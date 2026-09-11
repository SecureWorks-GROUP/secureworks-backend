// Debt picture: the classification data behind the Clear Debt screen.
// Design: secureworks-wiki lanes/DEBT_COLLECTION/DESIGN-clear-debt-2026-09-11.md (accepted 11 Sep 2026).
//
// Three actions, all on the desk's own columns of xero_invoices and on payment_chase_logs:
//   upsert_debt_picture  write class, type, blocker, owner, reason, next action, void proposal,
//                        handoff, source, as-of, brief and pending proposal for a batch of invoices.
//                        Logs every class change to payment_chase_logs (method classification).
//                        Never touches GHL tags, Xero, or sends anything.
//   list_debt_picture    every open receivable with its classification columns and job link,
//                        for the screen to group by kind, type and blocker.
//   debt_note            add a note (with a tag) against an invoice and its job; returns the merged
//                        thread (desk notes plus the job's own notes), newest first.

export const DEBT_PICTURE_VERSION = 'debt-picture/v1'

export const DEBT_CLASSES = ['unclassified', 'genuine_debt', 'blocked_by_us', 'in_dispute', 'bad_debt', 'not_owed'] as const
export const DEBT_TYPES = ['deposit', 'final_balance', 'progress_claim', 'variation', 'plan_fee', 'work_order', 'job_invoice', 'no_reference'] as const
export const DEBT_BLOCKERS = ['paid_unallocated', 'payment_claimed', 'rectification', 'pack_missing', 'invoice_wrong', 'no_job_linked', 'job_link_ambiguous', 'context_pending'] as const
export const DEBT_OWNERS = ['DEBT', 'BOOKKEEPING', 'OPERATIONS', 'INSURANCE', 'FENCING_SALES', 'PATIO_SALES', 'MARNIN', 'CIO'] as const
export const DEBT_SOURCES = ['curated', 'rule', 'note', 'card', 'button'] as const
export const PROPOSAL_KINDS = ['sms', 'email', 'statement'] as const
export const PROPOSAL_STATUSES = ['pending', 'approved', 'sent', 'declined', 'expired'] as const
export const NOTE_TAGS = ['promised', 'call back', 'waiting on client', 'park until', 'propose void', 'dispute', 'lesson', 'rectification', 'invoice wrong', 'paid'] as const

const MAX_ROWS = 50

export class DebtPictureError extends Error {
  status: number
  code: string
  constructor(message: string, status = 400, code = 'debt_picture_bad_request') {
    super(message)
    this.status = status
    this.code = code
  }
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T, field: string, nullable = true): T[number] | null {
  if (value === undefined || value === null || value === '') {
    if (nullable) return null
    throw new DebtPictureError(`${field} is required`)
  }
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new DebtPictureError(`${field} must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`)
  }
  return value as T[number]
}

function text(value: unknown, field: string, max = 4000): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new DebtPictureError(`${field} must be a string`)
  const v = value.trim()
  if (v.length > max) throw new DebtPictureError(`${field} longer than ${max} characters`)
  return v || null
}

function isoDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DebtPictureError(`${field} must be YYYY-MM-DD`)
  return value
}

/** Type of debt from the invoice reference code Xero already carries. Pure, so the screen and the refresh agree. */
export function debtTypeFromReference(reference: unknown): typeof DEBT_TYPES[number] {
  const r = String(reference ?? '').toUpperCase().trim()
  if (!r) return 'no_reference'
  if (/MLB-|PO-?\d|SWMS|AJBR|WB\d|^\d{2}-\d{3}-|^PO\d/.test(r)) return 'work_order'
  const seg = r.split(/[-_ /]+/)
  if (seg.includes('DEP') || seg.some((x) => /^DEP\d+$/.test(x))) return 'deposit'
  if (seg.includes('FINBAL') || seg.includes('FINAL') || seg.some((x) => /^FINBAL\d+$/.test(x))) return 'final_balance'
  if (seg.includes('PROG')) return 'progress_claim'
  if (seg.includes('VAR')) return 'variation'
  if (seg.includes('PLAN')) return 'plan_fee'
  return 'job_invoice'
}

interface RowInput {
  xero_invoice_id?: string
  invoice_number?: string
  classification?: string
  type?: string
  blocker?: string
  owner?: string
  reason?: string
  next_action?: string
  next_action_at?: string
  void_proposed?: boolean
  handoff_ref?: string
  handoff_at?: string
  source?: string
  brief?: Record<string, unknown>
  proposal?: { kind?: string; text?: string; to?: string } | null
}

