import type { Standings, StandingsRow } from "./standings.ts";
import type { Match } from "./worldrugby.ts";

// "As it stands": official standings with in-progress matches applied as if they ended now,
// and with completed results the official table doesn't include yet (World Rugby's table
// can lag its own results by days, until a whole round is in).
//
// Standings (often from ESPN) and matches (World Rugby) name teams differently ("La
// Rochelle" vs "Stade Rochelais"), so a team is placed by its record instead: the official
// row with P played whose played / points for / points against equal the team's totals
// from its first P completed league matches. Results after those are the ones the table is
// missing. Name similarity only breaks ties (e.g. before anyone has played). Teams that
// still can't be placed are reported, not guessed.

export type BonusRules = {
  // "tries": a bonus for scoring `min` tries, whatever the result. "margin": a bonus for
  // the winner scoring at least `min` more tries than the opponent.
  tryBonus: { kind: "tries" | "margin"; min: number };
  // A bonus for losing by at most this many points.
  losingMargin: number;
};

export const standardBonus: BonusRules = { tryBonus: { kind: "tries", min: 4 }, losingMargin: 7 };

export type LiveTeam = {
  match: Match;
  side: "home" | "away";
  // Where the team was in the official table.
  officialPosition: number;
};

// A completed result the official table doesn't include yet.
export type UnrecordedResult = { match: Match; side: "home" | "away" };

export type ProjectedStandings = {
  standings: Standings;
  // Keyed by standings team name.
  live: Map<string, LiveTeam>;
  // Keyed by standings team name, oldest first.
  unrecorded: Map<string, UnrecordedResult[]>;
  // Live teams that couldn't be matched to a standings row.
  unplaced: string[];
};

// Knockout matches don't count towards the table.
const KNOCKOUT = /final|quarter|semi|round of|play-?off|barrage/i;

function isLeagueMatch({ match }: { match: Match }) {
  return !KNOCKOUT.test(match.round ?? "");
}

function words({ name }: { name: string }) {
  const filler = new Set(["rugby", "club", "rc", "fc", "union", "stade", "the", "de", "la"]);
  return new Set(
    name
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !filler.has(w)),
  );
}

// Shared significant words, with prefix matches ("rochelle" ~ "rochelais") counting too.
export function similarity({ a, b }: { a: string; b: string }) {
  const wa = words({ name: a });
  const wb = words({ name: b });
  let score = 0;
  for (const x of wa) {
    for (const y of wb) {
      if (x === y) score += 2;
      else if (x.length >= 4 && y.length >= 4 && x.slice(0, 5) === y.slice(0, 5)) score += 1;
    }
  }
  return score;
}

type Record = { played: number; pointsFor: number; pointsAgainst: number };

function recordKey({ record }: { record: Record }) {
  return `${record.played}/${record.pointsFor}/${record.pointsAgainst}`;
}

export function matchPoints({
  rules,
  scored,
  conceded,
  tries,
  opponentTries,
}: {
  rules: BonusRules;
  scored: number;
  conceded: number;
  // null when unknown: no try bonus is awarded.
  tries: number | null;
  opponentTries: number | null;
}) {
  const result = scored > conceded ? "won" : scored < conceded ? "lost" : "drawn";
  let bonus = 0;
  if (tries !== null && opponentTries !== null) {
    if (rules.tryBonus.kind === "tries" && tries >= rules.tryBonus.min) bonus++;
    if (
      rules.tryBonus.kind === "margin" &&
      result === "won" &&
      tries - opponentTries >= rules.tryBonus.min
    ) {
      bonus++;
    }
  }
  if (result === "lost" && conceded - scored <= rules.losingMargin) bonus++;
  return { result, points: (result === "won" ? 4 : result === "drawn" ? 2 : 0) + bonus, bonus };
}

type Team = { id: string; name: string };

