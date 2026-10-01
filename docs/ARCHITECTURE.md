# Architecture

```
          Twitch IRC (wss, anonymous)
                     │  chat messages
                     ▼
┌──────────────────────────────────────────────────────────┐
│ Node.js server (Fastify)                                  │
│                                                          │
│  TwitchChatClient ──► RoomRegistry ──► Room ──► GameEngine│
│   (ref-counted joins,   (chat routing,   (broadcast      │
│    reconnect/backoff)    persistence)     throttling,    │
│                                           timers)        │
│  WS gateway (/ws) ◄──────────────────────┘               │
│  REST (/api/rooms) · static assets · /healthz            │
└───────────────┬───────────────────────────┬──────────────┘
                │ host state + commands     │ public state
                ▼                           ▼
        Control panel (/control)      Overlay (/overlay?room=…)
          streamer's browser            OBS browser source
```

## Key decisions

**Single stateful service.** Live overlays need server push and the chat connection must stay open,
so the app is one long-running Node process rather than serverless functions. Game state lives in
memory (fast, simple) and is snapshotted to disk with debounced atomic writes so restarts and
deploys don't lose rounds or scores.

**Pure game engine.** `GameEngine` is a deterministic state machine with injected clock and random
source and no I/O. All rules — phases, clue limits, scoring, card generation — are unit-tested in
isolation. `Room` adds the side-effects: timers, persistence notifications and broadcasting.

**Information hiding by construction.** The engine produces two views: `getPublicState()` (overlay)
and `getHostState()` (adds the secret card and target). The overlay never receives the target until
the round is revealed, so it cannot leak through browser dev tools or a shared overlay URL.

**Authentication.** Creating a room returns a random 256-bit host token, stored only in the
streamer's browser; the server keeps a SHA-256 hash and compares in constant time. The token is sent
inside the first WebSocket message rather than the URL so it never appears in access logs. Overlay
URLs contain only the public room id and are read-only. An optional `ACCESS_CODE` and
`ALLOWED_CHANNELS` stop strangers from using a public instance.

**Back-pressure.** Popular channels can produce hundreds of guesses per second. Guess broadcasts are
coalesced (at most four per second per room), the public state carries a capped list of recent
guesses plus per-cell counts, and per-round guess totals are bounded. Incoming WebSocket messages
are size-limited, schema-validated with zod and rate-limited per connection; room creation is
rate-limited per IP.

**Resilience.** The chat client reconnects with jittered exponential back-off, honours Twitch's
`RECONNECT`, detects dead connections with keepalive pings and rejoins channels. Browser clients
reconnect indefinitely (OBS sources run for hours) except after an authorisation failure.

**Colour board.** Colours are generated in OKLCH (perceptually uniform) and gamut-mapped to sRGB hex
in TypeScript, so neighbouring squares look evenly spaced and the board renders identically in older
OBS browser engines that lack CSS `oklch()`.

## Wire protocol

Defined in `src/shared/protocol.ts`.

1. Client connects to `/ws` and sends `hello` (`role: "overlay"` with `roomId`, or `role: "host"`
   with `roomId` and `token`).
2. Server replies `welcome`, `chatStatus`, then a full `state` message, and pushes a new `state`
   after every change.
3. Hosts send commands: `drawCard`, `selectTarget`, `giveClue`, `closeGuessing`, `reveal`,
   `cancelRound`, `resetScores`, `updateSettings`, `simulateGuess`.
4. Failures come back as `error` messages; fatal problems close the socket with a 44xx code.

## Game phases

```
idle ─drawCard→ picking ─giveClue→ guessing ─close→ intermission ─giveClue→ guessing
                  ↺ drawCard (redraw)    │                  │
                                         └──close/reveal──→ reveal ─drawCard→ picking
any phase ─cancelRound→ idle
```
