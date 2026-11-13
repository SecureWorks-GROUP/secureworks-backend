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

/** The by_supplier entry of the one figure for all materials (T1): no supplier of its own. */
export const ONE_FIGURE_KEY = 'one_figure'

/** What a materials line is: an item, or a delivery or cutting charge the supplier's order adds. */
export const MATERIAL_KINDS = ['item', 'delivery', 'cutting'] as const
export type MaterialKind = typeof MATERIAL_KINDS[number]

/**
 * The supplier_key a materials line or by_supplier entry was sealed with must be
 * the one its supplier gives, or the one-figure entry, which has no supplier id.
 * The fixings allowance (T2) has no supplier and so is the "none" entry.
 */
function sealedSupplierKey(raw: Record<string, unknown>, field: 'supplier_key' | 'key', at: string): string {
  const key = str(raw[field])
  if (!key) return refuse('supplier_key_missing', at)
  const supplier = isRec(raw.supplier) ? raw.supplier : {}
  if (key === ONE_FIGURE_KEY) {
    if (str(supplier.id)) return refuse('supplier_key_mismatch', at)
    return key
  }
  if (key !== supplierKeyOf(raw.supplier)) return refuse('supplier_key_mismatch', at)
  return key
}

/** One line of any lane, read for the checks and for job_budget_lines. */
export type BudgetLine = {
  lane: BudgetLane
  key: string
  line_id: string | null
  supplier_key: string | null
  kind: MaterialKind | null
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
  let kind: MaterialKind | null = null
  let supplierKey: string | null = null
  if (lane === 'materials') {
    if (!MATERIAL_KINDS.includes(raw.kind as MaterialKind)) return refuse('line_kind_invalid', key)
    kind = raw.kind as MaterialKind
    supplierKey = sealedSupplierKey(raw, 'supplier_key', key)
    // The one counted figure for all materials is the only line in the one_figure entry.
    if (supplierKey === ONE_FIGURE_KEY && raw.cost_from !== 'one_figure') return refuse('supplier_key_mismatch', key)
  }
  return {
    lane,
    key,
    line_id: lane === 'materials' ? str(raw.line_id) : null,
    supplier_key: supplierKey,
    kind,
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
  // Only a budget the options formula made carries taken_option_ids: each a sealed option, in options order.
  if (raw.taken_option_ids !== undefined) {
    const ids = raw.taken_option_ids
    const sealed = Array.isArray(raw.options) ? raw.options.map((o) => (isRec(o) ? str(o.option_id) : null)) : []
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || !sealed.includes(id))) {
      return refuse('taken_option_ids_invalid')
    }
    const order = ids.map((id) => sealed.indexOf(id as string))
    if (order.some((n, i) => i > 0 && n <= order[i - 1])) return refuse('taken_option_ids_invalid')
  }
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
    // "No supplier order"; the one-figure entry (T1) is key "one_figure", id null;
    // every other entry's key follows its supplier.
    sealedSupplierKey(entry, 'key', key)
    // Counted item and cutting lines add to lines_ex_gst, counted delivery lines to
    // delivery_ex_gst; each counts once in the supplier's total. Lines riding along
    // (in_total false: a one-figure job's order lines, not bought before) count nowhere.
    const own = lines.filter((l) => l.lane === 'materials' && l.supplier_key === key && l.in_total)
    const linesSum = moneyCents(entry.lines_ex_gst, `${key}.lines_ex_gst`)
    if (linesSum !== addAll(own.filter((l) => l.kind !== 'delivery').map((l) => l.cost_cents))) {
      return refuse('supplier_lines_mismatch', key)
    }
    const surcharge = moneyCents(entry.surcharge_ex_gst, `${key}.surcharge_ex_gst`)
    const delivery = moneyCents(entry.delivery_ex_gst, `${key}.delivery_ex_gst`)
    if (delivery !== addAll(own.filter((l) => l.kind === 'delivery').map((l) => l.cost_cents))) {
      return refuse('supplier_delivery_mismatch', key)
    }
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
  // Ruling 17 step 4: hourly pay carries its maximum. The rate times the
  // maximum hours is the maximum dollars, and that maximum is the allowance
  // (the labour amount, the lines adding up to it). Group pay carries none.
  if (labour.pay === 'group_work_order') {
    if (labour.hourly !== null && labour.hourly !== undefined) return refuse('labour_hourly_invalid')
  } else {
    const hourly = isRec(labour.hourly) ? labour.hourly : refuse('labour_hourly_invalid')
    const rate = moneyCents(hourly.rate_ex_gst, 'labour.hourly.rate_ex_gst')
    const maxHours = hourly.max_hours
    const max = moneyCents(hourly.max_ex_gst, 'labour.hourly.max_ex_gst')
    if (rate === null || rate <= 0 || max === null || typeof maxHours !== 'number' || !Number.isFinite(maxHours) ||
        maxHours <= 0 || Math.abs(maxHours * 100 - Math.round(maxHours * 100)) > 1e-6) {
      return refuse('labour_hourly_invalid')
    }
    if (max !== Math.round((rate * Math.round(maxHours * 100)) / 100) || labourAmount !== max) {
      return refuse('labour_hourly_mismatch')
    }
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
 * the order of `options[]`, and the result records them, in that order, as
 * `taken_option_ids` (contract section 5 step 4). No option taken returns the
 * base unchanged, with no `taken_option_ids`.
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
  // Sealed options order, as the tool's formula takes them.
  const taken = options.filter((o): o is Rec => isRec(o) && takenIds.includes(o.option_id as string))

  const job = b.job as Rec
  const materials = b.materials as Rec
  const labour = b.labour as Rec
  if (!isRec(job) || !isRec(materials) || !isRec(labour) || !Array.isArray(materials.lines) || !Array.isArray(materials.by_supplier) || !Array.isArray(labour.lines)) {
    return refuse('budget_unreadable')
  }
  const other = (Array.isArray(b.other) ? b.other : (b.other = [])) as Rec[]
  const gaps = (Array.isArray(b.gaps) ? b.gaps : (b.gaps = [])) as Rec[]

  let sell = moneyCents(job.sell_ex_gst, 'job.sell_ex_gst')
  let gst = moneyCents(job.gst, 'job.gst')
  let inc = moneyCents(job.total_inc_gst, 'job.total_inc_gst')
  for (const o of taken) {
    const key = `option:${o.option_id as string}`
    sell = add(sell, moneyCents(o.sell_ex_gst, `${key}.sell_ex_gst`) ?? refuse('option_sell_missing', key))
    gst = add(gst, moneyCents(o.gst, `${key}.gst`) ?? refuse('option_sell_missing', key))
    inc = add(inc, moneyCents(o.sell_inc_gst, `${key}.sell_inc_gst`) ?? refuse('option_sell_missing', key))
  }
  job.sell_ex_gst = dollars(sell)
  job.gst = dollars(gst)
  job.total_inc_gst = dollars(inc)

  for (const o of taken) {
    const key = `option:${o.option_id as string}`
    const cost = moneyCents(o.cost_ex_gst, `${key}.cost_ex_gst`)
    const x = isRec(o.line) ? o.line : {}
    const lands = isRec(o.lands) ? o.lands : refuse('option_lands_missing', key)
    const description = typeof x.description === 'string' ? x.description : ''
    const quantity = typeof x.quantity === 'number' ? x.quantity : 1
    const unit = str(x.unit) ?? 'each'

    if (lands.lane === 'materials') {
      const sup = isRec(lands.supplier) ? lands.supplier : {}
      const supId = str(sup.id)
      const supName = str(sup.name)
      const skey = supplierKeyOf({ id: supId, name: supName })
      const entries = materials.by_supplier as Rec[]
      let entry = entries.find((e) => e.key === skey)
      if (!entry) {
        // A supplier new to the job: an entry with no delivery of its own.
        entry = { key: skey, supplier: { id: supId, name: supName ?? '' }, lines_ex_gst: 0, surcharge_ex_gst: 0, delivery_ex_gst: 0, total_ex_gst: 0 }
        entries.push(entry)
      }
      entry.surcharge_ex_gst = dollars(add(
        moneyCents(entry.surcharge_ex_gst, `${skey}.surcharge_ex_gst`),
        moneyCents(o.surcharge_ex_gst ?? 0, `${key}.surcharge_ex_gst`) ?? 0,
      ))
      ;(materials.lines as unknown[]).push({
        key, description, quantity, unit, in_total: true,
        line_id: null, supplier_key: skey, supplier: { id: supId, name: supName, code: null }, kind: 'item',
        unit_cost_ex_gst: null, line_cost_ex_gst: dollars(cost), cost_from: cost === null ? 'none' : 'typed', note_to_supplier: null,
      })
      if (!supId) gaps.push({ where: 'materials', key, code: 'no_supplier_id', what: 'Supplier not on the list' })
    } else if (lands.lane === 'labour') {
      ;(labour.lines as unknown[]).push({ key, task: description, people: null, days: null, day_rate_ex_gst: null, amount_ex_gst: dollars(cost), in_total: true })
    } else if (OTHER_LANES.includes(lands.lane as OtherLane)) {
      const lane = lands.lane as OtherLane
      let entry = other.find((e) => e.lane === lane)
      if (!entry) {
        entry = { lane, lines: [], total_ex_gst: 0 }
        other.push(entry)
      }
      ;(entry.lines as unknown[]).push({ key, description, quantity, unit, in_total: true, cost_ex_gst: dollars(cost), paid_to: str(lands.paid_to) ?? 'office', supplier: null })
    } else {
      return refuse('option_lane_unknown', key)
    }
  }
  b.taken_option_ids = taken.map((o) => o.option_id as string)
  return addUp(b)
}