// The teams in the season's completed or live league matches, each with its completed
// league results, oldest first. `leagueGames` caps the results that count (later ones are
// placement matches the table never includes).
function teamResults({ matches, leagueGames }: { matches: Match[]; leagueGames?: number }) {
  const league = matches
    .filter((m) => isLeagueMatch({ match: m }) && (m.phase === "complete" || m.phase === "live"))
    .toSorted((a, b) => a.kickoff.getTime() - b.kickoff.getTime());
  const teams = new Map<string, { team: Team; results: UnrecordedResult[] }>();
  for (const match of league) {
    for (const side of ["home", "away"] as const) {
      const team = match[side];
      const entry = teams.get(team.id) ?? { team: { id: team.id, name: team.name }, results: [] };
      teams.set(team.id, entry);
      if (match.phase !== "complete") continue;
      if (leagueGames === undefined || entry.results.length < leagueGames) {
        entry.results.push({ match, side });
      }
    }
  }
  return [...teams.values()];
}

function recordOf({ results }: { results: UnrecordedResult[] }): Record {
  let pointsFor = 0;
  let pointsAgainst = 0;
  for (const { match, side } of results) {
    pointsFor += match[side].score;
    pointsAgainst += match[side === "home" ? "away" : "home"].score;
  }
  return { played: results.length, pointsFor, pointsAgainst };
}

type Placement = { team: Team; g: number; row: StandingsRow; unrecorded: UnrecordedResult[] };

// Each team's standings row (see the top of this file), keyed by team id. Teams with the
// fewest candidate rows are placed first.
function placeTeams({
  standings,
  matches,
  leagueGames,
}: {
  standings: Standings;
  matches: Match[];
  leagueGames?: number;
}) {
  const rows = standings.groups.flatMap((group, g) => group.rows.map((row) => ({ g, row })));
  const candidates = teamResults({ matches, leagueGames })
    .map(({ team, results }) => ({
      team,
      results,
      options: rows.filter(
        ({ row }) =>
          row.played <= results.length &&
          recordKey({ record: recordOf({ results: results.slice(0, row.played) }) }) ===
            recordKey({ record: row }),
      ),
    }))
    .sort((a, b) => a.options.length - b.options.length);
  const used = new Set<StandingsRow>();
  const placed = new Map<string, Placement>();
  for (const { team, results, options } of candidates) {
    const ranked = options
      .filter(({ row }) => !used.has(row))
      .map((option) => ({ ...option, score: similarity({ a: option.row.team, b: team.name }) }))
      .sort((a, b) => b.score - a.score);
    const [best, next] = ranked;
    // A unique record is enough; otherwise the name has to settle it.
    if (!best || (next && (best.score === 0 || best.score === next.score))) continue;
    used.add(best.row);
    placed.set(team.id, {
      team,
      g: best.g,
      row: best.row,
      unrecorded: results.slice(best.row.played),
    });
  }
  return placed;
}

// Completed league matches the official table doesn't include yet, oldest first.
export function unrecordedMatches({
  standings,
  matches,
  leagueGames,
}: {
  standings: Standings;
  matches: Match[];
  leagueGames?: number;
}): Match[] {
  const found = new Map<string, Match>();
  for (const { unrecorded } of placeTeams({ standings, matches, leagueGames }).values()) {
    for (const { match } of unrecorded) found.set(match.id, match);
  }
  return [...found.values()].sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());
}

// The matches' (World Rugby) name for each standings team, keyed by standings name: the
// placed team (see the top of this file), else the uniquely most similar name. Teams that
// can't be told apart are left out.
export function matchTeamNames({
  standings,
  matches,
  leagueGames,
}: {
  standings: Standings;
  matches: Match[];
  leagueGames?: number;
}): Map<string, string> {
  const placed = placeTeams({ standings, matches, leagueGames });
  const names = new Map([...placed.values()].map((p) => [p.row.team, p.team.name]));
  const teams = [
    ...new Map(matches.flatMap((m) => [m.home, m.away]).map((t) => [t.id, t])).values(),
  ];
  for (const row of standings.groups.flatMap((g) => g.rows)) {
    if (names.has(row.team)) continue;
    const ranked = teams
      .map((t) => ({ name: t.name, score: similarity({ a: row.team, b: t.name }) }))
      .sort((a, b) => b.score - a.score);
    const [best, next] = ranked;
    if (best && best.score > 0 && best.score !== next?.score) names.set(row.team, best.name);
  }
  return names;
}

