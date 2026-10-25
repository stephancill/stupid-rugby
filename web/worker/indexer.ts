import { DurableObject } from "cloudflare:workers";
import { competitionKey, majorCompetitions } from "../../src/competitions.ts";
import { createEspnClient } from "../../src/espn.ts";
import { isRateLimited } from "../../src/http.ts";
import { withPeriodStart } from "../../src/match-clock.ts";
import type { Standings } from "../../src/standings.ts";
import {
  createClient,
  type Incident,
  type Match,
  type Season,
  UPSTREAM_URL,
} from "../../src/worldrugby.ts";
import {
  competitionEvents,
  type FollowKind,
  matchEvents,
  type MatchEventKind,
  payloadFor,
  type PushSubscriptionJson,
  scoringIncidents,
  sendPushes,
} from "./notify.ts";

// The index: one Durable Object that polls World Rugby (and ESPN for standings) on its own
// alarm, stores matches, seasons and standings in its SQLite storage, and pushes live score
// changes to browsers over hibernatable WebSockets. See docs/implementation-notes.md.
//
// Scheduling, in one alarm:
// - Live: from 15 min before a kickoff until every started match is complete (or 4h after
//   kickoff), poll the matches' days every LIVE_POLL_MS.
// - Jobs: a queue of upstream fetches (backfill weeks, schedule syncs, standings, rechecks
//   after full time), run one at a time at most every JOB_GAP_MS so upstream sees no bursts.
// - Otherwise sleep until the next kickoff window or the next due job.

