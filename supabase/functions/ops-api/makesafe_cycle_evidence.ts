// U2-S1: one shared cycle-scoped evidence boundary for board + audit.
// Pure projection helpers only — no second status engine and no DB writes.

export const CYCLE_ATTRIBUTION = {
  BOUND: "bound",
  BACKFILL_CYCLE_SCOPE: "backfill_cycle_scope",
  LEGACY_UNSCOPED: "legacy_unscoped",
} as const;

export type CycleAttribution =
  (typeof CYCLE_ATTRIBUTION)[keyof typeof CYCLE_ATTRIBUTION];

/** reattend_count > 0 is the reattendance boundary (same as board/audit #386). */
export function hasReattendBoundary(detail: any): boolean {
  return (Number(detail?.reattend_count ?? 0) || 0) > 0;
}

/** First-attendance / reopen-only cards keep legacy any-cycle behaviour. */
export function isLegacyMakesafeCard(detail: any): boolean {
  return !hasReattendBoundary(detail);
}

export function currentCycleNumber(detail: any): number {
  const n = Number(detail?.cycle_number ?? 1);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Whether a fact row may satisfy *current* attendance readiness.
 * - Prefer attendance_cycle_id match when both sides have one.
 * - Else cycle_number match.
 * - backfill_cycle_scope never satisfies current readiness.
 * - On reattend, unbound / legacy_unscoped rows fail closed.
 * - Without reattend boundary, unbound rows keep legacy any-cycle behaviour.
 */
export function isEvidenceBoundToCurrentCycle(
  row: any,
  detail: any,
  currentAttendanceCycleId?: string | null,
): boolean {
  if (!row) return false;
  const attribution = String(row.cycle_attribution || "").toLowerCase();
  if (attribution === CYCLE_ATTRIBUTION.BACKFILL_CYCLE_SCOPE) return false;

  const cycle = currentCycleNumber(detail);
  const rowCycleId = row.attendance_cycle_id
    ? String(row.attendance_cycle_id)
    : null;
  const currentId = currentAttendanceCycleId
    ? String(currentAttendanceCycleId)
    : null;

  if (rowCycleId && currentId) {
    return rowCycleId === currentId &&
      attribution === CYCLE_ATTRIBUTION.BOUND;
  }
  if (rowCycleId && !currentId) return false;

  // Unbound by UUID — fall back to cycle_number when present.
  if (row.cycle_number != null && Number(row.cycle_number) !== cycle) {
    if (hasReattendBoundary(detail)) return false;
    // Legacy path: any-cycle first-match allowed only when no reattend boundary.
    return true;
  }
  if (row.cycle_number != null && Number(row.cycle_number) === cycle) {
    return !hasReattendBoundary(detail) || attribution === CYCLE_ATTRIBUTION.BOUND;
  }

  // Fully unbound (no cycle_number, no attendance_cycle_id).
  if (hasReattendBoundary(detail)) return false;
  return true;
}

export function selectCurrentCycleReport(
  reports: any[] | null | undefined,
  detail: any,
  currentAttendanceCycleId?: string | null,
): any | null {
  for (const row of reports || []) {
    if (!row?.job_id && !row) continue;
    const status = String(row?.status || "").toLowerCase();
    if (status === "draft") continue;
    if (isEvidenceBoundToCurrentCycle(row, detail, currentAttendanceCycleId)) {
      return row;
    }
  }
  // Legacy reopen-only: first non-draft when no reattend boundary and nothing matched.
  if (!hasReattendBoundary(detail)) {
    for (const row of reports || []) {
      if (String(row?.status || "").toLowerCase() === "draft") continue;
      if (row) return row;
    }
  }
  return null;
}

/**
 * Same contract as index currentCycleReportMap: reattend → current cycle only;
 * legacy → first-match any cycle. Prefer attendance_cycle_id when present.
 */
export function currentCycleReportMap(
  rows: any[] | null | undefined,
  detailsMap: Record<string, any>,
  cycleIdByJobId?: Record<string, string | null>,
): Record<string, any> {
  const map: Record<string, any> = {};
  for (const row of rows || []) {
    const jobId = row?.job_id;
    if (!jobId) continue;
    const detail = detailsMap[jobId];
    const cycleId = cycleIdByJobId?.[jobId] ?? null;
    if (hasReattendBoundary(detail)) {
      if (!isEvidenceBoundToCurrentCycle(row, detail, cycleId)) continue;
    }
    if (!map[jobId]) map[jobId] = row;
  }
  return map;
}

export function filterAssignmentsForCurrentCycle(
  assignments: any[] | null | undefined,
  detail: any,
  currentAttendanceCycleId?: string | null,
): { assignments: any[]; flags: string[] } {
  const flags: string[] = [];
  const list = assignments || [];
  if (!hasReattendBoundary(detail)) {
    return { assignments: list, flags };
  }
  const bound = list.filter((a) =>
    isEvidenceBoundToCurrentCycle(a, detail, currentAttendanceCycleId)
  );
  const dropped = list.length - bound.length;
  if (dropped > 0) {
    flags.push("stale_assignment_excluded");
  }
  if (list.some((a) =>
    String(a?.cycle_attribution || "") === CYCLE_ATTRIBUTION.BACKFILL_CYCLE_SCOPE
  )) {
    flags.push(CYCLE_ATTRIBUTION.BACKFILL_CYCLE_SCOPE);
  }
  return { assignments: bound, flags };
}

export function filterHoldsForCurrentCycle(
  holds: any[] | null | undefined,
  detail: any,
  currentAttendanceCycleId?: string | null,
): any | null {
  const cycle = currentCycleNumber(detail);
  for (const hold of holds || []) {
    if (hold?.lifted_at) continue;
    if (hold?.attendance_cycle_id && currentAttendanceCycleId) {
      if (
        String(hold.attendance_cycle_id) === String(currentAttendanceCycleId) &&
        String(hold.cycle_attribution || "") === CYCLE_ATTRIBUTION.BOUND
      ) {
        return hold;
      }
      continue;
    }
    if (Number(hold?.cycle_number || 1) === cycle) {
      if (hasReattendBoundary(detail)) {
        if (String(hold?.cycle_attribution || "") !== CYCLE_ATTRIBUTION.BOUND) continue;
        if (!hold?.attendance_cycle_id || !currentAttendanceCycleId) continue;
      }
      return hold;
    }
  }
  return null;
}

export function typedReportDocSatisfiesCurrent(
  docs: any[] | null | undefined,
  detail: any,
  currentAttendanceCycleId?: string | null,
): boolean {
  // job_documents have no cycle column yet. On reattend they fail closed unless
  // a future write path binds attendance_cycle_id. Legacy cards keep any typed doc.
  if (!hasReattendBoundary(detail)) {
    return (docs || []).some(
      (d) => String(d?.type || "").toLowerCase() === "makesafe_report",
    );
  }
  return (docs || []).some((d) =>
    String(d?.type || "").toLowerCase() === "makesafe_report" &&
    isEvidenceBoundToCurrentCycle(d, detail, currentAttendanceCycleId)
  );
}

export function hasReportDocHeuristicCurrent(
  hasReportDoc: boolean,
  detail: any,
): boolean {
  if (!hasReportDoc) return false;
  // Heuristic filename docs are job-global; reattend fails closed.
  if (hasReattendBoundary(detail)) return false;
  return true;
}

/** Pack/sent may satisfy current readiness only when cycle-bound (or legacy). */
export function packSentSatisfiesCurrent(
  packSent: boolean,
  detail: any,
  packCycleBound: boolean,
): boolean {
  if (!packSent) return false;
  if (!hasReattendBoundary(detail)) return true;
  return packCycleBound;
}

export function packForCurrentReadiness(
  pack: any | null | undefined,
  detail: any,
  packCycleBound: boolean,
): any | null {
  if (!pack) return null;
  if (!hasReattendBoundary(detail)) return pack;
  if (packCycleBound) return pack;
  // Strip send/closeout statuses so prior-cycle pack cannot close the card.
  return {
    ...pack,
    status: "drafted",
    sent_at: null,
    // Keep doc ids only when bound; unbound prior pack artifacts do not count.
    report_doc_id: null,
    invoice_doc_id: null,
    swms_doc_id: null,
    review_state: null,
  };
}

/**
 * On reattend, invoice/commercial may be shown as a warning but must not close
 * the current attendance. Callers pass invoice through for display and set
 * suppressCloseout when reattend boundary is active.
 */
export function commercialCloseoutAllowed(detail: any): boolean {
  return !hasReattendBoundary(detail);
}

export function photoCountForCurrentCycle(
  photoCount: number,
  detail: any,
  photosBoundToCurrent: boolean,
): number {
  if (!hasReattendBoundary(detail)) return photoCount;
  // Photos are not yet cycle-keyed; fail closed unless an explicit binding flag
  // is provided by a future write path.
  return photosBoundToCurrent ? photoCount : 0;
}

export interface CycleScopedEvidenceInput {
  detail: any;
  reports?: any[] | null;
  assignments?: any[] | null;
  docs?: any[] | null;
  pack?: any | null;
  packSent?: boolean;
  packCycleBound?: boolean;
  photoCount?: number;
  photosBoundToCurrent?: boolean;
  attendanceCycleId?: string | null;
  holds?: any[] | null;
  familyMatrixVersion?: string;
  pricingRevision?: string | null;
  packRevision?: string | null;
}

export interface CycleScopedEvidence {
  attendance_cycle_id: string | null;
  cycle_number: number;
  cycle_attribution_flags: string[];
  readiness_revision: string | null;
  serviceReport: any | null;
  assignments: any[];
  hold: any | null;
  pack: any | null;
  packSent: boolean;
  hasReportDocTyped: boolean;
  hasReportDoc: boolean;
  photoCount: number;
  commercial_warning: string | null;
  allowCloseoutFromEvidence: boolean;
  has_report_record: boolean;
}

export function projectCycleScopedEvidence(
  input: CycleScopedEvidenceInput,
): CycleScopedEvidence {
  const detail = input.detail || {};
  const cycle = currentCycleNumber(detail);
  const attendanceCycleId = input.attendanceCycleId ?? null;
  const flags: string[] = [];

  const report = selectCurrentCycleReport(
    input.reports,
    detail,
    attendanceCycleId,
  );
  const assign = filterAssignmentsForCurrentCycle(
    input.assignments,
    detail,
    attendanceCycleId,
  );
  flags.push(...assign.flags);

  const packCycleBound = input.packCycleBound === true;
  if (hasReattendBoundary(detail) && input.packSent && !packCycleBound) {
    flags.push("stale_pack_sent_excluded");
  }
  if (hasReattendBoundary(detail) && !packCycleBound && input.pack) {
    flags.push("stale_pack_excluded");
  }

  const packSent = packSentSatisfiesCurrent(
    input.packSent === true,
    detail,
    packCycleBound,
  );
  const pack = packForCurrentReadiness(input.pack, detail, packCycleBound);
  const hasReportDocTyped = typedReportDocSatisfiesCurrent(
    input.docs,
    detail,
    attendanceCycleId,
  );
  const hasReportDoc = hasReportDocHeuristicCurrent(
    (input.docs || []).some((d) => {
      const t = String(d?.type || "").toLowerCase();
      const name = String(d?.file_name || "").toLowerCase();
      return t === "makesafe_report" || name.includes("make safe report") ||
        name.includes("makesafe report");
    }),
    detail,
  );

  // Prefer typed binding over heuristic for has_report_record.
  const has_report_record = !!report || hasReportDocTyped;

  if (hasReattendBoundary(detail) && !has_report_record) {
    // Surface missing current-cycle report when old evidence was present.
    const anyOldReport = (input.reports || []).some((r) =>
      String(r?.status || "").toLowerCase() !== "draft"
    );
    const anyOldDoc = (input.docs || []).some((d) =>
      String(d?.type || "").toLowerCase() === "makesafe_report"
    );
    if (anyOldReport || anyOldDoc) flags.push("stale_report_excluded");
  }

  const photoCount = photoCountForCurrentCycle(
    Number(input.photoCount || 0),
    detail,
    input.photosBoundToCurrent === true,
  );
  if (
    hasReattendBoundary(detail) && Number(input.photoCount || 0) > 0 &&
    photoCount === 0
  ) {
    flags.push("stale_photos_excluded");
  }

  const hold = filterHoldsForCurrentCycle(
    input.holds,
    detail,
    attendanceCycleId,
  );

  const allowCloseout = commercialCloseoutAllowed(detail);
  let commercial_warning: string | null = null;
  if (!allowCloseout) {
    commercial_warning =
      "prior_cycle_commercial_visible_not_closing_current_attendance";
    flags.push("commercial_from_prior_cycle");
  }

  const readiness_revision = computeReadinessRevisionSync({
    attendanceCycleId,
    cycleNumber: cycle,
    reportId: report?.id ?? null,
    reportStatus: report?.status ?? null,
    assignmentIds: assign.assignments.map((a) => a?.id || a?.assignment_id)
      .filter(Boolean).sort(),
    packStatus: pack?.status ?? null,
    packSent,
    hasReportDocTyped,
    photoCount,
    familyMatrixVersion: input.familyMatrixVersion || "makesafe-family.v1",
    pricingRevision: input.pricingRevision || null,
    packRevision: input.packRevision || pack?.last_render_hash || null,
    reattendCount: Number(detail?.reattend_count || 0),
  });

  return {
    attendance_cycle_id: attendanceCycleId,
    cycle_number: cycle,
    cycle_attribution_flags: Array.from(new Set(flags)),
    readiness_revision,
    serviceReport: report,
    assignments: assign.assignments,
    hold,
    pack,
    packSent,
    hasReportDocTyped,
    hasReportDoc,
    photoCount,
    commercial_warning,
    allowCloseoutFromEvidence: allowCloseout,
    has_report_record,
  };
}

/** Canonical readiness fingerprint input (order-stable). */
export function readinessRevisionPayload(parts: {
  attendanceCycleId: string | null;
  cycleNumber: number;
  reportId: string | null;
  reportStatus: string | null;
  assignmentIds: string[];
  packStatus: string | null;
  packSent: boolean;
  hasReportDocTyped: boolean;
  photoCount: number;
  familyMatrixVersion: string;
  pricingRevision: string | null;
  packRevision: string | null;
  reattendCount: number;
}): string {
  return JSON.stringify({
    v: 1,
    attendance_cycle_id: parts.attendanceCycleId,
    cycle_number: parts.cycleNumber,
    reattend_count: parts.reattendCount,
    report_id: parts.reportId,
    report_status: parts.reportStatus,
    assignment_ids: parts.assignmentIds,
    pack_status: parts.packStatus,
    pack_sent: parts.packSent,
    has_report_doc_typed: parts.hasReportDocTyped,
    photo_count: parts.photoCount,
    family_matrix_version: parts.familyMatrixVersion,
    pricing_revision: parts.pricingRevision,
    pack_revision: parts.packRevision,
  });
}

/** Sync SHA-256 hex via Web Crypto is async; provide a deterministic FNV-1a
 *  fallback label only for pure unit tests. Production uses computeReadinessRevision.
 *  S1 exposes this as readiness_revision without claiming approval invalidation. */
export function computeReadinessRevisionSync(
  parts: Parameters<typeof readinessRevisionPayload>[0],
): string {
  const payload = readinessRevisionPayload(parts);
  // FNV-1a 64-bit hex — stable, pure, no async. Documented as readiness_revision
  // v1 fingerprint; U4 may upgrade to full SHA-256 in the docket envelope.
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < payload.length; i++) {
    h ^= BigInt(payload.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return `fnv1a64:${h.toString(16).padStart(16, "0")}`;
}

export async function computeReadinessRevisionSha256(
  parts: Parameters<typeof readinessRevisionPayload>[0],
): Promise<string> {
  const payload = readinessRevisionPayload(parts);
  const data = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

/** Trade-safe hold shape (no user PII beyond reason/note/held_since). */
export function tradeSafeHold(hold: any | null | undefined) {
  if (!hold) return null;
  return {
    reason_code: hold.reason_code || null,
    note: hold.note || null,
    held_since: hold.created_at || null,
    cycle_number: hold.cycle_number ?? null,
  };
}
