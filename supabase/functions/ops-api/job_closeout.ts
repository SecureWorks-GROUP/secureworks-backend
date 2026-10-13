// Paid close-out for fencing and patio jobs (captain, 13 Oct 2026): paid -> Get Review,
// one review text, archived 24 hours later.
//
// The rule for "paid" is _shared/job_paid_closeout.ts. This module owns every read and
// write around it, and every step goes through it:
//   - closeoutOnPaid       xero-sync calls job_closeout_paid when a linked sales invoice of
//                          a fencing or patio job turns PAID: a paid job moves from
//                          complete, final_payment or invoiced to get_review (compare and
//                          set on the status); "paid less than quoted" stays put with a
//                          marker; a held job never moves.
//   - closeoutCatchUp      xero-sync calls job_closeout_catch_up after each run: the same
//                          for invoiced and final_payment cards whose last invoice was paid
//                          before the card got there (paid within CATCH_UP_PAID_WITHIN_DAYS).
//   - requestJobReview     the one review sender: once per job (a job_review_claims row is
//                          inserted before any text), to every paying owner, skipping any
//                          contact asked for a review in the last 90 days from any source,
//                          re-checking get_review, the holds and the paid rule first.
//   - closeoutSweep        the job-closeout-sweep cron (closeout lane): archives a card that
//                          entered get_review at least 24 hours ago, is still paid, is not
//                          held and whose review was sent or deliberately skipped (or the
//                          sender is not live). Compare and set on get_review.
//   - closeoutBacklogPreview  the dry-run list of fully paid fencing and patio jobs sitting
//                          in complete that a later, separate step may archive. Writes
//                          nothing and never texts.
//
// Switches, all off at deploy (migration 20261013140000_job_closeout_review_archive.sql):
// job_closeout_settings.get_review_move_enabled, job_closeout_settings.review_sender_mode
// (off | dry_run | live, and live needs env JOB_REVIEW_SENDING_ENABLED=true) and the
// closeout automation lane for the sweep. Builder, insurance, make-safe and repair jobs are
// never touched here.

import {
  CLOSEOUT_ARCHIVE_AFTER_MS,
  CLOSEOUT_ARCHIVE_STATUS,
  CLOSEOUT_FROM_STATUSES,
  CLOSEOUT_REVIEW_STATUS,
  closeoutHold,
  type CloseoutInvoice,
  type CloseoutJob,
  type CloseoutParty,
  type CloseoutQuote,
  evaluateJobPaid,
  isCloseoutFromStatus,
  isCloseoutJobType,
  type PaidVerdict,
  payingParties,
} from "../_shared/job_paid_closeout.ts";
import { GOOGLE_REVIEW_URL } from "../_shared/google_review_link.ts";
import {
  type JobQuotes,
  readJobQuotes,
  readJobVariations,
  type VariationView,
} from "./job_commercial_read.ts";

/** A contact asked for a review this recently, from any source, is not asked again. */
export const REVIEW_LOOKBACK_DAYS = 90;
/** The sender texts only while the later of entering get_review and the last payment is this recent. */
export const REVIEW_SEND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** The catch-up moves only jobs whose newest payment is this recent. */
export const CATCH_UP_PAID_WITHIN_DAYS = 30;
/** Jobs read per sweep, catch-up or backlog page. */
export const CLOSEOUT_BATCH_LIMIT = 200;
/** Ids per PostgREST .in() filter. */
const ID_CHUNK = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a captured review text looks like, whoever sent it (GHL workflow, by hand, us). */
const REVIEW_TEXT_PATTERNS = [
  "share.google/AFyfkE7jLfCZcxanV",
  "leave a review",
  "leave us a review",
  "google review",
];

export type ReviewSenderMode = "off" | "dry_run" | "live";

export interface CloseoutSwitches {
  move_enabled: boolean;
  /** The effective mode: 'live' only when the row says live AND the env says true. */
  sender_mode: ReviewSenderMode;
  sender_configured_mode: ReviewSenderMode;
  read_ok: boolean;
}

export type SmsSendResult =
  | { ok: true; message_id: string | null }
  | { ok: false; refused: boolean; error: string };

export interface JobCloseoutDeps {
  // deno-lint-ignore no-explicit-any
  client: any;
  now: () => Date;
  env: (key: string) => string | undefined;
  /** ops-api updateJobStatus (with expected_statuses for compare and set). */
  // deno-lint-ignore no-explicit-any
  moveJobStatus: (body: Record<string, unknown>) => Promise<any>;
  /** One SMS through ghl-proxy send_sms (the shared sender policy and contact guard). */
  sendSms: (
    args: { contactId: string; message: string; jobId: string },
  ) => Promise<SmsSendResult>;
  laneEnabled: (lane: "closeout") => Promise<boolean>;
}

