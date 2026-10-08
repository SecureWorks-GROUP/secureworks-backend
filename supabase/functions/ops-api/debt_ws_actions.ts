// Debt Workshop actions (secureworks-wiki coding/capabilities/debt-follow-up/debt-workshop-spec.md,
// sections 1, 4, 6, 7 and 8). index.ts only wires the actions to runDebtWsAction and injects
// the private helpers it owns (sendChaseSms, getJobConversation, getToken, xeroReadGet,
// updateJobStatus, the Outlook send, the invoice PDF, the GHL contact search, the staff SMS
// path to Jan's mobile, and the job document reads).
//
// Safety (spec section 1), in code:
//   - Nothing reaches a client unless sending is effectively on: env DEBT_WS_SENDING_ENABLED
//     is exactly "true" AND debt_ws_settings.sending_enabled is true. Both default off.
//   - Only the owner (env DEBT_WS_OWNER_USER_IDS, else debt_ws_settings.owner_user_ids, never
//     a role) may send, approve statements, link contacts or move a card.
//   - Before every text: a live Xero re-check (AUTHORISED, amount due above zero and not
//     below the draft's amount) and the bank-feed check. Either failing refuses, with a
//     plain reason, and the refusal is logged.
//   - A claim row (debt_ws_sends, unique per share, cycle and step) is written before the
//     text goes, so a step is never texted twice.
//   - Texts go only through the injected sendChaseSms path (771, the SES fence and the
//     contact/job match guard). Xero is read only. A card moves only through updateJobStatus.
//   - Automatic sending (stage 5) also needs env DEBT_WS_AUTO_SEND_ENABLED === "true" and
//     debt_ws_settings.auto_send_steps[step] === true. Off by default.

import {
  addDays,
  type BankTransaction,
  classifyInvoice,
  clientTextProblem,
  DEBT_WS_PLAYBOOK_VERSION,
  DEBT_WS_VERSION,
  isIsoDate,
  isLadderStep,
  isReplyStep,
  isTextStep,
  type JanListItem,
  janListText,
  longDate,
  mondayOf,
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
  categoryTotals,
  companiesOf,
  type CompanyView,
  janItemsLive,
  loadBook,
  paidThisWeek,
  possiblePaymentsFor,
  sortRows,
  suggestionView,
  templateDraftFor,
} from "./debt_ws_book.ts";
import {
  DebtWsError,
  type DebtWsSettings,
  type DebtWsStore,
  type WsLogRow,
  type WsSuggestion,
} from "./debt_ws_store.ts";

export { DebtWsError } from "./debt_ws_store.ts";

export const DEBT_WS_SENDING_SWITCH = "DEBT_WS_SENDING_ENABLED";
export const DEBT_WS_AUTO_SEND_SWITCH = "DEBT_WS_AUTO_SEND_ENABLED";
export const DEBT_WS_OWNERS_SETTING = "DEBT_WS_OWNER_USER_IDS";
export const DEBT_WS_STATEMENT_FROM = "admin@secureworkswa.com.au";
/** Bank feed: one page, re-read at most every 15 minutes within a Perth day (spec section 6). */
export const DEBT_WS_BANK_CACHE_MS = 15 * 60_000;
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
  /** One page of Xero's unreconciled bank transactions, from this date when given. */
  bankTransactions: (dateFrom: string | null) => Promise<BankTransaction[]>;
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
  /** The send-outlook-email edge function. HTML only, never an attachment. */
  sendEmail: (payload: {
    from: string;
    to: string;
    subject: string;
    htmlBody: string;
  }) => Promise<{ ok: boolean; status: number; error: string | null }>;
  /** The existing updateJobStatus (job_events, business_events, the GHL stage move). */
  updateJobStatus: (body: Record<string, unknown>) => Promise<unknown>;
  /** getJobConversation: messages with full text, call transcripts included. */
  conversation: (
    jobId: string,
    limit: number,
  ) => Promise<{ messages: Record<string, unknown>[]; summary?: unknown }>;
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
    Array<{ id: string; name?: string; phone?: string; email?: string }>
  >;
}

// ── Switches and the owner ──

