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

// ── lead_search helpers (fence repeat-client mission) ──────────────────────
//
// Pure, network-free shaping for the `lead_search` action. index.ts does the
// GHL/Supabase IO and maps opps through mapOpp; these helpers merge the pieces
// into the Row[] contract the fence client depends on. The Row shape is a hard
// contract — do not rename fields.

// A GHL opportunity already run through mapOpp, with pipelineId carried through
// so the merge can pipeline-filter and contact-verify (AM-I) without the raw opp.
export type LeadMappedOpp = {
  id: string
  name?: string
  contactName?: string
  contactEmail?: string
  contactPhone?: string
  contactAddress?: string
  contactCity?: string
  stageName?: string
  updatedAt?: string | null
  contactId?: string
  pipelineId?: string
  [key: string]: unknown
}

export type LeadContact = {
  id: string
  name?: string | null
  email?: string | null
  phone?: string | null
  address?: string | null
  city?: string | null
}

// Supabase cross-ref for a job row (by opp id or by contact id).
export type LeadJobRef = { id: string; hasScope: boolean; jobNumber: string | null }

// Result of the per-contact opportunity lookup. `failed:true` means the lookup
// timed out / errored / returned an unexpected shape and the contact degrades to
// a non-selectable lookupFailed row (AM-C, AM-I).
export type LeadLookup = { opps: LeadMappedOpp[]; failed: boolean }

export type LeadRow = {
  id: string | null
  contactId: string
  name: string
  contactName: string
  contactEmail: string
  contactPhone: string
  contactAddress: string
  contactCity: string
  stageName: string
  updatedAt: string | null
  supabaseJobId: string | null
  hasScope: boolean
  jobNumber: string | null
  isContactOnly: boolean
  lookupFailed: boolean
  [key: string]: unknown
}

// Build a Row for an opportunity: reuse the mapOpp output spread + the extra
// cross-ref/mode fields. pipelineId is an internal carry field and is dropped.
export function leadOppRow(mapped: LeadMappedOpp, job: LeadJobRef | undefined | null): LeadRow {
  const { pipelineId: _pipelineId, ...rest } = mapped
  return {
    ...rest,
    id: mapped.id ?? null,
    contactId: mapped.contactId || '',
    name: (mapped.name as string) || (mapped.contactName as string) || '',
    contactName: mapped.contactName || '',
    contactEmail: mapped.contactEmail || '',
    contactPhone: mapped.contactPhone || '',
    contactAddress: mapped.contactAddress || '',
    contactCity: mapped.contactCity || '',
    stageName: mapped.stageName || '',
    updatedAt: mapped.updatedAt ?? null,
    supabaseJobId: job?.id ?? null,
    hasScope: job?.hasScope ?? false,
    jobNumber: job?.jobNumber ?? null,
    isContactOnly: false,
    lookupFailed: false,
  }
}

// Build a contact-only Row (no opportunity in this pipeline, or the lookup
// degraded). Cross-ref is by ghl_contact_id.
export function leadContactOnlyRow(
  contact: LeadContact,
  job: LeadJobRef | undefined | null,
  lookupFailed: boolean,
): LeadRow {
  const name = (contact.name || '').trim()
  return {
    id: null,
    contactId: contact.id || '',
    name,
    contactName: name,
    contactEmail: contact.email || '',
    contactPhone: contact.phone || '',
    contactAddress: contact.address || '',
    contactCity: contact.city || '',
    stageName: '',
    updatedAt: null,
    supabaseJobId: job?.id ?? null,
    hasScope: job?.hasScope ?? false,
    jobNumber: job?.jobNumber ?? null,
    isContactOnly: true,
    lookupFailed,
  }
}

