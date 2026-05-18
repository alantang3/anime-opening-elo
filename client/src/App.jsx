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

const LS_TOKEN = "aoe.token";
const LS_VOL = "aoe.volume";
const STUN = [{ urls: "stun:stun.l.google.com:19302" }];

// Anime-flavoured rank tiers across Elo ranges (everyone starts at 100).
const RANKS = [
  { min: 0, name: "Background Character", color: "#8d94a8" },
  { min: 300, name: "Academy Student", color: "#4ec9b0" },
  { min: 600, name: "Rookie Hunter", color: "#38bdf8" },
  { min: 1000, name: "Chunin", color: "#a78bfa" },
  { min: 1500, name: "Jonin", color: "#f472b6" },
  { min: 2200, name: "S-Class Hero", color: "#fb923c" },
  { min: 3000, name: "Kage", color: "#f87171" },
  { min: 4000, name: "Anime God", color: "#fde047" },
];
function rankForElo(elo) {
  let r = RANKS[0];
  for (const t of RANKS) if ((elo ?? 0) >= t.min) r = t;
  return r;
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
  const [countdown, setCountdown] = useState(0);
  const [remaining, setRemaining] = useState(1);
  const [feedback, setFeedback] = useState(null);
  const [needTap, setNeedTap] = useState(false); // autoplay was blocked
  const [oppStatus, setOppStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [votes, setVotes] = useState({ you: null, opponent: null });
  const [notice, setNotice] = useState(null);
  const [board, setBoard] = useState([]);
  const [inviteCode, setInviteCode] = useState(null);
  const [nameDraft, setNameDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const [rankUp, setRankUp] = useState(null); // {name,color} on tier-up
  const rankUpTimer = useRef(null);
  const [stats, setStats] = useState(null);
  const [showStats, setShowStats] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarInputRef = useRef(null);
  // Invite code from a ?invite= link, joined once we're authed.
  const pendingInviteRef = useRef(
    new URLSearchParams(window.location.search).get("invite")
  );

  // Guess autocomplete
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [picked, setPicked] = useState(null);
  const searchTimer = useRef(null);
  const inputRef = useRef(null);

  const durationRef = useRef(null);
  const playStartRef = useRef(null);
  const tickRef = useRef(null);
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
    });
    socket.on("queueCancelled", () => setPhase(PHASE.LOBBY));

    socket.on("matchFound", ({ you, opponent, polite }) => {
      setMe(you);
      setOpponent(opponent);
      politeRef.current = !!polite;
      setResult(null);
      setVotes({ you: null, opponent: null });
      setFeedback(null);
      setOppStatus(null);
      setNotice(null);
      setHasRemote(false);
      setPeerAV({ cam: false, mic: false });
      ensurePeer(); // ready to negotiate if either side enables A/V
      setPhase(PHASE.PREPARE);
    });

    socket.on("round:prepare", ({ round, videoUrl, dub }) => {
      setResult(null);
      setVotes({ you: null, opponent: null });
      setFeedback(null);
      setOppStatus(null);
      setQuery("");
      setOptions([]);
      setPicked(null);
      setNeedTap(false);
      setRoundInfo({ round, videoUrl, dub: dub || null, durationMs: null });
      setPhase(PHASE.PREPARE);
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

    socket.on("guess:result", ({ correct }) => {
      if (!correct) {
        setFeedback("Not it — keep guessing!");
        setPicked(null);
        setOptions([]);
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
      refreshBoard();
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

    socket.on("opponent:left", ({ forfeited }) => {
      teardownRTC();
      setNotice(
        forfeited
          ? "Opponent left mid-round — you win this one. Finding a new opponent…"
          : "Opponent left. Finding a new opponent…"
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

  // ---------- Timer (visual only; server is authoritative) ----------
  function beginPlaying() {
    setPhase(PHASE.PLAYING);
    playStartRef.current = Date.now();
    setRemaining(1);
    const v = videoRef.current;
    if (v) {
      v.volume = volume;
      v.currentTime = 0;
      // If the browser blocks autoplay (gesture window elapsed during the
      // countdown), surface a one-tap fallback instead of failing silently.
      v.play().then(
        () => setNeedTap(false),
        () => setNeedTap(true)
      );
    }
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
      () => setNeedTap(false),
      () => {}
    );
  }
  function stopTimer() {
    clearInterval(tickRef.current);
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
  }, [volume, roundInfo?.videoUrl, phase]);

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
    const pc = new RTCPeerConnection({ iceServers: STUN });
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

  // ---------- Autocomplete ----------
  useEffect(() => {
    clearTimeout(searchTimer.current);
    if (!query || query.length < 2) {
      setOptions([]);
      return;
    }
    if (picked && query !== picked.name) setPicked(null);
    searchTimer.current = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/search?q=${encodeURIComponent(query)}`
        ).then((x) => x.json());
        setOptions(r.results || []);
        setActiveIdx(0);
      } catch (e) {
        console.error(e);
      }
    }, 180);
    return () => clearTimeout(searchTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const submitGuess = useCallback(() => {
    const guessText = query.trim();
    if (!guessText) return;
    socketRef.current?.emit("guess", { guessText, animeId: picked?.id });
  }, [query, picked]);

  function onKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      submitGuess();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Escape") {
      setOptions([]);
    }
  }

  // ---------- Actions ----------
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
  function toggleStats() {
    const next = !showStats;
    setShowStats(next);
    if (next) loadStats();
  }
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

  return (
    <div className="app">
      <div className="header">
        <div className="title-wrap">
          <img src="/anitune.png" alt="AniTune" className="app-icon" />
          <div className="title">
            Ani<span>Tune</span>
          </div>
        </div>
        {me && (
          <div className="rating-pill">
            {me.avatar ? (
              <img className="avatar" src={me.avatar} alt="" referrerPolicy="no-referrer" />
            ) : (
              <span className="avatar avatar-fallback">
                {initialOf(me.nickname)}
              </span>
            )}
            <div className="pill-info">
              <span className="pill-name">{me.nickname}</span>
              <span
                className="rank-badge"
                style={{ color: rankForElo(me.elo).color }}
              >
                {rankForElo(me.elo).name} · {me.elo}
              </span>
            </div>
            <button className="signout" onClick={signOut} title="Sign out">
              ⏻
            </button>
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
          <div style={{ textAlign: "center", padding: "28px 0" }}>
            <div className="lobby-id">
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
              <p style={{ margin: "10px 0 0" }}>
                Welcome back, <strong>{me?.nickname}</strong>
              </p>
              <span
                className="rank-badge"
                style={{ color: rankForElo(me?.elo).color }}
              >
                {rankForElo(me?.elo).name} · {me?.elo} Elo
              </span>
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

            <p style={{ color: "var(--muted)", marginTop: 20 }}>
              Battle players. Guess faster. Climb ELO.
            </p>
            <div
              className="button-row"
              style={{ maxWidth: 360, margin: "16px auto 0" }}
            >
              <button onClick={findMatch} disabled={!connected}>
                {connected ? "Find a match" : "Connecting…"}
              </button>
              <button
                className="secondary"
                onClick={createInvite}
                disabled={!connected}
              >
                Play a friend
              </button>
            </div>

            <button className="link-btn" onClick={toggleStats}>
              {showStats ? "Hide stats" : "Stats & recent matches"}
            </button>

            {showStats && stats && (
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
          <div style={{ textAlign: "center", padding: "40px 0" }}>
            <div className="pulse">Finding an opponent…</div>
            <div className="button-row" style={{ maxWidth: 220, margin: "20px auto 0" }}>
              <button className="danger" onClick={cancelQueue}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ---------- Match ---------- */}
        {inMatch && (
          <>
            <div className="vs-bar">
              <PlayerBadge p={me} label="YOU" />
              <div className="vs-mid">
                vs{roundInfo?.round ? ` · round ${roundInfo.round}` : ""}
              </div>
              <PlayerBadge p={opponent} label="OPPONENT" />
            </div>

            <div className="player-wrap">
              <video
                ref={videoRef}
                key={roundInfo?.videoUrl}
                src={roundInfo?.videoUrl}
                playsInline
                controls={phase === PHASE.RESULT}
                onLoadedMetadata={onLoadedMetadata}
                onError={() =>
                  roundInfo?.videoUrl &&
                  setNotice(
                    "Couldn't load this opening (network/CDN). Skipping…"
                  )
                }
                style={{
                  visibility: phase === PHASE.RESULT ? "visible" : "hidden",
                }}
              />
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
              {phase === PHASE.PLAYING && !needTap && (
                <div className="player-cover">
                  ▶ audio playing — name the anime
                  {roundInfo?.dub && (
                    <span className="dub-badge">🎙 English dub</span>
                  )}
                </div>
              )}
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
            {(camOn || micOn || hasRemote) && (
              <div className="av-videos">
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className={"av-remote" + (hasRemote ? "" : " empty")}
                />
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="av-local"
                />
              </div>
            )}

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
                  {options.length > 0 && !picked && (
                    <div className="autocomplete">
                      {options.map((o, i) => (
                        <div
                          key={o.id}
                          className={"item" + (i === activeIdx ? " active" : "")}
                          onMouseEnter={() => setActiveIdx(i)}
                          onClick={() => {
                            setPicked(o);
                            setQuery(o.name);
                            setOptions([]);
                            inputRef.current?.focus();
                          }}
                        >
                          {o.name}
                          {o.year && <span className="year">({o.year})</span>}
                        </div>
                      ))}
                    </div>
                  )}
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
              />
            )}
          </>
        )}
      </div>

      {board.length > 0 && (
        <div className="history">
          <h3>Leaderboard</h3>
          {board.map((p, i) => (
            <div className="history-row" key={p.id}>
              <div className="name">
                {i + 1}. {p.nickname}
              </div>
              <div className="meta">
                {p.elo} · {p.wins}W/{p.losses}L
              </div>
            </div>
          ))}
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

function ResultPanel({ result, votes, opponent, onVote }) {
  const r = result.result || {};
  const won = r.youWon;
  const cls =
    result.outcome === "timeout" ? "wrong" : won ? "correct" : "wrong";
  const delta = r.delta ?? 0;
  const pop = result.popularity || {};

  return (
    <div className={"result " + cls}>
      <h3>
        {result.outcome === "timeout"
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
      <div style={{ color: "var(--muted)", fontSize: 13, marginTop: 4 }}>
        {pop.members != null
          ? `MAL: ${pop.members.toLocaleString()} members`
          : "MAL popularity unknown"}
        {pop.score ? ` · score ${pop.score}` : ""}
        {pop.factor != null
          ? ` · stake ×${pop.factor.toFixed(2)} (${
              pop.factor > 0.66
                ? "obscure"
                : pop.factor > 0.33
                ? "moderate"
                : "popular"
            })`
          : ""}
      </div>

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
    </div>
  );
}
