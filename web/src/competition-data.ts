import { useQuery } from "@tanstack/react-query";
import { findCompetitionByKey } from "../../src/competitions.ts";
import type { Season } from "../../src/worldrugby.ts";
import { fetchSeason, fetchSeasons } from "./api.ts";

// Seasons of a major competition in the index's window, newest first. Other competitions
// have no label pattern, so they rely on a linked season id.
export function useSeasons({ key }: { key: string }) {
  const competition = findCompetitionByKey({ key });
  return useQuery({
    queryKey: ["seasons"],
    queryFn: fetchSeasons,
    enabled: competition !== null,
    staleTime: 60 * 60_000,
    select: (seasons: Season[]) => seasons.filter((s) => competition?.seasons.test(s.label)),
  });
}

// A season's matches and standings. Live changes are pushed in by useLiveUpdates (live.ts).
export function useSeason({ id }: { id: string | null }) {
  return useQuery({
    queryKey: ["season", id],
    queryFn: () => fetchSeason({ id: id! }),
    enabled: id !== null,
    staleTime: 60_000,
  });
}
