// deno-lint-ignore-file no-explicit-any
// Dispatch v2: the payment step on a supplier order. The rules, pure.
// Contract: docs/dispatch-v2-board-contract.md, section 3c.
//
// Shaun, 29 Oct 2026: when a supplier we have no account with comes back with
// a quote, the order waits on us to pay, and stays there until someone records
// in Dispatch that we paid.
//
// The rules, in business words:
//   * On account or pay first. Five suppliers are on account (Bunnings, Fence
//     Makers, Fencing Warehouse WA, R&R Fencing, Stratco WA). Every other
//     supplier pays first, including a box whose supplier is not linked to the
//     approved supplier list at all, so nothing slips past payment. The list
//     is kept in one place (dispatch_approved_supplier_emails.on_account).
//   * If the account list could not be read, the terms are "unknown" and
//     Dispatch behaves exactly as it did before the payment step (no payment
//     gate, no reply move). The read answer says so (reads.accounts).
//
// Nothing here reads or writes the database: the local preview stand-in
// imports this file as it is.

export type DispatchV2PaymentTerms = "on_account" | "pay_first" | "unknown";

/** A box's payment terms. `linked` = an active approved entry is linked to
 * the box's supplier; `onAccount` = that entry's on_account. */
export function dispatchV2PaymentTerms(input: {
  readOk: boolean;
  linked: boolean;
  onAccount: boolean | null;
}): DispatchV2PaymentTerms {
  if (!input.readOk) return "unknown";
  return input.linked && input.onAccount === true ? "on_account" : "pay_first";
}

// The account list as read: supplier id -> its linked approved entry (active
// or not). `readOk` false = the read failed, every box is "unknown".
export type DispatchV2Accounts = {
  readOk: boolean;
  bySupplier: Map<string, { active: boolean; on_account: boolean }>;
};

/** The account list from its two reads: the links (supplier_id ->
 * approved_id, one per Xero supplier) and the approved entries. Pass null for
 * either when its read failed. */
export function dispatchV2AccountsOf(
  links: any[] | null | undefined,
  entries: any[] | null | undefined,
): DispatchV2Accounts {
  const bySupplier = new Map<string, { active: boolean; on_account: boolean }>();
  if (!Array.isArray(links) || !Array.isArray(entries)) {
    return { readOk: false, bySupplier };
  }
  const byId = new Map<string, any>();
  for (const entry of entries) {
    if (entry?.id) byId.set(String(entry.id), entry);
  }
  for (const link of links) {
    const supplierId = String(link?.supplier_id ?? "");
    const entry = byId.get(String(link?.approved_id ?? ""));
    if (!supplierId || !entry) continue;
    bySupplier.set(supplierId, {
      active: entry.active === true,
      on_account: entry.on_account === true,
    });
  }
  return { readOk: true, bySupplier };
}

/** The terms for one supplier on the account list. A link to a retired
 * (inactive) entry counts as no link: pay first. Accounts left out = the
 * account list was not read: unknown. */
export function dispatchV2TermsFor(
  accounts: DispatchV2Accounts | null | undefined,
  supplierId: unknown,
): DispatchV2PaymentTerms {
  if (!accounts) return "unknown";
  const entry = accounts.bySupplier.get(String(supplierId ?? ""));
  return dispatchV2PaymentTerms({
    readOk: accounts.readOk,
    linked: !!entry && entry.active,
    onAccount: entry ? entry.on_account : null,
  });
}

// ── Paid for the current order ──────────────────────────────────────────────
//
//   * Mark paid is a record only: it pays nobody, touches no Xero and sends
//     nothing. It stamps who and when on the box (paid_at, paid_by_email,
//     migration 20261029120100_dispatch_v2_box_paid.sql).
//   * A paid stamp counts for the order it was marked against: only while it
//     is newer than the box's newest order email (a second order to the same
//     supplier reuses the box) and newer than the latest hand pick of
//     Awaiting payment (picking Awaiting payment by hand re-opens the
//     payment). The latest such pick is kept in payment_reopened_at, so a
//     later hand pick of another stage does not make the old stamp count
//     again. A stamp that no longer counts is kept on the box and shown as an
//     earlier order's.

