// deno-lint-ignore-file no-explicit-any no-import-prefix
// Ruling 17 step 1: the budget's checks, the options formula (the contract's
// worked examples, to the cent) and the strip.
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { budgetAddedUp, budgetWithOptions, checkBudget, commissionCents, moneyCents, withoutBudget } from './budget_v1.ts'
import { EXPECTED, fenceLossBase, patioBase } from './budget_examples.ts'
import toolExamples from './fixtures/options-examples.json' with { type: 'json' }
import native from './fixtures/native-budgets.json' with { type: 'json' }

function applied(base: Record<string, unknown>, taken: readonly string[]) {
  const out = budgetWithOptions(base, taken)
  if (!out.ok) throw new Error(`refused: ${JSON.stringify(out.refusal)}`)
  return out.budget as any
}

Deno.test('R17 the two base examples add up', () => {
  for (const base of [patioBase(), fenceLossBase()]) {
    const out = checkBudget(base)
    assert(out.ok, JSON.stringify(out))
  }
})

Deno.test('R17 options formula: example A, one supplier option, to the cent', () => {
  const b = applied(patioBase(), EXPECTED.A.taken)
  const e = EXPECTED.A
  assertEquals([b.job.sell_ex_gst, b.job.gst, b.job.total_inc_gst], [e.sell, e.gst, e.inc])
  const sup = b.materials.by_supplier[0]
  assertEquals([sup.lines_ex_gst, sup.surcharge_ex_gst, sup.total_ex_gst], [e.supplier.lines, e.supplier.surcharge, e.supplier.total])
  assertEquals(b.totals, {
    cost_before_commission_ex_gst: e.cost, gross_profit_ex_gst: e.gp, gross_profit_pct: e.gp_pct,
    commission_ex_gst: e.com, profit_after_commission_ex_gst: e.after, profit_after_commission_pct: e.after_pct,
  })
  assertEquals(b.complete, e.complete)
  assertEquals(b.taken_option_ids, ['o1'], 'the applied budget records what was taken (section 5 step 4)')
  assert(checkBudget(b).ok, 'the result passes the same checks as a sealed budget')
})

Deno.test('R17 options formula: example B, a supplier and a crew option', () => {
  const b = applied(patioBase(), EXPECTED.B.taken)
  const e = EXPECTED.B
  assertEquals([b.job.sell_ex_gst, b.job.gst, b.job.total_inc_gst], [e.sell, e.gst, e.inc])
  assertEquals([b.labour.amount_ex_gst, b.labour.work_order_amount_ex_gst], [e.labour, e.work_order])
  assertEquals([b.totals.cost_before_commission_ex_gst, b.totals.gross_profit_ex_gst, b.totals.gross_profit_pct], [e.cost, e.gp, e.gp_pct])
  assertEquals([b.totals.commission_ex_gst, b.totals.profit_after_commission_ex_gst, b.totals.profit_after_commission_pct], [e.com, e.after, e.after_pct])
  assertEquals(b.taken_option_ids, ['o1', 'o2'])
  assert(checkBudget(b).ok)
  // Taken in another order, the record keeps the sealed options order.
  assertEquals(applied(patioBase(), ['o2', 'o1']).taken_option_ids, ['o1', 'o2'])
})

Deno.test('R17 options formula: example C, an option with no cost is null with a gap, never 0', () => {
  const b = applied(patioBase(), EXPECTED.C.taken)
  const e = EXPECTED.C
  assertEquals([b.job.sell_ex_gst, b.job.gst, b.job.total_inc_gst], [e.sell, e.gst, e.inc])
  const hire = b.other.find((l: any) => l.lane === 'hire')
  assertEquals(hire.total_ex_gst, null)
  assertEquals(hire.lines[0].cost_ex_gst, null)
  assertEquals(b.totals, {
    cost_before_commission_ex_gst: null, gross_profit_ex_gst: null, gross_profit_pct: null,
    commission_ex_gst: null, profit_after_commission_ex_gst: null, profit_after_commission_pct: null,
  })
  assertEquals(b.complete, false)
  assertEquals(b.gaps, [{ where: 'other:hire', key: 'option:o3', code: 'no_cost', what: 'No cost' }])
  assert(checkBudget(b).ok, 'an incomplete budget with its gap named is stored, not refused')
})

