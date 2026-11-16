// deno-lint-ignore-file no-explicit-any
// Ruling 17 step 3 (backend half): Dispatch lines carry their cost from the job
// budget. Contract: docs/job-budget-v1.md, "Dispatch lines carry cost (step 3)".
//
// The one place for the rule. Every Dispatch read and press that shows, checks
// or records a line's cost goes through these functions:
//
//   - readDispatchBudget: the job's current stored budget (job_budgets, newest
//     version), its materials lines as sealed, or null when it has none.
//   - readDispatchOrder / dispatchOrderFillLines: the order lines the sealed
//     order list gives (ruling 17b: the sealed order row is the order; the
//     budget adds dollars only), each naming the budget line by its key.
//   - dispatchLineCost: a line's unit cost, line cost and basis, and whether it
//     may be ordered as it stands or needs a named person's reason.
//   - dispatchOrderCost: the record of an order's cost kept beside its email.
//
// A line is costed from the budget line it names (job_material_lines.budget_id
// + budget_line_key). Its unit cost is the budget's; its line cost is that unit
// cost times the quantity ordered, in whole cents. A line may be ordered as it
// stands only when it is at or under its budget line's quantity, in the same
// unit, with a cost the budget gives. Anything else (over the budget quantity,
// a different unit, a budget line with no cost, a line not in the budget) is
// ordered only with a reason a signed-in person gave for that quantity, and,
// where the budget gives no unit cost, the unit cost they gave. It is never $0
// and never silently over. A materials figure the budget priced as one figure
// (priced_by_line false) has no per-line dollars: such a line is ordered at or
// under its budget quantity with its cost shown as part of the one figure.
//
// Nothing here prints a dollar on a supplier email: the email body is built
// from the line text only (dispatch_v2_emails.ts dispatchV2LineText).

import {
  cleanDispatchQuantity,
  cleanDispatchUnit,
  cleanSuggestedDescription,
} from "./dispatch_materials.ts";
import { jsonHash } from "../_shared/release_packet/canonicalize.ts";

export const DISPATCH_BUDGET_COST_FLAG = "dispatch_budget_cost_v1";
export const DISPATCH_ORDER_COST_VERSION = "dispatch-order-cost.v1";
/** The longest supplier note a line holds (job_material_lines.detail). */
export const DISPATCH_SUPPLIER_NOTE_MAX = 300;
export const DISPATCH_COST_REASON_MIN = 3;
export const DISPATCH_COST_REASON_MAX = 500;

// ── The budget ──────────────────────────────────────────────────────────────

export type DispatchBudgetLine = {
  key: string;
  line_id: string | null;
  kind: "item" | "delivery" | "cutting" | null;
  supplier_key: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  /** A readable copy only (ruling 17b): Dispatch never builds a line from it. */
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unit_cost_ex_gst: number | null;
  line_cost_ex_gst: number | null;
  in_total: boolean;
  cost_from: string | null;
};

export type DispatchBudgetSupplier = {
  key: string;
  supplier_id: string | null;
  supplier_name: string | null;
  lines_ex_gst: number | null;
  surcharge_ex_gst: number | null;
  delivery_ex_gst: number | null;
  total_ex_gst: number | null;
};

export type DispatchBudget = {
  id: string;
  job_id: string;
  scope_revision_id: string;
  version: number;
  trade: string;
  /** The sealed pricing bytes' hash the budget was stored from. */
  pricing_hash: string | null;
  /** The quote options the customer took (budget.v1 taken_option_ids). */
  taken_option_ids: string[];
  /** False: the budget priced all materials as one figure (T1). */
  priced_by_line: boolean;
  /** One figure for all materials, when priced_by_line is false. */
  one_figure_ex_gst: number | null;
  materials_ex_gst: number | null;
  lines: DispatchBudgetLine[];
  by_supplier: DispatchBudgetSupplier[];
};

export class DispatchBudgetReadError extends Error {}

function rec(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t : null;
}

