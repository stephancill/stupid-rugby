import type { Standings, StandingsRow } from "./standings.ts";
import type { Match } from "./worldrugby.ts";

// "As it stands": official standings with in-progress matches applied as if they ended now.
//
// Standings (often from ESPN) and matches (World Rugby) name teams differently ("La
// Rochelle" vs "Stade Rochelais"), so a live team is placed by its record instead: the
// official row whose played / points for / points against equal that team's totals from
// the season's completed league matches. Name similarity only breaks ties (e.g. before
// anyone has played). Teams that still can't be placed are reported, not guessed.

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

export type ProjectedStandings = {
  standings: Standings;
  // Keyed by standings team name.
  live: Map<string, LiveTeam>;
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

export function projectStandings({
  standings,
  matches,
  tries,
  rules,
}: {
  standings: Standings;
  // The season's matches.
  matches: Match[];
  // Tries scored in each live match, by match id; missing means unknown.
  tries: Map<string, { home: number; away: number }>;
  rules: BonusRules;
}): ProjectedStandings {
  const league = matches.filter((m) => isLeagueMatch({ match: m }));
  const liveMatches = league.filter((m) => m.phase === "live");

  // Each team's record from completed league matches, to recognise its standings row.
  const records = new Map<string, Record>();
  for (const m of league.filter((x) => x.phase === "complete")) {
    for (const [team, opponent] of [
      [m.home, m.away],
      [m.away, m.home],
    ] as const) {
      const r = records.get(team.id) ?? { played: 0, pointsFor: 0, pointsAgainst: 0 };
      records.set(team.id, {
        played: r.played + 1,
        pointsFor: r.pointsFor + team.score,
        pointsAgainst: r.pointsAgainst + opponent.score,
      });
    }
  }

  const rows = standings.groups.flatMap((group, g) => group.rows.map((row) => ({ g, row })));
  const used = new Set<StandingsRow>();
  function place({ id, name }: { id: string; name: string }) {
    const record = records.get(id) ?? { played: 0, pointsFor: 0, pointsAgainst: 0 };
    const sameRecord = rows.filter(
      ({ row }) => !used.has(row) && recordKey({ record: row }) === recordKey({ record }),
    );
    const ranked = sameRecord
      .map((candidate) => ({ ...candidate, score: similarity({ a: candidate.row.team, b: name }) }))
      .sort((a, b) => b.score - a.score);
    const [best, next] = ranked;
    // A unique record is enough; otherwise the name has to settle it.
    if (!best || (next && (best.score === 0 || best.score === next.score))) return null;
    used.add(best.row);
    return best;
  }

  const groups = standings.groups.map((group) => ({
    ...group,
    rows: group.rows.map((row) => ({ ...row })),
  }));
  const live = new Map<string, LiveTeam>();
  const unplaced: string[] = [];
  for (const match of liveMatches) {
    for (const side of ["home", "away"] as const) {
      const team = match[side];
      const opponent = match[side === "home" ? "away" : "home"];
      const placed = place({ id: team.id, name: team.name });
      if (!placed) {
        unplaced.push(team.name);
        continue;
      }
      const row = groups[placed.g]!.rows.find((r) => r.team === placed.row.team)!;
      const matchTries = tries.get(match.id);
      const { result, points, bonus } = matchPoints({
        rules,
        scored: team.score,
        conceded: opponent.score,
        tries: matchTries ? matchTries[side] : null,
        opponentTries: matchTries ? matchTries[side === "home" ? "away" : "home"] : null,
      });
      live.set(row.team, { match, side, officialPosition: row.position });
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
  }

  // Teams not playing keep their official order (official tie-breakers vary and aren't
  // reproducible from the table). Each playing team is reinserted above the first team it
  // beats on points, then points difference, then points for.
  const ahead = (a: StandingsRow, b: StandingsRow) =>
    a.points - b.points ||
    a.pointsFor - a.pointsAgainst - (b.pointsFor - b.pointsAgainst) ||
    a.pointsFor - b.pointsFor;
  for (const group of groups) {
    const playing = group.rows.filter((r) => live.has(r.team)).sort((a, b) => ahead(b, a));
    const ordered = group.rows.filter((r) => !live.has(r.team));
    for (const row of playing) {
      const index = ordered.findIndex((other) => ahead(row, other) > 0);
      ordered.splice(index === -1 ? ordered.length : index, 0, row);
    }
    ordered.forEach((row, i) => {
      row.position = i + 1;
    });
    group.rows = ordered;
  }
  return { standings: { ...standings, groups }, live, unplaced };
}
