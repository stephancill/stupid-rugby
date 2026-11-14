import { describe, expect, test } from "bun:test";
import {
  type BonusRules,
  matchPoints,
  matchTeamNames,
  projectStandings,
  standardBonus,
  unrecordedMatches,
} from "./live-standings.ts";
import type { Standings, StandingsRow } from "./standings.ts";
import type { Match } from "./worldrugby.ts";

const top14: BonusRules = { tryBonus: { kind: "margin", min: 3 }, losingMargin: 5 };

describe("matchPoints", () => {
  const points = (
    rules: BonusRules,
    scored: number,
    conceded: number,
    tries: number,
    opp: number,
  ) => matchPoints({ rules, scored, conceded, tries, opponentTries: opp }).points;
  test("standard: win with 4 tries", () => expect(points(standardBonus, 28, 10, 4, 1)).toBe(5));
  test("standard: loss with 4 tries and within 7", () =>
    expect(points(standardBonus, 24, 30, 4, 3)).toBe(2));
  test("standard: draw", () => expect(points(standardBonus, 10, 10, 1, 1)).toBe(2));
  test("top 14: win by 3 tries", () => expect(points(top14, 30, 6, 4, 1)).toBe(5));
  test("top 14: 4 tries but not 3 more", () => expect(points(top14, 30, 20, 4, 2)).toBe(4));
  test("top 14: losing bonus only within 5", () => {
    expect(points(top14, 20, 25, 2, 2)).toBe(1);
    expect(points(top14, 20, 26, 2, 2)).toBe(0);
  });
  test("unknown tries: no try bonus, losing bonus still applies", () => {
    expect(
      matchPoints({
        rules: standardBonus,
        scored: 3,
        conceded: 8,
        tries: null,
        opponentTries: null,
      }).points,
    ).toBe(1);
  });
});

function row(position: number, team: string, record: Partial<StandingsRow> = {}): StandingsRow {
  return {
    position,
    team,
    played: 1,
    won: 0,
    drawn: 0,
    lost: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    bonusPoints: 0,
    points: 0,
    ...record,
  };
}

let ids = 0;
function match(
  home: [string, string, number],
  away: [string, string, number],
  phase: Match["phase"],
): Match {
  return {
    id: `m${ids++}`,
    competition: "Top 14 2027",
    competitionId: "s",
    round: "Round 1",
    // In creation order.
    kickoff: new Date(ids * 60_000),
    venue: null,
    home: { id: home[0], name: home[1], score: home[2] },
    away: { id: away[0], name: away[1], score: away[2] },
    state: phase === "live" ? "L2" : "C",
    phase,
    clock: null,
    periodStart: null,
    winner: null,
  };
}