export async function upsertDebtPicture(client: any, body: any, orgId: string) {
  const rows: RowInput[] = Array.isArray(body?.rows) ? body.rows : []
  if (!rows.length) throw new DebtPictureError('rows[] required')
  if (rows.length > MAX_ROWS) throw new DebtPictureError(`at most ${MAX_ROWS} rows per call`)
  const operator = text(body?.operator_email, 'operator_email', 200) || 'secureworks-debt-live'
  const asOf = new Date().toISOString()

  const ids = rows.map((r) => text(r.xero_invoice_id, 'xero_invoice_id', 64)).filter(Boolean) as string[]
  const numbers = rows.map((r) => text(r.invoice_number, 'invoice_number', 64)).filter(Boolean) as string[]
  if (!ids.length && !numbers.length) throw new DebtPictureError('each row needs xero_invoice_id or invoice_number')

  const sel = 'xero_invoice_id, invoice_number, reference, invoice_type, status, amount_due, debt_classification, debt_blocker, debt_owner, debt_proposal_status, job_id'
  const found: any[] = []
  if (ids.length) {
    const { data, error } = await client.from('xero_invoices').select(sel).eq('org_id', orgId).eq('invoice_type', 'ACCREC').in('xero_invoice_id', ids)
    if (error) throw error
    found.push(...(data || []))
  }
  if (numbers.length) {
    const { data, error } = await client.from('xero_invoices').select(sel).eq('org_id', orgId).eq('invoice_type', 'ACCREC').in('invoice_number', numbers)
    if (error) throw error
    found.push(...(data || []))
  }
  const existing = [...new Map(found.map((r: any) => [r.xero_invoice_id, r])).values()]
  const byId = new Map<string, any>()
  const numberCount = new Map<string, number>()
  const byNumber = new Map<string, any>()
  for (const inv of existing) {
    byId.set(inv.xero_invoice_id, inv)
    numberCount.set(inv.invoice_number, (numberCount.get(inv.invoice_number) || 0) + 1)
    byNumber.set(inv.invoice_number, inv)
  }

  const changes: Array<{ invoice: string; from: string; to: string; reason: string }> = []
  const missing: string[] = []
  const ambiguous: string[] = []
  const failed: Array<{ invoice: string; error: string }> = []
  let written = 0
  for (const r of rows) {
    const label = r.xero_invoice_id || r.invoice_number || '?'
    try {
    if (!r.xero_invoice_id && r.invoice_number && (numberCount.get(r.invoice_number) || 0) > 1) { ambiguous.push(r.invoice_number); continue }
    const inv = (r.xero_invoice_id && byId.get(r.xero_invoice_id)) || (r.invoice_number && byNumber.get(r.invoice_number))
    if (!inv) { missing.push(label); continue }
    if (inv.status === 'PAID' || inv.status === 'VOIDED' || inv.status === 'DELETED') { missing.push(`${inv.invoice_number} (${inv.status})`); continue }
    const cls = oneOf(r.classification, DEBT_CLASSES, 'classification', false)!
    const blocker = oneOf(r.blocker, DEBT_BLOCKERS, 'blocker')
    if ((cls === 'blocked_by_us' || cls === 'unclassified') && !blocker) throw new DebtPictureError(`${inv.invoice_number}: ${cls} needs a blocker`)
    if (cls !== 'blocked_by_us' && cls !== 'unclassified' && blocker) throw new DebtPictureError(`${inv.invoice_number}: blocker only belongs to blocked_by_us or unclassified`)
    const owner = oneOf(r.owner, DEBT_OWNERS, 'owner', false)!
    const reason = text(r.reason, 'reason', 1000)
    if (!reason) throw new DebtPictureError(`${inv.invoice_number}: reason (why unpaid) is required`)
    const nextAction = text(r.next_action, 'next_action', 500)
    if (!nextAction) throw new DebtPictureError(`${inv.invoice_number}: next_action is required`)
    const update: Record<string, unknown> = {
      debt_classification: cls,
      debt_type: oneOf(r.type, DEBT_TYPES, 'type') ?? debtTypeFromReference(inv.reference),
      debt_blocker: blocker,
      debt_owner: owner,
      debt_classification_reason: reason,
      debt_next_action: nextAction,
      debt_next_action_at: isoDate(r.next_action_at, 'next_action_at'),
      debt_source: oneOf(r.source, DEBT_SOURCES, 'source') ?? 'rule',
      debt_as_of: asOf,
    }
    if (r.void_proposed !== undefined) update.debt_void_proposed = r.void_proposed === true
    if (r.handoff_ref !== undefined) update.debt_handoff_ref = text(r.handoff_ref, 'handoff_ref', 300)
    if (r.handoff_at !== undefined) update.debt_handoff_at = isoDate(r.handoff_at, 'handoff_at')
    if (r.brief !== undefined) {
      if (r.brief !== null && typeof r.brief !== 'object') throw new DebtPictureError(`${inv.invoice_number}: brief must be an object`)
      update.debt_brief = r.brief
    }
    if (r.proposal !== undefined) {
      if (r.proposal === null) {
        if (inv.debt_proposal_status === 'pending') Object.assign(update, { debt_proposal_status: 'expired' })
      } else {
        const kind = oneOf(r.proposal.kind, PROPOSAL_KINDS, 'proposal.kind', false)
        const ptext = text(r.proposal.text, 'proposal.text', 2000)
        if (!ptext) throw new DebtPictureError(`${inv.invoice_number}: proposal.text is required`)
        if (/—/.test(ptext)) throw new DebtPictureError(`${inv.invoice_number}: proposal text contains an em dash`)
        Object.assign(update, {
          debt_proposal_kind: kind, debt_proposal_text: ptext, debt_proposal_to: text(r.proposal.to, 'proposal.to', 300),
          debt_proposal_at: asOf, debt_proposal_status: 'pending', debt_proposal_approved_by: null, debt_proposal_approved_at: null, debt_proposal_sent_ref: null,
        })
      }
    }
    const from = inv.debt_classification ?? null
    const fromKey = `${from ?? 'unset'}/${inv.debt_blocker ?? ''}/${inv.debt_owner ?? ''}`
    const toKey = `${cls}/${blocker ?? ''}/${owner}`
    if (fromKey !== toKey) Object.assign(update, { debt_classified_by: operator, debt_classified_at: asOf })
    const { error: updErr } = await client.from('xero_invoices').update(update).eq('org_id', orgId).eq('xero_invoice_id', inv.xero_invoice_id)
    if (updErr) throw updErr
    written += 1
    if (fromKey !== toKey) {
      changes.push({ invoice: inv.invoice_number, from: fromKey, to: toKey, reason })
      const { error: logErr } = await client.from('payment_chase_logs').insert({
        xero_invoice_id: inv.xero_invoice_id, job_id: inv.job_id ?? null, method: 'classification', outcome: cls,
        notes: `${from ?? 'unset'}${inv.debt_blocker ? ' (' + inv.debt_blocker + ')' : ''} to ${cls}${blocker ? ' (' + blocker + ')' : ''}, ${owner}: ${reason}`,
        chased_by: operator,
      })
      if (logErr) throw logErr
    }
    } catch (e) {
      if (e instanceof DebtPictureError) throw e
      failed.push({ invoice: label, error: String((e as any)?.message ?? e) })
    }
  }
  return { ok: true, version: DEBT_PICTURE_VERSION, as_of: asOf, read: existing.length, written, changed: changes.length, changes, missing, ambiguous, failed }
}

