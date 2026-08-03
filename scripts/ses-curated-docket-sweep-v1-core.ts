import {
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
  MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
  MAKESAFE_REPORT_CONTRACT_VERSION,
} from "../supabase/functions/ops-api/makesafe_report_render.ts";
import {
  canonicalSesJson,
  type SesPhysicalReportProof,
} from "../supabase/functions/ops-api/ses_docket_envelope.ts";

export const SWEEP_SCHEMA = "secureworks.ses-curated-docket-sweep/v1";
export const TRUSTED_PR_525_BOUNDARY =
  "1a3e31e137b5c03a639c6c27a55ff4d8ab1e9b9b";
export const REPORT_MAX_BYTES = 8 * 1024 * 1024;
export const MUTATION_EXCLUDED_JOB_NUMBER = "SWMS-261109";

export type SweepClassification =
  | "stale_legacy"
  | "contact_contract_stale"
  | "stale_provenance"
  | "already_current"
  | "protected_excluded"
  | "not_applicable_no_report";

export interface SweepRow {
  job_id: string;
  job_number: string;
  builder_reference: string | null;
  suburb: string | null;
  docket_revision_id: string;
  docket_artifact_hash: string | null;
  docket_object_key: string | null;
  artifact_metadata: Record<string, unknown> | null;
  family: string | null;
  source: Record<string, unknown>;
}

export interface SweepEntry {
  job_id: string;
  job_number: string;
  builder_reference: string | null;
  suburb: string | null;
  old_revision_id: string;
  old_artifact_hash: string | null;
  old_object_key: string | null;
  old_provenance: Record<string, unknown> | null;
  classification: SweepClassification;
  selection: "selected" | "already_current" | "excluded" | "not_applicable";
  searched_sources: string[];
  rejected_candidates: Array<{ source: string; code: string }>;
  selected_source: SesPhysicalReportProof | null;
  render_hash: string | null;
  report_input_hash: string | null;
  render_size_bytes: number | null;
  max_size_bytes: number;
  new_document_id: string | null;
  new_revision_id: string | null;
  refusal: { code: string; remedy: string } | null;
  verification_state: "dry_run_proven" | "not_selected" | "applied" | "refused";
}

export function classifySweepRow(row: SweepRow): SweepClassification {
  if (!row.docket_object_key) return "not_applicable_no_report";
  if (row.job_number === MUTATION_EXCLUDED_JOB_NUMBER) {
    return "protected_excluded";
  }
  const metadata = row.artifact_metadata || {};
  const contract = metadata.report_contract_version;
  const renderer = metadata.report_renderer_version;
  const source = metadata.evidence_source;
  const hash = String(metadata.render_hash || "").replace(/^sha256:/, "");
  const outputHash = String(metadata.output_sha256 || "").replace(
    /^sha256:/,
    "",
  );
  const expectedHash = String(metadata.expected_raw_sha256 || "").replace(
    /^sha256:/,
    "",
  );
  const reportDocumentId = typeof metadata.report_document_id === "string"
    ? metadata.report_document_id.trim()
    : "";
  const sourceIdentity = typeof metadata.source_identity === "string"
    ? metadata.source_identity.trim()
    : "";
  const sourceKind = metadata.source_kind;
  const sourceRevisionId = typeof metadata.source_revision_id === "string"
    ? metadata.source_revision_id.trim()
    : "";
  const sourceArtifactId = typeof metadata.source_artifact_id === "string"
    ? metadata.source_artifact_id.trim()
    : "";
  const sourceArtifactContentHash = String(
    metadata.source_artifact_content_hash || "",
  );
  const trusted = contract === MAKESAFE_REPORT_CONTRACT_VERSION &&
    source === "current_cycle_curated_makesafe_report" &&
    (sourceKind === "durable_curated_revision" ||
      sourceKind === "previously_committed_pdf") &&
    sourceIdentity.length > 0 && sourceIdentity !== reportDocumentId &&
    /^[a-f0-9]{64}$/.test(hash) && hash === outputHash &&
    outputHash === expectedHash && reportDocumentId.length > 0 &&
    sourceRevisionId.length > 0 && sourceArtifactId.length > 0 &&
    sourceIdentity.includes(sourceRevisionId) &&
    sourceIdentity.includes(sourceArtifactId) &&
    /^sha256:[a-f0-9]{64}$/.test(sourceArtifactContentHash);
  if (trusted) return "already_current";
  if (contract === MAKESAFE_REPORT_CONTRACT_VERSION && renderer) {
    return "contact_contract_stale";
  }
  if (Object.keys(metadata).every((key) => key === "render_hash")) {
    return "stale_legacy";
  }
  return "stale_provenance";
}

export function selectedClassification(value: SweepClassification): boolean {
  return ["stale_legacy", "contact_contract_stale", "stale_provenance"]
    .includes(value);
}

export function validSweepSourceProof(
  value: unknown,
): value is SesPhysicalReportProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  const sourceKind = proof.source_kind;
  const sourceIdentity = String(proof.source_identity || "");
  const sourceRevisionId = String(proof.source_revision_id || "");
  const sourceArtifactId = String(proof.source_artifact_id || "");
  return (sourceKind === "durable_curated_revision" ||
    sourceKind === "previously_committed_pdf") &&
    String(proof.source_document_id || "").length > 0 &&
    sourceRevisionId.length > 0 && sourceArtifactId.length > 0 &&
    sourceIdentity.includes(sourceRevisionId) &&
    sourceIdentity.includes(sourceArtifactId) &&
    /^sha256:[a-f0-9]{64}$/.test(
      String(proof.source_artifact_content_hash || ""),
    ) &&
    /^sha256:[a-f0-9]{64}$/.test(String(proof.expected_raw_sha256 || "")) &&
    (proof.report_input_hash === undefined ||
      /^sha256:[a-f0-9]{64}$/.test(String(proof.report_input_hash)));
}

