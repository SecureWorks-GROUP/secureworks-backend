// deno-lint-ignore-file no-explicit-any
// Dispatch v2: where each supplier order is at (the material stage). The
// rules, pure. Contract: docs/dispatch-v2-board-contract.md, section 3b.
//
// Shaun and Marnin, 27 Oct 2026: a job has its own stage (Order Materials
// through Scheduled, then In Progress and Rectification), and the materials
// have theirs. Every material stage says who it is waiting on, so the board
// can show what is waiting on us and what is waiting on a supplier.
//
// In v2 one supplier box (job_material_suppliers) is one supplier's orders on
// one job. A person can set the box's stage by hand (migration
// 20261028170000_dispatch_v2_material_stages.sql, the press in
// dispatch_v2_material_stage_write.ts). Until they do, or when something newer
// happens on the box, the stage is worked out from the box itself:
//
//   * Whatever happened last decides. The newest of: the stage a person set,
//     the newest order email sent from the box ("Sent to supplier"), and the
//     newest change to a line still not sent ("Order materials": there is
//     something new to order, for example a flashing on a job already on
//     site).
//   * A delivery date confirmed after that (typed and ticked, or accepted
//     from a supplier reply) lifts an earlier stage to "Order confirmed". It
//     never moves a later stage back. The payment gate (contract section 3c):
//     on a pay-first box with nothing paid, the date lifts it only as far as
//     "Awaiting payment". The date stays saved; the box shows it is held.
//   * A supplier reply matched to the box's newest order moves a Sent box on
//     by itself: "Awaiting payment" when we pay first, "Quote received" when
//     we are on account (only while the replies switch is on).
//   * An empty box with nothing sent is "Order materials".
//   * An "Order confirmed" box with no date for the current order (no date
//     of its own, none asked for in the newest order email) is waiting on
//     the supplier for a date, not on us to book the install.
//   * A pickup order (its newest order email says "for pickup") is "Picked
//     up" at its last stage instead of "Delivered", and at "Materials ready"
//     says "Materials ready to be picked up, Mon 2/11". A pickup on the
//     install's first day skips "Materials ready" (the crew collects it on
//     the way): the box says so (skips_ready) and the screen leaves that
//     stage out of the box's strip and picker.
//
// A purchase order with no box (a v1 Dispatch order or one made elsewhere) has
// no stage of its own: it is read from the order's status.
//
// ASAP or Pick a date (piece C): a sent order's mode is its newest order
// email's Date line ("Date: ASAP" = asap). Before anything is sent it is the
// box's own choice (order_date_mode); a box made before that column existed
// (NULL) reads as "date" when it or its open email has a date, else "asap".
//
// One function, dispatchV2BoxStage, turns a supplier box and its order
// emails into everything a box shows (the stage, who it waits on, the next
// step and the payment). The board (dispatch_board.ts) and the materials
// panel (dispatch_v2_store.ts) both call it, so the two can never disagree.
//
// Nothing here reads or writes the database: the local preview stand-in
// imports this file as it is.

import { isDispatchDeliveryDate } from "./dispatch_deliveries.ts";
import {
  type DispatchV2DateMode,
  dispatchV2DateModeOf,
  type DispatchV2Fulfilment,
  dispatchV2FulfilmentOf,
} from "./dispatch_v2_emails.ts";
import {
  type DispatchV2Payment,
  dispatchV2PaymentOf,
  type DispatchV2PaymentTerms,
  dispatchV2ReplyAt,
  dispatchV2ReplyStage,
  dispatchV2ReplyTiedToOrder,
} from "./dispatch_v2_payment.ts";

export type DispatchMaterialWaitingOn = "us" | "supplier" | "nobody";

export const DISPATCH_MATERIAL_STAGES = [
  { key: "order_materials", label: "Order materials" },
  { key: "sent", label: "Sent to supplier" },
  { key: "quote_received", label: "Quote received" },
  { key: "awaiting_payment", label: "Awaiting payment" },
  { key: "order_confirmed", label: "Order confirmed" },
  { key: "manufacturing", label: "Manufacturing" },
  { key: "ready", label: "Materials ready" },
  { key: "delivered", label: "Delivered" },
] as const;

export type DispatchMaterialStageKey =
  typeof DISPATCH_MATERIAL_STAGES[number]["key"];

const STAGE_KEYS: readonly string[] = DISPATCH_MATERIAL_STAGES.map((s) =>
  s.key
);

