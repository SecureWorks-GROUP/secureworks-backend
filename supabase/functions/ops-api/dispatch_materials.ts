// deno-lint-ignore-file no-explicit-any
// Dispatch slice 4: Materials by supplier. The rules, pure.
// Contract: docs/dispatch-slice-4-contract.md.
//
// The reads and writes live in dispatch_materials_store.ts and the `pipeline`
// read in index.ts; this module owns what they validate, derive and project,
// so the rules are testable without a database. In particular the display
// status and the "items ready" count are worked out HERE ONLY: the
// dispatch_materials read, every write's answer and the Dispatch list's two
// fields all call dispatchMaterialCounts, so they cannot disagree.

// The only values ever stored on a line. Set by hand on the screen.
export const DISPATCH_MATERIAL_STORED_STATUSES = [
  "not_reviewed",
  "to_order",
  "in_stock",
] as const;
export type DispatchMaterialStoredStatus =
  typeof DISPATCH_MATERIAL_STORED_STATUSES[number];

// Worked out on read, never stored, never accepted from a caller. `on_po` is
// true when slice 5 stamps purchase_order_id; slice 6 adds `delivered` here;
// S5 (docs/dispatch-partial-deliveries-v1.md) adds `part_delivered`.
export type DispatchMaterialDisplayStatus =
  | DispatchMaterialStoredStatus
  | "on_po"
  | "part_delivered"
  | "delivered";

// S5: what the receipts and sightings say about each line on an order, worked
// out once by dispatchLineDeliveryView (dispatch_line_receipts.ts). Line ids.
export type DispatchLineDeliveryView = {
  delivered: ReadonlySet<string>;
  part: ReadonlySet<string>;
  received: ReadonlyMap<string, number>;
  // Every receipt for the line on its current order, voided ones included,
  // oldest first, already projected for the screen.
  receipts: ReadonlyMap<string, unknown[]>;
};

// Slice 6 callers pass the set of sighted order ids; S5 callers pass the view.
export type DispatchDeliveredInput =
  | ReadonlySet<string>
  | DispatchLineDeliveryView;

function isLineDeliveryView(
  input: DispatchDeliveredInput | undefined,
): input is DispatchLineDeliveryView {
  return !!input && !(input instanceof Set) && "delivered" in input;
}

const READY_DISPLAY_STATUSES = new Set<string>(["in_stock", "delivered"]);

export const DISPATCH_MATERIAL_SOURCES = ["manual", "scope"] as const;

export const DISPATCH_MATERIAL_DESCRIPTION_MAX = 300;
export const DISPATCH_MATERIAL_UNIT_MAX = 30;
export const DISPATCH_MATERIAL_LINES_PER_JOB_MAX = 500;
// numeric(12,3): nine whole digits.
export const DISPATCH_MATERIAL_QUANTITY_MAX = 999_999_999.999;
export const DISPATCH_WORKING_OUT_MAX = 20_000;
export const DISPATCH_SKETCH_MAX = 400_000;
export const DISPATCH_SKETCH_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// The columns the list read takes from job_material_lines: enough for the
// count rule and nothing else (never a description, never the sketch table).
// S5 adds the line id, its quantity and when it went on its order, for the
// receipts rule (dispatch_line_receipts.ts).
export const DISPATCH_MATERIALS_LIST_SELECT =
  "job_id, status, purchase_order_id, id, quantity, purchase_order_attached_at";

// The single-job read's column lists. Verified against the live schema on
// 14 Oct 2026 (suppliers, purchase_orders); the three job_ tables are this
// slice's own migration.
export const DISPATCH_MATERIAL_SUPPLIER_SELECT =
  "supplier_id, supplier_name, position, created_at";
export const DISPATCH_MATERIAL_LINE_SELECT =
  "id, job_id, supplier_id, description, quantity, unit, status, purchase_order_id, source, position, updated_at, purchase_order_attached_at";
export const DISPATCH_SUPPLIER_CONTACT_SELECT =
  "id, org_id, name, email, is_active";
export const DISPATCH_WORKINGS_SELECT =
  "working_out, working_out_updated_at, sketch_png, sketch_updated_at";
// No price, total, account code or tax column is selected. Slice 5 adds the
// Dispatch order columns (docs/dispatch-slice-5-contract.md); xero_po_id is
// read only to answer in_xero and is never passed on.
export const DISPATCH_ORDER_SELECT =
  "id, po_number, supplier_name, status, created_at, updated_at, line_items, supplier_id, source, pdf_version, last_sent_pdf_version, last_sent_at, xero_po_id";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDispatchUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// ── Status and counts: the one rule ─────────────────────────────────────────

