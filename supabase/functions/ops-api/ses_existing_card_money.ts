// deno-lint-ignore-file no-explicit-any
/**
 * Does this card ALREADY have live money in Xero?
 *
 * WHY THIS EXISTS
 * ---------------
 * The review cockpit decides "is there an invoice on this card" from the
 * docket's `xero_binding` alone. A hand-made Xero invoice that was never linked
 * to the job, or one linked to the job but never bound to the current docket,
 * is invisible to that read — so the cockpit reports no invoice and tells the
 * operator, in the APPROVE INVOICE control, to "mint the draft first".
 *
 * Measured live 2026-08-06: all 16 Docs Ready cards with no bound invoice
 * already had live money under their own reference — SEVEN PAID, six
 * AUTHORISED, three unlinked DRAFTs — and the proposal the cockpit offered
 * differed from what was actually billed (SWMS-26841: proposal $561 against
 * INV-0850 already PAID at $882.20). Acting on that flag double-bills a
 * customer who has already paid us.
 *
 * This module answers the question from the Xero mirror BY REFERENCE, which is
 * the surface that does not lie, and its answer is only ever used to REFUSE.
 * There is deliberately no path here that makes a card more approvable.
 *
 * INCLUSIVE, NOT UNIQUE — AND THAT IS THE POINT
 * ---------------------------------------------
 * `makesafe_invoice_reference_match.ts` is unique-match-only: it answers "which
 * card owns this money" and correctly returns nothing for a claim with two
 * candidates. That is the right shape for ATTRIBUTION and the wrong shape for
 * REFUSAL — a contested reference is more reason to stop, not less. So this
 * module consumes that module's reference GRAMMAR (`builderReferenceDigits` /
 * `invoiceNamesBuilderReference`, never restated here) and applies it
 * inclusively. It also does NOT restrict to issued statuses: a live DRAFT under
 * our own reference is exactly the second-draft case we are preventing.
 *
 * Fail-closed: an unreadable mirror reports `unreadable`, which the consumer
 * treats as "cannot rule out existing money" and still refuses.
 *
 * A PRIOR-CYCLE TERMINAL STATE MUST NEVER SILENCE A CURRENT-CYCLE QUESTION
 * ------------------------------------------------------------------------
 * The mirror image of that rule applies here, and it is the same rule: a
 * re-attendance is genuinely NEW WORK, so an invoice that belongs only to an
 * EARLIER attendance cycle is not this cycle's money and must not refuse this
 * cycle. Prior-cycle money was never the double-bill risk. The cycle boundary
 * is `makesafeInvoiceAttendanceCycle` — the card's one existing cycle engine,
 * consumed here, never restated — and the fail-closed direction for THIS
 * question is that an `unknown` cycle still refuses.
 */

import {
  builderReferenceDigits,
  invoiceNamesBuilderReference,
  type SesMatchInvoice,
} from "./makesafe_invoice_reference_match.ts";
import { makesafeInvoiceAttendanceCycle } from "./makesafe_docs_ready_invoice.ts";

/** Statuses that mean the invoice is dead and cannot be double-billed against. */
const DEAD_INVOICE_STATUSES = ["VOIDED", "DELETED"];

export type SesExistingMoneyAttribution =
  /** `xero_invoices.job_id` is this job: the card's own money, just not bound. */
  | "own_job"
  /** Unlinked live ACCREC whose reference names this card's builder reference. */
  | "unlinked_reference_match";

export interface SesExistingCardMoneyRow {
  invoice_number: string | null;
  xero_invoice_id: string | null;
  status: string | null;
  total: number | null;
  reference: string | null;
  attribution: SesExistingMoneyAttribution;
  /** `current` or `unknown`; prior-cycle money is never reported. */
  attendance_cycle: "current" | "unknown";
}

export interface SesExistingCardMoney {
  /** True when any live invoice was found, OR the mirror could not be read. */
  exists: boolean;
  unreadable: boolean;
  /**
   * False means the question was NOT ASKED (a card whose docket already binds
   * its invoice), which is never the same claim as "there is no other money"
   * and is never a licence to mint.
   */
  evaluated: boolean;
  rows: SesExistingCardMoneyRow[];
}

