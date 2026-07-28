// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE — SLA latency (email received -> card created) — B5
// Mission: fix/makesafe-board-hardening (zero-mistakes wave 2B)
// ════════════════════════════════════════════════════════════
//
// The email->board-card pipeline is a 2-minute cron. This computes the arrival->card
// latency so the cadence is PROVABLE: per-scan (folded into makesafe_intake_health as
// a last-scan snapshot) and 24h-rolling (computed on read in the intake_health action
// from the per-draft created_at/received_at columns). Pure + deterministic — no I/O,
// no dependencies — so it is trivially unit-testable.
//
// received_at on a draft = the email's received timestamp (set at parse time).
// created_at on a draft   = when scanSesMakesafes inserted the row.
// latency  = created_at - received_at, clamped to >= 0 (a negative delta means clock
//            skew / a mis-stamped received_at; it is dropped, never counted negative).

import { contentFingerprintChecks } from "./makesafe_intake_dedup.ts";
import type { IntakeReconcileInvariantItem } from "./makesafe_intake_reconciliation.ts";
import { SYNTHETIC_LIVEFIRE_MARKER_PREFIX } from "./makesafe_synthetic_livefire.ts";

export interface SlaLatencyRow {
  received_at?: string | null;
  created_at?: string | null;
}

export interface SlaLatencySummary {
  samples: number;
  p50_sec: number;
  p95_sec: number;
  max_sec: number;
}

