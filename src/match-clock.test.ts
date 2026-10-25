import { describe, expect, test } from "bun:test";
import { liveClock, withPeriodStart } from "./match-clock.ts";
import type { Match } from "./worldrugby.ts";

function match(state: Match["state"], extra: Partial<Match> = {}): Match {
  return {
    id: "m1",
    competition: "Top 14 2027",
    competitionId: "s",
    round: "League",
    kickoff: new Date("2026-10-25T20:05:00Z"),
    venue: null,
    home: { id: "lr", name: "Stade Rochelais", score: 0 },
    away: { id: "bb", name: "Union Bordeaux-Begles", score: 0 },
    state,
    phase: state === "U" ? "scheduled" : "live",
    clock: null,
    periodStart: null,
    winner: null,
    ...extra,
  };
}

const at = (time: string) => new Date(`2026-10-25T${time}Z`);

describe("withPeriodStart", () => {
  test("stamps kickoff when the match goes live", () => {
    const now = at("20:08:18");
    expect(withPeriodStart({ match: match("L1"), before: match("U"), now }).periodStart).toEqual(
      now,
    );
  });
  test("keeps the start while the period continues", () => {
    const before = match("L1", { periodStart: at("20:08:18") });
    expect(
      withPeriodStart({ match: match("L1"), before, now: at("20:30:00") }).periodStart,
    ).toEqual(at("20:08:18"));
  });
  test("stamps the second half", () => {
    const now = at("21:09:20");
    expect(withPeriodStart({ match: match("L2"), before: match("LHT"), now }).periodStart).toEqual(
      now,
    );
  });
  test("a period under way when first seen is unknown", () => {
    expect(
      withPeriodStart({ match: match("L2"), before: null, now: at("21:20:00") }).periodStart,
    ).toBeNull();
  });
  test("clears it at half time", () => {
    const before = match("L1", { periodStart: at("20:08:18") });
    expect(
      withPeriodStart({ match: match("LHT"), before, now: at("20:54:20") }).periodStart,
    ).toBeNull();
  });
});

describe("liveClock", () => {
  test("counts from the period start", () => {
    const m = match("L1", { periodStart: at("20:08:24"), clock: "45:48" });
    expect(liveClock({ match: m, now: at("20:51:24") })).toBe("43:00");
  });
  test("second half starts at 40:00", () => {
    const m = match("L2", { periodStart: at("21:09:14") });
    expect(liveClock({ match: m, now: at("21:21:04") })).toBe("51:50");
  });
  test("half time", () => {
    expect(liveClock({ match: match("LHT"), now: at("21:00:00") })).toBe("HT");
  });
  test("falls back to World Rugby's clock, marked as an estimate", () => {
    expect(liveClock({ match: match("L2", { clock: "35:26" }), now: at("21:21:00") })).toBe(
      "~35:26",
    );
  });
});
