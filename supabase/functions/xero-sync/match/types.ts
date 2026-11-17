export interface Clue {
  clue_code: string;
  class: "key" | "clue" | "narrower" | "ai";
  family: string;
  root: string;
  outcome: "job" | "overhead" | "division_stock";
  job_id?: string;
  division?: string;
  names_one: boolean;
  seen_where?: string;
  seen_value?: string;
  detail?: Record<string, unknown>;
}

export interface ClueType {
  code: string;
  class: Clue["class"];
  family: string;
  mode: "counts" | "suggest_only" | "off";
}

export interface Stop {
  code: string;
  words: string;
  detail?: Record<string, unknown>;
}

export type MatchResult =
  | { result: "auto"; job_id: string; clue_indexes: [number, number] }
  | {
    result: "suggest";
    reason: string;
    outcome?: Clue["outcome"];
    job_id?: string;
    division?: string;
    from_clue_index?: number;
  }
  | { result: "none"; reason: "no_clue" };
