// Ruling 14 step 1 (13 Nov 2026): optional extras the customer ticks when accepting.
//
// Contract: pricing_json.optional_extras v1, written by the quote tools
// (data contract "options on a quote", section 2 and 3). Every base figure in
// the sealed pricing stays the price WITHOUT options; the tool precomputes one
// `combinations` entry per tickable set (2^n, n <= 6) with the accepted totals,
// deposit, payment schedule, local invoice stages and party shares. The job
// system never adds GST, splits a deposit or rounds a payment: it picks the
// combination for the ticked set and checks it (section 3) before using it.
//
// Pure: no reads, no writes. The accept handler reads the released revision's
// pricing (never the live job), calls these, and writes the record.
//
// A revision with no optional_extras block is byte-for-byte today: none() is
// returned and nothing here touches the acceptance.
import { goesOnSupplierCopy } from '../_shared/quote_options/supplier_copy_rule.ts'

export const MAX_QUOTE_OPTIONS = 6

export type QuoteOption = {
  id: string
  name: string
  line: string
  quantity: number | null
  unit: string | null
  sell_ex_gst: number
  gst: number
  sell_inc_gst: number
  payer_id: string | null
  goes: 'supplier' | 'crew' | 'office'
  cost_ex_gst: number | null
  cost_kind: 'materials' | 'labour' | 'other'
  order_line?: Record<string, unknown>
  labour_line?: Record<string, unknown>
  office_line?: Record<string, unknown>
  /** Fence only: the pricing_json.line_items[] custom entry it would be in the price. */
  line_item?: Record<string, unknown>
  /** The entry exactly as sealed in optional_extras.options[] (kept on the record). */
  sealed: Record<string, unknown>
}

export type OptionCombination = {
  option_ids: string[]
  totalExGST: number
  gst: number
  totalIncGST: number
  deposit_inc_gst: number
  payment_schedule?: Record<string, unknown>
  local_invoice_stages?: Record<string, unknown>
  parties?: Array<Record<string, unknown>>
  /** The entry exactly as sealed in optional_extras.combinations[] (kept on the record). */
  sealed: Record<string, unknown>
}

export type QuoteOptionsOffer = {
  version: 1
  sentence: string
  options: QuoteOption[]
  combinations: OptionCombination[]
}

export type QuoteOptionsRead =
  | { kind: 'none' }
  | { kind: 'offer'; offer: QuoteOptionsOffer }
  | { kind: 'invalid'; reason: string }

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v)

