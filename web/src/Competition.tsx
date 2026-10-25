import { parseAsString, useQueryState } from "nuqs";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { baseLabel, currentSeason, findCompetitionByKey } from "../../src/competitions.ts";
import type { Standings } from "../../src/standings.ts";
import { useSeason, useSeasons } from "./competition-data.ts";
import { FollowButton, PushHint } from "./FollowButton.tsx";
import { formatDay } from "./format.ts";
import { MatchRow } from "./match-row.tsx";
import { closestDay, dayKey } from "./matches.ts";

function StandingsTables({ standings }: { standings: Standings }) {
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
              return (
                <tr key={row.team}>
                  <td>{row.position}</td>
                  <td className="team-col">{row.team}</td>
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
      <p className="source">Standings: {standings.source}</p>
    </>
  );
}

export function CompetitionPage() {
  const { key = "" } = useParams();
  // Fixed at mount so render stays pure.
  const [now] = useState(() => new Date());
  const [seasonParam, setSeasonParam] = useQueryState("season", parseAsString);
  const competition = findCompetitionByKey({ key });
  const seasons = useSeasons({ key });
  const seasonId = seasonParam ?? currentSeason({ seasons: seasons.data ?? [], now })?.id ?? null;
  const detail = useSeason({ id: seasonId });
  const season = detail.data?.season;

  // Block body: an effect's return value is treated as its cleanup function.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [key]);

  // The linked season may be missing from the list (non-major competitions have no
  // season pattern), so make sure it is selectable.
  const options = useMemo(() => {
    const list = seasons.data ?? [];
    return season && !list.some((s) => s.id === season.id) ? [season, ...list] : list;
  }, [seasons.data, season]);

  const days = useMemo(
    () => Map.groupBy(detail.data?.matches ?? [], (m) => dayKey({ date: m.kickoff })),
    [detail.data],
  );
  const highlighted = closestDay({ days: [...days.keys()], now });

  const title = competition?.label ?? (season ? baseLabel({ label: season.label }) : key);

  return (
    <main className="competition">
      <p>
        <Link to="/">← All matches</Link>
      </p>
      <h1>{title}</h1>
      <p>
        <FollowButton
          label={`${title} (kick-off and full time)`}
          targets={[{ kind: "competition", target: key, label: title }]}
        />
        <PushHint />
      </p>
      {options.length > 0 && (
        <label>
          Season{" "}
          <select value={seasonId ?? ""} onChange={(e) => void setSeasonParam(e.target.value)}>
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {seasons.error && <p className="error">{seasons.error.message}</p>}
      {detail.error && <p className="error">{detail.error.message}</p>}
      {!competition && !seasonParam && (
        <p>Open this competition from a match on the timeline to see a season.</p>
      )}
      {competition && seasons.isSuccess && options.length === 0 && (
        <p>No seasons found in the last five years.</p>
      )}

      <h2>Standings</h2>
      {detail.isPending ? (
        <p>{seasonId && !detail.error ? "Loading…" : "—"}</p>
      ) : detail.data?.standings ? (
        <StandingsTables standings={detail.data.standings} />
      ) : (
        <p>No standings are available for this season.</p>
      )}

      <h2>Fixtures and results</h2>
      {detail.isLoading && <p>Loading…</p>}
      {[...days].map(([day, dayMatches]) => (
        <section key={day} className={day === highlighted ? "day highlighted" : "day"}>
          <h3>{formatDay({ key: day })}</h3>
          <table>
            <tbody>
              {dayMatches.map((match) => (
                <MatchRow key={match.id} match={match} />
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </main>
  );
}
