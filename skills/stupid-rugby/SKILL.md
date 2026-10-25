---
name: stupid-rugby
description: Rugby union fixtures, results, live scores, standings, match details (scorers, cards, line-ups, stats) and score notifications from the free Stupid Rugby API (rugby.stupidtech.net). Use when asked about rugby union matches or teams, e.g. "when do Leinster play next", "what's the URC table", "who scored for the Stormers", "is anyone playing now", "Six Nations results", or when an agent wants to be notified of kick-offs, scores, half-time and full time for teams, matches or competitions. Men's competitions only: Six Nations, Rugby Championship, Rugby World Cup, internationals, URC, Premiership, Top 14, Champions/Challenge Cup, Super Rugby, Japan League One, MLR, Currie Cup, NPC, Pro D2 and more.
---

# Stupid Rugby API

Base URL: `https://rugby.stupidtech.net/api`. It's free, needs no auth, returns JSON, and allows any origin for GET. `GET /api` returns a machine-readable index of every endpoint.

The data comes from World Rugby (and ESPN for standings), collected by an index that polls every 10s while matches are live. Reads never touch upstream, so you can query freely, but please cache what you can.

## Conventions

- Dates in query params are UTC `YYYY-MM-DD`. Timestamps in responses are ISO 8601 UTC. Convert kick-off times to the user's timezone when answering.
- The index covers about 5 years back to 1 year ahead. `GET /api/status` gives the exact `window`, and ranges outside it return 400.
- A 503 with "Index is warming up" means the first backfill is still running, so retry in a few minutes. Errors are `{ "error": "..." }`.
- Only men's rugby union is covered.

## Data model

A **match**:

```json
{
  "id": "75c07e8a-8c3f-4bc0-9c43-7cc3c49764d6",
  "competition": "English Premiership 2027",
  "competitionId": "6cacfefe-eb6f-4314-989c-893ebff51651",
  "round": "League",
  "kickoff": "2026-10-25T15:00:00.000Z",
  "venue": "Twickenham Stoop, Twickenham",
  "home": { "id": "81", "name": "Harlequins", "score": 33 },
  "away": { "id": "74", "name": "Saracens", "score": 10 },
  "state": "L2",
  "phase": "live",
  "clock": "58:00",
  "winner": null
}
```

- `phase` is one of `scheduled`, `live`, `complete`, `postponed` or `cancelled`. Use it rather than `state`, which is the raw World Rugby code. In `state`, `LHT` means half-time and `L1`/`L2` mean the first and second half.
- `winner` is `"home"`, `"away"` or `"draw"` once complete, and otherwise `null`.
- Scores are only meaningful when `phase` is `live` or `complete`.
- `clock` in match lists only moves when the score changes. `/summary` has the fresher clock.
- `competitionId` is the **season** id, which changes every year. Use it with `/api/seasons/{id}`.
- `competition` labels include the season year, and their wording sometimes changes between seasons.

## Endpoints

