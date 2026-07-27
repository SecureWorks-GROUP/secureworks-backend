import {
  isMakesafeTerminalDisplayStatus,
  isMakesafeTerminalJobState,
  type MakesafeStatusApplication,
} from "./makesafe_status_apply.ts";
import type {
  BlockerFact,
  MakesafeStateV2,
} from "./makesafe_state_projection.ts";

const VALID_DISPLAY_STAGES = new Set([
  "new",
  "allocated",
  "trade_report_in",
  "report_ready",
  "completed",
  "archive",
  "cancelled",
]);

const STAGE_RANK = new Map([
  ["new", 0],
  ["allocated", 1],
  ["trade_report_in", 2],
  ["report_ready", 3],
  ["completed", 4],
  ["archive", 5],
  ["cancelled", 6],
]);

export interface MakesafeCaptainAction {
  code: string;
  message: string;
  since: string;
  evidence_refs: string[];
}

export interface MakesafeAttentionApplication extends MakesafeCaptainAction {
  job_id: string;
  job_number: string;
  attendance_cycle_id: string | null;
  state: "active" | "resolved";
  computed_at: string;
}

export interface MakesafeReconcileRow {
  id?: string | null;
  job_number?: string | null;
  job_state?: string | null;
  declared_stage?: string | null;
  canonical_stage?: string | null;
  captain_action?: MakesafeCaptainAction | null;
  state_v2?: MakesafeStateV2 | null;
}

export interface MakesafeReconciliationPlan {
  requested: number;
  trustworthy: number;
  captain_marked: number;
  neither: number;
  transitions: MakesafeStatusApplication[];
  attention_applications: MakesafeAttentionApplication[];
  outcomes: Array<{
    job_id: string;
    job_number: string;
    outcome: "trustworthy" | "captain_marked";
    displayed_status: string;
    fact_derived_status: string | null;
    reason: string;
  }>;
}

