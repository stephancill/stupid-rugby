import { parseArgs } from "node:util";
import { z } from "zod";
import { findCompetition, majorCompetitions } from "./competitions.ts";
import { createClient, liveStates, type Match, type TimelineEntry } from "./worldrugby.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const { fetchMatches, fetchTimeline } = createClient();

const optionsSchema = z.object({
  command: z.enum(["fixtures", "results", "live", "competitions"]),
  days: z.coerce.number().int().positive().max(365),
  comp: z.enum(majorCompetitions.map((c) => c.key) as [string, ...string[]]).optional(),
  all: z.boolean(),
  women: z.boolean(),
  json: z.boolean(),
  watch: z.boolean(),
  interval: z.coerce.number().int().min(10),
});

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    days: { type: "string", default: "7" },
    comp: { type: "string" },
    all: { type: "boolean", default: false },
    women: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    watch: { type: "boolean", default: false },
    interval: { type: "string", default: "30" },
  },
});

const options = optionsSchema.parse({ ...values, command: positionals[0] });
const sport = options.women ? "wru" : "mru";

function filterMatches({ matches }: { matches: Match[] }) {
  return matches.filter((m) => {
    const comp = findCompetition({ label: m.competition });
    if (options.comp) return comp?.key === options.comp;
    return options.all || comp !== null;
  });
}

function formatKickoff({ date }: { date: Date }) {
  return date.toLocaleString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatMatch({ match }: { match: Match }) {
  const { home, away } = match;
  switch (match.phase) {
    case "scheduled":
      return `${formatKickoff({ date: match.kickoff })}  ${home.name} v ${away.name}`;
    case "live":
      return `LIVE ${match.state} ${match.clock ?? ""}  ${home.name} ${home.score} - ${away.score} ${away.name}`;
    case "complete":
      return `FT  ${home.name} ${home.score} - ${away.score} ${away.name}`;
    default:
      return `${match.phase.toUpperCase()}  ${home.name} v ${away.name}`;
  }
}

function printGrouped({ matches }: { matches: Match[] }) {
  if (options.json) return console.log(JSON.stringify(matches, null, 2));
  if (matches.length === 0) return console.log("No matches.");
  const groups = Map.groupBy(matches, (m) => m.competition);
  for (const [competition, group] of groups) {
    console.log(`\n${competition}`);
    for (const match of group) {
      console.log(`  ${formatMatch({ match })}${match.round ? `  [${match.round}]` : ""}`);
    }
  }
}

function formatEvent({ entry, match }: { entry: TimelineEntry; match: Match }) {
  const team =
    entry.teamIndex === 0 ? match.home.name : entry.teamIndex === 1 ? match.away.name : "";
  return `${entry.time.label.padStart(6)}  ${entry.typeLabel}${entry.points ? ` (+${entry.points})` : ""}  ${team}`;
}

async function fetchLive() {
  const now = Date.now();
  const matches = await fetchMatches({
    from: new Date(now - DAY_MS),
    to: new Date(now + DAY_MS),
    states: liveStates,
    sport,
  });
  return filterMatches({ matches });
}

async function runLive() {
  // Timeline entries already printed per match, so watch mode only emits new ones.
  const seen = new Map<string, number>();
  do {
    const live = await fetchLive();
    if (!options.watch || live.length === 0) {
      console.log(`[${new Date().toISOString()}] ${live.length} live match(es)`);
    }
    for (const summary of live) {
      const { match, timeline } = await fetchTimeline({ matchId: summary.id });
      const scoring = timeline.filter((e) => e.points > 0 || e.typeLabel.endsWith("Card"));
      const printed = seen.get(match.id) ?? 0;
      if (options.json) {
        console.log(JSON.stringify({ match, timeline: scoring.slice(printed) }));
      } else if (printed === 0 || scoring.length > printed) {
        console.log(`\n${match.competition}\n  ${formatMatch({ match })}`);
        for (const entry of scoring.slice(printed))
          console.log(`    ${formatEvent({ entry, match })}`);
      }
      seen.set(match.id, scoring.length);
    }
    if (options.watch) await Bun.sleep(options.interval * 1000);
  } while (options.watch);
}

switch (options.command) {
  case "fixtures": {
    const now = Date.now();
    const matches = await fetchMatches({
      from: new Date(now),
      to: new Date(now + options.days * DAY_MS),
      states: ["U", "UP", ...liveStates],
      sport,
    });
    printGrouped({ matches: filterMatches({ matches }) });
    break;
  }
  case "results": {
    const now = Date.now();
    const matches = await fetchMatches({
      from: new Date(now - options.days * DAY_MS),
      to: new Date(now),
      states: ["C"],
      sport,
    });
    printGrouped({ matches: filterMatches({ matches }).reverse() });
    break;
  }
  case "live":
    await runLive();
    break;
  case "competitions":
    for (const c of majorCompetitions) console.log(`${c.key.padEnd(22)} ${c.label}`);
    break;
}
