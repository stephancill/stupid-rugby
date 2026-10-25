import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import type { ApiError } from "../../src/http.ts";

// Push notifications: the service worker (public/sw.js), this device's push subscription,
// and what it follows. The server side is in worker/notify.ts and the index.

export type FollowKind = "team" | "match" | "competition";
export type Follow = { kind: FollowKind; target: string; label: string };

const followsSchema = z.object({
  follows: z.array(
    z.object({
      kind: z.enum(["team", "match", "competition"]),
      target: z.string(),
      label: z.string(),
    }),
  ),
});

// "install": iOS only offers push to apps added to the Home Screen.
export type PushSupport = "supported" | "install" | "unsupported";

export function pushSupport(): PushSupport {
  if ("serviceWorker" in navigator && "PushManager" in window) return "supported";
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches;
  return ios && !standalone ? "install" : "unsupported";
}

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
    console.error("Service worker registration failed", error);
  });
}

async function post<T>({
  path,
  body,
  schema,
}: {
  path: string;
  body: unknown;
  schema: z.ZodType<T>;
}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json();
  if (!res.ok) {
    const message = (json as { error?: string }).error ?? `API ${res.status} for ${path}`;
    throw Object.assign(new Error(message), { status: res.status }) satisfies ApiError;
  }
  return schema.parse(json);
}

function keyBytes({ base64url }: { base64url: string }) {
  const base64 = base64url.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  if (pushSupport() !== "supported") return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

function saveSubscription({ subscription }: { subscription: PushSubscription }) {
  return post({
    path: "/api/push/subscription",
    body: { subscription: subscription.toJSON() },
    schema: followsSchema,
  });
}

// Must run from a user gesture: iOS only shows the permission prompt then.
async function subscribe() {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked for this site.");
  const { key } = z.object({ key: z.string() }).parse(await (await fetch("/api/push/key")).json());
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes({ base64url: key }),
  });
  await saveSubscription({ subscription });
  return subscription;
}

const subscriptionKey = ["push-subscription"];
const followsKey = ["push-follows"];

export function usePushSubscription() {
  return useQuery({ queryKey: subscriptionKey, queryFn: currentSubscription, staleTime: Infinity });
}

// This device's follows; empty without a subscription. A subscription the server doesn't
// know (e.g. after its data was reset) is registered again.
export function useFollows() {
  const subscription = usePushSubscription();
  const endpoint = subscription.data?.endpoint;
  return useQuery({
    queryKey: [...followsKey, endpoint],
    queryFn: async () => {
      if (!subscription.data) return [];
      try {
        return (
          await post({ path: "/api/push/follows", body: { endpoint }, schema: followsSchema })
        ).follows;
      } catch (error) {
        if ((error as Partial<ApiError>).status !== 404) throw error;
        return (await saveSubscription({ subscription: subscription.data })).follows;
      }
    },
    enabled: subscription.isSuccess,
    staleTime: 60_000,
  });
}

// Follows or unfollows a set of targets (several team ids can share a name), subscribing
// this device first if needed.
export function useToggleFollow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ targets, follow }: { targets: Follow[]; follow: boolean }) => {
      const subscription = (await currentSubscription()) ?? (await subscribe());
      let follows: Follow[] = [];
      for (const target of targets) {
        ({ follows } = await post({
          path: "/api/push/follow",
          body: { endpoint: subscription.endpoint, ...target, follow },
          schema: followsSchema,
        }));
      }
      return { subscription, follows };
    },
    onSuccess: ({ subscription, follows }) => {
      queryClient.setQueryData(subscriptionKey, subscription);
      queryClient.setQueryData([...followsKey, subscription.endpoint], follows);
    },
  });
}

// Stops all notifications on this device.
export function useDisablePush() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const subscription = await currentSubscription();
      if (!subscription) return;
      await post({
        path: "/api/push/unsubscribe",
        body: { endpoint: subscription.endpoint },
        schema: followsSchema,
      });
      await subscription.unsubscribe();
    },
    onSuccess: () => {
      queryClient.setQueryData(subscriptionKey, null);
      void queryClient.invalidateQueries({ queryKey: followsKey });
    },
  });
}