| Endpoint                                         | Returns                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/competitions`                          | `{ competitions: [{ key, name, standings }] }`: major competitions with stable keys (`urc`, `six-nations`, `top-14`, …)                                                                                                                                                                                     |
| `GET /api/teams?q=leinster`                      | `{ teams: [{ id, name, matches, lastMatch, latestCompetition }] }`: team ids by name (substring, 2+ chars)                                                                                                                                                                                                  |
| `GET /api/matches?from=2026-10-19&to=2026-10-26` | `{ matches: [...] }`: every match kicking off in `[from, to)`, all competitions, sorted by kick-off                                                                                                                                                                                                         |
| `GET /api/matches?from=…&to=…&teams=1139,81`     | The same, only matches involving those team ids                                                                                                                                                                                                                                                             |
| `GET /api/matches/live`                          | `{ matches: [...] }`: matches in progress                                                                                                                                                                                                                                                                   |
| `GET /api/matches/{id}`                          | `{ match }`                                                                                                                                                                                                                                                                                                 |
| `GET /api/matches/{id}/summary`                  | `{ final, match, lineups: { home, away }, incidents, officials }`: scorers and cards in clock order, line-ups with numbers, positions, captain and replacement flags                                                                                                                                        |
| `GET /api/matches/{id}/stats`                    | `{ final, stats: { home, away } \| null }`: team stats keyed by World Rugby names (`Possession`, `Territory`, `Tackles`, `MissedTackles`, `Carries`, `Metres`, `CleanBreaks`, `LineoutsWon`, `TotalLineouts`, `PenaltiesConceded`, …). Percentages are fractions (0.66), and stats are null before kick-off |
| `GET /api/seasons`                               | `{ seasons: [{ id, label, start, end }] }`: every indexed season, newest first                                                                                                                                                                                                                              |
| `GET /api/seasons/{id}`                          | `{ season, matches, standings }`. `standings` is `{ source, groups: [{ name, rows: [{ position, team, played, won, drawn, lost, pointsFor, pointsAgainst, bonusPoints, points }] }] }`, or `null` when none are published. Pool competitions have one group per pool                                        |
| `GET /api/status`                                | `{ ready, window: { from, to }, lastKickoff, backlog, cooldownUntil, lastError }`                                                                                                                                                                                                                           |
| `WS /api/live`                                   | Pushes `{ "type": "matches", "matches": [...] }` for every changed match near now. Send `ping` to get `pong`                                                                                                                                                                                                |

Each incident in `summary.incidents` looks like `{ kind, team: "home" | "away", secs, clock, player }`. `kind` is one of `try`, `conversion`, `penalty`, `drop-goal`, `yellow-card` or `red-card`. A `try` with a `null` player is a penalty try. Minutes follow rugby convention, `floor(secs / 60) + 1`, so 02:56 is the 3rd minute.

## Recipes

- **A team's next match or last result:** find the id with `/api/teams?q=`, then call `/api/matches?from=<today-60d>&to=<today+120d>&teams=<id>`. Take the first match with `phase` `scheduled` and the last with `phase` `complete`.
- **A competition table:** list `/api/seasons` and filter labels by the competition name (for example "URC"), or take `competitionId` from any recent match in it. The current season is the one whose `start <= now <= end`. Then read `standings` from `/api/seasons/{id}`.
- **Results for a weekend:** call `/api/matches?from=…&to=…` with the weekend's dates and filter by `competition` (strip the trailing year) or by team ids.
- **Who scored:** call `/api/matches/{id}/summary` and read its `incidents`.
- **Watching live:** connect to the WebSocket, or poll `/api/matches/live` every 10–30s. Responses are cached for 10s, so polling faster gains nothing.
- **Linking people to a match:** `https://rugby.stupidtech.net/matches/{id}`. A competition is `https://rugby.stupidtech.net/competitions/{key}?season={seasonId}`.

## Notifications for agents

The app sends Web Push notifications. Any agent that can run an **HTTPS** webhook can receive them by behaving like a browser push subscription. There's no account or API key; the subscription endpoint URL is the credential, so keep it unguessable.

What you get:

- **Following a team or match:** kick-off, every score with the scorer, half-time and full time.
- **Following a competition:** kick-off and full time only.

Each notification is a JSON payload `{ title, body, url, tag }`, for example `{"title":"Harlequins 33–10 Saracens","body":"Conversion – Marcus Smith 56'","url":"/matches/<id>","tag":"<match id>"}`.

1. **Create keys** once and keep them: a P-256 ECDH key pair, a random 16-byte auth secret, and an endpoint URL on your server with a random path.
2. **Register** with `POST /api/push/subscription`, using the body `{ "subscription": { "endpoint": "https://you.example/push/<random>", "keys": { "p256dh": "<public key, base64url, uncompressed>", "auth": "<auth secret, base64url>" } } }`.
3. **Follow** with `POST /api/push/follow`, using the body `{ "endpoint", "kind": "team" | "match" | "competition", "target", "label", "follow": true }`.
   - The target is a team id from `/api/teams`, a match id, or a competition key from `/api/competitions`.
   - `label` is any display name.
   - Set `follow: false` to unfollow.
   - The response lists your follows.
4. **Receive** HTTPS POSTs at your endpoint and decrypt them.
   - They're encrypted with the `aesgcm` content encoding: the sender's public key is the `dh=` value in the `Crypto-Key` header, and the salt is the `salt=` value in the `Encryption` header.
   - Decrypt with your private key and auth secret, for example with the `http_ece` npm package using `version: "aesgcm"`.
   - The `Authorization: vapid t=…, k=…` header is a VAPID token you can verify against `GET /api/push/key` if you want to.
   - Answer 201.
5. **Manage:**
   - `POST /api/push/follows` with `{ endpoint }` lists your follows. A 404 means the subscription is unknown, so register again.
   - `POST /api/push/unsubscribe` with `{ endpoint }` deletes the subscription and its follows.
   - Answering a push with 404 or 410 also deletes them.

Delivery facts:

- Pushes are sent within about 10s of a change upstream.
- Each push carries `TTL: 900` and a per-match `Topic`, and is sent once. If your endpoint is down, it's lost, with no retries.
- Endpoints must be HTTPS. Plain `http://` subscriptions are rejected.

[`examples/push-webhook.ts`](examples/push-webhook.ts) is a complete, tested Bun webhook. It generates and stores keys, subscribes, follows, decrypts and logs:

```sh
bun add http_ece
PUBLIC_URL=https://your-host.example bun examples/push-webhook.ts follow team 1139 Leinster
bun examples/push-webhook.ts unsubscribe
```
