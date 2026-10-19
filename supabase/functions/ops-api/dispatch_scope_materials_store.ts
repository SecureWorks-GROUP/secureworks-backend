// Dispatch scope material lines, stage 2. IO only.
// Contract: docs/dispatch-scope-material-lines-v1.md.
//
// Reads one scope's stored order lines, existing supplier records and the
// confirmed-price ledger, then copies known lines onto job_material_lines
// through dispatch_replace_scope_material_lines. It adds a
// job_material_suppliers row when the matched supplier is not yet on the job.
// It does not write the suppliers catalogue, does not read the job scope blob,
// does not raise an order, and it never sends.

import { DISPATCH_MATERIAL_LINES_PER_JOB_MAX, isDispatchUuid } from "./dispatch_materials.ts";
import { DispatchScopeOrderError, type ScopeOrderCut } from "./dispatch_scope_order.ts";
import {
  confirmedUnitPrice,
  matchSupplier,
  scopeLineCopyReasons,
  storedSupplierMatch,
  type ConfirmedPriceRow,
  type SupplierCandidate,
  type SupplierMatch,
} from "./dispatch_scope_materials.ts";

export const DISPATCH_SCOPE_MATERIAL_ACTIONS = [
  "dispatch_scope_material_lines",
  "dispatch_scope_order_apply",
] as const;

export const DISPATCH_SCOPE_MATERIAL_WRITE_ACTIONS = [
  "dispatch_scope_order_apply",
] as const;

const PRICE_CODE_CHUNK = 40;
const PRICE_ROW_CAP = 200;
const READ_PAGE = 1000;

export type DispatchScopeMaterialActor = {
  userId: string | null;
  email: string | null;
  orgId: string | null;
};

export type DispatchScopeMaterialContext = {
  orgId: string;
  actor: DispatchScopeMaterialActor;
  now?: () => string;
};

export type DispatchScopeMaterialLine = {
  id: string;
  supplier_id: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  status: string;
  source: string;
  product: string | null;
  length_mm: number | null;
  stock_length_mm: number | null;
  stock_qty: number | null;
  cut_size: string | null;
  cuts: ScopeOrderCut[];
  scope_id: string | null;
  demand_id: string | null;
  unit_price: number | null;
  purchase_order_id: string | null;
  position: number;
  created_by: string | null;
  created_by_email: string | null;
  updated_by: string | null;
  updated_by_email: string | null;
};

type StoredOrderLine = {
  demand_id: string;
  product: string | null;
  product_unknown: boolean;
  price_to_confirm: boolean;
  description: string;
  quantity: number | null;
  unit: string | null;
  length_mm: number | null;
  stock_length_mm: number | null;
  stock_qty: number | null;
  cut_size: string | null;
  cuts: ScopeOrderCut[];
  supplier_name: string | null;
  position: number;
};

function fail(status: number, code: string, message: string): never {
  throw new DispatchScopeOrderError(status, code, message);
}

function readFailed(label: string, error: unknown): never {
  console.error(`[dispatch_scope_materials] ${label} failed:`, error);
  const code = label === "confirmed price read"
    ? "price_read_failed"
    : label === "supplier read"
    ? "supplier_read_failed"
    : "material_read_failed";
  fail(500, code, `${label} failed`);
}

function writeFailed(label: string, error: unknown): never {
  console.error(`[dispatch_scope_materials] ${label} failed:`, error);
  fail(500, "material_write_failed", `${label} failed`);
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

function textOrNull(value: unknown): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

export async function scopeMaterialLineId(
  jobId: string,
  scopeId: string,
  demandId: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`dispatch-scope-material:${jobId}:${scopeId}:${demandId}`),
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
  ctx: DispatchScopeMaterialContext,
): Promise<{ id: string; org_id: string }> {
  const jobId = typeof jobIdInput === "string" ? jobIdInput.trim() : "";
  if (!jobId) fail(400, "invalid_request", "job_id required");
  if (!isDispatchUuid(jobId)) fail(400, "invalid_request", "job_id must be a uuid");
  const { data: job, error } = await client.from("jobs")
    .select("id, org_id")
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
  return { id: String(job.id), org_id: String(job.org_id) };
}

async function paged(
  client: any,
  table: string,
  columns: string,
  jobOrOrg: { key: string; value: string },
  extra: { key: string; value: string }[],
  orders: string[],
  label: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; from < READ_PAGE * 20; from += READ_PAGE) {
    let query = client.from(table).select(columns).eq(jobOrOrg.key, jobOrOrg.value);
    for (const filter of extra) query = query.eq(filter.key, filter.value);
    for (const key of orders) query = query.order(key);
    const { data, error } = await query.range(from, from + READ_PAGE - 1);
    if (error) readFailed(label, error);
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < READ_PAGE) return rows;
  }
  readFailed(label, { message: "page cap" });
}

