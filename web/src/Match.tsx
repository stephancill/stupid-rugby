import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect } from "react";
import { Link, useParams } from "react-router";
import { baseLabel, competitionKey } from "../../src/competitions.ts";
import {
  type Incident,
  type LineupPlayer,
  type Match,
  type TeamStats,
} from "../../src/worldrugby.ts";
import { fetchMatchStats, fetchMatchSummary } from "./api.ts";
import { FollowButton, PushHint } from "./FollowButton.tsx";
import { matchStatus } from "./format.ts";

const LIVE_REFETCH_MS = 10_000;
const PRE_MATCH_REFETCH_MS = 60_000;
const PRE_MATCH_WINDOW_MS = 2 * 60 * 60 * 1000;

// While live, poll at the proxy's cache lifetime; before kickoff, slowly (line-ups land
// about an hour before).
function refetchFor({ match }: { match: Match | undefined }) {
  if (!match) return false;
  if (match.phase === "live") return LIVE_REFETCH_MS;
  const untilKickoff = match.kickoff.getTime() - Date.now();
  return match.phase === "scheduled" && untilKickoff < PRE_MATCH_WINDOW_MS
    ? PRE_MATCH_REFETCH_MS
    : false;
}

const incidentLabels: Record<Incident["kind"], string> = {
  try: "Try",
  conversion: "Conversion",
  penalty: "Penalty",
  "drop-goal": "Drop goal",
  "yellow-card": "Yellow card",
  "red-card": "Red card",
};

function describe({ incident }: { incident: Incident }) {
  // A try with no scorer is a penalty try.
  if (incident.kind === "try" && !incident.player) return "Penalty try";
  return `${incidentLabels[incident.kind]} – ${incident.player ?? "unknown player"}`;
}

const percent = (v: number) => `${Math.round(v * 100)}%`;
const count = (v: number) => String(Math.round(v));

// A curated subset of World Rugby's ~130 team stats.
const statRows: { label: string; key: string; format: (v: number) => string; of?: string }[] = [
  { label: "Possession", key: "Possession", format: percent },
  { label: "Territory", key: "Territory", format: percent },
  { label: "Tries", key: "Tries", format: count },
  { label: "Metres carried", key: "Metres", format: count },
  { label: "Carries", key: "Carries", format: count },
  { label: "Clean breaks", key: "CleanBreaks", format: count },
  { label: "Defenders beaten", key: "DefendersBeaten", format: count },
  { label: "Offloads", key: "Offload", format: count },
  { label: "Passes", key: "Passes", format: count },
  { label: "Kicks from hand", key: "KicksFromHand", format: count },
  { label: "Tackles", key: "Tackles", format: count },
  { label: "Missed tackles", key: "MissedTackles", format: count },
  { label: "Tackle success", key: "TackleSuccess", format: percent },
  { label: "Line-outs won", key: "LineoutsWon", of: "TotalLineouts", format: count },
  { label: "Scrums won", key: "ScrumsWon", of: "ScrumsTotal", format: count },
  { label: "Penalties conceded", key: "PenaltiesConceded", format: count },
];

