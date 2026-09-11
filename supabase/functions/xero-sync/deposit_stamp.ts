import { insertCapturedEvidence } from "../_shared/evidence/capture_guard.ts";
import { automationLaneEnabled } from "../_shared/automation_switch.ts";

// Deposit stamp (ACCREC) — projects "the deposit invoice is PAID in Xero" onto
// jobs.deposit_at.
//
// Why this exists: the desks read jobs.deposit_at to answer "has this job's
// deposit landed?". Nothing ever wrote it from Xero. deposit_at was only set as
// a side effect of a human moving the job into status 'deposit'
// (ops-api update_job_status), so a job that took a deposit while sitting in a
// later status (SWF-261334: order_materials, deposit invoice PAID, deposit_at
// null) reads as "no deposit" forever, and BOOKKEEPING and the sales desks
// disagree about the same money.
//
// Boundaries this respects:
//   * jobs.status belongs to the desks. This never moves a job.
//   * a stamp is written once. An existing deposit_at is never overwritten and
//     never cleared, including when the invoice is later voided or deleted —
//     that contradiction is logged as a business event for a human, because
//     silently un-stamping money is how the two desks got out of sync in the
//     first place.
//   * the invoice must be the job's OWN deposit invoice
//     (jobs.deposit_invoice_id), not merely an invoice linked to the job.

export interface DepositStampJob {
  id?: string | null;
  job_number?: string | null;
  deposit_at?: string | null;
  deposit_invoice_id?: string | null;
}

export type DepositStampDecision =
  | {
    action: "stamp";
    deposit_at: string;
    // Which provider timestamp the stamp came from. 'sync_time' means Xero
    // gave us no usable date and we recorded when we observed the payment.
    source: "fully_paid_on" | "updated_date" | "sync_time";
  }
  | {
    action: "log_contradiction";
    invoice_status: string;
    reason: string;
  }
  | null;

const VOID_STATUSES = new Set(["VOIDED", "DELETED"]);