function projectOrder(row: Record<string, unknown>): StoredOrderLine {
  return {
    demand_id: String(row.demand_id),
    product: textOrNull(row.product),
    product_unknown: row.product_unknown === true,
    price_to_confirm: row.price_to_confirm === true,
    description: String(row.description ?? ""),
    quantity: numberOrNull(row.quantity),
    unit: textOrNull(row.unit),
    length_mm: numberOrNull(row.length_mm),
    stock_length_mm: numberOrNull(row.stock_length_mm),
    stock_qty: numberOrNull(row.stock_qty),
    cut_size: textOrNull(row.cut_size),
    cuts: cutsOf(row.cuts),
    supplier_name: textOrNull(row.supplier_name),
    position: Number(row.position ?? 0),
  };
}

function projectMaterial(row: Record<string, unknown>): DispatchScopeMaterialLine {
  return {
    id: String(row.id),
    supplier_id: String(row.supplier_id),
    description: String(row.description ?? ""),
    quantity: numberOrNull(row.quantity),
    unit: textOrNull(row.unit),
    status: String(row.status ?? ""),
    source: String(row.source ?? ""),
    product: textOrNull(row.product),
    length_mm: numberOrNull(row.length_mm),
    stock_length_mm: numberOrNull(row.stock_length_mm),
    stock_qty: numberOrNull(row.stock_qty),
    cut_size: textOrNull(row.cut_size),
    cuts: cutsOf(row.cuts),
    scope_id: textOrNull(row.scope_id),
    demand_id: textOrNull(row.demand_id),
    unit_price: numberOrNull(row.unit_price),
    purchase_order_id: textOrNull(row.purchase_order_id),
    position: Number(row.position ?? 0),
    created_by: textOrNull(row.created_by),
    created_by_email: textOrNull(row.created_by_email),
    updated_by: textOrNull(row.updated_by),
    updated_by_email: textOrNull(row.updated_by_email),
  };
}

const MATERIAL_SELECT =
  "id, supplier_id, description, quantity, unit, status, source, product, length_mm, stock_length_mm, stock_qty, cut_size, cuts, scope_id, demand_id, unit_price, purchase_order_id, position, created_by, created_by_email, updated_by, updated_by_email";

function supplierOf(row: Record<string, unknown>): SupplierCandidate {
  const aliases = Array.isArray(row.aliases)
    ? row.aliases.filter((item) => typeof item === "string")
    : [];
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    aliases,
    is_active: row.is_active === false ? false : row.is_active === true ? true : null,
  };
}

function priceOf(row: Record<string, unknown>): ConfirmedPriceRow {
  return {
    id: String(row.id),
    material_code: textOrNull(row.material_code),
    supplier_name: String(row.supplier_name ?? ""),
    unit_price: numberOrNull(row.unit_price) ?? Number.NaN,
    status: String(row.status ?? ""),
    confirmed_at: textOrNull(row.confirmed_at),
  };
}

