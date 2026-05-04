// T7 Loop 1 — EvidenceRef contract + proposal validator
//
// Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 18)
// Closes: T5-DEVQ-9 (310/310 ai_proposed_actions with no evidence_refs)
//
// Every ai_proposed_actions row should carry action_payload.evidence_refs[]
// citing the spine rows that justified the proposal. Loop 1 ships this
// validator + helper. Loop 8 wires the strict-mode flag.

import {
  Channel,
  Direction,
  EvidenceRef,
} from "./types.ts";

export type ValidatorMode = "off" | "soft-warn" | "strict";

export interface ValidationResult {
  ok: boolean;
  mode: ValidatorMode;
  errors: string[];
  warnings: string[];
  /**
   * When 'strict' returns ok=false, callers MUST NOT insert. When
   * 'soft-warn' returns ok=false, callers SHOULD log
   * 'proposal.missing_evidence_refs' to the spine and proceed.
   */
}

const ALLOWED_EXCEPTION_REASONS = new Set([
  "synthetic_probe",
  "scheduled_cleanup",
  "first_run_bootstrap",
  "health_check",
]);

/**
 * Validate that a proposal payload carries an acceptable evidence_refs[].
 *
 * Required shape on payload (per Section 18 of the roadmap):
 *   action_payload.evidence_refs: EvidenceRef[]
 *   OR
 *   action_payload.exception_reason: one of ALLOWED_EXCEPTION_REASONS
 *   AND provenance.writer_role === 'system'
 *
 * Modes:
 *   off       -> always returns ok=true. No checks. (default during rollout)
 *   soft-warn -> returns ok=false on missing refs but caller should still write.
 *   strict    -> returns ok=false on missing refs; caller MUST NOT write.
 */
export function validateProposalEvidenceRefs(
  proposal: {
    action_payload?: Record<string, unknown> | null;
    provenance?: Record<string, unknown> | null;
  },
  mode: ValidatorMode,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (mode === "off") {
    return { ok: true, mode, errors, warnings };
  }

  const payload = (proposal.action_payload ?? {}) as Record<string, unknown>;
  const provenance = (proposal.provenance ?? {}) as Record<string, unknown>;
  const refs = payload.evidence_refs;
  const exceptionReason = payload.exception_reason as string | undefined;

  // Exception path: system/maintenance proposals with declared reason.
  if (exceptionReason && ALLOWED_EXCEPTION_REASONS.has(exceptionReason)) {
    if (provenance.writer_role !== "system") {
      errors.push(
        `exception_reason '${exceptionReason}' requires provenance.writer_role='system' (got '${provenance.writer_role}')`,
      );
    }
    if (errors.length === 0) {
      warnings.push(`accepted under exception '${exceptionReason}'`);
      return { ok: true, mode, errors, warnings };
    }
    return failOrWarn(mode, errors, warnings);
  }

  if (!Array.isArray(refs)) {
    errors.push("action_payload.evidence_refs must be an array");
    return failOrWarn(mode, errors, warnings);
  }
  if (refs.length === 0) {
    errors.push("action_payload.evidence_refs is empty (no source row cited)");
    return failOrWarn(mode, errors, warnings);
  }

  for (let i = 0; i < refs.length; i++) {
    const r = refs[i] as Partial<EvidenceRef>;
    const path = `evidence_refs[${i}]`;
    if (typeof r.evidence_id !== "string" || r.evidence_id.length === 0) {
      errors.push(`${path}.evidence_id missing`);
    }
    if (typeof r.source_table !== "string" || r.source_table.length === 0) {
      errors.push(`${path}.source_table missing`);
    }
    if (typeof r.source_id !== "string" || r.source_id.length === 0) {
      errors.push(`${path}.source_id missing`);
    }
    if (typeof r.summary !== "string" || r.summary.length === 0) {
      warnings.push(`${path}.summary missing — operator card will lack provenance text`);
    }
  }

  return failOrWarn(mode, errors, warnings);
}

function failOrWarn(
  mode: ValidatorMode,
  errors: string[],
  warnings: string[],
): ValidationResult {
  return {
    ok: errors.length === 0,
    mode,
    errors,
    warnings,
  };
}

/**
 * Build a lightweight EvidenceRef from a freshly-inserted spine row.
 * Used by recordEvidence to return the ref alongside the spine row.
 */
export function makeEvidenceRef(spine: {
  id: string;
  source_table: string;
  source_id: string;
  channel: Channel;
  direction: Direction;
  occurred_at: string;
  job_id: string | null;
  contact_id: string | null;
  thread_key?: string | null;
  safe_summary?: string | null;
  body_preview?: string | null;
}): EvidenceRef {
  const summary = (spine.safe_summary && spine.safe_summary.length > 0)
    ? spine.safe_summary
    : truncateForSummary(spine.body_preview ?? "");
  return {
    evidence_id: spine.id,
    source_table: spine.source_table,
    source_id: spine.source_id,
    channel: spine.channel,
    direction: spine.direction,
    occurred_at: spine.occurred_at,
    job_id: spine.job_id,
    contact_id: spine.contact_id,
    thread_key: spine.thread_key ?? null,
    summary,
  };
}

function truncateForSummary(text: string): string {
  if (text.length <= 280) return text;
  return text.slice(0, 277) + "...";
}
