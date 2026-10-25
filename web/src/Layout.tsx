import { NuqsAdapter } from "nuqs/adapters/react-router/v8";
import { Outlet } from "react-router";
import { useLiveUpdates } from "./live.ts";

// nuqs reads and writes search params through the router, so it sits inside it.
export function Layout() {
  useLiveUpdates();
  return (
    <NuqsAdapter>
      <Outlet />
    </NuqsAdapter>
  );
}