export class JobCloseoutError extends Error {
  constructor(message: string, readonly status = 400, readonly code = "bad_request") {
    super(message);
  }
}

const text = (v: unknown): string => String(v ?? "").trim();

// ── Switches ─────────────────────────────────────────────────────────────────

export function effectiveSenderMode(
  configured: unknown,
  envValue: string | undefined,
): ReviewSenderMode {
  const mode = text(configured);
  if (mode === "live") return envValue === "true" ? "live" : "dry_run";
  if (mode === "dry_run") return "dry_run";
  return "off";
}

/** Fails closed: an unreadable row is every switch off. */
export async function readCloseoutSwitches(
  deps: Pick<JobCloseoutDeps, "client" | "env">,
): Promise<CloseoutSwitches> {
  try {
    const { data, error } = await deps.client.from("job_closeout_settings")
      .select("get_review_move_enabled, review_sender_mode")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) {
      return { move_enabled: false, sender_mode: "off", sender_configured_mode: "off", read_ok: false };
    }
    const configured = (["off", "dry_run", "live"] as const).includes(
        data.review_sender_mode,
      )
      ? data.review_sender_mode as ReviewSenderMode
      : "off";
    return {
      move_enabled: data.get_review_move_enabled === true,
      sender_mode: effectiveSenderMode(configured, deps.env("JOB_REVIEW_SENDING_ENABLED")),
      sender_configured_mode: configured,
      read_ok: true,
    };
  } catch {
    return { move_enabled: false, sender_mode: "off", sender_configured_mode: "off", read_ok: false };
  }
}

// ── The review text ──────────────────────────────────────────────────────────

/**
 * The review text, in the wording the GHL review workflow and staff already send
 * (captured 2026: "Thank you for trusting us with your recent job! Payment is well
 * received. ... Shaun, SecureWorks Fencing"), with the one review link. A patio job signs
 * "SecureWorks" (no captured patio wording exists; "SecureWorks" is a captured sign-off).
 */
export function reviewRequestMessage(
  clientName: string | null | undefined,
  jobType?: string | null,
): string {
  const first = text(clientName).split(/\s+/)[0] || "there";
  const signOff = text(jobType).toLowerCase() === "patio"
    ? "SecureWorks"
    : "SecureWorks Fencing";
  return `Hi ${first},\n\nThank you for trusting us with your recent job! Payment is well received.\n\n` +
    `If you were satisfied with our work and the overall experience, we'd greatly appreciate it if you could take a moment to share your feedback. ` +
    `Your review helps us continue to provide quality service to our customers. You can leave a review here: ${GOOGLE_REVIEW_URL}\n\n` +
    `Thank you again for your business!\n\nShaun\n${signOff}`;
}

// ── Quote side of the paid rule ──────────────────────────────────────────────

const AGREED_VARIATIONS = new Set([
  "customer_accepted",
  "invoiced",
  "approved_internally_not_accepted",
]);

/**
 * The sent quote (job_quote_values through readJobQuotes: the whole-job total when the
 * quote is split by party, else the accepted or newest current document's value) plus
 * approved variations, inc GST. Pure.
 */
