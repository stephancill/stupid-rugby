// Service worker: shows push notifications from the index (worker/notify.ts) and opens the
// match when one is tapped. Plain JS in public/ so it is served as-is at /sw.js.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  const { title, body, url, tag } = event.data.json();
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // One notification per match: a newer update replaces the previous one.
      tag,
      renotify: true,
      icon: "/icon-192.png",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data.url, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const client = clients[0];
      if (!client) return self.clients.openWindow(url);
      await client.focus();
      return client.navigate(url);
    }),
  );
});

// Safari only accepts the key as bytes.
function keyBytes(base64url) {
  const base64 = base64url.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

// The browser rotated the subscription: subscribe again and move the follows over.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const { key } = await (await fetch("/api/push/key")).json();
      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(key),
      });
      await fetch("/api/push/subscription", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          previousEndpoint: event.oldSubscription?.endpoint,
        }),
      });
    })(),
  );
});
