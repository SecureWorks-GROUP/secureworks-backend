// deno-lint-ignore-file no-explicit-any
// Dispatch S5: partial deliveries. The rules, pure.
// Contract: docs/dispatch-partial-deliveries-v1.md.
//
// What a line has received, whether it reads Delivered or Part delivered,
// whether an order is on site, and the rail line's words are worked out HERE
// ONLY. The dispatch_materials read, every Dispatch write's counts, the two
// receipt writes, the three slice 6 delivery writes and the pipeline&dispatch=1
// list all call these, so they cannot disagree. Nothing here is stored: the
// line's own status and quantity and the order's status are never written.

import {
  type DispatchLineDeliveryView,
  isDispatchUuid,
} from "./dispatch_materials.ts";
import {
  type DispatchPersonNames,
  isDispatchDeliveryCounted,
  isDispatchDeliveryDate,
  isDispatchOrderSighted,
} from "./dispatch_deliveries.ts";

// The receipt columns the read and the writes take. Verified against this
// slice's own migration (20261020180000_dispatch_line_receipts.sql).
export const DISPATCH_LINE_RECEIPT_SELECT =
  "id, org_id, job_id, line_id, purchase_order_id, quantity, received_on, note, created_at, created_by, created_by_email, voided_at, voided_by, voided_by_email";

// What the counts and the list need: live receipts only, no person, no note.
export const DISPATCH_LINE_RECEIPT_COUNT_SELECT =
  "id, job_id, line_id, purchase_order_id, quantity";

// The order columns the on-site rule reads.
export const DISPATCH_RECEIPT_ORDER_SELECT =
  "id, status, po_type, delivery_sighted_at";

export const DISPATCH_RECEIPT_NOTE_MAX = 300;
// numeric(12,3): nine whole digits.
export const DISPATCH_RECEIPT_QUANTITY_MAX = 999_999_999.999;

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Three decimal places, as numeric(12,3) keeps them; sums never drift.
function thousandths(value: number): number {
  return Math.round(value * 1000);
}

function fromThousandths(value: number): number {
  return value / 1000;
}

// A line's quantity counts only when it is above 0. A line with no quantity
// (null, or 0) can only be received in full: one live receipt delivers it.
export function dispatchLineHasQuantity(line: any): boolean {
  const quantity = numberOrNull(line?.quantity);
  return quantity !== null && quantity > 0;
}

