// The office's own words on a trade invoice it sent back or queried.
//
// trade_invoices.query_note holds office reasons and system notes side by side
// ("Validated invoice awaiting Xero ACCPAY creation.", hours flags, duplicate
// warnings, deduction notes), joined with " | ". A trade must see why the
// office sent an invoice back, never the system notes. So this keeps only
// text the office wrote: a sent-back reason, a voided-bill release reason, a
// rejected-line marker, and the note on each queried or rejected line.

/** What reject_trade_invoice stores in front of the office's reason. */
export const OFFICE_SENT_BACK_PREFIX = "Sent back by the office: ";
export const OFFICE_SENT_BACK_DEFAULT =
  "Sent back by the office. Fix it and send it again.";

const VOIDED_RELEASE_PREFIX =
  "Xero bill voided and unpaid. Released for a corrected submission: ";
const LINE_REJECTED_MARKER =
  "A line was rejected. Fix it and send the invoice again.";
const LEGACY_REJECT_DEFAULT = /^Rejected by ops\b/i;

// Notes the server writes for the office or for itself. Never trade-facing.
const SYSTEM_NOTE =
  /^(validated invoice awaiting|xero bill |xero created bill|invoice assignment stamp failed|hours-flag|possible duplicate|auto-flagged|manual hours|weekly deduction|a line on this invoice is still awaiting|group work order share|.* not applied)/i;

/** The reason a reject_trade_invoice press stores. */
export function officeSentBackNote(reason: unknown): string {
  const text = typeof reason === "string" ? reason.trim() : "";
  return text ? (OFFICE_SENT_BACK_PREFIX + text).slice(0, 2000) : OFFICE_SENT_BACK_DEFAULT;
}

export type OfficeNoteLine = {
  office_review_status?: unknown;
  office_review_note?: unknown;
  description?: unknown;
};

function officeSegment(segment: string, allowLegacy: boolean): string | null {
  const text = segment.trim();
  if (!text) return null;
  if (text.startsWith(OFFICE_SENT_BACK_PREFIX)) {
    return text.slice(OFFICE_SENT_BACK_PREFIX.length).trim() || null;
  }
  if (text === OFFICE_SENT_BACK_DEFAULT) return "Fix it and send it again.";
  if (text.startsWith(VOIDED_RELEASE_PREFIX)) {
    const reason = text.slice(VOIDED_RELEASE_PREFIX.length).trim();
    return "The Xero bill was voided. Send a corrected invoice." +
      (reason ? " Reason: " + reason : "");
  }
  if (text === LINE_REJECTED_MARKER) return LINE_REJECTED_MARKER;
  if (LEGACY_REJECT_DEFAULT.test(text)) return "Fix it and send it again.";
  // An older reject stored the office's reason alone, replacing every other
  // note. Only that whole, single note on a sent-back invoice is read as the
  // office's, and only when it is not a known system note.
  if (allowLegacy && !SYSTEM_NOTE.test(text)) return text;
  return null;
}

/**
 * The office note a trade may see on one invoice, or null. `lines` are that
 * invoice's lines; a queried or rejected line's own note is included with
 * the line it is about.
 */
export function tradeInvoiceOfficeNote(
  invoice: { status?: unknown; query_note?: unknown } | null | undefined,
  lines: ReadonlyArray<OfficeNoteLine> = [],
): string | null {
  const status = String(invoice?.status || "");
  const parts: string[] = [];
  const raw = typeof invoice?.query_note === "string" ? invoice.query_note : "";
  if (status === "ops-reject" && raw.trim()) {
    const segments = raw.split(" | ");
    for (const segment of segments) {
      const kept = officeSegment(segment, segments.length === 1);
      if (kept && !parts.includes(kept)) parts.push(kept);
    }
  }
  for (const line of lines || []) {
    const review = String(line?.office_review_status || "");
    if (review !== "rejected" && review !== "queried") continue;
    const note = typeof line?.office_review_note === "string"
      ? line.office_review_note.trim()
      : "";
    if (!note) continue;
    const label = typeof line?.description === "string" && line.description.trim()
      ? line.description.trim().slice(0, 80) + ": "
      : "";
    const text = label + note;
    if (!parts.includes(text)) parts.push(text);
  }
  return parts.length ? parts.join("\n").slice(0, 2000) : null;
}