export function emptyEntry(row: SweepRow): SweepEntry {
  const classification = classifySweepRow(row);
  const selection = selectedClassification(classification)
    ? "selected"
    : classification === "already_current"
    ? "already_current"
    : classification === "not_applicable_no_report"
    ? "not_applicable"
    : "excluded";
  return {
    job_id: row.job_id,
    job_number: row.job_number,
    builder_reference: row.builder_reference,
    suburb: row.suburb,
    old_revision_id: row.docket_revision_id,
    old_artifact_hash: row.docket_artifact_hash,
    // Storage filenames can embed street addresses. Revision + artifact hashes
    // are the reviewed drift boundary; never copy the object key into manifests.
    old_object_key: null,
    old_provenance: row.artifact_metadata,
    classification,
    selection,
    searched_sources: [],
    rejected_candidates: [],
    selected_source: null,
    render_hash: null,
    report_input_hash: null,
    render_size_bytes: null,
    max_size_bytes: REPORT_MAX_BYTES,
    new_document_id: null,
    new_revision_id: null,
    refusal: classification === "protected_excluded"
      ? {
        code: "captain_corrected_artifact_mutation_excluded",
        remedy:
          "Prove candidate and currently served raw PDF bytes are identical before any touch.",
      }
      : null,
    verification_state: selectedClassification(classification)
      ? "refused"
      : "not_selected",
  };
}

export interface SweepDependencies {
  prepare(row: SweepRow, args: {
    dry_run: boolean;
    expected_physical_report_proof?: SesPhysicalReportProof;
  }): Promise<{
    revision_id: string | null;
    source: SesPhysicalReportProof | null;
    refusal?: { code: string; remedy: string };
  }>;
}

export async function runGuardedSweep(
  rows: SweepRow[],
  deps: SweepDependencies,
  mode: "dry_run" | "apply",
  reviewedEntries: SweepEntry[] = [],
): Promise<SweepEntry[]> {
  const reviewed = new Map(
    reviewedEntries.map((entry) => [entry.job_id, entry]),
  );
  const output: SweepEntry[] = [];
  for (const row of rows) {
    const entry = emptyEntry(row);
    if (!selectedClassification(entry.classification)) {
      output.push(entry);
      continue;
    }
    entry.searched_sources = [
      "makesafe_docket_revisions.current_cycle",
      "makesafe_docket_artifacts.supporting_report_pdf",
      "job_documents.provenance",
    ];
    entry.rejected_candidates = [{
      source: "raw_trade_report_fields",
      code: "raw_trade_fields_not_curated_authority",
    }];
    try {
      let expected: SesPhysicalReportProof | undefined;
      if (mode === "apply") {
        const prior = reviewed.get(row.job_id);
        if (
          !prior || prior.verification_state !== "dry_run_proven" ||
          prior.old_revision_id !== row.docket_revision_id ||
          prior.old_artifact_hash !== row.docket_artifact_hash ||
          !prior.selected_source
        ) {
          entry.refusal = {
            code: "reviewed_target_drift",
            remedy: "Run and review a new prepare-only dry-run manifest.",
          };
          output.push(entry);
          continue;
        }
        expected = prior.selected_source;
      }
      const prepared = await deps.prepare(row, {
        dry_run: mode === "dry_run",
        ...(expected ? { expected_physical_report_proof: expected } : {}),
      });
      if (prepared.refusal) {
        entry.refusal = prepared.refusal;
        output.push(entry);
        continue;
      }
      if (!validSweepSourceProof(prepared.source)) {
        entry.refusal = {
          code: "curated_source_missing",
          remedy:
            "Bind an independently curated revision or exact previously committed PDF artifact with both its artifact content hash and raw PDF SHA-256.",
        };
        output.push(entry);
        continue;
      }
      if (mode === "apply" && !prepared.revision_id) {
        entry.refusal = {
          code: "persistent_prepare_refused",
          remedy:
            "The source-bound persistent prepare did not commit a revision; inspect its blockers and run a new dry-run.",
        };
        output.push(entry);
        continue;
      }
      if (
        expected &&
        canonicalSesJson(expected) !== canonicalSesJson(prepared.source)
      ) {
        entry.refusal = {
          code: "reviewed_candidate_drift",
          remedy: "Run and review a new prepare-only dry-run manifest.",
        };
        output.push(entry);
        continue;
      }
      entry.selected_source = prepared.source;
      entry.render_hash = prepared.source.expected_raw_sha256.slice(7);
      entry.report_input_hash = prepared.source.report_input_hash || null;
      entry.verification_state = mode === "dry_run"
        ? "dry_run_proven"
        : "applied";
      entry.new_revision_id = mode === "apply" ? prepared.revision_id : null;
      entry.refusal = null;
    } catch (error) {
      entry.refusal = {
        code: error instanceof SweepRefusal
          ? error.code
          : "prepare_only_orchestration_failed",
        remedy: error instanceof Error ? error.message : String(error),
      };
    }
    output.push(entry);
  }
  return output;
}

export class SweepRefusal extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function sweepBoundary() {
  return {
    pr_525_commit: TRUSTED_PR_525_BOUNDARY,
    report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
    renderer_source_revision: MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
    renderer_version: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
    orchestration: "prepare-only-curated-source/v2",
  };
}
