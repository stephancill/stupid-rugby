import { useQueries } from "@tanstack/react-query";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useMemo } from "react";
import { bonusRules } from "../../src/competitions.ts";
import { type LiveTeam, projectStandings } from "../../src/live-standings.ts";
import type { Standings } from "../../src/standings.ts";
import type { Match } from "../../src/worldrugby.ts";
import { fetchMatchSummary } from "./api.ts";

const tableParser = parseAsStringLiteral(["official", "live"] as const).withDefault("official");

function LiveNote({ live }: { live: LiveTeam }) {
  const { match, side } = live;
  const opponent = match[side === "home" ? "away" : "home"];
  const clock = match.state === "LHT" ? "HT" : match.clock;
  return (
    <small className="live">
      {" "}
      LIVE {match[side].score}–{opponent.score} v {opponent.name}
      {clock && ` (${clock})`}
    </small>
  );
}

function StandingsTables({
  standings,
  live,
  official,
}: {
  standings: Standings;
  live: Map<string, LiveTeam>;
  // Official positions by team, to show movement in the projected table.
  official: Map<string, number> | null;
}) {
  return (
    <>
      {standings.groups.map((group, i) => (
        <table key={group.name ?? i} className="standings">
          {group.name && <caption>{group.name}</caption>}
          <thead>
            <tr>
              <th>#</th>
              <th className="team-col">Team</th>
              <th title="Played">P</th>
              <th title="Won">W</th>
              <th title="Drawn">D</th>
              <th title="Lost">L</th>
              <th title="Points for">PF</th>
              <th title="Points against">PA</th>
              <th title="Points difference">+/-</th>
              <th title="Bonus points">BP</th>
              <th title="League points">Pts</th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => {
              const diff = row.pointsFor - row.pointsAgainst;
              const playing = live.get(row.team);
              const moved = official ? (official.get(row.team) ?? row.position) - row.position : 0;
              return (
                <tr key={row.team} className={playing ? "playing" : undefined}>
                  <td>
                    {row.position}
                    {moved !== 0 && (
                      <small className={moved > 0 ? "up" : "down"}>
                        {moved > 0 ? ` ▲${moved}` : ` ▼${-moved}`}
                      </small>
                    )}
                  </td>
                  <td className="team-col">
                    {row.team}
                    {playing && <LiveNote live={playing} />}
                  </td>
                  <td>{row.played}</td>
                  <td>{row.won}</td>
                  <td>{row.drawn}</td>
                  <td>{row.lost}</td>
                  <td>{row.pointsFor}</td>
                  <td>{row.pointsAgainst}</td>
                  <td>{diff > 0 ? `+${diff}` : diff}</td>
                  <td>{row.bonusPoints}</td>
                  <td>
                    <strong>{row.points}</strong>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ))}
    </>
  );
}

// Official standings, plus an "as it stands" view with in-progress matches applied as if
// they ended now (src/live-standings.ts). Teams playing are highlighted in both.
export function StandingsSection({
  standings,
  matches,
  competitionKey,
}: {
  standings: Standings;
  matches: Match[];
  competitionKey: string;
}) {
  const [table, setTable] = useQueryState("table", tableParser);
  const liveMatches = useMemo(() => matches.filter((m) => m.phase === "live"), [matches]);
  const asItStands = table === "live" && liveMatches.length > 0;

  // Try counts for bonus points, from each live match's summary.
  const summaries = useQueries({
    queries: liveMatches.map((m) => ({
      queryKey: ["match-summary", m.id],
      queryFn: () => fetchMatchSummary({ id: m.id }),
      enabled: asItStands,
      refetchInterval: 15_000,
    })),
  });
  const tries = new Map<string, { home: number; away: number }>();
  summaries.forEach((s, i) => {
    const incidents = s.data?.incidents;
    if (!incidents) return;
    const count = (team: "home" | "away") =>
      incidents.filter((x) => x.kind === "try" && x.team === team).length;
    tries.set(liveMatches[i]!.id, { home: count("home"), away: count("away") });
  });
  const triesKey = JSON.stringify([...tries]);

  const projected = useMemo(
    () =>
      projectStandings({
        standings,
        matches,
        tries: new Map(JSON.parse(triesKey) as [string, { home: number; away: number }][]),
        rules: bonusRules({ key: competitionKey }),
      }),
    [standings, matches, triesKey, competitionKey],
  );
  const official = useMemo(
    () => new Map(standings.groups.flatMap((g) => g.rows.map((r) => [r.team, r.position]))),
    [standings],
  );
  const pendingTries = asItStands && summaries.some((s) => s.isPending);
  const summaryError = summaries.find((s) => s.error)?.error;

  return (
    <>
      {liveMatches.length > 0 && (
        <p className="table-toggle">
          {(["official", "live"] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="table"
                checked={table === value}
                onChange={() => void setTable(value)}
              />
              {value === "official" ? "Official" : "As it stands"}
            </label>
          ))}
        </p>
      )}
      <StandingsTables
        standings={asItStands ? projected.standings : standings}
        live={projected.live}
        official={asItStands ? official : null}
      />
      {asItStands && (
        <p className="source">
          As it stands: live matches counted as if they ended now, including bonus points. Teams
          playing are placed by points, then points difference, then points for; the rest keep their
          official order.
          {pendingTries && " Try bonus points are loading."}
        </p>
      )}
      {asItStands && summaryError && (
        <p className="error">
          Couldn't load try counts, so try bonus points are missing: {summaryError.message}
        </p>
      )}
      {projected.unplaced.length > 0 && (
        <p className="error">
          Couldn't find {projected.unplaced.join(", ")} in the table, so{" "}
          {projected.unplaced.length === 1 ? "its" : "their"} live result isn't included.
        </p>
      )}
      <p className="source">Standings: {standings.source}</p>
    </>
  );
}
