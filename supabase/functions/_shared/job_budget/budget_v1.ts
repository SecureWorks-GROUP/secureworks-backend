// Ruling 17 step 1: the job budget, `budget.v1` (contract: docs/job-budget-v1.md).
//
// The Scope Engine builds the budget at seal from the figures its Cost review
// screen shows, and freezes it inside the revision's pricing record. The job
// system stores it at acceptance exactly as given. This module is the job
// system's only reader of that record. It does three things and no other
// arithmetic:
//   1. checks the record adds up, to the cent (checkBudget);
//   2. applies the options the customer took, by the one formula the contract
//      allows (budgetWithOptions, contract section 5);
//   3. flattens the lines for job_budget_lines (budgetLines).
//
// Every sum is worked in whole cents (integers). Money in the record is dollars
// with at most two decimal places; a third decimal is refused, never rounded.
// An unknown cost is null and stays null: a total is null when any line it adds
// is null. Nothing here invents a figure or pads a gap with zero.
//
// No operator share of gross profit is read, kept or worked out here.

export const BUDGET_VERSION = 'budget.v1'

export const OTHER_LANES = ['delivery', 'removal', 'skip_and_tip', 'hire', 'buffer', 'other'] as const
export type OtherLane = typeof OTHER_LANES[number]
export const BUDGET_LANES = ['materials', 'labour', ...OTHER_LANES] as const
export type BudgetLane = typeof BUDGET_LANES[number]

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)

/** A refusal: a check's code and, where it helps, the key or field it failed on.
 * Codes and keys only: they are written to job_events, which trades can read. */
export type BudgetRefusal = { code: string; at?: string }

class Refused extends Error {
  constructor(readonly refusal: BudgetRefusal) {
    super(refusal.code)
  }
}
const refuse = (code: string, at?: string): never => {
  throw new Refused(at ? { code, at } : { code })
}

// ── Money in whole cents ─────────────────────────────────────────────────────

/** Dollars (a JSON number, at most two decimals) to whole cents; null stays null. */
export function moneyCents(v: unknown, at: string): number | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' || !Number.isFinite(v)) return refuse('money_not_a_number', at)
  const c = Math.round(v * 100)
  if (Math.abs(v * 100 - c) > 1e-6) return refuse('money_not_two_decimals', at)
  if (!Number.isSafeInteger(c)) return refuse('money_out_of_range', at)
  return c
}

/** Whole cents back to dollars for the stored record. */
export const dollars = (c: number | null): number | null => (c === null ? null : c / 100)

/** Integer division rounded half away from zero. */
export function halfAway(num: number, den: number): number {
  const s = Math.sign(num) * Math.sign(den)
  const a = Math.abs(num)
  const b = Math.abs(den)
  return s * Math.floor((2 * a + b) / (2 * b))
}

const addAll = (xs: Array<number | null>): number | null =>
  xs.some((x) => x === null) ? null : (xs as number[]).reduce((a, b) => a + b, 0)
const add = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b)

/** A percent of sell, in hundredths of a percent (34.85% -> 3485); null as the contract says. */
export function pctHundredths(part: number | null, sell: number | null): number | null {
  if (part === null || sell === null || sell === 0) return null
  return halfAway(part * 10000, sell)
}

/** Commission: 0 when gross profit is zero or less, else pct of it, half up to the cent. */
export function commissionCents(gp: number | null, pctH: number | null): number | null {
  if (gp === null || pctH === null) return null
  if (gp <= 0) return 0
  return halfAway(gp * pctH, 10000)
}

// ── Reading the record ───────────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/** The percent as given (8, 8.5, 15.00) in hundredths; null stays null. */
function pctOf(v: unknown, at: string): number | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) return refuse('pct_invalid', at)
  const h = Math.round(v * 100)
  if (Math.abs(v * 100 - h) > 1e-6) return refuse('pct_not_two_decimals', at)
  return h
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A staff id is public.users.id (a uuid) or null. */
function staffId(v: unknown, at: string): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string' || !UUID_RE.test(v)) return refuse('staff_id_not_uuid', at)
  return v.toLowerCase()
}

/** The by_supplier key a materials line belongs to (contract section 2). */
export function supplierKeyOf(supplier: unknown): string {
  const s = isRec(supplier) ? supplier : {}
  const id = str(s.id)
  if (id) return id
  const name = str(s.name)
  return name && name !== NO_SUPPLIER_NAME ? `name:${name}` : 'none'
}

/** The name the contract gives the no-supplier entry (T2). */
export const NO_SUPPLIER_NAME = 'No supplier order'

