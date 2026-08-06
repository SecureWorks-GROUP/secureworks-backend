// Pure planning for the captain-approved make-safe board display cutover.
//
// Applying a plan appends to makesafe_board_status_applications. It never writes
// jobs, makesafe_job_details, assignments, invoices, messages, or notifications.

export const MAKESAFE_TERMINAL_DISPLAY_STATUSES = [
  "completed",
  "archive",
  "cancelled",
] as const;

/**
 * Release 12: the evidence engine says "the column is not proved" rather than
 * picking a plausible one. It is a real `canonical_stage` value, so every
 * planner over canonical rows has to recognise it — but it is never a ledger
 * `before_status` (the table CHECK rejects it) and never plannable: it is a
 * question for the Captain, parked with a reason.
 */
export const MAKESAFE_DECISION_REQUIRED_DISPLAY_STATUS =
  "decision_required" as const;

const TERMINAL_DISPLAY = new Set<string>(MAKESAFE_TERMINAL_DISPLAY_STATUSES);
const TERMINAL_JOB_STATES = new Set([
  "archived",
  "complete",
  "completed",
  "closed",
  "cancelled",
  "canceled",
  "lost",
  "deleted",
]);
const VALID_STATUSES = new Set([
  "new",
  "allocated",
  "trade_report_in",
  "report_ready",
  "completed",
  "archive",
  "cancelled",
]);

export interface MakesafeStatusApplyRow {
  id: string;
  job_number?: string | null;
  job_state?: string | null;
  declared_stage?: string | null;
  derived_stage_v2?: string | null;
  canonical_stage?: string | null;
  computed_status?: string | null;
  computed_status_reasons?: string[] | null;
  computed_status_missing?: string[] | null;
  computed_status_at?: string | null;
  computed_status_evidence?: {
    closeout_satisfied?: boolean | null;
    [key: string]: unknown;
  } | null;
}

export interface MakesafeStatusApplication {
  job_id: string;
  job_number: string | null;
  source_status: string;
  before_status: string;
  after_status: string;
  computed_at: string;
  computed_reasons: string[];
  computed_missing: string[];
}

export interface MakesafeStatusApplicationSkip {
  job_id: string | null;
  job_number: string | null;
  reason:
    | "not_found"
    | "terminal_display_status"
    | "terminal_job_status"
    | "missing_computed_status"
    | "missing_computed_evidence"
    | "decision_required_display_status"
    | "already_matches";
  current_status?: string | null;
  computed_status?: string | null;
}

