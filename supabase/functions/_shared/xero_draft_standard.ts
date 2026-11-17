// The Xero draft standard (ticket P3-01.2): one file decides a draft's division,
// its account rule, whether it carries its four things, and the fingerprint of
// its lines. ops-api's trackingCategoryForJob and phase 2's P2-07 call this file;
// never keep a second copy of the division rule.
//
// A draft our system makes in Xero must carry four things so approving is the
// only step left: an account code on every line (from xero_account_rules), a
// division tag on every line (an ACTIVE option in xero_tracking_options), the
// job reference (bills and credit notes: every line description starts
// `[<job number>] `, because Xero drops Reference on a bill; customer invoices:
// the job number is in Reference), and the source document (never on a
// customer invoice: an attachment there could go out to the customer).
// Nothing here fills a gap with a guess: an unknown division is '' and named.
// This file never calls Xero.

// ── Division (Business Unit) rule ──
// Maps a job to its Xero "Business Unit" tracking option.
//
// SWR- IS NOW AMBIGUOUS, AND THIS FUNCTION REFUSES TO GUESS.
//
// The prefix was already shared by renovation and roofing; repair makes it three
// ways. An insurance repair is SES insurance work and books where the make-safe /
// SES insurance work books (NOT 'SW - PRIVATE ROOFING', which is private
// roofing revenue). So a bare SWR- number can no longer decide a business unit,
// and returning a wrong category is worse than returning none: every caller
// already handles the empty answer (they skip Tracking, or fall back to
// 'Construction' in a description), whereas a wrong one silently misfiles
// revenue and nobody notices until month end.
//
// Pass the job type wherever a job row is in hand and the answer is exact.
// Callers holding only a job-number string (supplier bills, WO cost lines) get
// '' for SWR-. Every OTHER prefix is untouched and answers exactly as before.
//
// The pre-merge premise (PR #771) was that production held zero renovation
// jobs, zero roofing jobs and zero SWR- job numbers, so no existing row changed
// answer. That premise is spent: the repair SWR- mint lane went live 2026-08-28,
// which is exactly why a bare SWR- number must keep resolving to '' rather than
// being taught a default. Re-measure production before assuming any count here.
//
// 'SW - MAKESAFE' for repair is inherited from the make-safe route, and the
// captain confirmed the intent behind it on 2026-08-31: repair revenue books as
// make-safe / insurance work, so it tracks where SES insurance work already
// tracks. Read that intent, not the string: a future tracking split follows the
// insurance work, not the 'repair' label. (Closes what this comment carried as
// OPEN RISK #2; OPEN RISK #1, captain signoff on the money-seal path, is a
// different question and stays open in the 20260826000001 migration header.)
//
// Division stock (a line booked to a division, not a job) names its division in
// stock_division: an option already written `SW - ...` is taken as it is, and a
// plain division word maps to its option. Anything else falls to the job rule.

export const DIVISION_CATEGORY_NAME = 'Business Unit'

const STOCK_DIVISION_OPTIONS: Record<string, string> = {
  patio: 'SW - PATIOS',
  patios: 'SW - PATIOS',
  fencing: 'SW - FENCING',
  fence: 'SW - FENCING',
  decking: 'SW - DECKING',
  deck: 'SW - DECKING',
  roofing: 'SW - PRIVATE ROOFING',
  makesafe: 'SW - MAKESAFE',
  insurance: 'SW - INSURANCE WORK',
  restoration: 'SW - RESTORATION',
}

