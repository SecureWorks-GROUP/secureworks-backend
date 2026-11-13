// The shared worked examples of contract section 5 (made-up figures). The Scope
// Engine runs the same examples through its own `budgetWithOptions`
// (verify/r17-budget/options-examples.json); both must match them to the cent.

const REV = '11111111-1111-4111-8111-111111111111'
const STAFF = '22222222-2222-4222-8222-222222222222'
const who = () => ({ staff_id: STAFF, name: 'ZZTEST Scoper' })

/** Base budget, patio, 8%. */
export function patioBase(): Record<string, unknown> {
  return {
    version: 'budget.v1',
    trade: 'patio',
    job: { scope_revision_id: REV, revision_n: 1, sell_ex_gst: 10000, gst: 1000, total_inc_gst: 11000, scoped_by: who(), salesperson: who() },
    materials: {
      priced_by_line: true,
      lines: [
        { key: 'm1', line_id: 'sl-1', supplier_key: 'sup-a', supplier: { id: 'sup-a', name: 'Supplier A', code: null }, kind: 'item', description: 'Roof sheets', quantity: 10, unit: 'each', cut: null, unit_cost_ex_gst: 200, line_cost_ex_gst: 2000, in_total: true, cost_from: 'supplier_price', note_to_supplier: null },
        { key: 'm2', line_id: 'sl-2', supplier_key: 'sup-a', supplier: { id: 'sup-a', name: 'Supplier A', code: null }, kind: 'item', description: 'Posts', quantity: 4, unit: 'each', cut: null, unit_cost_ex_gst: 250, line_cost_ex_gst: 1000, in_total: true, cost_from: 'typed', note_to_supplier: null },
        // The supplier's delivery is a line of that supplier (draft 3): it adds to delivery_ex_gst, not lines_ex_gst.
        { key: 'sup-a:delivery', line_id: 'ZZTEST-delivery', supplier_key: 'sup-a', supplier: { id: 'sup-a', name: 'Supplier A', code: null }, kind: 'delivery', description: 'Delivery', quantity: 1, unit: 'job', cut: null, unit_cost_ex_gst: 120, line_cost_ex_gst: 120, in_total: true, cost_from: 'supplier_price', note_to_supplier: null },
      ],
      by_supplier: [
        { key: 'sup-a', supplier: { id: 'sup-a', name: 'Supplier A' }, lines_ex_gst: 3000, surcharge_ex_gst: 45, delivery_ex_gst: 120, total_ex_gst: 3165 },
      ],
      total_ex_gst: 3165,
    },
    labour: {
      pay: 'group_work_order', amount_ex_gst: 2800, hourly: null,
      lines: [{ key: 'l1', task: 'Build', people: 2, days: 2, day_rate_ex_gst: 700, amount_ex_gst: 2800, in_total: true }],
      work_order_amount_ex_gst: 2800,
    },
    other: [
      { lane: 'skip_and_tip', lines: [{ key: 'x1', description: 'Skip bin', quantity: 1, unit: 'each', cost_ex_gst: 350, in_total: true, paid_to: 'office', supplier: null }], total_ex_gst: 350 },
      { lane: 'buffer', lines: [{ key: 'b1', description: 'Job buffer', quantity: 1, unit: 'job', cost_ex_gst: 200, in_total: true, paid_to: 'office', supplier: null }], total_ex_gst: 200 },
    ],
    commission: { salesperson: who(), rule_id: 'patio_commission_rate', pct: 8, basis: 'gross_profit', amount_ex_gst: 278.8 },
    totals: {
      cost_before_commission_ex_gst: 6515, gross_profit_ex_gst: 3485, gross_profit_pct: 34.85,
      commission_ex_gst: 278.8, profit_after_commission_ex_gst: 3206.2, profit_after_commission_pct: 32.06,
    },
    options: [
      { option_id: 'o1', sell_ex_gst: 400, gst: 40, sell_inc_gst: 440, cost_ex_gst: 180, surcharge_ex_gst: 2.7, lands: { lane: 'materials', supplier: { id: 'sup-a', name: 'Supplier A' } }, line: { description: 'Two downlights', quantity: 2, unit: 'each' } },
      { option_id: 'o2', sell_ex_gst: 520, gst: 52, sell_inc_gst: 572, cost_ex_gst: 250, surcharge_ex_gst: 0, lands: { lane: 'labour' }, line: { description: 'Ceiling fan fitted', quantity: 1, unit: 'each' } },
      { option_id: 'o3', sell_ex_gst: 300, gst: 30, sell_inc_gst: 330, cost_ex_gst: null, surcharge_ex_gst: 0, lands: { lane: 'hire', paid_to: 'office' }, line: { description: 'Scaffold hire', quantity: 1, unit: 'each' } },
    ],
    complete: true,
    gaps: [],
  }
}

