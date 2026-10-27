// Paid-invoice receipt for fencing and patio jobs (captain, 20 Oct 2026): when a client
// sales invoice of a fencing or patio job turns PAID, Xero emails that paid invoice to its
// Xero contact (POST /Invoices/{InvoiceID}/Email). The customer gets Xero's paid invoice
// email ("View Invoice", no Pay button, $0.00 due), sent by Xero from the Xero user who
// authorised the connection. Every paid invoice counts, deposits included. One email per
// invoice, ever.
//
// This is a recorded exception to the 30 Sep 2026 ruling that our automated money
// messages stay off (debt_autotexts_off.ts): receipts only. (The other: the deposit
// received text, job_deposit_advance.ts.) Contract: docs/job-receipt-v1.md.
//
//   - requestInvoiceReceipt  the one sender, for one xero_invoice_id. Order: switch ->
//                            invoice (ACCREC, PAID, on a job) -> job (fencing or patio,
//                            not sealed) -> window (paid after the switch's current mode
//                            began, and within PAID_WITHIN_DAYS) -> claim already taken ->
//                            paid by the customer (not wholly by credit) -> holds ->
//                            wrong-party guard -> ops-api's own send guards ->
//                            (dry run: one receipt_dry_run event) -> claim -> Xero.
//   - receiptCatchUp         xero-sync calls job_receipt_catch_up after each run: every
//                            in-window paid invoice with no claim, so a payment another
//                            writer mirrored first, or a post that failed, is still sent.
//
// The claim (job_receipt_claims, one row per xero_invoice_id) is inserted before the Xero
// call and its id is the Idempotency-Key. Xero sends an email every time /Email is called,
// so a claim is never retried once the call may have gone: an unknown outcome is kept as
// 'unconfirmed', a Xero refusal (4xx) is kept as 'refused' for staff. Only an answer that
// proves Xero never took the request (rate limited, cooldown, auth, no token) releases the
// claim, so the next run sends. A refusal of ours (held, wrong party) claims nothing and is
// recorded once as a receipt_not_sent job event, so staff can fix it and the next run sends.
//
// Switch: job_closeout_settings.receipt_sender_mode (off | dry_run | live; the database
// switch alone decides, captain 20 Oct 2026) and receipt_sender_mode_since, which a trigger
// stamps whenever the mode changes. Only invoices paid after the current mode began are in
// scope: history is never caught up, and a live switch never sends for invoices paid during
// the dry run (staff were still sending those by hand). The manual Send review button never
// sends a receipt.

import {
  closeoutHold,
  invoicePartyKey,
  isCloseoutJobType,
  OWNER_KEY,
  payingParties,
} from "../_shared/job_paid_closeout.ts";
import { PAID_WITHIN_DAYS } from "./job_closeout.ts";

/** A claim still 'claimed' this long after it was taken never finished; the catch-up records
 *  it as unconfirmed (never re-sent). */
export const STUCK_RECEIPT_CLAIM_AFTER_MS = 60 * 60 * 1000;
/** The longest one Xero /Email call may take before it counts as unconfirmed. */
export const RECEIPT_EMAIL_TIMEOUT_MS = 20_000;
/** Perth is UTC+8 all year; Xero's FullyPaidOnDate is the organisation's (Perth) day. */
const PERTH_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Ids per PostgREST .in() filter. */
const ID_CHUNK = 50;
/** Paid invoices one catch-up looks at (about three a day are fencing or patio). */
const CATCH_UP_LIMIT = 1000;

export type ReceiptSenderMode = "off" | "dry_run" | "live";

export interface ReceiptSwitch {
  /** The effective mode: 'off' whenever the start instant is missing. */
  mode: ReceiptSenderMode;
  configured_mode: ReceiptSenderMode;
  /** When the current mode began (receipt_sender_mode_since). */
  since: string | null;
  read_ok: boolean;
}

/** What one Xero /Email call came to. */
export type ReceiptEmailResult =
  | { outcome: "sent" }
  /** Xero answered and refused (4xx): nothing went out; kept for staff, never retried. */
  | { outcome: "refused"; error: string }
  /** Xero provably never took the request (rate limit, cooldown, auth, no token). */
  | { outcome: "not_sent"; error: string }
  /** The email may or may not have gone (5xx, timeout, lost connection). */
  | { outcome: "unknown"; error: string };

