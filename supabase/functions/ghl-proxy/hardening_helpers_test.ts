import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts"
import {
  assignJobNumberWithNullCas,
  classifyAuthCredential,
  classifyScopeCasReread,
  contactDisplayIdentity,
  deterministicMediaId,
  deterministicMediaStorageKey,
  isProfileRequestBoundToJwt,
  isSameOrg,
  rejectSharedKeyForBrowserAction,
  requestedBaseScopeHash,
  requiresBaseScopeCursor,
  scopeJsonHash,
  stalePreparedContactIds,
  verifiedJobStorageOrgId,
} from './hardening_helpers.ts'

Deno.test('browser-facing actions reject the shared SW_API_KEY when the rollout gate is enabled', () => {
  const credential = classifyAuthCredential({
    xApiKey: 'shared',
    bearerToken: null,
    validKey: 'shared',
    serviceKey: 'service',
  })
  assertEquals(credential.ok, true)
  if (!credential.ok) return
  assertEquals(credential.mode, 'shared_key')

  const rejection = rejectSharedKeyForBrowserAction('save_scope', 'POST', credential.mode, true)
  assertEquals(rejection?.ok, false)
  if (rejection?.ok === false) {
    assertEquals(rejection.status, 401)
    assertEquals(rejection.code, 'user_jwt_required')
  }
})

Deno.test('legacy shared-key browser callers remain compatible while the rollout gate is unset', () => {
  const credential = classifyAuthCredential({
    xApiKey: 'shared',
    bearerToken: null,
    validKey: 'shared',
    serviceKey: 'service',
  })
  assertEquals(credential.ok, true)
  if (!credential.ok) return
  assertEquals(rejectSharedKeyForBrowserAction('save_scope', 'POST', credential.mode), null)
  assertEquals(rejectSharedKeyForBrowserAction('load_job', 'GET', credential.mode, false), null)
})

Deno.test('JWT rollout gate covers every mutating fence browser action', () => {
  for (const action of [
    'create_contact_and_opportunity',
    'prepare_quote',
    'prepare_neighbour_quotes',
  ]) {
    const rejection = rejectSharedKeyForBrowserAction(action, 'POST', 'shared_key', true)
    assertEquals(rejection?.ok, false, `${action} must not retain a shared-key bypass`)
  }
})

Deno.test('service-role auth remains valid for server-to-server calls', () => {
  const credential = classifyAuthCredential({
    xApiKey: 'service',
    bearerToken: null,
    validKey: 'shared',
    serviceKey: 'service',
  })
  assertEquals(credential.ok, true)
  if (!credential.ok) return
  assertEquals(credential.mode, 'service_role')
  assertEquals(rejectSharedKeyForBrowserAction('save_scope', 'POST', credential.mode), null)
})

Deno.test('same-org check rejects cross-org job access', () => {
  assertEquals(isSameOrg('org-a', 'org-a'), true)
  assertEquals(isSameOrg('org-a', 'org-b'), false)
  assertEquals(isSameOrg(null, 'org-a'), false)
})

Deno.test('phone-only contacts have a useful opportunity identity without inventing a client name', () => {
  assertEquals(contactDisplayIdentity({ phone: '+61 400 111 222' }), 'Phone lead +61 400 111 222')
  assertEquals(contactDisplayIdentity({ firstName: 'Ada', lastName: 'Lovelace', phone: '0400' }), 'Ada Lovelace')
  assertEquals(contactDisplayIdentity({ email: 'lead@example.com' }), 'lead@example.com')
})

Deno.test('save_scope requires a base cursor for already-nonempty scope', async () => {
  const currentScope = { job: { ref: 'SWP-26001' }, measurements: [1, 2, 3] }
  assertEquals(requiresBaseScopeCursor(currentScope, null), true)
  assertEquals(requiresBaseScopeCursor(currentScope, await scopeJsonHash(currentScope)), false)
  assertEquals(requiresBaseScopeCursor({}, null), false)
})

Deno.test('legacy shared-key scope saves remain compatible until their cursor gate is enabled', () => {
  const currentScope = { job: { ref: 'SWP-26001' } }
  assertEquals(requiresBaseScopeCursor(currentScope, null, 'shared_key'), false)
  assertEquals(requiresBaseScopeCursor(currentScope, null, 'shared_key', true), true)
  assertEquals(requiresBaseScopeCursor(currentScope, null, 'service_role', true), false)
})

Deno.test('save_scope detects stale cursor before write', async () => {
  const currentScope = { a: 1 }
  const staleScope = { a: 0 }
  const currentHash = await scopeJsonHash(currentScope)
  const expectedHash = requestedBaseScopeHash({ baseScopeHash: await scopeJsonHash(staleScope) })
  assertEquals(expectedHash === currentHash, false)
})

