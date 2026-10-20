// Paid close-out for fencing and patio jobs (captain, 13 Oct 2026): paid -> Get Review,
// one review text, archived 24 hours later.
//
// The rule for "paid" is _shared/job_paid_closeout.ts. This module owns every read and
// write around it, and every step goes through it:
//   - closeoutOnPaid       xero-sync calls job_closeout_paid when a linked sales invoice of
//                          a fencing or patio job turns PAID: a paid job moves from
//                          complete, final_payment or invoiced to get_review (compare and
//                          set on the status); "paid less than quoted" stays put with a
//                          marker; a held job never moves; a job whose newest payment is
//                          older than PAID_WITHIN_DAYS never moves (stale_payment).
//   - closeoutCatchUp      xero-sync calls job_closeout_catch_up after each run: the same
//                          for invoiced and final_payment cards whose last invoice was paid
//                          before the card got there.
//   - requestJobReview     the one review sender: once per job (a job_review_claims row is
//                          inserted before any text), to every paying owner, skipping any
//                          contact asked for a review in the last 90 days from any source,
//                          re-checking get_review, the holds and the paid rule first. A job
//                          paid more than PAID_WITHIN_DAYS ago is not texted and not claimed.
//                          A job a person switched off (jobs.review_opt_out, set through
//                          setReviewOptOut) is never texted automatically: no claim, one
//                          job event, action opted_out. A manual Send review still sends.
//   - setReviewOptOut      the per-job review switch (captain, 20 Oct 2026): on by default,
//                          staff turn it off (or back on) from Complete onwards; refused
//                          once the job has a review claim.
//   - closeoutSweep        the job-closeout-sweep cron (closeout lane): archives a card that
//                          entered get_review at least 24 hours ago, is still paid, is not
//                          held and whose review was sent or deliberately skipped, could
//                          not go (no linked contact, paid too long ago, review switched
//                          off for the job, or every send refused by a guard: no claim is kept, so a later Send review
//                          still works), or the sender is not live. A claim stuck
//                          'claimed' past STUCK_CLAIM_AFTER_MS is recorded unconfirmed
//                          (never re-sent) and counts as finished.
//                          Compare and set on get_review.
//   - closeoutBacklogPreview  the dry-run list of fully paid fencing and patio jobs sitting
//                          in complete that a later, separate step may archive. Writes
//                          nothing and never texts.
//
// Switches, all off at deploy (migration 20261013150000_job_closeout_review_archive.sql):
// job_closeout_settings.get_review_move_enabled, job_closeout_settings.review_sender_mode
// (off | dry_run | live; the database switch alone decides, Captain 20 Oct 2026) and the
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
/** A card moves to get_review, and the automatic sender texts, only while the job's newest
 *  payment is this recent; older paid jobs are the backlog. */
export const PAID_WITHIN_DAYS = 30;
/** A review claim still 'claimed' this long after it was taken never finished; the sweep
 *  records it as unconfirmed (never re-sent) so the card can archive. */
export const STUCK_CLAIM_AFTER_MS = 60 * 60 * 1000;
/** The longest one review text may wait on ghl-proxy before it counts as unconfirmed. */
export const REVIEW_SMS_TIMEOUT_MS = 15_000;
/** Jobs per page when a sweep, catch-up or backlog list reads every candidate card. */
const JOB_PAGE_SIZE = 500;
const JOB_PAGES_MAX = 10;
/** Ids per PostgREST .in() filter. */
const ID_CHUNK = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

/** True when the newest payment (a YYYY-MM-DD day, read as its end) is within PAID_WITHIN_DAYS. */
function paidRecently(lastPaidOn: string | null, now: Date): boolean {
  if (!lastPaidOn) return false;
  return now.getTime() - new Date(`${lastPaidOn}T23:59:59Z`).getTime() <=
    PAID_WITHIN_DAYS * DAY_MS;
}

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

