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
  dispatchBudgetFromRecord,
  DispatchBudgetReadError,
  type DispatchOrder,
  dispatchOrderFillLines,
  dispatchOrderFromPricing,
  dispatchOrderHoldWords,
  DispatchOrderShapeError,
  readDispatchOrder,
  dispatchLineCost,
  dispatchLineCostCents,
  type DispatchLineReason,
  dispatchOrderCost,
} from "./dispatch_v2_budget_cost.ts";
import native from "../_shared/job_budget/fixtures/native-budgets.json" with { type: "json" };
import { dispatchV2LineText } from "./dispatch_v2_emails.ts";
import { jsonHash } from "../_shared/release_packet/canonicalize.ts";

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

// The sealed order list (ruling 17b-1) as the tool seals it, made here from a
// native budget's own lines: one row per line the supplier copy prints, row id
// = the budget line key. A stand-in until the tool seals order.v1.
function orderFor(raw: any, edit: (row: any) => void = () => {}): DispatchOrder {
  const rows = raw.materials.lines
    .filter((l: any) => l.supplier_key !== "one_figure" && l.cost_from !== "allowance")
    .map((l: any) => {
      const row: any = {
        id: l.key,
        scope_line_id: l.line_id ?? null,
        option_id: null,
        kind: l.kind,
        supplier: l.supplier ?? null,
        supplier_code: null,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        cost_by: l.cost_from === "one_figure" ? "one_figure" : "line",
      };
      edit(row);
      return row;
    });
  return dispatchOrderFromPricing({ order: { version: "order.v1", rows } })!;
}
const fromRaw = (raw: any, trade = "patio") =>
  dispatchBudgetFromRecord({ id: BUDGET_ID, job_id: "j", scope_revision_id: "r", version: 1, trade, budget: raw });
// patio_standard with its one uncosted line taken out (that line holds a fill:
// see the holds test).
function patioCosted(): any {
  const raw = structuredClone(native.budgets.patio_standard) as any;
  raw.materials.lines = raw.materials.lines.filter((l: any) => l.key !== "patio:SL-28f63ccd9594f698");
  return raw;
}

Deno.test("order: a revision sealed before order.v1 has none; one that is there must be order.v1 rows, never guessed", () => {
  assertEquals(dispatchOrderFromPricing({ budget: {} }), null);
  assertEquals(dispatchOrderFromPricing(null), null);
  const code = (p: unknown) => {
    try {
      dispatchOrderFromPricing(p);
      return "read";
    } catch (e) {
      return e instanceof DispatchOrderShapeError ? e.code : String(e);
    }
  };
  assertEquals(code({ order: null }), "order_version_unknown");
  assertEquals(code({ order: { version: "order.v2", rows: [] } }), "order_version_unknown");
  assertEquals(code({ order: { version: "order.v1" } }), "order_version_unknown");
  const row = { id: "a", description: "Post", kind: "item", cost_by: "line" };
  assertEquals(code({ order: { version: "order.v1", rows: [row] } }), "read");
  for (const bad of [{ ...row, id: "" }, { ...row, description: null }, { ...row, kind: "labour" }, { ...row, cost_by: "free" }]) {
    assertEquals(code({ order: { version: "order.v1", rows: [bad] } }), "order_row_unreadable");
  }
});

Deno.test("order read: the sealed pricing bytes are re-hashed and must be the bytes the budget was stored from", async () => {
  const pricing = { budget: { version: "budget.v1" }, order: { version: "order.v1", rows: [] } };
  const text = JSON.stringify(pricing);
  const hash = await jsonHash(pricing);
  const client = (row: any, error: any = null) => ({
    from: (t: string) => {
      assertEquals(t, "scope_revisions");
      const q: any = { select: () => q, eq: () => q, maybeSingle: () => Promise.resolve({ data: row, error }) };
      return q;
    },
  });
  const budget = { ...fromRaw(patioCosted()), scope_revision_id: "r", pricing_hash: hash };
  assertEquals(await readDispatchOrder(client({ pricing_canonical_text: text, pricing_hash: hash }), budget), { rows: [] });
  const fails = async (c: any, b = budget) => {
    try {
      await readDispatchOrder(c, b);
      return "read";
    } catch (e) {
      return e instanceof DispatchOrderShapeError ? e.code : e instanceof DispatchBudgetReadError ? "retry" : String(e);
    }
  };
  assertEquals(await fails(client({ pricing_canonical_text: text, pricing_hash: "f".repeat(64) })), "order_pricing_hash_mismatch");
  assertEquals(await fails(client({ pricing_canonical_text: text, pricing_hash: hash }), { ...budget, pricing_hash: "e".repeat(64) }), "order_pricing_hash_mismatch");
  assertEquals(await fails(client({ pricing_canonical_text: "{", pricing_hash: hash })), "order_pricing_unreadable");
  assertEquals(await fails(client(null)), "order_revision_missing");
  assertEquals(await fails(client(null, { message: "timeout" })), "retry");
  // A revision sealed before order.v1: null, so Dispatch keeps today's path.
  const old = { budget: {} };
  assertEquals(await readDispatchOrder(client({ pricing_canonical_text: JSON.stringify(old), pricing_hash: await jsonHash(old) }), { ...budget, pricing_hash: null }), null);
});

