import { buildPushHTTPRequest } from "@pushforge/builder";
import { z } from "zod";
import { baseLabel } from "../../src/competitions.ts";
import type { Incident, Match } from "../../src/worldrugby.ts";

// Web Push notifications for followed teams, matches and competitions. The index detects
// events while saving matches (indexer.ts) and sends straight away from the alarm.

export const subscriptionSchema = z.object({
  // Push services are always HTTPS, and the push library refuses anything else.
  endpoint: z.url({ protocol: /^https$/ }),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

export type PushSubscriptionJson = z.infer<typeof subscriptionSchema>;

export const followKinds = ["team", "match", "competition"] as const;
export type FollowKind = (typeof followKinds)[number];

export type MatchEventKind = "kickoff" | "score" | "half-time" | "full-time";

// Competition followers only hear about kickoff and full time; team and match followers
// get everything.
export const competitionEvents: readonly MatchEventKind[] = ["kickoff", "full-time"];

// A late score alert is worse than none, so the push service drops undelivered ones.
const PUSH_TTL_SECONDS = 15 * 60;
// Workers allow 6 simultaneous outgoing connections.
const SEND_CONCURRENCY = 6;

export type PushPayload = { title: string; body: string; url: string; tag: string };

export function matchEvents({ before, after }: { before: Match; after: Match }): MatchEventKind[] {
  const events: MatchEventKind[] = [];
  if (before.phase === "scheduled" && after.phase === "live") events.push("kickoff");
  if (after.phase === "complete" && before.phase !== "complete") return [...events, "full-time"];
  if (after.phase !== "live") return events;
  if (after.home.score !== before.home.score || after.away.score !== before.away.score) {
    events.push("score");
  }
  if (after.state === "LHT" && before.state !== "LHT") events.push("half-time");
  return events;
}

const incidentPoints: Partial<Record<Incident["kind"], number>> = {
  try: 5,
  conversion: 2,
  penalty: 3,
  "drop-goal": 3,
};

const incidentLabels: Record<Incident["kind"], string> = {
  try: "Try",
  conversion: "Conversion",
  penalty: "Penalty",
  "drop-goal": "Drop goal",
  "yellow-card": "Yellow card",
  "red-card": "Red card",
};

// The scoring incidents behind a team's score change: its latest scores, walking back until
// they add up to the change (a try and conversion can land in one poll). Null when the
// summary doesn't account for the change yet.
export function scoringIncidents({
  incidents,
  team,
  points,
}: {
  incidents: Incident[];
  team: "home" | "away";
  points: number;
}): Incident[] | null {
  const found: Incident[] = [];
  let total = 0;
  for (const incident of incidents.toReversed()) {
    if (total >= points) break;
    if (incident.team !== team) continue;
    // A try with no scorer is a penalty try: 7 points, no conversion.
    const value =
      incident.kind === "try" && !incident.player ? 7 : (incidentPoints[incident.kind] ?? 0);
    if (value === 0) continue;
    found.unshift(incident);
    total += value;
  }
  return total === points ? found : null;
}

function describeIncident({ incident }: { incident: Incident }) {
  const minute = `${Math.floor(incident.secs / 60) + 1}'`;
  if (incident.kind === "try" && !incident.player) return `Penalty try ${minute}`;
  return `${incidentLabels[incident.kind]} – ${incident.player ?? "unknown"} ${minute}`;
}

export function payloadFor({
  kind,
  before,
  match,
  scorers,
}: {
  kind: MatchEventKind;
  // The match before this change, for score events.
  before?: Match;
  match: Match;
  // For score events: each scoring team's incidents, or null when unknown.
  scorers?: { team: "home" | "away"; incidents: Incident[] | null }[];
}): PushPayload {
  const { home, away } = match;
  const score = `${home.name} ${home.score}–${away.score} ${away.name}`;
  const competition = baseLabel({ label: match.competition });
  const base = { url: `/matches/${match.id}`, tag: match.id };
  switch (kind) {
    case "kickoff":
      return {
        ...base,
        title: "Match Started",
        body: `${home.name} v ${away.name} · ${competition}`,
      };
    case "half-time":
      return { ...base, title: score, body: "Half-time" };
    case "full-time": {
      const result =
        match.winner === "draw"
          ? "Draw"
          : match.winner
            ? `${match[match.winner].name} win`
            : "Result";
      return { ...base, title: score, body: `Full time · ${result} · ${competition}` };
    }
    case "score": {
      const lines = (scorers ?? []).map(({ team, incidents }) =>
        incidents
          ? incidents.map((incident) => describeIncident({ incident })).join(", ")
          : `${match[team].name} score`,
      );
      // World Rugby sometimes takes points back (a mistaken entry, or a try overturned).
      const corrected =
        before &&
        (["home", "away"] as const).some((team) => match[team].score < before[team].score);
      if (corrected) lines.push("Score corrected");
      return { ...base, title: score, body: lines.join(" · ") || "Score update" };
    }
  }
}

// Push services return 404/410 for subscriptions that are gone for good.
export type SendResult = { endpoint: string; status: number; gone: boolean };

export async function sendPushes({
  subscriptions,
  payload,
  privateJWK,
  subject,
}: {
  subscriptions: PushSubscriptionJson[];
  payload: PushPayload;
  privateJWK: string;
  subject: string;
}): Promise<SendResult[]> {
  const results: SendResult[] = [];
  const queue = [...subscriptions];
  async function worker() {
    for (let subscription = queue.shift(); subscription; subscription = queue.shift()) {
      const request = await buildPushHTTPRequest({
        privateJWK,
        subscription,
        message: {
          payload,
          adminContact: subject,
          // One topic per match: a newer update replaces one still waiting for delivery.
          // Topics are limited to 32 URL-safe characters.
          options: {
            urgency: "high",
            ttl: PUSH_TTL_SECONDS,
            topic: payload.tag.replaceAll("-", "").slice(0, 32),
          },
        },
      });
      const res = await fetch(request.endpoint, {
        method: "POST",
        headers: request.headers,
        body: request.body,
      });
      if (!res.ok) {
        console.warn(
          `Push ${res.status} ${new URL(subscription.endpoint).host}: ${await res.text()}`,
        );
      }
      results.push({
        endpoint: subscription.endpoint,
        status: res.status,
        gone: res.status === 404 || res.status === 410,
      });
    }
  }
  await Promise.all(Array.from({ length: SEND_CONCURRENCY }, worker));
  return results;
}
