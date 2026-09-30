// Debt book: the live, read-only book behind the Clear Debt desk (plan step 1).
// Plan: docs/debt-book/PLAN.md sections 3 and 6. Rules: debt_book_rules.ts.
// Screen contract: secureworks-ux docs/clear-debt-desk.md (`debt_book`, GET).
//
//   debt_book   reads every open sales invoice live from Xero through the read-only
//               xero_receivables_read.ts (no cache, no provider write), applies the
//               captain's rules, and compares the result with our copy (xero_invoices).
//
// Xero is the truth (D2). Our copy is read only for the job link, the desk class, job
// status and first payment, and for the copy-vs-Xero check. This module writes nothing:
// no database write, no Xero write, no message.

import { listXeroReceivables } from './xero_receivables_read.ts'
import {
  classifyDebtBookInvoice,
  DEBT_BOOK_CHECK_FIRST,
  DEBT_BOOK_CORRECTIONS,
  DEBT_BOOK_PAYERS,
  type DebtBookCopyRow,
  type DebtBookInvoice,
  type DebtBookJobContext,
  debtBookHeadlineReason,
  diffDebtBookCopy,
  normaliseXeroInvoice,
  perthDate,
  perthTimestamp,
  summariseDebtBook,
} from './debt_book_rules.ts'

export const DEBT_BOOK_VERSION = 'debt-book/v1'

/** Xero returns 100 invoices a page; the book is about two pages. Ten pages is a runaway guard, not a limit on the book. */
const MAX_PAGES = 10
const PAGE_SIZE = 100
/** Keeps each PostgREST `.in()` well inside a reliable GET URL (36-character UUIDs). */
const IN_CHUNK = 50
const COPY_PAGE = 1000

export class DebtBookError extends Error {
  constructor(message: string, readonly status = 502, readonly code = 'debt_book_unavailable', readonly details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'DebtBookError'
  }
}

export interface DebtBookCopyRecord extends DebtBookCopyRow {
  job_id: string | null
  debt_classification: string | null
}

export interface DebtBookJobRecord {
  id: string
  job_number: string | null
  status: string | null
  deposit_at: string | null
}

/** The only database reads the book makes. Every method reads; none writes. */
export interface DebtBookStore {
  copyRowsByXeroIds(ids: string[]): Promise<DebtBookCopyRecord[]>
  openCopyRows(): Promise<DebtBookCopyRecord[]>
  jobsByIds(ids: string[]): Promise<DebtBookJobRecord[]>
  jobsByNumbers(numbers: string[]): Promise<DebtBookJobRecord[]>
  /** Job ids (from the given ones) that carry at least one PAID sales invoice in our copy. */
  paidJobIds(jobIds: string[]): Promise<string[]>
}

type ReceivablesDeps = Parameters<typeof listXeroReceivables>[2]
export type DebtBookDeps = ReceivablesDeps & { store: DebtBookStore; now?: () => Date }