export async function listDebtPicture(client: any, orgId: string) {
  const sel = 'xero_invoice_id, xero_contact_id, contact_name, invoice_number, reference, status, total, amount_due, amount_paid, invoice_date, due_date, job_id, jobs(job_number), synced_at, debt_classification, debt_type, debt_blocker, debt_owner, debt_classification_reason, debt_next_action, debt_next_action_at, debt_void_proposed, debt_void_decision, debt_handoff_ref, debt_handoff_at, debt_source, debt_as_of, debt_brief, debt_proposal_kind, debt_proposal_text, debt_proposal_to, debt_proposal_status, debt_proposal_at'
  const data: any[] = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data: page, error } = await client.from('xero_invoices').select(sel)
      .eq('org_id', orgId).eq('invoice_type', 'ACCREC').eq('status', 'AUTHORISED').gt('amount_due', 0)
      .order('amount_due', { ascending: false }).order('xero_invoice_id', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (error) throw error
    data.push(...(page || []))
    if (!page || page.length < PAGE) break
  }
  const today = new Date(); today.setUTCHours(0, 0, 0, 0)
  const rows: any[] = data.map((inv: any) => {
    const due = inv.due_date ? new Date(inv.due_date + 'T00:00:00Z') : null
    const days = due ? Math.round((today.getTime() - due.getTime()) / 86400000) : null
    const { jobs, ...rest } = inv
    return { ...rest, job_number: jobs?.job_number ?? null, days_overdue: days, debt_type: inv.debt_type ?? debtTypeFromReference(inv.reference) }
  })
  const totals: Record<string, { count: number; amount_due: number }> = {}
  let amount = 0, overdue = 0, overdueN = 0, noDue = 0
  for (const r of rows) {
    const k = r.debt_classification || 'unclassified'
    totals[k] = totals[k] || { count: 0, amount_due: 0 }
    totals[k].count += 1; totals[k].amount_due = Math.round((totals[k].amount_due + Number(r.amount_due || 0)) * 100) / 100
    amount += Number(r.amount_due || 0)
    if (r.days_overdue === null) noDue += 1
    else if (r.days_overdue > 0) { overdue += Number(r.amount_due || 0); overdueN += 1 }
  }
  const stamps = rows.map((r: any) => String(r.debt_as_of || '')).filter(Boolean).sort()
  return { version: DEBT_PICTURE_VERSION, as_of: new Date().toISOString(), picture_as_of: stamps.length ? stamps[0] : null, newest_as_of: stamps.length ? stamps[stamps.length - 1] : null,
    count: rows.length, amount_due: Math.round(amount * 100) / 100, overdue_count: overdueN, overdue_amount: Math.round(overdue * 100) / 100, no_due_date: noDue, totals, rows }
}

