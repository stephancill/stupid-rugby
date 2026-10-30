# Implementation notes

## Prototype CLI (`src/`)

- `src/worldrugby.ts`: World Rugby (Pulselive) client. It validates responses with zod and normalizes matches into `Match` (home/away, `phase`, clock, winner). Unknown status codes fail zod validation instead of being silently mapped. `fetchMatches` paginates at 100 per page and sorts by kickoff.
- `src/competitions.ts`: the list of major competitions, matched by label with the season year stripped, because World Rugby event IDs change every season.
- `src/cli.ts`: the `fixtures`, `results`, `live` and `competitions` commands. The `live` command queries matches in live states within ±1 day and fetches each match's timeline. It prints scoring events and cards. `--watch` polls and prints only new events.

See `docs/research.md` for source evaluation.

## Web app (`web/`)

- Vite + React + TanStack Query, plus a Hono Cloudflare Worker (`worker/index.ts`) run through `@cloudflare/vite-plugin`, so `bun dev` serves both. `bun run deploy` builds and runs `wrangler deploy`. Pushes to `main` deploy automatically through Cloudflare Workers Builds (Git integration on the `stupid-rugby` worker): root directory `/web`, build command `bun install --cwd .. && bun run build` (the app imports `../src`, which needs the root package's dependencies; Workers Builds only installs the root directory's), deploy command `bunx wrangler deploy`. Secrets (`VAPID_PRIVATE_KEY`) live on the worker and survive deploys. Production is the `stupid-rugby` worker on the custom domain `rugby.stupidtech.net` (`routes` in `wrangler.jsonc`), so the Cache API layer is active there. The app, worker and CLI share code in `../src` (`server.fs.allow: [".."]`). The app reads everything from the index (see below) through `web/src/api.ts`; the CLI calls World Rugby directly.
- `web/src/matches.ts`: `useMatches` fetches one `/api/matches` query per Monday-to-Monday UTC week. "Load earlier" adds weeks without refetching cached ones, down to the start of the index's window (from `/api/status`), after which the timeline says where results start. Later weeks auto-load when the end of the list comes within 600px of the viewport, as long as the index's latest kickoff is after the loaded window. The observer is recreated after every fetch, because it fires on `observe()`, so loading continues while filtered-out weeks keep the list short. Auto-loading stops after 3 loads in a row that add no visible match days (for example, a team filter that matches nothing), and a "Load later" button is the manual fallback. Nothing polls: live changes are pushed into the cached queries (see "Live updates").
- Team view: when the team box exactly matches a team name in the loaded data (case-insensitive), `useTeamMatches` fetches every match for all ids with that name in one `/api/matches?teams=` request, covering a year either side of this UTC week, and merges them into the timeline. Auto-loading is off in team view because that range is already loaded. Partial team names still filter loaded data only. In team view the list is filtered by those team ids, not by name, so "Bulls" doesn't also show "Newcastle Red Bulls".
- Scroll anchoring (`useScrollAnchor` in `Timeline.tsx`): the anchor is the first day section whose top is below the sticky header. It is re-measured on scroll and after every render, and any change in its `offsetTop` is offset with `scrollBy`. This covers earlier weeks resolving out of order and the header growing. An earlier version anchored on the first day of the list, which broke when later-resolving weeks were inserted between it and the reading position.
- `closestDay` picks the match day nearest to today among the filtered days; on a tie the upcoming day wins. That day is highlighted and scrolled into view once per filter combination (on first load and when filters change), not when more weeks load. Loading toggles `isPending`, so re-scrolling then would jump the user back up from the bottom.
- Filters live in the URL via nuqs (`NuqsAdapter` from `nuqs/adapters/react-router/v8` in `Layout.tsx`): `?comp=urc,top-14&team=Leinster`. `comp` holds competition keys from `competitionKey` (the curated key for major competitions, a slug of the base label otherwise). The default is all major keys, and selections are written in canonical order (majors in curated order, then the rest alphabetically), so re-selecting the default clears the param. "None" serializes as `comp=`. Competitions without matches in the loaded window are hidden. The team filter is a case-insensitive substring match while typing (exact names switch to team view), with suggestions from the selected competitions.
- `now` is captured once at mount to keep render pure (oxlint react/purity).
- The root `tsconfig.json` is scoped to `src/` so the CLI typecheck doesn't pick up the DOM code in `web/`.

