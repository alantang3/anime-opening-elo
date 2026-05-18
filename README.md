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

For production, `npm run build` builds the React app and `npm start` runs a
**single** Node process that serves the API, the websocket, and that built
app together (see Deploy below).

## Deploy (Render)

This runs as **one service** — the Node server serves everything, so there's
no separate frontend deploy, no CORS, and no websocket-URL config.

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New → Blueprint**, pick the repo.
   Render reads `render.yaml`:
   - build: `npm install && npm run build`
   - start: `npm start` (`node server/server.js`)
   - health check: `/api/health`
   - a 1 GB persistent disk mounted at `/var/data`, with `DATA_DIR` pointed
     at it so the SQLite DB (players, Elo, leaderboard) survives redeploys.
3. First deploy takes a few minutes (it compiles `better-sqlite3`). Open the
   service URL — the game is live; share it and open it on two devices.

**Cost / free-tier caveat:** Render persistent disks require a paid instance
(`starter` plan, ~$7/mo). Render's **free** plan has no disk *and* sleeps
after ~15 min idle (a cold start interrupts any live match). To deploy free,
delete the `disk:` block in `render.yaml` and set `plan: free` — the DB then
resets on every deploy/restart. (Fly.io is an alternative with free
volumes; the same single-service build works there via a Dockerfile.)

Env vars: **`GOOGLE_CLIENT_ID`** (required — set it in the Render dashboard;
sign-in won't work without it), `DATA_DIR` (writable persistent path; set by
`render.yaml`), optional `SESSION_SECRET` (auto-generated into `DATA_DIR` if
unset). `PORT` is provided by the host. After deploying, add the live
`https://…` URL to the OAuth client's authorized JavaScript origins.

## How a round works

1. **Queue** — players join a plain FIFO queue. The two longest-waiting
   players are paired. Matchmaking does **not** consider Elo.
2. **Difficulty selection** — the server averages the two players' Elo and
   picks an opening whose MAL popularity matches that average: low average →
   a popular, easy-to-name show; high average → an obscure deep cut. Only
   strong pairs get hard songs.
3. **Synced start** — both clients buffer the opening, report its length, then
   a shared 3-2-1 countdown plays the audio simultaneously (video hidden).
4. **Race** — free-text guessing (autocomplete is just an aid). Unlimited
   attempts; the server validates against a hidden accepted-answer set.
5. **Resolve** — first correct guess wins; Elo is exchanged. If the song ends
   with nobody correct, both lose points. The answer, MAL stats, and Elo
   deltas are revealed.
6. **Rematch** — both players vote. Both *yes* → next round vs the same
   opponent. Anyone declines or leaves → remaining player is requeued.

Disconnecting or forfeiting mid-round counts as a loss; the opponent wins.

### Guessing (franchise-level)

A guess is correct if it names the right **franchise**, not the exact entry.
The English title, Japanese/romaji title, an acronym of either (AoT, SnK,
MHA), or any season/movie title of the franchise all count — none required.
Matching is exact-after-normalization (diacritics/punctuation/case folded,
season/part/movie markers stripped) with broad alias coverage from
AnimeThemes synonyms + Jikan title variants. See `server/matching.js`.

### Dubbed franchises

Every show plays its original **Japanese** opening, except **Pokémon** and
**Digimon Adventure**, which play the **English dub**. AnimeThemes hosts
those dub openings itself as separate theme records with a `-EN` slug
(`Pokemon-OP1-EN.webm` = "Pokémon Theme"), so no external hosting is needed.

Configured in `server/dubOverrides.js` by normalized name substring, so it
covers every Pokémon season (`Pokemon Best Wishes!` = Black & White,
`Pokemon XY`, …) while staying narrow on `digimon adventure` (Digimon
Tamers/Frontier keep their Japanese OPs). When a dub show is chosen, **a
random one of its English OPs** plays. If a specific show has no `-EN`
opening on AnimeThemes (e.g. Pokémon XY), it **falls back to the Japanese
opening** — nothing is ever skipped. The dub name is an accepted guess
regardless.

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

## Accounts (Google sign-in, required)

There is **no guest mode** — you sign in with Google and your Elo, record,
and leaderboard spot are tied to that account.

Flow: the browser gets a Google ID token from Google Identity Services and
POSTs it to `POST /api/auth/google`; the server verifies it (audience =
your client id) via `google-auth-library`, upserts the account by the stable
Google `sub` (`server/db.js`), and returns **our own** session JWT. The
socket connection authenticates with that token (`socket.emit("auth", …)`);
unauthenticated sockets can't queue. Session JWTs are signed with a secret
from `SESSION_SECRET`, or an auto-generated key persisted in `DATA_DIR`
(`session-secret`) so logins survive restarts with zero config.

**One-time Google Cloud setup** (free):

1. [console.cloud.google.com](https://console.cloud.google.com) → new project.
2. **APIs & Services → OAuth consent screen** → External; add yourself as a
   test user (or Publish). Scopes: just the default `email`/`profile` —
   non-sensitive, no verification review needed.
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   Under **Authorized JavaScript origins** add `http://localhost:5173`
   (dev), `http://localhost:5174`, and your deployed `https://…` URL. (The
   GIS button uses the JS origin — no redirect URI needed.)
4. Copy the **Client ID** and set it as the `GOOGLE_CLIENT_ID` env var on the
   server. The client reads it from `GET /api/config` — no client-side env.

## Camera / mic with your opponent (WebRTC)

Opt-in **📷 Camera** / **🎤 Mic** toggles appear during a match. Media is
peer-to-peer (`RTCPeerConnection`); the existing Socket.IO connection only
relays SDP/ICE between the two matched players (`rtc:signal`), using the
perfect-negotiation pattern with a server-assigned `polite` peer.

Caveats: `getUserMedia` requires a **secure context** — fine on the Render
HTTPS URL and on `localhost`, but plain-HTTP LAN IPs won't grant devices.
Connectivity uses a free public **STUN** server, which connects most
players; peers behind strict/symmetric NAT need a **TURN** relay (a paid /
self-hosted server) that isn't configured here.

## Identity / data

Accounts live in the `players` table keyed by a UUID with a unique
`google_sub`; `email`/`avatar`/`auth_provider` are stored from the Google
profile. Everything persists in the SQLite DB under `DATA_DIR`.

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