export async function debtNote(client: any, body: any) {
  const xeroInvoiceId = text(body?.xero_invoice_id, 'xero_invoice_id', 64)
  if (!xeroInvoiceId) throw new DebtPictureError('xero_invoice_id required')
  const note = text(body?.note, 'note', 2000)
  if (!note) throw new DebtPictureError('note required')
  const tag = oneOf(body?.tag, NOTE_TAGS, 'tag')
  const operator = text(body?.operator_email, 'operator_email', 200)
  if (!operator) throw new DebtPictureError('operator_email required')
  const { data: inv, error: readErr } = await client.from('xero_invoices').select('xero_invoice_id, job_id, contact_name').eq('xero_invoice_id', xeroInvoiceId).maybeSingle()
  if (readErr) throw readErr
  if (!inv) throw new DebtPictureError('invoice not found', 404, 'debt_picture_not_found')
  const { error: insErr } = await client.from('payment_chase_logs').insert({
    xero_invoice_id: inv.xero_invoice_id, job_id: inv.job_id ?? null, contact_name: inv.contact_name ?? null,
    method: 'note', outcome: tag, notes: note, chased_by: operator,
  })
  if (insErr) throw insErr
  let thread: any[] = []
  let threadError: string | null = null
  try { thread = await debtNotes(client, inv.xero_invoice_id, inv.job_id ?? null) } catch (e) { threadError = String((e as any)?.message ?? e) }
  return { ok: true, thread, thread_error: threadError }
}