function isLive(receipt: any): boolean {
  return !receipt?.voided_at;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function personName(
  id: unknown,
  email: unknown,
  names: DispatchPersonNames,
): string | null {
  const key = typeof id === "string" ? id : "";
  return (key && names.get(key)) || text(email);
}

// Every person id the receipts name, for the one users read.
export function dispatchReceiptPersonIds(receipts: any[]): string[] {
  const ids = new Set<string>();
  for (const receipt of receipts || []) {
    for (const id of [receipt?.created_by, receipt?.voided_by]) {
      if (typeof id === "string" && id) ids.add(id);
    }
  }
  return [...ids];
}

export type DispatchReceiptProjection = {
  id: string;
  quantity: number | null;
  received_on: string | null;
  note: string | null;
  recorded_at: string | null;
  recorded_by: string | null;
  voided: boolean;
  voided_at: string | null;
  voided_by: string | null;
};

export function projectDispatchReceipt(
  receipt: any,
  names: DispatchPersonNames = new Map(),
): DispatchReceiptProjection {
  const voided = !!receipt?.voided_at;
  return {
    id: String(receipt?.id ?? ""),
    quantity: numberOrNull(receipt?.quantity),
    received_on: receipt?.received_on ?? null,
    note: text(receipt?.note),
    recorded_at: receipt?.created_at ?? null,
    recorded_by: personName(
      receipt?.created_by,
      receipt?.created_by_email,
      names,
    ),
    voided,
    voided_at: voided ? String(receipt.voided_at) : null,
    voided_by: voided
      ? personName(receipt?.voided_by, receipt?.voided_by_email, names)
      : null,
  };
}

function oldestFirst(a: any, b: any): number {
  const at = String(a?.created_at ?? "");
  const bt = String(b?.created_at ?? "");
  if (at !== bt) return at < bt ? -1 : 1;
  const ai = String(a?.id ?? "");
  const bi = String(b?.id ?? "");
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

// The order's sighting covers a line only when the line was already on the
// order when it was sighted. A line put on the order later needs its own
// receipts (W1, 20 Oct 2026). A line with no stamp went on its order before
// S5 shipped, so its sighting covers it exactly as slice 6 read it.
export function dispatchSightingCoversLine(line: any, order: any): boolean {
  if (!isDispatchOrderSighted(order)) return false;
  const attached = line?.purchase_order_attached_at;
  if (attached === null || attached === undefined || attached === "") {
    return true;
  }
  const attachedMs = Date.parse(String(attached));
  const sightedMs = Date.parse(String(order.delivery_sighted_at));
  if (!Number.isFinite(attachedMs) || !Number.isFinite(sightedMs)) {
    return false;
  }
  return attachedMs <= sightedMs;
}

export type DispatchLineDelivery = DispatchLineDeliveryView & {
  // Order ids on site: sighted with every line covered, or every line on it
  // Delivered by its receipts. Counted orders only.
  onSiteOrderIds: ReadonlySet<string>;
  // Order id -> how many of its lines read Part delivered.
  partByOrder: ReadonlyMap<string, number>;
};

// The one rule. `lines` are the job's material lines (any that sit on an
// order matter), `orders` the job's orders, `receipts` the job's receipts
// (voided ones are kept for the screen and never counted). A receipt counts
// only for the order its line sits on now: a line taken off an order and put
// on another starts again.
export function dispatchLineDeliveryView(
  lines: any[] | null | undefined,
  orders: any[] | null | undefined,
  receipts: any[] | null | undefined,
  names: DispatchPersonNames = new Map(),
): DispatchLineDelivery {
  const orderById = new Map<string, any>();
  for (const order of orders || []) {
    if (order?.id) orderById.set(String(order.id), order);
  }
  const byLine = new Map<string, any[]>();
  for (const receipt of [...(receipts || [])].sort(oldestFirst)) {
    const key = String(receipt?.line_id ?? "");
    if (!key) continue;
    const bucket = byLine.get(key);
    if (bucket) bucket.push(receipt);
    else byLine.set(key, [receipt]);
  }

  const delivered = new Set<string>();
  const part = new Set<string>();
  const received = new Map<string, number>();
  const projected = new Map<string, unknown[]>();
  const linesByOrder = new Map<string, string[]>();

  for (const line of lines || []) {
    const orderId = line?.purchase_order_id
      ? String(line.purchase_order_id)
      : "";
    const id = String(line?.id ?? "");
    if (!orderId || !id) continue;
    const onOrder = (byLine.get(id) || []).filter((r) =>
      String(r?.purchase_order_id ?? "") === orderId
    );
    const live = onOrder.filter(isLive);
    const total = live.reduce(
      (sum, r) => sum + thousandths(numberOrNull(r?.quantity) ?? 0),
      0,
    );
    received.set(id, fromThousandths(total));
    projected.set(id, onOrder.map((r) => projectDispatchReceipt(r, names)));
    const bucket = linesByOrder.get(orderId);
    if (bucket) bucket.push(id);
    else linesByOrder.set(orderId, [id]);

    const covered = dispatchSightingCoversLine(line, orderById.get(orderId));
    const complete = dispatchLineHasQuantity(line)
      ? total >= thousandths(Number(line.quantity))
      : live.length > 0;
    if (covered || complete) delivered.add(id);
    else if (total > 0) part.add(id);
  }

  const onSiteOrderIds = new Set<string>();
  const partByOrder = new Map<string, number>();
  for (const order of orders || []) {
    if (!isDispatchDeliveryCounted(order)) continue;
    const orderId = String(order.id);
    const lineIds = linesByOrder.get(orderId) || [];
    const partCount = lineIds.filter((id) => part.has(id)).length;
    if (partCount > 0) partByOrder.set(orderId, partCount);
    const onSite = lineIds.length === 0
      ? isDispatchOrderSighted(order)
      : lineIds.every((id) => delivered.has(id));
    if (onSite) onSiteOrderIds.add(orderId);
  }

  return {
    delivered,
    part,
    received,
    receipts: projected,
    onSiteOrderIds,
    partByOrder,
  };
}

export type DispatchOnSiteSummary = {
  on_site: number;
  all_on_site: boolean;
  lines_part_delivered: number;
};

// The summary beside slice 6's counted / sighted / all_sighted.
export function dispatchOnSiteSummary(
  orders: any[] | null | undefined,
  view: Pick<DispatchLineDelivery, "onSiteOrderIds" | "partByOrder">,
): DispatchOnSiteSummary {
  const counted = (orders || []).filter(isDispatchDeliveryCounted);
  const onSite =
    counted.filter((o) => view.onSiteOrderIds.has(String(o.id))).length;
  let part = 0;
  for (const order of counted) {
    part += view.partByOrder.get(String(order.id)) ?? 0;
  }
  return {
    on_site: onSite,
    all_on_site: counted.length > 0 && onSite === counted.length,
    lines_part_delivered: part,
  };
}

// ── What a caller sends ─────────────────────────────────────────────────────

export type DispatchReceiptInput = {
  id: string;
  lineId: string;
  quantity: number;
  receivedOn: string;
  note: string | null;
};

export type DispatchReceiptCheck =
  | { ok: true; value: DispatchReceiptInput }
  | { ok: false; error: string };

// Today in Perth, YYYY-MM-DD.
export function dispatchPerthToday(nowIso: string): string {
  const ms = Date.parse(nowIso);
  const perth = new Date(
    (Number.isFinite(ms) ? ms : Date.now()) + 8 * 3600_000,
  );
  return perth.toISOString().slice(0, 10);
}

export function cleanDispatchReceipt(
  body: any,
  nowIso: string,
): DispatchReceiptCheck {
  const id = body?.client_receipt_id;
  if (!isDispatchUuid(id)) {
    return { ok: false, error: "client_receipt_id must be a uuid" };
  }
  const lineId = body?.line_id;
  if (!isDispatchUuid(lineId)) {
    return { ok: false, error: "line_id must be a uuid" };
  }
  const quantity = body?.quantity;
  if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
    return { ok: false, error: "quantity must be a number above 0" };
  }
  if (quantity <= 0 || thousandths(quantity) <= 0) {
    return { ok: false, error: "quantity must be a number above 0" };
  }
  if (quantity > DISPATCH_RECEIPT_QUANTITY_MAX) {
    return { ok: false, error: "quantity is too large" };
  }
  const receivedOn = body?.received_on;
  if (!isDispatchDeliveryDate(receivedOn)) {
    return { ok: false, error: "received_on must be a real date YYYY-MM-DD" };
  }
  if (receivedOn > dispatchPerthToday(nowIso)) {
    return { ok: false, error: "received_on cannot be after today" };
  }
  let note: string | null = null;
  if (body?.note !== undefined && body?.note !== null) {
    if (typeof body.note !== "string") {
      return { ok: false, error: "note must be text" };
    }
    const trimmed = body.note.trim();
    if (trimmed.length > DISPATCH_RECEIPT_NOTE_MAX) {
      return {
        ok: false,
        error: `note must be at most ${DISPATCH_RECEIPT_NOTE_MAX} characters`,
      };
    }
    note = trimmed || null;
  }
  return {
    ok: true,
    value: {
      id,
      lineId,
      quantity: fromThousandths(thousandths(quantity)),
      receivedOn,
      note,
    },
  };
}

// Over the line's quantity is allowed (suppliers over-supply), with a warning.
export function dispatchReceiptWarning(
  line: any,
  receivedBefore: number,
  quantity: number,
): { code: "over_quantity"; ordered: number; received: number } | null {
  if (!dispatchLineHasQuantity(line)) return null;
  const ordered = thousandths(Number(line.quantity));
  const after = thousandths(receivedBefore) + thousandths(quantity);
  return after > ordered
    ? {
      code: "over_quantity",
      ordered: fromThousandths(ordered),
      received: fromThousandths(after),
    }
    : null;
}
