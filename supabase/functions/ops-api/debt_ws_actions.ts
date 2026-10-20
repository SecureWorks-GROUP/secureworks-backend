// Debt Workshop actions (secureworks-wiki coding/capabilities/debt-follow-up/debt-workshop-spec.md,
// sections 1, 4, 6, 7 and 8). index.ts only wires the actions to runDebtWsAction and injects
// the private helpers it owns (sendChaseSms, getJobConversation, getToken, xeroReadGet,
// updateJobStatus, the Outlook send, the invoice PDF, the GHL contact search, the staff SMS
// path to Jan's mobile, and the job document reads).
//
// Safety (spec section 1), in code:
//   - Nothing reaches a client unless sending is on: debt_ws_settings.sending_enabled is
//     true (default off). That database switch alone decides it (Shaun decided 14 Oct 2026).
//     The old env DEBT_WS_SENDING_ENABLED is retired and ignored.
//   - Only the owner (env DEBT_WS_OWNER_USER_IDS, else debt_ws_settings.owner_user_ids, never
//     a role) may send, approve statements, link contacts or move a card.
//   - Before every text: a live Xero re-check (AUTHORISED, amount due above zero and not
//     below the draft's amount) and the bank-feed check. Either failing refuses, with a
//     plain reason, and the refusal is logged. Statements and Jan's list run both checks
//     too, and a failed live read never falls back to our Xero copy (fail closed).
//   - The bank feed is one cached read (15 minutes, same Perth day) that reaches back to
//     the oldest open invoice, paged and capped well inside Xero's 60 calls a minute.
//   - A claim row (debt_ws_sends, unique per share, cycle and step) is written before the
//     text goes, so a step is never texted twice.
//   - Texts go only through the injected sendChaseSms path (771, the SES fence and the
//     contact/job match guard). Xero is read only. A card moves only through updateJobStatus.
//   - Automatic sending (stage 5) stays two-key: on top of sending being on, it also needs
//     env DEBT_WS_AUTO_SEND_ENABLED === "true" and debt_ws_settings.auto_send_steps[step]
//     === true. Off by default.
//   - A manual text (Shaun's own words from the job screen's reply box, step "manual") goes
//     through the same guarded send and every check above. It is logged as a manual text,
//     never as a step, so it never moves the day ladder. It may go while chasing is paused
//     (says paid, rectification, a promise to pay, day 21: Shaun decided 16 Oct 2026), so he
//     can reply; the planned steps stay paused. Its claim is keyed on a client_ref the
//     screen makes once per message, so a double tap never texts twice.

import {
  addDays,
  type BankTransaction,
  classifyInvoice,
  clientTextProblem,
  DEBT_WS_PLAYBOOK_VERSION,
  DEBT_WS_VERSION,
  firstNameOf,
  inScope,
  isIsoDate,
  isLadderStep,
  isReplyStep,
  isTextStep,
  type JanListItem,
  janListText,
  longDate,
  looksLikeCompanyName,
  mondayOf,
  money,
  nextMonday,
  perthDate,
  perthDateOf,
  type PossiblePayment,
  possiblePayments,
  statementHtml,
  type StatementLine,
  statementSubject,
  STEP_LABELS,
  stepDate,
  styleProblem,
  type WsInvoice,
} from "./debt_ws_rules.ts";
import {
  type Book,
  type BookEntry,
  canonicalCompanyKey,
  categoryTotals,
  companiesOf,
  type CompanyView,
  janItemsLive,
  loadBook,
  paidThisWeek,
  sortRows,
  suggestionView,
  templateDraftFor,
} from "./debt_ws_book.ts";
import {
  partiesOf,
  type PayerContact,
  sharesOf,
  splitConversation,
} from "./debt_ws_payer.ts";
import {
  DebtWsError,
  type DebtWsReportSettings,
  type DebtWsSettings,
  type DebtWsStore,
  type WsLogRow,
  type WsReportRow,
  type WsSuggestion,
} from "./debt_ws_store.ts";
import {
  type BankAccountBalance,
  buildDebtReport,
  type DebtReport,
  debtReportEmail,
  debtReportFileName,
  debtReportHtml,
  debtReportTotals,
  perthClock,
  placeOpenInvoices,
  totalOwedFrom,
} from "./debt_ws_report.ts";
import {
  xeroCheckUnread,
  xeroCheckView,
  type XeroCheckView,
} from "./debt_ws_xero_check.ts";

export { DebtWsError } from "./debt_ws_store.ts";

export const DEBT_WS_AUTO_SEND_SWITCH = "DEBT_WS_AUTO_SEND_ENABLED";
export const DEBT_WS_OWNERS_SETTING = "DEBT_WS_OWNER_USER_IDS";
export const DEBT_WS_STATEMENT_FROM = "admin@secureworkswa.com.au";
/** Statements are signed by Shaun on admin@ (send-outlook-email signature "shaun"). */
export const DEBT_WS_STATEMENT_SIGNATURE = "shaun";
/**
 * The step a manual text is sent and logged under (Shaun's own words, not a planned step).
 * Its claim row's step is "manual:<client_ref>", which is never a ladder step, so the
 * ladder never counts it as done.
 */
export const DEBT_WS_MANUAL_STEP = "manual";
/** Bank feed: one read, re-read at most every 15 minutes within a Perth day (spec section 6). */
export const DEBT_WS_BANK_CACHE_MS = 15 * 60_000;
/** Pages of 100 per bank-feed read at most: 10 Xero calls, well inside 60 a minute. */
export const DEBT_WS_BANK_MAX_PAGES = 10;
/** Bank-feed page calls allowed from one warm function in any 60 seconds. */
export const DEBT_WS_BANK_CALLS_PER_MINUTE = 30;
/** Pay links fetched live per request at most; the rest come from the cache or wait. */
export const DEBT_WS_PAY_LINK_FETCH_LIMIT = 20;
export const DEBT_WS_AGENT_QUEUE_LIMIT = 25;
export const DEBT_WS_AGENT_MESSAGES = 40;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GHL_ID = /^[A-Za-z0-9]{10,40}$/;

/** sendChaseSms refused in its own guards (SES fence, contact/job match) before any SMS. */
export class DebtWsSendRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DebtWsSendRefusedError";
  }
}

export interface DebtWsCaller {
  /** user: a signed-in staff JWT; server: a server secret (cron, the agent routine). */
  kind: "user" | "server" | "none";
  user_id?: string | null;
  email?: string | null;
  /** The signed-in user holds a staff role (admin, owner, ops_manager). */
  staff?: boolean;
}

export interface DebtWsDeps {
  store: DebtWsStore;
  env: (name: string) => string | undefined;
  now: () => Date;
  /** One live Xero read of one invoice: the raw Xero invoice. */
  readInvoice: (xeroInvoiceId: string) => Promise<Record<string, unknown>>;
  /** Live Xero reads of several invoices (raw Xero invoices), in as few calls as Xero allows. */
  readInvoices: (ids: string[]) => Promise<Record<string, unknown>[]>;
  /** Xero's online invoice URL for one invoice. */
  payLink: (xeroInvoiceId: string) => Promise<string>;
  /**
   * One page (100 rows, newest first) of Xero's unreconciled bank transactions dated on or
   * after dateFrom (all dates when null). has_more: a full page, so another may follow.
   */
  bankTransactions: (
    dateFrom: string | null,
    page: number,
  ) => Promise<{ transactions: BankTransaction[]; has_more: boolean }>;
  /** The existing ops-api sendChaseSms path (771, SES fence, contact/job guard). */
  sendSms: (
    body: Record<string, unknown>,
  ) => Promise<{ success?: boolean; message_id?: string | null }>;
  /** The staff SMS path to one raw mobile (Jan's), through ghl-proxy send_sms. */
  sendStaffSms: (
    phone: string,
    message: string,
  ) => Promise<
    {
      accepted: boolean;
      messageId: string | null;
      failureReason: string | null;
    }
  >;
  /**
   * The send-outlook-email edge function. Statements are HTML only, never an attachment.
   * The debt report alone carries cc and one PDF attachment, and marks itself
   * internal_report: "debt_report"; send-outlook-email accepts an unanchored PDF only on
   * that mark and only when every address is on our own domain (secureworkswa.com.au).
   */
  sendEmail: (payload: {
    from: string;
    to: string;
    subject: string;
    htmlBody: string;
    cc?: string[];
    attachments?: Array<
      { name: string; contentType: string; contentBytes: string }
    >;
    internal_report?: "debt_report";
    /** send-outlook-email signature choice for this mailbox, e.g. "shaun". */
    signature?: string;
  }) => Promise<{ ok: boolean; status: number; error: string | null }>;
  /** Xero's Bank Summary read live: one closing balance per bank account. */
  bankSummary: () => Promise<BankAccountBalance[]>;
  /** Draws the debt report as a PDF (debt_ws_report_pdf.ts). */
  renderReportPdf: (
    report: DebtReport,
  ) => Promise<{ bytes: Uint8Array; pageCount: number }>;
  /** The existing updateJobStatus (job_events, business_events, the GHL stage move). */
  updateJobStatus: (body: Record<string, unknown>) => Promise<unknown>;
  /**
   * getJobConversation: messages with full text, call transcripts included. Each message
   * carries contact_id (its GoHighLevel contact) and email_addresses where its source
   * has them. contactIds: extra GoHighLevel contacts whose cached threads are read too
   * (a neighbour payer's own thread on a shared job). heldContactIds: the payer's
   * contact, whose messages held on NO job with this job among their candidates are
   * read too, each marked unplaced: true (getJobConversation held_contact_ids).
   * held_read_failed is true when heldContactIds were asked for and that read failed.
   */
  conversation: (
    jobId: string,
    limit: number,
    contactIds?: string[],
    heldContactIds?: string[],
  ) => Promise<{
    messages: Record<string, unknown>[];
    summary?: unknown;
    held_read_failed?: boolean;
  }>;
  /** readJobStory: job-story-v1 or null, with its status. */
  story: (jobId: string) => Promise<{ story: unknown; status: unknown }>;
  listDocuments: (jobId: string) => Promise<Record<string, unknown>[]>;
  getDocument: (
    jobId: string,
    documentId: string,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  invoicePdf: (xeroInvoiceId: string) => Promise<Record<string, unknown>>;
  searchContacts: (
    q: string,
  ) => Promise<
    Array<
      {
        id: string;
        name?: string;
        firstName?: string;
        phone?: string;
        email?: string;
      }
    >
  >;
}

// ── Switches and the owner ──

/**
 * Sending is on when the settings row says so: debt_ws_settings.sending_enabled === true.
 * The database switch alone decides it (Shaun decided 14 Oct 2026). The old env
 * DEBT_WS_SENDING_ENABLED is retired and ignored. This covers manual texts, statements and
 * Jan's list (which also needs jan_list_auto_send). Auto-send keeps its own env key on top.
 */
export function debtWsSendingOn(settings: DebtWsSettings): boolean {
  return settings.sending_enabled === true;
}

/** The owners: env DEBT_WS_OWNER_USER_IDS when set (an unusable value means nobody), else the settings row. */
export function debtWsOwnerIds(
  env: DebtWsDeps["env"],
  settings: DebtWsSettings,
): string[] {
  const raw = env(DEBT_WS_OWNERS_SETTING)?.trim();
  const list = raw
    ? raw.split(",")
    : settings.owner_user_ids.map((id) => String(id));
  return list.map((id) => id.trim().toLowerCase()).filter((id) =>
    UUID.test(id)
  );
}

function isOwner(
  caller: DebtWsCaller,
  env: DebtWsDeps["env"],
  settings: DebtWsSettings,
): boolean {
  return caller.kind === "user" && !!caller.user_id &&
    debtWsOwnerIds(env, settings).includes(caller.user_id.toLowerCase());
}

// ── Body helpers ──

/** Fields every Ops dashboard POST carries (opsPost adds them). Accepted, never read. */
const ENVELOPE = ["action", "operator_email"];

function bad(message: string, code = "debt_ws_bad_request"): never {
  throw new DebtWsError(message, 400, code);
}

function asBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    bad("The request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function onlyKeys(body: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(body)) {
    if (!ENVELOPE.includes(key) && !allowed.includes(key)) {
      bad(`Unsupported field: ${key}`);
    }
  }
}

function uuidOf(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value.trim())) {
    bad(`${field} must be an id`);
  }
  return value.trim().toLowerCase();
}

function optionalText(value: unknown, field: string, max: number) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") bad(`${field} must be text`);
  const text = value.trim();
  if (text.length > max) bad(`${field} is longer than ${max} characters`);
  return text || null;
}

// ── Bank feed cache (module level: survives between requests on a warm function) ──

/** One bank-feed read: the RECEIVE transactions and how far back they are complete. */
interface BankFeed {
  day: string;
  at: number;
  /** The date_from asked of Xero (null: all dates). */
  from: string | null;
  /** Every RECEIVE transaction dated on or after this is in txs; null: all of them. */
  coveredFrom: string | null;
  /** The read stopped at DEBT_WS_BANK_MAX_PAGES before Xero ran out of pages. */
  truncated: boolean;
  txs: BankTransaction[];
}

let bankCache: BankFeed | null = null;
let bankCallTimes: number[] = [];

export function _resetDebtWsBankCacheForTest() {
  bankCache = null;
  bankCallTimes = [];
  // Tests reset between calls through this one hook; the greeting cache goes too.
  greetingCache.clear();
}

/** The bank-feed date an invoice needs: its invoice date minus one day (null: undated). */
function bankFromOf(inv: { invoice_date: string | null }): string | null {
  return inv.invoice_date && isIsoDate(inv.invoice_date)
    ? addDays(inv.invoice_date, -1)
    : null;
}

/** The feed holds every RECEIVE transaction from this date on (null: an undated invoice). */
function bankCovers(feed: BankFeed, from: string | null): boolean {
  if (from === null) return feed.coveredFrom === null;
  return feed.coveredFrom === null || from >= feed.coveredFrom;
}

/** The oldest open invoice in our Xero copy, as a bank-feed date; null when none is dated. */
async function oldestOpenFrom(deps: DebtWsDeps): Promise<string | null> {
  const dates = (await deps.store.openInvoices()).filter(inScope)
    .map((i) => bankFromOf(i)).filter((d): d is string => !!d).sort();
  return dates[0] ?? null;
}

class DebtWsBankBusyError extends Error {
  constructor() {
    super("The bank feed was read too often this minute");
    this.name = "DebtWsBankBusyError";
  }
}

/**
 * The cached feed when it is fresh (same Perth day, under 15 minutes) and reaches back far
 * enough for every date in `need`; else ONE new read, paged, that reaches back to the
 * oldest open invoice (and anything older in `need`), so later checks reuse it.
 */
async function cachedBankFeed(
  deps: DebtWsDeps,
  need: Array<string | null>,
): Promise<BankFeed> {
  const now = deps.now();
  const day = perthDate(now);
  const fresh = bankCache && bankCache.day === day &&
      now.getTime() - bankCache.at < DEBT_WS_BANK_CACHE_MS
    ? bankCache
    : null;
  if (fresh && need.every((from) => bankCovers(fresh, from))) return fresh;
  let floor = await oldestOpenFrom(deps);
  for (const from of need) if (from && (!floor || from < floor)) floor = from;
  if (fresh?.from && floor && fresh.from < floor) floor = fresh.from;

  const txs: BankTransaction[] = [];
  let oldest: string | null = null;
  let truncated = false;
  for (let page = 1;; page++) {
    if (page > DEBT_WS_BANK_MAX_PAGES) {
      truncated = true;
      break;
    }
    const at = deps.now().getTime();
    bankCallTimes = bankCallTimes.filter((t) => at - t < 60_000);
    if (bankCallTimes.length >= DEBT_WS_BANK_CALLS_PER_MINUTE) {
      throw new DebtWsBankBusyError();
    }
    bankCallTimes.push(at);
    const result = await deps.bankTransactions(floor, page);
    for (const tx of result.transactions) {
      const date = tx.date ? String(tx.date).slice(0, 10) : null;
      if (date && isIsoDate(date) && (!oldest || date < oldest)) oldest = date;
      // Spends never pay an invoice: only RECEIVE rows are kept.
      if (String(tx.type ?? "").toUpperCase().startsWith("RECEIVE")) {
        txs.push(tx);
      }
    }
    if (!result.has_more) break;
  }
  const feed: BankFeed = {
    day,
    at: now.getTime(),
    from: floor,
    // Cut short: only the days after the oldest row read are whole.
    coveredFrom: truncated
      ? (oldest ? addDays(oldest, 1) : "9999-12-31")
      : floor,
    truncated,
    txs,
  };
  bankCache = feed;
  return feed;
}