export interface JobReceiptDeps {
  // deno-lint-ignore no-explicit-any
  client: any;
  now: () => Date;
  /** The claim id; also the Idempotency-Key. */
  newId?: () => string;
  /** One POST /Invoices/{id}/Email. */
  emailInvoice: (
    args: { xeroInvoiceId: string; idempotencyKey: string },
  ) => Promise<ReceiptEmailResult>;
  /** ops-api's own send guards (the sealed SES money fence, synthetic jobs): a refusal
   *  code, or null to go on. */
  preSendGuard?: (
    args: { xeroInvoiceId: string; jobId: string },
  ) => Promise<string | null>;
}

const text = (v: unknown): string => String(v ?? "").trim();

// ── Switch ───────────────────────────────────────────────────────────────────

/** Fails closed: an unreadable row, or a mode with no start instant, is off. */
export async function readReceiptSwitch(
  deps: Pick<JobReceiptDeps, "client">,
): Promise<ReceiptSwitch> {
  const off: ReceiptSwitch = {
    mode: "off",
    configured_mode: "off",
    since: null,
    read_ok: false,
  };
  try {
    const { data, error } = await deps.client.from("job_closeout_settings")
      .select("receipt_sender_mode, receipt_sender_mode_since")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) return off;
    const configured = (["off", "dry_run", "live"] as const).includes(
        data.receipt_sender_mode,
      )
      ? data.receipt_sender_mode as ReceiptSenderMode
      : "off";
    const since = text(data.receipt_sender_mode_since) || null;
    const sinceOk = since !== null && Number.isFinite(Date.parse(since));
    return {
      mode: sinceOk ? configured : "off",
      configured_mode: configured,
      since: sinceOk ? since : null,
      read_ok: true,
    };
  } catch {
    return off;
  }
}

// ── The rules (pure) ─────────────────────────────────────────────────────────

export interface ReceiptInvoice {
  xero_invoice_id: string;
  invoice_number: string | null;
  invoice_type: string | null;
  status: string | null;
  reference: string | null;
  job_id: string | null;
  job_contact_id: string | null;
  xero_contact_id: string | null;
  contact_name: string | null;
  fully_paid_on: string | null;
  /** Xero's AmountPaid: money the customer paid, never credit applied. */
  amount_paid: number | string | null;
  /** Xero's UpdatedDateUTC as the sync mirrors it. */
  updated_at: string | null;
}

export interface ReceiptJob {
  id: string;
  job_number: string | null;
  type: string | null;
  status: string | null;
  is_callback: boolean | null;
  ses_money_sealed_at?: string | null;
}

export interface ReceiptParty {
  id: string;
  contact_label: string | null;
  is_primary: boolean | null;
  share_percentage: number | string | null;
  removed_at: string | null;
  status?: string | null;
  xero_contact_id: string | null;
}

