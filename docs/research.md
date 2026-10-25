# Data source research

Goal: free, broad coverage of major rugby union competitions with fixtures, results and live scores for a match-day indexer.

## Recommendation

Use the **World Rugby (Pulselive) API** as the primary source. Keep ESPN as an optional cross-check for the biggest competitions.

## World Rugby / Pulselive (primary)

Base URL: `https://api.wr-rims-prod.pulselive.com/rugby/v3`. This is the unofficial, unauthenticated API behind world.rugby. It's used by open-source apps such as `ricknout/rugby-ranker` and `rawling/wr-calc`.

### Endpoints

| Endpoint | Notes |
| --- | --- |
| `GET /match?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&states=U,C&sport=mru&page=0&pageSize=100` | Fixtures and results across every competition. `pageSize` max is 100 (above that returns 400). Paginate with `pageInfo.numPages`. `sort` does not reliably sort by date, so sort client-side. |
| `GET /match?teams={id},{id}&startDate=…&endDate=…` | Filters to matches involving any of the given team IDs, across all competitions. The Stormers' Sep 2026 to Jun 2027 matches came back in one request (22 matches). `team=` and `teamId=` are ignored. |
| `GET /event/{eventId}/schedule?language=en` | `{ event, matches }`: a competition season's full schedule (URC 2027 has 151 matches) in the same match shape as `/match`. |
| `GET /event/{eventId}/standings` | `{ tables: [{ label, shortLabel, entries: [{ positionLabel, team, played, won, drawn, lost, pointsFor, pointsAgainst, triesFor, triesAgainst, bonusPoints, points }] }] }`. Only populated for some World Rugby events (e.g. Nations Championship 2026 has two tables). Empty for URC, Top 14, Champions Cup and even Six Nations, so use ESPN for those. |
| `GET /event?sport=mru&startDate=…&endDate=…&pageSize=100` | Seasons starting in the range. Labels can differ from the `competition` label on matches ("2026 Six Nations" vs "Six Nations 2026", "Investec Champions Cup" vs "EPCR Champions Cup", "Hilux NPC" vs "Bunnings Warehouse NPC", "MLR" vs "Major League Rugby", "Super Rugby Pacific" vs "Super Rugby"), but event ids match `events[0].id` on matches. |
| `GET /match/{id}/timeline` | Play-by-play: tries, conversions, penalties, drop goals, cards, subs, match status changes, each with game clock, `teamIndex`, `points`, `playerId`. The points reconcile exactly with the final score. Lower-tier competitions may return an empty timeline. |
| `GET /match/{id}/summary` | Match, teams (lineups), officials, man of the match. |
| `GET /match/{id}/stats` | Team stats. |
| `GET /event?pageSize=100` | Competition/season catalogue (about 2,400 entries, including historical). `pageSize` is required. |
| `GET /rankings/{mru\|wru}` | World rankings. |

### Match fields

- `status`: `U` upcoming, `UP` postponed, `C` complete, `CC` cancelled, plus the live states `L`, `L1`, `LT1`, `LHT`, `L2` and `LT2`. The live states are taken from rugby-ranker; no live match was available to observe while researching.
- `outcome`: `A` first team won, `B` second team won, `D` draw, `N` no result.
- `teams[0]` is the home team.
- `time.millis` is the UTC kickoff time.
- `clock.label` is the game clock.
- `events[0]` is the competition season. Its `id` changes each season (for example, "URC 2026" and "URC 2027" have different IDs), so competitions are matched by label with the year removed.
- `sport`: `mru` covers men's (including sevens), `wru` covers women's.

### Coverage

The API returned about 3,000 men's matches for Oct 2025 to Oct 2026, including:

- **Internationals:** Six Nations, Rugby Championship, Nations Championship, Autumn Nations Series, Pacific Nations Cup, Bledisloe Cup, Rugby World Cup qualifying, Rugby Europe, Asia and Americas competitions, U20s, and the Sevens Series.
- **Clubs and provinces:** URC, Premiership, Top 14, Pro D2, English Championship, Champions Cup, Challenge Cup, Super Rugby (Pacific, AUS, Americas), Japan League One (D1 and D2), MLR, Currie Cup, NPC, Heartland Championship, and Serie A Elite.
- **Women's:** Six Nations, WXV, PWR, Super Rugby Aupiki, and Farah Palmer Cup.

### Risks

- The API is undocumented and unofficial, so it could change or be rate-limited without notice. Cache aggressively, poll only live matches frequently, and identify the client politely.
- Licensing and terms for commercial redistribution haven't been checked.
- Rate limit: CloudFront answers 429 (an HTML body, no `Retry-After`) once a client sends too many requests. During development, roughly 150 to 200 requests in a few minutes triggered a block that lasted about 35 minutes. Browsers should go through the caching proxy, and polling should stay well below that.

## ESPN (secondary)

Base URL: `https://site.api.espn.com/apis/site/v2/sports/rugby/{leagueId}/scoreboard?dates=YYYYMMDD`. It has no auth. Rugby doesn't support date ranges, only single dates.

The league IDs below were verified:

| League | ID |
| --- | --- |
| Six Nations | 180659 |
| Rugby World Cup | 164205 |
| Women's Rugby World Cup | 289237 |
| Rugby Championship | 244293 |
| Super Rugby Pacific | 242041 |
| Premiership | 267979 |
| URC | 270557 |
| Top 14 | 270559 |
| Champions Cup | 271937 |
| Challenge Cup | 272073 |
| International test matches | 289234 |

Use: an independent second feed to cross-check or fail over on live scores for the biggest competitions.

### Standings

`GET https://site.api.espn.com/apis/v2/sports/rugby/{leagueId}/standings?season={year}` returns `children[]`, one per league or pool (the Champions Cup has Pool 1 to 4). Each has `standings.season` and `standings.entries[]`, with `stats[]` holding `{ name, value }` (`rank`, `gamesPlayed`, `gamesWon`, `gamesDrawn`, `gamesLost`, `pointsFor`, `pointsAgainst`, `bonusPoints`, `bonusPointsTry`, `bonusPointsLosing`, `triesFor`, `points`).

- `season` is the year the season ends (2026-27 is `2027`).
- Without `?season=`, some leagues return a stale season (Top 14 returned 2022-23). With `?season=2027` it returned the live 2026-27 table. Always pass the season and check `standings.season` in the response.
- Verified with current data: URC, Premiership, Top 14, Champions Cup (pools), Six Nations, Super Rugby Pacific.

## Paid options (not evaluated in depth)

Sportradar Rugby, API-Sports Rugby and Highlightly offer official SLAs and licensing. Worth considering if the Pulselive API proves unreliable or a commercial launch needs licensed data.