/** The feed, or null when it cannot be read (the caller decides what that blocks). */
async function bankFeedSafe(
  deps: DebtWsDeps,
  need: Array<string | null>,
): Promise<BankFeed | null> {
  try {
    return await cachedBankFeed(deps, need);
  } catch (error) {
    console.error("[debt_ws] bank feed unavailable", (error as Error)?.name);
    return null;
  }
}

/**
 * Possible payments for one invoice from the feed, or null when there is no feed or it
 * does not reach back to the invoice date (so the invoice cannot be checked).
 */
function bankCheck(
  feed: BankFeed | null,
  invoice: {
    invoice_number: string | null;
    amount_due: number | null;
    total: number | null;
    invoice_date: string | null;
  },
  names: Array<string | null | undefined>,
): PossiblePayment[] | null {
  if (!feed || !bankCovers(feed, bankFromOf(invoice))) return null;
  return possiblePayments(invoice, names, feed.txs);
}

// ── Pay links (cached on debt_ws_states.pay_link) ──

async function payLinkFor(
  deps: DebtWsDeps,
  entry: BookEntry,
  budget: { left: number },
): Promise<string | null> {
  if (entry.state?.pay_link) return entry.state.pay_link;
  if (budget.left <= 0) return null;
  budget.left -= 1;
  try {
    const link = await deps.payLink(entry.inv.xero_invoice_id);
    if (typeof link === "string" && /^https:\/\//.test(link)) {
      try {
        await deps.store.upsertState(entry.inv.xero_invoice_id, {
          pay_link: link,
          pay_link_read_at: deps.now().toISOString(),
        });
      } catch (_) {
        // The link still works this time; it is only not cached.
      }
      return link;
    }
  } catch (error) {
    console.error(
      "[debt_ws] pay link unavailable",
      entry.inv.xero_invoice_id,
      (error as Error)?.name ?? "",
    );
  }
  return null;
}

// ── Actor and logging ──

interface Actor {
  user_id: string | null;
  label: string;
}

async function actorOf(deps: DebtWsDeps, caller: DebtWsCaller): Promise<Actor> {
  if (caller.kind === "user" && caller.user_id) {
    const name = await deps.store.userName(caller.user_id).catch(() => null);
    return {
      user_id: caller.user_id.toLowerCase(),
      label: name || caller.email || "staff",
    };
  }
  return { user_id: null, label: "agent" };
}

async function log(
  deps: DebtWsDeps,
  entry: { share_key: string; ids: string[]; job_id: string | null },
  actor: Actor,
  kind: string,
  fields: {
    step?: string | null;
    body?: string | null;
    meta?: Record<string, unknown>;
  },
): Promise<WsLogRow> {
  return await deps.store.insertLog({
    share_key: entry.share_key,
    xero_invoice_ids: entry.ids,
    job_id: entry.job_id,
    kind,
    step: fields.step ?? null,
    body: fields.body ?? null,
    meta: fields.meta ?? {},
    created_by: actor.user_id,
    created_by_name: actor.label,
  });
}

/** The names a bank transaction may carry for this share: the Xero contact and the payer. */
const payerNames = (e: BookEntry) => [e.inv.contact_name, e.payer.name];

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/**
 * Why this invoice's payer cannot be texted from here, or null when they can.
 *   payer_not_linked: the payer has no GoHighLevel contact yet (link it first).
 * A neighbour on a shared job is texted at their OWN contact (their job_contacts row's
 * ghl_contact_id), never the job's. The send names the job, so the one guarded text path
 * (sendChaseSms: assertGhlContactMatchesResolvedJob, then ghl-proxy's contact/job match)
 * checks the contact is the job's own or a live party on the same job's contact list
 * (Captain ruling, 12 Oct 2026). A contact on no list for this job is still refused there.
 */
export function payerSendBlock(
  entry: Pick<BookEntry, "job" | "payer">,
): { code: string; message: string } | null {
  const payer = entry.payer;
  const who = firstName(payer.name);
  if (!entry.job || !payer.ghl_contact_id) {
    return {
      code: "payer_not_linked",
      message:
        `Link ${who}'s GoHighLevel contact first: there is no contact to text`,
    };
  }
  return null;
}

/**
 * Why a manual text (Shaun's own words, not a planned step) cannot go to this invoice's
 * payer, or null when it can. The job screen shows the reason in place of its reply box;
 * the guarded send refuses the same cases with the same code (not_chased_by_text):
 *   a company invoice (the Monday statement), a contact we never chase, or an invoice that
 *   is no longer open (paid, nothing owing).
 * Paused chasing does NOT block a manual text (Shaun decided 16 Oct 2026): says paid,
 * rectification, a promise to pay still ahead and day 21 (Jan's visit list) pause the
 * planned steps only, so Shaun can still reply in his own words. The rest of the checks
 * (sending on, the payer's contact, live Xero, the bank feed) run at the send itself,
 * exactly as for a planned step.
 */
export function manualTextBlock(
  entry: Pick<BookEntry, "kind" | "notChased" | "open">,
): { code: string; message: string } | null {
  if (entry.kind === "account") {
    return {
      code: "not_chased_by_text",
      message: "Company invoices go on the Monday statement, not a text",
    };
  }
  if (entry.notChased) {
    return {
      code: "not_chased_by_text",
      message: "This contact is never chased",
    };
  }
  if (!entry.open) {
    return {
      code: "not_chased_by_text",
      message: "This invoice is no longer open in our Xero copy",
    };
  }
  return null;
}

/** A neighbour payer's own GoHighLevel thread is read as well as the job's. */
function extraContactIds(entry: BookEntry): string[] {
  const id = entry.payer.ghl_contact_id;
  return id && id !== entry.job?.ghl_contact_id ? [id] : [];
}

/**
 * Whose messages held on no job may be read onto this job: the PAYER's GoHighLevel
 * contact only (on a shared fence the neighbour who owes, not the main client). A
 * message the placement ladder left unplaced, with this job among its candidates, then
 * shows in the conversation marked unplaced. No contact, no held messages.
 */
function heldContactIds(entry: BookEntry): string[] {
  const id = entry.payer.ghl_contact_id;
  return id ? [id] : [];
}

// -- Greeting name (Shaun, 14 Oct 2026) --
//
// Drafted texts greet the payer by the first name on their GoHighLevel contact when the
// payer is linked, because that is the name Shaun's own texts use: Xero can hold another
// name for the same household (Xero "Tuan Tran", GoHighLevel "Vincent Tran", Shaun writes
// "Hi Vincent"). Otherwise, the Xero contact's first name as before.
//
// No stored copy of the GoHighLevel contact's name exists (jobs.client_name and
// job_contacts.client_name are ours, business_events and ghl_conversation_cache carry no
// contact name), so it comes from the existing GoHighLevel contact search (the one the
// link candidates use, read only): the payer's phone, then email, keeping only the result
// whose id IS the payer's linked contact. Cached per contact per Perth day. A failed
// search is not cached and falls back to the Xero name. Nothing is written to
// GoHighLevel.

/** The name a draft greets the payer by, and where it came from. */
export interface GreetingName {
  /** The first name for {name} in a template. */
  name: string;
  /**
   * ghl: the linked GoHighLevel contact's first name. xero: the Xero contact's first
   * name. company_generic: the Xero payer is a company and no linked person was found,
   * so the draft says "Hi there,".
   */
  source: "ghl" | "xero" | "company_generic";
  /** The linked GoHighLevel contact's full name, when it was found. */
  ghl_name: string | null;
}

/** GoHighLevel contact id -> its name, for one Perth day. */
const greetingCache = new Map<
  string,
  { day: string; first: string | null; full: string | null }
>();

const tidyGhlName = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim();

/** The payer's linked GoHighLevel contact's name (first and full), or nulls. */
async function ghlContactName(
  deps: DebtWsDeps,
  payer: PayerContact,
): Promise<{ first: string | null; full: string | null }> {
  const id = payer.ghl_contact_id;
  if (!id) return { first: null, full: null };
  const day = perthDate(deps.now());
  const hit = greetingCache.get(id);
  if (hit && hit.day === day) return { first: hit.first, full: hit.full };
  const email = String(payer.email ?? "").trim().toLowerCase();
  const queries = [
    ...new Set(
      [
        digits(payer.phone).length >= 8 ? String(payer.phone).trim() : null,
        normaliseAuMobile(payer.phone),
        email.includes("@") ? email : null,
      ].filter((q): q is string => !!q && q.length >= 2),
    ),
  ];
  let failed = false;
  for (const q of queries) {
    try {
      const c = (await deps.searchContacts(q)).find((r) => r?.id === id);
      if (c) {
        const full = tidyGhlName(c.name) || tidyGhlName(c.firstName) || null;
        const first = tidyGhlName(c.firstName) || full;
        greetingCache.set(id, { day, first, full });
        return { first, full };
      }
    } catch (error) {
      failed = true;
      console.error(
        "[debt_ws] greeting name search failed",
        (error as Error)?.name ?? "",
      );
    }
  }
  // Not found is remembered for the day; a failed search is tried again next time.
  if (!failed) greetingCache.set(id, { day, first: null, full: null });
  return { first: null, full: null };
}

/**
 * The greeting name for an entry's drafts: the linked GoHighLevel contact's first name,
 * else the Xero contact's first name (firstNameOf the row's payer name). On a shared
 * fence the payer is the neighbour, so it is the neighbour's own contact. A company
 * account is never texted, so it is never searched.
 *
 * A payer whose Xero name reads like a company (looksLikeCompanyName, e.g. "Thomasz
 * Group") is never greeted by the first word of that name: the linked GoHighLevel
 * contact's first name when that contact is a person, else "there" ("Hi there,") with
 * source company_generic. A GoHighLevel contact whose own name reads like a company is
 * never used for the greeting either.
 */
export async function greetingNameFor(
  deps: DebtWsDeps,
  entry: BookEntry,
): Promise<GreetingName> {
  const company = looksLikeCompanyName(entry.row.payer_name);
  const fallback = (ghl_name: string | null): GreetingName =>
    company
      ? { name: "there", source: "company_generic", ghl_name }
      : { name: firstNameOf(entry.row.payer_name), source: "xero", ghl_name };
  if (entry.kind === "account" || !entry.payer.ghl_contact_id) {
    return fallback(null);
  }
  const ghl = await ghlContactName(deps, entry.payer);
  const person = !looksLikeCompanyName(ghl.full) &&
    !looksLikeCompanyName(ghl.first);
  const first = ghl.first && person ? firstNameOf(ghl.first) : null;
  if (first && first !== "there") {
    return { name: first, source: "ghl", ghl_name: ghl.full };
  }
  return fallback(ghl.full);
}

/** The payer as the screen and the agent see them, with the name drafts greet them by. */
function payerView(p: PayerContact, greeting: GreetingName) {
  return {
    name: p.name,
    phone: p.phone,
    email: p.email,
    ghl_contact_id: p.ghl_contact_id,
    contact_row_id: p.contact_row_id,
    label: p.label,
    is_primary: p.is_primary,
    resolved_by: p.resolved_by,
    // {name} in a drafted text: the GoHighLevel contact's first name when linked and
    // found, else the Xero contact's; "there" for a company payer with no linked person
    // (source company_generic). first_name is the same value, for the agent.
    greeting_name: greeting.name,
    greeting_name_source: greeting.source,
    first_name: greeting.name,
    ghl_name: greeting.ghl_name,
  };
}

const entryRef = (e: BookEntry) => ({
  share_key: e.row.share_key,
  ids: [e.inv.xero_invoice_id],
  job_id: e.job?.id ?? null,
});

async function oneEntry(
  deps: DebtWsDeps,
  xeroInvoiceId: string,
): Promise<{ book: Book; entry: BookEntry }> {
  const book = await loadBook(deps.store, {
    now: deps.now(),
    invoiceIds: [xeroInvoiceId],
  });
  const entry = book.entries.find((e) =>
    e.inv.xero_invoice_id === xeroInvoiceId
  );
  if (!entry) {
    const look = book.needsALook.find((n) =>
      n.xero_invoice_id === xeroInvoiceId
    );
    const goAhead = book.goAhead.some((g) =>
      g.xero_invoice_id === xeroInvoiceId
    );
    throw new DebtWsError(
      look
        ? `This invoice needs a look first: ${look.reason}`
        : goAhead
        ? "This is the job's go-ahead payment, which is never chased"
        : "That invoice is not in the debt book",
      404,
      "not_in_book",
      { reason: look?.reason ?? (goAhead ? "go_ahead" : "not_found") },
    );
  }
  return { book, entry };
}

// ── debt_ws_overview ──

/** Not-chased contacts, one entry per contact: {name, amount, count} plus the invoice ids. */
function notChasedGroups(open: BookEntry[]) {
  const groups = new Map<
    string,
    { name: string; amount: number; count: number; xero_invoice_ids: string[] }
  >();
  for (const e of open.filter((x) => x.notChased)) {
    const name = e.row.payer_name;
    const g = groups.get(name) ??
      { name, amount: 0, count: 0, xero_invoice_ids: [] };
    g.amount = Math.round(g.amount * 100 + e.row.amount_due * 100) / 100;
    g.count += 1;
    g.xero_invoice_ids.push(e.inv.xero_invoice_id);
    groups.set(name, g);
  }
  return [...groups.values()].sort((a, b) => b.amount - a.amount);
}

/**
 * The newest check of our Xero copy against Xero, as the tab and the report show it. A
 * check that cannot be read (its migration not applied yet, say) never stops the tab: it
 * reads "Could not read the check against Xero", never "Matches Xero".
 */
async function xeroCheckFor(deps: DebtWsDeps, now: Date): Promise<XeroCheckView> {
  try {
    const { latest, latestComplete } = await deps.store.mirrorChecks();
    return xeroCheckView(latest, latestComplete, now);
  } catch (error) {
    console.error("[debt_ws] the check against Xero is unavailable", (error as Error)?.name);
    return xeroCheckUnread();
  }
}

/** The not-chased names from the settings, without the contact ids. */
function notChasedNamesOf(settings: DebtWsSettings): string[] {
  return settings.not_chased_contacts.filter((x) => !UUID.test(x));
}

export async function debtWsOverview(deps: DebtWsDeps, caller: DebtWsCaller) {
  const now = deps.now();
  // One read of the open invoices, shared by the book and "Total owed to us", so the
  // breakdown always adds up to the same invoices the chart is drawn from.
  const openInvoices = await deps.store.openInvoices();
  const book = await loadBook(deps.store, { now, openInvoices });
  const weekStart = mondayOf(book.today);
  const [statements, paid, xeroCheck] = await Promise.all([
    deps.store.statementsForWeek(weekStart),
    paidThisWeek(deps.store, book.today),
    xeroCheckFor(deps, now),
  ]);
  const open = book.entries.filter((e) => e.open);
  const notDue = open.filter((e) => e.category === null);
  const janItems = janItemsLive(book);
  const janStored = book.janRow && book.janRow.status !== "open";
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    perth_date: book.today,
    read_at: now.toISOString(),
    settings: {
      tab_visible: book.settings.tab_visible,
      sending_on: debtWsSendingOn(book.settings),
      agent_on: book.settings.agent_enabled,
      viewer_is_owner: isOwner(caller, deps.env, book.settings),
      owner_set: debtWsOwnerIds(deps.env, book.settings).length > 0,
    },
    categories: categoryTotals(open),
    rows: sortRows(open.map((e) => e.row)),
    companies: companiesOf(book, statements),
    not_due: {
      count: notDue.length,
      amount:
        Math.round(notDue.reduce((s, e) => s + e.row.amount_due * 100, 0)) /
        100,
    },
    not_chased: notChasedGroups(open),
    needs_a_look: book.needsALook,
    // Every open invoice, broken down (debt_ws_report.ts totalOwedFrom), and whether our
    // Xero copy matched Xero at the last hourly check. Display only: nothing here is chased.
    total_owed: totalOwedFrom(
      placeOpenInvoices(book, openInvoices),
      notChasedNamesOf(book.settings),
    ),
    xero_check: xeroCheck,
    paid_this_week: paid,
    jan_list: {
      visit_date: book.janVisitDate,
      status: book.janRow?.status ?? "open",
      count: janStored ? (book.janRow!.items ?? []).length : janItems.length,
    },
  };
}

// ── debt_ws_job ──

/** The kind of any invoice on the job, by the same debt rule (go_ahead or null included). */
function kindLabel(book: Book, inv: WsInvoice) {
  const job = inv.job_id ? book.jobs.get(String(inv.job_id)) ?? null : null;
  const cls = classifyInvoice(
    inv,
    job,
    job ? book.history.get(String(job.id)) ?? [] : [],
  );
  return cls.status === "debt"
    ? cls.kind
    : cls.status === "go_ahead"
    ? "go_ahead"
    : null;
}

