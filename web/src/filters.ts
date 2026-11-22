import { useSyncExternalStore } from "react";
import { z } from "zod";
import { majorCompetitions } from "../../src/competitions.ts";

// The timeline's filters, remembered per browser in localStorage and shared across tabs.
// Storage can be unavailable (private windows, blocked site data); the filters then still
// work for the visit, starting from the defaults.

export const majorKeys: string[] = majorCompetitions.map((c) => c.key);

const STORAGE_KEY = "timeline-filters";

const filtersSchema = z.object({
  comp: z.array(z.string()),
  team: z.string(),
});

export type TimelineFilters = z.infer<typeof filtersSchema>;

const defaults: TimelineFilters = { comp: majorKeys, team: "" };

// Major competitions in their curated order, then the rest alphabetically, so the same
// selection always compares equal.
function canonical({ keys }: { keys: Iterable<string> }) {
  const set = new Set(keys);
  return [
    ...majorKeys.filter((key) => set.has(key)),
    ...[...set].filter((key) => !majorKeys.includes(key)).sort(),
  ];
}

function read(): TimelineFilters {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return defaults;
  }
  if (raw === null) return defaults;
  // Malformed or outdated values are dropped rather than breaking the page.
  try {
    return filtersSchema.parse(JSON.parse(raw));
  } catch {
    return defaults;
  }
}

let current = read();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return;
    current = read();
    emit();
  };
  addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    removeEventListener("storage", onStorage);
  };
}

export function setTimelineFilters(patch: Partial<TimelineFilters>) {
  const next = { ...current, ...patch };
  current = { ...next, comp: canonical({ keys: next.comp }) };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Not remembered; the filters still apply for this visit.
  }
  emit();
}

export function useTimelineFilters() {
  return useSyncExternalStore(subscribe, () => current);
}
