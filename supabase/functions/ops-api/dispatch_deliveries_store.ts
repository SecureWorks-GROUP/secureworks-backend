// deno-lint-ignore-file no-explicit-any
// Dispatch slice 6: Deliveries. The three writes.
// Contract: docs/dispatch-slice-6-contract.md. Rules: dispatch_deliveries.ts.
//
// Each write updates ONE purchase_orders row (only its own columns) and adds
// one job_events row. Never jobs, job_dispatch_state, the order's status,
// line_items, delivery_confirmed_at, xero_po_id or job_id. No send, no Xero
// call, no business event, no paid AI read.
//
// PostgREST returns errors, it does not throw: every read and write below
// reads `error`.

import {
  type DispatchMaterialsActor,
  DispatchMaterialsError,
  projectDispatchDeliveryOrder,
  readDispatchJobCounts,
  readDispatchPersonNames,
} from "./dispatch_materials_store.ts";
import { DISPATCH_ORDER_SELECT, isDispatchUuid } from "./dispatch_materials.ts";
import {
  DISPATCH_DELIVERY_ORDER_COLUMNS,
  dispatchDeliverySummary,
  isDispatchDeliveryDate,
  isDispatchMaterialOrder,
  isDispatchOrderGone,
} from "./dispatch_deliveries.ts";
import {
  DISPATCH_FAMILY_PROJECTION,
  dispatchWorkType,
} from "./dispatch_job_list.ts";

export const DISPATCH_DELIVERY_ACTIONS = [
  "dispatch_delivery_set_expected",
  "dispatch_delivery_set_confirmed",
  "dispatch_delivery_mark_sighted",
] as const;

export type DispatchDeliveriesContext = {
  orgId: string;
  actor: DispatchMaterialsActor;
  // 'screen' for a signed-in session, 'terminal' for the ops key.
  via: "screen" | "terminal";
  now?: () => string;
};

const ORDER_SELECT =
  `${DISPATCH_ORDER_SELECT}, ${DISPATCH_DELIVERY_ORDER_COLUMNS}, org_id, job_id`;
const JOB_SELECT = "id, org_id, job_number, type, " +
  DISPATCH_FAMILY_PROJECTION.join(", ");

function refuse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new DispatchMaterialsError(status, code, message, extra);
}

function readFailed(label: string, error: any): never {
  console.error(`[dispatch_deliveries] ${label} failed:`, error);
  refuse(500, "deliveries_read_failed", `${label} failed`);
}

function badRequest(message: string): never {
  refuse(400, "invalid_request", message);
}

