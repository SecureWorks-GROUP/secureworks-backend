// deno-lint-ignore-file no-explicit-any
// Dispatch v2, Tweak 2 piece 1 (Shaun, 5 Nov 2026): an order Shaun sent from
// Outlook becomes a Dispatch order by itself. Contract:
// docs/dispatch-v2-board-contract.md, section 3f.1.
//
// Shaun often orders straight from Outlook (admin@secureworkswa.com.au) with
// the same words Dispatch would use: subject "Material Order Ref SWF-261586",
// "Hi Team, could we please order the following for delivery:", the Date,
// Address and Contact lines, then "Materials Needed:" and numbered lines. The
// supplier's reply matched the job by its number, but with no Dispatch order
// to tie it to nothing moved on the board.
//
// Now, when the reply scan matches a supplier reply by the job number only and
// the job has no Dispatch order for that supplier, this file:
//   1. finds our sent email in the capture (business_events, folder 'sent',
//      mailbox admin@): subject "Material Order Ref <job number>", addressed
//      to that supplier's approved order address (or its domain), sent before
//      the reply. The one in the reply's own conversation wins, else the
//      newest.
//   2. reads it: delivery or pickup (and the pickup branch), the Date and
//      Address lines, and the numbered lines under "Materials Needed".
//   3. records it as a SENT order (origin 'outlook') with its real sent time
//      and Outlook ids, making the supplier box first if the job has none,
//      through one database function (dispatch_v2_record_outlook_order).
// The scan then ties the reply to that order, so the normal steps follow: the
// box moves by the payment rules, a date in the reply becomes a suggestion
// for Shaun's Accept, and Tweak 1 runs once the order is confirmed.
//
// What it never does: send anything, add material lines to the job's list,
// start the fencing fill from the scope, change an order that is already
// there, write the suppliers table, or move a job's stage or status. When the
// sent email cannot be found or read, it does nothing and the reply stays as
// it is (matched to the job only).
//
// The rules (pure, tested) come first, then the database reads and the one
// write behind OutlookOrderStore, then the step the scan calls.

import {
  type ApprovedSupplierSender,
  dayLabel,
  domainOf,
  emailAddressOf,
  type JobHint,
  normaliseJobNumber,
  perthDay,
  SHARED_MAIL_DOMAINS,
  type V2Order,
} from "./dispatch_v2_replies_rules.ts";
import {
  DISPATCH_V2_FROM_MAILBOX,
  DISPATCH_V2_STANDING_LINES,
  type DispatchV2Fulfilment,
  dispatchV2FulfilmentOf,
  dispatchV2TeamCc,
} from "./dispatch_v2_emails.ts";
import { dispatchOrderBranchOf } from "./dispatch_v2_order_confirmed.ts";
import { emailProviderKey } from "../_shared/evidence/outlook_mail.ts";

// ── Shapes ────────────────────────────────────────────────────────────────

/** One email we sent, as the capture reader saved it (business_events,
 * source outlook-mail-capture, direction outbound, folder 'sent'). */
export type OutlookSentEmail = {
  business_event_id: string;
  provider_message_id: string | null;
  internet_message_id: string | null;
  conversation_id: string | null;
  sent_at: string | null;
  mailbox: string | null;
  from_email: string | null;
  sent_by_email: string | null;
  folder_kind: string | null;
  to: string[];
  cc: string[];
  subject: string;
  // The body with the reader's "Subject: ..." first line removed.
  body: string;
  body_truncated: boolean;
};

/** One order line read from "Materials Needed". The line ids are null: an
 * Outlook order was never built from the job's list. */
export type OutlookOrderLine = {
  line_id: null;
  updated_at: null;
  text: string;
  standing: boolean;
};

export type ParsedOutlookOrder = {
  fulfilment: DispatchV2Fulfilment;
  pickup_branch: string | null;
  // The Date line as written ("12 November 2026", "ASAP"), or null.
  date_text: string | null;
  date_mode: "asap" | "date";
  // The day the Date line names (YYYY-MM-DD), or null.
  delivery_date: string | null;
  address: string | null;
  lines: OutlookOrderLine[];
  // The order as written: the opening line to "Please confirm when you can,
  // thank you.", without the subject line or the signature.
  body_text: string;
};

