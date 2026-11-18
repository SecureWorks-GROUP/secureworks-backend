// P3-01.10: once a day, each recorded draft (xero_draft_register) that our
// copy of Xero now shows approved is marked changed or not changed, and the
// month's count is stored in bookkeeping_checks.
//
// One snapshot only (director ruling, 18 Nov 07:35): the status and the lines
// compared are both read from the same stored Xero record, raw_json. The
// separate status and line_items columns are never read here, because some
// writers move one without the other (an approve writes status alone; the
// trade bill sweep kept old line_items until PR 1587). A record that does not
// carry its own line list is incomplete and its row stays pending.
//
// Never calls Xero. Never marks a draft "not changed" before Xero shows it
// approved. A failed read leaves rows pending and stores no count.

import { linesFingerprint } from '../_shared/xero_draft_standard.ts'

export const DRAFT_CHECK_BATCH = 500
export const DRAFT_CHECK_CHUNK = 50
export const DRAFTS_CHANGED_CHECK = 'drafts_changed_before_approval'

const APPROVED = new Set(['AUTHORISED', 'PAID'])
const PERTH_OFFSET_MS = 8 * 60 * 60 * 1000 // Perth has no daylight saving.

// deno-lint-ignore no-explicit-any
type SupabaseLike = { from: (table: string) => any }

type RegisterRow = {
  id: string
  xero_document_id: string
  document_type: string
  lines_fingerprint: string
}

type Snapshot = { status: unknown; lines: unknown }

export type DraftCheckResult = {
  ok: boolean
  error?: string
  pending_read: number
  approved_now: number
  changed_now: number
  left_pending: number
  month: { period_key: string; approved: number; changed: number } | null
  errors: string[]
}

// The Perth calendar month holding nowIso, and its bounds in UTC.
export function perthMonth(nowIso: string): { key: string; startIso: string; endIso: string } {
  const perth = new Date(Date.parse(nowIso) + PERTH_OFFSET_MS)
  const y = perth.getUTCFullYear()
  const m = perth.getUTCMonth()
  return {
    key: `${y}-${String(m + 1).padStart(2, '0')}`,
    startIso: new Date(Date.UTC(y, m, 1) - PERTH_OFFSET_MS).toISOString(),
    endIso: new Date(Date.UTC(y, m + 1, 1) - PERTH_OFFSET_MS).toISOString(),
  }
}

// The fingerprint lines of one stored Xero record, or null when the record
// does not carry an approved status and its own line list. A record with no
// lines at all is treated as incomplete: Xero does not approve an empty
// document, so an empty list is a summary read, never proof.
// deno-lint-ignore no-explicit-any
export function approvedSnapshotLines(snap: Snapshot | null | undefined): any[] | null {
  if (!snap) return null
  if (!APPROVED.has(String(snap.status ?? ''))) return null
  if (!Array.isArray(snap.lines) || snap.lines.length === 0) return null
  // deno-lint-ignore no-explicit-any
  return snap.lines.map((li: any) => ({
    accountCode: li?.AccountCode ?? null,
    trackingOption: li?.Tracking?.[0]?.Option ?? null,
    quantity: li?.Quantity ?? null,
    unitAmount: li?.UnitAmount ?? null,
  }))
}

function errCode(error: unknown): string {
  // deno-lint-ignore no-explicit-any
  const e = error as any
  return String(e?.code || e?.name || 'unknown')
}

async function readSnapshots(
  sb: SupabaseLike,
  orgId: string,
  table: 'xero_invoices' | 'xero_supplier_credit_notes',
  idColumn: 'xero_invoice_id' | 'xero_credit_note_id',
  ids: string[],
  errors: string[],
): Promise<Map<string, Snapshot>> {
  const out = new Map<string, Snapshot>()
  for (let i = 0; i < ids.length; i += DRAFT_CHECK_CHUNK) {
    const chunk = ids.slice(i, i + DRAFT_CHECK_CHUNK)
    // Status and lines are projected from the SAME raw_json value: one snapshot.
    const { data, error } = await sb.from(table)
      .select(`${idColumn}, snap_status:raw_json->Status, snap_lines:raw_json->LineItems`)
      .eq('org_id', orgId)
      .in(idColumn, chunk)
    if (error) {
      // These rows stay pending; nothing is marked from a read that failed.
      console.error('[draft_approval_check] snapshot read failed', table, errCode(error))
      errors.push(`${table}_read_failed`)
      continue
    }
    // deno-lint-ignore no-explicit-any
    for (const r of (data || []) as any[]) {
      out.set(String(r[idColumn]), { status: r.snap_status, lines: r.snap_lines })
    }
  }
  return out
}

