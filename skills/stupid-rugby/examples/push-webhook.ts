// Receive Stupid Rugby notifications as an agent: act as a Web Push endpoint.
//
//   bun add http_ece
//   PUBLIC_URL=https://<your-public-https-host> bun push-webhook.ts follow team 1139 Leinster
//
// PUBLIC_URL must be HTTPS and route to this server (a reverse proxy or tunnel to PORT).
// Keys live in push-keys.json so the subscription survives restarts. Stop notifications
// with `bun push-webhook.ts unsubscribe`, or answer 410 from the webhook.
import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import ece from "http_ece";

const API = process.env.STUPID_RUGBY_API ?? "https://rugby.stupidtech.net/api";
const PORT = Number(process.env.PORT ?? 8787);
const KEYS_FILE = process.env.KEYS_FILE ?? "push-keys.json";

// A P-256 key pair and a 16-byte auth secret: what a browser generates for a subscription.
type Keys = { privateKey: string; publicKey: string; auth: string; endpoint: string };

function loadKeys(): Keys {
  if (existsSync(KEYS_FILE)) return JSON.parse(readFileSync(KEYS_FILE, "utf8")) as Keys;
  if (!process.env.PUBLIC_URL) throw new Error("Set PUBLIC_URL to this server's HTTPS URL");
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = {
    privateKey: ecdh.getPrivateKey("base64url"),
    publicKey: ecdh.getPublicKey("base64url"),
    auth: crypto.randomBytes(16).toString("base64url"),
    // A random path, so the endpoint stays unguessable: it's the subscription's credential.
    endpoint: `${process.env.PUBLIC_URL.replace(/\/$/, "")}/push/${crypto.randomUUID()}`,
  };
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
  return keys;
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}/push/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json as { follows: { kind: string; target: string; label: string }[] };
}

// Payloads use the "aesgcm" content encoding: the sender's key and salt are in headers.
function decrypt({ keys, body, headers }: { keys: Keys; body: Buffer; headers: Headers }) {
  const param = (header: string, name: string) =>
    new RegExp(`${name}=([^;,]+)`).exec(headers.get(header) ?? "")?.[1];
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(keys.privateKey, "base64url"));
  const plain = ece.decrypt(body, {
    version: "aesgcm",
    privateKey: ecdh,
    dh: param("crypto-key", "dh"),
    salt: param("encryption", "salt"),
    authSecret: keys.auth,
  });
  return JSON.parse(plain.toString()) as { title: string; body: string; url: string; tag: string };
}

const keys = loadKeys();
const [command, kind, target, label] = process.argv.slice(2);

if (command === "unsubscribe") {
  console.log(await post("unsubscribe", { endpoint: keys.endpoint }));
  process.exit(0);
}

if (command === "follow" || command === "unfollow") {
  if (!kind || !target || !label)
    throw new Error("Usage: follow <team|match|competition> <target> <label>");
  const subscription = {
    endpoint: keys.endpoint,
    keys: { p256dh: keys.publicKey, auth: keys.auth },
  };
  await post("subscription", { subscription });
  const { follows } = await post("follow", {
    endpoint: keys.endpoint,
    kind,
    target,
    label,
    follow: command === "follow",
  });
  console.log("Following:", follows);
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method !== "POST" || path !== new URL(keys.endpoint).pathname) {
      return new Response("Not found", { status: 404 });
    }
    const notification = decrypt({
      keys,
      body: Buffer.from(await req.arrayBuffer()),
      headers: req.headers,
    });
    // Act on it here: e.g. "Leinster 14–7 Munster" / "Try – James Lowe 23'".
    console.log(new Date().toISOString(), notification.title, "|", notification.body);
    // 201 acknowledges. Answering 404 or 410 deletes the subscription and its follows.
    return new Response(null, { status: 201 });
  },
});
console.log(`Listening on :${PORT} for ${keys.endpoint}`);
