// Trade-safe scope-of-works packer.
//
// Every sent quote posts a stripped SOW (quantities + installer charge kinds,
// never client sell / GST / margin). Trades triage by quote number.

export type TradePackItemKind =
  | 'install_m'
  | 'plinth'
  | 'removal_m'
  | 'gate_pedestrian'
  | 'gate_double'
  | 'patio_tube'
  | 'info'
  | 'note'

export type TradePackItem = {
  kind: TradePackItemKind
  description: string
  quantity: number
  unit: string
  unit_price: number | null
  line_total: number | null
}

export type TradeQuotePackStatus = 'accepted' | 'sent' | 'superseded'

export type TradeQuotePack = {
  quote_number: string | null
  job_document_id: string | null
  sent_at: string | null
  accepted: boolean
  status: TradeQuotePackStatus
  job_type: 'fencing' | 'patio' | 'other'
  notes: string
  items: TradePackItem[]
  summary: string
  source: 'frozen' | 'live_fallback'
}

export const TRADE_INSTALLER_RATES = {
  install_m: 30,
  plinth: 10,
  removal_m: 10,
  gate_pedestrian: 250,
  gate_double: 500,
} as const

export const HENRY_INSTALLER_RATES = {
  install_m: null as number | null,
  plinth: 12.5,
  removal_m: null as number | null,
  gate_pedestrian: 250,
  gate_double: 500,
} as const

const CLIENT_MONEY_RE =
  /totalIncGST|totalExGST|total_inc_gst|total_ex_gst|grandTotal|total_sell|sell_price|unit_price_ex|pricePerMetre|price_per_metre|margin_pct|marginPct|job_costs|jobCosts|cost_price|labourCostEstimate|materialCostEstimate|commissionCostEstimate/i

export type PackTradeQuoteInput = {
  quote_number?: string | null
  job_document_id?: string | null
  sent_at?: string | null
  accepted?: boolean
  superseded?: boolean
  job_type?: string | null
  scope_json?: unknown
  pricing_json?: unknown
  source?: 'frozen' | 'live_fallback'
}

export function isHenryInstaller(email: string | null | undefined): boolean {
  return /emeka|henry/i.test(String(email || ''))
}

export function packTradeQuote(input: PackTradeQuoteInput): TradeQuotePack {
  const jobType = classifyJobType(input.job_type, input.scope_json, input.pricing_json)
  const scope = asObject(input.scope_json)
  const pricing = asObject(input.pricing_json)
  const items: TradePackItem[] = jobType === 'fencing'
    ? packFencing(scope, pricing)
    : jobType === 'patio'
    ? packPatio(scope, pricing)
    : packGeneric(scope, pricing)

  const notes = installerNotes(scope)
  if (notes) items.push(item('note', notes, 1, 'lot'))

  const accepted = input.accepted === true
  const superseded = input.superseded === true && !accepted
  const summary = items
    .filter((i) => i.kind !== 'note')
    .slice(0, 6)
    .map((i) => qtyLabel(i))
    .join(' · ')

  return {
    quote_number: input.quote_number || null,
    job_document_id: input.job_document_id || null,
    sent_at: input.sent_at || null,
    accepted,
    status: accepted ? 'accepted' : superseded ? 'superseded' : 'sent',
    job_type: jobType,
    notes,
    items,
    summary,
    source: input.source || 'frozen',
  }
}

export function applyInstallerRates(pack: TradeQuotePack, isHenry: boolean): TradeQuotePack {
  if (pack.job_type !== 'fencing') {
    return {
      ...pack,
      items: pack.items.map((i) => ({ ...i, unit_price: null, line_total: null })),
    }
  }
  const card = isHenry ? HENRY_INSTALLER_RATES : TRADE_INSTALLER_RATES
  const items = pack.items.map((i) => {
    const rate = rateForKind(i.kind, card)
    if (rate == null) return { ...i, unit_price: null, line_total: null }
    const qty = Number(i.quantity) || 0
    const line = Math.round(qty * rate * 100) / 100
    return { ...i, unit_price: rate, line_total: line }
  })
  return { ...pack, items }
}

export function tradePackMoneyLeakKeys(pack: TradeQuotePack): string[] {
  const blob = JSON.stringify(pack)
  const hits = blob.match(CLIENT_MONEY_RE)
  return hits ? [...new Set(hits)] : []
}