/** Whole cents of a money number; null when not a finite number with at most 2 decimals. */
export function cents(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const c = Math.round(v * 100)
  return Math.abs(c - v * 100) < 1e-6 ? c : null
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

function readOption(raw: unknown): QuoteOption | string {
  if (!isRec(raw)) return 'option_not_an_object'
  const id = nonEmptyString(raw.id)
  if (!id) return 'option_id_missing'
  const name = nonEmptyString(raw.name)
  if (!name) return 'option_name_missing'
  const line = typeof raw.line === 'string' ? raw.line : ''
  const ex = cents(raw.sell_ex_gst)
  const gst = cents(raw.gst)
  const inc = cents(raw.sell_inc_gst)
  if (ex == null || gst == null || inc == null) return 'option_price_unreadable'
  if (ex <= 0) return 'option_price_not_positive'
  if (gst !== Math.round(ex * 0.1)) return 'option_gst_not_ten_percent'
  if (ex + gst !== inc) return 'option_inc_gst_mismatch'
  const goes = raw.goes
  if (goes !== 'supplier' && goes !== 'crew' && goes !== 'office') return 'option_goes_unknown'
  const costKind = raw.cost_kind
  if (costKind !== 'materials' && costKind !== 'labour' && costKind !== 'other') return 'option_cost_kind_unknown'
  let cost: number | null = null
  if (raw.cost_ex_gst != null) {
    const c = cents(raw.cost_ex_gst)
    if (c == null || c < 0) return 'option_cost_unreadable'
    cost = c / 100
  }
  const lineKey = goes === 'supplier' ? 'order_line' : goes === 'crew' ? 'labour_line' : 'office_line'
  if (!isRec(raw[lineKey])) return 'option_destination_line_missing'
  const lineProblem = destinationLineProblem(goes, raw[lineKey] as Rec)
  if (lineProblem) return lineProblem
  const out: QuoteOption = {
    id,
    name,
    line,
    quantity: typeof raw.quantity === 'number' && Number.isFinite(raw.quantity) ? raw.quantity : null,
    unit: typeof raw.unit === 'string' ? raw.unit : null,
    sell_ex_gst: ex / 100,
    gst: gst / 100,
    sell_inc_gst: inc / 100,
    payer_id: typeof raw.payer_id === 'string' ? raw.payer_id : null,
    goes,
    cost_ex_gst: cost,
    cost_kind: costKind,
    sealed: raw,
  }
  out[lineKey] = raw[lineKey] as Record<string, unknown>
  if (raw.line_item != null) {
    if (!isRec(raw.line_item)) return 'option_line_item_unreadable'
    out.line_item = raw.line_item
  }
  return out
}

const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0
const moneyOrNull = (v: unknown) => v === null || v === undefined || (cents(v) != null && (cents(v) as number) >= 0)

/**
 * A destination line its consumer can use, or the reason it cannot. The line
 * is checked here, before the customer can tick it, so a taken option is never
 * on an order, work order or office list as an empty line. No cost is required
 * (a blank cost stays unknown), and none is invented.
 *   supplier: id, description, a positive quantity and a unit; never the
 *             office's own fixing (the Dispatch fill skips those).
 *   crew:     line_key, description, a positive quantity and a unit; total in
 *             whole cents or blank.
 *   office:   description, a positive quantity and a unit; cost in whole cents or blank.
 */
export function destinationLineProblem(goes: 'supplier' | 'crew' | 'office', line: Rec): string | null {
  if (!nonEmptyString(line.description)) return `option_${goes}_line_description_missing`
  if (!positive(line.quantity)) return `option_${goes}_line_quantity_unreadable`
  if (!nonEmptyString(line.unit)) return `option_${goes}_line_unit_missing`
  if (goes === 'supplier') {
    if (!nonEmptyString(line.id)) return 'option_supplier_line_id_missing'
    const supplier = line.supplier ?? line.supplierId ?? line.supplier_id
    const sid = typeof supplier === 'string' ? supplier : isRec(supplier) ? supplier.id : null
    if (typeof sid === 'string' && sid.trim().toLowerCase() === 'office') return 'option_supplier_line_is_office'
    // Dispatch never puts these on supplier copy, so the line could never be ordered.
    if (!goesOnSupplierCopy(line.description)) return 'option_supplier_line_not_supplier_copy'
  } else if (goes === 'crew') {
    if (!nonEmptyString(line.line_key)) return 'option_crew_line_key_missing'
    if (!moneyOrNull(line.total)) return 'option_crew_line_total_unreadable'
  } else if (!moneyOrNull(line.cost_ex_gst)) {
    return 'option_office_line_cost_unreadable'
  }
  return null
}

/** Same JSON meaning (object key order ignored). */
function sameMeaning(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : isRec(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
      : v
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b))
}

type Shape = { ids: string[]; amounts: number[] }

const SCHEDULE_MONEY_KEYS = new Set(['amount_inc_gst'])
const STAGES_MONEY_KEYS = new Set(['amount_inc_gst', 'total_inc_gst'])

/** A copy without its money keys, at every depth: the terms that must not move. */
function withoutMoney(v: unknown, keys: Set<string>): unknown {
  if (Array.isArray(v)) return v.map((x) => withoutMoney(x, keys))
  if (isRec(v)) return Object.fromEntries(Object.entries(v).filter(([k]) => !keys.has(k)).map(([k, x]) => [k, withoutMoney(x, keys)]))
  return v
}