export function debtWsEnvSendingOn(env: DebtWsDeps["env"]): boolean {
  return env(DEBT_WS_SENDING_SWITCH) === "true";
}

/** Effective sending: env DEBT_WS_SENDING_ENABLED === "true" AND the settings row says so. */
export function debtWsSendingOn(
  env: DebtWsDeps["env"],
  settings: DebtWsSettings,
): boolean {
  return debtWsEnvSendingOn(env) && settings.sending_enabled === true;
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

let bankCache: { day: string; at: number; txs: BankTransaction[] } | null =
  null;

export function _resetDebtWsBankCacheForTest() {
  bankCache = null;
}

/** The cached page (same Perth day, under 15 minutes old), else one fresh read. */
async function cachedBankFeed(deps: DebtWsDeps): Promise<BankTransaction[]> {
  const now = deps.now();
  const day = perthDate(now);
  if (
    bankCache && bankCache.day === day &&
    now.getTime() - bankCache.at < DEBT_WS_BANK_CACHE_MS
  ) return bankCache.txs;
  const txs = await deps.bankTransactions(addDays(day, -120));
  bankCache = { day, at: now.getTime(), txs };
  return txs;
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

export async function debtWsOverview(deps: DebtWsDeps, caller: DebtWsCaller) {
  const now = deps.now();
  const book = await loadBook(deps.store, { now });
  const weekStart = mondayOf(book.today);
  const [statements, paid] = await Promise.all([
    deps.store.statementsForWeek(weekStart),
    paidThisWeek(deps.store, book.today),
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
      sending_on: debtWsSendingOn(deps.env, book.settings),
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

async function contactCandidates(deps: DebtWsDeps, entry: BookEntry) {
  const job = entry.job;
  if (!job || job.ghl_contact_id) return [];
  const phone = digits(job.client_phone);
  const email = String(job.client_email ?? "").trim().toLowerCase();
  const queries = [
    phone.length >= 8 ? String(job.client_phone) : null,
    email || null,
    !phone && !email ? entry.row.payer_name : null,
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

async function bankFeedSafe(deps: DebtWsDeps) {
  try {
    return { txs: await cachedBankFeed(deps), status: "ok" as const };
  } catch (error) {
    console.error("[debt_ws] bank feed unavailable", (error as Error)?.name);
    return { txs: [] as BankTransaction[], status: "unavailable" as const };
  }
}

export async function debtWsJob(deps: DebtWsDeps, params: URLSearchParams) {
  const id = uuidOf(params.get("xero_invoice_id"), "xero_invoice_id");
  const { book, entry } = await oneEntry(deps, id);
  const job = entry.job;
  const budget = { left: DEBT_WS_PAY_LINK_FETCH_LIMIT };
  const [story, documents, conversation, jobLogs, payLink, bank, candidates] =
    await Promise.all([
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
        ? deps.conversation(job.id, 100).catch(() => ({
          messages: [],
          summary: null,
          error: "The conversation could not be read",
        }))
        : Promise.resolve({ messages: [], summary: null }),
      job ? deps.store.logsForJob(job.id) : Promise.resolve([]),
      payLinkFor(deps, entry, budget),
      bankFeedSafe(deps),
      contactCandidates(deps, entry),
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
    : templateDraftFor(entry, payLink);
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
      }
      : null,
    story: story.story ?? null,
    story_status: story.status ?? null,
    invoices,
    documents: documents.rows,
    documents_status: documents.status,
    conversation,
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
    possible_payments: possiblePaymentsFor(entry, bank.txs),
    possible_payments_status: bank.status,
    contact: { ghl_contact_id: job?.ghl_contact_id ?? null, candidates },
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
    const key = body.company_key.trim().toLowerCase().slice(0, 200);
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
  if (!debtWsSendingOn(deps.env, settings)) {
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
  const contact = entry.job?.ghl_contact_id ?? null;
  if (!entry.job || !contact) {
    await refuse(
      deps,
      input,
      "no_contact",
      "The job has no GoHighLevel contact to text. Link the contact first",
    );
  }
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
    s.cycle_start === entry.dayZero && s.step === step &&
    (s.status === "sending" || s.status === "sent")
  );
  if (already) {
    await refuse(
      deps,
      input,
      "already_sent",
      "That step was already sent (or a send of it is not confirmed), so it is not sent twice",
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

  // The bank-feed check (fresh, from the invoice date minus one day).
  let payments: PossiblePayment[];
  try {
    const from = entry.inv.invoice_date
      ? addDays(entry.inv.invoice_date, -1)
      : null;
    payments = possiblePayments(
      {
        ...entry.inv,
        amount_due: Number(live.AmountDue ?? entry.inv.amount_due),
      },
      [entry.inv.contact_name, entry.job?.client_name],
      await deps.bankTransactions(from),
    );
  } catch (_) {
    return await refuse(
      deps,
      input,
      "bank_check_unavailable",
      "The bank feed could not be read, so nothing was sent. Try again shortly",
      503,
    );
  }
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
    step,
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
  if (!isLadderStep(step) && !isReplyStep(step)) {
    bad("step must be d1, d3, d7, d12, d17, d21 or a reply step");
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
  const jobId = uuidOf(body.job_id, "job_id");
  const contact = typeof body.ghl_contact_id === "string"
    ? body.ghl_contact_id.trim()
    : "";
  if (!GHL_ID.test(contact)) {
    bad("ghl_contact_id must be a GoHighLevel contact id");
  }
  const actor = await actorOf(deps, caller);
  const [job] = await deps.store.jobs([jobId]);
  if (!job) {
    throw new DebtWsError("That job was not found", 404, "job_not_found");
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
  const invoiceId = body.xero_invoice_id
    ? uuidOf(body.xero_invoice_id, "xero_invoice_id")
    : null;
  await log(
    deps,
    {
      share_key: invoiceId ?? `job:${jobId}`,
      ids: invoiceId ? [invoiceId] : [],
      job_id: jobId,
    },
    actor,
    "link_contact",
    {
      body: `Linked GoHighLevel contact ${contact}`,
      meta: { ghl_contact_id: contact, previous: job.ghl_contact_id ?? null },
    },
  );
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    job_id: jobId,
    ghl_contact_id: contact,
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
  const key = companyKeyParam(params.get("company_key"));
  const book = await loadBook(deps.store, { now: deps.now() });
  const { company, entries } = await statementFor(deps, book, key);
  const lines = await statementLines(deps, entries);
  return {
    ok: true,
    version: DEBT_WS_VERSION,
    perth_date: book.today,
    sending_on: debtWsSendingOn(deps.env, book.settings),
    ...statementView(company, mondayOf(book.today), lines),
  };
}

export async function debtWsStatementSend(
  deps: DebtWsDeps,
  caller: DebtWsCaller,
  rawBody: unknown,
) {
  const body = asBody(rawBody);
  onlyKeys(body, ["company_key"]);
  const key = companyKeyParam(body.company_key);
  const actor = await actorOf(deps, caller);
  const book = await loadBook(deps.store, { now: deps.now() });
  const weekStart = mondayOf(book.today);
  const refuseStatement = async (
    code: string,
    message: string,
    status = 409,
  ): Promise<never> => {
    await log(
      deps,
      { share_key: key, ids: [], job_id: null },
      actor,
      "send_refused",
      {
        body: message,
        meta: { code, week_start: weekStart, statement: true },
      },
    ).catch(() => {});
    throw new DebtWsError(message, status, code);
  };
  if (!debtWsSendingOn(deps.env, book.settings)) {
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

  // The live re-check: drop anything Xero shows paid or no longer open.
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
    await deps.store.settleStatement(claim!.id, {
      status: "refused",
      error: "xero_unavailable",
    }).catch(() => {});
    return await refuseStatement(
      "xero_unavailable",
      "Xero could not be read for the last check, so the statement was not sent",
      503,
    );
  }
  if (!kept.length) {
    await deps.store.settleStatement(claim!.id, {
      status: "refused",
      error: "nothing_due",
    }).catch(() => {});
    return await refuseStatement(
      "nothing_due",
      "Xero shows everything on this statement paid",
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
    sending_on: debtWsSendingOn(deps.env, book.settings),
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
    : !debtWsSendingOn(deps.env, settings)
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
    };
  };

  // Drop anyone paid since the lock: live from Xero, else from our copy.
  const items = (row.items as JanListItem[]).filter((i) =>
    !row.removed_share_keys.includes(i.share_key)
  );
  let kept: JanListItem[];
  try {
    const live = await deps.readInvoices(items.map((i) => i.xero_invoice_id));
    const byId = new Map(
      live.map((inv) => [String(inv.InvoiceID ?? "").toLowerCase(), inv]),
    );
    kept = items.filter((i) => {
      const inv = byId.get(i.xero_invoice_id);
      return inv && inv.Status === "AUTHORISED" && Number(inv.AmountDue) > 0;
    }).map((i) => ({
      ...i,
      amount: Number(byId.get(i.xero_invoice_id)!.AmountDue),
    }));
  } catch (_) {
    const copy = await deps.store.invoicesByIds(
      items.map((i) => i.xero_invoice_id),
    );
    const open = new Map(
      copy.filter((c) => c.status === "AUTHORISED" && Number(c.amount_due) > 0)
        .map((c) => [c.xero_invoice_id, c]),
    );
    kept = items.filter((i) => open.has(i.xero_invoice_id)).map((i) => ({
      ...i,
      amount: Number(open.get(i.xero_invoice_id)!.amount_due),
    }));
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
  const actor: Actor = { user_id: null, label: "cron" };
  for (const item of kept) {
    await log(
      deps,
      {
        share_key: item.share_key,
        ids: [item.xero_invoice_id],
        job_id: null,
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
  };
  if (!book.settings.agent_enabled) return { ...base, items: [], more: false };
  const candidates = book.entries.filter((e) =>
    e.open && e.kind !== "account" && !e.notChased && e.category !== null &&
    e.job
  );
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
  const take = queued.slice(0, DEBT_WS_AGENT_QUEUE_LIMIT);
  const bank = await bankFeedSafe(deps);
  const budget = { left: DEBT_WS_PAY_LINK_FETCH_LIMIT };
  const items = [];
  for (const { entry, why } of take) {
    const [story, conversation] = await Promise.all([
      deps.story(entry.job!.id).catch(() => ({
        story: null,
        status: { ok: false, state: "failed" },
      })),
      deps.conversation(entry.job!.id, DEBT_WS_AGENT_MESSAGES).catch(() => ({
        messages: [] as Record<string, unknown>[],
      })),
    ]);
    const payLink = await payLinkFor(deps, entry, budget);
    const messages = [...(conversation.messages ?? [])].slice(
      0,
      DEBT_WS_AGENT_MESSAGES,
    ).map(agentMessage).sort((a, b) =>
      String(a.at ?? "").localeCompare(String(b.at ?? ""))
    );
    const draft = templateDraftFor(entry, payLink);
    items.push({
      row: entry.row,
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
      notes: entry.logs.map(noteView),
      possible_payments: possiblePaymentsFor(entry, bank.txs),
      possible_payments_status: bank.status,
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

  const suggestion = await deps.store.insertSuggestion({
    share_key: entry.row.share_key,
    xero_invoice_ids: ids,
    job_id: entry.job?.id ?? null,
    cycle_start: entry.dayZero,
    step: step as string | null,
    kind: kind as "draft" | "move" | "flag",
    channel: kind === "flag" ? null : "sms",
    text,
    why,
    proposed_category: proposed as "says_paid" | "rectification" | null,
    amount: Math.round(
      entries.reduce((s, e) => s + e!.row.amount_due * 100, 0),
    ) / 100,
    source: "agent",
    agent_version: agentVersion,
  });
  if (kind === "flag") {
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
        body: text,
        meta: { suggestion_id: suggestion.id, why },
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
    debtWsSendingOn(deps.env, settings)
  ) {
    const bank = await bankFeedSafe(deps);
    const payments = possiblePaymentsFor(entry, bank.txs);
    if (bank.status !== "ok" || payments.length) {
      autoSend = {
        attempted: false,
        reason: payments.length ? "possible_payment" : "bank_check_unavailable",
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
    kind,
    suggestion: suggestionView(suggestion),
    auto_send: autoSend,
  };
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
    if (user || caller.kind === "server") return;
    throw new DebtWsError(
      "An authorised operator session is required",
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