/** An existing order row on the job (any origin, any status). */
export type JobOrderRow = {
  id: string;
  supplier_id: string | null;
  status: string;
  origin: string | null;
  source_business_event_id: string | null;
  sent_internet_message_id: string | null;
};

export type SupplierUsage = {
  supplier_id: string;
  // The newest Dispatch order sent to this Xero contact, any job.
  last_order_at: string | null;
  // The newest supplier box made for this Xero contact, any job.
  last_box_at: string | null;
};

export type RecordOutlookOrderInput = {
  org_id: string;
  job_id: string;
  supplier_id: string;
  related_supplier_ids: string[];
  work_type: string;
  team_cc_email: string | null;
  to_emails: string[];
  cc_emails: string[];
  subject: string;
  body_text: string;
  delivery_date: string | null;
  order_lines: OutlookOrderLine[];
  standing_lines_included: boolean;
  sent_at: string;
  sent_by_email: string | null;
  sent_from_mailbox: string | null;
  sent_internet_message_id: string | null;
  sent_conversation_id: string | null;
  source_business_event_id: string;
  reply_email_id: string | null;
};

export type RecordOutlookOrderResult = {
  recorded: boolean;
  order_id: string | null;
  box_created: boolean;
  // null when recorded; else already_recorded, dispatch_order_exists,
  // job_not_found, supplier_not_found or supplier_inactive.
  reason: string | null;
  supplier_name?: string | null;
};

export interface OutlookOrderStore {
  /** Our captured sent emails whose subject names this job number. */
  sentOrderEmails(orgId: string, jobNumber: string): Promise<OutlookSentEmail[]>;
  /** Every order row on the job, any origin and status. */
  jobOrders(orgId: string, jobId: string): Promise<JobOrderRow[]>;
  /** The Xero contacts the job already has a supplier box for. */
  jobBoxSupplierIds(orgId: string, jobId: string): Promise<string[]>;
  /** When each of these Xero contacts was last used on Dispatch. */
  supplierUsage(orgId: string, supplierIds: string[]): Promise<SupplierUsage[]>;
  /** The one write (dispatch_v2_record_outlook_order). */
  recordOutlookOrder(
    input: RecordOutlookOrderInput,
  ): Promise<RecordOutlookOrderResult>;
}

// ── The rules ─────────────────────────────────────────────────────────────

