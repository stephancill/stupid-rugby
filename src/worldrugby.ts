import { z } from "zod";
import { getJson } from "./http.ts";
import type { Standings } from "./standings.ts";

// Unofficial World Rugby (Pulselive) API that powers world.rugby. No auth.
// Status codes cross-checked against ricknout/rugby-ranker.
export const UPSTREAM_URL = "https://api.wr-rims-prod.pulselive.com";
const API_PATH = "/rugby/v3";
const MAX_PAGE_SIZE = 100;

export const liveStates = ["L", "L1", "LT1", "LHT", "L2", "LT2"] as const;
// LFT ("live, full time") is full time before the result is confirmed; some old matches
// never left it.
export const matchStates = ["U", "UP", "C", "CC", "LFT", ...liveStates] as const;
export const matchPhases = ["scheduled", "postponed", "live", "complete", "cancelled"] as const;

export type Sport = "mru" | "wru";
export type MatchState = (typeof matchStates)[number];
export type MatchPhase = (typeof matchPhases)[number];

const timeSchema = z.object({
  millis: z.number(),
  gmtOffset: z.number(),
  label: z.string(),
});

const teamSchema = z.object({
  id: z.string(),
  name: z.string(),
  abbreviation: z.string().nullable(),
  countryCode: z.string().nullable(),
});

const matchSchema = z.object({
  matchId: z.string(),
  eventPhase: z.string().nullable(),
  venue: z
    .object({ name: z.string(), city: z.string().nullable(), country: z.string().nullable() })
    .nullable(),
  time: timeSchema,
  teams: z.array(teamSchema).length(2),
  scores: z.array(z.number()).length(2),
  status: z.enum(matchStates),
  clock: z.object({ secs: z.number(), label: z.string() }).nullable(),
  // A = first team won, B = second team won, D = draw, N = no result
  outcome: z.enum(["A", "B", "D", "N"]).nullable(),
  events: z.array(z.object({ id: z.string(), label: z.string() })),
  competition: z.string().nullable(),
});

const pageSchema = z.object({
  pageInfo: z.object({ page: z.number(), numPages: z.number(), numEntries: z.number() }),
  content: z.array(matchSchema),
});

const eventSchema = z.object({
  id: z.string(),
  label: z.string(),
  start: timeSchema,
  end: timeSchema,
});

const eventPageSchema = z.object({
  pageInfo: z.object({ page: z.number(), numPages: z.number() }),
  content: z.array(eventSchema),
});

// A competition season's full schedule, in the same match shape as /match.
const scheduleSchema = z.object({ event: eventSchema, matches: z.array(matchSchema) });

const standingsSchema = z.object({
  tables: z.array(
    z.object({
      label: z.string().nullable(),
      shortLabel: z.string().nullable(),
      entries: z.array(
        z.object({
          positionLabel: z.string(),
          team: z.object({ name: z.string() }),
          played: z.number(),
          won: z.number(),
          drawn: z.number(),
          lost: z.number(),
          pointsFor: z.number(),
          pointsAgainst: z.number(),
          bonusPoints: z.number().nullable(),
          points: z.number(),
        }),
      ),
    }),
  ),
});

// A competition season (World Rugby calls these events). Labels can differ from the
// `competition` label on matches ("2026 Six Nations" vs "Six Nations 2026"); ids match.
export type Season = { id: string; label: string; start: Date; end: Date };

const timelineEntrySchema = z.object({
  phase: z.string().nullable(),
  time: z.object({ secs: z.number(), label: z.string() }),
  type: z.string(),
  typeLabel: z.string(),
  group: z.string().nullable(),
  points: z.number(),
  playerId: z.string().nullable(),
  teamIndex: z.number().nullable(),
});

const timelineSchema = z.object({
  match: matchSchema,
  timeline: z.array(timelineEntrySchema),
});

const incidentSchema = z.object({
  time: z.object({ secs: z.number(), label: z.string() }),
  playerId: z.string().nullable(),
});

