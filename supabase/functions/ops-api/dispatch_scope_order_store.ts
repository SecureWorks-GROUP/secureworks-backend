// Dispatch scope order lines, stage 1. IO only.
// Contract: docs/dispatch-scope-order-lines-v1.md.
//
// Reads jobs (id, org, number, type) and replaces one scope's rows in
// dispatch_scope_order_lines, in the one function
// dispatch_replace_scope_order_lines. It does not read scope_json, does not
// write job_material_lines, purchase orders, prices or events, and it never
// sends.

import { isDispatchUuid } from "./dispatch_materials.ts";
import {
  DispatchScopeOrderError,
  parseScopeOrder,
  requireOrderVersion,
  requireScopeId,
  SCOPE_ORDER_BYTES_MAX,
  scopeOrderUtf8Bytes,
  type ScopeOrderCut,
  type ScopeOrderLine,
} from "./dispatch_scope_order.ts";

export const DISPATCH_SCOPE_ORDER_ACTIONS = [
  "dispatch_scope_order_lines",
  "dispatch_scope_order_import",
] as const;

export const DISPATCH_SCOPE_ORDER_WRITE_ACTIONS = [
  "dispatch_scope_order_import",
] as const;

const LINE_SELECT =
  "id, job_id, scope_id, order_version, demand_id, product, product_unknown, description, quantity, unit, length_mm, stock_length_mm, stock_qty, cut_size, cuts, element_refs, supplier_name, position, created_at, created_by, created_by_email";

export type DispatchScopeOrderActor = {
  userId: string | null;
  email: string | null;
  orgId: string | null;
};

export type DispatchScopeOrderContext = {
  orgId: string;
  actor: DispatchScopeOrderActor;
  now?: () => string;
};

export type DispatchScopeOrderLineRow = {
  id: string;
  scope_id: string;
  order_version: string;
  demand_id: string;
  product: string | null;
  product_unknown: boolean;
  description: string;
  quantity: number | null;
  unit: string | null;
  length_mm: number | null;
  stock_length_mm: number | null;
  stock_qty: number | null;
  cut_size: string | null;
  cuts: ScopeOrderCut[];
  element_refs: string[];
  supplier_name: string | null;
  position: number;
};

function fail(
  status: number,
  code: string,
  message: string,
): never {
  throw new DispatchScopeOrderError(status, code, message);
}

function readFailed(label: string, error: unknown): never {
  console.error(`[dispatch_scope_order] ${label} failed:`, error);
  fail(500, "scope_order_read_failed", `${label} failed`);
}

function writeFailed(label: string, error: unknown): never {
  console.error(`[dispatch_scope_order] ${label} failed:`, error);
  fail(500, "scope_order_write_failed", `${label} failed`);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function cutsOf(value: unknown): ScopeOrderCut[] {
  const raw = typeof value === "string"
    ? (() => {
      try {
        return JSON.parse(value);
      } catch {
        return [];
      }
    })()
    : value;
  if (!Array.isArray(raw)) return [];
  const cuts: ScopeOrderCut[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const length = numberOrNull(row.length_mm);
    const qty = numberOrNull(row.qty);
    if (length === null || qty === null) continue;
    cuts.push({ length_mm: length, qty });
  }
  return cuts;
}

function refsOf(value: unknown): string[] {
  const raw = typeof value === "string"
    ? (() => {
      try {
        return JSON.parse(value);
      } catch {
        return [];
      }
    })()
    : value;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => typeof item === "string");
}

function project(row: Record<string, unknown>): DispatchScopeOrderLineRow {
  return {
    id: String(row.id),
    scope_id: String(row.scope_id ?? ""),
    order_version: String(row.order_version ?? ""),
    demand_id: String(row.demand_id),
    product: row.product == null || row.product === "" ? null : String(row.product),
    product_unknown: row.product_unknown === true,
    description: String(row.description ?? ""),
    quantity: numberOrNull(row.quantity),
    unit: row.unit == null || row.unit === "" ? null : String(row.unit),
    length_mm: numberOrNull(row.length_mm),
    stock_length_mm: numberOrNull(row.stock_length_mm),
    stock_qty: numberOrNull(row.stock_qty),
    cut_size: row.cut_size == null || row.cut_size === "" ? null : String(row.cut_size),
    cuts: cutsOf(row.cuts),
    element_refs: refsOf(row.element_refs),
    supplier_name: row.supplier_name == null || row.supplier_name === ""
      ? null
      : String(row.supplier_name),
    position: Number(row.position ?? 0),
  };
}

export async function scopeOrderLineId(
  jobId: string,
  scopeId: string,
  demandId: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`dispatch-scope-order:${jobId}:${scopeId}:${demandId}`),
    ),
  ).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