Deno.test('R17 options formula: example D, a loss made good, and the rounding trap (15.02, not 15.01)', () => {
  const base = checkBudget(fenceLossBase())
  assert(base.ok)
  assertEquals(base.budget.summary.commission_cents, 0, 'commission is 0 on a loss')
  const b = applied(fenceLossBase(), EXPECTED.D.taken)
  const e = EXPECTED.D
  assertEquals([b.job.sell_ex_gst, b.job.gst, b.job.total_inc_gst], [e.sell, e.gst, e.inc])
  const sup = b.materials.by_supplier[0]
  assertEquals([sup.lines_ex_gst, sup.total_ex_gst], [e.supplier.lines, e.supplier.total])
  assertEquals([b.totals.cost_before_commission_ex_gst, b.totals.gross_profit_ex_gst, b.totals.gross_profit_pct], [e.cost, e.gp, e.gp_pct])
  assertEquals([b.totals.commission_ex_gst, b.totals.profit_after_commission_ex_gst, b.totals.profit_after_commission_pct], [e.com, e.after, e.after_pct])
  assert(checkBudget(b).ok)
  // The float sum the contract warns about.
  assertEquals(Math.round(100.1 * 0.15 * 100) / 100, 15.01)
  assertEquals(commissionCents(10010, 1500), 1502)
})

Deno.test('R17 options formula: nothing taken is the base unchanged; a taken id the budget lacks is refused', () => {
  assertEquals(applied(patioBase(), []), patioBase())
  assertEquals('taken_option_ids' in applied(patioBase(), []), false, 'no option taken: the base, no ids')
  const out = budgetWithOptions(patioBase(), ['nope'])
  assertEquals(out, { ok: false, refusal: { code: 'option_not_in_budget', at: 'option:nope' } })
  // A supplier not yet on the job gets its own entry, delivery 0 (known, not unknown).
  const base = patioBase() as any
  base.options[0].lands.supplier = { id: 'sup-new', name: 'New Supplier' }
  const b = applied(base, ['o1'])
  assertEquals(b.materials.by_supplier[1], { key: 'sup-new', supplier: { id: 'sup-new', name: 'New Supplier' }, lines_ex_gst: 180, surcharge_ex_gst: 2.7, delivery_ex_gst: 0, total_ex_gst: 182.7 })
  assert(checkBudget(b).ok)
})

Deno.test('R17 checks: each failed add-up names its own code', () => {
  const bad = (mut: (b: any) => void) => {
    const b = patioBase() as any
    mut(b)
    const out = checkBudget(b)
    return out.ok ? 'ok' : out.refusal.code
  }
  assertEquals(bad((b) => { b.job.gst = 1001 }), 'gst_mismatch')
  assertEquals(bad((b) => { b.materials.lines[0].line_cost_ex_gst = 2000.01 }), 'supplier_lines_mismatch')
  assertEquals(bad((b) => { b.materials.lines[0].line_cost_ex_gst = 2000.001 }), 'money_not_two_decimals')
  assertEquals(bad((b) => { b.materials.by_supplier[0].total_ex_gst = 3166 }), 'supplier_total_mismatch')
  assertEquals(bad((b) => { b.materials.total_ex_gst = 3166 }), 'materials_total_mismatch')
  assertEquals(bad((b) => { b.labour.amount_ex_gst = 2801 }), 'labour_amount_mismatch')
  assertEquals(bad((b) => { b.labour.work_order_amount_ex_gst = 2801 }), 'work_order_amount_mismatch')
  assertEquals(bad((b) => { b.other[0].total_ex_gst = 351 }), 'lane_total_mismatch')
  assertEquals(bad((b) => { b.totals.cost_before_commission_ex_gst = 6516 }), 'cost_mismatch')
  assertEquals(bad((b) => { b.totals.gross_profit_ex_gst = 3484 }), 'gross_profit_mismatch')
  assertEquals(bad((b) => { b.totals.gross_profit_pct = 34.84 }), 'gross_profit_pct_mismatch')
  assertEquals(bad((b) => { b.commission.amount_ex_gst = 278.79 }), 'commission_mismatch')
  assertEquals(bad((b) => { b.totals.profit_after_commission_ex_gst = 3206.21 }), 'profit_after_mismatch')
  assertEquals(bad((b) => { b.other[1].lines[0].key = 'm1' }), 'key_not_unique')
  assertEquals(bad((b) => { b.complete = false }), 'complete_mismatch')
  assertEquals(bad((b) => { b.job.salesperson.staff_id = 'Nithin' }), 'staff_id_not_uuid')
  assertEquals(bad((b) => { b.version = 'budget.v2' }), 'budget_version_unknown')
})

