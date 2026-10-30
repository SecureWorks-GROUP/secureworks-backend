// deno-lint-ignore-file no-explicit-any
// Dispatch v2: the payment step's presses on a supplier order. Contract:
// docs/dispatch-v2-board-contract.md, section 3c.5. The rules for what a box
// shows: dispatch_v2_payment.ts and dispatch_v2_material_stage.ts.
//
// Shaun, 29 Oct 2026: a supplier we have no account with waits on our money.
// Someone records in Dispatch that we paid, and the order moves on.
//
// The presses, in business words:
//   * Mark paid is a record only. It pays nobody, touches no Xero and sends
//     nothing. It stamps who and when on the box, and the box shows Order
//     confirmed. A box already paid for the current order is left as it is.
//     A supplier on account has no payment step: refused (409 on_account).
//     A box with no sent order is refused (409 order_not_sent): there is no
//     order to pay for yet.
//   * Undo paid takes the stamp off. The box then shows what it would have
//     shown without it (usually Awaiting payment).
//   * Pay on pickup / Pay on delivery confirms the order without paying: the
//     box shows Order confirmed exactly as Mark paid would, with a visible
//     tag. Allowed on any box, on account included, once its order is sent
//     (409 order_not_sent before). Set to null it comes off, at any time.
//     Mark paid can still be pressed later; both stamps are kept.
//
// What this touches: one job_material_suppliers row (the paid columns only)
// and one job_events row (the audit line) per press. Never jobs, suppliers,
// purchase_orders, the order emails, the reply tables, Xero, GHL, SMS or any
// email. job_status_changed is always false.
//
// PostgREST returns errors, it does not throw: every read and write below
// reads `error`.

import {
  type DispatchMaterialsActor,
  DispatchMaterialsError,
} from "./dispatch_materials_store.ts";
import { isDispatchUuid } from "./dispatch_materials.ts";
import { dispatchWorkType } from "./dispatch_job_list.ts";
import {
  DISPATCH_BOARD_WORK_TYPES,
  DispatchArrivalError,
  dispatchArrivalRead,
} from "./dispatch_board.ts";

export const DISPATCH_V2_MARK_PAID_ACTION = "dispatch_v2_mark_paid";
export const DISPATCH_V2_UNDO_PAID_ACTION = "dispatch_v2_undo_paid";
export const DISPATCH_V2_SET_PAY_ON_ACTION = "dispatch_v2_set_pay_on";
export const DISPATCH_V2_PAYMENT_ACTIONS = [
  DISPATCH_V2_MARK_PAID_ACTION,
  DISPATCH_V2_UNDO_PAID_ACTION,
  DISPATCH_V2_SET_PAY_ON_ACTION,
] as const;

export type DispatchV2PaymentContext = {
  orgId: string;
  actor: DispatchMaterialsActor;
  // 'screen' for a signed-in session, 'terminal' for the ops key.
  via: "screen" | "terminal";
  // Today in Perth (YYYY-MM-DD), for the Arrival line in the answer.
  today: string;
  now?: () => string;
};

const BOX_SELECT =
  "id, org_id, job_id, supplier_id, supplier_name, material_stage, material_stage_set_at, paid_at, paid_by, paid_by_email, pay_on, pay_on_set_at, pay_on_set_by, pay_on_set_by_email";
const JOB_SELECT =
  "id, org_id, type, status, job_number, ds_ses_family:metadata->>ses_family, ds_makesafe_family:metadata->>makesafe_job_family, ds_repair_stage:metadata->>repair_stage";

type Operator = { userId: string | null; email: string };

function refuse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new DispatchMaterialsError(status, code, message, extra);
}

function badRequest(message: string): never {
  refuse(400, "invalid_request", message);
}