// Merge contacts (in search order) + their per-contact opp lookups + Supabase
// cross-ref maps into the Row[] the fence client renders.
//   - opps kept only when opp.pipelineId === pipelineId AND the opp's contact id
//     matches the contact we looked up (AM-I: an ignored contact_id filter cannot
//     leak another client's opps).
//   - a failed lookup → single lookupFailed contact-only row (never fails the set).
//   - a contact with zero valid opps → contact-only row (isContactOnly, cross-ref
//     by contact id; supabaseJobId may still be populated — AM: keep isContactOnly).
//   - sort (AM-E): opp rows by updatedAt desc first, then contact-only rows in the
//     original contacts-search order.
export function buildLeadSearchRows(args: {
  contacts: LeadContact[]
  lookups: Record<string, LeadLookup>
  pipelineId: string
  jobByOppId: Record<string, LeadJobRef>
  jobByContactId: Record<string, LeadJobRef>
}): LeadRow[] {
  const { contacts, lookups, pipelineId, jobByOppId, jobByContactId } = args
  const oppRows: LeadRow[] = []
  const contactOnlyRows: LeadRow[] = []

  for (const contact of contacts || []) {
    const contactId = contact?.id || ''
    const lookup = lookups[contactId] || { opps: [], failed: false }

    if (lookup.failed) {
      contactOnlyRows.push(leadContactOnlyRow(contact, jobByContactId[contactId], true))
      continue
    }

    const validOpps = (lookup.opps || []).filter((o) => {
      if (!o || typeof o.id !== 'string') return false
      if (pipelineId && o.pipelineId !== pipelineId) return false
      const oppContactId = o.contactId || ''
      return oppContactId === contactId
    })

    if (validOpps.length === 0) {
      contactOnlyRows.push(leadContactOnlyRow(contact, jobByContactId[contactId], false))
      continue
    }

    for (const opp of validOpps) {
      oppRows.push(leadOppRow(opp, jobByOppId[opp.id]))
    }
  }

  oppRows.sort((a, b) => {
    const at = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
    const bt = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
    return bt - at
  })

  return [...oppRows, ...contactOnlyRows]
}

// Opportunity name for a contact whose identity was fetched from GHL (B2/AM-B).
// Built from the FETCHED contact fields, never from the empty request body.
export function leadOppNameForContact(
  contact: { firstName?: unknown; lastName?: unknown; phone?: unknown; email?: unknown; address1?: unknown; address?: unknown },
  toolType: unknown,
): string {
  const label = contactDisplayIdentity({
    firstName: contact.firstName,
    lastName: contact.lastName,
    phone: contact.phone,
    email: contact.email,
    address: contact.address1 ?? contact.address,
  })
  return label + ' — ' + (toolType === 'fencing' ? 'Fencing' : 'Patio')
}

// Orchestrates the create_contact_and_opportunity contactId branch (B2/AM-B):
// verify an existing contact, then create a NEW opportunity in the pipeline.
// The GHL client is injected so this is unit-testable without network:
//   - GET /contacts/{id} 404 / not-found → { status:404, code:'contact_not_found' }
//     and NO opportunity creation is attempted.
//   - other fetch failure → { status:502, code:'contact_fetch_failed' }.
//   - success → { status:200, body:{ contactId, opportunityId, contactExisted:true } }
//     with oppName built from the FETCHED contact identity.
//   - opportunity creation failure → { status:500 } echoing the resolved contactId.
export async function createOpportunityForExistingContact(args: {
  contactId: string
  toolType: unknown
  locationId: string
  pipelines: Record<string, string>
  ghl: (path: string, init?: Record<string, unknown>) => Promise<any>
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { contactId, toolType, locationId, pipelines, ghl } = args

  let fetchedContact: any
  try {
    const data = await ghl(`/contacts/${contactId}`)
    fetchedContact = data?.contact || data
  } catch (e) {
    const msg = (e as Error)?.message || ''
    if (/^GHL 404/.test(msg) || /not found/i.test(msg)) {
      return { status: 404, body: { error: 'Contact not found', code: 'contact_not_found' } }
    }
    return { status: 502, body: { error: 'Failed to fetch contact: ' + msg, code: 'contact_fetch_failed' } }
  }
  if (!fetchedContact || !fetchedContact.id) {
    return { status: 404, body: { error: 'Contact not found', code: 'contact_not_found' } }
  }

  const pipelineId = pipelines[toolType as string] || pipelines.patio
  try {
    const oppName = leadOppNameForContact(fetchedContact, toolType)
    const oppRes = await ghl('/opportunities/', {
      method: 'POST',
      body: JSON.stringify({
        pipelineId,
        locationId,
        contactId: fetchedContact.id,
        name: oppName,
        status: 'open',
        pipelineStageId: undefined,
      }),
    })
    const opportunityId = oppRes?.opportunity?.id || null
    return { status: 200, body: { contactId: fetchedContact.id, opportunityId, contactExisted: true } }
  } catch (e) {
    return {
      status: 500,
      body: {
        contactId: fetchedContact.id,
        opportunityId: null,
        contactExisted: true,
        error: 'Opportunity creation failed: ' + ((e as Error)?.message || ''),
      },
    }
  }
}