export const NO_EXISTING_CARD_MONEY: SesExistingCardMoney = {
  exists: false,
  unreadable: false,
  evaluated: true,
  rows: [],
};

/** The card already binds an invoice, so the mirror was never questioned. */
export const NOT_EVALUATED_CARD_MONEY: SesExistingCardMoney = {
  exists: false,
  unreadable: false,
  evaluated: false,
  rows: [],
};

function isLive(invoice: SesMatchInvoice): boolean {
  const status = String(invoice.status || "").toUpperCase();
  return !DEAD_INVOICE_STATUSES.includes(status);
}

function isAccrec(invoice: SesMatchInvoice): boolean {
  return String(invoice.invoice_type || "").toUpperCase() === "ACCREC";
}

function toRow(
  invoice: SesMatchInvoice,
  attribution: SesExistingMoneyAttribution,
  attendanceCycle: "current" | "unknown",
): SesExistingCardMoneyRow {
  const total = Number(invoice.total);
  return {
    invoice_number: invoice.invoice_number ?? null,
    xero_invoice_id: invoice.id ?? null,
    status: invoice.status ?? null,
    total: Number.isFinite(total) ? total : null,
    reference: invoice.reference ?? null,
    attribution,
    attendance_cycle: attendanceCycle,
  };
}

/**
 * The card facts the cycle boundary needs. `reattend_count` of zero (or an
 * absent detail row) means the card has one attendance and all its money is
 * current.
 */
export interface SesExistingCardMoneyCycleDetail {
  reattend_count?: number | null;
  last_reattend_at?: string | null;
}

/**
 * Pure classification. `boundXeroInvoiceId` is the invoice the docket already
 * binds — it is this card's expected money, so it is never reported as a
 * surprise.
 */
export function classifyExistingCardMoney(
  jobId: string,
  externalRef: unknown,
  invoices: readonly SesMatchInvoice[],
  boundXeroInvoiceId: string | null,
  cycleDetail: SesExistingCardMoneyCycleDetail | null = null,
): SesExistingCardMoney {
  const bound = String(boundXeroInvoiceId || "").trim();
  const digits = builderReferenceDigits(externalRef);
  const seen = new Set<string>();
  const rows: SesExistingCardMoneyRow[] = [];

  for (const invoice of invoices) {
    if (!isAccrec(invoice) || !isLive(invoice)) continue;
    const id = String(invoice.id || "").trim();
    if (id && bound && id === bound) continue;
    if (id && seen.has(id)) continue;

    const ownJob = String(invoice.job_id || "").trim() === String(jobId).trim() &&
      String(invoice.job_id || "").trim().length > 0;
    // Inclusive on purpose: a reference hit refuses even when the invoice is
    // attributed elsewhere or contested, because a mint here would still be a
    // second invoice on the same builder reference.
    //
    // `invoiceNamesBuilderReference` returns the ARRAY of digit runs it
    // matched, and an empty array is truthy — testing it directly matches every
    // invoice on the board. Compare the length.
    const matchedDigits = digits.length > 0
      ? invoiceNamesBuilderReference(invoice.reference, digits)
      : [];
    const referenceHit = matchedDigits.length > 0;

    if (!ownJob && !referenceHit) continue;
    // A re-attendance is new work: an invoice raised for an EARLIER attendance
    // cycle is not this cycle's money and must not refuse it. `unknown` still
    // refuses — this question fails closed towards the double-bill.
    const cycle = makesafeInvoiceAttendanceCycle(cycleDetail, invoice);
    if (cycle === "prior") continue;
    if (id) seen.add(id);
    rows.push(
      toRow(invoice, ownJob ? "own_job" : "unlinked_reference_match", cycle),
    );
  }

  return {
    exists: rows.length > 0,
    unreadable: false,
    evaluated: true,
    rows,
  };
}

export const UNREADABLE_CARD_MONEY: SesExistingCardMoney = {
  exists: true,
  unreadable: true,
  evaluated: true,
  rows: [],
};

