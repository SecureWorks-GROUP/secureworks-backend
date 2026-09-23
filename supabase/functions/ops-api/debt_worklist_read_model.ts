// deno-lint-ignore-file no-explicit-any
//
// Debtor work list (debt collection redesign, PR 3 of the 24 Sep 2026 review).
//
// One read: the whole open receivable book, grouped into debtors. SELECT-only.
// Never calls Xero or GHL, never writes, never classifies, never sends.
//
// A debtor is one verified Xero contact: the invoice's xero_contact_id must
// equal the ContactID inside the invoice's own Xero payload. A shared name is
// not a join, and neither is a shared GHL contact. An invoice whose contact
// cannot be verified stands alone as its own debtor with the reason on it.
// Every open invoice is listed separately under exactly one debtor.
// A debtor timeline covers open invoices only; closed-invoice events and
// payments are outside this read. Invoice GHL/email/notes health points to the
// debtor's source status rather than repeating it on every invoice.
// GHL cache freshness uses the 24-hour v1 default from
// GHL_CACHE_STALE_HOURS and publishes it as stale_after beside the sync time.
//
// It builds no second status or message engine. It consumes:
//   - debt_picture.ts      the desk's stored classification, next step and
//                          owner columns, and its chase-log note shape;
//   - invoice_context.ts   debtContextCoverage: job link, facts, stored
//                          conversation counts and blockers per invoice;
//   - getJobConversation   (index.ts) the stored message merge per job.
// The timeline adds what that merge leaves out (payment_chase_logs, invoice
// events and Xero payments, captured Luna facts, and GHL messages and notes
// held by a verified Xero/GHL contact_matches pair) and removes the same
// message seen twice. A signed-in caller from another org is refused first.
//
// Honesty rules: a source that could not be read is a fault on the row it
// touches, never an empty list or a zero; every summary count names its
// denominator; every row carries its as-of time and freshness. Stored copies
// are not a provider census: an empty timeline never means "no contact".

import {
  chaseLogThreadEntry,
  DEBT_PICTURE_VERSION,
  debtTypeFromReference,
} from "./debt_picture.ts";
import {
  chunk,
  debtContextCoverage,
  INVOICE_CONTEXT_VERSION,
  type InvoiceContextDeps,
  num,
  OPEN_STATUSES,
  pageThrough,
  parseXeroDate,
  str,
  unwrap,
  XERO_STALE_HOURS,
} from "./invoice_context.ts";
import { isLunaSubscriptionFact } from "./context_visibility.ts";
import { emailKey, phoneKey } from "../_shared/job_refs.ts";

export const DEBT_WORKLIST_VERSION = "debt-worklist/v1";

// Bounded fan-out for the per-job conversation reads (one merge call per job).
const CONVERSATION_CONCURRENCY = 6;
const TIMELINE_BOUNDS = {
  // List: newest entries per job from the merge, then the newest per debtor.
  recent: { per_job: 10, facts_per_job: 10, per_debtor: 12 },
  // One debtor: everything the merge will return per job, no debtor trim.
  full: { per_job: 100, facts_per_job: 60, per_debtor: null as number | null },
} as const;
type TimelineMode = keyof typeof TIMELINE_BOUNDS;
// A chase-log SMS and the provider's copy of it are one message when the text
// matches and they are this close in time.
const SAME_SMS_WINDOW_MS = 15 * 60_000;
const CONFIRMED_INBOX_EVENT_COPY_STATES: ReadonlySet<string> = new Set();
// The v1 default GHL conversation cache freshness threshold.
export const GHL_CACHE_STALE_HOURS = 24;

export const POPULATION_DENOMINATOR =
  "open receivables: Xero ACCREC invoices with status AUTHORISED or SUBMITTED and amount due above zero";
export const DEBTOR_DENOMINATOR =
  "debtors: one per verified Xero contact; an invoice whose contact cannot be verified stands alone";
export const STORED_COPIES_NOTE =
  "stored copies only (GHL cache, inbox and business events); not a live GHL or Outlook read, and Outlook Sent Items are not captured";

export class DebtWorklistError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_request",
  ) {
    super(message);
    this.name = "DebtWorklistError";
  }
}

export interface DebtWorklistDeps extends InvoiceContextDeps {
  /**
   * The signed-in caller's org, when the caller is a user session. Anything
   * other than orgId (null included) is refused before any read. Undefined
   * means a server caller (ops key, routine) with no user org to check.
   */
  callerOrgId?: string | null;
  /** index.ts getJobConversation; called with report_faults so faults are named. */
  getJobConversation: (
    client: any,
    body: {
      job_id: string;
      limit: number;
      report_faults?: boolean;
    },
  ) => Promise<{ messages: any[]; read_faults?: string[] }>;
}

export interface Fault {
  source: string;
  detail: string;
}

export interface TimelineEntry {
  key: string;
  kind: string;
  channel: string | null;
  provider: string;
  provider_id: string | null;
  at: string | null;
  at_precision: "time" | "date";
  direction: string;
  author: string | null;
  source: string;
  source_ref: string | null;
  subject: string | null;
  preview: string;
  job_id: string | null;
  invoice_ids: string[];
  invoice_scope: "invoice" | "job" | "debtor" | "unplaced";
  seen_in: string[];
  label: string | null;
  /** Only on captured fact entries. */
  fact?: {
    kind: string | null;
    value: unknown;
    captured_at: string | null;
    source_id: string;
    state: "current" | "stale";
  };
}

// ── small helpers ────────────────────────────────────────────────────────────

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String((e as any)?.message ?? e);
}