describe("projectStandings", () => {
  // Round 1 done: La Rochelle beat Toulon 20-10, Bordeaux beat Pau 30-25.
  const standings: Standings = {
    source: "ESPN",
    groups: [
      {
        name: null,
        rows: [
          row(1, "Bordeaux Begles", { won: 1, pointsFor: 30, pointsAgainst: 25, points: 4 }),
          row(2, "La Rochelle", { won: 1, pointsFor: 20, pointsAgainst: 10, points: 4 }),
          row(3, "Pau", { lost: 1, pointsFor: 25, pointsAgainst: 30, bonusPoints: 1, points: 1 }),
          row(4, "Toulon", { lost: 1, pointsFor: 10, pointsAgainst: 20, points: 0 }),
        ],
      },
    ],
  };
  const done = [
    match(["lr", "Stade Rochelais", 20], ["tl", "RC Toulonnais", 10], "complete"),
    match(["bb", "Union Bordeaux-Begles", 30], ["pau", "Section Paloise", 25], "complete"),
  ];

  test("places teams by record and re-ranks", () => {
    // Round 2, live: Toulon lead Bordeaux 27-3 with 4 tries to 0.
    const live = match(["tl", "RC Toulonnais", 27], ["bb", "Union Bordeaux-Begles", 3], "live");
    const result = projectStandings({
      standings,
      matches: [...done, live],
      tries: new Map([[live.id, { home: 4, away: 0 }]]),
      rules: top14,
    });
    expect(result.unplaced).toEqual([]);
    expect([...result.live.keys()].sort()).toEqual(["Bordeaux Begles", "Toulon"]);
    const table = result.standings.groups[0]!.rows;
    expect(table.map((r) => [r.position, r.team, r.points])).toEqual([
      [1, "Toulon", 5],
      [2, "La Rochelle", 4],
      [3, "Bordeaux Begles", 4],
      [4, "Pau", 1],
    ]);
    expect(table[0]).toMatchObject({
      played: 2,
      won: 1,
      lost: 1,
      pointsFor: 37,
      pointsAgainst: 23,
    });
    expect(result.live.get("Toulon")?.officialPosition).toBe(4);
  });

  test("reports teams it can't place instead of guessing", () => {
    const live = match(["x", "Unknown Club", 3], ["lr", "Stade Rochelais", 0], "live");
    const result = projectStandings({
      standings,
      matches: [...done, live],
      tries: new Map(),
      rules: top14,
    });
    expect(result.unplaced).toEqual(["Unknown Club"]);
    expect(result.live.has("La Rochelle")).toBe(true);
  });

  test("teams not playing keep their official order", () => {
    // Pau and Toulon are level on points, with Pau ahead by a tie-breaker the projection
    // can't see; a live match between other teams mustn't swap them.
    const tied: Standings = {
      source: "ESPN",
      groups: [
        {
          name: null,
          rows: [
            row(1, "La Rochelle", { won: 1, pointsFor: 20, pointsAgainst: 10, points: 4 }),
            row(2, "Bordeaux Begles", { won: 1, pointsFor: 30, pointsAgainst: 25, points: 4 }),
            // Toulon has the better difference, but Pau is officially ahead.
            row(3, "Pau", { lost: 1, pointsFor: 25, pointsAgainst: 30, points: 0 }),
            row(4, "Toulon", { lost: 1, pointsFor: 10, pointsAgainst: 20, points: 0 }),
          ],
        },
      ],
    };
    const live = match(["lr", "Stade Rochelais", 0], ["bb", "Union Bordeaux-Begles", 40], "live");
    const result = projectStandings({
      standings: tied,
      matches: [...done, live],
      tries: new Map([[live.id, { home: 0, away: 6 }]]),
      rules: top14,
    });
    expect(result.standings.groups[0]!.rows.map((r) => r.team)).toEqual([
      "Bordeaux Begles",
      "La Rochelle",
      "Pau",
      "Toulon",
    ]);
  });

  test("ignores knockout matches", () => {
    const final = {
      ...match(["tl", "RC Toulonnais", 9], ["lr", "Stade Rochelais", 0], "live"),
      round: "Final",
    };
    const result = projectStandings({
      standings,
      matches: [...done, final],
      tries: new Map(),
      rules: top14,
    });
    expect(result.live.size).toBe(0);
  });

  test("applies completed results the official table is missing", () => {
    // Round 2 is over, but the table still shows round 1. Toulon beat Bordeaux 27-3 with 4
    // tries to 0; Pau beat La Rochelle 20-15.
    const round2 = [
      match(["tl", "RC Toulonnais", 27], ["bb", "Union Bordeaux-Begles", 3], "complete"),
      match(["pau", "Section Paloise", 20], ["lr", "Stade Rochelais", 15], "complete"),
    ];
    const matches = [...done, ...round2];
    expect(unrecordedMatches({ standings, matches }).map((m) => m.id)).toEqual(
      round2.map((m) => m.id),
    );
    const result = projectStandings({
      standings,
      matches,
      tries: new Map([[round2[0]!.id, { home: 4, away: 0 }]]),
      rules: top14,
    });
    expect(result.unplaced).toEqual([]);
    expect(result.live.size).toBe(0);
    expect(result.unrecorded.get("Toulon")?.map((r) => r.match.id)).toEqual([round2[0]!.id]);
    expect(
      result.standings.groups[0]!.rows.map((r) => [r.position, r.team, r.played, r.points]),
    ).toEqual([
      [1, "Toulon", 2, 5],
      // Level with Pau, but +5 to Pau's 0.
      [2, "La Rochelle", 2, 5],
      [3, "Pau", 2, 5],
      [4, "Bordeaux Begles", 2, 4],
    ]);
    // Teams keep their names for the timeline filter.
    expect(matchTeamNames({ standings, matches }).get("Pau")).toBe("Section Paloise");
  });

  test("applies unrecorded results and live matches together", () => {
    const round2 = match(
      ["tl", "RC Toulonnais", 27],
      ["bb", "Union Bordeaux-Begles", 3],
      "complete",
    );
    const live = match(["pau", "Section Paloise", 7], ["lr", "Stade Rochelais", 0], "live");
    const result = projectStandings({
      standings,
      matches: [...done, round2, live],
      tries: new Map(),
      rules: top14,
    });
    expect(result.unplaced).toEqual([]);
    expect([...result.unrecorded.keys()].sort()).toEqual(["Bordeaux Begles", "Toulon"]);
    expect([...result.live.keys()].sort()).toEqual(["La Rochelle", "Pau"]);
    expect(result.standings.groups[0]!.rows.every((r) => r.played === 2)).toBe(true);
  });

  test("an up-to-date table has nothing unrecorded", () => {
    expect(unrecordedMatches({ standings, matches: done })).toEqual([]);
  });

  test("matches past leagueGames don't count", () => {
    // One league match each, then a placement match the table never includes.
    const placement = match(["tl", "RC Toulonnais", 30], ["lr", "Stade Rochelais", 0], "complete");
    expect(unrecordedMatches({ standings, matches: [...done, placement], leagueGames: 1 })).toEqual(
      [],
    );
    expect(
      unrecordedMatches({ standings, matches: [...done, placement] }).map((m) => m.id),
    ).toEqual([placement.id]);
  });
});