const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "").slice(-9);

/**
 * GoHighLevel contacts that may be the PAYER, searched by the payer's own phone and email
 * (a neighbour's from their job_contacts row). None when the payer is linked, or when there
 * is nowhere to link them (a neighbour with no job_contacts row).
 */
async function contactCandidates(deps: DebtWsDeps, entry: BookEntry) {
  const job = entry.job;
  const payer = entry.payer;
  if (!job || payer.ghl_contact_id) return [];
  if (!payer.is_primary && !payer.contact_row_id) return [];
  const phone = digits(payer.phone);
  const email = String(payer.email ?? "").trim().toLowerCase();
  const queries = [
    phone.length >= 8 ? String(payer.phone) : null,
    email || null,
    !phone && !email ? payer.name : null,
  ].filter((q): q is string => !!q && q.trim().length >= 2);
  const seen = new Map<string, Record<string, unknown>>();
  for (const q of queries) {
    try {
      for (const c of await deps.searchContacts(q)) {
        if (!c?.id || seen.has(c.id)) continue;
        const match = phone && digits(c.phone) === phone
          ? "phone"
          : email && String(c.email ?? "").toLowerCase() === email
          ? "email"
          : "name";
        seen.set(c.id, {
          id: c.id,
          name: c.name ?? null,
          phone: c.phone ?? null,
          email: c.email ?? null,
          match,
        });
      }
    } catch (error) {
      console.error(
        "[debt_ws] contact search failed",
        (error as Error)?.name ?? "",
      );
    }
  }
  const rank = (m: unknown) => m === "phone" ? 0 : m === "email" ? 1 : 2;
  return [...seen.values()].sort((a, b) => rank(a.match) - rank(b.match));
}

function noteView(l: WsLogRow) {
  return {
    id: l.id,
    kind: l.kind,
    step: l.step,
    body: l.body,
    meta: l.meta,
    created_at: l.created_at,
    created_by_name: l.created_by_name,
    xero_invoice_ids: l.xero_invoice_ids,
  };
}

function documentView(d: Record<string, unknown>) {
  const name = String(d.file_name || d.quote_number || d.type || "Document");
  const url = String(d.storage_url || d.pdf_url || d.html_url || "");
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ||
    url.split("?")[0].match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  const mime = ext === "pdf"
    ? "application/pdf"
    : ["jpg", "jpeg"].includes(ext)
    ? "image/jpeg"
    : ["png", "gif", "webp", "heic"].includes(ext)
    ? `image/${ext}`
    : d.pdf_url
    ? "application/pdf"
    : "application/octet-stream";
  return {
    id: String(d.id),
    name,
    mime,
    kind: d.type ?? null,
    created_at: d.created_at ?? null,
  };
}

export async function debtWsJob(deps: DebtWsDeps, params: URLSearchParams) {
  const id = uuidOf(params.get("xero_invoice_id"), "xero_invoice_id");
  // conversation=payer (default): the payer's own messages; conversation=all: the whole
  // job's thread, each message marked with whose it is.
  const mode = params.get("conversation") || "payer";
  if (mode !== "payer" && mode !== "all") {
    bad('conversation must be "payer" or "all"');
  }
  const { book, entry } = await oneEntry(deps, id);
  const job = entry.job;
  const payer = entry.payer;
  const rows = job ? book.contacts.get(String(job.id)) ?? [] : [];
  const budget = { left: DEBT_WS_PAY_LINK_FETCH_LIMIT };
  const [
    story,
    documents,
    conversation,
    jobLogs,
    payLink,
    bank,
    candidates,
    greeting,
  ] = await Promise.all([
      job
        ? deps.story(job.id).catch(() => ({
          story: null,
          status: { ok: false, state: "failed" },
        }))
        : Promise.resolve({
          story: null,
          status: { ok: false, state: "no_job" },
        }),
      job
        ? deps.listDocuments(job.id).then((rows) => ({
          rows: rows.map(documentView),
          status: "ok",
        })).catch(() => ({ rows: [], status: "unavailable" }))
        : Promise.resolve({ rows: [], status: "no_job" }),
      job
        ? deps.conversation(
          job.id,
          100,
          extraContactIds(entry),
          heldContactIds(entry),
        ).catch(() => ({
          messages: [] as Record<string, unknown>[],
          summary: null as unknown,
          error: "The conversation could not be read",
        }))
        : Promise.resolve({
          messages: [] as Record<string, unknown>[],
          summary: null as unknown,
        }),
      job ? deps.store.logsForJob(job.id) : Promise.resolve([]),
      payLinkFor(deps, entry, budget),
      bankFeedSafe(deps, [bankFromOf(entry.inv)]),
      contactCandidates(deps, entry),
      greetingNameFor(deps, entry),
    ]);
  const notes = new Map<string, WsLogRow>();
  for (const l of [...entry.logs, ...jobLogs]) notes.set(l.id, l);
  const invoices = (job ? book.history.get(String(job.id)) ?? [] : [entry.inv])
    .map((inv) => ({
      xero_invoice_id: inv.xero_invoice_id,
      number: inv.invoice_number,
      reference: inv.reference,
      kind: kindLabel(book, inv),
      total: Number(inv.total ?? 0),
      amount_due: Number(inv.amount_due ?? 0),
      status: inv.status,
      date: inv.invoice_date,
    })).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const suggestion = entry.suggestion
    ? suggestionView(entry.suggestion)
    : templateDraftFor(entry, payLink, greeting.name);
  const split = splitConversation(
    conversation.messages ?? [],
    payer,
    partiesOf(job, rows),
  );
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    perth_date: book.today,
    row: entry.row,
    job: job
      ? {
        id: job.id,
        job_number: job.job_number,
        type: job.type,
        status: job.status,
        client_name: job.client_name,
        client_phone: job.client_phone,
        site_address: job.site_address,
        site_suburb: job.site_suburb,
        ghl_contact_id: job.ghl_contact_id,
        // Every share on the job: a shared fence has one per payer.
        shares: sharesOf(job, book.history.get(String(job.id)) ?? [], rows),
      }
      : null,
    payer_contact: payerView(payer, greeting),
    story: story.story ?? null,
    story_status: story.status ?? null,
    invoices,
    documents: documents.rows,
    documents_status: documents.status,
    conversation: {
      ...conversation,
      messages: mode === "all" ? split.all_messages : split.payer_messages,
      mode,
      all_job_messages_count: split.all_messages.length,
      payer_messages_count: split.payer_messages.length,
      reason: split.reason,
    },
    notes: [...notes.values()].sort((a, b) =>
      String(b.created_at).localeCompare(String(a.created_at))
    ).map(noteView),
    ladder: entry.ladder.ladder,
    suggestion,
    flags: entry.flags.map((f) => ({
      id: f.id,
      text: f.text,
      why: f.why,
      created_at: f.created_at,
    })),
    possible_payments: bankCheck(bank, entry.inv, payerNames(entry)) ?? [],
    possible_payments_status: !bank
      ? "unavailable"
      : bankCovers(bank, bankFromOf(entry.inv))
      ? "ok"
      : "partial",
    // The PAYER's contact. Linking writes to the payer (a neighbour's job_contacts row).
    contact: {
      ghl_contact_id: payer.ghl_contact_id,
      candidates,
      linkable: !!job && (payer.is_primary || !!payer.contact_row_id),
      payer_name: payer.name,
    },
    // Why Send is off for this payer (null: it can be texted once sending is on).
    send_block: entry.kind === "account" ? null : payerSendBlock(entry),
    // Whether Shaun may type his own text here (step "manual"), and why not in words.
    manual_text: (() => {
      const block = manualTextBlock(entry);
      return block
        ? { allowed: false, code: block.code, reason: block.message }
        : { allowed: true, code: null, reason: null };
    })(),
    pay_link: payLink,
  };
}

// ── debt_ws_document ──

export async function debtWsDocument(
  deps: DebtWsDeps,
  params: URLSearchParams,
) {
  if (params.get("xero_invoice_id")) {
    const id = uuidOf(params.get("xero_invoice_id"), "xero_invoice_id");
    const pdf = await deps.invoicePdf(id);
    return {
      status: 200,
      body: {
        ok: true,
        version: DEBT_WS_VERSION,
        document: {
          id,
          name: pdf.filename ?? `${id}.pdf`,
          mime: "application/pdf",
          kind: "invoice",
        },
        content: {
          base64: pdf.pdf_base64 ?? null,
          mime_type: "application/pdf",
        },
        file_name: pdf.filename ?? `${id}.pdf`,
      },
    };
  }
  const jobId = uuidOf(params.get("job_id"), "job_id");
  const documentId = uuidOf(params.get("document_id"), "document_id");
  const result = await deps.getDocument(jobId, documentId);
  const doc = (result.body.document ?? {}) as Record<string, unknown>;
  return {
    status: result.status,
    body: {
      ...result.body,
      version: DEBT_WS_VERSION,
      file_name: doc.file_name ?? doc.quote_number ?? doc.type ?? "document",
    },
  };
}

// ── debt_ws_note ──

export async function debtWsNote(
  deps: DebtWsDeps,
  caller: DebtWsCaller,
  rawBody: unknown,
) {
  const body = asBody(rawBody);
  // The screen sends the note as `body` (and `note`, the same text); `text` is accepted too.
  // It also sends share_key and job_id: accepted and not read (the invoice decides both).
  onlyKeys(body, [
    "xero_invoice_id",
    "company_key",
    "share_key",
    "job_id",
    "body",
    "note",
    "text",
    "promise_date",
  ]);
  if (caller.kind !== "user" || !caller.user_id) {
    throw new DebtWsError(
      "A signed-in staff user is required: a note records who wrote it",
      403,
      "user_required",
    );
  }
  const actor = await actorOf(deps, caller);
  const text = optionalText(body.body, "body", 4000) ??
    optionalText(body.note, "note", 4000) ??
    optionalText(body.text, "text", 4000);
  const promise = body.promise_date === "" ? null : body.promise_date ?? null;
  const today = perthDate(deps.now());
  if (promise !== null) {
    if (!isIsoDate(promise)) bad("promise_date must be YYYY-MM-DD");
    if (promise < today) bad("promise_date cannot be before today");
    if (!body.xero_invoice_id) bad("A promise needs the xero_invoice_id");
  }
  if (!text && promise === null) bad("Write a note or pick a promise date");

  let ref: { share_key: string; ids: string[]; job_id: string | null };
  if (body.xero_invoice_id !== undefined) {
    const id = uuidOf(body.xero_invoice_id, "xero_invoice_id");
    const [inv] = await deps.store.invoicesByIds([id]);
    if (!inv) {
      throw new DebtWsError("That invoice was not found", 404, "not_found");
    }
    ref = { share_key: id, ids: [id], job_id: inv.job_id ?? null };
  } else if (typeof body.company_key === "string" && body.company_key.trim()) {
    // A company note sits on the canonical company (an alias contact id is mapped).
    const settings = await deps.store.settings();
    const key = canonicalCompanyKey(
      body.company_key.trim().toLowerCase().slice(0, 200),
      settings.company_aliases,
    );
    ref = { share_key: key, ids: [], job_id: null };
  } else {
    bad("Send the xero_invoice_id or the company_key the note is about");
  }

  const written: WsLogRow[] = [];
  if (text) written.push(await log(deps, ref, actor, "note", { body: text }));
  if (promise !== null) {
    await deps.store.upsertState(ref.share_key, {
      paused_until: promise as string,
      updated_by: actor.label,
    });
    written.push(
      await log(deps, ref, actor, "promise", {
        body: `Promised to pay by ${longDate(promise as string)}`,
        meta: { promise_date: promise },
      }),
    );
  }
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    notes: written.map(noteView),
    paused_until: promise,
  };
}

// ── The guarded send (spec section 1) ──

interface SendInput {
  book: Book;
  entry: BookEntry;
  step: string;
  text: string;
  suggestion: WsSuggestion | null;
  actor: Actor;
  operatorEmail: string | null;
  override: boolean;
  /** The amount the draft was written against. */
  draftAmount: number;
  /**
   * Set for a manual text (step DEBT_WS_MANUAL_STEP): the screen's one-off reference for
   * this message, which keys the claim so the same message is never texted twice.
   */
  manual?: { client_ref: string };
}

function liveCheck(
  inv: Record<string, unknown>,
  draftAmount: number,
): { code: string; message: string } | null {
  const number = String(inv.InvoiceNumber ?? inv.InvoiceID ?? "the invoice");
  const status = String(inv.Status ?? "");
  const due = Number(inv.AmountDue);
  if (status === "PAID" || (status === "AUTHORISED" && !(due > 0))) {
    return {
      code: "paid",
      message: `Xero shows ${number} paid, so the text was not sent`,
    };
  }
  if (status !== "AUTHORISED") {
    return {
      code: "not_open",
      message: `Xero shows ${number} as ${
        status || "unknown"
      }, not an open invoice, so the text was not sent`,
    };
  }
  if (Math.round(due * 100) < Math.round(draftAmount * 100)) {
    return {
      code: "part_paid",
      message: `Xero shows $${
        due.toFixed(2)
      } owing on ${number}, less than the $${
        draftAmount.toFixed(2)
      } the text was written for. Something was paid or credited, so read the job again`,
    };
  }
  return null;
}

async function refuse(
  deps: DebtWsDeps,
  input: Pick<SendInput, "entry" | "step" | "actor">,
  code: string,
  message: string,
  status = 409,
  details: Record<string, unknown> = {},
): Promise<never> {
  let logged = false;
  try {
    await log(deps, entryRef(input.entry), input.actor, "send_refused", {
      step: input.step,
      body: message,
      meta: { code, cycle_start: input.entry.dayZero, ...details },
    });
    logged = true;
  } catch (error) {
    console.error("[debt_ws] refusal not logged", (error as Error)?.name);
  }
  throw new DebtWsError(message, status, code, { ...details, logged });
}