export type QuoteDocRow = {
  id?: string
  type?: string | null
  quote_number?: string | null
  sent_at?: string | null
  accepted_at?: string | null
  superseded_at?: string | null
  trade_pack_json?: unknown
  created_at?: string | null
}

export function assembleQuotePacksForTrade(input: {
  documents: QuoteDocRow[]
  jobType?: string | null
  liveScopeJson?: unknown
  livePricingJson?: unknown
  isHenry?: boolean
}): TradeQuotePack[] {
  const docs = (input.documents || [])
    .filter((d) => String(d?.type || '').toLowerCase() === 'quote')
    .filter((d) => !!(d.sent_at || d.trade_pack_json))
    .slice()
    .sort((a, b) => String(b.sent_at || b.created_at || '').localeCompare(String(a.sent_at || a.created_at || '')))

  return docs.map((doc) => {
    const stored = asObject(doc.trade_pack_json)
    const packed = stored && Array.isArray(stored.items)
      ? hydrateStoredPack(stored, doc)
      : packTradeQuote({
        quote_number: doc.quote_number,
        job_document_id: doc.id || null,
        sent_at: doc.sent_at,
        accepted: !!doc.accepted_at,
        superseded: !!doc.superseded_at,
        job_type: input.jobType,
        scope_json: input.liveScopeJson,
        pricing_json: input.livePricingJson,
        source: 'live_fallback',
      })
    return applyInstallerRates(packed, input.isHenry === true)
  })
}

export async function persistTradePackOnDocuments(
  sb: { from: (table: string) => any },
  args: {
    documents: Array<{ id?: string; quote_number?: string | null; sent_at?: string | null }>
    jobType?: string | null
    scopeJson?: unknown
    pricingJson?: unknown
    sentAt?: string | null
  },
): Promise<number> {
  let wrote = 0
  const sentAt = args.sentAt || new Date().toISOString()
  for (const doc of args.documents || []) {
    if (!doc?.id) continue
    const pack = packTradeQuote({
      quote_number: doc.quote_number,
      job_document_id: doc.id,
      sent_at: doc.sent_at || sentAt,
      job_type: args.jobType,
      scope_json: args.scopeJson,
      pricing_json: args.pricingJson,
      source: 'frozen',
    })
    const { error } = await sb.from('job_documents').update({ trade_pack_json: pack }).eq('id', doc.id)
    if (error) {
      console.error('[trade-pack-persist-fail]', JSON.stringify({
        document_id: doc.id,
        error: error.message || String(error),
      }))
      continue
    }
    wrote++
  }
  return wrote
}

function hydrateStoredPack(stored: Record<string, unknown>, doc: QuoteDocRow): TradeQuotePack {
  const items = (Array.isArray(stored.items) ? stored.items : []).map((raw) => {
    const row = asObject(raw)
    const rawKind = String(row.kind || '').trim().toLowerCase()
    return item(
      rawKind === 'note'
        ? 'note'
        : (sanitizeTradePackKind(row.kind) as TradePackItemKind) || 'info',
      String(row.description || ''),
      Number(row.quantity) || 0,
      typeof row.unit === 'string' ? row.unit : 'ea',
    )
  })
  const accepted = !!doc.accepted_at || stored.accepted === true
  const superseded = !!doc.superseded_at && !accepted
  return {
    quote_number: (stored.quote_number as string) || doc.quote_number || null,
    job_document_id: (stored.job_document_id as string) || doc.id || null,
    sent_at: (stored.sent_at as string) || doc.sent_at || null,
    accepted,
    status: accepted ? 'accepted' : superseded ? 'superseded' : 'sent',
    job_type: classifyJobType(stored.job_type as string, null, null),
    notes: String(stored.notes || ''),
    items,
    // Keep stored summary verbatim. Office / division-manager are quote-visible
    // and must still see monetary summary text. Allocated trades strip later
    // in redactTradeQuotePackMoney.
    summary: String(stored.summary || ''),
    source: stored.source === 'live_fallback' ? 'live_fallback' : 'frozen',
  }
}

function classifyJobType(raw: unknown, scope: unknown, pricing: unknown): 'fencing' | 'patio' | 'other' {
  const t = String(raw || '').toLowerCase()
  if (t === 'fencing' || t === 'fence') return 'fencing'
  if (t === 'patio' || t === 'decking') return 'patio'
  const s = asObject(scope)
  if (asObject(s.job).runs || asObject(s.job).profile) return 'fencing'
  if (asObject(s.config).roofing || asObject(s.config).roofStyle) return 'patio'
  const p = asObject(pricing)
  if (String(p.source || '') === 'scoping_tool') return 'patio'
  return 'other'
}