function money(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A stored budget record (job_budgets.budget, budget.v1) read for Dispatch. */
export function dispatchBudgetFromRecord(
  row: {
    id: string;
    job_id: string;
    scope_revision_id: string;
    version: number;
    trade: string;
    pricing_hash?: string | null;
    budget: unknown;
  },
): DispatchBudget {
  const b = rec(row.budget);
  const materials = rec(b.materials);
  const rawLines = Array.isArray(materials.lines) ? materials.lines : [];
  const lines: DispatchBudgetLine[] = rawLines.flatMap((raw: unknown) => {
    const l = rec(raw);
    const key = text(l.key);
    if (!key) return [];
    const supplier = rec(l.supplier);
    const kind = l.kind === "item" || l.kind === "delivery" || l.kind === "cutting" ? l.kind : null;
    return [{
      key,
      line_id: text(l.line_id),
      kind,
      supplier_key: text(l.supplier_key),
      supplier_id: text(supplier.id),
      supplier_name: text(supplier.name),
      description: text(l.description),
      quantity: money(l.quantity),
      unit: text(l.unit),
      unit_cost_ex_gst: money(l.unit_cost_ex_gst),
      line_cost_ex_gst: money(l.line_cost_ex_gst),
      in_total: l.in_total === true,
      cost_from: text(l.cost_from),
    }];
  });
  const bySupplier = (Array.isArray(materials.by_supplier) ? materials.by_supplier : [])
    .flatMap((raw: unknown) => {
      const e = rec(raw);
      const key = text(e.key);
      if (!key) return [];
      const supplier = rec(e.supplier);
      return [{
        key,
        supplier_id: text(supplier.id),
        supplier_name: text(supplier.name),
        lines_ex_gst: money(e.lines_ex_gst),
        surcharge_ex_gst: money(e.surcharge_ex_gst),
        delivery_ex_gst: money(e.delivery_ex_gst),
        total_ex_gst: money(e.total_ex_gst),
      }];
    });
  const pricedByLine = materials.priced_by_line !== false;
  const oneFigure = pricedByLine
    ? null
    : lines.find((l) => l.in_total && l.cost_from === "one_figure")?.line_cost_ex_gst ?? null;
  return {
    id: row.id,
    job_id: row.job_id,
    scope_revision_id: row.scope_revision_id,
    version: Number(row.version),
    trade: String(row.trade),
    pricing_hash: text(row.pricing_hash),
    taken_option_ids: Array.isArray(b.taken_option_ids)
      ? b.taken_option_ids.filter((id: unknown): id is string => typeof id === "string")
      : [],
    priced_by_line: pricedByLine,
    one_figure_ex_gst: oneFigure,
    materials_ex_gst: money(materials.total_ex_gst),
    lines,
    by_supplier: bySupplier,
  };
}

/**
 * The job's current stored budget: the newest version in job_budgets. Null
 * when the job has none. A failed read throws DispatchBudgetReadError: a
 * caller never treats an unreadable budget as "no budget".
 */
export async function readDispatchBudget(client: any, jobId: string): Promise<DispatchBudget | null> {
  const { data, error } = await client.from("job_budgets")
    .select("id, job_id, scope_revision_id, version, trade, pricing_hash, budget")
    .eq("job_id", jobId)
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw new DispatchBudgetReadError(String(error?.message ?? "job budget read failed"));
  const row = Array.isArray(data) ? data[0] : null;
  return row ? dispatchBudgetFromRecord(row) : null;
}

/**
 * The switch as stored. `off` is an explicit false or no row (Dispatch then
 * runs exactly as it did before step 3); `unreadable` is a failed read, which
 * every caller refuses (writes) or names (reads), never treats as off: a read
 * fault must never let an uncosted order through while the switch is on.
 */
export type DispatchBudgetCostSwitch = "on" | "off" | "unreadable";

export async function readDispatchBudgetCostSwitch(client: any): Promise<DispatchBudgetCostSwitch> {
  try {
    const { data, error } = await client.from("feature_flags").select("enabled")
      .eq("flag_name", DISPATCH_BUDGET_COST_FLAG).limit(1);
    if (error) return "unreadable";
    if (!Array.isArray(data)) return "unreadable";
    return data[0]?.enabled === true ? "on" : "off";
  } catch {
    return "unreadable";
  }
}

// ── The sealed order list (ruling 17b, addendum 17b-1) ─────────────────────
//
// What is ordered is the sealed order list: `order` (order.v1) at the top of
// the sealed revision's pricing bytes, beside `budget`, one row for every row
// the supplier copies print. A row's `id` is the key of the budget materials
// line that holds its money. Dispatch builds each line from a row and takes
// only the unit cost and line cost from that budget line. A revision sealed
// before order.v1 has no `order`: Dispatch keeps today's path for it.

export const DISPATCH_ORDER_VERSION = "order.v1";

export type DispatchOrderCut = { length_mm: number; qty: number };

export type DispatchOrderRow = {
  id: string;
  scope_line_id: string | null;
  /** A quote option's row: ordered only when the customer took that option. */
  option_id: string | null;
  kind: "item" | "delivery" | "cutting";
  supplier_id: string | null;
  supplier_name: string | null;
  supplier_code: string | null;
  /** As the supplier copy prints it. */
  description: string;
  quantity: number | null;
  unit: string | null;
  stock_length_mm: number | null;
  /** The stock length is the supplier's to confirm (no product on file). */
  stock_to_confirm: boolean;
  cuts: DispatchOrderCut[];
  /** The supplier copy's own cut words, used only when cuts is empty. */
  cut: string | null;
  profile: string | null;
  colour: string | null;
  variant: string | null;
  finish: string | null;
  gauge_mm: number | null;
  girth_mm: number | null;
  note_to_supplier: string | null;
  cost_by: "line" | "one_figure" | "allowance";
};

export type DispatchOrder = { rows: DispatchOrderRow[] };

/** The sealed order list is there but cannot be used: never filled from, never ignored. */
export class DispatchOrderShapeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// A physical measure: a positive finite number, else absent (never zero).
function measure(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function cutsOf(value: unknown): DispatchOrderCut[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw: unknown) => {
    const c = rec(raw);
    const length = measure(c.length_mm);
    const qty = measure(c.qty);
    return length !== null && qty !== null ? [{ length_mm: length, qty }] : [];
  });
}

