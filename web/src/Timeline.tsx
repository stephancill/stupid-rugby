import { parseAsArrayOf, parseAsString, useQueryState } from "nuqs";
import { Link } from "react-router";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { baseLabel, competitionKey, majorCompetitions } from "../../src/competitions.ts";
import { formatDay } from "./format.ts";
import { closestDay, dayKey, useMatches, useTeamMatches } from "./matches.ts";
import { FollowButton, PushHint } from "./FollowButton.tsx";
import { MatchRow } from "./match-row.tsx";

const MAX_EMPTY_LOADS = 3;
const majorKeys: string[] = majorCompetitions.map((c) => c.key);

// Major competitions in their curated order, then the rest alphabetically, so the same
// selection always serializes to the same URL (and the default clears from it).
function canonical({ keys }: { keys: Iterable<string> }) {
  const set = new Set(keys);
  return [
    ...majorKeys.filter((key) => set.has(key)),
    ...[...set].filter((key) => !majorKeys.includes(key)).sort(),
  ];
}

const compParser = parseAsArrayOf(parseAsString).withDefault(majorKeys);
const teamParser = parseAsString.withDefault("");

// Extends the loaded window while `ref` is near the viewport. The observer is recreated
// after each fetch and fires on observe, so weeks that are empty under the current filters
// keep loading, up to MAX_EMPTY_LOADS in a row.
function useAutoLoad({
  ref,
  enabled,
  visibleDays,
  extend,
}: {
  ref: RefObject<HTMLElement | null>;
  enabled: boolean;
  visibleDays: number;
  extend: Dispatch<SetStateAction<number>>;
}) {
  const state = useRef({ visibleDays: -1, emptyLoads: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        if (state.current.visibleDays === visibleDays) state.current.emptyLoads++;
        else state.current = { visibleDays, emptyLoads: 0 };
        if (state.current.emptyLoads < MAX_EMPTY_LOADS) extend((n) => n + 4);
      },
      { rootMargin: "600px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled, visibleDays, extend]);
}

// The first day section starting below the sticky header: what the user is reading. A
// section merely peeking out from under the header would be a bad anchor, because new days
// can be inserted between it and the reading position.
function findAnchor() {
  const headerBottom = document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
  let above: HTMLElement | null = null;
  for (const el of document.querySelectorAll<HTMLElement>("section.day")) {
    if (el.getBoundingClientRect().top >= headerBottom) return { id: el.id, top: el.offsetTop };
    above = el;
  }
  // One section taller than the viewport: anchor on the one being scrolled through.
  return above && { id: above.id, top: above.offsetTop };
}

// Anything inserted above the day being read (earlier weeks, which can resolve out of
// order, or the header growing as competitions appear) would push it down the page. After
// every render, scroll by however far it moved. The anchor is re-measured on scroll, so it
// always tracks the current reading position. Native scroll anchoring is disabled in CSS
// (overflow-anchor) so it doesn't adjust twice, and Safari lacks it anyway.
function useScrollAnchor() {
  const anchor = useRef<{ id: string; top: number } | null>(null);
  useEffect(() => {
    const update = () => {
      anchor.current = findAnchor();
    };
    addEventListener("scroll", update, { passive: true });
    return () => removeEventListener("scroll", update);
  }, []);
  useLayoutEffect(() => {
    const prev = anchor.current;
    const el = prev && document.getElementById(prev.id);
    if (prev && el && el.offsetTop !== prev.top) window.scrollBy(0, el.offsetTop - prev.top);
    anchor.current = findAnchor();
  });
}

// Whether the filters are expanded, remembered per browser. Storage can be unavailable
// (private windows, blocked site data), so it falls back to expanded.
const FILTERS_OPEN_KEY = "filters-open";

function useFiltersOpen() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(FILTERS_OPEN_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const set = ({ open }: { open: boolean }) => {
    setOpen(open);
    try {
      localStorage.setItem(FILTERS_OPEN_KEY, String(open));
    } catch {
      // Not remembered; the toggle still works for this visit.
    }
  };
  return [open, set] as const;
}

export function Timeline() {
  // Fixed at mount so render stays pure; live data still refreshes via refetch.
  const [now] = useState(() => new Date());
  const [weeksBefore, setWeeksBefore] = useState(3);
  const [weeksAfter, setWeeksAfter] = useState(3);
  const [comp, setComp] = useQueryState("comp", compParser);
  const [team, setTeam] = useQueryState("team", teamParser);
  const [filtersOpen, setFiltersOpen] = useFiltersOpen();
  const selected = useMemo(() => new Set(comp), [comp]);
  const weekly = useMatches({ now, weeksBefore, weeksAfter });

  // When the team box exactly matches a team, load all of its matches in one request
  // instead of paging week by week. Several teams can share a name, so match on all ids.
  const teamIds = useMemo(() => {
    const name = team.trim().toLowerCase();
    if (!name) return [];
    const ids = weekly.matches
      .flatMap((m) => [m.home, m.away])
      .filter((t) => t.name.toLowerCase() === name)
      .map((t) => t.id);
    return [...new Set(ids)].sort();
  }, [weekly.matches, team]);
  const teamMode = teamIds.length > 0;
  // The exact name as listed, for labels.
  const teamName =
    weekly.matches.flatMap((m) => [m.home, m.away]).find((t) => teamIds.includes(t.id))?.name ??
    team;
  const teamMatches = useTeamMatches({ teamIds, now });

  const matches = useMemo(() => {
    const byId = new Map(weekly.matches.map((m) => [m.id, m]));
    for (const m of teamMatches.data ?? []) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());
  }, [weekly.matches, teamMatches.data]);
  const isPending = weekly.isPending || (teamMode && teamMatches.isPending);
  const isFetching = weekly.isFetching || teamMatches.isFetching;
  const error = weekly.error ?? teamMatches.error;
  const { hasLater, hasEarlier, indexFrom } = weekly;

  const competitions = useMemo(() => {
    const present = new Map(
      matches.map((m) => [
        competitionKey({ label: m.competition }),
        baseLabel({ label: m.competition }),
      ]),
    );
    const toOptions = (keys: string[]) => keys.map((key) => ({ key, label: present.get(key)! }));
    return {
      major: toOptions(majorKeys.filter((key) => present.has(key))),
      other: toOptions([...present.keys()].filter((key) => !majorKeys.includes(key)).sort()),
    };
  }, [matches]);

  const inCompetitions = useMemo(
    () => matches.filter((m) => selected.has(competitionKey({ label: m.competition }))),
    [matches, selected],
  );

  const teams = useMemo(
    () => [...new Set(inCompetitions.flatMap((m) => [m.home.name, m.away.name]))].sort(),
    [inCompetitions],
  );

  // An exact team match shows only that team ("Bulls" mustn't include "Newcastle Red
  // Bulls"); anything else is a substring search while typing.
  const days = useMemo(() => {
    const query = team.trim().toLowerCase();
    const filtered =
      teamIds.length > 0
        ? inCompetitions.filter((m) => teamIds.includes(m.home.id) || teamIds.includes(m.away.id))
        : query
          ? inCompetitions.filter((m) =>
              `${m.home.name}\n${m.away.name}`.toLowerCase().includes(query),
            )
          : inCompetitions;
    return Map.groupBy(filtered, (m) => dayKey({ date: m.kickoff }));
  }, [inCompetitions, team, teamIds]);

  const highlighted = closestDay({ days: [...days.keys()], now });
  const highlightedRef = useRef<HTMLElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Scroll to the highlighted day once per filter combination. Loading more weeks also
  // toggles isPending, and re-scrolling then would yank the user away from the bottom.
  const filterKey = `${comp.join(",")}|${team}`;
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (isPending || scrolledFor.current === filterKey) return;
    scrolledFor.current = filterKey;
    highlightedRef.current?.scrollIntoView({ block: "start" });
  }, [isPending, filterKey]);

  // Earlier weeks load until the start of the index's window. A team's matches are already
  // loaded a year either way, so paging would only cost requests.
  const canLoad = !isFetching && !error && !teamMode;
  useAutoLoad({
    ref: startRef,
    enabled: canLoad && hasEarlier,
    visibleDays: days.size,
    extend: setWeeksBefore,
  });
  useAutoLoad({
    ref: endRef,
    enabled: canLoad && hasLater,
    visibleDays: days.size,
    extend: setWeeksAfter,
  });

  useScrollAnchor();

  function toggle({ key }: { key: string }) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    void setComp(canonical({ keys: next }));
  }

  function setAll({ keys }: { keys: string[] }) {
    void setComp(canonical({ keys }));
  }

  const today = dayKey({ date: now });

  return (
    <>
      <header>
        <h1>
          stupid rugby {isFetching && <small>updating…</small>}
          <Link to="/notifications" className="nav">
            Notifications
          </Link>
        </h1>
        <details
          className="filters"
          open={filtersOpen}
          onToggle={(e) => setFiltersOpen({ open: e.currentTarget.open })}
        >
          <summary>
            Filters{" "}
            <small>
              {comp.length === 1 ? "1 competition" : `${comp.length} competitions`}
              {team.trim() && ` · ${team.trim()}`}
            </small>
          </summary>
          <fieldset>
            <legend>Competitions</legend>
            {competitions.major.map(({ key, label }) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={selected.has(key)}
                  onChange={() => toggle({ key })}
                />
                {label}
              </label>
            ))}
            {competitions.other.length > 0 && (
              <details>
                <summary>Other competitions ({competitions.other.length})</summary>
                {competitions.other.map(({ key, label }) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={selected.has(key)}
                      onChange={() => toggle({ key })}
                    />
                    {label}
                  </label>
                ))}
              </details>
            )}
            <div>
              <button onClick={() => setAll({ keys: majorKeys })}>Major</button>{" "}
              <button
                onClick={() =>
                  setAll({ keys: [...competitions.major, ...competitions.other].map((c) => c.key) })
                }
              >
                All
              </button>{" "}
              <button onClick={() => setAll({ keys: [] })}>None</button>
            </div>
          </fieldset>
          <label>
            Team{" "}
            <input
              type="search"
              list="teams"
              value={team}
              placeholder="Any team"
              onChange={(e) => void setTeam(e.target.value)}
            />
            <datalist id="teams">
              {teams.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>
          {teamMode && (
            <>
              <small>
                {" "}
                All matches {teamMatches.from.toLocaleDateString()} –{" "}
                {teamMatches.to.toLocaleDateString()}
              </small>{" "}
              <FollowButton
                label={teamName}
                targets={teamIds.map((id) => ({ kind: "team", target: id, label: teamName }))}
              />
              <PushHint />
            </>
          )}
        </details>
      </header>

      <main>
        {error && <p className="error">Failed to load matches: {error.message}</p>}
        <div ref={startRef} className="edge">
          {isFetching ? (
            "Loading…"
          ) : hasEarlier ? (
            <button onClick={() => setWeeksBefore((n) => n + 4)}>Load earlier</button>
          ) : (
            indexFrom && `Results start ${indexFrom.toLocaleDateString()}.`
          )}
        </div>
        {days.size === 0 && <p>{isPending ? "Loading…" : "No matches for these filters."}</p>}
        {[...days].map(([key, dayMatches]) => (
          <section
            key={key}
            id={`day-${key}`}
            ref={key === highlighted ? highlightedRef : undefined}
            className={key === highlighted ? "day highlighted" : "day"}
          >
            <h2>
              {formatDay({ key })}
              {key === today && " (today)"}
            </h2>
            {[...Map.groupBy(dayMatches, (m) => m.competition)].map(([competition, group]) => (
              <table key={competition}>
                <caption>
                  <Link
                    to={{
                      pathname: `/competitions/${competitionKey({ label: competition })}`,
                      search: group[0]?.competitionId ? `?season=${group[0].competitionId}` : "",
                    }}
                  >
                    {baseLabel({ label: competition })}
                  </Link>
                </caption>
                <tbody>
                  {group.map((match) => (
                    <MatchRow key={match.id} match={match} />
                  ))}
                </tbody>
              </table>
            ))}
          </section>
        ))}
        <div ref={endRef} className="edge">
          {isFetching ? (
            "Loading…"
          ) : hasLater ? (
            <button onClick={() => setWeeksAfter((n) => n + 4)}>Load later</button>
          ) : (
            "No more fixtures scheduled."
          )}
        </div>
      </main>
    </>
  );
}
