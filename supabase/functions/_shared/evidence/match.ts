// Caller hints never establish attribution. The database owns contact/thread resolution.
import { MatchStatus, MatchMethod } from "./types.ts";

export interface MatchInput {
  job_id: string | null;
  match_method?: MatchMethod;
  match_confidence?: number;
  /**
   * If true, caller is asserting that *no* match attempt was performed
   * (e.g. system events without a customer side). Resolves to 'ignored'.
   */
  no_match_attempted?: boolean;
}

export interface MatchOutput {
  job_id: string | null;
  match_status: MatchStatus;
  match_method: MatchMethod;
  match_confidence: number | null;
  notes: string[];
}

export function resolveMatch(input: MatchInput): MatchOutput {
  const notes: string[] = [];

  if (input.no_match_attempted) {
    return {
      job_id: null,
      match_status: "ignored",
      match_method: "none",
      match_confidence: null,
      notes: ["no_match_attempted by caller"],
    };
  }

  const method = input.match_method ?? "none";
  let confidence = clampConfidence(input.match_confidence);

  // Direct id / manual link: high trust by definition.
  if (input.job_id !== null && (method === "direct_job_id" || method === "direct_reference" || method === "manual")) {
    if (confidence === null || confidence < 0.95) {
      notes.push(`direct method '${method}' raised confidence to 0.99`);
      confidence = 0.99;
    }
    return {
      job_id: input.job_id,
      match_status: "matched",
      match_method: method,
      match_confidence: confidence,
      notes,
    };
  }

  // Confidence is not provenance: even a 1.0 contact guess must run the ladder.
  if (input.job_id !== null) {
    notes.push(`non-direct method '${method}'; retained suggestion only, dropped job_id`);
    return { job_id: null, match_status: "unresolved", match_method: method,
      match_confidence: confidence, notes };
  }

  // No job_id but caller had multiple candidates (positive confidence).
  if (confidence !== null && confidence > 0) {
    return {
      job_id: null,
      match_status: "ambiguous",
      match_method: method,
      match_confidence: confidence,
      notes,
    };
  }

  // No job_id, no confidence -> unresolved.
  return {
    job_id: null,
    match_status: "unresolved",
    match_method: method,
    match_confidence: confidence,
    notes,
  };
}

function clampConfidence(c: number | undefined): number | null {
  if (c === undefined || c === null || Number.isNaN(c)) return null;
  if (c < 0) return 0;
  if (c > 1) return 1;
  return Number(c.toFixed(2));
}