/**
 * The sealed order list in a sealed pricing record, or null when the record
 * has none (sealed before order.v1). An `order` that is there but not an
 * order.v1 list of usable rows throws DispatchOrderShapeError.
 */
export function dispatchOrderFromPricing(pricing: unknown): DispatchOrder | null {
  const p = rec(pricing);
  if (!Object.prototype.hasOwnProperty.call(p, "order")) return null;
  const o = p.order;
  if (!o || typeof o !== "object" || Array.isArray(o) || o.version !== DISPATCH_ORDER_VERSION || !Array.isArray(o.rows)) {
    throw new DispatchOrderShapeError("order_version_unknown");
  }
  const rows = (o.rows as unknown[]).map((raw): DispatchOrderRow => {
    const r = rec(raw);
    const id = text(r.id);
    const description = text(r.description);
    const kind = r.kind === "item" || r.kind === "delivery" || r.kind === "cutting" ? r.kind : null;
    const costBy = r.cost_by === "line" || r.cost_by === "one_figure" || r.cost_by === "allowance" ? r.cost_by : null;
    if (!id || !description || !kind || !costBy) throw new DispatchOrderShapeError("order_row_unreadable");
    const supplier = r.supplier && typeof r.supplier === "object" ? rec(r.supplier) : {};
    return {
      id,
      scope_line_id: text(r.scope_line_id),
      option_id: text(r.option_id),
      kind,
      supplier_id: text(supplier.id),
      supplier_name: text(supplier.name),
      supplier_code: text(r.supplier_code),
      description,
      quantity: money(r.quantity),
      unit: text(r.unit),
      stock_length_mm: measure(r.stock_length_mm),
      stock_to_confirm: r.stock_to_confirm === true,
      cuts: cutsOf(r.cuts),
      cut: text(r.cut),
      profile: text(r.profile),
      colour: text(r.colour),
      variant: text(r.variant),
      finish: text(r.finish),
      gauge_mm: measure(r.gauge_mm),
      girth_mm: measure(r.girth_mm),
      note_to_supplier: text(r.note_to_supplier),
      cost_by: costBy,
    };
  });
  return { rows };
}

/**
 * The sealed order list of the revision a budget was stored from: its pricing
 * bytes re-hashed, and the hash the budget was stored from. Null when that
 * revision has no `order`. A failed read throws DispatchBudgetReadError
 * (retry); a missing revision, bytes that do not match their hash or the
 * budget's, or an unusable `order` throws DispatchOrderShapeError.
 */
