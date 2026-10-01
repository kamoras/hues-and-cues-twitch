# Hues & Cues for Twitch

A colour-guessing party game in the style of _Hues and Cues_, played by your Twitch chat.

- **The streamer** draws a card, secretly picks one of its four colours and gives a one-word clue
  (then optionally a two-word clue) from a web control panel.
- **Chat** guesses the square by typing a coordinate such as `F12` (or `!guess F12`).
- **The stream** shows a live overlay — an OBS browser source with the board, clue, timer,
  guesses, results and a running leaderboard.

No Twitch login, bot account or developer application is required: the server reads public
chat anonymously.

| Overlay (OBS browser source)                    | Control panel                                     |
| ----------------------------------------------- | ------------------------------------------------- |
| Board, clues, countdown, latest guesses, scores | Card picker, clue entry, round controls, settings |

## Quick start (local)

Requires Node.js 22.12+.

```bash
npm ci
npm run build
npm start            # http://localhost:8080
```

Open <http://localhost:8080/control>, enter your channel name, then copy the **overlay URL** into
OBS → _Sources_ → _Browser_ (width 1920, height 1080). The control panel's
**Test without chat** card lets you rehearse a round without anyone in chat.

For development with hot reload, run `npm run dev` and open <http://localhost:5173>.

## How a round works

1. **Draw a card** — four well-separated colours appear, visible only to you.
2. **Pick a colour** and enter a **one-word clue**. Guessing opens on stream.
3. Chat types coordinates. Each chatter gets one guess per clue (they may move it while guessing
   is open unless you disable that).
4. Guessing closes when the timer runs out or you close it. Give a **second clue** (up to two
   words) for a second guess, or reveal immediately.
5. **Reveal** — the target and its scoring frames appear on the board.

### Scoring

Each guess scores by its distance from the target, measured in squares (diagonals count as one):

| Guess position             | Points |
| -------------------------- | -----: |
| On the target              |      3 |
| In the 3×3 frame around it |      2 |
| In the 5×5 frame around it |      1 |

Both of a player's guesses score. The streamer earns one point for every guess inside the 3×3
frame — a good clue pays off.

### Settings (control panel)

| Setting                   | Default | Description                                          |
| ------------------------- | ------- | ---------------------------------------------------- |
| Guess timer               | 45 s    | `0` means guessing stays open until you close it     |
| Second clue               | on      | Adds the two-word clue and second guess              |
| Let chatters change guess | on      | Latest guess counts while guessing is open           |
| Require `!guess`          | off     | Ignore bare `F12` messages; only `!guess F12` counts |
| Enforce clue word limits  | on      | One word, then two                                   |

Accepted chat formats: `F12`, `f12`, `F 12`, `F-12`, `12F`, `!guess F12`, `!g F12`, `!hue F12`.

## Deployment

The game needs a long-running server: it holds a WebSocket connection to Twitch chat and pushes
live updates to the overlay. **Serverless platforms such as Vercel cannot do this** (functions
are short-lived and cannot hold WebSocket connections), so deploy to any small always-on host.

**Oracle Cloud Always Free** is a great fit and is fully documented in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). In short, on the VM:

```bash
git clone https://github.com/kamoras/hues-and-cues-twitch.git && cd hues-and-cues-twitch
cp .env.example .env    # set DOMAIN (e.g. 203-0-113-7.sslip.io) and ACCESS_CODE
docker compose up -d --build
```

Caddy provisions an HTTPS certificate automatically. The Docker image also runs as-is on Fly.io,
Railway, Render or any VPS.

### Configuration

All configuration is via environment variables (see [`.env.example`](.env.example)):

| Variable              | Default  | Purpose                                                  |
| --------------------- | -------- | -------------------------------------------------------- |
| `PORT`                | `8080`   | HTTP port                                                |
| `ACCESS_CODE`         | —        | Required to create rooms. **Set this on public servers** |
| `ALLOWED_CHANNELS`    | —        | Comma-separated allow-list of Twitch channels            |
| `DATA_DIR`            | `./data` | Where rooms and scores are persisted                     |
| `ROOM_RETENTION_DAYS` | `30`     | Unused rooms are deleted after this long                 |
| `MAX_ROOMS`           | `500`    | Upper bound on rooms                                     |
| `TRUST_PROXY`         | `false`  | Set behind a reverse proxy                               |
| `LOG_LEVEL`           | `info`   | Pino log level                                           |

## Development

```bash
npm run dev            # server (tsx watch) + Vite dev server with proxy
npm run check          # format check, lint, typecheck, tests
npm run test:coverage  # tests with coverage thresholds
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## Project layout

```
src/
  shared/    Board geometry, colour generation, rules and the wire protocol (server + browser)
  server/    Fastify app, WebSocket gateway, game engine, rooms, Twitch chat client, persistence
  client/    Landing page, control panel and overlay (Vite, TypeScript, no framework)
test/        Vitest unit and integration tests
deploy/      Caddyfile and systemd unit
```

_Hues and Cues_ is a trademark of The Op Games. This is an unofficial fan project and is not
affiliated with or endorsed by The Op.
