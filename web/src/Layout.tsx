import { Outlet } from "react-router";
import { useLiveUpdates } from "./live.ts";

export function Layout() {
  useLiveUpdates();
  return <Outlet />;
}