// The order email's subject: "Material Order Ref SWF-261586", optionally
// followed by more words after a dash ("... - Vesna"). Never a reply or a
// forward (our own sent order is neither).
const SUBJECT_RE =
  /^\s*material\s+order\s+ref\.?\s*[:#]?\s*(SW[A-Z]{1,3}[- ]?\d{4,7})(?![0-9A-Za-z])(?:\s*(?:[-:|,]\s*.*)?)?$/i;

/** True when the subject is our order subject for this job number. */
export function isOutlookOrderSubject(
  subject: unknown,
  jobNumber: string,
): boolean {
  const m = SUBJECT_RE.exec(String(subject ?? ""));
  if (!m) return false;
  const named = normaliseJobNumber(m[1].replace(/\s+/g, "-"));
  return named === normaliseJobNumber(jobNumber);
}

/** True when the email went to the supplier: one of its To addresses is on
 * the supplier's approved order list, or shares a company domain with one
 * (never a shared mail domain such as gmail.com). */
export function sentToSupplier(
  to: string[],
  approved: Pick<ApprovedSupplierSender, "emails">,
): boolean {
  const list = approved.emails.map((e) => e.toLowerCase());
  const domains = new Set(
    list.map(domainOf).filter((d) => !SHARED_MAIL_DOMAINS.has(d)),
  );
  return to.some((raw) => {
    const a = emailAddressOf(raw);
    if (!a) return false;
    return list.includes(a) || domains.has(domainOf(a));
  });
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** "Nov", "November" or "Sept" -> 11 / 9; anything else -> null. */
function monthOf(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return null;
  const i = MONTH_NAMES.findIndex((name) => name.startsWith(w));
  return i < 0 ? null : i + 1;
}

function isoDay(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (
    t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 ||
    t.getUTCDate() !== d
  ) {
    return null;
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The day a Date line names: "12 November 2026", "Thu 12 Nov", "12/11/2026"
 * or "12/11" (day first, as written in Australia). With no year, the year
 * the email was sent, or the next one when that day is more than 60 days
 * before the send. Null when it names no single day (ASAP, blank, words). */
export function readOrderDate(
  value: string,
  sentAt: string | null,
): string | null {
  const v = value.trim();
  if (!v) return null;
  const sentDay = perthDay(sentAt);
  const sentYear = sentDay ? Number(sentDay.slice(0, 4)) : null;
  const withYear = (d: number, m: number, y: number | null): string | null => {
    if (y !== null) return isoDay(y < 100 ? 2000 + y : y, m, d);
    if (sentYear === null || !sentDay) return null;
    const same = isoDay(sentYear, m, d);
    if (!same) return null;
    const gap = (Date.parse(sentDay) - Date.parse(same)) / 86_400_000;
    return gap > 60 ? isoDay(sentYear + 1, m, d) : same;
  };
  const named =
    /^(?:[A-Za-z]+,?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?,?(?:\s+(\d{4}))?$/
      .exec(v);
  if (named) {
    const m = monthOf(named[2]);
    if (!m) return null;
    return withYear(Number(named[1]), m, named[3] ? Number(named[3]) : null);
  }
  const slashed =
    /^(?:[A-Za-z]+,?\s+)?(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?$/.exec(v);
  if (slashed) {
    return withYear(
      Number(slashed[1]),
      Number(slashed[2]),
      slashed[3] ? Number(slashed[3]) : null,
    );
  }
  return null;
}

// The line that ends the order: "Please confirm when you can, thank you."
const CONFIRM_LINE_RE = /^\s*please\s+confirm\b/i;
// A sign-off: the signature starts here.
const SIGN_OFF_RE =
  /^\s*(?:kind\s+regards|warm\s+regards|best\s+regards|regards|many\s+thanks|thanks|thank\s+you|cheers)\b[\s,.!]*$/i;
const MATERIALS_RE = /^\s*materials\s+needed\s*:?\s*$/i;
const ITEM_RE = /^\s*(\d{1,2})[.)]\s+(\S.*)$/;
const MAX_LINES = 60;

function standingText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}
const STANDING = new Set(DISPATCH_V2_STANDING_LINES.map(standingText));

/** The order part of an email body: from the top (the reader's "Subject:"
 * line removed) to "Please confirm..." (kept) or to the sign-off (not kept),
 * so the signature is never part of the order. */
function orderTextOf(body: string): { lines: string[]; confirmAt: number } {
  const all = String(body ?? "").replace(/\r\n?/g, "\n")
    .replace(/^\s*Subject:[^\n]*\n+/i, "")
    .split("\n");
  let end = all.length;
  let confirmAt = -1;
  for (let i = 0; i < all.length; i++) {
    if (CONFIRM_LINE_RE.test(all[i])) {
      confirmAt = i;
      end = i + 1;
      break;
    }
    if (SIGN_OFF_RE.test(all[i])) {
      end = i;
      break;
    }
  }
  return { lines: all.slice(0, end), confirmAt };
}

/** The Date, Address, delivery or pickup and branch, read from the lines
 * above the list (or from the whole order when there is no list). */
function orderHeadOf(
  head: string[],
  bodyText: string,
  sentAt: string | null,
): Omit<ParsedOutlookOrder, "lines" | "body_text"> {
  const field = (label: string): string | null => {
    const re = new RegExp(`^\s*${label}\s*:[ \t]*(.*)$`, "i");
    for (const l of head) {
      const m = re.exec(l);
      if (m) return m[1].trim() || null;
    }
    return null;
  };
  const dateText = field("Date");
  const asap = !!dateText && /^asap\b/i.test(dateText);
  return {
    fulfilment: dispatchV2FulfilmentOf(bodyText),
    pickup_branch: dispatchOrderBranchOf(bodyText),
    date_text: dateText,
    date_mode: asap ? "asap" : "date",
    delivery_date: asap || !dateText ? null : readOrderDate(dateText, sentAt),
    address: field("Address"),
  };
}

/** Read an order email Shaun wrote in Outlook. Null when it is not one we
 * can read for certain: no "Materials Needed" heading, no numbered line, or
 * words before the first numbered line. */
export function parseOutlookOrderBody(
  body: string,
  sentAt: string | null,
): ParsedOutlookOrder | null {
  const { lines, confirmAt } = orderTextOf(body);
  const heading = lines.findIndex((l) => MATERIALS_RE.test(l));
  if (heading < 0) return null;

  // The numbered lines. A line that does not start a number belongs to the
  // item above it ("Profile: Ridgeside" under the panels).
  const itemsEnd = confirmAt >= 0 ? confirmAt : lines.length;
  const items: string[][] = [];
  for (const raw of lines.slice(heading + 1, itemsEnd)) {
    if (raw.trim() === "" || /^\s*\[cid:[^\]]*\]\s*$/i.test(raw)) continue;
    const m = ITEM_RE.exec(raw);
    if (m) {
      items.push([m[2].trim()]);
    } else if (items.length > 0) {
      items[items.length - 1].push(raw.trim());
    } else {
      return null;
    }
  }
  if (items.length === 0 || items.length > MAX_LINES) return null;

  const bodyText = lines.join("\n").trim();
  if (!bodyText) return null;
  const orderLines: OutlookOrderLine[] = items.map((parts) => {
    const text = parts.join("\n");
    return {
      line_id: null,
      updated_at: null,
      text,
      standing: STANDING.has(standingText(text)),
    };
  });
  return {
    ...orderHeadOf(lines.slice(0, heading), bodyText, sentAt),
    lines: orderLines,
    body_text: bodyText,
  };
}

// The longest order text a Dispatch order row may keep (its body check).
export const OUTLOOK_ORDER_BODY_MAX = 20000;

/** Read an order email for the send rule (contract section 3g, Shaun 6 Nov
 * 2026). When the list can be read, the same answer as parseOutlookOrderBody
 * with `list_read` true. When it cannot, the email's own words are kept as
 * the order with no lines (`list_read` false); the Date, Address and
 * delivery or pickup are still read from them. Null only when the email has
 * no words at all. */
export function readOutlookOrderBody(
  body: string,
  sentAt: string | null,
): (ParsedOutlookOrder & { list_read: boolean }) | null {
  const strict = parseOutlookOrderBody(body, sentAt);
  if (strict && strict.body_text.length <= OUTLOOK_ORDER_BODY_MAX) {
    return { ...strict, list_read: true };
  }
  const { lines } = orderTextOf(body);
  let bodyText = lines.join("\n").trim();
  if (!bodyText) {
    // Nothing above the sign-off: keep the whole email rather than nothing.
    bodyText = String(body ?? "").replace(/\r\n?/g, "\n")
      .replace(/^\s*Subject:[^\n]*\n+/i, "").trim();
  }
  if (!bodyText) return null;
  bodyText = bodyText.slice(0, OUTLOOK_ORDER_BODY_MAX);
  const heading = lines.findIndex((l) => MATERIALS_RE.test(l));
  return {
    ...orderHeadOf(
      heading < 0 ? lines : lines.slice(0, heading),
      bodyText,
      sentAt,
    ),
    lines: [],
    body_text: bodyText,
    list_read: false,
  };
}

/** Which of our sent emails is the order this reply answers. Only a sent
 * email from admin@ with this job's order subject, addressed to the
 * supplier, sent before the reply, read in full, and not already a Dispatch
 * order. The one in the reply's own conversation wins, else the newest. */
export function pickSentOrderEmail(
  sent: OutlookSentEmail[],
  opts: {
    jobNumber: string;
    approved: Pick<ApprovedSupplierSender, "emails">;
    replyConversationId: string | null;
    replyReceivedAt: string | null;
    // Provider keys of orders already sent from Dispatch.
    dispatchMessageKeys: Set<string>;
  },
): OutlookSentEmail | null {
  const replyAt = Date.parse(String(opts.replyReceivedAt ?? ""));
  const ours = DISPATCH_V2_FROM_MAILBOX.toLowerCase();
  const fit = sent.filter((e) => {
    if (e.folder_kind !== "sent") return false;
    const mailbox = emailAddressOf(e.mailbox) ?? emailAddressOf(e.from_email);
    if (mailbox !== ours) return false;
    if (!isOutlookOrderSubject(e.subject, opts.jobNumber)) return false;
    if (!sentToSupplier(e.to, opts.approved)) return false;
    if (e.body_truncated) return false;
    const at = Date.parse(String(e.sent_at ?? ""));
    if (!Number.isFinite(at)) return false;
    if (Number.isFinite(replyAt) && at >= replyAt) return false;
    const key = e.provider_message_id ??
      emailProviderKey(e.internet_message_id);
    if (key && opts.dispatchMessageKeys.has(key)) return false;
    return true;
  });
  if (fit.length === 0) return null;
  const newestFirst = [...fit].sort((a, b) =>
    Date.parse(String(b.sent_at)) - Date.parse(String(a.sent_at))
  );
  if (opts.replyConversationId) {
    const same = newestFirst.find((e) =>
      e.conversation_id === opts.replyConversationId
    );
    if (same) return same;
  }
  return newestFirst[0];
}

/** Which Xero contact the box is for. One supplier can be several Xero
 * contacts (R&R Fencing is three). The one already boxed on the job wins;
 * else the only one; else the one Dispatch last sent an order to, then the
 * one last boxed. Null when it cannot be told: nothing is recorded. */
export function pickSupplierId(
  candidates: string[],
  boxedOnJob: string[],
  usage: SupplierUsage[],
): string | null {
  const ids = [...new Set(candidates)];
  if (ids.length === 0) return null;
  const onJob = ids.filter((id) => boxedOnJob.includes(id));
  if (onJob.length === 1) return onJob[0];
  if (onJob.length > 1) return null;
  if (ids.length === 1) return ids[0];
  const newest = (key: "last_order_at" | "last_box_at"): string | null => {
    const dated = usage
      .filter((u) => ids.includes(u.supplier_id) && u[key])
      .map((u) => ({ id: u.supplier_id, at: Date.parse(String(u[key])) }))
      .filter((u) => Number.isFinite(u.at))
      .sort((a, b) => b.at - a.at);
    if (dated.length === 0) return null;
    if (dated.length > 1 && dated[0].at === dated[1].at) return null;
    return dated[0].id;
  };
  return newest("last_order_at") ?? newest("last_box_at");
}

/** Addresses as the order row keeps them: lower case, valid, no repeats. */
function cleanList(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const a = emailAddressOf(raw);
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

// ── The database ──────────────────────────────────────────────────────────

const CAPTURE_SOURCE = "outlook-mail-capture";
const SENT_SELECT =
  "id, provider_message_id, event_at, recorded_at, privacy_classification, payload";

export class OutlookOrderStoreError extends Error {
  detail: unknown;
  constructor(label: string, detail: unknown) {
    super(`${label} failed`);
    this.detail = detail;
  }
}

function failed(label: string, error: unknown): never {
  console.error(`[dispatch_v2_outlook_order] ${label} failed:`, error);
  throw new OutlookOrderStoreError(label, error);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(str).filter(Boolean) : [];
}

/** A business_events row -> the sent email the rules read. */
export function outlookSentEmailOf(row: any): OutlookSentEmail {
  const p = row?.payload ?? {};
  return {
    business_event_id: String(row.id),
    provider_message_id: str(row.provider_message_id) || null,
    internet_message_id: str(p.internet_message_id) || null,
    conversation_id: str(p.conversation_id) || null,
    sent_at: str(row.event_at) || str(row.recorded_at) || null,
    mailbox: str(p.mailbox) || null,
    from_email: str(p.from) || null,
    sent_by_email: str(p.sent_by_user) || null,
    folder_kind: str(p.folder_kind) || null,
    to: list(p.to),
    cc: list(p.cc),
    subject: str(p.subject),
    body: str(p.body).replace(/^\s*Subject:[^\n]*\n+/i, ""),
    body_truncated: p.body_truncated === true,
  };
}

/** The default: PostgREST reads and the one function call. */
export function postgrestOutlookOrderStore(client: any): OutlookOrderStore {
  return {
    async sentOrderEmails(_orgId, jobNumber) {
      const digits = /(\d{4,7})$/.exec(normaliseJobNumber(jobNumber))?.[1];
      if (!digits) return [];
      const { data, error } = await client.from("business_events")
        .select(SENT_SELECT)
        .eq("source", CAPTURE_SOURCE)
        .eq("channel", "email")
        .eq("direction", "outbound")
        .eq("payload->>folder_kind", "sent")
        .ilike("payload->>subject", `%material order ref%${digits}%`)
        .or(
          "privacy_classification.is.null,privacy_classification.neq.restricted_pii",
        )
        .order("event_at", { ascending: false })
        .limit(20);
      if (error) failed("sent order emails read", error);
      return (data || []).map(outlookSentEmailOf);
    },

    async jobOrders(orgId, jobId) {
      const { data, error } = await client.from(
        "dispatch_supplier_order_emails",
      )
        .select(
          "id, supplier_id, status, origin, source_business_event_id, sent_internet_message_id",
        )
        .eq("org_id", orgId)
        .eq("job_id", jobId);
      if (error) failed("job orders read", error);
      return (data || []).map((r: any) => ({
        id: String(r.id),
        supplier_id: r.supplier_id ? String(r.supplier_id) : null,
        status: String(r.status ?? ""),
        origin: r.origin ?? null,
        source_business_event_id: r.source_business_event_id ?? null,
        sent_internet_message_id: r.sent_internet_message_id ?? null,
      }));
    },

    async jobBoxSupplierIds(_orgId, jobId) {
      const { data, error } = await client.from("job_material_suppliers")
        .select("supplier_id")
        .eq("job_id", jobId);
      if (error) failed("job boxes read", error);
      return (data || []).map((r: any) => String(r.supplier_id));
    },

    async supplierUsage(orgId, supplierIds) {
      const ids = [...new Set(supplierIds)];
      if (ids.length === 0) return [];
      const orders = await client.from("dispatch_supplier_order_emails")
        .select("supplier_id, sent_at")
        .eq("org_id", orgId)
        .eq("status", "sent")
        .in("supplier_id", ids)
        .order("sent_at", { ascending: false })
        .limit(500);
      if (orders.error) failed("supplier order use read", orders.error);
      const boxes = await client.from("job_material_suppliers")
        .select("supplier_id, created_at")
        .in("supplier_id", ids)
        .order("created_at", { ascending: false })
        .limit(500);
      if (boxes.error) failed("supplier box use read", boxes.error);
      const out = new Map<string, SupplierUsage>();
      const row = (id: string) => {
        if (!out.has(id)) {
          out.set(id, { supplier_id: id, last_order_at: null, last_box_at: null });
        }
        return out.get(id)!;
      };
      for (const r of orders.data || []) {
        const u = row(String(r.supplier_id));
        if (!u.last_order_at && r.sent_at) u.last_order_at = String(r.sent_at);
      }
      for (const r of boxes.data || []) {
        const u = row(String(r.supplier_id));
        if (!u.last_box_at && r.created_at) u.last_box_at = String(r.created_at);
      }
      return [...out.values()];
    },

    async recordOutlookOrder(input) {
      const { data, error } = await client.rpc(
        "dispatch_v2_record_outlook_order",
        { p: input },
      );
      if (error) failed("outlook order record", error);
      const r = data ?? {};
      return {
        recorded: r.recorded === true,
        order_id: r.order_id ? String(r.order_id) : null,
        box_created: r.box_created === true,
        reason: r.reason ?? null,
      };
    },
  };
}

// ── The step the scan calls ───────────────────────────────────────────────

export type OutlookOrderOutcome =
  | {
    recorded: boolean;
    order: V2Order;
    box_created: boolean;
    reason: string;
  }
  | { recorded: false; order: null; box_created: false; reason: string };

function skip(reason: string): OutlookOrderOutcome {
  return { recorded: false, order: null, box_created: false, reason };
}

/** Record the Outlook order a reply answers, or say why not. Never throws:
 * a failed read or write is a skip ("failed"), and the reply stays matched
 * to the job only, as it was before this existed. */
export async function recordOutlookOrderForReply(
  store: OutlookOrderStore,
  input: {
    orgId: string;
    reply: {
      id: string;
      conversation_id: string | null;
      received_at: string | null;
    };
    job: JobHint;
    // The sender's approved entry (its order addresses and Xero contacts).
    supplier: ApprovedSupplierSender | null;
  },
): Promise<OutlookOrderOutcome> {
  const { orgId, reply, job, supplier } = input;
  if (!supplier || supplier.supplier_ids.length === 0) {
    return skip("supplier_not_on_approved_list");
  }
  if (!job.job_number) return skip("job_has_no_number");
  try {
    const related = [...new Set(supplier.supplier_ids)];
    const jobOrders = await store.jobOrders(orgId, job.job_id);
    const dispatchKeys = new Set(
      jobOrders
        .map((o) => emailProviderKey(o.sent_internet_message_id))
        .filter((k): k is string => !!k),
    );
    const sent = await store.sentOrderEmails(orgId, job.job_number);
    const chosen = pickSentOrderEmail(sent, {
      jobNumber: job.job_number,
      approved: supplier,
      replyConversationId: reply.conversation_id,
      replyReceivedAt: reply.received_at,
      dispatchMessageKeys: new Set(
        [...dispatchKeys].filter((k) =>
          // An Outlook order's own message id is not a Dispatch send.
          !jobOrders.some((o) =>
            o.origin === "outlook" &&
            emailProviderKey(o.sent_internet_message_id) === k
          )
        ),
      ),
    });
    if (!chosen) return skip("sent_email_not_found");

    // Any other order on the job to this supplier (a draft, a Dispatch send,
    // another Outlook order): the job is left alone.
    const others = jobOrders.filter((o) =>
      o.status !== "discarded" &&
      o.source_business_event_id !== chosen.business_event_id &&
      o.supplier_id !== null && related.includes(o.supplier_id)
    );
    if (others.length > 0) return skip("dispatch_order_exists");

    const parsed = parseOutlookOrderBody(chosen.body, chosen.sent_at);
    if (!parsed) return skip("sent_email_not_read");

    const supplierId = pickSupplierId(
      related,
      await store.jobBoxSupplierIds(orgId, job.job_id),
      await store.supplierUsage(orgId, related),
    );
    if (!supplierId) return skip("supplier_contact_not_known");

    const to = cleanList(chosen.to);
    const cc = cleanList(chosen.cc);
    if (to.length < 1 || to.length > 10 || cc.length > 12) {
      return skip("recipients_out_of_range");
    }
    const subject = chosen.subject.trim();
    if (!subject || subject.length > 250) return skip("sent_email_not_read");
    if (parsed.body_text.length > 20000) return skip("sent_email_not_read");

    const workType = job.type ?? "other";
    const result = await store.recordOutlookOrder({
      org_id: orgId,
      job_id: job.job_id,
      supplier_id: supplierId,
      related_supplier_ids: related,
      work_type: workType,
      team_cc_email: dispatchV2TeamCc(workType).email,
      to_emails: to,
      cc_emails: cc,
      subject,
      body_text: parsed.body_text,
      delivery_date: parsed.delivery_date,
      order_lines: parsed.lines,
      standing_lines_included: parsed.lines.some((l) => l.standing),
      sent_at: chosen.sent_at!,
      sent_by_email: emailAddressOf(chosen.sent_by_email) ??
        emailAddressOf(chosen.mailbox),
      sent_from_mailbox: emailAddressOf(chosen.mailbox),
      sent_internet_message_id: chosen.internet_message_id,
      sent_conversation_id: chosen.conversation_id,
      source_business_event_id: chosen.business_event_id,
      reply_email_id: reply.id,
    });
    if (!result.order_id) return skip(result.reason ?? "not_recorded");
    const order: V2Order = {
      order_id: result.order_id,
      job_id: job.job_id,
      job_number: job.job_number,
      supplier_id: supplierId,
      supplier_name: supplier.supplier_name,
      status: "sent",
      sent_at: chosen.sent_at,
      sent_internet_message_id: chosen.internet_message_id,
      sent_conversation_id: chosen.conversation_id,
      confirmed_delivery_date: null,
      fulfilment: parsed.fulfilment,
    };
    return {
      recorded: result.recorded,
      order,
      box_created: result.box_created,
      reason: result.recorded ? "recorded" : (result.reason ?? "already_recorded"),
    };
  } catch (e) {
    console.error("[dispatch_v2_outlook_order] skipped:", e);
    return skip("failed");
  }
}

/** The words the reply's match reason gains once it is tied. */
export function outlookTieReason(order: V2Order): string {
  const day = perthDay(order.sent_at);
  return `Tied to the order sent from Outlook${day ? ` on ${dayLabel(day)}` : ""}`;
}
