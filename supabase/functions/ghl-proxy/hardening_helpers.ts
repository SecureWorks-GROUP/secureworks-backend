export type AuthMode = 'service_role' | 'shared_key' | 'user_jwt'

export type AuthDecision =
  | { ok: true; mode: AuthMode; bearerToken: string | null }
  | { ok: false; status: 401 | 403; code: string; error: string }

export const BROWSER_USER_ACTIONS = new Set([
  'opportunities',
  'search_contacts',
  'search',
  'contact',
  'link',
  'find_job',
  'search_jobs',
  'create_job',
  'create_contact_and_opportunity',
  'save_scope',
  'load_job',
  'list_media',
  'get_upload_url',
  'register_media',
  'upload_photo',
  'update_contact',
  'get_profile',
  'delete_media',
  'increment_scope_version',
  'assign_job_number',
  'prepare_quote',
  'prepare_neighbour_quotes',
])

export const JOB_SCOPED_ACTIONS = new Set([
  'link',
  'save_scope',
  'load_job',
  'list_media',
  'get_upload_url',
  'register_media',
  'upload_photo',
  'delete_media',
  'increment_scope_version',
  'assign_job_number',
])

export function cleanIdentity(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

export function normalizeIdentity(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function contactDisplayIdentity(args: {
  firstName?: unknown
  lastName?: unknown
  phone?: unknown
  email?: unknown
  address?: unknown
}): string {
  const name = [cleanIdentity(args.firstName), cleanIdentity(args.lastName)].filter(Boolean).join(' ')
  if (name) return name
  const phone = cleanIdentity(args.phone)
  if (phone) return `Phone lead ${phone}`
  return cleanIdentity(args.email) || cleanIdentity(args.address) || 'Unnamed lead'
}

export function isRealJobRef(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /^SW[PF]?-?\d/i.test(value.trim())
}

export function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((v) => stableJsonStringify(v)).join(',') + ']'
  const obj = value as Record<string, unknown>
  return '{' + Object.keys(obj).sort().map((key) => JSON.stringify(key) + ':' + stableJsonStringify(obj[key])).join(',') + '}'
}

export async function scopeJsonHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJsonStringify(value || {}))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function requestedBaseScopeHash(meta: any = {}): string | null {
  return cleanIdentity(meta?.expectedScopeHash ?? meta?.baseScopeHash ?? meta?.base_scope_hash ?? meta?.scope_hash)
}

export function hasNonEmptyScope(scopeJson: unknown): boolean {
  return !!(
    scopeJson &&
    typeof scopeJson === 'object' &&
    !Array.isArray(scopeJson) &&
    Object.keys(scopeJson as Record<string, unknown>).length > 0
  )
}

export function requiresBaseScopeCursor(
  currentScopeJson: unknown,
  expectedScopeHash: string | null,
  mode: AuthMode = 'user_jwt',
  enforceForSharedKey = false,
): boolean {
  const callerRequiresCursor = mode === 'user_jwt' || (mode === 'shared_key' && enforceForSharedKey)
  return callerRequiresCursor && hasNonEmptyScope(currentScopeJson) && !expectedScopeHash
}

export function classifyScopeCasReread(incomingScopeHash: string, rereadScopeHash: string): 'scope_concurrent_same_hash' | 'scope_hash_conflict' {
  return rereadScopeHash === incomingScopeHash ? 'scope_concurrent_same_hash' : 'scope_hash_conflict'
}

export function classifyAuthCredential(args: {
  xApiKey: string | null
  bearerToken: string | null
  validKey: string | undefined
  serviceKey: string | undefined
}): AuthDecision {
  const { xApiKey, bearerToken, validKey, serviceKey } = args
  if (serviceKey && (xApiKey === serviceKey || bearerToken === serviceKey)) {
    return { ok: true, mode: 'service_role', bearerToken }
  }
  if (validKey && (xApiKey === validKey || bearerToken === validKey)) {
    return { ok: true, mode: 'shared_key', bearerToken }
  }
  if (bearerToken) return { ok: true, mode: 'user_jwt', bearerToken }
  return { ok: false, status: 401, code: 'missing_auth', error: 'Authentication required' }
}