export function quoteForCloseout(
  quotes: Pick<JobQuotes, "status" | "whole_quote_total" | "headline"> | null,
  variations: Pick<VariationView, "agreement" | "amount" | "gst_included">[] | null,
): CloseoutQuote {
  let quoteTotal: number | null = null;
  let reason: string | null = null;
  if (!quotes) reason = "quote_unreadable";
  else if (quotes.status === "none_recorded") reason = "no_sent_quote";
  else if (quotes.whole_quote_total) quoteTotal = quotes.whole_quote_total.value_inc_gst;
  else if (quotes.headline?.value_inc_gst != null) quoteTotal = quotes.headline.value_inc_gst;
  else reason = "quote_value_not_recorded";
  let variationsInc: number | null = null;
  if (variations) {
    variationsInc = 0;
    for (const v of variations) {
      if (!AGREED_VARIATIONS.has(v.agreement) || v.amount == null) continue;
      variationsInc += v.gst_included === false ? v.amount * 1.1 : v.amount;
    }
    variationsInc = Math.round(variationsInc * 100) / 100;
  } else if (!reason) {
    reason = "variations_unreadable";
  }
  return { quote_total_inc: quoteTotal, variations_inc: variationsInc, unknown_reason: reason };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface CloseoutJobRow extends CloseoutJob {
  client_name: string | null;
  client_email: string | null;
  ghl_contact_id: string | null;
}

interface PartyRow extends CloseoutParty {
  client_name: string | null;
  ghl_contact_id: string | null;
}

const JOB_COLUMNS =
  "id, job_number, type, status, is_callback, deposit_invoice_id, client_name, client_email, ghl_contact_id";
const INVOICE_COLUMNS =
  "job_id, xero_invoice_id, invoice_number, invoice_type, status, reference, total, amount_paid, job_contact_id, xero_contact_id, fully_paid_on";
const PARTY_COLUMNS =
  "id, job_id, contact_label, is_primary, share_percentage, removed_at, xero_contact_id, client_name, ghl_contact_id";

function chunks<T>(items: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// deno-lint-ignore no-explicit-any
async function readByJob<T>(client: any, table: string, columns: string, jobIds: string[], extra?: (q: any) => any): Promise<Map<string, T[]> | null> {
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

export interface JobFacts {
  job: CloseoutJobRow;
  invoices: CloseoutInvoice[];
  parties: PartyRow[];
}

/** Invoices and parties for many jobs at once; null when either read fails. */
// deno-lint-ignore no-explicit-any
export async function loadJobFacts(client: any, jobs: CloseoutJobRow[]): Promise<Map<string, JobFacts> | null> {
  const ids = jobs.map((j) => j.id);
  if (!ids.length) return new Map();
  const [invoices, parties] = await Promise.all([
    readByJob<CloseoutInvoice & { job_id: string }>(client, "xero_invoices", INVOICE_COLUMNS, ids, (q) => q.eq("invoice_type", "ACCREC")),
    readByJob<PartyRow & { job_id: string }>(client, "job_contacts", PARTY_COLUMNS, ids),
  ]);
  if (!invoices || !parties) return null;
  const out = new Map<string, JobFacts>();
  for (const job of jobs) {
    out.set(job.id, { job, invoices: invoices.get(job.id) ?? [], parties: parties.get(job.id) ?? [] });
  }
  return out;
}

// deno-lint-ignore no-explicit-any
async function loadQuote(client: any, job: CloseoutJobRow, now: Date): Promise<CloseoutQuote> {
  try {
    const [quotes, variations] = await Promise.all([
      readJobQuotes(client, { id: job.id, client_email: job.client_email }),
      readJobVariations(client, job.id, now),
    ]);
    return quoteForCloseout(quotes.quotes, variations.variations);
  } catch {
    return { quote_total_inc: null, variations_inc: null, unknown_reason: "quote_read_threw" };
  }
}

/**
 * The strict check for one job. The quote (several reads) is read only when rules 1 and 2
 * already hold, since it can only turn "paid" into "paid less than quoted".
 */
export async function evaluateFacts(deps: Pick<JobCloseoutDeps, "client" | "now">, facts: JobFacts): Promise<PaidVerdict> {
  const base = { job: facts.job, invoices: facts.invoices, parties: facts.parties };
  const first = evaluateJobPaid({ ...base, quote: null });
  if (first.outcome === "not_paid") return first;
  return evaluateJobPaid({ ...base, quote: await loadQuote(deps.client, facts.job, deps.now()) });
}

// deno-lint-ignore no-explicit-any
async function loadJob(client: any, jobId: string): Promise<CloseoutJobRow | null> {
  const { data, error } = await client.from("jobs").select(JOB_COLUMNS).eq("id", jobId).maybeSingle();
  if (error) throw new JobCloseoutError(`job read failed: ${error.message}`, 503, "job_unreadable");
  return data ?? null;
}

// deno-lint-ignore no-explicit-any
async function loadJobsByStatus(client: any, statuses: string[], limit: number): Promise<CloseoutJobRow[] | null> {
  const { data, error } = await client.from("jobs").select(JOB_COLUMNS)
    .in("type", ["fencing", "patio"])
    .in("status", statuses)
    .order("updated_at", { ascending: true })
    .limit(limit);
  if (error) return null;
  return data ?? [];
}

/** When each job last entered get_review (its newest status_changed row to get_review). */
// deno-lint-ignore no-explicit-any
export async function loadGetReviewEntries(client: any, jobIds: string[]): Promise<Map<string, string> | null> {
  const out = new Map<string, string>();
  for (const part of chunks(jobIds)) {
    const { data, error } = await client.from("job_events")
      .select("job_id, created_at")
      .in("job_id", part)
      .eq("event_type", "status_changed")
      .eq("detail_json->>new_status", CLOSEOUT_REVIEW_STATUS)
      .order("created_at", { ascending: false })
      .limit(5000);
    if (error) return null;
    for (const row of data ?? []) {
      if (!out.has(row.job_id)) out.set(row.job_id, row.created_at);
    }
  }
  return out;
}

// ── Records ──────────────────────────────────────────────────────────────────

/** Upserts the job's paid check; logs one job_events row when the short marker first appears. */
async function recordPaidCheck(deps: JobCloseoutDeps, jobId: string, verdict: PaidVerdict, by: string): Promise<void> {
  const { client } = deps;
  const { data: prior } = await client.from("job_closeout_state")
    .select("paid_less_than_quoted").eq("job_id", jobId).maybeSingle();
  const short = verdict.outcome === "paid_less_than_quoted";
  const { error } = await client.from("job_closeout_state").upsert({
    job_id: jobId,
    outcome: verdict.outcome,
    paid_less_than_quoted: short,
    paid_total_inc: verdict.paid_total_inc,
    expected_inc: verdict.expected_inc,
    shortfall_inc: verdict.shortfall_inc,
    reasons: verdict.reasons,
    checked_at: deps.now().toISOString(),
    checked_by: by,
  }, { onConflict: "job_id" });
  if (error) console.error("[job_closeout] paid check write failed:", error.message);
  if (short && prior?.paid_less_than_quoted !== true) {
    await client.from("job_events").insert({
      job_id: jobId,
      event_type: "closeout_paid_less_than_quoted",
      detail_json: {
        source: by,
        paid_total_inc: verdict.paid_total_inc,
        expected_inc: verdict.expected_inc,
        shortfall_inc: verdict.shortfall_inc,
      },
    });
  }
}

// ── Paid -> Get Review ───────────────────────────────────────────────────────

export interface SettleResult {
  job_id: string;
  job_number: string | null;
  action:
    | "moved"
    | "move_skipped"
    | "held"
    | "not_closeout_type"
    | "not_in_from_status"
    | "paid_less_than_quoted"
    | "not_paid"
    | "facts_unreadable";
  detail?: unknown;
}

async function settleJob(deps: JobCloseoutDeps, facts: JobFacts, source: string): Promise<SettleResult> {
  const { job } = facts;
  const base = { job_id: job.id, job_number: job.job_number };
  if (!isCloseoutJobType(job.type)) return { ...base, action: "not_closeout_type" };
  const hold = closeoutHold(job);
  if (hold) return { ...base, action: "held", detail: hold };
  if (!isCloseoutFromStatus(job.status)) return { ...base, action: "not_in_from_status", detail: job.status };
  const verdict = await evaluateFacts(deps, facts);
  await recordPaidCheck(deps, job.id, verdict, source);
  if (verdict.outcome === "not_paid") return { ...base, action: "not_paid", detail: verdict.reasons };
  if (verdict.outcome === "paid_less_than_quoted") {
    return { ...base, action: "paid_less_than_quoted", detail: { paid: verdict.paid_total_inc, expected: verdict.expected_inc } };
  }
  const moved = await deps.moveJobStatus({
    jobId: job.id,
    status: CLOSEOUT_REVIEW_STATUS,
    source,
    expected_statuses: [...CLOSEOUT_FROM_STATUSES],
  });
  return moved?.success === true
    ? { ...base, action: "moved" }
    : { ...base, action: "move_skipped", detail: moved?.skipped ?? moved?.error ?? null };
}

/** xero-sync: a linked sales invoice of this job just turned PAID. */
export async function closeoutOnPaid(deps: JobCloseoutDeps, body: Record<string, unknown>) {
  const jobId = text(body.job_id ?? body.jobId);
  if (!jobId) throw new JobCloseoutError("job_id required");
  const switches = await readCloseoutSwitches(deps);
  if (!switches.move_enabled) return { ok: true, action: "switch_off" };
  const job = await loadJob(deps.client, jobId);
  if (!job) throw new JobCloseoutError("job not found", 404, "job_not_found");
  const facts = await loadJobFacts(deps.client, [job]);
  if (!facts) return { ok: true, job_id: jobId, action: "facts_unreadable" };
  const result = await settleJob(deps, facts.get(jobId)!, text(body.source) || "xero_sync");
  return { ok: true, ...result };
}

/** xero-sync, after each run: invoiced and final_payment cards paid before they got there. */
export async function closeoutCatchUp(deps: JobCloseoutDeps, body: Record<string, unknown>) {
  const switches = await readCloseoutSwitches(deps);
  if (!switches.move_enabled) return { ok: true, ran: false, reason: "switch_off" };
  const jobs = await loadJobsByStatus(deps.client, ["invoiced", "final_payment"], CLOSEOUT_BATCH_LIMIT);
  if (!jobs) return { ok: false, ran: false, reason: "jobs_unreadable" };
  const facts = await loadJobFacts(deps.client, jobs);
  if (!facts) return { ok: false, ran: false, reason: "facts_unreadable" };
  const cutoff = new Date(deps.now().getTime() - CATCH_UP_PAID_WITHIN_DAYS * DAY_MS).toISOString().slice(0, 10);
  const results: SettleResult[] = [];
  for (const job of jobs) {
    const f = facts.get(job.id)!;
    // Cheap pre-check: only a job whose invoices are all paid can pass.
    if (evaluateJobPaid({ job, invoices: f.invoices, parties: f.parties, quote: null }).outcome === "not_paid") continue;
    const lastPaid = f.invoices.map((i) => text(i.fully_paid_on).slice(0, 10)).filter(Boolean).sort().pop() ?? "";
    if (!lastPaid || lastPaid < cutoff) {
      results.push({ job_id: job.id, job_number: job.job_number, action: "not_paid", detail: "stale_payment" });
      continue;
    }
    results.push(await settleJob(deps, f, text(body.source) || "job_closeout_catch_up"));
  }
  return { ok: true, ran: true, checked: jobs.length, results };
}

// ── The review sender ────────────────────────────────────────────────────────

export interface ReviewRecipient {
  label: string;
  party_id: string | null;
  ghl_contact_id: string | null;
  first_name: string | null;
  result?: string;
  message_id?: string | null;
  error?: string;
}

/** Every paying owner with their own contact (captain answer 3), one entry per GHL contact. */
export function reviewRecipients(job: CloseoutJobRow, parties: PartyRow[]): ReviewRecipient[] {
  const paying = payingParties(parties) as PartyRow[];
  const out: ReviewRecipient[] = [];
  if (!paying.length) {
    out.push({ label: "owner", party_id: null, ghl_contact_id: job.ghl_contact_id || null, first_name: job.client_name });
  } else {
    for (const p of paying) {
      const primary = p.is_primary === true;
      out.push({
        label: text(p.contact_label).toUpperCase() || (primary ? "owner" : p.id),
        party_id: p.id,
        ghl_contact_id: p.ghl_contact_id || (primary ? job.ghl_contact_id : null) || null,
        first_name: p.client_name || (primary ? job.client_name : null),
      });
    }
  }
  const seen = new Set<string>();
  return out.filter((r) => {
    if (!r.ghl_contact_id) return true;
    if (seen.has(r.ghl_contact_id)) return false;
    seen.add(r.ghl_contact_id);
    return true;
  });
}

/** True when this contact was sent a review text in the lookback, from any source; null when unreadable. */
async function askedRecently(deps: JobCloseoutDeps, contactId: string): Promise<boolean | null> {
  const since = new Date(deps.now().getTime() - REVIEW_LOOKBACK_DAYS * DAY_MS).toISOString();
  const patterns = REVIEW_TEXT_PATTERNS.map((p) => `body_preview.ilike."*${p}*"`).join(",");
  const [events, claims] = await Promise.all([
    deps.client.from("business_events").select("id")
      .eq("contact_id", contactId)
      .eq("direction", "outbound")
      .gte("occurred_at", since)
      .or(patterns)
      .limit(1),
    deps.client.from("job_review_claims").select("job_id")
      .contains("recipients", [{ ghl_contact_id: contactId, result: "sent" }])
      .gte("claimed_at", since)
      .limit(1),
  ]);
  if (events.error || claims.error) return null;
  return (events.data?.length ?? 0) > 0 || (claims.data?.length ?? 0) > 0;
}

export interface ReviewRequestOptions {
  job_id: string;
  trigger: string;
  /** A person asked (send_review_request): the sender switch still applies; the status,
   *  hold, paid and send-window checks do not. */
  manual?: boolean;
}

/**
 * The one review sender, automatic and manual alike, so neither ships on before its switch.
 * Order: switch -> job -> (automatic only) type, get_review, hold,
 * paid rule, send window -> recipients -> 90-day look-back -> claim -> send. Nothing is
 * claimed until every read has answered, so a failed read is retried by the next sweep;
 * once claimed, the job is never texted again by this system.
 */
export async function requestJobReview(deps: JobCloseoutDeps, opts: ReviewRequestOptions) {
  const mode: ReviewSenderMode = (await readCloseoutSwitches(deps)).sender_mode;
  if (mode === "off") return { ok: true, action: "sender_off" };
  const job = await loadJob(deps.client, opts.job_id);
  if (!job) throw new JobCloseoutError("job not found", 404, "job_not_found");
  const facts = await loadJobFacts(deps.client, [job]);
  if (!facts) return { ok: true, action: "facts_unreadable" };
  const f = facts.get(job.id)!;

  let skipReason: string | null = null;
  if (!opts.manual) {
    if (!isCloseoutJobType(job.type)) return { ok: true, action: "not_closeout_type" };
    if (job.status !== CLOSEOUT_REVIEW_STATUS) return { ok: true, action: "not_in_get_review", status: job.status };
    const hold = closeoutHold(job);
    if (hold) return { ok: true, action: "held", hold };
    const verdict = await evaluateFacts(deps, f);
    if (verdict.outcome !== "paid") return { ok: true, action: "not_paid", outcome: verdict.outcome, reasons: verdict.reasons };
    const entries = await loadGetReviewEntries(deps.client, [job.id]);
    if (!entries) return { ok: true, action: "entry_unreadable" };
    const entered = entries.get(job.id) ?? null;
    const lastPaid = verdict.last_paid_on ? `${verdict.last_paid_on}T23:59:59Z` : null;
    const newest = [entered, lastPaid].filter(Boolean).map((t) => new Date(t!).getTime()).sort((a, b) => b - a)[0];
    if (!newest || deps.now().getTime() - newest > REVIEW_SEND_WINDOW_MS) {
      skipReason = "paid_and_in_get_review_too_long_ago";
    }
  }

  const recipients = reviewRecipients(job, f.parties);
  if (!skipReason) {
    for (const r of recipients) {
      if (!r.ghl_contact_id) {
        r.result = "skipped_no_contact";
        continue;
      }
      const recent = await askedRecently(deps, r.ghl_contact_id);
      if (recent === null) return { ok: true, action: "lookback_unreadable" };
      r.result = recent ? "skipped_asked_recently" : "to_send";
    }
  } else {
    for (const r of recipients) r.result = "skipped_window";
  }

  if (mode === "dry_run") {
    const { data: prior } = await deps.client.from("job_events").select("id")
      .eq("job_id", job.id).eq("event_type", "review_request_dry_run").limit(1);
    if (!prior?.length) {
      await deps.client.from("job_events").insert({
        job_id: job.id,
        event_type: "review_request_dry_run",
        detail_json: {
          trigger: opts.trigger,
          skip_reason: skipReason,
          recipients: recipients.map((r) => ({
            label: r.label,
            ghl_contact_id: r.ghl_contact_id,
            would: r.result === "to_send" ? "send" : r.result,
          })),
          message: reviewRequestMessage(recipients[0]?.first_name ?? null, job.type),
        },
      });
    }
    return { ok: true, action: "dry_run", skip_reason: skipReason, recipients: recipients.map(({ label, result }) => ({ label, result })) };
  }

  // Live: the claim first. A second claim for the same job is refused by the primary key.
  const { error: claimError } = await deps.client.from("job_review_claims").insert({
    job_id: job.id,
    status: "claimed",
    trigger: opts.trigger,
    recipients: recipients.map(({ label, party_id, ghl_contact_id, result }) => ({ label, party_id, ghl_contact_id, result })),
  });
  if (claimError) {
    if (claimError.code === "23505") return { ok: true, action: "already_claimed" };
    return { ok: false, action: "claim_failed", error: claimError.message };
  }

  for (const r of recipients) {
    if (r.result !== "to_send") continue;
    try {
      const sent = await deps.sendSms({
        contactId: r.ghl_contact_id!,
        message: reviewRequestMessage(r.first_name, job.type),
        jobId: job.id,
      });
      if (sent.ok) {
        r.result = "sent";
        r.message_id = sent.message_id;
      } else {
        r.result = sent.refused ? "refused" : "unconfirmed";
        r.error = sent.error.slice(0, 300);
      }
    } catch (e) {
      r.result = "unconfirmed";
      r.error = (e as Error).message.slice(0, 300);
    }
  }
  const results = recipients.map((r) => r.result);
  const status = results.includes("sent")
    ? "sent"
    : results.includes("unconfirmed")
    ? "unconfirmed"
    : results.includes("refused")
    ? "refused"
    : "skipped";
  const reason = skipReason ??
    (status === "skipped" ? (results.includes("skipped_asked_recently") ? "asked_recently" : "no_contact") : null);
  const stored = recipients.map(({ label, party_id, ghl_contact_id, result, message_id, error }) => ({
    label, party_id, ghl_contact_id, result, message_id: message_id ?? null, error: error ?? null,
  }));
  const { error: finishError } = await deps.client.from("job_review_claims").update({
    status,
    reason,
    recipients: stored,
    finished_at: deps.now().toISOString(),
  }).eq("job_id", job.id).eq("status", "claimed");
  if (finishError) console.error("[job_closeout] review claim finish failed:", finishError.message);
  await deps.client.from("job_events").insert({
    job_id: job.id,
    event_type: status === "sent" ? "review_request_sent" : "review_request_not_sent",
    detail_json: {
      trigger: opts.trigger,
      status,
      reason,
      review_url: GOOGLE_REVIEW_URL,
      recipients: stored.map(({ label, ghl_contact_id, result }) => ({ label, ghl_contact_id, result })),
    },
  });
  return { ok: true, action: status, reason, recipients: stored.map(({ label, result }) => ({ label, result })) };
}

// ── The 24-hour archive sweep ────────────────────────────────────────────────

export async function closeoutSweep(deps: JobCloseoutDeps, body: Record<string, unknown>) {
  const dryRun = body.dry_run !== false;
  if (!dryRun && !(await deps.laneEnabled("closeout"))) {
    return { ok: true, ran: false, reason: "lane_off" };
  }
  const switches = await readCloseoutSwitches(deps);
  const jobs = await loadJobsByStatus(deps.client, [CLOSEOUT_REVIEW_STATUS], CLOSEOUT_BATCH_LIMIT);
  if (!jobs) return { ok: false, ran: false, reason: "jobs_unreadable" };
  const [facts, entries] = await Promise.all([
    loadJobFacts(deps.client, jobs),
    loadGetReviewEntries(deps.client, jobs.map((j) => j.id)),
  ]);
  if (!facts || !entries) return { ok: false, ran: false, reason: "facts_unreadable" };
  const now = deps.now().getTime();
  const results: { job_id: string; job_number: string | null; action: string; detail?: unknown }[] = [];
  for (const job of jobs) {
    const base = { job_id: job.id, job_number: job.job_number };
    const hold = closeoutHold(job);
    if (hold) {
      results.push({ ...base, action: "held", detail: hold });
      continue;
    }
    const entered = entries.get(job.id);
    if (!entered) {
      results.push({ ...base, action: "entry_unknown" });
      continue;
    }
    const verdict = await evaluateFacts(deps, facts.get(job.id)!);
    if (!dryRun) await recordPaidCheck(deps, job.id, verdict, "job_closeout_sweep");
    if (verdict.outcome !== "paid") {
      results.push({ ...base, action: verdict.outcome, detail: verdict.reasons });
      continue;
    }
    // The review: the sweep is the sender's backstop for a card whose move did not send.
    let reviewDone = switches.sender_mode !== "live";
    let reviewWouldSend = false;
    if (!reviewDone) {
      let claim = await readClaim(deps, job.id);
      if (!claim && dryRun) {
        reviewWouldSend = true;
      } else if (!claim) {
        await requestJobReview(deps, { job_id: job.id, trigger: "job_closeout_sweep" });
        claim = await readClaim(deps, job.id);
      }
      reviewDone = reviewWouldSend || (claim !== null && claim.status !== "claimed");
    }
    if (!reviewDone) {
      results.push({ ...base, action: "waiting_for_review" });
      continue;
    }
    if (now - new Date(entered).getTime() < CLOSEOUT_ARCHIVE_AFTER_MS) {
      results.push({ ...base, action: "waiting_24h", detail: entered });
      continue;
    }
    if (dryRun) {
      results.push({ ...base, action: reviewWouldSend ? "would_send_review_then_archive" : "would_archive" });
      continue;
    }
    const moved = await deps.moveJobStatus({
      jobId: job.id,
      status: CLOSEOUT_ARCHIVE_STATUS,
      source: "job_closeout_sweep",
      expected_statuses: [CLOSEOUT_REVIEW_STATUS],
    });
    results.push({ ...base, action: moved?.success === true ? "archived" : "archive_skipped", detail: moved?.skipped ?? null });
  }
  return { ok: true, ran: true, dry_run: dryRun, sender_mode: switches.sender_mode, checked: jobs.length, results };
}

async function readClaim(deps: JobCloseoutDeps, jobId: string): Promise<{ status: string } | null> {
  const { data } = await deps.client.from("job_review_claims").select("status").eq("job_id", jobId).maybeSingle();
  return data ?? null;
}

// ── The existing Complete backlog (dry run only) ─────────────────────────────

/**
 * Fully paid fencing and patio jobs sitting in complete that a later, separate step may
 * archive (captain answer 5: archive only, never a review text). Writes nothing.
 */
export async function closeoutBacklogPreview(deps: JobCloseoutDeps) {
  const all: CloseoutJobRow[] = [];
  for (let page = 0; page < 10; page++) {
    const { data, error } = await deps.client.from("jobs").select(JOB_COLUMNS)
      .in("type", ["fencing", "patio"])
      .eq("status", "complete")
      .order("id", { ascending: true })
      .range(page * 500, page * 500 + 499);
    if (error) throw new JobCloseoutError(`jobs read failed: ${error.message}`, 503, "jobs_unreadable");
    all.push(...(data ?? []));
    if ((data ?? []).length < 500) break;
  }
  const facts = await loadJobFacts(deps.client, all);
  if (!facts) throw new JobCloseoutError("invoice or party read failed", 503, "facts_unreadable");
  const wouldArchive: unknown[] = [];
  const excluded: Record<string, string[]> = {};
  const exclude = (why: string, job: CloseoutJobRow) => {
    (excluded[why] ??= []).push(job.job_number ?? job.id);
  };
  for (const job of all) {
    const hold = closeoutHold(job);
    if (hold) {
      exclude(`held_${hold}`, job);
      continue;
    }
    const verdict = await evaluateFacts(deps, facts.get(job.id)!);
    if (verdict.outcome === "paid") {
      wouldArchive.push({
        job_id: job.id,
        job_number: job.job_number,
        type: job.type,
        last_paid_on: verdict.last_paid_on,
        paid_total_inc: verdict.paid_total_inc,
        expected_inc: verdict.expected_inc,
      });
    } else if (verdict.outcome === "paid_less_than_quoted") {
      exclude("paid_less_than_quoted", job);
    } else {
      exclude(verdict.reasons.includes("no_invoices") ? "no_invoices" : "not_paid", job);
    }
  }
  return {
    ok: true,
    dry_run: true,
    note: "Nothing was archived or texted. These jobs would move from complete to archived, with no review text.",
    checked: all.length,
    would_archive_count: wouldArchive.length,
    would_archive: wouldArchive,
    excluded_counts: Object.fromEntries(Object.entries(excluded).map(([k, v]) => [k, v.length])),
    excluded,
  };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export const JOB_CLOSEOUT_ACTIONS = [
  "job_closeout_paid",
  "job_closeout_catch_up",
  "job_closeout_sweep",
  "job_closeout_backlog_preview",
] as const;

export type JobCloseoutCaller = { kind: "server" } | { kind: "staff" } | { kind: "none" };

/** Server key only for anything that moves, texts or archives; the backlog list also admits staff. */
export async function runJobCloseoutAction(
  action: string,
  method: string,
  body: Record<string, unknown>,
  caller: JobCloseoutCaller,
  deps: JobCloseoutDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    if (action === "job_closeout_backlog_preview") {
      if (caller.kind === "none") return { status: 403, body: { ok: false, code: "operator_access_required" } };
      return { status: 200, body: await closeoutBacklogPreview(deps) };
    }
    if (caller.kind !== "server") return { status: 403, body: { ok: false, code: "server_key_required" } };
    if (method !== "POST") return { status: 405, body: { ok: false, code: "method_not_allowed" } };
    if (action === "job_closeout_paid") return { status: 200, body: await closeoutOnPaid(deps, body) };
    if (action === "job_closeout_catch_up") return { status: 200, body: await closeoutCatchUp(deps, body) };
    if (action === "job_closeout_sweep") return { status: 200, body: await closeoutSweep(deps, body) };
    return { status: 400, body: { ok: false, code: "unknown_action" } };
  } catch (e) {
    if (e instanceof JobCloseoutError) return { status: e.status, body: { ok: false, code: e.code, error: e.message } };
    throw e;
  }
}