function packFencing(scope: Record<string, unknown>, pricing: Record<string, unknown>): TradePackItem[] {
  const job = asObject(scope.job)
  const items: TradePackItem[] = []
  const colour = String(job.colour || job.color || '')
  const profile = String(job.profile || '')
  const supplier = String(job.supplier || '')
  if (colour || profile || supplier) {
    items.push(item('info', [supplier, profile || 'Colorbond', colour].filter(Boolean).join(' · '), 1, 'lot'))
  }

  const runs = Array.isArray(job.runs) ? job.runs : []
  for (const raw of runs) {
    const run = asObject(raw)
    const length = runMetres(run)
    const name = String(run.name || run.run_name || run.run_label || 'Run')
    const height = runHeight(run)
    const plinths = runPlinths(run)
    const patioTubes = runPatioTubes(run)
    const heightBit = height ? ` ${height}mm` : ''
    if (length > 0) {
      items.push(item('install_m', `${name} - Colorbond install${heightBit}`, round1(length), 'm'))
    }
    if (plinths > 0) {
      items.push(item('plinth', `${name} - retaining plinths`, plinths, 'ea'))
    }
    if (patioTubes > 0) {
      items.push(item('patio_tube', `${name} - patio tubes`, patioTubes, 'ea'))
    }
  }

  const gates = Array.isArray(job.gates) ? job.gates : []
  for (const raw of gates) {
    const g = asObject(raw)
    const kind: TradePackItemKind = String(g.type || '').toLowerCase() === 'double'
      ? 'gate_double'
      : 'gate_pedestrian'
    const label = kind === 'gate_double'
      ? 'Double swing gate'
      : `Pedestrian gate ${g.width || 900}mm`
    items.push(item(kind, label, Number(g.qty) || 1, 'ea'))
  }

  items.push(...packRemoval(job, pricing))
  return items
}

function packRemoval(job: Record<string, unknown>, pricing: Record<string, unknown>): TradePackItem[] {
  const items: TradePackItem[] = []
  const removal = asObject(job.removal)
  const extras = Array.isArray(removal.removalExtras) ? removal.removalExtras : []
  const existingType = String(removal.existingFenceType || '').toLowerCase()
  const existingLen = Number(removal.existingFenceLength) || 0
  if ((existingType === 'colourbond' || existingType === 'colorbond') && existingLen > 0) {
    items.push(item('removal_m', 'Remove Colorbond fence', round1(existingLen), 'm'))
  }
  for (const raw of extras) {
    const ex = asObject(raw)
    const t = String(ex.fenceType || '').toLowerCase()
    const len = Number(ex.length) || 0
    if ((t === 'colourbond' || t === 'colorbond') && len > 0) {
      items.push(item('removal_m', 'Remove Colorbond fence', round1(len), 'm'))
    } else if (len > 0) {
      items.push(item('info', `Remove ${ex.fenceType || 'existing fence'}`, round1(len), 'm'))
    }
  }

  const lines = Array.isArray(pricing.line_items) ? pricing.line_items : []
  for (const raw of lines) {
    const li = asObject(raw)
    const desc = String(li.description || '')
    const qty = Number(li.quantity) || 0
    const cat = String(li.category || '').toLowerCase()
    const unit = String(li.unit || 'm')
    if (qty <= 0) continue
    if (cat === 'removal' || /remove\s+colorbond|remove\s+colourbond/i.test(desc)) {
      if (/colorbond|colourbond/i.test(desc)) {
        if (!items.some((i) => i.kind === 'removal_m')) {
          items.push(item('removal_m', 'Remove Colorbond fence', round1(qty), unit === 'each' ? 'm' : unit))
        }
      } else if (!items.some((i) => i.description === desc)) {
        items.push(item('info', desc, round1(qty), unit))
      }
    }
  }
  return items
}

