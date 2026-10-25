// Standings normalized across sources (World Rugby, ESPN).
export type StandingsRow = {
  position: number;
  team: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  pointsFor: number;
  pointsAgainst: number;
  bonusPoints: number;
  points: number;
};

// One table: a league, or a pool/conference within a competition.
export type StandingsGroup = { name: string | null; rows: StandingsRow[] };

export type Standings = { source: "World Rugby" | "ESPN"; groups: StandingsGroup[] };
