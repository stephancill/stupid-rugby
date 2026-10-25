import { useEffect, useState } from "react";

// The current time, ticking every second while `enabled` (a live match clock is showing).
export function useNow({ enabled }: { enabled: boolean }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}
