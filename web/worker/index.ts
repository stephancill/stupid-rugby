import { Hono } from "hono";
import { z } from "zod";
import { UPSTREAM_URL } from "../../src/worldrugby.ts";
import { type Env, Indexer, type ReadResult } from "./indexer.ts";
import { followKinds, subscriptionSchema } from "./notify.ts";

export { Indexer };

// The app's API. Matches, seasons and standings are read from the index (indexer.ts), a
// Durable Object that polls upstream on its own schedule, so browsers never cause upstream
// calls for them. /api/live is a WebSocket the index pushes live score changes to.
//
// Per-match details (summary, stats) aren't indexed and go through a caching
// proxy to World Rugby at /api/wr.
//
// Responses are cached in a per-isolate memory LRU, then the colo-wide Cache API (a no-op
// on *.workers.dev, so only active on the custom domain).

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_MEMORY_ENTRIES = 1000;
// Reads covering today change as matches are played; the rest only on fixture changes.
const CURRENT_TTL_MS = 10 * SECOND;
const SETTLED_TTL_MS = 10 * MINUTE;
const PROXY_MIN_COOLDOWN_MS = 2 * MINUTE;
const PROXY_MAX_COOLDOWN_MS = 30 * MINUTE;

type Entry = { status: number; body: string; expires: number };

const memory = new Map<string, Entry>();

function remember({ key, entry }: { key: string; entry: Entry }) {
  // Map iteration order is insertion order, so this evicts the oldest entry.
  memory.delete(key);
  memory.set(key, entry);
  if (memory.size > MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value!);
}

function respond({ entry, source }: { entry: Entry; source: string }) {
  const maxAge = Math.max(0, Math.round((entry.expires - Date.now()) / SECOND));
  return new Response(entry.body, {
    status: entry.status,
    headers: {
      "content-type": "application/json",
      "cache-control": entry.status === 200 ? `public, max-age=${maxAge}` : "no-store",
      "x-cache": source,
    },
  });
}

// Serves `load` through both cache layers. Only successful responses are cached.
async function cached({
  url,
  ttlMs,
  load,
  waitUntil,
}: {
  url: URL;
  // A fixed lifetime, or one decided from the loaded body.
  ttlMs: number | ((args: { body: string }) => number);
  load: () => Promise<ReadResult>;
  waitUntil: (promise: Promise<unknown>) => void;
}) {
  // Sorted params so equivalent queries share an entry.
  const params = new URLSearchParams([...url.searchParams].sort(([a], [b]) => a.localeCompare(b)));
  const key = `${url.pathname}?${params}`;
  const now = Date.now();

  const hit = memory.get(key);
  if (hit && hit.expires > now) return respond({ entry: hit, source: "HIT-MEMORY" });

  const edgeKey = new Request(`${url.origin}${key}`);
  const edge = await caches.default.match(edgeKey);
  if (edge) {
    const expires = Number(edge.headers.get("x-expires") ?? now);
    const entry = { status: 200, body: await edge.text(), expires };
    remember({ key, entry });
    return respond({ entry, source: "HIT-EDGE" });
  }

  const { status, body } = await load();
  const ttl = typeof ttlMs === "number" ? ttlMs : ttlMs({ body });
  const entry = { status, body, expires: now + ttl };
  if (status === 200) {
    remember({ key, entry });
    waitUntil(
      caches.default.put(
        edgeKey,
        new Response(body, {
          headers: {
            "content-type": "application/json",
            "cache-control": `public, max-age=${Math.round(ttl / SECOND)}`,
            "x-expires": String(entry.expires),
          },
        }),
      ),
    );
  }
  return respond({ entry, source: "MISS" });
}

function indexer({ env }: { env: Env }) {
  return env.INDEXER.get(env.INDEXER.idFromName("main"));
}

function touchesToday({ from, to }: { from: number; to: number }) {
  const now = Date.now();
  return from < now + DAY && to > now - DAY;
}

const dateParam = z.iso.date().transform((d) => Date.parse(d));

const matchesQuery = z.object({
  from: dateParam,
  to: dateParam,
  teams: z
    .string()
    .optional()
    .transform((t) => (t ? t.split(",").filter(Boolean).sort() : [])),
});

const app = new Hono<{ Bindings: Env }>();

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: error.message }, 500);
});

app.get("/api/status", async (c) => c.json(await indexer({ env: c.env }).status()));

// Matches kicking off in [from, to), optionally only those involving `teams` (ids).
app.get("/api/matches", async (c) => {
  const parsed = matchesQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: z.prettifyError(parsed.error) }, 400);
  const { from, to, teams } = parsed.data;
  return cached({
    url: new URL(c.req.url),
    ttlMs: touchesToday({ from, to }) ? CURRENT_TTL_MS : SETTLED_TTL_MS,
    load: () => indexer({ env: c.env }).matches({ from, to, teams }),
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });
});

