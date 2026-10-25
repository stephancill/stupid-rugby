// GET /api: a self-describing index of the public API, so agents can discover it from the
// base URL. The full guide (data model, notifications for agents) is the skill in
// skills/stupid-rugby/SKILL.md.

// Raw markdown, so agents get the text rather than GitHub's HTML page.
const SKILL_URL =
  "https://raw.githubusercontent.com/stephancill/stupid-rugby/main/skills/stupid-rugby/SKILL.md";

export function apiIndex({ origin }: { origin: string }) {
  const api = `${origin}/api`;
  return {
    name: "Stupid Rugby API",
    description:
      "Rugby union (men's) fixtures, results, live scores, standings and match details for major competitions, from an index refreshed every 10s while matches are live. Free, no auth, CORS open for GET.",
    guide: SKILL_URL,
    notes: [
      "Dates are UTC (YYYY-MM-DD); times are ISO 8601 UTC.",
      "The index covers 5 years back to 1 year ahead (see /api/status window); other ranges return 400.",
      "503 means the index is warming up (first backfill); retry later.",
      "Match phase: scheduled | live | complete | postponed | cancelled.",
      "competitionId on a match is the season id for /api/seasons/{id}.",
    ],
    endpoints: [
      { method: "GET", path: "/api/status", description: "Index readiness and window." },
      {
        method: "GET",
        path: "/api/competitions",
        description: "Major competitions: key and name.",
      },
      {
        method: "GET",
        path: "/api/teams?q={name}",
        description: "Find team ids by name (case-insensitive substring, 2+ chars).",
        example: `${api}/teams?q=leinster`,
      },
      {
        method: "GET",
        path: "/api/matches?from={date}&to={date}[&teams={id,id}]",
        description:
          "Matches kicking off in [from, to), every competition, optionally only those involving the given team ids.",
        example: `${api}/matches?from=2026-10-19&to=2026-10-26`,
      },
      { method: "GET", path: "/api/matches/live", description: "Matches in progress now." },
      { method: "GET", path: "/api/matches/{id}", description: "One match." },
      {
        method: "GET",
        path: "/api/matches/{id}/summary",
        description: "Line-ups, scorers, cards and officials, with the freshest match clock.",
      },
      { method: "GET", path: "/api/matches/{id}/stats", description: "Team stats." },
      {
        method: "GET",
        path: "/api/seasons",
        description: "Every indexed season (competition season) with id, label and dates.",
      },
      {
        method: "GET",
        path: "/api/seasons/{id}",
        description: "A season's matches and standings (null when none are published).",
      },
      {
        method: "GET (WebSocket)",
        path: "/api/live",
        description:
          'Live updates: {"type":"matches","matches":[...]} for every changed match near now.',
      },
      {
        method: "POST",
        path: "/api/push/*",
        description:
          "Web Push notifications for followed teams, matches and competitions. Agents can subscribe with their own HTTPS webhook; see the guide.",
      },
    ],
  };
}
