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

export type TradeQuoteCustomerSnapshot = {
  name: string | null
  phone: string | null
  email: string | null
  site_address: string | null
  site_suburb: string | null
}

export type TradeQuoteTermsSnapshot = {
  payment_terms: string | null
  valid_days: number | null
  valid_until: string | null
}

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
  customer: TradeQuoteCustomerSnapshot
  terms: TradeQuoteTermsSnapshot
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
  customer?: Partial<TradeQuoteCustomerSnapshot> | null
  terms?: Partial<TradeQuoteTermsSnapshot> | null
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

  const flags = quotePublicationFlags({
    accepted: input.accepted === true,
    superseded: input.superseded === true,
  })
  const summary = items
    .filter((i) => i.kind !== 'note')
    .slice(0, 6)
    .map((i) => qtyLabel(i))
    .join(' · ')

  return {
    quote_number: input.quote_number || null,
    job_document_id: input.job_document_id || null,
    sent_at: input.sent_at || null,
    accepted: flags.accepted,
    status: flags.status,
    job_type: jobType,
    notes,
    items,
    summary,
    source: input.source || 'frozen',
    customer: snapshotTradeQuoteCustomer(input.customer),
    terms: snapshotTradeQuoteTerms({
      pricing_json: input.pricing_json,
      sent_at: input.sent_at,
      terms: input.terms,
    }),
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
  sent_to_client?: boolean | null
  send_claimed_at?: string | null
  accepted_at?: string | null
  superseded_at?: string | null
  trade_pack_json?: unknown
  created_at?: string | null
}

/** Sealed default terms language. Not a billed amount. Exact phrase only. */
export const TRADE_SEALED_PAYMENT_TERMS = /^\s*50%\s*deposit\s*\+\s*50%\s*on\s+completion\s*$/i

const TRADE_PERCENT_MONEY_RE = /%|percent(?:age)?/i
const TRADE_PAYMENT_LANGUAGE_RE =
  /\b(?:upfront|up-front|balance|owing|payable|outstanding|instal?ment|retainer|progress\s+payment|due|payments?|pay|paid)\b/i
const TRADE_CURRENCY_WORD_RE = /\b(?:dollars?|bucks?)\b/i
const TRADE_CURRENCY_SYMBOL_RE = /[€£¥₹₩₽₪₱₫₴₡₦฿₭₮¢￥＄﹩]/
const TRADE_UNICODE_CURRENCY_RE = /\p{Sc}/u
const TRADE_CURRENCY_CODE_RE =
  /\b(?:A\$|AU\$|US\$|NZ\$|C\$|HK\$|S\$|AUD|USD|EUR|GBP|JPY|NZD|CAD|SGD|HKD|CHF|CNY|INR|KRW|ZAR|VAT|GST)\b/i
const TRADE_CURRENCY_CODE_AMOUNT_RE =
  /\b(?:AUD|USD|EUR|GBP|JPY|NZD|CAD|SGD|HKD|CHF|CNY|INR|KRW|ZAR)\s*-?\d/i
const TRADE_TAX_INVOICE_LANGUAGE_RE =
  /\b(?:tax(?:es|ed|able|ation)?|invoices?|invoiced|invoicing|billing|billed)\b/i
/** Residual money vocabulary after figure-strip. Inflected totals / pricing /
 *  rates / fees / costs / deposits / charged. Bare quote / quotes / quotation
 *  stay off this list so `Quote note text` survives. invoices? and paid|due
 *  stay on tax / payment predicates. Sealed phrase exempt only on payment_terms. */
const TRADE_PACK_INFLECTED_MONEY_VOCAB =
  'totals?|subtotals?|rates?|charg(?:e[ds]?|ing)|pric(?:e[ds]?|ing)|fees?|costs?|amounts?|deposits?'