export type DispatchV2PaymentInput = {
  terms: DispatchV2PaymentTerms;
  paidAt: unknown;
  paidByEmail: unknown;
  // The Pay on pickup / Pay on delivery tag (migration
  // 20261029120200_dispatch_v2_box_pay_on.sql). Left out = no tag.
  payOn?: unknown;
  payOnSetAt?: unknown;
  payOnSetByEmail?: unknown;
  // The box's newest sent order email (null = nothing sent yet).
  newestSentAt: unknown;
  // The stage a person picked on the box, and when.
  storedStage: unknown;
  storedStageAt: unknown;
  // When a person last picked Awaiting payment by hand (migration
  // 20261029120300_dispatch_v2_box_payment_reopened.sql). Left out = never.
  paymentReopenedAt?: unknown;
  // The stage the box finally shows (for blocks_job_move: a delivered box
  // never holds the job up). Left out = not delivered.
  materialStage?: string;
  // The payment gate is holding the box's stage (dispatchMaterialStageOf's
  // held_by_payment). Left out = not held.
  holdsStage?: boolean;
};

export type DispatchV2PayOn = "pickup" | "delivery";

export type DispatchV2Payment = {
  terms: DispatchV2PaymentTerms;
  // not_needed: on account and no tag. unpaid: pay first, nothing counts.
  // paid / pay_on_pickup / pay_on_delivery: that stamp counts for the current
  // order (paid wins when both count). unknown: the terms are unknown.
  state:
    | "not_needed"
    | "unpaid"
    | "paid"
    | "pay_on_pickup"
    | "pay_on_delivery"
    | "unknown";
  // A paid stamp counts for the current order.
  paid: boolean;
  // The counting stamp (null when none counts).
  paid_at: string | null;
  paid_by_email: string | null;
  // The Pay on tag, only while it counts for the current order.
  pay_on: DispatchV2PayOn | null;
  pay_on_set_at: string | null;
  pay_on_set_by_email: string | null;
  // A stamp on the box that belongs to an earlier order.
  earlier_order_paid_at: string | null;
  earlier_order_pay_on_set_at: string | null;
  // A confirmed date is saved but the payment gate holds the stage at
  // Awaiting payment.
  holds_stage: boolean;
  // Counts towards "a box on the job is unpaid": pay first, unpaid, not
  // delivered.
  blocks_job_move: boolean;
  // What the screen may offer on this box.
  can_mark_paid: boolean;
  can_undo_paid: boolean;
  // Pay on pickup / delivery can be set on any supplier box, on account too.
  can_set_pay_on: boolean;
  // The stored stamps the presses guard on (raw, null = never set).
  guard: { paid_at: string | null; pay_on_set_at: string | null };
};

/** A Pay on value from the box, or null for anything else. */
export function dispatchV2PayOnOf(value: unknown): DispatchV2PayOn | null {
  return value === "pickup" || value === "delivery" ? value : null;
}

