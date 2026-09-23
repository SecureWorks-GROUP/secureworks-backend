// One owner of what a Xero invoice read does to our copy (money slice MN1,
// money.md §6 step 2, review M1).
//
// Four paths read invoices from Xero: the 15-minute incremental loop, the
// open-book sweep, the sweep's closure read, and the single-record verify
// (reconcileXeroInvoice, also the sweep's per-id fallback). Before MN1 only
// the loop ran the side effects, so a deposit invoice closed by any other
// path never stamped jobs.deposit_at and a fully paid job never completed.
// Now every path goes through this module:
//
//   buildInvoiceRecord        the row a LIST read writes (loop, sweep, IDs=).
//   buildVerifiedInvoicePatch the patch a SINGLE-record read writes (verify,
//                             per-id fallback). Update only: a key the read
//                             did not carry never erases the cached value.
//   applyProviderInvoice      list-read row upsert, then the effects.
//   applyProviderInvoiceEffects
//                             (a) whole-token reference auto-link, (b) the
//                             deposit stamp, (c) "every ACCREC invoice PAID ->
//                             the invoiced job completes". Idempotent: the
//                             link only fills a null job_id, the deposit
//                             stamp writes once (deposit_stamp.ts), and the
//                             completion only moves a job still 'invoiced'.
//
// Both builders stamp xero_verified_at: the time this copy was last read from
// Xero. synced_at keeps meaning "last local write"; the ~20 ops-api mirror
// writers set synced_at and never xero_verified_at (money.md follow-up 1).

import { insertCapturedEvidence } from "../_shared/evidence/capture_guard.ts";
import { automationLaneEnabled } from "../_shared/automation_switch.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import {
  type SealedSesJobRecord,
  type SealedSesMoneyRefusal,
  sealedSesMoneyRefusal,
} from "../_shared/sealed_ses_money_fence.ts";
import {
  applyDepositStamp,
  type DepositStampOutcome,
  depositStampRelevant,
  xeroDateToIsoTimestamp,
} from "./deposit_stamp.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type XeroInvoice = any;

export type XeroInvoiceLinkRecord = {
  id?: string | null;
  xero_invoice_id?: string | null;
  invoice_number?: string | null;
  invoice_type?: string | null;
  job_id?: string | null;
  invoice_obligation_revision_id?: string | null;
  ses_external_token?: string | null;
};

// The cached fields applyProviderInvoice needs before it writes. The sweep
// reads them for a whole page at once and passes them in.
export type ExistingInvoiceLink = {
  job_id?: string | null;
  job_contact_id?: string | null;
  invoice_obligation_revision_id?: string | null;
  ses_external_token?: string | null;
};

export const EXISTING_LINK_COLUMNS =
  "job_id, job_contact_id, invoice_obligation_revision_id, ses_external_token";

// Async so every caller keeps its await (moved from index.ts unchanged).
// deno-lint-ignore require-await
export async function sealedSesXeroLinkRefusal(
  _client: Db,
  invoice: XeroInvoiceLinkRecord,
  _targetJob: string | SealedSesJobRecord,
  action: string,
): Promise<SealedSesMoneyRefusal | null> {
  // ACCPAY is explicitly outside the sales-invoice fence. A missing/unknown
  // type is not proof that the row is safe, so it must still be classified
  // against its SES bindings and source/target jobs.
  if (String(invoice.invoice_type || "").toUpperCase() === "ACCPAY") {
    return null;
  }

  if (invoice.invoice_obligation_revision_id || invoice.ses_external_token) {
    return sealedSesMoneyRefusal(action, {
      xero_invoice_id: invoice.xero_invoice_id || null,
      invoice_number: invoice.invoice_number || null,
      ses_release_binding: true,
    });
  }

  return null;
}

