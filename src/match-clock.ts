import type { Match, MatchState } from "./worldrugby.ts";

// The live match clock. World Rugby's own clock is sometimes started at the scheduled
// kickoff rather than the real one (minutes out), and stalls; its status changes are
// timely. So the clock counts up from when the index saw the current period start, and
// World Rugby's clock is only a fallback, marked as an estimate.

// Where each period's clock starts, in seconds.
const periodOffsets: Partial<Record<MatchState, number>> = {
  L1: 0,
  L2: 40 * 60,
  LT1: 80 * 60,
  LT2: 90 * 60,
};

function isPeriodState({ state }: { state: MatchState }) {
  return state in periodOffsets;
}

// Upstream matches carry no period start: keep the stored one while the period continues,
// and stamp a new period (kickoff, second half, extra time) with when it was first seen.
// The index polls live matches every 10s, so that's within seconds of the real start. A
// period already under way when first seen stays unknown.
export function withPeriodStart({
  match,
  before,
  now,
}: {
  match: Match;
  before: Match | null;
  now: Date;
}) {
  if (match.phase !== "live" || !isPeriodState({ state: match.state })) {
    return { ...match, periodStart: null };
  }
  if (before?.state === match.state) return { ...match, periodStart: before.periodStart };
  return { ...match, periodStart: before ? now : null };
}

function formatSecs({ secs }: { secs: number }) {
  const minutes = Math.floor(secs / 60);
  return `${String(minutes).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
}

// "HT", "52:10", "~35:26" (World Rugby's clock), or null when there is nothing to show.
export function liveClock({ match, now }: { match: Match; now: Date }): string | null {
  if (match.phase !== "live") return null;
  if (match.state === "LHT") return "HT";
  const offset = periodOffsets[match.state];
  if (offset !== undefined && match.periodStart) {
    const elapsed = Math.max(0, Math.floor((now.getTime() - match.periodStart.getTime()) / 1000));
    return formatSecs({ secs: offset + elapsed });
  }
  return match.clock && `~${match.clock}`;
}
