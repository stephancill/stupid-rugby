import { useQueries, useQuery } from "@tanstack/react-query";
import type { Match } from "../../src/worldrugby.ts";
import { fetchMatches, fetchStatus } from "./api.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const TEAM_RANGE_MS = 365 * DAY_MS;

// Data comes from the index (worker/indexer.ts); live changes are pushed into these
// queries' caches by useLiveUpdates (live.ts), so nothing polls.

// Weeks are UTC-aligned so every viewer, whatever their timezone, requests the same date
// ranges and shares the API's cache entries. Days are still grouped in local time.
export function startOfWeek({ date }: { date: Date }) {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start;
}

// The index's window and latest fixture.
export function useIndexStatus() {
  return useQuery({ queryKey: ["status"], queryFn: fetchStatus, staleTime: 5 * 60_000 });
}

// Matches are fetched one week at a time, so extending the window only fetches new weeks.
// Weeks before the index's window are never requested (the API rejects them).
export function useMatches({
  now,
  weeksBefore,
  weeksAfter,
}: {
  now: Date;
  weeksBefore: number;
  weeksAfter: number;
}) {
  const status = useIndexStatus();
  const thisWeek = startOfWeek({ date: now }).getTime();
  const windowFrom = status.data?.window.from.getTime() ?? -Infinity;
  const weeks = Array.from(
    { length: weeksBefore + weeksAfter + 1 },
    (_, i) => thisWeek + (i - weeksBefore) * WEEK_MS,
  ).filter((start) => start >= windowFrom);
  const end = thisWeek + (weeksAfter + 1) * WEEK_MS;

  const weekly = useQueries({
    queries: weeks.map((start) => ({
      queryKey: ["matches", start],
      queryFn: () => fetchMatches({ from: new Date(start), to: new Date(start + WEEK_MS) }),
      staleTime: start === thisWeek ? 30_000 : 10 * 60_000,
    })),
    combine: (results) => ({
      matches: results
        .flatMap((r) => r.data ?? [])
        .sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime()),
      isPending: results.some((r) => r.isPending),
      isFetching: results.some((r) => r.isFetching),
      error: results.find((r) => r.error)?.error ?? null,
    }),
  });

  return {
    ...weekly,
    error: weekly.error ?? status.error,
    // Whether the index has fixtures after (or weeks before) what's loaded.
    hasLater: (status.data?.lastKickoff?.getTime() ?? 0) >= end,
    hasEarlier: status.data !== undefined && thisWeek - weeksBefore * WEEK_MS > windowFrom,
    indexFrom: status.data?.window.from ?? null,
    isFetching: weekly.isFetching || status.isFetching,
  };
}

// Every match for the given teams within a year either side of this week, across all
// competitions, in one request.
export function useTeamMatches({ teamIds, now }: { teamIds: string[]; now: Date }) {
  const thisWeek = startOfWeek({ date: now }).getTime();
  const from = new Date(thisWeek - TEAM_RANGE_MS);
  const to = new Date(thisWeek + TEAM_RANGE_MS);
  const query = useQuery({
    queryKey: ["team-matches", teamIds, thisWeek],
    queryFn: (): Promise<Match[]> => fetchMatches({ from, to, teams: teamIds }),
    enabled: teamIds.length > 0,
    staleTime: 60_000,
  });
  return { ...query, from, to };
}

export function dayKey({ date }: { date: Date }) {
  return date.toLocaleDateString("en-CA");
}

// The match day closest to today; on a tie the upcoming day wins.
export function closestDay({ days, now }: { days: string[]; now: Date }) {
  const today = new Date(dayKey({ date: now })).getTime();
  let best: { key: string; distance: number } | null = null;
  for (const key of days) {
    const diff = new Date(key).getTime() - today;
    const distance = Math.abs(diff) - (diff >= 0 ? 0.5 : 0);
    if (!best || distance < best.distance) best = { key, distance };
  }
  return best?.key ?? null;
}