const TRADE_PACK_INFLECTED_MONEY_VOCAB_RE = new RegExp(
  `\\b(?:${TRADE_PACK_INFLECTED_MONEY_VOCAB}|quoted|unit\\s+price|line\\s+total|totalIncGST|totalExGST)\\b`,
  'i',
)

/** Exact sealed payment-terms phrase. Exempt only on a payment_terms field path. */
export function isSealedPaymentTermsPhrase(value: string): boolean {
  return TRADE_SEALED_PAYMENT_TERMS.test(String(value || '').trim())
}

/** Last path segment is `payment_terms` (`terms.payment_terms`, `extract.terms.payment_terms`). */
export function isTradePaymentTermsFieldPath(path: string): boolean {
  const parts = String(path || '').split(/[.[\]]+/).filter(Boolean)
  return parts[parts.length - 1] === 'payment_terms'
}

/**
 * Ad-hoc percent or payment-language prose. No sealed-phrase exemption —
 * that lives only on an explicit payment_terms field path.
 */
export function tradeTextHasAdHocPercentOrPaymentLanguage(value: string): boolean {
  const trimmed = String(value || '').trim()
  if (!trimmed) return false
  return TRADE_PERCENT_MONEY_RE.test(trimmed) || TRADE_PAYMENT_LANGUAGE_RE.test(trimmed)
}

/** Bare currency words. Not AUD/USD codes — those stay on the token predicate. */
export function tradeTextHasCurrencyWord(value: string): boolean {
  return TRADE_CURRENCY_WORD_RE.test(String(value || '').trim())
}

/**
 * Allocated leftover prose after figure-strip. Same fail-closed predicate
 * as extract / identity leaves — generic money words, USD/GST, deposit,
 * payment language, and currency words all drop. Sealed phrase exemption
 * is payment_terms-only.
 */
export function tradeAllocatedProseHasMoneyLanguage(value: string): boolean {
  return tradeTextHasMoneyToken(value)
}

/**
 * Conservative money-token predicate for every extract / allocated-pack
 * string leaf, including identity fields. Fail closed: any hit drops the
 * field rather than copying it. Covers $, common currency symbols/codes
 * (€ £ ¥ EUR GBP …), tax/invoice/billing prose, and payment language.
 * The sealed payment phrase is money here; callers exempt it only when
 * the field path is payment_terms.
 */
export function tradeTextHasMoneyToken(value: string): boolean {
  const text = String(value || '')
  const trimmed = text.trim()
  if (!trimmed) return false
  if (/\$/.test(text)) return true
  if (TRADE_UNICODE_CURRENCY_RE.test(text)) return true
  if (TRADE_CURRENCY_SYMBOL_RE.test(text)) return true
  if (TRADE_CURRENCY_CODE_RE.test(text)) return true
  if (TRADE_CURRENCY_CODE_AMOUNT_RE.test(text)) return true
  if (tradeTextHasCurrencyWord(text)) return true
  if (TRADE_PACK_INFLECTED_MONEY_VOCAB_RE.test(text)) return true
  if (TRADE_TAX_INVOICE_LANGUAGE_RE.test(text)) return true
  if (tradeTextHasAdHocPercentOrPaymentLanguage(trimmed)) return true
  return false
}

export function assembleQuotePacksForTrade(input: {
  documents: QuoteDocRow[]
  jobType?: string | null
  liveScopeJson?: unknown
  livePricingJson?: unknown
  isHenry?: boolean
  customer?: Partial<TradeQuoteCustomerSnapshot> | null
  terms?: Partial<TradeQuoteTermsSnapshot> | null
}): TradeQuotePack[] {
  // Live fallback is for quote_packs (TRD-4) on an already-sent/accepted
  // quote with no frozen pack. trade_quote_extract never consumes that path.
  const docs = (input.documents || [])
    .filter((d) => String(d?.type || '').toLowerCase() === 'quote')
    .filter((d) => quoteDocumentHasClientSend(d))
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
        customer: input.customer,
        terms: input.terms,
      })
    return applyInstallerRates(
      overlayTradePackSnapshots(packed, {
        customer: input.customer,
        pricing_json: input.livePricingJson,
        terms: input.terms,
      }),
      input.isHenry === true,
    )
  })
}