Deno.test('R17 step 4: hourly pay carries a maximum whose rate x hours is the allowance; group pay carries none', () => {
  const run = (mut: (b: any) => void) => {
    const b = patioBase() as any
    mut(b)
    const out = checkBudget(b)
    return out.ok ? 'ok' : out.refusal.code
  }
  const hourly = (b: any, h: unknown) => { b.labour.pay = 'hourly_capped'; b.labour.hourly = h }
  assertEquals(run(() => {}), 'ok')
  assertEquals(run((b) => hourly(b, { rate_ex_gst: 70, max_hours: 40, max_ex_gst: 2800 })), 'ok')
  assertEquals(run((b) => hourly(b, { rate_ex_gst: 56, max_hours: 50, max_ex_gst: 2800 })), 'ok')
  assertEquals(run((b) => hourly(b, { rate_ex_gst: 70, max_hours: 40, max_ex_gst: 2801 })), 'labour_hourly_mismatch')
  // The maximum is the allowance: the labour amount must equal it.
  assertEquals(run((b) => hourly(b, { rate_ex_gst: 60, max_hours: 40, max_ex_gst: 2400 })), 'labour_hourly_mismatch')
  assertEquals(run((b) => hourly(b, null)), 'labour_hourly_invalid')
  assertEquals(run((b) => hourly(b, { rate_ex_gst: 0, max_hours: 40, max_ex_gst: 0 })), 'labour_hourly_invalid')
  assertEquals(run((b) => hourly(b, { rate_ex_gst: 70, max_hours: 0, max_ex_gst: 2800 })), 'labour_hourly_invalid')
  assertEquals(run((b) => hourly(b, { rate_ex_gst: 70, max_hours: 40.005, max_ex_gst: 2800 })), 'labour_hourly_invalid')
  assertEquals(run((b) => hourly(b, { rate_ex_gst: 70, max_hours: '40', max_ex_gst: 2800 })), 'labour_hourly_invalid')
  assertEquals(run((b) => { b.labour.hourly = { rate_ex_gst: 70, max_hours: 40, max_ex_gst: 2800 } }), 'labour_hourly_invalid')
  assertEquals(run((b) => { b.labour.pay = 'fixed' }), 'labour_pay_unknown')
})

Deno.test('R17 checks: an unknown cost must be named as a gap, and a loss pays no commission', () => {
  const b = patioBase() as any
  b.other[0].lines[0].cost_ex_gst = null
  b.other[0].total_ex_gst = null
  for (const k of Object.keys(b.totals)) b.totals[k] = null
  b.commission.amount_ex_gst = null
  assertEquals((checkBudget(b) as any).refusal, { code: 'gap_not_named', at: 'x1' })
  b.complete = false
  assertEquals((checkBudget(b) as any).refusal.code, 'complete_mismatch', 'complete: false with no gap listed')
  b.gaps = [{ where: 'other:skip_and_tip', key: 'x1', code: 'no_cost', what: 'No cost' }]
  assert(checkBudget(b).ok)

  // A negative commission (today's patio fault, T4) is refused, never stored.
  const loss = fenceLossBase() as any
  loss.commission.amount_ex_gst = -15
  loss.totals.commission_ex_gst = -15
  loss.totals.profit_after_commission_ex_gst = -85
  loss.totals.profit_after_commission_pct = -8.5
  assertEquals((checkBudget(loss) as any).refusal.code, 'commission_mismatch')
})

