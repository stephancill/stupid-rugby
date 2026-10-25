import { z } from "zod";
import type { ApiError } from "../../src/http.ts";
import {
  type Incident,
  type LineupPlayer,
  matchPhases,
  matchStates,
  type Match,
  type MatchSummary,
  type Season,
  type TeamStats,
} from "../../src/worldrugby.ts";
import type { Standings } from "../../src/standings.ts";

// Client for the app's own API (worker/index.ts), which serves from the index.

const teamSchema = z.object({ id: z.string(), name: z.string(), score: z.number() });

export const matchSchema = z.object({
  id: z.string(),
  competition: z.string(),
  competitionId: z.string().nullable(),
  round: z.string().nullable(),
  kickoff: z.coerce.date(),
  venue: z.string().nullable(),
  home: teamSchema,
  away: teamSchema,
  state: z.enum(matchStates),
  phase: z.enum(matchPhases),
  clock: z.string().nullable(),
  // Absent in responses cached before it existed.
  periodStart: z.coerce.date().nullable().default(null),
  winner: z.enum(["home", "away", "draw"]).nullable(),
}) satisfies z.ZodType<Match>;

const seasonSchema = z.object({
  id: z.string(),
  label: z.string(),
  start: z.coerce.date(),
  end: z.coerce.date(),
}) satisfies z.ZodType<Season>;

const standingsSchema = z.object({
  source: z.enum(["World Rugby", "ESPN"]),
  groups: z.array(
    z.object({
      name: z.string().nullable(),
      rows: z.array(
        z.object({
          position: z.number(),
          team: z.string(),
          played: z.number(),
          won: z.number(),
          drawn: z.number(),
          lost: z.number(),
          pointsFor: z.number(),
          pointsAgainst: z.number(),
          bonusPoints: z.number(),
          points: z.number(),
        }),
      ),
    }),
  ),
}) satisfies z.ZodType<Standings>;

const statusSchema = z.object({
  ready: z.boolean(),
  window: z.object({ from: z.coerce.date(), to: z.coerce.date() }),
  lastKickoff: z.coerce.date().nullable(),
});

export const liveMessageSchema = z.object({
  type: z.literal("matches"),
  matches: z.array(matchSchema),
});

function isoDate({ date }: { date: Date }) {
  return date.toISOString().slice(0, 10);
}

// Errors carry the HTTP status and the API's own message (e.g. "Index is warming up").
async function get<T>({ path, schema }: { path: string; schema: z.ZodType<T> }): Promise<T> {
  const res = await fetch(path);
  const body: unknown = await res.json();
  if (!res.ok) {
    const message = (body as { error?: string }).error ?? `API ${res.status} for ${path}`;
    throw Object.assign(new Error(message), { status: res.status }) satisfies ApiError;
  }
  return schema.parse(body);
}

export function fetchStatus() {
  return get({ path: "/api/status", schema: statusSchema });
}

// Matches kicking off in [from, to), UTC dates.
export async function fetchMatches({
  from,
  to,
  teams,
}: {
  from: Date;
  to: Date;
  teams?: readonly string[];
}) {
  const params = new URLSearchParams({ from: isoDate({ date: from }), to: isoDate({ date: to }) });
  if (teams?.length) params.set("teams", teams.join(","));
  const { matches } = await get({
    path: `/api/matches?${params}`,
    schema: z.object({ matches: z.array(matchSchema) }),
  });
  return matches;
}

export async function fetchSeasons() {
  const { seasons } = await get({
    path: "/api/seasons",
    schema: z.object({ seasons: z.array(seasonSchema) }),
  });
  return seasons;
}

const incidentSchema = z.object({
  kind: z.enum(["try", "conversion", "penalty", "drop-goal", "yellow-card", "red-card"]),
  team: z.enum(["home", "away"]),
  secs: z.number(),
  clock: z.string(),
  player: z.string().nullable(),
}) satisfies z.ZodType<Incident>;

const lineupSchema = z.array(
  z.object({
    id: z.string(),
    number: z.string().nullable(),
    name: z.string(),
    position: z.string().nullable(),
    captain: z.boolean(),
    replacement: z.boolean(),
  }),
) satisfies z.ZodType<LineupPlayer[]>;

export function fetchMatchSummary({ id }: { id: string }): Promise<MatchSummary> {
  return get({
    path: `/api/matches/${encodeURIComponent(id)}/summary`,
    schema: z.object({
      match: matchSchema,
      lineups: z.object({ home: lineupSchema, away: lineupSchema }),
      incidents: z.array(incidentSchema),
      officials: z.array(z.object({ name: z.string(), position: z.string() })),
    }),
  });
}

export async function fetchMatchStats({ id }: { id: string }): Promise<TeamStats> {
  const side = z.record(z.string(), z.number());
  const { stats } = await get({
    path: `/api/matches/${encodeURIComponent(id)}/stats`,
    schema: z.object({ stats: z.object({ home: side, away: side }).nullable() }),
  });
  return stats;
}

export function fetchSeason({ id }: { id: string }) {
  return get({
    path: `/api/seasons/${encodeURIComponent(id)}`,
    schema: z.object({
      season: seasonSchema,
      matches: z.array(matchSchema),
      standings: standingsSchema.nullable(),
    }),
  });
}