function StatsTable({ stats, match }: { stats: NonNullable<TeamStats>; match: Match }) {
  const cell = ({
    side,
    row,
  }: {
    side: Record<string, number>;
    row: (typeof statRows)[number];
  }) => {
    const value = side[row.key] ?? 0;
    return row.of ? `${row.format(value)}/${row.format(side[row.of] ?? 0)}` : row.format(value);
  };
  const rows = statRows.filter((row) => row.key in stats.home || row.key in stats.away);
  return (
    <table className="stats">
      <thead>
        <tr>
          <th>{match.home.name}</th>
          <th />
          <th>{match.away.name}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td>{cell({ side: stats.home, row })}</td>
            <th scope="row">{row.label}</th>
            <td>{cell({ side: stats.away, row })}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Lineup({ name, players }: { name: string; players: LineupPlayer[] }) {
  return (
    <table className="lineup">
      <caption>{name}</caption>
      <tbody>
        {players.map((p, i) => (
          <Fragment key={p.id}>
            {/* Starters (1–15), then the bench (16+), shown muted. */}
            {p.replacement && !players[i - 1]?.replacement && (
              <tr className="replacement">
                <th colSpan={2}>Replacements</th>
              </tr>
            )}
            <tr className={p.replacement ? "replacement" : undefined}>
              <td>{p.number}</td>
              <td className="team-col">
                {p.name}
                {p.captain && " (c)"}
              </td>
            </tr>
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

export function MatchPage() {
  const { id = "" } = useParams();
  const summary = useQuery({
    queryKey: ["match-summary", id],
    queryFn: () => fetchMatchSummary({ id }),
    staleTime: 10_000,
    refetchInterval: ({ state }) => refetchFor({ match: state.data?.match }),
  });
  const match = summary.data?.match;
  const stats = useQuery({
    queryKey: ["match-stats", id],
    queryFn: () => fetchMatchStats({ id }),
    enabled: match !== undefined && match.phase !== "scheduled",
    staleTime: 10_000,
    refetchInterval: match?.phase === "live" ? 3 * LIVE_REFETCH_MS : false,
  });

  // Block body: an effect's return value is treated as its cleanup function.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [id]);

  if (summary.error) {
    return (
      <main className="match">
        <p>
          <Link to="/">← All matches</Link>
        </p>
        <p className="error">Failed to load match: {summary.error.message}</p>
      </main>
    );
  }
  if (!summary.data || !match) {
    return (
      <main className="match">
        <p>Loading…</p>
      </main>
    );
  }

  const { incidents, lineups, officials } = summary.data;
  const showScore = match.phase === "live" || match.phase === "complete";
  const competitionLink = {
    pathname: `/competitions/${competitionKey({ label: match.competition })}`,
    search: match.competitionId ? `?season=${match.competitionId}` : "",
  };

  return (
    <main className="match">
      <p>
        <Link to="/">← All matches</Link>
      </p>
      <h1>
        {match.home.name} {showScore ? `${match.home.score} – ${match.away.score}` : "v"}{" "}
        {match.away.name}
      </h1>
      <p>
        <strong className={match.phase === "live" ? "live" : undefined}>
          {matchStatus({ match })}
        </strong>
        {" · "}
        <Link to={competitionLink}>{baseLabel({ label: match.competition })}</Link>
        {match.round && ` · ${match.round}`}
        {" · "}
        {match.kickoff.toLocaleString(undefined, {
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })}
        {match.venue && ` · ${match.venue}`}
      </p>

      <p className="follows">
        <FollowButton
          label="this match"
          targets={[
            { kind: "match", target: match.id, label: `${match.home.name} v ${match.away.name}` },
          ]}
        />{" "}
        {[match.home, match.away].map((team) => (
          <FollowButton
            key={team.id}
            label={team.name}
            targets={[{ kind: "team", target: team.id, label: team.name }]}
          />
        ))}{" "}
        <FollowButton
          label={baseLabel({ label: match.competition })}
          targets={[
            {
              kind: "competition",
              target: competitionKey({ label: match.competition }),
              label: baseLabel({ label: match.competition }),
            },
          ]}
        />
        <PushHint />
      </p>

      <h2>Scoring and cards</h2>
      {incidents.length === 0 ? (
        <p>{match.phase === "scheduled" ? "Not started." : "Nothing yet."}</p>
      ) : (
        <table className="incidents">
          <tbody>
            {incidents.map((incident, i) => (
              <tr key={i}>
                <td className="team home">{incident.team === "home" && describe({ incident })}</td>
                {/* Rugby convention: 02:56 is the 3rd minute. */}
                <td className="status">{Math.floor(incident.secs / 60) + 1}'</td>
                <td className="team">{incident.team === "away" && describe({ incident })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {stats.data && (
        <>
          <h2>Stats</h2>
          <StatsTable stats={stats.data} match={match} />
        </>
      )}
      {stats.error && <p className="error">Failed to load stats: {stats.error.message}</p>}

      <h2>Line-ups</h2>
      {lineups.home.length === 0 && lineups.away.length === 0 ? (
        <p>Not announced yet.</p>
      ) : (
        <div className="lineups">
          <Lineup name={match.home.name} players={lineups.home} />
          <Lineup name={match.away.name} players={lineups.away} />
        </div>
      )}

      {officials.length > 0 && (
        <>
          <h2>Officials</h2>
          <ul>
            {officials.map((o) => (
              <li key={`${o.position}-${o.name}`}>
                {o.position}: {o.name}
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