const summaryTeamSchema = z.object({
  teamList: z
    .object({
      list: z.array(
        z.object({
          player: z.object({
            id: z.string(),
            altId: z.string().nullable(),
            name: z.object({ display: z.string() }),
            isReplacement: z.boolean().nullable(),
          }),
          number: z.string().nullable(),
          positionLabel: z.string().nullable(),
        }),
      ),
      // Captains are listed by either id or altId.
      captainIds: z.array(z.string()).nullable(),
    })
    .nullable(),
  // Empty categories are sometimes sent as [] and sometimes left out.
  scoring: z.object({
    Try: z.array(incidentSchema).default([]),
    Con: z.array(incidentSchema).default([]),
    Pen: z.array(incidentSchema).default([]),
    dropGoals: z.array(incidentSchema).default([]),
  }),
  disciplinary: z.object({
    YC: z.array(incidentSchema).default([]),
    RC: z.array(incidentSchema).default([]),
  }),
});

const summarySchema = z.object({
  match: matchSchema,
  teams: z.array(summaryTeamSchema).length(2),
  officials: z.array(
    z.object({
      official: z.object({ name: z.object({ display: z.string() }) }),
      position: z.string(),
    }),
  ),
});

const statsSchema = z.object({
  teamStats: z.array(z.object({ stats: z.record(z.string(), z.number()).nullable() })),
});

export type LineupPlayer = {
  id: string;
  number: string | null;
  name: string;
  position: string | null;
  captain: boolean;
  replacement: boolean;
};

export type IncidentKind =
  | "try"
  | "conversion"
  | "penalty"
  | "drop-goal"
  | "yellow-card"
  | "red-card";

export type Incident = {
  kind: IncidentKind;
  team: "home" | "away";
  secs: number;
  clock: string;
  // Display name from the line-up; null when the player isn't listed.
  player: string | null;
};

export type MatchSummary = {
  match: Match;
  lineups: { home: LineupPlayer[]; away: LineupPlayer[] };
  // Scoring and cards in match-clock order.
  incidents: Incident[];
  officials: { name: string; position: string }[];
};

// Team stats keyed by World Rugby's stat names (e.g. Possession, Tackles); null before
// kickoff or when the match has no stats coverage.
export type TeamStats = { home: Record<string, number>; away: Record<string, number> } | null;

export type RawMatch = z.infer<typeof matchSchema>;
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export type Match = {
  id: string;
  competition: string;
  competitionId: string | null;
  round: string | null;
  kickoff: Date;
  venue: string | null;
  home: { id: string; name: string; score: number };
  away: { id: string; name: string; score: number };
  state: MatchState;
  phase: MatchPhase;
  clock: string | null;
  winner: "home" | "away" | "draw" | null;
};

export function toPhase({ state }: { state: MatchState }): MatchPhase {
  switch (state) {
    case "U":
      return "scheduled";
    case "UP":
      return "postponed";
    case "C":
    case "LFT":
      return "complete";
    case "CC":
      return "cancelled";
    default:
      return "live";
  }
}

// The first team is the home team on world.rugby.
function normalize({ raw }: { raw: RawMatch }): Match {
  const [home, away] = raw.teams as [z.infer<typeof teamSchema>, z.infer<typeof teamSchema>];
  const [homeScore, awayScore] = raw.scores as [number, number];
  const phase = toPhase({ state: raw.status });
  const event = raw.events[0];
  return {
    id: raw.matchId,
    competition: raw.competition ?? event?.label ?? "Unknown",
    competitionId: event?.id ?? null,
    round: raw.eventPhase,
    kickoff: new Date(raw.time.millis),
    venue: raw.venue ? [raw.venue.name, raw.venue.city].filter(Boolean).join(", ") : null,
    home: { id: home.id, name: home.name, score: homeScore },
    away: { id: away.id, name: away.name, score: awayScore },
    state: raw.status,
    phase,
    clock: phase === "live" ? (raw.clock?.label ?? null) : null,
    winner:
      raw.outcome === "A"
        ? "home"
        : raw.outcome === "B"
          ? "away"
          : raw.outcome === "D"
            ? "draw"
            : null,
  };
}

