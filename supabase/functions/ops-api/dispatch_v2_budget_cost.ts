// deno-lint-ignore-file no-explicit-any
// Ruling 17 step 3 (backend half): Dispatch lines carry their cost from the job
// budget. Contract: docs/job-budget-v1.md, "Dispatch lines carry cost (step 3)".
//
// The one place for the rule. Every Dispatch read and press that shows, checks
// or records a line's cost goes through these functions:
//
//   - readDispatchBudget: the job's current stored budget (job_budgets, newest
//     version), its materials lines as sealed, or null when it has none.
//   - dispatchBudgetFillLines: the order lines a budget gives (one list: the
//     budget's materials are the order), each naming its budget line.
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
import { dispatchV2SuggestionAllowed } from "./dispatch_v2_emails.ts";

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
  description: string | null;
  quantity: number | null;
  unit: string | null;
  unit_cost_ex_gst: number | null;
  line_cost_ex_gst: number | null;
  in_total: boolean;
  cost_from: string | null;
  note_to_supplier: string | null;
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
  row: { id: string; job_id: string; scope_revision_id: string; version: number; trade: string; budget: unknown },
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
      note_to_supplier: text(l.note_to_supplier),
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
    .select("id, job_id, scope_revision_id, version, trade, budget")
    .eq("job_id", jobId)
    .order("version", { ascending: false })
    .limit(1);
  if (error) throw new DispatchBudgetReadError(String(error?.message ?? "job budget read failed"));
  const row = Array.isArray(data) ? data[0] : null;
  return row ? dispatchBudgetFromRecord(row) : null;
}

/**
 * Is the switch on? Missing or unreadable is off: Dispatch then runs exactly
 * as it did before step 3.
 */
export async function readDispatchBudgetCostOn(client: any): Promise<boolean> {
  try {
    const { data, error } = await client.from("feature_flags").select("enabled")
      .eq("flag_name", DISPATCH_BUDGET_COST_FLAG).limit(1);
    if (error) return false;
    return data?.[0]?.enabled === true;
  } catch {
    return false;
  }
}

// ── Filling from the budget ─────────────────────────────────────────────────

export type DispatchBudgetFillLine = {
  description: string;
  quantity: number | null;
  unit: string | null;
  /** The supplier note the sealed line carries, printed under the line. */
  detail: string | null;
  profile: null;
  colour: null;
  /** The sealed line id (source_line_id), or null. */
  scope_line_id: string | null;
  supplier_key: string | null;
  supplier_name: string | null;
  budget_line_key: string;
};

export type DispatchBudgetFill =
  | { ok: true; lines: DispatchBudgetFillLine[]; notes: string[] }
  | { ok: false; code: "supplier_note_too_long"; keys: string[] };

// No supplier to order from: the office's own fixings and the catalogue's
// placeholder (scope_engine_materials.ts keeps the same two).
const NO_SUPPLIER = new Set(["office", "supplier-to-confirm"]);

/**
 * The order lines a budget gives, in the budget's order. Only item lines are
 * order lines; a delivery or cutting charge stays on the budget under its
 * supplier (the order email says delivery or pickup itself). The one figure
 * for all materials and the fixings allowance are not lines anyone orders. A
 * line with no supplier goes on the draft list. A supplier note longer than a
 * line holds refuses the fill, so a note is never cut short.
 */
export function dispatchBudgetFillLines(budget: DispatchBudget): DispatchBudgetFill {
  const lines: DispatchBudgetFillLine[] = [];
  const charges: string[] = [];
  const tooLong: string[] = [];
  const held: string[] = [];
  const offCopy: string[] = [];
  for (const l of budget.lines) {
    if (l.kind !== "item") {
      if (l.kind === "delivery" || l.kind === "cutting") charges.push(l.description ?? l.key);
      continue;
    }
    if (l.supplier_key === "one_figure" || l.cost_from === "allowance") continue;
    const description = cleanSuggestedDescription(l.description);
    if (!description) continue;
    // Calculated concrete, screws and the like never go on supplier copy (the
    // email's standing lines ask for them): their cost stays on the budget.
    if (!dispatchV2SuggestionAllowed(description)) {
      offCopy.push(description);
      continue;
    }
    const quantity = cleanDispatchQuantity(l.quantity);
    const unit = cleanDispatchUnit(l.unit);
    if (l.note_to_supplier && l.note_to_supplier.length > DISPATCH_SUPPLIER_NOTE_MAX) {
      tooLong.push(l.key);
      continue;
    }
    const placed = l.supplier_key !== null && l.supplier_key !== "none" &&
      !(l.supplier_id && NO_SUPPLIER.has(l.supplier_id.toLowerCase()));
    if (!placed) held.push(description);
    lines.push({
      description,
      quantity: quantity.ok ? quantity.value : null,
      unit: unit.ok ? unit.value : null,
      detail: l.note_to_supplier,
      profile: null,
      colour: null,
      scope_line_id: l.line_id && l.line_id.length <= 100 ? l.line_id : null,
      supplier_key: placed ? (l.supplier_id ?? l.supplier_name ?? l.supplier_key) : null,
      supplier_name: placed ? l.supplier_name : null,
      budget_line_key: l.key,
    });
  }
  if (tooLong.length) return { ok: false, code: "supplier_note_too_long", keys: tooLong };
  const notes = [`These lines come from the job budget (version ${budget.version}), with their costs.`];
  if (charges.length) {
    notes.push(`Delivery and cutting charges stay on the budget, not as lines: ${charges.join(", ")}.`);
  }
  if (offCopy.length) {
    notes.push(`Never on a supplier order, so their cost stays on the budget: ${offCopy.join(", ")}.`);
  }
  if (held.length) {
    notes.push(`${held.length === 1 ? "1 line has" : `${held.length} lines have`} no supplier in the budget, so ${held.length === 1 ? "it is" : "they are"} on the draft list: ${held.join(", ")}.`);
  }
  if (!budget.priced_by_line) {
    notes.push("The budget priced the materials as one figure, so its lines carry no dollars of their own.");
  }
  return { ok: true, lines, notes };
}

// ── A line's cost ───────────────────────────────────────────────────────────

/** Why a line is costed the way it is. */
export type DispatchCostBasis =
  /** At or under its budget line, same unit, the budget's unit cost. */
  | "budget"
  /** At or under its budget line in a budget priced as one figure. */
  | "one_figure"
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
  cost_from: "budget" | "reason" | "one_figure" | null;
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
  const supplierKeys = new Set<string>();
  const lines = costed.map(({ line, cost }) => {
    if (cost.line_cost_ex_gst !== null) cents += Math.round(cost.line_cost_ex_gst * 100);
    if (cost.basis === "one_figure") oneFigure += 1;
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
