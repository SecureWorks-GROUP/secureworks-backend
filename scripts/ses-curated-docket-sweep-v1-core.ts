import {
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
  MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
  MAKESAFE_REPORT_CONTRACT_VERSION,
} from "../supabase/functions/ops-api/makesafe_report_render.ts";

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

export interface SweepRender {
  bytes: Uint8Array;
  pdf_sha256: string;
  report_input_hash: string;
  report_job: Record<string, unknown>;
  searched_sources: string[];
  rejected_candidates: Array<{ source: string; code: string }>;
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
  const reportDocumentId = typeof metadata.report_document_id === "string"
    ? metadata.report_document_id.trim()
    : "";
  const trusted = contract === MAKESAFE_REPORT_CONTRACT_VERSION &&
    renderer === MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION &&
    source === "current_cycle_curated_makesafe_report" &&
    /^[a-f0-9]{64}$/.test(hash) && reportDocumentId.length > 0;
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
  render(row: SweepRow): Promise<SweepRender>;
  attach?(row: SweepRow, rendered: SweepRender): Promise<{
    document_id: string;
    skipped: boolean;
  }>;
  prepare?(row: SweepRow, rendered: SweepRender): Promise<{
    revision_id: string;
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
    if (mode === "apply") {
      const prior = reviewed.get(row.job_id);
      if (
        !prior || prior.selection !== "selected" ||
        prior.old_revision_id !== row.docket_revision_id ||
        prior.old_artifact_hash !== row.docket_artifact_hash
      ) {
        entry.refusal = {
          code: "reviewed_target_drift",
          remedy: "Run and review a new production dry-run manifest.",
        };
        output.push(entry);
        continue;
      }
    }
    try {
      const rendered = await deps.render(row);
      entry.searched_sources = rendered.searched_sources;
      entry.rejected_candidates = rendered.rejected_candidates;
      entry.render_hash = rendered.pdf_sha256;
      entry.report_input_hash = rendered.report_input_hash;
      entry.render_size_bytes = rendered.bytes.byteLength;
      if (rendered.bytes.byteLength > REPORT_MAX_BYTES) {
        entry.refusal = {
          code: "current_wiki_report_oversize",
          remedy:
            "Resolve source-image size while retaining every applicable photo, then rerun dry-run.",
        };
        output.push(entry);
        continue;
      }
      if (mode === "dry_run") {
        entry.verification_state = "dry_run_proven";
        entry.refusal = null;
        output.push(entry);
        continue;
      }
      const prior = reviewed.get(row.job_id)!;
      if (
        prior.render_hash !== rendered.pdf_sha256 ||
        prior.report_input_hash !== rendered.report_input_hash
      ) {
        entry.refusal = {
          code: "reviewed_candidate_drift",
          remedy: "Run and review a new production dry-run manifest.",
        };
        output.push(entry);
        continue;
      }
      if (!deps.attach || !deps.prepare) {
        throw new Error("apply dependencies unavailable");
      }
      const attached = await deps.attach(row, rendered);
      const prepared = await deps.prepare(row, rendered);
      entry.new_document_id = attached.document_id;
      entry.new_revision_id = prepared.revision_id;
      entry.verification_state = "applied";
      entry.refusal = null;
    } catch (error) {
      entry.refusal = {
        code: error instanceof SweepRefusal
          ? error.code
          : "candidate_reconstruction_failed",
        remedy: error instanceof Error ? error.message : String(error),
      };
      entry.verification_state = "refused";
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
  };
}
