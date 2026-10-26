// Deposit advance for fencing and patio jobs (captain, 26 Oct 2026): the pipeline moves a
// job along by its deposit, so nobody tracks each job by hand.
//
// The rule for "sent" and "paid" is _shared/job_deposit_paid.ts. This module owns every
// read and write around it, and every step goes through it:
//   - depositInvoiceSent    a deposit invoice of the job was just emailed successfully
//                           (send_acceptance_invoice on an online accept, or an office send):
//                           a job still in accepted moves to awaiting_deposit (compare and
//                           set on accepted). A failed send never calls it, so that job
//                           stays in Accepted, and so does a job with no deposit invoice.
//   - depositOnInvoiceChange xero-sync calls job_deposit_paid when a client sales invoice of
//                           a fencing or patio job changes: a job in accepted or
//                           awaiting_deposit where every paying party has a deposit and
//                           every live deposit invoice is paid in full moves to order_materials (patio: approvals while council is
//                           needed or not decided), compare and set on those two statuses,
//                           source xero_deposit_paid; a job already moved on is checked for a
//                           voided or no-longer-paid deposit, which is flagged for a person.
//   - depositCatchUp        xero-sync calls job_deposit_catch_up after each run: the same
//                           paid move for accepted and awaiting_deposit cards whose deposit
//                           was paid before the switch was on or before the card got there,
//                           and the same flag check for every job this module moved.
//   - clearDepositFlag      a person has dealt with a flag (clear_job_deposit_flag).
//
// The client text (captain answer 6): live mode only, only on an automatic move to Order
// Materials, once per job (job_deposit_advance_state.text_status is claimed before the
// send), never for a hand move, through ghl-proxy send_sms (the shared sender policy and
// contact guard). A patio move to Approvals sends nothing: council comes before materials,
// so "we're now ordering your materials" would not be true yet.
//
// GHL (captain answer 7): these moves pass skip_ghl_push, so the GHL opportunity is left
// alone.
//
// Switch (migration 20261026160000_job_deposit_advance.sql):
// job_closeout_settings.deposit_advance_mode, off | dry_run | live, shipped off. off: nothing
// is read or written. dry_run: each move that would happen is one job_events row
// deposit_advance_dry_run (once per job, from status and target) and nothing moves or is
// texted. live: jobs move. The database switch alone decides.

import {
  DEPOSIT_FLAG_STATUSES,
  DEPOSIT_LAND_FROM_STATUSES,
  DEPOSIT_LAND_STATUS,
  DEPOSIT_ORDER_MATERIALS_STATUS,
  DEPOSIT_PAID_FROM_STATUSES,
  type DepositFlag,
  depositFlagFor,
  depositFlagKey,
  type DepositInvoice,
  depositInvoicesSent,
  type DepositJob,
  depositPaidTargetStatus,
  type DepositPaidVerdict,
  depositReceivedText,
  evaluateDepositPaid,
  isDepositAdvanceJobType,
  isDepositInvoice,
} from "../_shared/job_deposit_paid.ts";
import type { CloseoutParty } from "../_shared/job_paid_closeout.ts";
import type { SmsSendResult } from "./job_closeout.ts";

/** Jobs per page when the catch-up reads every candidate card. */
const JOB_PAGE_SIZE = 500;
const JOB_PAGES_MAX = 10;
/** Ids per PostgREST .in() filter. */
const ID_CHUNK = 50;

export const DEPOSIT_PAID_SOURCE = "xero_deposit_paid";
export const DEPOSIT_SENT_SOURCE = "deposit_invoice_sent";
/** The email_events comms trigger the client text is logged under; send_client_update
 *  deposit_paid dedupes on it, so a hand send after the automatic one is refused. */
export const DEPOSIT_TEXT_COMMS_TRIGGER = "deposit_paid";

export type DepositAdvanceMode = "off" | "dry_run" | "live";