export function rejectSharedKeyForBrowserAction(
  action: string | null,
  method: string,
  mode: AuthMode,
  enforceUserJwt = false,
): AuthDecision | null {
  if (!enforceUserJwt || !action || mode !== 'shared_key') return null
  if (BROWSER_USER_ACTIONS.has(action)) {
    return {
      ok: false,
      status: 401,
      code: 'user_jwt_required',
      error: 'This action requires a Supabase user JWT; the shared API key is not accepted.',
    }
  }
  return null
}

export function isSameOrg(userOrgId: unknown, jobOrgId: unknown): boolean {
  return !!userOrgId && !!jobOrgId && String(userOrgId) === String(jobOrgId)
}

export function verifiedJobStorageOrgId(job: { org_id?: unknown } | null | undefined): string | null {
  return job?.org_id ? String(job.org_id) : null
}

export function isProfileRequestBoundToJwt(mode: AuthMode, requestedUserId: string, authUserId: string | null): boolean {
  return mode !== 'user_jwt' || (!!authUserId && requestedUserId === authUserId)
}

export function isDuplicateJobNumberError(error: unknown): boolean {
  const anyErr = error as { code?: string; message?: string; details?: string }
  const msg = String(anyErr?.message || anyErr?.details || error || '')
  return anyErr?.code === '23505' || /idx_jobs_job_number|duplicate key value|job_number/i.test(msg)
}

export async function deterministicMediaId(jobId: string, storageUrl: string): Promise<string> {
  const input = `${jobId}\n${storageUrl}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  const bytes = new Uint8Array(digest).slice(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function deterministicMediaStorageKey(clientMediaId: string, fileName: string): Promise<string> {
  const safeName = String(fileName || 'media').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'media'
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`media-upload\n${String(clientMediaId || '')}`),
  )
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `${hex.slice(0, 24)}_${safeName}`
}

export function stalePreparedContactIds(previousIds: unknown[], preparedIds: unknown[]): string[] {
  const prepared = new Set((preparedIds || []).filter(Boolean).map((id) => String(id)))
  return (previousIds || [])
    .filter(Boolean)
    .map((id) => String(id))
    .filter((id) => !prepared.has(id))
}

export async function assignJobNumberWithNullCas(args: {
  sb: any
  jobId: string
  jobType: string
  maxAttempts?: number
  logPrefix?: string
}) {
  const { sb, jobId, jobType, maxAttempts = 3, logPrefix = 'ghl-proxy' } = args
  const { data: existing, error: existingError } = await sb.from('jobs').select('job_number, status').eq('id', jobId).single()
  if (existingError) throw existingError
  if (existing?.job_number) {
    return { jobNumber: existing.job_number, status: existing.status || null, reused: true, assigned: false, collisionCount: 0 }
  }

  let collisionCount = 0
  let lastAssignError: unknown = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { data: jnData, error: jnError } = await sb.rpc('next_job_number', { job_type: jobType })
    if (jnError) {
      lastAssignError = jnError
      break
    }
    if (!jnData) break

    const { data: updated, error: updateError } = await sb.from('jobs')
      .update({ job_number: jnData })
      .eq('id', jobId)
      .is('job_number', null)
      .select('job_number, status')
      .maybeSingle()

    if (!updateError && updated?.job_number) {
      return { jobNumber: updated.job_number, status: updated.status || null, reused: false, assigned: true, collisionCount }
    }

    if (!updateError && !updated) {
      const { data: winner, error: winnerError } = await sb.from('jobs').select('job_number, status').eq('id', jobId).single()
      if (winnerError) throw winnerError
      if (winner?.job_number) {
        return { jobNumber: winner.job_number, status: winner.status || null, reused: true, assigned: false, collisionCount }
      }
      lastAssignError = new Error('Job number compare-and-swap updated no rows and no winning job number was found')
      break
    }

    lastAssignError = updateError
    if (isDuplicateJobNumberError(updateError)) {
      collisionCount++
      console.log(`[${logPrefix}] job-number collision, retrying:`, jnData, updateError?.message)
      continue
    }
    throw updateError
  }

  return { jobNumber: null, status: null, reused: false, assigned: false, collisionCount, error: lastAssignError }
}
