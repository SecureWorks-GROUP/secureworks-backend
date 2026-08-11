import {
  type DraftPackContext,
  type DraftPackOutput,
} from "./makesafe_draft_pack.ts";
import {
  projectDraftPackReport,
} from "./makesafe_draft_pack_report_projection.ts";

export const SES_REVIEW_PACK_MATERIALS_VERSION = "ses-review-pack-materials/v1";

type ReviewConfidence = "high" | "medium" | "low";

export interface SesReviewPackMaterials {
  version: typeof SES_REVIEW_PACK_MATERIALS_VERSION;
  selected_source: Record<string, unknown>;
  make_safe_report: Record<string, unknown>;
  draft_zero_invoice: Record<string, unknown> | null;
  assumptions_for_attention: Array<Record<string, unknown>>;
  source_selection: {
    state: "selected" | "missing" | "review_attention" | "identity_hard";
    candidates: Array<Record<string, unknown>>;
    blocker: Record<string, unknown> | null;
  };
  rule_inputs: Record<string, unknown>;
  review_only_capabilities: {
    xero_draft_creation: "not_executed";
    approve: false;
    send: false;
    void: false;
    stage_mutation: false;
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hash(value: unknown): string | null {
  const candidate = text(value);
  return /^sha256:[0-9a-f]{64}$/i.test(candidate) ? candidate : null;
}

function sourceIdentity(
  report: Record<string, unknown>,
  cycleId: string | null,
): string | null {
  const id = text(report.id);
  if (!id) return null;
  const cycle = text(report.attendance_cycle_id) || text(cycleId);
  return `job_service_reports:${id}${cycle ? `#cycle=${cycle}` : ""}`;
}

function candidatesFrom(
  report: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const raw = Array.isArray(report.source_candidates)
    ? report.source_candidates
    : [];
  return raw.map((candidate, index) => {
    const row = record(candidate);
    return {
      identity: text(row.identity) || text(row.id) || `candidate-${index + 1}`,
      content_hash: hash(
        row.content_hash || row.source_content_hash || row.hash,
      ),
      selected: row.selected === true,
    };
  });
}

function sourceSelection(
  report: Record<string, unknown> | null,
): SesReviewPackMaterials["source_selection"] {
  if (!report) return { state: "missing", candidates: [], blocker: null };
  const candidates = candidatesFrom(report);
  const hashes = new Set(
    candidates.map((candidate) => candidate.content_hash).filter(Boolean),
  );
  const conflict = report.source_conflict === true || hashes.size > 1 ||
    (candidates.length > 1 &&
      candidates.filter((item) => item.selected).length > 1);
  const identityHard = report.wrong_job === true ||
    report.cross_cycle === true || report.provenance_mismatch === true;
  return {
    state: identityHard
      ? "identity_hard"
      : conflict
      ? "review_attention"
      : "selected",
    candidates,
    blocker: conflict || identityHard
      ? {
        code: identityHard
          ? "source_identity_ambiguity"
          : "source_selection_conflict",
        category: "source_selection",
        fact: identityHard
          ? "The source evidence cannot be safely attributed to this job or attendance cycle."
          : "Safely attributable source alternatives are retained for Captain review; no source was silently discarded.",
        recovery_action: identityHard
          ? "Recover the exact job, source-instruction and attendance-cycle binding before review or release."
          : "Select the exact source before any release or send action.",
        candidates,
      }
      : null,
  };
}

function reportProjection(
  output: DraftPackOutput | null,
  selectedSource: Record<string, unknown>,
  context: DraftPackContext,
  exceptionReview: Record<string, unknown> | null,
): Record<string, unknown> {
  const exceptionProjection = () => {
    if (!exceptionReview) return null;
    // A wrong-card, incoherent source or unavailable/incomplete canonical
    // output must never donate report prose to this card. It still receives a
    // complete, explicitly non-assertive exception report for review.
    const job = record(context.job);
    const detail = record(context.detail);
    const reference = text(detail.external_ref) || text(job.job_number) ||
      text(job.id) || "Reference unavailable";
    return {
      kind: "draft_pack_exception_review",
      state: "complete",
      exception_review: exceptionReview,
      source_identity: selectedSource.source_identity || null,
      report: {
        ref: reference,
        address: text(job.site_address) || text(job.site_suburb) ||
          "Address pending confirmation",
        contact: "",
        date: "",
        arrival: "",
        crew: "",
        billing_note: "Draft-zero exception review only.",
        scope:
          "Exception review pack generated without importing unbound report content.",
        findings: text(exceptionReview.reason) ||
          "The evidence requires review before release.",
        works:
          "No work-completion statement is asserted until the selected case evidence is confirmed.",
        materials:
          "Materials are unknown; no material charge has been selected.",
        photos: [],
        photo_limit: 0,
      },
    };
  };
  if (!output) {
    const exception = exceptionProjection();
    if (exception) return exception;
    return {
      kind: "draft_pack_report_projection",
      state: "canonical_output_missing",
      report: null,
      missing_sections: ["canonical_draft_pack_output"],
      source_identity: selectedSource.source_identity || null,
    };
  }
  const required = ["scope", "findings", "works", "materials"] as const;
  const missingSections = required.filter((section) =>
    !text(output.report[section])
  );
  if (missingSections.length) {
    const exception = exceptionProjection();
    if (exception) return exception;
    return {
      kind: "draft_pack_report_projection",
      state: "canonical_output_incomplete",
      report: null,
      missing_sections: missingSections,
      source_identity: selectedSource.source_identity || null,
    };
  }
  const projected = projectDraftPackReport(output, context);
  return {
    kind: "draft_pack_report_projection",
    state: "complete",
    source_identity: selectedSource.source_identity || null,
    report: projected,
  };
}

export function buildSesReviewPackMaterials(args: {
  selected_trade_report: Record<string, unknown> | null;
  attendance_cycle_id: string | null;
  invoice_proposal: Record<string, unknown> | null;
  builder_key: string;
  builder_reference: string | null;
  family: string;
  location: string | null;
  invoice_basis: string | null;
  material_facts?: unknown;
  canonical_draft_pack_output?: DraftPackOutput | null;
  exception_review?: Record<string, unknown> | null;
  draft_pack_context: DraftPackContext;
  rule_inputs?: Record<string, unknown>;
}): SesReviewPackMaterials {
  const report = args.selected_trade_report;
  const sourceIdentityValue = sourceIdentity(
    report || {},
    args.attendance_cycle_id,
  );
  const selectedSource = {
    relation: "job_service_reports",
    id: report ? text(report.id) || null : null,
    source_identity: sourceIdentityValue,
    source_content_hash: report
      ? hash(report.source_content_hash || report.content_hash)
      : null,
    attendance_cycle_id: report
      ? text(report.attendance_cycle_id) || args.attendance_cycle_id || null
      : args.attendance_cycle_id,
    selection: report ? "current_attendance_cycle" : "none",
  };
  const selection = sourceSelection(report);
  const proposal = args.invoice_proposal;
  const canonicalOutput = args.canonical_draft_pack_output || null;
  const lines = proposal && Array.isArray(proposal.line_items)
    ? proposal.line_items.map((line, index) => {
      const row = record(line);
      const description = text(row.description) || `Line ${index + 1}`;
      const source = text(record(row.provenance).source) || "family_rule";
      const confidence = (text(record(row.provenance).confidence) ||
        "high") as ReviewConfidence;
      const unusual = record(row.provenance).unusual === true;
      const attention = unusual || confidence === "low";
      return {
        id: text(row.id) || `line-${index + 1}`,
        description,
        quantity: finiteNumber(row.quantity),
        unit_price_ex_gst: finiteNumber(
          row.unit_price_ex_gst ?? row.unit_price,
        ),
        amount_ex_gst: finiteNumber(row.amount_ex_gst ?? row.amount),
        provenance: {
          source,
          confidence,
          ...(attention
            ? {
              attention: "review_assumption",
              reason:
                "Captain review is required for this non-ordinary pricing assumption.",
            }
            : {}),
        },
      };
    })
    : [];
  const assumptions = lines.filter((line) => record(line.provenance).attention)
    .map((line) => ({
      line_id: line.id,
      description: line.description,
      ...record(line.provenance),
    }));
  return {
    version: SES_REVIEW_PACK_MATERIALS_VERSION,
    selected_source: selectedSource,
    make_safe_report: reportProjection(
      canonicalOutput,
      selectedSource,
      args.draft_pack_context,
      args.exception_review || null,
    ),
    draft_zero_invoice: proposal
      ? {
        state: "pre_authorisation_review_only",
        proposal,
        line_items: lines,
        subtotal_ex_gst: finiteNumber(proposal.subtotal_ex_gst),
        total_inc_gst: finiteNumber(proposal.total_inc_gst),
      }
      : null,
    assumptions_for_attention: assumptions,
    source_selection: selection,
    rule_inputs: {
      builder_key: args.builder_key,
      family: args.family,
      location: args.location,
      invoice_basis: args.invoice_basis,
      ...(args.rule_inputs || {}),
    },
    review_only_capabilities: {
      xero_draft_creation: "not_executed",
      approve: false,
      send: false,
      void: false,
      stage_mutation: false,
    },
  };
}
