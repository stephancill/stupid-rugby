import { useQueries } from "@tanstack/react-query";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useMemo } from "react";
import { Link } from "react-router";
import { bonusRules, leagueGames } from "../../src/competitions.ts";
import { liveClock } from "../../src/match-clock.ts";
import {
  type LiveTeam,
  matchTeamNames,
  projectStandings,
  type UnrecordedResult,
  unrecordedMatches,
} from "../../src/live-standings.ts";
import type { Standings } from "../../src/standings.ts";
import type { Match } from "../../src/worldrugby.ts";
import { fetchMatchSummary } from "./api.ts";
import { useNow } from "./now.ts";

// No default: it depends on whether the official table is behind (see StandingsSection).
const tableParser = parseAsStringLiteral(["official", "live"] as const);

function LiveNote({ live }: { live: LiveTeam }) {
  const { match, side } = live;
  const opponent = match[side === "home" ? "away" : "home"];
  const now = useNow({ enabled: true });
  const clock = liveClock({ match, now });
  return (
    <small className="live">
      {" "}
      LIVE {match[side].score}–{opponent.score} v {opponent.name}
      {clock && ` (${clock})`}
    </small>
  );
}

// Results counted in the projected table that the official one doesn't have yet.
function UnrecordedNote({ results }: { results: UnrecordedResult[] }) {
  return (
    <small>
      {" "}
      incl.{" "}
      {results
        .map(({ match, side }) => {
          const opponent = match[side === "home" ? "away" : "home"];
          return `${match[side].score}–${opponent.score} v ${opponent.name}`;
        })
        .join(", ")}
    </small>
  );
}

function StandingsTables({
  standings,
  live,
  unrecorded,
  official,
  teamNames,
  competitionKey,
}: {
  standings: Standings;
  live: Map<string, LiveTeam>;
  // Shown only in the projected table; empty otherwise.
  unrecorded: Map<string, UnrecordedResult[]>;
  // Official positions by team, to show movement in the projected table.
  official: Map<string, number> | null;
  // Standings name → the matches' name, which the timeline's team filter uses.
  teamNames: Map<string, string>;
  competitionKey: string;
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
              const added = unrecorded.get(row.team);
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
                    <Link
                      to={{
                        pathname: "/",
                        search: `?${new URLSearchParams({ comp: competitionKey, team: teamNames.get(row.team) ?? row.team })}`,
                      }}
                    >
                      {row.team}
                    </Link>
                    {added && <UnrecordedNote results={added} />}
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

// Official standings, plus an "as it stands" view with completed results the official table
// is missing and in-progress matches applied as if they ended now (src/live-standings.ts).
// When the official table is behind, "as it stands" is the default. Teams playing are
// highlighted in both.
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
  const games = leagueGames({ key: competitionKey });
  const liveMatches = useMemo(() => matches.filter((m) => m.phase === "live"), [matches]);
  const unrecorded = useMemo(
    () => unrecordedMatches({ standings, matches, leagueGames: games }),
    [standings, matches, games],
  );
  const hasProjection = liveMatches.length > 0 || unrecorded.length > 0;
  const shown = table ?? (unrecorded.length > 0 ? "live" : "official");
  const asItStands = shown === "live" && hasProjection;

  // Try counts for bonus points, from each live or unrecorded match's summary.
  const tryMatches = [...unrecorded, ...liveMatches];
  const summaries = useQueries({
    queries: tryMatches.map((m) => ({
      queryKey: ["match-summary", m.id],
      queryFn: () => fetchMatchSummary({ id: m.id }),
      enabled: asItStands,
      refetchInterval: m.phase === "live" ? 15_000 : false,
    })),
  });
  const tries = new Map<string, { home: number; away: number }>();
  summaries.forEach((s, i) => {
    const incidents = s.data?.incidents;
    if (!incidents) return;
    const count = (team: "home" | "away") =>
      incidents.filter((x) => x.kind === "try" && x.team === team).length;
    tries.set(tryMatches[i]!.id, { home: count("home"), away: count("away") });
  });
  const triesKey = JSON.stringify([...tries]);

  const projected = useMemo(
    () =>
      projectStandings({
        standings,
        matches,
        tries: new Map(JSON.parse(triesKey) as [string, { home: number; away: number }][]),
        rules: bonusRules({ key: competitionKey }),
        leagueGames: games,
      }),
    [standings, matches, triesKey, competitionKey, games],
  );
  const official = useMemo(
    () => new Map(standings.groups.flatMap((g) => g.rows.map((r) => [r.team, r.position]))),
    [standings],
  );
  const teamNames = useMemo(
    () => matchTeamNames({ standings, matches, leagueGames: games }),
    [standings, matches, games],
  );
  const pendingTries = asItStands && summaries.some((s) => s.isPending);
  const summaryError = summaries.find((s) => s.error)?.error;

  return (
    <>
      {hasProjection && (
        <p className="table-toggle">
          {(["official", "live"] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name="table"
                checked={shown === value}
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
        unrecorded={asItStands ? projected.unrecorded : new Map()}
        official={asItStands ? official : null}
        teamNames={teamNames}
        competitionKey={competitionKey}
      />
      {asItStands && (
        <p className="source">
          As it stands:{" "}
          {unrecorded.length > 0 &&
            `${unrecorded.length} ${unrecorded.length === 1 ? "result" : "results"} the official table doesn't include yet${liveMatches.length > 0 ? " and " : " "}`}
          {liveMatches.length > 0 && "live matches as if they ended now "}
          counted, including bonus points. Teams with new results are placed by points, then points
          difference, then points for; the rest keep their official order.
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
