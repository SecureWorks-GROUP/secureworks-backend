export class ContextPipelineError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message) }
}
export function contextReviewWeek(value: unknown, now = new Date()): string {
  const perthDay = new Date(now.getTime() + 8 * 3600_000)
  const monday = new Date(Date.UTC(perthDay.getUTCFullYear(), perthDay.getUTCMonth(), perthDay.getUTCDate()))
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7) - 7)
  if (value === undefined || value === null || value === '') return monday.toISOString().slice(0, 10)
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ContextPipelineError('invalid_week', 400, 'week_start must be a Monday date.')
  const day = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value || day.getUTCDay() !== 1) throw new ContextPipelineError('invalid_week', 400, 'week_start must be a Monday date.')
  return value
}
export async function contextPipelineStatus(client: any) {
  const { data, error } = await client.rpc('context_pipeline_status')
  if (error || !data) throw new ContextPipelineError('context_status_unavailable', 503, 'Context pipeline status could not be read.')
  return data
}
export async function contextAccuracySample(client: any, week: string) {
  const [summary, sample] = await Promise.all([
    client.from('context_accuracy_weeks').select('*').eq('week_start', week).maybeSingle(),
    client.from('context_accuracy_samples').select('*').eq('week_start', week).order('bucket').order('fact_id'),
  ])
  if (summary.error || sample.error) throw new ContextPipelineError('context_sample_unavailable', 503, 'The accuracy review could not be read.')
  const rows = sample.data || []
  return { week_start: week, requested: 40, sampled: rows.length, missing: Math.max(0, 40 - rows.length),
    state: !summary.data ? 'not_drawn' : rows.length < 40 ? 'insufficient_sample' : 'drawn',
    week: summary.data, samples: rows }
}
export async function contextAccuracyVerdict(client: any, body: Record<string, unknown>, actor: { id: string; orgId: string } | null, expectedOrgId: string) {
  if (!actor || !actor.id) throw new ContextPipelineError('human_auth_required', 401, 'Sign in as a named operator to record this verdict. A service key or judged_by name is not human identity.')
  if (!actor.orgId || actor.orgId !== expectedOrgId) throw new ContextPipelineError('operator_org_required', 403, 'The reviewing operator must belong to this organisation.')
  const week = contextReviewWeek(body.week_start)
  if (typeof body.fact_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.fact_id)
    || !['job_context','job_temporary_context'].includes(String(body.fact_store)) || !['true','false','wrong_job'].includes(String(body.verdict))
    || (body.invented_payment !== undefined && typeof body.invented_payment !== 'boolean') || (body.invented_payment === true && body.verdict !== 'false')) {
    throw new ContextPipelineError('invalid_verdict', 400, 'Supply a sampled fact, verdict and optional invented-payment finding.')
  }
  const { data, error } = await client.rpc('record_context_accuracy_verdict', {
    p_week_start: week, p_fact_id: body.fact_id, p_fact_store: body.fact_store, p_verdict: body.verdict,
    p_actor_id: actor.id, p_invented_payment: body.invented_payment === true,
  })
  if (error || !data) throw new ContextPipelineError('context_verdict_refused', 409, 'The verdict was not recorded. Check the sample, operator profile and whether the review is already published.')
  return data
}