function packPatio(scope: Record<string, unknown>, pricing: Record<string, unknown>): TradePackItem[] {
  const config = asObject(scope.config)
  const items: TradePackItem[] = []
  const length = patioMetres(config.length ?? config.L)
  const projection = patioMetres(config.projection ?? config.W ?? config.width)
  if (length > 0 && projection > 0) {
    items.push(item('info', `Patio ${round1(length)}m × ${round1(projection)}m`, 1, 'lot'))
  } else if (length > 0) {
    items.push(item('info', `Patio ${round1(length)}m`, 1, 'lot'))
  }
  const roof = String(config.roofStyle || '')
  const roofing = String(config.roofing || '')
  if (roof || roofing) items.push(item('info', [roof, humanRoof(roofing)].filter(Boolean).join(' · '), 1, 'lot'))
  const sheet = colourName(config.sheetColor || config.sheetColour || config.colour)
  const steel = colourName(config.steelColor || config.steelColour)
  if (sheet) items.push(item('info', `Sheet colour ${sheet}`, 1, 'lot'))
  if (steel) items.push(item('info', `Steel colour ${steel}`, 1, 'lot'))
  if (config.connection) items.push(item('info', `Attachment ${config.connection}`, 1, 'lot'))
  if (config.posts) items.push(item('info', `Posts ${config.posts}`, Number(config.posts) || 1, 'ea'))
  if (config.beams) items.push(item('info', `Beams ${config.beams}`, Number(config.beams) || 1, 'ea'))

  const desc = String(pricing.job_description || pricing.description || '').trim()
  if (desc) items.push(item('info', stripMoney(desc), 1, 'lot'))

  const flashings = Array.isArray(scope.flashings) ? scope.flashings : []
  if (flashings.length > 0) {
    items.push(item('info', `${flashings.length} flashing profile${flashings.length > 1 ? 's' : ''}`, flashings.length, 'ea'))
  }
  return items
}

function packGeneric(scope: Record<string, unknown>, pricing: Record<string, unknown>): TradePackItem[] {
  const desc = String(pricing.job_description || pricing.description || '').trim()
  if (desc) return [item('info', stripMoney(desc), 1, 'lot')]
  const notes = installerNotes(scope)
  return notes ? [item('info', notes, 1, 'lot')] : []
}

function installerNotes(scope: Record<string, unknown>): string {
  const notes = asObject(scope.notes)
  return String(notes.noteWorkOrder || '').trim()
}

function runMetres(run: Record<string, unknown>): number {
  return Number(run.length) || Number(run.lengthM) || Number(run.totalLength) || 0
}

function runHeight(run: Record<string, unknown>): number {
  if (Number(run.sheetHeight) > 0) return Number(run.sheetHeight)
  const panels = Array.isArray(run.panels) ? run.panels : []
  const first = asObject(panels[0])
  return Number(first.height) || 0
}

function runPlinths(run: Record<string, unknown>): number {
  const panels = Array.isArray(run.panels) ? run.panels : []
  let n = 0
  for (const raw of panels) {
    const p = asObject(raw)
    const slope = Number(p.slopePlinths) || 0
    const manual = (Number(p.retaining) || 0) / 150
    n += Math.min(4, slope + manual)
  }
  return Math.round(n)
}

function runPatioTubes(run: Record<string, unknown>): number {
  const panels = Array.isArray(run.panels) ? run.panels : []
  let patioCount = 0
  for (const raw of panels) {
    const p = asObject(raw)
    const slope = Number(p.slopePlinths) || 0
    const manual = (Number(p.retaining) || 0) / 150
    const totalPl = Math.min(4, slope + manual)
    if (totalPl >= 3 && totalPl <= 4) patioCount++
  }
  return patioCount > 0 ? patioCount + 1 : 0
}

function patioMetres(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 80 ? n / 1000 : n
}

function colourName(v: unknown): string {
  if (v && typeof v === 'object') return String((v as any).name || '')
  return String(v || '')
}

function humanRoof(roofing: string): string {
  return roofing
    .replace(/solarspan75/i, 'SolarSpan 75mm')
    .replace(/solarspan100/i, 'SolarSpan 100mm')
    .replace(/trimdek/i, 'Trimdek')
    .replace(/corrugated/i, 'Corrugated')
}

function rateForKind(
  kind: TradePackItemKind,
  card: typeof TRADE_INSTALLER_RATES | typeof HENRY_INSTALLER_RATES,
): number | null {
  if (kind === 'install_m') return card.install_m
  if (kind === 'plinth') return card.plinth
  if (kind === 'removal_m') return card.removal_m
  if (kind === 'gate_pedestrian') return card.gate_pedestrian
  if (kind === 'gate_double') return card.gate_double
  return null
}

