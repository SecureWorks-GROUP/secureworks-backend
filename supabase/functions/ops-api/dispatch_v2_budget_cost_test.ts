// deno-lint-ignore-file no-explicit-any
// Ruling 17 step 3: the rule for a Dispatch line's cost against the job
// budget (dispatch_v2_budget_cost.ts), against the tool's own native sealed
// budgets (_shared/job_budget/fixtures/native-budgets.json) and small
// hand-made ones. Pure: no database, no email.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cleanDispatchCostReason,
  cleanDispatchUnitCost,
  type DispatchBudget,
  dispatchBudgetFillLines,
  dispatchBudgetFromRecord,
  dispatchLineCost,
  dispatchLineCostCents,
  type DispatchLineReason,
  dispatchOrderCost,
} from "./dispatch_v2_budget_cost.ts";
import native from "../_shared/job_budget/fixtures/native-budgets.json" with { type: "json" };

const BUDGET_ID = "11111111-1111-4111-8111-111111111111";

function stored(name: keyof typeof native.budgets): DispatchBudget {
  return dispatchBudgetFromRecord({
    id: BUDGET_ID,
    job_id: "22222222-2222-4222-8222-222222222222",
    scope_revision_id: "33333333-3333-4333-8333-333333333333",
    version: 1,
    trade: name.startsWith("fence") ? "fence" : "patio",
    budget: native.budgets[name],
  });
}

const lineOf = (b: DispatchBudget, key: string, over: Record<string, unknown> = {}) => {
  const l = b.lines.find((x) => x.key === key)!;
  return { id: "line-1", quantity: l.quantity, unit: l.unit, budget_id: b.id, budget_line_key: key, ...over };
};

function reason(over: Partial<DispatchLineReason> = {}): DispatchLineReason {
  return {
    id: "reason-1",
    basis: "over_budget",
    reason: "Site needs two more",
    quantity: 0,
    unit: null,
    unit_cost_ex_gst: null,
    given_by: "44444444-4444-4444-8444-444444444444",
    given_by_email: "staff@example.test",
    given_at: "2026-11-13T10:00:00.000Z",
    ...over,
  };
}

Deno.test("fill: a fence budget's lines are the order, each naming its budget line; screws (never on supplier copy) and delivery stay on the budget", () => {
  const b = stored("fence_standard");
  const fill = dispatchBudgetFillLines(b);
  assert(fill.ok);
  assertEquals(
    fill.lines.map((l) => [l.budget_line_key, l.quantity, l.unit, l.supplier_key]),
    [
      ["fence:group:0:0", 9, "each", "Fencing Warehouse"],
      ["fence:group:0:1", 6, "each", "Fencing Warehouse"],
      ["fence:group:0:2", 6, "each", "Fencing Warehouse"],
      ["fence:concrete", 9, "each", "Fencing Warehouse"],
    ],
  );
  assert(fill.lines.every((l) => l.scope_line_id?.startsWith("SL-")));
  assert(fill.notes.some((n) => n.startsWith("Never on a supplier order") && n.includes("Tek screws")));
  assert(fill.notes.some((n) => n.startsWith("Delivery and cutting charges stay on the budget")));
  // No line carries money into the order text.
  assert(!JSON.stringify(fill.lines).match(/128|154|1152/));
});

Deno.test("fill: a supplier note rides on its line; one too long refuses the fill by key", () => {
  const raw = structuredClone(native.budgets.fence_standard) as any;
  raw.materials.lines[0].note_to_supplier = "Cut each sheet to 1,650";
  let fill = dispatchBudgetFillLines(dispatchBudgetFromRecord({ id: BUDGET_ID, job_id: "j", scope_revision_id: "r", version: 1, trade: "fence", budget: raw }));
  assert(fill.ok);
  assertEquals(fill.lines[0].detail, "Cut each sheet to 1,650");
  raw.materials.lines[1].note_to_supplier = "x".repeat(301);
  fill = dispatchBudgetFillLines(dispatchBudgetFromRecord({ id: BUDGET_ID, job_id: "j", scope_revision_id: "r", version: 1, trade: "fence", budget: raw }));
  assertEquals(fill, { ok: false, code: "supplier_note_too_long", keys: ["fence:group:0:1"] });
});

