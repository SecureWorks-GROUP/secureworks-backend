// T7 Loop 8 — Strict-mode wrapper for ai_proposed_actions inserts
//
// Roadmap: cio/operations/2026-05-02-t7-evidence-capture-spine-roadmap.md (Section 18)
// Closes: T5-DEVQ-9 (310/310 ai_proposed_actions in 30d carry zero evidence_refs)
//
// Every loop engine that writes ai_proposed_actions imports this and
// passes its proposal here. The wrapper consults
// feature_flags.evidence_refs_strict_mode and either:
//
//   - off       : insert as-is (no warning, no spine row).
//   - soft-warn : insert as-is BUT log a proposal.missing_evidence_refs
//                 spine row when evidence_refs is missing.
//   - strict    : reject the insert (return ok:false) when evidence_refs
//                 is missing. Caller MUST NOT retry without supplying refs.
//
// Allowed-exception path: action_payload.exception_reason in the
// allowlist + provenance.writer_role='system' lets system/maintenance
// proposals through without refs even in strict mode (e.g. health-check
// synthetic probes).

import { recordEvidence } from "./record_evidence.ts";
import { getRefsValidatorMode } from "./feature_flag.ts";
import { validateProposalEvidenceRefs } from "./evidence_ref.ts";

export interface ProposalRow {
  job_id?: string | null;
  contact_id?: string | null;
  action_type?: string;
  action_payload?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  status?: string;
  // ... other ai_proposed_actions columns flow through verbatim.
  [key: string]: unknown;
}

export interface InsertProposalResult {
  ok: boolean;
  inserted_id?: string;
  mode: "off" | "soft-warn" | "strict";
  reason?: string;
  warnings: string[];
}

export interface InsertProposalOptions {
  org_id?: string;
}

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

export async function insertProposalWithEvidenceCheck(
  // deno-lint-ignore no-explicit-any
  client: any,
  proposal: ProposalRow,
  options: InsertProposalOptions = {},
): Promise<InsertProposalResult> {
  const orgId = options.org_id ?? DEFAULT_ORG_ID;
  const mode = await getRefsValidatorMode(client, orgId);

  const validation = validateProposalEvidenceRefs(
    {
      action_payload: proposal.action_payload ?? {},
      provenance: proposal.provenance ?? {},
    },
    mode,
  );

  // Strict + invalid → reject; do not insert.
  if (mode === "strict" && !validation.ok) {
    return {
      ok: false,
      mode,
      reason: validation.errors.join("; "),
      warnings: validation.warnings,
    };
  }

  // Soft-warn + invalid → log a spine row, then insert anyway.
  if (mode === "soft-warn" && !validation.ok) {
    try {
      await recordEvidence(client, {
        event_type: "proposal.missing_evidence_refs",
        source: "insertProposalWithEvidenceCheck",
        channel: "audit",
        direction: "system",
        source_table: "ai_proposed_actions",
        source_id: String(proposal.action_type ?? "unknown") + ":" + Date.now(),
        job_id: (proposal.job_id as string) ?? null,
        contact_id: (proposal.contact_id as string) ?? null,
        match_method: proposal.job_id ? "direct_job_id" : "none",
        body_preview: `proposal.${proposal.action_type ?? "unknown"} missing evidence_refs: ${validation.errors.join("; ")}`.slice(0, 500),
        privacy_classification: "internal",
        retention_class: "90d_transient",
        payload: {
          action_type: proposal.action_type ?? null,
          errors: validation.errors,
          provenance_writer_role: (proposal.provenance as { writer_role?: string })?.writer_role ?? null,
        },
      }, {
        org_id: orgId,
        bypass_feature_flag: true,    // audit always-on
      });
    } catch { /* best-effort */ }
  }

  // Insert.
  try {
    const { data, error } = await client
      .from("ai_proposed_actions")
      .insert(proposal)
      .select("id")
      .single();
    if (error) {
      return { ok: false, mode, reason: error.message, warnings: validation.warnings };
    }
    return {
      ok: true,
      inserted_id: data?.id as string,
      mode,
      warnings: validation.warnings,
    };
  } catch (e) {
    return { ok: false, mode, reason: (e as Error).message, warnings: validation.warnings };
  }
}