Deno.test("fill: a fence order's rows are the lines, delivery row included, each naming its budget line by key; no dollar in a line", () => {
  const raw = native.budgets.fence_standard as any;
  const fill = dispatchOrderFillLines(orderFor(raw), fromRaw(raw, "fence"));
  assert(fill.ok, JSON.stringify(fill));
  assertEquals(
    fill.lines.map((l) => [l.budget_line_key, l.quantity, l.unit, l.supplier_key]),
    [
      ["fence:group:0:0", 9, "each", "Fencing Warehouse"],
      ["fence:group:0:1", 6, "each", "Fencing Warehouse"],
      ["fence:group:0:2", 6, "each", "Fencing Warehouse"],
      ["fence:concrete", 9, "each", "Fencing Warehouse"],
      ["fence:tekScrewBox", 1, "each", "Fencing Warehouse"],
      ["fence:delivery|Delivery (Fencing Warehouse)", 1, "each", "Fencing Warehouse"],
    ],
  );
  assert(fill.lines.every((l) => l.scope_line_id?.startsWith("SL-")));
  assert(!JSON.stringify(fill.lines).match(/128|154|1152/));
});

Deno.test("fill: a line is built from its order row, never from the budget's copy of the words", () => {
  const raw = patioCosted();
  const order = orderFor(raw);
  for (const l of raw.materials.lines) l.description = "ZZTEST budget words";
  const fill = dispatchOrderFillLines(order, fromRaw(raw));
  assert(fill.ok);
  assert(fill.lines.every((l) => l.description !== "ZZTEST budget words"));
  assertEquals(fill.lines.find((l) => l.budget_line_key === "patio:SL-960b8f314bbd83cb")?.description, "90x90x2 SHS");
});

Deno.test("fill: two stock rows of one section print their own length and cuts, so each reads as its supplier copy row", () => {
  const raw = patioCosted();
  const order = orderFor(raw, (row) => {
    if (row.id === "patio:SL-960b8f314bbd83cb") Object.assign(row, { stock_length_mm: 8000, cuts: [{ length_mm: 3350, qty: 2 }], colour: "Monument" });
    if (row.id === "patio:SL-960b8f314bbd83cb#2") Object.assign(row, { stock_length_mm: 4100, cuts: [{ length_mm: 3350, qty: 1 }], colour: "Monument" });
  });
  const fill = dispatchOrderFillLines(order, fromRaw(raw));
  assert(fill.ok);
  const twins = fill.lines.filter((l) => l.scope_line_id === "SL-960b8f314bbd83cb");
  assertEquals(twins.map((l) => l.budget_line_key), ["patio:SL-960b8f314bbd83cb", "patio:SL-960b8f314bbd83cb#2"]);
  const texts = twins.map((l) => dispatchV2LineText(l));
  assertEquals(texts, [
    "1 length x 90x90x2 SHS\nLength: 8,000 mm\nCuts: 2 x 3,350 mm\nColour: Monument",
    "1 length x 90x90x2 SHS\nLength: 4,100 mm\nCuts: 1 x 3,350 mm\nColour: Monument",
  ]);
  assert(!texts.join("\n").includes("$"));
});