export type PersistTradePackResult = {
  wrote: number
  failed: Array<{ document_id: string; error: string }>
}

export function persistTradePackWriteConfirmed(
  result: PersistTradePackResult,
  expectedCount: number,
): boolean {
  return result.failed.length === 0 && result.wrote === expectedCount && expectedCount >= 0
}

export async function persistTradePackOnDocuments(
  sb: { from: (table: string) => any },
  args: {
    documents: Array<{
      id?: string
      quote_number?: string | null
      sent_at?: string | null
      claim_token?: string | null
    }>
    jobType?: string | null
    scopeJson?: unknown
    pricingJson?: unknown
    sentAt?: string | null
    customer?: Partial<TradeQuoteCustomerSnapshot> | null
    terms?: Partial<TradeQuoteTermsSnapshot> | null
  },
): Promise<PersistTradePackResult> {
  let wrote = 0
  const failed: PersistTradePackResult['failed'] = []
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
      customer: args.customer,
      terms: args.terms,
    })
    const token = typeof doc.claim_token === 'string' ? doc.claim_token.trim() : ''
    let query = sb.from('job_documents').update({ trade_pack_json: pack }).eq('id', doc.id)
    if (token) query = query.eq('send_claim_token', token)
    const { data, error } = await query.select('id').maybeSingle()
    if (error || !data || typeof data.id !== 'string') {
      const message = error?.message || 'pack write not confirmed'
      console.error('[trade-pack-persist-fail]', JSON.stringify({
        document_id: doc.id,
        error: message,
      }))
      failed.push({ document_id: doc.id, error: message })
      continue
    }
    wrote++
  }
  return { wrote, failed }
}

/** A superseded stamp outranks accept. A revised quote must not stay
 *  extract-eligible just because the earlier version was accepted. */
export function quotePublicationFlags(input: {
  accepted?: boolean
  superseded?: boolean
}): { accepted: boolean; superseded: boolean; status: TradeQuotePackStatus } {
  const superseded = input.superseded === true
  const accepted = input.accepted === true && !superseded
  return {
    accepted,
    superseded,
    status: superseded ? 'superseded' : accepted ? 'accepted' : 'sent',
  }
}

export function quoteDocumentIsSuperseded(doc: QuoteDocRow | null | undefined): boolean {
  return !!doc?.superseded_at
}

export function quoteDocumentHasClientSend(doc: QuoteDocRow | null | undefined): boolean {
  if (doc?.accepted_at) return true
  if (!doc?.sent_at) return false
  // In-flight /send claims send_claimed_at only. That is not publication.
  if (doc.sent_to_client === false) return false
  if (doc.sent_to_client === true) return true
  // Historical rows omit the flag. A still-open claim is not a client send.
  if (doc.send_claimed_at) return false
  return true
}

export function quoteDocumentHasFrozenPack(doc: QuoteDocRow | null | undefined): boolean {
  const stored = asObject(doc?.trade_pack_json)
  return Array.isArray(stored.items)
}

/** Frozen pack for the trade extract only. Requires an authoritative client
 *  send or accept on the document row, plus persisted `trade_pack_json`.
 *  Never synthesizes from live scope/pricing. Overlay fills empty customer
 *  and terms snapshots only. */