/** The Perth day (YYYY-MM-DD) of an instant. */
export function perthDay(iso: string): string {
  return new Date(Date.parse(iso) + PERTH_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Is this paid invoice inside the send window? null when it is; otherwise why not.
 * In scope: fully paid on or after the Perth day the switch's current mode began (on that
 * day itself, only when Xero last changed the invoice after that instant), and within
 * PAID_WITHIN_DAYS of now. History is never caught up.
 */
export function receiptWindowMiss(
  inv: Pick<ReceiptInvoice, "fully_paid_on" | "updated_at">,
  since: string,
  now: Date,
): "no_paid_date" | "paid_before_start" | "paid_too_long_ago" | null {
  const paidOn = text(inv.fully_paid_on).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return "no_paid_date";
  if (
    now.getTime() - new Date(`${paidOn}T23:59:59Z`).getTime() >
      PAID_WITHIN_DAYS * DAY_MS
  ) {
    return "paid_too_long_ago";
  }
  const startDay = perthDay(since);
  if (paidOn < startDay) return "paid_before_start";
  if (paidOn === startDay) {
    const changed = Date.parse(text(inv.updated_at));
    if (!Number.isFinite(changed) || changed < Date.parse(since)) {
      return "paid_before_start";
    }
  }
  return null;
}

export type PartyCheck =
  | { ok: true; party_id: string | null; party_label: string | null }
  | { ok: false; reason: string };

/**
 * The wrong-party guard. Xero emails the invoice's own Xero contact, so whenever the
 * invoice names a party (job_contact_id), and on every invoice of a job with two or more
 * paying parties, the invoice must sit on the Xero contact of the party it belongs to
 * (invoicePartyKey: its job_contact_id, its share letter, its Xero contact, else the
 * client), and that contact must be that party's alone. A named party that is removed or
 * has a zero share is no paying party, so its invoice is refused. Pure.
 */
export function receiptPartyCheck(
  inv: Pick<
    ReceiptInvoice,
    "job_contact_id" | "reference" | "xero_contact_id"
  >,
  parties: ReceiptParty[],
): PartyCheck {
  const invoiceContact = text(inv.xero_contact_id).toLowerCase();
  if (!invoiceContact) return { ok: false, reason: "no_xero_contact" };
  const paying = payingParties(parties) as ReceiptParty[];
  if (paying.length < 2 && !text(inv.job_contact_id)) {
    const only = paying[0] ?? null;
    return {
      ok: true,
      party_id: only?.id ?? null,
      party_label: only ? text(only.contact_label).toUpperCase() || null : null,
    };
  }
  const key = invoicePartyKey({
    xero_invoice_id: null,
    invoice_number: null,
    invoice_type: "ACCREC",
    status: "PAID",
    reference: inv.reference,
    total: null,
    amount_paid: null,
    job_contact_id: inv.job_contact_id,
    xero_contact_id: inv.xero_contact_id,
    fully_paid_on: null,
  }, paying);
  if (key.startsWith("unmatched:")) {
    return { ok: false, reason: "party_unmatched" };
  }
  const party = key === OWNER_KEY ? null : paying.find((p) => p.id === key);
  if (!party) return { ok: false, reason: "party_unknown" };
  const partyContact = text(party.xero_contact_id).toLowerCase();
  if (!partyContact) return { ok: false, reason: "party_xero_contact_unknown" };
  if (partyContact !== invoiceContact) {
    return { ok: false, reason: "xero_contact_mismatch" };
  }
  const sharing = paying.filter((p) =>
    text(p.xero_contact_id).toLowerCase() === invoiceContact
  );
  if (sharing.length > 1) return { ok: false, reason: "xero_contact_shared" };
  return {
    ok: true,
    party_id: party.id,
    party_label: text(party.contact_label).toUpperCase() || null,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

const INVOICE_COLUMNS =
  "xero_invoice_id, invoice_number, invoice_type, status, reference, job_id, job_contact_id, xero_contact_id, contact_name, fully_paid_on, amount_paid, updated_at";
const JOB_COLUMNS =
  "id, job_number, type, status, is_callback, ses_money_sealed_at";
const PARTY_COLUMNS =
  "id, contact_label, is_primary, share_percentage, removed_at, status, xero_contact_id";

function chunks<T>(items: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// ── Records ──────────────────────────────────────────────────────────────────

function invoiceDetail(inv: ReceiptInvoice, trigger: string) {
  return {
    xero_invoice_id: inv.xero_invoice_id,
    invoice_number: inv.invoice_number,
    xero_contact_id: inv.xero_contact_id,
    contact_name: inv.contact_name,
    fully_paid_on: inv.fully_paid_on,
    trigger,
  };
}

/** One job event per invoice and key (event type plus reason), never repeated each run. */
async function logOnce(
  deps: JobReceiptDeps,
  jobId: string,
  eventType: string,
  inv: ReceiptInvoice,
  key: { field: string; value: string },
  detail: Record<string, unknown>,
): Promise<void> {
  const { data: prior, error } = await deps.client.from("job_events")
    .select("id")
    .eq("job_id", jobId)
    .eq("event_type", eventType)
    .eq("detail_json->>xero_invoice_id", inv.xero_invoice_id)
    .eq(`detail_json->>${key.field}`, key.value)
    .limit(1);
  if (error || prior?.length) return;
  await deps.client.from("job_events").insert({
    job_id: jobId,
    event_type: eventType,
    detail_json: detail,
  });
}

/** The evidence row for a sent receipt, through the one SQL writer. Never throws. */
async function captureReceiptEvidence(
  deps: JobReceiptDeps,
  job: ReceiptJob,
  inv: ReceiptInvoice,
  claimId: string,
): Promise<void> {
  try {
    const { data, error } = await deps.client.rpc("capture_business_event", {
      p_row: {
        event_type: "invoice.receipt_emailed",
        source: "ops-api/job_receipt",
        entity_type: "invoice",
        entity_id: inv.xero_invoice_id,
        job_id: job.id,
        match_method: "direct_job_id",
        channel: "email",
        direction: "outbound",
        event_at: deps.now().toISOString(),
        provider_message_id: `xero:invoice:${inv.xero_invoice_id}:receipt`,
        body_preview: `Xero emailed paid invoice ${
          inv.invoice_number || inv.xero_invoice_id
        } to its Xero contact as the payment receipt.`,
        payload: {
          invoice_number: inv.invoice_number,
          xero_contact_id: inv.xero_contact_id,
          fully_paid_on: inv.fully_paid_on,
          via: "xero_direct",
        },
        metadata: { capture_mode: "live", receipt_claim_id: claimId },
      },
    });
    const outcome = data?.outcome;
    if (error || outcome === "error") {
      console.error(
        `[job_receipt] receipt evidence not written: ${
          error?.code ?? data?.code ?? "unknown"
        } ${inv.xero_invoice_id}`,
      );
    }
  } catch {
    console.error(
      `[job_receipt] receipt evidence threw ${inv.xero_invoice_id}`,
    );
  }
}

// ── The sender ───────────────────────────────────────────────────────────────

export interface ReceiptRequestOptions {
  xero_invoice_id: string;
  trigger: string;
}

export interface ReceiptResult {
  ok: boolean;
  action: string;
  xero_invoice_id?: string;
  invoice_number?: string | null;
  job_id?: string | null;
  reason?: string | null;
  error?: string;
}

/**
 * The one receipt sender. Nothing is claimed until every read has answered and every rule
 * of ours has passed; once a claim may have reached Xero it is kept, so no invoice is ever
 * emailed twice by this system.
 */
export async function requestInvoiceReceipt(
  deps: JobReceiptDeps,
  opts: ReceiptRequestOptions,
): Promise<ReceiptResult> {
  const id = text(opts.xero_invoice_id);
  if (!id) return { ok: false, action: "xero_invoice_id_required" };
  const sw = await readReceiptSwitch(deps);
  if (sw.mode === "off" || !sw.since) {
    return { ok: true, action: "sender_off", xero_invoice_id: id };
  }

  const { data: inv, error: invError } = await deps.client.from("xero_invoices")
    .select(INVOICE_COLUMNS)
    .eq("xero_invoice_id", id)
    .eq("invoice_type", "ACCREC")
    .maybeSingle();
  if (invError) {
    return { ok: false, action: "invoice_unreadable", xero_invoice_id: id };
  }
  if (!inv) {
    return { ok: true, action: "not_sales_invoice", xero_invoice_id: id };
  }
  const base = {
    xero_invoice_id: id,
    invoice_number: inv.invoice_number ?? null,
    job_id: inv.job_id ?? null,
  };
  if (text(inv.status).toUpperCase() !== "PAID") {
    return { ok: true, action: "not_paid", ...base };
  }
  if (!inv.job_id) return { ok: true, action: "no_job", ...base };

  const [jobRead, partyRead, claimRead] = await Promise.all([
    deps.client.from("jobs").select(JOB_COLUMNS).eq("id", inv.job_id)
      .maybeSingle(),
    deps.client.from("job_contacts").select(PARTY_COLUMNS).eq(
      "job_id",
      inv.job_id,
    ).limit(500),
    deps.client.from("job_receipt_claims").select("status").eq(
      "xero_invoice_id",
      id,
    ).maybeSingle(),
  ]);
  if (jobRead.error || partyRead.error || claimRead.error) {
    return { ok: false, action: "facts_unreadable", ...base };
  }
  const job = jobRead.data as ReceiptJob | null;
  if (!job) return { ok: true, action: "job_not_found", ...base };
  // Builder, insurer, make-safe and repair jobs are never receipted; nor is a sealed SES card.
  if (!isCloseoutJobType(job.type)) {
    return { ok: true, action: "not_closeout_type", ...base };
  }
  if (job.ses_money_sealed_at) {
    return { ok: true, action: "ses_sealed", ...base };
  }
  const miss = receiptWindowMiss(inv, sw.since, deps.now());
  if (miss) return { ok: true, action: miss, ...base };
  if (claimRead.data) {
    return {
      ok: true,
      action: "already_claimed",
      reason: claimRead.data.status ?? null,
      ...base,
    };
  }

  // Our own refusals: nothing claimed, recorded once for staff, sent once fixed.
  let refusal: string | null = null;
  let party: PartyCheck | null = null;
  const hold = closeoutHold(job);
  if (!(Number(inv.amount_paid) > 0)) refusal = "credit_settled";
  else if (hold) refusal = `held_${hold}`;
  else {
    party = receiptPartyCheck(inv, (partyRead.data ?? []) as ReceiptParty[]);
    if (!party.ok) refusal = party.reason;
  }
  if (!refusal && deps.preSendGuard) {
    try {
      const guard = await deps.preSendGuard({
        xeroInvoiceId: id,
        jobId: job.id,
      });
      if (guard) refusal = `guard_${guard}`;
    } catch (e) {
      refusal = `guard_${text((e as Error)?.message).slice(0, 80) || "threw"}`;
    }
  }
  const detail = {
    ...invoiceDetail(inv, opts.trigger),
    party_id: party?.ok ? party.party_id : null,
    party_label: party?.ok ? party.party_label : null,
  };

  if (sw.mode === "dry_run") {
    const would = refusal ?? "send";
    await logOnce(deps, job.id, "receipt_dry_run", inv, {
      field: "would",
      value: would,
    }, { ...detail, would });
    return { ok: true, action: "dry_run", reason: refusal, ...base };
  }

  if (refusal) {
    await logOnce(deps, job.id, "receipt_not_sent", inv, {
      field: "reason",
      value: refusal,
    }, { ...detail, status: "refused", reason: refusal });
    return { ok: true, action: "refused", reason: refusal, ...base };
  }

  // Live: the claim first. A second claim for the same invoice is refused by its key.
  const claimId = deps.newId?.() ?? crypto.randomUUID();
  const { error: claimError } = await deps.client.from("job_receipt_claims")
    .insert({
      id: claimId,
      xero_invoice_id: id,
      job_id: job.id,
      invoice_number: inv.invoice_number,
      xero_contact_id: inv.xero_contact_id,
      status: "claimed",
      trigger: opts.trigger,
    });
  if (claimError) {
    if (claimError.code === "23505") {
      return { ok: true, action: "already_claimed", ...base };
    }
    return {
      ok: false,
      action: "claim_failed",
      error: claimError.message,
      ...base,
    };
  }

  let sent: ReceiptEmailResult;
  try {
    sent = await deps.emailInvoice({
      xeroInvoiceId: id,
      idempotencyKey: claimId,
    });
  } catch (e) {
    sent = {
      outcome: "unknown",
      error: text((e as Error)?.message).slice(0, 300) || "threw",
    };
  }

  // Xero provably never took it: release the claim so the next run sends.
  if (sent.outcome === "not_sent") {
    const { error: releaseError } = await deps.client.from("job_receipt_claims")
      .delete().eq("id", claimId).eq("status", "claimed");
    if (releaseError) {
      console.error(
        "[job_receipt] receipt claim release failed:",
        releaseError.message,
      );
    }
    console.warn(
      `[job_receipt] ${id} not sent, retried next run: ${sent.error}`,
    );
    return {
      ok: true,
      action: "retry_later",
      reason: sent.error.slice(0, 120),
      ...base,
    };
  }

  const status = sent.outcome === "sent"
    ? "sent"
    : sent.outcome === "refused"
    ? "refused"
    : "unconfirmed";
  const error = sent.outcome === "sent" ? null : sent.error.slice(0, 300);
  const { error: finishError } = await deps.client.from("job_receipt_claims")
    .update({ status, error, finished_at: deps.now().toISOString() })
    .eq("id", claimId).eq("status", "claimed");
  if (finishError) {
    console.error(
      "[job_receipt] receipt claim finish failed:",
      finishError.message,
    );
  }
  await deps.client.from("job_events").insert({
    job_id: job.id,
    event_type: status === "sent" ? "receipt_sent" : "receipt_not_sent",
    detail_json: {
      ...detail,
      status,
      reason: status === "sent"
        ? null
        : status === "refused"
        ? "xero_refused"
        : "unconfirmed",
      error,
      claim_id: claimId,
      via: "xero_direct",
    },
  });
  if (status === "sent") await captureReceiptEvidence(deps, job, inv, claimId);
  return {
    ok: true,
    action: status,
    reason: status === "sent" ? null : error,
    ...base,
  };
}

// ── The catch-up ─────────────────────────────────────────────────────────────

/** Claims still 'claimed' long after they were taken: recorded unconfirmed, never re-sent. */
async function settleStuckClaims(deps: JobReceiptDeps): Promise<number> {
  const before = new Date(deps.now().getTime() - STUCK_RECEIPT_CLAIM_AFTER_MS)
    .toISOString();
  const { data, error } = await deps.client.from("job_receipt_claims")
    .select("id")
    .eq("status", "claimed")
    .lt("claimed_at", before)
    .limit(100);
  if (error || !data?.length) return 0;
  const ids = data.map((r: { id: string }) => r.id);
  const { error: updateError } = await deps.client.from("job_receipt_claims")
    .update({
      status: "unconfirmed",
      error: "stuck_claim",
      finished_at: deps.now().toISOString(),
    })
    .in("id", ids)
    .eq("status", "claimed");
  if (updateError) {
    console.error(
      "[job_receipt] stuck claim settle failed:",
      updateError.message,
    );
    return 0;
  }
  return ids.length;
}

/** xero-sync, after each run: every in-window fencing or patio invoice the customer paid
 *  money on, with no claim. */
export async function receiptCatchUp(
  deps: JobReceiptDeps,
  body: Record<string, unknown>,
) {
  const sw = await readReceiptSwitch(deps);
  if (sw.mode === "off" || !sw.since) {
    return { ok: true, ran: false, reason: "sender_off" };
  }
  const stuck = sw.mode === "live" ? await settleStuckClaims(deps) : 0;
  const now = deps.now();
  const windowStart = new Date(
    now.getTime() - (PAID_WITHIN_DAYS + 1) * DAY_MS,
  ).toISOString().slice(0, 10);
  const startDay = perthDay(sw.since);
  const floor = startDay > windowStart ? startDay : windowStart;
  const { data: invoices, error } = await deps.client.from("xero_invoices")
    .select("xero_invoice_id, job_id")
    .eq("invoice_type", "ACCREC")
    .eq("status", "PAID")
    .gt("amount_paid", 0)
    .gte("fully_paid_on", floor)
    .not("job_id", "is", null)
    .order("fully_paid_on", { ascending: true })
    .limit(CATCH_UP_LIMIT);
  if (error) return { ok: false, ran: false, reason: "invoices_unreadable" };
  const rows = (invoices ?? []) as {
    xero_invoice_id: string;
    job_id: string;
  }[];
  const claimed = new Set<string>();
  const closeoutJobs = new Set<string>();
  for (const part of chunks(rows.map((r) => r.xero_invoice_id))) {
    const { data, error: claimError } = await deps.client.from(
      "job_receipt_claims",
    ).select("xero_invoice_id").in("xero_invoice_id", part);
    if (claimError) {
      return { ok: false, ran: false, reason: "claims_unreadable" };
    }
    for (const c of data ?? []) claimed.add(c.xero_invoice_id);
  }
  const jobIds = [...new Set(rows.map((r) => r.job_id))];
  for (const part of chunks(jobIds)) {
    const { data, error: jobError } = await deps.client.from("jobs")
      .select("id, type").in("id", part);
    if (jobError) return { ok: false, ran: false, reason: "jobs_unreadable" };
    for (const j of data ?? []) {
      if (isCloseoutJobType(j.type)) closeoutJobs.add(j.id);
    }
  }
  const trigger = text(body.source) || "job_receipt_catch_up";
  const results: ReceiptResult[] = [];
  for (const r of rows) {
    if (claimed.has(r.xero_invoice_id) || !closeoutJobs.has(r.job_id)) continue;
    results.push(
      await requestInvoiceReceipt(deps, {
        xero_invoice_id: r.xero_invoice_id,
        trigger,
      }),
    );
  }
  return {
    ok: true,
    ran: true,
    mode: sw.mode,
    checked: rows.length,
    stuck_claims_settled: stuck,
    results,
  };
}

// ── The Xero call ────────────────────────────────────────────────────────────

/**
 * The live emailInvoice: one POST /Invoices/{id}/Email with the claim id as the
 * Idempotency-Key. `fetch` is ops-api's shared Xero cooldown fetch, so a cooldown or
 * rate limit is answered before anything reaches Xero. Never retries.
 */
export function xeroReceiptEmailer(opts: {
  getToken: () => Promise<{ accessToken: string; tenantId: string }>;
  fetch: typeof fetch;
  baseUrl: string;
}): JobReceiptDeps["emailInvoice"] {
  return async ({ xeroInvoiceId, idempotencyKey }) => {
    let token: { accessToken: string; tenantId: string };
    try {
      token = await opts.getToken();
    } catch {
      return { outcome: "not_sent", error: "xero_token_unavailable" };
    }
    let resp: Response;
    try {
      resp = await opts.fetch(
        `${opts.baseUrl}/Invoices/${encodeURIComponent(xeroInvoiceId)}/Email`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token.accessToken}`,
            "Xero-tenant-id": token.tenantId,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: "{}",
        },
      );
    } catch (e) {
      // The shared cooldown refuses before any request leaves; anything else (a timeout,
      // a lost connection) may have reached Xero.
      // deno-lint-ignore no-explicit-any
      const err = e as any;
      if (err?.details?.provider_call_made === false) {
        return {
          outcome: "not_sent",
          error: text(err.code) || "xero_cooldown",
        };
      }
      return {
        outcome: "unknown",
        error: err?.name === "TimeoutError" || err?.name === "AbortError"
          ? "timeout"
          : text(err?.message).slice(0, 300) || "fetch_failed",
      };
    }
    if (resp.ok) {
      await resp.body?.cancel().catch(() => {});
      return { outcome: "sent" };
    }
    const body = await resp.text().catch(() => "");
    if (resp.status === 429 || resp.status === 401 || resp.status === 403) {
      return { outcome: "not_sent", error: `HTTP ${resp.status}` };
    }
    if (resp.status >= 400 && resp.status < 500) {
      return {
        outcome: "refused",
        error: `HTTP ${resp.status}: ${xeroValidationMessage(body)}`.slice(
          0,
          300,
        ),
      };
    }
    return { outcome: "unknown", error: `HTTP ${resp.status}` };
  };
}

/** Xero's validation messages, else the start of its answer. */
function xeroValidationMessage(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const msgs = (parsed?.Elements ?? []).flatMap((
      // deno-lint-ignore no-explicit-any
      el: any,
    ) =>
      (el?.ValidationErrors ?? []).map((ve: { Message?: string }) =>
        ve?.Message
      )
    )
      .filter(Boolean);
    if (msgs.length) return msgs.join("; ");
    if (parsed?.Message) return text(parsed.Message);
  } catch { /* not JSON */ }
  return body.slice(0, 200);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export const JOB_RECEIPT_ACTIONS = [
  "job_receipt_paid",
  "job_receipt_catch_up",
] as const;

/** Server key only: both actions can email a customer. */
export async function runJobReceiptAction(
  action: string,
  method: string,
  body: Record<string, unknown>,
  caller: { kind: "server" | "staff" | "none" },
  deps: JobReceiptDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (caller.kind !== "server") {
    return { status: 403, body: { ok: false, code: "server_key_required" } };
  }
  if (method !== "POST") {
    return { status: 405, body: { ok: false, code: "method_not_allowed" } };
  }
  if (action === "job_receipt_paid") {
    const result = await requestInvoiceReceipt(deps, {
      xero_invoice_id: text(body.xero_invoice_id ?? body.xeroInvoiceId),
      trigger: text(body.source) || "xero_sync",
    });
    return {
      status: result.action === "xero_invoice_id_required" ? 400 : 200,
      body: { ...result },
    };
  }
  if (action === "job_receipt_catch_up") {
    return { status: 200, body: await receiptCatchUp(deps, body) };
  }
  return { status: 400, body: { ok: false, code: "unknown_action" } };
}
