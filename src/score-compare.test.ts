import { describe, expect, test } from "bun:test";
import type { EspnEvent } from "./espn.ts";
import { divergenceStep, espnScore, pairEvents } from "./score-compare.ts";
import type { Match } from "./worldrugby.ts";

function match(id: string, home: string, away: string, kickoff: string): Match {
  return {
    id,
    competition: "URC 2027",
    competitionId: "s",
    round: "League",
    kickoff: new Date(kickoff),
    venue: null,
    home: { id: `${id}h`, name: home, score: 0 },
    away: { id: `${id}a`, name: away, score: 0 },
    state: "L1",
    phase: "live",
    clock: null,
    periodStart: null,
    winner: null,
  };
}

function event(id: string, home: string, away: string, kickoff: string): EspnEvent {
  return {
    id,
    kickoff: new Date(kickoff),
    state: "in",
    home: { name: home, score: 7 },
    away: { name: away, score: 3 },
  };
}

describe("pairEvents", () => {
  test("pairs simultaneous kick-offs by team names", () => {
    const matches = [
      match("glas", "Glasgow Warriors", "Lions", "2026-10-30T19:45:00Z"),
      match("bris", "Bristol Bears", "Leicester Tigers", "2026-10-30T19:45:00Z"),
    ];
    const events = [
      event("e1", "Bristol Rugby", "Leicester Tigers", "2026-10-30T19:45:00Z"),
      event("e2", "Glasgow Warriors", "Lions", "2026-10-30T19:45:00Z"),
    ];
    const pairs = pairEvents({ matches, events });
    expect(pairs.get("glas")?.id).toBe("e2");
    expect(pairs.get("bris")?.id).toBe("e1");
  });

  test("leaves a match unpaired when kick-offs are far apart", () => {
    const matches = [match("glas", "Glasgow Warriors", "Lions", "2026-10-30T19:45:00Z")];
    const events = [event("e1", "Glasgow Warriors", "Lions", "2026-10-31T19:45:00Z")];
    expect(pairEvents({ matches, events }).size).toBe(0);
  });
});

describe("espnScore", () => {
  test("is null before kick-off", () => {
    const e = event("e1", "A", "B", "2026-10-30T19:45:00Z");
    expect(espnScore({ event: { ...e, state: "pre" } })).toBeNull();
    expect(espnScore({ event: e })).toEqual({ home: 7, away: 3 });
  });
});

describe("divergenceStep", () => {
  const s = (home: number, away: number) => ({ home, away });

  test("opens when scores differ and updates while they still do", () => {
    expect(divergenceStep({ open: null, wr: s(0, 0), espn: s(7, 0) })).toEqual({ kind: "open" });
    const open = { wr: s(0, 0), espn: s(7, 0) };
    expect(divergenceStep({ open, wr: s(0, 0), espn: s(10, 0) })).toEqual({ kind: "update" });
  });

  test("nothing to do while scores agree", () => {
    expect(divergenceStep({ open: null, wr: s(7, 0), espn: s(7, 0) })).toEqual({ kind: "none" });
  });

  test("ESPN was ahead when World Rugby catches up", () => {
    const open = { wr: s(0, 0), espn: s(7, 0) };
    expect(divergenceStep({ open, wr: s(7, 0), espn: s(7, 0) })).toEqual({
      kind: "close",
      ahead: "espn",
    });
  });

  test("World Rugby was ahead when ESPN catches up", () => {
    const open = { wr: s(7, 0), espn: s(0, 0) };
    expect(divergenceStep({ open, wr: s(7, 0), espn: s(7, 0) })).toEqual({
      kind: "close",
      ahead: "wr",
    });
  });

  test("neither when both change on the closing poll", () => {
    const open = { wr: s(0, 0), espn: s(5, 0) };
    expect(divergenceStep({ open, wr: s(7, 0), espn: s(7, 0) })).toEqual({
      kind: "close",
      ahead: "neither",
    });
  });
});