export function frozenTradePackForExtract(
  doc: QuoteDocRow,
  overlay?: {
    customer?: Partial<TradeQuoteCustomerSnapshot> | null
    terms?: Partial<TradeQuoteTermsSnapshot> | null
  },
): TradeQuotePack | null {
  if (!quoteDocumentHasClientSend(doc) || !quoteDocumentHasFrozenPack(doc)) return null
  if (quoteDocumentIsSuperseded(doc)) return null
  const packed = hydrateStoredPack(asObject(doc.trade_pack_json), doc)
  if (packed.source === 'live_fallback') return null
  return overlayTradePackSnapshots(packed, {
    customer: overlay?.customer,
    terms: overlay?.terms,
  })
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
  const flags = quotePublicationFlags({
    accepted: !!doc.accepted_at,
    superseded: !!doc.superseded_at,
  })
  const sentAt = doc.sent_at || null
  return {
    quote_number: (stored.quote_number as string) || doc.quote_number || null,
    job_document_id: (stored.job_document_id as string) || doc.id || null,
    sent_at: sentAt,
    accepted: flags.accepted,
    status: flags.superseded ? 'superseded' : flags.accepted ? 'accepted' : sentAt ? 'sent' : 'superseded',
    job_type: classifyJobType(stored.job_type as string, null, null),
    notes: String(stored.notes || ''),
    items,
    // Keep stored summary verbatim. Office / division-manager are quote-visible
    // and must still see monetary summary text. Allocated trades strip later
    // in redactTradeQuotePackMoney.
    summary: String(stored.summary || ''),
    source: stored.source === 'live_fallback' ? 'live_fallback' : 'frozen',
    customer: stored.customer && typeof stored.customer === 'object'
      ? snapshotTradeQuoteCustomer(asObject(stored.customer))
      : emptyTradeQuoteCustomer(),
    terms: stored.terms && typeof stored.terms === 'object'
      ? snapshotTradeQuoteTerms({
        sent_at: (stored.sent_at as string) || doc.sent_at || null,
        terms: asObject(stored.terms),
      })
      : emptyTradeQuoteTerms(),
  }
}

export function emptyTradeQuoteCustomer(): TradeQuoteCustomerSnapshot {
  return { name: null, phone: null, email: null, site_address: null, site_suburb: null }
}

export function emptyTradeQuoteTerms(): TradeQuoteTermsSnapshot {
  return { payment_terms: null, valid_days: null, valid_until: null }
}

export function tradeQuoteCustomerHasValues(
  customer?: Partial<TradeQuoteCustomerSnapshot> | null,
): boolean {
  if (!customer) return false
  return [customer.name, customer.phone, customer.email, customer.site_address, customer.site_suburb]
    .some((v) => String(v || '').trim() !== '')
}

export function tradeQuoteTermsHasValues(
  terms?: Partial<TradeQuoteTermsSnapshot> | null,
): boolean {
  if (!terms) return false
  return String(terms.payment_terms || '').trim() !== '' ||
    (typeof terms.valid_days === 'number' && Number.isFinite(terms.valid_days)) ||
    String(terms.valid_until || '').trim() !== ''
}

export function snapshotTradeQuoteCustomer(
  input?: Partial<TradeQuoteCustomerSnapshot> | null,
): TradeQuoteCustomerSnapshot {
  const raw = input && typeof input === 'object' ? input : {}
  return {
    name: cleanIdentityText(raw.name),
    phone: cleanIdentityText(raw.phone),
    email: cleanIdentityText(raw.email),
    site_address: cleanProseField(raw.site_address),
    site_suburb: cleanProseField(raw.site_suburb),
  }
}

export function snapshotTradeQuoteTerms(input: {
  pricing_json?: unknown
  sent_at?: string | null
  terms?: Partial<TradeQuoteTermsSnapshot> | null
}): TradeQuoteTermsSnapshot {
  const pricing = asObject(input.pricing_json)
  const explicit = input.terms && typeof input.terms === 'object' ? input.terms : {}
  const rawTerms = String(explicit.payment_terms ?? pricing.payment_terms ?? '').trim()
  const paymentTerms = rawTerms
    ? stripTradePackMoney(rawTerms) || null
    : '50% deposit + 50% on completion'
  const rawDays = explicit.valid_days ?? pricing.valid_days ?? 30
  const days = Number(rawDays)
  const validDays = Number.isFinite(days) && days > 0 && days <= 3650 ? Math.round(days) : 30
  const explicitUntil = cleanIdentityText(explicit.valid_until)
  let validUntil = explicitUntil
  if (!validUntil && input.sent_at) {
    const sent = new Date(input.sent_at)
    if (!Number.isNaN(sent.getTime())) {
      validUntil = new Date(sent.getTime() + validDays * 86400000).toISOString().slice(0, 10)
    }
  }
  return {
    payment_terms: paymentTerms,
    valid_days: validDays,
    valid_until: validUntil,
  }
}