function readFailed(label: string, error: any): never {
  console.error(`[dispatch_v2_payment] ${label} failed:`, error);
  refuse(500, "dispatch_read_failed", `${label} failed`);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sameInstant(a: unknown, b: unknown): boolean {
  const x = text(a);
  const y = text(b);
  if (!x || !y) return !x && !y;
  return Date.parse(x) === Date.parse(y);
}

// A guard the screen sends back: the stamp as it showed it (null = none).
// Left out = no guard. Anything else is a bad request.
function readGuard(body: any, name: string, required: boolean) {
  if (!(name in body)) {
    if (required) badRequest(`${name} is required`);
    return undefined;
  }
  const g = body[name];
  if (
    g !== null && (typeof g !== "string" || !Number.isFinite(Date.parse(g)))
  ) {
    badRequest(`${name} must be a timestamp or null`);
  }
  return g as string | null;
}

// Every press names a person: the signed-in user, or for the ops key the
// operator_email in the body matching a row in users (as the stage press).
async function resolveOperator(
  client: any,
  body: any,
  ctx: DispatchV2PaymentContext,
): Promise<Operator> {
  if (ctx.via === "screen") {
    if (!ctx.actor.userId || !ctx.actor.email) {
      refuse(400, "operator_required", "A named person is required");
    }
    return { userId: ctx.actor.userId, email: ctx.actor.email };
  }
  const raw = typeof body?.operator_email === "string"
    ? body.operator_email.trim()
    : "";
  if (!raw) {
    refuse(
      400,
      "operator_required",
      "operator_email naming a person is required",
    );
  }
  const { data, error } = await client.from("users")
    .select("id, email, org_id")
    .eq("org_id", ctx.orgId)
    .in("email", [...new Set([raw, raw.toLowerCase()])]);
  if (error) readFailed("operator read", error);
  const match = (data || []).find((u: any) =>
    String(u.email || "").toLowerCase() === raw.toLowerCase()
  );
  if (!match) {
    refuse(
      400,
      "operator_required",
      "operator_email does not name a person in users",
    );
  }
  return { userId: null, email: String(match.email) };
}

// The box, by box_id, or by job_id and supplier_id (one box per supplier per
// job). Another organisation's box is not found.
async function loadBox(client: any, body: any, ctx: DispatchV2PaymentContext) {
  const boxId = body?.box_id;
  const jobId = body?.job_id ?? body?.jobId;
  const supplierId = body?.supplier_id;
  let query = client.from("job_material_suppliers").select(BOX_SELECT)
    .eq("org_id", ctx.orgId);
  if (boxId !== undefined && boxId !== null) {
    if (!isDispatchUuid(boxId)) badRequest("box_id must be a uuid");
    query = query.eq("id", boxId);
  } else {
    if (!isDispatchUuid(jobId) || !isDispatchUuid(supplierId)) {
      badRequest("box_id required (or job_id and supplier_id)");
    }
    query = query.eq("job_id", jobId).eq("supplier_id", supplierId);
  }
  const { data, error } = await query.maybeSingle();
  if (error) readFailed("supplier box read", error);
  if (
    !data || String(data.org_id || "") !== ctx.orgId ||
    (ctx.actor.orgId && String(data.org_id || "") !== ctx.actor.orgId)
  ) {
    refuse(404, "box_not_found", "That supplier order is not on the job");
  }
  return data;
}

async function loadJob(client: any, jobId: string, ctx: DispatchV2PaymentContext) {
  const { data, error } = await client.from("jobs")
    .select(JOB_SELECT)
    .eq("id", jobId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (error) readFailed("job read", error);
  if (!data) {
    refuse(404, "box_not_found", "That supplier order is not on the job");
  }
  if (!DISPATCH_BOARD_WORK_TYPES.includes(dispatchWorkType(data))) {
    refuse(409, "not_dispatch_work", "This job is not Dispatch work");
  }
  return data;
}

// The job's Arrival line, as dispatch_arrival answers it. null when the read
// failed (it never undoes a write that already landed).
async function arrivalOf(
  client: any,
  jobId: string,
  ctx: DispatchV2PaymentContext,
) {
  try {
    return await dispatchArrivalRead(client, jobId, ctx.orgId, ctx.today);
  } catch (e) {
    console.error(
      "[dispatch_v2_payment] arrival read failed:",
      e instanceof DispatchArrivalError ? e.body : e,
    );
    return null;
  }
}

// This box's entry on an Arrival answer, or null.
function entryFor(arrival: any, boxId: string) {
  const orders = arrival?.arrival?.orders;
  if (!Array.isArray(orders)) return null;
  return orders.find((o: any) => String(o?.box_id ?? "") === boxId) ?? null;
}

// What a press needs to know before it writes: the box as the board shows it
// (stage and payment, by the same rules), with the account list read. A press
// never guesses: if the Arrival line or the account list could not be read it
// is refused. Pay on does not depend on the terms, so it can skip the
// account list check (needTerms false).
async function boxAsShown(
  client: any,
  box: any,
  ctx: DispatchV2PaymentContext,
  needTerms = true,
) {
  const arrival = await arrivalOf(client, String(box.job_id), ctx);
  if (!arrival || arrival.arrival_read !== "ok") {
    refuse(500, "dispatch_read_failed", "Arrival read failed");
  }
  if (needTerms && arrival.accounts_read !== "ok") {
    refuse(500, "dispatch_read_failed", "account list read failed");
  }
  const entry = entryFor(arrival, String(box.id));
  if (!entry || !entry.payment) {
    refuse(500, "dispatch_read_failed", "supplier box read failed");
  }
  return { arrival, entry };
}

// Mark paid and Pay on need a sent order for the box: with nothing sent there
// is no order to pay for, and the box would jump to Order confirmed.
function refuseUnsent(box: any, entry: any) {
  if (entry.order_sent) return;
  refuse(
    409,
    "order_not_sent",
    "This order has not been sent to the supplier yet",
    { box: projectPaymentBox(box, entry) },
  );
}

/** The box as the answer and a 409 show it: its stage and payment as the
 * board shows them (null when the Arrival read failed). */
export function projectPaymentBox(box: any, entry: any | null) {
  return {
    box_id: String(box.id),
    job_id: String(box.job_id),
    supplier_id: text(box.supplier_id),
    supplier_name: text(box.supplier_name),
    material_stage: entry?.material_stage ?? null,
    material_stage_label: entry?.material_stage_label ?? null,
    payment: entry?.payment ?? null,
  };
}

async function latestBox(client: any, box: any, ctx: DispatchV2PaymentContext) {
  const { data } = await client.from("job_material_suppliers")
    .select(BOX_SELECT)
    .eq("id", box.id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  return data || box;
}

// Refuse a press over a change made somewhere else, with the box as it is
// now, so the person sees the change before pressing again.
async function changedElsewhere(
  client: any,
  box: any,
  code: string,
  message: string,
  ctx: DispatchV2PaymentContext,
): Promise<never> {
  const latest = await latestBox(client, box, ctx);
  const arrival = await arrivalOf(client, String(box.job_id), ctx);
  refuse(409, code, message, {
    box: projectPaymentBox(latest, entryFor(arrival, String(box.id))),
  });
}

// One compare-and-set update of the box: it lands only while `column` still
// holds what was read, so two presses at once never quietly overwrite each
// other. Returns the updated row, or null when the stamp changed meanwhile.
async function writeBox(
  client: any,
  box: any,
  patch: Record<string, unknown>,
  column: string,
  ctx: DispatchV2PaymentContext,
) {
  let update = client.from("job_material_suppliers")
    .update(patch)
    .eq("id", box.id)
    .eq("org_id", ctx.orgId);
  update = box[column]
    ? update.eq(column, box[column])
    : update.is(column, null);
  const { data, error } = await update.select(BOX_SELECT);
  if (error) {
    console.error("[dispatch_v2_payment] box write failed:", error);
    refuse(500, "dispatch_write_failed", "supplier box write failed");
  }
  const updated = Array.isArray(data) ? data[0] : data;
  return updated || null;
}

// The order a payment is for: the box's newest sent order email (its id is
// what supplier replies name). For the audit line only: a failed read gives
// null and never stops the press.
async function newestSentEmailId(client: any, box: any): Promise<string | null> {
  const { data, error } = await client.from("dispatch_supplier_order_emails")
    .select("id, sent_at")
    .eq("job_id", box.job_id)
    .eq("supplier_id", box.supplier_id)
    .eq("status", "sent")
    .order("sent_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[dispatch_v2_payment] order email read failed:", error);
    return null;
  }
  return Array.isArray(data) && data[0]?.id ? String(data[0].id) : null;
}

// The audit line. A failed insert does not undo the write: the answer then
// says audit_logged false.
async function audit(
  client: any,
  box: any,
  operator: Operator,
  eventType: string,
  detail: Record<string, unknown>,
): Promise<boolean> {
  const { error } = await client.from("job_events").insert({
    job_id: box.job_id,
    user_id: operator.userId,
    event_type: eventType,
    detail_json: detail,
  });
  if (error) {
    console.error("[dispatch_v2_payment] job_events insert failed:", error);
    return false;
  }
  return true;
}

// The answer every press gives: the box as the board now shows it, and the
// job's fresh Arrival line, so the screen redraws from one answer.
async function answer(
  client: any,
  box: any,
  ctx: DispatchV2PaymentContext,
  extra: { unchanged: boolean; audited?: boolean; arrival?: any },
) {
  const arrival = extra.arrival !== undefined
    ? extra.arrival
    : await arrivalOf(client, String(box.job_id), ctx);
  return {
    success: true,
    unchanged: extra.unchanged,
    ...(extra.audited === false ? { audit_logged: false } : {}),
    job_status_changed: false,
    box: projectPaymentBox(box, entryFor(arrival, String(box.id))),
    arrival,
  };
}

/** POST {box_id | job_id + supplier_id, expected_paid_at?, operator_email
 * (ops key)}. Stamps the box paid for its current order. */
export async function markDispatchV2Paid(
  client: any,
  body: any,
  ctx: DispatchV2PaymentContext,
) {
  if (!body || typeof body !== "object") badRequest("A JSON body is required");
  const guard = readGuard(body, "expected_paid_at", false);
  const box = await loadBox(client, body, ctx);
  await loadJob(client, String(box.job_id), ctx);
  const operator = await resolveOperator(client, body, ctx);

  if (guard !== undefined && !sameInstant(box.paid_at, guard)) {
    await changedElsewhere(
      client,
      box,
      "paid_changed",
      "This order's payment was changed somewhere else",
      ctx,
    );
  }
  const { arrival, entry } = await boxAsShown(client, box, ctx);
  if (entry.payment.terms === "on_account") {
    refuse(
      409,
      "on_account",
      "This supplier is on account: there is no payment step",
      { box: projectPaymentBox(box, entry) },
    );
  }
  // Already paid for the current order: nothing to write.
  if (entry.payment.paid) {
    return await answer(client, box, ctx, { unchanged: true, arrival });
  }
  refuseUnsent(box, entry);

  const now = ctx.now ? ctx.now() : new Date().toISOString();
  const updated = await writeBox(client, box, {
    paid_at: now,
    paid_by: operator.userId,
    paid_by_email: operator.email,
  }, "paid_at", ctx);
  if (!updated) {
    await changedElsewhere(
      client,
      box,
      "paid_changed",
      "This order's payment was changed somewhere else",
      ctx,
    );
  }
  const after = await arrivalOf(client, String(box.job_id), ctx);
  const afterEntry = entryFor(after, String(box.id));
  const audited = await audit(client, updated, operator, "dispatch_v2_marked_paid", {
    box_id: updated.id,
    supplier_id: updated.supplier_id ?? null,
    supplier: updated.supplier_name ?? null,
    // The order this payment is for: the box's newest sent order email.
    order_email_id: await newestSentEmailId(client, updated),
    replaced_paid_at: text(box.paid_at),
    had_date: !!entry.delivery_date,
    stage_before: entry.material_stage,
    stage_after: afterEntry?.material_stage ?? null,
    via: ctx.via,
    operator_email: operator.email,
  });
  return await answer(client, updated, ctx, {
    unchanged: false,
    audited,
    arrival: after,
  });
}

/** POST {box_id | job_id + supplier_id, expected_paid_at (required),
 * operator_email (ops key)}. Takes the paid stamp off. */
export async function undoDispatchV2Paid(
  client: any,
  body: any,
  ctx: DispatchV2PaymentContext,
) {
  if (!body || typeof body !== "object") badRequest("A JSON body is required");
  const guard = readGuard(body, "expected_paid_at", true);
  const box = await loadBox(client, body, ctx);
  await loadJob(client, String(box.job_id), ctx);
  const operator = await resolveOperator(client, body, ctx);

  if (!sameInstant(box.paid_at, guard)) {
    await changedElsewhere(
      client,
      box,
      "paid_changed",
      "This order's payment was changed somewhere else",
      ctx,
    );
  }
  // No stamp on the box: nothing to undo.
  if (!text(box.paid_at)) {
    return await answer(client, box, ctx, { unchanged: true });
  }
  const before = await arrivalOf(client, String(box.job_id), ctx);
  const beforeEntry = entryFor(before, String(box.id));
  const updated = await writeBox(client, box, {
    paid_at: null,
    paid_by: null,
    paid_by_email: null,
  }, "paid_at", ctx);
  if (!updated) {
    await changedElsewhere(
      client,
      box,
      "paid_changed",
      "This order's payment was changed somewhere else",
      ctx,
    );
  }
  const after = await arrivalOf(client, String(box.job_id), ctx);
  const afterEntry = entryFor(after, String(box.id));
  const audited = await audit(client, updated, operator, "dispatch_v2_paid_undone", {
    box_id: updated.id,
    supplier_id: updated.supplier_id ?? null,
    supplier: updated.supplier_name ?? null,
    undone_paid_at: text(box.paid_at),
    undone_paid_by_email: text(box.paid_by_email),
    stage_before: beforeEntry?.material_stage ?? null,
    stage_after: afterEntry?.material_stage ?? null,
    via: ctx.via,
    operator_email: operator.email,
  });
  return await answer(client, updated, ctx, {
    unchanged: false,
    audited,
    arrival: after,
  });
}

/** POST {box_id | job_id + supplier_id, pay_on ('pickup' | 'delivery' |
 * null), expected_set_at?, operator_email (ops key)}. Sets or takes off the
 * Pay on tag. */
export async function setDispatchV2PayOn(
  client: any,
  body: any,
  ctx: DispatchV2PaymentContext,
) {
  if (!body || typeof body !== "object") badRequest("A JSON body is required");
  if (!("pay_on" in body)) badRequest("pay_on is required");
  const target = body.pay_on;
  if (target !== null && target !== "pickup" && target !== "delivery") {
    badRequest("pay_on must be pickup, delivery or null");
  }
  const guard = readGuard(body, "expected_set_at", false);
  const box = await loadBox(client, body, ctx);
  await loadJob(client, String(box.job_id), ctx);
  const operator = await resolveOperator(client, body, ctx);

  if (guard !== undefined && !sameInstant(box.pay_on_set_at, guard)) {
    await changedElsewhere(
      client,
      box,
      "pay_on_changed",
      "This order's Pay on tag was changed somewhere else",
      ctx,
    );
  }
  const { arrival, entry } = await boxAsShown(client, box, ctx, false);
  // Nothing to do: the same tag already counts for the current order, or
  // there is no tag to take off.
  if (
    (target === null && !text(box.pay_on)) ||
    (target !== null && entry.payment.pay_on === target)
  ) {
    return await answer(client, box, ctx, { unchanged: true, arrival });
  }
  if (target !== null) refuseUnsent(box, entry);

  const now = ctx.now ? ctx.now() : new Date().toISOString();
  const patch = target === null
    ? {
      pay_on: null,
      pay_on_set_at: null,
      pay_on_set_by: null,
      pay_on_set_by_email: null,
    }
    : {
      pay_on: target,
      pay_on_set_at: now,
      pay_on_set_by: operator.userId,
      pay_on_set_by_email: operator.email,
    };
  const updated = await writeBox(client, box, patch, "pay_on_set_at", ctx);
  if (!updated) {
    await changedElsewhere(
      client,
      box,
      "pay_on_changed",
      "This order's Pay on tag was changed somewhere else",
      ctx,
    );
  }
  const after = await arrivalOf(client, String(box.job_id), ctx);
  const afterEntry = entryFor(after, String(box.id));
  const audited = await audit(
    client,
    updated,
    operator,
    target === null ? "dispatch_v2_pay_on_cleared" : "dispatch_v2_pay_on_set",
    {
      box_id: updated.id,
      supplier_id: updated.supplier_id ?? null,
      supplier: updated.supplier_name ?? null,
      from: text(box.pay_on),
      to: target,
      // The order this tag is for: the box's newest sent order email.
      order_email_id: await newestSentEmailId(client, updated),
      stage_before: entry.material_stage,
      stage_after: afterEntry?.material_stage ?? null,
      via: ctx.via,
      operator_email: operator.email,
    },
  );
  return await answer(client, updated, ctx, {
    unchanged: false,
    audited,
    arrival: after,
  });
}

export async function runDispatchV2PaymentAction(
  client: any,
  action: string,
  body: any,
  ctx: DispatchV2PaymentContext,
) {
  switch (action) {
    case DISPATCH_V2_MARK_PAID_ACTION:
      return await markDispatchV2Paid(client, body, ctx);
    case DISPATCH_V2_UNDO_PAID_ACTION:
      return await undoDispatchV2Paid(client, body, ctx);
    case DISPATCH_V2_SET_PAY_ON_ACTION:
      return await setDispatchV2PayOn(client, body, ctx);
    default:
      refuse(400, "unknown_action", `Unknown action: ${action}`);
  }
}
