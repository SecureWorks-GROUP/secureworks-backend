// ── Finance review email for flagged trade invoices (M4 U3) ─────────────────
//
// Mission profit-trade-invoice-intelligence-2026-07-03 (campaign
// profitability-job-costing, M4). Wiki issue #112. Built FROM SCRATCH — the
// CP1 infra verification confirmed NO finance email path existed; the eventual
// live send reuses the backend's existing Resend transport (the same
// api.resend.com/emails call sendQuickQuoteEmail uses), but that send is GATED
// OFF until Marnin approves the exact draft at CP2. This module is pure and
// deterministic (no AI narrative, no I/O): it builds the email content, the
// idempotency hash, and the send-ledger decision. index.ts does the DB/transport.
//
// Rulings pinned at CP1 (Marnin, 2026-07-05):
//   • ONE email per flagged invoice (never per line); all flagged lines in it.
//   • Per flagged line: Allowed: X hrs (source: ...) / Charged: Y hrs /
//     Trade's justification: Z / Please review before payment.
//   • Subject: "Review: trade invoice <ref> on <job> (<n> flagged line(s))".
//   • Links: the Xero draft bill AND the per-job cost report (U5).
//   • v1 allowance is the 2h rule default and ~40% of jobs legitimately vary,
//     so flags are NOISY BY DESIGN — the tone is calm and routine, never an
//     alarm; the email aggregates cleanly.
//   • Finance inbox = finance@secureworkswa.com.au (confirmed).
//
// Idempotency (finding #1): the send-ledger is keyed by trade_invoice_id + a
// hash of the flagged-line set. Exactly-one-send semantics — a resubmission with
// an UNCHANGED flag set sends nothing; a CHANGED flag set sends one superseding
// email marked as an update. A wrongly-sent email is corrected by a follow-up
// correction email to the same inbox, recorded in the ledger (see index.ts).

import { type AllowanceSource, describeSource } from "./makesafe_hours_flag.ts";

// Confirmed inbox (CP1, 2026-07-05). One recipient; internal review only.
export const FINANCE_REVIEW_INBOX = "finance@secureworkswa.com.au";

// From/reply-to. The From reuses the only Resend-verified sender domain in the
// backend (orders@secureworksgroup.app — the .app is the SENDING domain; humans
// never see it as a reply target). Reply-to points back at the finance inbox so
// a reply threads to finance. Sender identity is a CP2 confirm item.
export const FINANCE_REVIEW_FROM =
  "SecureWorks Group <orders@secureworksgroup.app>";
export const FINANCE_REVIEW_REPLY_TO = FINANCE_REVIEW_INBOX;

// ─────────────────────────────────────────────────────────────────────────
// Flagged-line input + link builders
// ─────────────────────────────────────────────────────────────────────────
export interface FlaggedReviewLine {
  jobId: string | null;
  jobNumber: string | null;
  clientName: string | null;
  allowedHours: number;
  source: AllowanceSource;
  chargedHours: number;
  justification: string | null;
}

export interface FinanceReviewEmailInput {
  invoiceNumber: string;
  tradeInvoiceId: string;
  tradeName?: string | null;
  flaggedLines: FlaggedReviewLine[];
  xeroDraftBillUrl?: string | null;
  // Per-jobId cost report URL (U5). Deckhand B owns the page; index.ts passes a
  // stable-pattern URL (placeholder route acceptable, documented there).
  jobCostReportUrls?: Record<string, string>;
  // True when this supersedes an earlier notice for the same invoice.
  isUpdate?: boolean;
}

export interface FinanceReviewEmail {
  recipient: string;
  from: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
  flagSetHash: string;
  flaggedLineCount: number;
}

// Xero deep-link to the DRAFT ACCPAY bill. Classic AP view by InvoiceID — the
// exact host/path is a CP2 confirm item; the InvoiceID is the load-bearing part.
export function xeroDraftBillUrl(
  xeroBillId: string | null | undefined,
): string | null {
  if (!xeroBillId) return null;
  return "https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=" +
    xeroBillId;
}

function roundHours(h: number): number {
  return Math.round((Number(h) || 0) * 100) / 100;
}

function safeJustification(j: string | null): string {
  const t = (j ?? "").trim();
  return t.length > 0 ? t : "no explanation provided";
}