function chunks<T>(xs: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

const COPY_SELECT = 'xero_invoice_id, invoice_number, status, amount_due, due_date, synced_at, job_id, debt_classification'
const JOB_SELECT = 'id, job_number, status, deposit_at'

// deno-lint-ignore no-explicit-any
function readFailed(what: string, error: any): never {
  // A PostgREST error comes back, it is not thrown. Emptiness here would change which
  // invoices count as debt, so an unreadable read stops the book rather than degrading it.
  console.error(`[debt_book] ${what} read failed`, error?.code ?? '', error?.message ?? error)
  throw new DebtBookError(`The debt book could not read ${what}`, 502, 'debt_book_read_failed', { read: what })
}

// deno-lint-ignore no-explicit-any
export function createSupabaseDebtBookStore(client: any, orgId: string): DebtBookStore {
  return {
    async copyRowsByXeroIds(ids) {
      const out: DebtBookCopyRecord[] = []
      for (const part of chunks(ids)) {
        const { data, error } = await client.from('xero_invoices').select(COPY_SELECT)
          .eq('org_id', orgId).eq('invoice_type', 'ACCREC').in('xero_invoice_id', part)
        if (error) readFailed('our invoice copy', error)
        out.push(...(data || []))
      }
      return out
    },
    async openCopyRows() {
      const out: DebtBookCopyRecord[] = []
      for (let offset = 0; ; offset += COPY_PAGE) {
        const { data, error } = await client.from('xero_invoices').select(COPY_SELECT)
          .eq('org_id', orgId).eq('invoice_type', 'ACCREC').eq('status', 'AUTHORISED').gt('amount_due', 0)
          .order('xero_invoice_id', { ascending: true }).range(offset, offset + COPY_PAGE - 1)
        if (error) readFailed('our open invoice copy', error)
        out.push(...(data || []))
        if (!data || data.length < COPY_PAGE) break
      }
      return out
    },
    async jobsByIds(ids) {
      const out: DebtBookJobRecord[] = []
      for (const part of chunks(ids)) {
        const { data, error } = await client.from('jobs').select(JOB_SELECT).in('id', part)
        if (error) readFailed('jobs', error)
        out.push(...(data || []))
      }
      return out
    },
    async jobsByNumbers(numbers) {
      const out: DebtBookJobRecord[] = []
      for (const part of chunks(numbers)) {
        const { data, error } = await client.from('jobs').select(JOB_SELECT).in('job_number', part)
        if (error) readFailed('jobs by number', error)
        out.push(...(data || []))
      }
      return out
    },
    async paidJobIds(jobIds) {
      const out = new Set<string>()
      for (const part of chunks(jobIds)) {
        const { data, error } = await client.from('xero_invoices').select('job_id')
          .eq('org_id', orgId).eq('invoice_type', 'ACCREC').eq('status', 'PAID').in('job_id', part)
        if (error) readFailed('paid invoices on jobs', error)
        for (const r of data || []) if (r?.job_id) out.add(String(r.job_id))
      }
      return [...out]
    },
  }
}

/** Our job numbers as they appear in references: SWF-26556, SWP-261046, SWMS-26845, SWR-1. */
const JOB_NUMBER_IN_REFERENCE = /\bSW[A-Z]{1,3}-\d{3,7}\b/gi

function referenceJobNumber(reference: string): string | null {
  const found = [...new Set((reference.match(JOB_NUMBER_IN_REFERENCE) || []).map((s) => s.toUpperCase()))]
  return found.length === 1 ? found[0] : null
}

type Params = URLSearchParams | Record<string, unknown>

function validateParams(params: Params) {
  const keys = params instanceof URLSearchParams ? [...params.keys()] : Object.keys(params)
  for (const key of keys) {
    if (key !== 'action') throw new DebtBookError(`Unsupported parameter: ${key}`, 400, 'debt_book_bad_request')
  }
}

/** Read every page of the open book, stopping only on Xero's end of results. */
async function readOpenBook(client: unknown, deps: ReceivablesDeps) {
  const byId = new Map<string, Record<string, unknown>>()
  const pages: Array<Record<string, unknown>> = []
  let duplicates = 0
  let tenant: string | null = null
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await listXeroReceivables(client, { status: 'OUTSTANDING', page: String(page), page_size: String(PAGE_SIZE) }, deps)
    tenant = result.provenance.tenant_id
    for (const invoice of result.invoices) {
      const id = String(invoice.InvoiceID).toLowerCase()
      // Pages are live reads, not a snapshot: an invoice can appear on two pages.
      if (byId.has(id)) duplicates += 1
      byId.set(id, invoice)
    }
    pages.push({
      page,
      count: result.invoices.length,
      retrieved_at: result.provenance.retrieved_at,
      request_id: result.provenance.request_id,
      quota: result.provenance.quota,
      cache_used: result.provenance.cache_used,
    })
    // `traversal_complete` is always false on this reader; the end is an incomplete page.
    if (result.pagination.end_of_results_observed || !result.pagination.has_more) {
      return { invoices: [...byId.values()], pages, duplicates, tenant }
    }
  }
  throw new DebtBookError(`Xero still had more invoices after ${MAX_PAGES} pages; the book was not read to the end`, 502, 'debt_book_traversal_incomplete', { pages })
}

