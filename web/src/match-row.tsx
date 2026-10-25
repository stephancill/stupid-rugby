import { Link } from "react-router";
import type { Match } from "../../src/worldrugby.ts";
import { matchStatus } from "./format.ts";

export function MatchRow({ match }: { match: Match }) {
  const { home, away } = match;
  const showScore = match.phase === "complete" || match.phase === "live";
  return (
    <tr className={match.phase === "live" ? "live" : undefined}>
      <td className="status">{matchStatus({ match })}</td>
      <td className={`team home${match.winner === "home" ? " winner" : ""}`}>{home.name}</td>
      <td className="score">
        <Link to={`/matches/${match.id}`}>{showScore ? `${home.score} – ${away.score}` : "v"}</Link>
      </td>
      <td className={`team${match.winner === "away" ? " winner" : ""}`}>{away.name}</td>
      <td className="meta">{[match.round, match.venue].filter(Boolean).join(" · ")}</td>
    </tr>
  );
}