export interface JobDepositDeps {
  // deno-lint-ignore no-explicit-any
  client: any;
  now: () => Date;
  /** ops-api updateJobStatus (with expected_statuses for compare and set). */
  // deno-lint-ignore no-explicit-any
  moveJobStatus: (body: Record<string, unknown>) => Promise<any>;
  /** One SMS through ghl-proxy send_sms (the shared sender policy and contact guard). */
  sendSms: (
    args: { contactId: string; message: string; jobId: string },
  ) => Promise<SmsSendResult>;
}

export class JobDepositError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "bad_request",
  ) {
    super(message);
  }
}

const text = (v: unknown): string => String(v ?? "").trim();

// ── Switch ───────────────────────────────────────────────────────────────────

/** Fails closed: an unreadable row, or anything but dry_run or live, is off. */
export async function readDepositAdvanceMode(
  // deno-lint-ignore no-explicit-any
  client: any,
): Promise<DepositAdvanceMode> {
  try {
    const { data, error } = await client.from("job_closeout_settings")
      .select("deposit_advance_mode")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) return "off";
    const mode = text(data.deposit_advance_mode);
    return mode === "live" ? "live" : mode === "dry_run" ? "dry_run" : "off";
  } catch {
    return "off";
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface DepositJobRow extends DepositJob {
  client_name: string | null;
  ghl_contact_id: string | null;
  deposit_at: string | null;
}

export interface DepositStateRow {
  job_id: string;
  moved_at: string | null;
  moved_to: string | null;
  counted_invoice_ids: string[] | null;
  text_status: string | null;
  flag: string | null;
  flag_invoice_id: string | null;
  flag_cleared_at: string | null;
  cleared_flags: string[] | null;
}

const JOB_COLUMNS =
  "id, job_number, type, status, deposit_invoice_id, council_required, client_name, ghl_contact_id, deposit_at";
const INVOICE_COLUMNS =
  "job_id, xero_invoice_id, invoice_number, invoice_type, status, reference, total, amount_due, amount_paid, fully_paid_on, job_contact_id, xero_contact_id";
const PARTY_COLUMNS =
  "id, job_id, contact_label, is_primary, share_percentage, removed_at, status, xero_contact_id";
const STATE_COLUMNS =
  "job_id, moved_at, moved_to, counted_invoice_ids, text_status, flag, flag_invoice_id, flag_cleared_at, cleared_flags";

function chunks<T>(items: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function readByJob<T extends { job_id: string }>(
  // deno-lint-ignore no-explicit-any
  client: any,
  table: string,
  columns: string,
  jobIds: string[],
  // deno-lint-ignore no-explicit-any
  extra?: (q: any) => any,
): Promise<Map<string, T[]> | null> {
  const out = new Map<string, T[]>();
  for (const id of jobIds) out.set(id, []);
  for (const part of chunks(jobIds)) {
    let q = client.from(table).select(columns).in("job_id", part);
    if (extra) q = extra(q);
    const { data, error } = await q.limit(5000);
    if (error) return null;
    for (const row of data ?? []) out.get(row.job_id)?.push(row);
  }
  return out;
}

async function loadJob(
  // deno-lint-ignore no-explicit-any
  client: any,
  jobId: string,
): Promise<DepositJobRow | null> {
  const { data, error } = await client.from("jobs").select(JOB_COLUMNS).eq(
    "id",
    jobId,
  ).maybeSingle();
  if (error) {
    throw new JobDepositError(
      `job read failed: ${error.message}`,
      503,
      "job_unreadable",
    );
  }
  return data ?? null;
}

export interface DepositFacts {
  invoices: DepositInvoice[];
  parties: CloseoutParty[];
}

/** Each job's client sales invoices and its party rows; null when either read fails. */
async function loadFacts(
  // deno-lint-ignore no-explicit-any
  client: any,
  jobIds: string[],
): Promise<Map<string, DepositFacts> | null> {
  const [invoices, parties] = await Promise.all([
    readByJob<DepositInvoice & { job_id: string }>(
      client,
      "xero_invoices",
      INVOICE_COLUMNS,
      jobIds,
      (q) => q.eq("invoice_type", "ACCREC"),
    ),
    readByJob<CloseoutParty & { job_id: string }>(
      client,
      "job_contacts",
      PARTY_COLUMNS,
      jobIds,
    ),
  ]);
  if (!invoices || !parties) return null;
  const out = new Map<string, DepositFacts>();
  for (const id of jobIds) {
    out.set(id, {
      invoices: invoices.get(id) ?? [],
      parties: parties.get(id) ?? [],
    });
  }
  return out;
}

async function loadState(
  // deno-lint-ignore no-explicit-any
  client: any,
  jobId: string,
): Promise<{ ok: boolean; row: DepositStateRow | null }> {
  const { data, error } = await client.from("job_deposit_advance_state")
    .select(STATE_COLUMNS).eq("job_id", jobId).maybeSingle();
  if (error) return { ok: false, row: null };
  return { ok: true, row: data ?? null };
}

/** Every fencing and patio card in these statuses, paged by id; null when a page fails. */
async function loadJobsByStatus(
  // deno-lint-ignore no-explicit-any
  client: any,
  statuses: readonly string[],
): Promise<DepositJobRow[] | null> {
  const all: DepositJobRow[] = [];
  for (let page = 0; page < JOB_PAGES_MAX; page++) {
    const { data, error } = await client.from("jobs").select(JOB_COLUMNS)
      .in("type", ["fencing", "patio"])
      .in("status", [...statuses])
      .order("id", { ascending: true })
      .range(page * JOB_PAGE_SIZE, page * JOB_PAGE_SIZE + JOB_PAGE_SIZE - 1);
    if (error) return null;
    all.push(...(data ?? []));
    if ((data ?? []).length < JOB_PAGE_SIZE) break;
  }
  return all;
}

// ── Records ──────────────────────────────────────────────────────────────────

/** One dry-run row per job, from status and target: the sync re-reads a paid invoice every
 *  run and the catch-up re-reads every waiting card, so a repeat writes nothing. */
async function recordDryRun(
  deps: JobDepositDeps,
  job: DepositJobRow,
  detail: Record<string, unknown> & { would_move_to: string },
): Promise<"dry_run" | "dry_run_already_recorded"> {
  const { data: prior, error } = await deps.client.from("job_events")
    .select("id")
    .eq("job_id", job.id)
    .eq("event_type", "deposit_advance_dry_run")
    .eq("detail_json->>from_status", text(job.status))
    .eq("detail_json->>would_move_to", detail.would_move_to)
    .limit(1);
  if (!error && Array.isArray(prior) && prior.length > 0) {
    return "dry_run_already_recorded";
  }
  await deps.client.from("job_events").insert({
    job_id: job.id,
    event_type: "deposit_advance_dry_run",
    detail_json: {
      from_status: text(job.status),
      ...detail,
      note: "Watch only: the job was not moved and nobody was texted.",
    },
  });
  return "dry_run";
}

function depositSummary(verdict: Pick<DepositPaidVerdict, "deposits">) {
  return verdict.deposits.map((d) => ({
    invoice_number: d.invoice_number,
    status: d.status,
    amount_due: d.amount_due,
  }));
}

// ── Invoice sent -> Awaiting Deposit ─────────────────────────────────────────

export type DepositResult = {
  job_id: string;
  job_number: string | null;
  action:
    | "switch_off"
    | "moved"
    | "move_skipped"
    | "dry_run"
    | "dry_run_already_recorded"
    | "not_deposit_type"
    | "not_deposit_invoice"
    | "not_in_from_status"
    | "not_sent"
    | "not_paid"
    | "no_target"
    | "flagged"
    | "already_flagged"
    | "no_flag"
    | "facts_unreadable";
  detail?: unknown;
  text?: string;
};

/**
 * A deposit invoice of this job was just emailed to the client successfully. Never throws
 * into the caller's send: the callers log the result and carry on.
 */
export async function depositInvoiceSent(
  deps: JobDepositDeps,
  input: { job_id: string; xero_invoice_id?: string | null; source: string },
): Promise<DepositResult> {
  const base = { job_id: input.job_id, job_number: null as string | null };
  const mode = await readDepositAdvanceMode(deps.client);
  if (mode === "off") return { ...base, action: "switch_off" };
  const job = await loadJob(deps.client, input.job_id);
  if (!job) {
    return { ...base, action: "facts_unreadable", detail: "job_not_found" };
  }
  base.job_number = job.job_number;
  if (!isDepositAdvanceJobType(job.type)) {
    return { ...base, action: "not_deposit_type" };
  }
  if (
    !(DEPOSIT_LAND_FROM_STATUSES as readonly string[]).includes(
      text(job.status),
    )
  ) {
    return { ...base, action: "not_in_from_status", detail: job.status };
  }
  const facts = await loadFacts(deps.client, [job.id]);
  if (!facts) return { ...base, action: "facts_unreadable" };
  const rows = facts.get(job.id)?.invoices ?? [];
  if (input.xero_invoice_id) {
    const sentInvoice = rows.find((r) =>
      text(r.xero_invoice_id) === text(input.xero_invoice_id)
    );
    const status = text(sentInvoice?.status).toUpperCase();
    if (
      !sentInvoice || !isDepositInvoice(sentInvoice, job.deposit_invoice_id) ||
      (status !== "AUTHORISED" && status !== "PAID")
    ) {
      return { ...base, action: "not_deposit_invoice" };
    }
  }
  const sent = depositInvoicesSent({ job, invoices: rows });
  if (!sent.sent) return { ...base, action: "not_sent", detail: sent.reasons };
  if (mode === "dry_run") {
    return {
      ...base,
      action: await recordDryRun(deps, job, {
        rule: "deposit_invoice_sent",
        would_move_to: DEPOSIT_LAND_STATUS,
        source: input.source,
      }),
    };
  }
  const moved = await deps.moveJobStatus({
    jobId: job.id,
    status: DEPOSIT_LAND_STATUS,
    source: input.source || DEPOSIT_SENT_SOURCE,
    expected_statuses: [...DEPOSIT_LAND_FROM_STATUSES],
    skip_ghl_push: true,
  });
  return moved?.success === true ? { ...base, action: "moved" } : {
    ...base,
    action: "move_skipped",
    detail: moved?.skipped ?? moved?.error ?? null,
  };
}

// ── Deposit paid -> Order Materials / Approvals ──────────────────────────────

async function settlePaid(
  deps: JobDepositDeps,
  job: DepositJobRow,
  facts: DepositFacts,
  mode: DepositAdvanceMode,
  source: string,
): Promise<DepositResult> {
  const base = { job_id: job.id, job_number: job.job_number };
  if (
    !(DEPOSIT_PAID_FROM_STATUSES as readonly string[]).includes(
      text(job.status),
    )
  ) {
    return { ...base, action: "not_in_from_status", detail: job.status };
  }
  const verdict = evaluateDepositPaid({ job, ...facts });
  if (!verdict.paid) {
    return { ...base, action: "not_paid", detail: verdict.reasons };
  }
  const target = depositPaidTargetStatus(job);
  if (!target) return { ...base, action: "no_target" };
  if (mode === "dry_run") {
    return {
      ...base,
      action: await recordDryRun(deps, job, {
        rule: "deposit_paid",
        would_move_to: target,
        would_text_client: target === DEPOSIT_ORDER_MATERIALS_STATUS,
        council_required: job.council_required ?? null,
        last_paid_on: verdict.last_paid_on,
        deposits: depositSummary(verdict),
        source,
      }),
    };
  }
  const moved = await deps.moveJobStatus({
    jobId: job.id,
    status: target,
    source: DEPOSIT_PAID_SOURCE,
    expected_statuses: [...DEPOSIT_PAID_FROM_STATUSES],
    skip_ghl_push: true,
  });
  if (moved?.success !== true) {
    return {
      ...base,
      action: "move_skipped",
      detail: moved?.skipped ?? moved?.error ?? null,
    };
  }
  const nowIso = deps.now().toISOString();
  const { error: stateErr } = await deps.client.from(
    "job_deposit_advance_state",
  )
    .upsert({
      job_id: job.id,
      moved_at: nowIso,
      moved_from: text(job.status),
      moved_to: target,
      moved_source: source,
      counted_invoice_ids: verdict.deposits.map((d) => text(d.xero_invoice_id))
        .filter(Boolean),
      last_paid_on: verdict.last_paid_on,
      updated_at: nowIso,
    }, { onConflict: "job_id" });
  if (stateErr) {
    console.error("[job_deposit] move record failed:", stateErr.message);
  }
  let textResult = "not_order_materials";
  if (target === DEPOSIT_ORDER_MATERIALS_STATUS) {
    textResult = await sendDepositText(deps, job, !stateErr);
  }
  return { ...base, action: "moved", detail: { to: target }, text: textResult };
}

/** The once-per-job client text after an automatic move to Order Materials. */
async function sendDepositText(
  deps: JobDepositDeps,
  job: DepositJobRow,
  stateWritten: boolean,
): Promise<string> {
  const { client } = deps;
  // Without its state row there is no claim to take, so nothing is sent.
  if (!stateWritten) return "no_claim_row";
  const finish = async (
    status: string,
    extra: Record<string, unknown> = {},
  ) => {
    await client.from("job_deposit_advance_state").update({
      text_status: status,
      text_at: deps.now().toISOString(),
      ...extra,
    }).eq("job_id", job.id);
    await client.from("job_events").insert({
      job_id: job.id,
      event_type: "deposit_received_text",
      detail_json: { result: status, ...extra },
    });
    return status;
  };
  // Claim first, so two runs cannot both text: only the run whose update changes a row
  // that had no text status goes on.
  const { data: claimed, error: claimErr } = await client.from(
    "job_deposit_advance_state",
  )
    .update({ text_status: "claimed", text_at: deps.now().toISOString() })
    .eq("job_id", job.id)
    .is("text_status", null)
    .select("job_id");
  if (claimErr) return "claim_failed";
  if (!Array.isArray(claimed) || claimed.length === 0) return "already_claimed";
  if (!text(job.ghl_contact_id)) return await finish("no_contact");
  const { count, error: priorErr } = await client.from("email_events")
    .select("id", { count: "exact", head: true })
    .eq("job_id", job.id)
    .eq("comms_trigger", DEPOSIT_TEXT_COMMS_TRIGGER)
    .eq("status", "sent");
  // Nothing was sent: the earlier sends could not be read, so it is not risked.
  if (priorErr) return await finish("prior_send_unreadable");
  if ((count || 0) > 0) return await finish("already_sent");
  const message = depositReceivedText(job.client_name);
  let result: SmsSendResult;
  try {
    result = await deps.sendSms({
      contactId: text(job.ghl_contact_id),
      message,
      jobId: job.id,
    });
  } catch (e) {
    result = {
      ok: false,
      refused: false,
      error: String((e as Error)?.message ?? e),
    };
  }
  if (result.ok) {
    await client.from("email_events").insert({
      email_type: "notification",
      entity_type: "job",
      entity_id: job.id,
      job_id: job.id,
      recipient: text(job.ghl_contact_id),
      sender: "system",
      subject: `Client update: ${DEPOSIT_TEXT_COMMS_TRIGGER}`,
      status: "sent",
      comms_trigger: DEPOSIT_TEXT_COMMS_TRIGGER,
      comms_channel: "sms",
      sent_at: deps.now().toISOString(),
    });
    return await finish("sent", { text_message_id: result.message_id });
  }
  // A 4xx refusal sent nothing; anything else may have reached GHL. Neither is retried.
  return await finish(result.refused ? "refused" : "unconfirmed", {
    text_error: result.error.slice(0, 500),
  });
}

// ── Voided or refunded after the move: flag it ───────────────────────────────

async function checkFlag(
  deps: JobDepositDeps,
  job: DepositJobRow,
  facts: DepositFacts,
  source: string,
): Promise<DepositResult> {
  const base = { job_id: job.id, job_number: job.job_number };
  const state = await loadState(deps.client, job.id);
  if (!state.ok) {
    return { ...base, action: "facts_unreadable", detail: "state_unreadable" };
  }
  if (state.row?.flag && !state.row.flag_cleared_at) {
    return { ...base, action: "already_flagged", detail: state.row.flag };
  }
  // Only a job whose deposit was once counted as paid can lose it: one this module moved,
  // or one the Xero deposit stamp marked paid (jobs.deposit_at).
  const moved = !!state.row?.moved_at;
  if (!moved && !text(job.deposit_at)) return { ...base, action: "no_flag" };
  // Every flag a person cleared: the earlier ones, and the one on the row now.
  const cleared = [...(state.row?.cleared_flags ?? [])];
  if (state.row?.flag && state.row.flag_cleared_at) {
    cleared.push(depositFlagKey(state.row.flag, state.row.flag_invoice_id));
  }
  const flag: DepositFlag | null = depositFlagFor({
    job,
    ...facts,
    countedIds: moved ? (state.row?.counted_invoice_ids ?? []) : [],
    cleared,
  });
  if (!flag) return { ...base, action: "no_flag" };
  const nowIso = deps.now().toISOString();
  const { error } = await deps.client.from("job_deposit_advance_state").upsert({
    job_id: job.id,
    flag: flag.reason,
    flag_at: nowIso,
    flag_invoice_id: flag.xero_invoice_id,
    flag_invoice_number: flag.invoice_number,
    flag_invoice_status: flag.invoice_status,
    flag_cleared_at: null,
    flag_cleared_by: null,
    cleared_flags: [...new Set(cleared)],
    updated_at: nowIso,
  }, { onConflict: "job_id" });
  if (error) {
    console.error("[job_deposit] flag write failed:", error.message);
    return { ...base, action: "facts_unreadable", detail: "flag_write_failed" };
  }
  await deps.client.from("job_events").insert({
    job_id: job.id,
    event_type: "deposit_flagged",
    detail_json: {
      reason: flag.reason,
      invoice_number: flag.invoice_number,
      xero_invoice_id: flag.xero_invoice_id,
      invoice_status: flag.invoice_status,
      job_status: job.status,
      source,
      note: "The job was not moved back. A person decides.",
    },
  });
  return { ...base, action: "flagged", detail: flag };
}

// ── Entry points ─────────────────────────────────────────────────────────────

/** xero-sync: a client sales invoice of this job changed (paid, voided, payment removed). */
export async function depositOnInvoiceChange(
  deps: JobDepositDeps,
  body: Record<string, unknown>,
): Promise<{ ok: true } & DepositResult> {
  const jobId = text(body.job_id ?? body.jobId);
  if (!jobId) throw new JobDepositError("job_id required");
  const source = text(body.source) || DEPOSIT_PAID_SOURCE;
  const mode = await readDepositAdvanceMode(deps.client);
  if (mode === "off") {
    return { ok: true, job_id: jobId, job_number: null, action: "switch_off" };
  }
  const job = await loadJob(deps.client, jobId);
  if (!job) throw new JobDepositError("job not found", 404, "job_not_found");
  const base = { job_id: job.id, job_number: job.job_number };
  if (!isDepositAdvanceJobType(job.type)) {
    return { ok: true, ...base, action: "not_deposit_type" };
  }
  const allFacts = await loadFacts(deps.client, [job.id]);
  if (!allFacts) return { ok: true, ...base, action: "facts_unreadable" };
  const facts = allFacts.get(job.id) ?? { invoices: [], parties: [] };
  const rows = facts.invoices;
  const xeroInvoiceId = text(body.xero_invoice_id);
  if (xeroInvoiceId) {
    const changed = rows.find((r) => text(r.xero_invoice_id) === xeroInvoiceId);
    if (!changed || !isDepositInvoice(changed, job.deposit_invoice_id)) {
      return { ok: true, ...base, action: "not_deposit_invoice" };
    }
  }
  if (
    (DEPOSIT_PAID_FROM_STATUSES as readonly string[]).includes(text(job.status))
  ) {
    return { ok: true, ...(await settlePaid(deps, job, facts, mode, source)) };
  }
  if ((DEPOSIT_FLAG_STATUSES as readonly string[]).includes(text(job.status))) {
    return { ok: true, ...(await checkFlag(deps, job, facts, source)) };
  }
  return {
    ok: true,
    ...base,
    action: "not_in_from_status",
    detail: job.status,
  };
}

/** xero-sync, after each run: waiting cards whose deposits are paid, and moved cards whose
 *  deposit has since been voided or unpaid. */
export async function depositCatchUp(
  deps: JobDepositDeps,
  body: Record<string, unknown>,
) {
  const mode = await readDepositAdvanceMode(deps.client);
  if (mode === "off") return { ok: true, ran: false, reason: "switch_off" };
  const source = text(body.source) || "job_deposit_catch_up";
  const waiting = await loadJobsByStatus(
    deps.client,
    DEPOSIT_PAID_FROM_STATUSES,
  );
  if (!waiting) return { ok: false, ran: false, reason: "jobs_unreadable" };
  const { data: movedRows, error: movedErr } = await deps.client.from(
    "job_deposit_advance_state",
  ).select("job_id").not("moved_at", "is", null).is("flag_cleared_at", null).is(
    "flag",
    null,
  ).limit(5000);
  if (movedErr) return { ok: false, ran: false, reason: "state_unreadable" };
  const movedIds = new Set<string>(
    (movedRows ?? []).map((r: { job_id: string }) => r.job_id),
  );
  const movedJobs: DepositJobRow[] = [];
  for (const part of chunks([...movedIds])) {
    const { data, error } = await deps.client.from("jobs").select(JOB_COLUMNS)
      .in(
        "id",
        part,
      );
    if (error) return { ok: false, ran: false, reason: "jobs_unreadable" };
    for (const j of data ?? []) {
      if (
        (DEPOSIT_FLAG_STATUSES as readonly string[]).includes(text(j.status))
      ) {
        movedJobs.push(j);
      }
    }
  }
  const all = [...waiting, ...movedJobs];
  const facts = await loadFacts(deps.client, all.map((j) => j.id));
  if (!facts) return { ok: false, ran: false, reason: "invoices_unreadable" };
  const factsFor = (id: string): DepositFacts =>
    facts.get(id) ?? { invoices: [], parties: [] };
  const results: DepositResult[] = [];
  for (const job of waiting) {
    // Only a card whose deposits pass the paid rule can move; the rest are not listed.
    if (!evaluateDepositPaid({ job, ...factsFor(job.id) }).paid) continue;
    results.push(await settlePaid(deps, job, factsFor(job.id), mode, source));
  }
  for (const job of movedJobs) {
    const r = await checkFlag(deps, job, factsFor(job.id), source);
    if (r.action !== "no_flag") results.push(r);
  }
  return {
    ok: true,
    ran: true,
    mode,
    checked: waiting.length + movedJobs.length,
    results,
  };
}

/** A person has dealt with the flag: it stops showing on the board. */
export async function clearDepositFlag(
  deps: JobDepositDeps,
  body: Record<string, unknown>,
  by: string,
) {
  const jobId = text(body.job_id ?? body.jobId);
  if (!jobId) throw new JobDepositError("job_id required");
  const { data, error } = await deps.client.from("job_deposit_advance_state")
    .update({
      flag_cleared_at: deps.now().toISOString(),
      flag_cleared_by: by,
      updated_at: deps.now().toISOString(),
    })
    .eq("job_id", jobId)
    .not("flag", "is", null)
    .is("flag_cleared_at", null)
    .select("job_id, flag");
  if (error) {
    throw new JobDepositError(
      `flag clear failed: ${error.message}`,
      503,
      "state_unwritable",
    );
  }
  if (!Array.isArray(data) || data.length === 0) {
    return { ok: true, job_id: jobId, action: "no_open_flag" };
  }
  await deps.client.from("job_events").insert({
    job_id: jobId,
    event_type: "deposit_flag_cleared",
    detail_json: { reason: data[0].flag, cleared_by: by },
  });
  return { ok: true, job_id: jobId, action: "cleared" };
}

// ── Board read ───────────────────────────────────────────────────────────────

export interface DepositFlagBlock {
  reason: string;
  invoice_number: string | null;
  invoice_status: string | null;
  flagged_at: string | null;
}

/** The open deposit flags for these jobs (pipeline card field deposit_flag); null when the
 *  read fails. */
export async function loadDepositFlags(
  // deno-lint-ignore no-explicit-any
  client: any,
  jobIds: string[],
): Promise<Map<string, DepositFlagBlock> | null> {
  const out = new Map<string, DepositFlagBlock>();
  for (const part of chunks(jobIds)) {
    const { data, error } = await client.from("job_deposit_advance_state")
      .select("job_id, flag, flag_invoice_number, flag_invoice_status, flag_at")
      .in("job_id", part)
      .not("flag", "is", null)
      .is("flag_cleared_at", null)
      .limit(5000);
    if (error) return null;
    for (const row of data ?? []) {
      out.set(row.job_id, {
        reason: row.flag,
        invoice_number: row.flag_invoice_number ?? null,
        invoice_status: row.flag_invoice_status ?? null,
        flagged_at: row.flag_at ?? null,
      });
    }
  }
  return out;
}

// ── Action door ──────────────────────────────────────────────────────────────

export const JOB_DEPOSIT_ACTIONS = [
  "job_deposit_paid",
  "job_deposit_catch_up",
  "clear_job_deposit_flag",
] as const;

export type JobDepositCaller =
  | { kind: "server" }
  | { kind: "staff"; email: string | null }
  | { kind: "none" };

/** Server key only for the two that move or text; a signed-in staff operator clears a flag. */
export async function runJobDepositAction(
  action: string,
  method: string,
  body: Record<string, unknown>,
  caller: JobDepositCaller,
  deps: JobDepositDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    if (method !== "POST") {
      return { status: 405, body: { ok: false, code: "method_not_allowed" } };
    }
    if (action === "clear_job_deposit_flag") {
      if (caller.kind === "none") {
        return {
          status: 403,
          body: { ok: false, code: "operator_access_required" },
        };
      }
      const by = caller.kind === "staff"
        ? (caller.email || "staff")
        : (text(body.operator_email) || "server");
      return { status: 200, body: await clearDepositFlag(deps, body, by) };
    }
    if (caller.kind !== "server") {
      return { status: 403, body: { ok: false, code: "server_key_required" } };
    }
    if (action === "job_deposit_paid") {
      return { status: 200, body: await depositOnInvoiceChange(deps, body) };
    }
    if (action === "job_deposit_catch_up") {
      return { status: 200, body: await depositCatchUp(deps, body) };
    }
    return { status: 400, body: { ok: false, code: "unknown_action" } };
  } catch (e) {
    if (e instanceof JobDepositError) {
      return {
        status: e.status,
        body: { ok: false, code: e.code, error: e.message },
      };
    }
    throw e;
  }
}