/**
 * Page size for the per-digit-run reference read. A FULL page is treated as a
 * truncated read (`unreadable`), never as a complete answer: an unordered
 * `LIKE` window that happens to exclude the card's own already-billed invoice
 * would restore the mint invitation this module exists to remove.
 */
const REFERENCE_PAGE_SIZE = 500;

/**
 * Read the Xero mirror for this card: everything attributed to the job, plus
 * everything naming its builder reference. Any read fault, or a truncated
 * reference page, yields `unreadable: true`, which the consumer must treat as
 * existing money.
 */
export async function readSesExistingCardMoney(
  client: any,
  jobId: string,
  externalRef: unknown,
  boundXeroInvoiceId: string | null,
  cycleDetail: SesExistingCardMoneyCycleDetail | null = null,
): Promise<SesExistingCardMoney> {
  const columns =
    "id:xero_invoice_id,invoice_number,reference,status,invoice_type,job_id,total,created_at";
  const collected: SesMatchInvoice[] = [];

  const byJob = await client.from("xero_invoices").select(columns)
    .eq("job_id", jobId);
  if (byJob?.error) return UNREADABLE_CARD_MONEY;
  collected.push(...((byJob?.data || []) as SesMatchInvoice[]));

  for (const digits of builderReferenceDigits(externalRef)) {
    const byRef = await client.from("xero_invoices").select(columns)
      .eq("invoice_type", "ACCREC")
      .like("reference", `%${digits}%`)
      .limit(REFERENCE_PAGE_SIZE);
    if (byRef?.error) return UNREADABLE_CARD_MONEY;
    const rows = (byRef?.data || []) as SesMatchInvoice[];
    if (rows.length >= REFERENCE_PAGE_SIZE) return UNREADABLE_CARD_MONEY;
    collected.push(...rows);
  }

  return classifyExistingCardMoney(
    jobId,
    externalRef,
    collected,
    boundXeroInvoiceId,
    cycleDetail,
  );
}

/**
 * The whole card-money question, including the `external_ref` read that feeds
 * the reference half. Owned here so no caller can degrade the reference half to
 * silence: an unreadable or absent detail row is `unreadable` money, not
 * "job-linked invoices only" — which would return `exists: false` for exactly
 * the unlinked-invoice case this module exists to catch.
 */
export async function readSesExistingCardMoneyForJob(
  client: any,
  jobId: string,
  boundXeroInvoiceId: string | null,
): Promise<SesExistingCardMoney> {
  const detail = await client.from("makesafe_job_details")
    .select("external_ref,reattend_count,last_reattend_at")
    .eq("job_id", jobId).maybeSingle();
  if (detail?.error || !detail?.data) return UNREADABLE_CARD_MONEY;
  const row = detail.data as Record<string, unknown>;
  return await readSesExistingCardMoney(
    client,
    jobId,
    row.external_ref,
    boundXeroInvoiceId,
    {
      reattend_count: Number(row.reattend_count ?? 0) || 0,
      last_reattend_at: row.last_reattend_at == null
        ? null
        : String(row.last_reattend_at),
    },
  );
}

/** One operator-facing sentence naming the money that already exists. */
export function describeExistingCardMoney(money: SesExistingCardMoney): string {
  if (!money.evaluated) {
    return "This card's Xero money was not checked, so it is not possible to rule out that an invoice already exists.";
  }
  if (money.unreadable) {
    return "The Xero mirror could not be read, so it is not possible to rule out that this card already has an invoice.";
  }
  const parts = money.rows.slice(0, 4).map((row) => {
    const total = row.total === null ? "" : ` $${row.total.toFixed(2)}`;
    const where = row.attribution === "own_job"
      ? "on this card"
      : `unlinked, reference ${row.reference ?? "?"}`;
    return `${row.invoice_number ?? "(no number)"} ${row.status ?? "?"}${total} (${where})`;
  });
  const more = money.rows.length > parts.length
    ? ` and ${money.rows.length - parts.length} more`
    : "";
  return `Xero already carries live money for this card: ${parts.join("; ")}${more}.`;
}
