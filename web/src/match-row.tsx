import { Link, useNavigate } from "react-router";
import type { Match } from "../../src/worldrugby.ts";
import { matchStatus } from "./format.ts";

// The whole row opens the match. The score stays a real link, for keyboard focus, middle
// click and "open in new tab".
export function MatchRow({ match }: { match: Match }) {
  const navigate = useNavigate();
  const { home, away } = match;
  const showScore = match.phase === "complete" || match.phase === "live";
  const url = `/matches/${match.id}`;
  return (
    <tr
      className={match.phase === "live" ? "match live" : "match"}
      onClick={(event) => {
        // The link handles its own clicks; don't hijack text selection either.
        if ((event.target as HTMLElement).closest("a")) return;
        if (window.getSelection()?.toString()) return;
        if (event.metaKey || event.ctrlKey) window.open(url, "_blank");
        else void navigate(url);
      }}
    >
      <td className="status">{matchStatus({ match })}</td>
      <td className={`team home${match.winner === "home" ? " winner" : ""}`}>{home.name}</td>
      <td className="score">
        <Link to={url}>{showScore ? `${home.score} – ${away.score}` : "v"}</Link>
      </td>
      <td className={`team${match.winner === "away" ? " winner" : ""}`}>{away.name}</td>
      <td className="meta">{[match.round, match.venue].filter(Boolean).join(" · ")}</td>
    </tr>
  );
}
