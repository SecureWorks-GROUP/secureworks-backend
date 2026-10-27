// deno-lint-ignore-file no-explicit-any
// Dispatch v2: set, change or clear a supplier order's delivery date by hand.
// Contract: docs/dispatch-v2-board-contract.md, section 3a.
//
// Shaun's ruling (23 Oct 2026): "we can tweak delivery dates manually". A
// supplier often confirms a delivery day by phone, so a person can type the
// date on the order (and tick Confirmed) without waiting for a reply email.
//
// In v2 one supplier box (job_material_suppliers) is one order, so the date
// lives on the box, in the columns the board v2 migration added
// (20261023160000_dispatch_v2_board_arrival_dates.sql). The Arrival line
// (dispatch_board.ts) reads them: solid = confirmed, ring = a date not
// confirmed.
//
// The rules, in business words:
//   * A date set by hand always wins: it replaces whatever date is on the box,
//     including one accepted from a supplier's reply. The box then says
//     "set by hand" with the person's email. The latest press wins either way:
//     Accepting a newer supplier reply later replaces a hand-set date.
//   * Supplier reply suggestions are left as they are (open ones stay open).
//   * Clear (date null) takes the box's own date off completely. The Arrival
//     line then falls back to the date our order email asked for (a ring), or
//     "no date yet".
//   * Pressing Save with nothing different writes nothing.
//
// What this touches: one job_material_suppliers row (the seven delivery date
// columns only) and one job_events row (the audit line). Never jobs (no status
// or stage change), suppliers, purchase_orders, the order emails, the reply
// tables, Xero, GHL, SMS or any email.
//
// PostgREST returns errors, it does not throw: every read and write below
// reads `error`.

import {
  type DispatchMaterialsActor,
  DispatchMaterialsError,
} from "./dispatch_materials_store.ts";
import { isDispatchUuid } from "./dispatch_materials.ts";
import { isDispatchDeliveryDate } from "./dispatch_deliveries.ts";
import { dispatchWorkType } from "./dispatch_job_list.ts";
import {
  DISPATCH_BOARD_WORK_TYPES,
  DispatchArrivalError,
  dispatchArrivalRead,
} from "./dispatch_board.ts";

export const DISPATCH_V2_SET_DELIVERY_DATE_ACTION =
  "dispatch_v2_set_delivery_date";

// The box's delivery_date_source for a date a person typed.
export const DELIVERY_SOURCE_BY_HAND = "by_hand";

export type DispatchV2DeliveryDateContext = {
  orgId: string;
  actor: DispatchMaterialsActor;
  // 'screen' for a signed-in session, 'terminal' for the ops key.
  via: "screen" | "terminal";
  // Today in Perth (YYYY-MM-DD), for the fresh Arrival line in the answer.
  today: string;
  now?: () => string;
};

const BOX_SELECT =
  "id, org_id, job_id, supplier_id, supplier_name, delivery_date, delivery_date_source, delivery_date_set_at, delivery_date_set_by_email, delivery_date_confirmed_at, delivery_date_confirmed_by, delivery_date_confirmed_by_email";
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
  console.error(`[dispatch_v2_delivery_date] ${label} failed:`, error);
  refuse(500, "dispatch_read_failed", `${label} failed`);
}

