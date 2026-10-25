# stupid-rugby

Prototype rugby union fixtures, results and live scores indexer.

```sh
bun install
bun rugby fixtures --days 7            # major competitions
bun rugby fixtures --comp urc
bun rugby results --days 3 --all       # every competition World Rugby covers
bun rugby results --women
bun rugby live --watch --interval 30   # scoring events and cards as they happen
bun rugby competitions                 # list --comp keys
```

Add `--json` for machine-readable output. See `docs/research.md` for data sources.

## Web app

```sh
cd web && bun install && bun dev
```

A timeline of match days with competition and team filters. The match day closest to today is highlighted. Competition pages (`/competitions/urc`) show standings and a season's fixtures and results. Match pages (`/matches/:id`) show scorers, cards, stats and line-ups. Devices can follow teams, matches and competitions for push notifications (install to the Home Screen on iOS). Data is served from an index (`web/worker/indexer.ts`, a Durable Object) that polls World Rugby and ESPN on its own schedule and pushes live scores to browsers over a WebSocket. Pushes to `main` deploy to https://rugby.stupidtech.net through Cloudflare Workers Builds; `bun run deploy` deploys from a local checkout.

Push notifications need a VAPID key pair (`bunx @pushforge/builder vapid`): the public key is `VAPID_PUBLIC_KEY` in `web/wrangler.jsonc`, and the private JWK goes in `web/.env.local` as `VAPID_PRIVATE_KEY` for dev and `bunx wrangler secret put VAPID_PRIVATE_KEY` for production.
