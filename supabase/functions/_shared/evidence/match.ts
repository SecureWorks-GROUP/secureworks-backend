// T7 Loop 1 — Conservative matching ladder
//
// Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 0 adopted-from-Codex)
// Purpose:
//   Take a (job_id, match_method, match_confidence) suggestion from the caller
//   and resolve to a final (job_id, match_status, match_confidence, match_method)
//   tuple per the conservative ladder. Below MATCH_CONFIDENCE_FLOOR (0.60),
//   downgrade to 'unresolved' regardless of the caller's claim.
//
// This module is pure. No DB calls. Callers do their own resolution
// (looking up contact_id, scanning subject for SWP-####, etc.) and pass the
// result here for envelope normalization.

import {
  MatchStatus,
  MatchMethod,
  MATCH_CONFIDENCE_FLOOR,
} from "./types.ts";

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

/**
 * Resolve a caller-supplied match suggestion into a final envelope tuple.
 *
 * Rules:
 *  1. Caller declared no_match_attempted -> 'ignored', confidence null.
 *  2. job_id present + method='direct_job_id' (or 'manual') -> 'matched',
 *     confidence clamped to >= 0.95 (high-trust direct sources).
 *  3. job_id present + confidence >= floor -> 'matched'.
 *  4. job_id present + confidence < floor -> 'unresolved' (downgrade,
 *     keep job_id as a hint only on quarantine row? -> NO. Drop job_id
 *     to null so consumers cannot accidentally treat low-confidence
 *     guesses as truth).
 *  5. job_id null + confidence > 0 -> 'ambiguous' (caller saw multiple
 *     candidates).
 *  6. job_id null + no confidence + no method -> 'unresolved'.
 */
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
  if (input.job_id !== null && (method === "direct_job_id" || method === "manual")) {
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

  // Job_id present with confidence above the floor.
  if (input.job_id !== null && confidence !== null && confidence >= MATCH_CONFIDENCE_FLOOR) {
    return {
      job_id: input.job_id,
      match_status: "matched",
      match_method: method,
      match_confidence: confidence,
      notes,
    };
  }

  // Job_id present but confidence below floor -> unresolved, drop job_id.
  if (input.job_id !== null) {
    notes.push(
      `confidence ${confidence ?? "null"} below floor ${MATCH_CONFIDENCE_FLOOR}; dropped job_id`,
    );
    return {
      job_id: null,
      match_status: "unresolved",
      match_method: method,
      match_confidence: confidence,
      notes,
    };
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