function token(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function isMakesafeTerminalDisplayStatus(value: unknown): boolean {
  return TERMINAL_DISPLAY.has(token(value));
}

export function isMakesafeTerminalJobState(value: unknown): boolean {
  return TERMINAL_JOB_STATES.has(token(value));
}

export function isMakesafeDecisionRequiredDisplayStatus(
  value: unknown,
): boolean {
  return token(value) === MAKESAFE_DECISION_REQUIRED_DISPLAY_STATUS;
}

/**
 * The ONE producer of an overlay ledger row's `source_status`. Release 12 moved
 * placement to the evidence engine, so the anchor the reader compares against is
 * the engine's own pre-overlay answer (`derived_stage_v2`), falling back to
 * `canonical_stage` when a caller built the row without the diagnostic field.
 * Never `declared_stage`: the legacy ladder is provenance only, and stamping it
 * here writes a row the R12 reader can never bind and the guarded RPC rejects.
 */
export function makesafeOverlaySourceStatus(
  row: Pick<MakesafeStatusApplyRow, "derived_stage_v2" | "canonical_stage">,
): string {
  return token(row?.derived_stage_v2) || token(row?.canonical_stage);
}

export function countMakesafeBoardStages(
  rows: MakesafeStatusApplyRow[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows || []) {
    const stage = token(row.canonical_stage) || "unknown";
    counts[stage] = (counts[stage] || 0) + 1;
  }
  return counts;
}

export function planMakesafeStatusApplications(
  rows: MakesafeStatusApplyRow[],
  requestedJobNumbers?: string[] | null,
): {
  requested: number;
  transitions: MakesafeStatusApplication[];
  skipped: MakesafeStatusApplicationSkip[];
  before_counts: Record<string, number>;
  after_counts: Record<string, number>;
  terminal_untouched: {
    completed: number;
    archive: number;
    cancelled: number;
  };
} {
  const allRows = rows || [];
  const byNumber = new Map(
    allRows
      .filter((row) => row?.job_number)
      .map((row) => [String(row.job_number).toUpperCase(), row]),
  );
  const requested = requestedJobNumbers?.length
    ? [
      ...new Set(
        requestedJobNumbers.map((value) => String(value).trim().toUpperCase())
          .filter(Boolean),
      ),
    ]
    : allRows.map((row) => String(row.job_number || "").toUpperCase()).filter(
      Boolean,
    );
  const transitions: MakesafeStatusApplication[] = [];
  const skipped: MakesafeStatusApplicationSkip[] = [];

  for (const jobNumber of requested) {
    const row = byNumber.get(jobNumber);
    if (!row) {
      skipped.push({
        job_id: null,
        job_number: jobNumber,
        reason: "not_found",
      });
      continue;
    }
    const before = token(row.canonical_stage);
    const source = makesafeOverlaySourceStatus(row);
    const after = token(row.computed_status);
    if (isMakesafeDecisionRequiredDisplayStatus(before)) {
      skipped.push({
        job_id: row.id,
        job_number: row.job_number || null,
        reason: "decision_required_display_status",
        current_status: before,
        computed_status: after || null,
      });
      continue;
    }
    if (isMakesafeTerminalDisplayStatus(before)) {
      skipped.push({
        job_id: row.id,
        job_number: row.job_number || null,
        reason: "terminal_display_status",
        current_status: before,
        computed_status: after || null,
      });
      continue;
    }
    if (isMakesafeTerminalJobState(row.job_state)) {
      skipped.push({
        job_id: row.id,
        job_number: row.job_number || null,
        reason: "terminal_job_status",
        current_status: before || null,
        computed_status: after || null,
      });
      continue;
    }
    if (!after || !VALID_STATUSES.has(after)) {
      skipped.push({
        job_id: row.id,
        job_number: row.job_number || null,
        reason: "missing_computed_status",
        current_status: before || null,
        computed_status: after || null,
      });
      continue;
    }
    if (
      !row.computed_status_at ||
      !Array.isArray(row.computed_status_reasons) ||
      row.computed_status_reasons.length === 0
    ) {
      skipped.push({
        job_id: row.id,
        job_number: row.job_number || null,
        reason: "missing_computed_evidence",
        current_status: before || null,
        computed_status: after,
      });
      continue;
    }
    if (before === after) {
      skipped.push({
        job_id: row.id,
        job_number: row.job_number || null,
        reason: "already_matches",
        current_status: before,
        computed_status: after,
      });
      continue;
    }
    transitions.push({
      job_id: row.id,
      job_number: row.job_number || null,
      source_status: source,
      before_status: before,
      after_status: after,
      computed_at: row.computed_status_at,
      computed_reasons: row.computed_status_reasons || [],
      computed_missing: row.computed_status_missing || [],
    });
  }

  const beforeCounts = countMakesafeBoardStages(allRows);
  const afterCounts = { ...beforeCounts };
  for (const transition of transitions) {
    afterCounts[transition.before_status] = Math.max(
      0,
      (afterCounts[transition.before_status] || 0) - 1,
    );
    afterCounts[transition.after_status] =
      (afterCounts[transition.after_status] || 0) + 1;
  }

  return {
    requested: requested.length,
    transitions,
    skipped,
    before_counts: beforeCounts,
    after_counts: afterCounts,
    terminal_untouched: {
      completed: beforeCounts.completed || 0,
      archive: beforeCounts.archive || 0,
      cancelled: beforeCounts.cancelled || 0,
    },
  };
}