// Parses a /match/{id}/summary response. Exported so the worker can normalize responses it
// fetched (and cached) itself.
export function parseSummary({ json }: { json: unknown }): MatchSummary {
  const data = summarySchema.parse(json);
  const sides = ["home", "away"] as const;
  const lineups = data.teams.map((team) => {
    const captains = new Set(team.teamList?.captainIds ?? []);
    return (team.teamList?.list ?? []).map((entry): LineupPlayer => ({
      id: entry.player.id,
      number: entry.number,
      name: entry.player.name.display,
      position: entry.positionLabel,
      captain: captains.has(entry.player.id) || captains.has(entry.player.altId ?? ""),
      replacement: entry.player.isReplacement ?? false,
    }));
  });
  const names = new Map(lineups.flat().map((p) => [p.id, p.name]));
  // Each team's incidents are listed under that team (their teamIndex field is unreliable).
  const incidents = data.teams.flatMap((team, i) => {
    const kinds: [IncidentKind, z.infer<typeof incidentSchema>[]][] = [
      ["try", team.scoring.Try],
      ["conversion", team.scoring.Con],
      ["penalty", team.scoring.Pen],
      ["drop-goal", team.scoring.dropGoals],
      ["yellow-card", team.disciplinary.YC],
      ["red-card", team.disciplinary.RC],
    ];
    return kinds.flatMap(([kind, list]) =>
      list.map((e): Incident => ({
        kind,
        team: sides[i]!,
        secs: e.time.secs,
        clock: e.time.label,
        player: (e.playerId && names.get(e.playerId)) ?? null,
      })),
    );
  });
  return {
    match: normalize({ raw: data.match }),
    lineups: { home: lineups[0]!, away: lineups[1]! },
    incidents: incidents.sort((a, b) => a.secs - b.secs),
    officials: data.officials.map((o) => ({
      name: o.official.name.display,
      position: o.position,
    })),
  };
}

export function parseStats({ json }: { json: unknown }): TeamStats {
  const data = statsSchema.parse(json);
  const [home, away] = data.teamStats.map((t) => t.stats ?? {});
  if (!home || !away || Object.keys(home).length === 0) return null;
  return { home, away };
}

function isoDate({ date }: { date: Date }) {
  return date.toISOString().slice(0, 10);
}