export async function readDispatchOrder(client: any, budget: DispatchBudget): Promise<DispatchOrder | null> {
  const { data, error } = await client.from("scope_revisions")
    .select("id, pricing_canonical_text, pricing_hash")
    .eq("id", budget.scope_revision_id)
    .maybeSingle();
  if (error) throw new DispatchBudgetReadError(String(error?.message ?? "sealed revision read failed"));
  if (!data || typeof data.pricing_canonical_text !== "string") {
    throw new DispatchOrderShapeError("order_revision_missing");
  }
  let pricing: unknown;
  try {
    pricing = JSON.parse(data.pricing_canonical_text);
  } catch {
    throw new DispatchOrderShapeError("order_pricing_unreadable");
  }
  if (await jsonHash(pricing) !== data.pricing_hash || (budget.pricing_hash && budget.pricing_hash !== data.pricing_hash)) {
    throw new DispatchOrderShapeError("order_pricing_hash_mismatch");
  }
  return dispatchOrderFromPricing(pricing);
}

// ── Filling from the sealed order list ──────────────────────────────────────

export type DispatchOrderFillLine = {
  description: string;
  quantity: number | null;
  unit: string | null;
  /** What the supplier copy prints under the line. */
  detail: string | null;
  profile: string | null;
  colour: string | null;
  /** The take-off line it comes from (source_line_id), or null. */
  scope_line_id: string | null;
  supplier_key: string | null;
  supplier_name: string | null;
  /** The budget line that holds its money. */
  budget_line_key: string;
};

/** Why a sealed order cannot be filled as it stands. */
export type DispatchOrderHoldCode =
  /** A row costed by its own line has no budget line by its id. */
  | "order_row_no_budget_line"
  /** A row costed by its own line whose budget line has no cost. */
  | "order_row_no_cost"
  /** A row covered by the one figure, in a budget with no one figure. */
  | "order_row_no_one_figure"
  /** A row covered by the fixings allowance, in a budget with no single allowance. */
  | "order_row_no_allowance"
  /** A budget materials item line no order row names. */
  | "budget_line_no_order_row"
  /** Two budget lines on one key. */
  | "budget_key_duplicated"
  /** Two order rows on one id. */
  | "order_row_duplicated"
  /** A note to the supplier longer than a line holds. */
  | "supplier_note_too_long"
  /** Order detail, a profile or a colour longer than a line holds. */
  | "order_detail_too_long";

export type DispatchOrderHold = { code: DispatchOrderHoldCode; key: string };

export type DispatchOrderFill =
  | { ok: true; lines: DispatchOrderFillLine[]; notes: string[] }
  | { ok: false; holds: DispatchOrderHold[] };

/** The longest profile or colour a line holds (job_material_lines). */
export const DISPATCH_PROFILE_MAX = 80;

