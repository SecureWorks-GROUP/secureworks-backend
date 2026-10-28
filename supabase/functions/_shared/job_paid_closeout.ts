// Paid close-out rule for fencing and patio jobs (captain, 13 Oct 2026).
//
// When a fencing or patio job is paid, its card goes to Get Review (not Complete),
// a review text goes out once, and the card is archived 24 hours later. This module
// is the ONE answer to "is this job paid?" for that flow. It is pure: the reads live
// in ops-api/job_closeout.ts, which every step (the Xero sync move, the catch-up, the
// review sender, the archive sweep and the backlog list) goes through.
//
// "Paid" is the captain's strict check, all three must hold:
//   1. Every linked sales invoice that is not voided or deleted is PAID, and none is a
//      DRAFT (a draft is money we still mean to bill).
//   2. Every paying party has a paid final invoice. A paying party is a job_contacts
//      row not removed (removed_at null and status not 'removed') whose share_percentage
//      is not an explicit 0 (a null share counts; the owner and each neighbour on a
//      shared fence); a job with no such row has one payer, its client. A final needs
//      positive evidence: the Debt tab's rule (debt_ws_rules.ts invoiceKindOf), a final
//      reference ending (FIN, FINBAL or BAL with up to three digits, FINAL, PRIVATE)
//      whose first line starts "balance", "remaining", "remainder" or "final"; an unlabelled
//      invoice is never a final. An invoice belongs to the party its job_contact_id
//      names, else the party whose share letter is on its reference (SWF-26624-B-FINBAL
//      is share B), else the party whose Xero contact it carries, else the job's own
//      client (the primary party).
//   3. The money paid covers the sent quote plus agreed variations (customer accepted
//      or invoiced), short by no more than PAID_QUOTE_ROUNDING_INC (GST rounding). When the
//      job has no sent quote or no recorded quote value, rules 1 and 2 decide; when the
//      quote or variations could not be read, nothing is decided (QUOTE_READ_FAILURES).
//
// Outcomes: "paid" (all three), "paid_less_than_quoted" (1 and 2 hold, 3 fails: the
// card stays where it is and carries a marker), "not_paid" (1 or 2 fails), "undecided"
// (1 and 2 hold but the quote could not be read: nothing moves, texts, archives or is
// recorded, and the next run asks again).

import { invoiceKindOf, parseReference } from "../ops-api/debt_ws_rules.ts";

/** The only job types the paid close-out flow touches. */
export const CLOSEOUT_JOB_TYPES = ["fencing", "patio"] as const;

/** The statuses a paid job may move to Get Review from. */
export const CLOSEOUT_FROM_STATUSES = [
  "complete",
  "final_payment",
  "invoiced",
] as const;

export const CLOSEOUT_REVIEW_STATUS = "get_review";
export const CLOSEOUT_ARCHIVE_STATUS = "archived";

/** How long a card sits in Get Review before the sweep archives it. */
export const CLOSEOUT_ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Paid may fall short of the quote by this much (GST rounding) before it counts as short. */
export const PAID_QUOTE_ROUNDING_INC = 1;

/** Quote reasons that mean the quote or its variations could not be read, not that there is none. */
export const QUOTE_READ_FAILURES = [
  "quote_unreadable",
  "variations_unreadable",
  "quote_read_threw",
] as const;

export interface CloseoutJob {
  id: string;
  job_number: string | null;
  type: string | null;
  status: string | null;
  is_callback: boolean | null;
  deposit_invoice_id: string | null;
}

export interface CloseoutInvoice {
  xero_invoice_id: string | null;
  invoice_number: string | null;
  invoice_type: string | null;
  status: string | null;
  reference: string | null;
  total: number | string | null;
  amount_paid: number | string | null;
  job_contact_id: string | null;
  xero_contact_id: string | null;
  fully_paid_on: string | null;
  /** The first line item's description (line_items->0->>Description). */
  first_description?: string | null;
}

export interface CloseoutParty {
  id: string;
  contact_label: string | null;
  is_primary: boolean | null;
  share_percentage: number | string | null;
  removed_at: string | null;
  /** The legacy neighbour sync removes a party with status 'removed' and no removed_at. */
  status?: string | null;
  xero_contact_id: string | null;
}

/** The quote side of rule 3, read by ops-api through job_quote_values. */
export interface CloseoutQuote {
  /** Sent quote value inc GST, null when unknown. */
  quote_total_inc: number | null;
  /** Agreed variations (customer accepted or invoiced) inc GST; null when they could not be read. */
  variations_inc: number | null;
  /** Why the quote is unknown, when it is. */
  unknown_reason: string | null;
}

