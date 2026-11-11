// deno-lint-ignore-file no-explicit-any
// WS6 notes 69/70 and RQ-19.e: no crew starts and no materials are ordered on
// a fencing or patio job until every paying party has accepted and paid its
// deposit. The one way past it is an override the owner or the office
// recorded with a reason (job_deposit_gate_overrides, 20261111110000).
// Read only. Reuses the deposit-advance rule; never creates or sends an invoice.
import {
  evaluateDepositPaid,
  isDepositAdvanceJobType,
  liveDepositInvoices,
} from "../_shared/job_deposit_paid.ts";
import { isInsuranceRepairFamily } from "./insurance_repairs_board.ts";
import { payingParties } from "../_shared/job_paid_closeout.ts";

/** What the gate is holding: crew starting work, or a supplier order. */
export type DepositGatePurpose = "start" | "materials";

export class JobStartDepositError extends Error {
  readonly status = 409;
  constructor(
    readonly code: string,
    readonly reasons: string[],
    readonly purpose: DepositGatePurpose = "start",
  ) {
    const what = purpose === "materials"
      ? "Materials cannot be ordered"
      : "Work cannot start";
    super(
      code === "job_deposits_unreadable"
        ? `${what} until every party's deposit can be checked. Ask the office to check the deposits.`
        : code === "job_not_accepted"
        ? `${what} until every party has accepted the quote. Ask the office to check the acceptances.`
        : `${what} until every paying party's deposit is paid. Ask the office to check the deposits.`,
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

/** The live override on the job, or null. A failed read throws. */
export async function readLiveDepositGateOverride(client: any, jobId: string) {
  const { data, error } = await client.from("job_deposit_gate_overrides")
    .select(
      "id, job_id, reason, unpaid_reasons, granted_by, granted_by_email, granted_by_role, granted_at",
    )
    .eq("job_id", jobId).is("revoked_at", null).maybeSingle();
  if (error) throw new Error("deposit gate override unreadable");
  return data ?? null;
}

type GateVerdict =
  | { open: true; reason: "not_gated" | "paid" }
  | { open: false; code: string; reasons: string[] };

/** Judges the job without the override. Unknown reads never count as paid. */
async function judgeDepositGate(client: any, jobId: string): Promise<GateVerdict> {
  try {
    const { data: job, error } = await client.from("jobs")
      .select("id, type, status, metadata, deposit_invoice_id").eq("id", jobId)
      .maybeSingle();
    if (error || !job || !String(job.type ?? "").trim()) {
      throw new Error("job unreadable");
    }
    if (!isDepositAdvanceJobType(job.type)) return { open: true, reason: "not_gated" };
    // A legacy repair can still carry type patio/fencing. The repair-family
    // reader, shared with the board and auto-start, owns that classification.
    if (isInsuranceRepairFamily(job)) return { open: true, reason: "not_gated" };
    const detail = await client.from("makesafe_job_details").select(
      "report_type",
    )
      .eq("job_id", jobId).maybeSingle();
    if (detail.error) throw new Error("job family unreadable");
    if (isInsuranceRepairFamily({ ...job, makesafe_details: detail.data })) {
      return { open: true, reason: "not_gated" };
    }
    // Every party must have accepted: the one acceptance rule (RQ-19.a).
    const accepted = await client.rpc("job_not_yet_accepted", {
      p_type: job.type,
      p_status: job.status ?? null,
    });
    if (accepted.error || typeof accepted.data !== "boolean") {
      throw new Error("acceptance unreadable");
    }
    if (accepted.data === true) {
      return {
        open: false,
        code: "job_not_accepted",
        reasons: [`job_not_accepted:${String(job.status ?? "")}`],
      };
    }
    const [invoices, parties, payerDrafts, draftSet] = await Promise.all([
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
      readRows(
        client,
        "scope_job_draft_invoices",
        "id, payer_id, scope_revision_id, inc_cents",
        jobId,
      ),
      client.from("scope_job_draft_sets").select("scope_revision_id")
        .eq("job_id", jobId).maybeSingle().then((r: any) => {
          if (r.error) throw new Error("payer drafts unreadable");
          return r.data ?? null;
        }),
    ]);
    // The sealed quote's payer drafts name who pays. A payer with no party row
    // here has no deposit the gate can see, so the job cannot be judged paid
    // on the parties it does have (a shared fence with no neighbour row would
    // otherwise pass on the owner's deposit alone). A known 0 share pays nothing.
    // Only the current draft set's revision counts: a payer row kept from an
    // older quote revision (a neighbour since dropped) is not owed a party.
    // No draft set: no sealed payers, the one-owner roster decides as before.
    const currentRevision = draftSet?.scope_revision_id ?? null;
    const quotedPayers = payerDrafts.filter((d: any) =>
      currentRevision !== null && d.scope_revision_id === currentRevision &&
      (d.inc_cents === null || d.inc_cents === undefined ||
        Number(d.inc_cents) !== 0)
    ).length;
    const knownPayers = Math.max(1, payingParties(parties).length);
    if (quotedPayers > knownPayers) {
      return {
        open: false,
        code: "job_deposits_unpaid",
        reasons: [`payer_without_party:${quotedPayers - knownPayers}`],
      };
    }
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
      return { open: false, code: "job_deposits_unpaid", reasons: verdict.reasons };
    }
    return { open: true, reason: "paid" };
  } catch {
    return {
      open: false,
      code: "job_deposits_unreadable",
      reasons: ["deposit_read_failed"],
    };
  }
}

/** The gate as staff see it: open or held, why, and any live override. */
export async function readDepositGate(client: any, jobId: string) {
  const verdict = await judgeDepositGate(client, jobId);
  let override: any = null;
  let overrideReadable = true;
  try {
    override = await readLiveDepositGateOverride(client, jobId);
  } catch {
    overrideReadable = false;
  }
  return {
    job_id: jobId,
    gate: verdict.open ? "open" : override ? "overridden" : overrideReadable ? "held" : "unreadable",
    reason: verdict.open ? verdict.reason : verdict.code,
    reasons: verdict.open ? [] : verdict.reasons,
    override,
    override_readable: overrideReadable,
  };
}

/**
 * Refuses before any start write or supplier order. A live override recorded
 * by the owner or the office lets it through; an unreadable override never does.
 */
export async function assertJobDepositsBeforeWork(
  client: any,
  jobId: string,
  purpose: DepositGatePurpose = "start",
) {
  const verdict = await judgeDepositGate(client, jobId);
  if (verdict.open) return;
  let override: any = null;
  try {
    override = await readLiveDepositGateOverride(client, jobId);
  } catch {
    throw new JobStartDepositError(
      "job_deposits_unreadable",
      ["deposit_gate_override_unreadable", ...verdict.reasons],
      purpose,
    );
  }
  if (override) return;
  throw new JobStartDepositError(verdict.code, verdict.reasons, purpose);
}