/** Ids and amounts (whole cents, never negative) of a list of payment-like entries. */
function readSteps(list: unknown, amountKey: string, idOf: (r: Rec) => unknown): Shape | string {
  if (!Array.isArray(list) || list.length === 0) return 'empty'
  const ids: string[] = []
  const amounts: number[] = []
  for (const item of list) {
    if (!isRec(item)) return 'entry_unreadable'
    const id = nonEmptyString(idOf(item))
    if (!id) return 'id_missing'
    if (ids.includes(id)) return 'id_duplicate'
    const c = cents(item[amountKey])
    if (c == null || c < 0) return 'amount_unreadable'
    ids.push(id)
    amounts.push(c)
  }
  return { ids, amounts }
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
const partyKey = (p: Rec) => (typeof p.id === 'string' && p.id ? p.id : p.letter)

/** A schedule's payments: the right ids, cents that add to the total. */
function checkSchedule(sched: unknown, base: Shape, inc: number): Shape | string {
  if (!isRec(sched)) return 'combination_schedule_unreadable'
  const s = readSteps(sched.payments, 'amount_inc_gst', (r) => r.id)
  if (typeof s === 'string') return `combination_schedule_${s}`
  if (!sameIds(s.ids, base.ids)) return 'combination_schedule_ids_not_base'
  if (sum(s.amounts) !== inc) return 'combination_schedule_not_total'
  return s
}

/** Local invoice stages: the right ids and payers, cents that add up at every level. */
function checkStages(stages: unknown, base: { shape: Shape; payers: string[][] }, inc: number): Shape | string {
  if (!isRec(stages)) return 'combination_stages_unreadable'
  if (stages.total_inc_gst != null && cents(stages.total_inc_gst) !== inc) return 'combination_stages_total_not_inc'
  const s = readSteps(stages.stages, 'amount_inc_gst', (r) => r.id)
  if (typeof s === 'string') return `combination_stages_${s}`
  if (!sameIds(s.ids, base.shape.ids)) return 'combination_stages_ids_not_base'
  if (sum(s.amounts) !== inc) return 'combination_stages_not_total'
  for (const [i, stage] of (stages.stages as Rec[]).entries()) {
    if (stage.payers == null) {
      if (base.payers[i].length) return 'combination_stage_payers_missing'
      continue
    }
    const p = readSteps(stage.payers, 'amount_inc_gst', (r) => r.payer_id)
    if (typeof p === 'string') return `combination_stage_payers_${p}`
    if (!sameIds(p.ids, base.payers[i])) return 'combination_stage_payers_not_base'
    if (sum(p.amounts) !== s.amounts[i]) return 'combination_stage_payers_not_stage'
  }
  return s
}

function stagePayers(stages: unknown): string[][] | null {
  if (!isRec(stages) || !Array.isArray(stages.stages)) return null
  const out: string[][] = []
  for (const stage of stages.stages) {
    if (!isRec(stage)) return null
    if (stage.payers == null) {
      out.push([])
      continue
    }
    const p = readSteps(stage.payers, 'amount_inc_gst', (r) => r.payer_id)
    if (typeof p === 'string') return null
    out.push(p.ids)
  }
  return out
}

type PartyFigures = { key: string; ex: number; gst: number; inc: number }

function readParties(list: unknown): PartyFigures[] | string {
  if (!Array.isArray(list) || list.length === 0) return 'empty'
  const out: PartyFigures[] = []
  for (const p of list) {
    if (!isRec(p)) return 'entry_unreadable'
    const key = nonEmptyString(partyKey(p))
    if (!key) return 'id_missing'
    if (out.some((x) => x.key === key)) return 'id_duplicate'
    const ex = cents(p.ex_gst)
    const gst = cents(p.gst)
    const inc = cents(p.inc_gst)
    if (ex == null || gst == null || inc == null || ex < 0 || gst < 0 || inc < 0) return 'amount_unreadable'
    if (ex + gst !== inc) return 'ex_plus_gst_not_inc'
    out.push({ key, ex, gst, inc })
  }
  return out
}

/**
 * The option offer on a released quote's pricing, checked against the
 * contract. `none` when the pricing carries no optional_extras block (every
 * revision sealed before ruling 14, and every revision with no option).
 *
 * Every combination must carry the same money structures the base carries
 * (payment schedule, local invoice stages, parties), with the same ids, whole
 * non-negative cents that add up, and a deposit that is its first payment and
 * its first stage. The empty combination must mean exactly the sealed base.
 * Anything else is invalid: the accepted price never keeps an old base
 * schedule beside a new total.
 */
export function readQuoteOptions(pricing: unknown): QuoteOptionsRead {
  if (!isRec(pricing) || pricing.optional_extras == null) return { kind: 'none' }
  const block = pricing.optional_extras
  const invalid = (reason: string): QuoteOptionsRead => ({ kind: 'invalid', reason })
  if (!isRec(block) || block.version !== 1) return invalid('options_version_unsupported')
  if (!Array.isArray(block.options) || block.options.length === 0) return invalid('options_empty')
  if (block.options.length > MAX_QUOTE_OPTIONS) return invalid('options_more_than_six')
  const options: QuoteOption[] = []
  for (const raw of block.options) {
    const o = readOption(raw)
    if (typeof o === 'string') return invalid(o)
    if (options.some((x) => x.id === o.id)) return invalid('option_id_duplicate')
    options.push(o)
  }

  const baseEx = cents(pricing.totalExGST)
  const baseGst = cents(pricing.gst)
  const baseInc = cents(pricing.totalIncGST)
  if (baseEx == null || baseGst == null || baseInc == null) return invalid('base_total_unreadable')
  const baseDeposit = isRec(pricing.deposit) ? cents(pricing.deposit.total_deposit_inc_gst) : null
  if (baseDeposit == null) return invalid('base_deposit_unreadable')

  // The base's own structures, read once: every combination must carry each one the base carries.
  const hasSchedule = pricing.payment_schedule != null
  let baseSchedule: Shape | null = null
  if (hasSchedule) {
    const s = isRec(pricing.payment_schedule)
      ? readSteps(pricing.payment_schedule.payments, 'amount_inc_gst', (r) => r.id)
      : 'unreadable'
    if (typeof s === 'string') return invalid('base_schedule_unreadable')
    baseSchedule = s
  }
  const hasStages = pricing.local_invoice_stages != null
  let baseStages: { shape: Shape; payers: string[][] } | null = null
  if (hasStages) {
    const st = pricing.local_invoice_stages
    const s = isRec(st) ? readSteps(st.stages, 'amount_inc_gst', (r) => r.id) : 'unreadable'
    const payers = stagePayers(st)
    if (typeof s === 'string' || !payers) return invalid('base_stages_unreadable')
    baseStages = { shape: s, payers }
  }
  const hasParties = Array.isArray(pricing.parties) && pricing.parties.length > 0
  let baseParties: PartyFigures[] | null = null
  if (hasParties) {
    const p = readParties(pricing.parties)
    if (typeof p === 'string') return invalid('base_parties_unreadable')
    baseParties = p
    for (const o of options) {
      if (!o.payer_id || !p.some((x) => x.key === o.payer_id)) return invalid('option_payer_not_a_party')
    }
  }
  const optionPayers = new Set(options.map((o) => o.payer_id).filter((x): x is string => !!x))

  if (!Array.isArray(block.combinations) || block.combinations.length !== 2 ** options.length) {
    return invalid('combinations_incomplete')
  }
  const order = new Map(options.map((o, i) => [o.id, i]))
  const seen = new Set<string>()
  const combinations: OptionCombination[] = []
  for (const [index, raw] of block.combinations.entries()) {
    if (!isRec(raw) || !Array.isArray(raw.option_ids)) return invalid('combination_unreadable')
    const ids = raw.option_ids
    if (!ids.every((id) => typeof id === 'string' && order.has(id))) return invalid('combination_names_unknown_option')
    const positions = (ids as string[]).map((id) => order.get(id)!)
    if (positions.some((p, i) => i > 0 && p <= positions[i - 1])) return invalid('combination_not_in_option_order')
    const key = (ids as string[]).join('\u0000')
    if (seen.has(key)) return invalid('combination_duplicate')
    seen.add(key)
    if (index === 0 && ids.length !== 0) return invalid('combination_base_not_first')
    const isBase = ids.length === 0

    const ex = cents(raw.totalExGST)
    const gst = cents(raw.gst)
    const inc = cents(raw.totalIncGST)
    const dep = cents(raw.deposit_inc_gst)
    if (ex == null || gst == null || inc == null || dep == null) return invalid('combination_figures_unreadable')
    if (ex < 0 || gst < 0 || inc < 0) return invalid('combination_figures_unreadable')
    if (ex + gst !== inc) return invalid('combination_ex_plus_gst_not_inc')
    const taken = options.filter((o) => (ids as string[]).includes(o.id))
    const addEx = taken.reduce((s, o) => s + Math.round(o.sell_ex_gst * 100), 0)
    const addGst = taken.reduce((s, o) => s + Math.round(o.gst * 100), 0)
    const addInc = taken.reduce((s, o) => s + Math.round(o.sell_inc_gst * 100), 0)
    if (ex !== baseEx + addEx || gst !== baseGst + addGst || inc !== baseInc + addInc) {
      return invalid('combination_total_not_base_plus_options')
    }
    if (isBase && dep !== baseDeposit) return invalid('base_combination_deposit_mismatch')
    if (dep < 0 || dep > inc) return invalid('combination_deposit_out_of_range')

    const combo: OptionCombination = {
      option_ids: [...(ids as string[])],
      totalExGST: ex / 100,
      gst: gst / 100,
      totalIncGST: inc / 100,
      deposit_inc_gst: dep / 100,
      sealed: raw,
    }

    if ((raw.payment_schedule != null) !== hasSchedule) {
      return invalid(hasSchedule ? 'combination_schedule_missing' : 'combination_schedule_not_on_base')
    }
    let printed: Shape | null = null
    if (baseSchedule) {
      const s = checkSchedule(raw.payment_schedule, baseSchedule, inc)
      if (typeof s === 'string') return invalid(s)
      if (s.amounts[0] !== dep) return invalid('combination_deposit_not_first_payment')
      // Labels, printed terms: everything but the amounts is the base's.
      if (!sameMeaning(withoutMoney(raw.payment_schedule, SCHEDULE_MONEY_KEYS), withoutMoney(pricing.payment_schedule, SCHEDULE_MONEY_KEYS))) {
        return invalid('combination_schedule_terms_not_base')
      }
      printed = s
      if (isBase && !sameMeaning(raw.payment_schedule, pricing.payment_schedule)) {
        return invalid('base_combination_schedule_not_base')
      }
      combo.payment_schedule = raw.payment_schedule as Rec
    }

    if ((raw.local_invoice_stages != null) !== hasStages) {
      return invalid(hasStages ? 'combination_stages_missing' : 'combination_stages_not_on_base')
    }
    if (baseStages) {
      const s = checkStages(raw.local_invoice_stages, baseStages, inc)
      if (typeof s === 'string') return invalid(s)
      if (s.amounts[0] !== dep) return invalid('combination_deposit_not_first_stage')
      // Basis, trigger, due rule, labels, terms, payers: everything but the amounts is the base's.
      if (!sameMeaning(withoutMoney(raw.local_invoice_stages, STAGES_MONEY_KEYS), withoutMoney(pricing.local_invoice_stages, STAGES_MONEY_KEYS))) {
        return invalid('combination_stages_terms_not_base')
      }
      // The printed payments and the invoice stages are one plan: the same
      // payments, the same amount each, or the customer is billed other than
      // what they were shown.
      if (printed && (!sameIds(printed.ids, s.ids) || printed.amounts.some((a, i) => a !== s.amounts[i]))) {
        return invalid('combination_schedule_and_stages_disagree')
      }
      if (isBase && !sameMeaning(raw.local_invoice_stages, pricing.local_invoice_stages)) {
        return invalid('base_combination_stages_not_base')
      }
      combo.local_invoice_stages = raw.local_invoice_stages as Rec
    }

    if ((raw.parties != null) !== hasParties) {
      return invalid(hasParties ? 'combination_parties_missing' : 'combination_parties_not_on_base')
    }
    if (baseParties) {
      const p = readParties(raw.parties)
      if (typeof p === 'string') return invalid(`combination_parties_${p}`)
      if (!sameIds(p.map((x) => x.key), baseParties.map((x) => x.key))) return invalid('combination_parties_not_base')
      if (sum(p.map((x) => x.ex)) !== ex || sum(p.map((x) => x.gst)) !== gst || sum(p.map((x) => x.inc)) !== inc) {
        return invalid('combination_parties_not_total')
      }
      // Only the paying party's share moves: every other party is its base share.
      for (const [i, party] of p.entries()) {
        const b = baseParties[i]
        if (optionPayers.has(party.key)) continue
        if (party.ex !== b.ex || party.gst !== b.gst || party.inc !== b.inc) return invalid('combination_other_party_changed')
      }
      if (isBase && !sameMeaning(raw.parties, pricing.parties)) return invalid('base_combination_parties_not_base')
      combo.parties = raw.parties as Array<Record<string, unknown>>
    }

    combinations.push(combo)
  }

  return {
    kind: 'offer',
    offer: {
      version: 1,
      sentence: typeof block.sentence === 'string' ? block.sentence : '',
      options,
      combinations,
    },
  }
}

export type OptionChoice =
  | { ok: true; combination: OptionCombination; taken: QuoteOption[]; notTaken: QuoteOption[] }
  | { ok: false; reason: string }

/** The ticked set, in options[] order, and its precomputed combination. */
export function chooseOptions(offer: QuoteOptionsOffer, ticked: unknown): OptionChoice {
  if (ticked == null) ticked = []
  if (!Array.isArray(ticked)) return { ok: false, reason: 'option_ids_not_a_list' }
  if (ticked.length > MAX_QUOTE_OPTIONS) return { ok: false, reason: 'option_ids_more_than_six' }
  if (!ticked.every((id) => typeof id === 'string')) return { ok: false, reason: 'option_id_not_text' }
  const set = new Set(ticked as string[])
  if (set.size !== ticked.length) return { ok: false, reason: 'option_id_duplicate' }
  for (const id of set) {
    if (!offer.options.some((o) => o.id === id)) return { ok: false, reason: 'option_not_on_this_quote' }
  }
  const taken = offer.options.filter((o) => set.has(o.id))
  const notTaken = offer.options.filter((o) => !set.has(o.id))
  const want = taken.map((o) => o.id).join('\u0000')
  const combination = offer.combinations.find((c) => c.option_ids.join('\u0000') === want)
  if (!combination) return { ok: false, reason: 'combination_missing' }
  return { ok: true, combination, taken, notTaken }
}

/** Any ticked id sent for a quote that has no options: refused, never ignored silently. */
export function tickedNothing(ticked: unknown): boolean {
  return ticked == null || (Array.isArray(ticked) && ticked.length === 0)
}

/**
 * The job's pricing once a set is accepted (contract 4.3): the released
 * pricing with the combination's figures in place of the base ones. Every
 * other key, the deposit percent and description included, is the released
 * pricing as sealed. The options block stays, naming what was taken.
 */
export function acceptedPricing(
  released: Record<string, unknown>,
  offer: QuoteOptionsOffer,
  choice: { combination: OptionCombination; taken: QuoteOption[] },
): Record<string, unknown> {
  const c = choice.combination
  const out: Record<string, unknown> = { ...released }
  out.totalExGST = c.totalExGST
  out.gst = c.gst
  out.totalIncGST = c.totalIncGST
  out.deposit = { ...(isRec(released.deposit) ? released.deposit : {}), total_deposit_inc_gst: c.deposit_inc_gst }
  // readQuoteOptions checked each structure is on the combination exactly when it
  // is on the base, so the base's own schedule, stages and parties never survive.
  for (const k of ['payment_schedule', 'local_invoice_stages', 'parties'] as const) {
    if (c[k] != null) out[k] = c[k]
    else delete out[k]
  }
  // Fence: a taken option is one more custom line, as it would be in the price.
  const added = choice.taken.map((o) => o.line_item).filter((l): l is Record<string, unknown> => !!l)
  if (added.length) out.line_items = [...(Array.isArray(released.line_items) ? released.line_items : []), ...added]
  out.optional_extras = {
    ...(isRec(released.optional_extras) ? released.optional_extras : {}),
    accepted_option_ids: choice.taken.map((o) => o.id),
  }
  void offer
  return out
}

/**
 * The deposit for the party who took the options on a shared fence: their
 * amount on the combination's first local invoice stage (the tool's own
 * figure). With no stages, the contract's one rule: the deposit percent of
 * their share of the new total, to the cent. Null when neither can be read
 * (the deposit is then held for the office, never guessed).
 */
export function partyOptionDeposit(
  pricing: Record<string, unknown>,
  combination: OptionCombination,
  payerId: string | null,
): number | null {
  if (!payerId) return null
  const stages = combination.local_invoice_stages
  if (isRec(stages) && Array.isArray(stages.stages) && isRec(stages.stages[0])) {
    const payers = stages.stages[0].payers
    if (!Array.isArray(payers)) return null
    const mine = payers.filter((p) => isRec(p) && p.payer_id === payerId)
    if (mine.length !== 1) return null
    const c = cents((mine[0] as Rec).amount_inc_gst)
    return c == null || c < 0 ? null : c / 100
  }
  const party = (combination.parties || []).filter((p) => partyKey(p) === payerId)
  if (party.length !== 1) return null
  const inc = cents(party[0].inc_gst)
  const pct = isRec(pricing.deposit) ? Number(pricing.deposit.percent) : NaN
  if (inc == null || !Number.isFinite(pct) || pct <= 0 || pct > 100) return null
  return Math.round((inc * pct) / 100) / 100
}

export type OptionAcceptanceRecord = {
  job_id: string
  job_document_id: string
  quote_revision_id: string
  accepted_via: 'public_link' | 'staff_phone'
  accepted_by: string | null
  offered: Array<{ id: string; name: string; line: string; sell_ex_gst: number; gst: number; sell_inc_gst: number; goes: string }>
  taken_option_ids: string[]
  base_total_inc_gst: number
  accepted_total_ex_gst: number
  accepted_gst: number
  accepted_total_inc_gst: number
  accepted_deposit_inc_gst: number
  /** The taken options exactly as sealed: the database checks each against the frozen revision before it goes on the job's orders. */
  taken_options: Array<Record<string, unknown>>
  /** The ticked combination exactly as sealed. */
  accepted_combination: Record<string, unknown>
}

/** The row kept on the job (quote_option_acceptances). Not taken = offered less taken. */
export function optionAcceptanceRecord(input: {
  jobId: string
  documentId: string
  revisionId: string
  via: 'public_link' | 'staff_phone'
  staffUserId: string | null
  offer: QuoteOptionsOffer
  choice: { combination: OptionCombination; taken: QuoteOption[] }
}): OptionAcceptanceRecord {
  const base = input.offer.combinations[0]
  const c = input.choice.combination
  return {
    job_id: input.jobId,
    job_document_id: input.documentId,
    quote_revision_id: input.revisionId,
    accepted_via: input.via,
    accepted_by: input.staffUserId,
    offered: input.offer.options.map((o) => ({
      id: o.id, name: o.name, line: o.line,
      sell_ex_gst: o.sell_ex_gst, gst: o.gst, sell_inc_gst: o.sell_inc_gst, goes: o.goes,
    })),
    taken_option_ids: input.choice.taken.map((o) => o.id),
    base_total_inc_gst: base.totalIncGST,
    accepted_total_ex_gst: c.totalExGST,
    accepted_gst: c.gst,
    accepted_total_inc_gst: c.totalIncGST,
    accepted_deposit_inc_gst: c.deposit_inc_gst,
    taken_options: input.choice.taken.map((o) => o.sealed),
    accepted_combination: c.sealed,
  }
}

/** Plain words for a refused tick set (the customer sees these). */
export function optionRefusalMessage(reason: string): string {
  switch (reason) {
    case 'options_on_neighbour_quote':
      return 'Options on this quote are for the owner to choose. Please accept without them, or call us to talk about them.'
    case 'option_not_on_this_quote':
    case 'option_id_duplicate':
    case 'option_ids_not_a_list':
    case 'option_id_not_text':
    case 'option_ids_more_than_six':
    case 'options_not_offered':
      return 'The options you picked do not match this quote. Please reload the page and try again.'
    default:
      return 'We could not confirm the options on this quote. Please call us and we will sort it out.'
  }
}
