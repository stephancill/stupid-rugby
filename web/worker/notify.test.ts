import { describe, expect, test } from "bun:test";
import type { Incident, Match } from "../../src/worldrugby.ts";
import { matchEvents, payloadFor, scoringIncidents } from "./notify.ts";

function match(overrides: Partial<Match> = {}): Match {
  return {
    id: "m1",
    competition: "URC 2027",
    competitionId: "s1",
    round: "Round 5",
    kickoff: new Date("2026-10-25T15:00:00Z"),
    venue: null,
    home: { id: "h", name: "Leinster", score: 0 },
    away: { id: "a", name: "Munster", score: 0 },
    state: "U",
    phase: "scheduled",
    clock: null,
    winner: null,
    ...overrides,
  };
}

const live = (home: number, away: number, state: Match["state"] = "L1") =>
  match({
    state,
    phase: "live",
    home: { id: "h", name: "Leinster", score: home },
    away: { id: "a", name: "Munster", score: away },
  });

const incident = (kind: Incident["kind"], team: Incident["team"], secs: number, player = "P") => ({
  kind,
  team,
  secs,
  clock: "",
  player,
});

describe("matchEvents", () => {
  test("kickoff", () => {
    expect(matchEvents({ before: match(), after: live(0, 0) })).toEqual(["kickoff"]);
  });
  test("score", () => {
    expect(matchEvents({ before: live(0, 0), after: live(7, 0) })).toEqual(["score"]);
  });
  test("clock changes alone are not events", () => {
    expect(matchEvents({ before: live(7, 0), after: { ...live(7, 0), clock: "12:00" } })).toEqual(
      [],
    );
  });
  test("half-time", () => {
    expect(matchEvents({ before: live(7, 0), after: live(7, 0, "LHT") })).toEqual(["half-time"]);
  });
  test("full time replaces a final score change", () => {
    const after = match({ ...live(10, 7), state: "C", phase: "complete", winner: "home" });
    expect(matchEvents({ before: live(7, 7), after })).toEqual(["full-time"]);
  });
});

describe("scoringIncidents", () => {
  const incidents = [
    incident("penalty", "away", 100),
    incident("try", "home", 200, "Lowe"),
    incident("conversion", "home", 260, "Byrne"),
  ];
  test("a try and conversion in one poll", () => {
    expect(scoringIncidents({ incidents, team: "home", points: 7 })?.map((i) => i.kind)).toEqual([
      "try",
      "conversion",
    ]);
  });
  test("just the latest score", () => {
    expect(scoringIncidents({ incidents, team: "away", points: 3 })?.map((i) => i.kind)).toEqual([
      "penalty",
    ]);
  });
  test("a penalty try is 7", () => {
    const penaltyTry = [{ ...incident("try", "home", 300), player: null }];
    expect(scoringIncidents({ incidents: penaltyTry, team: "home", points: 7 })).toHaveLength(1);
  });
  test("null when the summary hasn't caught up", () => {
    expect(scoringIncidents({ incidents, team: "away", points: 5 })).toBeNull();
  });
});

describe("payloadFor", () => {
  test("score with scorers", () => {
    const payload = payloadFor({
      kind: "score",
      match: live(7, 0),
      scorers: [
        {
          team: "home",
          incidents: [
            incident("try", "home", 176, "Lowe"),
            incident("conversion", "home", 233, "Byrne"),
          ],
        },
      ],
    });
    expect(payload).toEqual({
      title: "Leinster 7–0 Munster",
      body: "Try – Lowe 3', Conversion – Byrne 4'",
      url: "/matches/m1",
      tag: "m1",
    });
  });
  test("score without scorers names the team", () => {
    const payload = payloadFor({
      kind: "score",
      match: live(0, 3),
      scorers: [{ team: "away", incidents: null }],
    });
    expect(payload.body).toBe("Munster score");
  });
  test("score taken back", () => {
    const payload = payloadFor({
      kind: "score",
      before: live(0, 2),
      match: live(0, 0),
      scorers: [],
    });
    expect(payload).toMatchObject({ title: "Leinster 0–0 Munster", body: "Score corrected" });
  });
  test("score with a correction", () => {
    const payload = payloadFor({
      kind: "score",
      before: live(0, 2),
      match: live(3, 0),
      scorers: [{ team: "home", incidents: [incident("penalty", "home", 600, "Sexton")] }],
    });
    expect(payload.body).toBe("Penalty – Sexton 11' · Score corrected");
  });
  test("full time", () => {
    const after = match({ ...live(10, 7), state: "C", phase: "complete", winner: "home" });
    expect(payloadFor({ kind: "full-time", match: after }).body).toBe(
      "Full time · Leinster win · URC",
    );
  });
});
