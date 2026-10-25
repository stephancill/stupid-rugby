import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { ZodError } from "zod";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import "./index.css";
import type { ApiError } from "../../src/http.ts";
import { CompetitionPage } from "./Competition.tsx";
import { Layout } from "./Layout.tsx";
import { MatchPage } from "./Match.tsx";
import { NotificationsPage } from "./Notifications.tsx";
import { registerServiceWorker } from "./push.ts";
import { Timeline } from "./Timeline.tsx";

// Only network failures are retried. Invalid data (ZodError) won't fix itself, and the
// API's own errors (warming up, outside the index's window, unknown season) are shown as
// they are.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) =>
        (error as Partial<ApiError>).status === undefined &&
        !(error instanceof ZodError) &&
        count < 3,
    },
  },
});

// Layout wraps every route in nuqs and the live-update subscription.
const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Timeline /> },
      { path: "competitions/:key", element: <CompetitionPage /> },
      { path: "matches/:id", element: <MatchPage /> },
      { path: "notifications", element: <NotificationsPage /> },
    ],
  },
]);

registerServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
