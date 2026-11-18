// P3-01.9: every Xero draft the system creates writes one row to
// xero_draft_register (P3-01.4), and an office draft with a problem raises one
// draft_incomplete item on the Reconcile list for a person.
//
// Behind the draft standard switch (xero_draft_standard_v1, seeded off): with
// it off, missing or unreadable, nothing is read beyond the switch and nothing
// is written, as on main. The record never changes what Xero is sent, and it
// never fails or blocks the draft it records: every error is logged (codes and
// ids only) and answered { recorded: false }.
//
// The lines are taken from the document Xero returned when it carries them,
// else from the document we sent, mapped exactly as the daily check
// (xero-sync/draft_approval_check.ts approvedSnapshotLines) maps our stored
// copy, so an unedited draft keeps the same fingerprint. Only a document Xero
// holds as DRAFT is recorded: an invoice created AUTHORISED, or a bill reused
// after it was approved, is not a draft.

import { readSwitch } from './switch_cache.ts'
import {
  checkDraft,
  type DraftDocumentType,
  type DraftLine,
  type DraftProblem,
  type FingerprintLine,
  linesFingerprint,
  loadDraftStandard,
} from './xero_draft_standard.ts'

export const DRAFT_REGISTER_SWITCH = 'xero_draft_standard_v1'
export const DRAFT_INCOMPLETE_KIND = 'draft_incomplete'
export const DRAFT_RAISED_BY = 'phase3:books'

export type DraftRegisterRow = 'X3' | 'X6' | 'X7' | 'X9'

export type RecordXeroDraftInput = {
  orgId: string
  xeroDocumentId: string | null | undefined
  documentType: DraftDocumentType
  sourceKind: string
  sourceId: string | null | undefined
  registerRow: DraftRegisterRow
  jobIds: readonly (string | null | undefined)[]
  // The one document we sent (Invoices[0] or CreditNotes[0]).
  // deno-lint-ignore no-explicit-any
  payload: any
  // The one document Xero returned, when the caller has it.
  // deno-lint-ignore no-explicit-any
  returned?: any
  hasSourceDocument: boolean
  raise: boolean
}

export type RecordXeroDraftResult = {
  recorded: boolean
  skipped?: 'switch_off' | 'no_document_id' | 'not_draft'
  raised?: boolean
  raise_error?: string
  problems?: number
}