export function divisionTrackingOption(input: {
  job_number?: string | null
  job_type?: string | null
  stock_division?: string | null
}): string {
  const stock = String(input.stock_division || '').trim()
  if (stock.startsWith('SW - ')) return stock
  const stockOption = STOCK_DIVISION_OPTIONS[stock.toLowerCase()]
  if (stockOption) return stockOption

  const jobNumber = String(input.job_number || '')
  const jobType = input.job_type
  // An explicit type always wins, including when the job has no number yet.
  const type = String(jobType || '').trim().toLowerCase()
  // Granny-flat accounting is unresolved. Never infer a division from its retained number.
  if (type === 'granny_flat') return ''
  if (type === 'repair') return 'SW - MAKESAFE'
  if (type === 'roofing' || type === 'renovation') return 'SW - PRIVATE ROOFING'
  if (!jobNumber) return ''
  const upper = jobNumber.toUpperCase()
  // SWRESTO- (restoration) has its own Business Unit option (owner, 12 Nov
  // 2026); it must be read before the 'SWR' slice below, which answers ''.
  if (upper.startsWith('SWRESTO-')) return 'SW - RESTORATION'
  if (upper.startsWith('SWMS-') || upper.startsWith('AJBR') || upper.startsWith('MS1') || upper.startsWith('BWCWA') || upper.startsWith('WB6')) return 'SW - MAKESAFE'
  const prefix = upper.slice(0, 3)
  if (prefix === 'SWP') return 'SW - PATIOS'
  if (prefix === 'SWF') return 'SW - FENCING'
  if (prefix === 'SWD') return 'SW - DECKING'
  if (prefix === 'SWI') return 'SW - INSURANCE WORK'
  // 'SWR' deliberately falls through to '': renovation | roofing | repair.
  return ''
}

// ── Account rules (xero_account_rules) ──

export type XeroAccountSourceKind = 'trade_invoice' | 'expense_receipt' | 'supplier_bill' | 'supplier_credit'

export type XeroAccountRule = {
  org_id?: string
  source_kind: string
  line_kind: string
  account_code: string
  tax_type?: string | null
  note?: string | null
  confirmed_by?: string | null
  confirmed_at?: string | null
}

// The row for this kind of document and line; else that document's 'default'
// row; else null (the caller names the gap, never invents a code).
export function accountRuleFor(
  rules: readonly XeroAccountRule[] | null | undefined,
  sourceKind: string,
  lineKind: string,
): XeroAccountRule | null {
  const list = rules || []
  return list.find((r) => r.source_kind === sourceKind && r.line_kind === lineKind) ||
    list.find((r) => r.source_kind === sourceKind && r.line_kind === 'default') ||
    null
}

export type DraftStandard = {
  rules: XeroAccountRule[]
  activeOptions: Set<string>
  optionsLoaded: boolean
}

// deno-lint-ignore no-explicit-any
type SupabaseLike = { from: (table: string) => any }

// Two reads: the org's account rules, and its ACTIVE division options.
// optionsLoaded is false when the options read failed or found no row, so a
// draft is never called correctly tagged against an empty list.
export async function loadDraftStandard(client: SupabaseLike, orgId: string): Promise<DraftStandard> {
  const [rulesRes, optionsRes] = await Promise.all([
    client.from('xero_account_rules')
      .select('org_id, source_kind, line_kind, account_code, tax_type, note, confirmed_by, confirmed_at')
      .eq('org_id', orgId),
    client.from('xero_tracking_options')
      .select('option_name')
      .eq('org_id', orgId)
      .eq('status', 'ACTIVE'),
  ])
  if (rulesRes?.error) console.error('[xero_draft_standard] account rules not read:', rulesRes.error.message)
  if (optionsRes?.error) console.error('[xero_draft_standard] division options not read:', optionsRes.error.message)
  const rules: XeroAccountRule[] = rulesRes?.error ? [] : (rulesRes?.data || [])
  const optionRows: { option_name: string }[] = optionsRes?.error ? [] : (optionsRes?.data || [])
  return {
    rules,
    activeOptions: new Set(optionRows.map((r) => String(r.option_name))),
    optionsLoaded: !optionsRes?.error && optionRows.length > 0,
  }
}

// ── Job reference ──

export function withJobPrefix(jobNumber: string | null | undefined, description: string | null | undefined): string {
  const desc = String(description ?? '')
  const job = String(jobNumber || '').trim()
  if (!job) return desc
  const prefix = `[${job}] `
  if (desc.startsWith(prefix)) return desc
  return prefix + desc
}

// ── Completeness check ──

export type DraftDocumentType = 'ACCPAY' | 'ACCPAYCREDIT' | 'ACCREC'