export function overlayTradePackSnapshots(
  pack: TradeQuotePack,
  overlay: {
    customer?: Partial<TradeQuoteCustomerSnapshot> | null
    pricing_json?: unknown
    terms?: Partial<TradeQuoteTermsSnapshot> | null
  },
): TradeQuotePack {
  return {
    ...pack,
    customer: tradeQuoteCustomerHasValues(pack.customer)
      ? pack.customer
      : snapshotTradeQuoteCustomer(overlay.customer),
    terms: tradeQuoteTermsHasValues(pack.terms)
      ? pack.terms
      : snapshotTradeQuoteTerms({
        pricing_json: overlay.pricing_json,
        sent_at: pack.sent_at,
        terms: overlay.terms,
      }),
  }
}

function cleanIdentityText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function cleanProseField(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = stripTradePackMoney(value)
  return cleaned || null
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
const TRADE_PACK_CURRENCY_WORD = '(?:dollars?|bucks|usd|aud)'
const TRADE_PACK_CURRENCY_PREFIX =
  `(?:\\b${TRADE_PACK_CURRENCY_WORD}\\s*|AU\\$\\s*|A\\$\\s*|\\$\\s*)`
const TRADE_PACK_CURRENCY_SUFFIX = '(?:AUD\\b|AU\\$|A\\$|\\$)'
const TRADE_PACK_CURRENCY_MID = `(?:\\s+${TRADE_PACK_CURRENCY_WORD})?`
const TRADE_PACK_TAX_WORD = '(?:GST|tax)\\b'
const TRADE_PACK_TAX_QUALIFIER =
  '(?:ex(?:cl(?:uding|usive)?)?|inc(?:l(?:uding|usive)?)?|excluding|including|exclusive|inclusive|plus|\\+)'
const TRADE_PACK_TAX_QUALIFIED =
  `(?:${TRADE_PACK_TAX_QUALIFIER}\\s*[.\\-]?\\s*(?:of\\s+)?${TRADE_PACK_TAX_WORD}|${TRADE_PACK_TAX_WORD}\\s*[.\\-]?\\s*${TRADE_PACK_TAX_QUALIFIER})`
const TRADE_PACK_TAX_PHRASE =
  `(?:${TRADE_PACK_TAX_QUALIFIED}|${TRADE_PACK_TAX_WORD})`
const TRADE_PACK_UNQUALIFIED_MONEY_WORD =
  '(?:totals?|subtotals?|rates?|charg(?:e[ds]?|ing)|pric(?:e[ds]?|ing)|fees?|costs?|amounts?|invoices?|quot(?:e[ds]?|ing|ations?)|deposits?|balances?|paid|due)'
const TRADE_PACK_QTY_WORD =
  '(?:trades?|days?|labourers?|posts?|pickets?|panels?|hours?|hrs?)'
const TRADE_PACK_REF_PREFIX =
  '(?:SWF|SWMS|SWP|SWR|SW|WO|PO|INV|MLB|AJBR|AJ|Q)'

/** Money-safe pack text: drop common currency figures, keep the writing.
 *  Prefix ($ / A$ / AUD / USD / dollars 9,999), suffix / tax forms (9,999 AUD, 9,999 ex GST,
 *  9,999 excluding GST, 9,999 GST exclusive, ex GST 9,999), parenthetical
 *  tax marks, and unqualified totals/rates (Total 9999, rate 85, 85/hour,
 *  1200/m, 85 per day, 85/day, 85 per trade, 85 per panel, 85 each,
 *  85 dollars each, 85 USD each, 85 per item, 85 per gate, 85 per material,
 *  85 per linear metre).
 *  Contextual words also catch two-digit marks (Deposit 85, Deposit of 85,
 *  Price of 85, 12 panels at 85, Balance due 85, Paid 85, Due 85)
 *  without eating construction counts (2 trades, 19m). Leftover
 *  money-shaped numbers (decimals, thousands commas, 3+ digit integers)
 *  fail closed as unrecognised quote amounts (TRD4-REV16-002). Office
 *  full-quote summaries must not call this — hydrateStoredPack keeps
 *  stored summary verbatim. */
export function stripTradePackMoney(text: unknown): string {
  const kept: string[] = []
  const hold = (match: string) => {
    kept.push(match)
    return `^@${kept.length - 1}^@`
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
    // Whole money phrases strip must eat (leftover fail-closed cannot see
    // `uded` from `tax included`, or `attached` after `invoice`).
    .replace(/\btax\s+included\b/gi, '')
    .replace(/\binvoices?\s+attached\b/gi, '')
    .replace(new RegExp(`${TRADE_PACK_CURRENCY_PREFIX}${TRADE_PACK_MONEY_AMOUNT}`, 'gi'), '')
    .replace(new RegExp(`\\p{Sc}\\s*${TRADE_PACK_MONEY_AMOUNT}`, 'gu'), '')
    .replace(new RegExp(`${TRADE_PACK_MONEY_AMOUNT}\\s*\\p{Sc}`, 'gu'), '')
    // Currency-word unit prices before suffix / money-word strips so
    // "85 AUD each" is not reduced to leftover "each", and "Charge 85 dollars
    // each" does not keep the unit after the money word eats 85.
    .replace(
      new RegExp(
        `${TRADE_PACK_MONEY_AMOUNT}${TRADE_PACK_CURRENCY_MID}\\s+each\\b`,
        'gi',
      ),
      '',
    )
    .replace(
      new RegExp(
        `${TRADE_PACK_MONEY_AMOUNT}${TRADE_PACK_CURRENCY_MID}\\s*(?:/\\s*|\\bper\\s+)(?:[A-Za-z]+(?:\\s+[A-Za-z]+)?)\\b`,
        'gi',
      ),
      '',
    )
    .replace(
      new RegExp(
        `${TRADE_PACK_MONEY_AMOUNT}\\s+${TRADE_PACK_CURRENCY_WORD}\\b`,
        'gi',
      ),
      '',
    )
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
        `(\\b${TRADE_PACK_UNQUALIFIED_MONEY_WORD}\\b)\\s*(?:[=:\\-]|(?:of|at|for))?\\s*(?:${TRADE_PACK_CURRENCY_WORD}\\s+)?${TRADE_PACK_MONEY_AMOUNT}\\b`,
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
    // After qty holds, leftover "at 85" / "of 85" / "for 85" are unit prices
    // (12 panels at 85). Keep the connector; drop only the amount.
    .replace(
      new RegExp(
        `(\\b(?:of|at|for)\\b)\\s+${TRADE_PACK_MONEY_AMOUNT}\\b`,
        'gi',
      ),
      '$1',
    )
    // Unrecognised leftover quote amounts: 9,999 / 99.50 / 850 / 18400.
    // 1–2 digit counts stay (2 at, 12 posts) unless a money word already ate them.
    .replace(/\b-?\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, '')
    .replace(/\b-?\d+\.\d+\b/g, '')
    .replace(/\b-?\d{3,}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  s = s.replace(/\^@(\d+)\^@/g, (_, i) => kept[Number(i)] ?? '')
  return s.replace(/\s{2,}/g, ' ').trim()
}

/** Allocated pack / note prose: strings only. Numbers and numeric-only
 *  strings are amounts, not writing — drop them rather than stringify
 *  through the count-preserving sanitizer (TRD4-REV20-003). */
/** ASCII $ figures are strip-and-keep. Any other money language in the
 *  original must fail closed even when strip mangles it (`tax included` → `uded`). */
export function tradeOriginalHasNonFigureMoneyLanguage(value: string): boolean {
  return tradeTextHasMoneyToken(String(value || '').replace(/\$/g, ' '))
}

/** Payment-schedule leftover after a figure strip (`$50 on completion`
 *  → `on completion`). Not the sealed terms phrase. */
const TRADE_PAYMENT_SCHEDULE_REMNANT_RE = /\b(?:on|upon)\s+completion\b/i

export function leftoverIsPaymentScheduleAfterAmountStrip(
  original: string,
  leftover: string,
): boolean {
  const cleaned = String(leftover || '').trim()
  if (!cleaned || !TRADE_PAYMENT_SCHEDULE_REMNANT_RE.test(cleaned)) return false
  if (/^(?:on|upon)\s+completion$/i.test(cleaned)) return true
  return String(original || '').trim() !== cleaned
}

/** Short leftover after strip is a mangled remnant only when it is not a
 *  whole word from the original (`uded` from `tax included`). `Plus` from
 *  `Plus 80 +GST` is strip-and-keep. */
export function leftoverIsMangledMoneyRemnant(original: string, leftover: string): boolean {
  const cleaned = String(leftover || '').trim()
  if (!cleaned || cleaned.length > 8) return false
  const source = String(original || '')
  // Unicode currency / tax-included / invoice-attached originals drop a short
  // leftover (`＄18 extra` → `extra`, `tax included on the invoice attached`
  // → `on the`). ASCII $ is `\p{Sc}` too — strip it first so `$9,999` stays
  // strip-and-keep (`Pat Client $9,999`, `WO line $850`).
  const withoutAsciiDollar = source.replace(/\$/g, ' ')
  if (
    TRADE_UNICODE_CURRENCY_RE.test(withoutAsciiDollar) ||
    TRADE_CURRENCY_SYMBOL_RE.test(withoutAsciiDollar)
  ) {
    return true
  }
  if (/\btax\s+included\b/i.test(source) || /\binvoices?\s+attached\b/i.test(source)) {
    return true
  }
  if (!tradeOriginalHasNonFigureMoneyLanguage(source)) return false
  const leftoverWords = cleaned.toLowerCase().match(/[a-z]+/g) || []
  const originalWords = new Set((source.toLowerCase().match(/[a-z]+/g) || []))
  if (leftoverWords.length > 0 && leftoverWords.every((word) => originalWords.has(word))) {
    return false
  }
  return true
}

export function allocatedTradePackProse(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (/^\$?\s*-?[\d,]+(?:\.\d+)?(?:\s*(?:ex|inc)?\s*gst)?$/i.test(trimmed)) return null
  const cleaned = stripTradePackMoney(value)
  if (!cleaned) return null
  // Sealed phrase is payment_terms-only. A name / item / note leftover
  // matching it is money prose and must not ride the allocated pack.
  // Amount + "on/upon completion" leftovers are the same class.
  if (isSealedPaymentTermsPhrase(cleaned)) return null
  if (tradeTextHasMoneyToken(cleaned)) return null
  if (leftoverIsMangledMoneyRemnant(trimmed, cleaned)) return null
  if (leftoverIsPaymentScheduleAfterAmountStrip(trimmed, cleaned)) return null
  return cleaned
}

/**
 * payment_terms only. Strip billed amounts, then keep the exact sealed
 * leftover. Any other leftover is dropped — "Payment on completion" /
 * "Net 30" are not the sealed phrase. Do not use for customer, items,
 * notes, or summary.
 */
export function allocatedPaymentTerms(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return ''
  const cleaned = stripTradePackMoney(value)
  if (!cleaned) return ''
  return isSealedPaymentTermsPhrase(cleaned) ? cleaned : null
}

/** Phone / email / dates keep digits. Drop the field if a money token is present. */
export function allocatedTradePackIdentity(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (tradeTextHasMoneyToken(trimmed)) return null
  return trimmed
}

const ALLOCATED_PACK_CUSTOMER_STRINGS = [
  'name',
  'phone',
  'email',
  'site_address',
  'site_suburb',
] as const
const ALLOCATED_PACK_TERMS_STRINGS = ['payment_terms', 'valid_until'] as const

/** Customer / terms / summary / item prose / unit leaks on an allocated
 *  quote-pack projection. Same money-token predicate as extract leaves. */
export function allocatedTradeQuotePackProjectionLeaks(pack: unknown): string[] {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) return []
  const row = pack as Record<string, unknown>
  const leaks: string[] = []
  const blob = JSON.stringify(row)
  if (blob.includes('$')) leaks.push('$')
  leaks.push(...tradePackMoneyLeakKeys(row as TradeQuotePack).map((key) => `key.${key}`))
  if (typeof row.quote_number === 'string' && tradeTextHasMoneyToken(row.quote_number)) {
    leaks.push('quote_number')
  }
  if (typeof row.summary === 'string' && tradeTextHasMoneyToken(row.summary)) {
    leaks.push('summary')
  }
  const customer = row.customer
  if (customer && typeof customer === 'object' && !Array.isArray(customer)) {
    for (const key of ALLOCATED_PACK_CUSTOMER_STRINGS) {
      const value = (customer as Record<string, unknown>)[key]
      if (typeof value === 'string' && tradeTextHasMoneyToken(value)) leaks.push(`customer.${key}`)
    }
  }
  const terms = row.terms
  if (terms && typeof terms === 'object' && !Array.isArray(terms)) {
    for (const key of ALLOCATED_PACK_TERMS_STRINGS) {
      const value = (terms as Record<string, unknown>)[key]
      if (typeof value !== 'string') continue
      if (key === 'payment_terms') {
        if (!isSealedPaymentTermsPhrase(value)) leaks.push('terms.payment_terms')
        continue
      }
      if (tradeTextHasMoneyToken(value)) leaks.push(`terms.${key}`)
    }
  }
  const items = row.items
  if (Array.isArray(items)) {
    items.forEach((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return
      const description = (item as Record<string, unknown>).description
      if (typeof description === 'string') {
        if (isSealedPaymentTermsPhrase(description) || tradeTextHasMoneyToken(description)) {
          leaks.push(`items[${index}].description`)
        }
      }
      const unit = (item as Record<string, unknown>).unit
      if (typeof unit === 'string' && tradeTextHasMoneyToken(unit)) {
        leaks.push(`items[${index}].unit`)
      }
    })
  }
  return [...new Set(leaks)]
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
  'sheet',
  'sheets',
])

/** Allocated unit scalar: approved construction vocabulary only, or a
 *  digit-free money-clean token. The shared prose sanitizer holds unmarked
 *  1–2 digit integers as construction counts — that must not apply here, or
 *  bare "85" / "999" ride as units (TRD4-REV19-001). */
export function sanitizeTradePackUnit(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (TRADE_PACK_SAFE_UNITS.has(trimmed.toLowerCase())) return trimmed
  if (/\d/.test(trimmed)) return undefined
  const cleaned = stripTradePackMoney(trimmed)
  if (!cleaned || cleaned !== trimmed) return undefined
  if (/^(?:aud|usd|eur|gbp|jpy|nzd|cad|gst|vat|au\$|a\$|\$|€|£|¥|dollars?|bucks?)$/i.test(cleaned)) {
    return undefined
  }
  if (new RegExp(`^${TRADE_PACK_UNQUALIFIED_MONEY_WORD}$`, 'i').test(cleaned)) return undefined
  if (tradeTextHasMoneyToken(cleaned)) return undefined
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