async function confirmedPrices(
  client: any,
  orgId: string,
  codes: string[],
): Promise<ConfirmedPriceRow[]> {
  const unique = [...new Set(codes)];
  const rows: ConfirmedPriceRow[] = [];
  for (let i = 0; i < unique.length; i += PRICE_CODE_CHUNK) {
    const chunk = unique.slice(i, i + PRICE_CODE_CHUNK);
    const { data, error } = await client.from("material_price_ledger")
      .select("id, material_code, supplier_name, unit_price, status, confirmed_at")
      .eq("org_id", orgId)
      .eq("status", "confirmed")
      .in("material_code", chunk)
      .order("confirmed_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(PRICE_ROW_CAP);
    if (error) readFailed("confirmed price read", error);
    const page = Array.isArray(data) ? data : [];
    if (page.length >= PRICE_ROW_CAP) {
      readFailed("confirmed price read", { message: "confirmed price page was full" });
    }
    rows.push(...page.map(priceOf));
  }
  return rows;
}

function overLineCap(
  existing: Record<string, unknown>[],
  scopeId: string,
  incomingDemandIds: string[],
): boolean {
  const held = new Set(
    existing
      .filter((row) =>
        row.source === "scope" && row.scope_id === scopeId && textOrNull(row.purchase_order_id)
      )
      .map((row) => String(row.demand_id)),
  );
  const keep = existing.filter((row) =>
    !(row.source === "scope" && row.scope_id === scopeId && !textOrNull(row.purchase_order_id))
  ).length;
  const add = incomingDemandIds.filter((id) => !held.has(id)).length;
  return keep + add > DISPATCH_MATERIAL_LINES_PER_JOB_MAX;
}

function nowIso(ctx: DispatchScopeMaterialContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

async function materialLines(client: any, jobId: string): Promise<DispatchScopeMaterialLine[]> {
  const rows = await paged(
    client,
    "job_material_lines",
    MATERIAL_SELECT,
    { key: "job_id", value: jobId },
    [],
    ["position", "id"],
    "material line read",
  );
  return rows.map(projectMaterial);
}

export async function runDispatchScopeMaterialAction(
  client: any,
  action: string,
  params: URLSearchParams,
  body: Record<string, unknown> | null,
  ctx: DispatchScopeMaterialContext,
): Promise<Record<string, unknown>> {
  if (action === "dispatch_scope_material_lines") {
    const job = await loadJob(client, jobIdOf(params, body), ctx);
    return { job_id: job.id, material_lines: await materialLines(client, job.id), sends: false };
  }
  if (action !== "dispatch_scope_order_apply") {
    fail(400, "invalid_request", "unknown scope material action");
  }
  const scopeId = typeof body?.scope_id === "string" ? body.scope_id.trim() : "";
  if (!scopeId) fail(400, "invalid_request", "scope_id required");
  const job = await loadJob(client, jobIdOf(params, body), ctx);
  const stored = (await paged(
    client,
    "dispatch_scope_order_lines",
    "demand_id, product, product_unknown, price_to_confirm, description, quantity, unit, length_mm, stock_length_mm, stock_qty, cut_size, cuts, supplier_name, position",
    { key: "job_id", value: job.id },
    [{ key: "scope_id", value: scopeId }],
    ["position", "demand_id"],
    "scope order read",
  )).map(projectOrder);
  if (stored.length === 0) fail(400, "no_lines", "that scope has no stored order lines");

  const supplierRows = await paged(
    client,
    "suppliers",
    "id, name, aliases, is_active",
    { key: "org_id", value: job.org_id },
    [],
    ["id"],
    "supplier read",
  );
  const suppliers = supplierRows.map(supplierOf);
  const matches = new Map<string, SupplierMatch>();
  for (const line of stored) matches.set(line.demand_id, matchSupplier(line.supplier_name, suppliers));

  const reasonsFor = (line: StoredOrderLine): string[] =>
    scopeLineCopyReasons(line.product_unknown || line.product === null, matches.get(line.demand_id)!);
  const copyable = stored.filter((line) => reasonsFor(line).length === 0);
  const prices = copyable.length === 0
    ? []
    : await confirmedPrices(
      client,
      job.org_id,
      copyable.map((line) => line.product).filter((product): product is string => product !== null),
    );
  const byId = new Map(suppliers.map((supplier) => [supplier.id, supplier]));
  const existing = await paged(
    client,
    "job_material_lines",
    "id, source, scope_id, demand_id, purchase_order_id",
    { key: "job_id", value: job.id },
    [],
    ["id"],
    "material line read",
  );
  if (overLineCap(existing, scopeId, copyable.map((line) => line.demand_id))) {
    fail(
      409,
      "too_many_lines",
      `a job can carry at most ${DISPATCH_MATERIAL_LINES_PER_JOB_MAX} material lines`,
    );
  }

  const supplierPayload = [];
  const seenSuppliers = new Set<string>();
  for (const line of copyable) {
    const match = matches.get(line.demand_id)!;
    if (match.status !== "matched" || seenSuppliers.has(match.supplier_id)) continue;
    seenSuppliers.add(match.supplier_id);
    supplierPayload.push({
      supplier_id: match.supplier_id,
      supplier_name: match.supplier_name,
      position: supplierPayload.length,
    });
  }
  const linePayload = [];
  for (const line of copyable) {
    const match = matches.get(line.demand_id)!;
    if (match.status !== "matched" || !line.product) continue;
    const supplier = byId.get(match.supplier_id);
    const names = supplier ? [supplier.name, ...(supplier.aliases ?? [])] : [match.supplier_name];
    linePayload.push({
      id: await scopeMaterialLineId(job.id, scopeId, line.demand_id),
      supplier_id: match.supplier_id,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      product: line.product,
      length_mm: line.length_mm,
      stock_length_mm: line.stock_length_mm,
      stock_qty: line.stock_qty,
      cut_size: line.cut_size,
      cuts: line.cuts,
      demand_id: line.demand_id,
      unit_price: confirmedUnitPrice(line.product, names, prices),
      position: line.position,
    });
  }
  const flags = stored.map((line) => ({
    demand_id: line.demand_id,
    supplier_match: storedSupplierMatch(matches.get(line.demand_id)!),
  }));
  const now = nowIso(ctx);
  const { data, error } = await client.rpc("dispatch_replace_scope_material_lines", {
    p: {
      job_id: job.id,
      org_id: job.org_id,
      scope_id: scopeId,
      now,
      actor: { user_id: ctx.actor.userId, email: ctx.actor.email },
      suppliers: supplierPayload,
      lines: linePayload,
      flags,
    },
  });
  if (error) writeFailed("scope material replace", error);
  const result = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const flagged = stored
    .map((line) => {
      const match = matches.get(line.demand_id)!;
      const reasons = reasonsFor(line);
      return {
        demand_id: line.demand_id,
        product: line.product,
        product_unknown: line.product_unknown,
        price_to_confirm: line.price_to_confirm,
        supplier_name: line.supplier_name,
        supplier_match: storedSupplierMatch(match),
        reasons,
      };
    })
    .filter((line) => line.reasons.length > 0)
    .sort((a, b) => a.demand_id < b.demand_id ? -1 : a.demand_id > b.demand_id ? 1 : 0);
  return {
    job_id: job.id,
    scope_id: scopeId,
    sends: false,
    material_lines: await materialLines(client, job.id),
    copied: numberOrNull(result.copied) ?? 0,
    removed: numberOrNull(result.removed) ?? 0,
    held: numberOrNull(result.held) ?? 0,
    flagged,
  };
}
