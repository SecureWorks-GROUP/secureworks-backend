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
  }
  out[lineKey] = raw[lineKey] as Record<string, unknown>
  if (raw.line_item != null) {
    if (!isRec(raw.line_item)) return 'option_line_item_unreadable'
    out.line_item = raw.line_item
  }
  return out
}

function sumCents(list: unknown[], key: string): number | null {
  let total = 0
  for (const item of list) {
    if (!isRec(item)) return null
    const c = cents(item[key])
    if (c == null) return null
    total += c
  }
  return total
}

/**
 * The option offer on a released quote's pricing, checked against the
 * contract. `none` when the pricing carries no optional_extras block (every
 * revision sealed before ruling 14, and every revision with no option).
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

    const ex = cents(raw.totalExGST)
    const gst = cents(raw.gst)
    const inc = cents(raw.totalIncGST)
    const dep = cents(raw.deposit_inc_gst)
    if (ex == null || gst == null || inc == null || dep == null) return invalid('combination_figures_unreadable')
    if (ex + gst !== inc) return invalid('combination_ex_plus_gst_not_inc')
    const taken = options.filter((o) => order.has(o.id) && (ids as string[]).includes(o.id))
    const addEx = taken.reduce((s, o) => s + Math.round(o.sell_ex_gst * 100), 0)
    const addGst = taken.reduce((s, o) => s + Math.round(o.gst * 100), 0)
    const addInc = taken.reduce((s, o) => s + Math.round(o.sell_inc_gst * 100), 0)
    if (ex !== baseEx + addEx || gst !== baseGst + addGst || inc !== baseInc + addInc) {
      return invalid('combination_total_not_base_plus_options')
    }
    if (ids.length === 0 && dep !== baseDeposit) return invalid('base_combination_deposit_mismatch')
    if (dep < 0 || dep > inc) return invalid('combination_deposit_out_of_range')

    const combo: OptionCombination = {
      option_ids: [...(ids as string[])],
      totalExGST: ex / 100,
      gst: gst / 100,
      totalIncGST: inc / 100,
      deposit_inc_gst: dep / 100,
    }
    if (raw.payment_schedule != null) {
      const sched = raw.payment_schedule
      if (!isRec(sched) || !Array.isArray(sched.payments)) return invalid('combination_schedule_unreadable')
      if (sumCents(sched.payments, 'amount_inc_gst') !== inc) return invalid('combination_schedule_not_total')
      combo.payment_schedule = sched
    }
    if (raw.local_invoice_stages != null) {
      const stages = raw.local_invoice_stages
      if (!isRec(stages) || !Array.isArray(stages.stages)) return invalid('combination_stages_unreadable')
      if (sumCents(stages.stages, 'amount_inc_gst') !== inc) return invalid('combination_stages_not_total')
      combo.local_invoice_stages = stages
    } else if (pricing.local_invoice_stages != null) {
      return invalid('combination_stages_missing')
    }
    if (raw.parties != null) {
      if (!Array.isArray(raw.parties)) return invalid('combination_parties_unreadable')
      const pEx = sumCents(raw.parties, 'ex_gst')
      const pGst = sumCents(raw.parties, 'gst')
      const pInc = sumCents(raw.parties, 'inc_gst')
      if (pEx !== ex || pGst !== gst || pInc !== inc) return invalid('combination_parties_not_total')
      for (const p of raw.parties as Rec[]) {
        if (Math.round((p.ex_gst as number) * 100) + Math.round((p.gst as number) * 100) !== Math.round((p.inc_gst as number) * 100)) {
          return invalid('combination_party_ex_plus_gst_not_inc')
        }
      }
      combo.parties = raw.parties as Array<Record<string, unknown>>
    } else if (Array.isArray(pricing.parties) && pricing.parties.length > 0) {
      return invalid('combination_parties_missing')
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
  if (c.payment_schedule) out.payment_schedule = c.payment_schedule
  if (c.local_invoice_stages) out.local_invoice_stages = c.local_invoice_stages
  if (c.parties) out.parties = c.parties
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
  }
}

/** Plain words for a refused tick set (the customer sees these). */
export function optionRefusalMessage(reason: string): string {
  switch (reason) {
    case 'options_on_shared_quote':
      return 'Options on this quote cannot be added online. Please accept without them, or call us to talk about them.'
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