export type DraftLine = {
  accountCode?: string | null
  trackingOption?: string | null
  description?: string | null
  jobNumber?: string | null
}

export type DraftToCheck = {
  documentType: DraftDocumentType
  lines: DraftLine[]
  billNumber?: string | null
  reference?: string | null
  hasSourceDocument: boolean
}

export type DraftProblemCode =
  | 'account_code_missing'
  | 'division_not_known'
  | 'division_option_not_active'
  | 'options_not_loaded'
  | 'job_reference_missing'
  | 'source_document_missing'

// line is the line's position counting from 1, or null for a problem with the
// whole draft.
export type DraftProblem = { code: DraftProblemCode; line: number | null; text: string }

export type DraftCheck = {
  has_account_codes: boolean
  has_division_tags: boolean
  has_job_reference: boolean
  has_source_document: boolean
  problems: DraftProblem[]
}

// Each has_* flag is true exactly when the draft has no problem of that kind,
// so "any flag false" and "has problems" always agree. A customer invoice is
// never short of a source document (nothing is attached to one by design), so
// its has_source_document is true. When the option list was not loaded the
// tags cannot be shown ACTIVE: one options_not_loaded problem, and
// has_division_tags is false rather than assumed.
export function checkDraft(draft: DraftToCheck, standard: Pick<DraftStandard, 'activeOptions' | 'optionsLoaded'>): DraftCheck {
  const problems: DraftProblem[] = []
  const isBillOrCredit = draft.documentType === 'ACCPAY' || draft.documentType === 'ACCPAYCREDIT'
  const lines = draft.lines || []
  const billNumber = String(draft.billNumber || '')
  const reference = String(draft.reference || '')

  if (!standard.optionsLoaded) {
    problems.push({ code: 'options_not_loaded', line: null, text: 'The list of division options was not loaded, so no tag could be checked' })
  }

  lines.forEach((l, i) => {
    const n = i + 1
    if (!String(l.accountCode || '').trim()) {
      problems.push({ code: 'account_code_missing', line: n, text: `Line ${n} has no account code` })
    }
    const option = String(l.trackingOption || '').trim()
    if (!option) {
      problems.push({ code: 'division_not_known', line: n, text: `Line ${n} has no division tag` })
    } else if (standard.optionsLoaded && !standard.activeOptions.has(option)) {
      problems.push({ code: 'division_option_not_active', line: n, text: `Line ${n} division ${option} is not an active option in Xero` })
    }
    const job = String(l.jobNumber || '').trim()
    if (job) {
      if (isBillOrCredit) {
        if (!String(l.description || '').startsWith(`[${job}] `) && !billNumber.includes(job)) {
          problems.push({ code: 'job_reference_missing', line: n, text: `Line ${n} does not start with job ${job}` })
        }
      } else if (!reference.includes(job)) {
        problems.push({ code: 'job_reference_missing', line: n, text: `The reference does not carry job ${job}` })
      }
    }
  })

  if (isBillOrCredit && !draft.hasSourceDocument) {
    problems.push({ code: 'source_document_missing', line: null, text: 'No source document is attached' })
  }

  const has = (codes: DraftProblemCode[]) => !problems.some((p) => codes.includes(p.code))
  return {
    has_account_codes: has(['account_code_missing']),
    has_division_tags: has(['division_not_known', 'division_option_not_active', 'options_not_loaded']),
    has_job_reference: has(['job_reference_missing']),
    has_source_document: has(['source_document_missing']),
    problems,
  }
}

// ── Fingerprint ──
// sha256 (hex) of each line's account, tag, quantity and unit amount in cents,
// in order. Tax type is left out: Xero fills in its own default.

export type FingerprintLine = {
  accountCode?: string | null
  trackingOption?: string | null
  quantity?: number | string | null
  unitAmount?: number | string | null
}

export async function linesFingerprint(lines: readonly FingerprintLine[]): Promise<string> {
  const text = JSON.stringify(lines.map((l) => [
    String(l.accountCode || ''),
    String(l.trackingOption || ''),
    Number(l.quantity || 0),
    Math.round(Number(l.unitAmount || 0) * 100),
  ]))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
