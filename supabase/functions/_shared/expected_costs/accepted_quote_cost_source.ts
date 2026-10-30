// D1 / JP-24: acceptance must use the revision actually released to the
// accepting parties, never a newer draft frozen while a send was in flight.
// This reads provenance only. It neither accepts a quote nor changes prices.
// Existing unbound quotes retain CP1's legacy resolver; a declared but broken
// chain is Unknown, never permission to use today's working draft.

export type AcceptedQuoteCostSource =
  | { kind: 'bound'; revision_id: string }
  | { kind: 'legacy' }
  | { kind: 'unknown'; reason: string }

type Row = Record<string, any>
const unknown = (reason: string): AcceptedQuoteCostSource => ({ kind: 'unknown', reason })
// Exact counts keep a server row limit from making a partial chain look whole.
const complete = (r: { data?: unknown; error?: unknown; count?: unknown }): boolean =>
  !r.error && Array.isArray(r.data) && Number.isInteger(r.count) && r.count === r.data.length

export async function readAcceptedQuoteCostSource(client: any, jobId: string): Promise<AcceptedQuoteCostSource> {
  try {
    const [docs, runs, variations] = await Promise.all([
      client.from('job_documents').select('id', { count: 'exact' })
        .eq('job_id', jobId).eq('type', 'quote').not('accepted_at', 'is', null),
      client.from('run_acceptances').select('status, job_document_id', { count: 'exact' }).eq('job_id', jobId),
      client.from('job_variations').select('accepted_at, status', { count: 'exact' }).eq('job_id', jobId),
    ])
    if (![docs, runs, variations].every(complete)) return unknown('acceptance_chain_unreadable')
    const accepted = new Set<string>((docs.data as Row[]).map(d => d.id))
    for (const run of runs.data as Row[]) {
      if (run.status === 'accepted') {
        if (!run.job_document_id) return unknown('run_acceptance_without_document')
        accepted.add(run.job_document_id)
      }
    }
    if (!accepted.size) return unknown('no_accepted_document')
    const releases = await client.from('quote_revisions')
      .select('job_document_id, scope_revision_id', { count: 'exact' })
      .eq('job_id', jobId).in('job_document_id', [...accepted]).not('sent_at', 'is', null)
    if (!complete(releases)) return unknown('acceptance_chain_unreadable')
    const rows = releases.data as Row[]
    // No named provenance anywhere: preserve the existing legacy CP1 path.
    // This is NOT proof that the latest revision was accepted; JP-23 still
    // refuses that assertion. Mixed bound/unbound parties are not legacy.
    if (!rows.some(r => r.scope_revision_id != null)) return { kind: 'legacy' }
    for (const id of accepted) {
      if (!rows.some(r => r.job_document_id === id)) return unknown('accepted_document_not_released')
    }
    if (rows.some(r => typeof r.scope_revision_id !== 'string' || !r.scope_revision_id)) {
      return unknown('release_names_no_revision')
    }
    const revisions = new Set<string>(rows.map(r => r.scope_revision_id))
    if (revisions.size !== 1) return unknown('releases_name_different_revisions')
    // Keep JP-23's conservative variation/party rules. Do not invent blended
    // costs or make this correction decide unresolved variation policy.
    if ((variations.data as Row[]).some(v => v.accepted_at || ['accepted', 'invoiced'].includes(v.status))) {
      return unknown('variation_accepted_semantics_open')
    }
    if ((runs.data as Row[]).some(r => r.status !== 'accepted')) return unknown('party_not_accepted')
    return { kind: 'bound', revision_id: [...revisions][0] }
  } catch {
    return unknown('acceptance_chain_unreadable')
  }
}