export async function readDebtBook(client: unknown, params: Params, deps: DebtBookDeps) {
  validateParams(params)
  const { store } = deps
  const book = await readOpenBook(client, deps)
  const readAt = (deps.now?.() ?? new Date())
  const perth = perthDate(readAt)
  const invoices = book.invoices.map((raw) => normaliseXeroInvoice(raw))

  // Our copy: job link and desk class per invoice, plus every row the copy thinks is open.
  const ids = invoices.map((i) => i.xero_invoice_id)
  const [copyById, openCopy] = await Promise.all([store.copyRowsByXeroIds(ids), store.openCopyRows()])
  const copy = new Map<string, DebtBookCopyRecord>()
  for (const r of [...openCopy, ...copyById]) copy.set(String(r.xero_invoice_id).toLowerCase(), r)

  // Jobs: the copy's job link first, then the one job number named in the reference.
  const linkedJobIds = [...new Set(ids.map((id) => copy.get(id)?.job_id).filter((x): x is string => !!x))]
  const refNumbers = [...new Set(invoices
    .filter((i) => !copy.get(i.xero_invoice_id)?.job_id)
    .map((i) => referenceJobNumber(i.reference))
    .filter((x): x is string => !!x))]
  const [jobsById, jobsByNumber] = await Promise.all([
    linkedJobIds.length ? store.jobsByIds(linkedJobIds) : Promise.resolve([]),
    refNumbers.length ? store.jobsByNumbers(refNumbers) : Promise.resolve([]),
  ])
  const jobById = new Map(jobsById.map((j) => [String(j.id), j]))
  const numberMatches = new Map<string, DebtBookJobRecord[]>()
  for (const j of jobsByNumber) {
    const k = String(j.job_number ?? '').toUpperCase()
    numberMatches.set(k, [...(numberMatches.get(k) || []), j])
  }
  const allJobIds = [...new Set([...jobsById, ...jobsByNumber].map((j) => String(j.id)))]
  const paid = new Set(allJobIds.length ? await store.paidJobIds(allJobIds) : [])

  const rows = invoices.map((invoice) => {
    const copyRow = copy.get(invoice.xero_invoice_id) ?? null
    let jobRow: DebtBookJobRecord | null = null
    let linkSource: DebtBookJobContext['link_source'] = null
    if (copyRow?.job_id && jobById.has(String(copyRow.job_id))) {
      jobRow = jobById.get(String(copyRow.job_id))!
      linkSource = 'copy_job_id'
    } else {
      const n = referenceJobNumber(invoice.reference)
      const matches = n ? numberMatches.get(n) || [] : []
      if (matches.length === 1) {
        jobRow = matches[0]
        linkSource = 'reference_job_number'
      }
    }
    const job: DebtBookJobContext = {
      job_id: jobRow?.id ?? null,
      job_number: jobRow?.job_number ?? null,
      job_status: jobRow?.status ?? null,
      first_payment: jobRow ? (!!jobRow.deposit_at || paid.has(String(jobRow.id))) : null,
      link_source: linkSource,
      desk_class: copyRow?.debt_classification ?? null,
    }
    return { invoice, job, classification: classifyDebtBookInvoice(invoice, job, { perthDate: perth }) }
  })

  const summary = summariseDebtBook(rows)
  const diff = diffDebtBookCopy(invoices, [...copy.values()], { readAt: readAt.toISOString() })

  return {
    ok: true,
    version: DEBT_BOOK_VERSION,
    read_at: perthTimestamp(readAt),
    perth_date: perth,
    copy_check: {
      matches: diff.matches,
      differs_by: diff.differing_amount,
      invoice_count: diff.differing_count,
      stamp: diff.stamp,
      xero_open: diff.xero_open,
      copy_open: diff.copy_open,
      missing_from_copy: diff.missing_from_copy,
      copy_not_open: diff.copy_not_open,
      copy_open_not_in_xero: diff.copy_open_not_in_xero,
      amount_differs: diff.amount_differs,
      due_date_differs: diff.due_date_differs,
    },
    summary,
    invoices: rows
      .sort((a, b) => b.invoice.amount_due - a.invoice.amount_due || a.invoice.invoice_number.localeCompare(b.invoice.invoice_number))
      .map(({ invoice, job, classification: c }) => ({
        xero_invoice_id: invoice.xero_invoice_id,
        invoice_number: invoice.invoice_number,
        reference: invoice.reference,
        contact_id: invoice.contact_id,
        contact_name: invoice.contact_name,
        payer: c.payer.key,
        kind: c.kind,
        is_debt: c.counts_as_debt,
        reason: debtBookHeadlineReason(c),
        hold: c.hold?.kind ?? null,
        hold_reason: c.hold ? c.hold.reasons.map((h) => h.reason).join('; ') : null,
        invoice_date: invoice.invoice_date,
        due_date: invoice.due_date,
        total: invoice.total,
        amount_due: invoice.amount_due,
        amount_paid: invoice.amount_paid,
        amount_credited: invoice.amount_credited,
        job_id: job.job_id ?? null,
        job_number: job.job_number,
        job_status: job.job_status,
        job_link: job.link_source,
        job_first_payment: job.first_payment,
        desk_class: job.desk_class,
        builder_work: c.builder_work,
        not_debt_reason: c.not_debt_reason,
        overdue: c.overdue,
        days_overdue: c.days_overdue,
        age_bucket: c.age_bucket,
        start_step: c.start_step,
        hold_reasons: c.hold?.reasons ?? [],
        corrections: c.corrections,
        reasons: c.reasons,
        line_descriptions: invoice.line_descriptions,
        line_count: (invoice as DebtBookInvoice & { line_count?: number }).line_count ?? invoice.line_descriptions.length,
      })),
    rules: { payers: DEBT_BOOK_PAYERS, corrections: DEBT_BOOK_CORRECTIONS, check_first: DEBT_BOOK_CHECK_FIRST },
    source: {
      source: 'xero',
      tenant_id: book.tenant,
      cache_used: false,
      end_of_results_observed: true,
      invoice_count: invoices.length,
      duplicates_dropped: book.duplicates,
      pages: book.pages,
    },
  }
}
