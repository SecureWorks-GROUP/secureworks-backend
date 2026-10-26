// Deposit advance rule for fencing and patio jobs (captain, 26 Oct 2026).
//
// A fencing or patio job moves along its early columns by payment, so nobody tracks each
// job by hand:
//   - accepted          -> awaiting_deposit  when its deposit invoice went out
//   - accepted or
//     awaiting_deposit  -> order_materials   when every live deposit invoice is paid in full
//                                            (patio: -> approvals while council is needed
//                                            or not decided)
//
// This module is the ONE answer to "is this job's deposit sent / paid?" for that flow. It
// is pure: the reads, the switch and every write live in ops-api/job_deposit_advance.ts.
// xero-sync uses isDepositInvoice only as a cheap pre-filter before it posts.
//
// "Deposit invoice" is any client sales invoice on the job whose reference ends in DEP
// with up to three digits (SWF-261369-DEP50, SWF-26535-B-DEP50, the debt rules' ending,
// debt_ws_rules.ts parseReference), or the job's own pointer (jobs.deposit_invoice_id).
// The pointer alone is not enough: it is overwritten per invoice on a shared fence and it
// never names a deposit made by hand in Xero.
//
// "Paid" (captain answer 3, 26 Oct 2026): every paying party has a live deposit invoice,
// and every live deposit invoice (not voided or deleted) is PAID with nothing left due. A
// part payment never counts, a draft never counts, and a job with no live deposit invoice
// is not paid. The paying parties and which party an invoice belongs to are the paid
// close-out's rule (_shared/job_paid_closeout.ts payingParties, invoicePartyKey): on a
// shared fence that is the owner and each neighbour with a share, so a party whose
// deposit was never raised holds the job back.

import { parseReference } from "../ops-api/debt_ws_rules.ts";
import {
  type CloseoutParty,
  invoicePartyKey,
  OWNER_KEY,
  payingParties,
} from "./job_paid_closeout.ts";

/** The only job types the deposit advance touches. */
export const DEPOSIT_ADVANCE_JOB_TYPES = ["fencing", "patio"] as const;

/** A job lands in Awaiting Deposit only from Accepted. */
export const DEPOSIT_LAND_FROM_STATUSES = ["accepted"] as const;
export const DEPOSIT_LAND_STATUS = "awaiting_deposit";

/** A paid deposit moves a job only from these: never one someone already moved on. */
export const DEPOSIT_PAID_FROM_STATUSES = ["accepted", "awaiting_deposit"] as const;

export const DEPOSIT_ORDER_MATERIALS_STATUS = "order_materials";
export const DEPOSIT_APPROVALS_STATUS = "approvals";

/** Statuses a job can be in once its deposit has moved it on, where a voided or unpaid
 *  deposit is flagged for a person (captain answer 8: flag it, a person decides). */
export const DEPOSIT_FLAG_STATUSES = [
  "approvals",
  "order_materials",
  "processing",
  "awaiting_supplier",
  "order_confirmed",
  "schedule_install",
  "scheduled",
  "in_progress",
  "rectification",
] as const;

/** Money left due under this counts as nothing due (Xero rounds to the cent). */
export const PAID_TOLERANCE = 0.005;

export interface DepositJob {
  id: string;
  job_number: string | null;
  type: string | null;
  status: string | null;
  deposit_invoice_id: string | null;
  /** jobs.council_required: false = no council; true or null = needed or not decided. */
  council_required?: boolean | null;
}

export interface DepositInvoice {
  xero_invoice_id: string | null;
  invoice_number: string | null;
  invoice_type: string | null;
  status: string | null;
  reference: string | null;
  total: number | string | null;
  amount_due: number | string | null;
  amount_paid: number | string | null;
  fully_paid_on: string | null;
  /** Which party the invoice is for (invoicePartyKey); absent reads as null. */
  job_contact_id?: string | null;
  xero_contact_id?: string | null;
}

export interface DepositView {
  xero_invoice_id: string | null;
  invoice_number: string | null;
  status: string;
  amount_due: number;
}

export interface DepositPaidVerdict {
  paid: boolean;
  /** Why not, as codes: "no_deposit_invoice", "party_without_deposit:B",
   *  "draft_deposit:INV-1", "part_paid:INV-1", "unpaid_deposit:INV-1". Empty when paid. */
  reasons: string[];
  deposits: DepositView[];
  /** The newest fully_paid_on among the live deposits (YYYY-MM-DD), or null. */
  last_paid_on: string | null;
}

const text = (v: unknown): string => String(v ?? "").trim();
const upper = (v: unknown): string => text(v).toUpperCase();

function money(v: unknown): number {
  const n = typeof v === "number" ? v : Number(text(v));
  return Number.isFinite(n) ? n : 0;
}

