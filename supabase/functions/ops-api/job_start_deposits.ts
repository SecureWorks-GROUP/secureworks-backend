// deno-lint-ignore-file no-explicit-any
// WS6 notes 69/70: starting shared work requires every payer's deposit.
// Read only. Reuses the deposit-advance rule; never creates or sends an invoice.
import {
  evaluateDepositPaid,
  isDepositAdvanceJobType,
  liveDepositInvoices,
} from "../_shared/job_deposit_paid.ts";
import { isInsuranceRepairFamily } from "./insurance_repairs_board.ts";
import { payingParties } from "../_shared/job_paid_closeout.ts";

export class JobStartDepositError extends Error {
  readonly status = 409;
  constructor(readonly code: string, readonly reasons: string[]) {
    super(
      code === "job_deposits_unreadable"
        ? "Work cannot start until every party's deposit can be checked. Ask the office to check the deposits."
        : "Work cannot start until every paying party's deposit is paid. Ask the office to check the deposits.",
    );
  }
}

/** Scope visits, meetings, delivery and ghost watchers are not installation work. */
export function isInstallationAssignment(row: any): boolean {
  if (row?.is_ghost === true) return false;
  const role = String(row?.role ?? "").trim().toLowerCase();
  const kind = String(row?.assignment_type ?? "install").trim().toLowerCase() ||
    "install";
  return !["observer", "ghost"].includes(role) && kind === "install";
}

async function readRows(
  client: any,
  table: string,
  columns: string,
  jobId: string,
) {
  const rows: any[] = [];
  for (let start = 0;; start += 500) {
    let query = client.from(table).select(columns).eq("job_id", jobId);
    if (table === "xero_invoices") query = query.eq("invoice_type", "ACCREC");
    const { data, error } = await query.order("id").range(start, start + 499);
    if (error || !Array.isArray(data)) {
      throw new Error("deposit facts unreadable");
    }
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}

/** Refuses before any start write. Unknown reads never count as paid. */
export async function assertJobDepositsBeforeWork(client: any, jobId: string) {
  try {
    const { data: job, error } = await client.from("jobs")
      .select("id, type, metadata, deposit_invoice_id").eq("id", jobId)
      .maybeSingle();
    if (error || !job || !String(job.type ?? "").trim()) {
      throw new Error("job unreadable");
    }
    if (!isDepositAdvanceJobType(job.type)) return;
    // A legacy repair can still carry type patio/fencing. The repair-family
    // reader, shared with the board and auto-start, owns that classification.
    if (isInsuranceRepairFamily(job)) return;
    const detail = await client.from("makesafe_job_details").select(
      "report_type",
    )
      .eq("job_id", jobId).maybeSingle();
    if (detail.error) throw new Error("job family unreadable");
    if (isInsuranceRepairFamily({ ...job, makesafe_details: detail.data })) {
      return;
    }
    const [invoices, parties] = await Promise.all([
      readRows(
        client,
        "xero_invoices",
        "id, xero_invoice_id, invoice_number, invoice_type, status, reference, amount_due, amount_paid, fully_paid_on, job_contact_id, xero_contact_id",
        jobId,
      ),
      readRows(
        client,
        "job_contacts",
        "id, contact_label, is_primary, share_percentage, removed_at, status, xero_contact_id",
        jobId,
      ),
    ]);
    // A partial shared-boundary roster must not turn its lone neighbour into
    // the owner through the legacy invoice matching fallback. An explicitly
    // removed/zero-share owner is different: that decision remains recorded.
    const primaryRows = parties.filter((party: any) =>
      party.is_primary === true
    );
    if (
      primaryRows.length > 1 ||
      (primaryRows.length === 0 && payingParties(parties).length > 0)
    ) throw new Error("payer roster incomplete");
    // The older advance evaluator treats a missing amount as zero. At the work
    // start boundary an unread amount is unknown, even if the status says PAID.
    if (
      liveDepositInvoices(invoices, job.deposit_invoice_id).some((inv: any) =>
        inv.amount_due === null || inv.amount_due === undefined ||
        String(inv.amount_due).trim() === "" ||
        !Number.isFinite(Number(inv.amount_due))
      )
    ) throw new Error("deposit amount unreadable");
    const verdict = evaluateDepositPaid({ job, invoices, parties });
    if (!verdict.paid) {
      throw new JobStartDepositError("job_deposits_unpaid", verdict.reasons);
    }
  } catch (error) {
    if (error instanceof JobStartDepositError) throw error;
    throw new JobStartDepositError("job_deposits_unreadable", [
      "deposit_read_failed",
    ]);
  }
}
