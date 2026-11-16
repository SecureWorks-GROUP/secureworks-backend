// The house-plans upload (send-quote/upload-plans), behind the accept page's upload box.
//
// Director's ruling 5 (12 Nov 2026). Until then the upload trusted the job id in
// the request over the link's token (any job id uploaded to that job, valid token
// or not, and could mark its council step complete), and a failed storage write
// still answered success. Rules now:
// - An upload is accepted only with a share token that is a real quote document
//   AND belongs to the job named (a request may omit the job; then it is the
//   token's job). Anything else is refused and writes nothing.
// - Success ("received") is answered only when storage confirms the file. Only
//   then are the evidence event and job note written and the council step moved.
// - The storage bucket's visibility is not changed here.

export type Sb = { from: (table: string) => any }

export type UploadPlansJob =
  | { ok: true; jobId: string; site: { site_address?: string | null; site_suburb?: string | null } | null }
  | { ok: false; status: number; error: string }

/** The job a share token may upload to. `claimedJobId` is the job the link or page names, if any. */
export async function resolveUploadPlansJob(
  sb: Sb,
  token: unknown,
  claimedJobId: unknown,
): Promise<UploadPlansJob> {
  if (typeof token !== 'string' || !token.trim()) return { ok: false, status: 400, error: 'invalid_link' }
  let res: { data: any; error: unknown }
  try {
    res = await sb.from('job_documents')
      .select('job_id, jobs(site_address, site_suburb)')
      .eq('share_token', token)
      .maybeSingle()
  } catch {
    return { ok: false, status: 503, error: 'link_unreadable' }
  }
  if (res?.error) return { ok: false, status: 503, error: 'link_unreadable' }
  const doc = res?.data
  const jobId = doc && typeof doc.job_id === 'string' ? doc.job_id : ''
  if (!jobId) return { ok: false, status: 404, error: 'invalid_link' }
  const claimed = typeof claimedJobId === 'string' ? claimedJobId.trim() : ''
  if (claimed && claimed !== jobId) return { ok: false, status: 403, error: 'link_not_for_this_job' }
  const site = doc.jobs && typeof doc.jobs === 'object' && !Array.isArray(doc.jobs) ? doc.jobs : null
  return { ok: true, jobId, site }
}

/** A file name safe to put in a storage path: no folders, no control characters. */
export function safePlanFilename(filename: unknown): string {
  const raw = typeof filename === 'string' ? filename : ''
  const base = raw.split(/[\\/]/).pop() || ''
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '').trim().slice(0, 200)
  return clean || 'house-plans.pdf'
}

export type UploadPlansDeps = {
  sb: Sb
  /** Stores the bytes. Returns an error when storage did not confirm the file. */
  store: (path: string, bytes: Uint8Array, contentType: string) => Promise<{ error: unknown }>
  publicUrl: (path: string) => string | null
  recordEvidence: (row: Record<string, unknown>) => Promise<unknown>
  orgId: string
  now?: () => Date
}

export type UploadPlansResult = { status: number; body: Record<string, unknown> }

export async function handleUploadPlans(deps: UploadPlansDeps, body: any): Promise<UploadPlansResult> {
  const { token, job_id, filename, content_base64, content_type } = body || {}
  if (!token || !content_base64) return { status: 400, body: { error: 'token and content_base64 required' } }

  const job = await resolveUploadPlansJob(deps.sb, token, job_id)
  if (!job.ok) return { status: job.status, body: { error: job.error } }
  const jId = job.jobId

  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(String(content_base64)), (c) => c.charCodeAt(0))
  } catch {
    return { status: 400, body: { error: 'file_unreadable' } }
  }
  if (bytes.length === 0) return { status: 400, body: { error: 'file_empty' } }

  const name = safePlanFilename(filename)
  const now = deps.now?.() ?? new Date()
  const filePath = `${jId}/council/house-plans/${now.getTime()}-${name}`
  let stored: { error: unknown }
  try {
    stored = await deps.store(filePath, bytes, typeof content_type === 'string' && content_type ? content_type : 'application/pdf')
  } catch (e) {
    stored = { error: e }
  }
  if (stored?.error) {
    console.error('[send-quote] house plans upload not stored', JSON.stringify({
      job_id: jId, reason: (stored.error as any)?.message || String(stored.error),
    }))
    return { status: 502, body: { error: 'upload_failed' } }
  }
  const url = deps.publicUrl(filePath)

  // Stored: only now record it and move the council step.
  await deps.recordEvidence({
    event_type: 'council.plans_received',
    entity_type: 'job',
    entity_id: jId,
    detail_json: { filename: name, source: 'upload_page', url },
  }).then(() => {}, () => {})

  await Promise.resolve(deps.sb.from('ai_annotations').insert({
    org_id: deps.orgId,
    entity_type: 'job',
    entity_id: jId,
    ui_location: 'job_overview',
    annotation_type: 'council_plans_received',
    category: 'council',
    title: 'House plans uploaded by client',
    body: `${name} uploaded via acceptance page`,
    priority: 60,
    severity: 'info',
    source: 'send-quote',
    source_ref: `plans:${jId}:${now.getTime()}`,
    confidence: 1.0,
  })).then(() => {}, () => {})

  const { data: submission } = await deps.sb.from('council_submissions')
    .select('id, steps').eq('job_id', jId).maybeSingle()
  if (submission && submission.steps && submission.steps[0]?.status === 'pending') {
    const steps = [...submission.steps]
    steps[0] = { ...steps[0], status: 'complete', completed_at: now.toISOString(), documents_received: [{ filename: name, url }] }
    await deps.sb.from('council_submissions').update({ steps, current_step_index: 1 }).eq('id', submission.id)
  }

  return { status: 200, body: { success: true, url } }
}