// deno-lint-ignore no-explicit-any
type SupabaseLike = { from: (table: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => any }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const DOCUMENT_WORDS: Record<DraftDocumentType, string> = {
  ACCPAY: 'bill',
  ACCPAYCREDIT: 'credit note',
  ACCREC: 'customer invoice',
}

const PROBLEM_WORDS: Record<DraftProblem['code'], string> = {
  account_code_missing: 'an account code',
  division_not_known: 'a division tag',
  division_option_not_active: 'an active division tag',
  options_not_loaded: 'a checked division tag',
  job_reference_missing: 'the job reference',
  source_document_missing: 'its source document',
}

function errCode(error: unknown): string {
  // deno-lint-ignore no-explicit-any
  const e = error as any
  return String(e?.code || e?.name || 'unknown')
}

// Real job ids only, each once: a missing or made-up id never reaches the list.
export function draftJobIds(ids: readonly (string | null | undefined)[]): string[] {
  const out: string[] = []
  for (const id of ids || []) {
    const s = String(id || '').trim()
    if (UUID_RE.test(s) && !out.includes(s)) out.push(s)
  }
  return out
}

// The document's lines: Xero's returned list when it carries one, else ours.
// deno-lint-ignore no-explicit-any
function documentLineItems(input: Pick<RecordXeroDraftInput, 'payload' | 'returned'>): any[] {
  const returned = input.returned?.LineItems
  if (Array.isArray(returned) && returned.length > 0) return returned
  return Array.isArray(input.payload?.LineItems) ? input.payload.LineItems : []
}

// Same mapping as the daily check's approvedSnapshotLines.
// deno-lint-ignore no-explicit-any
export function draftFingerprintLines(lineItems: readonly any[]): FingerprintLine[] {
  return (lineItems || []).map((li) => ({
    accountCode: li?.AccountCode ?? null,
    trackingOption: li?.Tracking?.[0]?.Option ?? null,
    quantity: li?.Quantity ?? null,
    unitAmount: li?.UnitAmount ?? null,
  }))
}

// deno-lint-ignore no-explicit-any
function draftCheckLines(lineItems: readonly any[]): DraftLine[] {
  return (lineItems || []).map((li) => ({
    accountCode: li?.AccountCode ?? null,
    trackingOption: li?.Tracking?.[0]?.Option ?? null,
    description: li?.Description ?? null,
  }))
}

// 'a division tag and its source document'; each kind of problem once.
export function problemsInWords(problems: readonly DraftProblem[]): string {
  const words: string[] = []
  for (const p of problems) {
    const w = PROBLEM_WORDS[p.code] || p.code
    if (!words.includes(w)) words.push(w)
  }
  if (words.length <= 1) return words[0] || ''
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

function documentDate(input: Pick<RecordXeroDraftInput, 'payload' | 'returned'>): string | null {
  for (const raw of [input.payload?.Date, input.returned?.DateString]) {
    const d = String(raw || '').slice(0, 10)
    if (DATE_RE.test(d)) return d
  }
  return null
}

export async function recordXeroDraft(client: SupabaseLike, input: RecordXeroDraftInput): Promise<RecordXeroDraftResult> {
  try {
    if (!await readSwitch(client, DRAFT_REGISTER_SWITCH)) return { recorded: false, skipped: 'switch_off' }
    const documentId = String(input.xeroDocumentId || '').trim()
    if (!documentId) return { recorded: false, skipped: 'no_document_id' }
    const returnedStatus = String(input.returned?.Status || '').trim().toUpperCase()
    if (returnedStatus && returnedStatus !== 'DRAFT') return { recorded: false, skipped: 'not_draft' }

    const lineItems = documentLineItems(input)
    const standard = await loadDraftStandard(client, input.orgId)
    const check = checkDraft({
      documentType: input.documentType,
      lines: draftCheckLines(lineItems),
      billNumber: input.payload?.InvoiceNumber ?? null,
      reference: input.payload?.Reference ?? null,
      hasSourceDocument: input.hasSourceDocument === true,
    }, standard)
    const fingerprint = await linesFingerprint(draftFingerprintLines(lineItems))
    const jobIds = draftJobIds(input.jobIds)
    const sourceId = String(input.sourceId || '').trim() || null

    // drafted_at keeps its first value; approval columns are the daily check's.
    const { error: upErr } = await client.from('xero_draft_register').upsert({
      org_id: input.orgId,
      xero_document_id: documentId,
      document_type: input.documentType,
      source_kind: input.sourceKind,
      source_id: sourceId,
      register_row: input.registerRow,
      job_ids: jobIds,
      lines_fingerprint: fingerprint,
      has_account_codes: check.has_account_codes,
      has_division_tags: check.has_division_tags,
      has_job_reference: check.has_job_reference,
      has_source_document: check.has_source_document,
      problems: check.problems,
    }, { onConflict: 'org_id,xero_document_id' })
    if (upErr) {
      console.error('[xero_draft_register] draft not recorded', input.registerRow, documentId, errCode(upErr))
      return { recorded: false }
    }

    const result: RecordXeroDraftResult = { recorded: true, problems: check.problems.length }
    if (!input.raise || check.problems.length === 0) return result
    if (typeof client.rpc !== 'function') {
      result.raised = false
      result.raise_error = 'no_rpc'
      return result
    }
    let raiseErr: unknown = null
    try {
      const answer = await client.rpc('reconcile_item_raise', {
        p_kind: DRAFT_INCOMPLETE_KIND,
        p_subject_table: 'xero_draft_register',
        p_subject_id: documentId,
        p_job_ids: jobIds,
        p_suggestion: null,
        p_evidence: {
          reason: DRAFT_INCOMPLETE_KIND,
          document_type: input.documentType,
          amount_ex: null,
          document_date: documentDate(input),
          summary: {
            words: `Draft ${DOCUMENT_WORDS[input.documentType]} is missing ${problemsInWords(check.problems)}`,
            problems: check.problems,
          },
        },
        p_raised_by: DRAFT_RAISED_BY,
        p_org_id: input.orgId,
      })
      raiseErr = answer?.error ?? null
    } catch (error) {
      raiseErr = error ?? { code: 'raise_threw' }
    }
    if (raiseErr) {
      const code = errCode(raiseErr)
      if (code === 'PGRST202') console.warn('[xero_draft_register] raise function not reachable; draft recorded', documentId)
      else console.error('[xero_draft_register] raise failed; draft recorded', documentId, code)
      result.raised = false
      result.raise_error = code
      return result
    }
    result.raised = true
    return result
  } catch (error) {
    console.error('[xero_draft_register] draft not recorded', input?.registerRow, String(input?.xeroDocumentId || ''), errCode(error))
    return { recorded: false }
  }
}