export function isDepositAdvanceJobType(type: unknown): boolean {
  return (DEPOSIT_ADVANCE_JOB_TYPES as readonly string[]).includes(
    text(type).toLowerCase(),
  );
}

const DEP_ENDING = /^DEP\d{0,3}$/;

/** A client sales invoice that is a deposit: a DEP reference ending, or the job's pointer. */
export function isDepositInvoice(
  inv: Pick<DepositInvoice, "xero_invoice_id" | "invoice_type" | "reference">,
  depositInvoiceId: string | null | undefined,
): boolean {
  const type = upper(inv.invoice_type);
  if (type && type !== "ACCREC") return false;
  const id = text(inv.xero_invoice_id);
  if (id && id === text(depositInvoiceId)) return true;
  const ending = parseReference(inv.reference).ending;
  return !!ending && DEP_ENDING.test(ending);
}

function isVoided(status: unknown): boolean {
  const s = upper(status);
  return s === "VOIDED" || s === "DELETED";
}

/** The deposit invoices that still count: deposits not voided or deleted. */
export function liveDepositInvoices<T extends DepositInvoice>(
  invoices: T[],
  depositInvoiceId: string | null | undefined,
): T[] {
  return invoices.filter((inv) =>
    isDepositInvoice(inv, depositInvoiceId) && !isVoided(inv.status)
  );
}

function label(inv: DepositInvoice): string {
  return text(inv.invoice_number) || text(inv.xero_invoice_id) || "?";
}

function newestDate(values: (string | null)[]): string | null {
  const dates = values.map((v) => text(v).slice(0, 10)).filter((v) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v)
  ).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

/** One invoice is paid in full: PAID in Xero with nothing left due. */
export function depositInvoicePaidInFull(inv: DepositInvoice): boolean {
  return upper(inv.status) === "PAID" && money(inv.amount_due) <= PAID_TOLERANCE;
}

/** The paying parties (job_contacts rows) with no live deposit invoice of their own. */
function partiesWithoutDeposit(
  live: DepositInvoice[],
  parties: CloseoutParty[],
): string[] {
  const paying = payingParties(parties);
  const keys = new Set(live.map((inv) =>
    invoicePartyKey({
      ...inv,
      job_contact_id: inv.job_contact_id ?? null,
      xero_contact_id: inv.xero_contact_id ?? null,
    }, paying)
  ));
  if (paying.length === 0) return keys.has(OWNER_KEY) ? [] : ["owner"];
  return paying.filter((p) => !keys.has(p.id)).map((p) =>
    p.contact_label ? upper(p.contact_label) : p.is_primary ? "owner" : p.id
  );
}

/** The paid rule. Pure. */
export function evaluateDepositPaid(input: {
  job: Pick<DepositJob, "deposit_invoice_id">;
  invoices: DepositInvoice[];
  parties: CloseoutParty[];
}): DepositPaidVerdict {
  const live = liveDepositInvoices(input.invoices, input.job.deposit_invoice_id);
  const reasons: string[] = [];
  if (live.length === 0) reasons.push("no_deposit_invoice");
  else {
    for (const party of partiesWithoutDeposit(live, input.parties)) {
      reasons.push(`party_without_deposit:${party}`);
    }
  }
  for (const inv of live) {
    const status = upper(inv.status);
    if (status === "PAID") {
      if (money(inv.amount_due) > PAID_TOLERANCE) {
        reasons.push(`part_paid:${label(inv)}`);
      }
    } else if (status === "DRAFT" || status === "SUBMITTED") {
      reasons.push(`draft_deposit:${label(inv)}`);
    } else if (money(inv.amount_paid) > PAID_TOLERANCE) {
      reasons.push(`part_paid:${label(inv)}`);
    } else {
      reasons.push(`unpaid_deposit:${label(inv)}`);
    }
  }
  return {
    paid: reasons.length === 0,
    reasons,
    deposits: live.map((inv) => ({
      xero_invoice_id: inv.xero_invoice_id,
      invoice_number: inv.invoice_number,
      status: upper(inv.status),
      amount_due: money(inv.amount_due),
    })),
    last_paid_on: newestDate(live.map((inv) => inv.fully_paid_on)),
  };
}

/**
 * The landing rule: the job has at least one live deposit invoice and none of them is a
 * draft (a draft was never sent). The caller has already seen one of them sent.
 */