function nowIso(ctx: DispatchV2DeliveryDateContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// The box's own date as a Perth day, or null.
function boxDay(box: any): string | null {
  const d = text(box?.delivery_date);
  return d ? d.slice(0, 10) : null;
}

// Every press names a person: the signed-in user, or for the ops key the
// operator_email in the body matching a row in users (as the Deliveries and
// supplier reply presses do).
async function resolveOperator(
  client: any,
  body: any,
  ctx: DispatchV2DeliveryDateContext,
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
  // The key is not that person: the by-id stays null and the email names them.
  return { userId: null, email: String(match.email) };
}

// What the press asks for. `delivery_date` must be given: a real date, or
// null to clear. `confirmed` must be true or false with a date (it is ignored
// and may be left out when clearing, but a confirmed clear is refused).
function readRequest(body: any) {
  if (!body || typeof body !== "object") badRequest("A JSON body is required");
  if (!("delivery_date" in body)) {
    badRequest("delivery_date required (a date YYYY-MM-DD, or null to clear)");
  }
  const raw = body.delivery_date;
  let date: string | null = null;
  if (raw !== null) {
    if (!isDispatchDeliveryDate(raw)) {
      badRequest("delivery_date must be a real date YYYY-MM-DD or null");
    }
    date = raw as string;
  }
  const confirmed = body.confirmed;
  if (date !== null && confirmed !== true && confirmed !== false) {
    badRequest("confirmed must be true or false");
  }
  if (date === null && confirmed === true) {
    badRequest("A cleared date cannot be confirmed");
  }
  // The guard: the box's delivery_date_set_at the screen showed (null = the
  // box had no date of its own). Left out = no guard.
  let guard: { setAt: string | null } | null = null;
  if ("expected_set_at" in body) {
    const g = body.expected_set_at;
    if (
      g !== null && (typeof g !== "string" || !Number.isFinite(Date.parse(g)))
    ) {
      badRequest("expected_set_at must be a timestamp or null");
    }
    guard = { setAt: g };
  }
  return { date, confirmed: date !== null && confirmed === true, guard };
}

// The box, found by box_id, or by job_id and supplier_id (one box per
// supplier per job).
async function loadBox(
  client: any,
  body: any,
  ctx: DispatchV2DeliveryDateContext,
) {
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

async function loadJob(
  client: any,
  jobId: string,
  ctx: DispatchV2DeliveryDateContext,
) {
  const { data, error } = await client.from("jobs")
    .select(JOB_SELECT)
    .eq("id", jobId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (error) readFailed("job read", error);
  if (!data) {
    refuse(404, "box_not_found", "That supplier order is not on the job");
  }
  // The same work as the Arrival line: no make-safe, insurance or other type.
  if (!DISPATCH_BOARD_WORK_TYPES.includes(dispatchWorkType(data))) {
    refuse(409, "not_dispatch_work", "This job is not Dispatch work");
  }
  return data;
}

/** The box's delivery date as the answer and the 409 show it. */
export function projectDeliveryDateBox(box: any) {
  const date = boxDay(box);
  return {
    box_id: String(box.id),
    job_id: String(box.job_id),
    supplier_id: text(box.supplier_id),
    supplier_name: text(box.supplier_name),
    delivery_date: date,
    delivery_date_source: date ? text(box.delivery_date_source) : null,
    confirmed: !!date && !!box.delivery_date_confirmed_at,
    set_at: date ? text(box.delivery_date_set_at) : null,
    set_by_email: date ? text(box.delivery_date_set_by_email) : null,
    confirmed_at: date ? text(box.delivery_date_confirmed_at) : null,
    confirmed_by_email: date
      ? text(box.delivery_date_confirmed_by_email)
      : null,
  };
}

// Nothing to do: the box already says exactly this, set by hand (a date a
// supplier reply put there, saved again by a person, is stamped as theirs).
function isUnchanged(
  box: any,
  want: { date: string | null; confirmed: boolean },
): boolean {
  const date = boxDay(box);
  if (want.date === null) return date === null;
  return date === want.date &&
    !!box.delivery_date_confirmed_at === want.confirmed &&
    box.delivery_date_source === DELIVERY_SOURCE_BY_HAND;
}

// The seven columns after the press. Every change is stamped as this
// person's, by hand (a tick or untick of Confirmed on the same date too).
function patchFor(
  want: { date: string | null; confirmed: boolean },
  operator: Operator,
  now: string,
) {
  if (want.date === null) {
    return {
      delivery_date: null,
      delivery_date_source: null,
      delivery_date_set_at: null,
      delivery_date_set_by_email: null,
      delivery_date_confirmed_at: null,
      delivery_date_confirmed_by: null,
      delivery_date_confirmed_by_email: null,
    };
  }
  return {
    delivery_date: want.date,
    delivery_date_source: DELIVERY_SOURCE_BY_HAND,
    delivery_date_set_at: now,
    delivery_date_set_by_email: operator.email,
    ...(want.confirmed
      ? {
        delivery_date_confirmed_at: now,
        delivery_date_confirmed_by: operator.userId,
        delivery_date_confirmed_by_email: operator.email,
      }
      : {
        delivery_date_confirmed_at: null,
        delivery_date_confirmed_by: null,
        delivery_date_confirmed_by_email: null,
      }),
  };
}

// The job's fresh Arrival line (the dispatch_arrival answer), so the screen
// redraws the line and the count from one answer. A failed read does not undo
// the write: the answer carries null and the screen reads dispatch_arrival.
async function freshArrival(
  client: any,
  jobId: string,
  ctx: DispatchV2DeliveryDateContext,
) {
  try {
    return await dispatchArrivalRead(client, jobId, ctx.orgId, ctx.today);
  } catch (e) {
    console.error(
      "[dispatch_v2_delivery_date] arrival read failed:",
      e instanceof DispatchArrivalError ? e.body : e,
    );
    return null;
  }
}

async function logEvent(
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
    detail_json: {
      box_id: box.id,
      supplier_id: box.supplier_id ?? null,
      supplier: box.supplier_name ?? null,
      ...detail,
      operator_email: operator.email,
    },
  });
  if (error) {
    console.error(
      "[dispatch_v2_delivery_date] job_events insert failed:",
      error,
    );
    return false;
  }
  return true;
}

// Two stamps are the same moment (or both empty). Compared as instants, so
// the same time written two ways still matches.
function sameInstant(a: unknown, b: unknown): boolean {
  const x = text(a);
  const y = text(b);
  if (!x || !y) return !x && !y;
  return Date.parse(x) === Date.parse(y);
}

function dateState(box: any) {
  const date = boxDay(box);
  return {
    delivery_date: date,
    confirmed: !!date && !!box.delivery_date_confirmed_at,
    source: date ? text(box.delivery_date_source) : null,
  };
}

/** POST {box_id | job_id + supplier_id, delivery_date (date | null),
 * confirmed, expected_set_at?, operator_email (ops key)}. Never moves the
 * job's stage or status. */
export async function setDispatchV2DeliveryDate(
  client: any,
  body: any,
  ctx: DispatchV2DeliveryDateContext,
) {
  const want = readRequest(body);
  const box = await loadBox(client, body, ctx);
  await loadJob(client, String(box.job_id), ctx);
  const operator = await resolveOperator(client, body, ctx);

  // The screen showed an older date than the box now has: refuse, with the
  // box as it is now, so the person sees the change before overwriting it.
  if (want.guard && !sameInstant(box.delivery_date_set_at, want.guard.setAt)) {
    refuse(
      409,
      "date_changed",
      "This delivery date was changed somewhere else",
      {
        box: projectDeliveryDateBox(box),
      },
    );
  }

  if (isUnchanged(box, want)) {
    return {
      success: true,
      unchanged: true,
      job_status_changed: false,
      box: projectDeliveryDateBox(box),
      arrival: await freshArrival(client, String(box.job_id), ctx),
    };
  }

  const now = nowIso(ctx);
  const patch = patchFor(want, operator, now);
  // One update, only while the box still carries the date stamp just read, so
  // two people pressing at once cannot quietly overwrite each other.
  let update = client.from("job_material_suppliers")
    .update(patch)
    .eq("id", box.id)
    .eq("org_id", ctx.orgId);
  update = box.delivery_date_set_at
    ? update.eq("delivery_date_set_at", box.delivery_date_set_at)
    : update.is("delivery_date_set_at", null);
  const { data, error } = await update.select(BOX_SELECT);
  if (error) {
    console.error("[dispatch_v2_delivery_date] box write failed:", error);
    refuse(500, "dispatch_write_failed", "delivery date write failed");
  }
  const updated = Array.isArray(data) ? data[0] : data;
  if (!updated) {
    const { data: latest } = await client.from("job_material_suppliers")
      .select(BOX_SELECT)
      .eq("id", box.id)
      .eq("org_id", ctx.orgId)
      .maybeSingle();
    refuse(
      409,
      "date_changed",
      "This delivery date was changed somewhere else",
      {
        box: projectDeliveryDateBox(latest || box),
      },
    );
  }

  const from = dateState(box);
  const logged = await logEvent(
    client,
    updated,
    operator,
    want.date === null
      ? "dispatch_v2_delivery_date_cleared"
      : "dispatch_v2_delivery_date_set",
    {
      from,
      to: dateState(updated),
      // True when this press replaced a date accepted from a supplier reply.
      replaced_supplier_reply: from.source === "supplier_reply",
      via: ctx.via,
    },
  );
  return {
    success: true,
    ...(logged ? {} : { audit_logged: false }),
    job_status_changed: false,
    box: projectDeliveryDateBox(updated),
    arrival: await freshArrival(client, String(updated.job_id), ctx),
  };
}

export async function runDispatchV2DeliveryDateAction(
  client: any,
  action: string,
  body: any,
  ctx: DispatchV2DeliveryDateContext,
) {
  if (action !== DISPATCH_V2_SET_DELIVERY_DATE_ACTION) {
    refuse(400, "unknown_action", `Unknown action: ${action}`);
  }
  return await setDispatchV2DeliveryDate(client, body, ctx);
}