export function isDispatchMaterialStage(
  value: unknown,
): value is DispatchMaterialStageKey {
  return typeof value === "string" && STAGE_KEYS.includes(value);
}

export function dispatchMaterialStageLabel(key: string): string {
  return DISPATCH_MATERIAL_STAGES.find((s) => s.key === key)?.label || key;
}

// Position in the list, 0-based; -1 for an unknown key.
export function dispatchMaterialStageRank(key: string): number {
  return STAGE_KEYS.indexOf(key);
}

// What a supplier box knows about its current order, for the waiting on and
// next step lines (contract section 3c). Left out, the two functions below
// answer as they always have (a purchase order, an older caller).
export type DispatchMaterialStageContext = {
  // The box has a date for the current order: its own date, or the date the
  // newest order email asked for.
  hasDate: boolean;
  // Delivery or pickup, from the newest order email; null or left out = not
  // known (nothing sent yet).
  fulfilment?: DispatchV2Fulfilment | null;
  // That date (YYYY-MM-DD), for the pickup wording.
  date?: string | null;
};

// "Mon 2/11" for 2026-11-02: the short day the next-step lines use.
export function dispatchShortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
    new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  ];
  return `${weekday} ${d}/${m}`;
}

/** The stage's label on a box: "Picked up" instead of "Delivered" for a
 * pickup order; every other stage as listed. */
export function dispatchMaterialStageLabelFor(
  key: string,
  fulfilment?: DispatchV2Fulfilment | null,
): string {
  if (key === "delivered" && fulfilment === "pickup") return "Picked up";
  return dispatchMaterialStageLabel(key);
}

// Who the stage is waiting on. Order confirmed is ours until the install is
// booked (tell the client, book the crew), then the supplier's. An Order
// confirmed box with no date for the current order waits on the supplier for
// one: an install cannot be booked without it (rule 7).
export function dispatchMaterialWaitingOn(
  key: string,
  installBooked: boolean,
  context?: DispatchMaterialStageContext,
): DispatchMaterialWaitingOn {
  switch (key) {
    case "order_materials":
    case "quote_received":
    case "awaiting_payment":
    case "ready":
      return "us";
    case "order_confirmed":
      if (context && !context.hasDate) return "supplier";
      return installBooked ? "supplier" : "us";
    case "sent":
    case "manufacturing":
      return "supplier";
    default:
      return "nobody";
  }
}

// The one line the card and the box show: what needs doing next, in plain
// words. Null once delivered.
export function dispatchMaterialTodo(
  key: string,
  supplierName: string | null,
  installBooked: boolean,
  context?: DispatchMaterialStageContext,
): string | null {
  const s = supplierName || "the supplier";
  switch (key) {
    case "order_materials":
      return `Send the order to ${s}`;
    case "sent":
      return `Waiting on ${s} to reply`;
    case "quote_received":
      return `Check the quote from ${s}`;
    case "awaiting_payment":
      return `Pay ${s}`;
    case "order_confirmed":
      if (context && !context.hasDate) return `Waiting on ${s} for a date`;
      return installBooked
        ? `Waiting on ${s} for the materials`
        : "Book the install and tell the client";
    case "manufacturing":
      return `${s} is making it`;
    case "ready":
      if (context?.fulfilment === "pickup") {
        return context.date && isDispatchDeliveryDate(context.date)
          ? `Materials ready to be picked up, ${dispatchShortDay(context.date)}`
          : "Materials ready to be picked up";
      }
      if (context?.fulfilment === "delivery") {
        return `Arrange delivery from ${s}`;
      }
      return `Arrange delivery or pickup from ${s}`;
    default:
      return null;
  }
}

export type DispatchMaterialStageInput = {
  // The box's own stage and when a person set it (null = never set).
  stored: unknown;
  storedAt: unknown;
  // When each order email from this box was sent (status sent only).
  sentAts: unknown[];
  // When each line still to be ordered last changed: lines in the box with no
  // order email, no purchase order and not In stock.
  unsentLineChanges: unknown[];
  // When the box's delivery date was confirmed (null = not confirmed).
  confirmedAt: unknown;
  // The payment step (dispatch_v2_payment.ts, contract section 3c). Every
  // one is optional: a caller that passes none gets exactly the rule above.
  // The box's terms; left out = unknown.
  terms?: DispatchV2PaymentTerms;
  // The box's payment (dispatchV2PaymentOf), for the payment step.
  payment?: DispatchV2Payment | null;
  // The reply step (contract section 3c): the box's newest sent order email
  // and the job's matched supplier replies (dispatch_v2_supplier_emails rows:
  // id, state, order_id, received_at, matched_at, rung). Left out = no
  // replies read, no reply moves.
  newestSent?: { id: string | null; sent_at: string } | null;
  replies?: any[] | null;
};