/** The live sendSms: one POST to ghl-proxy send_sms, abandoned after REVIEW_SMS_TIMEOUT_MS. */
export function ghlProxyReviewSender(opts: {
  supabaseUrl: string;
  serviceKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): JobCloseoutDeps["sendSms"] {
  const doFetch = opts.fetch ?? fetch;
  return async (args) => {
    let resp: Response;
    // deno-lint-ignore no-explicit-any
    let result: any;
    try {
      resp = await doFetch(
        `${opts.supabaseUrl}/functions/v1/ghl-proxy?action=send_sms`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${opts.serviceKey}`,
          },
          body: JSON.stringify({
            contactId: args.contactId,
            message: args.message,
            jobId: args.jobId,
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? REVIEW_SMS_TIMEOUT_MS),
        },
      );
      result = await resp.json().catch(() => ({}));
    } catch (e) {
      // A timeout or a lost connection: the text may or may not have reached GHL.
      return {
        ok: false,
        refused: false,
        error: (e as Error)?.name === "TimeoutError"
          ? "timeout"
          : String((e as Error)?.message ?? e),
      };
    }
    if (resp.ok && result?.success === true) {
      return { ok: true, message_id: (result.messageId as string) || null };
    }
    // A 4xx is a guard refusal before GHL (contact not on the job, duplicate, bad sender):
    // nothing was sent. Anything else may or may not have reached GHL.
    return {
      ok: false,
      refused: resp.status >= 400 && resp.status < 500,
      error: String(result?.error || `HTTP ${resp.status}`),
    };
  };
}

export class JobCloseoutError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "bad_request",
  ) {
    super(message);
  }
}

const text = (v: unknown): string => String(v ?? "").trim();

// ── Switches ─────────────────────────────────────────────────────────────────

export function effectiveSenderMode(configured: unknown): ReviewSenderMode {
  const mode = text(configured);
  if (mode === "live") return "live";
  if (mode === "dry_run") return "dry_run";
  return "off";
}

/** Fails closed: an unreadable row is every switch off. */
export async function readCloseoutSwitches(
  deps: Pick<JobCloseoutDeps, "client">,
): Promise<CloseoutSwitches> {
  try {
    const { data, error } = await deps.client.from("job_closeout_settings")
      .select("get_review_move_enabled, review_sender_mode")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) {
      return {
        move_enabled: false,
        sender_mode: "off",
        sender_configured_mode: "off",
        read_ok: false,
      };
    }
    const configured = (["off", "dry_run", "live"] as const).includes(
        data.review_sender_mode,
      )
      ? data.review_sender_mode as ReviewSenderMode
      : "off";
    return {
      move_enabled: data.get_review_move_enabled === true,
      sender_mode: effectiveSenderMode(configured),
      sender_configured_mode: configured,
      read_ok: true,
    };
  } catch {
    return {
      move_enabled: false,
      sender_mode: "off",
      sender_configured_mode: "off",
      read_ok: false,
    };
  }
}

// ── The review text ──────────────────────────────────────────────────────────

/**
 * The review text. A fencing or patio job that passes the paid rule gets the owner's
 * wording (20 Oct 2026): "Hi {first name}, Thank you for trusting us with your recent job!
 * Payment is well received. We'd love to hear your feedback. ... Shaun, SecureWorks Fencing"
 * (or "SecureWorks Patios" for a patio job). Every other request (another job type, or a
 * job not paid) makes no payment claim and signs "SecureWorks". Both carry the one review
 * link.
 */
export function reviewRequestMessage(
  clientName: string | null | undefined,
  jobType: string | null | undefined,
  paid: boolean,
): string {
  const first = text(clientName).split(/\s+/)[0] || "there";
  if (!paid || !isCloseoutJobType(jobType)) {
    const ask =
      `If you were satisfied with our work and the overall experience, we'd greatly appreciate it if you could take a moment to share your feedback. ` +
      `Your review helps us continue to provide quality service to our customers. You can leave a review here: ${GOOGLE_REVIEW_URL}\n\n` +
      `Thank you again for your business!`;
    return `Hi ${first},\n\nThank you for choosing SecureWorks for your recent job!\n\n${ask}\n\nSecureWorks`;
  }
  const signOff = text(jobType).toLowerCase() === "patio"
    ? "SecureWorks Patios"
    : "SecureWorks Fencing";
  return `Hi ${first},\n\nThank you for trusting us with your recent job!\nPayment is well received.\n\n` +
    `We'd love to hear your feedback. If you have a moment, could you leave us a quick review here: ${GOOGLE_REVIEW_URL}\n\n` +
    `Thank you again for your business!\n\nShaun\n${signOff}`;
}

// ── Quote side of the paid rule ──────────────────────────────────────────────

/**
 * The sent quote (job_quote_values through readJobQuotes: the whole-job total when the
 * quote is split by party, else the accepted or newest current document's value) plus
 * agreed variations (customer accepted or invoiced; one approved internally but never
 * accepted is not owed), inc GST. Pure.
 */
export function quoteForCloseout(
  quotes: Pick<JobQuotes, "status" | "whole_quote_total" | "headline"> | null,
  variations:
    | Pick<VariationView, "agreed" | "amount" | "gst_included">[]
    | null,
): CloseoutQuote {
  let quoteTotal: number | null = null;
  let reason: string | null = null;
  if (!quotes) reason = "quote_unreadable";
  else if (quotes.status === "none_recorded") reason = "no_sent_quote";
  else if (quotes.whole_quote_total) {
    quoteTotal = quotes.whole_quote_total.value_inc_gst;
  } else if (quotes.headline?.value_inc_gst != null) {
    quoteTotal = quotes.headline.value_inc_gst;
  } else reason = "quote_value_not_recorded";
  let variationsInc: number | null = null;
  if (variations) {
    variationsInc = 0;
    for (const v of variations) {
      if (!v.agreed || v.amount == null) continue;
      variationsInc += v.gst_included === false ? v.amount * 1.1 : v.amount;
    }
    variationsInc = Math.round(variationsInc * 100) / 100;
  } else if (!reason) {
    reason = "variations_unreadable";
  }
  return {
    quote_total_inc: quoteTotal,
    variations_inc: variationsInc,
    unknown_reason: reason,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface CloseoutJobRow extends CloseoutJob {
  client_name: string | null;
  client_email: string | null;
  ghl_contact_id: string | null;
  /** A person switched the review text off for this job (setReviewOptOut). */
  review_opt_out?: boolean | null;
  review_opt_out_at?: string | null;
  review_opt_out_by?: string | null;
}

interface PartyRow extends CloseoutParty {
  client_name: string | null;
  ghl_contact_id: string | null;
}

const JOB_COLUMNS =
  "id, job_number, type, status, is_callback, deposit_invoice_id, client_name, client_email, ghl_contact_id, review_opt_out, review_opt_out_at, review_opt_out_by";
const INVOICE_COLUMNS =
  "job_id, xero_invoice_id, invoice_number, invoice_type, status, reference, total, amount_paid, job_contact_id, xero_contact_id, fully_paid_on, first_description:line_items->0->>Description";
const PARTY_COLUMNS =
  "id, job_id, contact_label, is_primary, share_percentage, removed_at, status, xero_contact_id, client_name, ghl_contact_id";

function chunks<T>(items: T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function readByJob<T>(
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

export interface JobFacts {
  job: CloseoutJobRow;
  invoices: CloseoutInvoice[];
  parties: PartyRow[];
}

/** Invoices and parties for many jobs at once; null when either read fails. */
export async function loadJobFacts(
  // deno-lint-ignore no-explicit-any
  client: any,
  jobs: CloseoutJobRow[],
): Promise<Map<string, JobFacts> | null> {
  const ids = jobs.map((j) => j.id);
  if (!ids.length) return new Map();
  const [invoices, parties] = await Promise.all([
    readByJob<CloseoutInvoice & { job_id: string }>(
      client,
      "xero_invoices",
      INVOICE_COLUMNS,
      ids,
      (q) => q.eq("invoice_type", "ACCREC"),
    ),
    readByJob<PartyRow & { job_id: string }>(
      client,
      "job_contacts",
      PARTY_COLUMNS,
      ids,
    ),
  ]);
  if (!invoices || !parties) return null;
  const out = new Map<string, JobFacts>();
  for (const job of jobs) {
    out.set(job.id, {
      job,
      invoices: invoices.get(job.id) ?? [],
      parties: parties.get(job.id) ?? [],
    });
  }
  return out;
}

async function loadQuote(
  // deno-lint-ignore no-explicit-any
  client: any,
  job: CloseoutJobRow,
  now: Date,
): Promise<CloseoutQuote> {
  try {
    const [quotes, variations] = await Promise.all([
      readJobQuotes(client, { id: job.id, client_email: job.client_email }),
      readJobVariations(client, job.id, now),
    ]);
    return quoteForCloseout(quotes.quotes, variations.variations);
  } catch {
    return {
      quote_total_inc: null,
      variations_inc: null,
      unknown_reason: "quote_read_threw",
    };
  }
}

/**
 * The strict check for one job. The quote (several reads) is read only when rules 1 and 2
 * already hold, since it can only turn "paid" into "paid less than quoted".
 */
export async function evaluateFacts(
  deps: Pick<JobCloseoutDeps, "client" | "now">,
  facts: JobFacts,
): Promise<PaidVerdict> {
  const base = {
    job: facts.job,
    invoices: facts.invoices,
    parties: facts.parties,
  };
  const first = evaluateJobPaid({ ...base, quote: null });
  if (first.outcome === "not_paid") return first;
  return evaluateJobPaid({
    ...base,
    quote: await loadQuote(deps.client, facts.job, deps.now()),
  });
}

async function loadJob(
  // deno-lint-ignore no-explicit-any
  client: any,
  jobId: string,
): Promise<CloseoutJobRow | null> {
  const { data, error } = await client.from("jobs").select(JOB_COLUMNS).eq(
    "id",
    jobId,
  ).maybeSingle();
  if (error) {
    throw new JobCloseoutError(
      `job read failed: ${error.message}`,
      503,
      "job_unreadable",
    );
  }
  return data ?? null;
}

/** Every fencing and patio card in these statuses, paged by id; null when a page fails. */
async function loadJobsByStatus(
  // deno-lint-ignore no-explicit-any
  client: any,
  statuses: string[],
): Promise<CloseoutJobRow[] | null> {
  const all: CloseoutJobRow[] = [];
  for (let page = 0; page < JOB_PAGES_MAX; page++) {
    const { data, error } = await client.from("jobs").select(JOB_COLUMNS)
      .in("type", ["fencing", "patio"])
      .in("status", statuses)
      .order("id", { ascending: true })
      .range(page * JOB_PAGE_SIZE, page * JOB_PAGE_SIZE + JOB_PAGE_SIZE - 1);
    if (error) return null;
    all.push(...(data ?? []));
    if ((data ?? []).length < JOB_PAGE_SIZE) break;
  }
  return all;
}

/** When each job last entered get_review (its newest status_changed row to get_review). */
export async function loadGetReviewEntries(
  // deno-lint-ignore no-explicit-any
  client: any,
  jobIds: string[],
): Promise<Map<string, string> | null> {
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

/** Upserts the job's paid check; logs one job_events row when the short marker first appears.
 *  An undecided check (quote unreadable) records nothing. */
async function recordPaidCheck(
  deps: JobCloseoutDeps,
  jobId: string,
  verdict: PaidVerdict,
  by: string,
): Promise<void> {
  if (verdict.outcome === "undecided") return;
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
  if (error) {
    console.error("[job_closeout] paid check write failed:", error.message);
  }
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
    | "stale_payment"
    | "not_paid"
    | "facts_unreadable";
  detail?: unknown;
}

async function settleJob(
  deps: JobCloseoutDeps,
  facts: JobFacts,
  source: string,
): Promise<SettleResult> {
  const { job } = facts;
  const base = { job_id: job.id, job_number: job.job_number };
  if (!isCloseoutJobType(job.type)) {
    return { ...base, action: "not_closeout_type" };
  }
  const hold = closeoutHold(job);
  if (hold) return { ...base, action: "held", detail: hold };
  if (!isCloseoutFromStatus(job.status)) {
    return { ...base, action: "not_in_from_status", detail: job.status };
  }
  const verdict = await evaluateFacts(deps, facts);
  await recordPaidCheck(deps, job.id, verdict, source);
  if (verdict.outcome === "undecided") {
    return {
      ...base,
      action: "facts_unreadable",
      detail: verdict.quote_unknown_reason,
    };
  }
  if (verdict.outcome === "not_paid") {
    return { ...base, action: "not_paid", detail: verdict.reasons };
  }
  if (verdict.outcome === "paid_less_than_quoted") {
    return {
      ...base,
      action: "paid_less_than_quoted",
      detail: { paid: verdict.paid_total_inc, expected: verdict.expected_inc },
    };
  }
  // Paid long ago is the backlog, whatever the card's status: the existing Complete backlog
  // is archived separately and never texted (captain answer 5).
  if (!paidRecently(verdict.last_paid_on, deps.now())) {
    return {
      ...base,
      action: "stale_payment",
      detail: { last_paid_on: verdict.last_paid_on },
    };
  }
  const moved = await deps.moveJobStatus({
    jobId: job.id,
    status: CLOSEOUT_REVIEW_STATUS,
    source,
    expected_statuses: [...CLOSEOUT_FROM_STATUSES],
  });
  return moved?.success === true ? { ...base, action: "moved" } : {
    ...base,
    action: "move_skipped",
    detail: moved?.skipped ?? moved?.error ?? null,
  };
}

/** xero-sync: a linked sales invoice of this job just turned PAID. */
export async function closeoutOnPaid(
  deps: JobCloseoutDeps,
  body: Record<string, unknown>,
) {
  const jobId = text(body.job_id ?? body.jobId);
  if (!jobId) throw new JobCloseoutError("job_id required");
  const switches = await readCloseoutSwitches(deps);
  if (!switches.move_enabled) return { ok: true, action: "switch_off" };
  const job = await loadJob(deps.client, jobId);
  if (!job) throw new JobCloseoutError("job not found", 404, "job_not_found");
  const facts = await loadJobFacts(deps.client, [job]);
  if (!facts) return { ok: true, job_id: jobId, action: "facts_unreadable" };
  const result = await settleJob(
    deps,
    facts.get(jobId)!,
    text(body.source) || "xero_sync",
  );
  return { ok: true, ...result };
}

/** xero-sync, after each run: invoiced and final_payment cards paid before they got there. */
export async function closeoutCatchUp(
  deps: JobCloseoutDeps,
  body: Record<string, unknown>,
) {
  const switches = await readCloseoutSwitches(deps);
  if (!switches.move_enabled) {
    return { ok: true, ran: false, reason: "switch_off" };
  }
  const jobs = await loadJobsByStatus(deps.client, [
    "invoiced",
    "final_payment",
  ]);
  if (!jobs) return { ok: false, ran: false, reason: "jobs_unreadable" };
  const facts = await loadJobFacts(deps.client, jobs);
  if (!facts) return { ok: false, ran: false, reason: "facts_unreadable" };
  const results: SettleResult[] = [];
  for (const job of jobs) {
    const f = facts.get(job.id)!;
    // Cheap pre-check: only a job whose invoices are all paid can pass.
    const pre = evaluateJobPaid({
      job,
      invoices: f.invoices,
      parties: f.parties,
      quote: null,
    });
    if (pre.outcome === "not_paid") continue;
    if (!paidRecently(pre.last_paid_on, deps.now())) {
      results.push({
        job_id: job.id,
        job_number: job.job_number,
        action: "stale_payment",
        detail: { last_paid_on: pre.last_paid_on },
      });
      continue;
    }
    results.push(
      await settleJob(deps, f, text(body.source) || "job_closeout_catch_up"),
    );
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
export function reviewRecipients(
  job: CloseoutJobRow,
  parties: PartyRow[],
): ReviewRecipient[] {
  const paying = payingParties(parties) as PartyRow[];
  const out: ReviewRecipient[] = [];
  if (!paying.length) {
    out.push({
      label: "owner",
      party_id: null,
      ghl_contact_id: job.ghl_contact_id || null,
      first_name: job.client_name,
    });
  } else {
    for (const p of paying) {
      const primary = p.is_primary === true;
      out.push({
        label: text(p.contact_label).toUpperCase() ||
          (primary ? "owner" : p.id),
        party_id: p.id,
        ghl_contact_id: p.ghl_contact_id ||
          (primary ? job.ghl_contact_id : null) || null,
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
async function askedRecently(
  deps: JobCloseoutDeps,
  contactId: string,
): Promise<boolean | null> {
  const since = new Date(deps.now().getTime() - REVIEW_LOOKBACK_DAYS * DAY_MS)
    .toISOString();
  const patterns = REVIEW_TEXT_PATTERNS.map((p) =>
    `body_preview.ilike."*${p}*"`
  ).join(",");
  const [events, claims] = await Promise.all([
    deps.client.from("business_events").select("id")
      .eq("contact_id", contactId)
      .eq("direction", "outbound")
      .gte("occurred_at", since)
      .or(patterns)
      .limit(1),
    deps.client.from("job_review_claims").select("job_id")
      // A JSON string: postgrest-js sends an array as a Postgres array literal, which jsonb refuses.
      .contains(
        "recipients",
        JSON.stringify([{ ghl_contact_id: contactId, result: "sent" }]),
      )
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
   *  hold, review switch, paid and send-window checks do not, and the paid wording is used
   *  only for a fencing or patio job that passes the paid rule. */
  manual?: boolean;
}

/**
 * The one review sender, automatic and manual alike, so neither ships on before its switch.
 * Order: switch -> job -> (automatic only) type, get_review, hold, the job's review
 * switch, paid rule, send window -> recipients -> 90-day look-back -> claim -> (automatic
 * only) the job's review switch again -> send. Nothing is
 * claimed until every read has answered, so a failed read is retried by the next sweep.
 * Nothing is kept claimed when nothing could go out (no linked contact, paid too long ago,
 * or every send refused by a guard before GHL), so fixing the cause and asking again sends;
 * once a claim is kept, the job is never texted again by this system.
 */
export async function requestJobReview(
  deps: JobCloseoutDeps,
  opts: ReviewRequestOptions,
) {
  const mode: ReviewSenderMode = (await readCloseoutSwitches(deps)).sender_mode;
  if (mode === "off") return { ok: true, action: "sender_off" };
  const job = await loadJob(deps.client, opts.job_id);
  if (!job) throw new JobCloseoutError("job not found", 404, "job_not_found");
  const facts = await loadJobFacts(deps.client, [job]);
  if (!facts) return { ok: true, action: "facts_unreadable" };
  const f = facts.get(job.id)!;

  let skipReason: string | null = null;
  let paidWording: boolean;
  if (!opts.manual) {
    if (!isCloseoutJobType(job.type)) {
      return { ok: true, action: "not_closeout_type" };
    }
    if (job.status !== CLOSEOUT_REVIEW_STATUS) {
      return { ok: true, action: "not_in_get_review", status: job.status };
    }
    const hold = closeoutHold(job);
    if (hold) return { ok: true, action: "held", hold };
    if (job.review_opt_out === true) {
      await recordOptedOut(deps, job, f, opts.trigger, mode);
      return { ok: true, action: "opted_out", dry_run: mode === "dry_run" };
    }
    const verdict = await evaluateFacts(deps, f);
    if (verdict.outcome === "undecided") {
      return {
        ok: true,
        action: "facts_unreadable",
        reason: verdict.quote_unknown_reason,
      };
    }
    if (verdict.outcome !== "paid") {
      return {
        ok: true,
        action: "not_paid",
        outcome: verdict.outcome,
        reasons: verdict.reasons,
      };
    }
    if (!paidRecently(verdict.last_paid_on, deps.now())) {
      skipReason = "paid_too_long_ago";
    }
    paidWording = true;
  } else if (isCloseoutJobType(job.type)) {
    const verdict = await evaluateFacts(deps, f);
    if (verdict.outcome === "undecided") {
      return {
        ok: true,
        action: "facts_unreadable",
        reason: verdict.quote_unknown_reason,
      };
    }
    paidWording = verdict.outcome === "paid";
  } else {
    paidWording = false;
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
          message: reviewRequestMessage(
            recipients[0]?.first_name ?? null,
            job.type,
            paidWording,
          ),
        },
      });
    }
    return {
      ok: true,
      action: "dry_run",
      skip_reason: skipReason,
      recipients: recipients.map(({ label, result }) => ({ label, result })),
    };
  }

  if (skipReason) {
    return {
      ok: true,
      action: skipReason,
      recipients: recipients.map(({ label, result }) => ({ label, result })),
    };
  }
  if (
    !recipients.some((r) => r.result === "to_send") &&
    recipients.some((r) => r.result === "skipped_no_contact")
  ) {
    return {
      ok: true,
      action: "no_contact",
      recipients: recipients.map(({ label, result }) => ({ label, result })),
    };
  }

  // Live: the claim first. A second claim for the same job is refused by the primary key.
  const { error: claimError } = await deps.client.from("job_review_claims")
    .insert({
      job_id: job.id,
      status: "claimed",
      trigger: opts.trigger,
      recipients: recipients.map((
        { label, party_id, ghl_contact_id, result },
      ) => ({ label, party_id, ghl_contact_id, result })),
    });
  if (claimError) {
    if (claimError.code === "23505") {
      return { ok: true, action: "already_claimed" };
    }
    return { ok: false, action: "claim_failed", error: claimError.message };
  }
  // The switch is read again only now, with the claim held: setReviewOptOut writes the
  // switch before it looks for a claim, so a switch turned off while this run was reading
  // is seen here (nothing sent, claim released) or the switch sees this claim (409).
  if (!opts.manual) {
    const { data: fresh, error: freshError } = await deps.client.from("jobs")
      .select("review_opt_out, review_opt_out_at, review_opt_out_by")
      .eq("id", job.id).maybeSingle();
    if (freshError || fresh?.review_opt_out === true) {
      const { error: releaseError } = await deps.client.from(
        "job_review_claims",
      ).delete().eq("job_id", job.id).eq("status", "claimed");
      if (releaseError) {
        console.error(
          "[job_closeout] review claim release failed:",
          releaseError.message,
        );
      }
      if (freshError) return { ok: true, action: "opt_out_unreadable" };
      await recordOptedOut(deps, { ...job, ...fresh }, f, opts.trigger, mode);
      return { ok: true, action: "opted_out", dry_run: false };
    }
  }

  for (const r of recipients) {
    if (r.result !== "to_send") continue;
    try {
      const sent = await deps.sendSms({
        contactId: r.ghl_contact_id!,
        message: reviewRequestMessage(r.first_name, job.type, paidWording),
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
  const reason = status === "skipped" ? "asked_recently" : null;
  const stored = recipients.map((
    { label, party_id, ghl_contact_id, result, message_id, error },
  ) => ({
    label,
    party_id,
    ghl_contact_id,
    result,
    message_id: message_id ?? null,
    error: error ?? null,
  }));
  // Every send refused by a guard before GHL: nothing went out, so the claim is released
  // and a later automatic or manual attempt can send once the cause is fixed.
  const finish = status === "refused"
    ? deps.client.from("job_review_claims").delete()
    : deps.client.from("job_review_claims").update({
      status,
      reason,
      recipients: stored,
      finished_at: deps.now().toISOString(),
    });
  const { error: finishError } = await finish.eq("job_id", job.id).eq(
    "status",
    "claimed",
  );
  if (finishError) {
    console.error(
      "[job_closeout] review claim finish failed:",
      finishError.message,
    );
  }
  const { data: priorRefusal } = status === "refused"
    ? await deps.client.from("job_events").select("id")
      .eq("job_id", job.id)
      .eq("event_type", "review_request_not_sent")
      .eq("detail_json->>status", "refused")
      .limit(1)
    : { data: null };
  if (!priorRefusal?.length) {
    await deps.client.from("job_events").insert({
      job_id: job.id,
      event_type: status === "sent"
        ? "review_request_sent"
        : "review_request_not_sent",
      detail_json: {
        trigger: opts.trigger,
        status,
        reason,
        review_url: GOOGLE_REVIEW_URL,
        recipients: stored.map(({ label, ghl_contact_id, result }) => ({
          label,
          ghl_contact_id,
          result,
        })),
      },
    });
  }
  return {
    ok: true,
    action: status,
    reason,
    recipients: stored.map(({ label, result }) => ({ label, result })),
  };
}

/**
 * A job a person switched the review off for, asked automatically: nothing is sent or
 * claimed. A dry run logs it on its one review_request_dry_run row; a live run logs one
 * review_request_not_sent row (status opted_out), not again on every sweep.
 */
async function recordOptedOut(
  deps: JobCloseoutDeps,
  job: CloseoutJobRow,
  facts: JobFacts,
  trigger: string,
  mode: ReviewSenderMode,
): Promise<void> {
  const optedOut = {
    by: job.review_opt_out_by ?? null,
    at: job.review_opt_out_at ?? null,
  };
  if (mode === "dry_run") {
    const { data: prior } = await deps.client.from("job_events").select("id")
      .eq("job_id", job.id).eq("event_type", "review_request_dry_run").limit(1);
    if (!prior?.length) {
      await deps.client.from("job_events").insert({
        job_id: job.id,
        event_type: "review_request_dry_run",
        detail_json: {
          trigger,
          skip_reason: "opted_out",
          opted_out: optedOut,
          recipients: reviewRecipients(job, facts.parties).map((r) => ({
            label: r.label,
            ghl_contact_id: r.ghl_contact_id,
            would: "skipped_opted_out",
          })),
        },
      });
    }
    return;
  }
  const { data: prior } = await deps.client.from("job_events").select("id")
    .eq("job_id", job.id)
    .eq("event_type", "review_request_not_sent")
    .eq("detail_json->>status", "opted_out")
    .limit(1);
  if (!prior?.length) {
    await deps.client.from("job_events").insert({
      job_id: job.id,
      event_type: "review_request_not_sent",
      detail_json: {
        trigger,
        status: "opted_out",
        reason: "opted_out",
        opted_out: optedOut,
      },
    });
  }
}

// ── The per-job review switch ────────────────────────────────────────────────

export interface ReviewOptOutResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * set_review_opt_out { job_id, opt_out }: turns the job's review text off (opt_out true)
 * or back on. Every change stamps who and when on the job and writes one job_events row
 * (review_opt_out_changed); asking for the value the job already has changes nothing.
 * Refused 409 review_already_sent once the job has a review claim (sent or in flight),
 * since the switch can no longer stop it; the claim is looked for again after the write,
 * so a sender that claimed in between is reported, never missed, and then (or when that
 * look fails) the switch is put back as it was and no event is written. Staff only (the
 * caller checks); `by` is the verified person, else the operator email the screen stamps.
 */
export async function setReviewOptOut(
  deps: Pick<JobCloseoutDeps, "client" | "now">,
  body: Record<string, unknown>,
  by: string | null,
): Promise<ReviewOptOutResult> {
  const jobId = text(body.job_id ?? body.jobId);
  if (!jobId) {
    return { status: 400, body: { success: false, error: "job_id required" } };
  }
  if (typeof body.opt_out !== "boolean") {
    return {
      status: 400,
      body: { success: false, error: "opt_out must be true or false" },
    };
  }
  const optOut = body.opt_out;
  const { client } = deps;
  const { data: job, error: jobError } = await client.from("jobs")
    .select("id, review_opt_out, review_opt_out_at, review_opt_out_by")
    .eq("id", jobId).maybeSingle();
  if (jobError) {
    return {
      status: 503,
      body: { success: false, error: "job_unreadable" },
    };
  }
  if (!job) {
    return { status: 404, body: { success: false, error: "job_not_found" } };
  }
  const { data: claim, error: claimError } = await client.from(
    "job_review_claims",
  ).select("status").eq("job_id", jobId).maybeSingle();
  if (claimError) {
    return {
      status: 503,
      body: { success: false, error: "review_claim_unreadable" },
    };
  }
  if (claim) return alreadySent(claim.status);
  const current = job.review_opt_out === true;
  if (current === optOut) {
    return {
      status: 200,
      body: {
        success: true,
        changed: false,
        review_opt_out: current,
        review_opt_out_at: job.review_opt_out_at ?? null,
        review_opt_out_by: job.review_opt_out_by ?? null,
      },
    };
  }
  const prior = {
    review_opt_out: current,
    review_opt_out_at: job.review_opt_out_at ?? null,
    review_opt_out_by: job.review_opt_out_by ?? null,
  };
  const at = deps.now().toISOString();
  const { error: writeError } = await client.from("jobs").update({
    review_opt_out: optOut,
    review_opt_out_at: at,
    review_opt_out_by: by,
  }).eq("id", jobId);
  if (writeError) {
    return {
      status: 500,
      body: { success: false, error: `write failed: ${writeError.message}` },
    };
  }
  // A sender that claimed after the first look and before this write may not have seen it.
  const { data: lateClaim, error: lateClaimError } = await client.from(
    "job_review_claims",
  ).select("status").eq("job_id", jobId).maybeSingle();
  if (lateClaimError || lateClaim) {
    const { error: restoreError } = await client.from("jobs").update(prior)
      .eq("id", jobId);
    if (restoreError) {
      console.error(
        "[job_closeout] review switch not put back:",
        restoreError.message,
      );
    }
    if (lateClaim) return alreadySent(lateClaim.status);
    return {
      status: 503,
      body: { success: false, error: "review_claim_unreadable" },
    };
  }
  const { error: eventError } = await client.from("job_events").insert({
    job_id: jobId,
    event_type: "review_opt_out_changed",
    detail_json: {
      review_opt_out: optOut,
      review: optOut ? "off" : "on",
      by,
      at,
    },
  });
  if (eventError) {
    console.error(
      "[job_closeout] review_opt_out_changed event not written:",
      eventError.message,
    );
  }
  return {
    status: 200,
    body: {
      success: true,
      changed: true,
      review_opt_out: optOut,
      review_opt_out_at: at,
      review_opt_out_by: by,
    },
  };
}

function alreadySent(status: string | null | undefined): ReviewOptOutResult {
  return {
    status: 409,
    body: {
      success: false,
      error: "review_already_sent",
      review_claim_status: status ?? null,
    },
  };
}

// ── The 24-hour archive sweep ────────────────────────────────────────────────

/** Sender answers that keep no claim but leave nothing to wait for: the card still archives. */
const UNCLAIMED_REVIEW_ACTIONS: readonly string[] = [
  "no_contact",
  "paid_too_long_ago",
  "opted_out",
  "refused",
];

export async function closeoutSweep(
  deps: JobCloseoutDeps,
  body: Record<string, unknown>,
) {
  const dryRun = body.dry_run !== false;
  if (!dryRun && !(await deps.laneEnabled("closeout"))) {
    return { ok: true, ran: false, reason: "lane_off" };
  }
  const switches = await readCloseoutSwitches(deps);
  if (!dryRun && !switches.read_ok) {
    return { ok: false, ran: false, reason: "switches_unreadable" };
  }
  const jobs = await loadJobsByStatus(deps.client, [CLOSEOUT_REVIEW_STATUS]);
  if (!jobs) return { ok: false, ran: false, reason: "jobs_unreadable" };
  const [facts, entries] = await Promise.all([
    loadJobFacts(deps.client, jobs),
    loadGetReviewEntries(deps.client, jobs.map((j) => j.id)),
  ]);
  if (!facts || !entries) {
    return { ok: false, ran: false, reason: "facts_unreadable" };
  }
  const now = deps.now().getTime();
  const results: {
    job_id: string;
    job_number: string | null;
    action: string;
    detail?: unknown;
  }[] = [];
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
    if (!dryRun) {
      await recordPaidCheck(deps, job.id, verdict, "job_closeout_sweep");
    }
    if (verdict.outcome !== "paid") {
      results.push({
        ...base,
        action: verdict.outcome,
        detail: verdict.reasons,
      });
      continue;
    }
    // The review: the sweep is the sender's backstop for a card whose move did not send.
    let reviewDone = switches.sender_mode !== "live";
    let reviewWouldSend = false;
    if (!reviewDone) {
      let claim = await readClaim(deps, job.id);
      let notClaimed = false;
      if (!claim && dryRun) {
        if (job.review_opt_out === true) notClaimed = true;
        else reviewWouldSend = true;
      } else if (!claim) {
        const review = await requestJobReview(deps, {
          job_id: job.id,
          trigger: "job_closeout_sweep",
        });
        notClaimed = UNCLAIMED_REVIEW_ACTIONS.includes(review.action);
        claim = await readClaim(deps, job.id);
      }
      if (claim?.status === "claimed" && claimStuck(claim, now)) {
        claim = dryRun
          ? { ...claim, status: "unconfirmed" }
          : await releaseStuckClaim(deps, job.id);
      }
      reviewDone = reviewWouldSend || notClaimed ||
        (claim !== null && claim.status !== "claimed");
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
      results.push({
        ...base,
        action: reviewWouldSend
          ? "would_send_review_then_archive"
          : "would_archive",
      });
      continue;
    }
    const moved = await deps.moveJobStatus({
      jobId: job.id,
      status: CLOSEOUT_ARCHIVE_STATUS,
      source: "job_closeout_sweep",
      expected_statuses: [CLOSEOUT_REVIEW_STATUS],
    });
    results.push({
      ...base,
      action: moved?.success === true ? "archived" : "archive_skipped",
      detail: moved?.skipped ?? null,
    });
  }
  return {
    ok: true,
    ran: true,
    dry_run: dryRun,
    sender_mode: switches.sender_mode,
    checked: jobs.length,
    results,
  };
}

interface ClaimRow {
  status: string;
  claimed_at?: string | null;
}

async function readClaim(
  deps: JobCloseoutDeps,
  jobId: string,
): Promise<ClaimRow | null> {
  const { data } = await deps.client.from("job_review_claims").select(
    "status, claimed_at",
  ).eq("job_id", jobId).maybeSingle();
  return data ?? null;
}

function claimStuck(claim: ClaimRow, now: number): boolean {
  const at = new Date(text(claim.claimed_at)).getTime();
  return Number.isFinite(at) && now - at > STUCK_CLAIM_AFTER_MS;
}

/** A claim that never finished: recorded as unconfirmed, never re-sent. */
async function releaseStuckClaim(
  deps: JobCloseoutDeps,
  jobId: string,
): Promise<ClaimRow | null> {
  const { error } = await deps.client.from("job_review_claims").update({
    status: "unconfirmed",
    reason: "stuck_claim",
    finished_at: deps.now().toISOString(),
  }).eq("job_id", jobId).eq("status", "claimed");
  if (error) {
    console.error("[job_closeout] stuck claim release failed:", error.message);
  }
  return await readClaim(deps, jobId);
}

// ── The existing Complete backlog (dry run only) ─────────────────────────────

/**
 * Fully paid fencing and patio jobs sitting in complete that a later, separate step may
 * archive (captain answer 5: archive only, never a review text). Writes nothing.
 */
export async function closeoutBacklogPreview(deps: JobCloseoutDeps) {
  const all = await loadJobsByStatus(deps.client, ["complete"]);
  if (!all) {
    throw new JobCloseoutError("jobs read failed", 503, "jobs_unreadable");
  }
  const facts = await loadJobFacts(deps.client, all);
  if (!facts) {
    throw new JobCloseoutError(
      "invoice or party read failed",
      503,
      "facts_unreadable",
    );
  }
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
    } else if (verdict.outcome === "undecided") {
      exclude("quote_unreadable", job);
    } else {
      exclude(
        verdict.reasons.includes("no_invoices") ? "no_invoices" : "not_paid",
        job,
      );
    }
  }
  return {
    ok: true,
    dry_run: true,
    note:
      "Nothing was archived or texted. These jobs would move from complete to archived, with no review text.",
    checked: all.length,
    would_archive_count: wouldArchive.length,
    would_archive: wouldArchive,
    excluded_counts: Object.fromEntries(
      Object.entries(excluded).map(([k, v]) => [k, v.length]),
    ),
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

export type JobCloseoutCaller = { kind: "server" } | { kind: "staff" } | {
  kind: "none";
};

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
      if (caller.kind === "none") {
        return {
          status: 403,
          body: { ok: false, code: "operator_access_required" },
        };
      }
      return { status: 200, body: await closeoutBacklogPreview(deps) };
    }
    if (caller.kind !== "server") {
      return { status: 403, body: { ok: false, code: "server_key_required" } };
    }
    if (method !== "POST") {
      return { status: 405, body: { ok: false, code: "method_not_allowed" } };
    }
    if (action === "job_closeout_paid") {
      return { status: 200, body: await closeoutOnPaid(deps, body) };
    }
    if (action === "job_closeout_catch_up") {
      return { status: 200, body: await closeoutCatchUp(deps, body) };
    }
    if (action === "job_closeout_sweep") {
      return { status: 200, body: await closeoutSweep(deps, body) };
    }
    return { status: 400, body: { ok: false, code: "unknown_action" } };
  } catch (e) {
    if (e instanceof JobCloseoutError) {
      return {
        status: e.status,
        body: { ok: false, code: e.code, error: e.message },
      };
    }
    throw e;
  }
}