/** Nearest-rank percentile (0..1) over an ascending-sorted numeric array. */
function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = Math.ceil(q * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

/**
 * Compute p50/p95/max of the received->created latency (in whole seconds) over the
 * given draft rows. Rows missing either timestamp, or with an unparseable / negative
 * delta, are excluded (never counted). Returns all-zero when there are no valid rows.
 */
export function computeLatencySla(
  rows: SlaLatencyRow[] | null | undefined,
): SlaLatencySummary {
  const deltas: number[] = [];
  for (const r of rows || []) {
    const rec = r?.received_at ? Date.parse(r.received_at) : NaN;
    const cre = r?.created_at ? Date.parse(r.created_at) : NaN;
    if (Number.isNaN(rec) || Number.isNaN(cre)) continue;
    const sec = Math.round((cre - rec) / 1000);
    if (sec < 0) continue; // clock skew / mis-stamp — do not count a negative latency
    deltas.push(sec);
  }
  if (deltas.length === 0) {
    return { samples: 0, p50_sec: 0, p95_sec: 0, max_sec: 0 };
  }
  deltas.sort((a, b) => a - b);
  return {
    samples: deltas.length,
    p50_sec: percentile(deltas, 0.5),
    p95_sec: percentile(deltas, 0.95),
    max_sec: deltas[deltas.length - 1],
  };
}

export type LogicalIntakeSlaOutcome =
  | "job_on_board_within_300s"
  | "terminal_non_work_fate_within_300s"
  | "missed_or_late";

export interface LogicalIntakeSlaCaseSource {
  post_id?: string | null;
  internet_message_id?: string | null;
  received_at?: string | null;
  raw_identity_json?: unknown;
}

export interface LogicalIntakeSlaCase {
  id: string;
  state: string;
  job_id?: string | null;
  received_at?: string | null;
  last_decision_at?: string | null;
  raw_identity_json?: unknown;
  makesafe_intake_case_sources?: LogicalIntakeSlaCaseSource[] | null;
  jobs?:
    | {
      id?: string | null;
      created_at?: string | null;
    }
    | Array<{
      id?: string | null;
      created_at?: string | null;
    }>
    | null;
}

export interface LogicalIntakeSlaBoardRow {
  id: string;
  canonical_stage?: string | null;
  ses_family?: string | null;
}

export interface LogicalIntakeSlaNotification {
  case_id?: string | null;
  job_id?: string | null;
  state?: string | null;
  attempted_at?: string | null;
  provider_accepted_at?: string | null;
}

export interface LogicalIntakeSlaInput {
  nowIso: string;
  windowStartIso: string;
  cases: readonly LogicalIntakeSlaCase[];
  boardRows: readonly LogicalIntakeSlaBoardRow[];
  notifications: readonly LogicalIntakeSlaNotification[];
  unaccountedItems: readonly IntakeReconcileInvariantItem[];
  sourceReadComplete: boolean;
}

export interface LogicalIntakeSlaSummary {
  target_sec: 300;
  window_start: string;
  generated_at: string;
  grain: "eligible_logical_email";
  stop_basis: "job_created_at_with_current_canonical_board_confirmation";
  complete: boolean;
  denominator_matured: number;
  pending_within_300s: number;
  raw_source_rows: number;
  logical_email_groups: number;
  unaccounted_logical_groups: number;
  outcomes: Record<LogicalIntakeSlaOutcome, number>;
  hugo_notification: {
    physical_jobs_in_denominator: number;
    provider_accepted_within_300s: number;
    missed_or_late: number;
  };
  missed_sample: Array<{
    grain_id: string;
    received_at: string | null;
    job_id: string | null;
    reason: string;
  }>;
}

const LOGICAL_SLA_TARGET_SECONDS = 300;
const PHYSICAL_FAMILIES = new Set([
  "physical_makesafe",
  "temporary_fencing",
]);

function timestamp(value: string | null | undefined): number | null {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function firstTimestamp(
  values: Array<string | null | undefined>,
): string | null {
  let earliest: { raw: string; ms: number } | null = null;
  for (const value of values) {
    const ms = timestamp(value);
    if (ms === null || !value) continue;
    if (!earliest || ms < earliest.ms) earliest = { raw: value, ms };
  }
  return earliest?.raw || null;
}

function embeddedJob(row: LogicalIntakeSlaCase): {
  id?: string | null;
  created_at?: string | null;
} | null {
  if (Array.isArray(row.jobs)) return row.jobs[0] || null;
  return row.jobs || null;
}

function containsSyntheticMarker(value: unknown): boolean {
  try {
    return JSON.stringify(value ?? "").includes(
      SYNTHETIC_LIVEFIRE_MARKER_PREFIX,
    );
  } catch {
    return false;
  }
}

function caseIsSynthetic(row: LogicalIntakeSlaCase): boolean {
  if (containsSyntheticMarker(row.raw_identity_json)) return true;
  return (row.makesafe_intake_case_sources || []).some((source) =>
    containsSyntheticMarker(source.raw_identity_json)
  );
}

function itemIsSynthetic(item: IntakeReconcileInvariantItem): boolean {
  return containsSyntheticMarker([
    item.subject,
    item.raw_reference,
    item.canonical_claim_ref,
    item.canonical_po_ref,
  ]);
}

function logicalTokens(item: IntakeReconcileInvariantItem): string[] {
  const tokens = new Set<string>();
  const internetId = String(item.internet_message_id || "").trim()
    .toLowerCase();
  if (internetId) tokens.add(`internet:${internetId}`);
  // An explicit claim is the stronger discriminator. Never also emit the PO
  // token for that row: two distinct explicit claims can legitimately share a
  // builder PO and must remain two logical emails.
  const discriminator = item.canonical_claim_ref ||
    item.canonical_po_ref ||
    item.raw_reference ||
    null;
  for (
    const fingerprint of contentFingerprintChecks(
      item.from_email,
      item.subject,
      item.received_at,
      discriminator,
      null,
    )
  ) {
    tokens.add(`fingerprint:${fingerprint}`);
  }
  return [...tokens];
}

function groupUnaccountedItems(
  items: readonly IntakeReconcileInvariantItem[],
): IntakeReconcileInvariantItem[][] {
  const parents = items.map((_, index) => index);
  const find = (index: number): number => {
    let cursor = index;
    while (parents[cursor] !== cursor) {
      parents[cursor] = parents[parents[cursor]];
      cursor = parents[cursor];
    }
    return cursor;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const tokenOwner = new Map<string, number>();
  items.forEach((item, index) => {
    for (const token of logicalTokens(item)) {
      const owner = tokenOwner.get(token);
      if (owner === undefined) tokenOwner.set(token, index);
      else union(index, owner);
    }
  });
  const groups = new Map<number, IntakeReconcileInvariantItem[]>();
  items.forEach((item, index) => {
    const root = find(index);
    const group = groups.get(root) || [];
    group.push(item);
    groups.set(root, group);
  });
  return [...groups.values()];
}

function withinTarget(start: string | null, stop: string | null): boolean {
  const startMs = timestamp(start);
  const stopMs = timestamp(stop);
  if (startMs === null || stopMs === null || stopMs < startMs) return false;
  return stopMs - startMs <= LOGICAL_SLA_TARGET_SECONDS * 1000;
}

/**
 * Honest five-minute accounting over the canonical logical grain.
 *
 * A mature case contributes exactly one outcome. Raw unaccounted source rows are
 * collapsed across the known dual-capture identity and contribute missed outcomes
 * instead of disappearing from a success-only percentile. Cases younger than the
 * target remain visible as pending but do not enter the denominator until their
 * five-minute window closes.
 */
export function computeLogicalIntakeSla(
  input: LogicalIntakeSlaInput,
): LogicalIntakeSlaSummary {
  const nowMs = timestamp(input.nowIso);
  const windowStartMs = timestamp(input.windowStartIso);
  if (nowMs === null || windowStartMs === null) {
    throw new Error("logical intake SLA requires valid window timestamps");
  }

  const boardByJobId = new Map(
    input.boardRows.map((row) => [String(row.id), row]),
  );
  const notificationByJobId = new Map<string, LogicalIntakeSlaNotification>();
  for (const notification of input.notifications) {
    const jobId = String(notification.job_id || "");
    if (!jobId) continue;
    const current = notificationByJobId.get(jobId);
    if (
      !current ||
      (timestamp(notification.attempted_at) || 0) >
        (timestamp(current.attempted_at) || 0)
    ) {
      notificationByJobId.set(jobId, notification);
    }
  }

  const outcomes: Record<LogicalIntakeSlaOutcome, number> = {
    job_on_board_within_300s: 0,
    terminal_non_work_fate_within_300s: 0,
    missed_or_late: 0,
  };
  const missedSample: LogicalIntakeSlaSummary["missed_sample"] = [];
  let pendingWithinTarget = 0;
  let matured = 0;
  let physicalJobs = 0;
  let physicalNotificationAccepted = 0;
  let physicalNotificationMissed = 0;
  const caseSourceIds = new Set<string>();

  for (const row of input.cases) {
    for (const source of row.makesafe_intake_case_sources || []) {
      const postId = String(source.post_id || "").trim();
      if (postId) caseSourceIds.add(postId);
    }
    if (caseIsSynthetic(row)) continue;
    const receivedAt = firstTimestamp([
      row.received_at,
      ...(row.makesafe_intake_case_sources || []).map((source) =>
        source.received_at
      ),
    ]);
    const receivedMs = timestamp(receivedAt);
    if (
      receivedMs === null || receivedMs < windowStartMs || receivedMs > nowMs
    ) continue;
    if (nowMs - receivedMs < LOGICAL_SLA_TARGET_SECONDS * 1000) {
      pendingWithinTarget++;
      continue;
    }
    matured++;

    const job = embeddedJob(row);
    const jobId = String(row.job_id || job?.id || "");
    const board = jobId ? boardByJobId.get(jobId) : undefined;
    let outcome: LogicalIntakeSlaOutcome = "missed_or_late";
    let reason = "no_terminal_outcome_within_300s";
    if (
      jobId && board &&
      withinTarget(receivedAt, job?.created_at || null)
    ) {
      outcome = "job_on_board_within_300s";
      reason = "current_board_confirms_job_created_within_300s";
    } else if (
      row.state === "accounted_non_wo" &&
      withinTarget(receivedAt, row.last_decision_at || null)
    ) {
      outcome = "terminal_non_work_fate_within_300s";
      reason = "canonical_non_work_decision_within_300s";
    } else if (jobId && !board) {
      reason = "linked_job_not_on_current_canonical_board";
    } else if (jobId) {
      reason = "job_created_late_or_before_email";
    } else if (row.state === "accounted_non_wo") {
      reason = "terminal_non_work_fate_late";
    }
    outcomes[outcome]++;

    if (outcome === "missed_or_late" && missedSample.length < 10) {
      missedSample.push({
        grain_id: `case:${row.id}`,
        received_at: receivedAt,
        job_id: jobId || null,
        reason,
      });
    }

    if (
      outcome === "job_on_board_within_300s" &&
      board && PHYSICAL_FAMILIES.has(String(board.ses_family || ""))
    ) {
      physicalJobs++;
      const notification = notificationByJobId.get(jobId);
      if (
        notification?.state === "accepted" &&
        withinTarget(receivedAt, notification.provider_accepted_at || null)
      ) {
        physicalNotificationAccepted++;
      } else {
        physicalNotificationMissed++;
      }
    }
  }

  const unaccounted = input.unaccountedItems.filter((item) => {
    const postId = String(item.post_id || "").trim();
    const receivedMs = timestamp(item.received_at);
    return item.classification === "genuinely_unaccounted" &&
      !itemIsSynthetic(item) &&
      (!postId || !caseSourceIds.has(postId)) &&
      receivedMs !== null &&
      receivedMs >= windowStartMs &&
      receivedMs <= nowMs;
  });
  const rawGroups = groupUnaccountedItems(unaccounted);
  for (const group of rawGroups) {
    const receivedAt = firstTimestamp(group.map((item) => item.received_at));
    const receivedMs = timestamp(receivedAt);
    if (receivedMs === null) continue;
    if (nowMs - receivedMs < LOGICAL_SLA_TARGET_SECONDS * 1000) {
      pendingWithinTarget++;
      continue;
    }
    matured++;
    outcomes.missed_or_late++;
    if (missedSample.length < 10) {
      missedSample.push({
        grain_id: `unaccounted:${
          group.map((item) => item.post_id).filter(Boolean).sort().join(",")
        }`,
        received_at: receivedAt,
        job_id: null,
        reason: "eligible_logical_email_has_no_canonical_case",
      });
    }
  }

  return {
    target_sec: 300,
    window_start: input.windowStartIso,
    generated_at: input.nowIso,
    grain: "eligible_logical_email",
    stop_basis: "job_created_at_with_current_canonical_board_confirmation",
    complete: input.sourceReadComplete,
    denominator_matured: matured,
    pending_within_300s: pendingWithinTarget,
    raw_source_rows: unaccounted.length,
    logical_email_groups: matured + pendingWithinTarget,
    unaccounted_logical_groups: rawGroups.length,
    outcomes,
    hugo_notification: {
      physical_jobs_in_denominator: physicalJobs,
      provider_accepted_within_300s: physicalNotificationAccepted,
      missed_or_late: physicalNotificationMissed,
    },
    missed_sample: missedSample,
  };
}