// `baseUrl` lets callers go through the caching proxy (web app) or straight upstream (CLI).
export function createClient({ baseUrl = UPSTREAM_URL }: { baseUrl?: string } = {}) {
  const apiUrl = `${baseUrl}${API_PATH}`;

  async function fetchMatches({
    from,
    to,
    states,
    teams,
    sport = "mru",
  }: {
    from: Date;
    to: Date;
    states?: readonly MatchState[];
    // Team ids; matches involving any of them, across every competition.
    teams?: readonly string[];
    sport?: Sport;
  }): Promise<Match[]> {
    const matches: Match[] = [];
    for (let page = 0; ; page++) {
      const params = new URLSearchParams({
        sport,
        startDate: isoDate({ date: from }),
        endDate: isoDate({ date: to }),
        pageSize: String(MAX_PAGE_SIZE),
        page: String(page),
      });
      if (states) params.set("states", states.join(","));
      if (teams) params.set("teams", teams.join(","));
      const data = pageSchema.parse(
        await getJson({ source: "World Rugby", url: `${apiUrl}/match?${params}` }),
      );
      matches.push(...data.content.map((raw) => normalize({ raw })));
      if (page + 1 >= data.pageInfo.numPages) break;
    }
    return matches.sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());
  }

  async function countMatches({
    from,
    to,
    states,
    sport = "mru",
  }: {
    from: Date;
    to: Date;
    states?: readonly MatchState[];
    sport?: Sport;
  }): Promise<number> {
    const params = new URLSearchParams({
      sport,
      startDate: isoDate({ date: from }),
      endDate: isoDate({ date: to }),
      pageSize: "1",
    });
    if (states) params.set("states", states.join(","));
    const data = pageSchema.parse(
      await getJson({ source: "World Rugby", url: `${apiUrl}/match?${params}` }),
    );
    return data.pageInfo.numEntries;
  }

  async function fetchTimeline({ matchId }: { matchId: string }) {
    const data = timelineSchema.parse(
      await getJson({ source: "World Rugby", url: `${apiUrl}/match/${matchId}/timeline` }),
    );
    return { match: normalize({ raw: data.match }), timeline: data.timeline };
  }

  // Line-ups, scorers and cards. The match in it can be fresher than in /match lists, whose
  // clock only moves when the score does.
  async function fetchSummary({ matchId }: { matchId: string }): Promise<MatchSummary> {
    return parseSummary({
      json: await getJson({ source: "World Rugby", url: `${apiUrl}/match/${matchId}/summary` }),
    });
  }

  async function fetchStats({ matchId }: { matchId: string }): Promise<TeamStats> {
    return parseStats({
      json: await getJson({ source: "World Rugby", url: `${apiUrl}/match/${matchId}/stats` }),
    });
  }

  // Seasons starting within [from, to].
  async function fetchEvents({
    from,
    to,
    sport = "mru",
  }: {
    from: Date;
    to: Date;
    sport?: Sport;
  }): Promise<Season[]> {
    const seasons: Season[] = [];
    for (let page = 0; ; page++) {
      const params = new URLSearchParams({
        sport,
        startDate: isoDate({ date: from }),
        endDate: isoDate({ date: to }),
        pageSize: String(MAX_PAGE_SIZE),
        page: String(page),
      });
      const data = eventPageSchema.parse(
        await getJson({ source: "World Rugby", url: `${apiUrl}/event?${params}` }),
      );
      for (const e of data.content) {
        seasons.push({
          id: e.id,
          label: e.label,
          start: new Date(e.start.millis),
          end: new Date(e.end.millis),
        });
      }
      if (page + 1 >= data.pageInfo.numPages) break;
    }
    return seasons;
  }

  async function fetchSchedule({ eventId }: { eventId: string }) {
    const data = scheduleSchema.parse(
      await getJson({ source: "World Rugby", url: `${apiUrl}/event/${eventId}/schedule` }),
    );
    const { event } = data;
    return {
      season: {
        id: event.id,
        label: event.label,
        start: new Date(event.start.millis),
        end: new Date(event.end.millis),
      } satisfies Season,
      matches: data.matches
        .map((raw) => normalize({ raw }))
        .sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime()),
    };
  }

  // World Rugby only publishes tables for some of its own events (e.g. Nations
  // Championship); for most competitions `tables` is empty and this returns null.
  async function fetchStandings({ eventId }: { eventId: string }): Promise<Standings | null> {
    const data = standingsSchema.parse(
      await getJson({ source: "World Rugby", url: `${apiUrl}/event/${eventId}/standings` }),
    );
    if (data.tables.every((t) => t.entries.length === 0)) return null;
    return {
      source: "World Rugby",
      groups: data.tables.map((t) => ({
        name: t.label ?? t.shortLabel,
        rows: t.entries.map((e) => ({
          position: Number(e.positionLabel),
          team: e.team.name,
          played: e.played,
          won: e.won,
          drawn: e.drawn,
          lost: e.lost,
          pointsFor: e.pointsFor,
          pointsAgainst: e.pointsAgainst,
          bonusPoints: e.bonusPoints ?? 0,
          points: e.points,
        })),
      })),
    };
  }

  return {
    fetchMatches,
    countMatches,
    fetchTimeline,
    fetchSummary,
    fetchStats,
    fetchEvents,
    fetchSchedule,
    fetchStandings,
  };
}

export type Client = ReturnType<typeof createClient>;