Deno.test('R17 checks: a supplier delivery line adds to delivery, not to the item lines (draft 3)', () => {
  const out = checkBudget(native.budgets.delivery)
  assert(out.ok, JSON.stringify(out))
  const lines = out.budget.lines.filter((l) => l.lane === 'materials')
  assertEquals(lines.map((l) => [l.key, l.kind, l.supplier_key]), [['m1', 'item', 'sup-a'], ['m2', 'item', 'sup-a'], ['sup-a:delivery', 'delivery', 'sup-a']])
  const bad = (mut: (b: any) => void) => {
    const b = structuredClone(native.budgets.delivery) as any
    mut(b)
    const r = checkBudget(b)
    return r.ok ? 'ok' : r.refusal.code
  }
  // The delivery counted in the item lines too, or left out of delivery, is refused.
  assertEquals(bad((b) => { b.materials.by_supplier[0].lines_ex_gst = 3120 }), 'supplier_lines_mismatch')
  assertEquals(bad((b) => { b.materials.by_supplier[0].delivery_ex_gst = 0 }), 'supplier_delivery_mismatch')
  assertEquals(bad((b) => { b.materials.lines[2].kind = 'freight' }), 'line_kind_invalid')
  assertEquals(bad((b) => { delete b.materials.lines[0].kind }), 'line_kind_invalid')
  // The sealed supplier_key is read, not worked out again, and must be its supplier's.
  assertEquals(bad((b) => { b.materials.lines[0].supplier_key = 'sup-b' }), 'supplier_key_mismatch')
  assertEquals(bad((b) => { delete b.materials.lines[0].supplier_key }), 'supplier_key_missing')
})

Deno.test('R17 checks: a one-figure patio (T1), the exact native shape: one counted figure in the one_figure entry', () => {
  for (const name of ['one_figure', 'patio_one_figure'] as const) {
    const b = native.budgets[name] as any
    const out = checkBudget(b)
    assert(out.ok, `${name}: ${JSON.stringify(out)}`)
    const lines = out.budget.lines.filter((l) => l.lane === 'materials')
    const counted = lines.filter((l) => l.in_total)
    assertEquals(counted.map((l) => [l.supplier_key, l.cost_from]), [['one_figure', 'one_figure']])
    // The order lines ride along with no cost under their real supplier, and are not gaps.
    assert(lines.filter((l) => !l.in_total).every((l) => l.cost_cents === null && l.supplier_key !== 'one_figure'))
    assertEquals(out.budget.summary.gap_count, 0)
    // A real supplier's entry may be all zeros.
    assert(b.materials.by_supplier.some((e: any) => e.key !== 'one_figure' && e.total_ex_gst === 0))
  }
  const bad = (mut: (b: any) => void) => {
    const b = structuredClone(native.budgets.one_figure) as any
    mut(b)
    const r = checkBudget(b)
    return r.ok ? 'ok' : r.refusal.code
  }
  // The one_figure entry has no supplier id, and only the one figure may sit in it.
  assertEquals(bad((b) => { b.materials.by_supplier[1].supplier.id = 'sup-a' }), 'supplier_key_mismatch')
  assertEquals(bad((b) => { b.materials.lines[2].supplier = { id: 'sup-a', name: 'Supplier A' } }), 'supplier_key_mismatch')
  assertEquals(bad((b) => { b.materials.lines[2].cost_from = 'typed' }), 'supplier_key_mismatch')
})

