import type { EspnEvent } from "./espn.ts";
import { similarity } from "./live-standings.ts";
import type { Match } from "./worldrugby.ts";

// Live scores from World Rugby compared with ESPN's, to measure whether (and by how much)
// World Rugby lags. Nothing user-facing reads ESPN scores; the index only records periods
// where the two disagree.

const KICKOFF_TOLERANCE_MS = 30 * 60 * 1000;

export type Score = { home: number; away: number };

// Pairs each match with the ESPN event kicking off at about the same time whose team names
// are most alike. Each event pairs at most once. Unpaired matches are left out.
export function pairEvents({
  matches,
  events,
}: {
  matches: Match[];
  events: EspnEvent[];
}): Map<string, EspnEvent> {
  const candidates = matches.flatMap((match) =>
    events
      .filter(
        (event) =>
          Math.abs(event.kickoff.getTime() - match.kickoff.getTime()) <= KICKOFF_TOLERANCE_MS,
      )
      .map((event) => ({
        match,
        event,
        score:
          similarity({ a: match.home.name, b: event.home.name }) +
          similarity({ a: match.away.name, b: event.away.name }),
      }))
      .filter((c) => c.score > 0),
  );
  const pairs = new Map<string, EspnEvent>();
  const used = new Set<string>();
  for (const { match, event } of candidates.toSorted((a, b) => b.score - a.score)) {
    if (pairs.has(match.id) || used.has(event.id)) continue;
    pairs.set(match.id, event);
    used.add(event.id);
  }
  return pairs;
}

export function espnScore({ event }: { event: EspnEvent }): Score | null {
  if (event.state === "pre" || event.home.score === null || event.away.score === null) {
    return null;
  }
  return { home: event.home.score, away: event.away.score };
}

export function formatScore({ score }: { score: Score }) {
  return `${score.home}-${score.away}`;
}

function sameScore({ a, b }: { a: Score; b: Score }) {
  return a.home === b.home && a.away === b.away;
}

// An open divergence: the scores each source showed at the last poll.
export type OpenDivergence = { wr: Score; espn: Score };

// "espn": World Rugby caught up with ESPN, so ESPN was ahead. "wr": the reverse. "neither":
// both changed on the same poll.
export type Ahead = "espn" | "wr" | "neither";

export type DivergenceStep =
  | { kind: "none" }
  | { kind: "open" }
  | { kind: "update" }
  | { kind: "close"; ahead: Ahead };

// One poll's transition. A divergence opens when the scores first differ and closes when
// they agree again; whichever source didn't change on the closing poll was ahead.
export function divergenceStep({
  open,
  wr,
  espn,
}: {
  open: OpenDivergence | null;
  wr: Score;
  espn: Score;
}): DivergenceStep {
  if (!sameScore({ a: wr, b: espn })) return { kind: open ? "update" : "open" };
  if (!open) return { kind: "none" };
  const wrMoved = !sameScore({ a: open.wr, b: wr });
  const espnMoved = !sameScore({ a: open.espn, b: espn });
  return {
    kind: "close",
    ahead: wrMoved && !espnMoved ? "espn" : espnMoved && !wrMoved ? "wr" : "neither",
  };
}