Deno.test("fill: supplier code, no stock length on file, cut words, variant, finish, gauge, girth and the note print as the row states; nothing is made up", () => {
  const raw = patioCosted();
  const order = orderFor(raw, (row) => {
    if (row.id === "patio:SL-960b8f314bbd83cb") {
      Object.assign(row, { supplier_code: "SHS9090", stock_to_confirm: true, cut: "Cut to 6,000", variant: "Galv", profile: "Square", finish: "Matt", gauge_mm: 0.42, girth_mm: 300, note_to_supplier: "Deliver with the posts" });
    }
    if (row.id === "patio:SL-960b8f314bbd83cb#2") Object.assign(row, { stock_length_mm: 0, cuts: [{ length_mm: -1, qty: 2 }], gauge_mm: 0 });
  });
  const fill = dispatchOrderFillLines(order, fromRaw(raw));
  assert(fill.ok);
  const [a, b] = fill.lines.filter((l) => l.scope_line_id === "SL-960b8f314bbd83cb");
  assertEquals(a.detail, "Code: SHS9090\nStock length: supplier to confirm\nCuts: Cut to 6,000\nVariant: Galv\nFinish: Matt\nGauge: 0.42 mm\nGirth: 300 mm\nDeliver with the posts");
  assertEquals(a.profile, "Square");
  // A zero or negative measure is absent, never zero.
  assertEquals([b.detail, b.profile, b.colour], [null, null, null]);
});

Deno.test("fill: what does not join holds the whole fill with a reason code per row or budget line, never a $0 line or a dropped one", () => {
  const holds = (raw: any, edit: (o: any, raw: any) => void = () => {}) => {
    const o: any = orderFor(raw);
    edit(o, raw);
    const fill = dispatchOrderFillLines(o, fromRaw(raw));
    return fill.ok ? "filled" : fill.holds.map((h) => `${h.code}:${h.key}`);
  };
  // The native patio's uncosted 3PL cap: a row costed by its line with no cost.
  assertEquals(holds(structuredClone(native.budgets.patio_standard)), ["order_row_no_cost:patio:SL-28f63ccd9594f698"]);
  assertEquals(holds(patioCosted()), "filled");
  // A row whose budget line is gone; a budget item line no row names.
  assertEquals(
    holds(patioCosted(), (o) => (o.rows[0].id = "patio:SL-nowhere")),
    ["order_row_no_budget_line:patio:SL-nowhere", "budget_line_no_order_row:patio:SL-ae32dfda743e952c"],
  );
  // A delivery line on no supplier copy stays on the budget: never held.
  assertEquals(holds(patioCosted(), (o) => (o.rows = o.rows.filter((r: any) => r.kind !== "delivery"))), "filled");
  // Two budget lines on one key; two rows on one id.
  assertEquals(
    holds(patioCosted(), (_o, raw) => raw.materials.lines.push(structuredClone(raw.materials.lines[0]))),
    ["budget_key_duplicated:patio:SL-ae32dfda743e952c"],
  );
  assertEquals(holds(patioCosted(), (o) => o.rows.push({ ...o.rows[0] })), ["order_row_duplicated:patio:SL-ae32dfda743e952c"]);
  // One figure or allowance rows with nothing in the budget to cover them.
  assertEquals(holds(patioCosted(), (o) => o.rows.push({ ...o.rows[0], id: "x:1", cost_by: "one_figure" })), ["order_row_no_one_figure:x:1"]);
  assertEquals(holds(patioCosted(), (o) => o.rows.push({ ...o.rows[0], id: "x:2", cost_by: "allowance" })), ["order_row_no_allowance:x:2"]);
  // Too long for a line: never cut short.
  assertEquals(holds(patioCosted(), (o) => (o.rows[1].note_to_supplier = "x".repeat(301))), ["supplier_note_too_long:patio:SL-1adef0739ac2cfaa"]);
  assertEquals(holds(patioCosted(), (o) => Object.assign(o.rows[1], { supplier_code: "SHS9090", note_to_supplier: "x".repeat(290) })), ["order_detail_too_long:patio:SL-1adef0739ac2cfaa"]);
  assertEquals(holds(patioCosted(), (o) => (o.rows[1].colour = "c".repeat(81))), ["order_detail_too_long:patio:SL-1adef0739ac2cfaa"]);
  const words = dispatchOrderHoldWords([{ code: "order_row_no_cost", key: "k" }, { code: "budget_line_no_order_row", key: "j" }]);
  assert(words.includes("no cost") && words.includes("no sealed order line") && !words.includes("—"));
});