/** One thread: the desk's notes on the invoice plus the job's own notes, newest first. */
export async function debtNotes(client: any, xeroInvoiceId: string, jobId: string | null) {
  const out: Array<{ at: string; who: string | null; tag: string | null; text: string; source: string }> = []
  const { data: logs, error: e1 } = await client.from('payment_chase_logs')
    .select('created_at, chased_by, method, outcome, notes').eq('xero_invoice_id', xeroInvoiceId).order('created_at', { ascending: false }).limit(100)
  if (e1) throw e1
  for (const l of logs || []) out.push({ at: l.created_at, who: l.chased_by, tag: l.method === 'note' ? l.outcome : l.method, text: l.notes || l.outcome || '', source: 'debt' })
  if (jobId) {
    const { data: ev, error: e2 } = await client.from('job_events')
      .select('created_at, user_id, detail_json, event_type').eq('job_id', jobId).eq('event_type', 'note').order('created_at', { ascending: false }).limit(50)
    if (e2) throw e2
    for (const e of ev || []) {
      const p = e.detail_json || {}
      out.push({ at: e.created_at, who: e.user_id || p.author || null, tag: p.tag || 'job note', text: String(p.text || p.note || p.body || ''), source: 'job' })
    }
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return out
}

/** Legacy mark path can decline only; a caller-supplied email is not Marnin approval. */
export async function debtProposalMark(client: any, body: any) {
  const xeroInvoiceId = text(body?.xero_invoice_id, 'xero_invoice_id', 64)
  if (!xeroInvoiceId) throw new DebtPictureError('xero_invoice_id required')
  const status = oneOf(body?.status, ['declined'] as const, 'status', false)!
  const operator = text(body?.operator_email, 'operator_email', 200)
  if (!operator) throw new DebtPictureError('operator_email required')
  const sentRef = text(body?.sent_ref, 'sent_ref', 300)
  const finalText = text(body?.text, 'text', 2000)
  const { data: inv, error: readErr } = await client.from('xero_invoices').select('xero_invoice_id, job_id, debt_proposal_status, debt_proposal_kind').eq('xero_invoice_id', xeroInvoiceId).maybeSingle()
  if (readErr) throw readErr
  if (!inv) throw new DebtPictureError('invoice not found', 404, 'debt_picture_not_found')
  const now = new Date().toISOString()
  const update: Record<string, unknown> = { debt_proposal_status: status }
  if (finalText) update.debt_proposal_text = finalText
  const { error: updErr } = await client.from('xero_invoices').update(update).eq('xero_invoice_id', inv.xero_invoice_id)
  if (updErr) throw updErr
  const { error: logErr } = await client.from('payment_chase_logs').insert({
    xero_invoice_id: inv.xero_invoice_id, job_id: inv.job_id ?? null, method: 'proposal', outcome: status,
    notes: `${inv.debt_proposal_kind ?? 'proposal'} ${status}${sentRef ? ' (' + sentRef + ')' : ''} by ${operator}`, chased_by: operator,
  })
  if (logErr) throw logErr
  return { ok: true, status, at: now }
}

/** Save a reviewable proposal only. This door has no approval or provider capability. */
export async function debtProposalSave(client: any, body: any, orgId: string, actor: string) {
  if (!orgId || !actor) throw new DebtPictureError('Authenticated operator and organisation required', 403)
  const allowed = new Set(['xero_invoice_id', 'kind', 'text', 'to', 'subject', 'operator_email'])
  if (Object.keys(body || {}).some((key) => !allowed.has(key))) throw new DebtPictureError('Only pending proposal fields are accepted')
  const xid = text(body?.xero_invoice_id, 'xero_invoice_id', 64)
  const kind = oneOf(body?.kind, ['sms', 'email'] as const, 'kind', false)
  const to = text(body?.to, 'to', 300)
  const subject = text(body?.subject, 'subject', 300)
  const draft = text(body?.text, 'text', 2000)
  if (!xid || !to || !draft) throw new DebtPictureError('Invoice, proposed recipient and complete text required')
  if (subject && kind !== 'email') throw new DebtPictureError('Subject is only valid for email')
  const fullText = text(subject ? `Subject: ${subject}\n\n${draft}` : draft, 'text', 2000)!
  if (/—/.test(fullText)) throw new DebtPictureError('Proposal text contains an em dash')
  const fields = 'xero_invoice_id, job_id, invoice_type, status, amount_due, debt_proposal_kind, debt_proposal_text, debt_proposal_to, debt_proposal_status, debt_proposal_at'
  const { data: inv, error } = await client.from('xero_invoices').select(fields).eq('org_id', orgId).eq('xero_invoice_id', xid).maybeSingle()
  if (error) throw error
  if (!inv) throw new DebtPictureError('Invoice not found', 404)
  if (inv.invoice_type !== 'ACCREC' || inv.status !== 'AUTHORISED' || Number(inv.amount_due) <= 0) throw new DebtPictureError('Proposal requires an open receivable', 409)
  if (inv.debt_proposal_status === 'pending' && inv.debt_proposal_kind === kind && inv.debt_proposal_text === fullText && inv.debt_proposal_to === to) {
    return { ok: true, status: 'pending', changed: false, at: inv.debt_proposal_at }
  }
  const at = new Date().toISOString()
  const update = { debt_proposal_kind: kind, debt_proposal_text: fullText, debt_proposal_to: to, debt_proposal_status: 'pending', debt_proposal_at: at,
    debt_proposal_approved_by: null, debt_proposal_approved_at: null, debt_proposal_sent_ref: null }
  let query = client.from('xero_invoices').update(update).eq('org_id', orgId).eq('xero_invoice_id', xid)
    .eq('invoice_type', 'ACCREC').eq('status', 'AUTHORISED').gt('amount_due', 0)
  query = inv.debt_proposal_at ? query.eq('debt_proposal_at', inv.debt_proposal_at) : query.is('debt_proposal_at', null)
  const { data: saved, error: saveError } = await query.select('xero_invoice_id').maybeSingle()
  if (saveError) throw saveError
  if (!saved) throw new DebtPictureError('Invoice or proposal changed. Refresh before saving again.', 409)
  const { error: logError } = await client.from('payment_chase_logs').insert({ xero_invoice_id: xid, job_id: inv.job_id ?? null, method: 'proposal', outcome: 'pending', notes: `${kind} proposal saved for individual Marnin approval. Nothing sent.`, chased_by: actor })
  return { ok: true, status: 'pending', changed: true, at, audit_warning: logError ? 'Proposal saved; audit log unavailable' : null }
}
