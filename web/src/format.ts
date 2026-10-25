import { liveClock } from "../../src/match-clock.ts";
import type { Match } from "../../src/worldrugby.ts";

export function formatDay({ key }: { key: string }) {
  return new Date(`${key}T00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatTime({ date }: { date: Date }) {
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// `now` comes from useNow, so live clocks tick.
export function matchStatus({ match, now }: { match: Match; now: Date }) {
  return match.phase === "live"
    ? `LIVE ${liveClock({ match, now }) ?? ""}`
    : match.phase === "complete"
      ? "FT"
      : match.phase === "scheduled"
        ? formatTime({ date: match.kickoff })
        : match.phase.toUpperCase();
}