// Slice 6 (docs/dispatch-slice-6-contract.md): `sightedOrderIds` holds the
// ids of the job's orders whose delivery is sighted on site; a line on one of
// them is Delivered. Callers that read no orders pass none, and a line on an
// order stays On PO. S5: a caller that read the receipts passes the line view
// instead, and the view alone decides Delivered and Part delivered.
export function dispatchMaterialDisplayStatus(
  line:
    | { id?: unknown; status?: unknown; purchase_order_id?: unknown }
    | null
    | undefined,
  sightedOrderIds?: DispatchDeliveredInput,
): DispatchMaterialDisplayStatus {
  if (line?.purchase_order_id) {
    if (isLineDeliveryView(sightedOrderIds)) {
      const id = String(line.id ?? "");
      if (sightedOrderIds.delivered.has(id)) return "delivered";
      return sightedOrderIds.part.has(id) ? "part_delivered" : "on_po";
    }
    return sightedOrderIds?.has(String(line.purchase_order_id))
      ? "delivered"
      : "on_po";
  }
  const stored = String(line?.status ?? "");
  return (DISPATCH_MATERIAL_STORED_STATUSES as readonly string[]).includes(
      stored,
    )
    ? stored as DispatchMaterialStoredStatus
    : "not_reviewed";
}

export function isDispatchMaterialReady(
  line: any,
  sightedOrderIds?: DispatchDeliveredInput,
): boolean {
  return READY_DISPLAY_STATUSES.has(
    dispatchMaterialDisplayStatus(line, sightedOrderIds),
  );
}

export type DispatchMaterialCounts = { total: number; ready: number };

// `total` is every line; `ready` is every line whose display status is In
// stock or Delivered.
export function dispatchMaterialCounts(
  lines: any[] | null | undefined,
  sightedOrderIds?: DispatchDeliveredInput,
): DispatchMaterialCounts {
  const all = Array.isArray(lines) ? lines : [];
  return {
    total: all.length,
    ready: all.filter((line) => isDispatchMaterialReady(line, sightedOrderIds))
      .length,
  };
}

// The same rule, per job, for the Dispatch list. A job with no line is absent
// from the map; the list reads it as 0 and 0.
export function dispatchMaterialCountsByJob(
  lines: any[] | null | undefined,
  sightedOrderIds?: DispatchDeliveredInput,
): Map<string, DispatchMaterialCounts> {
  const grouped = new Map<string, any[]>();
  for (const line of Array.isArray(lines) ? lines : []) {
    const jobId = String(line?.job_id ?? "");
    if (!jobId) continue;
    const bucket = grouped.get(jobId);
    if (bucket) bucket.push(line);
    else grouped.set(jobId, [line]);
  }
  const counts = new Map<string, DispatchMaterialCounts>();
  for (const [jobId, jobLines] of grouped) {
    counts.set(jobId, dispatchMaterialCounts(jobLines, sightedOrderIds));
  }
  return counts;
}

// The two list fields for one row. Only called when the list's materials read
// worked: a failed read leaves both fields off (never 0).
export function dispatchMaterialListFields(
  counts: DispatchMaterialCounts | undefined,
): { materials_lines_total: number; materials_lines_ready: number } {
  return {
    materials_lines_total: counts?.total ?? 0,
    materials_lines_ready: counts?.ready ?? 0,
  };
}

// The suggestion is offered on a patio job with no line at all.
export function dispatchCanSuggest(
  workType: unknown,
  lineCount: number,
): boolean {
  return workType === "patio" && lineCount === 0;
}

// ── Projections for the read's answer ───────────────────────────────────────

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function projectDispatchMaterialLine(
  row: any,
  sightedOrderIds?: DispatchDeliveredInput,
) {
  const base = {
    id: row?.id,
    supplier_id: row?.supplier_id,
    description: row?.description,
    // numeric comes back from PostgREST as a number; keep it one.
    quantity: numberOrNull(row?.quantity),
    unit: row?.unit ?? null,
    status: row?.status,
    display_status: dispatchMaterialDisplayStatus(row, sightedOrderIds),
    purchase_order_id: row?.purchase_order_id ?? null,
    source: row?.source,
    position: row?.position,
    updated_at: row?.updated_at,
  };
  // S5: a line on an order, read with its receipts, carries what has arrived.
  // A line on no order is exactly as before.
  if (row?.purchase_order_id && isLineDeliveryView(sightedOrderIds)) {
    const id = String(row?.id ?? "");
    return {
      ...base,
      received_quantity: sightedOrderIds.received.get(id) ?? 0,
      receipts: sightedOrderIds.receipts.get(id) ?? [],
    };
  }
  return base;
}