export function projectStandings({
  standings,
  matches,
  tries,
  rules,
  leagueGames,
}: {
  standings: Standings;
  // The season's matches.
  matches: Match[];
  // Tries scored in each live or unrecorded match, by match id; missing means unknown.
  tries: Map<string, { home: number; away: number }>;
  rules: BonusRules;
  leagueGames?: number;
}): ProjectedStandings {
  const placed = placeTeams({ standings, matches, leagueGames });
  const groups = standings.groups.map((group) => ({
    ...group,
    rows: group.rows.map((row) => ({ ...row })),
  }));
  const rowFor = ({ placement }: { placement: Placement }) =>
    groups[placement.g]!.rows.find((r) => r.team === placement.row.team)!;

  function apply({ row, match, side }: { row: StandingsRow } & UnrecordedResult) {
    const team = match[side];
    const opponent = match[side === "home" ? "away" : "home"];
    const matchTries = tries.get(match.id);
    const { result, points, bonus } = matchPoints({
      rules,
      scored: team.score,
      conceded: opponent.score,
      tries: matchTries ? matchTries[side] : null,
      opponentTries: matchTries ? matchTries[side === "home" ? "away" : "home"] : null,
    });
    Object.assign(row, {
      played: row.played + 1,
      won: row.won + (result === "won" ? 1 : 0),
      drawn: row.drawn + (result === "drawn" ? 1 : 0),
      lost: row.lost + (result === "lost" ? 1 : 0),
      pointsFor: row.pointsFor + team.score,
      pointsAgainst: row.pointsAgainst + opponent.score,
      bonusPoints: row.bonusPoints + bonus,
      points: row.points + points,
    });
  }

  const unrecorded = new Map<string, UnrecordedResult[]>();
  for (const placement of placed.values()) {
    if (placement.unrecorded.length === 0) continue;
    const row = rowFor({ placement });
    unrecorded.set(row.team, placement.unrecorded);
    for (const result of placement.unrecorded) apply({ row, ...result });
  }

  const live = new Map<string, LiveTeam>();
  const unplaced: string[] = [];
  const liveMatches = matches.filter((m) => isLeagueMatch({ match: m }) && m.phase === "live");
  for (const match of liveMatches) {
    for (const side of ["home", "away"] as const) {
      const placement = placed.get(match[side].id);
      if (!placement) {
        unplaced.push(match[side].name);
        continue;
      }
      const row = rowFor({ placement });
      live.set(row.team, { match, side, officialPosition: placement.row.position });
      apply({ row, match, side });
    }
  }

  // Teams with no changes keep their official order (official tie-breakers vary and aren't
  // reproducible from the table). Each changed team is reinserted above the first team it
  // beats on points, then points difference, then points for.
  const changed = (row: StandingsRow) => live.has(row.team) || unrecorded.has(row.team);
  const ahead = (a: StandingsRow, b: StandingsRow) =>
    a.points - b.points ||
    a.pointsFor - a.pointsAgainst - (b.pointsFor - b.pointsAgainst) ||
    a.pointsFor - b.pointsFor;
  for (const group of groups) {
    const moving = group.rows.filter(changed).sort((a, b) => ahead(b, a));
    const ordered = group.rows.filter((r) => !changed(r));
    for (const row of moving) {
      const index = ordered.findIndex((other) => ahead(row, other) > 0);
      ordered.splice(index === -1 ? ordered.length : index, 0, row);
    }
    ordered.forEach((row, i) => {
      row.position = i + 1;
    });
    group.rows = ordered;
  }
  return { standings: { ...standings, groups }, live, unrecorded, unplaced };
}
