// deno-lint-ignore-file no-explicit-any
//
// The job overview read (job overview v1, the owner's approved design of
// 9 Oct 2026). One staff GET feeds the new job page Overview:
//
//   - story       the job story card (context_job_story, job-story-v1), with
//                 call transcript words taken out (loops[].why, and a last
//                 exchange that is a transcript): the page never shows them;
//   - notes       the live AI reading's items (context_job_story_ledger, the
//                 citation-rechecked read), each with its owner, its group
//                 (blocking, waiting on someone, good to know) and its first
//                 receipt quote (160 characters, never from a call transcript);
//   - messages    the job conversation (getJobConversation, the one reader),
//                 calls merged into one row with their length and no words,
//                 empty texts dropped, the newest 80 oldest first;
//   - files       quotes (job_quote_values is the only value), customer
//                 invoices on the job only (a draft is never invoiced, a
//                 deleted or voided one never counts), email attachments, the
//                 photo count and whether a scope exists;
//   - story_text  the saved written story and whether it is still current
//                 (context_job_story_text_get, given the card just read, so the
//                 card is built once).
//
// Every part reads on its own: a failed part is null with a code in sources,
// never an empty list, and the answer is 200 whenever the job resolves. A
// missing story-text function (the migration not applied yet) reads as
// not_deployed. No table write, no provider call, no model call.
//
// POST request_job_story asks for the story to be written or rewritten
// (context_job_story_request, reason asked) as the verified caller.

import {
  currentPriceIncGst,
  type JobQuotes,
  type QuoteDocumentView,
  readJobQuotes,
} from "./job_commercial_read.ts";
import {
  readJobStory,
  resolveStoryJob,
  sanitizedError,
  StoryReadError,
} from "./job_story_read.ts";

export const JOB_OVERVIEW_VERSION = "job-overview-v1";
/** Messages returned, newest kept, oldest first. */
export const OVERVIEW_MESSAGE_LIMIT = 80;
/** Messages read from the conversation before calls are merged and empties dropped. */
export const OVERVIEW_CONVERSATION_READ = 150;
export const OVERVIEW_TEXT_MAX = 400;
export const OVERVIEW_EXCERPT_MAX = 160;
export const OVERVIEW_ATTACHMENT_LIMIT = 100;

const TRANSCRIPT_EVENT = "call.transcript_completed";

export type OverviewPartState = "ok" | "failed" | "not_deployed";

export interface OverviewPartStatus {
  ok: boolean;
  state: OverviewPartState;
  count: number;
  code?: string;
  error?: string;
}

export interface JobOverviewDeps {
  /** index.ts getJobConversation: the one job conversation reader. */
  getJobConversation: (client: any, body: any) => Promise<any>;
  /** The clock, for tests. */
  now?: () => Date;
}

function ok(count: number): OverviewPartStatus {
  return { ok: true, state: "ok", count };
}

function failed(code: string, error?: string): OverviewPartStatus {
  return {
    ok: false,
    state: "failed",
    count: 0,
    code,
    ...(error ? { error } : {}),
  };
}

function errorCode(error: any): string | null {
  const code = error?.code;
  return typeof code === "string" && code ? code : null;
}

/** A PostgREST answer for a function that is not there (yet): PGRST202, or 42883 from SQL. */
export function isMissingFunction(error: any): boolean {
  const code = errorCode(error);
  return code === "PGRST202" || code === "42883";
}

// ── plain words and Perth time ───────────────────────────────────────────────

/**
 * Stored text as a person reads it: an em or en dash becomes a comma (a range
 * between two numbers becomes "to"), line endings are normalised, and the
 * result is trimmed. Never invents or removes words.
 */
export function plainText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/(\d)\s*[\u2013\u2014]\s*(?=\d)/g, "$1 to ")
    .replace(/[ \t]*[\u2013\u2014][ \t]*/g, ", ")
    .replace(/,(\s*,)+/g, ",")
    .replace(/^[\s,]+/, "")
    .replace(/[\s,]+$/, "")
    .trim();
}

/** Cut to max characters at a word boundary, marked with "..." when cut. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, Math.max(0, max - 3));
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/** Perth keeps UTC+8 all year (no daylight saving). */
const PERTH_OFFSET_MS = 8 * 60 * 60 * 1000;

function perthDate(iso: unknown): Date | null {
  if (typeof iso !== "string" || !iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + PERTH_OFFSET_MS) : null;
}