function token(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function sentence(value: unknown): string {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function effectiveDisplayStage(state: MakesafeStateV2): string {
  return state.cancellation.state === "confirmed"
    ? "cancelled"
    : state.ops_stage;
}

function firstBlocker(
  state: MakesafeStateV2,
  codes: string[],
): BlockerFact | null {
  return state.blocker.active.find((item) => codes.includes(item.code)) || null;
}

function attentionFor(
  row:
    & Required<Pick<MakesafeReconcileRow, "id" | "job_number">>
    & MakesafeReconcileRow,
  state: MakesafeStateV2,
  before: string,
  derived: string,
): MakesafeAttentionApplication {
  const terminalProtected = isMakesafeTerminalDisplayStatus(before) ||
    isMakesafeTerminalJobState(row.job_state);
  const family = firstBlocker(state, ["missing_family_rule"]);
  const cycle = firstBlocker(state, ["backfill_cycle_scope"]);
  const intake = firstBlocker(state, [
    "intake_exception",
    "missing_job_binding",
  ]);
  const input = firstBlocker(state, ["projection_input_error"]);
  const diagnostic = state.diagnostics.find((item) =>
    item.code === "projection_input_error" && item.severity === "hard"
  );
  let code = "status_evidence_review";
  let message: string;
  let evidenceRefs: string[] = [];

  if (terminalProtected && before !== derived) {
    code = "terminal_status_ruling";
    message =
      `Need you to confirm whether this job should stay ${before} or be reopened at ${derived}; ` +
      `${sentence(state.stage_evidence.reason)}`;
    evidenceRefs = state.stage_evidence.evidence_refs;
  } else if (cycle) {
    code = "attendance_cycle_ruling";
    message =
      `Need you to choose which attendance cycle owns the ambiguous evidence; ${
        sentence(cycle.recovery_instruction)
      }`;
    evidenceRefs = cycle.evidence_refs;
  } else if (family) {
    code = "family_rule_ruling";
    message = `Need you to decide the completion rule for this job family; ${
      sentence(family.recovery_instruction)
    }`;
    evidenceRefs = family.evidence_refs;
  } else if (intake) {
    code = "intake_authority_ruling";
    message = `Need you to decide which intake instruction owns this job; ${
      sentence(intake.recovery_instruction)
    }`;
    evidenceRefs = intake.evidence_refs;
  } else {
    code = "state_input_repair";
    const repair = input?.recovery_instruction ||
      diagnostic?.reason ||
      state.stage_evidence.reason;
    message =
      `Need you to assign the state-evidence repair before trusting this card: ${
        sentence(repair)
      }`;
    evidenceRefs = [
      ...(input?.evidence_refs || []),
      ...(diagnostic?.evidence_refs || []),
    ];
  }

  return {
    job_id: String(row.id),
    job_number: String(row.job_number),
    attendance_cycle_id: state.identity.current_attendance_cycle_id,
    state: "active",
    code,
    message: sentence(message),
    since: state.computed_at,
    evidence_refs: [...new Set(evidenceRefs.filter(Boolean))],
    computed_at: state.computed_at,
  };
}

function correctionEvidence(state: MakesafeStateV2): {
  reasons: string[];
  refs: string[];
} {
  const reason = sentence(state.stage_evidence.reason);
  return {
    reasons: [
      reason,
      ...(state.stage_evidence.evidence_refs.length
        ? [`Evidence: ${state.stage_evidence.evidence_refs.join(", ")}`]
        : []),
    ],
    refs: state.stage_evidence.evidence_refs,
  };
}

function stageIsDeterminate(
  state: MakesafeStateV2,
  before: string,
  derived: string,
): boolean {
  if (
    state.cancellation.state === "confirmed" &&
    !!state.cancellation.decision_id
  ) return true;
  if (!state.stage_evidence.determinate) return false;
  if (
    state.diagnostics.some((item) =>
      item.code === "projection_input_error" && item.severity === "hard"
    )
  ) return false;
  if (
    firstBlocker(state, [
      "projection_input_error",
      "backfill_cycle_scope",
      "intake_exception",
      "missing_job_binding",
    ])
  ) return false;
  const missingFamily = firstBlocker(state, ["missing_family_rule"]);
  if (missingFamily) {
    const beforeRank = STAGE_RANK.get(before) ?? Number.POSITIVE_INFINITY;
    const derivedRank = STAGE_RANK.get(derived) ?? Number.NEGATIVE_INFINITY;
    if (beforeRank > derivedRank || derivedRank > 1) return false;
  }
  return true;
}

function resolvedAttention(
  row:
    & Required<Pick<MakesafeReconcileRow, "id" | "job_number">>
    & MakesafeReconcileRow,
  state: MakesafeStateV2,
): MakesafeAttentionApplication | null {
  if (!row.captain_action) return null;
  return {
    job_id: String(row.id),
    job_number: String(row.job_number),
    attendance_cycle_id: state.identity.current_attendance_cycle_id,
    state: "resolved",
    code: "status_now_trustworthy",
    message:
      "The fact-derived status is now trustworthy; no Captain action remains.",
    since: state.computed_at,
    evidence_refs: state.stage_evidence.evidence_refs,
    computed_at: state.computed_at,
  };
}

export function planMakesafeStateReconciliation(
  rows: MakesafeReconcileRow[],
): MakesafeReconciliationPlan {
  const transitions: MakesafeStatusApplication[] = [];
  const attentionApplications: MakesafeAttentionApplication[] = [];
  const outcomes: MakesafeReconciliationPlan["outcomes"] = [];
  const seen = new Set<string>();
  let trustworthy = 0;
  let captainMarked = 0;

  for (const row of rows || []) {
    const jobId = String(row?.id || "").trim();
    const jobNumber = String(row?.job_number || "").trim();
    if (!jobId || !jobNumber || seen.has(jobId)) {
      throw new Error(
        !jobId || !jobNumber
          ? "Every reconciliation row requires a job id and job number."
          : `Duplicate reconciliation job id ${jobId}.`,
      );
    }
    seen.add(jobId);
    const state = row.state_v2;
    const before = token(row.canonical_stage);
    const source = token(row.declared_stage || row.canonical_stage);
    if (!state || !VALID_DISPLAY_STAGES.has(before) || !source) {
      throw new Error(
        `Job ${jobNumber} is missing its v2 state or displayed status.`,
      );
    }
    const derived = effectiveDisplayStage(state);
    const determinate = stageIsDeterminate(state, before, derived);
    const terminalProtected = isMakesafeTerminalDisplayStatus(before) ||
      isMakesafeTerminalJobState(row.job_state);
    const typedRow = {
      ...row,
      id: jobId,
      job_number: jobNumber,
    };

    if (!determinate || (terminalProtected && before !== derived)) {
      const attention = attentionFor(typedRow, state, before, derived);
      attentionApplications.push(attention);
      captainMarked += 1;
      outcomes.push({
        job_id: jobId,
        job_number: jobNumber,
        outcome: "captain_marked",
        displayed_status: before,
        fact_derived_status: determinate ? derived : null,
        reason: attention.message,
      });
      continue;
    }

    if (before !== derived) {
      const evidence = correctionEvidence(state);
      transitions.push({
        job_id: jobId,
        job_number: jobNumber,
        source_status: source,
        before_status: before,
        after_status: derived,
        computed_at: state.computed_at,
        computed_reasons: evidence.reasons,
        computed_missing: [],
      });
    }
    const resolution = resolvedAttention(typedRow, state);
    if (resolution) attentionApplications.push(resolution);
    trustworthy += 1;
    outcomes.push({
      job_id: jobId,
      job_number: jobNumber,
      outcome: "trustworthy",
      displayed_status: before,
      fact_derived_status: derived,
      reason: state.stage_evidence.reason,
    });
  }

  return {
    requested: (rows || []).length,
    trustworthy,
    captain_marked: captainMarked,
    neither: (rows || []).length - trustworthy - captainMarked,
    transitions,
    attention_applications: attentionApplications,
    outcomes,
  };
}