Deno.test("fill: a one-figure patio budget fills its order lines, never the one figure, and says it has no per-line dollars", () => {
  const b = stored("patio_one_figure");
  const fill = dispatchBudgetFillLines(b);
  assert(fill.ok);
  assert(!fill.lines.some((l) => l.budget_line_key === "one_figure" || l.supplier_key === "one_figure"));
  assert(fill.lines.length > 0);
  // Two budget lines from one sealed line keep their own keys.
  const twins = fill.lines.filter((l) => l.scope_line_id === "SL-960b8f314bbd83cb");
  assertEquals(twins.map((l) => l.budget_line_key), ["patio:SL-960b8f314bbd83cb", "patio:SL-960b8f314bbd83cb#2"]);
  assert(fill.notes.some((n) => n.includes("one figure")));
});

Deno.test("cost: at its budget quantity a line costs the budget's unit cost times its quantity; under is fine too", () => {
  const b = stored("fence_standard");
  const at = dispatchLineCost(lineOf(b, "fence:group:0:0"), b, null);
  assertEquals([at.basis, at.unit_cost_ex_gst, at.line_cost_ex_gst, at.cost_from, at.needs_reason, at.resolved], ["budget", 128, 1152, "budget", false, true]);
  const under = dispatchLineCost(lineOf(b, "fence:group:0:0", { quantity: 7 }), b, null);
  assertEquals([under.basis, under.line_cost_ex_gst, under.resolved], ["budget", 896, true]);
});

Deno.test("cost: over its budget line needs a named person's reason for that quantity; the budget's unit cost still applies", () => {
  const b = stored("fence_standard");
  const line = lineOf(b, "fence:group:0:0", { quantity: 11 });
  const open = dispatchLineCost(line, b, null);
  assertEquals([open.basis, open.needs_reason, open.needs_unit_cost, open.resolved, open.line_cost_ex_gst], ["over_budget", true, false, false, 1408]);
  const covered = dispatchLineCost(line, b, reason({ quantity: 11, unit: "each" }));
  assertEquals([covered.resolved, covered.unit_cost_ex_gst, covered.line_cost_ex_gst, covered.reason?.id], [true, 128, 1408, "reason-1"]);
  assert(covered.words.includes("staff@example.test"));
  // A reason for 10 does not cover 11: a later rise needs a new one.
  assertEquals(dispatchLineCost(line, b, reason({ quantity: 10, unit: "each" })).resolved, false);
  // A reason in another unit does not cover it either.
  assertEquals(dispatchLineCost(line, b, reason({ quantity: 11, unit: "m" })).resolved, false);
});

Deno.test("cost: another unit, a budget line with no cost, or a line not in the budget needs a reason and a unit cost", () => {
  const f = stored("fence_standard");
  const unit = dispatchLineCost(lineOf(f, "fence:group:0:1", { unit: "length" }), f, null);
  assertEquals([unit.basis, unit.needs_unit_cost, unit.line_cost_ex_gst, unit.resolved], ["unit_changed", true, null, false]);
  const p = stored("patio_standard");
  const notBought = dispatchLineCost(lineOf(p, "patio:SL-28f63ccd9594f698"), p, null);
  assertEquals([notBought.basis, notBought.needs_unit_cost, notBought.line_cost_ex_gst], ["no_budget_cost", true, null]);
  const typed = dispatchLineCost({ quantity: 2, unit: "each", budget_id: null, budget_line_key: null }, p, null);
  assertEquals([typed.basis, typed.needs_unit_cost, typed.resolved], ["not_in_budget", true, false]);
  // A reason without a unit cost does not cover a line that needs one; with one it does.
  assertEquals(dispatchLineCost({ quantity: 2, unit: "each" }, p, reason({ quantity: 2, unit: "each" })).resolved, false);
  const given = dispatchLineCost({ quantity: 2, unit: "each" }, p, reason({ quantity: 2, unit: "each", unit_cost_ex_gst: 12.5 }));
  assertEquals([given.resolved, given.unit_cost_ex_gst, given.line_cost_ex_gst, given.cost_from], [true, 12.5, 25, "reason"]);
  // A line from an older budget is not in this one.
  assertEquals(dispatchLineCost(lineOf(p, "patio:SL-ae32dfda743e952c", { budget_id: "older" }), p, null).basis, "not_in_budget");
});