/** "Thu 8 Oct" in Perth, or null. */
export function perthDay(iso: unknown): string | null {
  const d = perthDate(iso);
  if (!d) return null;
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Thu 8 Oct, 2:01pm" in Perth, or null. */
export function perthStamp(iso: unknown): string | null {
  const d = perthDate(iso);
  if (!d) return null;
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${
    MONTHS[d.getUTCMonth()]
  }, ${h % 12 === 0 ? 12 : h % 12}:${m}${h < 12 ? "am" : "pm"}`;
}

// ── the AI notes ─────────────────────────────────────────────────────────────

export type NoteGroup = "blocking" | "waiting" | "good_to_know";
export type NoteOwner = "us" | "customer" | "third_party" | "unknown";

/**
 * Which group an AI note sits in: blocking (open and it blocks a step of the
 * job), waiting (open, and someone owes it: a promise, an ask, an outside
 * party, an agreement still asked or offered), else good to know.
 */
export function noteGroup(item: any): NoteGroup {
  if (item?.status !== "open") return "good_to_know";
  if (
    typeof item?.blocks === "string" && item.blocks && item.blocks !== "none"
  ) {
    return "blocking";
  }
  if (
    ["commitment", "request", "dependency"].includes(String(item?.item_type))
  ) {
    return "waiting";
  }
  if (
    item?.item_type === "agreement" &&
    ["requested", "offered"].includes(String(item?.modality))
  ) return "waiting";
  return "good_to_know";
}

function roleOwner(role: unknown): NoteOwner {
  const r = String(role ?? "");
  if (r === "us" || r === "crew") return "us";
  if (r === "customer" || r === "insurer_builder") return "customer";
  if (r === "supplier" || r === "third_party") return "third_party";
  return "unknown";
}

/**
 * Who owes an AI note, the story's own rule (context_job_story_assemble,
 * lrole/norm): a promise is owed by who made it; an ask by who was asked; a
 * dependency by the outside party it waits on; an agreement we offered by the
 * other side, else by us; anything else by us.
 */
export function noteOwner(
  item: any,
): { owner: NoteOwner; owner_name: string | null } {
  let role: unknown;
  let name: unknown = null;
  switch (item?.item_type) {
    case "commitment":
      role = item.from_role;
      name = item.from_name;
      break;
    case "request":
      role = item.to_role ?? "us";
      name = item.to_name;
      break;
    case "dependency":
      role = item.to_role ?? "third_party";
      if (role === "us" || role === "crew") role = "third_party";
      name = item.to_name;
      break;
    case "agreement":
      if (item.from_role === "us" || item.from_role === "crew") {
        role = item.to_role ?? "customer";
        name = item.to_name;
      } else role = "us";
      break;
    default:
      role = "us";
  }
  const owner_name = typeof name === "string" && name.trim()
    ? plainText(name)
    : null;
  return { owner: roleOwner(role), owner_name };
}

function receiptsOf(item: any): any[] {
  return Array.isArray(item?.opened_by)
    ? item.opened_by.filter((r: any) => r && typeof r === "object")
    : [];
}

/**
 * The receipt a note shows: its first receipt that is not a call transcript,
 * else its first receipt with no words. An unknown business_events row (its
 * kind was not read) shows no words either.
 */
export function noteReceipt(
  item: any,
  eventTypes: Map<string, string> | null,
): { table: string | null; id: string | null; excerpt: string | null } | null {
  const receipts = receiptsOf(item);
  if (!receipts.length) return null;
  const wordsAllowed = (r: any) => {
    if (r.table !== "business_events") return true;
    const kind = eventTypes?.get(String(r.id));
    return typeof kind === "string" && kind !== TRANSCRIPT_EVENT;
  };
  const shown = receipts.find(wordsAllowed);
  const r = shown ?? receipts[0];
  const words = shown && typeof r.excerpt === "string"
    ? clip(plainText(r.excerpt), OVERVIEW_EXCERPT_MAX)
    : null;
  return {
    table: typeof r.table === "string" ? r.table : null,
    id: r.id == null ? null : String(r.id),
    excerpt: words ? words : null,
  };
}

/** One AI note as the overview shows it. */
export function overviewNote(
  item: any,
  eventTypes: Map<string, string> | null,
): any {
  const { owner, owner_name } = noteOwner(item);
  const status = typeof item?.status === "string" ? item.status : null;
  return {
    id: item?.item_key ?? null,
    item_type: item?.item_type ?? null,
    status,
    from_role: item?.from_role ?? null,
    from_name: item?.from_name ? plainText(item.from_name) : null,
    to_role: item?.to_role ?? null,
    to_name: item?.to_name ? plainText(item.to_name) : null,
    what: plainText(item?.what),
    due_date: item?.due_date ?? null,
    blocks: item?.blocks ?? null,
    modality: item?.modality ?? null,
    phase: item?.phase ?? null,
    opened_at: item?.opened_at ?? null,
    // a note is true as at its own date: the page always shows it
    as_at: perthDay(item?.opened_at),
    closed_at: item?.closed_at ?? null,
    cites_ok: item?.cites_ok !== false,
    owner,
    owner_name,
    group: noteGroup(item),
    // superseded notes and notes whose citations no longer hold stay out of sight by default
    shown: status !== "superseded" && item?.cites_ok !== false,
    receipt: noteReceipt(item, eventTypes),
  };
}

// ── the conversation ─────────────────────────────────────────────────────────

export type MessageKind = "text" | "email" | "call" | "note" | "system";

export interface CallFacts {
  id: string;
  event_type: string | null;
  provider_message_id: string | null;
  seconds: number | null;
  call_status: string | null;
  ghl_call_id: string | null;
  legacy_event_id: string | null;
}

function messageKind(channel: unknown): MessageKind {
  const c = String(channel ?? "").toLowerCase();
  if (c === "sms" || c === "whatsapp" || c === "chat") return "text";
  if (c === "email") return "email";
  if (c === "call") return "call";
  if (c === "note") return "note";
  return "system";
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The words a call row shows: what happened, never what was said. */
export function callWords(
  direction: string,
  status: string | null,
  seconds: number | null,
): string {
  const s = (status ?? "").toLowerCase();
  if (s === "voicemail") return "Voicemail";
  if (
    [
      "no-answer",
      "no_answer",
      "busy",
      "failed",
      "canceled",
      "cancelled",
      "missed",
    ].includes(s)
  ) {
    return direction === "outbound" ? "Call not answered" : "Missed call";
  }
  if (seconds !== null && seconds > 0) {
    const m = Math.floor(seconds / 60);
    const r = Math.round(seconds % 60);
    return `Call, ${m > 0 ? `${m} min ` : ""}${r} s`.replace(" 0 s", "").trim();
  }
  return "Call";
}

const NO_TEXT = /^\[No text\.\s*(.*?)\]$/s;

/** A text with no words that only describes attachments, as plain words; null when there is nothing at all. */
function attachmentOnlyWords(
  body: string,
): { words: string | null; empty: boolean } {
  const m = body.match(NO_TEXT);
  if (!m) return { words: null, empty: false };
  const rest = m[1].replace(/\.$/, "").trim();
  if (!rest || /^No attachments$/i.test(rest)) {
    return { words: null, empty: true };
  }
  return { words: rest.charAt(0).toUpperCase() + rest.slice(1), empty: false };
}

function callKey(m: any, facts: CallFacts | undefined): string | null {
  const pm = String(facts?.provider_message_id ?? m?.provider_message_id ?? "");
  if (pm.startsWith("ghltx:")) return pm.slice(6);
  if (pm.startsWith("ghl:")) return pm.slice(4);
  if (facts?.ghl_call_id) return facts.ghl_call_id;
  if (m?.source_system === "ghl_cache" && m?.source_ref) {
    return String(m.source_ref);
  }
  return null;
}

/**
 * The conversation as the overview shows it, newest kept, oldest first:
 * every call one row (its CRM call row, its transcript row and its legacy
 * workflow row merged) with its length and no words; texts with no words
 * dropped; dashes as commas; at most OVERVIEW_TEXT_MAX characters.
 */
export function overviewMessages(
  messages: any[],
  callFacts: Map<string, CallFacts>,
  clientName: string | null,
): any[] {
  const rows = Array.isArray(messages) ? messages : [];
  // legacy workflow call rows a CRM call row already names
  const pairedLegacy = new Set<string>();
  for (const f of callFacts.values()) {
    if (f.legacy_event_id) pairedLegacy.add(f.legacy_event_id);
  }
  const calls = new Map<string, any>();
  const out: any[] = [];
  for (const m of rows) {
    if (!m || typeof m !== "object") continue;
    const kind = messageKind(m.channel);
    const facts = m.source_system === "business_events"
      ? callFacts.get(String(m.source_ref))
      : undefined;
    if (kind === "call") {
      if (
        m.source_system === "business_events" &&
        pairedLegacy.has(String(m.source_ref))
      ) continue;
      const key = callKey(m, facts) ?? `row:${m.id}`;
      const isTranscript = m.call_transcript === true ||
        facts?.event_type === TRANSCRIPT_EVENT ||
        String(m.provider_message_id ?? "").startsWith("ghltx:") ||
        m.source === "call_transcript";
      const seconds = numberOrNull(facts?.seconds ?? m.call_duration);
      const status = (facts?.call_status ?? m.call_status ?? null) as
        | string
        | null;
      const existing = calls.get(key);
      if (existing) {
        existing.has_transcript = existing.has_transcript || isTranscript;
        if (!isTranscript) {
          // the call row itself decides the time, direction, status and who it was with
          existing.id = m.id ?? existing.id;
          existing.at = m.occurred_at ?? existing.at;
          existing.direction = m.direction ?? existing.direction;
          existing.call_status = status ?? existing.call_status;
          existing.source = m.source_system ?? existing.source;
          existing.m = m;
        }
        if (existing.call_seconds === null && seconds !== null) {
          existing.call_seconds = seconds;
        }
        if (existing.call_status === null && status) {
          existing.call_status = status;
        }
        existing.merged += 1;
        continue;
      }
      const row = {
        id: m.id ?? null,
        at: m.occurred_at ?? null,
        channel: "call",
        kind: "call" as MessageKind,
        direction: m.direction ?? "unknown",
        call_seconds: seconds,
        call_status: status,
        has_transcript: isTranscript,
        merged: 1,
        source: m.source_system ?? null,
        m,
      };
      calls.set(key, row);
      out.push(row);
      continue;
    }
    const raw = String(m.body ?? m.preview ?? "");
    const subject = typeof m.subject === "string" && m.subject.trim()
      ? clip(plainText(m.subject), 200)
      : null;
    const described = attachmentOnlyWords(raw.trim());
    if (described.empty && !subject) continue;
    const words = described.words ?? plainText(raw);
    if (!words && !subject) continue; // an empty text (a backfilled row with no words)
    out.push({
      id: m.id ?? null,
      at: m.occurred_at ?? null,
      channel: String(m.channel ?? "message").toLowerCase(),
      kind,
      direction: m.direction ?? "unknown",
      text: words ? clip(words, OVERVIEW_TEXT_MAX) : null,
      subject,
      attachments_only: described.words !== null,
      source: m.source_system ?? null,
      m,
    });
  }
  const customer = clientName && clientName.trim()
    ? plainText(clientName)
    : "Customer";
  const shaped = out.map((r) => {
    const m = r.m;
    const internal = r.direction === "internal" || m.internal === true ||
      r.kind === "note";
    const other = m.audience === "other_party" || m.customer_party === false ||
      ["supplier", "crew", "insurer_builder", "council"].includes(
        String(m.counterpart_role ?? ""),
      );
    const side = internal
      ? "internal"
      : r.direction === "outbound"
      ? "us"
      : "them";
    const otherWho = String(m.sender_role ?? "") === "supplier"
      ? "Supplier"
      : String(m.sender_role ?? "") === "crew"
      ? "Crew"
      : String(m.sender_role ?? "") === "insurer_builder"
      ? "Builder"
      : "Other party";
    const who = side === "us"
      ? "Us"
      : side === "internal"
      ? (r.kind === "note" ? "Us (note)" : "Us (internal)")
      : other
      ? otherWho
      : customer;
    const base: any = {
      id: r.id,
      at: r.at,
      at_perth: perthStamp(r.at),
      channel: r.channel,
      kind: r.kind,
      direction: r.direction,
      side,
      party: side === "them" ? (other ? "other" : "customer") : "us",
      who,
      text: r.kind === "call"
        ? callWords(r.direction, r.call_status, r.call_seconds)
        : r.text,
      source: r.source,
    };
    if (r.kind === "call") {
      base.call_seconds = r.call_seconds;
      base.call_status = r.call_status;
      base.has_transcript = r.has_transcript;
    } else {
      if (r.subject) base.subject = r.subject;
      if (r.attachments_only) base.attachments_only = true;
    }
    return base;
  });
  const t = (x: any) => {
    const v = Date.parse(String(x?.at ?? ""));
    return Number.isFinite(v) ? v : -Infinity;
  };
  shaped.sort((a, b) =>
    t(a) - t(b) || String(a.id ?? "").localeCompare(String(b.id ?? ""))
  );
  return shaped.slice(Math.max(0, shaped.length - OVERVIEW_MESSAGE_LIMIT));
}

// ── files ────────────────────────────────────────────────────────────────────

/** One customer invoice as the overview shows it. A draft can not be paid; a removed one counts for nothing. */
export function overviewInvoice(row: any): any {
  const status = String(row?.status ?? "").toUpperCase() || null;
  const removed = status === "DELETED" || status === "VOIDED";
  const draft = status === "DRAFT" || status === "SUBMITTED";
  const issued = status === "AUTHORISED" || status === "PAID";
  const total = numberOrNull(row?.total);
  return {
    id: row?.id ?? null,
    number: row?.invoice_number ?? null,
    reference: row?.reference ? plainText(row.reference) : null,
    status,
    status_words: removed
      ? (status === "VOIDED" ? "voided" : "deleted")
      : status === "SUBMITTED"
      ? "awaiting approval, cannot be paid"
      : draft
      ? "draft, cannot be paid"
      : status === "PAID"
      ? "paid"
      : status === "AUTHORISED"
      ? ((numberOrNull(row?.amount_due) ?? 0) > 0 ? "sent, owing" : "sent")
      : (status ?? "unknown").toLowerCase(),
    counts_as_invoiced: issued,
    draft,
    removed,
    total,
    // a removed invoice was never paid, whatever a stale row or event says
    amount_paid: removed ? 0 : numberOrNull(row?.amount_paid),
    amount_due: issued ? numberOrNull(row?.amount_due) : 0,
    invoice_date: row?.invoice_date ?? null,
    due_date: row?.due_date ?? null,
    fully_paid_on: removed ? null : row?.fully_paid_on ?? null,
    updated_at: row?.updated_at ?? null,
  };
}

/** Invoice totals: only issued invoices count as invoiced, paid or owing; drafts are counted apart. */
export function invoiceTotals(invoices: any[]): any {
  let invoiced = 0, paid = 0, owing = 0, draftTotal = 0, drafts = 0;
  for (const i of invoices) {
    if (i.counts_as_invoiced) {
      invoiced += i.total ?? 0;
      paid += i.amount_paid ?? 0;
      owing += i.amount_due ?? 0;
    } else if (i.draft) {
      drafts += 1;
      draftTotal += i.total ?? 0;
    }
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    invoiced: r(invoiced),
    paid: r(paid),
    owing: r(owing),
    drafts,
    draft_total: r(draftTotal),
  };
}

/** One quote document as the overview shows it (its value only from job_quote_values). */
export function overviewQuote(
  view: QuoteDocumentView,
  viewCounts: Map<string, number> | null,
  current: boolean,
): any {
  return {
    document_id: view.document_id,
    quote_number: view.quote_number,
    version: view.version,
    run_label: view.run_label,
    option_label: view.option_label,
    status: view.superseded_at ? "replaced" : view.status,
    value_inc_gst: view.value_inc_gst,
    value_source: view.value_source,
    sent_at: view.sent_at,
    viewed_at: view.viewed_at,
    accepted_at: view.accepted_at,
    declined_at: view.declined_at,
    superseded_at: view.superseded_at,
    view_count: viewCounts ? (viewCounts.get(view.document_id) ?? 0) : null,
    current,
  };
}

export function overviewQuotes(
  quotes: JobQuotes,
  viewCounts: Map<string, number> | null,
): any {
  return {
    status: quotes.status,
    headline: quotes.headline,
    documents: [
      ...quotes.current.map((v) => overviewQuote(v, viewCounts, true)),
      ...quotes.history.map((v) => overviewQuote(v, viewCounts, false)),
    ],
    history_total: quotes.history_total,
    unsent_documents: quotes.unsent_documents,
    note: quotes.note,
  };
}

/** An email attachment or an uploaded document from its evidence row; null for our own documents. */
export function overviewAttachment(row: any): any | null {
  const at = row?.event_at ?? row?.occurred_at ?? null;
  if (row?.event_type === "document.text_extracted") {
    if (row?.source_kind !== "email_attachment") return null;
    return {
      id: row?.id ?? null,
      source: "email_attachment",
      file_name: row?.file_name ? plainText(row.file_name) : null,
      label: row?.label ? plainText(row.label) : null,
      content_type: row?.content_type ?? null,
      page_count: numberOrNull(row?.page_count),
      sha256: row?.sha256 ?? null,
      at,
      at_perth: perthStamp(at),
    };
  }
  if (row?.event_type === "document.uploaded") {
    return {
      id: row?.id ?? null,
      source: "upload",
      file_name: row?.uploaded_file_name
        ? plainText(row.uploaded_file_name)
        : null,
      label: row?.uploaded_type ? plainText(row.uploaded_type) : null,
      content_type: null,
      page_count: null,
      sha256: null,
      at,
      at_perth: perthStamp(at),
    };
  }
  return null;
}

// ── the story card, without transcript words ────────────────────────────────

/** The card as the overview shows it: a loop's quoted why and a transcript's last-exchange words are taken out. */
export function overviewStory(card: any): any {
  if (!card || typeof card !== "object") return card;
  const story = { ...card };
  if (Array.isArray(card.loops)) {
    story.loops = card.loops.map((l: any) =>
      l && typeof l === "object" ? { ...l, why: null } : l
    );
  }
  const le = card.last_exchange;
  if (le && typeof le === "object") {
    const scrub = (x: any) => {
      if (!x || typeof x !== "object") return x;
      const transcript = x.event_type === TRANSCRIPT_EVENT ||
        (typeof x.text === "string" &&
          /^Call \(speakers not labelled\)/.test(x.text));
      return transcript
        ? { ...x, text: null, text_withheld: "call_transcript" }
        : x;
    };
    story.last_exchange = {
      ...le,
      customer_said: scrub(le.customer_said),
      we_told_customer: scrub(le.we_told_customer),
      internal: scrub(le.internal),
    };
  }
  return story;
}

// ── the reads ────────────────────────────────────────────────────────────────

async function part<T>(
  label: string,
  run: () => Promise<{ data: T | null; status: OverviewPartStatus }>,
): Promise<{ data: T | null; status: OverviewPartStatus }> {
  try {
    return await run();
  } catch (e) {
    return {
      data: null,
      status: failed("read_threw", sanitizedError(`${label} read threw`, e)),
    };
  }
}

const JOB_COLUMNS =
  "id, job_number, type, status, client_name, client_phone, client_email, site_address, site_suburb, ghl_contact_id, ghl_opportunity_id, deposit_amount, created_at, quoted_at, accepted_at, scheduled_at, completed_at, updated_at, pricing_json";

const INVOICE_COLUMNS =
  "id, invoice_number, reference, invoice_type, status, total, amount_due, amount_paid, invoice_date, due_date, fully_paid_on, updated_at";

const ATTACHMENT_COLUMNS =
  "id, event_type, event_at, occurred_at, file_name:payload->document->>file_name, label:payload->document->>label, content_type:payload->document->>content_type, page_count:payload->document->>page_count, source_kind:payload->document->>source_kind, sha256:payload->document->>sha256, uploaded_file_name:payload->>file_name, uploaded_type:payload->>type";

const CALL_FACT_COLUMNS =
  "id, event_type, provider_message_id, seconds:payload->duration_seconds, call_status:payload->>call_status, ghl_call_id:payload->>ghl_call_id, legacy_event_id:payload->>legacy_event_id";

async function readEventTypes(
  client: any,
  ids: string[],
): Promise<Map<string, string> | null> {
  const unique = [...new Set(ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  const types = new Map<string, string>();
  if (!unique.length) return types;
  for (let i = 0; i < unique.length; i += 100) {
    const { data, error } = await client.from("business_events")
      .select("id, event_type")
      .in("id", unique.slice(i, i + 100));
    if (error) {
      sanitizedError("receipt kinds read failed", error);
      return null;
    }
    for (const r of Array.isArray(data) ? data : []) {
      if (r?.id) types.set(String(r.id), String(r.event_type ?? ""));
    }
  }
  return types;
}

async function readCallFacts(
  client: any,
  messages: any[],
): Promise<{ facts: Map<string, CallFacts>; ok: boolean }> {
  const ids = [
    ...new Set(
      (Array.isArray(messages) ? messages : [])
        .filter((m) =>
          m?.source_system === "business_events" && m?.channel === "call" &&
          m?.source_ref
        )
        .map((m) => String(m.source_ref)),
    ),
  ];
  const facts = new Map<string, CallFacts>();
  if (!ids.length) return { facts, ok: true };
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await client.from("business_events")
      .select(CALL_FACT_COLUMNS)
      .in("id", ids.slice(i, i + 100));
    if (error) {
      sanitizedError("call facts read failed", error);
      return { facts, ok: false };
    }
    for (const r of Array.isArray(data) ? data : []) {
      if (!r?.id) continue;
      facts.set(String(r.id), {
        id: String(r.id),
        event_type: r.event_type ?? null,
        provider_message_id: r.provider_message_id ?? null,
        seconds: numberOrNull(r.seconds),
        call_status: typeof r.call_status === "string" ? r.call_status : null,
        ghl_call_id: typeof r.ghl_call_id === "string" && r.ghl_call_id
          ? r.ghl_call_id
          : null,
        legacy_event_id:
          typeof r.legacy_event_id === "string" && r.legacy_event_id
            ? r.legacy_event_id
            : null,
      });
    }
  }
  return { facts, ok: true };
}

async function readQuoteViewCounts(
  client: any,
  jobId: string,
): Promise<Map<string, number> | null> {
  const { data, error } = await client.from("job_events")
    .select("document_id:detail_json->>document_id")
    .eq("job_id", jobId)
    .eq("event_type", "quote_viewed")
    .limit(2000);
  if (error) {
    sanitizedError("quote views read failed", error);
    return null;
  }
  const counts = new Map<string, number>();
  for (const r of Array.isArray(data) ? data : []) {
    const id = typeof r?.document_id === "string" ? r.document_id : null;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * GET job_overview: jobId (a uuid) or job_number. Staff only (the front
 * door), read only. The job must resolve (else 400/404/409 as job_story
 * answers); every other part reads on its own and reports in sources.
 */
export async function jobOverviewAction(
  client: any,
  params: URLSearchParams,
  deps: JobOverviewDeps,
) {
  const job = await resolveStoryJob(client, {
    job_id: params.get("jobId") ?? params.get("job_id"),
    job_number: params.get("job_number") ?? params.get("jobNumber"),
  });
  const now = deps.now ? deps.now() : new Date();
  const asOf = now.toISOString();

  const header = await part<any>("job", async () => {
    const { data, error } = await client.from("jobs").select(JOB_COLUMNS).eq(
      "id",
      job.id,
    ).limit(1);
    if (error) {
      return {
        data: null,
        status: failed("read_failed", sanitizedError("job read failed", error)),
      };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { data: null, status: failed("job_not_found") };
    return { data: row, status: ok(1) };
  });
  const jobRow = header.data;

  const [
    storyRead,
    notesRead,
    conversationRead,
    quotesRead,
    viewCounts,
    invoicesRead,
    attachmentsRead,
    mediaRead,
    scopeRead,
  ] = await Promise.all([
    part<any>("story", async () => {
      const read = await readJobStory(client, { jobId: job.id });
      return {
        data: read.story,
        status: read.story
          ? ok(read.status.count)
          : failed(read.status.code ?? "story_failed", read.status.error),
      };
    }),
    part<any>("notes", async () => {
      const { data, error } = await client.rpc("context_job_story_ledger", {
        p_job_id: job.id,
        p_generation_id: null,
        p_as_of: asOf,
      });
      if (error) {
        return {
          data: null,
          status: failed(
            "rpc_failed",
            sanitizedError("notes read failed", error),
          ),
        };
      }
      if (!data || typeof data !== "object") {
        return { data: null, status: failed("empty_payload") };
      }
      return {
        data,
        status: ok(Array.isArray(data.items) ? data.items.length : 0),
      };
    }),
    part<any>("messages", async () => {
      const conversation = await deps.getJobConversation(client, {
        job_id: job.id,
        limit: OVERVIEW_CONVERSATION_READ,
      });
      const messages = Array.isArray(conversation?.messages)
        ? conversation.messages
        : null;
      if (!messages) return { data: null, status: failed("invalid_shape") };
      return { data: messages, status: ok(messages.length) };
    }),
    part<JobQuotes>("quotes", async () => {
      const read = await readJobQuotes(client, {
        id: job.id,
        client_email: jobRow?.client_email ?? null,
      });
      return {
        data: read.quotes,
        status: read.quotes
          ? ok(read.status.count)
          : failed(read.status.code ?? "read_failed"),
      };
    }),
    readQuoteViewCounts(client, job.id).catch((e) => {
      sanitizedError("quote views read threw", e);
      return null;
    }),
    part<any[]>("invoices", async () => {
      const { data, error } = await client.from("xero_invoices")
        .select(INVOICE_COLUMNS)
        .eq("job_id", job.id)
        .order("invoice_date", { ascending: true })
        .limit(200);
      if (error) {
        return {
          data: null,
          status: failed(
            "read_failed",
            sanitizedError("invoices read failed", error),
          ),
        };
      }
      const rows = (Array.isArray(data) ? data : []).filter((r: any) =>
        String(r?.invoice_type ?? "ACCREC").toUpperCase() === "ACCREC"
      );
      return { data: rows, status: ok(rows.length) };
    }),
    part<any[]>("attachments", async () => {
      const { data, error } = await client.from("business_events")
        .select(ATTACHMENT_COLUMNS)
        .eq("job_id", job.id)
        .in("event_type", ["document.text_extracted", "document.uploaded"])
        .order("occurred_at", { ascending: false })
        .limit(OVERVIEW_ATTACHMENT_LIMIT);
      if (error) {
        return {
          data: null,
          status: failed(
            "read_failed",
            sanitizedError("attachments read failed", error),
          ),
        };
      }
      const seen = new Set<string>();
      const rows: any[] = [];
      for (const r of Array.isArray(data) ? data : []) {
        const a = overviewAttachment(r);
        if (!a) continue;
        const key = a.sha256 ?? `${a.file_name ?? ""}|${a.at ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(a);
      }
      return { data: rows, status: ok(rows.length) };
    }),
    part<any>("media", async () => {
      const { data, error } = await client.from("job_media").select("type").eq(
        "job_id",
        job.id,
      ).limit(2000);
      if (error) {
        return {
          data: null,
          status: failed(
            "read_failed",
            sanitizedError("media read failed", error),
          ),
        };
      }
      const rows = Array.isArray(data) ? data : [];
      const videos = rows.filter((r: any) =>
        String(r?.type ?? "").toLowerCase() === "video"
      ).length;
      return {
        data: { photos: rows.length - videos, videos, total: rows.length },
        status: ok(rows.length),
      };
    }),
    part<any>("scope", async () => {
      const { data, error } = await client.from("jobs").select("id").eq(
        "id",
        job.id,
      ).not("scope_json", "is", null).limit(1);
      if (error) {
        return {
          data: null,
          status: failed(
            "read_failed",
            sanitizedError("scope read failed", error),
          ),
        };
      }
      const exists =
        (Array.isArray(data) ? data : data ? [data] : []).length > 0;
      return { data: { exists }, status: ok(exists ? 1 : 0) };
    }),
  ]);

  // The saved story: compared with the card just read (never built twice); a
  // failed card read still answers, unchecked.
  const storyText = await part<any>("story_text", async () => {
    const args: Record<string, unknown> = { p_job_id: job.id };
    if (storyRead.data) args.p_card = storyRead.data;
    else args.p_check = false;
    const { data, error } = await client.rpc(
      "context_job_story_text_get",
      args,
    );
    if (error) {
      if (isMissingFunction(error)) {
        return {
          data: null,
          status: {
            ok: false,
            state: "not_deployed" as const,
            count: 0,
            code: "not_deployed",
          },
        };
      }
      return {
        data: null,
        status: failed(
          "rpc_failed",
          sanitizedError("story text read failed", error),
        ),
      };
    }
    if (
      !data || typeof data !== "object" || data.version !== "job-story-text-v1"
    ) {
      return { data: null, status: failed("invalid_shape") };
    }
    return { data, status: ok(data.text ? 1 : 0) };
  });

  // The notes' receipts: no words from a call transcript, ever.
  const items: any[] = Array.isArray(notesRead.data?.items)
    ? notesRead.data.items
    : [];
  const receiptIds = items.flatMap((i) =>
    receiptsOf(i).filter((r) => r.table === "business_events" && r.id).map((
      r,
    ) => String(r.id))
  );
  const eventTypes = receiptIds.length
    ? await readEventTypes(client, receiptIds).catch(() => null)
    : new Map();
  const notes = notesRead.data
    ? {
      status: notesRead.data.status ?? null,
      generation_id: notesRead.data.generation?.id ?? null,
      evidence_until: notesRead.data.generation?.evidence_until ?? null,
      reader: notesRead.data.generation?.reader ?? null,
      unread_rows: notesRead.data.unread_rows ?? null,
      items: items.map((i) => overviewNote(i, eventTypes)),
    }
    : null;
  const notesStatus = notesRead.data && eventTypes === null
    ? { ...notesRead.status, code: "receipt_kinds_unread" }
    : notesRead.status;

  // The conversation: calls merged with their facts.
  let messages: any[] | null = null;
  let messagesStatus = conversationRead.status;
  if (conversationRead.data) {
    const facts = await readCallFacts(client, conversationRead.data).catch(
      () => ({ facts: new Map<string, CallFacts>(), ok: false }),
    );
    messages = overviewMessages(
      conversationRead.data,
      facts.facts,
      jobRow?.client_name ?? null,
    );
    messagesStatus = {
      ...ok(messages.length),
      ...(facts.ok ? {} : { code: "call_facts_unread" }),
    };
  }

  const invoices = invoicesRead.data
    ? invoicesRead.data.map(overviewInvoice)
    : null;
  const pricing = jobRow?.pricing_json;
  const job_header = jobRow
    ? {
      id: jobRow.id,
      job_number: jobRow.job_number ?? null,
      type: jobRow.type ?? null,
      status: jobRow.status ?? null,
      client_name: jobRow.client_name ? plainText(jobRow.client_name) : null,
      client_phone: jobRow.client_phone ?? null,
      client_email: jobRow.client_email ?? null,
      site_address: jobRow.site_address ? plainText(jobRow.site_address) : null,
      site_suburb: jobRow.site_suburb ? plainText(jobRow.site_suburb) : null,
      ghl_contact_id: jobRow.ghl_contact_id ?? null,
      ghl_opportunity_id: jobRow.ghl_opportunity_id ?? null,
      deposit_amount: numberOrNull(jobRow.deposit_amount),
      created_at: jobRow.created_at ?? null,
      quoted_at: jobRow.quoted_at ?? null,
      accepted_at: jobRow.accepted_at ?? null,
      scheduled_at: jobRow.scheduled_at ?? null,
      completed_at: jobRow.completed_at ?? null,
      // the job's live price (pricing_json.totalIncGST), never a quote's value
      current_price_inc_gst: currentPriceIncGst(pricing),
      job_description: pricing && typeof pricing === "object" &&
          typeof pricing.job_description === "string"
        ? plainText(pricing.job_description)
        : null,
    }
    : { id: job.id, job_number: job.job_number };

  return {
    version: JOB_OVERVIEW_VERSION,
    generated_at: asOf,
    job: job_header,
    story: storyRead.data ? overviewStory(storyRead.data) : null,
    notes,
    messages,
    files: {
      quotes: quotesRead.data
        ? overviewQuotes(quotesRead.data, viewCounts)
        : null,
      invoices,
      invoice_totals: invoices ? invoiceTotals(invoices) : null,
      attachments: attachmentsRead.data,
      media: mediaRead.data,
      media_count: mediaRead.data ? mediaRead.data.photos : null,
      scope: scopeRead.data,
    },
    story_text: storyText.data,
    sources: {
      job: header.status,
      story: storyRead.status,
      notes: notesStatus,
      messages: messagesStatus,
      quotes: quotesRead.status,
      quote_views: viewCounts ? ok(viewCounts.size) : failed("read_failed"),
      invoices: invoicesRead.status,
      attachments: attachmentsRead.status,
      media: mediaRead.status,
      scope: scopeRead.status,
      story_text: storyText.status,
    },
  };
}

/**
 * POST request_job_story: { jobId } (or job_id, job_number). Asks for the
 * job's story to be written or rewritten, as the verified caller (never a
 * body field). The SQL outcome passes through: queued, already_open, recent
 * (the story is new and still current), off (the switch is off).
 */
export async function requestJobStoryAction(
  client: any,
  body: any,
  actor: string,
) {
  const job = await resolveStoryJob(client, {
    job_id: body?.jobId ?? body?.job_id,
    job_number: body?.job_number ?? body?.jobNumber,
  });
  const { data, error } = await client.rpc("context_job_story_request", {
    p_job_id: job.id,
    p_by: actor,
    p_reason: "asked",
  });
  if (error) {
    if (isMissingFunction(error)) {
      throw new StoryReadError(
        "not_deployed",
        "the saved job story is not installed yet",
        503,
      );
    }
    throw new StoryReadError(
      "request_failed",
      sanitizedError("story request failed", error),
      502,
    );
  }
  if (!data || typeof data !== "object" || typeof data.outcome !== "string") {
    throw new StoryReadError(
      "invalid_shape",
      "story request answer not recognised",
      502,
    );
  }
  return {
    version: "job-story-request-v1",
    job_id: job.id,
    job_number: job.job_number,
    ...data,
  };
}