async function guardedSend(deps: DebtWsDeps, input: SendInput) {
  const { entry, step, actor } = input;
  const settings = input.book.settings;
  if (!debtWsSendingOn(settings)) {
    await refuse(
      deps,
      input,
      "sending_off",
      "Sending is off until you switch it on",
    );
  }
  const textProblem = clientTextProblem(input.text);
  if (textProblem) {
    throw new DebtWsError(textProblem, 400, "text_not_allowed");
  }
  if (entry.kind === "account" || entry.notChased || !entry.open) {
    await refuse(
      deps,
      input,
      "not_chased_by_text",
      entry.notChased
        ? "This contact is never chased"
        : !entry.open
        ? "This invoice is no longer open in our Xero copy"
        : "Company invoices go on the Monday statement, not a text",
    );
  }
  // (A manual text is blocked by exactly the cases above, as manualTextBlock tells the
  // screen; paused chasing does not stop it: Shaun decided 16 Oct 2026.)
  // The text goes to the PAYER's own contact, never the job's: on a shared fence the
  // job's contact is the primary client, who may not owe this invoice.
  const block = payerSendBlock(entry);
  if (block) await refuse(deps, input, block.code, block.message);
  const contact = entry.payer.ghl_contact_id as string;
  // The claim's step: the step itself, or "manual:<client_ref>" for a manual text, which
  // is unique to that one message and is never a ladder step.
  const claimStep = input.manual
    ? `${DEBT_WS_MANUAL_STEP}:${input.manual.client_ref}`
    : step;
  if (isLadderStep(step) && entry.row.step_due?.step !== step) {
    await refuse(
      deps,
      input,
      "step_not_due",
      `That step is not due now${
        entry.row.step_due
          ? `: ${STEP_LABELS[entry.row.step_due.step as "d1"]} is`
          : ""
      }`,
    );
  }
  const already = entry.sends.find((s) =>
    s.cycle_start === entry.dayZero && s.step === claimStep &&
    (s.status === "sending" || s.status === "sent")
  );
  if (already) {
    await refuse(
      deps,
      input,
      "already_sent",
      input.manual
        ? "That text was already sent (or a send of it is not confirmed), so it is not sent twice"
        : "That step was already sent (or a send of it is not confirmed), so it is not sent twice",
    );
  }

  // The live Xero re-check.
  let live: Record<string, unknown>;
  try {
    live = await deps.readInvoice(entry.inv.xero_invoice_id);
  } catch (error) {
    const rate = (error as { name?: string })?.name === "XeroCooldownError";
    return await refuse(
      deps,
      input,
      rate ? "xero_rate_limited" : "xero_unavailable",
      rate
        ? "Xero is busy, so the last check could not run. Nothing was sent; try again shortly"
        : "Xero could not be read for the last check, so nothing was sent",
      503,
    );
  }
  const problem = liveCheck(live, input.draftAmount);
  if (problem) await refuse(deps, input, problem.code, problem.message);

  // The bank-feed check: the cached feed (one read per 15 minutes) when it reaches back to
  // the invoice date minus one day, else one new read that does.
  const feed = await bankFeedSafe(deps, [bankFromOf(entry.inv)]);
  const checked = bankCheck(feed, {
    ...entry.inv,
    amount_due: Number(live.AmountDue ?? entry.inv.amount_due),
  }, payerNames(entry));
  if (!checked) {
    return await refuse(
      deps,
      input,
      "bank_check_unavailable",
      "The bank feed could not be read, so nothing was sent. Try again shortly",
      503,
    );
  }
  const payments: PossiblePayment[] = checked;
  if (payments.length && !input.override) {
    const first = payments[0];
    await refuse(
      deps,
      input,
      "possible_payment",
      `There may already be a payment: ${first.date ?? "a recent date"}, $${
        first.amount.toFixed(2)
      } from ${first.payer_text} (${first.reason}). Match it in Xero, or send anyway`,
      409,
      { possible_payments: payments },
    );
  }

  // The claim, then the one text.
  const claim = await deps.store.claimSend({
    share_key: entry.row.share_key,
    cycle_start: entry.dayZero,
    step: claimStep,
    suggestion_id: input.suggestion?.id ?? null,
    actor: actor.label,
  });
  if (!claim) {
    await refuse(
      deps,
      input,
      "already_sent",
      "Another send already claimed that step, so it is not sent twice",
    );
  }
  let messageId: string | null = null;
  try {
    const sent = await deps.sendSms({
      ghl_contact_id: contact,
      job_id: entry.job!.id,
      xero_invoice_id: entry.inv.xero_invoice_id,
      message: input.text,
      operator_email: input.operatorEmail,
    });
    if (sent?.success === false) throw new Error("SMS send failed");
    messageId = sent?.message_id ?? null;
  } catch (error) {
    const why = String((error as Error)?.message ?? error).slice(0, 300);
    if (error instanceof DebtWsSendRefusedError) {
      // Refused before any SMS was handed over: the claim is released.
      await deps.store.settleSend(claim!.id, { status: "refused", error: why })
        .catch(() => {});
      return await refuse(
        deps,
        input,
        "send_refused_by_guard",
        `${why}. No text was sent`,
      );
    }
    // The provider may have sent it: the claim stays, so it can never text twice.
    await deps.store.settleSend(claim!.id, { error: `not confirmed: ${why}` })
      .catch(() => {});
    return await refuse(
      deps,
      input,
      "send_not_confirmed",
      `${why}. The step stays claimed so it cannot text twice; check the GoHighLevel conversation`,
      502,
    );
  }

  let logged = true;
  try {
    await deps.store.settleSend(claim!.id, {
      status: "sent",
      provider_message_id: messageId,
    });
  } catch (error) {
    logged = false;
    console.error(
      "[debt_ws] SENT BUT NOT MARKED",
      claim!.id,
      (error as Error)?.name,
    );
  }
  const suggestionId = input.suggestion?.id ?? null;
  if (suggestionId) {
    await deps.store.decideSuggestion(suggestionId, {
      status: "sent",
      decided_by: actor.label,
    }, ["pending", "accepted"]).catch(() => false);
  }
  try {
    await log(deps, entryRef(entry), actor, "text_sent", {
      step,
      body: input.text,
      meta: {
        cycle_start: entry.dayZero,
        send_id: claim!.id,
        suggestion_id: suggestionId,
        provider_message_id: messageId,
        override_possible_payment: input.override && payments.length > 0,
        ...(input.override && payments.length
          ? { possible_payments: payments }
          : {}),
        // A manual text is marked as one, so it never reads as a planned step.
        ...(input.manual
          ? { manual: true, client_ref: input.manual.client_ref }
          : {}),
      },
    });
  } catch (error) {
    logged = false;
    console.error(
      "[debt_ws] SENT BUT NOT LOGGED",
      claim!.id,
      (error as Error)?.name,
    );
  }
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    sent: true,
    step,
    manual: !!input.manual,
    send_id: claim!.id,
    provider_message_id: messageId,
    override_possible_payment: input.override && payments.length > 0,
    logged,
  };
}

// ── debt_ws_decide ──

export async function debtWsDecide(
  deps: DebtWsDeps,
  caller: DebtWsCaller,
  rawBody: unknown,
) {
  const body = asBody(rawBody);
  onlyKeys(body, [
    "xero_invoice_id",
    "step",
    "suggestion_id",
    "action",
    "text",
    "override_possible_payment",
    "amount",
    "channel",
    "client_ref",
  ]);
  // Texts only in v1: the screen may name the channel, and it must be sms.
  if (
    body.channel !== undefined && body.channel !== null &&
    body.channel !== "sms"
  ) bad("channel must be sms");
  const actor = await actorOf(deps, caller);
  const action = body.action;
  if (action !== "send" && action !== "skip" && action !== "dismiss") {
    bad('action must be "send", "skip" or "dismiss"');
  }
  const suggestionId = body.suggestion_id === undefined ||
      body.suggestion_id === null
    ? null
    : uuidOf(body.suggestion_id, "suggestion_id");
  const suggestion = suggestionId
    ? await deps.store.suggestionById(suggestionId)
    : null;
  if (suggestionId && !suggestion) {
    throw new DebtWsError("That suggestion was not found", 404, "not_found");
  }

  if (action === "dismiss") {
    if (!suggestion) bad("dismiss needs the suggestion_id");
    if (suggestion.status !== "pending") {
      throw new DebtWsError(
        `That suggestion is already ${suggestion.status}`,
        409,
        "suggestion_not_pending",
      );
    }
    await deps.store.decideSuggestion(suggestion.id, {
      status: "dismissed",
      decided_by: actor.label,
    });
    await log(
      deps,
      {
        share_key: suggestion.share_key,
        ids: suggestion.xero_invoice_ids,
        job_id: suggestion.job_id,
      },
      actor,
      "skip",
      {
        body: `Dismissed the agent's ${suggestion.kind}`,
        meta: {
          dismissed_suggestion_id: suggestion.id,
          suggestion_kind: suggestion.kind,
        },
      },
    );
    return {
      ok: true,
      version: DEBT_WS_VERSION,
      dismissed: true,
      suggestion_id: suggestion.id,
    };
  }

  const id = uuidOf(body.xero_invoice_id, "xero_invoice_id");
  const step = body.step;

  // A manual text: Shaun's own words, not a planned step. Sent only (never skipped), with
  // no suggestion, the amount owing it was written against, and the screen's client_ref.
  if (step === DEBT_WS_MANUAL_STEP) {
    if (action !== "send") bad("A manual text can only be sent");
    if (suggestion) bad("A manual text has no suggestion_id");
    const clientRef = uuidOf(body.client_ref, "client_ref");
    if (typeof body.text !== "string") bad("text is required to send");
    if (
      body.override_possible_payment !== undefined &&
      typeof body.override_possible_payment !== "boolean"
    ) bad("override_possible_payment must be true or false");
    const owed = body.amount === undefined || body.amount === null
      ? null
      : Number(body.amount);
    if (owed === null) {
      bad(
        "amount is required: send the amount owing the text was written for",
        "amount_required",
      );
    }
    if (!Number.isFinite(owed) || owed <= 0) {
      bad("amount must be the positive amount the text was written for");
    }
    const { book, entry } = await oneEntry(deps, id);
    return await guardedSend(deps, {
      book,
      entry,
      step: DEBT_WS_MANUAL_STEP,
      text: (body.text as string).trim(),
      suggestion: null,
      actor,
      operatorEmail: caller.email ?? null,
      override: body.override_possible_payment === true,
      draftAmount: owed,
      manual: { client_ref: clientRef },
    });
  }
  if (body.client_ref !== undefined) {
    bad("client_ref is only for a manual text");
  }

  if (!isLadderStep(step) && !isReplyStep(step)) {
    bad("step must be d1, d3, d7, d12, d17, d21, a reply step or manual");
  }
  if (suggestion && suggestion.share_key !== id) {
    throw new DebtWsError(
      "That suggestion belongs to another invoice",
      409,
      "suggestion_mismatch",
    );
  }
  // "Move + send reply": the screen moves the card first (set_category marks the move
  // accepted), then sends its reply, so an accepted move may still send its text once.
  const sendable = suggestion?.status === "pending" ||
    (action === "send" && suggestion?.kind === "move" &&
      suggestion.status === "accepted");
  if (suggestion && !sendable) {
    throw new DebtWsError(
      `That suggestion is already ${suggestion.status}`,
      409,
      "suggestion_not_pending",
    );
  }
  if (isReplyStep(step) && (!suggestion || suggestion.step !== step)) {
    bad("A reply is sent from its suggestion: send the suggestion_id");
  }
  const { book, entry } = await oneEntry(deps, id);

  if (action === "skip") {
    if (isLadderStep(step) && entry.row.step_due?.step !== step) {
      throw new DebtWsError(
        "That step is not due now, so there is nothing to skip",
        409,
        "step_not_due",
      );
    }
    const target = suggestion ?? entry.suggestion;
    if (target && target.step === step) {
      await deps.store.decideSuggestion(target.id, {
        status: "skipped",
        decided_by: actor.label,
      });
    }
    const row = await log(deps, entryRef(entry), actor, "skip", {
      step,
      body: optionalText(body.text, "text", 4000),
      meta: { cycle_start: entry.dayZero, suggestion_id: target?.id ?? null },
    });
    return {
      ok: true,
      version: DEBT_WS_VERSION,
      skipped: true,
      step,
      note: noteView(row),
    };
  }

  if (step === "d21") {
    bad("Day 21 is Jan's visit list, not a text");
  }
  if (typeof body.text !== "string") bad("text is required to send");
  if (
    body.override_possible_payment !== undefined &&
    typeof body.override_possible_payment !== "boolean"
  ) bad("override_possible_payment must be true or false");
  const amount = body.amount === undefined || body.amount === null
    ? null
    : Number(body.amount);
  if (amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
    bad("amount must be the positive amount the draft was written for");
  }
  // A template send (no suggestion_id) carries the amount its draft was written against:
  // the live check refuses when Xero shows less owing than that (part paid since).
  if (!suggestion && amount === null) {
    bad(
      "amount is required: send the amount the draft was written for",
      "amount_required",
    );
  }
  const draftAmount = suggestion?.amount !== null &&
      suggestion?.amount !== undefined
    ? Number(suggestion.amount)
    : amount ?? entry.row.amount_due;
  return await guardedSend(deps, {
    book,
    entry,
    step,
    text: (body.text as string).trim(),
    suggestion: suggestion ??
      (entry.suggestion && entry.suggestion.step === step
        ? entry.suggestion
        : null),
    actor,
    operatorEmail: caller.email ?? null,
    override: body.override_possible_payment === true,
    draftAmount,
  });
}

// ── debt_ws_set_category ──

export async function debtWsSetCategory(
  deps: DebtWsDeps,
  caller: DebtWsCaller,
  rawBody: unknown,
) {
  const body = asBody(rawBody);
  onlyKeys(body, ["xero_invoice_id", "category", "suggestion_id"]);
  const id = uuidOf(body.xero_invoice_id, "xero_invoice_id");
  const category = body.category;
  if (
    category !== "says_paid" && category !== "rectification" &&
    category !== "clear"
  ) bad('category must be "says_paid", "rectification" or "clear"');
  const actor = await actorOf(deps, caller);
  const { book, entry } = await oneEntry(deps, id);
  const suggestionId = body.suggestion_id === undefined ||
      body.suggestion_id === null
    ? null
    : uuidOf(body.suggestion_id, "suggestion_id");
  const from = entry.category;
  let note: string | null = null;

  if (category === "rectification") {
    if (!entry.job) {
      throw new DebtWsError(
        "This invoice has no job, so there is no card to move",
        409,
        "no_job",
      );
    }
    if (String(entry.job.status ?? "").toLowerCase() !== "rectification") {
      await deps.updateJobStatus({
        job_id: entry.job.id,
        status: "rectification",
        source: "debt_workshop",
        operator_email: caller.email ?? null,
        userId: actor.user_id,
      });
    }
  } else if (category === "says_paid") {
    if (!entry.state?.says_paid_since) {
      await deps.store.upsertState(id, {
        says_paid_since: book.today,
        updated_by: actor.label,
      });
    }
  } else {
    await deps.store.upsertState(id, {
      says_paid_since: null,
      updated_by: actor.label,
    });
    if (String(entry.job?.status ?? "").toLowerCase() === "rectification") {
      note =
        "The card stays in Rectification: move it on the board when the work is fixed";
    }
  }
  // "Keep chasing" (clear) dismisses the move; a move taken is accepted, and its reply can
  // then be sent once through debt_ws_decide.
  if (suggestionId) {
    await deps.store.decideSuggestion(suggestionId, {
      status: category === "clear" ? "dismissed" : "accepted",
      decided_by: actor.label,
    });
  }
  await log(deps, entryRef(entry), actor, "category_change", {
    body: category === "clear"
      ? (suggestionId
        ? "Kept chasing: dismissed the suggested move"
        : "Cleared says paid")
      : `Moved to ${category === "says_paid" ? "Says paid" : "Rectification"}`,
    meta: { from, to: category, suggestion_id: suggestionId },
  });
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    category,
    job_status: category === "rectification"
      ? "rectification"
      : entry.job?.status ?? null,
    note,
  };
}

// ── debt_ws_link_contact ──

export async function debtWsLinkContact(
  deps: DebtWsDeps,
  caller: DebtWsCaller,
  rawBody: unknown,
) {
  const body = asBody(rawBody);
  onlyKeys(body, ["job_id", "ghl_contact_id", "xero_invoice_id", "replace"]);
  const contact = typeof body.ghl_contact_id === "string"
    ? body.ghl_contact_id.trim()
    : "";
  if (!GHL_ID.test(contact)) {
    bad("ghl_contact_id must be a GoHighLevel contact id");
  }
  if (body.xero_invoice_id === undefined && body.job_id === undefined) {
    bad("Send the xero_invoice_id whose payer is being linked");
  }
  const invoiceId = body.xero_invoice_id !== undefined
    ? uuidOf(body.xero_invoice_id, "xero_invoice_id")
    : null;
  const actor = await actorOf(deps, caller);

  // With the invoice, the link goes to the invoice's PAYER: a neighbour's own
  // job_contacts row on a shared fence, never the job (whose contact is the primary's).
  let payer: PayerContact | null = null;
  let jobId: string;
  let jobRows: Awaited<ReturnType<DebtWsStore["jobContacts"]>> = [];
  if (invoiceId) {
    const { book, entry } = await oneEntry(deps, invoiceId);
    if (!entry.job) {
      throw new DebtWsError(
        "This invoice has no job, so there is nowhere to link a contact",
        409,
        "no_job",
      );
    }
    if (
      body.job_id !== undefined &&
      uuidOf(body.job_id, "job_id") !== entry.job.id
    ) {
      throw new DebtWsError(
        "That invoice is not on that job",
        409,
        "job_mismatch",
      );
    }
    jobId = entry.job.id;
    payer = entry.payer;
    jobRows = book.contacts.get(String(jobId)) ?? [];
  } else {
    jobId = uuidOf(body.job_id, "job_id");
  }
  const [job] = await deps.store.jobs([jobId]);
  if (!job) {
    throw new DebtWsError("That job was not found", 404, "job_not_found");
  }
  if (!invoiceId) jobRows = await deps.store.jobContacts([jobId]);
  const active = jobRows.filter((r) =>
    !r.status || String(r.status).toLowerCase() === "active"
  );
  const ref = {
    share_key: invoiceId ?? `job:${jobId}`,
    ids: invoiceId ? [invoiceId] : [],
    job_id: jobId,
  };

  if (payer && !payer.is_primary) {
    if (!payer.contact_row_id) {
      throw new DebtWsError(
        `${payer.name} has no contact row on this job, so there is nowhere to link them. Add them to the job's contacts first`,
        409,
        "payer_not_on_job",
      );
    }
    const row = active.find((r) => r.id === payer!.contact_row_id);
    // One GoHighLevel contact is one person: never the primary's (or another payer's)
    // contact on a neighbour's row.
    const primaryIds = new Set(
      [
        job.ghl_contact_id,
        ...active.filter((r) => r.is_primary === true).map((r) =>
          r.ghl_contact_id
        ),
      ].filter((x): x is string => !!x),
    );
    const otherRow = active.find((r) =>
      r.id !== payer!.contact_row_id && r.ghl_contact_id === contact
    );
    if (primaryIds.has(contact) || otherRow) {
      throw new DebtWsError(
        `That GoHighLevel contact belongs to ${
          otherRow?.client_name?.replace(/\s+/g, " ").trim() ||
          job.client_name || "another payer on this job"
        }, not ${payer.name}. Pick ${payer.name}'s own contact`,
        409,
        "contact_belongs_to_other_payer",
      );
    }
    const previous = row?.ghl_contact_id ?? null;
    if (previous && previous !== contact && body.replace !== true) {
      throw new DebtWsError(
        `${payer.name} already has a different GoHighLevel contact. Send replace: true to change it`,
        409,
        "contact_already_linked",
        { current_ghl_contact_id: previous },
      );
    }
    await deps.store.setContactRowGhl(payer.contact_row_id, jobId, contact);
    await log(deps, ref, actor, "link_contact", {
      body:
        `Linked GoHighLevel contact ${contact} to ${payer.name} (share ${payer.label})`,
      meta: {
        ghl_contact_id: contact,
        previous,
        target: "job_contacts",
        job_contact_id: payer.contact_row_id,
        label: payer.label,
      },
    });
    return {
      ok: true,
      version: DEBT_WS_VERSION,
      job_id: jobId,
      ghl_contact_id: contact,
      target: "job_contacts",
      job_contact_id: payer.contact_row_id,
    };
  }

  // The primary payer (or a job_id-only call): the job's own contact, as before. A
  // neighbour's contact is never put on the job.
  const neighbourRow = active.find((r) =>
    r.is_primary !== true && r.ghl_contact_id === contact
  );
  if (neighbourRow) {
    throw new DebtWsError(
      `That GoHighLevel contact belongs to ${
        neighbourRow.client_name?.replace(/\s+/g, " ").trim() || "a neighbour"
      }, a neighbour on this job, not the job's client`,
      409,
      "contact_belongs_to_other_payer",
    );
  }
  if (
    job.ghl_contact_id && job.ghl_contact_id !== contact &&
    body.replace !== true
  ) {
    throw new DebtWsError(
      "This job already has a different GoHighLevel contact. Send replace: true to change it",
      409,
      "contact_already_linked",
      { current_ghl_contact_id: job.ghl_contact_id },
    );
  }
  await deps.store.setJobContact(jobId, contact);
  await log(deps, ref, actor, "link_contact", {
    body: `Linked GoHighLevel contact ${contact}`,
    meta: {
      ghl_contact_id: contact,
      previous: job.ghl_contact_id ?? null,
      target: "jobs",
    },
  });
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    job_id: jobId,
    ghl_contact_id: contact,
    target: "jobs",
  };
}