function stampText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stampInstant(value: unknown): number | null {
  const s = stampText(value);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/** Whether a stamp made at `stampAt` counts for the box's current order:
 * newer than the newest send, and newer than the latest hand pick of
 * Awaiting payment (payment_reopened_at, or the stored pick when the box's
 * stored stage is still Awaiting payment, which covers a box re-opened
 * before the column existed). */
export function dispatchV2StampCounts(
  stampAt: unknown,
  input: Pick<
    DispatchV2PaymentInput,
    "newestSentAt" | "storedStage" | "storedStageAt" | "paymentReopenedAt"
  >,
): boolean {
  const at = stampInstant(stampAt);
  if (at === null) return false;
  const sentAt = stampInstant(input.newestSentAt);
  if (sentAt !== null && at <= sentAt) return false;
  const reopenedAt = stampInstant(input.paymentReopenedAt);
  if (reopenedAt !== null && at <= reopenedAt) return false;
  if (input.storedStage === "awaiting_payment") {
    const pickedAt = stampInstant(input.storedStageAt);
    if (pickedAt !== null && at <= pickedAt) return false;
  }
  return true;
}

// ── Supplier replies (contract section 3c, the reply step) ─────────────────
//
// A supplier reply that the reply scan (or a person in the tray) matched to
// the box's newest order moves a Sent box on by itself: to Awaiting payment
// on a pay-first box (the supplier is waiting on our money), to Quote
// received on an on-account box. Unknown terms never move a box.

/** The stage a matched reply moves a Sent box to, or null for no move. */
export function dispatchV2ReplyStage(
  terms: DispatchV2PaymentTerms,
): "awaiting_payment" | "quote_received" | null {
  if (terms === "pay_first") return "awaiting_payment";
  if (terms === "on_account") return "quote_received";
  return null;
}

// When a reply arrived: received_at, else when it was matched.
export function dispatchV2ReplyAt(reply: {
  received_at: unknown;
  matched_at: unknown;
}): string | null {
  return stampText(reply?.received_at) ?? stampText(reply?.matched_at);
}

/** Whether one reply is tied to the box's newest order: matched, naming
 * that order email, and arrived after it was sent. */
export function dispatchV2ReplyTiedToOrder(
  reply: {
    state: unknown;
    order_id: unknown;
    received_at: unknown;
    matched_at: unknown;
  },
  newestSent: { id: string | null; sent_at: string } | null,
): boolean {
  if (!reply || !newestSent?.id) return false;
  if (reply.state !== "matched") return false;
  if (String(reply.order_id ?? "") !== newestSent.id) return false;
  const at = stampInstant(dispatchV2ReplyAt(reply));
  const sentAt = stampInstant(newestSent.sent_at);
  return at !== null && sentAt !== null && at > sentAt;
}

/** The box's payment, by the rules above. */
export function dispatchV2PaymentOf(
  input: DispatchV2PaymentInput,
): DispatchV2Payment {
  const paidAt = stampText(input.paidAt);
  const paidByEmail = stampText(input.paidByEmail);
  const paid = !!paidAt && !!paidByEmail &&
    dispatchV2StampCounts(paidAt, input);
  const payOn = dispatchV2PayOnOf(input.payOn);
  const payOnSetAt = payOn ? stampText(input.payOnSetAt) : null;
  const payOnSetByEmail = payOn ? stampText(input.payOnSetByEmail) : null;
  const tagged = !!payOnSetAt && !!payOnSetByEmail &&
    dispatchV2StampCounts(payOnSetAt, input);
  let state: DispatchV2Payment["state"];
  if (paid) state = "paid";
  else if (tagged) state = payOn === "pickup" ? "pay_on_pickup" : "pay_on_delivery";
  else if (input.terms === "on_account") state = "not_needed";
  else if (input.terms === "pay_first") state = "unpaid";
  else state = "unknown";
  return {
    terms: input.terms,
    state,
    paid,
    paid_at: paid ? paidAt : null,
    paid_by_email: paid ? paidByEmail : null,
    pay_on: tagged ? payOn : null,
    pay_on_set_at: tagged ? payOnSetAt : null,
    pay_on_set_by_email: tagged ? payOnSetByEmail : null,
    earlier_order_paid_at: !paid && paidAt ? paidAt : null,
    earlier_order_pay_on_set_at: !tagged && payOnSetAt ? payOnSetAt : null,
    holds_stage: input.holdsStage === true,
    blocks_job_move: state === "unpaid" && input.materialStage !== "delivered",
    can_mark_paid: input.terms !== "on_account" && !paid,
    can_undo_paid: paid,
    can_set_pay_on: true,
    guard: {
      paid_at: paidAt,
      // The raw stored stamp, so a guard always matches what is on the box.
      pay_on_set_at: stampText(input.payOnSetAt),
    },
  };
}