// Xero dates arrive as "/Date(1690000000000+0000)/", an ISO timestamp, or a
// plain "YYYY-MM-DD". Returns a full ISO timestamp (deposit_at is a timestamp,
// unlike trade_invoices.paid_at which is a date).
export function xeroDateToIsoTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;
  const m = s.match(/\/Date\((-?\d+)([+-]\d+)?\)\//);
  if (m) {
    const d = new Date(parseInt(m[1], 10));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // A zoneless date or timestamp is the moment Xero means, read as UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00.000Z`;
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(s)) {
    const d = new Date(`${s}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Cheap pre-filter so the sync loop skips a jobs lookup for most invoices. */
// deno-lint-ignore no-explicit-any
export function depositStampRelevant(inv: any): boolean {
  if (!inv || inv.Type !== "ACCREC") return false;
  if (!String(inv.InvoiceID || "").trim()) return false;
  const status = String(inv.Status || "").trim().toUpperCase();
  return status === "PAID" || VOID_STATUSES.has(status);
}

// Exact match, deliberately. The database lookup that finds the job is an
// exact `.eq('deposit_invoice_id', InvoiceID)`, so a looser comparison here
// would only ever disagree with the row we were handed.
const sameInvoice = (a: unknown, b: unknown) => {
  const x = String(a ?? "").trim();
  const y = String(b ?? "").trim();
  return !!x && x === y;
};

/**
 * Pure decision. `now` is the sync time and is only used as the last-resort
 * stamp when Xero supplies no usable date.
 */
export function depositStampDecision(
  // deno-lint-ignore no-explicit-any
  inv: any,
  job: DepositStampJob | null | undefined,
  now: Date = new Date(),
): DepositStampDecision {
  if (!inv || !job) return null;
  if (inv.Type !== "ACCREC") return null;
  // Only the job's own deposit invoice may stamp its deposit.
  if (!sameInvoice(inv.InvoiceID, job.deposit_invoice_id)) return null;

  const status = String(inv.Status || "").trim().toUpperCase();
  const alreadyStamped = !!String(job.deposit_at || "").trim();

  if (VOID_STATUSES.has(status)) {
    // Never clear a stamp. A voided deposit invoice against a stamped job is a
    // real-world contradiction a human has to resolve (credit note, refund, or
    // a re-issued invoice), not a field to silently reset.
    return alreadyStamped
      ? {
        action: "log_contradiction",
        invoice_status: status,
        reason:
          "deposit invoice is " + status.toLowerCase() +
          " in Xero but the job is already stamped as deposit-paid",
      }
      : null;
  }

  if (status !== "PAID") return null;
  if (alreadyStamped) return null; // idempotent: one stamp, ever

  // Xero says PAID; if the same payload still reports money outstanding, the
  // provider record disagrees with itself. Do not invent a payment.
  const amountDue = Number(inv.AmountDue);
  if (Number.isFinite(amountDue) && amountDue > 0.005) return null;

  const fullyPaid = xeroDateToIsoTimestamp(inv.FullyPaidOnDate);
  if (fullyPaid) return { action: "stamp", deposit_at: fullyPaid, source: "fully_paid_on" };
  const updated = xeroDateToIsoTimestamp(inv.UpdatedDateUTC);
  if (updated) return { action: "stamp", deposit_at: updated, source: "updated_date" };
  return { action: "stamp", deposit_at: now.toISOString(), source: "sync_time" };
}

export interface DepositStampOutcome {
  job_id: string;
  job_number: string | null;
  action: "stamped" | "contradiction_logged";
  deposit_at?: string;
  source?: string;
}

/**
 * Looks the job up by its deposit_invoice_id and applies the decision.
 * Returns null when there is nothing to do. Never writes jobs.status.
 *
 * The jobs update carries `.is('deposit_at', null)` and returns the rows it
 * wrote, so two concurrent syncs cannot double-stamp: the second one writes
 * nothing and logs nothing.
 */
export async function applyDepositStamp(
  // deno-lint-ignore no-explicit-any
  client: any,
  orgId: string,
  // deno-lint-ignore no-explicit-any
  inv: any,
  now: Date = new Date(),
): Promise<DepositStampOutcome | null> {
  if (!depositStampRelevant(inv)) return null;

  const { data: job, error } = await client.from("jobs")
    .select("id, job_number, deposit_at, deposit_invoice_id")
    .eq("org_id", orgId)
    .eq("deposit_invoice_id", inv.InvoiceID)
    .maybeSingle();
  // A failed lookup is not "no such job" — leave it for the next run, but say
  // so out loud: a silent null here is indistinguishable from a genuine miss.
  if (error) {
    console.error(
      "[xero-sync] deposit stamp job lookup failed for invoice " +
        (inv.InvoiceNumber || inv.InvoiceID) + ":",
      error.message,
    );
    return null;
  }
  if (!job) return null;

  const decision = depositStampDecision(inv, job, now);
  if (!decision) return null;

  if (decision.action === "log_contradiction") {
    if (!(await automationLaneEnabled(client, "capture"))) return null;

    // The sync window overlaps by 15 minutes, so a voided deposit invoice is
    // re-read every run. One contradiction per invoice, not one per run.
    const { data: logged, error: loggedErr } = await client.from("business_events")
      .select("id")
      .eq("event_type", "job.deposit_stamp_contradicted")
      .eq("entity_id", inv.InvoiceID)
      .limit(1);
    if (loggedErr) {
      console.error(
        "[xero-sync] deposit contradiction lookup failed for invoice " +
          (inv.InvoiceNumber || inv.InvoiceID) + ":",
        loggedErr.message,
      );
      return null;
    }
    if (Array.isArray(logged) && logged.length > 0) return null;

    await insertCapturedEvidence(client, {
      event_type: "job.deposit_stamp_contradicted",
      source: "xero-sync",
      entity_type: "invoice",
      entity_id: inv.InvoiceID,
      job_id: job.id,
      match_method: "direct_job_id",
      channel: "invoice", direction: "internal",
      occurred_at: now.toISOString(),
      event_at: xeroDateToIsoTimestamp(inv.UpdatedDateUTC),
      body_preview: `Deposit invoice ${inv.InvoiceNumber || inv.InvoiceID} is ${decision.invoice_status}; prior deposit stamp retained.`,
      payload: {
        invoice_number: inv.InvoiceNumber || null,
        invoice_status: decision.invoice_status,
        deposit_at: job.deposit_at,
        reason: decision.reason,
      },
    }).then(() => undefined, () => undefined);
    return {
      job_id: job.id,
      job_number: job.job_number ?? null,
      action: "contradiction_logged",
    };
  }

  const { data: stampedRows, error: updErr } = await client.from("jobs")
    .update({ deposit_at: decision.deposit_at, updated_at: now.toISOString() })
    .eq("id", job.id)
    .is("deposit_at", null)
    .select("id");
  if (updErr) {
    console.error(
      "[xero-sync] deposit_at stamp failed for job " + (job.job_number || job.id) + ":",
      updErr.message,
    );
    return null;
  }
  // Zero rows means another run won the race and stamped first. Claiming a
  // stamp we did not write would put a false event in the business log.
  if (!Array.isArray(stampedRows) || stampedRows.length === 0) return null;

  if (await automationLaneEnabled(client, "capture")) {
    await insertCapturedEvidence(client, {
      event_type: "job.deposit_stamped",
      source: "xero-sync",
      entity_type: "invoice",
      entity_id: inv.InvoiceID,
      job_id: job.id,
      match_method: "direct_job_id",
      channel: "invoice", direction: "internal",
      occurred_at: now.toISOString(),
      event_at: xeroDateToIsoTimestamp(inv.FullyPaidOnDate),
      body_preview: `Xero marks deposit invoice ${inv.InvoiceNumber || inv.InvoiceID} PAID.`,
      payload: {
        invoice_number: inv.InvoiceNumber || null,
        deposit_at: decision.deposit_at,
        timestamp_source: decision.source,
        amount_paid: inv.AmountPaid ?? null,
      },
    }).then(() => undefined, () => undefined);
  }

  return {
    job_id: job.id,
    job_number: job.job_number ?? null,
    action: "stamped",
    deposit_at: decision.deposit_at,
    source: decision.source,
  };
}
