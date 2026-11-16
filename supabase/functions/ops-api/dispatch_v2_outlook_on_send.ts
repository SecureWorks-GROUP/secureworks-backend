// deno-lint-ignore-file no-explicit-any
// Dispatch v2 (Shaun, 6 Nov 2026): an order sent from Outlook becomes a
// Dispatch order the moment it is sent. Contract:
// docs/dispatch-v2-board-contract.md, section 3g.
//
// Shaun's rule, in business words:
//   * An order is an email sent from admin@secureworkswa.com.au whose subject
//     starts "Material Order Ref <job number>" (words after the number are
//     fine), addressed to a supplier on the approved order list, or to an
//     address at that supplier's company domain.
//   * The send itself makes it that supplier's order on that job. Nobody
//     waits for a reply (this replaces the 5 Nov rule, section 3f.1).
//   * Never an order: a Re: or Fw:, a "Material Order Quote Ref" (a request
//     for a price), or an email Dispatch sent itself (its copy also lands in
//     admin@ Sent; it is matched on the Outlook message id or conversation).
//   * The job comes only from the subject. A wrong or unknown job number, or
//     a job that is not on the Dispatch board, never makes an order: the
//     email waits under "Emails to sort" for a person.
//   * The supplier comes from the To addresses. One email to two suppliers
//     makes two orders. An entry's recognise-only addresses count too
//     (also_known_emails: Shaun, 11 Nov 2026, an order to
//     wasales@solarspan.com.au is a Bondor order).
//   * The box shows Sent to supplier, with the lines read from "Materials
//     Needed:", delivery or pickup, the date or ASAP and the address, read
//     exactly as section 3f.1 reads them. With no readable list the email's
//     words are kept as the order and the lines are left empty.
//   * A second order to the same supplier on the same job reuses the box as
//     its newest order. Replies then tie to it the normal way (same thread,
//     or that supplier with the job number in the subject) and the normal
//     one-step move follows (section 3c).
//
// This file holds:
//   1. The rules (pure, tested): reading the subject, who it went to, whether
//      Dispatch sent it, whether the job is on the board, and the plan for one
//      sent email. Also which stored reply belongs to which order.
//   2. The database reads and writes behind OnSendStore.
//   3. The step the five-minute scan runs (scanSentOrderEmails).
// The one-off catch-up over older emails (section 3g.2) is in
// dispatch_v2_outlook_catch_up.ts and uses the same rules.
//
// What it never does: send anything, move a job's stage or status, add
// material lines to the job's list, or write GHL, Xero or the suppliers table.

import {
  type ApprovedSupplierSender,
  approvedMatchEmails,
  dayLabel,
  domainOf,
  emailAddressOf,
  normaliseJobNumber,
  perthDay,
  SHARED_MAIL_DOMAINS,
  supplierKeyOf,
} from "./dispatch_v2_replies_rules.ts";
import { DISPATCH_V2_FROM_MAILBOX, dispatchV2TeamCc } from "./dispatch_v2_emails.ts";
import {
  type OutlookOrderLine,
  type OutlookSentEmail,
  outlookSentEmailOf,
  type ParsedOutlookOrder,
  pickSupplierId,
  readOutlookOrderBody,
  type SupplierUsage,
} from "./dispatch_v2_outlook_order.ts";
import { dispatchBoardStage } from "./dispatch_board.ts";
import { dispatchWorkType } from "./dispatch_job_list.ts";
import { emailProviderKey } from "../_shared/evidence/outlook_mail.ts";
import type { NewEmailRow, RepliesStore } from "./dispatch_v2_replies_store.ts";

// ── Shapes ────────────────────────────────────────────────────────────────

/** One approved supplier on the order list, with its id and terms. */
export type OnSendEntry = ApprovedSupplierSender & {
  approved_id: string | null;
  on_account: boolean | null;
};

/** A captured sent email, with its place in business_events. */
export type CapturedSentEmail = OutlookSentEmail & { sequence_number: number };

/** The job as the board rule needs it. */
export type OnSendJob = {
  job_id: string;
  job_number: string | null;
  client_name: string | null;
  status: string | null;
  type: string | null;
  legacy: boolean | null;
  ses_family: string | null;
  makesafe_family: string | null;
  repair_stage: string | null;
};

/** A sent order row on Dispatch (any origin). */
export type OnSendOrderRow = {
  order_id: string;
  job_id: string;
  supplier_id: string | null;
  origin: string | null;
  status: string;
  sent_at: string | null;
  sent_internet_message_id: string | null;
  sent_conversation_id: string | null;
  source_business_event_id: string | null;
};

/** A supplier box on a job. */
export type OnSendBox = {
  box_id: string;
  job_id: string;
  supplier_id: string;
  material_stage: string | null;
  material_stage_set_at: string | null;
};

/** A supplier email the reply scan already stored. */
export type StoredReply = {
  id: string;
  job_id: string | null;
  order_id: string | null;
  state: string;
  rung: string | null;
  supplier_key: string | null;
  from_email: string | null;
  conversation_id: string | null;
  received_at: string | null;
  match_reason: string | null;
  subject: string;
};

// ── The rules ─────────────────────────────────────────────────────────────

export type SubjectRead =
  // "Material Order Ref SWF-261586 ...": the job number, normalised.
  | { kind: "order"; job_number: string }
  // "Material Order Ref" followed by something that is not one of our job
  // numbers ("MLB-27836"), or by nothing.
  | { kind: "order_unknown_number"; token: string | null }
  | { kind: "reply_or_forward" }
  | { kind: "quote_request" }
  | { kind: "not_order" };