export type PaidOutcome =
  | "paid"
  | "paid_less_than_quoted"
  | "not_paid"
  | "undecided";

export interface PartyPaidView {
  key: string;
  label: string | null;
  is_owner: boolean;
  has_paid_final: boolean;
}

export interface PaidVerdict {
  outcome: PaidOutcome;
  /** Every rule that failed, as codes ("draft_invoice", "party_without_paid_final:B"). */
  reasons: string[];
  parties: PartyPaidView[];
  paid_total_inc: number;
  /** Quote plus agreed variations, inc GST; null when unknown. */
  expected_inc: number | null;
  /** How far paid falls short of expected (0 when it covers it); null when unknown. */
  shortfall_inc: number | null;
  quote_known: boolean;
  quote_unknown_reason: string | null;
  /** The newest fully_paid_on among the live invoices (YYYY-MM-DD), or null. */
  last_paid_on: string | null;
}

const text = (v: unknown): string => String(v ?? "").trim();
const upper = (v: unknown): string => text(v).toUpperCase();

function money(v: unknown): number {
  const n = typeof v === "number" ? v : Number(text(v));
  return Number.isFinite(n) ? n : 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function isCloseoutJobType(type: unknown): boolean {
  return (CLOSEOUT_JOB_TYPES as readonly string[]).includes(
    text(type).toLowerCase(),
  );
}

export function isCloseoutFromStatus(status: unknown): boolean {
  return (CLOSEOUT_FROM_STATUSES as readonly string[]).includes(
    text(status).toLowerCase(),
  );
}

/**
 * The automatic holds (captain answer 4): a job in Rectification, or one marked as a
 * callback. A held job never moves, is never texted and is never archived.
 */
export function closeoutHold(
  job: Pick<CloseoutJob, "status" | "is_callback">,
): "rectification" | "callback" | null {
  if (text(job.status).toLowerCase() === "rectification") {
    return "rectification";
  }
  if (job.is_callback === true) return "callback";
  return null;
}

/** A sales invoice that still counts: ACCREC (or untyped) and not voided or deleted. */
export function isLiveSalesInvoice(inv: CloseoutInvoice): boolean {
  const type = upper(inv.invoice_type);
  if (type && type !== "ACCREC") return false;
  const status = upper(inv.status);
  return status !== "VOIDED" && status !== "DELETED";
}

/** A final by positive evidence (invoiceKindOf), and never the job's own deposit invoice. */
export function isFinalInvoice(
  inv: CloseoutInvoice,
  depositInvoiceId: string | null,
): boolean {
  if (
    depositInvoiceId && text(inv.xero_invoice_id) === text(depositInvoiceId)
  ) {
    return false;
  }
  return invoiceKindOf(inv.reference, inv.first_description).kind === "final";
}

/** The parties who pay: rows not removed (removed_at or status 'removed'), unless their
 *  share is explicitly zero (a null share is a paying party: the party writer stores null
 *  when no portions were sent). */
export function payingParties(parties: CloseoutParty[]): CloseoutParty[] {
  return parties.filter((p) =>
    !p.removed_at && text(p.status).toLowerCase() !== "removed" &&
    (text(p.share_percentage) === "" || money(p.share_percentage) !== 0)
  );
}

/** The key "owner" stands for the job's own client when no party row names one. */
export const OWNER_KEY = "owner";

function ownerParty(paying: CloseoutParty[]): CloseoutParty | null {
  const primary = paying.filter((p) => p.is_primary === true);
  if (primary.length === 1) return primary[0];
  if (primary.length === 0 && paying.length === 1) return paying[0];
  return null;
}

/**
 * The party key one invoice belongs to: a paying party's id, OWNER_KEY when the job has
 * no party rows, or "unmatched:<why>" when it names somebody who is not a paying party.
 */
export function invoicePartyKey(
  inv: CloseoutInvoice,
  paying: CloseoutParty[],
): string {
  const owner = ownerParty(paying);
  const ownerKey = owner ? owner.id : OWNER_KEY;
  if (inv.job_contact_id) {
    if (paying.some((p) => p.id === inv.job_contact_id)) {
      return inv.job_contact_id;
    }
    return `unmatched:job_contact:${inv.job_contact_id}`;
  }
  const letter = parseReference(inv.reference).letter;
  if (letter) {
    const byLabel = paying.filter((p) => upper(p.contact_label) === letter);
    if (byLabel.length === 1) return byLabel[0].id;
    // A lone "A" on a job with no labelled rows is the client's.
    if (letter === "A" && byLabel.length === 0 && paying.length === 0) {
      return OWNER_KEY;
    }
    return `unmatched:letter:${letter}`;
  }
  const xero = text(inv.xero_contact_id).toLowerCase();
  if (xero) {
    const byXero = paying.filter((p) =>
      text(p.xero_contact_id).toLowerCase() === xero
    );
    if (byXero.length === 1) return byXero[0].id;
  }
  return ownerKey;
}

function newestDate(values: (string | null)[]): string | null {
  const dates = values.map((v) => text(v).slice(0, 10)).filter((v) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v)
  ).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

/** The strict paid check. Pure. A null quote is a pre-check (not read yet): rules 1 and 2 decide. */
export function evaluateJobPaid(input: {
  job: CloseoutJob;
  invoices: CloseoutInvoice[];
  parties: CloseoutParty[];
  quote: CloseoutQuote | null;
}): PaidVerdict {
  const reasons: string[] = [];
  const live = input.invoices.filter(isLiveSalesInvoice);
  const depositId = input.job.deposit_invoice_id;

  // Rule 1: every live invoice paid, none a draft.
  if (live.length === 0) reasons.push("no_invoices");
  if (live.some((inv) => upper(inv.status) === "DRAFT")) {
    reasons.push("draft_invoice");
  }
  if (
    live.some((inv) =>
      upper(inv.status) !== "PAID" && upper(inv.status) !== "DRAFT"
    )
  ) {
    reasons.push("unpaid_invoice");
  }

  // Rule 2: every paying party has a paid final.
  const paying = payingParties(input.parties);
  const owner = ownerParty(paying);
  const partyKeys = paying.length
    ? paying.map((p) => ({
      key: p.id,
      label: p.contact_label ? upper(p.contact_label) : null,
      is_owner: owner?.id === p.id,
    }))
    : [{ key: OWNER_KEY, label: null, is_owner: true }];
  const paidFinalKeys = new Set(
    live.filter((inv) =>
      upper(inv.status) === "PAID" && isFinalInvoice(inv, depositId)
    ).map((inv) => invoicePartyKey(inv, paying)),
  );
  const parties: PartyPaidView[] = partyKeys.map((p) => ({
    ...p,
    has_paid_final: paidFinalKeys.has(p.key),
  }));
  for (const p of parties) {
    if (!p.has_paid_final) {
      reasons.push(
        `party_without_paid_final:${p.label ?? (p.is_owner ? "owner" : p.key)}`,
      );
    }
  }

  // Rule 3: paid covers the quote plus agreed variations.
  const paidTotal = round2(
    live.reduce((sum, inv) => sum + money(inv.amount_paid), 0),
  );
  const quoteTotal = input.quote?.quote_total_inc ?? null;
  const variations = input.quote?.variations_inc ?? null;
  const quoteKnown = quoteTotal !== null && quoteTotal > 0 &&
    variations !== null;
  let expected: number | null = null;
  let shortfall: number | null = null;
  let quoteShort = false;
  if (quoteKnown) {
    expected = round2(quoteTotal! + variations!);
    shortfall = round2(Math.max(0, expected - paidTotal));
    quoteShort = shortfall > PAID_QUOTE_ROUNDING_INC;
  }

  const quoteUnknownReason = quoteKnown ? null : (input.quote?.unknown_reason ??
    (variations === null && quoteTotal !== null
      ? "variations_unreadable"
      : "quote_unknown"));
  const quoteUnread = input.quote !== null && quoteUnknownReason !== null &&
    (QUOTE_READ_FAILURES as readonly string[]).includes(quoteUnknownReason);

  const rules12 = reasons.length === 0;
  if (quoteShort) reasons.push("paid_less_than_quoted");
  if (rules12 && quoteUnread) reasons.push(quoteUnknownReason!);
  const outcome: PaidOutcome = !rules12
    ? "not_paid"
    : quoteUnread
    ? "undecided"
    : quoteShort
    ? "paid_less_than_quoted"
    : "paid";
  return {
    outcome,
    reasons,
    parties,
    paid_total_inc: paidTotal,
    expected_inc: expected,
    shortfall_inc: shortfall,
    quote_known: quoteKnown,
    quote_unknown_reason: quoteUnknownReason,
    last_paid_on: newestDate(live.map((inv) => inv.fully_paid_on)),
  };
}