Deno.test('R17 checks: the fixings allowance (T2) is its own "none" entry, counted, not a gap', () => {
  const b = structuredClone(native.budgets.one_figure) as any
  b.materials.lines.push({ key: 'patio:fixings-allowance', line_id: null, supplier_key: 'none', supplier: { id: null, name: null, code: null }, kind: 'item', description: 'Fixings allowance', quantity: 1, unit: 'job', cut: null, unit_cost_ex_gst: 100, line_cost_ex_gst: 100, in_total: true, cost_from: 'allowance', note_to_supplier: null })
  b.materials.by_supplier.push({ key: 'none', supplier: { id: null, name: 'No supplier order' }, lines_ex_gst: 0, surcharge_ex_gst: 0, delivery_ex_gst: 0, total_ex_gst: 0 })
  const done = budgetAddedUp(b)
  assert(done.ok)
  const out = checkBudget(done.budget)
  assert(out.ok, JSON.stringify(out))
  assertEquals(out.budget.lines.find((l) => l.key === 'patio:fixings-allowance')?.supplier_key, 'none')
  assertEquals(out.budget.summary.materials_cents, 326500)
  assertEquals(out.budget.summary.gap_count, 0)
})

Deno.test('R17 checks: native sealed, saved and reopened budgets of both trades pass as given', () => {
  for (const [name, b] of Object.entries(native.budgets)) {
    const out = checkBudget(b)
    assert(out.ok, `${name}: ${JSON.stringify(out)}`)
    // Adding up again changes nothing: the record is what the tool made.
    const again = budgetAddedUp(b)
    assert(again.ok)
    assertEquals(again.budget, b, name)
  }
  // The fence's suppliers not on the list are named gaps: stored, complete false.
  const fence = checkBudget(native.budgets.fence_standard)
  assert(fence.ok)
  assertEquals(fence.budget.summary.complete, false)
})

Deno.test('R17 options formula: the tool\'s own shared examples (verify/r17-budget/options-examples.json), every case', () => {
  for (const tc of toolExamples.cases) {
    const raw = structuredClone((toolExamples.bases as any)[tc.base]) as any
    // The examples' made-up staff ids are not users.id (B9); give them one so the checks run.
    for (const who of [raw.job.scoped_by, raw.job.salesperson, raw.commission.salesperson]) who.staff_id = '22222222-2222-4222-8222-222222222222'
    const base = budgetAddedUp(raw)
    assert(base.ok)
    assert(checkBudget(base.budget).ok, `${tc.name}: base`)
    const b = applied(base.budget, tc.taken)
    const e = tc.expect as any
    assertEquals([b.job.sell_ex_gst, b.job.gst, b.job.total_inc_gst], [e.sell_ex_gst, e.gst, e.total_inc_gst], tc.name)
    for (const k of Object.keys(b.totals)) assertEquals(b.totals[k], e[k], `${tc.name}: ${k}`)
    assertEquals(b.taken_option_ids, tc.taken.length ? tc.taken : undefined, tc.name)
    const out = checkBudget(b)
    assert(out.ok, `${tc.name}: ${JSON.stringify(out)}`)
  }
})

Deno.test('R17 money is dollars to two decimals; a third decimal is refused, never rounded', () => {
  assertEquals(moneyCents(15.02, 'x'), 1502)
  assertEquals(moneyCents(null, 'x'), null)
  let code = ''
  try { moneyCents(15.015, 'x') } catch (e) { code = (e as Error).message }
  assertEquals(code, 'money_not_two_decimals')
})

Deno.test('R17 strip: a pricing record never carries its budget to a customer, trade or crew read', () => {
  const pricing = { totalIncGST: 11000, budget: patioBase(), runs: [] }
  assertEquals(withoutBudget(pricing as Record<string, unknown>), { totalIncGST: 11000, runs: [] })
  assertEquals(JSON.parse(withoutBudget(JSON.stringify(pricing))), { totalIncGST: 11000, runs: [] })
  assertEquals(withoutBudget({ a: 1 }), { a: 1 })
  assertEquals(withoutBudget(null), null)
  assertEquals(withoutBudget('not json'), 'not json')
})