// The supplier reply that moved a box (source "reply").
export type DispatchMaterialStageReply = {
  email_id: string;
  received_at: string | null;
  rung: string | null;
};

export type DispatchMaterialStageShown = {
  key: DispatchMaterialStageKey;
  // set = a person chose it and nothing newer happened; worked_out = read
  // from the box; payment = moved by Mark paid or Pay on; reply = moved by a
  // matched supplier reply (contract section 3c).
  source: "set" | "worked_out" | "payment" | "reply";
  // A confirmed date would have lifted the box to Order confirmed, but the
  // payment gate holds it at Awaiting payment. Present only when the caller
  // passed terms or payment, so a caller of the old rule gets the old shape.
  held_by_payment?: boolean;
  // The reply that moved the box; null unless source is "reply". Present
  // only when the caller passed replies.
  reply?: DispatchMaterialStageReply | null;
};

// One candidate for the stage: what it is, the moment it happened and why.
type StageCandidate = {
  at: number;
  key: DispatchMaterialStageKey;
  source: DispatchMaterialStageShown["source"];
  reply?: DispatchMaterialStageReply;
};

function instant(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function newest(values: unknown[] | null | undefined): number | null {
  let best: number | null = null;
  for (const v of values || []) {
    const ms = instant(v);
    if (ms !== null && (best === null || ms > best)) best = ms;
  }
  return best;
}

// Step 1: whatever happened last. Each candidate with the moment it
// happened; on the same moment a stage a person set wins, then a send, then a
// line change.
function lastThingThatHappened(
  input: DispatchMaterialStageInput,
): StageCandidate {
  const candidates: StageCandidate[] = [];
  const storedAt = instant(input.storedAt);
  if (isDispatchMaterialStage(input.stored) && storedAt !== null) {
    candidates.push({ at: storedAt, key: input.stored, source: "set" });
  }
  const sentAt = newest(input.sentAts);
  if (sentAt !== null) {
    candidates.push({ at: sentAt, key: "sent", source: "worked_out" });
  }
  const lineAt = newest(input.unsentLineChanges);
  if (lineAt !== null) {
    candidates.push({
      at: lineAt,
      key: "order_materials",
      source: "worked_out",
    });
  }
  let shown: StageCandidate = {
    at: -Infinity,
    key: "order_materials",
    source: "worked_out",
  };
  for (const c of candidates) {
    if (c.at > shown.at) shown = c;
  }
  return shown;
}

// Step 2, the payment step (contract section 3c): a paid stamp or a Pay on
// tag that counts for the current order is one more candidate, at its stamp
// time (the newer one when both count): Order confirmed. The newest still
// wins, so a person's later pick beats it, and on the same moment the earlier
// steps win. Forward only: a box already at Order confirmed or past it stays
// where it is (Mark paid pressed on the day of pickup never pulls a box back
// from Materials ready).
function paymentStep(
  shown: StageCandidate,
  payment: DispatchV2Payment | null | undefined,
): StageCandidate {
  if (!payment) return shown;
  if (
    dispatchMaterialStageRank(shown.key) >=
      dispatchMaterialStageRank("order_confirmed")
  ) {
    return shown;
  }
  const at = newest([payment.paid_at, payment.pay_on_set_at]);
  if (at === null || at <= shown.at) return shown;
  return { at, key: "order_confirmed", source: "payment" };
}

// Step 3, the reply step (contract section 3c): a Sent box with nothing paid
// or tagged, and a reply tied to its newest order that arrived after the
// moment it was sent, moves on by itself: Awaiting payment (pay first) or
// Quote received (on account). The earliest such reply is the one named.
// Never from any other stage (forward only), never with unknown terms. A date
// confirmed after the send but before the reply came in already says more
// than the reply does, so the date lift (step 4) decides instead: a later
// reply never pulls an on-account box back from Order confirmed to Quote
// received.
function replyStep(
  shown: StageCandidate,
  input: DispatchMaterialStageInput,
): StageCandidate {
  if (shown.key !== "sent") return shown;
  const payment = input.payment;
  if (payment && (payment.paid || payment.pay_on)) return shown;
  const target = dispatchV2ReplyStage(
    input.terms ?? payment?.terms ?? "unknown",
  );
  if (!target) return shown;
  let earliest: { at: number; reply: any } | null = null;
  for (const reply of input.replies || []) {
    if (!dispatchV2ReplyTiedToOrder(reply, input.newestSent ?? null)) continue;
    const at = instant(dispatchV2ReplyAt(reply));
    if (at === null || at <= shown.at) continue;
    if (!earliest || at < earliest.at) earliest = { at, reply };
  }
  if (!earliest) return shown;
  const confirmedAt = instant(input.confirmedAt);
  if (
    confirmedAt !== null && confirmedAt > shown.at && confirmedAt < earliest.at
  ) {
    return shown;
  }
  return {
    at: earliest.at,
    key: target,
    source: "reply",
    reply: {
      email_id: String(earliest.reply.id),
      received_at: dispatchV2ReplyAt(earliest.reply),
      rung: typeof earliest.reply.rung === "string" ? earliest.reply.rung : null,
    },
  };
}

// Whether the payment gate applies: a pay-first box with no paid stamp or
// Pay on tag counting for the current order.
function gatedByPayment(input: DispatchMaterialStageInput): boolean {
  if (input.payment) return input.payment.state === "unpaid";
  return input.terms === "pay_first";
}

// Step 4, the date lift with the payment gate. A confirmed date newer than
// the winner lifts an earlier stage to Order confirmed; gated, only as far as
// Awaiting payment.
function dateLift(
  shown: StageCandidate,
  input: DispatchMaterialStageInput,
): StageCandidate & { held: boolean } {
  const confirmedAt = instant(input.confirmedAt);
  const lifts = confirmedAt !== null && confirmedAt > shown.at &&
    dispatchMaterialStageRank(shown.key) <
      dispatchMaterialStageRank("order_confirmed");
  if (!lifts) return { ...shown, held: false };
  if (!gatedByPayment(input)) {
    return {
      at: confirmedAt,
      key: "order_confirmed",
      source: "worked_out",
      held: false,
    };
  }
  if (
    dispatchMaterialStageRank(shown.key) <
      dispatchMaterialStageRank("awaiting_payment")
  ) {
    return {
      at: confirmedAt,
      key: "awaiting_payment",
      source: "worked_out",
      held: true,
    };
  }
  return { ...shown, held: true };
}

/** The stage a supplier box shows, by the rules at the top of this file. */
export function dispatchMaterialStageOf(
  input: DispatchMaterialStageInput,
): DispatchMaterialStageShown {
  let shown = lastThingThatHappened(input);
  shown = paymentStep(shown, input.payment);
  shown = replyStep(shown, input);
  const lifted = dateLift(shown, input);
  const answer: DispatchMaterialStageShown = {
    key: lifted.key,
    source: lifted.source,
  };
  if (input.terms !== undefined || input.payment != null) {
    answer.held_by_payment = lifted.held;
  }
  if (input.replies !== undefined) {
    answer.reply = lifted.source === "reply" ? lifted.reply ?? null : null;
  }
  return answer;
}

// A purchase order's stage, from its status (a v1 Dispatch order or one made
// elsewhere, with no supplier box).
export function dispatchPoMaterialStage(
  status: unknown,
): DispatchMaterialStageKey {
  switch (String(status ?? "").trim().toLowerCase()) {
    case "sent":
    case "submitted":
    case "authorised":
    case "acked":
      return "sent";
    case "confirmed":
      return "order_confirmed";
    case "delivered":
    case "billed":
      return "delivered";
    default:
      return "order_materials";
  }
}

// Lines in a box still to be ordered: no order email, no purchase order and
// not In stock (the same lines Make email builds from).
export function dispatchUnsentLineChanges(
  lines: any[] | null | undefined,
  supplierId: string,
): string[] {
  const out: string[] = [];
  for (const line of lines || []) {
    if (String(line?.supplier_id ?? "") !== supplierId) continue;
    if (line?.status === "in_stock") continue;
    if (line?.dispatch_order_email_id || line?.purchase_order_id) continue;
    const at = typeof line?.updated_at === "string" && line.updated_at
      ? line.updated_at
      : typeof line?.created_at === "string"
      ? line.created_at
      : null;
    // A line with no time at all still counts, as the oldest possible change.
    out.push(at || "1970-01-01T00:00:00.000Z");
  }
  return out;
}

// ── One supplier box, as the board and the materials panel show it ─────────

export type DispatchV2BoxStageInput = {
  // The job_material_suppliers row (the columns the readers select).
  box: any;
  // The box's order emails. Only status "sent" ones count as sent.
  emails: any[] | null | undefined;
  // The job's material lines (only this box's supplier's are used).
  lines: any[] | null | undefined;
  // The box's payment terms (dispatch_v2_payment.ts); left out = unknown.
  terms?: DispatchV2PaymentTerms;
  // The install day the board shows (null = no install booked).
  installDay?: string | null;
  // The install's first day, for skips_ready; left out = installDay.
  installFirstDay?: string | null;
  // The box's open (not sent) order email, when the caller read it (the
  // materials panel); for a NULL date mode only.
  openEmail?: any | null;
  // The job's matched supplier replies (the reply step); left out or null =
  // not read, no reply moves.
  replies?: any[] | null;
};

export type DispatchV2BoxNewestSent = {
  // The order email's id (what a supplier reply's order_id names); null only
  // for a row read without its id.
  id: string | null;
  sent_at: string;
  // The date that email asked for (its Date: line), if any.
  requested_date: string | null;
  // Delivery or pickup, from that email's opening line.
  fulfilment: DispatchV2Fulfilment;
  // ASAP or Pick a date, from that email's Date line.
  date_mode: DispatchV2DateMode;
};

export type DispatchV2BoxStage = {
  key: DispatchMaterialStageKey;
  label: string;
  source: DispatchMaterialStageShown["source"];
  // Who set the stage, when a person did (source "set"); else null.
  set_at: string | null;
  set_by_email: string | null;
  // The box's newest sent order email, null when none went.
  newest_sent: DispatchV2BoxNewestSent | null;
  // The box's own delivery date for the current order: a date set before the
  // newest send belongs to an earlier order, so it is left out (null).
  box_date: string | null;
  box_date_confirmed: boolean;
  // Lines still to be ordered and when each last changed.
  unsent_line_changes: string[];
  waiting_on: DispatchMaterialWaitingOn;
  todo: string | null;
  // A confirmed date is saved but the payment gate holds the stage at
  // Awaiting payment.
  held_by_payment: boolean;
  // The supplier reply that moved the box; null unless source is "reply".
  reply: DispatchMaterialStageReply | null;
  // A pickup whose date (own or asked for) is the install's first day: the
  // crew collects it on the way, so the screen leaves "Materials ready" out
  // of this box's strip and picker.
  skips_ready: boolean;
  // ASAP or Pick a date (dispatchV2BoxDateMode); derived = the box's own
  // choice is NULL (made before piece C) and the mode was worked out.
  date_mode: DispatchV2DateMode;
  date_mode_derived: boolean;
  // The payment step (dispatch_v2_payment.ts).
  payment: DispatchV2Payment;
};

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** ASAP or Pick a date for one supplier box (contract section 3c, rule 10).
 * A sent order: its newest order email's Date line. Else the box's own
 * choice. A NULL choice (a box made before piece C): "date" when the box or
 * its open email has a date, else "asap"; derived is then true. */
export function dispatchV2BoxDateMode(input: {
  stored: unknown;
  // The box has a date of its own for the current order.
  boxHasDate: boolean;
  newestSent: Pick<DispatchV2BoxNewestSent, "date_mode"> | null;
  // The open order email (delivery_date, body_text), when read.
  openEmail?: any | null;
}): { mode: DispatchV2DateMode; derived: boolean } {
  const stored = input.stored === "asap" || input.stored === "date"
    ? input.stored as DispatchV2DateMode
    : null;
  if (input.newestSent) {
    return { mode: input.newestSent.date_mode, derived: stored === null };
  }
  if (stored) return { mode: stored, derived: false };
  const open = input.openEmail;
  const openHasDate = !!open && (
    isDispatchDeliveryDate(open.delivery_date) ||
    (typeof open.body_text === "string" &&
      dispatchV2DateModeOf(open.body_text) === "date" &&
      /^Date:[ \t]*\S/im.test(open.body_text))
  );
  return {
    mode: input.boxHasDate || openHasDate ? "date" : "asap",
    derived: true,
  };
}

/** The box's newest sent order email (status sent, newest sent_at). */
export function dispatchV2NewestSent(
  emails: any[] | null | undefined,
): DispatchV2BoxNewestSent | null {
  let best: any = null;
  let bestAt: number | null = null;
  for (const email of emails || []) {
    if (String(email?.status ?? "").trim().toLowerCase() !== "sent") continue;
    const at = instant(email?.sent_at);
    if (at === null) continue;
    if (bestAt === null || at > bestAt) {
      best = email;
      bestAt = at;
    }
  }
  if (!best) return null;
  return {
    id: best.id ? String(best.id) : null,
    sent_at: String(best.sent_at),
    requested_date: isDispatchDeliveryDate(best.delivery_date)
      ? best.delivery_date
      : null,
    fulfilment: dispatchV2FulfilmentOf(best.body_text),
    date_mode: dispatchV2DateModeOf(best.body_text),
  };
}

/** Everything one supplier box shows, by the rules at the top of this file.
 * The board's Arrival line and the materials panel both call this. */
export function dispatchV2BoxStage(
  input: DispatchV2BoxStageInput,
): DispatchV2BoxStage {
  const box = input.box || {};
  const supplierId = String(box.supplier_id ?? "");
  const emails = (input.emails || []).filter((e: any) =>
    String(e?.supplier_id ?? supplierId) === supplierId
  );
  const sentAts = emails
    .filter((e: any) =>
      String(e?.status ?? "").trim().toLowerCase() === "sent"
    )
    .map((e: any) => e?.sent_at)
    .filter((at: unknown): at is string => instant(at) !== null);
  const newestSent = dispatchV2NewestSent(emails);
  // A box date set before the newest send belongs to an earlier order.
  const dateSetAt = instant(box.delivery_date_set_at);
  const dateOlderThanSend = !!newestSent && dateSetAt !== null &&
    (instant(newestSent.sent_at) as number) > dateSetAt;
  const boxDate = isDispatchDeliveryDate(box.delivery_date) &&
      !dateOlderThanSend
    ? box.delivery_date as string
    : null;
  const unsent = dispatchUnsentLineChanges(input.lines, supplierId);
  const terms: DispatchV2PaymentTerms = input.terms ?? "unknown";
  const paymentInput = {
    terms,
    paidAt: box.paid_at,
    paidByEmail: box.paid_by_email,
    payOn: box.pay_on,
    payOnSetAt: box.pay_on_set_at,
    payOnSetByEmail: box.pay_on_set_by_email,
    newestSentAt: newestSent?.sent_at ?? null,
    storedStage: box.material_stage,
    storedStageAt: box.material_stage_set_at,
  };
  const shown = dispatchMaterialStageOf({
    stored: box.material_stage,
    storedAt: box.material_stage_set_at,
    sentAts,
    unsentLineChanges: unsent,
    confirmedAt: boxDate ? box.delivery_date_confirmed_at : null,
    terms,
    payment: dispatchV2PaymentOf(paymentInput),
    newestSent,
    replies: input.replies || [],
  });
  const installBooked = !!input.installDay;
  const supplierName = textOrNull(box.supplier_name);
  const set = shown.source === "set";
  // Rule 7: a date for the current order is the box's own date or the date
  // the newest order email asked for.
  const date = boxDate || newestSent?.requested_date || null;
  const fulfilment = newestSent?.fulfilment ?? null;
  const context: DispatchMaterialStageContext = {
    hasDate: !!date,
    fulfilment,
    date,
  };
  const firstDay = input.installFirstDay !== undefined
    ? input.installFirstDay
    : input.installDay;
  const dateMode = dispatchV2BoxDateMode({
    stored: box.order_date_mode,
    boxHasDate: !!boxDate,
    newestSent,
    openEmail: input.openEmail,
  });
  return {
    key: shown.key,
    label: dispatchMaterialStageLabelFor(shown.key, fulfilment),
    source: shown.source,
    set_at: set ? textOrNull(box.material_stage_set_at) : null,
    set_by_email: set ? textOrNull(box.material_stage_set_by_email) : null,
    newest_sent: newestSent,
    box_date: boxDate,
    box_date_confirmed: !!boxDate && !!box.delivery_date_confirmed_at,
    unsent_line_changes: unsent,
    waiting_on: dispatchMaterialWaitingOn(shown.key, installBooked, context),
    todo: dispatchMaterialTodo(shown.key, supplierName, installBooked, context),
    held_by_payment: shown.held_by_payment === true,
    reply: shown.reply ?? null,
    skips_ready: fulfilment === "pickup" && !!date && !!firstDay &&
      date === firstDay,
    date_mode: dateMode.mode,
    date_mode_derived: dateMode.derived,
    // Worked out again with the stage shown, so a delivered box never holds
    // the job up, and with whether the gate is holding the stage.
    payment: dispatchV2PaymentOf({
      ...paymentInput,
      materialStage: shown.key,
      holdsStage: shown.held_by_payment === true,
    }),
  };
}