// Millimetres as the supplier copy writes a length: whole, with a thousands
// comma ("8,000 mm"); a fraction keeps up to two decimal places (a 0.42 gauge).
function mm(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const [whole, frac] = String(rounded).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${grouped}${frac ? `.${frac}` : ""} mm`;
}

function count(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * The order detail a sealed order row prints under itself: its supplier code,
 * stock length (or that the supplier confirms it), cuts, variant, finish,
 * gauge and girth, then the note to the supplier. Profile and colour have
 * their own fields. Only what the row states; nothing is made up.
 */
export function dispatchOrderRowDetail(row: DispatchOrderRow): string | null {
  const parts: string[] = [];
  if (row.supplier_code) parts.push(`Code: ${row.supplier_code}`);
  if (row.stock_length_mm !== null) parts.push(`Length: ${mm(row.stock_length_mm)}`);
  else if (row.stock_to_confirm) parts.push("Stock length: supplier to confirm");
  if (row.cuts.length) {
    parts.push(`Cuts: ${row.cuts.map((c) => `${count(c.qty)} x ${mm(c.length_mm)}`).join(", ")}`);
  } else if (row.cut) {
    parts.push(`Cuts: ${row.cut}`);
  }
  if (row.variant) parts.push(`Variant: ${row.variant}`);
  if (row.finish) parts.push(`Finish: ${row.finish}`);
  if (row.gauge_mm !== null) parts.push(`Gauge: ${mm(row.gauge_mm)}`);
  if (row.girth_mm !== null) parts.push(`Girth: ${mm(row.girth_mm)}`);
  if (row.note_to_supplier) parts.push(row.note_to_supplier);
  return parts.length ? parts.join("\n") : null;
}

// No supplier to order from: the office's own fixings and the catalogue's
// placeholder (scope_engine_materials.ts keeps the same two).
const NO_SUPPLIER = new Set(["office", "supplier-to-confirm"]);

// The budget entries no order row is for: the one figure for all materials
// (T1) and the fixings allowance (T2).
function coversOthers(l: DispatchBudgetLine): boolean {
  return l.supplier_key === "one_figure" || l.cost_from === "allowance";
}

/**
 * The order lines a sealed order list gives, in its order: one line per row,
 * delivery and cutting rows included (the supplier copy prints them), a quote
 * option's rows only when the customer took that option. Each
 * names the budget line that holds its money. Anything that does not join
 * holds the whole fill with a reason code per row or budget line: never a $0
 * line, never a line without its detail, never one silently dropped.
 */
export function dispatchOrderFillLines(order: DispatchOrder, budget: DispatchBudget): DispatchOrderFill {
  const holds: DispatchOrderHold[] = [];
  const byKey = new Map<string, DispatchBudgetLine>();
  for (const l of budget.lines) {
    if (byKey.has(l.key)) holds.push({ code: "budget_key_duplicated", key: l.key });
    else byKey.set(l.key, l);
  }
  const aggregate = budget.lines.filter((l) => l.supplier_key === "one_figure");
  const allowance = budget.lines.filter((l) => l.cost_from === "allowance");
  const rowIds = new Set<string>();
  const lines: DispatchOrderFillLine[] = [];
  const unplaced: string[] = [];
  let oneFigureRows = 0;
  let allowanceRows = 0;
  for (const row of order.rows) {
    if (rowIds.has(row.id)) {
      holds.push({ code: "order_row_duplicated", key: row.id });
      continue;
    }
    rowIds.add(row.id);
    // A row of an option the customer did not take is not ordered.
    if (row.option_id !== null && !budget.taken_option_ids.includes(row.option_id)) continue;
    let link: DispatchBudgetLine | null = byKey.get(row.id) ?? null;
    if (row.cost_by === "line") {
      if (!link) {
        holds.push({ code: "order_row_no_budget_line", key: row.id });
        continue;
      }
      if (link.unit_cost_ex_gst === null && !(link.line_cost_ex_gst !== null && link.in_total)) {
        holds.push({ code: "order_row_no_cost", key: row.id });
        continue;
      }
    } else if (row.cost_by === "one_figure") {
      link ??= aggregate.length === 1 ? aggregate[0] : null;
      if (!link) {
        holds.push({ code: "order_row_no_one_figure", key: row.id });
        continue;
      }
      oneFigureRows += 1;
    } else {
      link ??= allowance.length === 1 ? allowance[0] : null;
      if (!link) {
        holds.push({ code: "order_row_no_allowance", key: row.id });
        continue;
      }
      allowanceRows += 1;
    }
    if (row.note_to_supplier && row.note_to_supplier.length > DISPATCH_SUPPLIER_NOTE_MAX) {
      holds.push({ code: "supplier_note_too_long", key: row.id });
      continue;
    }
    // The length, cuts, profile and colour are what tell two rows of one
    // section apart (two 90x90 stock lengths): never cut one short.
    const detail = dispatchOrderRowDetail(row);
    if (
      (detail && detail.length > DISPATCH_SUPPLIER_NOTE_MAX) ||
      (row.profile && row.profile.length > DISPATCH_PROFILE_MAX) ||
      (row.colour && row.colour.length > DISPATCH_PROFILE_MAX)
    ) {
      holds.push({ code: "order_detail_too_long", key: row.id });
      continue;
    }
    const description = cleanSuggestedDescription(row.description);
    const quantity = cleanDispatchQuantity(row.quantity);
    const unit = cleanDispatchUnit(row.unit);
    const placed = (row.supplier_id !== null || row.supplier_name !== null) &&
      !(row.supplier_id && NO_SUPPLIER.has(row.supplier_id.toLowerCase()));
    if (!placed) unplaced.push(description);
    lines.push({
      description,
      quantity: quantity.ok ? quantity.value : null,
      unit: unit.ok ? unit.value : null,
      detail,
      profile: row.profile,
      colour: row.colour,
      scope_line_id: row.scope_line_id && row.scope_line_id.length <= 100 ? row.scope_line_id : null,
      supplier_key: placed ? (row.supplier_id ?? row.supplier_name) : null,
      supplier_name: placed ? row.supplier_name : null,
      budget_line_key: link.key,
    });
  }
  for (const l of budget.lines) {
    if (l.kind === "item" && !coversOthers(l) && !rowIds.has(l.key)) {
      holds.push({ code: "budget_line_no_order_row", key: l.key });
    }
  }
  if (holds.length) return { ok: false, holds };
  const notes = [
    `These lines come from the sealed order list, costed from the job budget (version ${budget.version}).`,
  ];
  if (unplaced.length) {
    notes.push(`${unplaced.length === 1 ? "1 line has" : `${unplaced.length} lines have`} no supplier in the sealed order, so ${unplaced.length === 1 ? "it is" : "they are"} on the draft list: ${unplaced.join(", ")}.`);
  }
  if (oneFigureRows) {
    notes.push("The budget priced the materials as one figure, so those lines carry no dollars of their own.");
  }
  if (allowanceRows) {
    notes.push("The fixings allowance covers the fixings lines, so they carry no dollars of their own.");
  }
  return { ok: true, lines, notes };
}

/** Plain words for a hold, by code. */
export function dispatchOrderHoldWords(holds: DispatchOrderHold[]): string {
  const say: Record<DispatchOrderHoldCode, string> = {
    order_row_no_budget_line: "a line has no line in the job budget",
    order_row_no_cost: "a line's budget line has no cost",
    order_row_no_one_figure: "a line covered by one figure, in a budget with no one figure",
    order_row_no_allowance: "a fixings line, in a budget with no fixings allowance",
    budget_line_no_order_row: "a budget line is on no sealed order line",
    budget_key_duplicated: "two budget lines share one key",
    order_row_duplicated: "two sealed order lines share one id",
    supplier_note_too_long: `a note to the supplier is longer than ${DISPATCH_SUPPLIER_NOTE_MAX} characters`,
    order_detail_too_long: "a line has more order detail than a line holds",
  };
  const codes = [...new Set(holds.map((h) => h.code))];
  return `The sealed order is held, so the list was not filled: ${codes.map((c) => say[c]).join("; ")}. Fix it in the quote tool.`;
}

// ── A line's cost ───────────────────────────────────────────────────────────

/** Why a line is costed the way it is. */
export type DispatchCostBasis =
  /** At or under its budget line, same unit, the budget's unit cost. */
  | "budget"
  /** At or under its budget line in a budget priced as one figure, or covered by the one figure. */
  | "one_figure"
  /** Covered by the fixings allowance (no dollars of its own). */
  | "allowance"
  /** More than its budget line's quantity. */
  | "over_budget"
  /** Not in its budget line's unit, so the budget's unit cost does not apply. */
  | "unit_changed"
  /** A budget line costed as a whole (no unit cost) ordered at another quantity. */
  | "quantity_changed"
  /** Its budget line has no cost (not bought before, left to enter). */
  | "no_budget_cost"
  /** Names no line of the job's budget (typed in, or from an older budget). */
  | "not_in_budget"
  /** No quantity, so no cost can be worked out. */
  | "quantity_missing";

export type DispatchLineReason = {
  id: string;
  basis: string;
  reason: string;
  quantity: number;
  unit: string | null;
  unit_cost_ex_gst: number | null;
  given_by: string;
  given_by_email: string | null;
  given_at: string;
};

export type DispatchLineCost = {
  basis: DispatchCostBasis;
  budget_line_key: string | null;
  budget_quantity: number | null;
  budget_unit: string | null;
  budget_unit_cost_ex_gst: number | null;
  /** The unit cost the order uses (the budget's, else the reason's), or null. */
  unit_cost_ex_gst: number | null;
  /** Unit cost times quantity in whole cents, or the budget line's whole cost. */
  line_cost_ex_gst: number | null;
  /** Where the cost came from. */
  cost_from: "budget" | "reason" | "one_figure" | "allowance" | null;
  /** The line needs a named person's reason before it is ordered. */
  needs_reason: boolean;
  /** That reason must also give a unit cost (the budget gives none that applies). */
  needs_unit_cost: boolean;
  /** The line's current reason, when it covers this quantity and unit. */
  reason: DispatchLineReason | null;
  /** The line may go on an order as it stands. */
  resolved: boolean;
  /** Plain words for the screen. */
  words: string;
};

function sameUnit(a: string | null, b: string | null): boolean {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

/** Unit cost (dollars) times a quantity (to three decimals), in whole cents. */
export function dispatchLineCostCents(unitCost: number, quantity: number): number {
  const unitCents = Math.round(unitCost * 100);
  const milli = Math.round(quantity * 1000);
  return Math.floor((unitCents * milli + 500) / 1000);
}

function dollars(cents: number): number {
  return cents / 100;
}

/**
 * A line's cost against the job's budget. line: a job_material_lines row
 * (quantity, unit, budget_id, budget_line_key). reason: the row its
 * cost_reason_id names, or null.
 */
export function dispatchLineCost(
  line: { quantity: unknown; unit: unknown; budget_id?: unknown; budget_line_key?: unknown },
  budget: DispatchBudget,
  reason: DispatchLineReason | null,
): DispatchLineCost {
  const quantity = money(line.quantity);
  const unit = text(line.unit);
  const linked = String(line.budget_id ?? "") === budget.id
    ? budget.lines.find((l) => l.key === line.budget_line_key) ?? null
    : null;
  const base = {
    budget_line_key: linked?.key ?? null,
    budget_quantity: linked?.quantity ?? null,
    budget_unit: linked?.unit ?? null,
    budget_unit_cost_ex_gst: linked?.unit_cost_ex_gst ?? null,
  };
  const make = (
    basis: DispatchCostBasis,
    budgetUnitCost: number | null,
    needsReason: boolean,
    words: string,
    whole: number | null = null,
  ): DispatchLineCost => {
    const needsUnitCost = needsReason && budgetUnitCost === null;
    const covers = !!reason && quantity !== null &&
      reason.quantity + 1e-9 >= quantity && sameUnit(reason.unit, unit) &&
      (!needsUnitCost || reason.unit_cost_ex_gst !== null);
    const ok = needsReason ? covers : basis !== "quantity_missing";
    const unitCost = needsReason && covers && reason!.unit_cost_ex_gst !== null
      ? reason!.unit_cost_ex_gst
      : budgetUnitCost;
    const lineCost = whole !== null && !needsReason
      ? whole
      : unitCost !== null && quantity !== null
      ? dollars(dispatchLineCostCents(unitCost, quantity))
      : null;
    return {
      basis,
      ...base,
      unit_cost_ex_gst: unitCost,
      line_cost_ex_gst: lineCost,
      cost_from: basis === "one_figure"
        ? "one_figure"
        : basis === "allowance"
        ? "allowance"
        : lineCost === null
        ? null
        : needsReason && covers && reason!.unit_cost_ex_gst !== null
        ? "reason"
        : "budget",
      needs_reason: needsReason,
      needs_unit_cost: needsUnitCost,
      reason: needsReason && covers ? reason : null,
      resolved: ok,
      words: ok && needsReason ? `${words} Reason given by ${reason!.given_by_email ?? "a staff member"}.` : words,
    };
  };

  if (!linked) {
    return make("not_in_budget", null, true, "This line is not in the job budget. It needs a reason and a unit cost before it is ordered.");
  }
  if (quantity === null) {
    return make("quantity_missing", null, false, "This line has no quantity, so its cost cannot be worked out. Add the quantity.");
  }
  // A sealed order row covered by the fixings allowance or the one figure for
  // all materials names that budget entry: no dollars of its own (17b-1 B).
  if (linked.cost_from === "allowance") {
    return make("allowance", null, false, "The fixings allowance in the job budget covers this line.");
  }
  if (linked.supplier_key === "one_figure") {
    return make("one_figure", null, false, "The budget priced the materials as one figure; this line is part of it.");
  }
  if (!sameUnit(unit, linked.unit)) {
    return make("unit_changed", null, true, `The budget counts this line in ${linked.unit ?? "no unit"}. It needs a reason and a unit cost before it is ordered.`);
  }
  const over = linked.quantity !== null && quantity > linked.quantity + 1e-9;
  if (!budget.priced_by_line && linked.cost_from === "one_figure") {
    return over
      ? make("over_budget", null, true, `This is more than the budget's ${linked.quantity}. It needs a reason and a unit cost before it is ordered.`)
      : make("one_figure", null, false, "The budget priced the materials as one figure; this line is part of it.");
  }
  if (linked.unit_cost_ex_gst !== null) {
    return over
      ? make("over_budget", linked.unit_cost_ex_gst, true, `This is more than the budget's ${linked.quantity}. It needs a reason before it is ordered.`)
      : make("budget", linked.unit_cost_ex_gst, false, "Costed from the job budget.");
  }
  if (linked.line_cost_ex_gst !== null && linked.in_total) {
    // A line the budget costs as a whole (a taken option): the whole cost at
    // its own quantity, a person's unit cost at any other.
    return linked.quantity !== null && Math.abs(quantity - linked.quantity) <= 1e-9
      ? make("budget", null, false, "Costed from the job budget.", linked.line_cost_ex_gst)
      : make(over ? "over_budget" : "quantity_changed", null, true, "The budget costs this line as a whole at its own quantity. It needs a reason and a unit cost before it is ordered.");
  }
  return make("no_budget_cost", null, true, "The budget has no cost for this line. It needs a reason and a unit cost before it is ordered.");
}

