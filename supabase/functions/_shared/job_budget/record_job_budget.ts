// Ruling 17 step 1: store the job budget at acceptance, beside
// freezeExpectedCostsOnAcceptance (which is unchanged, contract B12).
//
// Source (B1): only the accepted revision the acceptance chain names
// (readAcceptedQuoteCostSource 'bound'), its pricing re-hashed against
// pricing_hash, top-level key `budget`. Never jobs.pricing_json. A bound source
// is the whole job accepted with no accepted variation (B11); anything else
// stores nothing. No `budget` key (every revision sealed before step 1) also
// stores nothing: today's path runs.
//
// A budget that does not add up (B2): the acceptance stands, nothing is stored,
// and one `job_budget_refused` job event records the code. Job events are read
// by trades, so the event carries the code, the place it failed and the
// revision id only, never money. v_job_budget then shows
// "budget refused: <code>".
//
// The options the customer took are added by the contract's one formula
// (budgetWithOptions), and the result must equal the acceptance record's
// accepted totals to the cent.

import { jsonHash } from '../release_packet/canonicalize.ts'
import { readAcceptedQuoteCostSource } from '../expected_costs/accepted_quote_cost_source.ts'
import { fetchNamedAcceptedRevision } from '../expected_costs/expected_costs_freeze.ts'
import { readTakenQuoteOptions } from '../quote_options/taken_options.ts'
import { budgetWithOptions, checkBudget, dollars, moneyCents, type BudgetLine, type BudgetSummary } from './budget_v1.ts'

export type RecordJobBudgetResult =
  | { outcome: 'recorded' | 'replayed'; budget_id: string; version: number; taken_option_ids: string[] }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'refused'; code: string; at?: string; event_written: boolean }

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const FUNCTION_MISSING = new Set(['42883', 'PGRST202'])

/** The writer's summary, in dollars, keyed as record_job_budget reads it. */
export function summaryForStore(s: BudgetSummary): Record<string, unknown> {
  const pct = (h: number | null) => (h === null ? null : h / 100)
  return {
    trade: s.trade,
    complete: s.complete,
    gap_count: s.gap_count,
    sell_ex_gst: dollars(s.sell_cents),
    gst: dollars(s.gst_cents),
    total_inc_gst: dollars(s.total_inc_cents),
    materials_ex_gst: dollars(s.materials_cents),
    labour_ex_gst: dollars(s.labour_cents),
    work_order_ex_gst: dollars(s.work_order_cents),
    other_ex_gst: dollars(s.other_cents),
    cost_before_commission_ex_gst: dollars(s.cost_cents),
    gross_profit_ex_gst: dollars(s.gross_profit_cents),
    gross_profit_pct: pct(s.gross_profit_pct_h),
    commission_rule_id: s.commission_rule_id,
    commission_pct: pct(s.commission_pct_h),
    commission_ex_gst: dollars(s.commission_cents),
    profit_after_commission_ex_gst: dollars(s.profit_after_cents),
    profit_after_commission_pct: pct(s.profit_after_pct_h),
    scoped_by_staff_id: s.scoped_by_staff_id,
    salesperson_staff_id: s.salesperson_staff_id,
  }
}

/** The writer's lines, in dollars. */
export function linesForStore(lines: BudgetLine[]): Record<string, unknown>[] {
  return lines.map((l) => ({
    lane: l.lane,
    key: l.key,
    line_id: l.line_id,
    supplier_key: l.supplier_key,
    supplier_id: l.supplier_id,
    supplier_name: l.supplier_name,
    description: l.description,
    quantity: l.quantity,
    unit: l.unit,
    unit_cost_ex_gst: dollars(l.unit_cost_cents),
    cost_ex_gst: dollars(l.cost_cents),
    in_total: l.in_total,
    paid_to: l.paid_to,
    cost_from: l.cost_from,
    option_id: l.option_id,
  }))
}

// deno-lint-ignore no-explicit-any
async function refuse(client: any, jobId: string, revisionId: string, code: string, at?: string): Promise<RecordJobBudgetResult> {
  let event_written = false
  try {
    const { error } = await client.from('job_events').insert({
      job_id: jobId,
      event_type: 'job_budget_refused',
      detail_json: { code, ...(at ? { at } : {}), scope_revision_id: revisionId },
    })
    event_written = !error
  } catch {
    event_written = false
  }
  if (!event_written) console.error('[job_budget] refusal event not written', { job_id: jobId, code })
  return { outcome: 'refused', code, ...(at ? { at } : {}), event_written }
}

// deno-lint-ignore no-explicit-any
async function readAcceptedTotals(client: any, jobId: string, documentId: string): Promise<{ ex: number; gst: number; inc: number } | null> {
  try {
    const { data, error } = await client.from('quote_option_acceptances')
      .select('accepted_total_ex_gst, accepted_gst, accepted_total_inc_gst')
      .eq('job_id', jobId).eq('job_document_id', documentId)
    if (error || !Array.isArray(data) || data.length !== 1) return null
    const ex = moneyCents(data[0]?.accepted_total_ex_gst, 'accepted_total_ex_gst')
    const gst = moneyCents(data[0]?.accepted_gst, 'accepted_gst')
    const inc = moneyCents(data[0]?.accepted_total_inc_gst, 'accepted_total_inc_gst')
    if (ex === null || gst === null || inc === null) return null
    return { ex, gst, inc }
  } catch {
    return null
  }
}