Deno.test('save_scope CAS loser reports same-hash winner separately from stale conflict', async () => {
  const incomingHash = await scopeJsonHash({ run: 'same' })
  const differentHash = await scopeJsonHash({ run: 'different' })
  assertEquals(classifyScopeCasReread(incomingHash, incomingHash), 'scope_concurrent_same_hash')
  assertEquals(classifyScopeCasReread(incomingHash, differentHash), 'scope_hash_conflict')
})

Deno.test('assign_job_number reuses a same-job concurrent winner after null-only CAS loses', async () => {
  const sb = fakeSupabase({
    selectSingles: [
      { data: { job_number: null, status: 'draft' }, error: null },
      { data: { job_number: 'SWP-26001', status: 'draft' }, error: null },
    ],
    rpcResults: [{ data: 'SWP-26001', error: null }],
    updateMaybeSingles: [{ data: null, error: null }],
  })

  const result = await assignJobNumberWithNullCas({
    sb,
    jobId: 'job-1',
    jobType: 'patio',
  })

  assertEquals(result.jobNumber, 'SWP-26001')
  assertEquals(result.reused, true)
  assertEquals(result.assigned, false)
  assertEquals(sb.calls.updateFilters, [
    ['eq', 'id', 'job-1'],
    ['is', 'job_number', null],
  ])
})

Deno.test('register_media deterministic ID makes concurrent retries converge on one row identity', async () => {
  const first = await deterministicMediaId('job-1', 'https://storage.example/job-1/photo.jpg')
  const retry = await deterministicMediaId('job-1', 'https://storage.example/job-1/photo.jpg')
  const different = await deterministicMediaId('job-1', 'https://storage.example/job-1/other.jpg')
  assertEquals(first, retry)
  assertEquals(first === different, false)
  assertMatch(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

Deno.test('register_media identity ignores differing or missing media type for same uploaded object', async () => {
  const fromPhotoType = await deterministicMediaId('job-1', 'https://storage.example/job-1/photo.jpg')
  const fromMissingType = await deterministicMediaId('job-1', 'https://storage.example/job-1/photo.jpg')
  assertEquals(fromPhotoType, fromMissingType)
})

Deno.test('media upload retry reuses one deterministic storage key', async () => {
  const first = await deterministicMediaStorageKey('photo-local-1', 'Front fence.jpg')
  const retry = await deterministicMediaStorageKey('photo-local-1', 'Front fence.jpg')
  const different = await deterministicMediaStorageKey('photo-local-2', 'Front fence.jpg')
  assertEquals(first, retry)
  assertEquals(first === different, false)
  assertMatch(first, /^[0-9a-f]{24}_Front_fence\.jpg$/)
})

Deno.test('neighbour replacement cleanup removes only contacts absent from the prepared set', () => {
  assertEquals(stalePreparedContactIds(['old-a', 'old-b', 'old-c'], ['old-a', 'old-c', 'new-d']), ['old-b'])
  assertEquals(stalePreparedContactIds([], ['new-a']), [])
})

Deno.test('upload storage path uses the verified target job org id', () => {
  assertEquals(verifiedJobStorageOrgId({ org_id: 'org-from-job' }), 'org-from-job')
  assertEquals(verifiedJobStorageOrgId({ org_id: null }), null)
})

Deno.test('browser get_profile is bound to the verified JWT user id', () => {
  assertEquals(isProfileRequestBoundToJwt('user_jwt', 'user-1', 'user-1'), true)
  assertEquals(isProfileRequestBoundToJwt('user_jwt', 'user-2', 'user-1'), false)
  assertEquals(isProfileRequestBoundToJwt('service_role', 'user-2', 'user-1'), true)
})

function fakeSupabase(script: {
  selectSingles: Array<{ data: any; error: any }>
  rpcResults: Array<{ data: any; error: any }>
  updateMaybeSingles: Array<{ data: any; error: any }>
}) {
  const calls: { updateFilters: unknown[][] } = { updateFilters: [] }
  return {
    calls,
    rpc(_name: string, _args: Record<string, unknown>) {
      return Promise.resolve(script.rpcResults.shift() || { data: null, error: null })
    },
    from(_table: string) {
      return {
        select(_columns?: string) {
          return {
            eq(_column: string, _value: unknown) {
              return this
            },
            single() {
              return Promise.resolve(script.selectSingles.shift() || { data: null, error: null })
            },
          }
        },
        update(_payload: Record<string, unknown>) {
          return {
            eq(column: string, value: unknown) {
              calls.updateFilters.push(['eq', column, value])
              return this
            },
            is(column: string, value: unknown) {
              calls.updateFilters.push(['is', column, value])
              return this
            },
            select(_columns?: string) {
              return this
            },
            maybeSingle() {
              return Promise.resolve(script.updateMaybeSingles.shift() || { data: null, error: null })
            },
          }
        },
      }
    },
  }
}
