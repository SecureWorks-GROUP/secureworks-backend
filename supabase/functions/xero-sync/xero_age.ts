// Date/bucket helpers for aged payables/receivables reads.
// Xero returns DateString ("2026-09-11T00:00:00") and/or /Date(ms)/. Using
// `new Date("/Date(...)/")` is Invalid Date and parks every bill in "current".

export function parseXeroDotNetDate(raw: unknown): Date | null {
  const text = String(raw || "");
  const match = text.match(/\/Date\((\d+)([+-]\d+)?\)\//);
  if (!match) return null;
  const parsed = new Date(parseInt(match[1], 10));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function resolveXeroInvoiceDueDate(
  inv: { DueDateString?: unknown; DueDate?: unknown; due_date?: unknown },
  fallback: Date,
): Date {
  const candidates = [inv?.DueDateString, inv?.due_date, inv?.DueDate];
  for (const candidate of candidates) {
    if (candidate == null || candidate === "") continue;
    const fromDotNet = parseXeroDotNetDate(candidate);
    if (fromDotNet) return fromDotNet;
    const parsed = new Date(String(candidate));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback;
}

export function ageBucketDaysOverdue(daysOverdue: number): string {
  if (!Number.isFinite(daysOverdue) || daysOverdue <= 0) return "current";
  if (daysOverdue > 90) return "90+";
  if (daysOverdue > 60) return "61-90";
  if (daysOverdue > 30) return "31-60";
  return "1-30";
}
