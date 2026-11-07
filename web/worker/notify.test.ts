import { describe, expect, test } from "bun:test";
import type { Incident, Match } from "../../src/worldrugby.ts";
import {
  CORRECTION_CONFIRM_MS,
  matchEvents,
  payloadFor,
  type ScoreAlertState,
  scoreAlertStep,
  scoringIncidents,
} from "./notify.ts";

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
    periodStart: null,
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
  test("scores are left to scoreAlertStep", () => {
    expect(matchEvents({ before: live(0, 0), after: live(7, 0) })).toEqual([]);
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

describe("scoreAlertStep", () => {
  const SEC = 1000;
  const confirm = CORRECTION_CONFIRM_MS / SEC;
  const parse = (s: string) => {
    const [home, away] = s.split("-").map(Number);
    return { home, away };
  };
  // Replays polls of [seconds, "home-away"] from a starting alerted score and returns the
  // scores that were alerted.
  function replay({ start, polls }: { start: string; polls: [number, string][] }) {
    let state: ScoreAlertState = { alerted: parse(start), pending: null };
    const alerts: string[] = [];
    for (const [secs, score] of polls) {
      const step = scoreAlertStep({ state, current: parse(score), now: secs * SEC });
      state = step.state;
      if (step.alert) alerts.push(score);
    }
    return alerts;
  }

  test("rises alert straight away", () => {
    const polls: [number, string][] = [
      [0, "0-5"],
      [10, "0-7"],
      [20, "3-7"],
    ];
    expect(replay({ start: "0-0", polls })).toEqual(["0-5", "0-7", "3-7"]);
  });

  test("a drop that flaps back is silent", () => {
    const polls: [number, string][] = [
      [0, "0-52"],
      [30, "7-52"],
      [60, "7-52"],
    ];
    expect(replay({ start: "7-52", polls })).toEqual([]);
  });

  test("a drop that sticks is alerted once confirmed", () => {
    const polls: [number, string][] = [
      [0, "0-0"],
      [confirm - 10, "0-0"],
      [confirm, "0-0"],
      [confirm + 10, "0-0"],
    ];
    expect(replay({ start: "0-2", polls })).toEqual(["0-0"]);
  });

  test("a different drop restarts the wait", () => {
    const polls: [number, string][] = [
      [0, "0-52"],
      [confirm - 10, "2-52"],
      [confirm + 10, "2-52"],
    ];
    expect(replay({ start: "7-52", polls })).toEqual([]);
  });

  test("a rise on one side alerts even with a drop on the other", () => {
    expect(replay({ start: "7-52", polls: [[0, "0-57"]] })).toEqual(["0-57"]);
  });

  // Italy v South Africa, 7 Nov 2026 (Italy at home), from Workers Logs: the feed's score at
  // each change. Per-poll detection sent every one of these, 5 of them "Score corrected".
  // Only the real scores should go out.
  test("the World Rugby flapping seen on 7 Nov 2026", () => {
    const at = (hms: string) => {
      const [h, m, s] = hms.split(":").map(Number);
      return h * 3600 + m * 60 + s;
    };
    const changes: [string, string][] = [
      ["13:07:15", "5-52"],
      ["13:07:46", "7-52"],
      ["13:08:18", "0-52"],
      ["13:08:49", "7-52"],
      ["13:09:20", "0-52"],
      ["13:11:02", "2-52"],
      ["13:11:33", "0-52"],
      ["13:14:26", "7-52"],
      ["13:15:37", "2-52"],
      ["13:16:08", "7-52"],
      ["13:19:12", "7-57"],
      ["13:19:42", "7-59"],
      ["13:21:33", "7-52"],
      ["13:22:03", "7-59"],
    ];
    // The step runs every poll, not only on changes: fill in 10s polls between changes.
    const polls: [number, string][] = [];
    changes.forEach(([time, score], i) => {
      const next = changes[i + 1] ? at(changes[i + 1][0]) : at(time) + 10;
      for (let t = at(time); t < next; t += 10) polls.push([t, score]);
    });
    expect(replay({ start: "0-52", polls })).toEqual(["5-52", "7-52", "7-57", "7-59"]);
  });
});