// ── Statements ──

async function statementFor(
  deps: DebtWsDeps,
  book: Book,
  companyKey: string,
) {
  const statements = await deps.store.statementsForWeek(mondayOf(book.today));
  const company = companiesOf(book, statements).find((c) =>
    c.company_key === companyKey
  );
  const notChased = book.entries.some((e) =>
    e.companyKey === companyKey && e.notChased
  );
  if (!company) {
    throw new DebtWsError(
      notChased
        ? "This company is not chased, so it never gets a statement"
        : "No open company invoices for that company",
      404,
      notChased ? "not_chased" : "not_found",
    );
  }
  const entries = book.entries.filter((e) =>
    e.companyKey === companyKey && e.open && e.day >= 1 && !e.notChased
  ).sort((a, b) => b.day - a.day);
  return { company, entries, statements };
}

async function statementLines(
  deps: DebtWsDeps,
  entries: BookEntry[],
): Promise<StatementLine[]> {
  const budget = { left: DEBT_WS_PAY_LINK_FETCH_LIMIT };
  const out: StatementLine[] = [];
  for (const e of entries) {
    out.push({
      xero_invoice_id: e.inv.xero_invoice_id,
      invoice_number: e.inv.invoice_number,
      job_ref: e.job?.job_number
        ? [e.job.job_number, e.job.site_address].filter(Boolean).join(", ")
        : e.inv.reference,
      invoice_date: e.inv.invoice_date,
      amount: e.row.amount_due,
      days_overdue: e.day,
      pay_link: await payLinkFor(deps, e, budget),
    });
  }
  return out;
}

function statementView(
  company: CompanyView,
  weekStart: string,
  lines: StatementLine[],
) {
  const total = Math.round(lines.reduce((s, l) => s + l.amount * 100, 0)) / 100;
  return {
    company_key: company.company_key,
    name: company.name,
    week_start: weekStart,
    to_email: company.to_email,
    status: company.statement.status,
    subject: statementSubject(company.name, weekStart),
    invoices: lines,
    total,
    html: statementHtml({
      company_name: company.name,
      week_start: weekStart,
      lines,
    }),
  };
}

function companyKeyParam(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    bad("company_key is required");
  }
  return value.trim().toLowerCase();
}

export async function debtWsStatementPreview(
  deps: DebtWsDeps,
  params: URLSearchParams,
) {
  const book = await loadBook(deps.store, { now: deps.now() });
  // An alias contact id reads as its canonical company.
  const key = canonicalCompanyKey(
    companyKeyParam(params.get("company_key")),
    book.settings.company_aliases,
  );
  const { company, entries } = await statementFor(deps, book, key);
  const lines = await statementLines(deps, entries);
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    perth_date: book.today,
    sending_on: debtWsSendingOn(book.settings),
    ...statementView(company, mondayOf(book.today), lines),
  };
}

/** One statement invoice with a possible payment in the bank feed. */
interface StatementPossiblePayment {
  xero_invoice_id: string;
  invoice_number: string | null;
  possible_payments: PossiblePayment[];
}

export async function debtWsStatementSend(
  deps: DebtWsDeps,
  caller: DebtWsCaller,
  rawBody: unknown,
) {
  const body = asBody(rawBody);
  onlyKeys(body, ["company_key", "override_possible_payment"]);
  const rawKey = companyKeyParam(body.company_key);
  if (
    body.override_possible_payment !== undefined &&
    typeof body.override_possible_payment !== "boolean"
  ) bad("override_possible_payment must be true or false");
  const override = body.override_possible_payment === true;
  const actor = await actorOf(deps, caller);
  const book = await loadBook(deps.store, { now: deps.now() });
  const key = canonicalCompanyKey(rawKey, book.settings.company_aliases);
  const weekStart = mondayOf(book.today);
  const refuseStatement = async (
    code: string,
    message: string,
    status = 409,
    details: Record<string, unknown> = {},
  ): Promise<never> => {
    await log(
      deps,
      { share_key: key, ids: [], job_id: null },
      actor,
      "send_refused",
      {
        body: message,
        meta: { code, week_start: weekStart, statement: true, ...details },
      },
    ).catch(() => {});
    throw new DebtWsError(message, status, code, details);
  };
  if (!debtWsSendingOn(book.settings)) {
    await refuseStatement(
      "sending_off",
      "Sending is off until you switch it on",
    );
  }
  const { company, entries } = await statementFor(deps, book, key);
  if (!company.to_email) {
    await refuseStatement("no_email", "No accounts email set for this company");
  }
  if (company.statement.status === "sent") {
    await refuseStatement(
      "already_sent",
      "This week's statement was already sent",
    );
  }
  if (!entries.length) {
    await refuseStatement("nothing_due", "Nothing on this company is past due");
  }

  const claim = await deps.store.claimStatement({
    company_key: key,
    week_start: weekStart,
    xero_invoice_ids: entries.map((e) => e.inv.xero_invoice_id),
    total: Math.round(entries.reduce((s, e) => s + e.row.amount_due * 100, 0)) /
      100,
    to_email: company.to_email!,
    approved_by: actor.label,
  });
  if (!claim) {
    await refuseStatement(
      "already_sent",
      "This week's statement was already sent",
    );
  }
  /** Releases the claim (refused), then refuses with the reason. */
  const release = async (
    code: string,
    message: string,
    status = 409,
    details: Record<string, unknown> = {},
  ): Promise<never> => {
    await deps.store.settleStatement(claim!.id, {
      status: "refused",
      error: code,
    }).catch(() => {});
    return await refuseStatement(code, message, status, details);
  };

  // The live re-check: drop anything Xero shows paid or no longer open. A failed read
  // refuses; it never falls back to our copy.
  let kept = entries;
  try {
    const live = await deps.readInvoices(
      entries.map((e) => e.inv.xero_invoice_id),
    );
    const byId = new Map(
      live.map((inv) => [String(inv.InvoiceID ?? "").toLowerCase(), inv]),
    );
    kept = entries.filter((e) => {
      const inv = byId.get(e.inv.xero_invoice_id);
      return inv && inv.Status === "AUTHORISED" && Number(inv.AmountDue) > 0;
    }).map((e) => {
      const inv = byId.get(e.inv.xero_invoice_id)!;
      e.row.amount_due = Number(inv.AmountDue);
      return e;
    });
  } catch (_) {
    return await release(
      "xero_unavailable",
      "Xero could not be read for the last check, so the statement was not sent",
      503,
    );
  }
  if (!kept.length) {
    return await release(
      "nothing_due",
      "Xero shows everything on this statement paid",
    );
  }

  // The bank-feed check on every invoice kept (spec section 6.5): any possible payment
  // refuses the statement, listing which invoices, unless the owner sends anyway.
  const feed = await bankFeedSafe(
    deps,
    kept.map((e) => bankFromOf(e.inv)),
  );
  const flagged: StatementPossiblePayment[] = [];
  for (const e of kept) {
    const payments = bankCheck(feed, {
      ...e.inv,
      amount_due: e.row.amount_due,
    }, payerNames(e));
    if (!payments) {
      return await release(
        "bank_check_unavailable",
        "The bank feed could not be read, so the statement was not sent. Try again shortly",
        503,
      );
    }
    if (payments.length) {
      flagged.push({
        xero_invoice_id: e.inv.xero_invoice_id,
        invoice_number: e.inv.invoice_number,
        possible_payments: payments,
      });
    }
  }
  if (flagged.length && !override) {
    return await release(
      "possible_payment",
      `There may already be a payment for ${
        flagged.map((f) => f.invoice_number ?? f.xero_invoice_id).join(", ")
      }. Match it in Xero, or send anyway`,
      409,
      { possible_payments: flagged },
    );
  }

  const lines = await statementLines(deps, kept);
  const view = statementView(company, weekStart, lines);
  let result: Awaited<ReturnType<DebtWsDeps["sendEmail"]>>;
  try {
    result = await deps.sendEmail({
      from: DEBT_WS_STATEMENT_FROM,
      to: company.to_email!,
      subject: view.subject,
      htmlBody: view.html,
      signature: DEBT_WS_STATEMENT_SIGNATURE,
    });
  } catch (error) {
    // The email may have gone: the claim stays (status sending) so it never sends twice.
    await deps.store.settleStatement(claim!.id, {
      error: `not confirmed: ${
        String((error as Error)?.message ?? error).slice(0, 300)
      }`,
      html: view.html,
    }).catch(() => {});
    throw new DebtWsError(
      "The email could not be confirmed. It stays claimed for this week so it cannot send twice; check the admin mailbox",
      502,
      "send_not_confirmed",
    );
  }
  if (!result.ok) {
    await deps.store.settleStatement(claim!.id, {
      status: "failed",
      error: String(result.error ?? `email ${result.status}`).slice(0, 500),
      html: view.html,
    }).catch(() => {});
    throw new DebtWsError(
      `The email was refused (${result.status}). Nothing was sent`,
      502,
      "email_failed",
      { email_status: result.status },
    );
  }
  const sentAt = deps.now().toISOString();
  await deps.store.settleStatement(claim!.id, {
    status: "sent",
    sent_at: sentAt,
    html: view.html,
    xero_invoice_ids: lines.map((l) => l.xero_invoice_id),
    total: view.total,
  });
  const overridden = override && flagged.length > 0;
  await log(
    deps,
    {
      share_key: key,
      ids: lines.map((l) => l.xero_invoice_id),
      job_id: null,
    },
    actor,
    "statement_sent",
    {
      body:
        `Statement emailed to ${company.to_email}: ${lines.length} invoice(s), $${
          view.total.toFixed(2)
        }`,
      meta: {
        statement_id: claim!.id,
        week_start: weekStart,
        to: company.to_email,
        override_possible_payment: overridden,
        ...(overridden ? { possible_payments: flagged } : {}),
      },
    },
  );
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    sent: true,
    statement_id: claim!.id,
    company_key: key,
    week_start: weekStart,
    to_email: company.to_email,
    invoices: lines.length,
    total: view.total,
    sent_at: sentAt,
    override_possible_payment: overridden,
  };
}

// ── Jan's visit list ──

/** An Australian mobile in any common shape as +614XXXXXXXX, or null. */
export function normaliseAuMobile(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || !/^[+\d\s().-]+$/.test(text)) return null;
  let d = text.replace(/\D/g, "");
  if (text.startsWith("+") || (d.startsWith("61") && d.length === 11)) {
    if (!d.startsWith("61")) return null;
    d = `0${d.slice(2)}`;
  }
  return /^04\d{8}$/.test(d) ? `+61${d.slice(1)}` : null;
}

/** Jan's mobile: the one staff record whose first name is Jan. */
export async function janMobile(
  store: DebtWsStore,
): Promise<
  { phone: string | null; name: string | null; problem: string | null }
> {
  const staff = (await store.janStaff()).filter((u) =>
    String(u.name ?? "").trim().split(/\s+/)[0].toLowerCase() === "jan"
  );
  if (!staff.length) {
    return { phone: null, name: null, problem: "No staff record is named Jan" };
  }
  const phones = new Set(staff.map((u) => normaliseAuMobile(u.phone)));
  if (phones.size === 1 && !phones.has(null)) {
    return {
      phone: [...phones][0],
      name: staff[0].name ?? null,
      problem: null,
    };
  }
  return {
    phone: null,
    name: null,
    problem: staff.length > 1
      ? "Several staff records are named Jan, with different or missing mobiles"
      : "Add an Australian mobile to Jan's staff record",
  };
}

function janVisitParam(params: URLSearchParams | null, today: string): string {
  const v = params?.get("visit_date");
  if (!v) return nextMonday(today);
  if (!isIsoDate(v)) bad("visit_date must be YYYY-MM-DD");
  return v;
}

export async function debtWsJanList(
  deps: DebtWsDeps,
  params: URLSearchParams,
) {
  const book = await loadBook(deps.store, { now: deps.now() });
  const visitDate = janVisitParam(params, book.today);
  const row = visitDate === book.janVisitDate
    ? book.janRow
    : await deps.store.janList(visitDate);
  const live = !row || row.status === "open";
  const items: JanListItem[] = live
    ? (visitDate === book.janVisitDate ? janItemsLive(book) : [])
    : (row!.items as JanListItem[]);
  const mobile = await janMobile(deps.store).catch(() => ({
    phone: null,
    name: null,
    problem: "The staff records could not be read",
  }));
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    visit_date: visitDate,
    lock_at: `${addDays(visitDate, -3)}T09:00:00+08:00`,
    send_at: `${addDays(visitDate, -1)}T19:00:00+08:00`,
    status: row?.status ?? "open",
    live,
    count: items.length,
    amount: Math.round(items.reduce((s, i) => s + i.amount * 100, 0)) / 100,
    items,
    removed_share_keys: row?.removed_share_keys ?? [],
    locked_at: row?.locked_at ?? null,
    sent_at: row?.sent_at ?? null,
    error: row?.error ?? null,
    auto_send_on: book.settings.jan_list_auto_send,
    sending_on: debtWsSendingOn(book.settings),
    jan: {
      name: mobile.name,
      mobile_set: !!mobile.phone,
      problem: mobile.problem,
    },
    text_preview: items.length ? janListText(visitDate, items) : null,
  };
}

export async function debtWsJanListRemove(
  deps: DebtWsDeps,
  caller: DebtWsCaller,
  rawBody: unknown,
) {
  const body = asBody(rawBody);
  onlyKeys(body, ["share_key", "visit_date"]);
  const shareKey = uuidOf(body.share_key, "share_key");
  const actor = await actorOf(deps, caller);
  const today = perthDate(deps.now());
  const visitDate = body.visit_date === undefined
    ? nextMonday(today)
    : isIsoDate(body.visit_date)
    ? body.visit_date
    : bad("visit_date must be YYYY-MM-DD");
  const row = await deps.store.ensureJanList(visitDate);
  if (!["open", "locked"].includes(row.status)) {
    throw new DebtWsError(
      `This week's list is already ${row.status}`,
      409,
      "jan_list_closed",
    );
  }
  const removed = [...new Set([...row.removed_share_keys, shareKey])];
  const items = (row.items as JanListItem[]).filter((i) =>
    i.share_key !== shareKey
  );
  const ok = await deps.store.updateJanList(visitDate, ["open", "locked"], {
    removed_share_keys: removed,
    ...(row.status === "locked" ? { items } : {}),
  });
  if (!ok) {
    throw new DebtWsError(
      "The list changed while removing; read it again",
      409,
      "jan_list_changed",
    );
  }
  await log(
    deps,
    { share_key: shareKey, ids: [shareKey], job_id: null },
    actor,
    "jan_list",
    {
      body: `Removed from Jan's visit list for ${longDate(visitDate)}`,
      meta: { visit_date: visitDate, removed: true },
    },
  );
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    visit_date: visitDate,
    removed_share_keys: removed,
  };
}