export function depositInvoicesSent(input: {
  job: Pick<DepositJob, "deposit_invoice_id">;
  invoices: DepositInvoice[];
}): { sent: boolean; reasons: string[] } {
  const live = liveDepositInvoices(input.invoices, input.job.deposit_invoice_id);
  const reasons: string[] = [];
  if (live.length === 0) reasons.push("no_deposit_invoice");
  for (const inv of live) {
    const status = upper(inv.status);
    if (status === "DRAFT" || status === "SUBMITTED") {
      reasons.push(`draft_deposit:${label(inv)}`);
    }
  }
  return { sent: reasons.length === 0, reasons };
}

/**
 * Where a paid deposit sends the job (captain answers 4 and 5): fencing to Order
 * Materials; patio to Approvals while council is needed or not decided
 * (council_required true or null, or anything unclear), to Order Materials only when
 * council_required is explicitly false. Null for any other job type.
 */
export function depositPaidTargetStatus(
  job: Pick<DepositJob, "type" | "council_required">,
): string | null {
  const type = text(job.type).toLowerCase();
  if (type === "fencing") return DEPOSIT_ORDER_MATERIALS_STATUS;
  if (type === "patio") {
    return job.council_required === false
      ? DEPOSIT_ORDER_MATERIALS_STATUS
      : DEPOSIT_APPROVALS_STATUS;
  }
  return null;
}

export type DepositFlagReason = "deposit_voided" | "deposit_unpaid";

export interface DepositFlag {
  reason: DepositFlagReason;
  xero_invoice_id: string | null;
  invoice_number: string | null;
  invoice_status: string;
}

/**
 * After a job has moved on from the deposit columns: the deposit that moved it is voided
 * or deleted, or no longer paid in full (a payment taken off for a refund), and the job's
 * deposits as they stand no longer pass the paid rule. Returns the flag, or null. A void
 * whose replacement deposit is paid in full flags nothing. Pure.
 *
 * `countedIds` are the invoices that counted when the job moved (the automatic move
 * records them); when empty (a job a person moved on), only a voided or deleted deposit
 * invoice can raise the flag.
 *
 * `cleared` is the flag a person already cleared (captain answer 8: a person decides):
 * the same reason on the same invoice is never raised again, only another one.
 */
export function depositFlagFor(input: {
  job: Pick<DepositJob, "deposit_invoice_id" | "status">;
  invoices: DepositInvoice[];
  parties: CloseoutParty[];
  countedIds: string[];
  cleared?: { reason: string | null; xero_invoice_id: string | null } | null;
}): DepositFlag | null {
  if (
    !(DEPOSIT_FLAG_STATUSES as readonly string[]).includes(
      text(input.job.status).toLowerCase(),
    )
  ) return null;
  const pointer = input.job.deposit_invoice_id;
  const counted = new Set(input.countedIds.map(text).filter(Boolean));
  const deposits = input.invoices.filter((inv) => isDepositInvoice(inv, pointer));
  const wasCleared = (reason: DepositFlagReason, inv: DepositInvoice) =>
    !!input.cleared && input.cleared.reason === reason &&
    text(input.cleared.xero_invoice_id) === text(inv.xero_invoice_id);
  if (
    evaluateDepositPaid({
      job: input.job,
      invoices: input.invoices,
      parties: input.parties,
    }).paid
  ) {
    return null;
  }
  const voided = deposits.find((inv) =>
    isVoided(inv.status) &&
    (counted.size === 0 || counted.has(text(inv.xero_invoice_id))) &&
    !wasCleared("deposit_voided", inv)
  );
  if (voided) {
    return {
      reason: "deposit_voided",
      xero_invoice_id: voided.xero_invoice_id,
      invoice_number: voided.invoice_number,
      invoice_status: upper(voided.status),
    };
  }
  const unpaid = deposits.find((inv) =>
    counted.has(text(inv.xero_invoice_id)) && !isVoided(inv.status) &&
    !depositInvoicePaidInFull(inv) && !wasCleared("deposit_unpaid", inv)
  );
  if (unpaid) {
    return {
      reason: "deposit_unpaid",
      xero_invoice_id: unpaid.xero_invoice_id,
      invoice_number: unpaid.invoice_number,
      invoice_status: upper(unpaid.status),
    };
  }
  return null;
}

/**
 * The client text on a paid-deposit move to Order Materials (captain answer 6, 26 Oct
 * 2026). The old client-comms deposit_paid template, reworded to the owner-comms rule (no
 * em dashes). ops-api sendClientUpdate's deposit_paid template is this same text.
 */
export const DEPOSIT_RECEIVED_TEXT_TEMPLATE =
  "Hi {name},\nThanks, we've received your deposit. We're now ordering your materials and we'll be in touch to book your install.\nCheers, Shaun";

export function depositReceivedText(clientName: string | null | undefined): string {
  const first = text(clientName).split(/\s+/)[0] || "there";
  return DEPOSIT_RECEIVED_TEXT_TEMPLATE.replace("{name}", first);
}
