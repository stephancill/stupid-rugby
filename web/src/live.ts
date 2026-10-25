import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { Match } from "../../src/worldrugby.ts";
import { liveMessageSchema } from "./api.ts";

const MAX_RETRY_MS = 30_000;

// Replaces matches by id wherever they're cached: week and team lists (Match[]) and season
// details ({ matches }). Matches not already cached are ignored; they arrive with the next
// fetch of the list they belong to.
function applyMatches({ queryClient, matches }: { queryClient: QueryClient; matches: Match[] }) {
  const byId = new Map(matches.map((m) => [m.id, m]));
  const replace = (list: Match[]) =>
    list.some((m) => byId.has(m.id)) ? list.map((m) => byId.get(m.id) ?? m) : list;
  for (const key of [["matches"], ["team-matches"]]) {
    queryClient.setQueriesData<Match[]>({ queryKey: key }, (list) => list && replace(list));
  }
  queryClient.setQueriesData<{ matches: Match[] }>(
    { queryKey: ["season"] },
    (detail) => detail && { ...detail, matches: replace(detail.matches) },
  );
}

// Subscribes to the index's live updates (/api/live). Reconnects with backoff; after a
// reconnect everything is refetched, since updates sent while disconnected were missed.
export function useLiveUpdates() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let ws: WebSocket | null = null;
    let retryMs = 1000;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    let connectedBefore = false;

    function connect() {
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${protocol}//${location.host}/api/live`);
      ws.addEventListener("open", () => {
        retryMs = 1000;
        if (connectedBefore) void queryClient.invalidateQueries();
        connectedBefore = true;
        // Keeps proxies from timing out idle connections; answered without waking the index.
        ping = setInterval(() => ws?.send("ping"), 30_000);
      });
      ws.addEventListener("message", (event) => {
        if (event.data === "pong") return;
        const message = liveMessageSchema.parse(JSON.parse(String(event.data)));
        applyMatches({ queryClient, matches: message.matches });
      });
      ws.addEventListener("close", () => {
        clearInterval(ping);
        if (closed) return;
        retry = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      });
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(ping);
      ws?.close();
    };
  }, [queryClient]);
}