// Slice 5: a line on an order also carries its order's number. `poNumbers` is
// purchase order id -> number, from the job's orders read.
export function projectDispatchMaterialLineOnOrder(
  row: any,
  poNumbers: Map<string, string | null>,
  sightedOrderIds?: DispatchDeliveredInput,
) {
  const line = projectDispatchMaterialLine(row, sightedOrderIds);
  return row?.purchase_order_id
    ? {
      ...line,
      po_number: poNumbers.get(String(row.purchase_order_id)) ?? null,
    }
    : line;
}

// A chosen supplier as the screen shows it: name and email from the contact as
// it is now; a contact that is gone or inactive falls back to the stored name,
// no email, and active false.
export function projectDispatchMaterialSupplier(chosen: any, contact: any) {
  const live = !!contact && contact.is_active === true;
  const email = live && typeof contact.email === "string" &&
      contact.email.trim()
    ? contact.email.trim()
    : null;
  return {
    supplier_id: chosen?.supplier_id,
    name: live && contact.name ? contact.name : chosen?.supplier_name,
    email,
    active: live,
    position: chosen?.position,
    added_at: chosen?.created_at,
  };
}

function plainText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

// A stored purchase order line flattened to item, quantity and unit. Live
// orders hold lines in six key shapes (every one has description and
// quantity, `unit` on some); no price, total, account or tax key is ever
// passed on.
export function flattenDispatchOrderLine(line: any) {
  const stored = line && typeof line === "object" && !Array.isArray(line)
    ? line
    : {};
  const quantity = typeof stored.quantity === "number"
    ? (Number.isFinite(stored.quantity) ? stored.quantity : null)
    : plainText(stored.quantity);
  // A Dispatch order line (slice 5) also carries the working line it copies.
  const lineId = typeof stored.line_id === "string" && stored.line_id
    ? { line_id: stored.line_id }
    : {};
  return {
    ...lineId,
    description: plainText(stored.description),
    quantity: quantity ?? null,
    unit: plainText(stored.unit),
  };
}

export function projectDispatchOrder(order: any) {
  return {
    id: order?.id,
    po_number: order?.po_number ?? null,
    supplier_name: order?.supplier_name ?? null,
    status: order?.status ?? null,
    created_at: order?.created_at ?? null,
    // The stamp Update, Take off and Cancel order send back as
    // expected_order_updated_at (slice 5): without it they are refused.
    updated_at: order?.updated_at ?? null,
    // Slice 5: an order made in Dispatch has a supplier_id and source
    // 'dispatch'; every other order has neither and stays in "Orders on this
    // job".
    supplier_id: order?.supplier_id ?? null,
    source: order?.source ?? null,
    pdf_version: order?.pdf_version ?? null,
    last_sent_pdf_version: order?.last_sent_pdf_version ?? null,
    last_sent_at: order?.last_sent_at ?? null,
    in_xero: !!order?.xero_po_id,
    lines: Array.isArray(order?.line_items)
      ? order.line_items.map(flattenDispatchOrderLine)
      : [],
  };
}

export function projectDispatchWorkings(row: any) {
  return {
    working_out: row?.working_out ?? null,
    working_out_updated_at: row?.working_out_updated_at ?? null,
    sketch_png: row?.sketch_png ?? null,
    sketch_updated_at: row?.sketch_updated_at ?? null,
  };
}

// ── Validation of what a caller sends ───────────────────────────────────────

export type DispatchFieldResult<T> = { ok: true; value: T } | {
  ok: false;
  error: string;
};

export function cleanDispatchDescription(
  value: unknown,
): DispatchFieldResult<string> {
  if (typeof value !== "string") {
    return { ok: false, error: "description must be text" };
  }
  const trimmed = value.trim();
  if (
    trimmed.length < 1 || trimmed.length > DISPATCH_MATERIAL_DESCRIPTION_MAX
  ) {
    return {
      ok: false,
      error:
        `description must be 1 to ${DISPATCH_MATERIAL_DESCRIPTION_MAX} characters`,
    };
  }
  return { ok: true, value: trimmed };
}