async function countApproved(
  sb: SupabaseLike,
  orgId: string,
  month: { startIso: string; endIso: string },
  changedOnly: boolean,
): Promise<number | null> {
  let q = sb.from('xero_draft_register')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .gte('approved_seen_at', month.startIso)
    .lt('approved_seen_at', month.endIso)
  if (changedOnly) q = q.eq('edited_before_approval', true)
  const { count, error } = await q
  if (error || typeof count !== 'number') {
    console.error('[draft_approval_check] month count read failed', errCode(error))
    return null
  }
  return count
}

export async function checkDraftsApproved(sb: SupabaseLike, orgId: string, nowIso: string): Promise<DraftCheckResult> {
  const result: DraftCheckResult = {
    ok: true, pending_read: 0, approved_now: 0, changed_now: 0, left_pending: 0, month: null, errors: [],
  }

  const { data: pending, error: regErr } = await sb.from('xero_draft_register')
    .select('id, xero_document_id, document_type, lines_fingerprint')
    .eq('org_id', orgId)
    .is('approved_seen_at', null)
    .order('drafted_at', { ascending: true })
    .limit(DRAFT_CHECK_BATCH)
  if (regErr || !Array.isArray(pending)) {
    console.error('[draft_approval_check] register read failed', errCode(regErr))
    return { ...result, ok: false, error: 'register_read_failed' }
  }
  const rows = pending as RegisterRow[]
  result.pending_read = rows.length

  const invoiceIds = [...new Set(rows.filter((r) => r.document_type !== 'ACCPAYCREDIT').map((r) => r.xero_document_id))]
  const creditIds = [...new Set(rows.filter((r) => r.document_type === 'ACCPAYCREDIT').map((r) => r.xero_document_id))]
  const invoices = await readSnapshots(sb, orgId, 'xero_invoices', 'xero_invoice_id', invoiceIds, result.errors)
  const credits = await readSnapshots(sb, orgId, 'xero_supplier_credit_notes', 'xero_credit_note_id', creditIds, result.errors)

  for (const row of rows) {
    const snap = row.document_type === 'ACCPAYCREDIT' ? credits.get(row.xero_document_id) : invoices.get(row.xero_document_id)
    const lines = approvedSnapshotLines(snap)
    if (!lines) {
      result.left_pending++
      continue
    }
    const fingerprint = await linesFingerprint(lines)
    const edited = fingerprint !== row.lines_fingerprint
    // Compare and set: a row another run already marked is never re-marked.
    const { data: marked, error: updErr } = await sb.from('xero_draft_register')
      .update({ approved_seen_at: nowIso, approved_fingerprint: fingerprint, edited_before_approval: edited })
      .eq('id', row.id)
      .eq('org_id', orgId)
      .is('approved_seen_at', null)
      .select('id')
    if (updErr) {
      console.error('[draft_approval_check] register update failed', row.id, errCode(updErr))
      result.errors.push('register_update_failed')
      result.left_pending++
      continue
    }
    if (!Array.isArray(marked) || marked.length === 0) continue // already marked by another run
    result.approved_now++
    if (edited) result.changed_now++
  }

  const month = perthMonth(nowIso)
  const approved = await countApproved(sb, orgId, month, false)
  const changed = approved === null ? null : await countApproved(sb, orgId, month, true)
  if (approved === null || changed === null) {
    // A failed count is never stored as zero.
    result.errors.push('month_count_read_failed')
    return result
  }
  const { error: upErr } = await sb.from('bookkeeping_checks').upsert({
    check_name: DRAFTS_CHANGED_CHECK,
    period_key: month.key,
    value: changed,
    detail: { approved, changed },
    checked_at: nowIso,
  }, { onConflict: 'check_name,period_key' })
  if (upErr) {
    console.error('[draft_approval_check] month count not stored', errCode(upErr))
    result.errors.push('month_count_write_failed')
    return result
  }
  result.month = { period_key: month.key, approved, changed }
  return result
}