export type Env = {
  INDEXER: DurableObjectNamespace<Indexer>;
  UPSTREAM_URL?: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_SUBJECT: string;
  // JWK; a secret.
  VAPID_PRIVATE_KEY: string;
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const LIVE_POLL_MS = 10 * SECOND;
const JOB_GAP_MS = 5 * SECOND;
const PRE_KICKOFF_MS = 15 * MINUTE;
// A match still not marked complete this long after kickoff stops being polled live.
const MAX_MATCH_MS = 4 * HOUR;
const BACKFILL_MS = 5 * 365 * DAY;
const LOOKAHEAD_MS = 365 * DAY;
const NEAR_SYNC = { back: 2 * DAY, ahead: 14 * DAY };
const MIN_COOLDOWN_MS = 2 * MINUTE;
const MAX_COOLDOWN_MS = 30 * MINUTE;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only changes to matches this close to now are pushed, so backfill doesn't flood browsers.
const PUSH_WITHIN_MS = 2 * DAY;
// Only changes to matches this close to now trigger notifications, so syncs that correct
// old matches don't.
const NOTIFY_WITHIN_MS = 6 * HOUR;

type Job =
  // A UTC week (Monday start): fetches it with a day either side and deletes matches in the
  // week that upstream no longer lists.
  | { kind: "week"; start: number }
  // Re-fetch a UTC day without deleting, 10 min and 1h after full time.
  | { kind: "recheck"; day: number; late: boolean }
  | { kind: "seasons" }
  | { kind: "standings"; seasonId: string }
  // Recurring: queue the weeks around now (15 min on match days, else hourly).
  | { kind: "sync-near" }
  // Recurring daily: queue every future week in the window, and current seasons' standings.
  | { kind: "sync-far" };

export type IndexWindow = { from: number; to: number };

type MatchChange = { before: Match | null; after: Match };

export type IndexStatus = {
  ready: boolean;
  window: IndexWindow;
  lastKickoff: number | null;
  backlog: number;
  cooldownUntil: number | null;
  lastError: string | null;
};

// Reads return a ready-to-send response body, so the worker can cache it as is.
export type ReadResult = { status: number; body: string };

export type SeasonDetail = {
  season: Season;
  matches: Match[];
  // null: no standings exist for this season (or competition).
  standings: Standings | null;
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    season_id TEXT,
    kickoff INTEGER NOT NULL,
    phase TEXT NOT NULL,
    home_id TEXT NOT NULL,
    away_id TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS matches_kickoff ON matches (kickoff);
  CREATE INDEX IF NOT EXISTS matches_season ON matches (season_id, kickoff);
  CREATE TABLE IF NOT EXISTS seasons (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS standings (
    season_id TEXT PRIMARY KEY,
    json TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    key TEXT PRIMARY KEY,
    due_at INTEGER NOT NULL,
    job TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS follows (
    endpoint TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    label TEXT NOT NULL,
    PRIMARY KEY (endpoint, kind, target)
  );
  CREATE INDEX IF NOT EXISTS follows_target ON follows (kind, target);
`;

// Weeks are UTC Mondays, like the client's.
export function startOfWeek({ time }: { time: number }) {
  const date = new Date(time);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.getTime();
}

export function indexWindow({ now }: { now: number }): IndexWindow {
  return {
    from: startOfWeek({ time: now - BACKFILL_MS }),
    to: startOfWeek({ time: now + LOOKAHEAD_MS }) + WEEK,
  };
}

function jobKey({ job }: { job: Job }) {
  switch (job.kind) {
    case "week":
      return `week:${new Date(job.start).toISOString().slice(0, 10)}`;
    case "recheck":
      return `recheck:${new Date(job.day).toISOString().slice(0, 10)}:${job.late ? "late" : "early"}`;
    case "standings":
      return `standings:${job.seasonId}`;
    default:
      return job.kind;
  }
}

function majorForSeason({ label }: { label: string }) {
  return majorCompetitions.find((c) => c.seasons.test(label)) ?? null;
}

function toMatch({ json }: { json: string }): Match {
  const raw = JSON.parse(json) as Match & { kickoff: string; periodStart?: string | null };
  return {
    ...raw,
    kickoff: new Date(raw.kickoff),
    periodStart: raw.periodStart ? new Date(raw.periodStart) : null,
  };
}

export class Indexer extends DurableObject<Env> {
  sql = this.ctx.storage.sql;
  worldRugby = createClient({ baseUrl: this.env.UPSTREAM_URL ?? UPSTREAM_URL });
  espn = createEspnClient();
  // In memory: after an eviction the next alarm simply polls straight away.
  lastLivePoll = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA);
      // Keep-alive pings are answered without waking the object.
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now());
    });
  }

  // --- state ----------------------------------------------------------------------------

  getState({ key }: { key: string }) {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM state WHERE key = ?", key);
    return row.toArray()[0]?.value ?? null;
  }

  setState({ key, value }: { key: string; value: string | null }) {
    if (value === null) this.sql.exec("DELETE FROM state WHERE key = ?", key);
    else this.sql.exec("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)", key, value);
  }

  recordError({ message }: { message: string }) {
    this.setState({ key: "last_error", value: `${new Date().toISOString()} ${message}` });
  }

  enqueue({ job, dueAt }: { job: Job; dueAt: number }) {
    // An already-queued job keeps the earlier due time.
    this.sql.exec(
      `INSERT INTO jobs (key, due_at, job) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET due_at = excluded.due_at
       WHERE excluded.due_at < jobs.due_at`,
      jobKey({ job }),
      dueAt,
      JSON.stringify(job),
    );
  }

  // --- writes ---------------------------------------------------------------------------

  // Upserts matches, rewriting only rows whose content changed. Returns the changes, with
  // the previous version (null for a match seen for the first time).
  saveMatches({ matches }: { matches: Match[] }) {
    const changes: MatchChange[] = [];
    const now = new Date();
    for (const upstream of matches) {
      const before = this.sql
        .exec<{ json: string }>("SELECT json FROM matches WHERE id = ?", upstream.id)
        .toArray()[0]?.json;
      const match = withPeriodStart({
        match: upstream,
        before: before ? toMatch({ json: before }) : null,
        now,
      });
      const json = JSON.stringify(match);
      if (before === json) continue;
      this.sql.exec(
        `INSERT OR REPLACE INTO matches (id, season_id, kickoff, phase, home_id, away_id, json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        match.id,
        match.competitionId,
        match.kickoff.getTime(),
        match.phase,
        match.home.id,
        match.away.id,
        json,
      );
      changes.push({ before: before ? toMatch({ json: before }) : null, after: match });
    }
    return changes;
  }

  async afterSave(changes: MatchChange[]) {
    const now = Date.now();
    for (const { before, after: match } of changes) {
      if (match.phase !== "complete" || !before || before.phase === "complete") continue;
      // Scores are sometimes corrected after full time, and standings update with a lag.
      const day = Date.UTC(
        match.kickoff.getUTCFullYear(),
        match.kickoff.getUTCMonth(),
        match.kickoff.getUTCDate(),
      );
      this.enqueue({ job: { kind: "recheck", day, late: false }, dueAt: now + 10 * MINUTE });
      this.enqueue({ job: { kind: "recheck", day, late: true }, dueAt: now + HOUR });
      if (match.competitionId) {
        this.enqueue({
          job: { kind: "standings", seasonId: match.competitionId },
          dueAt: now + 10 * MINUTE,
        });
      }
    }
    const recent = changes
      .map((c) => c.after)
      .filter((m) => Math.abs(m.kickoff.getTime() - now) < PUSH_WITHIN_MS);
    if (recent.length > 0) this.broadcast({ matches: recent });
    await this.notify({ changes });
  }

  // --- notifications ----------------------------------------------------------------------

  async notify({ changes }: { changes: MatchChange[] }) {
    const now = Date.now();
    for (const { before, after } of changes) {
      if (!before || Math.abs(after.kickoff.getTime() - now) > NOTIFY_WITHIN_MS) continue;
      for (const kind of matchEvents({ before, after })) {
        try {
          await this.notifyEvent({ kind, before, after });
        } catch (error) {
          console.error(`Notification ${kind} ${after.id} failed`, error);
          this.recordError({ message: `notify ${kind} ${after.id}: ${(error as Error).message}` });
        }
      }
    }
  }

  async notifyEvent({
    kind,
    before,
    after,
  }: {
    kind: MatchEventKind;
    before: Match;
    after: Match;
  }) {
    const subscriptions = this.sql
      .exec<{ json: string }>(
        `SELECT DISTINCT s.json FROM follows f
         JOIN push_subscriptions s ON s.endpoint = f.endpoint
         WHERE (f.kind = 'team' AND f.target IN (?1, ?2))
            OR (f.kind = 'match' AND f.target = ?3)
            OR (?5 AND f.kind = 'competition' AND f.target = ?4)`,
        after.home.id,
        after.away.id,
        after.id,
        competitionKey({ label: after.competition }),
        competitionEvents.includes(kind) ? 1 : 0,
      )
      .toArray()
      .map((r) => JSON.parse(r.json) as PushSubscriptionJson);
    if (subscriptions.length === 0) return;

    const scorers = kind === "score" ? await this.scorers({ before, after }) : undefined;
    const results = await sendPushes({
      subscriptions,
      payload: payloadFor({ kind, before, match: after, scorers }),
      privateJWK: this.env.VAPID_PRIVATE_KEY,
      subject: this.env.VAPID_SUBJECT,
    });
    for (const { endpoint, gone } of results) {
      if (gone) this.deleteSubscription({ endpoint });
    }
    const failed = results.filter((r) => r.status >= 300 && !r.gone).length;
    const scores = (m: Match) => `${m.home.score}-${m.away.score}`;
    console.log(
      `Notified ${kind} ${after.id} (${scores(before)} -> ${scores(after)}, ${after.state} ${after.clock ?? ""}): ${results.length} sent, ${failed} failed`,
    );
    if (failed > 0) {
      this.recordError({ message: `notify ${kind} ${after.id}: ${failed} pushes failed` });
    }
  }

  // Who scored, from the match summary (one upstream call per score change). Teams whose
  // scoring the summary doesn't account for yet are named without a scorer.
  async scorers({ before, after }: { before: Match; after: Match }) {
    const changed = (["home", "away"] as const)
      .map((team) => ({ team, points: after[team].score - before[team].score }))
      .filter((t) => t.points > 0);
    let incidents: Incident[] | null = null;
    try {
      ({ incidents } = await this.upstream({
        label: `summary ${after.id}`,
        call: () => this.worldRugby.fetchSummary({ matchId: after.id }),
      }));
    } catch (error) {
      // The notification still goes out, naming only the team; the failure is surfaced.
      console.error(`Summary for scorers failed ${after.id}`, error);
      this.recordError({
        message: `scorers ${after.id}: ${(error as Error).message}`.slice(0, 500),
      });
    }
    return changed.map(({ team, points }) => ({
      team,
      incidents: incidents && scoringIncidents({ incidents, team, points }),
    }));
  }

  // --- push subscriptions (RPC from the worker) -----------------------------------------

  deleteSubscription({ endpoint }: { endpoint: string }) {
    this.sql.exec("DELETE FROM follows WHERE endpoint = ?", endpoint);
    this.sql.exec("DELETE FROM push_subscriptions WHERE endpoint = ?", endpoint);
  }

  // Also moves follows over from `previousEndpoint` when the browser rotated the
  // subscription (pushsubscriptionchange).
  savePushSubscription({
    subscription,
    previousEndpoint,
  }: {
    subscription: PushSubscriptionJson;
    previousEndpoint?: string;
  }): ReadResult {
    this.sql.exec(
      `INSERT INTO push_subscriptions (endpoint, json, created_at) VALUES (?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET json = excluded.json`,
      subscription.endpoint,
      JSON.stringify(subscription),
      Date.now(),
    );
    if (previousEndpoint && previousEndpoint !== subscription.endpoint) {
      this.sql.exec(
        "UPDATE OR IGNORE follows SET endpoint = ? WHERE endpoint = ?",
        subscription.endpoint,
        previousEndpoint,
      );
      this.deleteSubscription({ endpoint: previousEndpoint });
    }
    return this.follows({ endpoint: subscription.endpoint });
  }

  deletePushSubscription({ endpoint }: { endpoint: string }): ReadResult {
    this.deleteSubscription({ endpoint });
    return { status: 200, body: JSON.stringify({ follows: [] }) };
  }

  // 404 for an unknown endpoint, so the client knows to subscribe again.
  follows({ endpoint }: { endpoint: string }): ReadResult {
    const known = this.sql
      .exec("SELECT 1 FROM push_subscriptions WHERE endpoint = ?", endpoint)
      .toArray().length;
    if (!known) {
      return { status: 404, body: JSON.stringify({ error: "Unknown push subscription." }) };
    }
    const follows = this.sql
      .exec<{ kind: FollowKind; target: string; label: string }>(
        "SELECT kind, target, label FROM follows WHERE endpoint = ? ORDER BY kind, label",
        endpoint,
      )
      .toArray();
    return { status: 200, body: JSON.stringify({ follows }) };
  }

  setFollow({
    endpoint,
    kind,
    target,
    label,
    follow,
  }: {
    endpoint: string;
    kind: FollowKind;
    target: string;
    label: string;
    follow: boolean;
  }): ReadResult {
    const current = this.follows({ endpoint });
    if (current.status !== 200) return current;
    if (follow) {
      this.sql.exec(
        "INSERT OR REPLACE INTO follows (endpoint, kind, target, label) VALUES (?, ?, ?, ?)",
        endpoint,
        kind,
        target,
        label,
      );
    } else {
      this.sql.exec(
        "DELETE FROM follows WHERE endpoint = ? AND kind = ? AND target = ?",
        endpoint,
        kind,
        target,
      );
    }
    return this.follows({ endpoint });
  }

  broadcast({ matches }: { matches: Match[] }) {
    const message = JSON.stringify({ type: "matches", matches });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch (error) {
        console.warn("WebSocket send failed", error);
      }
    }
  }

  // --- upstream -------------------------------------------------------------------------

  cooldownUntil() {
    return Number(this.getState({ key: "cooldown_until" }) ?? 0);
  }

  // Runs an upstream call, tracking rate limiting: a 429 starts a cooldown (doubling up to
  // MAX_COOLDOWN_MS) during which nothing calls upstream, since calls made while blocked can
  // extend the block.
  async upstream<T>({ label, call }: { label: string; call: () => Promise<T> }): Promise<T> {
    const started = Date.now();
    try {
      const result = await call();
      console.log(`${label} ok ${Date.now() - started}ms`);
      if (this.getState({ key: "cooldown_ms" })) this.setState({ key: "cooldown_ms", value: null });
      return result;
    } catch (error) {
      if (isRateLimited({ error })) {
        const previous = Number(this.getState({ key: "cooldown_ms" }) ?? 0);
        const ms = Math.min(Math.max(previous * 2, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS);
        this.setState({ key: "cooldown_ms", value: String(ms) });
        this.setState({ key: "cooldown_until", value: String(Date.now() + ms) });
        console.warn(`${label} rate limited; cooling down for ${ms / SECOND}s`);
      }
      throw error;
    }
  }

  // Matches that are live or about to be: kicked off (or kicking off within PRE_KICKOFF_MS)
  // and not finished.
  activeMatches({ now }: { now: number }) {
    return this.sql
      .exec<{ kickoff: number }>(
        `SELECT kickoff FROM matches
         WHERE kickoff BETWEEN ? AND ? AND phase IN ('scheduled', 'live')`,
        now - MAX_MATCH_MS,
        now + PRE_KICKOFF_MS,
      )
      .toArray();
  }

  async pollLive({ active }: { active: { kickoff: number }[] }) {
    const kickoffs = active.map((m) => m.kickoff);
    const matches = await this.upstream({
      label: "live",
      call: () =>
        this.worldRugby.fetchMatches({
          from: new Date(Math.min(...kickoffs)),
          // Upstream rejects a range starting and ending on the same date.
          to: new Date(Math.max(...kickoffs) + DAY),
        }),
    });
    await this.afterSave(this.saveMatches({ matches }));
  }

  async runJob({ job }: { job: Job }) {
    const now = Date.now();
    switch (job.kind) {
      case "week": {
        const from = job.start - DAY;
        const to = job.start + WEEK;
        const matches = await this.upstream({
          label: `week ${new Date(job.start).toISOString().slice(0, 10)}`,
          call: () => this.worldRugby.fetchMatches({ from: new Date(from), to: new Date(to) }),
        });
        await this.afterSave(this.saveMatches({ matches }));
        // Fixtures dropped upstream. Only within the week proper: the extra day either
        // side guards against date-boundary differences in how upstream filters.
        const ids = matches.map((m) => m.id);
        this.sql.exec(
          `DELETE FROM matches WHERE kickoff >= ? AND kickoff < ?
           AND id NOT IN (SELECT value FROM json_each(?))`,
          job.start,
          job.start + WEEK,
          JSON.stringify(ids),
        );
        return;
      }
      case "recheck": {
        const matches = await this.upstream({
          label: "recheck",
          call: () =>
            this.worldRugby.fetchMatches({ from: new Date(job.day), to: new Date(job.day + DAY) }),
        });
        await this.afterSave(this.saveMatches({ matches }));
        return;
      }
      case "seasons": {
        const { from, to } = indexWindow({ now });
        // Upstream filters seasons by start date; a season starting up to a year before the
        // window can still have matches in it.
        const seasons = await this.upstream({
          label: "seasons",
          call: () =>
            this.worldRugby.fetchEvents({ from: new Date(from - LOOKAHEAD_MS), to: new Date(to) }),
        });
        for (const s of seasons) {
          this.sql.exec(
            "INSERT OR REPLACE INTO seasons (id, label, start, end) VALUES (?, ?, ?, ?)",
            s.id,
            s.label,
            s.start.getTime(),
            s.end.getTime(),
          );
          // Standings for major competitions' seasons that have none yet (past seasons'
          // tables are fetched once; current ones are refreshed by sync-far and full time).
          const fetched = this.sql
            .exec("SELECT 1 FROM standings WHERE season_id = ?", s.id)
            .toArray().length;
          if (!fetched && majorForSeason({ label: s.label }) && s.start.getTime() <= now) {
            this.enqueue({ job: { kind: "standings", seasonId: s.id }, dueAt: now });
          }
        }
        this.enqueue({ job, dueAt: now + DAY });
        return;
      }
      case "standings": {
        const season = this.sql
          .exec<{ label: string; end: number }>(
            "SELECT label, end FROM seasons WHERE id = ?",
            job.seasonId,
          )
          .toArray()[0];
        const major = season && majorForSeason({ label: season.label });
        if (!season || !major) return;
        // Seasons before about 2023 have numeric ids, which the standings endpoint rejects;
        // World Rugby has no tables for them anyway.
        const own = UUID.test(job.seasonId)
          ? await this.upstream({
              label: `standings ${season.label} (World Rugby)`,
              call: () => this.worldRugby.fetchStandings({ eventId: job.seasonId }),
            })
          : null;
        // ESPN numbers seasons by the year they end.
        const standings =
          own ??
          ("espnId" in major
            ? await this.upstream({
                label: `standings ${season.label} (ESPN)`,
                call: () =>
                  this.espn.fetchStandings({
                    leagueId: major.espnId,
                    season: new Date(season.end).getUTCFullYear(),
                  }),
              })
            : null);
        this.sql.exec(
          "INSERT OR REPLACE INTO standings (season_id, json, updated_at) VALUES (?, ?, ?)",
          job.seasonId,
          standings && JSON.stringify(standings),
          now,
        );
        return;
      }
      case "sync-near": {
        for (
          let start = startOfWeek({ time: now - NEAR_SYNC.back });
          start < now + NEAR_SYNC.ahead;
          start += WEEK
        ) {
          this.enqueue({ job: { kind: "week", start }, dueAt: now });
        }
        const matchDay =
          this.sql
            .exec(
              "SELECT 1 FROM matches WHERE kickoff BETWEEN ? AND ? LIMIT 1",
              now,
              now + 12 * HOUR,
            )
            .toArray().length > 0;
        this.enqueue({ job, dueAt: now + (matchDay ? 15 * MINUTE : HOUR) });
        return;
      }
      case "sync-far": {
        const { to } = indexWindow({ now });
        for (let start = startOfWeek({ time: now + NEAR_SYNC.ahead }); start < to; start += WEEK) {
          this.enqueue({ job: { kind: "week", start }, dueAt: now });
        }
        const current = this.sql
          .exec<{ id: string; label: string }>(
            "SELECT id, label FROM seasons WHERE start <= ? AND end >= ?",
            now,
            now - WEEK,
          )
          .toArray();
        for (const s of current) {
          if (majorForSeason({ label: s.label })) {
            this.enqueue({ job: { kind: "standings", seasonId: s.id }, dueAt: now });
          }
        }
        this.enqueue({ job, dueAt: now + DAY });
        return;
      }
    }
  }

  // First run: queue the whole window, oldest last so the weeks people look at fill first.
  bootstrap({ now }: { now: number }) {
    const { from, to } = indexWindow({ now });
    this.enqueue({ job: { kind: "seasons" }, dueAt: now });
    const thisWeek = startOfWeek({ time: now });
    for (let start = from; start < to; start += WEEK) {
      this.enqueue({
        job: { kind: "week", start },
        dueAt: now + Math.abs(start - thisWeek) / WEEK,
      });
    }
    this.enqueue({ job: { kind: "sync-near" }, dueAt: now + HOUR });
    this.enqueue({ job: { kind: "sync-far" }, dueAt: now + DAY });
    this.setState({ key: "bootstrapped", value: String(now) });
  }

  async runDueJob({ now }: { now: number }) {
    const row = this.sql
      .exec<{ key: string; job: string; attempts: number }>(
        "SELECT key, job, attempts FROM jobs WHERE due_at <= ? ORDER BY due_at LIMIT 1",
        now,
      )
      .toArray()[0];
    if (!row) return;
    const job = JSON.parse(row.job) as Job;
    try {
      // Recurring jobs re-enqueue themselves under the same key, so delete first.
      this.sql.exec("DELETE FROM jobs WHERE key = ?", row.key);
      await this.runJob({ job });
    } catch (error) {
      const message = `${row.key}: ${(error as Error).message}`.slice(0, 500);
      console.error(`Job failed ${message}`);
      const attempts = isRateLimited({ error }) ? row.attempts : row.attempts + 1;
      if (!isRateLimited({ error })) this.recordError({ message });
      this.sql.exec(
        "INSERT OR REPLACE INTO jobs (key, due_at, job, attempts) VALUES (?, ?, ?, ?)",
        row.key,
        Math.max(Date.now() + Math.min(2 ** attempts * MINUTE, HOUR), this.cooldownUntil()),
        row.job,
        attempts,
      );
    }
  }

  async alarm() {
    const now = Date.now();
    try {
      if (!this.getState({ key: "bootstrapped" })) this.bootstrap({ now });
      if (this.cooldownUntil() <= now) {
        const active = this.activeMatches({ now });
        // Job ticks come every JOB_GAP_MS; live polls stay at LIVE_POLL_MS.
        if (active.length > 0 && now - this.lastLivePoll >= LIVE_POLL_MS - JOB_GAP_MS / 2) {
          this.lastLivePoll = now;
          try {
            await this.pollLive({ active });
          } catch (error) {
            // Retried on the next tick; surfaced through status().
            console.error("Live poll failed", error);
            if (!isRateLimited({ error })) {
              this.recordError({ message: `live: ${(error as Error).message}`.slice(0, 500) });
            }
          }
        }
        if (this.cooldownUntil() <= Date.now()) await this.runDueJob({ now });
      }
      if (!this.getState({ key: "ready" }) && this.countDueJobs({ now: Date.now() }) === 0) {
        this.setState({ key: "ready", value: String(Date.now()) });
      }
    } finally {
      // Always reschedule: an alarm that throws is retried only a few times, then dropped.
      await this.ctx.storage.setAlarm(this.nextWake());
    }
  }

  countDueJobs({ now }: { now: number }) {
    return this.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE due_at <= ?", now)
      .one().n;
  }

  nextWake() {
    const now = Date.now();
    const notBefore = Math.max(now + JOB_GAP_MS, this.cooldownUntil());
    const candidates: number[] = [];
    if (this.activeMatches({ now }).length > 0) candidates.push(now + LIVE_POLL_MS);
    const nextKickoff = this.sql
      .exec<{ t: number | null }>(
        "SELECT min(kickoff) AS t FROM matches WHERE kickoff > ? AND phase = 'scheduled'",
        now,
      )
      .one().t;
    if (nextKickoff !== null) candidates.push(nextKickoff - PRE_KICKOFF_MS);
    const nextJob = this.sql
      .exec<{ t: number | null }>("SELECT min(due_at) AS t FROM jobs")
      .one().t;
    if (nextJob !== null) candidates.push(nextJob);
    return Math.max(notBefore, Math.min(...candidates, now + DAY));
  }

  // --- reads (RPC from the worker) ------------------------------------------------------

  status(): IndexStatus {
    const now = Date.now();
    const cooldownUntil = this.cooldownUntil();
    return {
      ready: this.getState({ key: "ready" }) !== null,
      window: indexWindow({ now }),
      lastKickoff: this.sql
        .exec<{ t: number | null }>("SELECT max(kickoff) AS t FROM matches")
        .one().t,
      backlog: this.countDueJobs({ now }),
      cooldownUntil: cooldownUntil > now ? cooldownUntil : null,
      lastError: this.getState({ key: "last_error" }),
    };
  }

  // Fails loudly rather than returning partial data: 503 while the first backfill runs,
  // 400 for ranges outside the window.
  unavailable({ from, to }: { from?: number; to?: number } = {}): ReadResult | null {
    const status = this.status();
    if (!status.ready) {
      const error = `Index is warming up (${status.backlog} jobs left). Try again shortly.`;
      return { status: 503, body: JSON.stringify({ error }) };
    }
    const { window } = status;
    if ((from !== undefined && from < window.from) || (to !== undefined && to > window.to)) {
      const range = [window.from, window.to].map((t) => new Date(t).toISOString().slice(0, 10));
      const error = `Outside the indexed window (${range.join(" to ")}).`;
      return { status: 400, body: JSON.stringify({ error }) };
    }
    return null;
  }

  matches({ from, to, teams }: { from: number; to: number; teams: string[] }): ReadResult {
    const unavailable = this.unavailable({ from, to });
    if (unavailable) return unavailable;
    const rows = teams.length
      ? this.sql.exec<{ json: string }>(
          `SELECT json FROM matches WHERE kickoff >= ?1 AND kickoff < ?2
           AND (home_id IN (SELECT value FROM json_each(?3)) OR away_id IN (SELECT value FROM json_each(?3)))
           ORDER BY kickoff`,
          from,
          to,
          JSON.stringify(teams),
        )
      : this.sql.exec<{ json: string }>(
          "SELECT json FROM matches WHERE kickoff >= ? AND kickoff < ? ORDER BY kickoff",
          from,
          to,
        );
    const json = rows.toArray().map((r) => r.json);
    return { status: 200, body: `{"matches":[${json.join(",")}]}` };
  }

  // Matches in progress right now.
  liveMatches(): ReadResult {
    const unavailable = this.unavailable();
    if (unavailable) return unavailable;
    const json = this.sql
      .exec<{ json: string }>("SELECT json FROM matches WHERE phase = 'live' ORDER BY kickoff")
      .toArray()
      .map((r) => r.json);
    return { status: 200, body: `{"matches":[${json.join(",")}]}` };
  }

  match({ id }: { id: string }): ReadResult {
    const unavailable = this.unavailable();
    if (unavailable) return unavailable;
    const row = this.sql
      .exec<{ json: string }>("SELECT json FROM matches WHERE id = ?", id)
      .toArray()[0];
    if (!row)
      return { status: 404, body: JSON.stringify({ error: `Match ${id} is not indexed.` }) };
    return { status: 200, body: `{"match":${row.json}}` };
  }

  // Teams whose name contains `q` (case-insensitive), most matches first. Team ids are what
  // /api/matches?teams= and team follows take; several teams can share a name (e.g. a club's
  // men's and A sides), so the latest competition is included to tell them apart.
  teams({ q }: { q: string }): ReadResult {
    const unavailable = this.unavailable();
    if (unavailable) return unavailable;
    const teams = this.sql
      .exec<{
        id: string;
        name: string;
        matches: number;
        lastKickoff: number;
        competition: string;
      }>(
        `WITH sides AS (
           SELECT home_id AS id, json_extract(json, '$.home.name') AS name, kickoff,
                  json_extract(json, '$.competition') AS competition FROM matches
           UNION ALL
           SELECT away_id, json_extract(json, '$.away.name'), kickoff,
                  json_extract(json, '$.competition') FROM matches
         )
         SELECT id, name, count(*) AS matches, max(kickoff) AS lastKickoff, competition
         FROM sides WHERE name LIKE ? GROUP BY id ORDER BY matches DESC LIMIT 25`,
        `%${q}%`,
      )
      .toArray()
      .map((t) => ({
        id: t.id,
        name: t.name,
        matches: t.matches,
        lastMatch: new Date(t.lastKickoff),
        latestCompetition: t.competition,
      }));
    return { status: 200, body: JSON.stringify({ teams }) };
  }

  seasons(): ReadResult {
    const unavailable = this.unavailable();
    if (unavailable) return unavailable;
    const rows = this.sql
      .exec<{ id: string; label: string; start: number; end: number }>(
        "SELECT id, label, start, end FROM seasons ORDER BY start DESC",
      )
      .toArray();
    const seasons = rows.map((r) => ({ ...r, start: new Date(r.start), end: new Date(r.end) }));
    return { status: 200, body: JSON.stringify({ seasons }) };
  }

  season({ id }: { id: string }): ReadResult {
    const unavailable = this.unavailable();
    if (unavailable) return unavailable;
    const season = this.sql
      .exec<{ id: string; label: string; start: number; end: number }>(
        "SELECT id, label, start, end FROM seasons WHERE id = ?",
        id,
      )
      .toArray()[0];
    if (!season) {
      return { status: 404, body: JSON.stringify({ error: `Season ${id} is not indexed.` }) };
    }
    const matches = this.sql
      .exec<{ json: string }>("SELECT json FROM matches WHERE season_id = ? ORDER BY kickoff", id)
      .toArray()
      .map((r) => toMatch({ json: r.json }));
    const standings = this.sql
      .exec<{ json: string | null }>("SELECT json FROM standings WHERE season_id = ?", id)
      .toArray()[0];
    const detail: SeasonDetail = {
      season: { ...season, start: new Date(season.start), end: new Date(season.end) },
      matches,
      standings: standings?.json ? (JSON.parse(standings.json) as Standings) : null,
    };
    return { status: 200, body: JSON.stringify(detail) };
  }

  // Live updates: browsers connect here and receive changed matches as they're indexed.
  async fetch(request: Request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Browsers only listen; anything they send (other than auto-answered pings) is ignored.
  webSocketMessage() {}

  webSocketClose(ws: WebSocket, code: number) {
    ws.close(code === 1005 ? 1000 : code, "closing");
  }
}
