import { useEffect, useRef, useState, useCallback } from "react";
import { io } from "socket.io-client";

// Screen phases driven almost entirely by server events.
const PHASE = {
  NICK: "nick",       // choosing a nickname
  QUEUE: "queue",     // waiting for an opponent
  PREPARE: "prepare", // opponent found, buffering the opening
  COUNTDOWN: "countdown",
  PLAYING: "playing", // racing to guess
  RESULT: "result",   // answer revealed + rematch vote
};

const LS_GUEST = "aoe.guestId";
const LS_NICK = "aoe.nickname";

export default function App() {
  const socketRef = useRef(null);
  const videoRef = useRef(null);

  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState(PHASE.NICK);
  const [nickname, setNickname] = useState(
    () => localStorage.getItem(LS_NICK) || ""
  );
  const [me, setMe] = useState(null);          // { nickname, elo, wins, losses }
  const [opponent, setOpponent] = useState(null);
  const [roundInfo, setRoundInfo] = useState(null); // { round, videoUrl, durationMs }
  const [countdown, setCountdown] = useState(0);
  const [remaining, setRemaining] = useState(1); // 0..1 fraction for timer bar
  const [feedback, setFeedback] = useState(null); // transient guess feedback
  const [oppStatus, setOppStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [votes, setVotes] = useState({ you: null, opponent: null });
  const [notice, setNotice] = useState(null);
  const [board, setBoard] = useState([]);

  // Guess autocomplete
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [picked, setPicked] = useState(null);
  const searchTimer = useRef(null);
  const inputRef = useRef(null);

  const durationRef = useRef(null); // ms, for the visual timer
  const playStartRef = useRef(null);
  const tickRef = useRef(null);

  // ---------- Socket setup ----------
  useEffect(() => {
    const socket = io({ path: "/socket.io" });
    socketRef.current = socket;

    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => {
      setConnected(false);
      setNotice("Disconnected from server. Reconnecting…");
    });

    socket.on("joined", ({ guestId, player }) => {
      localStorage.setItem(LS_GUEST, guestId);
      localStorage.setItem(LS_NICK, player.nickname);
      setMe(player);
    });

    socket.on("queued", () => {
      setPhase(PHASE.QUEUE);
      setNotice(null);
      setResult(null);
    });
    socket.on("queueCancelled", () => setPhase(PHASE.NICK));

    socket.on("matchFound", ({ you, opponent }) => {
      setMe(you);
      setOpponent(opponent);
      setResult(null);
      setVotes({ you: null, opponent: null });
      setFeedback(null);
      setOppStatus(null);
      setNotice(null);
      setPhase(PHASE.PREPARE);
    });

    socket.on("round:prepare", ({ round, videoUrl }) => {
      setResult(null);
      setVotes({ you: null, opponent: null });
      setFeedback(null);
      setOppStatus(null);
      setQuery("");
      setOptions([]);
      setPicked(null);
      setRoundInfo({ round, videoUrl, durationMs: null });
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
        setQuery("");
        setOptions([]);
        setTimeout(() => inputRef.current?.focus(), 30);
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
    });

    socket.on("rematch:state", (v) => setVotes(v));
    socket.on("rematch:accepted", () => {
      setNotice(null);
      setPhase(PHASE.PREPARE);
    });

    socket.on("opponent:left", ({ forfeited }) => {
      setNotice(
        forfeited
          ? "Opponent left mid-round — you win this one. Finding a new opponent…"
          : "Opponent left. Finding a new opponent…"
      );
    });
    socket.on("match:over", ({ reason }) => {
      if (reason === "you_left") setPhase(PHASE.NICK);
      else setNotice("Match ended. Finding a new opponent…");
    });

    socket.on("errorMsg", ({ message }) => setNotice(message));

    return () => socket.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-join once connected if we already have a saved nickname.
  useEffect(() => {
    if (connected && nickname && !me) doJoin(nickname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  function doJoin(name) {
    socketRef.current?.emit("join", {
      nickname: name,
      guestId: localStorage.getItem(LS_GUEST) || undefined,
    });
  }

  // ---------- Timer (visual only; server is authoritative on round end) ----------
  function beginPlaying() {
    setPhase(PHASE.PLAYING);
    playStartRef.current = Date.now();
    setRemaining(1);
    const v = videoRef.current;
    if (v) {
      v.currentTime = 0;
      v.play().catch(() => {});
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
  function stopTimer() {
    clearInterval(tickRef.current);
    const v = videoRef.current;
    if (v) v.pause();
  }
  useEffect(() => () => clearInterval(tickRef.current), []);

  // Report the loaded media length so the server can size the round timer.
  function onLoadedMetadata() {
    const v = videoRef.current;
    if (v && Number.isFinite(v.duration)) {
      socketRef.current?.emit("mediaDuration", {
        ms: Math.round(v.duration * 1000),
      });
    }
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
    if (!picked) return;
    socketRef.current?.emit("guess", { animeId: picked.id });
  }, [picked]);

  function onKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (options.length && !picked) {
        const opt = options[activeIdx];
        setPicked(opt);
        setQuery(opt.name);
        setOptions([]);
      } else if (picked) {
        submitGuess();
      }
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
  function startQueue() {
    const name = nickname.trim();
    if (!name) return;
    if (!me) doJoin(name);
    socketRef.current?.emit("queue");
  }
  const cancelQueue = () => socketRef.current?.emit("cancelQueue");
  const leaveMatch = () => socketRef.current?.emit("leaveMatch");
  const vote = (yes) => socketRef.current?.emit("rematchVote", { yes });

  async function refreshBoard() {
    try {
      const r = await fetch("/api/leaderboard").then((x) => x.json());
      setBoard(r.players || []);
    } catch {}
  }
  useEffect(() => {
    refreshBoard();
  }, []);

  // ---------- Render helpers ----------
  const PlayerBadge = ({ p, label }) =>
    p && (
      <div className="vs-side">
        <div className="vs-label">{label}</div>
        <div className="vs-name">{p.nickname}</div>
        <div className="vs-elo">{p.elo} Elo</div>
      </div>
    );

  return (
    <div className="app">
      <div className="header">
        <div className="title">
          Anime Opening <span>Elo</span>
        </div>
        {me && (
          <div className="rating-pill">
            <small>{me.nickname}</small>
            {me.elo}
          </div>
        )}
      </div>

      {notice && <div className="notice">{notice}</div>}

      <div className="card">
        {/* ---------- Nickname ---------- */}
        {phase === PHASE.NICK && (
          <div style={{ textAlign: "center", padding: "24px 0" }}>
            <p style={{ color: "var(--muted)", marginTop: 0 }}>
              Get matched against another player. You both hear the same
              opening — first to name the anime wins Elo. Obscure shows are
              worth far more than popular ones.
            </p>
            <div style={{ maxWidth: 320, margin: "20px auto 0" }}>
              <input
                type="text"
                placeholder="Pick a nickname"
                value={nickname}
                maxLength={24}
                onChange={(e) => setNickname(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && startQueue()}
              />
              <div className="button-row">
                <button
                  onClick={startQueue}
                  disabled={!connected || !nickname.trim()}
                >
                  {connected ? "Find a match" : "Connecting…"}
                </button>
              </div>
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

        {/* ---------- Versus bar (prepare / countdown / playing / result) ---------- */}
        {(phase === PHASE.PREPARE ||
          phase === PHASE.COUNTDOWN ||
          phase === PHASE.PLAYING ||
          phase === PHASE.RESULT) && (
          <>
            <div className="vs-bar">
              <PlayerBadge p={me} label="YOU" />
              <div className="vs-mid">
                vs{roundInfo?.round ? ` · round ${roundInfo.round}` : ""}
              </div>
              <PlayerBadge p={opponent} label="OPPONENT" />
            </div>

            <div className="player-wrap">
              {/* Audio-only while guessing; visible (with controls) on result. */}
              <video
                ref={videoRef}
                key={roundInfo?.videoUrl}
                src={roundInfo?.videoUrl}
                playsInline
                controls={phase === PHASE.RESULT}
                onLoadedMetadata={onLoadedMetadata}
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
              {phase === PHASE.PLAYING && (
                <div className="player-cover">
                  ▶ audio playing — name the anime
                </div>
              )}
            </div>

            {/* ---------- Playing ---------- */}
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
                    placeholder="Start typing an anime name…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
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
                  <button onClick={submitGuess} disabled={!picked}>
                    Submit guess
                  </button>
                  <button className="danger" onClick={leaveMatch}>
                    Forfeit
                  </button>
                </div>
              </>
            )}

            {/* ---------- Result + rematch ---------- */}
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
      {result.answer?.song && (
        <div style={{ color: "var(--muted)", fontSize: 14 }}>
          ♪ {result.answer.song}
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        Your Elo:{" "}
        <strong>{r.eloAfter}</strong>{" "}
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
        <div className="rematch-q">
          Play {opponent?.nickname} again?
        </div>
        <div className="vote-state">
          You:{" "}
          <b>{votes.you == null ? "—" : votes.you ? "Yes" : "No"}</b>
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
          <button
            onClick={() => onVote(true)}
            disabled={votes.you != null}
          >
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
