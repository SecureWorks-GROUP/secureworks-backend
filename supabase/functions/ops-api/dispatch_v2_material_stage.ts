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
//     never moves a later stage back.
//   * An empty box with nothing sent is "Order materials".
//
// A purchase order with no box (a v1 Dispatch order or one made elsewhere) has
// no stage of its own: it is read from the order's status.
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
  type DispatchV2Fulfilment,
  dispatchV2FulfilmentOf,
} from "./dispatch_v2_emails.ts";
import {
  type DispatchV2Payment,
  dispatchV2PaymentOf,
  type DispatchV2PaymentTerms,
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

// Who the stage is waiting on. Order confirmed is ours until the install is
// booked (tell the client, book the crew), then the supplier's.
export function dispatchMaterialWaitingOn(
  key: string,
  installBooked: boolean,
): DispatchMaterialWaitingOn {
  switch (key) {
    case "order_materials":
    case "quote_received":
    case "awaiting_payment":
    case "ready":
      return "us";
    case "order_confirmed":
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
      return installBooked
        ? `Waiting on ${s} for the materials`
        : "Book the install and tell the client";
    case "manufacturing":
      return `${s} is making it`;
    case "ready":
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
};

export type DispatchMaterialStageShown = {
  key: DispatchMaterialStageKey;
  // set = a person chose it and nothing newer happened; worked_out = read
  // from the box; payment = moved by Mark paid (contract section 3c).
  source: "set" | "worked_out" | "payment";
};

// One candidate for the stage: what it is, the moment it happened and why.
type StageCandidate = {
  at: number;
  key: DispatchMaterialStageKey;
  source: DispatchMaterialStageShown["source"];
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

// Step 2, the payment step (contract section 3c): a paid stamp that counts
// for the current order is one more candidate, at its stamp time: Order
// confirmed. The newest still wins, so a person's later pick beats it, and
// on the same moment the earlier steps win.
function paymentStep(
  shown: StageCandidate,
  payment: DispatchV2Payment | null | undefined,
): StageCandidate {
  if (!payment?.paid) return shown;
  const at = instant(payment.paid_at);
  if (at === null || at <= shown.at) return shown;
  return { at, key: "order_confirmed", source: "payment" };
}

/** The stage a supplier box shows, by the rules at the top of this file. */
export function dispatchMaterialStageOf(
  input: DispatchMaterialStageInput,
): DispatchMaterialStageShown {
  let shown = lastThingThatHappened(input);
  shown = paymentStep(shown, input.payment);
  const confirmedAt = instant(input.confirmedAt);
  if (
    confirmedAt !== null && confirmedAt > shown.at &&
    dispatchMaterialStageRank(shown.key) <
      dispatchMaterialStageRank("order_confirmed")
  ) {
    return { key: "order_confirmed", source: "worked_out" };
  }
  return { key: shown.key, source: shown.source };
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
  // The payment step (dispatch_v2_payment.ts).
  payment: DispatchV2Payment;
};

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
  });
  const installBooked = !!input.installDay;
  const supplierName = textOrNull(box.supplier_name);
  const set = shown.source === "set";
  return {
    key: shown.key,
    label: dispatchMaterialStageLabel(shown.key),
    source: shown.source,
    set_at: set ? textOrNull(box.material_stage_set_at) : null,
    set_by_email: set ? textOrNull(box.material_stage_set_by_email) : null,
    newest_sent: newestSent,
    box_date: boxDate,
    box_date_confirmed: !!boxDate && !!box.delivery_date_confirmed_at,
    unsent_line_changes: unsent,
    waiting_on: dispatchMaterialWaitingOn(shown.key, installBooked),
    todo: dispatchMaterialTodo(shown.key, supplierName, installBooked),
    // Worked out again with the stage shown, so a delivered box never holds
    // the job up.
    payment: dispatchV2PaymentOf({ ...paymentInput, materialStage: shown.key }),
  };
}