// A number 0 or more, or null. Anything else (a string included) is refused,
// never coerced to 0: the screen checks the cell and sends a number.
export function cleanDispatchQuantity(
  value: unknown,
): DispatchFieldResult<number | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ok: false, error: "quantity must be a number 0 or more, or null" };
  }
  if (value > DISPATCH_MATERIAL_QUANTITY_MAX) {
    return { ok: false, error: "quantity is too large" };
  }
  return { ok: true, value };
}

export function cleanDispatchUnit(
  value: unknown,
): DispatchFieldResult<string | null> {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: "unit must be text" };
  }
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > DISPATCH_MATERIAL_UNIT_MAX) {
    return {
      ok: false,
      error: `unit must be at most ${DISPATCH_MATERIAL_UNIT_MAX} characters`,
    };
  }
  return { ok: true, value: trimmed };
}

export function cleanDispatchStatus(
  value: unknown,
): DispatchFieldResult<DispatchMaterialStoredStatus> {
  if (
    typeof value === "string" &&
    (DISPATCH_MATERIAL_STORED_STATUSES as readonly string[]).includes(value)
  ) {
    return { ok: true, value: value as DispatchMaterialStoredStatus };
  }
  return {
    ok: false,
    error: `status must be one of ${
      DISPATCH_MATERIAL_STORED_STATUSES.join(", ")
    }`,
  };
}

export function cleanDispatchWorkingOut(
  value: unknown,
): DispatchFieldResult<string | null> {
  if (typeof value !== "string") {
    return { ok: false, error: "working_out must be text" };
  }
  if (value.length > DISPATCH_WORKING_OUT_MAX) {
    return {
      ok: false,
      error:
        `working_out must be at most ${DISPATCH_WORKING_OUT_MAX} characters`,
    };
  }
  // An empty string clears the pad.
  return { ok: true, value: value === "" ? null : value };
}

// A sketch is the canvas's own PNG as a data URL, or null to clear it. The
// decoded bytes must begin with the PNG signature.
export function cleanDispatchSketch(
  value: unknown,
): DispatchFieldResult<string | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !value.startsWith(DISPATCH_SKETCH_PREFIX)) {
    return {
      ok: false,
      error: `sketch_png must be null or start ${DISPATCH_SKETCH_PREFIX}`,
    };
  }
  if (value.length > DISPATCH_SKETCH_MAX) {
    return {
      ok: false,
      error: `sketch_png must be at most ${DISPATCH_SKETCH_MAX} characters`,
    };
  }
  const payload = value.slice(DISPATCH_SKETCH_PREFIX.length);
  let bytes: string;
  try {
    bytes = atob(payload);
  } catch {
    return { ok: false, error: "sketch_png is not valid base64" };
  }
  const isPng = bytes.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, index) => bytes.charCodeAt(index) === byte);
  if (!isPng) return { ok: false, error: "sketch_png is not a PNG" };
  return { ok: true, value };
}

// ── The scope suggestion ────────────────────────────────────────────────────

// extractMaterialsFromScope writes its descriptions with a long dash and a
// multiplication sign. A material line takes a comma and an `x` instead.
export function cleanSuggestedDescription(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/×/g, "x")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DISPATCH_MATERIAL_DESCRIPTION_MAX)
    .trim();
}

export type DispatchSuggestedLine = {
  description: string;
  quantity: number | null;
  unit: string | null;
};

// What the suggestion stores from each extracted item: the cleaned
// description, the quantity as given, the unit as given. `unit_price` and
// `notes` are never stored. An item with no usable description is dropped.
export function dispatchSuggestedLines(items: any[]): DispatchSuggestedLine[] {
  const out: DispatchSuggestedLine[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    const description = cleanSuggestedDescription(item?.description);
    if (!description) continue;
    // The extractor's counts are numbers, but a scope can hold a count as
    // text ("4"); read that as its number, and anything else as no quantity.
    const rawQuantity = typeof item?.quantity === "string" &&
        /^\s*\d+(\.\d+)?\s*$/.test(item.quantity)
      ? Number(item.quantity)
      : item?.quantity;
    const quantity = cleanDispatchQuantity(rawQuantity);
    const unit = cleanDispatchUnit(item?.unit);
    out.push({
      description,
      quantity: quantity.ok ? quantity.value : null,
      unit: unit.ok ? unit.value : null,
    });
  }
  return out;
}