const REPLY_OR_FORWARD_RE = /^\s*(?:re|fw|fwd|aw|wg)\s*(?:\[\d+\])?\s*:/i;
const QUOTE_SUBJECT_RE = /^\s*material\s+order\s+quote\s+ref\b/i;
const ORDER_SUBJECT_RE = /^\s*material\s+order\s+ref\b\.?\s*[:#-]?\s*(.*)$/i;
const JOB_TOKEN_RE = /^(SW[A-Z]{1,3})[- ]?(\d{4,7})(?![0-9A-Za-z])/i;

/** What an email's subject says it is. Only a subject that STARTS with
 * "Material Order Ref" can be an order. */
export function readOrderSubject(subject: unknown): SubjectRead {
  const s = String(subject ?? "");
  if (REPLY_OR_FORWARD_RE.test(s)) {
    return /material\s+order/i.test(s)
      ? { kind: "reply_or_forward" }
      : { kind: "not_order" };
  }
  if (QUOTE_SUBJECT_RE.test(s)) return { kind: "quote_request" };
  const m = ORDER_SUBJECT_RE.exec(s);
  if (!m) return { kind: "not_order" };
  const rest = m[1].trim();
  const job = JOB_TOKEN_RE.exec(rest);
  if (job && job[1].toUpperCase() !== "SWMS") {
    return {
      kind: "order",
      job_number: normaliseJobNumber(`${job[1]}-${job[2]}`),
    };
  }
  const token = rest.split(/\s+/)[0] || null;
  return { kind: "order_unknown_number", token };
}

/** The approved suppliers an email was addressed to, from its To addresses
 * only: an address on a supplier's approved list, else an address at that
 * supplier's company domain (never a shared mail domain such as
 * bigpond.com, and never a domain two suppliers share). Each supplier once,
 * in the order its first address appears. */
export function suppliersAddressed(
  to: string[],
  entries: OnSendEntry[],
): { entry: OnSendEntry; address: string }[] {
  const out: { entry: OnSendEntry; address: string }[] = [];
  const add = (entry: OnSendEntry, address: string) => {
    if (!out.some((o) => o.entry.supplier_key === entry.supplier_key)) {
      out.push({ entry, address });
    }
  };
  for (const raw of to) {
    const a = emailAddressOf(raw);
    if (!a) continue;
    const exact = entries.filter((e) => e.emails.includes(a));
    if (exact.length === 1) {
      add(exact[0], a);
      continue;
    }
    if (exact.length > 1) continue;
    const domain = domainOf(a);
    if (SHARED_MAIL_DOMAINS.has(domain)) continue;
    const byDomain = entries.filter((e) =>
      e.emails.some((x) => domainOf(x) === domain)
    );
    if (byDomain.length === 1) add(byDomain[0], a);
  }
  return out;
}

/** True when the sent email is one Dispatch sent itself: the same Outlook
 * message, or the same conversation, as a Dispatch send. */
export function isDispatchOwnSend(
  email: Pick<
    OutlookSentEmail,
    "provider_message_id" | "internet_message_id" | "conversation_id"
  >,
  sends: Pick<
    OnSendOrderRow,
    "origin" | "sent_internet_message_id" | "sent_conversation_id"
  >[],
): boolean {
  const key = email.provider_message_id ??
    emailProviderKey(email.internet_message_id);
  return sends.some((s) => {
    if ((s.origin ?? "dispatch") !== "dispatch") return false;
    const sKey = emailProviderKey(s.sent_internet_message_id);
    if (key && sKey && key === sKey) return true;
    return !!email.conversation_id && !!s.sent_conversation_id &&
      email.conversation_id === s.sent_conversation_id;
  });
}

function isTestName(name: string | null): boolean {
  return !!name && (/\btest\b/i.test(name) || /^marnin test/i.test(name));
}

export type BoardPlace = {
  on_board: boolean;
  // The job's stage as the board names it ("Scheduled", "Repair: Materials").
  stage_label: string | null;
  // Past the board (Complete, Invoiced ...; a repair On Site or Complete).
  finished: boolean;
};

/** Whether a job is on the Dispatch board, by the board's own rule
 * (dispatch_board.ts dispatchBoardStage): fencing, patio or decking at Order
 * Materials to Rectification, or a repair at Materials or Scheduled. Never a
 * legacy job, a test record or a job with no number. */
export function jobOnDispatchBoard(job: OnSendJob): BoardPlace {
  if (job.legacy === true || !job.job_number || isTestName(job.client_name)) {
    return { on_board: false, stage_label: null, finished: false };
  }
  const stage = dispatchBoardStage({
    type: job.type,
    status: job.status,
    ds_ses_family: job.ses_family,
    ds_makesafe_family: job.makesafe_family,
    ds_repair_stage: job.repair_stage,
  });
  if (!stage) return { on_board: false, stage_label: null, finished: false };
  const label = stage.track === "repairs"
    ? `Repair: ${stage.label}`
    : stage.label;
  return {
    on_board: stage.phase === "window",
    stage_label: label,
    finished: stage.phase === "after",
  };
}

export type IgnoredReason =
  | "not_sent_from_admin"
  | "not_order_subject"
  | "reply_or_forward"
  | "quote_request"
  | "dispatch_own_send"
  | "not_to_a_supplier";

export type RefusedReason =
  | "job_number_unknown"
  | "job_not_on_board"
  | "no_words"
  | "supplier_not_in_xero";

export type PlannedOrder = {
  entry: OnSendEntry;
  // The To address that names the supplier.
  address: string;
  parsed: ParsedOutlookOrder & { list_read: boolean };
};

export type SentEmailPlan = {
  email: CapturedSentEmail;
  verdict: "orders" | "ignored" | "refused";
  reason: IgnoredReason | RefusedReason | null;
  // Plain words for the tray and the preview.
  reason_text: string | null;
  job_number: string | null;
  job: OnSendJob | null;
  place: BoardPlace | null;
  orders: PlannedOrder[];
  // Every approved supplier it was addressed to.
  suppliers: OnSendEntry[];
  // Approved suppliers it went to that have no Xero contact linked, so no
  // box can be made for them (an order to them waits under Emails to sort).
  unlinked: OnSendEntry[];
};

const OUR_MAILBOX = DISPATCH_V2_FROM_MAILBOX.toLowerCase();

/** What one sent email is, by Shaun's rule. Pure. */
export function planSentOrderEmail(
  email: CapturedSentEmail,
  input: {
    jobsByNumber: Map<string, OnSendJob>;
    entries: OnSendEntry[];
    dispatchSends: Pick<
      OnSendOrderRow,
      "origin" | "sent_internet_message_id" | "sent_conversation_id"
    >[];
  },
): SentEmailPlan {
  let suppliers: OnSendEntry[] = [];
  const plan = (
    verdict: SentEmailPlan["verdict"],
    reason: SentEmailPlan["reason"],
    reasonText: string | null,
    extra: Partial<SentEmailPlan> = {},
  ): SentEmailPlan => ({
    email,
    verdict,
    reason,
    reason_text: reasonText,
    job_number: null,
    job: null,
    place: null,
    orders: [],
    suppliers,
    unlinked: [],
    ...extra,
  });
  const mailbox = emailAddressOf(email.mailbox) ??
    emailAddressOf(email.from_email);
  if (email.folder_kind !== "sent" || mailbox !== OUR_MAILBOX) {
    return plan("ignored", "not_sent_from_admin", null);
  }
  const subject = readOrderSubject(email.subject);
  if (subject.kind === "not_order") {
    return plan("ignored", "not_order_subject", null);
  }
  if (subject.kind === "reply_or_forward") {
    return plan("ignored", "reply_or_forward", "A reply or forward, not an order");
  }
  if (subject.kind === "quote_request") {
    return plan("ignored", "quote_request", "A quote request, not an order");
  }
  if (isDispatchOwnSend(email, input.dispatchSends)) {
    return plan(
      "ignored",
      "dispatch_own_send",
      "Sent from Dispatch, already its order",
    );
  }
  const addressed = suppliersAddressed(email.to, input.entries);
  if (addressed.length === 0) {
    return plan(
      "ignored",
      "not_to_a_supplier",
      "Not addressed to a supplier on the approved order list",
    );
  }
  suppliers = addressed.map((a) => a.entry);
  const entriesText = suppliers.map((e) => e.supplier_name).join(", ");
  if (subject.kind === "order_unknown_number") {
    return plan(
      "refused",
      "job_number_unknown",
      `Order sent from Outlook to ${entriesText}, but "${
        subject.token ?? "(nothing)"
      }" in the subject is not one of our job numbers. Sort it by hand.`,
      { job_number: subject.token },
    );
  }
  const job = input.jobsByNumber.get(subject.job_number) ?? null;
  if (!job) {
    return plan(
      "refused",
      "job_number_unknown",
      `Order sent from Outlook to ${entriesText}, but there is no job ${subject.job_number}. Sort it by hand.`,
      { job_number: subject.job_number },
    );
  }
  const place = jobOnDispatchBoard(job);
  if (!place.on_board) {
    return plan(
      "refused",
      "job_not_on_board",
      `Order sent from Outlook to ${entriesText} for ${subject.job_number}, which is not on the Dispatch board${
        place.stage_label ? ` (${place.stage_label})` : ""
      }. Sort it by hand.`,
      { job_number: subject.job_number, job, place },
    );
  }
  const parsed = readOutlookOrderBody(email.body, email.sent_at);
  if (!parsed) {
    return plan(
      "refused",
      "no_words",
      `Order sent from Outlook for ${subject.job_number} has no words to keep. Sort it by hand.`,
      { job_number: subject.job_number, job, place },
    );
  }
  const orders = addressed
    .filter((a) => a.entry.supplier_ids.length > 0)
    .map((a) => ({ entry: a.entry, address: a.address, parsed }));
  const unlinked = addressed
    .filter((a) => a.entry.supplier_ids.length === 0)
    .map((a) => a.entry);
  if (orders.length === 0) {
    return plan(
      "refused",
      "supplier_not_in_xero",
      `Order sent from Outlook for ${subject.job_number} to ${
        unlinked.map((e) => e.supplier_name).join(", ")
      }, which has no Xero supplier contact linked, so Dispatch cannot show its box. Sort it by hand.`,
      { job_number: subject.job_number, job, place, unlinked },
    );
  }
  return plan("orders", null, null, {
    job_number: subject.job_number,
    job,
    place,
    orders,
    unlinked,
  });
}

/** True when a stored reply came from this approved supplier: its key, an
 * address on its list, or its company domain. */
export function replyIsFromEntry(
  reply: Pick<StoredReply, "supplier_key" | "from_email">,
  entry: Pick<OnSendEntry, "supplier_key" | "emails">,
): boolean {
  if (reply.supplier_key && reply.supplier_key === entry.supplier_key) {
    return true;
  }
  const a = emailAddressOf(reply.from_email);
  if (!a) return false;
  if (entry.emails.includes(a)) return true;
  const domain = domainOf(a);
  return !SHARED_MAIL_DOMAINS.has(domain) &&
    entry.emails.some((x) => domainOf(x) === domain);
}

export type OrderRef = {
  order_id: string;
  sent_at: string | null;
  sent_conversation_id: string | null;
};

function at(value: string | null | undefined): number {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : NaN;
}

/** Which of a supplier's orders on a job a stored reply answers: the one in
 * the reply's own email thread, else the newest one sent before the reply.
 * Null when no order was sent before it. */
export function orderForStoredReply(
  reply: Pick<StoredReply, "conversation_id" | "received_at">,
  orders: OrderRef[],
): OrderRef | null {
  const replyAt = at(reply.received_at);
  if (!Number.isFinite(replyAt)) return null;
  const before = orders.filter((o) => {
    const t = at(o.sent_at);
    return Number.isFinite(t) && t < replyAt;
  }).sort((a, b) => at(b.sent_at) - at(a.sent_at));
  if (before.length === 0) return null;
  if (reply.conversation_id) {
    const same = before.find((o) =>
      o.sent_conversation_id === reply.conversation_id
    );
    if (same) return same;
  }
  return before[0];
}

/** The stored replies to tie, and the order each ties to. Only a reply the
 * scan matched to this job with no order, from this supplier, whose order
 * (orderForStoredReply over all the supplier's orders on the job) is one of
 * `tieable` (the orders just recorded from Outlook). */
export function storedRepliesToTie(
  replies: StoredReply[],
  input: {
    job_id: string;
    entry: Pick<OnSendEntry, "supplier_key" | "emails">;
    orders: OrderRef[];
    tieable: Set<string>;
  },
): { reply: StoredReply; order: OrderRef }[] {
  const out: { reply: StoredReply; order: OrderRef }[] = [];
  for (const r of replies) {
    if (r.state !== "matched" || r.job_id !== input.job_id || r.order_id) {
      continue;
    }
    if (!replyIsFromEntry(r, input.entry)) continue;
    const order = orderForStoredReply(r, input.orders);
    if (order && input.tieable.has(order.order_id)) out.push({ reply: r, order });
  }
  return out;
}

/** The words a tied reply's match reason gains. */
export function outlookSendTieReason(sentAt: string | null): string {
  const day = perthDay(sentAt);
  return `Tied to the order sent from Outlook${day ? ` on ${dayLabel(day)}` : ""}`;
}

/** Addresses as the order row keeps them: lower case, valid, no repeats. */
export function cleanAddresses(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const a = emailAddressOf(raw);
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

/** The tray row ("Emails to sort") for a sent email that could not become
 * an order. Our own email, so it is marked sender_via 'our_sent_order': a
 * person who places it on a job ties it to the job only, never to an order,
 * so it can never move a box as if the supplier had replied. */
export function trayRowFor(
  plan: SentEmailPlan,
  orgId: string,
): NewEmailRow {
  const e = plan.email;
  const entry = plan.unlinked[0] ?? plan.suppliers[0] ?? null;
  const addressed = entry ? entry.supplier_name : null;
  const reason = plan.reason_text ??
    `Order sent from Outlook for ${plan.job_number} also went to ${
      plan.unlinked.map((u) => u.supplier_name).join(", ")
    }, which has no Xero supplier contact linked, so Dispatch cannot show that box. Sort it by hand.`;
  return {
    org_id: orgId,
    business_event_id: e.business_event_id,
    sequence_number: e.sequence_number,
    provider_message_id: e.provider_message_id,
    conversation_id: e.conversation_id,
    received_at: e.sent_at,
    from_email: emailAddressOf(e.mailbox) ?? OUR_MAILBOX,
    subject: e.subject,
    snippet: e.body.replace(/\s+/g, " ").trim().slice(0, 280),
    supplier_key: entry ? entry.supplier_key : null,
    supplier_name: addressed,
    sender_via: OUR_SENT_ORDER_VIA,
    // Shown in the tray's default view.
    order_desk: true,
    job_numbers: plan.job_number && /^SW[A-Z]{1,3}-\d+$/.test(plan.job_number)
      ? [plan.job_number]
      : [],
    supplier_refs: [],
    delivery_date: null,
    delivery_read: null,
    state: "unmatched",
    rung: null,
    match_reason: reason,
    job_id: null,
    order_id: null,
    candidates: plan.job
      ? [{
        order_id: null,
        job_id: plan.job.job_id,
        job_number: plan.job.job_number,
        supplier_name: addressed,
        reason: "job number in our order subject",
      }]
      : [],
    rejected_order_ids: [],
    decision: null,
    decided_at: null,
    decided_by: null,
    decided_by_email: null,
    matched_at: null,
  };
}

/** sender_via on a tray row that is one of our own sent order emails. */
export const OUR_SENT_ORDER_VIA = "our_sent_order";

// ── The database ──────────────────────────────────────────────────────────

export type RecordOnSendInput = {
  org_id: string;
  job_id: string;
  supplier_id: string;
  related_supplier_ids: string[];
  approved_email_id: string | null;
  trigger: "send" | "catch_up";
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
};

export type RecordOnSendResult = {
  recorded: boolean;
  order_id: string | null;
  box_id: string | null;
  box_created: boolean;
  // null when recorded; else already_recorded, dispatch_own_send,
  // job_not_found, supplier_not_found or supplier_inactive.
  reason: string | null;
};

export interface OnSendStore {
  /** Our captured sent emails (admin@ Sent, subject naming a material
   * order) captured in [since, before), oldest first. */
  sentOrderEmails(opts: {
    since: string;
    before: string;
    limit: number;
  }): Promise<CapturedSentEmail[]>;
  /** The approved supplier list, active entries, with links and terms. */
  approvedEntries(orgId: string): Promise<OnSendEntry[]>;
  jobsByNumbers(orgId: string, numbers: string[]): Promise<OnSendJob[]>;
  /** Dispatch's own sends whose message id or conversation is one of these. */
  dispatchSendsMatching(
    orgId: string,
    messageIds: string[],
    conversationIds: string[],
  ): Promise<OnSendOrderRow[]>;
  /** Order rows recorded from these captured sent emails. */
  ordersFromEvents(orgId: string, eventIds: string[]): Promise<OnSendOrderRow[]>;
  /** The captured emails among these already in the reply table (the tray). */
  storedEventIds(eventIds: string[]): Promise<Set<string>>;
  /** Every sent order on these jobs, any origin. */
  sentOrdersOnJobs(orgId: string, jobIds: string[]): Promise<OnSendOrderRow[]>;
  boxesOnJobs(orgId: string, jobIds: string[]): Promise<OnSendBox[]>;
  supplierUsage(orgId: string, supplierIds: string[]): Promise<SupplierUsage[]>;
  /** The supplier emails the reply scan stored on these jobs. */
  repliesOnJobs(orgId: string, jobIds: string[]): Promise<StoredReply[]>;
  /** The one order write (dispatch_v2_record_outlook_order_on_send). */
  recordOrder(input: RecordOnSendInput): Promise<RecordOnSendResult>;
  /** Tie a stored reply to an order, only while it still has none. */
  tieReply(
    orgId: string,
    replyId: string,
    orderId: string,
    matchReason: string,
    now: string,
  ): Promise<boolean>;
  /** The moment the send rule first ran (null before its first run). */
  sentOrdersSince(): Promise<string | null>;
  setSentOrdersSince(at: string): Promise<void>;
}

export class OnSendStoreError extends Error {
  detail: unknown;
  constructor(label: string, detail: unknown) {
    super(`${label} failed`);
    this.detail = detail;
  }
}

function failed(label: string, error: unknown): never {
  console.error(`[dispatch_v2_outlook_on_send] ${label} failed:`, error);
  throw new OnSendStoreError(label, error);
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const CAPTURE_SOURCE = "outlook-mail-capture";
const SENT_SELECT =
  "id, sequence_number, provider_message_id, event_at, recorded_at, privacy_classification, payload";
const ORDER_ROW_SELECT =
  "id, job_id, supplier_id, origin, status, sent_at, sent_internet_message_id, sent_conversation_id, source_business_event_id";
const JOB_SELECT =
  "id, job_number, client_name, status, type, legacy, ses_family:metadata->>ses_family, makesafe_family:metadata->>makesafe_job_family, repair_stage:metadata->>repair_stage";
const REPLY_SELECT =
  "id, job_id, order_id, state, rung, supplier_key, from_email, conversation_id, received_at, match_reason, subject";

function orderRowOf(r: any): OnSendOrderRow {
  return {
    order_id: String(r.id),
    job_id: String(r.job_id),
    supplier_id: r.supplier_id ? String(r.supplier_id) : null,
    origin: r.origin ?? null,
    status: String(r.status ?? ""),
    sent_at: r.sent_at ?? null,
    sent_internet_message_id: r.sent_internet_message_id ?? null,
    sent_conversation_id: r.sent_conversation_id ?? null,
    source_business_event_id: r.source_business_event_id ?? null,
  };
}

function jobOf(j: any): OnSendJob {
  return {
    job_id: String(j.id),
    job_number: j.job_number ?? null,
    client_name: j.client_name ?? null,
    status: j.status ?? null,
    type: j.type ?? null,
    legacy: j.legacy ?? null,
    ses_family: j.ses_family ?? null,
    makesafe_family: j.makesafe_family ?? null,
    repair_stage: j.repair_stage ?? null,
  };
}

/** The default: PostgREST reads and the one function call. */
export function postgrestOnSendStore(client: any): OnSendStore {
  return {
    async sentOrderEmails({ since, before, limit }) {
      const out: CapturedSentEmail[] = [];
      let after = -1;
      while (out.length < limit) {
        const { data, error } = await client.from("business_events")
          .select(SENT_SELECT)
          .eq("source", CAPTURE_SOURCE)
          .eq("channel", "email")
          .eq("direction", "outbound")
          .eq("payload->>folder_kind", "sent")
          .ilike("payload->>subject", "%material order%")
          .gte("recorded_at", since)
          .lt("recorded_at", before)
          .gt("sequence_number", after)
          .or(
            "privacy_classification.is.null,privacy_classification.neq.restricted_pii",
          )
          .order("sequence_number", { ascending: true })
          .limit(Math.min(200, limit - out.length));
        if (error) failed("sent order emails read", error);
        const rows = data || [];
        for (const r of rows) {
          out.push({
            ...outlookSentEmailOf(r),
            sequence_number: Number(r.sequence_number),
          });
        }
        if (rows.length < 200) break;
        after = Number(rows[rows.length - 1].sequence_number);
      }
      return out;
    },

    async approvedEntries(orgId) {
      const entries = await client.from("dispatch_approved_supplier_emails")
        .select(
          "id, name, to_emails, cc_emails, also_known_emails, active, on_account",
        )
        .eq("org_id", orgId)
        .eq("active", true);
      if (entries.error) failed("approved list read", entries.error);
      const links = await client.from("dispatch_approved_supplier_email_links")
        .select("supplier_id, approved_id")
        .eq("org_id", orgId);
      if (links.error) failed("approved links read", links.error);
      const ids = new Map<string, string[]>();
      for (const l of links.data || []) {
        const k = String(l.approved_id);
        ids.set(k, [...(ids.get(k) ?? []), String(l.supplier_id)]);
      }
      return (entries.data || []).map((e: any) => ({
        approved_id: String(e.id),
        supplier_key: supplierKeyOf(e.name),
        supplier_name: String(e.name),
        supplier_ids: ids.get(String(e.id)) ?? [],
        // To, CC and the recognise-only addresses (Solarspan on Bondor's
        // entry): who an order went to, never who Dispatch sends to.
        emails: approvedMatchEmails(e),
        on_account: typeof e.on_account === "boolean" ? e.on_account : null,
      }));
    },

    async jobsByNumbers(orgId, numbers) {
      const forms = [
        ...new Set(
          numbers.flatMap((n) => {
            const up = n.toUpperCase();
            const bare = up.replace("-", "");
            return up === bare ? [up] : [up, bare];
          }),
        ),
      ];
      const out: OnSendJob[] = [];
      for (const part of chunks(forms, 100)) {
        const { data, error } = await client.from("jobs")
          .select(JOB_SELECT)
          .eq("org_id", orgId)
          .in("job_number", part);
        if (error) failed("jobs by number read", error);
        out.push(...(data || []).map(jobOf));
      }
      return out;
    },

    async dispatchSendsMatching(orgId, messageIds, conversationIds) {
      const out = new Map<string, OnSendOrderRow>();
      const read = async (column: string, values: string[]) => {
        for (const part of chunks([...new Set(values)].filter(Boolean), 50)) {
          const { data, error } = await client.from(
            "dispatch_supplier_order_emails",
          )
            .select(ORDER_ROW_SELECT)
            .eq("org_id", orgId)
            .eq("origin", "dispatch")
            .in("status", ["sent", "send_unknown"])
            .in(column, part);
          if (error) failed("dispatch sends read", error);
          for (const r of data || []) out.set(String(r.id), orderRowOf(r));
        }
      };
      // Message ids are stored with or without the angle brackets.
      await read("sent_internet_message_id", [
        ...messageIds,
        ...messageIds.map((m) => `<${m.replace(/^<|>$/g, "")}>`),
        ...messageIds.map((m) => m.replace(/^<|>$/g, "")),
      ]);
      await read("sent_conversation_id", conversationIds);
      return [...out.values()];
    },

    async ordersFromEvents(orgId, eventIds) {
      const out: OnSendOrderRow[] = [];
      for (const part of chunks([...new Set(eventIds)], 100)) {
        const { data, error } = await client.from(
          "dispatch_supplier_order_emails",
        )
          .select(ORDER_ROW_SELECT)
          .eq("org_id", orgId)
          .in("source_business_event_id", part);
        if (error) failed("recorded orders read", error);
        out.push(...(data || []).map(orderRowOf));
      }
      return out;
    },

    async storedEventIds(eventIds) {
      const out = new Set<string>();
      for (const part of chunks([...new Set(eventIds)], 100)) {
        const { data, error } = await client.from("dispatch_v2_supplier_emails")
          .select("business_event_id")
          .in("business_event_id", part);
        if (error) failed("tray read", error);
        for (const r of data || []) out.add(String(r.business_event_id));
      }
      return out;
    },

    async sentOrdersOnJobs(orgId, jobIds) {
      const out: OnSendOrderRow[] = [];
      for (const part of chunks([...new Set(jobIds)], 100)) {
        const { data, error } = await client.from(
          "dispatch_supplier_order_emails",
        )
          .select(ORDER_ROW_SELECT)
          .eq("org_id", orgId)
          .in("status", ["sent", "send_unknown"])
          .in("job_id", part);
        if (error) failed("job orders read", error);
        out.push(...(data || []).map(orderRowOf));
      }
      return out;
    },

    async boxesOnJobs(orgId, jobIds) {
      const out: OnSendBox[] = [];
      for (const part of chunks([...new Set(jobIds)], 100)) {
        const { data, error } = await client.from("job_material_suppliers")
          .select("id, job_id, supplier_id, material_stage, material_stage_set_at")
          .eq("org_id", orgId)
          .in("job_id", part);
        if (error) failed("job boxes read", error);
        out.push(...(data || []).map((b: any) => ({
          box_id: String(b.id),
          job_id: String(b.job_id),
          supplier_id: String(b.supplier_id),
          material_stage: b.material_stage ?? null,
          material_stage_set_at: b.material_stage_set_at ?? null,
        })));
      }
      return out;
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

    async repliesOnJobs(orgId, jobIds) {
      const out: StoredReply[] = [];
      for (const part of chunks([...new Set(jobIds)], 100)) {
        const { data, error } = await client.from("dispatch_v2_supplier_emails")
          .select(REPLY_SELECT)
          .eq("org_id", orgId)
          .in("job_id", part)
          .limit(2000);
        if (error) failed("stored replies read", error);
        out.push(...(data || []).map((r: any) => ({
          id: String(r.id),
          job_id: r.job_id ?? null,
          order_id: r.order_id ?? null,
          state: String(r.state ?? ""),
          rung: r.rung ?? null,
          supplier_key: r.supplier_key ?? null,
          from_email: r.from_email ?? null,
          conversation_id: r.conversation_id ?? null,
          received_at: r.received_at ?? null,
          match_reason: r.match_reason ?? null,
          subject: String(r.subject ?? ""),
        })));
      }
      return out;
    },

    async recordOrder(input) {
      const { data, error } = await client.rpc(
        "dispatch_v2_record_outlook_order_on_send",
        { p: input },
      );
      if (error) failed("outlook order record", error);
      const r = data ?? {};
      return {
        recorded: r.recorded === true,
        order_id: r.order_id ? String(r.order_id) : null,
        box_id: r.box_id ? String(r.box_id) : null,
        box_created: r.box_created === true,
        reason: r.reason ?? null,
      };
    },

    async tieReply(orgId, replyId, orderId, matchReason, now) {
      const { data, error } = await client.from("dispatch_v2_supplier_emails")
        .update({ order_id: orderId, match_reason: matchReason, updated_at: now })
        .eq("org_id", orgId)
        .eq("id", replyId)
        .eq("state", "matched")
        .is("order_id", null)
        .select("id");
      if (error) failed("reply tie", error);
      return Array.isArray(data) && data.length > 0;
    },

    async sentOrdersSince() {
      const { data, error } = await client.from("dispatch_v2_reply_scan_state")
        .select("sent_orders_since")
        .eq("id", "default")
        .maybeSingle();
      if (error) failed("send rule start read", error);
      return data?.sent_orders_since ?? null;
    },

    async setSentOrdersSince(atIso) {
      const { error } = await client.from("dispatch_v2_reply_scan_state")
        .upsert({ id: "default", sent_orders_since: atIso }, {
          onConflict: "id",
        });
      if (error) failed("send rule start write", error);
    },
  };
}

// ── Recording the plans (shared by the scan and the catch-up) ─────────────

export type RecordedOrder = {
  plan: SentEmailPlan;
  order: PlannedOrder;
  supplier_id: string;
  result: RecordOnSendResult;
};

/** The order row input for one planned order. */
export function recordInputFor(
  orgId: string,
  plan: SentEmailPlan,
  order: PlannedOrder,
  supplierId: string,
  trigger: "send" | "catch_up",
): RecordOnSendInput | null {
  const e = plan.email;
  const job = plan.job!;
  const to = cleanAddresses(e.to);
  const cc = cleanAddresses(e.cc);
  const subject = e.subject.trim();
  if (to.length < 1 || to.length > 10 || cc.length > 12) return null;
  if (!subject || subject.length > 250 || !e.sent_at) return null;
  const workType = dispatchWorkType({
    type: job.type,
    ds_ses_family: job.ses_family,
    ds_makesafe_family: job.makesafe_family,
  }) ?? "other";
  return {
    org_id: orgId,
    job_id: job.job_id,
    supplier_id: supplierId,
    related_supplier_ids: [...new Set(order.entry.supplier_ids)],
    approved_email_id: order.entry.approved_id,
    trigger,
    work_type: workType,
    team_cc_email: dispatchV2TeamCc(workType).email,
    to_emails: to,
    cc_emails: cc,
    subject,
    body_text: order.parsed.body_text,
    delivery_date: order.parsed.delivery_date,
    order_lines: order.parsed.lines,
    standing_lines_included: order.parsed.lines.some((l) => l.standing),
    sent_at: e.sent_at,
    sent_by_email: emailAddressOf(e.sent_by_email) ?? emailAddressOf(e.mailbox),
    sent_from_mailbox: emailAddressOf(e.mailbox),
    sent_internet_message_id: e.internet_message_id,
    sent_conversation_id: e.conversation_id,
    source_business_event_id: e.business_event_id,
  };
}

/** Which Xero contact each planned order goes to (section 3f.1 rule 4: the
 * one boxed on the job, the only one, else the one last used). Null when it
 * cannot be told. */
export async function supplierIdsFor(
  store: OnSendStore,
  orgId: string,
  plans: SentEmailPlan[],
  boxes: OnSendBox[],
): Promise<Map<PlannedOrder, string | null>> {
  const out = new Map<PlannedOrder, string | null>();
  const needUsage = new Set<string>();
  for (const p of plans) {
    for (const o of p.orders) {
      if (o.entry.supplier_ids.length > 1) {
        o.entry.supplier_ids.forEach((id) => needUsage.add(id));
      }
    }
  }
  const usage = needUsage.size > 0
    ? await store.supplierUsage(orgId, [...needUsage])
    : [];
  for (const p of plans) {
    const boxed = boxes.filter((b) => b.job_id === p.job?.job_id)
      .map((b) => b.supplier_id);
    for (const o of p.orders) {
      out.set(o, pickSupplierId(o.entry.supplier_ids, boxed, usage));
    }
  }
  return out;
}

// ── The step the five-minute scan runs ────────────────────────────────────

// A sent email is read once it is two minutes old (the same lag as the
// reply scan), and only within the last seven days.
const SENT_LAG_MS = 2 * 60_000;
const SENT_WINDOW_MS = 7 * 86_400_000;
const SENT_LIMIT = 200;

export type SentPassCounts = {
  sent_read: number;
  sent_orders: number;
  sent_already: number;
  sent_ignored: number;
  sent_to_sort: number;
  sent_replies_tied: number;
  sent_failed: number;
};

export function zeroSentCounts(): SentPassCounts {
  return {
    sent_read: 0,
    sent_orders: 0,
    sent_already: 0,
    sent_ignored: 0,
    sent_to_sort: 0,
    sent_replies_tied: 0,
    sent_failed: 0,
  };
}

/** Record the orders sent from Outlook since the last runs. Runs at the
 * start of each reply scan, so an order is on Dispatch before its reply is
 * read. Never throws: a failed read or write is counted and the reply scan
 * carries on; the next run tries again (the window is seven days and every
 * write is once per email). */
/** The capture is read by when it stored an email, which can be long after
 * the email was sent: a re-run of the capture stores old mail again with a
 * new stored time. Only an email sent at or after `since` counts. */
export function sentAtOrAfter(email: CapturedSentEmail, since: string): boolean {
  const at = Date.parse(String(email.sent_at ?? ""));
  return Number.isFinite(at) && at >= Date.parse(since);
}

export async function scanSentOrderEmails(ctx: {
  orgId: string;
  store: OnSendStore;
  replies: RepliesStore;
  now: string;
}): Promise<SentPassCounts & { first_run?: boolean }> {
  const counts = zeroSentCounts();
  const { orgId, store, now } = ctx;
  try {
    const since = await store.sentOrdersSince();
    if (!since) {
      // First run: start from now. Older orders are for the catch-up, which
      // Shaun checks before it writes.
      await store.setSentOrdersSince(now);
      return { ...counts, first_run: true };
    }
    const nowAt = Date.parse(now);
    const from = new Date(
      Math.max(Date.parse(since), nowAt - SENT_WINDOW_MS),
    ).toISOString();
    const before = new Date(nowAt - SENT_LAG_MS).toISOString();
    if (from >= before) return counts;
    const read = await store.sentOrderEmails({
      since: from,
      before,
      limit: SENT_LIMIT,
    });
    counts.sent_read = read.length;
    // An old email stored again (sent before the rule started) is never an
    // order here: older orders are the catch-up's.
    const emails = read.filter((e) => sentAtOrAfter(e, since));
    counts.sent_ignored += read.length - emails.length;
    if (emails.length === 0) return counts;

    // Already handled: a row under Emails to sort, or an order recorded for
    // that email and supplier (an email to two suppliers is two orders, so it
    // is only done when both are).
    const ids = emails.map((e) => e.business_event_id);
    const recordedRows = await store.ordersFromEvents(orgId, ids);
    const sorted = await store.storedEventIds(ids);
    const toPlan = emails.filter((e) => !sorted.has(e.business_event_id));
    counts.sent_already = emails.length - toPlan.length;
    if (toPlan.length === 0) return counts;

    const { plans } = await planEmails(store, orgId, toPlan);
    const done = (plan: SentEmailPlan, order: PlannedOrder) =>
      recordedRows.some((r) =>
        r.source_business_event_id === plan.email.business_event_id &&
        !!r.supplier_id && order.entry.supplier_ids.includes(r.supplier_id)
      );
    const jobIds = [
      ...new Set(
        plans.filter((p) => p.verdict === "orders").map((p) => p.job!.job_id),
      ),
    ];
    const boxes = jobIds.length ? await store.boxesOnJobs(orgId, jobIds) : [];
    const supplierIds = await supplierIdsFor(store, orgId, plans, boxes);

    const recordedNow: RecordedOrder[] = [];
    for (const plan of plans) {
      if (plan.verdict === "ignored") {
        counts.sent_ignored++;
        continue;
      }
      if (plan.verdict === "refused") {
        if (await ctx.replies.insertEmail(trayRowFor(plan, orgId))) {
          counts.sent_to_sort++;
        }
        continue;
      }
      const open = plan.orders.filter((o) => !done(plan, o));
      if (open.length === 0) {
        counts.sent_already++;
        continue;
      }
      let failedHere = 0;
      for (const order of open) {
        const supplierId = supplierIds.get(order) ?? null;
        const input = supplierId
          ? recordInputFor(orgId, plan, order, supplierId, "send")
          : null;
        if (!input) {
          failedHere++;
          continue;
        }
        try {
          const result = await store.recordOrder(input);
          if (result.recorded) counts.sent_orders++;
          else if (result.reason === "already_recorded") counts.sent_already++;
          else counts.sent_ignored++;
          if (result.order_id) {
            recordedNow.push({ plan, order, supplier_id: supplierId!, result });
          }
        } catch (e) {
          console.error("[dispatch_v2_outlook_on_send] record failed:", e);
          failedHere++;
        }
      }
      counts.sent_failed += failedHere;
      // Part of the email went to a supplier with no Xero contact: once its
      // other orders are in, it also waits under Emails to sort. (The row
      // marks the email handled, so it is written only when nothing failed.)
      if (failedHere === 0 && plan.unlinked.length > 0) {
        if (await ctx.replies.insertEmail(trayRowFor(plan, orgId))) {
          counts.sent_to_sort++;
        }
      }
    }
    counts.sent_replies_tied += await tieRecordedReplies(
      store,
      orgId,
      recordedNow,
      now,
    );
  } catch (e) {
    console.error("[dispatch_v2_outlook_on_send] sent pass skipped:", e);
    counts.sent_failed++;
  }
  return counts;
}

/** Plan a batch of sent emails: reads the approved list, the named jobs and
 * any Dispatch sends with the same Outlook ids, then plans each email. */
export async function planEmails(
  store: OnSendStore,
  orgId: string,
  emails: CapturedSentEmail[],
): Promise<{ plans: SentEmailPlan[]; entries: OnSendEntry[] }> {
  const entries = await store.approvedEntries(orgId);
  const numbers = [
    ...new Set(
      emails.map((e) => readOrderSubject(e.subject))
        .filter((s): s is { kind: "order"; job_number: string } =>
          s.kind === "order"
        )
        .map((s) => s.job_number),
    ),
  ];
  const jobs = numbers.length ? await store.jobsByNumbers(orgId, numbers) : [];
  const jobsByNumber = new Map(
    jobs.filter((j) => j.job_number)
      .map((j) => [normaliseJobNumber(j.job_number), j]),
  );
  const dispatchSends = await store.dispatchSendsMatching(
    orgId,
    emails.map((e) => e.internet_message_id).filter((x): x is string => !!x),
    emails.map((e) => e.conversation_id).filter((x): x is string => !!x),
  );
  return {
    plans: emails.map((e) =>
      planSentOrderEmail(e, { jobsByNumber, entries, dispatchSends })
    ),
    entries,
  };
}

/** Tie the replies already stored to orders just recorded (a reply read
 * before its order was, for example in a run where the sent pass failed).
 * Returns how many were tied. */
export async function tieRecordedReplies(
  store: OnSendStore,
  orgId: string,
  recorded: RecordedOrder[],
  now: string,
): Promise<number> {
  if (recorded.length === 0) return 0;
  const jobIds = [...new Set(recorded.map((r) => r.plan.job!.job_id))];
  const replies = await store.repliesOnJobs(orgId, jobIds);
  const orders = await store.sentOrdersOnJobs(orgId, jobIds);
  let tied = 0;
  const seen = new Set<string>();
  for (const r of recorded) {
    const jobId = r.plan.job!.job_id;
    const key = `${jobId}|${r.order.entry.supplier_key}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sameSupplier = recorded.filter((x) =>
      x.plan.job!.job_id === jobId &&
      x.order.entry.supplier_key === r.order.entry.supplier_key
    );
    const tieable = new Set(sameSupplier.map((x) => x.result.order_id!));
    const supplierOrders = orders.filter((o) =>
      o.job_id === jobId && o.supplier_id &&
      r.order.entry.supplier_ids.includes(o.supplier_id)
    ).map((o) => ({
      order_id: o.order_id,
      sent_at: o.sent_at,
      sent_conversation_id: o.sent_conversation_id,
    }));
    for (const x of sameSupplier) {
      if (!supplierOrders.some((o) => o.order_id === x.result.order_id)) {
        supplierOrders.push({
          order_id: x.result.order_id!,
          sent_at: x.plan.email.sent_at,
          sent_conversation_id: x.plan.email.conversation_id,
        });
      }
    }
    for (
      const t of storedRepliesToTie(replies, {
        job_id: jobId,
        entry: r.order.entry,
        orders: supplierOrders,
        tieable,
      })
    ) {
      const reason = `${t.reply.match_reason ?? "Job number"}. ${
        outlookSendTieReason(t.order.sent_at)
      }`;
      if (await store.tieReply(orgId, t.reply.id, t.order.order_id, reason, now)) {
        tied++;
      }
    }
  }
  return tied;
}