/**
 * Store the job's budget for its accepted revision. Never throws, never
 * blocks the acceptance; the caller logs the result.
 */
// deno-lint-ignore no-explicit-any
export async function recordJobBudgetOnAcceptance(client: any, jobId: string): Promise<RecordJobBudgetResult> {
  try {
    const source = await readAcceptedQuoteCostSource(client, jobId)
    if (source.kind !== 'bound') {
      return { outcome: 'skipped', reason: source.kind === 'unknown' ? `source_unknown:${source.reason}` : 'source_legacy' }
    }
    const job = await client.from('jobs').select('accepted_at').eq('id', jobId).maybeSingle()
    if (job?.error || !job?.data) return { outcome: 'skipped', reason: 'job_unreadable' }
    if (!job.data.accepted_at) return { outcome: 'skipped', reason: 'job_not_accepted' }
    const rev = await fetchNamedAcceptedRevision(client, jobId, source.revision_id, job.data.accepted_at)
    if (!rev.ok) return { outcome: 'skipped', reason: 'revision_unreadable' }
    if (!rev.row) return { outcome: 'skipped', reason: 'revision_unavailable' }
    const revisionId = rev.row.id

    let pricing: unknown
    try {
      pricing = JSON.parse(rev.row.pricing_canonical_text)
    } catch {
      return { outcome: 'skipped', reason: 'pricing_unreadable' }
    }
    if (!isRec(pricing)) return { outcome: 'skipped', reason: 'pricing_unreadable' }
    if (!('budget' in pricing)) return { outcome: 'skipped', reason: 'no_budget' }
    if (await jsonHash(pricing) !== rev.row.pricing_hash) {
      return await refuse(client, jobId, revisionId, 'pricing_hash_mismatch')
    }
    const base = pricing.budget
    const baseJob = isRec(base) && isRec(base.job) ? base.job : null
    if (baseJob && baseJob.scope_revision_id != null && baseJob.scope_revision_id !== revisionId) {
      return await refuse(client, jobId, revisionId, 'budget_revision_mismatch')
    }
    const baseCheck = checkBudget(base)
    if (!baseCheck.ok) return await refuse(client, jobId, revisionId, baseCheck.refusal.code, baseCheck.refusal.at)

    const taken = await readTakenQuoteOptions(client, jobId)
    if (taken.state === 'unreadable') return await refuse(client, jobId, revisionId, 'quote_options_unreadable')
    const takenIds = taken.state === 'taken' ? taken.options.map((o) => o.id) : []
    const applied = budgetWithOptions(base, takenIds)
    if (!applied.ok) return await refuse(client, jobId, revisionId, applied.refusal.code, applied.refusal.at)
    const checked = checkBudget(applied.budget)
    if (!checked.ok) return await refuse(client, jobId, revisionId, checked.refusal.code, checked.refusal.at)

    // The formula's sell must equal what the customer accepted, to the cent.
    if (taken.state === 'taken') {
      const accepted = await readAcceptedTotals(client, jobId, taken.job_document_id)
      if (!accepted) return await refuse(client, jobId, revisionId, 'quote_options_unreadable')
      const s = checked.budget.summary
      if (s.sell_cents !== accepted.ex || s.gst_cents !== accepted.gst || s.total_inc_cents !== accepted.inc) {
        return await refuse(client, jobId, revisionId, 'option_sell_mismatch')
      }
    }

    const { data, error } = await client.rpc('record_job_budget', {
      p_job_id: jobId,
      p_scope_revision_id: revisionId,
      p_pricing_hash: rev.row.pricing_hash,
      p_taken_option_ids: takenIds,
      p_budget: applied.budget,
      p_summary: summaryForStore(checked.budget.summary),
      p_lines: linesForStore(checked.budget.lines),
    })
    if (error) {
      // Before the migration is applied there is nowhere to store it: say so, write no event.
      if (FUNCTION_MISSING.has(String(error?.code ?? ''))) return { outcome: 'skipped', reason: 'store_missing' }
      const msg = String(error?.message ?? '')
      const code = msg.includes('job_budget_conflict')
        ? 'budget_conflict'
        : msg.includes('job_budget_money_not_two_decimals')
        ? 'money_not_two_decimals'
        : msg.includes('job_budget_revision_mismatch')
        ? 'budget_revision_mismatch'
        : 'budget_write_failed'
      return await refuse(client, jobId, revisionId, code)
    }
    if (!isRec(data) || typeof data.budget_id !== 'string') {
      return await refuse(client, jobId, revisionId, 'budget_write_failed')
    }
    return {
      outcome: data.replayed === true ? 'replayed' : 'recorded',
      budget_id: data.budget_id,
      version: Number(data.version),
      taken_option_ids: takenIds,
    }
  } catch {
    return { outcome: 'skipped', reason: 'unexpected_error' }
  }
}