/** One line of any lane, read for the checks and for job_budget_lines. */
export type BudgetLine = {
  lane: BudgetLane
  key: string
  line_id: string | null
  supplier_key: string | null
  supplier_id: string | null
  supplier_name: string | null
  description: string | null
  quantity: number | null
  unit: string | null
  unit_cost_cents: number | null
  cost_cents: number | null
  in_total: boolean
  paid_to: string | null
  cost_from: string | null
  option_id: string | null
}

function readLine(lane: BudgetLane, raw: unknown, i: number): BudgetLine {
  const at = `${lane}[${i}]`
  if (!isRec(raw)) return refuse('line_invalid', at)
  const key = str(raw.key)
  if (!key) return refuse('line_key_missing', at)
  if (typeof raw.in_total !== 'boolean') return refuse('line_in_total_missing', key)
  const supplier = isRec(raw.supplier) ? raw.supplier : null
  const costField = lane === 'materials' ? 'line_cost_ex_gst' : lane === 'labour' ? 'amount_ex_gst' : 'cost_ex_gst'
  const quantity = raw.quantity === null || raw.quantity === undefined
    ? null
    : typeof raw.quantity === 'number' && Number.isFinite(raw.quantity) ? raw.quantity : refuse('line_quantity_invalid', key)
  const optionId = key.startsWith('option:') ? key.slice('option:'.length) : null
  return {
    lane,
    key,
    line_id: lane === 'materials' ? str(raw.line_id) : null,
    supplier_key: lane === 'materials' ? supplierKeyOf(raw.supplier) : null,
    supplier_id: supplier ? str(supplier.id) : null,
    supplier_name: supplier ? str(supplier.name) : null,
    description: str(raw.description) ?? str(raw.task),
    quantity,
    unit: str(raw.unit),
    unit_cost_cents: moneyCents(lane === 'materials' ? raw.unit_cost_ex_gst : lane === 'labour' ? raw.day_rate_ex_gst : null, `${key}.unit_cost`),
    cost_cents: moneyCents(raw[costField], `${key}.cost`),
    in_total: raw.in_total,
    paid_to: lane === 'materials' ? 'supplier' : lane === 'labour' ? 'crew' : str(raw.paid_to),
    cost_from: str(raw.cost_from),
    option_id: optionId,
  }
}

/** The figures the job system stores in job_budgets, in whole cents. */
export type BudgetSummary = {
  trade: 'patio' | 'fence'
  scope_revision_id: string | null
  sell_cents: number | null
  gst_cents: number | null
  total_inc_cents: number | null
  materials_cents: number | null
  labour_cents: number | null
  work_order_cents: number | null
  other_cents: number | null
  cost_cents: number | null
  gross_profit_cents: number | null
  gross_profit_pct_h: number | null
  commission_cents: number | null
  commission_pct_h: number | null
  commission_rule_id: string | null
  profit_after_cents: number | null
  profit_after_pct_h: number | null
  scoped_by_staff_id: string | null
  salesperson_staff_id: string | null
  complete: boolean
  gap_count: number
}

export type CheckedBudget = { summary: BudgetSummary; lines: BudgetLine[] }

/**
 * Checks the record adds up to the cent (contract section 8, check 3) and reads
 * it. Throws nothing: a record that does not add up comes back as a refusal
 * with the first failed check's code.
 */
export function checkBudget(raw: unknown): { ok: true; budget: CheckedBudget } | { ok: false; refusal: BudgetRefusal } {
  try {
    return { ok: true, budget: check(raw) }
  } catch (e) {
    if (e instanceof Refused) return { ok: false, refusal: e.refusal }
    return { ok: false, refusal: { code: 'budget_unreadable' } }
  }
}