export async function debtWsJanListLock(deps: DebtWsDeps) {
  const now = deps.now();
  const settings = await deps.store.settings();
  const visitDate = nextMonday(perthDate(now));
  if (!settings.jan_list_auto_send) {
    return {
      ok: true,
      version: DEBT_WS_VERSION,
      skipped: true,
      reason: "jan_list_auto_send_off",
      visit_date: visitDate,
    };
  }
  const book = await loadBook(deps.store, { now });
  const row = await deps.store.ensureJanList(visitDate);
  if (row.status !== "open") {
    return {
      ok: true,
      version: DEBT_WS_VERSION,
      skipped: true,
      reason: `already_${row.status}`,
      visit_date: visitDate,
    };
  }
  const removed = new Set(row.removed_share_keys);
  const items = janItemsLive(book).filter((i) => !removed.has(i.share_key));
  const locked = await deps.store.updateJanList(visitDate, ["open"], {
    status: "locked",
    items,
    locked_at: now.toISOString(),
  });
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    locked,
    visit_date: visitDate,
    count: items.length,
  };
}

export async function debtWsJanListSend(deps: DebtWsDeps) {
  const now = deps.now();
  const settings = await deps.store.settings();
  const visitDate = nextMonday(perthDate(now));
  const off = !settings.jan_list_auto_send
    ? "jan_list_auto_send_off"
    : !debtWsSendingOn(settings)
    ? "sending_off"
    : null;
  if (off) {
    return {
      ok: true,
      version: DEBT_WS_VERSION,
      skipped: true,
      reason: off,
      visit_date: visitDate,
    };
  }
  const row = await deps.store.janList(visitDate);
  if (!row || row.status !== "locked") {
    return {
      ok: true,
      version: DEBT_WS_VERSION,
      skipped: true,
      reason: row ? `status_${row.status}` : "not_locked",
      visit_date: visitDate,
    };
  }
  const claimed = await deps.store.updateJanList(visitDate, ["locked"], {
    status: "sending",
  });
  if (!claimed) {
    return {
      ok: true,
      version: DEBT_WS_VERSION,
      skipped: true,
      reason: "already_sending",
      visit_date: visitDate,
    };
  }
  const dropped: Array<
    { share_key: string; xero_invoice_id: string; code: string }
  > = [];
  const fail = async (
    error: string,
    status: "failed" | "skipped" = "failed",
  ) => {
    await deps.store.updateJanList(visitDate, ["sending"], { status, error });
    return {
      ok: status === "skipped",
      version: DEBT_WS_VERSION,
      sent: false,
      status,
      reason: error,
      visit_date: visitDate,
      dropped,
    };
  };

  // Drop anyone paid since the lock, read live from Xero. A failed live read fails the
  // list closed: it is never sent from our copy (spec section 4).
  const items = (row.items as JanListItem[]).filter((i) =>
    !row.removed_share_keys.includes(i.share_key)
  );
  let open: JanListItem[];
  try {
    const live = await deps.readInvoices(items.map((i) => i.xero_invoice_id));
    const byId = new Map(
      live.map((inv) => [String(inv.InvoiceID ?? "").toLowerCase(), inv]),
    );
    open = items.filter((i) => {
      const inv = byId.get(i.xero_invoice_id);
      return inv && inv.Status === "AUTHORISED" && Number(inv.AmountDue) > 0;
    }).map((i) => ({
      ...i,
      amount: Number(byId.get(i.xero_invoice_id)!.AmountDue),
    }));
  } catch (_) {
    return await fail("xero_unavailable");
  }
  if (!open.length) return await fail("nobody left to visit", "skipped");

  // The bank-feed check on every item left (spec section 6.6): a possible payment drops
  // that item, logged against its share, and the rest still go to Jan. No feed at all
  // fails the list closed.
  let copy: Map<string, WsInvoice>;
  let clients: Map<string, string | null>;
  try {
    const invoices = await deps.store.invoicesByIds(
      open.map((i) => i.xero_invoice_id),
    );
    copy = new Map(invoices.map((i) => [i.xero_invoice_id, i]));
    const jobIds = [
      ...new Set(invoices.map((i) => i.job_id).filter((j): j is string => !!j)),
    ];
    const jobs = jobIds.length ? await deps.store.jobs(jobIds) : [];
    clients = new Map(jobs.map((j) => [String(j.id), j.client_name]));
  } catch (_) {
    return await fail("bank_check_unavailable");
  }
  const feed = await bankFeedSafe(
    deps,
    open.map((i) => {
      const inv = copy.get(i.xero_invoice_id);
      return inv ? bankFromOf(inv) : null;
    }),
  );
  if (!feed) return await fail("bank_check_unavailable");
  const actor: Actor = { user_id: null, label: "cron" };
  const kept: JanListItem[] = [];
  for (const item of open) {
    const inv = copy.get(item.xero_invoice_id) ?? null;
    const payments = inv
      ? bankCheck(feed, { ...inv, amount_due: item.amount }, [
        inv.contact_name,
        inv.job_id ? clients.get(String(inv.job_id)) : null,
      ])
      : null;
    if (payments && !payments.length) {
      kept.push(item);
      continue;
    }
    const code = payments ? "possible_payment" : "bank_check_unavailable";
    const first = payments?.[0];
    const message = first
      ? `Dropped from Jan's visit list for ${
        longDate(visitDate)
      }: there may already be a payment: ${first.date ?? "a recent date"}, $${
        first.amount.toFixed(2)
      } from ${first.payer_text} (${first.reason}). Match it in Xero`
      : `Dropped from Jan's visit list for ${
        longDate(visitDate)
      }: the bank feed could not be checked for this invoice`;
    dropped.push({
      share_key: item.share_key,
      xero_invoice_id: item.xero_invoice_id,
      code,
    });
    await log(
      deps,
      {
        share_key: item.share_key,
        ids: [item.xero_invoice_id],
        job_id: inv?.job_id ?? null,
      },
      actor,
      "send_refused",
      {
        step: "d21",
        body: message,
        meta: {
          code,
          visit_date: visitDate,
          jan_list: true,
          possible_payments: payments ?? [],
        },
      },
    ).catch(() => {});
  }
  if (!kept.length) return await fail("nobody left to visit", "skipped");
  const mobile = await janMobile(deps.store);
  if (!mobile.phone) return await fail(mobile.problem ?? "jan_mobile_not_set");
  const text = janListText(visitDate, kept);
  const sent = await deps.sendStaffSms(mobile.phone, text);
  if (!sent.accepted || !sent.messageId) {
    return await fail(sent.failureReason ?? "SMS not accepted");
  }
  await deps.store.updateJanList(visitDate, ["sending"], {
    status: "sent",
    sent_at: deps.now().toISOString(),
    items: kept,
    provider_message_id: sent.messageId,
    error: null,
  });
  for (const item of kept) {
    await log(
      deps,
      {
        share_key: item.share_key,
        ids: [item.xero_invoice_id],
        job_id: copy.get(item.xero_invoice_id)?.job_id ?? null,
      },
      actor,
      "jan_list",
      {
        step: "d21",
        body: `Sent to Jan for the visit on ${longDate(visitDate)}`,
        meta: { visit_date: visitDate, provider_message_id: sent.messageId },
      },
    ).catch(() => {});
  }
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    sent: true,
    visit_date: visitDate,
    count: kept.length,
    provider_message_id: sent.messageId,
    dropped,
  };
}

// ── The agent ──

function trimStory(story: unknown): unknown {
  if (!story || typeof story !== "object" || Array.isArray(story)) return story;
  const out: Record<string, unknown> = {
    ...(story as Record<string, unknown>),
  };
  for (const heavy of ["events", "changes", "checks", "meta", "loops"]) {
    delete out[heavy];
  }
  for (const [k, v] of Object.entries(out)) {
    if (Array.isArray(v) && v.length > 20) out[k] = v.slice(-20);
  }
  return out;
}

/**
 * What the agent is told about held messages (14 Oct 2026 review). A held message with
 * several candidate jobs is one customer's text that could be about any of their jobs
 * (SWF-26337: 51 held against 1 placed), and the same text shows on every candidate's
 * debt card. Enforced in debtWsAgentSubmit, not only said here.
 */
export const DEBT_WS_HELD_MESSAGE_RULE =
  "A message marked unplaced is held on no job. When its candidate_job_count is more " +
  "than 1 it is marked context_only: it may be about another of this customer's jobs, " +
  "so use it as context only. Never base a move (says_paid or rectification) on it; " +
  "flag it to Shaun instead. A move resting on one is turned into a flag.";