function item(kind: TradePackItemKind, description: string, quantity: number, unit: string): TradePackItem {
  return {
    kind,
    description: stripTradePackMoney(description),
    quantity,
    unit: sanitizeTradePackUnit(unit) || 'ea',
    unit_price: null,
    line_total: null,
  }
}

const TRADE_PACK_MONEY_AMOUNT = '-?[\\d,]+(?:\\.\\d+)?'
const TRADE_PACK_CURRENCY_PREFIX = '(?:\\bAUD\\s*|AU\\$\\s*|A\\$\\s*|\\$\\s*)'
const TRADE_PACK_CURRENCY_SUFFIX = '(?:AUD\\b|AU\\$|A\\$|\\$)'
const TRADE_PACK_TAX_WORD = '(?:GST|tax)\\b'
const TRADE_PACK_TAX_QUALIFIER =
  '(?:ex(?:cl(?:uding|usive)?)?|inc(?:l(?:uding|usive)?)?|excluding|including|exclusive|inclusive|plus|\\+)'
const TRADE_PACK_TAX_QUALIFIED =
  `(?:${TRADE_PACK_TAX_QUALIFIER}\\s*[.\\-]?\\s*(?:of\\s+)?${TRADE_PACK_TAX_WORD}|${TRADE_PACK_TAX_WORD}\\s*[.\\-]?\\s*${TRADE_PACK_TAX_QUALIFIER})`
const TRADE_PACK_TAX_PHRASE =
  `(?:${TRADE_PACK_TAX_QUALIFIED}|${TRADE_PACK_TAX_WORD})`
const TRADE_PACK_UNQUALIFIED_MONEY_WORD =
  '(?:totals?|subtotals?|rates?|charg(?:e[ds]?|ing)|pric(?:e[ds]?|ing)|fees?|costs?|amounts?|invoices?|quot(?:e[ds]?|ing|ations?)|deposits?|balances?|paid|due)'
const TRADE_PACK_RATE_UNIT =
  '(?:hours?|hrs?|h|m(?:et(?:re|er)s?)?|days?|trades?|labou?rers?)'
const TRADE_PACK_QTY_WORD =
  '(?:trades?|days?|labourers?|posts?|pickets?|panels?|hours?|hrs?)'
const TRADE_PACK_REF_PREFIX =
  '(?:SWF|SWMS|SWP|SWR|SW|WO|PO|INV|MLB|AJBR|AJ|Q)'

/** Money-safe pack text: drop common currency figures, keep the writing.
 *  Prefix ($ / A$ / AUD 9,999), suffix / tax forms (9,999 AUD, 9,999 ex GST,
 *  9,999 excluding GST, 9,999 GST exclusive, ex GST 9,999), parenthetical
 *  tax marks, and unqualified totals/rates (Total 9999, rate 85, 85/hour,
 *  1200/m, 85 per day, 85/day, 85 per trade). Contextual words also
 *  catch two-digit marks (Deposit 85, Balance due 85, Paid 85, Due 85)
 *  without eating construction counts (2 trades, 19m). Leftover
 *  money-shaped numbers (decimals, thousands commas, 3+ digit integers)
 *  fail closed as unrecognised quote amounts (TRD4-REV16-002). Office
 *  full-quote summaries must not call this — hydrateStoredPack keeps
 *  stored summary verbatim. */
