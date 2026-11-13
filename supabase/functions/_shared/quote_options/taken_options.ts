// Ruling 14 step 1: which quote options a job's customer took, for the readers
// downstream of acceptance (the scope draft release and the job work order fill).
//
// Step 1 records taken options (send-quote quote_options_store.ts, table
// quote_option_acceptances) and prices the job and its deposit on them. The
// sealed work order, payer invoice and payment stage drafts were made at the
// base price, without the options, so they must not issue on their own while a
// taken option is missing from them: these readers hold them for the office.
//
// Unknown is never "none": a failed read answers 'unreadable' and the callers
// hold. The one exception is the table not existing yet (the migration
// 20261113150000 not applied): then no option can have been recorded, because
// the record write fails first and send-quote holds the option money itself.

export type TakenQuoteOption = { id: string; name: string; goes: string | null }

export type TakenQuoteOptions =
  | { state: 'none' }
  | { state: 'taken'; options: TakenQuoteOption[] }
  | { state: 'unreadable' }

const TABLE_MISSING = new Set(['42P01', 'PGRST205'])

// deno-lint-ignore no-explicit-any
export async function readTakenQuoteOptions(client: any, jobId: string): Promise<TakenQuoteOptions> {
  try {
    const { data, error } = await client.from('quote_option_acceptances')
      .select('offered, taken_option_ids')
      .eq('job_id', jobId)
    if (error) {
      return TABLE_MISSING.has(String(error?.code ?? '')) ? { state: 'none' } : { state: 'unreadable' }
    }
    if (!Array.isArray(data)) return { state: 'unreadable' }
    const options: TakenQuoteOption[] = []
    for (const row of data) {
      const taken = Array.isArray(row?.taken_option_ids) ? row.taken_option_ids.map(String) : []
      const offered = Array.isArray(row?.offered) ? row.offered : []
      for (const id of taken) {
        const o = offered.find((x: { id?: unknown }) => String(x?.id) === id) ?? {}
        options.push({
          id,
          name: typeof o.name === 'string' ? o.name : id,
          goes: typeof o.goes === 'string' ? o.goes : null,
        })
      }
    }
    return options.length > 0 ? { state: 'taken', options } : { state: 'none' }
  } catch {
    return { state: 'unreadable' }
  }
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
    taken: boolean
    label: 'taken' | 'offered, not taken'
  }>
}

/** The job's option records, oldest first; null when the read failed (never
 * "no options"). A table not yet created reads as none. */
// deno-lint-ignore no-explicit-any
export async function readJobQuoteOptionRecords(client: any, jobId: string): Promise<JobQuoteOptionRecord[] | null> {
  try {
    const { data, error } = await client.from('quote_option_acceptances')
      .select('job_document_id, accepted_via, accepted_by, offered, taken_option_ids, base_total_inc_gst, accepted_total_inc_gst, accepted_deposit_inc_gst, created_at')
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
            taken: isTaken,
            label: isTaken ? 'taken' as const : 'offered, not taken' as const,
          }
        }),
      }
    })
  } catch {
    return null
  }
}
