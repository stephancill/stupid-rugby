import { type BonusRules, standardBonus } from "./live-standings.ts";

// World Rugby event IDs change every season, so competitions are matched on
// their label with the trailing season year stripped (e.g. "URC 2027" -> "URC").
//
// `seasons` matches World Rugby event (season) labels, which can differ from match labels.
// `espnId` is ESPN's league id, where ESPN publishes standings. `bonus` is the bonus point
// system where it isn't the standard one (see bonusRules).
export const majorCompetitions = [
  {
    key: "six-nations",
    label: "Six Nations",
    seasons: /^(\d{4} )?Six Nations( \d{4})?$/,
    espnId: 180659,
  },
  {
    key: "rugby-championship",
    label: "The Rugby Championship",
    seasons: /^The Rugby Championship \d{4}$/,
    espnId: 244293,
  },
  {
    key: "nations-championship",
    label: "Nations Championship",
    seasons: /^Nations Championship \d{4}$/,
  },
  {
    key: "autumn-nations",
    label: "Autumn Nations Series",
    seasons: /^Autumn Nations Series \d{4}$/,
  },
  { key: "internationals", label: "Men's Internationals", seasons: /^\d{4} Men's International$/ },
  {
    key: "rwc",
    label: "Men's Rugby World Cup",
    seasons: /^(Men's )?Rugby World Cup \d{4}$/,
    espnId: 164205,
  },
  { key: "urc", label: "URC", seasons: /^URC \d{4}$/, espnId: 270557 },
  {
    key: "premiership",
    label: "English Premiership",
    seasons: /^English Premiership \d{4}$/,
    espnId: 267979,
  },
  {
    key: "top-14",
    label: "Top 14",
    seasons: /^Top 14 \d{4}$/,
    espnId: 270559,
    bonus: { tryBonus: { kind: "margin", min: 3 }, losingMargin: 5 },
  },
  {
    key: "champions-cup",
    label: "EPCR Champions Cup",
    seasons: /^(EPCR|Investec) Champions Cup \d{4}$/,
    espnId: 271937,
    // From 2026/27.
    bonus: { tryBonus: { kind: "margin", min: 3 }, losingMargin: 7 },
  },
  {
    key: "challenge-cup",
    label: "EPCR Challenge Cup",
    seasons: /^EPCR Challenge Cup \d{4}$/,
    espnId: 272073,
    // From 2026/27.
    bonus: { tryBonus: { kind: "margin", min: 3 }, losingMargin: 7 },
  },
  {
    key: "super-rugby",
    label: "Super Rugby",
    seasons: /^Super Rugby (Pacific )?\d{4}$/,
    espnId: 242041,
  },
  {
    key: "japan-league-one",
    label: "Japan League One",
    seasons: /^Japan (Rugby )?League One \d{4}$/,
  },
  { key: "mlr", label: "Major League Rugby", seasons: /^(MLR|Major League Rugby) \d{4}$/ },
  { key: "currie-cup", label: "Currie Cup", seasons: /^Currie Cup \d{4}$/ },
  { key: "npc", label: "Bunnings Warehouse NPC", seasons: /NPC \d{4}$/ },
  {
    key: "pro-d2",
    label: "Pro D2",
    seasons: /^Pro D2 \d{4}$/,
    bonus: { tryBonus: { kind: "margin", min: 3 }, losingMargin: 5 },
  },
  { key: "championship", label: "English Championship", seasons: /^English Championship \d{4}$/ },
] as const satisfies readonly {
  key: string;
  label: string;
  seasons: RegExp;
  espnId?: number;
  bonus?: BonusRules;
}[];

export type CompetitionKey = (typeof majorCompetitions)[number]["key"];

export function baseLabel({ label }: { label: string }) {
  return label.replace(/\s+\d{4}(\s+\d{4})?\s*$/, "").trim();
}

export function findCompetition({ label }: { label: string }) {
  const base = baseLabel({ label });
  return majorCompetitions.find((c) => c.label === base) ?? null;
}

// Stable, URL-friendly key: the curated key for major competitions, a slug otherwise.
export function competitionKey({ label }: { label: string }) {
  return (
    findCompetition({ label })?.key ??
    baseLabel({ label })
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
  );
}

export function findCompetitionByKey({ key }: { key: string }) {
  return majorCompetitions.find((c) => c.key === key) ?? null;
}

// Current-season rules: 4 tries and losing by 7 or fewer, unless the competition says
// otherwise (Top 14 and Pro D2: winning by 3+ tries, losing by 5; EPCR cups from 2026/27:
// winning by 3+ tries, losing by 7).
export function bonusRules({ key }: { key: string }): BonusRules {
  const competition = findCompetitionByKey({ key });
  return competition && "bonus" in competition ? competition.bonus : standardBonus;
}

// The season in progress, else the latest that has started, else the next to start.
export function currentSeason<T extends { start: Date; end: Date }>({
  seasons,
  now,
}: {
  seasons: T[];
  now: Date;
}): T | null {
  const t = now.getTime();
  const started = seasons
    .filter((s) => s.start.getTime() <= t)
    .sort((a, b) => b.start.getTime() - a.start.getTime());
  return (
    started.find((s) => s.end.getTime() >= t) ??
    started[0] ??
    seasons.toSorted((a, b) => a.start.getTime() - b.start.getTime())[0] ??
    null
  );
}