/** D: fence, 15%, a loss made good by an option. */
export function fenceLossBase(): Record<string, unknown> {
  return {
    version: 'budget.v1',
    trade: 'fence',
    job: { scope_revision_id: REV, revision_n: 1, sell_ex_gst: 1000, gst: 100, total_inc_gst: 1100, scoped_by: who(), salesperson: who() },
    materials: {
      priced_by_line: true,
      lines: [
        { key: 'fence:panel_kits', line_id: null, supplier_key: 'sup-f', supplier: { id: 'sup-f', name: 'Supplier F', code: null }, kind: 'item', description: 'Panel kits', quantity: 7, unit: 'each', cut: null, unit_cost_ex_gst: 100, line_cost_ex_gst: 700, in_total: true, cost_from: 'supplier_price', note_to_supplier: null },
        { key: 'sup-f:delivery', line_id: null, supplier_key: 'sup-f', supplier: { id: 'sup-f', name: 'Supplier F', code: null }, kind: 'delivery', description: 'Delivery', quantity: 1, unit: 'job', cut: null, unit_cost_ex_gst: 80, line_cost_ex_gst: 80, in_total: true, cost_from: 'supplier_price', note_to_supplier: null },
      ],
      by_supplier: [
        { key: 'sup-f', supplier: { id: 'sup-f', name: 'Supplier F' }, lines_ex_gst: 700, surcharge_ex_gst: 0, delivery_ex_gst: 80, total_ex_gst: 780 },
      ],
      total_ex_gst: 780,
    },
    labour: {
      pay: 'group_work_order', amount_ex_gst: 320, hourly: null,
      lines: [{ key: 'fence:labour', task: 'Install', people: null, days: null, day_rate_ex_gst: null, amount_ex_gst: 320, in_total: true }],
      work_order_amount_ex_gst: 320,
    },
    commission: { salesperson: who(), rule_id: 'fence_commission_rate', pct: 15, basis: 'gross_profit', amount_ex_gst: 0 },
    totals: {
      cost_before_commission_ex_gst: 1100, gross_profit_ex_gst: -100, gross_profit_pct: -10,
      commission_ex_gst: 0, profit_after_commission_ex_gst: -100, profit_after_commission_pct: -10,
    },
    options: [
      { option_id: 'o4', sell_ex_gst: 250, gst: 25, sell_inc_gst: 275, cost_ex_gst: 49.9, surcharge_ex_gst: 0, lands: { lane: 'materials', supplier: { id: 'sup-f', name: 'Supplier F' } }, line: { description: 'Rail upgrade', quantity: 1, unit: 'job' } },
    ],
    complete: true,
    gaps: [],
  }
}

/** The expected results, as the contract's table states them (dollars). */
export const EXPECTED = {
  A: { taken: ['o1'], sell: 10400, gst: 1040, inc: 11440, supplier: { lines: 3180, surcharge: 47.7, total: 3347.7 }, cost: 6697.7, gp: 3702.3, gp_pct: 35.6, com: 296.18, after: 3406.12, after_pct: 32.75, complete: true },
  B: { taken: ['o1', 'o2'], sell: 10920, gst: 1092, inc: 12012, labour: 3050, work_order: 3050, cost: 6947.7, gp: 3972.3, gp_pct: 36.38, com: 317.78, after: 3654.52, after_pct: 33.47, complete: true },
  C: { taken: ['o3'], sell: 10300, gst: 1030, inc: 11330, cost: null, gp: null, gp_pct: null, com: null, after: null, after_pct: null, complete: false },
  D: { taken: ['o4'], sell: 1250, gst: 125, inc: 1375, supplier: { lines: 749.9, total: 829.9 }, cost: 1149.9, gp: 100.1, gp_pct: 8.01, com: 15.02, after: 85.08, after_pct: 6.81, complete: true },
} as const