// ─────────────────────────────────────────────────────────────────────────
// Idempotency hash — order-independent over the flagged-line set
// ─────────────────────────────────────────────────────────────────────────

// A line's identity for the flag set: its job, allowed, charged, source, and
// justification. If any of these change on resubmit, the hash changes and finance
// gets ONE superseding update; if none change, the resubmission sends nothing.
function canonicalLine(l: FlaggedReviewLine): string {
  return [
    l.jobId ?? l.jobNumber ?? "",
    roundHours(l.allowedHours),
    l.source,
    roundHours(l.chargedHours),
    safeJustification(l.justification),
  ].join("|");
}

// FNV-1a 32-bit over the SORTED canonical lines — deterministic and
// order-independent (line ordering must not change the hash). Dependency-free.
export function computeFlagSetHash(lines: FlaggedReviewLine[]): string {
  const canon = lines.map(canonicalLine).sort().join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ─────────────────────────────────────────────────────────────────────────
// Email builder (deterministic; no AI narrative)
// ─────────────────────────────────────────────────────────────────────────
export function buildFinanceReviewEmail(
  input: FinanceReviewEmailInput,
): FinanceReviewEmail {
  const lines = input.flaggedLines;
  const n = lines.length;
  const flagSetHash = computeFlagSetHash(lines);

  // Subject: name the first flagged job, note "+N more" when the invoice spans
  // several flagged jobs. Deterministic (jobs in flagged order).
  const distinctJobs = [
    ...new Set(lines.map((l) => l.jobNumber || l.jobId || "").filter(Boolean)),
  ];
  const jobLabel = distinctJobs.length === 0
    ? "make-safe work"
    : distinctJobs.length === 1
    ? distinctJobs[0]
    : distinctJobs[0] + " +" + (distinctJobs.length - 1) + " more";
  const updatePrefix = input.isUpdate ? "Updated review: " : "Review: ";
  const subject = updatePrefix + "trade invoice " + input.invoiceNumber +
    " on " + jobLabel +
    " (" + n + " flagged line" + (n === 1 ? "" : "s") + ")";

  const billUrl = input.xeroDraftBillUrl || null;
  const reportUrls = input.jobCostReportUrls || {};
  const jobReportUrl = (l: FlaggedReviewLine): string | null =>
    l.jobId && reportUrls[l.jobId] ? reportUrls[l.jobId] : null;

  // Calm, routine framing (no alarm language). States the 40%-vary context so a
  // flag reads as expected, not an exception.
  const intro =
    (input.isUpdate
      ? "This is an updated review notice — it supersedes the earlier one for this invoice. "
      : "") +
    "This trade invoice has " + n + " make-safe line" + (n === 1 ? "" : "s") +
    " billing above the allowed hours. This is a routine check — around 40% of make-safe jobs " +
    "legitimately run over, so a flag here is expected rather than a problem. Please review the " +
    "detail below against the trade's explanation before approving payment in Xero.";

  // ── Plain text ──
  const textLines: string[] = [];
  textLines.push(intro);
  textLines.push("");
  textLines.push(
    "Invoice: " + input.invoiceNumber +
      (input.tradeName ? "  ·  Trade: " + input.tradeName : ""),
  );
  textLines.push("");
  for (const l of lines) {
    const jobRef = l.jobNumber || l.jobId || "make-safe line";
    textLines.push(jobRef + (l.clientName ? "  (" + l.clientName + ")" : ""));
    textLines.push(
      "  Allowed: " + roundHours(l.allowedHours) + " hrs (source: " +
        describeSource(l.source) + ")",
    );
    textLines.push("  Charged: " + roundHours(l.chargedHours) + " hrs");
    textLines.push(
      "  Trade's justification: " + safeJustification(l.justification),
    );
    const rpt = jobReportUrl(l);
    if (rpt) textLines.push("  Job cost report: " + rpt);
    textLines.push("  Please review before payment.");
    textLines.push("");
  }
  if (billUrl) {
    textLines.push("Xero draft bill: " + billUrl);
    textLines.push("");
  }
  textLines.push(
    "The pay decision stays with you in Xero — this notice never holds or pays anything.",
  );
  const text = textLines.join("\n");

  // ── HTML (brand colours; calm, scannable) ──
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lineBlocks = lines.map((l) => {
    const jobRef = esc(l.jobNumber || l.jobId || "make-safe line");
    const rpt = jobReportUrl(l);
    return `
    <div style="background:#f8f6f3;padding:14px 16px;border-radius:6px;margin:10px 0;border-left:3px solid #4C6A7C;">
      <p style="margin:0 0 6px;font-weight:600;color:#293C46;">${jobRef}${
      l.clientName
        ? ` <span style="font-weight:400;color:#4C6A7C;">· ${
          esc(l.clientName)
        }</span>`
        : ""
    }</p>
      <table style="font-size:14px;color:#293C46;border-collapse:collapse;">
        <tr><td style="padding:2px 12px 2px 0;color:#4C6A7C;">Allowed</td><td style="padding:2px 0;">${
      roundHours(l.allowedHours)
    } hrs <span style="color:#4C6A7C;">(source: ${
      esc(describeSource(l.source))
    })</span></td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#4C6A7C;">Charged</td><td style="padding:2px 0;">${
      roundHours(l.chargedHours)
    } hrs</td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#4C6A7C;vertical-align:top;">Justification</td><td style="padding:2px 0;">${
      esc(safeJustification(l.justification))
    }</td></tr>
      </table>
      ${
      rpt
        ? `<p style="margin:8px 0 0;font-size:13px;"><a href="${
          esc(rpt)
        }" style="color:#4C6A7C;">View job cost report</a></p>`
        : ""
    }
      <p style="margin:8px 0 0;font-size:13px;color:#4C6A7C;">Please review before payment.</p>
    </div>`;
  }).join("");

  const html = `
<div style="font-family:Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;">
  <div style="background:#293C46;padding:18px 24px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:18px;">SecureWorks Group</h1>
    <p style="color:#8FA4B2;margin:4px 0 0;font-size:12px;">Trade invoice — hours review</p>
  </div>
  <div style="padding:24px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;color:#293C46;">
    <p style="margin:0 0 4px;">${esc(intro)}</p>
    <p style="margin:16px 0 4px;font-size:14px;color:#4C6A7C;">Invoice <strong style="color:#293C46;">${
    esc(input.invoiceNumber)
  }</strong>${input.tradeName ? ` · Trade ${esc(input.tradeName)}` : ""}</p>
    ${lineBlocks}
    ${
    billUrl
      ? `<p style="margin:18px 0 0;"><a href="${
        esc(billUrl)
      }" style="background:#F15A29;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px;display:inline-block;">Open the Xero draft bill</a></p>`
      : ""
  }
    <p style="margin:18px 0 0;font-size:12px;color:#4C6A7C;">The pay decision stays with you in Xero — this notice never holds or pays anything.</p>
  </div>
</div>`;

  return {
    recipient: FINANCE_REVIEW_INBOX,
    from: FINANCE_REVIEW_FROM,
    replyTo: FINANCE_REVIEW_REPLY_TO,
    subject,
    text,
    html,
    flagSetHash,
    flaggedLineCount: n,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Send-ledger decision (exactly-one + supersede)
// ─────────────────────────────────────────────────────────────────────────

// The active ledger rows for one trade_invoice_id (status not superseded).
export interface LedgerRow {
  id: string;
  flag_set_hash: string;
}

export type LedgerActionKind = "skip" | "send" | "supersede";

export interface LedgerDecision {
  action: LedgerActionKind;
  // Rows to mark superseded before inserting the new one (supersede only).
  supersedesIds: string[];
  // True when the new email is an update (supersede path).
  isUpdate: boolean;
}

// Decide what to do given the currently-active ledger rows for this invoice and
// the new flag-set hash:
//   • an active row already carries this exact hash  -> skip (idempotent).
//   • active rows exist with a DIFFERENT hash        -> supersede (one update).
//   • no active rows                                 -> send (first notice).
export function decideLedgerAction(
  activeRows: LedgerRow[],
  newHash: string,
): LedgerDecision {
  const rows = activeRows ?? [];
  if (rows.some((r) => r.flag_set_hash === newHash)) {
    return { action: "skip", supersedesIds: [], isUpdate: false };
  }
  if (rows.length > 0) {
    return {
      action: "supersede",
      supersedesIds: rows.map((r) => r.id),
      isUpdate: true,
    };
  }
  return { action: "send", supersedesIds: [], isUpdate: false };
}