## Routing and competition page

- React Router 8 (`createBrowserRouter`, `RouterProvider` from `react-router/dom`). Routes: `/` (`Timeline.tsx`) and `/competitions/:key` (`Competition.tsx`). nuqs uses `nuqs/adapters/react-router/v8` inside a layout route, because it reads search params through the router. Deep links work in dev and in production (`not_found_handling: "single-page-application"`).
- Timeline competition headings link to `/competitions/<competitionKey>?season=<eventId>`.
- Competition page (`web/src/competition-data.ts`):
  - Seasons come from `/api/seasons` (every indexed season), filtered by each major competition's `seasons` label pattern in `src/competitions.ts`. Non-major competitions have no pattern and rely on the linked `?season=` id.
  - Without `?season=`, `currentSeason` picks the season in progress, else the latest started, else the next.
  - Fixtures, results and standings come from `/api/seasons/:id` in one request. Standings are null when neither World Rugby nor ESPN has a table for the season, and the page says so rather than showing another season's table.
- Shared modules: `src/http.ts` (`getJson`, `isRateLimited`), `src/standings.ts` (normalized `Standings`), `src/espn.ts` (`createEspnClient`).

## As it stands (`src/live-standings.ts`, `web/src/StandingsSection.tsx`)

- When a season has a live match, the competition page offers "Official" / "As it stands" (`?table=live`, nuqs). Teams playing are highlighted with their live score in both views; the projected view shows each team's movement against the official table.
- `projectStandings` applies each live league match as if it ended now: P/W/D/L, PF/PA, match points (4 win, 2 draw) and bonus points by `bonusRules` (`src/competitions.ts`): standard (4+ tries; losing by 7 or fewer), Top 14 and Pro D2 (winning by 3+ tries; losing by 5 or fewer), EPCR cups from 2026/27 (winning by 3+ tries; losing by 7 or fewer). Try counts come from each live match's summary (refetched every 15s); until they load there is no try bonus, and the page says so. Knockout rounds (final/semi/quarter/round of/play-off/barrage) are ignored.
- Teams are matched to standings rows by record, not name: standings (ESPN) and matches (World Rugby) name teams differently ("La Rochelle" / "Stade Rochelais", "Cardiff Blues" / "Cardiff Rugby", "Newcastle Falcons" / "Newcastle Red Bulls"). A live team's row is the one whose played / points for / points against equal its totals from the season's completed league matches; name similarity (accent-stripped words, shared 5-letter prefixes) only breaks ties, e.g. before anyone has played. Checked against the current Top 14, URC and Premiership with a simulated live round: every team placed correctly. Teams that can't be placed are listed on the page and left out, not guessed.
- Ordering: teams not playing keep their official order (official tie-breakers vary and can't be reproduced from the table, so re-sorting everything moved teams that weren't playing). Each playing team is reinserted above the first team it beats on points, then points difference, then points for.
- Tests: `bun test src`.

## Match page (`web/src/Match.tsx`)

