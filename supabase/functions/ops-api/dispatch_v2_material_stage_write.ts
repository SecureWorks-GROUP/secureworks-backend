// deno-lint-ignore-file no-explicit-any
// Dispatch v2: set where a supplier order is at (its material stage) by hand.
// Contract: docs/dispatch-v2-board-contract.md, section 3b. The stages and
// the rules for the stage a box shows: dispatch_v2_material_stage.ts.
//
// Shaun and Marnin, 27 Oct 2026: the materials need their own stages (Order
// materials, Sent to supplier, Quote received, Awaiting payment, Order
// confirmed, Manufacturing, Materials ready, Delivered), each saying who it is
// waiting on. A supplier's quote, a payment and a "ready for pickup" call
// mostly arrive by phone or email, so a person picks the stage on the order.
//
// The rules, in business words:
//   * The stage a person picks shows until something newer happens on the box:
//     another order email sent from it (back to Sent to supplier) or a new
//     line to order (back to Order materials).
//   * Pressing a stage again stamps it again: that is how a person says "it
//     is still at this stage" after a newer send or line moved the box on.
//   * It never moves the job's own stage or status, and never sends anything.
//
//   * Picking Awaiting payment re-opens the payment (contract 3c rule 5): it
//     also stamps payment_reopened_at, so a paid stamp or Pay on tag made
//     before it stops counting, whatever stage is picked after it.
//
// What this touches: one job_material_suppliers row (the three material stage
// columns, and payment_reopened_at on a pick of Awaiting payment) and one
// job_events row (the audit line). Never jobs,
// suppliers, purchase_orders, the order emails, the reply tables, Xero, GHL,
// SMS or any email.
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
import {
  dispatchMaterialStageLabel,
  isDispatchMaterialStage,
} from "./dispatch_v2_material_stage.ts";

export const DISPATCH_V2_SET_MATERIAL_STAGE_ACTION =
  "dispatch_v2_set_material_stage";

export type DispatchV2MaterialStageContext = {
  orgId: string;
  actor: DispatchMaterialsActor;
  // 'screen' for a signed-in session, 'terminal' for the ops key.
  via: "screen" | "terminal";
  // Today in Perth (YYYY-MM-DD), for the fresh Arrival line in the answer.
  today: string;
  now?: () => string;
};

const BOX_SELECT =
  "id, org_id, job_id, supplier_id, supplier_name, material_stage, material_stage_set_at, material_stage_set_by_email";
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
  console.error(`[dispatch_v2_material_stage] ${label} failed:`, error);
  refuse(500, "dispatch_read_failed", `${label} failed`);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// Every press names a person: the signed-in user, or for the ops key the