app.get("/api/seasons", (c) =>
  cached({
    url: new URL(c.req.url),
    ttlMs: HOUR,
    load: () => indexer({ env: c.env }).seasons(),
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  }),
);

// A season's matches and standings.
app.get("/api/seasons/:id", (c) =>
  cached({
    url: new URL(c.req.url),
    ttlMs: CURRENT_TTL_MS,
    load: () => indexer({ env: c.env }).season({ id: c.req.param("id") }),
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  }),
);

app.get("/api/live", (c) => {
  if (c.req.header("upgrade") !== "websocket")
    return c.json({ error: "Expected a WebSocket" }, 426);
  return indexer({ env: c.env }).fetch(c.req.raw);
});

// --- Push notifications ----------------------------------------------------------------
//
// A device is identified by its push subscription endpoint (an unguessable URL), sent in
// request bodies rather than URLs so it stays out of logs. Responses list the device's
// follows; 404 means the index doesn't know the subscription and the client should
// subscribe again.

function send({ result }: { result: ReadResult }) {
  return new Response(result.body, {
    status: result.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const endpointBody = z.object({ endpoint: z.url() });

app.get("/api/push/key", (c) => c.json({ key: c.env.VAPID_PUBLIC_KEY }));

app.post("/api/push/subscription", async (c) => {
  const body = z
    .object({ subscription: subscriptionSchema, previousEndpoint: z.url().optional() })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
  return send({ result: await indexer({ env: c.env }).savePushSubscription(body.data) });
});

app.post("/api/push/unsubscribe", async (c) => {
  const body = endpointBody.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
  return send({ result: await indexer({ env: c.env }).deletePushSubscription(body.data) });
});

app.post("/api/push/follows", async (c) => {
  const body = endpointBody.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
  return send({ result: await indexer({ env: c.env }).follows(body.data) });
});

app.post("/api/push/follow", async (c) => {
  const body = endpointBody
    .extend({
      kind: z.enum(followKinds),
      target: z.string().min(1).max(100),
      label: z.string().min(1).max(200),
      follow: z.boolean(),
    })
    .safeParse(await c.req.json());
  if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
  return send({ result: await indexer({ env: c.env }).setFollow(body.data) });
});

// --- Per-match detail proxy ---------------------------------------------------------------
//
// Summary and stats for the match page, cached like the index reads: 10s while a match is
// in progress, an hour once it's complete. A 429 starts a cooldown (doubling up to
// PROXY_MAX_COOLDOWN_MS) during which upstream isn't called and requests get a 429.

const proxyPaths = [/^\/rugby\/v3\/match\/[\w-]+\/(summary|stats)$/];
const proxyCooldown = { until: 0, ms: 0 };

async function proxyFetch({ url }: { url: string }): Promise<ReadResult> {
  if (proxyCooldown.until > Date.now()) {
    return { status: 429, body: JSON.stringify({ error: "World Rugby is rate limiting us." }) };
  }
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "stupid-rugby/0.1" },
  });
  const body = await res.text();
  console.log(`World Rugby proxy ${res.status} ${url}`);
  if (res.status === 429) {
    proxyCooldown.ms = Math.min(
      Math.max(proxyCooldown.ms * 2, PROXY_MIN_COOLDOWN_MS),
      PROXY_MAX_COOLDOWN_MS,
    );
    proxyCooldown.until = Date.now() + proxyCooldown.ms;
    return { status: 429, body: JSON.stringify({ error: "World Rugby is rate limiting us." }) };
  }
  if (!res.ok) {
    const error = `World Rugby API ${res.status}: ${body.slice(0, 200)}`;
    return { status: res.status < 500 ? res.status : 502, body: JSON.stringify({ error }) };
  }
  proxyCooldown.ms = 0;
  return { status: 200, body };
}

app.get("/api/wr/*", (c) => {
  const url = new URL(c.req.url);
  const path = url.pathname.slice("/api/wr".length);
  if (!proxyPaths.some((re) => re.test(path))) return c.json({ error: "Not allowed" }, 404);
  return cached({
    url,
    ttlMs: ({ body }) => (body.includes('"status":"C"') ? HOUR : CURRENT_TTL_MS),
    load: () => proxyFetch({ url: `${c.env.UPSTREAM_URL ?? UPSTREAM_URL}${path}` }),
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });
});

app.get("/api/health", (c) => c.json({ ok: true }));

export default app;