/** The number of jobs a held message could belong to, or null when not given. */
function heldCandidateCount(m: Record<string, unknown>): number | null {
  const n = m.candidate_job_count;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Held on no job and not known to be this job's alone: any held message whose
 * candidate count is not exactly 1. A single-candidate held message (SWF-261098) is
 * treated like a placed one.
 */
function heldOnSeveralJobs(m: Record<string, unknown>): boolean {
  return m.unplaced === true && heldCandidateCount(m) !== 1;
}

function agentMessage(m: Record<string, unknown>) {
  const channel = String(m.channel ?? "");
  return {
    id: m.id ?? null,
    at: m.occurred_at ?? null,
    direction: m.direction ?? null,
    type: channel || null,
    from: m.author ?? m.who ?? null,
    body: m.body ?? m.preview ?? "",
    transcript: channel === "call" ? m.body ?? null : null,
    // Held on no job by the placement ladder (this job one of its candidates), with
    // how many jobs it could belong to. More than one: context only.
    ...(m.unplaced === true
      ? {
        unplaced: true,
        candidate_job_count: heldCandidateCount(m),
        ...(heldOnSeveralJobs(m) ? { context_only: true } : {}),
      }
      : {}),
  };
}

/** A message's time in ms, or -Infinity when it has none that parses. */
function agentMessageTime(m: { at: unknown }): number {
  const t = Date.parse(String(m.at ?? ""));
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Oldest first by parsed time (a "...Z" and a "...+00:00" stamp of one instant are
 * equal; comparing the strings put the Z copy later). At the same instant a held
 * message (unplaced) goes after an unmarked one, so the newest-inbound pick
 * (moveHeldProblem) takes the held copy: SWF-261423, a call held on 2 jobs whose
 * call log and transcript share one instant. Otherwise the read's order is kept.
 */
export function compareAgentMessagesOldestFirst(
  a: { at: unknown; unplaced?: unknown },
  b: { at: unknown; unplaced?: unknown },
): number {
  const ta = agentMessageTime(a);
  const tb = agentMessageTime(b);
  if (ta !== tb) return ta === -Infinity ? -1 : tb === -Infinity ? 1 : ta - tb;
  return (a.unplaced === true ? 1 : 0) - (b.unplaced === true ? 1 : 0);
}

/**
 * The payer's own messages as the agent sees them, oldest first: read wider than kept,
 * only the payer's messages handed over. The queue builds the bundle from this and
 * the submit checks a move against the same read. With onFail "throw" a failed read
 * of the held messages throws too (held_read_failed), so a move is never checked
 * against a read missing them.
 */
async function payerAgentMessages(
  deps: DebtWsDeps,
  book: Awaited<ReturnType<typeof loadBook>>,
  entry: BookEntry,
  onFail: "empty" | "throw",
) {
  const conversation = await deps.conversation(
    entry.job!.id,
    DEBT_WS_AGENT_MESSAGES * 2,
    extraContactIds(entry),
    heldContactIds(entry),
  ).catch((error) => {
    if (onFail === "throw") throw error;
    return {
      messages: [] as Record<string, unknown>[],
      held_read_failed: undefined as boolean | undefined,
    };
  });
  if (onFail === "throw" && conversation.held_read_failed === true) {
    throw new Error("The payer's held messages could not be read");
  }
  const split = splitConversation(
    conversation.messages ?? [],
    entry.payer,
    partiesOf(entry.job, book.contacts.get(String(entry.job!.id)) ?? []),
  );
  const messages = [...split.payer_messages].slice(
    0,
    DEBT_WS_AGENT_MESSAGES,
  ).map(agentMessage).sort(compareAgentMessagesOldestFirst);
  return { messages, reason: split.reason };
}

/**
 * Why a move may not stand, or null. The agent cites no message ids, so which message
 * backs a move is not recorded. The rule used: a move answers what the payer said last,
 * so it may not stand while the payer's NEWEST inbound message is held with more than
 * one candidate job (nothing the payer said since the last message known to be this
 * job's). The move is kept as a flag to Shaun instead.
 */
function moveHeldProblem(
  messages: ReturnType<typeof agentMessage>[],
): { message_id: unknown; candidate_job_count: number | null } | null {
  const newest = messages.filter((m) =>
    String(m.direction ?? "").toLowerCase() === "inbound"
  ).at(-1);
  if (!newest || !heldOnSeveralJobs(newest as Record<string, unknown>)) {
    return null;
  }
  return {
    message_id: newest.id,
    candidate_job_count: heldCandidateCount(newest as Record<string, unknown>),
  };
}

function needsAgent(
  entry: BookEntry,
  evidenceAt: string | null,
): { due: boolean; evidence: boolean } {
  const reviewed = entry.state?.agent_reviewed_at ?? null;
  const step = entry.row.step_due?.step ?? null;
  let due = false;
  if (isTextStep(step)) {
    const suggested = entry.suggestions.some((s) =>
      s.source === "agent" && s.cycle_start === entry.dayZero && s.step === step
    );
    const reviewedSince = !!reviewed &&
      (perthDateOf(reviewed) ?? "") >= stepDate(entry.dayZero, step);
    due = !suggested && !reviewedSince;
  }
  const since = reviewed ?? `${entry.dayZero}T00:00:00+08:00`;
  const evidence = !!evidenceAt && Date.parse(evidenceAt) > Date.parse(since);
  return { due, evidence };
}

export async function debtWsAgentQueue(deps: DebtWsDeps) {
  const now = deps.now();
  const book = await loadBook(deps.store, { now });
  const base = {
    ok: true,
    version: DEBT_WS_VERSION,
    perth_date: book.today,
    playbook_version: DEBT_WS_PLAYBOOK_VERSION,
    agent_on: book.settings.agent_enabled,
    /** "bank_feed_unavailable": nothing is handed out until the bank feed reads again. */
    blocked: null as string | null,
  };
  if (!book.settings.agent_enabled) return { ...base, items: [], more: false };
  const candidates = book.entries.filter((e) =>
    e.open && e.kind !== "account" && !e.notChased && e.category !== null &&
    e.job
  );
  // Every item carries its bank-feed check (spec section 6), so without the feed the
  // queue hands out nothing rather than items that may already be paid.
  const bank = candidates.length
    ? await bankFeedSafe(deps, candidates.map((e) => bankFromOf(e.inv)))
    : null;
  if (candidates.length && !bank) {
    return {
      ...base,
      items: [],
      more: false,
      blocked: "bank_feed_unavailable",
    };
  }
  const jobIds = [...new Set(candidates.map((e) => e.job!.id))];
  const oldest = candidates.reduce((m, e) => {
    const since = e.state?.agent_reviewed_at ??
      `${e.dayZero}T00:00:00+08:00`;
    return !m || Date.parse(since) < Date.parse(m) ? since : m;
  }, "" as string);
  const evidence = jobIds.length && oldest
    ? await deps.store.evidenceSince(
      jobIds,
      new Date(Date.parse(oldest)).toISOString(),
    )
    : [];
  const evidenceBy = new Map(evidence.map((e) => [e.job_id, e.at]));
  const queued = candidates.map((e) => ({
    entry: e,
    why: needsAgent(e, evidenceBy.get(e.job!.id) ?? null),
  })).filter((q) => q.why.due || q.why.evidence);
  // An invoice the feed does not reach back to waits for a later round.
  const checkable = queued.filter((q) =>
    bankCovers(bank!, bankFromOf(q.entry.inv))
  );
  const take = checkable.slice(0, DEBT_WS_AGENT_QUEUE_LIMIT);
  const budget = { left: DEBT_WS_PAY_LINK_FETCH_LIMIT };
  const items = [];
  for (const { entry, why } of take) {
    const [story, split] = await Promise.all([
      deps.story(entry.job!.id).catch(() => ({
        story: null,
        status: { ok: false, state: "failed" },
      })),
      payerAgentMessages(deps, book, entry, "empty"),
    ]);
    const payLink = await payLinkFor(deps, entry, budget);
    const messages = split.messages;
    const greeting = await greetingNameFor(deps, entry);
    const draft = templateDraftFor(entry, payLink, greeting.name);
    items.push({
      row: entry.row,
      // Who owes it: the agent writes to this person, by this name.
      payer_contact: payerView(entry.payer, greeting),
      conversation_reason: split.reason,
      send_block: payerSendBlock(entry),
      template_draft: draft
        ? {
          step: draft.step,
          kind: draft.kind,
          channel: draft.channel,
          text: draft.text,
          why: draft.why,
          source: draft.source,
          proposed_category: null,
        }
        : null,
      story: trimStory(story.story),
      story_status: story.status ?? null,
      messages,
      held_message_rule: DEBT_WS_HELD_MESSAGE_RULE,
      notes: entry.logs.map(noteView),
      possible_payments: bankCheck(bank, entry.inv, payerNames(entry)) ?? [],
      possible_payments_status: "ok",
      queued_because: {
        step_due_without_suggestion: why.due,
        new_evidence: why.evidence,
      },
      playbook_version: DEBT_WS_PLAYBOOK_VERSION,
    });
  }
  return { ...base, items, more: queued.length > take.length };
}

export async function debtWsAgentSubmit(
  deps: DebtWsDeps,
  caller: DebtWsCaller,
  rawBody: unknown,
) {
  const body = asBody(rawBody);
  onlyKeys(body, [
    "xero_invoice_id",
    "xero_invoice_ids",
    "step",
    "kind",
    "channel",
    "text",
    "why",
    "proposed_category",
    "agent_version",
  ]);
  const ids = body.xero_invoice_ids !== undefined
    ? (Array.isArray(body.xero_invoice_ids) && body.xero_invoice_ids.length &&
        body.xero_invoice_ids.length <= 20
      ? body.xero_invoice_ids.map((v) => uuidOf(v, "xero_invoice_ids"))
      : bad("xero_invoice_ids must list 1 to 20 invoice ids"))
    : [uuidOf(body.xero_invoice_id, "xero_invoice_id")];
  const kind = body.kind;
  if (!["draft", "move", "flag", "no_action"].includes(String(kind))) {
    bad('kind must be "draft", "move", "flag" or "no_action"');
  }
  const agentVersion = optionalText(body.agent_version, "agent_version", 64);
  const actor = caller.kind === "server"
    ? { user_id: null, label: "agent" }
    : await actorOf(deps, caller);

  const book = await loadBook(deps.store, {
    now: deps.now(),
    invoiceIds: ids,
  });
  const entries = ids.map((id) =>
    book.entries.find((e) => e.inv.xero_invoice_id === id)
  );
  const entry = entries[0];
  if (!entry || entries.some((e) => !e)) {
    throw new DebtWsError(
      "That invoice is not in the debt book",
      404,
      "not_in_book",
    );
  }
  if (entry.kind === "account") {
    bad("The agent works the homeowner side only");
  }
  if (entries.some((e) => e!.cls.share !== entry.cls.share)) {
    bad("Every invoice in one suggestion must be on the same share");
  }
  const stamp = () =>
    deps.store.upsertState(entry.row.share_key, {
      agent_reviewed_at: deps.now().toISOString(),
    });

  if (kind === "no_action") {
    await stamp();
    return {
      ok: true,
      version: DEBT_WS_VERSION,
      kind: "no_action",
      suggestion: null,
      agent_reviewed_at: deps.now().toISOString(),
    };
  }

  const step = body.step ?? null;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const why = optionalText(body.why, "why", 1000);
  if (!why) bad("why is required: one to three sentences for Shaun");
  const whyStyle = styleProblem(why);
  if (whyStyle) bad(`why: ${whyStyle}`, "text_not_allowed");
  const proposed = body.proposed_category ?? null;

  if (kind === "draft" || kind === "move") {
    if (body.channel !== "sms") bad("channel must be sms");
    const problem = clientTextProblem(text);
    if (problem) bad(problem, "text_not_allowed");
    if (kind === "draft") {
      if (proposed !== null) bad("A draft has no proposed_category");
      if (isTextStep(step)) {
        if (entry.row.step_due?.step !== step) {
          throw new DebtWsError(
            "That step is not due now",
            409,
            "step_not_due",
          );
        }
      } else if (!isReplyStep(step)) {
        bad("A draft's step is the due step (d1 to d17) or a reply step");
      }
    } else {
      if (proposed !== "says_paid" && proposed !== "rectification") {
        bad('A move needs proposed_category "says_paid" or "rectification"');
      }
      if (!isReplyStep(step)) bad("A move's step is a reply step");
    }
  } else {
    if (step !== null && !isLadderStep(step) && !isReplyStep(step)) {
      bad("A flag's step is the due step, a reply step, or null");
    }
    if (!text) bad("A flag needs its note to Shaun in text");
    if (text.length > 4000) bad("text is longer than 4000 characters");
    const style = styleProblem(text);
    if (style) bad(style, "text_not_allowed");
    if (proposed !== null) bad("A flag has no proposed_category");
  }

  // A move may not rest on a message held with several candidate jobs: it may be about
  // another of the customer's jobs (14 Oct 2026 review). Checked against the same read
  // the agent's bundle comes from; the move is kept as a flag to Shaun.
  let finalKind = kind as "draft" | "move" | "flag";
  let finalText = text;
  let finalProposed = proposed as "says_paid" | "rectification" | null;
  let moveRefused: Record<string, unknown> | null = null;
  if (kind === "move" && entry.job) {
    const read = await payerAgentMessages(deps, book, entry, "throw")
      .catch(() => {
        throw new DebtWsError(
          "The payer's messages could not be read to check this move. Try again.",
          503,
          "conversation_unreadable",
        );
      });
    const problem = moveHeldProblem(read.messages);
    if (problem) {
      const count = problem.candidate_job_count;
      const label = proposed === "says_paid" ? "Says paid" : "Rectification";
      moveRefused = {
        reason: "held_message_several_jobs",
        proposed_category: proposed,
        message_id: problem.message_id,
        candidate_job_count: count,
      };
      finalKind = "flag";
      finalProposed = null;
      finalText =
        `The agent suggested moving this to ${label}, but the payer's ` +
        `newest message is held on no job and could belong to ` +
        `${
          count !== null ? `any of ${count} jobs` : "another job"
        }, so it may be ` +
        `about another job. Check it before moving.\n\nThe agent's draft reply was:` +
        `\n\n${text}`;
    }
  }

  const suggestion = await deps.store.insertSuggestion({
    share_key: entry.row.share_key,
    xero_invoice_ids: ids,
    job_id: entry.job?.id ?? null,
    cycle_start: entry.dayZero,
    step: step as string | null,
    kind: finalKind,
    channel: finalKind === "flag" ? null : "sms",
    text: finalText,
    why,
    proposed_category: finalProposed,
    amount: Math.round(
      entries.reduce((s, e) => s + e!.row.amount_due * 100, 0),
    ) / 100,
    source: "agent",
    agent_version: agentVersion,
  });
  if (finalKind === "flag") {
    await log(
      deps,
      {
        share_key: entry.row.share_key,
        ids,
        job_id: entry.job?.id ?? null,
      },
      actor,
      "agent_flag",
      {
        step: step as string | null,
        body: finalText,
        meta: {
          suggestion_id: suggestion.id,
          why,
          ...(moveRefused ? { move_refused: moveRefused } : {}),
        },
      },
    );
  } else {
    // A new draft or move replaces older pending drafts and moves; flags stay.
    await deps.store.supersedePending(
      entry.row.share_key,
      ["draft", "move"],
      suggestion.id,
    );
  }
  await stamp();

  // Stage 5 auto-send: every switch on, a plain ladder draft, no possible payment.
  let autoSend: Record<string, unknown> = { attempted: false };
  const settings = book.settings;
  if (
    kind === "draft" && isTextStep(step) && proposed === null &&
    settings.auto_send_steps[step] === true &&
    deps.env(DEBT_WS_AUTO_SEND_SWITCH) === "true" &&
    debtWsSendingOn(settings)
  ) {
    const bank = await bankFeedSafe(deps, [bankFromOf(entry.inv)]);
    const payments = bankCheck(bank, entry.inv, payerNames(entry));
    if (!payments || payments.length) {
      autoSend = {
        attempted: false,
        reason: payments ? "possible_payment" : "bank_check_unavailable",
      };
    } else {
      try {
        const sent = await guardedSend(deps, {
          book,
          entry,
          step,
          text,
          suggestion,
          actor: { user_id: null, label: "agent-auto" },
          operatorEmail: null,
          override: false,
          draftAmount: Number(suggestion.amount ?? entry.row.amount_due),
        });
        autoSend = { attempted: true, sent: true, send_id: sent.send_id };
      } catch (error) {
        autoSend = {
          attempted: true,
          sent: false,
          code: error instanceof DebtWsError ? error.code : "failed",
          reason: (error as Error)?.message ?? String(error),
        };
      }
    }
  }
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    kind: finalKind,
    ...(moveRefused ? { move_refused: moveRefused } : {}),
    suggestion: suggestionView(suggestion),
    auto_send: autoSend,
  };
}

// ── The debt report (Shaun approved 15 Oct 2026; README "The debt report") ──
//
// debt_ws_report      GET, staff:  the live report, built fresh on every read, with the
//                                  HTML view, who it goes to and when it last went.
// debt_ws_report_pdf  GET, staff:  the same report as a PDF (Download PDF).
// debt_ws_report_send POST, owner: emails the PDF to the report recipients (Marnin, cc
//                                  Shaun), built fresh at the moment of sending.
// debt_ws_report_auto POST, server key: the Wednesday 12:00 Perth cron. Does nothing
//                                  unless report_auto_send is on; one auto report per week.
//
// Consolidate first (Shaun, 16 Oct 2026: "it goes Wednesday at 12pm after consolidating the
// debt for that day"). Every report is built fresh from the tab's own book at the moment it
// is made, with the bank balances read live from Xero. The invoices come from our Xero copy,
// which xero-sync brings up to date every 15 minutes, and on a Wednesday the cron
// debt-ws-report-refresh runs one extra sync at 11:55 Perth so the copy is about five minutes
// old at 12:00 (20261016180000_debt_ws_report_wednesday.sql). A send, automatic or by hand,
// refuses when the copy is older than DEBT_WS_REPORT_MAX_COPY_AGE_MS or its age is unknown,
// so Marnin never gets a report built on stale debt.
//
// The report is internal: it holds every client's name and balance, so it only ever goes to
// our own domain. The recipients are checked here before every send (and the database
// refuses an outside address in the settings, and send-outlook-email refuses one too).

/** The one domain the debt report may be emailed to. */
export const DEBT_WS_REPORT_DOMAIN = "secureworkswa.com.au";
/** A second manual send within this long is refused as a double click. */
export const DEBT_WS_REPORT_RESEND_MS = 2 * 60_000;
/** The share_key the report's debt_ws_log rows sit on. */
export const DEBT_WS_REPORT_LOG_KEY = "debt-report";
/**
 * The oldest our Xero copy of invoices may be when a report is sent. The sync runs every
 * 15 minutes, so 20 minutes allows one run in flight; past that a run was missed.
 */
export const DEBT_WS_REPORT_MAX_COPY_AGE_MS = 20 * 60_000;
/** Who the automatic report says it came from (the email and the record). */
export const DEBT_WS_REPORT_AUTO_LABEL = "the Wednesday 12pm auto-send";

/**
 * Why a report must not be sent on this copy of the debt, or null when the copy is fresh:
 * its sync time is unknown, or it is older than DEBT_WS_REPORT_MAX_COPY_AGE_MS.
 */
export function reportCopyProblem(
  syncedAt: string | null,
  now: Date,
): string | null {
  const ms = syncedAt ? Date.parse(syncedAt) : NaN;
  if (!syncedAt || !Number.isFinite(ms)) {
    return "When our Xero copy of invoices was last synced is unknown, so the report cannot be sent";
  }
  if (now.getTime() - ms > DEBT_WS_REPORT_MAX_COPY_AGE_MS) {
    const syncedDay = perthDate(new Date(ms));
    const day = syncedDay === perthDate(now) ? "" : ` on ${longDate(syncedDay)}`;
    return `Our Xero copy of invoices was last synced at ${
      perthClock(syncedAt)
    } Perth time${day}, more than ${
      DEBT_WS_REPORT_MAX_COPY_AGE_MS / 60_000
    } minutes ago, so the report would not show today's debt. Wait for the next sync (every 15 minutes) and try again`;
  }
  return null;
}

const OWN_ADDRESS = /^[a-z0-9._%+-]+@secureworkswa\.com\.au$/;

/** True when every address is one of ours (lower case, @secureworkswa.com.au). */
export function reportAddressesInternal(addresses: string[]): boolean {
  return addresses.every((a) => OWN_ADDRESS.test(a));
}

/** "Marnin" from marnin@secureworkswa.com.au; "all" for more than one recipient. */
function reportGreeting(to: string[]): string {
  if (to.length !== 1) return "all";
  const local = to[0].split("@")[0].split(/[._-]/)[0] || "there";
  return local.charAt(0).toUpperCase() + local.slice(1);
}

/** The report, built fresh from the same reads the Debt tab makes, plus the extras. */
async function loadDebtReport(
  deps: DebtWsDeps,
  preparedBy: string,
): Promise<DebtReport> {
  const now = deps.now();
  // One read of the open invoices, shared by the book and the tie to Xero's total.
  const open = await deps.store.openInvoices();
  const book = await loadBook(deps.store, { now, openInvoices: open });
  const today = book.today;
  const [statements, payments, syncedAt, bank, feed, xeroCheck] = await Promise.all([
    deps.store.statementsForWeek(mondayOf(today)),
    // The extras never stop the report: a read that fails shows as "not read".
    deps.store.paymentsBetween(addDays(today, -29), today).catch((error) => {
      console.error("[debt_ws_report] payments unavailable", error?.name);
      return null;
    }),
    deps.store.lastInvoiceSync().catch(() => null),
    deps.bankSummary().then((accounts) => ({
      accounts,
      read_at: deps.now().toISOString(),
    })).catch((error) => {
      console.error("[debt_ws_report] bank summary unavailable", error?.name);
      return null;
    }),
    bankFeedSafe(
      deps,
      book.entries.filter((e) => e.open).map((e) => bankFromOf(e.inv)),
    ),
    xeroCheckFor(deps, now),
  ]);
  const paidJobIds = [
    ...new Set(
      (payments ?? []).map((p) => p.job_id).filter((id): id is string =>
        !!id && !book.jobs.has(String(id))
      ),
    ),
  ];
  const paymentJobs = new Map(book.jobs);
  if (paidJobIds.length) {
    for (const job of await deps.store.jobs(paidJobIds).catch(() => [])) {
      paymentJobs.set(String(job.id), job);
    }
  }
  const coversAll = !!feed &&
    book.entries.every((e) => bankCovers(feed, bankFromOf(e.inv)));
  return buildDebtReport({
    now,
    book,
    openInvoices: open,
    statements,
    payments,
    paymentJobs,
    bank,
    feed: feed ? { txs: feed.txs, truncated: feed.truncated || !coversAll } : null,
    syncedAt,
    preparedBy,
    xeroCheck,
  });
}

/** Who the report goes to, checked: our own domain only, at least one recipient. */
function reportAddresses(rs: DebtWsReportSettings | null): {
  to: string[];
  cc: string[];
  problem: { code: string; message: string } | null;
} {
  if (!rs) {
    return {
      to: [],
      cc: [],
      problem: {
        code: "debt_ws_read_failed",
        message: "The report settings could not be read",
      },
    };
  }
  const clean = (xs: string[]) =>
    [...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const to = clean(rs.recipients);
  const cc = clean(rs.cc).filter((x) => !to.includes(x));
  if (!to.length) {
    return {
      to,
      cc,
      problem: {
        code: "no_recipients",
        message: "No one is set to receive the report",
      },
    };
  }
  if (!reportAddressesInternal([...to, ...cc])) {
    return {
      to,
      cc,
      problem: {
        code: "recipient_not_internal",
        message:
          "The report only goes to SecureWorks Group addresses (@secureworkswa.com.au)",
      },
    };
  }
  return { to, cc, problem: null };
}

function reportSendView(row: WsReportRow | undefined | null) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    at: row.sent_at ?? row.created_at,
    to: row.to_emails ?? [],
    cc: row.cc_emails ?? [],
    by: row.sent_by_name,
    subject: row.subject,
    error: row.error,
  };
}