/**
 * The record added up again from its lines (a new record; the input is not
 * changed). The options formula ends with it; tests use it to finish the
 * tool's shared example bases exactly as the tool does.
 */
export function budgetAddedUp(b: unknown): { ok: true; budget: Rec } | { ok: false; refusal: BudgetRefusal } {
  try {
    if (!isRec(b)) return refuse('budget_not_an_object')
    return { ok: true, budget: addUp(structuredClone(b) as Rec) }
  } catch (e) {
    if (e instanceof Refused) return { ok: false, refusal: e.refusal }
    return { ok: false, refusal: { code: 'budget_unreadable' } }
  }
}

/**
 * Adds the record up again from its lines, the way the tool's finish does: each
 * supplier's item and cutting lines, its delivery lines and total; materials,
 * labour and the work order; each other lane (empty lanes dropped, lanes in
 * contract order); the totals; and the gaps (every counted line with no cost is
 * a no_cost gap, other gaps kept).
 */
function addUp(b: Rec): Rec {
  const lineCost = (l: Rec, field: string) => moneyCents(l[field], `${l.key}.cost`)
  const counted = (l: Rec) => l.in_total !== false
  const kept = (b.gaps as Rec[]).filter((g) => g.code !== 'no_cost')
  const noCost: Rec[] = []
  const materials = b.materials as Rec
  const mLines = materials.lines as Rec[]
  for (const s of materials.by_supplier as Rec[]) {
    const mine = mLines.filter((l) => l.supplier_key === s.key && counted(l))
    const items = addAll(mine.filter((l) => l.kind !== 'delivery').map((l) => lineCost(l, 'line_cost_ex_gst')))
    const delivery = addAll(mine.filter((l) => l.kind === 'delivery').map((l) => lineCost(l, 'line_cost_ex_gst')))
    s.lines_ex_gst = dollars(items)
    s.delivery_ex_gst = dollars(delivery)
    s.total_ex_gst = dollars(addAll([items, moneyCents(s.surcharge_ex_gst, `${s.key}.surcharge_ex_gst`), delivery]))
  }
  for (const l of mLines) if (counted(l) && lineCost(l, 'line_cost_ex_gst') === null) noCost.push({ where: 'materials', key: l.key, code: 'no_cost', what: 'No cost' })
  const materialsTotal = addAll((materials.by_supplier as Rec[]).map((s) => moneyCents(s.total_ex_gst, `${s.key}.total_ex_gst`)))
  materials.total_ex_gst = dollars(materialsTotal)
  const labour = b.labour as Rec
  const lLines = labour.lines as Rec[]
  for (const l of lLines) if (counted(l) && lineCost(l, 'amount_ex_gst') === null) noCost.push({ where: 'labour', key: l.key, code: 'no_cost', what: 'No cost' })
  const labourAmount = addAll(lLines.filter(counted).map((l) => lineCost(l, 'amount_ex_gst')))
  labour.amount_ex_gst = dollars(labourAmount)
  const other = (b.other as Rec[])
    .filter((o) => Array.isArray(o.lines) && (o.lines as unknown[]).length > 0)
    .sort((x, y) => OTHER_LANES.indexOf(x.lane as OtherLane) - OTHER_LANES.indexOf(y.lane as OtherLane))
  b.other = other
  for (const o of other) {
    const ls = o.lines as Rec[]
    for (const l of ls) if (counted(l) && lineCost(l, 'cost_ex_gst') === null) noCost.push({ where: `other:${o.lane}`, key: l.key, code: 'no_cost', what: 'No cost' })
    o.total_ex_gst = dollars(addAll(ls.filter(counted).map((l) => lineCost(l, 'cost_ex_gst'))))
  }
  const crew = other.flatMap((o) => (o.lines as Rec[]).filter((l) => counted(l) && l.paid_to === 'crew'))
  labour.work_order_amount_ex_gst = dollars(addAll([labourAmount, ...crew.map((l) => lineCost(l, 'cost_ex_gst'))]))
  const cost = addAll([materialsTotal, labourAmount, ...other.map((o) => moneyCents(o.total_ex_gst, `${o.lane}.total_ex_gst`))])
  const job = b.job as Rec
  const sell = moneyCents(job.sell_ex_gst, 'job.sell_ex_gst')
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
  b.gaps = [...kept, ...noCost]
  b.complete = (b.gaps as Rec[]).length === 0
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
