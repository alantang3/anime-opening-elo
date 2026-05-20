import { useEffect, useRef, useState, useCallback } from "react";
import { io } from "socket.io-client";

// Screen phases. AUTH/LOBBY are local; the rest are driven by server events.
const PHASE = {
  AUTH: "auth",         // not signed in
  LOBBY: "lobby",       // signed in, idle
  INVITING: "inviting", // waiting for a friend to join your link
  QUEUE: "queue",
  PREPARE: "prepare",
  COUNTDOWN: "countdown",
  PLAYING: "playing",
  RESULT: "result",
};

// How long Mimiko shows the "wait" pose (after a match is found) before the
// match screen takes over — long enough to actually register.
const FOUND_HOLD_MS = 1200;

const LS_TOKEN = "aoe.token";
const LS_VOL = "aoe.volume";
// WebRTC ICE servers. STUN alone fails across most real-world NATs, so a
// TURN relay is REQUIRED for camera/mic to work between two different
// networks (without it both sides only ever see themselves). Ships with the
// free OpenRelay project so it works out of the box; override with
// VITE_TURN_URL / VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL (build-time env)
// for a reliable production relay.
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: [
      "turn:openrelay.metered.ca:80",
      "turn:openrelay.metered.ca:443",
      "turn:openrelay.metered.ca:443?transport=tcp",
    ],
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];
if (import.meta.env.VITE_TURN_URL) {
  ICE_SERVERS.push({
    urls: import.meta.env.VITE_TURN_URL,
    username: import.meta.env.VITE_TURN_USERNAME || "",
    credential: import.meta.env.VITE_TURN_CREDENTIAL || "",
  });
}

// Anime-flavoured rank tiers across Elo ranges (everyone starts at 100).
// Escalating aura: dim/cool at the bottom → cool-vivid → hot → radiant.
// Every tier is a distinct hue/brightness so no two look alike.
const RANKS = [
  { min: 0, name: "Background Character", color: "#6e7687" },
  { min: 300, name: "Academy Student", color: "#4a7fb5" },
  { min: 600, name: "Rookie Hunter", color: "#2f9fe0" },
  { min: 900, name: "Genin", color: "#15c0c0" },
  { min: 1200, name: "Chunin", color: "#14cf86" },
  { min: 1500, name: "Jonin", color: "#3ad63f" },
  { min: 1800, name: "Survey Corps Member", color: "#9ad81b" },
  { min: 2100, name: "Pro Hero", color: "#e8b317" },
  { min: 2400, name: "Hashira", color: "#f6851f" },
  { min: 2700, name: "S-Class Hero", color: "#fb5a2e" },
  { min: 3000, name: "Special Grade Sorcerer", color: "#f5356e" },
  { min: 3300, name: "Kage", color: "#e62222" },
  { min: 3600, name: "Pirate King", color: "#c026d6" },
  { min: 3900, name: "The Honored One", color: "#6a5cff" },
  { min: 4200, name: "Super Saiyan", color: "#ffd23d" },
  { min: 4500, name: "Anime God", color: "#ffffff" },
];
function rankForElo(elo) {
  let r = RANKS[0];
  for (const t of RANKS) if ((elo ?? 0) >= t.min) r = t;
  return r;
}
// Leaderboard-position titles, shown IN ADDITION to the Elo rank.
function leaderboardTitle(index) {
  if (index === 0) return "Plot Armor Incarnate";
  if (index >= 1 && index < 10) return "Main Character";
  return null;
}
const initialOf = (n) => (n || "?").trim().charAt(0).toUpperCase();

