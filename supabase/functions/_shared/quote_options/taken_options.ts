// Ruling 14 step 1: which quote options a job's customer took, for the readers
// downstream of acceptance. A taken option goes where it was set to go, exactly
// as the same extra would in the price (contract 4.4):
//   - supplier: its sealed order_line joins the supplier order lines
//     (Dispatch fills, dispatch_v2_store.ts and dispatch_materials_store.ts);
//   - crew: its sealed labour_line joins the job work order and its total the
//     agreed labour (the scope drafts, apply_quote_options_to_scope_drafts, and
//     the quote fill, job_work_order_quote_fill.ts);
//   - office: its sealed office_line is on the job's office list (job_detail).
// A NOT-taken option is on none of them. The entries come from the record's
// taken_options, written with the acceptance in one transaction
// (20261113150000), never from the live job.
//
// Unknown is never "none": a failed read answers 'unreadable' and the callers
// hold. The one exception is the table not existing yet (the migration
// 20261113150000 not applied): then no option can have been taken, because
// accepting an offer with options needs that migration's function.

export type TakenQuoteOption = {
  id: string
  name: string
  goes: string | null
  /** The option exactly as sealed (order_line, labour_line or office_line, cost). */
  sealed: Record<string, unknown>
}

export type TakenQuoteOptions =
  | { state: 'none' }
  | { state: 'taken'; options: TakenQuoteOption[] }
  | { state: 'unreadable' }

const TABLE_MISSING = new Set(['42P01', 'PGRST205'])

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// deno-lint-ignore no-explicit-any
export async function readTakenQuoteOptions(client: any, jobId: string): Promise<TakenQuoteOptions> {
  try {
    const { data, error } = await client.from('quote_option_acceptances')
      .select('taken_option_ids, taken_options')
      .eq('job_id', jobId)
    if (error) {
      return TABLE_MISSING.has(String(error?.code ?? '')) ? { state: 'none' } : { state: 'unreadable' }
    }
    if (!Array.isArray(data)) return { state: 'unreadable' }
    const options: TakenQuoteOption[] = []
    for (const row of data) {
      const ids = Array.isArray(row?.taken_option_ids) ? row.taken_option_ids.map(String) : []
      const sealed = Array.isArray(row?.taken_options) ? row.taken_options : []
      // The database keeps one sealed entry per taken id; anything else is unreadable.
      if (sealed.length !== ids.length) return { state: 'unreadable' }
      for (const id of ids) {
        const o = sealed.find((x: unknown) => isRec(x) && String(x.id) === id)
        if (!isRec(o)) return { state: 'unreadable' }
        options.push({
          id,
          name: typeof o.name === 'string' ? o.name : id,
          goes: typeof o.goes === 'string' ? o.goes : null,
          sealed: o,
        })
      }
    }
    return options.length > 0 ? { state: 'taken', options } : { state: 'none' }
  } catch {
    return { state: 'unreadable' }
  }
}

/** The sealed destination lines of the taken options that go one way. */
export function takenLines(options: TakenQuoteOption[], goes: 'supplier' | 'crew' | 'office'): Array<{ id: string; name: string; line: Record<string, unknown> }> {
  const key = goes === 'supplier' ? 'order_line' : goes === 'crew' ? 'labour_line' : 'office_line'
  return options
    .filter((o) => o.goes === goes && isRec(o.sealed[key]))
    .map((o) => ({ id: o.id, name: o.name, line: o.sealed[key] as Record<string, unknown> }))
}

/** One accepted document's options for the job's record: each offered option
 * with its fate, taken or "offered, not taken" (drawn struck through). */
export type JobQuoteOptionRecord = {
  job_document_id: string
  accepted_via: string
  accepted_by: string | null
  accepted_at: string | null
  base_total_inc_gst: number
  accepted_total_inc_gst: number
  accepted_deposit_inc_gst: number
  options: Array<{
    id: string
    name: string
    line: string
    sell_inc_gst: number | null
    goes: string | null
    taken: boolean
    label: 'taken' | 'offered, not taken'
  }>
  /** The office's list for the job: each taken office option's sealed office_line. */
  office_list: Array<{
    option_id: string
    name: string
    description: string
    quantity: number | null
    unit: string | null
    cost_ex_gst: number | null
  }>
}

/** The job's option records, oldest first; null when the read failed (never
 * "no options"). A table not yet created reads as none. */
// deno-lint-ignore no-explicit-any
export async function readJobQuoteOptionRecords(client: any, jobId: string): Promise<JobQuoteOptionRecord[] | null> {
  try {
    const { data, error } = await client.from('quote_option_acceptances')
      .select('job_document_id, accepted_via, accepted_by, offered, taken_option_ids, taken_options, base_total_inc_gst, accepted_total_inc_gst, accepted_deposit_inc_gst, created_at')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true })
    if (error) return TABLE_MISSING.has(String(error?.code ?? '')) ? [] : null
    if (!Array.isArray(data)) return null
    const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null)
    return data.map((row) => {
      const taken = new Set(Array.isArray(row?.taken_option_ids) ? row.taken_option_ids.map(String) : [])
      const offered = Array.isArray(row?.offered) ? row.offered : []
      return {
        job_document_id: String(row.job_document_id),
        accepted_via: String(row.accepted_via ?? ''),
        accepted_by: row.accepted_by ?? null,
        accepted_at: row.created_at ?? null,
        base_total_inc_gst: num(row.base_total_inc_gst) ?? 0,
        accepted_total_inc_gst: num(row.accepted_total_inc_gst) ?? 0,
        accepted_deposit_inc_gst: num(row.accepted_deposit_inc_gst) ?? 0,
        options: offered.map((o: Record<string, unknown>) => {
          const id = String(o?.id ?? '')
          const isTaken = taken.has(id)
          return {
            id,
            name: typeof o?.name === 'string' ? o.name : id,
            line: typeof o?.line === 'string' ? o.line : '',
            sell_inc_gst: num(o?.sell_inc_gst),
            goes: typeof o?.goes === 'string' ? o.goes : null,
            taken: isTaken,
            label: isTaken ? 'taken' as const : 'offered, not taken' as const,
          }
        }),
        office_list: (Array.isArray(row?.taken_options) ? row.taken_options : [])
          .filter((o: unknown) => isRec(o) && o.goes === 'office' && isRec(o.office_line))
          .map((o: Record<string, unknown>) => {
            const l = o.office_line as Record<string, unknown>
            const name = typeof o.name === 'string' ? o.name : String(o.id ?? '')
            return {
              option_id: String(o.id ?? ''),
              name,
              description: typeof l.description === 'string' && l.description.trim() ? l.description : name,
              quantity: num(l.quantity),
              unit: typeof l.unit === 'string' ? l.unit : null,
              cost_ex_gst: l.cost_ex_gst === null || l.cost_ex_gst === undefined ? null : num(l.cost_ex_gst),
            }
          }),
      }
    })
  } catch {
    return null
  }
}