// ── An order's cost ─────────────────────────────────────────────────────────

export type DispatchOrderCost = {
  version: typeof DISPATCH_ORDER_COST_VERSION;
  budget_id: string;
  budget_version: number;
  lines: Array<{
    line_id: string;
    budget_line_key: string | null;
    basis: DispatchCostBasis;
    quantity: number | null;
    unit: string | null;
    unit_cost_ex_gst: number | null;
    line_cost_ex_gst: number | null;
    cost_from: DispatchLineCost["cost_from"];
    reason_id: string | null;
  }>;
  /** The sum of the lines' costs. */
  lines_ex_gst: number;
  /** Lines with no dollars of their own (part of a one-figure budget). */
  one_figure_lines: number;
  /** Lines the fixings allowance covers (no dollars of their own). */
  allowance_lines: number;
  /** The supplier's budget entry, when every budget line on the order is one supplier's. */
  supplier_budget: DispatchBudgetSupplier | null;
};

/**
 * The record kept with an order email. Only called with lines that are all
 * resolved (the make and send presses refuse first).
 */
export function dispatchOrderCost(
  costed: Array<{ line: any; cost: DispatchLineCost }>,
  budget: DispatchBudget,
): DispatchOrderCost {
  let cents = 0;
  let oneFigure = 0;
  let allowance = 0;
  const supplierKeys = new Set<string>();
  const lines = costed.map(({ line, cost }) => {
    if (cost.line_cost_ex_gst !== null) cents += Math.round(cost.line_cost_ex_gst * 100);
    if (cost.basis === "one_figure") oneFigure += 1;
    if (cost.basis === "allowance") allowance += 1;
    const bl = cost.budget_line_key ? budget.lines.find((l) => l.key === cost.budget_line_key) : null;
    if (bl?.supplier_key) supplierKeys.add(bl.supplier_key);
    return {
      line_id: String(line.id),
      budget_line_key: cost.budget_line_key,
      basis: cost.basis,
      quantity: money(line.quantity),
      unit: text(line.unit),
      unit_cost_ex_gst: cost.unit_cost_ex_gst,
      line_cost_ex_gst: cost.line_cost_ex_gst,
      cost_from: cost.cost_from,
      reason_id: cost.reason?.id ?? null,
    };
  });
  const only = supplierKeys.size === 1 ? [...supplierKeys][0] : null;
  return {
    version: DISPATCH_ORDER_COST_VERSION,
    budget_id: budget.id,
    budget_version: budget.version,
    lines,
    lines_ex_gst: dollars(cents),
    one_figure_lines: oneFigure,
    allowance_lines: allowance,
    supplier_budget: only ? budget.by_supplier.find((e) => e.key === only) ?? null : null,
  };
}

/** Reason text as given: trimmed, 3 to 500 characters, or null. */
export function cleanDispatchCostReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.replace(/\s+/g, " ").trim();
  return t.length >= DISPATCH_COST_REASON_MIN && t.length <= DISPATCH_COST_REASON_MAX ? t : null;
}

/** A unit cost as given: a number 0 or more with at most two decimals, or null. */
export function cleanDispatchUnitCost(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 9_999_999_999.99) return null;
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6 ? value : null;
}