export default function App() {
  const socketRef = useRef(null);
  const videoRef = useRef(null);

  const [volume, setVolume] = useState(() => {
    const v = parseFloat(localStorage.getItem(LS_VOL));
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.7;
  });

  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState(PHASE.AUTH);
  const [googleClientId, setGoogleClientId] = useState(null);
  const [me, setMe] = useState(null);
  const [opponent, setOpponent] = useState(null);
  const [roundInfo, setRoundInfo] = useState(null);
  // The round plays the AUDIO file (reliable); flips to the video on audio
  // failure. RESULT always shows the video for the reveal.
  const [audioFailed, setAudioFailed] = useState(false);
  // Brief curtain-reveal animation when a match is found.
  const [matchStarting, setMatchStarting] = useState(false);
  // Queue screen (one page, image swaps): mimiko → mimikosleep after 5s →
  // mimikowait when matched (held a beat so it registers, then the match).
  const [queueSleep, setQueueSleep] = useState(false);
  const [queueFound, setQueueFound] = useState(false);
  const foundHoldRef = useRef(false);
  // Kitsune "opponent found" intermediary between queue and battle:
  // null | "in" (covering, slightly transparent) | "up" (blinds-lift away).
  const [foundOverlay, setFoundOverlay] = useState(null);
  const [countdown, setCountdown] = useState(0);
  const [remaining, setRemaining] = useState(1);
  const [feedback, setFeedback] = useState(null);
  const [needTap, setNeedTap] = useState(false); // autoplay was blocked
  const [oppStatus, setOppStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [votes, setVotes] = useState({ you: null, opponent: null });
  // Opponent gone (disconnect/declined/timeout): stay on the result screen
  // with the opening replayable until the player chooses to re-queue.
  const [oppGone, setOppGone] = useState(false);
  const [notice, setNotice] = useState(null);
  const [board, setBoard] = useState([]);
  const [inviteCode, setInviteCode] = useState(null);
  const [nameDraft, setNameDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [rankUp, setRankUp] = useState(null); // {name,color} on tier-up
  const rankUpTimer = useRef(null);
  const [stats, setStats] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false); // header dropdown
  const [panel, setPanel] = useState(null); // null | "profile" | "stats"
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarInputRef = useRef(null);
  // Invite code from a ?invite= link, joined once we're authed.
  const pendingInviteRef = useRef(
    new URLSearchParams(window.location.search).get("invite")
  );

  // Guess: free-text only. You just need the franchise — no season/title
  // picker (the server matches against the franchise-wide accepted set).
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);

  const durationRef = useRef(null);
  const playStartRef = useRef(null);
  const tickRef = useRef(null);
  // Set once per round if the opening genuinely can't play here, so we don't
  // spam the server (reset on round:prepare).
  const unplayableSentRef = useRef(false);
  const altReqRef = useRef(false); // an alternate-video request is in flight
  const lastFailReasonRef = useRef("unplayable");
  const watchdogRef = useRef(null); // detects "loaded but not actually playing"
  const matchStartTimer = useRef(null);
  const tokenRef = useRef(localStorage.getItem(LS_TOKEN) || null);
  const tokenClientRef = useRef(null);
  const [gsiReady, setGsiReady] = useState(false);

  // ---- WebRTC (opt-in camera/mic with the opponent) ----
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const politeRef = useRef(false);
  const makingOfferRef = useRef(false);
  const ignoreOfferRef = useRef(false);
  const audioSenderRef = useRef(null); // persistent senders → toggle via
  const videoSenderRef = useRef(null); // replaceTrack (no renegotiation)
  const remoteStreamRef = useRef(null);
  const pendingIceRef = useRef([]); // ICE buffered until remoteDescription set
  const [camOn, setCamOn] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [hasRemote, setHasRemote] = useState(false);
  const [peerAV, setPeerAV] = useState({ cam: false, mic: false });

  // ---------- Socket setup ----------
  useEffect(() => {
    const socket = io({ path: "/socket.io" });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      if (tokenRef.current) socket.emit("auth", { token: tokenRef.current });
    });
    socket.on("disconnect", () => {
      setConnected(false);
      setNotice("Disconnected from server. Reconnecting…");
    });

    socket.on("authed", ({ player }) => {
      setMe(player);
      setNotice(null);
      setPhase((p) =>
        p === PHASE.AUTH || p === PHASE.QUEUE ? PHASE.LOBBY : p
      );
      // If we arrived via a ?invite= link, join that private match now.
      const code = pendingInviteRef.current;
      if (code) {
        pendingInviteRef.current = null;
        window.history.replaceState({}, "", window.location.pathname);
        socket.emit("joinInvite", { code });
      }
    });
    socket.on("authError", ({ message }) => {
      localStorage.removeItem(LS_TOKEN);
      tokenRef.current = null;
      setMe(null);
      setPhase(PHASE.AUTH);
      setNotice(message || "Please sign in again.");
    });

    socket.on("queued", () => {
      setPhase(PHASE.QUEUE);
      setNotice(null);
      setResult(null);
      setOppGone(false);
      setQueueFound(false);
      foundHoldRef.current = false;
      setFoundOverlay(null);
    });
    socket.on("queueCancelled", () => setPhase(PHASE.LOBBY));

    socket.on("matchFound", ({ you, opponent, polite }) => {
      setMe(you);
      setOpponent(opponent);
      politeRef.current = !!polite;
      setResult(null);
      setVotes({ you: null, opponent: null });
      setOppGone(false);
      setFeedback(null);
      setOppStatus(null);
      setNotice(null);
      setHasRemote(false);
      setPeerAV({ cam: false, mic: false });
      ensurePeer(); // ready to negotiate if either side enables A/V
      // 1) Same queue page: Mimiko swaps to the "wait" pose, held a beat.
      setQueueFound(true);
      foundHoldRef.current = true;
      clearTimeout(matchStartTimer.current);
      matchStartTimer.current = setTimeout(() => {
        foundHoldRef.current = false;
        // 2) Battle UI mounts underneath; the Kitsune "opponent found"
        //    overlay covers it (slightly transparent)…
        setPhase(PHASE.PREPARE);
        setFoundOverlay("in");
        setTimeout(() => {
          // 3) …then lifts up like a window blind, revealing the battle.
          setFoundOverlay("up");
          setTimeout(() => setFoundOverlay(null), 500);
        }, 2000);
      }, FOUND_HOLD_MS);
    });

    socket.on("round:prepare", ({ round, videoUrl, audioUrl, dub }) => {
      setResult(null);
      setVotes({ you: null, opponent: null });
      setOppGone(false);
      setFeedback(null);
      setOppStatus(null);
      setQuery("");
      setNeedTap(false);
      setAudioFailed(false);
      unplayableSentRef.current = false;
      altReqRef.current = false;
      clearTimeout(watchdogRef.current);
      setRoundInfo({
        round,
        videoUrl,
        audioUrl: audioUrl || null,
        dub: dub || null,
        durationMs: null,
      });
      // While Mimiko is holding the "wait" pose, stay on the queue page;
      // the found-hold timer flips to PREPARE when it's done.
      if (!foundHoldRef.current) setPhase(PHASE.PREPARE);
    });

    socket.on("round:start", ({ countdownMs, durationMs }) => {
      durationRef.current = durationMs;
      setPhase(PHASE.COUNTDOWN);
      let n = Math.ceil(countdownMs / 1000);
      setCountdown(n);
      const iv = setInterval(() => {
        n -= 1;
        setCountdown(n);
        if (n <= 0) {
          clearInterval(iv);
          beginPlaying();
        }
      }, 1000);
    });

    // Server's answer to round:videoFailed — swap to the next version/encode,
    // or (url == null) we're out of alternates → scrap the round.
    socket.on("round:altVideo", ({ url }) => {
      altReqRef.current = false;
      if (url) {
        setNotice(null);
        setNeedTap(false);
        setAudioFailed(true); // alternates are video links
        setRoundInfo((prev) => (prev ? { ...prev, videoUrl: url } : prev));
      } else {
        reportUnplayable(lastFailReasonRef.current || "unplayable");
      }
    });

    socket.on("guess:result", ({ correct }) => {
      if (!correct) {
        setFeedback("Not it — keep guessing!");
        setTimeout(() => inputRef.current?.select(), 30);
      }
    });
    socket.on("opponent:guessed", () => {
      setOppStatus("Opponent guessed — and missed");
      setTimeout(() => setOppStatus(null), 2500);
    });

    socket.on("round:end", (data) => {
      stopTimer();
      setResult(data);
      setPhase(PHASE.RESULT);
      setVotes({ you: null, opponent: null });
      setOppGone(false);
      refreshBoard();
      // Keep the player's own Elo (profile badge / next match) in sync. The
      // leaderboard refetches, but `me` previously only changed on auth or
      // matchFound, so a non-leaderboard player never saw their rating move.
      if (data?.result?.eloAfter != null)
        setMe((prev) =>
          prev ? { ...prev, elo: data.result.eloAfter } : prev
        );
      // Opponent's rating moves on your screen too — including the bot's, so
      // a rematch shows it gained/lost what it should.
      if (data?.result?.oppElo != null)
        setOpponent((prev) =>
          prev ? { ...prev, elo: data.result.oppElo } : prev
        );
      // Rank-up reveal: did this result push us into a higher tier?
      const before = data?.result?.eloBefore;
      const after = data?.result?.eloAfter;
      if (before != null && after != null) {
        const rb = rankForElo(before);
        const ra = rankForElo(after);
        if (ra.min > rb.min) {
          setRankUp(ra);
          clearTimeout(rankUpTimer.current);
          rankUpTimer.current = setTimeout(() => setRankUp(null), 5000);
        }
      }
    });

    socket.on("rematch:state", (v) => setVotes(v));
    socket.on("rematch:accepted", () => {
      setNotice(null);
      setPhase(PHASE.PREPARE);
    });

    // Opponent is gone — keep the player on the result screen until they
    // pick "Find new opponent" themselves (no auto-requeue).
    socket.on("opponent:gone", ({ reason }) => {
      teardownRTC();
      setVotes({ you: null, opponent: null });
      setOppGone(true);
      setNotice(
        reason === "opponent_declined"
          ? "Opponent wanted a new opponent."
          : reason === "rematch_timeout"
          ? "Rematch timed out."
          : "Opponent left."
      );
    });
    socket.on("match:over", ({ reason }) => {
      teardownRTC();
      // Back to the lobby by default. If the server re-queued us (random
      // rematch decline), the "queued" event will switch us to QUEUE.
      setPhase(PHASE.LOBBY);
      if (reason && reason !== "you_left")
        setNotice("Match ended.");
    });

    socket.on("errorMsg", ({ message }) => setNotice(message));

    // Profile / username
    socket.on("profileUpdated", ({ player }) => {
      setMe(player);
      setNotice("Username updated.");
    });
    socket.on("nicknameError", ({ message }) => setNotice(message));

    // Invite (private friend match)
    socket.on("inviteCreated", ({ code }) => {
      setInviteCode(code);
      setPhase(PHASE.INVITING);
    });
    socket.on("inviteCancelled", () => {
      setInviteCode(null);
      setPhase(PHASE.LOBBY);
    });
    socket.on("inviteExpired", () => {
      setInviteCode(null);
      setNotice("Your invite link expired.");
      setPhase(PHASE.LOBBY);
    });
    socket.on("inviteError", ({ message }) => {
      setInviteCode(null);
      setNotice(message);
      setPhase(PHASE.LOBBY);
    });

    // WebRTC signaling (perfect negotiation).
    socket.on("rtc:signal", (payload) => onSignal(payload));
    socket.on("rtc:peerState", (s) =>
      setPeerAV({ cam: !!s.cam, mic: !!s.mic })
    );

    return () => socket.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Google sign-in ----------
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((c) => setGoogleClientId(c.googleClientId || ""))
      .catch(() => setGoogleClientId(""));
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }, []);

  // Use Google's OAuth token flow so we render OUR OWN themed button instead
  // of Google's white iframe widget.
  useEffect(() => {
    if (!googleClientId) return;
    let tries = 0;
    const iv = setInterval(() => {
      const oauth = window.google?.accounts?.oauth2;
      if (!oauth) {
        if (++tries > 80) clearInterval(iv);
        return;
      }
      clearInterval(iv);
      tokenClientRef.current = oauth.initTokenClient({
        client_id: googleClientId,
        scope: "openid email profile",
        callback: (resp) => {
          if (resp?.access_token) handleGoogleToken(resp.access_token);
          else setNotice("Google sign-in was cancelled.");
        },
      });
      setGsiReady(true);
    }, 100);
    return () => clearInterval(iv);
  }, [googleClientId]);

  function signInWithGoogle() {
    if (!tokenClientRef.current) return;
    setNotice(null);
    tokenClientRef.current.requestAccessToken();
  }

  async function handleGoogleToken(accessToken) {
    try {
      const r = await fetch("/api/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken }),
      }).then((x) => x.json());
      if (!r.token) throw new Error(r.error || "sign-in failed");
      localStorage.setItem(LS_TOKEN, r.token);
      tokenRef.current = r.token;
      setMe(r.player);
      setNotice(null);
      socketRef.current?.emit("auth", { token: r.token });
      setPhase(PHASE.LOBBY);
    } catch (e) {
      setNotice("Google sign-in failed. Try again.");
    }
  }

  function signOut() {
    localStorage.removeItem(LS_TOKEN);
    tokenRef.current = null;
    teardownRTC();
    setMe(null);
    setPhase(PHASE.AUTH);
  }

  // The opening genuinely can't play on THIS screen (bad CDN/codec/region,
  // or even a tap couldn't start it). One round can't continue with only one
  // side hearing it, so tell the server to scrap it and re-queue both of us.
  function reportUnplayable(reason) {
    if (unplayableSentRef.current) return;
    unplayableSentRef.current = true;
    socketRef.current?.emit("roundUnplayable", { reason });
  }

  // Ask the server for the next version/encode of the same OP. The server
  // replies with `round:altVideo`; if it's out of alternates we escalate to
  // reportUnplayable (→ void round + rematch).
  function handleVideoFail(reason) {
    if (unplayableSentRef.current || altReqRef.current) return;
    clearTimeout(watchdogRef.current);
    altReqRef.current = true;
    lastFailReasonRef.current = reason;
    setNotice("That version wouldn't play — trying another…");
    socketRef.current?.emit("round:videoFailed", {
      url: roundInfo?.videoUrl,
      reason,
    });
  }

  // Single entry point for "the round media isn't playing here" (load error,
  // play() rejected, or the stall watchdog). Cheapest fix first: if we were
  // on the AUDIO file, fall back to this round's video locally (no server
  // round-trip). Only if that also fails do we go to server alternates.
  function onMediaTrouble(reason) {
    if (unplayableSentRef.current || altReqRef.current) return;
    clearTimeout(watchdogRef.current);
    if (roundInfo?.audioUrl && !audioFailed) {
      setAudioFailed(true); // src → video; the [roundSrc] effect replays it
      return;
    }
    handleVideoFail(reason);
  }

  // "Loaded, no error, but not actually progressing" (silent stall / dead
  // audio track) — the bug where it never skips and you just hear nothing.
  function armWatchdog() {
    clearTimeout(watchdogRef.current);
    const v = videoRef.current;
    if (!v) return;
    const t0 = v.currentTime || 0;
    watchdogRef.current = setTimeout(() => {
      const m = videoRef.current;
      if (!m || m.ended) return;
      if (m.paused || m.currentTime - t0 < 0.25) onMediaTrouble("stall");
    }, 3000);
  }

  function attemptPlay() {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.currentTime = 0;
    v.play().then(
      () => {
        setNeedTap(false);
        armWatchdog(); // make sure it's truly producing sound
      },
      (err) => {
        // NotAllowedError = browser autoplay policy (gesture window elapsed
        // during the countdown): a single tap fixes this, so offer it.
        // Anything else = this source won't play here → try a fallback.
        if (err && err.name === "NotAllowedError") setNeedTap(true);
        else onMediaTrouble("play:" + (err?.name || "unknown"));
      }
    );
  }

  // ---------- Timer (visual only; server is authoritative) ----------
  function beginPlaying() {
    setPhase(PHASE.PLAYING);
    playStartRef.current = Date.now();
    setRemaining(1);
    attemptPlay();
    setTimeout(() => inputRef.current?.focus(), 50);
    clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      const d = durationRef.current || 90000;
      const frac = 1 - (Date.now() - playStartRef.current) / d;
      setRemaining(Math.max(0, frac));
      if (frac <= 0) clearInterval(tickRef.current);
    }, 100);
  }
  function tapToPlay() {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.play().then(
      () => {
        setNeedTap(false);
        armWatchdog();
      },
      // A real tap still failed → not autoplay policy; try a fallback.
      (err) => onMediaTrouble("tap:" + (err?.name || "unknown"))
    );
  }
  // The round plays the audio file; flips to video on audio failure; RESULT
  // shows the video for the reveal. Keyed on this so a switch remounts.
  const roundSrc =
    phase === PHASE.RESULT
      ? roundInfo?.videoUrl || null
      : (roundInfo?.audioUrl && !audioFailed
          ? roundInfo.audioUrl
          : roundInfo?.videoUrl) || null;

  // When the source changes mid-round (audio→video, or a server alternate),
  // the <video> remounts (keyed on roundSrc); replay it if the song's on.
  useEffect(() => {
    if (phase === PHASE.PLAYING) attemptPlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundSrc]);
  function stopTimer() {
    clearInterval(tickRef.current);
    clearTimeout(watchdogRef.current);
    const v = videoRef.current;
    if (v) v.pause();
  }
  useEffect(
    () => () => {
      clearInterval(tickRef.current);
      clearTimeout(rankUpTimer.current);
      teardownRTC();
    },
    []
  );

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume, roundSrc, phase]);

  // Queue: show mimiko; after 5s with no match, switch to mimikosleep.
  useEffect(() => {
    setQueueSleep(false);
    if (phase !== PHASE.QUEUE) return;
    const t = setTimeout(() => setQueueSleep(true), 5000);
    return () => clearTimeout(t);
  }, [phase]);

  // Bind A/V streams AFTER the <video> elements mount. They render only when
  // (camOn || micOn || hasRemote) AND not on the RESULT replay, so the
  // elements also mount/unmount across phases — applyMedia()/ontrack assign
  // srcObject before that, so on first mount the ref is still null and the
  // stream is lost (blank local preview, no remote A/V). Re-bind here once
  // the elements actually exist. `phase` is a dep so a remount rebinds too.
  useEffect(() => {
    const lv = localVideoRef.current;
    if (lv && lv.srcObject !== localStreamRef.current)
      lv.srcObject = localStreamRef.current;
    const rv = remoteVideoRef.current;
    if (rv && rv.srcObject !== remoteStreamRef.current) {
      rv.srcObject = remoteStreamRef.current;
      rv.play().catch(() => {}); // kick autoplay (esp. remote audio)
    }
  }, [camOn, micOn, hasRemote, phase]);

  function changeVolume(val) {
    const v = Math.min(1, Math.max(0, val));
    setVolume(v);
    localStorage.setItem(LS_VOL, String(v));
    if (videoRef.current) videoRef.current.volume = v;
  }

  function onLoadedMetadata() {
    const v = videoRef.current;
    if (v && Number.isFinite(v.duration)) {
      socketRef.current?.emit("mediaDuration", {
        ms: Math.round(v.duration * 1000),
      });
    }
  }

  // ---------- WebRTC ----------
  function ensurePeer() {
    if (pcRef.current) return pcRef.current;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;
    pendingIceRef.current = [];

    // Persistent bidirectional transceivers, created ONCE. Toggling cam/mic
    // later only calls replaceTrack on these senders — no renegotiation, so
    // no glare and no one-way-media bug.
    audioSenderRef.current = pc.addTransceiver("audio", {
      direction: "sendrecv",
    }).sender;
    videoSenderRef.current = pc.addTransceiver("video", {
      direction: "sendrecv",
    }).sender;

    const remote = new MediaStream();
    remoteStreamRef.current = remote;

    pc.onnegotiationneeded = async () => {
      try {
        makingOfferRef.current = true;
        await pc.setLocalDescription();
        socketRef.current?.emit("rtc:signal", {
          description: pc.localDescription,
        });
      } catch (e) {
        console.error("negotiation", e);
      } finally {
        makingOfferRef.current = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socketRef.current?.emit("rtc:signal", { candidate });
    };
    pc.ontrack = ({ track }) => {
      remote.addTrack(track);
      if (
        remoteVideoRef.current &&
        remoteVideoRef.current.srcObject !== remote
      )
        remoteVideoRef.current.srcObject = remote;
      setHasRemote(true);
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState))
        setHasRemote(false);
    };
    return pc;
  }

  async function onSignal({ description, candidate }) {
    const pc = ensurePeer();
    try {
      if (description) {
        const offerCollision =
          description.type === "offer" &&
          (makingOfferRef.current || pc.signalingState !== "stable");
        ignoreOfferRef.current = !politeRef.current && offerCollision;
        if (ignoreOfferRef.current) return;
        await pc.setRemoteDescription(description);
        // Flush ICE that arrived before the remote description was set.
        const buffered = pendingIceRef.current;
        pendingIceRef.current = [];
        for (const c of buffered) {
          try {
            await pc.addIceCandidate(c);
          } catch {}
        }
        if (description.type === "offer") {
          await pc.setLocalDescription();
          socketRef.current?.emit("rtc:signal", {
            description: pc.localDescription,
          });
        }
      } else if (candidate) {
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
          pendingIceRef.current.push(candidate); // not ready yet — buffer it
        } else {
          try {
            await pc.addIceCandidate(candidate);
          } catch (e) {
            if (!ignoreOfferRef.current) console.error("ice", e);
          }
        }
      }
    } catch (e) {
      console.error("onSignal", e);
    }
  }

  async function applyMedia(nextCam, nextMic) {
    ensurePeer();
    try {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
      let stream = null;
      if (nextCam || nextMic) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: nextCam,
          audio: nextMic,
        });
      }
      localStreamRef.current = stream;
      // replaceTrack swaps what we send WITHOUT renegotiation — this is the
      // whole reason there's no more one-way-audio glare.
      await audioSenderRef.current?.replaceTrack(
        stream?.getAudioTracks()[0] || null
      );
      await videoSenderRef.current?.replaceTrack(
        stream?.getVideoTracks()[0] || null
      );
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      setCamOn(nextCam);
      setMicOn(nextMic);
      socketRef.current?.emit("rtc:state", { cam: nextCam, mic: nextMic });
    } catch (e) {
      setNotice("Couldn't access camera/mic (permission denied?).");
      setCamOn(false);
      setMicOn(false);
    }
  }
  const toggleCam = () => applyMedia(!camOn, micOn);
  const toggleMic = () => applyMedia(camOn, !micOn);

  function teardownRTC() {
    try {
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {}
    localStreamRef.current = null;
    try {
      pcRef.current?.close();
    } catch {}
    pcRef.current = null;
    audioSenderRef.current = null;
    videoSenderRef.current = null;
    remoteStreamRef.current = null;
    pendingIceRef.current = [];
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    makingOfferRef.current = false;
    ignoreOfferRef.current = false;
    setCamOn(false);
    setMicOn(false);
    setHasRemote(false);
    setPeerAV({ cam: false, mic: false });
  }

  const submitGuess = useCallback(() => {
    const guessText = query.trim();
    if (!guessText) return;
    socketRef.current?.emit("guess", { guessText });
  }, [query]);

  function onKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      submitGuess();
    }
  }

  // ---------- Actions ----------
  const goHome = () => {
    if (!me) return;
    if (phase === PHASE.QUEUE) cancelQueue();
    else if (phase === PHASE.INVITING) cancelInvite();
    else if (inMatch) leaveMatch();
    setPhase(PHASE.LOBBY);
  };
  const findMatch = () => socketRef.current?.emit("queue");
  const cancelQueue = () => socketRef.current?.emit("cancelQueue");
  const leaveMatch = () => socketRef.current?.emit("leaveMatch");
  const vote = (yes) => socketRef.current?.emit("rematchVote", { yes });
  const createInvite = () => socketRef.current?.emit("createInvite");
  const cancelInvite = () => socketRef.current?.emit("cancelInvite");
  const saveName = () => {
    const n = nameDraft.trim();
    if (n && n !== me?.nickname) socketRef.current?.emit("setNickname", { nickname: n });
  };

  function uploadAvatar(file) {
    if (!file || !tokenRef.current) return;
    if (file.size > 1_200_000) {
      setNotice("Image too large (max ~1.2MB).");
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      setAvatarBusy(true);
      try {
        const r = await fetch("/api/me/avatar", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${tokenRef.current}`,
          },
          body: JSON.stringify({ image: reader.result }),
        }).then((x) => x.json());
        if (r.player) {
          setMe(r.player);
          setNotice("Profile picture updated.");
        } else setNotice(r.error || "Upload failed.");
      } catch {
        setNotice("Upload failed.");
      } finally {
        setAvatarBusy(false);
      }
    };
    reader.readAsDataURL(file);
  }

  async function loadStats() {
    if (!tokenRef.current) return;
    try {
      const r = await fetch("/api/me/stats", {
        headers: { Authorization: `Bearer ${tokenRef.current}` },
      }).then((x) => x.json());
      setStats(r);
    } catch {}
  }
  function openProfile() {
    setNameDraft(me?.nickname || "");
    setPanel("profile");
    setMenuOpen(false);
  }
  function openStats() {
    loadStats();
    setPanel("stats");
    setMenuOpen(false);
  }
  const closePanel = () => setPanel(null);
  const inviteUrl = inviteCode
    ? `${window.location.origin}/?invite=${inviteCode}`
    : "";
  function copyInvite() {
    navigator.clipboard?.writeText(inviteUrl).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {}
    );
  }

  async function refreshBoard() {
    try {
      const r = await fetch("/api/leaderboard").then((x) => x.json());
      setBoard(r.players || []);
    } catch {}
  }
  useEffect(() => {
    refreshBoard();
  }, []);

  // Keep the username editor prefilled with the current name.
  useEffect(() => {
    if (me?.nickname) setNameDraft(me.nickname);
  }, [me?.nickname]);

  const inMatch =
    phase === PHASE.PREPARE ||
    phase === PHASE.COUNTDOWN ||
    phase === PHASE.PLAYING ||
    phase === PHASE.RESULT;

  const PlayerBadge = ({ p, label }) => {
    if (!p) return null;
    const rank = rankForElo(p.elo);
    return (
      <div className="vs-card" style={{ "--rank": rank.color }}>
        <div className="vs-rankbar">
          <span className="vs-eyebrow">{label}</span>
          <span className="vs-rankname">{rank.name}</span>
        </div>
        <div className="vs-ava-wrap">
          {p.avatar ? (
            <img
              className="vs-ava"
              src={p.avatar}
              alt=""
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="vs-ava avatar-fallback">
              {initialOf(p.nickname)}
            </span>
          )}
        </div>
        <div className="vs-name">{p.nickname}</div>
        <div className="vs-elo">{p.elo} Elo</div>
      </div>
    );
  };

  const myBoardIndex = me ? board.findIndex((p) => p.id === me.id) : -1;
  const myTitle = leaderboardTitle(myBoardIndex);

  return (
    <div className="app">
      <div className="header">
        <div
          className="title-wrap"
          onClick={goHome}
          role="button"
          title="Home"
        >
          <img src="/anitune.png" alt="AniTune" className="app-icon" />
          <div className="title">
            Ani<span>Tune</span>
          </div>
        </div>
        {me && (
          <div className="user-menu">
            <button
              className="rating-pill"
              onClick={() => setMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              {me.avatar ? (
                <img className="avatar" src={me.avatar} alt="" referrerPolicy="no-referrer" />
              ) : (
                <span className="avatar avatar-fallback">
                  {initialOf(me.nickname)}
                </span>
              )}
              <div className="pill-info">
                <span className="pill-name">
                  {me.nickname}
                  {myTitle && (
                    <span
                      className={
                        "lb-title" +
                        (myBoardIndex === 0 ? " lb-title-king" : "")
                      }
                    >
                      {myTitle}
                    </span>
                  )}
                </span>
                <span
                  className="rank-badge"
                  style={{ color: rankForElo(me.elo).color }}
                >
                  {rankForElo(me.elo).name} · {me.elo}
                </span>
              </div>
              <span className="pill-caret">{menuOpen ? "▴" : "▾"}</span>
            </button>
            {menuOpen && (
              <>
                <div
                  className="menu-backdrop"
                  onClick={() => setMenuOpen(false)}
                />
                <div className="user-dropdown" role="menu">
                  <button onClick={openProfile}>Profile</button>
                  <button onClick={openStats}>Statistics</button>
                  <button className="dd-danger" onClick={signOut}>
                    ⏻ Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {notice && <div className="notice">{notice}</div>}

      {rankUp && (
        <div className="rankup-overlay" onClick={() => setRankUp(null)}>
          <div className="rankup-card" style={{ "--rank": rankUp.color }}>
            <div className="rankup-label">RANK UP</div>
            <div className="rankup-name" style={{ color: rankUp.color }}>
              {rankUp.name}
            </div>
            <div className="rankup-sub">tap to dismiss</div>
          </div>
        </div>
      )}

      {foundOverlay && (
        <div
          className={"found-overlay" + (foundOverlay === "up" ? " lift" : "")}
          aria-hidden="true"
        >
          <div className="found-figure">
            <img src="/kitsune.png" alt="" />
          </div>
        </div>
      )}

      {panel === "profile" && (
        <div className="modal-backdrop" onClick={closePanel}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Profile</h3>
              <button className="modal-x" onClick={closePanel}>
                ✕
              </button>
            </div>
            <div className="profile-ava">
              <div
                className="lobby-ava"
                onClick={() => avatarInputRef.current?.click()}
                title="Change picture"
              >
                {me?.avatar ? (
                  <img src={me.avatar} alt="" referrerPolicy="no-referrer" />
                ) : (
                  <span className="avatar-fallback">
                    {initialOf(me?.nickname)}
                  </span>
                )}
                <span className="lobby-ava-edit">
                  {avatarBusy ? "…" : "✎"}
                </span>
              </div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: "none" }}
                onChange={(e) => {
                  uploadAvatar(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>
            <div className="name-editor">
              <label>Username</label>
              <div className="name-row">
                <input
                  type="text"
                  value={nameDraft}
                  maxLength={24}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveName()}
                  placeholder="Display name"
                />
                <button
                  className="secondary"
                  onClick={saveName}
                  disabled={
                    !nameDraft.trim() || nameDraft.trim() === me?.nickname
                  }
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {panel === "stats" && (
        <div className="modal-backdrop" onClick={closePanel}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Statistics</h3>
              <button className="modal-x" onClick={closePanel}>
                ✕
              </button>
            </div>
            {!stats ? (
              <div className="muted-row">Loading…</div>
            ) : (
              <div className="stats">
                <div className="stat-grid">
                  <div className="stat">
                    <span className="stat-n">{stats.peakElo}</span>
                    <span className="stat-l">Peak Elo</span>
                  </div>
                  <div className="stat">
                    <span className="stat-n">{stats.winrate}%</span>
                    <span className="stat-l">Win rate</span>
                  </div>
                  <div className="stat">
                    <span className="stat-n">
                      {stats.wins}-{stats.losses}-{stats.draws}
                    </span>
                    <span className="stat-l">W-L-D</span>
                  </div>
                  <div className="stat">
                    <span className="stat-n">
                      {stats.avgGuessMs
                        ? (stats.avgGuessMs / 1000).toFixed(1) + "s"
                        : "—"}
                    </span>
                    <span className="stat-l">Avg guess</span>
                  </div>
                </div>
                <h3>Recent matches</h3>
                {stats.recent.length === 0 && (
                  <div className="muted-row">No matches yet.</div>
                )}
                {stats.recent.map((m, i) => (
                  <div className="match-row" key={i}>
                    <span
                      className={
                        "m-res " +
                        (m.outcome === "timeout"
                          ? "draw"
                          : m.youWon
                          ? "win"
                          : "loss")
                      }
                    >
                      {m.outcome === "timeout"
                        ? "DRAW"
                        : m.youWon
                        ? "WIN"
                        : "LOSS"}
                    </span>
                    <span className="m-anime">{m.anime || "—"}</span>
                    <span className="m-opp">vs {m.opponent}</span>
                    {m.delta != null && (
                      <span
                        className={m.delta >= 0 ? "delta-pos" : "delta-neg"}
                      >
                        {m.delta >= 0 ? "+" : ""}
                        {m.delta}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card">
        {/* ---------- Sign in ---------- */}
        {phase === PHASE.AUTH && (
          <div className="hero">
            <div className="hero-title">
              Ani<span>Tune</span>
            </div>
            <div className="hero-sub">
              Battle players. Guess faster. Climb&nbsp;ELO.
            </div>
            {googleClientId === "" ? (
              <div className="notice" style={{ marginTop: 22 }}>
                Google sign-in isn’t configured yet — set{" "}
                <code>GOOGLE_CLIENT_ID</code> on the server.
              </div>
            ) : (
              <>
                <button
                  className="gsign"
                  onClick={signInWithGoogle}
                  disabled={!gsiReady}
                >
                  <svg className="gsign-g" viewBox="0 0 48 48" aria-hidden="true">
                    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.2C12.3 13.3 17.6 9.5 24 9.5z"/>
                    <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.1 5.3-4.6 7l7.1 5.5c4.2-3.9 6.6-9.6 6.6-17z"/>
                    <path fill="#FBBC05" d="M10.5 28.4c-.5-1.4-.7-2.9-.7-4.4s.3-3 .7-4.4l-7.9-6.2C1 16.6 0 20.2 0 24s1 7.4 2.6 10.6l7.9-6.2z"/>
                    <path fill="#34A853" d="M24 48c6.4 0 11.9-2.1 15.9-5.8l-7.1-5.5c-2 1.3-4.6 2.1-8.8 2.1-6.4 0-11.7-3.8-13.5-9.4l-7.9 6.2C6.5 42.6 14.6 48 24 48z"/>
                  </svg>
                  {gsiReady ? "Sign in with Google" : "Loading…"}
                </button>
                <div className="hero-note">
                  Sign in so your Elo, rank, and leaderboard spot stay with
                  your account.
                </div>
              </>
            )}
          </div>
        )}

        {/* ---------- Lobby ---------- */}
        {phase === PHASE.LOBBY && (
          <div className="lobby">
            <div className="lobby-id">
              <div className="lobby-ava lobby-ava-ro">
                {me?.avatar ? (
                  <img src={me.avatar} alt="" referrerPolicy="no-referrer" />
                ) : (
                  <span className="avatar-fallback">
                    {initialOf(me?.nickname)}
                  </span>
                )}
              </div>
              <p style={{ margin: "10px 0 0" }}>
                Welcome back, <strong>{me?.nickname}</strong>
              </p>
              <span
                className="rank-badge"
                style={{ color: rankForElo(me?.elo).color }}
              >
                {rankForElo(me?.elo).name} · {me?.elo} Elo
              </span>
              {myTitle && (
                <span
                  className={
                    "lb-title lb-title-block" +
                    (myBoardIndex === 0 ? " lb-title-king" : "")
                  }
                >
                  ★ {myTitle}
                </span>
              )}
            </div>

            <div className="play-stage">
              <img className="nyalea" src="/nyalea.png" alt="" />
              <div className="play-actions">
                <button
                  className="play-art"
                  onClick={findMatch}
                  disabled={!connected}
                  title={connected ? "Find a match" : "Connecting…"}
                  aria-label="Find a match"
                >
                  <img src="/playbutton.png" alt="Play" />
                </button>
                <button
                  className="play-art"
                  onClick={createInvite}
                  disabled={!connected}
                  title="Invite friends"
                  aria-label="Invite friends"
                >
                  <img src="/invitefriend.png" alt="Invite friends" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ---------- Inviting a friend ---------- */}
        {phase === PHASE.INVITING && (
          <div style={{ textAlign: "center", padding: "32px 0" }}>
            <div className="pulse">Waiting for your friend to join…</div>
            <p style={{ color: "var(--muted)", marginTop: 16 }}>
              Send them this link — first to open it (signed in) battles you.
              Ranked.
            </p>
            <div className="invite-row">
              <input type="text" readOnly value={inviteUrl} onFocus={(e) => e.target.select()} />
              <button className="secondary" onClick={copyInvite}>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <div
              className="button-row"
              style={{ maxWidth: 220, margin: "20px auto 0" }}
            >
              <button className="danger" onClick={cancelInvite}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ---------- Queue ---------- */}
        {phase === PHASE.QUEUE && (
          <div className="queue-screen">
            <div className="queue-figure">
              <img
                className={"qm" + (!queueSleep && !queueFound ? " on" : "")}
                src="/mimiko.png"
                alt=""
              />
              <img
                className={"qm" + (queueSleep && !queueFound ? " on" : "")}
                src="/mimikosleep.png"
                alt=""
              />
              <img
                className={"qm" + (queueFound ? " on" : "")}
                src="/mimikowait.png"
                alt=""
              />
            </div>
            {!queueFound && (
              <button
                className="queue-cancel"
                onClick={cancelQueue}
                aria-label="Cancel"
              >
                <img src="/cancelbutton.png" alt="Cancel" />
              </button>
            )}
          </div>
        )}

        {/* ---------- Match ---------- */}
        {inMatch && (
          <>
            <div
              className={"match-stage" + (matchStarting ? " is-opening" : "")}
            >
              <aside className="stage-side stage-left">
                <PlayerBadge p={me} label="YOU" />
              </aside>

              <div className="stage-center">
                <div className="player-wrap">
              <video
                ref={videoRef}
                key={roundSrc}
                src={roundSrc || undefined}
                playsInline
                controls={phase === PHASE.RESULT}
                onLoadedMetadata={onLoadedMetadata}
                onError={() => {
                  if (!roundSrc) return;
                  // A media error on the live round (not the RESULT replay):
                  // fall back (audio→video→alternate) before scrapping it.
                  if (
                    phase === PHASE.PREPARE ||
                    phase === PHASE.COUNTDOWN ||
                    phase === PHASE.PLAYING
                  ) {
                    onMediaTrouble("mediaerror");
                  }
                }}
                style={{
                  visibility: phase === PHASE.RESULT ? "visible" : "hidden",
                }}
              />
              {/* Camera/mic feeds live INSIDE the player box (not a separate
                  box). Hidden on the RESULT replay so the opening shows. */}
              {phase !== PHASE.RESULT && (camOn || micOn || hasRemote) && (
                <div className="player-cam">
                  <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    className={"cam-remote" + (hasRemote ? "" : " empty")}
                  />
                  <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className="cam-local"
                  />
                </div>
              )}
              {phase === PHASE.PREPARE && (
                <div className="player-cover">Buffering opening…</div>
              )}
              {phase === PHASE.COUNTDOWN && (
                <div className="player-cover countdown">
                  {countdown > 0 ? countdown : "GO!"}
                </div>
              )}
              {phase === PHASE.PLAYING && needTap && (
                <div
                  className="player-cover tap-to-play"
                  onClick={tapToPlay}
                  role="button"
                >
                  🔊 Tap to start the song
                </div>
              )}
              {phase === PHASE.PLAYING && !needTap && roundInfo?.dub && (
                <span className="dub-badge dub-float">🎙 English dub</span>
              )}
                </div>
              </div>

              <aside className="stage-side stage-right">
                <PlayerBadge p={opponent} label="OPPONENT" />
              </aside>

              {matchStarting && (
                <div className="curtain" aria-hidden="true">
                  <div className="curtain-panel curtain-left">
                    <span className="curtain-eyebrow">YOU</span>
                    <span className="curtain-ava">
                      {me?.avatar ? (
                        <img src={me.avatar} alt="" referrerPolicy="no-referrer" />
                      ) : (
                        initialOf(me?.nickname)
                      )}
                    </span>
                    <span className="curtain-name">{me?.nickname}</span>
                  </div>
                  <div className="curtain-panel curtain-right">
                    <span className="curtain-eyebrow">OPPONENT</span>
                    <span className="curtain-ava">
                      {opponent?.avatar ? (
                        <img
                          src={opponent.avatar}
                          alt=""
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        initialOf(opponent?.nickname)
                      )}
                    </span>
                    <span className="curtain-name">{opponent?.nickname}</span>
                  </div>
                </div>
              )}
            </div>

            <div className="round-tag">
              {roundInfo?.round ? `Round ${roundInfo.round}` : " "}
            </div>

            {/* ---- Camera / mic with opponent ---- */}
            <div className="av-bar">
              <button
                className={"av-btn" + (camOn ? " on" : "")}
                onClick={toggleCam}
              >
                {camOn ? "📷 Camera on" : "📷 Camera"}
              </button>
              <button
                className={"av-btn" + (micOn ? " on" : "")}
                onClick={toggleMic}
              >
                {micOn ? "🎤 Mic on" : "🎤 Mic"}
              </button>
              <span className="av-peer">
                {opponent?.nickname}:{" "}
                {peerAV.cam || peerAV.mic
                  ? `${peerAV.cam ? "📷" : ""}${peerAV.mic ? "🎤" : ""}`
                  : "—"}
              </span>
            </div>

            {phase === PHASE.PLAYING && (
              <div className="volume-row">
                <span
                  className="vol-icon"
                  onClick={() => changeVolume(volume === 0 ? 0.7 : 0)}
                  title={volume === 0 ? "Unmute" : "Mute"}
                >
                  {volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}
                </span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={(e) => changeVolume(parseFloat(e.target.value))}
                  aria-label="Volume"
                />
                <span className="vol-pct">{Math.round(volume * 100)}%</span>
              </div>
            )}

            {phase === PHASE.PLAYING && (
              <>
                <div className="timer-bar">
                  <div style={{ width: `${remaining * 100}%` }} />
                </div>
                {oppStatus && <div className="opp-status">{oppStatus}</div>}
                {feedback && <div className="feedback">{feedback}</div>}
                <div className="input-row">
                  <input
                    ref={inputRef}
                    type="text"
                    placeholder="Anime name — English, Japanese, or acronym (AoT, MHA)…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    autoComplete="off"
                  />
                </div>
                <div className="button-row">
                  <button onClick={submitGuess} disabled={!query.trim()}>
                    Submit guess
                  </button>
                  <button className="danger" onClick={leaveMatch}>
                    Forfeit
                  </button>
                </div>
              </>
            )}

            {phase === PHASE.RESULT && result && (
              <ResultPanel
                result={result}
                votes={votes}
                opponent={opponent}
                onVote={vote}
                oppGone={oppGone}
                onRequeue={findMatch}
              />
            )}
          </>
        )}
      </div>

      {board.length > 0 && (
        <div className="history">
          <h3>Leaderboard</h3>
          {board.map((p, i) => {
            const title = leaderboardTitle(i);
            const rank = rankForElo(p.elo);
            return (
              <div
                className="history-row"
                key={p.id}
                style={{ "--rank": rank.color }}
              >
                <div className="name">
                  {i + 1}. {p.nickname}
                  {title && (
                    <span
                      className={
                        "lb-title" + (i === 0 ? " lb-title-king" : "")
                      }
                    >
                      {title}
                    </span>
                  )}
                </div>
                <div className="meta">
                  {p.elo} · {p.wins}W/{p.losses}L
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="footer-note">
        Songs &amp; video from{" "}
        <a href="https://animethemes.moe" target="_blank" rel="noreferrer">
          AnimeThemes.moe
        </a>
        ; popularity from{" "}
        <a href="https://myanimelist.net" target="_blank" rel="noreferrer">
          MyAnimeList
        </a>
        .
      </div>
    </div>
  );
}

function ResultPanel({ result, votes, opponent, onVote, oppGone, onRequeue }) {
  const r = result.result || {};
  const won = r.youWon;
  const cls =
    result.outcome === "timeout" || result.outcome === "unplayable"
      ? "wrong"
      : won
      ? "correct"
      : "wrong";
  const delta = r.delta ?? 0;

  return (
    <div className={"result " + cls}>
      <h3>
        {result.outcome === "unplayable"
          ? "Opening wouldn't play — round skipped"
          : result.outcome === "timeout"
          ? "Time's up — nobody got it"
          : result.outcome === "disconnect"
          ? won
            ? "Opponent forfeited — you win"
            : "You forfeited"
          : won
          ? "You got it first!"
          : "Opponent got it first"}
      </h3>
      <div className="answer">
        {result.answer?.name}
        {result.answer?.year && (
          <span className="year"> ({result.answer.year})</span>
        )}
      </div>
      {result.answer?.franchise &&
        result.answer.franchise !== result.answer.name && (
          <div style={{ color: "var(--muted)", fontSize: 13 }}>
            franchise: {result.answer.franchise}
          </div>
        )}
      {result.answer?.song && (
        <div style={{ color: "var(--muted)", fontSize: 14 }}>
          ♪ {result.answer.song}
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        Your Elo: <strong>{r.eloAfter}</strong>{" "}
        <span className={delta >= 0 ? "delta-pos" : "delta-neg"}>
          ({delta >= 0 ? "+" : ""}
          {delta})
        </span>
      </div>

      {oppGone ? (
        <div className="rematch">
          <div className="rematch-q">Opponent left — match over.</div>
          <div className="button-row">
            <button onClick={onRequeue}>Find new opponent</button>
          </div>
        </div>
      ) : (
        <div className="rematch">
          <div className="rematch-q">Play {opponent?.nickname} again?</div>
          <div className="vote-state">
            You: <b>{votes.you == null ? "—" : votes.you ? "Yes" : "No"}</b>
            {"   "}Opponent:{" "}
            <b>
              {votes.opponent == null
                ? "waiting…"
                : votes.opponent
                ? "Yes"
                : "No"}
            </b>
          </div>
          <div className="button-row">
            <button onClick={() => onVote(true)} disabled={votes.you != null}>
              {votes.you === true ? "Waiting for opponent…" : "Yes, rematch"}
            </button>
            <button
              className="danger"
              onClick={() => onVote(false)}
              disabled={votes.you != null}
            >
              No, new opponent
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
