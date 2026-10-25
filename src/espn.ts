import { z } from "zod";
import { getJson } from "./http.ts";
import type { Standings, StandingsGroup } from "./standings.ts";

// Unofficial ESPN API. No auth. Used for standings, which World Rugby only publishes for
// some of its own events. ESPN numbers a season by the year it ends (2026-27 is 2027).
export const ESPN_URL = "https://site.api.espn.com";

const statSchema = z.object({ name: z.string(), value: z.number().nullish() });

const entrySchema = z.object({
  team: z.object({ displayName: z.string() }),
  stats: z.array(statSchema),
});

type Node = {
  name?: string;
  standings?: { season?: number; entries?: z.infer<typeof entrySchema>[] };
  children?: Node[];
};

const nodeSchema: z.ZodType<Node> = z.lazy(() =>
  z.object({
    name: z.string().optional(),
    standings: z
      .object({ season: z.number().optional(), entries: z.array(entrySchema).optional() })
      .optional(),
    children: z.array(nodeSchema).optional(),
  }),
);

// Leagues have one standings node; pooled competitions nest one per pool in `children`.
function collectGroups({ node }: { node: Node }): { season?: number; group: StandingsGroup }[] {
  const own = node.standings?.entries
    ? [
        {
          season: node.standings.season,
          group: {
            name: node.name ?? null,
            rows: node.standings.entries
              .map((entry) => {
                const stat = (name: string) => entry.stats.find((s) => s.name === name)?.value ?? 0;
                return {
                  position: stat("rank"),
                  team: entry.team.displayName,
                  played: stat("gamesPlayed"),
                  won: stat("gamesWon"),
                  drawn: stat("gamesDrawn"),
                  lost: stat("gamesLost"),
                  pointsFor: stat("pointsFor"),
                  pointsAgainst: stat("pointsAgainst"),
                  bonusPoints: stat("bonusPoints"),
                  points: stat("points"),
                };
              })
              .sort((a, b) => a.position - b.position),
          },
        },
      ]
    : [];
  return [...own, ...(node.children ?? []).flatMap((child) => collectGroups({ node: child }))];
}

export function createEspnClient({ baseUrl = ESPN_URL }: { baseUrl?: string } = {}) {
  // Returns null when ESPN has no table for `season`: for a season it doesn't cover it
  // answers with whichever season it has (its Top 14 table is stuck on 2022-23).
  async function fetchStandings({
    leagueId,
    season,
  }: {
    leagueId: number;
    season: number;
  }): Promise<Standings | null> {
    const json = await getJson({
      url: `${baseUrl}/apis/v2/sports/rugby/${leagueId}/standings?season=${season}`,
      source: "ESPN",
    });
    const groups = collectGroups({ node: nodeSchema.parse(json) });
    const current = groups.filter((g) => g.season === season && g.group.rows.length > 0);
    if (current.length === 0) return null;
    return { source: "ESPN", groups: current.map((g) => g.group) };
  }

  return { fetchStandings };
}