function nowIso(ctx: DispatchDeliveriesContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

type Operator = { userId: string | null; email: string };

// Every press names a person: the signed-in user, or for the ops key the
// operator_email in the body matching a row in users.
async function resolveOperator(
  client: any,
  body: any,
  ctx: DispatchDeliveriesContext,
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
  // The key is not that person (as slice 5): the by-id stays null and the
  // email names them.
  return { userId: null, email: String(match.email) };
}

async function readOrder(
  client: any,
  id: string,
  ctx: DispatchDeliveriesContext,
) {
  const { data, error } = await client.from("purchase_orders")
    .select(ORDER_SELECT)
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (error) readFailed("order read", error);
  return data || null;
}

// The order, on a job of this organisation that is Dispatch work, live and
// material. Refusals in the contract's order.
async function loadDeliveryOrder(
  client: any,
  body: any,
  ctx: DispatchDeliveriesContext,
) {
  const id = body?.purchase_order_id;
  if (!isDispatchUuid(id)) badRequest("purchase_order_id must be a uuid");
  const expected = body?.expected_updated_at;
  if (
    typeof expected !== "string" || !expected ||
    !Number.isFinite(Date.parse(expected))
  ) {
    badRequest("expected_updated_at must be a timestamp");
  }
  const order = await readOrder(client, id, ctx);
  if (
    !order || !order.job_id ||
    (ctx.actor.orgId && String(order.org_id || "") !== ctx.actor.orgId)
  ) {
    refuse(404, "order_not_found", "Order not found");
  }
  const { data: job, error } = await client.from("jobs")
    .select(JOB_SELECT)
    .eq("id", order.job_id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (error) readFailed("job read", error);
  if (!job) refuse(404, "order_not_found", "Order not found");
  if (dispatchWorkType(job) === "makesafe") {
    refuse(
      409,
      "not_dispatch_work",
      "Deliveries are not offered on a make-safe job",
    );
  }
  if (isDispatchOrderGone(order)) {
    refuse(409, "order_cancelled", "This order is cancelled");
  }
  if (!isDispatchMaterialOrder(order)) {
    refuse(409, "not_material", "This order delivers no materials");
  }
  return { order, job, expected: expected as string };
}

function dateInput(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (!isDispatchDeliveryDate(value)) {
    badRequest(`${name} must be a real date YYYY-MM-DD or null`);
  }
  return value as string;
}

// The job's delivery summary after a write. A failed read does not undo a
// write that landed: the answer carries null and the screen keeps its figure.
async function readJobDeliveries(client: any, jobId: string, orgId: string) {
  const { data, error } = await client.from("purchase_orders")
    .select("id, status, po_type, delivery_sighted_at")
    .eq("job_id", jobId)
    .eq("org_id", orgId)
    .neq("status", "deleted");
  if (error) {
    console.error("[dispatch_deliveries] job orders read failed:", error);
    return null;
  }
  return dispatchDeliverySummary(data || []);
}

async function answer(
  client: any,
  order: any,
  ctx: DispatchDeliveriesContext,
  extra: Record<string, unknown>,
) {
  const [names, deliveries, counts] = await Promise.all([
    readDispatchPersonNames(client, [order]),
    readJobDeliveries(client, String(order.job_id), ctx.orgId),
    readDispatchJobCounts(client, String(order.job_id), "dispatch_deliveries"),
  ]);
  return {
    success: true,
    ...extra,
    order: projectDispatchDeliveryOrder(order, names),
    deliveries,
    counts,
  };
}

// One update, only where the order is still the one the screen showed.
async function writeOrder(
  client: any,
  order: any,
  expected: string,
  patch: Record<string, unknown>,
  ctx: DispatchDeliveriesContext,
) {
  const { data, error } = await client.from("purchase_orders")
    .update(patch)
    .eq("id", order.id)
    .eq("updated_at", expected)
    .select(ORDER_SELECT);
  if (error) {
    console.error("[dispatch_deliveries] order write failed:", error);
    refuse(500, "deliveries_write_failed", "order write failed");
  }
  const updated = Array.isArray(data) ? data[0] : data;
  if (!updated) {
    const latest = (await readOrder(client, String(order.id), ctx)) || order;
    const names = await readDispatchPersonNames(client, [latest]);
    refuse(409, "order_changed", "This order changed somewhere else", {
      order: projectDispatchDeliveryOrder(latest, names),
    });
  }
  return updated;
}

async function logEvent(
  client: any,
  order: any,
  operator: Operator,
  eventType: string,
  detail: Record<string, unknown>,
): Promise<boolean> {
  const { error } = await client.from("job_events").insert({
    job_id: order.job_id,
    user_id: operator.userId,
    event_type: eventType,
    detail_json: {
      po_id: order.id,
      po_number: order.po_number ?? null,
      supplier: order.supplier_name ?? null,
      ...detail,
      operator_email: operator.email,
    },
  });
  if (error) {
    console.error("[dispatch_deliveries] job_events insert failed:", error);
    return false;
  }
  return true;
}

export async function setDispatchDeliveryExpected(
  client: any,
  body: any,
  ctx: DispatchDeliveriesContext,
) {
  const date = dateInput(body?.delivery_date, "delivery_date");
  const { order, expected } = await loadDeliveryOrder(client, body, ctx);
  if (order.xero_po_id) {
    refuse(
      409,
      "order_in_xero",
      "The expected date of an order in Xero is set in Xero",
    );
  }
  const operator = await resolveOperator(client, body, ctx);
  if ((order.delivery_date ?? null) === date) {
    return await answer(client, order, ctx, { unchanged: true });
  }
  const updated = await writeOrder(client, order, expected, {
    delivery_date: date,
  }, ctx);
  const logged = await logEvent(
    client,
    updated,
    operator,
    "po_delivery_expected_set",
    {
      from: order.delivery_date ?? null,
      to: date,
    },
  );
  return await answer(
    client,
    updated,
    ctx,
    logged ? {} : { audit_logged: false },
  );
}

export async function setDispatchDeliveryConfirmed(
  client: any,
  body: any,
  ctx: DispatchDeliveriesContext,
) {
  const date = dateInput(
    body?.confirmed_delivery_date,
    "confirmed_delivery_date",
  );
  const via = body?.via;
  if (via !== "deliveries" && via !== "thread") {
    badRequest("via must be deliveries or thread");
  }
  const { order, expected } = await loadDeliveryOrder(client, body, ctx);
  const operator = await resolveOperator(client, body, ctx);
  const stored = order.confirmed_delivery_date ?? null;
  // Unchanged: the same date already set by hand, or nothing to clear. A date
  // the reply reader wrote, set again by a person, is stamped as theirs.
  const unchanged = date === null
    ? stored === null && !order.confirmed_delivery_set_at
    : stored === date && !!order.confirmed_delivery_set_at;
  if (unchanged) return await answer(client, order, ctx, { unchanged: true });
  const patch = date === null
    ? {
      confirmed_delivery_date: null,
      confirmed_delivery_set_at: null,
      confirmed_delivery_set_by: null,
      confirmed_delivery_set_by_email: null,
    }
    : {
      confirmed_delivery_date: date,
      confirmed_delivery_set_at: nowIso(ctx),
      confirmed_delivery_set_by: operator.userId,
      confirmed_delivery_set_by_email: operator.email,
    };
  const updated = await writeOrder(client, order, expected, patch, ctx);
  const logged = await logEvent(
    client,
    updated,
    operator,
    "po_delivery_confirmed_set",
    {
      from: stored,
      to: date,
      via,
    },
  );
  return await answer(
    client,
    updated,
    ctx,
    logged ? {} : { audit_logged: false },
  );
}

export async function markDispatchDeliverySighted(
  client: any,
  body: any,
  ctx: DispatchDeliveriesContext,
) {
  const sighted = body?.sighted;
  if (sighted !== true && sighted !== false) {
    badRequest("sighted must be true or false");
  }
  const { order, expected } = await loadDeliveryOrder(client, body, ctx);
  const operator = await resolveOperator(client, body, ctx);
  const was = !!order.delivery_sighted_at;
  if (was === sighted) {
    return await answer(client, order, ctx, { unchanged: true });
  }
  const at = nowIso(ctx);
  const updated = await writeOrder(
    client,
    order,
    expected,
    sighted
      ? {
        delivery_sighted_at: at,
        delivery_sighted_by: operator.userId,
        delivery_sighted_by_email: operator.email,
      }
      : {
        delivery_sighted_at: null,
        delivery_sighted_by: null,
        delivery_sighted_by_email: null,
      },
    ctx,
  );
  const logged = sighted
    ? await logEvent(client, updated, operator, "po_delivery_sighted", {
      sighted_at: updated.delivery_sighted_at ?? at,
    })
    : await logEvent(client, updated, operator, "po_delivery_sighted_cleared", {
      was_sighted_at: order.delivery_sighted_at,
      was_sighted_by_email: order.delivery_sighted_by_email ?? null,
    });
  return await answer(
    client,
    updated,
    ctx,
    logged ? {} : { audit_logged: false },
  );
}

export async function runDispatchDeliveriesAction(
  client: any,
  action: string,
  body: any,
  ctx: DispatchDeliveriesContext,
) {
  switch (action) {
    case "dispatch_delivery_set_expected":
      return await setDispatchDeliveryExpected(client, body, ctx);
    case "dispatch_delivery_set_confirmed":
      return await setDispatchDeliveryConfirmed(client, body, ctx);
    case "dispatch_delivery_mark_sighted":
      return await markDispatchDeliverySighted(client, body, ctx);
    default:
      refuse(400, "unknown_action", `Unknown action: ${action}`);
  }
}