Deno.test("fill: a one-figure patio fills its rows at no dollars of their own; a row with no line of its own is covered by the one figure", () => {
  const raw = structuredClone(native.budgets.patio_one_figure) as any;
  const o: any = orderFor(raw, (row) => {
    if (row.id === "patio:SL-28f63ccd9594f698") row.cost_by = "one_figure";
  });
  o.rows.push({ ...o.rows[0], id: "patio:SL-extra", scope_line_id: "SL-extra", description: "Extra bracket" });
  const b = fromRaw(raw);
  const fill = dispatchOrderFillLines(o, b);
  assert(fill.ok, JSON.stringify(fill));
  assert(!fill.lines.some((l) => l.supplier_key === "one_figure"));
  const extra = fill.lines.find((l) => l.scope_line_id === "SL-extra")!;
  assertEquals(extra.budget_line_key, "patio:one-figure");
  const cost = dispatchLineCost({ quantity: extra.quantity, unit: extra.unit, budget_id: b.id, budget_line_key: extra.budget_line_key }, b, null);
  assertEquals([cost.basis, cost.line_cost_ex_gst, cost.cost_from, cost.resolved], ["one_figure", null, "one_figure", true]);
  assert(fill.notes.some((n) => n.includes("one figure")));
});

Deno.test("fill and cost: fixings covered by the allowance are ordered with no dollars of their own", () => {
  const raw = patioCosted();
  raw.materials.lines.push({ key: "patio:fixings-allowance", line_id: null, supplier_key: "none", supplier: null, kind: "item", description: "Fixings allowance", quantity: 1, unit: "allowance", unit_cost_ex_gst: 50, line_cost_ex_gst: 50, in_total: true, cost_from: "allowance" });
  const o: any = orderFor(raw);
  o.rows.push({ ...o.rows[0], id: "patio:fix-tek", scope_line_id: null, description: "Tek screws", quantity: 2, unit: "box", cost_by: "allowance" });
  const b = fromRaw(raw);
  const fill = dispatchOrderFillLines(o, b);
  assert(fill.ok, JSON.stringify(fill));
  const tek = fill.lines.find((l) => l.description === "Tek screws")!;
  assertEquals(tek.budget_line_key, "patio:fixings-allowance");
  const cost = dispatchLineCost({ quantity: 2, unit: "box", budget_id: b.id, budget_line_key: tek.budget_line_key }, b, null);
  assertEquals([cost.basis, cost.unit_cost_ex_gst, cost.line_cost_ex_gst, cost.cost_from, cost.needs_reason, cost.resolved], ["allowance", null, null, "allowance", false, true]);
  const order = dispatchOrderCost([{ line: { id: "l-tek", quantity: 2, unit: "box" }, cost }], b);
  assertEquals([order.lines_ex_gst, order.allowance_lines], [0, 1]);
  assert(fill.notes.some((n) => n.includes("fixings allowance")));
});

Deno.test("fill: a quote option's rows are ordered only when the customer took it, joined on its option line", () => {
  const raw = patioCosted();
  const o: any = orderFor(raw);
  o.rows.push({ ...o.rows[0], id: "option:o1", option_id: "o1", scope_line_id: null, description: "Extra post", quantity: 1, unit: "each" });
  o.rows.push({ ...o.rows[0], id: "option:o9", option_id: "o9", scope_line_id: null, description: "Untaken screen", quantity: 1, unit: "each" });
  // Not taken: neither row is ordered.
  let fill = dispatchOrderFillLines(o, fromRaw(raw));
  assert(fill.ok);
  assert(!fill.lines.some((l) => l.description === "Extra post" || l.description === "Untaken screen"));
  // Taken: its budget line (the options formula's option:o1) holds the money.
  raw.taken_option_ids = ["o1"];
  raw.materials.lines.push({ key: "option:o1", line_id: null, supplier_key: "bd-metals", supplier: { id: "bd-metals", name: "B&D Metals" }, kind: "item", description: "Extra post", quantity: 1, unit: "each", unit_cost_ex_gst: 180, line_cost_ex_gst: 180, in_total: true, cost_from: "option" });
  fill = dispatchOrderFillLines(o, fromRaw(raw));
  assert(fill.ok, JSON.stringify(fill));
  assertEquals(fill.lines.filter((l) => l.description === "Extra post").map((l) => l.budget_line_key), ["option:o1"]);
  assert(!fill.lines.some((l) => l.description === "Untaken screen"));
  // A taken option's budget line whose row the seal lacks holds the fill.
  o.rows = o.rows.filter((r: any) => r.id !== "option:o1");
  fill = dispatchOrderFillLines(o, fromRaw(raw));
  assertEquals(fill.ok ? [] : fill.holds, [{ code: "budget_line_no_order_row", key: "option:o1" }]);
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