export function stripTradePackMoney(text: unknown): string {
  const kept: string[] = []
  const hold = (match: string) => {
    kept.push(match)
    return `\u0000${kept.length - 1}\u0000`
  }

  let s = String(text ?? '')
  // Hold construction / identity / count tokens so the fail-closed leftover
  // strip cannot eat 19m / 1800mm / 90x90 / SWF-26101 / 2 trades.
  s = s.replace(/\b\d+x\d+\b/gi, hold)
  s = s.replace(new RegExp(`\\b${TRADE_PACK_MONEY_AMOUNT}mm\\b`, 'gi'), hold)
  s = s.replace(new RegExp(`\\b${TRADE_PACK_MONEY_AMOUNT}cm\\b`, 'gi'), hold)
  s = s.replace(new RegExp(`\\b${TRADE_PACK_MONEY_AMOUNT}m\\b`, 'gi'), hold)
  s = s.replace(new RegExp(`\\b${TRADE_PACK_REF_PREFIX}-[A-Z0-9]+\\b`, 'gi'), hold)
  s = s.replace(
    new RegExp(`\\b${TRADE_PACK_MONEY_AMOUNT}\\s+${TRADE_PACK_QTY_WORD}\\b`, 'gi'),
    hold,
  )

  s = s
    .replace(new RegExp(`${TRADE_PACK_CURRENCY_PREFIX}${TRADE_PACK_MONEY_AMOUNT}`, 'gi'), '')
    .replace(new RegExp(`${TRADE_PACK_MONEY_AMOUNT}\\s*${TRADE_PACK_CURRENCY_SUFFIX}`, 'gi'), '')
    .replace(
      new RegExp(`${TRADE_PACK_MONEY_AMOUNT}\\s*\\(?\\s*${TRADE_PACK_TAX_PHRASE}\\s*\\)?`, 'gi'),
      '',
    )
    .replace(
      new RegExp(`\\(?\\s*${TRADE_PACK_TAX_PHRASE}\\s*\\)?\\s*:?\\s*${TRADE_PACK_MONEY_AMOUNT}`, 'gi'),
      '',
    )
    // "$9,999 excluding GST" loses the figure first; drop the orphaned
    // qualified tax mark. Bare "GST" / "tax" stays (not a money figure).
    .replace(new RegExp(`\\(?\\s*${TRADE_PACK_TAX_QUALIFIED}\\s*\\)?`, 'gi'), '')
    .replace(
      new RegExp(
        `(\\b${TRADE_PACK_UNQUALIFIED_MONEY_WORD}\\b)\\s*[=:\\-]?\\s*${TRADE_PACK_MONEY_AMOUNT}\\b`,
        'gi',
      ),
      '$1',
    )
    .replace(
      new RegExp(
        `${TRADE_PACK_MONEY_AMOUNT}\\b\\s+(${TRADE_PACK_UNQUALIFIED_MONEY_WORD})\\b`,
        'gi',
      ),
      '$1',
    )
    .replace(
      new RegExp(
        `${TRADE_PACK_MONEY_AMOUNT}\\s*(?:/\\s*|\\bper\\s+)${TRADE_PACK_RATE_UNIT}\\b`,
        'gi',
      ),
      '',
    )
    // Unrecognised leftover quote amounts: 9,999 / 99.50 / 850 / 18400.
    // 1–2 digit counts stay (2 at, 12 posts) unless a money word already ate them.
    .replace(/\b-?\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, '')
    .replace(/\b-?\d+\.\d+\b/g, '')
    .replace(/\b-?\d{3,}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)] ?? '')
  return s.replace(/\s{2,}/g, ' ').trim()
}

/** Closed installer-pack kinds that may ride an allocated quote pack.
 *  `note` is excluded — allocated redaction drops note items separately. */
export const TRADE_PACK_ALLOCATED_KINDS = new Set<string>([
  'install_m',
  'plinth',
  'removal_m',
  'gate_pedestrian',
  'gate_double',
  'patio_tube',
  'info',
])

const TRADE_PACK_SAFE_UNITS = new Set([
  'm',
  'lm',
  'mm',
  'cm',
  'ea',
  'each',
  'lot',
  'hr',
  'hrs',
  'hour',
  'hours',
  'day',
  'days',
  'kg',
])

/** Allocated unit scalar: known construction units, or a money-clean token.
 *  Currency leftovers and money-word units (AUD 9,999, AUD, rate) drop. */
export function sanitizeTradePackUnit(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (TRADE_PACK_SAFE_UNITS.has(trimmed.toLowerCase())) return trimmed
  const cleaned = stripTradePackMoney(trimmed)
  if (!cleaned || cleaned !== trimmed) return undefined
  if (/^(?:aud|au\$|a\$|\$)$/i.test(cleaned)) return undefined
  if (new RegExp(`^${TRADE_PACK_UNQUALIFIED_MONEY_WORD}$`, 'i').test(cleaned)) return undefined
  return cleaned
}

/** Allocated pack kind: allowlisted installer kinds only. */
export function sanitizeTradePackKind(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const key = value.trim().toLowerCase()
  return TRADE_PACK_ALLOCATED_KINDS.has(key) ? key : undefined
}

function stripMoney(text: string): string {
  return stripTradePackMoney(text)
}

function qtyLabel(i: TradePackItem): string {
  if (i.unit === 'lot') return i.description
  return `${i.quantity}${i.unit === 'm' ? 'm' : ' ' + i.unit} ${i.description}`
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function asObject(v: unknown): Record<string, unknown> {
  if (!v) return {}
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return {}
}
