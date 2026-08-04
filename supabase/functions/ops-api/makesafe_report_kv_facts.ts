// Pure KV-fact helpers for the curated make-safe completion report.
//
// The builder-facing report Crew line is a TRADE COUNT ONLY ("1 trade" /
// "2 trades"). Client reports must never list crew names — that contract is
// pinned in assertCuratedReportPayload and the wiki Python renderer.
//
// The retired physicalReportRenderJob path preferred assignment.crew_name and
// only fell back to tradeCountLabel, which both put a personal name on the
// client report and left the line blank when the name was absent even though
// trade_count / assignment rows were present. These helpers recover the
// recorded count without inventing a name, a material, or a time.

const CREW_TRADE_COUNT_RE = /^\d+(?:\.\d+)?\s+trades?$/i;

const NON_COUNTABLE_ASSIGNMENT_STATUS = new Set([
  "cancelled",
  "canceled",
  "deleted",
  "void",
  "rejected",
]);

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Format a positive trade count as the client-facing Crew line. Empty when unknown. */
export function makesafeReportTradeCountLabel(value: unknown): string {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return "";
  // Integer labels only — fractional trade counts are not a recorded crew size.
  if (!Number.isInteger(count)) return "";
  return `${count} ${count === 1 ? "trade" : "trades"}`;
}

/**
 * Count assignment rows that prove a real person attended / was allocated.
 *
 * - Skips cancelled/deleted/void rows.
 * - Counts a row only when a person identity is present (user_id, crew_name, or
 *   joined users.name). A blank shell assignment is not a trade.
 * - Does not invent a default of 1 when the list is empty.
 */
export function countAssignmentsForCrewLine(
  assignments: unknown[] | null | undefined,
): number {
  if (!Array.isArray(assignments) || assignments.length === 0) return 0;
  let count = 0;
  for (const raw of assignments) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const status = text(row.status).toLowerCase();
    if (status && NON_COUNTABLE_ASSIGNMENT_STATUS.has(status)) continue;
    const joined = row.users;
    const joinedName = (() => {
      if (!joined || typeof joined !== "object") return "";
      const person = Array.isArray(joined) ? joined[0] : joined;
      if (!person || typeof person !== "object") return "";
      return text((person as Record<string, unknown>).name);
    })();
    const hasPerson = Boolean(
      text(row.user_id) || text(row.crew_name) || joinedName,
    );
    if (!hasPerson) continue;
    count += 1;
  }
  return count;
}

/**
 * Derive the client-facing Crew line.
 *
 * Precedence:
 *   1. Supplied value already in trade-count form (trusted as written).
 *   2. Explicit trade_count from the current-cycle service report.
 *   3. Count of person-bearing non-cancelled job_assignments.
 *   4. Otherwise blank (or the invalid supplied value so the curated gate can
 *      refuse a name rather than inventing a count).
 *
 * Never invents a name. Never invents a positive count when both sources are
 * empty.
 */
export function deriveMakesafeReportCrewLabel(input: {
  supplied?: unknown;
  tradeCount?: unknown;
  assignmentCount?: unknown;
  assignments?: unknown[] | null;
}): string {
  const supplied = text(input.supplied);
  if (supplied && CREW_TRADE_COUNT_RE.test(supplied)) return supplied;

  const fromTrade = makesafeReportTradeCountLabel(input.tradeCount);
  if (fromTrade) return fromTrade;

  const assignmentCount = Number.isFinite(Number(input.assignmentCount))
    ? Number(input.assignmentCount)
    : countAssignmentsForCrewLine(input.assignments);
  const fromAssignments = makesafeReportTradeCountLabel(assignmentCount);
  if (fromAssignments) return fromAssignments;

  // Invalid supplied (e.g. a personal name) is returned unchanged so
  // assertCuratedReportPayload can fail closed rather than inventing a count.
  return supplied;
}

/**
 * Extract a clock time for the Attendance line.
 *
 * Accepts bare `HH:MM`, ISO datetimes, and `YYYY-MM-DD HH:MM` values from the
 * trade checklist. Never invents a time when the source is blank.
 */
export function makesafeReportAttendanceTime(value: unknown): string {
  const candidate = text(value);
  if (!candidate) return "";
  const withDate = candidate.match(/(?:T|\s)(\d{1,2}:\d{2})(?::\d{2})?/);
  if (withDate?.[1]) return withDate[1].padStart(5, "0");
  const bare = candidate.match(/^(\d{1,2}:\d{2})(?::\d{2})?$/);
  if (bare?.[1]) {
    const [h, m] = bare[1].split(":");
    return `${h.padStart(2, "0")}:${m}`;
  }
  return candidate;
}

/**
 * Derive the Attendance arrival time for the curated report.
 *
 * Precedence: supplied → checklist.arrival_time → assignment.arrived_at.
 * Empty when none of those hold a real value.
 */
export function deriveMakesafeReportArrival(input: {
  supplied?: unknown;
  checklistArrival?: unknown;
  assignmentArrivedAt?: unknown;
}): string {
  const supplied = text(input.supplied);
  if (supplied) return makesafeReportAttendanceTime(supplied) || supplied;
  const fromChecklist = makesafeReportAttendanceTime(input.checklistArrival);
  if (fromChecklist) return fromChecklist;
  return makesafeReportAttendanceTime(input.assignmentArrivedAt);
}

/**
 * Fill blank/invalid Crew and blank Attendance from recorded evidence only.
 *
 * Does not touch scope/findings/works/materials prose. Does not invent when
 * both trade_count and assignments are empty.
 */
export function enrichMakesafeReportJobKvFacts(
  supplied: Record<string, unknown>,
  evidence: {
    tradeCount?: unknown;
    checklistArrival?: unknown;
    assignmentArrivedAt?: unknown;
    assignments?: unknown[] | null;
    assignmentCount?: unknown;
  },
): Record<string, unknown> {
  const crew = deriveMakesafeReportCrewLabel({
    supplied: supplied.crew,
    tradeCount: evidence.tradeCount,
    assignmentCount: evidence.assignmentCount,
    assignments: evidence.assignments,
  });
  const arrival = deriveMakesafeReportArrival({
    supplied: supplied.arrival,
    checklistArrival: evidence.checklistArrival,
    assignmentArrivedAt: evidence.assignmentArrivedAt,
  });
  return {
    ...supplied,
    ...(crew ? { crew } : {}),
    ...(arrival ? { arrival } : {}),
  };
}