- Live stream: while a match is live, a collapsed "Watch live" section embeds rugbybox.me's player host (`embedsports.me/rugby/<home>-vs-<away>-stream-1`, Link 2 uses `-stream-2`) in a 16:9 iframe that mounts only when the details element opens. The slug comes from World Rugby team names (diacritics stripped, a leading "Union " dropped because rugbybox slugs UBB as "bordeaux-begles"); matches rugbybox hasn't set up show their own "Starting Soon" placeholder, and the section links out to rugbybox.me as the fallback. No `sandbox` attribute on the iframe: the embed's player refuses to run sandboxed.
- `/matches/:id`. Every match row in lists opens it on click (`MatchRow`), ignoring clicks that select text; cmd/ctrl-click opens a new tab. The score (or "v") stays a real link for keyboard and middle-click. Data: `/api/matches/:id/summary` (line-ups, scorers, cards, officials) and `/api/matches/:id/stats` (team stats; only fetched once the match has started), normalized from World Rugby's `/match/{id}/summary` and `/stats` by the worker. Not indexed.
- Incidents are attributed to the team whose list they appear under: their `teamIndex` field is unreliable (1 for the home side in live data). A try with no player is a penalty try. Minutes follow rugby convention (02:56 shows as 3').
- Captains are listed by either player id or altId. Line-ups are sorted by shirt number (upstream sometimes shuffles them); starters (1–15) come first, then a "Replacements" heading and the bench, muted. Positions aren't shown: the shirt number implies them.
- The summary's clock is fresher than `/match` lists, whose clock only moves when the score changes (scores themselves update in both within the same 15s sample). The header uses the summary.
- Live clock (`src/match-clock.ts`): World Rugby's clock can't be trusted. In one Top 14 match it was started at the scheduled kickoff (3 minutes before the real one, per LNR's own timer), stalled in the second half, and its timeline stamped half-time 10 minutes early; its status changes (L1, LHT, L2) were within seconds of the real ones. So the index stamps `periodStart` on a match when it first sees a new period (`withPeriodStart` in `saveMatches`: scheduled → L1, LHT → L2, extra-time periods), keeps it while the state holds, and clears it otherwise. Clients show offset + time since then (L1 0:00, L2 40:00, LT1 80:00, LT2 90:00), ticking every second (`useNow`) in match rows, the match page and the standings live note. The summary route copies `periodStart` from the index when both are in the same state. A period already under way when the index first saw it (e.g. right after a deploy that predates this) has no start, and the clock falls back to World Rugby's, shown with a `~`. Match rows' status column is wide enough for "LIVE ~52:10", unwrapped and with tabular digits, so the ticking clock doesn't resize the table.
- Refreshes every 10s while live (the proxy's cache lifetime for unfinished matches) and every minute from 2h before kickoff (line-ups land about an hour before). Stats refresh every 30s while live.
- The stats table shows a curated subset of the ~130 team stats.

## Index (`web/worker/indexer.ts`)

Goal: browsers never cause upstream calls for matches, seasons or standings, live scores reach viewers within 20 seconds, and it all runs within the Workers Free plan's allowances.

- One SQLite-backed Durable Object (`Indexer`, binding `INDEXER`, name `main`) owns all upstream fetching and storage. It's a class because the Durable Object API requires one; the logic stays in plain methods.
- Tables: `matches` (normalized `Match` JSON plus indexed `kickoff`, `season_id`, `phase`, team ids), `seasons`, `standings` (per season; `json` null when no source has a table), `jobs` (the fetch queue), `state` (bootstrap/ready flags, cooldown, last error).
- Window: matches from 5 years back (UTC Monday) to a year ahead. Reads outside it return 400; until the first backfill finishes every read returns 503 "Index is warming up". This is deliberate (fail loudly) rather than falling back to upstream.
- One alarm drives everything. Each tick:
  1. Live: if any match is `scheduled`/`live` with kickoff between 4h ago and 15 min ahead, poll every 10s (`LIVE_POLL_MS`). The request covers the UTC dates of those kickoffs plus a day (upstream rejects ranges that start and end on the same date).
  2. Jobs: run the oldest due job, at most one per tick, ticks at least 5s apart (`JOB_GAP_MS`), so upstream never sees a burst.
  3. Sleep until the earliest of: next live poll, 15 min before the next scheduled kickoff, the next due job (or a day).
- Jobs (deduped by key; an existing job keeps the earlier due time):
  - `week`: fetch a UTC week plus a day either side; upsert; delete matches inside the week that upstream no longer lists (fixtures removed).
  - `recheck` (10 min and 1h after a match reaches full time): re-fetch that day for score corrections. Full time also queues that season's `standings` 10 min later.
  - `seasons` (daily): the event list; queues standings for major-competition seasons that have none yet.
  - `standings`: World Rugby's table, else ESPN's (`espnId`) for the season's end year. Seasons before about 2023 have numeric ids that World Rugby's standings endpoint rejects, so those go straight to ESPN. Only major competitions get standings.
  - `sync-near` (every 15 min when a match kicks off within 12h, else hourly): queue weeks from 2 days back to 14 days ahead, to catch new fixtures, postponements and moved kickoffs.
  - `sync-far` (daily): queue every later week in the window, and standings for current major seasons.
  - Bootstrap (first alarm): queue every week in the window ordered by distance from now (so the weeks people look at fill first), plus `seasons`. About 375 jobs, so about 30 min at one per 5s. The index is `ready` once nothing is due.
- Writes: a match row is only rewritten when its JSON changed, because rows written are the scarcest free allowance (100k/day; an index entry counts too, and each `setAlarm` is one write).
- Rate limiting: a 429 starts a cooldown (2 min doubling to 30 min, persisted in `state`) during which nothing calls upstream; failed jobs retry with exponential backoff (up to 1h). Non-429 failures are recorded as `lastError` in `/api/status` and logged.
- After a deploy, the running Durable Object can keep the previous code for a few minutes (seen while it was busy backfilling). Worker routes calling a new RPC method fail meanwhile with "The RPC receiver does not implement the method". It resolved on its own about 5 min after the deploy.
- The alarm handler never throws and always sets the next alarm, because an alarm that throws is retried only a few times and then dropped.

## API (`web/worker/index.ts`)

The API is public: GET routes send `Access-Control-Allow-Origin: *`, `GET /api` returns a self-describing index (`worker/api-index.ts`), and `skills/stupid-rugby/SKILL.md` is the agent guide, covering endpoints, the data model, recipes, and how an agent can receive notifications with its own HTTPS webhook (tested example in `skills/stupid-rugby/examples/push-webhook.ts`). `run_worker_first` includes `/api` itself as well as `/api/*`. `index.html` points agents at both: `<link rel="service-desc">` to `/api`, `<link rel="service-doc">` and `<link rel="alternate" type="text/markdown">` to the raw skill on GitHub, and the meta description mentions them.

- `GET /api/competitions` (static, from `src/competitions.ts`), `GET /api/teams?q=` (team ids by name substring, most matches first, with the latest competition to tell same-named teams apart), `GET /api/matches/live`, `GET /api/matches/:id`.
- `GET /api/matches/:id/summary` and `/stats`: fetched from World Rugby on demand, normalized with `parseSummary`/`parseStats` (`src/worldrugby.ts`) and cached (10s, or 1h once `final`, i.e. status `C`). These replaced the raw `/api/wr` passthrough; the match page uses them.

- `GET /api/status`: `{ ready, window, lastKickoff, backlog, cooldownUntil, lastError }`.
- `GET /api/matches?from=YYYY-MM-DD&to=YYYY-MM-DD[&teams=id,id]`: matches kicking off in `[from, to)` UTC.
- `GET /api/seasons`, `GET /api/seasons/:id` (`{ season, matches, standings }`).
- `GET /api/live`: WebSocket. The index pushes `{ type: "matches", matches }` with every changed match kicking off within 2 days of now. Connections use the hibernation API, so idle sockets cost nothing; `ping` is answered with `pong` by an auto-response without waking the object.
- Reads are cached per isolate (memory LRU) and per colo (Cache API, custom domain only): 10s for ranges touching today and for season details, 10 min for other ranges, 1h for the season list. Only 200s are cached.
- Upstream calls for match details keep a 429 cooldown (2 min doubling to 30 min) during which they answer 429 without calling World Rugby. The ESPN proxy is gone; the index calls ESPN directly.

## Live updates (`web/src/live.ts`)

- `useLiveUpdates` (in the layout route) keeps one WebSocket to `/api/live`, pings every 30s, and reconnects with backoff (1s doubling to 30s). After a reconnect it invalidates all queries, since pushes sent while disconnected were missed.
- Pushed matches replace cached ones by id in week lists, team lists and season details (`setQueriesData`). Matches not already cached are ignored; they arrive with the next fetch of their list.

## Push notifications (`web/worker/notify.ts`, `web/src/push.ts`, `web/public/sw.js`)

Based on an earlier standalone exploration of Web Push on Workers.

- Follows: a device follows teams (team id), matches (match id) or competitions (competition key, stable across seasons). Teams and matches get kick-off, every score, half-time and full time; competitions only kick-off and full time. A device following a match several ways gets one notification per event.
- Identity: there are no accounts. The push subscription endpoint (an unguessable URL) identifies the device and authorises changes to its follows. It's always sent in request bodies, never URLs.
- Storage: `push_subscriptions` and `follows` tables in the index's SQLite. A push service 404/410 deletes the subscription and its follows. `pushsubscriptionchange` in the service worker re-subscribes and moves the follows to the new endpoint (`previousEndpoint`).
- Detection: `saveMatches` returns each change with the previous version; `matchEvents` derives `kickoff` (scheduled → live), `score`, `half-time` (state `LHT`) and `full-time` (→ complete; replaces a final score change). Only matches kicking off within 6h of now notify, so syncs that correct old matches don't. First sightings of a match never notify.
- Scorers: a score event fetches the match summary (one upstream call) and walks back through the scoring team's incidents until they add up to the change (try 5, conversion 2, penalty and drop goal 3, penalty try 7), so a try and conversion caught in one poll are both named. If the summary doesn't account for the change yet (or fails), the notification says "<team> score".
- Corrections: World Rugby sometimes publishes points and then takes them back (a score of 0–2 that returned to 0–0). A score event where either side's score went down adds "Score corrected" to the body. Each send logs the score before and after, with the state and clock (`Notified score <id> (0-0 -> 0-2, L1 17:00): …`), so such sequences can be traced in Workers Logs.
- Sending: from the alarm, straight after the change is saved (so within the live-polling latency), with `@pushforge/builder` (Web Crypto; `web-push` needs Node crypto). Six sends at a time (the Workers connection limit). The account is on Workers Paid, so encrypting in the Durable Object is within its CPU limit. Options: urgency `high`, TTL 15 min (a late score alert is worse than none), and a per-match `topic` (the match id without dashes, as topics are capped at 32 URL-safe characters), so a newer update replaces one still queued. Notifications use the match id as `tag` with `renotify`, so a match occupies one notification. Failures are logged and recorded in `lastError`.
- Keys: `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT` (`https://stupidtech.net`, accepted by Apple) are vars in `wrangler.jsonc`. `VAPID_PRIVATE_KEY` (a JWK, generated with `bunx @pushforge/builder vapid`) is in `web/.env.local` for dev and a Worker secret in production.
- API: `GET /api/push/key`; `POST /api/push/subscription` `{ subscription, previousEndpoint? }`; `POST /api/push/unsubscribe` `{ endpoint }`; `POST /api/push/follows` `{ endpoint }`; `POST /api/push/follow` `{ endpoint, kind, target, label, follow }`. All return `{ follows }`; 404 means the subscription is unknown, and the client registers it again.
- Client: `public/sw.js` (plain JS, served as is) shows notifications and, on tap, focuses an open window and navigates it to the match (or opens one). `push.ts` holds the subscription and follows in React Query; following subscribes on first use, from the click (iOS only prompts from a user gesture). Follow buttons are on match pages (match, both teams, competition), competition pages and the timeline's team view. `/notifications` lists follows with unfollow, and turns notifications off for the device.
- iOS: push only works in the Home Screen app (manifest `display: standalone`, iOS 16.4+). Elsewhere on iOS the follow buttons are replaced by a hint linking to `/notifications`, which explains how to install.
- Tests: `bun test worker` covers event detection, scorer attribution and payloads. Push encryption was checked end to end by running `sendPushes` against a mock push service holding a real subscriber key pair and decrypting the result. pushforge sends the legacy `aesgcm` content encoding (key and salt in the `Crypto-Key` and `Encryption` headers), which Apple accepts. Subscriptions must be HTTPS: the API rejects anything else, since pushforge refuses to send to it.

## Costs

The account is on Workers Paid; these figures are against the allowances the design targeted (the Free plan's, which Paid includes many times over). Rough daily use on a busy match day (about 12 hours with a match live): about 5k alarm runs plus uncached reads against 100k requests; about 5.5k GB-s of 13k; 5-15k rows written of 100k. The first backfill writes about 7.5k matches (with indexes, about 25k rows). Live viewers cost one request per connection; pushes to them are free.