function jobIdOf(params: URLSearchParams, body: Record<string, unknown> | null): unknown {
  if (body && body.job_id !== undefined && body.job_id !== null && body.job_id !== "") {
    return body.job_id;
  }
  return params.get("job_id");
}

async function loadJob(
  client: any,
  jobIdInput: unknown,
  ctx: DispatchScopeOrderContext,
): Promise<{ id: string; org_id: string; job_number: string | null; type: string | null }> {
  const jobId = typeof jobIdInput === "string" ? jobIdInput.trim() : "";
  if (!jobId) fail(400, "invalid_request", "job_id required");
  if (!isDispatchUuid(jobId)) fail(400, "invalid_request", "job_id must be a uuid");
  const { data: job, error } = await client.from("jobs")
    .select("id, org_id, job_number, type")
    .eq("id", jobId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (error) readFailed("job read", error);
  if (
    !job || String(job.org_id || "") !== ctx.orgId ||
    (ctx.actor.orgId && String(job.org_id || "") !== ctx.actor.orgId)
  ) {
    fail(404, "job_not_found", "Job not found");
  }
  return {
    id: String(job.id),
    org_id: String(job.org_id),
    job_number: job.job_number == null ? null : String(job.job_number),
    type: job.type == null ? null : String(job.type),
  };
}

async function storedLines(client: any, jobId: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await client.from("dispatch_scope_order_lines")
    .select(LINE_SELECT)
    .eq("job_id", jobId)
    .order("scope_id")
    .order("position")
    .order("demand_id");
  if (error) readFailed("scope order read", error);
  return Array.isArray(data) ? data : [];
}

function nowIso(ctx: DispatchScopeOrderContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

async function linePayload(
  jobId: string,
  scopeId: string,
  row: ScopeOrderLine,
  position: number,
): Promise<Record<string, unknown>> {
  return {
    id: await scopeOrderLineId(jobId, scopeId, row.demand_id),
    demand_id: row.demand_id,
    product: row.product,
    product_unknown: row.product_unknown,
    description: row.description,
    quantity: row.quantity,
    unit: row.unit,
    length_mm: row.length_mm,
    stock_length_mm: row.stock_length_mm,
    stock_qty: row.stock_qty,
    cut_size: row.cut_size,
    cuts: row.cuts,
    element_refs: row.element_refs,
    supplier_name: row.supplier_name,
    position,
  };
}

export async function runDispatchScopeOrderAction(
  client: any,
  action: string,
  params: URLSearchParams,
  body: Record<string, unknown> | null,
  ctx: DispatchScopeOrderContext,
): Promise<Record<string, unknown>> {
  if (action === "dispatch_scope_order_lines") {
    const job = await loadJob(client, jobIdOf(params, body), ctx);
    const lines = (await storedLines(client, job.id)).map(project);
    return { job_id: job.id, lines, sends: false };
  }
  if (action !== "dispatch_scope_order_import") {
    fail(400, "invalid_request", "unknown scope order action");
  }
  const scopeId = requireScopeId(body?.scope_id);
  const orderVersion = requireOrderVersion(body?.order_version);
  if (!body || !Object.prototype.hasOwnProperty.call(body, "order")) {
    fail(400, "invalid_request", "order required");
  }
  if (scopeOrderUtf8Bytes(body.order) > SCOPE_ORDER_BYTES_MAX) {
    fail(400, "order_too_large", `an order must be at most ${SCOPE_ORDER_BYTES_MAX} bytes`);
  }
  const parsed = parseScopeOrder(body.order);
  if (parsed.lines.length === 0) {
    fail(400, "no_lines", "an order must name at least one line");
  }
  const job = await loadJob(client, jobIdOf(params, body), ctx);
  const now = nowIso(ctx);
  const lines = [];
  for (const [position, row] of parsed.lines.entries()) {
    lines.push(await linePayload(job.id, scopeId, row, position));
  }
  const { data, error } = await client.rpc("dispatch_replace_scope_order_lines", {
    p: {
      job_id: job.id,
      org_id: job.org_id,
      scope_id: scopeId,
      order_version: orderVersion,
      now,
      actor: { user_id: ctx.actor.userId, email: ctx.actor.email },
      lines,
    },
  });
  if (error) writeFailed("scope order replace", error);
  const removed = numberOrNull(data && typeof data === "object" ? (data as RowRemoved).removed : null) ?? 0;
  const stored = (await storedLines(client, job.id)).map(project);
  return {
    job_id: job.id,
    scope_id: scopeId,
    order_version: orderVersion,
    lines: stored,
    withheld_demand_ids: parsed.withheld_demand_ids,
    removed,
    sends: false,
  };
}

type RowRemoved = { removed?: unknown };