const bytesToBase64 = (bytes: Uint8Array) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
};

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function debtWsReport(deps: DebtWsDeps, caller: DebtWsCaller) {
  const actor = await actorOf(deps, caller);
  const report = await loadDebtReport(deps, actor.label);
  const [settings, rs, sends] = await Promise.all([
    deps.store.settings(),
    deps.store.reportSettings().catch(() => null),
    deps.store.reportSends(20).catch(() => [] as WsReportRow[]),
  ]);
  const addresses = reportAddresses(rs);
  const owner = isOwner(caller, deps.env, settings);
  const sendingOn = debtWsSendingOn(settings);
  const whyNot = !owner
    ? "Only the workshop owner (Shaun) can send the report"
    : !sendingOn
    ? "Sending is off until you switch it on"
    : addresses.problem?.message ??
      reportCopyProblem(report.synced_at, deps.now());
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    perth_date: report.today,
    read_at: report.read_at,
    report,
    html: debtReportHtml(report),
    delivery: {
      from: DEBT_WS_STATEMENT_FROM,
      to: addresses.to,
      cc: addresses.cc,
      auto_send: rs?.auto_send === true,
      sending_on: sendingOn,
      viewer_is_owner: owner,
      can_send: !whyNot,
      why_not: whyNot,
    },
    last_sent: reportSendView(sends.find((r) => r.status === "sent")),
    last_attempt: reportSendView(sends[0]),
  };
}

export async function debtWsReportPdf(deps: DebtWsDeps, caller: DebtWsCaller) {
  const actor = await actorOf(deps, caller);
  const report = await loadDebtReport(deps, actor.label);
  const pdf = await deps.renderReportPdf(report).catch((error) => {
    console.error("[debt_ws_report] pdf failed", error?.name);
    throw new DebtWsError(
      "The PDF could not be made just now. Try again shortly",
      502,
      "report_pdf_failed",
    );
  });
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    filename: debtReportFileName(report),
    content_type: "application/pdf",
    pdf_base64: bytesToBase64(pdf.bytes),
    page_count: pdf.pageCount,
    read_at: report.read_at,
  };
}

/**
 * One report email: claim the send, build the report fresh, check our Xero copy is fresh,
 * draw the PDF, email it, then keep the copy and log it. The claim is written first, so an
 * auto report can never go twice in a week, and an email that may have gone is never
 * retried by itself. A stale copy settles the claim as 'refused' (it does not hold the
 * week's auto slot) and sends nothing.
 */
async function sendDebtReport(
  deps: DebtWsDeps,
  actor: Actor,
  kind: "manual" | "auto",
  addresses: { to: string[]; cc: string[] },
  weekStart: string,
) {
  const sentBy = kind === "auto" ? DEBT_WS_REPORT_AUTO_LABEL : actor.label;
  const claim = await deps.store.claimReport({
    kind,
    week_start: weekStart,
    to_emails: addresses.to,
    cc_emails: addresses.cc,
    sent_by: actor.user_id,
    sent_by_name: sentBy,
  });
  if (!claim) return null;
  let report: DebtReport;
  let pdf: { bytes: Uint8Array; pageCount: number } | null = null;
  let stale: string | null = null;
  try {
    report = await loadDebtReport(deps, sentBy);
    // Consolidate first: no PDF is drawn on a stale copy of the debt.
    stale = reportCopyProblem(report.synced_at, deps.now());
    if (!stale) pdf = await deps.renderReportPdf(report);
  } catch (error) {
    // Nothing was sent: release the claim with the reason.
    await deps.store.settleReport(claim.id, {
      status: "failed",
      error: `not built: ${String((error as Error)?.name ?? error).slice(0, 200)}`,
    }).catch(() => {});
    if (error instanceof DebtWsError) throw error;
    throw new DebtWsError(
      "The report could not be built just now, so nothing was sent. Try again shortly",
      502,
      "report_pdf_failed",
    );
  }
  if (stale !== null || pdf === null) {
    // Our Xero copy is too old (or its age is unknown): nothing is sent. The claim settles
    // as 'refused' with the reason, which frees this week's auto slot, and the refusal is
    // logged where the Debt tab shows the report's history.
    const reason = stale ?? "The report could not be built just now";
    await deps.store.settleReport(claim.id, {
      status: "refused",
      error: `xero copy not fresh: ${reason}`.slice(0, 500),
    }).catch(() => {});
    await log(
      deps,
      { share_key: DEBT_WS_REPORT_LOG_KEY, ids: [], job_id: null },
      actor,
      "send_refused",
      {
        body: reason,
        meta: {
          code: "xero_copy_stale",
          report: true,
          report_id: claim.id,
          kind,
          synced_at: report.synced_at,
        },
      },
    ).catch(() => {});
    throw new DebtWsError(reason, 409, "xero_copy_stale", {
      synced_at: report.synced_at,
    });
  }
  const email = debtReportEmail(report, {
    greeting: reportGreeting(addresses.to),
    sentBy,
  });
  const pdfBase64 = bytesToBase64(pdf.bytes);
  const copy = {
    subject: email.subject,
    summary: email.text,
    totals: debtReportTotals(report),
    html: debtReportHtml(report),
    pdf_base64: pdfBase64,
    pdf_sha256: await sha256Hex(pdf.bytes),
  };
  let result: Awaited<ReturnType<DebtWsDeps["sendEmail"]>>;
  try {
    result = await deps.sendEmail({
      from: DEBT_WS_STATEMENT_FROM,
      to: addresses.to.join(", "),
      cc: addresses.cc,
      subject: email.subject,
      htmlBody: email.html,
      attachments: [{
        name: debtReportFileName(report),
        contentType: "application/pdf",
        contentBytes: pdfBase64,
      }],
      internal_report: "debt_report",
    });
  } catch (error) {
    // The email may have gone: the row stays 'sending' with the reason, never resent by itself.
    await deps.store.settleReport(claim.id, {
      ...copy,
      error: `not confirmed: ${
        String((error as Error)?.message ?? error).slice(0, 300)
      }`,
    }).catch(() => {});
    throw new DebtWsError(
      "The email could not be confirmed. Check the admin mailbox's Sent Items before sending again",
      502,
      "send_not_confirmed",
    );
  }
  if (!result.ok) {
    await deps.store.settleReport(claim.id, {
      ...copy,
      status: "failed",
      error: String(result.error ?? `email ${result.status}`).slice(0, 500),
    }).catch(() => {});
    throw new DebtWsError(
      `The email was refused (${result.status}). Nothing was sent`,
      502,
      "email_failed",
      { email_status: result.status },
    );
  }
  const sentAt = deps.now().toISOString();
  await deps.store.settleReport(claim.id, {
    ...copy,
    status: "sent",
    sent_at: sentAt,
  });
  await log(
    deps,
    { share_key: DEBT_WS_REPORT_LOG_KEY, ids: [], job_id: null },
    actor,
    "email_sent",
    {
      body: `Debt report emailed to ${addresses.to.join(", ")}${
        addresses.cc.length ? `, cc ${addresses.cc.join(", ")}` : ""
      }: debt ${money(report.debt.amount)} across ${report.debt.count} invoice(s)`,
      meta: {
        report_id: claim.id,
        kind,
        week_start: weekStart,
        to: addresses.to,
        cc: addresses.cc,
        totals: copy.totals,
      },
    },
  ).catch((error) => {
    // The send and its copy are recorded already; a missing log line never fails it.
    console.error("[debt_ws_report] log failed", error?.name);
  });
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    sent: true,
    report_id: claim.id,
    kind,
    to: addresses.to,
    cc: addresses.cc,
    subject: email.subject,
    sent_at: sentAt,
    page_count: pdf.pageCount,
  };
}

export async function debtWsReportSend(
  deps: DebtWsDeps,
  caller: DebtWsCaller,
  rawBody: unknown,
) {
  const body = asBody(rawBody);
  onlyKeys(body, []);
  const actor = await actorOf(deps, caller);
  const settings = await deps.store.settings();
  const today = perthDate(deps.now());
  const refuseReport = async (
    code: string,
    message: string,
    status = 409,
  ): Promise<never> => {
    await log(
      deps,
      { share_key: DEBT_WS_REPORT_LOG_KEY, ids: [], job_id: null },
      actor,
      "send_refused",
      { body: message, meta: { code, report: true } },
    ).catch(() => {});
    throw new DebtWsError(message, status, code);
  };
  if (!debtWsSendingOn(settings)) {
    await refuseReport("sending_off", "Sending is off until you switch it on");
  }
  const rs = await deps.store.reportSettings();
  const addresses = reportAddresses(rs);
  if (addresses.problem) {
    await refuseReport(addresses.problem.code, addresses.problem.message);
  }
  // A double click: a manual report already went (or is going) in the last two minutes.
  const recent = (await deps.store.reportSends(5)).find((r) =>
    r.kind === "manual" && (r.status === "sent" || r.status === "sending") &&
    deps.now().getTime() - Date.parse(r.created_at) < DEBT_WS_REPORT_RESEND_MS
  );
  if (recent) {
    await refuseReport(
      "recently_sent",
      "The report was just sent. Wait two minutes before sending it again",
    );
  }
  const sent = await sendDebtReport(
    deps,
    actor,
    "manual",
    addresses,
    mondayOf(today),
  );
  if (!sent) {
    throw new DebtWsError(
      "The report could not be claimed for sending. Try again shortly",
      409,
      "already_sent",
    );
  }
  return sent;
}

/**
 * The Wednesday 12:00 Perth cron. Off unless report_auto_send and sending are both on; once
 * a week (the week is Monday to Sunday, Perth, so week_start is still that Monday). Refuses
 * (xero_copy_stale) when our Xero copy is not fresh, like a manual send.
 */
export async function debtWsReportAuto(deps: DebtWsDeps) {
  const settings = await deps.store.settings();
  const rs = await deps.store.reportSettings();
  const today = perthDate(deps.now());
  const weekStart = mondayOf(today);
  const skipped = (reason: string) => ({
    ok: true,
    version: DEBT_WS_VERSION,
    sent: false,
    reason,
    week_start: weekStart,
  });
  if (!rs.auto_send) return skipped("auto_send_off");
  if (!debtWsSendingOn(settings)) return skipped("sending_off");
  const addresses = reportAddresses(rs);
  if (addresses.problem) {
    throw new DebtWsError(
      addresses.problem.message,
      409,
      addresses.problem.code,
    );
  }
  const sent = await sendDebtReport(
    deps,
    { user_id: null, label: "Wednesday 12pm auto-send" },
    "auto",
    addresses,
    weekStart,
  );
  return sent ?? skipped("already_sent");
}

// ── The dispatcher (index.ts wiring) ──

type Who = "staff" | "owner" | "server" | "server_or_owner";

export const DEBT_WS_ACTIONS: Record<
  string,
  { method: "GET" | "POST"; who: Who }
> = {
  debt_ws_overview: { method: "GET", who: "staff" },
  debt_ws_job: { method: "GET", who: "staff" },
  debt_ws_document: { method: "GET", who: "staff" },
  debt_ws_note: { method: "POST", who: "staff" },
  debt_ws_decide: { method: "POST", who: "owner" },
  debt_ws_set_category: { method: "POST", who: "owner" },
  debt_ws_link_contact: { method: "POST", who: "owner" },
  debt_ws_statement_preview: { method: "GET", who: "staff" },
  debt_ws_statement_send: { method: "POST", who: "owner" },
  debt_ws_jan_list: { method: "GET", who: "staff" },
  debt_ws_jan_list_remove: { method: "POST", who: "owner" },
  debt_ws_jan_list_lock: { method: "POST", who: "server" },
  debt_ws_jan_list_send: { method: "POST", who: "server" },
  debt_ws_agent_queue: { method: "GET", who: "server_or_owner" },
  debt_ws_agent_submit: { method: "POST", who: "server_or_owner" },
  debt_ws_report: { method: "GET", who: "staff" },
  debt_ws_report_pdf: { method: "GET", who: "staff" },
  debt_ws_report_send: { method: "POST", who: "owner" },
  debt_ws_report_auto: { method: "POST", who: "server" },
};

export function isDebtWsAction(action: unknown): boolean {
  return typeof action === "string" && action in DEBT_WS_ACTIONS;
}

/** Logs an unexpected failure by name and first stack frame only (never a provider body). */
function logFailure(action: string, error: unknown) {
  const name = error instanceof Error ? error.name : typeof error;
  const frame = error instanceof Error
    ? (error.stack ?? "").split("\n").map((l) => l.trim()).find((l) =>
      l.startsWith("at ")
    ) ?? ""
    : "";
  console.error(`[${action}] unexpected failure`, name, frame);
}

async function authorise(
  deps: DebtWsDeps,
  who: Who,
  caller: DebtWsCaller,
): Promise<void> {
  const user = caller.kind === "user" && !!caller.user_id && caller.staff;
  if (who === "staff") {
    // A signed-in staff JWT only. The server key reaches the Jan list cron actions and
    // the agent queue and submit, never the screen's reads and writes.
    if (user) return;
    throw new DebtWsError(
      "A signed-in staff session is required",
      403,
      "operator_access_required",
    );
  }
  if (who === "server") {
    if (caller.kind === "server") return;
    throw new DebtWsError(
      "Only the scheduled job (server key) runs this",
      403,
      "server_key_required",
    );
  }
  if (who === "server_or_owner" && caller.kind === "server") return;
  const settings = await deps.store.settings();
  const owners = debtWsOwnerIds(deps.env, settings);
  if (!owners.length) {
    throw new DebtWsError(
      "The workshop owner is not set (DEBT_WS_OWNER_USER_IDS or debt_ws_settings.owner_user_ids)",
      403,
      "owner_not_set",
    );
  }
  if (!user || !isOwner(caller, deps.env, settings)) {
    throw new DebtWsError(
      "Only the workshop owner (Shaun) can do this",
      403,
      "not_owner",
    );
  }
}

export async function runDebtWsAction(
  action: string,
  method: string,
  params: URLSearchParams,
  body: unknown,
  caller: DebtWsCaller,
  deps: DebtWsDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const spec = DEBT_WS_ACTIONS[action];
  if (!spec) {
    return {
      status: 400,
      body: { ok: false, code: "unknown_action", error: "Unknown action" },
    };
  }
  if (method !== spec.method) {
    return {
      status: 405,
      body: {
        ok: false,
        code: "METHOD_NOT_ALLOWED",
        error: `${action} requires ${spec.method}`,
      },
    };
  }
  try {
    await authorise(deps, spec.who, caller);
    const ok = (b: Record<string, unknown>) => ({ status: 200, body: b });
    switch (action) {
      case "debt_ws_overview":
        return ok(await debtWsOverview(deps, caller));
      case "debt_ws_job":
        return ok(await debtWsJob(deps, params));
      case "debt_ws_document":
        return await debtWsDocument(deps, params);
      case "debt_ws_note":
        return ok(await debtWsNote(deps, caller, body));
      case "debt_ws_decide":
        return ok(await debtWsDecide(deps, caller, body));
      case "debt_ws_set_category":
        return ok(await debtWsSetCategory(deps, caller, body));
      case "debt_ws_link_contact":
        return ok(await debtWsLinkContact(deps, caller, body));
      case "debt_ws_statement_preview":
        return ok(await debtWsStatementPreview(deps, params));
      case "debt_ws_statement_send":
        return ok(await debtWsStatementSend(deps, caller, body));
      case "debt_ws_jan_list":
        return ok(await debtWsJanList(deps, params));
      case "debt_ws_jan_list_remove":
        return ok(await debtWsJanListRemove(deps, caller, body));
      case "debt_ws_jan_list_lock":
        return ok(await debtWsJanListLock(deps));
      case "debt_ws_jan_list_send":
        return ok(await debtWsJanListSend(deps));
      case "debt_ws_agent_queue":
        return ok(await debtWsAgentQueue(deps));
      case "debt_ws_report":
        return ok(await debtWsReport(deps, caller));
      case "debt_ws_report_pdf":
        return ok(await debtWsReportPdf(deps, caller));
      case "debt_ws_report_send":
        return ok(await debtWsReportSend(deps, caller, body));
      case "debt_ws_report_auto":
        return ok(await debtWsReportAuto(deps));
      default:
        return ok(await debtWsAgentSubmit(deps, caller, body));
    }
  } catch (error) {
    if (error instanceof DebtWsError) {
      return {
        status: error.status,
        body: {
          ok: false,
          code: error.code,
          error: error.message,
          ...error.details,
        },
      };
    }
    if ((error as { name?: string })?.name === "XeroCooldownError") {
      return {
        status: 503,
        body: {
          ok: false,
          code: "xero_rate_limited",
          error: "Xero is busy right now; try again shortly",
        },
      };
    }
    logFailure(action, error);
    return {
      status: 502,
      body: {
        ok: false,
        code: "DEBT_WS_FAILED",
        error: "The debt workshop could not complete this action",
      },
    };
  }
}