function daysOverdue(dueDate: string | null, now: Date): number | null {
  if (!dueDate) return null;
  const due = Date.parse(`${dueDate.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(due)) return null;
  const perthNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const today = Date.UTC(
    perthNow.getUTCFullYear(),
    perthNow.getUTCMonth(),
    perthNow.getUTCDate(),
  );
  return Math.round((today - due) / 86_400_000);
}

async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

function normText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function providerFromId(providerId: string | null, fallback: string): string {
  if (!providerId) return fallback;
  const prefix = providerId.split(":")[0];
  if (prefix === "ghl") return "ghl";
  if (prefix === "graph" || prefix === "graph-group") return "outlook";
  return prefix || fallback;
}

function xeroContactEvidence(invoices: any[]) {
  const byContact = new Map<string, { emails: Set<string>; phones: Set<string> }>();
  for (const invoice of invoices) {
    const identity = debtorIdentityFor(invoice);
    if (identity.status !== "verified" || !identity.xero_contact_id) continue;
    const evidence = byContact.get(identity.xero_contact_id) ?? {
      emails: new Set<string>(),
      phones: new Set<string>(),
    };
    const email = emailKey(str(invoice.raw_contact_email));
    if (email) evidence.emails.add(email);
    const phones = Array.isArray(invoice.raw_contact_phones)
      ? invoice.raw_contact_phones
      : [];
    for (const phone of phones) {
      const key = phoneKey(
        `${phone?.PhoneAreaCode ?? ""}${phone?.PhoneNumber ?? ""}`,
      );
      if (key) evidence.phones.add(key);
    }
    byContact.set(identity.xero_contact_id, evidence);
  }
  return {
    byContact,
    verifies(match: Record<string, unknown>) {
      const evidence = byContact.get(String(match.xero_contact_id ?? ""));
      if (!evidence) return false;
      const email = emailKey(str(match.email));
      const phone = phoneKey(str(match.phone));
      return Boolean(
        (email && evidence.emails.has(email)) ||
          (phone && evidence.phones.has(phone)),
      );
    },
  };
}

// ── debtor identity ──────────────────────────────────────────────────────────

export interface DebtorIdentity {
  key: string;
  status:
    | "verified"
    | "no_contact"
    | "contact_unconfirmed"
    | "contact_conflict";
  xero_contact_id: string | null;
  detail: string | null;
}

/**
 * The debtor an invoice belongs to. Verified only when the mirror's contact id
 * is the ContactID in the invoice's own Xero payload; anything else stands
 * alone under its invoice id. Never keyed on a name.
 */
export function debtorIdentityFor(inv: {
  xero_invoice_id: string;
  xero_contact_id?: string | null;
  raw_contact_id?: string | null;
}): DebtorIdentity {
  const column = str(inv.xero_contact_id);
  const raw = str(inv.raw_contact_id);
  const alone = `invoice:${inv.xero_invoice_id}`;
  if (!column) {
    return {
      key: alone,
      status: "no_contact",
      xero_contact_id: null,
      detail:
        "Invoice has no Xero contact id; it stands alone until the contact is set in Xero",
    };
  }
  if (!raw) {
    return {
      key: alone,
      status: "contact_unconfirmed",
      xero_contact_id: column,
      detail:
        "The stored Xero payload has no ContactID, so the contact cannot be confirmed; it stands alone",
    };
  }
  if (raw !== column) {
    return {
      key: alone,
      status: "contact_conflict",
      xero_contact_id: column,
      detail:
        `The mirror's contact id ${column} differs from the Xero payload's ContactID ${raw}; it stands alone until a Xero sync settles it`,
    };
  }
  return {
    key: `xero:${column}`,
    status: "verified",
    xero_contact_id: column,
    detail: null,
  };
}

// ── timeline ────────────────────────────────────────────────────────────────

/** One getJobConversation message as a timeline entry. */
export function entryFromConversation(
  m: any,
  jobId: string,
  jobInvoiceIds: string[],
): TimelineEntry {
  const source = String(m.source_system ?? "unknown");
  const providerId = str(m.provider_message_id);
  const fallbackProvider = source === "ghl_cache"
    ? "ghl"
    : source === "inbox"
    ? "outlook"
    : "secureworks";
  const channel = str(m.channel);
  const inboxPlacementVerified = source === "inbox" &&
    typeof m.event_copy === "string" &&
    CONFIRMED_INBOX_EVENT_COPY_STATES.has(m.event_copy);
  const unplacedInbox = source === "inbox" && !inboxPlacementVerified;
  const kind = channel === "note" && source === "job_events"
    ? "job_note"
    : channel === "note"
    ? "ghl_note"
    : channel ?? "message";
  return {
    key: providerId ?? `${source}:${m.source_ref ?? m.id}`,
    kind,
    channel,
    provider: providerId?.startsWith("ghlnote:")
      ? "ghl"
      : providerFromId(providerId, fallbackProvider),
    provider_id: providerId,
    at: str(m.occurred_at),
    at_precision: "time",
    direction: str(m.direction) ?? "unknown",
    author: str(m.author),
    source,
    source_ref: str(m.source_ref),
    subject: str(m.subject),
    preview: String(m.preview ?? m.body ?? "").slice(0, 500),
    job_id: unplacedInbox ? null : jobId,
    invoice_ids: unplacedInbox ? [] : [...jobInvoiceIds],
    invoice_scope: unplacedInbox ? "unplaced" : "job",
    seen_in: [source],
    label: unplacedInbox
      ? "unplaced, matched by the old guess"
      : str(m.label),
  };
}

export function entryFromGhlContactNote(
  row: any,
  debtorInvoiceIds: string[],
  jobInvoiceIds?: string[],
): TimelineEntry {
  const payload = row.payload ?? {};
  const providerId = str(row.provider_message_id);
  const jobId = str(row.job_id);
  const body = String(
    payload.body ?? payload.text ?? payload.message ?? payload.note_text ??
      row.body_preview ?? "",
  );
  return {
    key: providerId ?? `business_events:${row.id}`,
    kind: "ghl_note",
    channel: "note",
    provider: "ghl",
    provider_id: providerId,
    at: str(row.occurred_at),
    at_precision: "time",
    direction: "internal",
    author: str(payload.added_by) ?? str(payload.sent_by_user) ??
      str(payload.from),
    source: "business_events",
    source_ref: str(row.id),
    subject: null,
    preview: body.slice(0, 500),
    job_id: jobId,
    invoice_ids: jobId ? [...(jobInvoiceIds ?? [])] : [...debtorInvoiceIds],
    invoice_scope: jobId ? "job" : "debtor",
    seen_in: ["business_events"],
    label: null,
  };
}

/** A payment_chase_logs row: a desk note, a logged call, an SMS send log, or a classification change. */
export function entryFromChaseLog(row: any): TimelineEntry {
  const thread = chaseLogThreadEntry(row);
  const method = String(row.method ?? "");
  const isSms = method === "sms" || method === "auto_sms";
  const kind = method === "note"
    ? "debt_note"
    : method === "call"
    ? "call"
    : isSms
    ? "sms"
    : method === "email"
    ? "email"
    : "debt_log";
  const channel = method === "call"
    ? "call"
    : isSms
    ? "sms"
    : method === "email"
    ? "email"
    : "note";
  return {
    key: `chase:${row.id}`,
    kind,
    channel,
    provider: "secureworks",
    provider_id: null,
    at: str(row.created_at),
    at_precision: "time",
    direction: isSms
      ? "outbound"
      : method === "email" || method === "call"
      ? "unknown"
      : "internal",
    author: str(thread.who),
    source: "payment_chase_logs",
    source_ref: str(row.id),
    subject: thread.tag ? String(thread.tag) : null,
    preview: String(thread.text ?? "").slice(0, 500),
    job_id: str(row.job_id),
    invoice_ids: row.xero_invoice_id ? [row.xero_invoice_id] : [],
    invoice_scope: "invoice",
    seen_in: ["payment_chase_logs"],
    label: method === "auto_sms"
      ? "GHL workflow SMS"
      : method === "sms"
      ? "chase log of an SMS send"
      : null,
  };
}

/** Invoice lifecycle rows in business_events (emailed, approved and sent, payment reconciled). */
export function entryFromInvoiceEvent(row: any): TimelineEntry {
  const type = String(row.event_type ?? "");
  const p = row.payload ?? {};
  const outbound = /emailed|sent/.test(type);
  return {
    key: `bev:${row.id}`,
    kind: "invoice_event",
    channel: outbound ? "email" : null,
    provider: "secureworks",
    provider_id: str(row.provider_message_id),
    at: str(row.occurred_at),
    at_precision: "time",
    direction: outbound ? "outbound" : "system",
    author: str(row.metadata_operator) ??
      str(p.operator_email) ?? str(p.sent_by) ?? str(p.actor),
    source: "business_events",
    source_ref: str(row.id),
    subject: type,
    preview: String(p.to_email ? `${type} to ${p.to_email}` : type).slice(
      0,
      500,
    ),
    job_id: str(row.job_id),
    invoice_ids: row.entity_id ? [row.entity_id] : [],
    invoice_scope: "invoice",
    seen_in: ["business_events"],
    label: null,
  };
}

/**
 * A captured Luna fact on a linked job. Current or stale is the same currency
 * rule the invoice context door counts by (isCurrentContextFact); a stale fact
 * is shown and labelled, never hidden.
 */
export function entryFromFact(
  row: any,
  jobId: string,
  jobInvoiceIds: string[],
  state: "current" | "stale",
): TimelineEntry {
  const capturedAt = str(row.updated_at) ?? str(row.created_at);
  const value = row.value ?? null;
  const preview = typeof value === "string"
    ? value
    : value === null
    ? ""
    : JSON.stringify(value);
  return {
    key: `fact:${row.id}`,
    kind: "fact",
    channel: null,
    provider: "luna",
    provider_id: str(row.id),
    at: capturedAt,
    at_precision: "time",
    direction: "system",
    author: null,
    source: "current_job_context_facts",
    source_ref: str(row.id),
    subject: str(row.kind),
    preview: preview.slice(0, 500),
    job_id: jobId,
    invoice_ids: [...jobInvoiceIds],
    invoice_scope: "job",
    seen_in: ["current_job_context_facts"],
    label: state === "stale" ? "stale fact" : null,
    fact: {
      kind: str(row.kind),
      value,
      captured_at: capturedAt,
      source_id: String(row.id),
      state,
    },
  };
}

/**
 * One message from a GHL conversation cache row read by contact (a verified
 * Xero/GHL contact_matches pair with no job). Same channel rule as
 * getJobConversation's GHL block, and the same ghl:<id> key, so a copy also
 * seen through a job collapses into one entry.
 */
export function entryFromGhlCacheMessage(
  m: any,
  ghlContactId: string,
  debtorInvoiceIds: string[],
): TimelineEntry {
  const type = String(m?.type ?? "");
  const isCall = m?.source === "call_transcript" ||
    /CALL|VOICEMAIL/i.test(type);
  const channel = isCall
    ? "call"
    : type.toUpperCase().includes("EMAIL")
    ? "email"
    : "sms";
  const id = str(m?.id);
  const body = String(m?.body ?? "");
  return {
    key: id ? `ghl:${id}` : `ghl_cache:${ghlContactId}:${m?.timestamp ?? ""}`,
    kind: channel,
    channel,
    provider: "ghl",
    provider_id: id ? `ghl:${id}` : null,
    at: str(m?.timestamp),
    at_precision: "time",
    direction: str(m?.direction) ?? "inbound",
    author: str(m?.sender_name),
    source: "ghl_cache",
    source_ref: id,
    subject: null,
    preview: body.slice(0, 500),
    job_id: null,
    invoice_ids: [...debtorInvoiceIds],
    invoice_scope: "debtor",
    seen_in: ["ghl_cache"],
    label: "read by contact match (no job)",
  };
}

/** Xero facts carried on the mirror: the invoice raised, and each payment against it. */
export function xeroEntriesFor(inv: any): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const base = {
    channel: null,
    provider: "xero",
    direction: "system",
    author: null,
    source: "xero_mirror",
    subject: null,
    job_id: str(inv.job_id),
    invoice_ids: [inv.xero_invoice_id],
    invoice_scope: "invoice" as const,
    seen_in: ["xero_mirror"],
    label: null,
  };
  const raised = str(inv.invoice_date);
  if (raised) {
    out.push({
      ...base,
      key: `xero:raised:${inv.xero_invoice_id}`,
      kind: "xero_invoice_raised",
      provider_id: inv.xero_invoice_id,
      at: raised.slice(0, 10),
      at_precision: "date",
      source_ref: inv.xero_invoice_id,
      preview: `${inv.invoice_number ?? "Invoice"} raised for ${
        num(inv.total) ?? "?"
      }${inv.due_date ? `, due ${String(inv.due_date).slice(0, 10)}` : ""}`,
    });
  }
  const payments = Array.isArray(inv.raw_payments) ? inv.raw_payments : [];
  payments.forEach((p: any, i: number) => {
    const pid = str(p?.PaymentID);
    out.push({
      ...base,
      key: `xero:payment:${pid ?? `${inv.xero_invoice_id}:${i}`}`,
      kind: "xero_payment",
      provider_id: pid,
      at: parseXeroDate(p?.Date),
      at_precision: "date",
      source_ref: pid ?? inv.xero_invoice_id,
      preview: `Payment of ${num(p?.Amount) ?? "?"} against ${
        inv.invoice_number ?? "the invoice"
      }`,
    });
  });
  return out;
}

function sortNewestFirst(entries: TimelineEntry[]): TimelineEntry[] {
  return [...entries].sort((a, b) => {
    const ax = a.at ?? "";
    const bx = b.at ?? "";
    if (ax !== bx) return ax < bx ? 1 : -1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

// Which copy of one message is kept when several sources hold it.
const SOURCE_RANK: Record<string, number> = {
  business_events: 0,
  ghl_cache: 1,
  inbox: 2,
  job_events: 3,
  payment_chase_logs: 4,
  xero_mirror: 5,
};

/**
 * Merges the entries into one timeline, newest first. The same provider
 * message seen by two sources (webhook capture and the GHL cache, or an inbox
 * row and its business event), and the same job's messages read for two
 * invoices, collapse to one entry that lists every source in seen_in. A chase
 * log of an SMS send collapses into the provider's outbound SMS with the same
 * text sent within 15 minutes.
 */
export function mergeTimeline(entries: TimelineEntry[]): {
  entries: TimelineEntry[];
  duplicates_merged: number;
} {
  const byKey = new Map<string, TimelineEntry>();
  let merged = 0;
  const absorb = (keep: TimelineEntry, other: TimelineEntry) => {
    if (keep.job_id !== other.job_id) {
      keep.job_id = null;
      keep.invoice_scope = "debtor";
    }
    for (const s of other.seen_in) {
      if (!keep.seen_in.includes(s)) keep.seen_in.push(s);
    }
    for (const id of other.invoice_ids) {
      if (!keep.invoice_ids.includes(id)) keep.invoice_ids.push(id);
    }
  };
  const ordered = [...entries].sort((a, b) =>
    (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9)
  );
  for (const e of ordered) {
    const copy: TimelineEntry = {
      ...e,
      seen_in: [...e.seen_in],
      invoice_ids: [...e.invoice_ids],
    };
    const existing = byKey.get(copy.key);
    if (existing) {
      absorb(existing, copy);
      merged += 1;
      continue;
    }
    byKey.set(copy.key, copy);
  }
  const kept = [...byKey.values()];
  const chaseSms = kept.filter((e) =>
    e.source === "payment_chase_logs" && e.kind === "sms"
  );
  const providerSms = kept.filter((e) =>
    e.source !== "payment_chase_logs" && e.channel === "sms" &&
    e.direction === "outbound"
  );
  const matchesByLog = new Map<string, TimelineEntry[]>();
  const logsByProvider = new Map<string, TimelineEntry[]>();
  for (const log of chaseSms) {
    const at = Date.parse(log.at ?? "");
    const text = normText(log.preview);
    if (!Number.isFinite(at) || !text) continue;
    const matches = providerSms.filter((m) => {
      const mt = Date.parse(m.at ?? "");
      const sharesJob = Boolean(log.job_id && m.job_id === log.job_id);
      const sharesInvoice = m.invoice_scope !== "debtor" &&
        log.invoice_ids.some((id) => m.invoice_ids.includes(id));
      return Number.isFinite(mt) && Math.abs(mt - at) <= SAME_SMS_WINDOW_MS &&
        (sharesJob || sharesInvoice) &&
        normText(m.preview).slice(0, 500) === text.slice(0, 500);
    });
    matchesByLog.set(log.key, matches);
    for (const match of matches) {
      const competingLogs = logsByProvider.get(match.key) ?? [];
      competingLogs.push(log);
      logsByProvider.set(match.key, competingLogs);
    }
  }
  const drop = new Set<string>();
  const consumed = new Set<string>();
  for (const log of chaseSms) {
    const matches = matchesByLog.get(log.key) ?? [];
    if (matches.length !== 1) continue;
    const match = matches[0];
    if (consumed.has(match.key) || logsByProvider.get(match.key)?.length !== 1) {
      continue;
    }
    consumed.add(match.key);
    absorb(match, log);
    drop.add(log.key);
    merged += 1;
  }
  return {
    entries: sortNewestFirst(kept.filter((e) => !drop.has(e.key))),
    duplicates_merged: merged,
  };
}

// ── next step ───────────────────────────────────────────────────────────────

/**
 * The debtor's next step is the stored next action with the earliest date;
 * with no dated action, the one on the largest invoice. It names the invoice it
 * came from so the screen never implies it covers the whole account.
 */
export function debtorNextStep(invoices: any[]) {
  const withAction = invoices.filter((i) => i.next_step?.action);
  if (!withAction.length) return null;
  const sorted = [...withAction].sort((a, b) => {
    const ad = a.next_step.at ?? "";
    const bd = b.next_step.at ?? "";
    if (ad && bd && ad !== bd) return ad < bd ? -1 : 1;
    if (ad && !bd) return -1;
    if (!ad && bd) return 1;
    const am = a.amount_due ?? 0;
    const bm = b.amount_due ?? 0;
    if (am !== bm) return bm - am;
    return String(a.invoice_number ?? "").localeCompare(
      String(b.invoice_number ?? ""),
    );
  });
  const pick = sorted[0];
  return {
    action: pick.next_step.action,
    at: pick.next_step.at,
    owner: pick.next_step.owner,
    from_invoice_id: pick.xero_invoice_id,
    from_invoice_number: pick.invoice_number,
  };
}

// ── the read ────────────────────────────────────────────────────────────────

const INVOICE_COLS = [
  "xero_invoice_id",
  "xero_contact_id",
  "contact_name",
  "invoice_number",
  "reference",
  "status",
  "total",
  "amount_due",
  "amount_paid",
  "invoice_date",
  "due_date",
  "job_id",
  "job_number",
  "synced_at",
  "debt_classification",
  "debt_type",
  "debt_blocker",
  "debt_owner",
  "debt_classification_reason",
  "debt_next_action",
  "debt_next_action_at",
  "debt_void_proposed",
  "debt_handoff_ref",
  "debt_handoff_at",
  "debt_source",
  "debt_as_of",
  "debt_brief",
  "debt_proposal_kind",
  "debt_proposal_text",
  "debt_proposal_to",
  "debt_proposal_status",
  "debt_proposal_at",
  "raw_contact_id:raw_json->Contact->>ContactID",
  "raw_contact_email:raw_json->Contact->>EmailAddress",
  "raw_contact_phones:raw_json->Contact->Phones",
  "raw_payments:raw_json->Payments",
  "sent_to_contact:raw_json->SentToContact",
].join(", ");

const INVOICE_EVENT_TYPES = [
  "invoice.emailed",
  "invoice.approved_and_sent",
  "invoice.approved",
  "invoice.authorised",
  "payment.reconciled",
  "payment.link_sent",
];

export async function debtWorklist(
  params: URLSearchParams,
  deps: DebtWorklistDeps,
) {
  if (deps.callerOrgId !== undefined && deps.callerOrgId !== deps.orgId) {
    throw new DebtWorklistError(
      "Organisation access required",
      403,
      "operator_org_required",
    );
  }
  const now = (deps.now ?? (() => new Date()))();
  const asOf = now.toISOString();
  const client = deps.client;
  const debtorFilter = str(params.get("debtor"));
  if (
    debtorFilter && !/^(xero|invoice):[A-Za-z0-9-]{1,64}$/.test(debtorFilter)
  ) {
    throw new DebtWorklistError(
      "debtor must be a debtor key (xero:<contact id> or invoice:<invoice id>)",
    );
  }
  const timelineRaw = str(params.get("timeline")) ??
    (debtorFilter ? "full" : "recent");
  if (!Object.hasOwn(TIMELINE_BOUNDS, timelineRaw)) {
    throw new DebtWorklistError("timeline must be recent or full");
  }
  const timelineMode = timelineRaw as TimelineMode;
  if (timelineMode === "full" && !debtorFilter) {
    throw new DebtWorklistError(
      "timeline=full needs one debtor; pass debtor=<key>",
    );
  }
  const warnings: string[] = [];
  const faults: Fault[] = [];

  // 1. The population. Without it nothing on this screen is honest, so a
  //    failed read refuses the whole call rather than returning an empty book.
  let population: any[];
  try {
    population = await pageThrough(
      "xero_invoices",
      () =>
        client.from("xero_invoices").select(INVOICE_COLS)
          .eq("org_id", deps.orgId).eq("invoice_type", "ACCREC")
          .in("status", OPEN_STATUSES).gt("amount_due", 0),
      warnings,
      "xero_invoice_id",
      true,
    );
  } catch (e) {
    throw new DebtWorklistError(
      `the open invoice book could not be read (${
        errText(e)
      }); nothing is shown rather than an empty book`,
      503,
      "population_unreadable",
    );
  }
  const populationIds = population.map((i) => i.xero_invoice_id);
  const xeroContact = xeroContactEvidence(population);
  const isContactMatchVerified = xeroContact.verifies;

  // 2. Per-invoice context from the coverage read (link, facts, conversation
  //    counts, blockers). One call for the whole book.
  const coverageById = new Map<string, any>();
  let coverage: any = null;
  let coverageFault: string | null = null;
  try {
    coverage = await debtContextCoverage(
      new URLSearchParams({ population: "open" }),
      deps,
    );
    for (const row of coverage.rows ?? []) {
      coverageById.set(row.xero_invoice_id, row);
    }
    for (const w of coverage.warnings ?? []) warnings.push(`context: ${w}`);
  } catch (e) {
    coverageFault = errText(e);
    faults.push({
      source: "context",
      detail: `debt_context_coverage failed: ${coverageFault}`,
    });
  }
  const coverageSources: Record<string, any> = coverage?.sources ?? {};
  const facetOk = (name: string) =>
    !coverageFault && coverageSources[name]?.ok !== false;
  const coverageIds = new Set(coverageById.keys());
  const populationSet = new Set(populationIds);
  const missingFromContext = coverageFault
    ? []
    : populationIds.filter((id) => !coverageIds.has(id));
  const extraInContext = [...coverageIds].filter((id) =>
    !populationSet.has(id)
  );

  // 3. Linked jobs (for GHL binding) and the chase log, batched.
  const linkedJobIds = [
    ...new Set(
      [...coverageById.values()].filter((r) =>
        populationSet.has(r.xero_invoice_id) && r.job_id
      )
        .map((r) => r.job_id as string),
    ),
  ];
  const jobs = new Map<string, any>();
  let jobsFault: string | null = null;
  try {
    for (const ids of chunk(linkedJobIds)) {
      const rows = await pageThrough(
        "jobs",
        () =>
          client.from("jobs").select(
            "id, job_number, ghl_contact_id, status, type",
          ).in("id", ids),
        warnings,
        "id",
      );
      for (const j of rows) jobs.set(j.id, j);
    }
  } catch (e) {
    jobsFault = errText(e);
    faults.push({ source: "jobs", detail: `jobs read failed: ${jobsFault}` });
  }

  const chaseByInvoice = new Map<string, any[]>();
  let chaseFault: string | null = null;
  try {
    for (const ids of chunk(populationIds)) {
      const rows = await pageThrough(
        "payment_chase_logs",
        () =>
          client.from("payment_chase_logs")
            .select(
              "id, xero_invoice_id, job_id, method, outcome, notes, follow_up_date, follow_up_resolved, chased_by, created_at",
            )
            .in("xero_invoice_id", ids),
        warnings,
        "id",
        true,
      );
      for (const r of rows) {
        const list = chaseByInvoice.get(r.xero_invoice_id) ?? [];
        list.push(r);
        chaseByInvoice.set(r.xero_invoice_id, list);
      }
    }
  } catch (e) {
    chaseFault = errText(e);
    faults.push({
      source: "notes",
      detail: `payment_chase_logs read failed: ${chaseFault}`,
    });
  }

  const invoiceEvents = new Map<string, any[]>();
  let invoiceEventsFault: string | null = null;
  {
    try {
      for (const ids of chunk(populationIds)) {
        const rows = await pageThrough(
          "business_events",
          () =>
            client.from("business_events")
              .select(
                "id, event_type, entity_type, entity_id, job_id, occurred_at, payload, metadata_operator:metadata->>operator, provider_message_id",
              )
              .in("entity_type", ["invoice", "xero_invoice"])
              .in("event_type", INVOICE_EVENT_TYPES)
              .in("entity_id", ids),
          warnings,
          "id",
          true,
        );
        for (const r of rows) {
          const list = invoiceEvents.get(r.entity_id) ?? [];
          list.push(r);
          invoiceEvents.set(r.entity_id, list);
        }
      }
    } catch (e) {
      invoiceEventsFault = errText(e);
      faults.push({
        source: "xero_events",
        detail: `invoice business_events read failed: ${invoiceEventsFault}`,
      });
    }
  }

  // 3b. GHL bindings a debtor has without a job: contact_matches rows whose
  //     Xero contact is a VERIFIED debtor contact. Never matched by name.
  const verifiedContactIds = [
    ...new Set(
      population.map((inv) => debtorIdentityFor(inv))
        .filter((id) => id.status === "verified")
        .map((id) => id.xero_contact_id as string),
    ),
  ];
  const contactMatchGhl = new Map<string, Set<string>>();
  const unverifiedContactMatches = new Map<string, any[]>();
  let contactMatchFault: string | null = null;
  try {
    for (const ids of chunk(verifiedContactIds)) {
      const rows = await pageThrough(
        "contact_matches",
        () =>
          client.from("contact_matches")
            .select(
              "id, xero_contact_id, ghl_contact_id, job_id, email, phone",
            )
            .eq("org_id", deps.orgId)
            .in("xero_contact_id", ids),
        warnings,
      );
      for (const r of rows) {
        if (!r.xero_contact_id || !r.ghl_contact_id) continue;
        if (!isContactMatchVerified(r)) {
          const evidence = xeroContact.byContact.get(r.xero_contact_id);
          const reason = !evidence ||
              (evidence.emails.size === 0 && evidence.phones.size === 0)
            ? "No Xero contact email or phone is available to verify this candidate"
            : !emailKey(str(r.email)) && !phoneKey(str(r.phone))
            ? "The candidate has no email or phone to verify against Xero"
            : "The candidate email and phone do not match the Xero contact";
          const candidates = unverifiedContactMatches.get(r.xero_contact_id) ??
            [];
          candidates.push({
            contact_match_id: str(r.id),
            ghl_contact_id: str(r.ghl_contact_id),
            job_id: str(r.job_id),
            status: "unverified",
            why: reason,
          });
          unverifiedContactMatches.set(r.xero_contact_id, candidates);
          continue;
        }
        const set = contactMatchGhl.get(r.xero_contact_id) ?? new Set();
        set.add(r.ghl_contact_id);
        contactMatchGhl.set(r.xero_contact_id, set);
      }
    }
  } catch (e) {
    contactMatchFault = errText(e);
    faults.push({
      source: "ghl",
      detail: `contact_matches read failed: ${contactMatchFault}`,
    });
  }

  // 3c. GHL cache freshness for every bound GHL contact (job or contact match).
  //     The cache's synced_at is the source's own freshness, not this read's.
  const allGhlIds = new Set<string>();
  for (const j of jobs.values()) {
    if (j.ghl_contact_id) allGhlIds.add(j.ghl_contact_id);
  }
  for (const set of contactMatchGhl.values()) {
    for (const id of set) allGhlIds.add(id);
  }
  const ghlCacheByContact = new Map<string, any>();
  let ghlCacheFault: string | null = null;
  try {
    for (const ids of chunk([...allGhlIds].sort())) {
      const rows = unwrap(
        await client.from("ghl_conversation_cache")
          .select("contact_id, job_id, message_count, synced_at")
          .in("contact_id", ids),
      ) || [];
      for (const r of rows) {
        const prev = ghlCacheByContact.get(r.contact_id);
        if (!prev || String(r.synced_at ?? "") > String(prev.synced_at ?? "")) {
          ghlCacheByContact.set(r.contact_id, r);
        }
      }
    }
  } catch (e) {
    ghlCacheFault = errText(e);
    faults.push({
      source: "ghl",
      detail: `ghl_conversation_cache read failed: ${ghlCacheFault}`,
    });
  }
  const ghlCacheByJob = new Map<string, any>();
  let ghlJobCacheFault: string | null = null;
  try {
    for (const ids of chunk([...linkedJobIds].sort())) {
      const rows = unwrap(
        await client.from("ghl_conversation_cache")
          .select("job_id, contact_id, message_count, synced_at")
          .in("job_id", ids),
      ) || [];
      for (const r of rows) {
        const prev = ghlCacheByJob.get(r.job_id);
        if (!prev || String(r.synced_at ?? "") > String(prev.synced_at ?? "")) {
          ghlCacheByJob.set(r.job_id, r);
        }
      }
    }
  } catch (e) {
    ghlJobCacheFault = errText(e);
    faults.push({
      source: "ghl",
      detail: `job-keyed GHL cache read failed: ${ghlJobCacheFault}`,
    });
  }

  // 4. Invoice rows.
  const staleMinutes = XERO_STALE_HOURS * 60;
  const invoiceRows = population.map((inv) => {
    const identity = debtorIdentityFor(inv);
    const cov = coverageById.get(inv.xero_invoice_id) ?? null;
    const rowFaults: Fault[] = [];
    if (coverageFault) {
      rowFaults.push({
        source: "context",
        detail: "the context read failed; link, facts and messages are unknown",
      });
    } else if (!cov) {
      rowFaults.push({
        source: "context",
        detail:
          "this invoice was not in the context read (it changed between reads); link, facts and messages are unknown",
      });
    }
    const syncedAt = str(inv.synced_at);
    const ageMinutes = syncedAt
      ? Math.max(0, Math.round((now.getTime() - Date.parse(syncedAt)) / 60_000))
      : null;
    const xeroFresh = ageMinutes !== null && ageMinutes <= staleMinutes;
    // invoice_context reports a failed link read as "none" on every row; here
    // it is "unknown", because nothing was read.
    const linkReadOk = facetOk("job_link");
    const linkStatus: string = cov && linkReadOk ? cov.link_status : "unknown";
    const jobId: string | null = linkReadOk ? cov?.job_id ?? null : null;
    const contextBlockers: string[] = !cov
      ? []
      : linkReadOk
      ? (cov.blockers ?? [])
      : [
        "job_link_unreadable",
        ...(cov.blockers ?? []).filter((b: string) =>
          b !== "no_job_linked" && b !== "job_link_ambiguous"
        ),
      ];
    const job = jobId ? jobs.get(jobId) ?? null : null;
    if (jobId && jobsFault) {
      rowFaults.push({
        source: "jobs",
        detail: "the job read failed; the GHL binding is unknown",
      });
    }
    if (!linkReadOk && cov) {
      rowFaults.push({
        source: "link",
        detail: "the job link read failed; the link is unknown",
      });
    }
    const known = Boolean(cov) && linkReadOk;
    const factsStatus = !known
      ? "unknown"
      : !jobId
      ? "no_job"
      : !facetOk("facts")
      ? "unreadable"
      : (cov.facts_count ?? 0) > 0
      ? "present"
      : "missing";
    if (factsStatus === "unreadable") {
      rowFaults.push({
        source: "facts",
        detail:
          "the facts read failed; whether Luna has extracted this job is unknown",
      });
    }
    const conversationStatus = !known
      ? "unknown"
      : !jobId
      ? "no_job"
      : !facetOk("conversation")
      ? "unreadable"
      : (cov.conversation_count ?? 0) > 0
      ? "present"
      : "missing";
    if (conversationStatus === "unreadable") {
      rowFaults.push({
        source: "conversation",
        detail:
          "the stored message counts could not be read; whether messages exist is unknown",
      });
    }
    const chase = chaseByInvoice.get(inv.xero_invoice_id) ?? [];
    if (chaseFault) {
      rowFaults.push({
        source: "notes",
        detail: "the debt notes read failed; notes are unknown",
      });
    }
    const followUp = chase.filter((c) =>
      c.follow_up_date && !c.follow_up_resolved
    )
      .map((c) => String(c.follow_up_date)).sort()[0] ?? null;
    const days = daysOverdue(str(inv.due_date), now);
    return {
      xero_invoice_id: inv.xero_invoice_id,
      invoice_number: inv.invoice_number ?? null,
      reference: inv.reference ?? null,
      status: inv.status ?? null,
      total: num(inv.total),
      amount_due: num(inv.amount_due),
      amount_paid: num(inv.amount_paid),
      invoice_date: inv.invoice_date ?? null,
      due_date: inv.due_date ?? null,
      days_overdue: days === null ? null : Math.max(0, days),
      overdue: days !== null && days > 0,
      sent_to_contact: typeof inv.sent_to_contact === "boolean"
        ? inv.sent_to_contact
        : null,
      contact: {
        xero_contact_id: inv.xero_contact_id ?? null,
        name: inv.contact_name ?? null,
        identity_status: identity.status,
      },
      link: {
        status: linkStatus,
        method: cov?.link_method ?? null,
        job_id: jobId,
        job_number: cov?.job_number ?? null,
        candidates: cov?.candidates ?? [],
      },
      ghl_contact_id: job?.ghl_contact_id ?? null,
      classification: {
        class: inv.debt_classification ?? null,
        type: inv.debt_type ?? debtTypeFromReference(inv.reference),
        blocker: inv.debt_blocker ?? null,
        reason: inv.debt_classification_reason ?? null,
        source: inv.debt_source ?? null,
        void_proposed: inv.debt_void_proposed ?? null,
        handoff_ref: inv.debt_handoff_ref ?? null,
        handoff_at: inv.debt_handoff_at ?? null,
        as_of: inv.debt_as_of ?? null,
      },
      next_step: {
        action: inv.debt_next_action ?? null,
        at: inv.debt_next_action_at ?? null,
        owner: inv.debt_owner ?? null,
        follow_up_date: followUp,
      },
      proposal: inv.debt_proposal_status
        ? {
          status: inv.debt_proposal_status,
          kind: inv.debt_proposal_kind ?? null,
          to: inv.debt_proposal_to ?? null,
          text: inv.debt_proposal_text ?? null,
          at: inv.debt_proposal_at ?? null,
        }
        : null,
      brief: debtorFilter ? (inv.debt_brief ?? null) : undefined,
      has_brief: Boolean(inv.debt_brief),
      context: cov
        ? {
          facts: factsStatus,
          facts_count: cov.facts_count,
          conversation: conversationStatus,
          conversation_count: cov.conversation_count,
          last_client_message_at: cov.last_client_message_at ?? null,
          extraction_queue: cov.extraction_queue ?? null,
          blockers: contextBlockers,
          complete: linkReadOk && (cov.complete ?? false),
        }
        : {
          facts: factsStatus,
          conversation: conversationStatus,
          blockers: [],
          complete: false,
        },
      chase: {
        count: chaseFault ? null : chase.length,
        last_at: chase.map((c) => String(c.created_at ?? "")).sort().pop() ||
          null,
      },
      xero: {
        synced_at: syncedAt,
        age_minutes: ageMinutes,
        fresh: xeroFresh,
      },
      as_of: asOf,
      source_status: "from_debtor",
      faults: rowFaults,
      _identity: identity,
      _raw: inv,
    };
  });

  // 5. Group into debtors.
  const groups = new Map<string, any[]>();
  for (const row of invoiceRows) {
    const list = groups.get(row._identity.key) ?? [];
    list.push(row);
    groups.set(row._identity.key, list);
  }
  let debtorKeys = [...groups.keys()];
  if (debtorFilter) {
    if (!groups.has(debtorFilter)) {
      throw new DebtWorklistError(
        `no open debtor ${debtorFilter}`,
        404,
        "debtor_not_found",
      );
    }
    debtorKeys = [debtorFilter];
  }

  // 6. Timelines, one merge call per job, bounded fan-out.
  const conversations = new Map<
    string,
    { messages: any[]; faults: string[] }
  >();
  {
    const bounds = TIMELINE_BOUNDS[timelineMode];
    const wanted = [
      ...new Set(
        debtorKeys.flatMap((k) =>
          groups.get(k)!.filter((r) =>
            r.link.status === "linked" && r.link.job_id
          ).map((r) => r.link.job_id as string)
        ),
      ),
    ].sort();
    const results = await mapBounded(
      wanted,
      CONVERSATION_CONCURRENCY,
      async (jobId) => {
        try {
          const res = await deps.getJobConversation(client, {
            job_id: jobId,
            limit: bounds.per_job,
            report_faults: true,
          });
          return {
            jobId,
            messages: res?.messages ?? [],
            faults: res?.read_faults ?? [],
          };
        } catch (e) {
          return {
            jobId,
            messages: [],
            faults: [`conversation: ${errText(e)}`],
          };
        }
      },
    );
    for (const r of results) {
      conversations.set(r.jobId, { messages: r.messages, faults: r.faults });
    }
  }

  // GHL contacts a verified debtor holds through contact_matches but not
  // through any of its linked jobs: their cached messages are read by contact.
  const jobGhlFor = (rows: any[]) =>
    new Set(
      rows.filter((r) => r.ghl_contact_id && r.link.job_id).map((r) =>
        r.ghl_contact_id as string
      ),
    );
  const contactOnlyGhlFor = (key: string): string[] => {
    const rows = groups.get(key)!;
    const identity: DebtorIdentity = rows[0]._identity;
    if (identity.status !== "verified" || !identity.xero_contact_id) return [];
    const viaJobs = jobGhlFor(rows);
    return [...(contactMatchGhl.get(identity.xero_contact_id) ?? [])]
      .filter((id) => !viaJobs.has(id)).sort();
  };
  const ghlContactIdsFor = (key: string): string[] => {
    const rows = groups.get(key)!;
    const identity: DebtorIdentity = rows[0]._identity;
    if (identity.status !== "verified" || !identity.xero_contact_id) return [];
    return [...new Set([
      ...(contactMatchGhl.get(identity.xero_contact_id) ?? []),
      ...rows.map((r) => r.ghl_contact_id).filter(Boolean),
    ])].sort();
  };
  const debtorGhlContactIds = new Map(
    debtorKeys.map((key) => [key, ghlContactIdsFor(key)]),
  );
  const contactNotesByGhl = new Map<string, any[]>();
  let contactNotesFault: string | null = null;
  try {
    const contactIds = [
      ...new Set([...debtorGhlContactIds.values()].flat()),
    ].sort();
    for (const ids of chunk(contactIds)) {
      const rows = await pageThrough(
        "business_events",
        () =>
          client.from("business_events")
            .select(
              "id, contact_id, job_id, event_type, occurred_at, direction, payload, body_preview, provider_message_id",
            )
            .in("event_type", ["ghl.note_added", "ghl.internal_comment"])
            .in("contact_id", ids),
        warnings,
        "id",
        true,
      );
      for (const row of rows) {
        const notes = contactNotesByGhl.get(row.contact_id) ?? [];
        notes.push(row);
        contactNotesByGhl.set(row.contact_id, notes);
      }
    }
  } catch (e) {
    contactNotesFault = errText(e);
    faults.push({
      source: "ghl",
      detail: `contact-level GHL note read failed: ${contactNotesFault}`,
    });
  }
  const contactMessages = new Map<string, any[]>();
  let contactMessagesFault: string | null = null;
  const factsByJob = new Map<string, any[]>();
  const factsCapJobs = new Set<string>();
  let factsReadFault: string | null = null;
  {
    const bounds = TIMELINE_BOUNDS[timelineMode];
    const contactOnly = [
      ...new Set(debtorKeys.flatMap((k) => contactOnlyGhlFor(k))),
    ].sort();
    try {
      for (const ids of chunk(contactOnly)) {
        const rows = unwrap(
          await client.from("ghl_conversation_cache")
            .select("contact_id, messages, synced_at")
            .in("contact_id", ids),
        ) || [];
        for (const r of rows) {
          const list = contactMessages.get(r.contact_id) ?? [];
          if (Array.isArray(r.messages)) list.push(...r.messages);
          contactMessages.set(r.contact_id, list);
        }
      }
    } catch (e) {
      contactMessagesFault = errText(e);
      faults.push({
        source: "ghl",
        detail: `contact-keyed GHL cache read failed: ${contactMessagesFault}`,
      });
    }
    const factJobs = [
      ...new Set(
        debtorKeys.flatMap((k) =>
          groups.get(k)!.filter((r) =>
            r.link.status === "linked" && r.link.job_id
          ).map((r) => r.link.job_id as string)
        ),
      ),
    ].sort();
    try {
      for (const ids of chunk(factJobs)) {
        const rows = await pageThrough(
          "current_job_context_facts",
          () =>
            client.from("current_job_context_facts")
              .select(
                "id, job_id, kind, value, provenance, expires_at, _context_store, extractor_version, trust, created_at, updated_at",
              )
              .in("job_id", ids),
          warnings,
          "id",
          true,
        );
        for (const r of rows) {
          if (!isLunaSubscriptionFact(r)) continue;
          const list = factsByJob.get(r.job_id) ?? [];
          list.push(r);
          factsByJob.set(r.job_id, list);
        }
      }
      for (const [jobId, list] of factsByJob) {
        list.sort((a, b) =>
          String(b.updated_at ?? b.created_at ?? "").localeCompare(
            String(a.updated_at ?? a.created_at ?? ""),
          )
        );
        if (list.length > bounds.facts_per_job) factsCapJobs.add(jobId);
        factsByJob.set(jobId, list.slice(0, bounds.facts_per_job));
      }
    } catch (e) {
      factsReadFault = errText(e);
      faults.push({
        source: "facts",
        detail: `fact timeline read failed: ${factsReadFault}`,
      });
    }
  }

  const debtors = debtorKeys.map((key) => {
    const rows = [...groups.get(key)!].sort((a, b) => {
      const ad = a.due_date ?? "9999";
      const bd = b.due_date ?? "9999";
      if (ad !== bd) return ad < bd ? -1 : 1;
      return String(a.invoice_number ?? "").localeCompare(
        String(b.invoice_number ?? ""),
      );
    });
    const identity: DebtorIdentity = rows[0]._identity;
    const names = [...new Set(rows.map((r) => r.contact.name).filter(Boolean))]
      .sort();
    const unverifiedCandidates = identity.xero_contact_id
      ? unverifiedContactMatches.get(identity.xero_contact_id) ?? []
      : [];
    const debtorFaults: Fault[] = [];
    for (const r of rows) {
      for (const f of r.faults) {
        if (
          !debtorFaults.some((d) =>
            d.source === f.source && d.detail === f.detail
          )
        ) debtorFaults.push(f);
      }
    }

    // GHL bindings through the linked jobs, plus any verified Xero/GHL
    // contact_matches pair with no job. Several are listed, never merged.
    const ghl = new Map<string, Set<string>>();
    for (const r of rows) {
      if (r.ghl_contact_id && r.link.job_id) {
        (ghl.get(r.ghl_contact_id) ??
          ghl.set(r.ghl_contact_id, new Set()).get(r.ghl_contact_id)!).add(
            r.link.job_id,
          );
      }
    }
    const contactOnlyGhl = contactOnlyGhlFor(key);
    const linkUnknown = rows.some((r) => r.link.status === "unknown");
    if (linkUnknown) {
      debtorFaults.push({
        source: "link",
        detail:
          "the job link could not be read, so this debtor's jobs, GHL and email history are unknown",
      });
    }
    const linkedJobs = [
      ...new Set(
        rows.filter((r) => r.link.status === "linked" && r.link.job_id).map((
          r,
        ) => r.link.job_id as string),
      ),
    ];
    const invoicesByLinkedJob = new Map(
      linkedJobs.map((jobId) => [
        jobId,
        rows.filter((r) => r.link.job_id === jobId).map((r) =>
          r.xero_invoice_id
        ),
      ]),
    );
    const staleCutoff = now.getTime() - GHL_CACHE_STALE_HOURS * 3_600_000;
    const ghlJobCaches = linkedJobs.map((jobId) => {
      const job = jobs.get(jobId);
      const contactCacheAvailable = Boolean(
        job?.ghl_contact_id && ghlCacheByContact.has(job.ghl_contact_id),
      );
      const cache = ghlCacheByJob.get(jobId);
      const syncedAt = ghlJobCacheFault ? null : str(cache?.synced_at);
      const syncedMs = syncedAt ? Date.parse(syncedAt) : NaN;
      return {
        job_id: jobId,
        ghl_contact_id: str(job?.ghl_contact_id),
        cache_synced_at: syncedAt,
        cache_message_count: ghlJobCacheFault
          ? null
          : num(cache?.message_count),
        stale: ghlJobCacheFault
          ? null
          : cache
          ? !Number.isFinite(syncedMs) || syncedMs < staleCutoff
          : null,
        used_by_conversation_read: !contactCacheAvailable,
      };
    });

    // Timeline.
    let timeline: any;
    let mergedTimelineEntries: TimelineEntry[] = [];
    let timelineSourcesComplete = false;
    const conversationFaults: string[] = [];
    {
      const bounds = TIMELINE_BOUNDS[timelineMode];
      const raw: TimelineEntry[] = [];
      for (const jobId of linkedJobs) {
        const conv = conversations.get(jobId);
        const jobInvoiceIds = invoicesByLinkedJob.get(jobId) ?? [];
        if (!conv) continue;
        for (const f of conv.faults) {
          conversationFaults.push(
            `${jobs.get(jobId)?.job_number ?? jobId}: ${f}`,
          );
        }
        for (const m of conv.messages) {
          raw.push(entryFromConversation(m, jobId, jobInvoiceIds));
        }
      }
      for (const r of rows) {
        for (const c of chaseByInvoice.get(r.xero_invoice_id) ?? []) {
          raw.push(entryFromChaseLog(c));
        }
        for (const ev of invoiceEvents.get(r.xero_invoice_id) ?? []) {
          raw.push(entryFromInvoiceEvent(ev));
        }
        raw.push(...xeroEntriesFor(r._raw));
      }
      const debtorInvoiceIds = rows.map((r) => r.xero_invoice_id);
      for (const g of contactOnlyGhl) {
        for (const m of contactMessages.get(g) ?? []) {
          raw.push(entryFromGhlCacheMessage(m, g, debtorInvoiceIds));
        }
      }
      const contactIds = debtorGhlContactIds.get(key) ?? [];
      for (const contactId of contactIds) {
        for (const note of contactNotesByGhl.get(contactId) ?? []) {
          const noteJobId = str(note.job_id);
          if (noteJobId) {
            const jobInvoiceIds = invoicesByLinkedJob.get(noteJobId);
            if (!jobInvoiceIds) continue;
            raw.push(
              entryFromGhlContactNote(note, debtorInvoiceIds, jobInvoiceIds),
            );
          } else {
            raw.push(entryFromGhlContactNote(note, debtorInvoiceIds));
          }
        }
      }
      for (const jobId of linkedJobs) {
        const jobInvoiceIds = invoicesByLinkedJob.get(jobId) ?? [];
        for (const f of factsByJob.get(jobId) ?? []) {
          raw.push(
            entryFromFact(
              f,
              jobId,
              jobInvoiceIds,
              deps.isCurrentContextFact(f, now.getTime()) ? "current" : "stale",
            ),
          );
        }
      }
      const factsCapHit = linkedJobs.filter((j) => factsCapJobs.has(j)).map((
        j,
      ) => jobs.get(j)?.job_number ?? j);
      const merged = mergeTimeline(raw);
      mergedTimelineEntries = merged.entries;
      const perJobCapHit = linkedJobs.filter((j) =>
        (conversations.get(j)?.messages.length ?? 0) >= bounds.per_job
      )
        .map((j) => jobs.get(j)?.job_number ?? j);
      const total = merged.entries.length;
      const entries = bounds.per_debtor === null
        ? merged.entries
        : merged.entries.slice(0, bounds.per_debtor);
      for (const f of conversationFaults) {
        debtorFaults.push({ source: "timeline", detail: f });
      }
      if (invoiceEventsFault) {
        debtorFaults.push({
          source: "xero_events",
          detail: "invoice events could not be read",
        });
      }
      if (factsReadFault && linkedJobs.length) {
        debtorFaults.push({
          source: "facts",
          detail: "captured facts could not be read for the timeline",
        });
      }
      if (
        (contactMatchFault && identity.status === "verified") ||
        (contactMessagesFault && contactOnlyGhl.length) ||
        (contactNotesFault && contactIds.length) ||
        (ghlCacheFault && contactIds.length) ||
        (ghlJobCacheFault && ghlJobCaches.some((c) => c.used_by_conversation_read))
      ) {
        debtorFaults.push({
          source: "ghl",
          detail:
            "GHL contact messages or notes could not be read for this debtor",
        });
      }
      timelineSourcesComplete = conversationFaults.length === 0 && !chaseFault &&
        !invoiceEventsFault && !coverageFault && !linkUnknown &&
        !jobsFault && !(factsReadFault && linkedJobs.length) &&
        !(contactMatchFault && identity.status === "verified") &&
        !(contactMessagesFault && contactOnlyGhl.length) &&
        !(contactNotesFault && contactIds.length) &&
        !(ghlCacheFault && contactIds.length) &&
        !(ghlJobCacheFault && ghlJobCaches.some((c) => c.used_by_conversation_read)) &&
        perJobCapHit.length === 0 && factsCapHit.length === 0 &&
        unverifiedCandidates.length === 0;
      timeline = {
        scope: "open_invoices",
        scope_note:
          "Completeness applies only to open-invoice sources; closed-invoice events and payments are not read.",
        mode: timelineMode,
        order: "newest_first",
        entries,
        entries_read: total,
        truncated: entries.length < total,
        duplicates_merged: merged.duplicates_merged,
        per_job_cap: bounds.per_job,
        per_job_cap_reached: perJobCapHit,
        facts_per_job_cap: bounds.facts_per_job,
        facts_cap_reached: factsCapHit,
        complete: timelineSourcesComplete && entries.length === total,
        sources_complete: timelineSourcesComplete,
        note: STORED_COPIES_NOTE,
      };
    }

    // Last contact: newest provider message in either direction.
    // A logged call counts whichever way it went; a message needs a direction.
    const contactEntries = mergedTimelineEntries.filter((
      e: TimelineEntry,
    ) =>
      e.kind === "call" ||
      ((e.direction === "inbound" || e.direction === "outbound") &&
        ["sms", "email"].includes(String(e.channel)) &&
        e.kind !== "invoice_event")
    );
    const brief = (e: TimelineEntry | undefined) =>
      e
        ? {
          at: e.at,
          channel: e.channel,
          direction: e.direction,
          provider: e.provider,
          source: e.source,
        }
        : null;
    const lastContact = {
      last: brief(contactEntries[0]),
      last_inbound: brief(
        contactEntries.find((e: TimelineEntry) => e.direction === "inbound"),
      ),
      last_outbound: brief(
        contactEntries.find((e: TimelineEntry) => e.direction === "outbound"),
      ),
      complete: timelineSourcesComplete,
      status: timelineSourcesComplete ? "complete" : "incomplete",
      basis: "merged stored timeline copies before the debtor trim",
    };

    // Per-source status.
    const staleIds = rows.filter((r) => !r.xero.fresh).map((r) =>
      r.xero_invoice_id
    );
    const syncStamps = rows.map((r) => r.xero.synced_at).filter(Boolean).sort();
    const linkedRows = rows.filter((r) => r.link.status === "linked");
    const convFaultBy = (src: string) =>
      conversationFaults.some((f) => f.includes(`${src}:`));
    const factRows = rows.filter((r) =>
      r.context.facts !== "no_job" && r.context.facts !== "unknown"
    );
    const factsStatus = rows.some((r) => r.context.facts === "unreadable")
      ? "unreadable"
      : rows.some((r) => r.context.facts === "unknown")
      ? "unknown"
      : !factRows.length
      ? "no_job"
      : factRows.every((r) => r.context.facts === "present")
      ? "present"
      : factRows.some((r) => r.context.facts === "present")
      ? "partial"
      : "missing";
    const countIn = (pred: (e: TimelineEntry) => boolean) =>
      (timeline.entries as TimelineEntry[]).filter(pred).length;

    // GHL: every bound contact with its own cache sync time and stale flag.
    const ghlContacts = [
      ...[...ghl.entries()].map(([id, jobIds]) => ({
        id,
        via: "job" as const,
        jobIds: [...jobIds].sort(),
      })),
      ...contactOnlyGhl.map((id) => ({
        id,
        via: "contact_match" as const,
        jobIds: [] as string[],
      })),
    ].map(({ id, via, jobIds }) => {
      const cache = ghlCacheByContact.get(id);
      const fallbackCaches = !cache
        ? jobIds.map((jobId) => ghlCacheByJob.get(jobId)).filter(Boolean)
        : [];
      const fallbackSyncs = fallbackCaches.map((row) => str(row.synced_at))
        .filter((at): at is string => Boolean(at)).sort();
      const syncedAt = ghlCacheFault
        ? null
        : str(cache?.synced_at) ?? fallbackSyncs[0] ?? null;
      const syncedMs = syncedAt ? Date.parse(syncedAt) : NaN;
      const missingFallback = !cache &&
        (jobIds.length === 0 || fallbackCaches.length !== jobIds.length);
      return {
        ghl_contact_id: id,
        via,
        via_job_ids: jobIds,
        cache_synced_at: syncedAt,
        cache_message_count: ghlCacheFault
          ? null
          : cache
          ? num(cache.message_count)
          : fallbackCaches.reduce(
            (total, row) => total + (num(row.message_count) ?? 0),
            0,
          ),
        stale: ghlCacheFault
          ? null
          : missingFallback || !Number.isFinite(syncedMs) ||
            syncedMs < staleCutoff,
        used_job_cache_fallback: !cache && jobIds.length > 0,
      };
    });
    const ghlUnreadable = linkUnknown || Boolean(jobsFault) ||
      Boolean(ghlCacheFault) ||
      Boolean(ghlJobCacheFault && ghlJobCaches.some((c) => c.used_by_conversation_read)) ||
      Boolean(contactMatchFault && identity.status === "verified") ||
      Boolean(contactMessagesFault && contactOnlyGhl.length) ||
      Boolean(contactNotesFault && (debtorGhlContactIds.get(key)?.length ?? 0)) ||
      Boolean(convFaultBy("ghl_cache"));
    const ghlStale = !ghlUnreadable && (
      ghlContacts.some((c) => c.stale) ||
      ghlJobCaches.some((c) => c.used_by_conversation_read && c.stale === true)
    );
    const ghlStatus = ghlUnreadable
      ? "unreadable"
      : !ghlContacts.length && unverifiedCandidates.length
      ? "unverified_candidate"
      : ghlStale
      ? "stale"
      : !linkedRows.length && !ghlContacts.length
      ? "no_job"
      : ghlContacts.length === 0
      ? "no_contact"
      : ghlContacts.length === 1
      ? "bound"
      : "several";
    const ghlSyncs = [
      ...ghlContacts.filter((c) => !c.used_job_cache_fallback).map((c) =>
        c.cache_synced_at
      ),
      ...ghlJobCaches.filter((c) => c.used_by_conversation_read).map((c) =>
        c.cache_synced_at
      ),
    ];
    const emailUnreadable = linkUnknown ||
      Boolean(
        convFaultBy("inbox") || convFaultBy("inbox_event_copies") ||
          convFaultBy("business_events")
      );
    const notesUnreadable = Boolean(chaseFault) ||
      Boolean(convFaultBy("job_events"));
    const sources = {
      xero: {
        status: staleIds.length ? "stale" : "current",
        oldest_synced_at: syncStamps[0] ?? null,
        stale_invoice_ids: staleIds,
        stale_after_hours: XERO_STALE_HOURS,
      },
      ghl: {
        status: ghlStatus,
        // The weakest bound contact: null when any has no cache row.
        last_success_at: ghlUnreadable || !ghlSyncs.length ||
            ghlSyncs.some((t) => !t)
          ? null
          : [...ghlSyncs].sort()[0],
        stale_after: `${GHL_CACHE_STALE_HOURS}h`,
        stale: ghlUnreadable || unverifiedCandidates.length ? null : ghlStale,
        owner: "CIO",
        recovery_action: ghlUnreadable
          ? "Retry the read; if it keeps failing, CIO checks the job link, contact_matches and GHL cache reads"
          : ghlStatus === "stale"
          ? "CIO: run the GHL message reconcile for the stale contact(s)"
          : ghlStatus === "no_contact"
          ? "CIO: bind the job's GHL contact"
          : ghlStatus === "unverified_candidate"
          ? "CIO: verify the candidate GHL contact using a matching Xero email or phone"
          : null,
        contact_ids: ghlContacts,
        job_caches: ghlJobCaches,
        unverified_candidates: unverifiedCandidates,
        messages_shown: countIn((e) => e.provider === "ghl"),
        read: "stored GHL cache and captured business events",
      },
      email: {
        // Never complete: Outlook Sent Items are not captured anywhere yet.
        status: emailUnreadable
          ? "unreadable"
          : !linkedRows.length
          ? "no_job"
          : "partial",
        last_success_at: null,
        stale_after: null,
        owner: "CIO",
        recovery_action: emailUnreadable
          ? "Retry the read; if it keeps failing, CIO checks the job link, inbox and business event reads"
          : "CIO email capture (EM1): capture Outlook Sent Items and inbound mail as stored events",
        messages_shown: countIn((e) =>
          e.channel === "email" && e.kind !== "invoice_event"
        ),
        note:
          `${STORED_COPIES_NOTE}; no email capture health is published, so there is no last success time`,
      },
      notes: {
        status: notesUnreadable ? "unreadable" : "read",
        // Notes are read live from our own tables at as_of.
        last_success_at: notesUnreadable ? null : asOf,
        stale_after: null,
        owner: "DEBT",
        recovery_action: notesUnreadable
          ? "Retry the read; if it keeps failing, CIO checks the payment_chase_logs and job_events reads"
          : null,
        debt_notes: chaseFault
          ? null
          : rows.reduce((n, r) =>
            n + (chaseByInvoice.get(r.xero_invoice_id) ?? []).filter((c) =>
              c.method === "note"
            ).length, 0),
        chase_log_rows: chaseFault ? null : rows.reduce(
          (n, r) => n + (chaseByInvoice.get(r.xero_invoice_id) ?? []).length,
          0,
        ),
        job_notes_shown: countIn((e) => e.kind === "job_note"),
      },
      facts: {
        status: factsStatus,
        invoices_with_facts: rows.filter((r) =>
          r.context.facts === "present"
        ).length,
        of_invoices: rows.length,
        timeline_read: factsReadFault && linkedJobs.length
          ? "unreadable"
          : "read",
        facts_shown: countIn((e) => e.kind === "fact"),
      },
    };

    const totalDue = money(rows.reduce((n, r) => n + (r.amount_due ?? 0), 0));
    const overdueRows = rows.filter((r) => r.overdue);
    const dueDates = rows.map((r) => r.due_date).filter(Boolean).sort();
    const owners = new Map<string, number>();
    for (const r of rows) {
      if (r.next_step.owner) {
        owners.set(
          r.next_step.owner,
          (owners.get(r.next_step.owner) ?? 0) + 1,
        );
      }
    }

    return {
      key,
      identity: {
        status: identity.status,
        xero_contact_id: identity.xero_contact_id,
        name: names[0] ?? null,
        names,
        name_variants: names.length > 1,
        detail: identity.detail,
      },
      invoice_count: rows.length,
      total_due: totalDue,
      overdue_count: overdueRows.length,
      overdue_amount: money(
        overdueRows.reduce((n, r) => n + (r.amount_due ?? 0), 0),
      ),
      oldest_due_date: dueDates[0] ?? null,
      max_days_overdue: rows.reduce(
        (m, r) => Math.max(m, r.days_overdue ?? 0),
        0,
      ),
      no_due_date: rows.filter((r) => !r.due_date).length,
      last_contact: lastContact,
      next_step: debtorNextStep(rows),
      owners: [...owners.entries()].map(([owner, invoices]) => ({
        owner,
        invoices,
      })).sort((a, b) =>
        b.invoices - a.invoices || a.owner.localeCompare(b.owner)
      ),
      link_state: {
        linked: rows.filter((r) => r.link.status === "linked").length,
        ambiguous: rows.filter((r) => r.link.status === "ambiguous").length,
        none: rows.filter((r) => r.link.status === "none").length,
        unknown: rows.filter((r) => r.link.status === "unknown").length,
        job_ids: linkedJobs.sort(),
      },
      freshness: {
        as_of: asOf,
        xero_oldest_synced_at: syncStamps[0] ?? null,
        xero_fresh: staleIds.length === 0,
        picture_as_of:
          rows.map((r) => r.classification.as_of).filter(Boolean).sort()[0] ??
            null,
      },
      sources,
      faults: debtorFaults,
      invoices: rows.map(({ _identity, _raw, ...rest }) => rest),
      timeline,
    };
  });

  debtors.sort((a, b) =>
    b.max_days_overdue - a.max_days_overdue || b.total_due - a.total_due ||
    a.key.localeCompare(b.key)
  );

  const bookSeen = new Map<string, number>();
  for (const rows of groups.values()) {
    for (const row of rows) {
      const id = row.xero_invoice_id;
      bookSeen.set(id, (bookSeen.get(id) ?? 0) + 1);
    }
  }
  const bookNotShown = populationIds.filter((id) => !bookSeen.has(id));
  const bookShownTwice = [...bookSeen.entries()]
    .filter(([, n]) => n > 1)
    .map(([id]) => id);
  const returnedSeen = new Map<string, number>();
  for (const d of debtors) {
    for (const i of d.invoices) {
      returnedSeen.set(
        i.xero_invoice_id,
        (returnedSeen.get(i.xero_invoice_id) ?? 0) + 1,
      );
    }
  }
  const returnedExpectedIds = debtorFilter
    ? groups.get(debtorFilter)!.map((r) => r.xero_invoice_id)
    : populationIds;
  const returnedNotShown = returnedExpectedIds.filter((id) =>
    !returnedSeen.has(id)
  );
  const returnedShownTwice = [...returnedSeen.entries()]
    .filter(([, n]) => n > 1)
    .map(([id]) => id);
  if (
    bookNotShown.length || bookShownTwice.length || returnedNotShown.length ||
    returnedShownTwice.length
  ) {
    faults.push({
      source: "worklist",
      detail:
        `invoice representation broken: book ${bookNotShown.length} not shown and ${bookShownTwice.length} duplicated; returned ${returnedNotShown.length} not shown and ${returnedShownTwice.length} duplicated`,
    });
  }
  if (extraInContext.length) {
    warnings.push(
      `context: ${extraInContext.length} invoice(s) were open in the context read but not in the book read (they changed between reads); the book read wins`,
    );
  }

  // 8. Summary over the whole book (not the filtered debtor).
  const all = invoiceRows;
  const countOf = (n: number, of: number, denominator: string) => ({
    n,
    of,
    denominator,
  });
  const invN = all.length;
  const overdueAll = all.filter((r) => r.overdue);
  const allDebtorKeys = [...groups.keys()];
  const summary = {
    invoices: {
      denominator: POPULATION_DENOMINATOR,
      count: invN,
      amount_due: money(all.reduce((n, r) => n + (r.amount_due ?? 0), 0)),
      overdue: {
        ...countOf(overdueAll.length, invN, "open_invoices"),
        amount_due: money(
          overdueAll.reduce((n, r) => n + (r.amount_due ?? 0), 0),
        ),
      },
      no_due_date: countOf(
        all.filter((r) => !r.due_date).length,
        invN,
        "open_invoices",
      ),
      link: {
        linked: countOf(
          all.filter((r) => r.link.status === "linked").length,
          invN,
          "open_invoices",
        ),
        ambiguous: countOf(
          all.filter((r) => r.link.status === "ambiguous").length,
          invN,
          "open_invoices",
        ),
        none: countOf(
          all.filter((r) => r.link.status === "none").length,
          invN,
          "open_invoices",
        ),
        unknown: countOf(
          all.filter((r) => r.link.status === "unknown").length,
          invN,
          "open_invoices",
        ),
      },
      facts: {
        present: countOf(
          all.filter((r) => r.context.facts === "present").length,
          invN,
          "open_invoices",
        ),
        missing: countOf(
          all.filter((r) => r.context.facts === "missing").length,
          invN,
          "open_invoices",
        ),
        no_job: countOf(
          all.filter((r) => r.context.facts === "no_job").length,
          invN,
          "open_invoices",
        ),
        unknown: countOf(
          all.filter((r) =>
            r.context.facts === "unreadable" || r.context.facts === "unknown"
          ).length,
          invN,
          "open_invoices",
        ),
      },
      xero_stale: countOf(
        all.filter((r) => !r.xero.fresh).length,
        invN,
        "open_invoices",
      ),
      with_faults: countOf(
        all.filter((r) => r.faults.length > 0).length,
        invN,
        "open_invoices",
      ),
    },
    debtors: {
      denominator: DEBTOR_DENOMINATOR,
      count: allDebtorKeys.length,
      verified: countOf(
        allDebtorKeys.filter((k) => k.startsWith("xero:")).length,
        allDebtorKeys.length,
        "debtors",
      ),
      standing_alone: countOf(
        allDebtorKeys.filter((k) => k.startsWith("invoice:")).length,
        allDebtorKeys.length,
        "debtors",
      ),
      shown: {
        n: debtors.length,
        of: debtorFilter ? allDebtorKeys.length : debtors.length,
        denominator: debtorFilter
          ? "all_debtors_in_book"
          : "debtors_in_returned_set",
        returned_set: debtors.length,
        total_book: allDebtorKeys.length,
      },
    },
  };

  return {
    version: DEBT_WORKLIST_VERSION,
    reads: {
      debt_picture: DEBT_PICTURE_VERSION,
      invoice_context: INVOICE_CONTEXT_VERSION,
    },
    as_of: asOf,
    filter: { debtor: debtorFilter, timeline: timelineMode },
    summary,
    reconciliation: {
      scope: "whole_book",
      book_invoice_ids: populationIds.length,
      book_represented_invoice_ids: bookSeen.size,
      shown_invoice_ids: returnedSeen.size,
      exactly_once: bookNotShown.length === 0 && bookShownTwice.length === 0,
      not_shown: bookNotShown,
      shown_more_than_once: bookShownTwice,
      returned_debtor_keys: debtors.map((d) => d.key),
      returned_invoice_ids: [...returnedSeen.keys()],
      returned_exactly_once: returnedNotShown.length === 0 &&
        returnedShownTwice.length === 0,
      returned_not_shown: returnedNotShown,
      returned_shown_more_than_once: returnedShownTwice,
      missing_from_context: missingFromContext,
      extra_in_context: extraInContext,
    },
    sources: {
      invoices: { ok: true, count: populationIds.length },
      context: coverageFault
        ? { ok: false, error: coverageFault }
        : { ok: true, facets: coverageSources },
      jobs: jobsFault
        ? { ok: false, error: jobsFault }
        : { ok: true, count: jobs.size },
      notes: chaseFault ? { ok: false, error: chaseFault } : { ok: true },
      xero_events: invoiceEventsFault
        ? { ok: false, error: invoiceEventsFault }
        : { ok: true },
    },
    debtors,
    faults,
    warnings,
  };
}