function check(raw: unknown): CheckedBudget {
  if (!isRec(raw)) return refuse('budget_not_an_object')
  if (raw.version !== BUDGET_VERSION) return refuse('budget_version_unknown')
  if (raw.trade !== 'patio' && raw.trade !== 'fence') return refuse('budget_trade_unknown')
  const job = isRec(raw.job) ? raw.job : refuse('job_missing')
  const materials = isRec(raw.materials) ? raw.materials : refuse('materials_missing')
  const labour = isRec(raw.labour) ? raw.labour : refuse('labour_missing')
  const commission = isRec(raw.commission) ? raw.commission : refuse('commission_missing')
  const totals = isRec(raw.totals) ? raw.totals : refuse('totals_missing')
  const gaps = Array.isArray(raw.gaps) ? raw.gaps : refuse('gaps_missing')
  if (typeof raw.complete !== 'boolean') return refuse('complete_missing')
  if (raw.other !== undefined && !Array.isArray(raw.other)) return refuse('other_invalid')
  if (!Array.isArray(materials.lines) || !Array.isArray(materials.by_supplier)) return refuse('materials_invalid')
  if (!Array.isArray(labour.lines)) return refuse('labour_invalid')

  // Sell and GST.
  const sell = moneyCents(job.sell_ex_gst, 'job.sell_ex_gst')
  const gst = moneyCents(job.gst, 'job.gst')
  const inc = moneyCents(job.total_inc_gst, 'job.total_inc_gst')
  const sellNulls = [sell, gst, inc].filter((x) => x === null).length
  if (sellNulls !== 0 && sellNulls !== 3) return refuse('sell_partly_unknown', 'job')
  if (sell !== null && sell + (gst as number) !== inc) return refuse('gst_mismatch', 'job')

  // Lines, every lane. Keys are unique across the whole budget.
  const lines: BudgetLine[] = []
  materials.lines.forEach((l, i) => lines.push(readLine('materials', l, i)))
  labour.lines.forEach((l, i) => lines.push(readLine('labour', l, i)))
  const otherLanes = (raw.other ?? []) as unknown[]
  const laneTotals = new Map<OtherLane, number | null>()
  for (const [i, entry] of otherLanes.entries()) {
    if (!isRec(entry)) return refuse('other_invalid', `other[${i}]`)
    const lane = entry.lane as OtherLane
    if (!OTHER_LANES.includes(lane)) return refuse('lane_unknown', `other[${i}]`)
    if (laneTotals.has(lane)) return refuse('lane_repeated', lane)
    if (!Array.isArray(entry.lines)) return refuse('other_invalid', lane)
    const own = entry.lines.map((l, j) => readLine(lane, l, j))
    for (const l of own) {
      if (!['supplier', 'crew', 'office'].includes(l.paid_to ?? '')) return refuse('line_paid_to_invalid', l.key)
    }
    lines.push(...own)
    const total = moneyCents(entry.total_ex_gst, `${lane}.total_ex_gst`)
    if (total !== addAll(own.filter((l) => l.in_total).map((l) => l.cost_cents))) return refuse('lane_total_mismatch', lane)
    laneTotals.set(lane, total)
  }
  const seen = new Set<string>()
  for (const l of lines) {
    if (seen.has(l.key)) return refuse('key_not_unique', l.key)
    seen.add(l.key)
  }

  // Materials: lines add to each supplier, suppliers add to materials.
  const supplierTotals: Array<number | null> = []
  const supplierKeys = new Set<string>()
  for (const [i, entry] of materials.by_supplier.entries()) {
    if (!isRec(entry)) return refuse('supplier_invalid', `by_supplier[${i}]`)
    const key = str(entry.key)
    if (!key) return refuse('supplier_key_missing', `by_supplier[${i}]`)
    if (supplierKeys.has(key)) return refuse('supplier_repeated', key)
    supplierKeys.add(key)
    // The no-supplier entry (fixings allowance, T2) is key "none", id null, named
    // "No supplier order"; every other entry's key follows its supplier.
    if (key !== supplierKeyOf(entry.supplier)) return refuse('supplier_key_mismatch', key)
    const own = lines.filter((l) => l.lane === 'materials' && l.supplier_key === key && l.in_total)
    const linesSum = moneyCents(entry.lines_ex_gst, `${key}.lines_ex_gst`)
    if (linesSum !== addAll(own.map((l) => l.cost_cents))) return refuse('supplier_lines_mismatch', key)
    const surcharge = moneyCents(entry.surcharge_ex_gst, `${key}.surcharge_ex_gst`)
    const delivery = moneyCents(entry.delivery_ex_gst, `${key}.delivery_ex_gst`)
    const total = moneyCents(entry.total_ex_gst, `${key}.total_ex_gst`)
    if (total !== addAll([linesSum, surcharge, delivery])) return refuse('supplier_total_mismatch', key)
    supplierTotals.push(total)
  }
  for (const l of lines) {
    if (l.lane === 'materials' && !supplierKeys.has(l.supplier_key as string)) return refuse('line_supplier_not_listed', l.key)
  }
  const materialsTotal = moneyCents(materials.total_ex_gst, 'materials.total_ex_gst')
  if (materialsTotal !== addAll(supplierTotals)) return refuse('materials_total_mismatch')
  if (typeof materials.priced_by_line !== 'boolean') return refuse('materials_priced_by_line_missing')

  // Labour and the work order.
  if (labour.pay !== 'group_work_order' && labour.pay !== 'hourly_capped') return refuse('labour_pay_unknown')
  const labourAmount = moneyCents(labour.amount_ex_gst, 'labour.amount_ex_gst')
  if (labourAmount !== addAll(lines.filter((l) => l.lane === 'labour' && l.in_total).map((l) => l.cost_cents))) {
    return refuse('labour_amount_mismatch')
  }
  const crewOther = lines.filter((l) => l.lane !== 'materials' && l.lane !== 'labour' && l.in_total && l.paid_to === 'crew')
  const workOrder = moneyCents(labour.work_order_amount_ex_gst, 'labour.work_order_amount_ex_gst')
  if (workOrder !== addAll([labourAmount, ...crewOther.map((l) => l.cost_cents)])) return refuse('work_order_amount_mismatch')

  // Totals.
  const otherTotal = addAll([...laneTotals.values()])
  const cost = addAll([materialsTotal, labourAmount, otherTotal])
  if (moneyCents(totals.cost_before_commission_ex_gst, 'totals.cost') !== cost) return refuse('cost_mismatch')
  const gp = cost === null || sell === null ? null : sell - cost
  if (moneyCents(totals.gross_profit_ex_gst, 'totals.gross_profit') !== gp) return refuse('gross_profit_mismatch')
  if (pctOfSigned(totals.gross_profit_pct, 'totals.gross_profit_pct') !== pctHundredths(gp, sell)) return refuse('gross_profit_pct_mismatch')
  const pctH = pctOf(commission.pct, 'commission.pct')
  const com = commissionCents(gp, pctH)
  if (moneyCents(commission.amount_ex_gst, 'commission.amount_ex_gst') !== com) return refuse('commission_mismatch')
  if (moneyCents(totals.commission_ex_gst, 'totals.commission') !== com) return refuse('commission_mismatch', 'totals')
  if (commission.basis !== 'gross_profit') return refuse('commission_basis_unknown')
  const after = gp === null || com === null ? null : gp - com
  if (moneyCents(totals.profit_after_commission_ex_gst, 'totals.profit_after') !== after) return refuse('profit_after_mismatch')
  if (pctOfSigned(totals.profit_after_commission_pct, 'totals.profit_after_pct') !== pctHundredths(after, sell)) {
    return refuse('profit_after_pct_mismatch')
  }

  // Gaps: complete means none, and every unknown the record counts is named.
  const gapKeys = new Set<string>()
  for (const [i, g] of gaps.entries()) {
    if (!isRec(g) || !str(g.code) || !str(g.where)) return refuse('gap_invalid', `gaps[${i}]`)
    gapKeys.add(`${g.where}|${g.key ?? ''}|${g.code}`)
  }
  if (raw.complete !== (gaps.length === 0)) return refuse('complete_mismatch')
  const named = (code: string, key: string | null) =>
    [...gapKeys].some((k) => k.endsWith(`|${code}`) && (key === null || k.split('|')[1] === key))
  for (const l of lines) {
    if (l.in_total && l.cost_cents === null && !named('no_cost', l.key)) return refuse('gap_not_named', l.key)
  }
  if (sell === null && !named('no_sell', null)) return refuse('gap_not_named', 'job')
  if (pctH === null && !named('no_rate', null)) return refuse('gap_not_named', 'commission')

  const scopedBy = isRec(job.scoped_by) ? job.scoped_by : {}
  const salesperson = isRec(job.salesperson) ? job.salesperson : {}
  return {
    lines,
    summary: {
      trade: raw.trade,
      scope_revision_id: str(job.scope_revision_id),
      sell_cents: sell,
      gst_cents: gst,
      total_inc_cents: inc,
      materials_cents: materialsTotal,
      labour_cents: labourAmount,
      work_order_cents: workOrder,
      other_cents: otherTotal,
      cost_cents: cost,
      gross_profit_cents: gp,
      gross_profit_pct_h: pctHundredths(gp, sell),
      commission_cents: com,
      commission_pct_h: pctH,
      commission_rule_id: str(commission.rule_id),
      profit_after_cents: after,
      profit_after_pct_h: pctHundredths(after, sell),
      scoped_by_staff_id: staffId(scopedBy.staff_id, 'job.scoped_by'),
      salesperson_staff_id: staffId(salesperson.staff_id, 'job.salesperson'),
      complete: raw.complete,
      gap_count: gaps.length,
    },
  }
}