// Converts /Date(1234567890000)/ to an ISO string.
export function parseXeroDate(
  xeroDate: string | null | undefined,
): string | null {
  if (!xeroDate) return null;
  const match = xeroDate.match(/\/Date\((\d+)([+-]\d+)?\)\//);
  if (!match) return null;
  return new Date(parseInt(match[1], 10)).toISOString();
}

/** The row a list read (loop, sweep, closure IDs= read) upserts. */
export function buildInvoiceRecord(
  inv: XeroInvoice,
  orgId: string,
  verifiedAt: Date,
): Record<string, unknown> {
  const at = verifiedAt.toISOString();
  return {
    org_id: orgId,
    xero_invoice_id: inv.InvoiceID,
    xero_contact_id: inv.Contact?.ContactID || null,
    contact_name: inv.Contact?.Name || null,
    invoice_number: inv.InvoiceNumber || null,
    invoice_type: inv.Type,
    status: inv.Status,
    reference: inv.Reference || null,
    currency_code: inv.CurrencyCode || "AUD",
    sub_total: inv.SubTotal || 0,
    total_tax: inv.TotalTax || 0,
    total: inv.Total || 0,
    amount_due: inv.AmountDue || 0,
    amount_paid: inv.AmountPaid || 0,
    invoice_date: inv.DateString || null,
    due_date: inv.DueDateString || null,
    fully_paid_on: parseXeroDate(inv.FullyPaidOnDate) || null,
    line_items: inv.LineItems || [],
    raw_json: inv,
    updated_at: parseXeroDate(inv.UpdatedDateUTC) || at,
    synced_at: at,
    xero_verified_at: at,
  };
}

/**
 * The patch a single-record read (verify, per-id fallback) writes. The caller
 * has already checked identity, type, status and balances. Contact and
 * reference are copied when the read carries them (money.md finding 3: the
 * verify used to leave a stale payer and reference behind); an omitted
 * optional field never erases the cached value.
 */
export function buildVerifiedInvoicePatch(
  inv: Record<string, unknown>,
  now: Date,
): Record<string, unknown> {
  const at = now.toISOString();
  const patch: Record<string, unknown> = {
    status: inv.Status,
    amount_due: inv.AmountDue,
    amount_paid: inv.AmountPaid,
    synced_at: at,
    xero_verified_at: at,
    // The attempt stamp orders the daily draft sweep. A verified read clears
    // any recorded failure.
    reconcile_attempted_at: at,
    reconcile_last_error: null,
    // Keep the verified provider snapshot aligned with status and balances.
    raw_json: inv,
  };
  if (
    typeof inv.DueDateString === "string" &&
    Number.isFinite(Date.parse(inv.DueDateString))
  ) {
    patch.due_date = inv.DueDateString;
  }
  if (Array.isArray(inv.LineItems)) patch.line_items = inv.LineItems;
  const contact = inv.Contact as Record<string, unknown> | undefined;
  if (
    contact && typeof contact.ContactID === "string" && contact.ContactID
  ) {
    patch.xero_contact_id = contact.ContactID;
    patch.contact_name = typeof contact.Name === "string" && contact.Name
      ? contact.Name
      : null;
  }
  // A single-record read always carries Reference when the invoice has one;
  // an explicit empty string clears it, an absent key leaves it alone.
  if (typeof inv.Reference === "string") {
    patch.reference = inv.Reference || null;
  }
  const date = String(inv.UpdatedDateUTC ?? "").match(
    /\/Date\((\d+)([+-]\d+)?\)\//,
  );
  // updated_at drives the incremental sync watermark. A retrieval timestamp
  // cannot substitute for a missing provider update timestamp.
  const updated = date ? new Date(Number(date[1])) : null;
  if (updated && Number.isFinite(updated.getTime())) {
    patch.updated_at = updated.toISOString();
  }
  return patch;
}

export interface ProviderInvoiceDeps {
  orgId: string;
  // Moves a fully paid 'invoiced' job to complete (ops-api, so the GHL stage
  // sync fires). Injected so tests make no network call.
  completeInvoicedJob: (jobId: string) => Promise<void>;
  now?: () => Date;
}

export interface ProviderInvoiceEffects {
  linked_job_id: string | null;
  deposit: DepositStampOutcome | null;
  ses_refusals: SealedSesMoneyRefusal[];
  job_completed: string | null;
}

async function referenceAutoLink(
  sb: Db,
  orgId: string,
  inv: XeroInvoice,
  existing: ExistingInvoiceLink | null,
  out: ProviderInvoiceEffects,
): Promise<void> {
  // Matches patterns like SWP-25001, SWF-25002, SW1615. Job numbers grew to
  // six digits in 2026 (SWP-261376); the old \d{3,5} cap matched the first
  // five and never found the job.
  const ref = inv.Reference || "";
  const swMatch = ref.match(/SWMS-\d{4,6}(?!\d)|SW[A-Z]?-?\d{3,6}(?!\d)/i);
  if (!swMatch) return;
  const swNumber = swMatch[0].toUpperCase();
  const { data: job } = await sb.from("jobs")
    .select("id,type,job_number")
    .eq("org_id", orgId)
    .eq("job_number", swNumber)
    .maybeSingle();
  const linkRecord = {
    xero_invoice_id: inv.InvoiceID,
    invoice_number: inv.InvoiceNumber,
    invoice_type: inv.Type,
    job_id: existing?.job_id || null,
    invoice_obligation_revision_id: existing?.invoice_obligation_revision_id ||
      null,
    ses_external_token: existing?.ses_external_token || null,
  };

  let target: string | SealedSesJobRecord | null = job ?? null;
  let targetId: string | null = job?.id ?? null;
  if (!job) {
    // Legacy Tradify SW numbers (e.g. "SW1615 15 Main St") in xero_projects.
    const { data: xp } = await sb.from("xero_projects")
      .select("job_id")
      .eq("org_id", orgId)
      .ilike("project_name", `${swNumber}%`)
      .not("job_id", "is", null)
      .limit(1)
      .maybeSingle();
    if (!xp?.job_id) return;
    target = xp.job_id;
    targetId = xp.job_id;
  }
  const refusal = await sealedSesXeroLinkRefusal(
    sb,
    linkRecord,
    target as string | SealedSesJobRecord,
    "xero-sync/reference auto-link",
  );
  if (refusal) {
    out.ses_refusals.push(refusal);
    console.warn("[xero-sync] sealed SES invoice link refused", refusal);
    return;
  }
  await sb.from("xero_invoices")
    .update({ job_id: targetId })
    .eq("xero_invoice_id", inv.InvoiceID)
    .eq("org_id", orgId)
    .is("job_id", null);
  out.linked_job_id = targetId;
}

async function paidJobCompletion(
  sb: Db,
  deps: ProviderInvoiceDeps,
  inv: XeroInvoice,
  existing: ExistingInvoiceLink | null,
  out: ProviderInvoiceEffects,
): Promise<void> {
  // Only for sales invoices (ACCREC) that are linked to a job.
  if (inv.Type !== "ACCREC" || inv.Status !== "PAID") return;
  const orgId = deps.orgId;
  const { data: invRecord } = await sb.from("xero_invoices")
    .select("job_id")
    .eq("xero_invoice_id", inv.InvoiceID)
    .eq("org_id", orgId)
    .not("job_id", "is", null)
    .maybeSingle();
  if (!invRecord?.job_id) return;
  const paidInvoiceRefusal = await sealedSesXeroLinkRefusal(
    sb,
    {
      xero_invoice_id: inv.InvoiceID,
      invoice_number: inv.InvoiceNumber,
      invoice_type: inv.Type,
      job_id: invRecord.job_id,
      invoice_obligation_revision_id:
        existing?.invoice_obligation_revision_id || null,
      ses_external_token: existing?.ses_external_token || null,
    },
    invRecord.job_id,
    "xero-sync/payment automation",
  );
  if (paidInvoiceRefusal) {
    out.ses_refusals.push(paidInvoiceRefusal);
    console.warn(
      "[xero-sync] sealed SES payment automation refused",
      paidInvoiceRefusal,
    );
    return;
  }
  // Check if ALL invoices for this job are paid.
  const { data: unpaid } = await sb.from("xero_invoices")
    .select("id")
    .eq("job_id", invRecord.job_id)
    .eq("invoice_type", "ACCREC")
    .not("status", "eq", "PAID")
    .not("status", "in", '("VOIDED","DELETED")')
    .limit(1);
  if (unpaid && unpaid.length > 0) return;
  // All invoices paid. Only a job still in 'invoiced' moves.
  const { data: jobData } = await sb.from("jobs")
    .select("id, status")
    .eq("id", invRecord.job_id)
    .eq("status", "invoiced")
    .maybeSingle();
  if (!jobData) return;

  await deps.completeInvoicedJob(jobData.id);
  out.job_completed = jobData.id;

  await sb.from("job_events").insert({
    job_id: jobData.id,
    event_type: "payment_received",
    detail_json: {
      source: "xero_sync",
      xero_invoice_id: inv.InvoiceID,
      invoice_number: inv.InvoiceNumber,
      amount_paid: inv.AmountPaid,
      fully_paid_on: inv.FullyPaidOnDate,
    },
  });
  if (await automationLaneEnabled(sb, "capture")) {
    const { error: captureError } = await insertCapturedEvidence(sb, {
      event_type: "invoice.payment_received",
      source: "xero-sync",
      entity_type: "invoice",
      entity_id: inv.InvoiceID,
      job_id: jobData.id,
      match_method: "direct_job_id",
      channel: "invoice",
      direction: "internal",
      occurred_at: new Date().toISOString(),
      event_at: xeroDateToIsoTimestamp(inv.FullyPaidOnDate),
      provider_message_id: `xero:invoice:${inv.InvoiceID}:paid`,
      body_preview: `Xero marks invoice ${
        inv.InvoiceNumber || inv.InvoiceID
      } PAID.`,
      payload: {
        invoice_number: inv.InvoiceNumber,
        amount_paid: inv.AmountPaid,
        fully_paid_on: inv.FullyPaidOnDate || null,
      },
    });
    if (captureError && captureError.code !== "23505") {
      console.error(
        "[xero-sync] payment evidence failed:",
        captureError.message,
      );
    }
  }
  console.log(
    `[xero-sync] Job ${jobData.id} fully paid — payment event logged`,
  );
}

/**
 * The side effects of a provider invoice that is already on our copy. Run by
 * every path after its row write. A cooldown propagates; the deposit stamp is
 * non-blocking as it always was.
 */
export async function applyProviderInvoiceEffects(
  sb: Db,
  inv: XeroInvoice,
  existing: ExistingInvoiceLink | null,
  deps: ProviderInvoiceDeps,
): Promise<ProviderInvoiceEffects> {
  const out: ProviderInvoiceEffects = {
    linked_job_id: null,
    deposit: null,
    ses_refusals: [],
    job_completed: null,
  };
  await referenceAutoLink(sb, deps.orgId, inv, existing, out);

  // Deposit stamp: a PAID deposit invoice lands on jobs.deposit_at. It never
  // moves the job; it only records that the deposit money arrived.
  if (depositStampRelevant(inv)) {
    try {
      out.deposit = await applyDepositStamp(
        sb,
        deps.orgId,
        inv,
        deps.now?.() ?? new Date(),
      );
      if (out.deposit?.action === "stamped") {
        console.log(
          `[xero-sync] Job ${out.deposit.job_number} deposit_at stamped ${out.deposit.deposit_at} (${out.deposit.source})`,
        );
      }
    } catch (e) {
      if (e instanceof XeroCooldownError) throw e;
      console.error("[xero-sync] Deposit stamp failed:", (e as Error).message);
    }
  }

  await paidJobCompletion(sb, deps, inv, existing, out);
  return out;
}

export interface AppliedProviderInvoice extends ProviderInvoiceEffects {
  written: boolean;
  error: string | null;
  existing: ExistingInvoiceLink | null;
}

/**
 * A list read's invoice: upsert the row (job links preserved), then the
 * effects. `existing` may be passed when the caller already read it; when it
 * is undefined the row is looked up here.
 */
export async function applyProviderInvoice(
  sb: Db,
  inv: XeroInvoice,
  verifiedAt: Date,
  deps: ProviderInvoiceDeps,
  existing?: ExistingInvoiceLink | null,
): Promise<AppliedProviderInvoice> {
  let current = existing;
  if (current === undefined) {
    const { data } = await sb.from("xero_invoices")
      .select(EXISTING_LINK_COLUMNS)
      .eq("org_id", deps.orgId)
      .eq("xero_invoice_id", inv.InvoiceID)
      .maybeSingle();
    current = data ?? null;
  }
  const record = buildInvoiceRecord(inv, deps.orgId, verifiedAt);
  // Preserve job linkage: sync never wipes links set by invoice creation.
  if (current?.job_id) record.job_id = current.job_id;
  if (current?.job_contact_id) record.job_contact_id = current.job_contact_id;

  const { error } = await sb.from("xero_invoices").upsert(record, {
    onConflict: "org_id,xero_invoice_id",
  });
  if (error) {
    return {
      written: false,
      error: error.message || "upsert_failed",
      existing: current ?? null,
      linked_job_id: null,
      deposit: null,
      ses_refusals: [],
      job_completed: null,
    };
  }
  const effects = await applyProviderInvoiceEffects(
    sb,
    inv,
    current ?? null,
    deps,
  );
  return { written: true, error: null, existing: current ?? null, ...effects };
}