// operator_email in the body matching a row in users (as the delivery date
// press does).
async function resolveOperator(
  client: any,
  body: any,
  ctx: DispatchV2MaterialStageContext,
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

// What the press asks for: a stage from the list, and optionally the box's
// material_stage_set_at the screen showed (null = the box had no stage of its
// own). Left out = no guard.
function readRequest(body: any) {
  if (!body || typeof body !== "object") badRequest("A JSON body is required");
  const stage = body.material_stage;
  if (!isDispatchMaterialStage(stage)) {
    badRequest(
      "material_stage must be one of order_materials, sent, quote_received, awaiting_payment, order_confirmed, manufacturing, ready, delivered",
    );
  }
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
  return { stage, guard };
}

// The box, by box_id, or by job_id and supplier_id (one box per supplier per
// job).
async function loadBox(
  client: any,
  body: any,
  ctx: DispatchV2MaterialStageContext,
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
  ctx: DispatchV2MaterialStageContext,
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
  if (!DISPATCH_BOARD_WORK_TYPES.includes(dispatchWorkType(data))) {
    refuse(409, "not_dispatch_work", "This job is not Dispatch work");
  }
  return data;
}

/** The box's own stage as the answer and the 409 show it. */
export function projectMaterialStageBox(box: any) {
  const stage = isDispatchMaterialStage(box?.material_stage)
    ? box.material_stage
    : null;
  return {
    box_id: String(box.id),
    job_id: String(box.job_id),
    supplier_id: text(box.supplier_id),
    supplier_name: text(box.supplier_name),
    material_stage: stage,
    material_stage_label: stage ? dispatchMaterialStageLabel(stage) : null,
    set_at: stage ? text(box.material_stage_set_at) : null,
    set_by_email: stage ? text(box.material_stage_set_by_email) : null,
  };
}

function sameInstant(a: unknown, b: unknown): boolean {
  const x = text(a);
  const y = text(b);
  if (!x || !y) return !x && !y;
  return Date.parse(x) === Date.parse(y);
}

// The job's fresh Arrival line, so the screen redraws from one answer. A
// failed read does not undo the write: the answer carries null.
async function freshArrival(
  client: any,
  jobId: string,
  ctx: DispatchV2MaterialStageContext,
) {
  try {
    return await dispatchArrivalRead(client, jobId, ctx.orgId, ctx.today);
  } catch (e) {
    console.error(
      "[dispatch_v2_material_stage] arrival read failed:",
      e instanceof DispatchArrivalError ? e.body : e,
    );
    return null;
  }
}

/** POST {box_id | job_id + supplier_id, material_stage, expected_set_at?,
 * operator_email (ops key)}. Never moves the job's stage or status. */
export async function setDispatchV2MaterialStage(
  client: any,
  body: any,
  ctx: DispatchV2MaterialStageContext,
) {
  const want = readRequest(body);
  const box = await loadBox(client, body, ctx);
  await loadJob(client, String(box.job_id), ctx);
  const operator = await resolveOperator(client, body, ctx);

  // The screen showed an older stage than the box now has: refuse, with the
  // box as it is now, so the person sees the change before overwriting it.
  if (
    want.guard && !sameInstant(box.material_stage_set_at, want.guard.setAt)
  ) {
    refuse(
      409,
      "stage_changed",
      "This order's stage was changed somewhere else",
      { box: projectMaterialStageBox(box) },
    );
  }

  const now = ctx.now ? ctx.now() : new Date().toISOString();
  // One update, only while the box still carries the stamp just read, so two
  // people pressing at once cannot quietly overwrite each other. Pressing the
  // same stage again re-stamps it: that is how a person says "still at this
  // stage" over a newer send or line the box would otherwise show.
  const patch: Record<string, unknown> = {
    material_stage: want.stage,
    material_stage_set_at: now,
    material_stage_set_by_email: operator.email,
  };
  if (want.stage === "awaiting_payment") patch.payment_reopened_at = now;
  let update = client.from("job_material_suppliers")
    .update(patch)
    .eq("id", box.id)
    .eq("org_id", ctx.orgId);
  update = box.material_stage_set_at
    ? update.eq("material_stage_set_at", box.material_stage_set_at)
    : update.is("material_stage_set_at", null);
  const { data, error } = await update.select(BOX_SELECT);
  if (error) {
    console.error("[dispatch_v2_material_stage] box write failed:", error);
    refuse(500, "dispatch_write_failed", "material stage write failed");
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
      "stage_changed",
      "This order's stage was changed somewhere else",
      { box: projectMaterialStageBox(latest || box) },
    );
  }

  const { error: eventError } = await client.from("job_events").insert({
    job_id: updated.job_id,
    user_id: operator.userId,
    event_type: "dispatch_v2_material_stage_set",
    detail_json: {
      box_id: updated.id,
      supplier_id: updated.supplier_id ?? null,
      supplier: updated.supplier_name ?? null,
      from: isDispatchMaterialStage(box.material_stage)
        ? box.material_stage
        : null,
      to: want.stage,
      via: ctx.via,
      operator_email: operator.email,
    },
  });
  if (eventError) {
    console.error(
      "[dispatch_v2_material_stage] job_events insert failed:",
      eventError,
    );
  }
  return {
    success: true,
    ...(eventError ? { audit_logged: false } : {}),
    job_status_changed: false,
    box: projectMaterialStageBox(updated),
    arrival: await freshArrival(client, String(updated.job_id), ctx),
  };
}

export async function runDispatchV2MaterialStageAction(
  client: any,
  action: string,
  body: any,
  ctx: DispatchV2MaterialStageContext,
) {
  if (action !== DISPATCH_V2_SET_MATERIAL_STAGE_ACTION) {
    refuse(400, "unknown_action", `Unknown action: ${action}`);
  }
  return await setDispatchV2MaterialStage(client, body, ctx);
}