Deno.test("cost: no quantity is never ordered and never costed, whatever reason", () => {
  const b = stored("fence_standard");
  const c = dispatchLineCost(lineOf(b, "fence:group:0:0", { quantity: null }), b, reason({ quantity: 99, unit: "each", unit_cost_ex_gst: 1 }));
  assertEquals([c.basis, c.resolved, c.line_cost_ex_gst], ["quantity_missing", false, null]);
});

Deno.test("cost: a one-figure budget's lines carry no dollars at or under quantity; over needs a reason and a unit cost", () => {
  const b = stored("patio_one_figure");
  const at = dispatchLineCost(lineOf(b, "patio:SL-1adef0739ac2cfaa"), b, null);
  assertEquals([at.basis, at.line_cost_ex_gst, at.cost_from, at.resolved], ["one_figure", null, "one_figure", true]);
  const over = dispatchLineCost(lineOf(b, "patio:SL-1adef0739ac2cfaa", { quantity: 3 }), b, null);
  assertEquals([over.basis, over.needs_unit_cost, over.resolved], ["over_budget", true, false]);
});

Deno.test("cost: whole cents, half up, from the unit cost and a three-decimal quantity", () => {
  assertEquals(dispatchLineCostCents(4, 0.702), 281);
  assertEquals(dispatchLineCostCents(33.33, 3), 9999);
  assertEquals(dispatchLineCostCents(10.01, 0.333), 333);
  assertEquals(dispatchLineCostCents(0.05, 0.1), 1);
  const p = stored("patio_standard");
  const concrete = dispatchLineCost(lineOf(p, "patio:SL-52bc826a5ed189db"), p, null);
  assertEquals(concrete.line_cost_ex_gst, 2.81);
});

Deno.test("order cost: each line's basis and cost, the total, and the one supplier's budget", () => {
  const b = stored("fence_standard");
  const lines = ["fence:group:0:0", "fence:group:0:1"].map((k, i) => ({ ...lineOf(b, k), id: `line-${i}` }));
  const costed = lines.map((line) => ({ line, cost: dispatchLineCost(line, b, null) }));
  const oc = dispatchOrderCost(costed, b);
  assertEquals(oc.version, "dispatch-order-cost.v1");
  assertEquals([oc.budget_id, oc.budget_version, oc.lines_ex_gst, oc.one_figure_lines], [BUDGET_ID, 1, 1932, 0]);
  assertEquals(oc.lines.map((l) => [l.line_id, l.basis, l.line_cost_ex_gst]), [["line-0", "budget", 1152], ["line-1", "budget", 780]]);
  assertEquals(oc.supplier_budget?.key, "name:Fencing Warehouse");
  assertEquals(oc.supplier_budget?.total_ex_gst, 3288);
});

Deno.test("reason and unit cost inputs", () => {
  assertEquals(cleanDispatchCostReason("  site  needs\n two more "), "site needs two more");
  assertEquals(cleanDispatchCostReason("ok"), null);
  assertEquals(cleanDispatchCostReason("x".repeat(501)), null);
  assertEquals(cleanDispatchCostReason(42), null);
  assertEquals(cleanDispatchUnitCost(12.5), 12.5);
  assertEquals(cleanDispatchUnitCost(0), 0);
  assertEquals(cleanDispatchUnitCost(1.234), null);
  assertEquals(cleanDispatchUnitCost(-1), null);
  assertEquals(cleanDispatchUnitCost("12"), null);
});
