# Anime Opening Elo

A real-time 1v1 game. Two players are matched from a queue, hear the **same
anime opening** at the same time, and race to name the anime. First correct
guess wins Elo; the loser loses Elo. If nobody gets it before the song ends,
both players lose points. After each round, both can vote to rematch the same
opponent — otherwise they're put back in the queue.

Songs and video are streamed from
[AnimeThemes.moe](https://animethemes.moe); show popularity comes from
[MyAnimeList](https://myanimelist.net) (via the Jikan API).

## Architecture

```
client/   Vite + React frontend            (localhost:5173)
server/   Express + Socket.IO backend      (localhost:5174)
  ├── server.js         matchmaking queue + round state machine
  ├── selectOpening.js  Elo-averaged difficulty-targeted song picker
  ├── animethemes.js    AnimeThemes fetch + search + MAL-id resolve
  ├── popularity.js     MAL popularity (Jikan) → Elo-swing / difficulty factor
  ├── elo.js            popularity-scaled PvP Elo
  ├── db.js             SQLite persistence (better-sqlite3)
  └── data/elo.db       players, popularity cache, match history (auto-created)
```

The client proxies `/api/*` **and the `/socket.io` websocket** to the server
(see `client/vite.config.js`), so everything is same-origin in dev.

The server is authoritative on everything that matters: it holds the answer
(clients never receive it until the round ends), runs the round timer, and
settles Elo. Clients only report their loaded media duration so the timer can
match the song length without trusting a single client.

## Run it

Requires Node 18+ (Node 22 tested). From the repo root:

```bash
npm run install:all   # root + server + client deps (first time only)
npm run dev            # starts BOTH server and client in one terminal
```

Open <http://localhost:5173> in **two browser tabs** (or two machines), pick
different nicknames, and hit **Find a match** in both — they'll pair up.

`npm start` runs the production-ish variant (`node server.js` + `vite
preview`).

## How a round works

1. **Queue** — players join a plain FIFO queue. The two longest-waiting
   players are paired. Matchmaking does **not** consider Elo.
2. **Difficulty selection** — the server averages the two players' Elo and
   picks an opening whose MAL popularity matches that average: low average →
   a popular, easy-to-name show; high average → an obscure deep cut. Only
   strong pairs get hard songs.
3. **Synced start** — both clients buffer the opening, report its length, then
   a shared 3-2-1 countdown plays the audio simultaneously (video hidden).
4. **Race** — type a name, pick from the autocomplete, submit. Guessing is
   unlimited; the server validates each guess against the hidden answer.
5. **Resolve** — first correct guess wins; Elo is exchanged. If the song ends
   with nobody correct, both lose points. The answer, MAL stats, and Elo
   deltas are revealed.
6. **Rematch** — both players vote. Both *yes* → next round vs the same
   opponent. Anyone declines or leaves → remaining player is requeued.

Disconnecting or forfeiting mid-round counts as a loss; the opponent wins.

## Elo model

- Everyone starts at **1200**; ratings can't drop below **100**.
- Standard pairwise Elo with `K = 32`, multiplied by a **popularity factor**
  (`0.4 + factor`, factor ∈ [0,1], ~1 = obscure): correctly naming an obscure
  OP is worth ~3× an equally-likely win on a blockbuster.
- Timeout (nobody guessed): both players lose a flat **12** points.
- Because difficulty *and* reward both scale with obscurity, high-rated
  players face harder songs but those wins are also worth the most.

All Elo constants live in `server/elo.js`; the Elo→difficulty curve lives in
`server/popularity.js` (`targetFactorForElo`, `EASY_ELO`/`HARD_ELO`).

## API surface

REST:

- `GET /api/health` — liveness
- `GET /api/search?q=…` — anime autocomplete (proxied to AnimeThemes)
- `GET /api/leaderboard` — top 20 players by Elo

Socket.IO (client → server): `join`, `queue`, `cancelQueue`,
`mediaDuration`, `guess`, `rematchVote`, `leaveMatch`.
(server → client): `joined`, `queued`, `matchFound`, `round:prepare`,
`round:start`, `guess:result`, `opponent:guessed`, `round:end`,
`rematch:state`, `rematch:accepted`, `opponent:left`, `match:over`,
`errorMsg`.

## Identity

Players are **guests**: a nickname plus a per-browser `guestId` in
localStorage that keeps your Elo across sessions. The `players` table already
carries nullable `email` / `password_hash` / `auth_provider` columns, so real
accounts can be added later without migrating the hot path.

## Scaling notes

This is a **single Node process** with an in-memory queue and match state —
fine for a meaningful number of concurrent players. Running multiple
instances later requires the Socket.IO Redis adapter and moving
queue/match state into Redis. SQLite (WAL mode) is plenty to start; swap
`db.js` for Postgres if write volume demands it. Jikan popularity is cached
in SQLite so it's queried roughly once per show, ever.

## Legality note

AnimeThemes.moe is a fan-run preservation archive operating in a legal gray
area. It's a stable, openly used public API, fine for a personal/hobby
project. Don't monetize or aggressively scale this without revisiting that.
```