/** A percent that may be negative (a loss), in hundredths; null stays null. */
function pctOfSigned(v: unknown, at: string): number | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' || !Number.isFinite(v)) return refuse('pct_invalid', at)
  const h = Math.round(v * 100)
  if (Math.abs(v * 100 - h) > 1e-6) return refuse('pct_not_two_decimals', at)
  return h
}

// ── The options formula (contract section 5) ─────────────────────────────────

/**
 * The base budget with the taken options added, by the contract's one formula.
 * Returns a new record (the input is not changed). Taken ids are applied in
 * the order of `options[]`. No option taken returns the base unchanged.
 */
export function budgetWithOptions(
  base: unknown,
  takenIds: readonly string[],
): { ok: true; budget: Rec } | { ok: false; refusal: BudgetRefusal } {
  try {
    return { ok: true, budget: withOptions(base, takenIds) }
  } catch (e) {
    if (e instanceof Refused) return { ok: false, refusal: e.refusal }
    return { ok: false, refusal: { code: 'budget_unreadable' } }
  }
}

function withOptions(base: unknown, takenIds: readonly string[]): Rec {
  if (!isRec(base)) return refuse('budget_not_an_object')
  const b = structuredClone(base) as Rec
  if (takenIds.length === 0) return b
  const options = Array.isArray(b.options) ? (b.options as unknown[]) : []
  const byId = new Map<string, Rec>()
  for (const o of options) if (isRec(o) && str(o.option_id)) byId.set(o.option_id as string, o)
  for (const id of takenIds) if (!byId.has(id)) return refuse('option_not_in_budget', `option:${id}`)
  const taken = options.filter((o): o is Rec => isRec(o) && takenIds.includes(o.option_id as string))

  const job = b.job as Rec
  const materials = b.materials as Rec
  const labour = b.labour as Rec
  const gaps = b.gaps as unknown[]
  const other = (Array.isArray(b.other) ? b.other : (b.other = [])) as Rec[]

  let sell = moneyCents(job.sell_ex_gst, 'job.sell_ex_gst')
  let gst = moneyCents(job.gst, 'job.gst')
  let inc = moneyCents(job.total_inc_gst, 'job.total_inc_gst')
  let labourAmount = moneyCents(labour.amount_ex_gst, 'labour.amount_ex_gst')
  let workOrder = moneyCents(labour.work_order_amount_ex_gst, 'labour.work_order_amount_ex_gst')

  for (const o of taken) {
    const id = o.option_id as string
    const key = `option:${id}`
    sell = add(sell, moneyCents(o.sell_ex_gst, `${key}.sell_ex_gst`) ?? refuse('option_sell_missing', key))
    gst = add(gst, moneyCents(o.gst, `${key}.gst`) ?? refuse('option_sell_missing', key))
    inc = add(inc, moneyCents(o.sell_inc_gst, `${key}.sell_inc_gst`) ?? refuse('option_sell_missing', key))
    const cost = moneyCents(o.cost_ex_gst, `${key}.cost_ex_gst`)
    const surcharge = cost === null ? 0 : moneyCents(o.surcharge_ex_gst ?? 0, `${key}.surcharge_ex_gst`) ?? 0
    const line = isRec(o.line) ? o.line : {}
    const lands = isRec(o.lands) ? o.lands : refuse('option_lands_missing', key)
    const description = str(line.description) ?? id
    const quantity = typeof line.quantity === 'number' ? line.quantity : null
    const unit = str(line.unit)

    if (lands.lane === 'materials') {
      const supplier = isRec(lands.supplier) ? lands.supplier : { id: null, name: null }
      ;(materials.lines as unknown[]).push({
        key, line_id: null,
        supplier: { id: str(supplier.id), name: str(supplier.name), code: null },
        description, quantity, unit, cut: null,
        unit_cost_ex_gst: null, line_cost_ex_gst: dollars(cost),
        in_total: true, cost_from: 'option', note_to_supplier: null,
      })
      const skey = supplierKeyOf(supplier)
      const entries = materials.by_supplier as Rec[]
      let entry = entries.find((e) => e.key === skey)
      if (!entry) {
        // A supplier not yet on the job: no delivery was allowed for it (0, known).
        entry = { key: skey, supplier: { id: str(supplier.id), name: str(supplier.name) ?? NO_SUPPLIER_NAME }, lines_ex_gst: 0, surcharge_ex_gst: 0, delivery_ex_gst: 0, total_ex_gst: 0 }
        entries.push(entry)
      }
      const lines = add(moneyCents(entry.lines_ex_gst, `${skey}.lines_ex_gst`), cost)
      const sur = moneyCents(entry.surcharge_ex_gst, `${skey}.surcharge_ex_gst`)
      const surNext = sur === null ? null : sur + surcharge
      entry.lines_ex_gst = dollars(lines)
      entry.surcharge_ex_gst = dollars(surNext)
      entry.total_ex_gst = dollars(addAll([lines, surNext, moneyCents(entry.delivery_ex_gst, `${skey}.delivery_ex_gst`)]))
      if (cost === null) gaps.push({ where: 'materials', key, code: 'no_cost', what: 'No cost' })
    } else if (lands.lane === 'labour') {
      ;(labour.lines as unknown[]).push({ key, task: description, people: null, days: null, day_rate_ex_gst: null, amount_ex_gst: dollars(cost), in_total: true })
      labourAmount = add(labourAmount, cost)
      workOrder = add(workOrder, cost)
      if (cost === null) gaps.push({ where: 'labour', key, code: 'no_cost', what: 'No cost' })
    } else if (OTHER_LANES.includes(lands.lane as OtherLane)) {
      const lane = lands.lane as OtherLane
      const paidTo = lands.paid_to === 'supplier' || lands.paid_to === 'crew' ? lands.paid_to : 'office'
      let entry = other.find((e) => e.lane === lane)
      if (!entry) {
        entry = { lane, lines: [], total_ex_gst: 0 }
        other.push(entry)
      }
      ;(entry.lines as unknown[]).push({ key, description, quantity, unit, cost_ex_gst: dollars(cost), in_total: true, paid_to: paidTo, supplier: null })
      entry.total_ex_gst = dollars(add(moneyCents(entry.total_ex_gst, `${lane}.total_ex_gst`), cost))
      if (paidTo === 'crew') workOrder = add(workOrder, cost)
      if (cost === null) gaps.push({ where: `other:${lane}`, key, code: 'no_cost', what: 'No cost' })
    } else {
      return refuse('option_lane_unknown', key)
    }
  }

  job.sell_ex_gst = dollars(sell)
  job.gst = dollars(gst)
  job.total_inc_gst = dollars(inc)
  labour.amount_ex_gst = dollars(labourAmount)
  labour.work_order_amount_ex_gst = dollars(workOrder)
  const materialsTotal = addAll((materials.by_supplier as Rec[]).map((e) => moneyCents(e.total_ex_gst, `${e.key}.total_ex_gst`)))
  materials.total_ex_gst = dollars(materialsTotal)

  const cost = addAll([materialsTotal, labourAmount, ...other.map((e) => moneyCents(e.total_ex_gst, `${e.lane}.total_ex_gst`))])
  const gp = cost === null || sell === null ? null : sell - cost
  const commission = b.commission as Rec
  const com = commissionCents(gp, pctOf(commission.pct, 'commission.pct'))
  const after = gp === null || com === null ? null : gp - com
  const pct = (h: number | null) => (h === null ? null : h / 100)
  commission.amount_ex_gst = dollars(com)
  b.totals = {
    cost_before_commission_ex_gst: dollars(cost),
    gross_profit_ex_gst: dollars(gp),
    gross_profit_pct: pct(pctHundredths(gp, sell)),
    commission_ex_gst: dollars(com),
    profit_after_commission_ex_gst: dollars(after),
    profit_after_commission_pct: pct(pctHundredths(after, sell)),
  }
  b.complete = gaps.length === 0
  return b
}

// ── Stripping it where it must never go ──────────────────────────────────────

/**
 * A pricing record (jobs.pricing_json or a sealed revision's pricing) without
 * its budget, for any read a customer, a trade or a crew document receives.
 * The budget carries commission and the salesperson (contract section 7).
 * Accepts an object or a JSON string and gives back the same kind.
 */
export function withoutBudget<T>(pricing: T): T {
  if (typeof pricing === 'string') {
    if (!pricing.includes('"budget"')) return pricing
    try {
      const parsed = JSON.parse(pricing)
      if (!isRec(parsed) || !('budget' in parsed)) return pricing
      const { budget: _b, ...rest } = parsed
      return JSON.stringify(rest) as unknown as T
    } catch {
      return pricing
    }
  }
  if (!isRec(pricing) || !('budget' in pricing)) return pricing
  const { budget: _b, ...rest } = pricing
  return rest as unknown as T
}
