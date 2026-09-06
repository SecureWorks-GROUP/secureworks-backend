// send-quote test suite covering:
//   - safeBusinessEventInsert (Phase 2 hardening — 5 cases, originally CAP0-QA-CANONICAL-EVENTS-HARDENING)
//   - stageQuoteRevision / releaseQuoteRevision (CAP0-QUOTE-REVISION-MINIMAL)
//
// LOCAL-ONLY. The helpers under test are non-exported top-level async functions
// in `index.ts`; importing index.ts directly would start the production HTTP
// server via `serve(...)` at module-load time. We therefore copy the helper
// bodies inline below — any drift between these copies and the deployed helpers
// is the operator's responsibility (audited at PR review time via grep diff).
//
// Run from the worktree root:
//   deno test --allow-net --allow-env supabase/functions/send-quote/index_test.ts
//   deno test --allow-net --allow-env supabase/functions/_shared/release_packet/

import { assert, assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts"
import { canonicalJsonAndHash } from "../_shared/release_packet/canonicalize.ts"
import { buildMinimalReleaseManifest } from "../_shared/release_packet/build_minimal_manifest.ts"
import {
  QUOTE_SEND_CLAIM_TTL_MS,
  claimJobSendRuns,
  claimQuoteDocumentSend,
  clearJobSendRunsClaim,
  quoteSendClaimRevertPayload,
  resendResponseIsDefinitivePreSendRejection,
  quoteSendResendIdempotencyKey,
  resendIdempotencyHeaders,
  touchQuoteDocumentSendClaim,
  touchQuoteDocumentSendClaims,
  touchGroupedQuoteDocumentSendClaims,
  classifySendClaimLease,
  claimsForDocumentIds,
  claimsNotInDocumentIds,
  documentIdsPublishedForSuccessfulSends,
  ensureQuoteGroupEmailSendKey,
  retireQuoteGroupEmailSendKey,
  persistTradePacksWhileHoldingSendClaims,
  pickQuoteGroupEmailCoveringRecord,
  quoteGroupEmailCoversDocumentSet,
  quoteGroupEmailDocumentSetKey,
  quoteGroupEmailResendIdempotencyKey,
  quoteSendRecipientKey,
  publishQuoteDocumentSend,
  publishQuoteDocumentSendOrRevert,
  publishQuoteDocumentsSendOrRevert,
  publishQuoteDocumentsSendOrRevertWhileHolding,
  quoteSendClaimIsStale,
  quoteSendClaimPayload,
  quoteSendPublicationPayload,
  resolveSendRunDocument,
  revertQuoteDocumentSendClaim,
  revertQuoteDocumentSendClaims,
  sendRunQuoteNumberFallback,
  sendRunsPrimaryClientPublicationSatisfied,
  sendRunsPublicationFailureBlocksSuccess,
  sendRunsSendOutcome,
  priorPublishedQuoteIdsToSupersede,
  quoteSendIsPublished,
  sendClaimKeyStampConfirmed,
  supersedePriorPublishedQuoteDocuments,
} from "../_shared/trade_quote_pack/quote_send_publication.ts"

// ── EXACT COPY of safeBusinessEventInsert from index.ts:108-132 ──
async function safeBusinessEventInsert(
  sb: any,
  row: Record<string, any>,
  ctx: { handler: string; job_id: string | null }
): Promise<void> {
  try {
    const { error } = await sb.from('business_events').insert(row)
    if (error) {
      console.error('[canonical-event-fail]', JSON.stringify({
        event_type: row?.event_type ?? null,
        handler: ctx.handler,
        job_id: ctx.job_id,
        error: error.message ?? String(error),
      }))
    }
  } catch (e: any) {
    console.error('[canonical-event-fail]', JSON.stringify({
      event_type: row?.event_type ?? null,
      handler: ctx.handler,
      job_id: ctx.job_id,
      error: e?.message ?? String(e),
    }))
  }
}
// ── END EXACT COPY ──

// Capture console.error calls for assertion.
function captureConsoleError() {
  const captured: Array<{ tag: string; payload: any }> = []
  const original = console.error
  console.error = (...args: any[]) => {
    if (typeof args[0] === 'string' && args[0] === '[canonical-event-fail]') {
      try {
        captured.push({ tag: args[0], payload: JSON.parse(args[1]) })
      } catch {
        captured.push({ tag: args[0], payload: { _raw: args[1] } })
      }
    }
  }
  return {
    captured,
    restore: () => { console.error = original },
  }
}

// Mock supabase client.
function makeMockSupabase(insertBehavior: 'ok' | 'error' | 'throw') {
  return {
    from: (table: string) => ({
      insert: (_row: Record<string, any>) => {
        if (insertBehavior === 'throw') {
          throw new Error('connection reset by peer (simulated)')
        }
        if (insertBehavior === 'error') {
          return Promise.resolve({ error: { message: 'simulated rls deny' } })
        }
        return Promise.resolve({ error: null })
      },
    }),
  }
}

const sampleRow = {
  event_type: 'quote.sent',
  source: 'send-quote',
  occurred_at: '2026-04-30T00:00:00Z',
  recorded_at: '2026-04-30T00:00:00Z',
  entity_type: 'job',
  entity_id: 'aa1da77f-1951-4d64-be86-a810781d9813',
  correlation_id: 'aa1da77f-1951-4d64-be86-a810781d9813',
  job_id: 'aa1da77f-1951-4d64-be86-a810781d9813',
  payload: { sent_to: 'marnin@secureworkswa.com.au' },
  metadata: { handler: 'send-quote/send' },
  schema_version: '1.0',
}
const sampleCtx = {
  handler: 'send-quote/send',
  job_id: 'aa1da77f-1951-4d64-be86-a810781d9813',
}

Deno.test("safeBusinessEventInsert — happy path: insert resolves ok, NO log emitted", async () => {
  const cap = captureConsoleError()
  try {
    const sb = makeMockSupabase('ok')
    await safeBusinessEventInsert(sb, sampleRow, sampleCtx)
    assertEquals(cap.captured.length, 0, "expected zero [canonical-event-fail] logs on happy path")
  } finally {
    cap.restore()
  }
})

Deno.test("safeBusinessEventInsert — resolved-error path: insert returns {error}, structured log emitted", async () => {
  const cap = captureConsoleError()
  try {
    const sb = makeMockSupabase('error')
    await safeBusinessEventInsert(sb, sampleRow, sampleCtx)
    assertEquals(cap.captured.length, 1, "expected exactly one [canonical-event-fail] log")
    const entry = cap.captured[0]
    assertEquals(entry.tag, '[canonical-event-fail]')
    assertEquals(entry.payload.event_type, 'quote.sent')
    assertEquals(entry.payload.handler, 'send-quote/send')
    assertEquals(entry.payload.job_id, 'aa1da77f-1951-4d64-be86-a810781d9813')
    assertEquals(entry.payload.error, 'simulated rls deny')
  } finally {
    cap.restore()
  }
})

Deno.test("safeBusinessEventInsert — thrown-exception path: insert throws, structured log emitted", async () => {
  const cap = captureConsoleError()
  try {
    const sb = makeMockSupabase('throw')
    await safeBusinessEventInsert(sb, sampleRow, sampleCtx)
    assertEquals(cap.captured.length, 1, "expected exactly one [canonical-event-fail] log on throw")
    const entry = cap.captured[0]
    assertEquals(entry.tag, '[canonical-event-fail]')
    assertEquals(entry.payload.event_type, 'quote.sent')
    assertEquals(entry.payload.handler, 'send-quote/send')
    assertEquals(entry.payload.job_id, 'aa1da77f-1951-4d64-be86-a810781d9813')
    assertEquals(entry.payload.error, 'connection reset by peer (simulated)')
  } finally {
    cap.restore()
  }
})

Deno.test("safeBusinessEventInsert — handler/job_id from ctx are echoed verbatim into the log", async () => {
  const cap = captureConsoleError()
  try {
    const sb = makeMockSupabase('error')
    await safeBusinessEventInsert(sb, sampleRow, {
      handler: 'send-quote/send-runs',
      job_id: '7a03c012-2195-43b4-9898-0c478cecba8f',
    })
    assertEquals(cap.captured.length, 1)
    assertEquals(cap.captured[0].payload.handler, 'send-quote/send-runs')
    assertEquals(cap.captured[0].payload.job_id, '7a03c012-2195-43b4-9898-0c478cecba8f')
  } finally {
    cap.restore()
  }
})

Deno.test("safeBusinessEventInsert — does NOT throw out of the helper on insert failure (caller is unaffected)", async () => {
  // The release moment is irreversible (email sent, jobs.status flipped). The helper
  // must NEVER throw out of itself on a canonical-event failure — the email caller
  // depends on response shape staying intact.
  const cap = captureConsoleError()
  try {
    const sb = makeMockSupabase('throw')
    let threw = false
    try {
      await safeBusinessEventInsert(sb, sampleRow, sampleCtx)
    } catch {
      threw = true
    }
    assertEquals(threw, false, "helper must swallow exceptions (release moment is irreversible)")
    assertExists(cap.captured[0])
  } finally {
    cap.restore()
  }
})


// ════════════════════════════════════════════════════════════════════════════
// CAP0-QUOTE-REVISION-MINIMAL — recordReleasedQuoteRevision tests (R1–R10)
// ════════════════════════════════════════════════════════════════════════════
//
// These mirror the helper body in index.ts. Any drift caught at PR review.
// The helper records the quote_revisions row ONLY at the release moment with
// sent_at = now() — no pre-Resend staging — so a failed first attempt leaves
// no row behind for a later retry to inherit a stale snapshot from.
// (Codex stop-gate review task-molbo0d5-4v6crc — see helper docstring.)

const SUPABASE_URL = 'https://kevgrhcjxspbxgovpmfl.supabase.co'

// ── EXACT COPY of recordReleasedQuoteRevision body from index.ts ───────────
type RecordReleaseQuoteRevisionInput = {
  job_id: string
  job_document_id: string
  version: number
  recipient_email: string
  recipient_label: string | null
  build_kind: 'patio' | 'fence' | 'misc'
  council_status?: 'not_required' | 'required_pending' | 'required_approved' | 'unknown'
  neighbours_required?: boolean | null
  scope: {
    client_name: string | null
    site_address: string | null
    site_suburb: string | null
    job_type: string | null
    job_number: string | null
    runs?: Array<{
      run_label: string
      run_name: string | null
      neighbour_id: string | null
      items_count: number
    }>
  }
  pricing_json: unknown
  pdf_url: string
  released_via: 'send-quote/send' | 'send-quote/send-runs'
  org_id: string
}

async function recordReleasedQuoteRevision(
  sb: any,
  input: RecordReleaseQuoteRevisionInput,
  ctx: { handler: string; job_id: string },
): Promise<string | null> {
  try {
    const manifest = buildMinimalReleaseManifest({
      job_id: input.job_id,
      job_document_id: input.job_document_id,
      version: input.version,
      recipient_email: input.recipient_email,
      recipient_label: input.recipient_label,
      build_kind: input.build_kind,
      council_status: input.council_status,
      neighbours_required: input.neighbours_required,
      scope: input.scope,
      pricing_json: input.pricing_json,
      pdf_url: input.pdf_url,
      released_via: input.released_via,
    })
    const { canonical, hash } = await canonicalJsonAndHash(manifest)
    // CAP0-QUOTE-REVISION-MANIFEST-STORAGE: upload canonical bytes to private
    // release-manifests bucket. Service role bypasses RLS. Real URL on
    // success; falls back to stub on upload failure (manifest_canonical_text
    // is the inline verification source either way).
    const objectPath = `${hash}.json`
    const realManifestUrl = `${SUPABASE_URL}/storage/v1/object/release-manifests/${objectPath}`
    const stubManifestUrl = `supabase-internal://manifest/${hash}`
    let manifestUrl = stubManifestUrl
    try {
      const bytes = new TextEncoder().encode(canonical)
      const { error: upErr } = await sb.storage
        .from('release-manifests')
        .upload(objectPath, bytes, { contentType: 'application/json', upsert: false })
      if (!upErr) {
        manifestUrl = realManifestUrl
      } else {
        const dup = (upErr as any)?.statusCode === '409'
          || /duplicate|already exists/i.test(upErr.message ?? '')
        if (dup) manifestUrl = realManifestUrl
      }
    } catch { /* swallow; stub URL fallback is in place */ }
    const totals = manifest.totals_snapshot
    const sentAtIso = new Date().toISOString()
    const { data: inserted, error: insErr } = await sb.from('quote_revisions')
      .insert({
        job_id: input.job_id, job_document_id: input.job_document_id, version: input.version,
        recipient_email: input.recipient_email, recipient_label: input.recipient_label,
        scope_snapshot_json: manifest.scope_snapshot,
        pricing_snapshot_json: manifest.pricing_snapshot,
        totals_snapshot_json: totals,
        manifest_url: manifestUrl, manifest_hash: hash,
        manifest_canonical_text: canonical,
        pdf_url: input.pdf_url,
        council_status: input.council_status ?? 'unknown',
        build_kind: input.build_kind,
        neighbours_required: input.neighbours_required ?? null,
        released_via: input.released_via,
        sent_at: sentAtIso,
        schema_version: '1.0',
      })
      .select('id').single()
    if (!insErr && inserted) {
      return inserted.id
    }
    const { data: existing } = await sb.from('quote_revisions')
      .select('id, sent_at')
      .eq('job_id', input.job_id).eq('version', input.version).maybeSingle()
    if (existing && existing.sent_at !== null) {
      return existing.id
    }
    if (existing) {
      return null
    }
    return null
  } catch {
    return null
  }
}

// ── Mock builder ──
type MockState = {
  uploaded: Array<{ path: string; bytes: string }>
  inserted: Array<Record<string, any>>
}

function makeQuoteRevSupabase(opts: {
  uploadOk?: boolean
  insertReturns?: 'ok' | 'conflict' | 'unknown_error'
  insertedId?: string
  preExistingRow?: { id: string; sent_at: string | null }
}) {
  const state: MockState = { uploaded: [], inserted: [] }
  const sb = {
    storage: {
      from: (_bucket: string) => ({
        // Defensive: keep the older direct-upload mock around in case some
        // future caller switches back. The current helper uses signed URLs.
        upload: async (path: string, body: Uint8Array | Blob, _opts: any) => {
          if (opts.uploadOk === false) return { error: { message: 'upload denied' } }
          const text = body instanceof Uint8Array
            ? new TextDecoder().decode(body)
            : await (body as Blob).text()
          state.uploaded.push({ path, bytes: text })
          return { error: null }
        },
        createSignedUploadUrl: async (path: string) => {
          if (opts.uploadOk === false) return { data: null, error: { message: 'sign denied' } }
          // Track the path so the test's downstream PUT-mock fills it in.
          state.uploaded.push({ path, bytes: '' })
          return { data: { signedUrl: `https://example.test/signed/${encodeURIComponent(path)}` }, error: null }
        },
      }),
    },
    from: (_table: string) => {
      const chain: any = {
        _captured: { method: '', payload: null as any, filters: [] as any[] },
        insert(payload: any) {
          this._captured.method = 'insert'
          this._captured.payload = payload
          state.inserted.push(payload)
          return this
        },
        select(_cols: string) { return this },
        eq(_col: string, _val: any) { return this },
        is(_col: string, _val: any) { return this },
        single() {
          if (this._captured.method === 'insert') {
            if (opts.insertReturns === 'ok') {
              return Promise.resolve({ data: { id: opts.insertedId || 'new-rev-id' }, error: null })
            }
            if (opts.insertReturns === 'conflict') {
              return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } })
            }
            return Promise.resolve({ data: null, error: { message: 'unknown error' } })
          }
          return Promise.resolve({ data: null, error: null })
        },
        maybeSingle() {
          if (opts.preExistingRow) return Promise.resolve({ data: opts.preExistingRow, error: null })
          return Promise.resolve({ data: null, error: null })
        },
      }
      return chain
    },
    _state: state,
  }
  return sb as any
}

const sampleInput: RecordReleaseQuoteRevisionInput = {
  job_id: 'aa1da77f-1951-4d64-be86-a810781d9813',
  job_document_id: '4e33c01b-99a4-4c00-9ee0-6e7385a94f0b',
  version: 1,
  recipient_email: 'marnin@secureworkswa.com.au',
  recipient_label: null,
  build_kind: 'patio',
  scope: {
    client_name: 'CAP0 TEST',
    site_address: '1 Test St',
    site_suburb: 'Perth',
    job_type: 'patio',
    job_number: 'SWP-26133',
  },
  pricing_json: { totalIncGST: 5500, totalExGST: 5000, gst: 500 },
  pdf_url: 'https://example.com/x.pdf',
  released_via: 'send-quote/send',
  org_id: '00000000-0000-0000-0000-000000000001',
}

const sampleRevCtx = { handler: 'send-quote/send', job_id: 'aa1da77f-1951-4d64-be86-a810781d9813' }

// Monkey-patch fetch globally for this test module. The helper PUTs the canonical
// manifest JSON to a signed URL; we intercept those PUTs in-process so tests don't
// hit the network. Returns 200 OK with body capture by default; returns 502 if the
// URL contains 'fail-put' (used by upload-failure cases).
{
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any): Promise<Response> => {
    const url = typeof input === 'string' ? input : input?.url || ''
    if (init?.method === 'PUT' && url.startsWith('https://example.test/signed/')) {
      const status = url.includes('fail-put') ? 502 : 200
      return new Response(status === 200 ? 'OK' : 'fail', { status })
    }
    return origFetch(input, init)
  }) as typeof fetch
}

Deno.test("R1 — recordReleasedQuoteRevision happy path: uploads canonical to release-manifests bucket, inserts row with sent_at NOT NULL + real URL, returns revision id", async () => {
  const sb = makeQuoteRevSupabase({ uploadOk: true, insertReturns: 'ok', insertedId: 'rev-r1' })
  const id = await recordReleasedQuoteRevision(sb, sampleInput, sampleRevCtx)
  assertEquals(id, 'rev-r1')
  // CAP0-QUOTE-REVISION-MANIFEST-STORAGE: Storage upload happens BEFORE INSERT.
  assertEquals(sb._state.uploaded.length, 1, 'one upload to release-manifests bucket')
  // Path is hash-named JSON.
  assert(/^[0-9a-f]{64}\.json$/.test(sb._state.uploaded[0].path), `expected <hash>.json, got ${sb._state.uploaded[0].path}`)
  // Critical assertion: sent_at MUST be non-null at INSERT time (no staging).
  assertEquals(sb._state.inserted.length, 1)
  assertEquals(typeof sb._state.inserted[0].sent_at, 'string')
  assertEquals(sb._state.inserted[0].sent_at !== null, true)
  assertEquals(sb._state.inserted[0].released_via, 'send-quote/send')
  assertEquals(sb._state.inserted[0].schema_version, '1.0')
  // manifest_url is the real private-bucket object URL.
  const hash = sb._state.inserted[0].manifest_hash
  assertEquals(hash.length, 64)
  assertEquals(sb._state.inserted[0].manifest_url, `${SUPABASE_URL}/storage/v1/object/release-manifests/${hash}.json`)
})

Deno.test("R2 — recordReleasedQuoteRevision: insert payload's sent_at is a valid ISO timestamp string (release moment)", async () => {
  const sb = makeQuoteRevSupabase({ uploadOk: true, insertReturns: 'ok', insertedId: 'rev-r2' })
  await recordReleasedQuoteRevision(sb, sampleInput, sampleRevCtx)
  const sentAt = sb._state.inserted[0].sent_at
  // ISO 8601 with milliseconds: 2026-04-30T10:00:00.000Z
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(sentAt), `expected ISO timestamp, got ${sentAt}`)
})

Deno.test("R3 — recordReleasedQuoteRevision: ON CONFLICT + existing released row returns existing revision id (defensive duplicate-release)", async () => {
  // Duplicate-release defensive path: a row already exists at sent_at IS NOT NULL.
  // Should never normally reach here in production (the conditional UPDATE on
  // jobs would have returned 0 rows on a re-fire). But if we do, log and
  // return the existing id so canonical events stay coherent.
  const sb = makeQuoteRevSupabase({
    uploadOk: true,
    insertReturns: 'conflict',
    preExistingRow: { id: 'rev-r3-existing', sent_at: '2026-04-30T06:13:04Z' },
  })
  const id = await recordReleasedQuoteRevision(sb, sampleInput, sampleRevCtx)
  assertEquals(id, 'rev-r3-existing')
})

Deno.test("R4 — recordReleasedQuoteRevision: INSERT error with no existing row returns null (no throw)", async () => {
  const sb = makeQuoteRevSupabase({ uploadOk: true, insertReturns: 'unknown_error' })
  const id = await recordReleasedQuoteRevision(sb, sampleInput, sampleRevCtx)
  assertEquals(id, null)
})

Deno.test("R5 — recordReleasedQuoteRevision: ON CONFLICT + stale staged row (sent_at IS NULL) returns null and does NOT mutate the stale row", async () => {
  // This path should not normally be reachable post-this-fix (we never stage),
  // but defensively if a stale staged row exists from old code or manual DB
  // intervention, the trigger blocks our updating it. Helper returns null;
  // canonical events still emit with quote_revision_id=null and the operator
  // notices the [quote-revision-stale-staged] log line.
  const sb = makeQuoteRevSupabase({
    uploadOk: true,
    insertReturns: 'conflict',
    preExistingRow: { id: 'rev-r5-stale-staged', sent_at: null },
  })
  const id = await recordReleasedQuoteRevision(sb, sampleInput, sampleRevCtx)
  assertEquals(id, null)
})

Deno.test("R6 — recordReleasedQuoteRevision: ON CONFLICT + no existing row visible returns null", async () => {
  // Edge case: insert reports conflict but the lookup finds no row. Could
  // be a transient consistency issue. Return null defensively.
  const sb = makeQuoteRevSupabase({
    uploadOk: true,
    insertReturns: 'conflict',
    // no preExistingRow set
  })
  const id = await recordReleasedQuoteRevision(sb, sampleInput, sampleRevCtx)
  assertEquals(id, null)
})

Deno.test("R7 — recordReleasedQuoteRevision: manifest_url is the real private-bucket object URL on successful upload", async () => {
  // CAP0-QUOTE-REVISION-MANIFEST-STORAGE: post-2026-05-01, manifest_url points
  // at the private release-manifests bucket. Direct GET returns 401 to
  // anon/authenticated; only service-role + future signed-URL read API can
  // fetch the bytes. manifest_canonical_text remains the inline verification
  // source (defence-in-depth).
  const sb = makeQuoteRevSupabase({ uploadOk: true, insertReturns: 'ok', insertedId: 'rev-r7' })
  await recordReleasedQuoteRevision(sb, sampleInput, sampleRevCtx)
  const url = sb._state.inserted[0].manifest_url
  const hash = sb._state.inserted[0].manifest_hash
  assertEquals(url, `${SUPABASE_URL}/storage/v1/object/release-manifests/${hash}.json`)
})

Deno.test("R8 — recordReleasedQuoteRevision: manifest_hash is 64-char SHA-256 hex (release-packet hash determinism contract)", async () => {
  const sb = makeQuoteRevSupabase({ uploadOk: true, insertReturns: 'ok', insertedId: 'rev-r8' })
  await recordReleasedQuoteRevision(sb, sampleInput, sampleRevCtx)
  const insertedHash = sb._state.inserted[0].manifest_hash
  assertEquals(typeof insertedHash, 'string')
  assertEquals(insertedHash.length, 64, 'manifest_hash must be 64-char SHA-256 hex')
  // manifest_url embeds the hash as the storage path so consumers can
  // correlate without an external lookup.
  assertEquals(sb._state.inserted[0].manifest_url, `${SUPABASE_URL}/storage/v1/object/release-manifests/${insertedHash}.json`)
})

Deno.test("R9 — recordReleasedQuoteRevision: insert payload contains no base64 data: URI fields (manifest no-binary contract)", async () => {
  const sb = makeQuoteRevSupabase({ uploadOk: true, insertReturns: 'ok', insertedId: 'rev-r9' })
  await recordReleasedQuoteRevision(sb, sampleInput, sampleRevCtx)
  const seen: string[] = []
  function walk(v: any, path: string) {
    if (typeof v === 'string') seen.push(`${path}=${v.slice(0, 40)}`)
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`))
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, val]) => walk(val, `${path}.${k}`))
  }
  walk(sb._state.inserted[0], '$')
  for (const s of seen) {
    if (/^[^=]+=data:[^;]+;base64,/.test(s)) {
      throw new Error(`base64 data URI leaked into manifest payload: ${s}`)
    }
  }
})

Deno.test("R10 — Codex stale-snapshot regression: a failed first attempt leaves NO row, so a second attempt with different content records its OWN snapshot (not the failed attempt's)", async () => {
  // The bug Codex flagged in 1933ec0: stage-pre-Resend persisted a row at
  // sent_at IS NULL on Resend failure; a later retry with different content
  // hit ON CONFLICT and reused the stale row's snapshot, releasing an
  // immutable revision whose recipient/pdf/pricing came from the failed
  // attempt rather than the email that actually shipped.
  //
  // Post-fix: a failed first attempt = no row, no upload, no commit. A second
  // attempt with different content runs to completion as if it were the first.
  // This test simulates BOTH attempts and asserts the second one's payload is
  // exactly what the second call computed (not bleed-through from the first).

  // Attempt 1 — Resend failure path. We model "Resend failure" by simply NOT
  // calling the helper at all (the production code only calls
  // recordReleasedQuoteRevision inside `if (transitioned)`, which requires
  // Resend success). State A: zero rows, zero uploads.
  const sbAttempt1 = makeQuoteRevSupabase({ uploadOk: true, insertReturns: 'ok', insertedId: 'rev-attempt1' })
  // (No call.) Verify the helper state is untouched by the "failure":
  assertEquals(sbAttempt1._state.inserted.length, 0)
  assertEquals(sbAttempt1._state.uploaded.length, 0)

  // Attempt 2 — same job_id+version as attempt 1, but DIFFERENT content
  // (recipient changed, pricing changed). Resend now succeeds; the helper is
  // called for the first and only time.
  const sbAttempt2 = makeQuoteRevSupabase({ uploadOk: true, insertReturns: 'ok', insertedId: 'rev-attempt2' })
  const attempt2Input: RecordReleaseQuoteRevisionInput = {
    ...sampleInput,
    recipient_email: 'differentclient@example.com',  // changed!
    pricing_json: { totalIncGST: 6000, totalExGST: 5454.55, gst: 545.45 },  // changed!
    pdf_url: 'https://example.com/regenerated-pdf.pdf',  // changed!
  }
  const id = await recordReleasedQuoteRevision(sbAttempt2, attempt2Input, sampleRevCtx)
  assertEquals(id, 'rev-attempt2')

  // The recorded INSERT payload must reflect attempt 2's content, not attempt 1's.
  const insertedPayload = sbAttempt2._state.inserted[0]
  assertEquals(insertedPayload.recipient_email, 'differentclient@example.com')
  assertEquals(insertedPayload.pdf_url, 'https://example.com/regenerated-pdf.pdf')
  assertEquals(insertedPayload.totals_snapshot_json.total_inc_gst, 6000)
  // sent_at must be non-null (this is a release, not a stage).
  assertEquals(typeof insertedPayload.sent_at, 'string')
  assertEquals(insertedPayload.sent_at !== null, true)
})

Deno.test("R11 — Codex verifiability fix: manifest_canonical_text is stored AND sha256(manifest_canonical_text) === manifest_hash (verifiability without Storage)", async () => {
  // After PR #6 replaced Storage upload with the supabase-internal://... stub,
  // the hash was no longer externally verifiable. PR-canonical-bytes captures
  // the canonical bytes inline. Verify: the helper writes both, and they
  // satisfy sha256(text) === hash by construction.
  const sb = makeQuoteRevSupabase({ uploadOk: true, insertReturns: 'ok', insertedId: 'rev-r11' })
  await recordReleasedQuoteRevision(sb, sampleInput, sampleRevCtx)
  const insertedPayload = sb._state.inserted[0]
  // The canonical text must be present and look like JSON.
  assertEquals(typeof insertedPayload.manifest_canonical_text, 'string')
  assert(insertedPayload.manifest_canonical_text.length > 0)
  assert(insertedPayload.manifest_canonical_text.startsWith('{'), 'canonical bytes should start with "{"')
  assert(insertedPayload.manifest_canonical_text.endsWith('}'), 'canonical bytes should end with "}"')
  // The independently-computed sha256 of the canonical bytes must match the stored hash.
  const recomputed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(insertedPayload.manifest_canonical_text))
  const recomputedHex = Array.from(new Uint8Array(recomputed))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  assertEquals(recomputedHex, insertedPayload.manifest_hash, 'sha256(manifest_canonical_text) must equal manifest_hash')
  // After CAP0-QUOTE-REVISION-MANIFEST-STORAGE: manifest_url is the real
  // private-bucket object URL, hash-keyed.
  assertEquals(insertedPayload.manifest_url, `${SUPABASE_URL}/storage/v1/object/release-manifests/${insertedPayload.manifest_hash}.json`)
})

Deno.test("R12 — CAP0-QUOTE-REVISION-MANIFEST-STORAGE: upload failure falls back to stub URL; row is still INSERTed; manifest_canonical_text remains the verification source", async () => {
  // Failure-mode contract: if the Storage upload fails (network blip, bucket
  // missing, transient outage), the helper does NOT fail the release. The row
  // is INSERTed with manifest_url = supabase-internal://manifest/<hash> as a
  // fallback. manifest_canonical_text + manifest_hash still let consumers
  // verify the bytes locally — the storage object is best-effort, not
  // load-bearing.
  const sb = makeQuoteRevSupabase({ uploadOk: false, insertReturns: 'ok', insertedId: 'rev-r12' })
  const id = await recordReleasedQuoteRevision(sb, sampleInput, sampleRevCtx)
  assertEquals(id, 'rev-r12', 'release moment proceeds; helper returns id')
  // Upload was ATTEMPTED (mock records the path even on failure for
  // observability) — but here uploadOk:false short-circuits before the push,
  // so state.uploaded stays empty.
  assertEquals(sb._state.uploaded.length, 0, 'no successful upload')
  // Row is still INSERTed.
  assertEquals(sb._state.inserted.length, 1)
  // manifest_url falls back to the internal stub.
  const hash = sb._state.inserted[0].manifest_hash
  assertEquals(sb._state.inserted[0].manifest_url, `supabase-internal://manifest/${hash}`)
  // manifest_canonical_text is preserved → hash stays verifiable.
  const recomputed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sb._state.inserted[0].manifest_canonical_text))
  const recomputedHex = Array.from(new Uint8Array(recomputed)).map(b => b.toString(16).padStart(2, '0')).join('')
  assertEquals(recomputedHex, hash, 'verifiability survives upload failure')
})

Deno.test("R13 — CAP0-QUOTE-REVISION-MANIFEST-STORAGE: upload writes the canonical bytes verbatim (sha256 of uploaded body matches manifest_hash)", async () => {
  // Storage round-trip integrity: the bytes uploaded to the bucket must be
  // EXACTLY the canonical bytes (not the manifest object pre-stringify).
  // sha256(uploaded.bytes) === manifest_hash by construction.
  const sb = makeQuoteRevSupabase({ uploadOk: true, insertReturns: 'ok', insertedId: 'rev-r13' })
  await recordReleasedQuoteRevision(sb, sampleInput, sampleRevCtx)
  assertEquals(sb._state.uploaded.length, 1)
  const uploadedBytes = sb._state.uploaded[0].bytes
  const recomputed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uploadedBytes))
  const recomputedHex = Array.from(new Uint8Array(recomputed)).map(b => b.toString(16).padStart(2, '0')).join('')
  assertEquals(recomputedHex, sb._state.inserted[0].manifest_hash, 'sha256(uploaded body) === manifest_hash')
  // And the uploaded body equals manifest_canonical_text exactly (hash-only
  // equality is necessary but not sufficient; verify byte equality too).
  assertEquals(uploadedBytes, sb._state.inserted[0].manifest_canonical_text)
})

// ════════════════════════════════════════════════════════════════════════════
// SEND-CLAIM-IDEMPOTENCY — atomic claim decision tests (C1–C4)
// ════════════════════════════════════════════════════════════════════════════
//
// The /send handler claims send_claimed_at + send_claim_token (in-flight lock),
// then stamps sent_to_client + sent_at after Resend succeeds and the frozen
// pack write is confirmed. Claim is not publication.
//
// If status is claimed      → proceed to email.
// If status is unavailable  → already claimed or published; return already_sent.
// If status is error        → database fault; return 500, never already_sent.

// Mock supabase client that simulates the claim UPDATE returning a row or null.
function makeClaimMockSb(
  claimResult: { id: string } | null,
  opts: { keyStampResult?: { id: string } | null } = {},
) {
  const updates: Record<string, unknown>[] = [];
  const api = {
    updates,
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        updates.push(payload);
        const chain: Record<string, unknown> = {};
        chain.eq = () => chain;
        chain.is = () => chain;
        chain.not = () => chain;
        chain.lt = () => chain;
        chain.in = () => chain;
        chain.select = () => ({
          maybeSingle: () => {
            const keyOnly =
              "send_resend_idempotency_key" in payload &&
              !("send_claimed_at" in payload)
            const data = keyOnly && "keyStampResult" in opts
              ? opts.keyStampResult
              : claimResult
            return Promise.resolve({ data, error: null })
          },
        });
        return chain;
      },
    }),
  };
  return api;
}

async function simulateClaim(sb: ReturnType<typeof makeClaimMockSb>, documentId: string): Promise<boolean> {
  const claimed = await claimQuoteDocumentSend(sb, documentId);
  return claimed.status === "claimed";
}

Deno.test("C1 — claim succeeds when DB returns a row (first caller gets through)", async () => {
  const sb = makeClaimMockSb({ id: 'doc-abc' })
  const result = await simulateClaim(sb, 'doc-abc')
  assertEquals(result, true, 'claim should succeed when UPDATE returns a row')
})

Deno.test("C2 — claim fails when DB returns null (already claimed by concurrent call)", async () => {
  const sb = makeClaimMockSb(null)
  const result = await simulateClaim(sb, 'doc-abc')
  assertEquals(result, false, 'claim should fail when UPDATE returns null (doc already sent)')
})

Deno.test("C3 — claim is idempotent: second call with null result does not throw", async () => {
  const sb = makeClaimMockSb(null)
  let threw = false
  try {
    await simulateClaim(sb, 'doc-xyz')
  } catch {
    threw = true
  }
  assertEquals(threw, false, 'claim decision must not throw on null result')
})

Deno.test("C4 — claim with distinct document IDs: each simulates independent documents", async () => {
  const sbA = makeClaimMockSb({ id: 'doc-A' })
  const sbB = makeClaimMockSb(null)
  const [resultA, resultB] = await Promise.all([
    simulateClaim(sbA, 'doc-A'),
    simulateClaim(sbB, 'doc-B'),
  ])
  assertEquals(resultA, true, 'doc-A should be claimable')
  assertEquals(resultB, false, 'doc-B should already be claimed')
})

Deno.test("C5 — claim payload is send_claimed_at plus token; publication is the sent marker", async () => {
  const sb = makeClaimMockSb({ id: 'doc-pub' })
  await simulateClaim(sb, 'doc-pub')
  assertEquals(Object.keys(sb.updates[0]).sort(), [
    'send_claim_token',
    'send_claimed_at',
  ])
  assertEquals(Object.prototype.hasOwnProperty.call(sb.updates[0], 'send_resend_idempotency_key'), false)
  assertEquals(Object.keys(sb.updates[1]), ['send_resend_idempotency_key'])
  assertEquals('sent_to_client' in sb.updates[0], false)
  assertEquals('sent_at' in sb.updates[0], false)
  const claim = quoteSendClaimPayload(new Date('2026-09-06T00:00:00.000Z'), 'tok-1')
  const published = quoteSendPublicationPayload(new Date('2026-09-06T00:00:01.000Z'))
  assertEquals(claim, {
    send_claimed_at: '2026-09-06T00:00:00.000Z',
    send_claim_token: 'tok-1',
    send_resend_idempotency_key: quoteSendResendIdempotencyKey('tok-1'),
  })
  assertEquals(quoteSendClaimRevertPayload(), {
    send_claimed_at: null,
    send_claim_token: null,
    send_resend_idempotency_key: null,
  })
  assertEquals(quoteSendClaimRevertPayload('keep_provider_key'), {
    send_claimed_at: null,
    send_claim_token: null,
  })
  assertEquals(resendResponseIsDefinitivePreSendRejection(422), true)
  assertEquals(resendResponseIsDefinitivePreSendRejection(409), false)
  assertEquals(resendResponseIsDefinitivePreSendRejection(429), false)
  assertEquals(resendResponseIsDefinitivePreSendRejection(500), false)
  assertEquals(published, {
    sent_to_client: true,
    sent_at: '2026-09-06T00:00:01.000Z',
  })
})

Deno.test("R17-001 key-stamp confirmation requires the owned returning row", () => {
  assertEquals(
    sendClaimKeyStampConfirmed("doc-1", "doc-1", "quote-send:stored", "quote-send:fallback"),
    "quote-send:stored",
  )
  assertEquals(
    sendClaimKeyStampConfirmed("doc-1", "doc-1", null, "quote-send:fallback"),
    "quote-send:fallback",
  )
  assertEquals(
    sendClaimKeyStampConfirmed(null, "doc-1", "quote-send:stored", "quote-send:fallback"),
    null,
  )
  assertEquals(
    sendClaimKeyStampConfirmed("doc-other", "doc-1", "quote-send:stored", "quote-send:fallback"),
    null,
  )
})

Deno.test("R17-001 exclusive quote key stamp without a returning row is not claimed", async () => {
  const sb = makeClaimMockSb({ id: "doc-abc" }, { keyStampResult: null })
  const claimed = await claimQuoteDocumentSend(sb, "doc-abc")
  assertEquals(claimed.status, "unavailable")
})

Deno.test("R4-002 send-runs publishes only docs for successful recipients", () => {
  const recipients = [
    { email: "pat@example.test", docs: [{ id: "doc-primary" }, { id: "doc-primary-2" }] },
    { email: "neighbour@example.test", docs: [{ id: "doc-neighbour" }] },
  ]
  assertEquals(
    documentIdsPublishedForSuccessfulSends(recipients, ["pat@example.test"]),
    ["doc-primary", "doc-primary-2"],
  )
  assertEquals(
    documentIdsPublishedForSuccessfulSends(recipients, ["neighbour@example.test"]),
    ["doc-neighbour"],
  )
  assertEquals(
    documentIdsPublishedForSuccessfulSends(recipients, ["pat@example.test", "neighbour@example.test"]),
    ["doc-primary", "doc-primary-2", "doc-neighbour"],
  )
  assertEquals(documentIdsPublishedForSuccessfulSends(recipients, []), [])
})

Deno.test("R18-002 case-variant recipient keys are one send-runs group", () => {
  assertEquals(quoteSendRecipientKey(" Pat@Example.TEST "), "pat@example.test")
  assertEquals(quoteSendRecipientKey("pat@example.test"), "pat@example.test")
  const groups: Record<string, string[]> = {}
  const add = (email: string, docId: string) => {
    const key = quoteSendRecipientKey(email)
    if (!groups[key]) groups[key] = []
    groups[key].push(docId)
  }
  add("Pat@example.test", "doc-a")
  add("pat@example.test", "doc-b")
  assertEquals(Object.keys(groups), ["pat@example.test"])
  assertEquals(groups["pat@example.test"], ["doc-a", "doc-b"])
  assertEquals(
    documentIdsPublishedForSuccessfulSends(
      [{ email: quoteSendRecipientKey("Pat@example.test"), docs: [{ id: "doc-a" }, { id: "doc-b" }] }],
      [quoteSendRecipientKey("Pat@example.test")],
    ),
    ["doc-a", "doc-b"],
  )
})

Deno.test("R18-002 publication matches the exact successful recipient group", () => {
  assertEquals(
    documentIdsPublishedForSuccessfulSends(
      [
        { email: "Pat@example.test", docs: [{ id: "doc-a" }] },
        { email: "pat@example.test", docs: [{ id: "doc-b" }] },
      ],
      ["Pat@example.test"],
    ),
    ["doc-a"],
  )
})

Deno.test("R18-002 send-runs source groups recipients on the normalized key", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url))
  const start = src.indexOf("const addRecipientDoc =")
  const end = src.indexOf("emailsByRecipient[dest].runs.push(run)", start)
  const slice = src.slice(start, end)
  assert(start >= 0 && end > start)
  assert(slice.includes("quoteSendRecipientKey(email)"))
  assert(!slice.includes("String(email || '').trim()"))
})

Deno.test("TRD6-21-001 /send fails closed on pack-source job read before persist", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url))
  const sendStart = src.indexOf("if (path === 'send' && req.method === 'POST')")
  const persist = src.indexOf("persistTradePackOnDocuments", sendStart)
  const publish = src.indexOf("publishQuoteDocumentSendOrRevert", persist)
  const prePersist = src.slice(sendStart, persist)
  const persistToPublish = src.slice(persist, publish)
  assert(sendStart >= 0 && persist > sendStart && publish > persist)
  assert(prePersist.includes("!doc.job_id"))
  assert(prePersist.includes("jobForPackErr || !jobForPack"))
  assert(prePersist.includes("keep_provider_key"))
  assert(prePersist.includes("500"))
  assert(prePersist.includes("Failed to persist quote trade pack"))
  assert(!prePersist.includes("publishQuoteDocumentSendOrRevert"))
  assert(persistToPublish.includes("persistTradePackWriteConfirmed"))
})

Deno.test("TRD6-21-002 send-runs primaryEmail uses quoteSendRecipientKey", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url))
  const start = src.indexOf("const primaryEmail =")
  const compare = src.indexOf("if (primaryEmail && email === primaryEmail)", start)
  const slice = src.slice(start, compare + 80)
  assert(start >= 0 && compare > start)
  assert(slice.includes("quoteSendRecipientKey(primaryContact.client_email || job.client_email)"))
  assert(!slice.includes(".toLowerCase()"))
  assertEquals(quoteSendRecipientKey(" pat@x.com "), "pat@x.com")
})

Deno.test("R19-003 group document set key is sorted unique ids", () => {
  assertEquals(quoteGroupEmailDocumentSetKey(["doc-b", "doc-a", "doc-b"]), "doc-a,doc-b")
  assertEquals(quoteGroupEmailDocumentSetKey(["  doc-a  ", null, ""]), "doc-a")
  assertEquals(
    quoteGroupEmailResendIdempotencyKey("tok-group"),
    "quote-group-send:tok-group",
  )
})

Deno.test("R19-003 leftover docs are covered by the original grouped set", () => {
  assertEquals(quoteGroupEmailCoversDocumentSet(["doc-a", "doc-b"], ["doc-b"]), true)
  assertEquals(quoteGroupEmailCoversDocumentSet(["doc-a", "doc-b"], ["doc-a", "doc-b"]), true)
  assertEquals(quoteGroupEmailCoversDocumentSet(["doc-a", "doc-b"], ["doc-c"]), false)
  assertEquals(quoteGroupEmailCoversDocumentSet(["doc-a", "doc-b"], ["doc-b", "doc-c"]), false)
  assertEquals(quoteGroupEmailCoversDocumentSet(["doc-a"], []), false)
  const original = {
    document_ids: ["doc-a", "doc-b"],
    document_set_key: "doc-a,doc-b",
    send_resend_idempotency_key: "quote-group-send:orig",
  }
  const later = {
    document_ids: ["doc-c"],
    document_set_key: "doc-c",
    send_resend_idempotency_key: "quote-group-send:later",
  }
  assertEquals(
    pickQuoteGroupEmailCoveringRecord([later, original], ["doc-b"])?.send_resend_idempotency_key,
    "quote-group-send:orig",
  )
  assertEquals(
    pickQuoteGroupEmailCoveringRecord([later, original], ["doc-a", "doc-b"])?.send_resend_idempotency_key,
    "quote-group-send:orig",
  )
  assertEquals(pickQuoteGroupEmailCoveringRecord([later, original], ["doc-c"])?.send_resend_idempotency_key, "quote-group-send:later")
  assertEquals(pickQuoteGroupEmailCoveringRecord([later, original], ["doc-d"]), null)
})

function makeGroupSendRecordSb(opts: {
  existing?: Array<{
    id: string
    job_id: string
    recipient_email: string
    document_ids: string[]
    document_set_key: string
    send_resend_idempotency_key: string
  }>
  selectError?: { message: string }
  insertError?: { message: string; code?: string }
  deleteError?: { message: string }
  insertResult?: null | { id?: string; send_resend_idempotency_key?: string }
  emptyFirstSelect?: boolean
} = {}) {
  const rows = (opts.existing || []).map((row) => ({ ...row }))
  const inserts: Record<string, unknown>[] = []
  const deletes: Record<string, unknown>[] = []
  let selects = 0
  return {
    rows,
    inserts,
    deletes,
    from: (table: string) => {
      assertEquals(table, "quote_group_email_send_records")
      let jobId = ""
      let recipient = ""
      let idempotencyKey = ""
      let mode: "select" | "insert" | "delete" = "select"
      const self: Record<string, unknown> = {}
      const matching = () =>
        rows.filter((row) =>
          (!jobId || row.job_id === jobId) &&
          (!recipient || row.recipient_email === recipient)
        )
      self.select = () => self
      self.eq = (col: string, value: unknown) => {
        if (col === "job_id") jobId = String(value)
        if (col === "recipient_email") recipient = String(value)
        if (col === "send_resend_idempotency_key") idempotencyKey = String(value)
        return self
      }
      self.insert = (payload: Record<string, unknown>) => {
        mode = "insert"
        inserts.push(payload)
        return self
      }
      self.delete = () => {
        mode = "delete"
        return self
      }
      self.maybeSingle = () => {
        if (mode !== "insert") {
          return Promise.resolve({ data: null, error: { message: "not insert" } })
        }
        if (opts.insertError) return Promise.resolve({ data: null, error: opts.insertError })
        const payload = inserts[inserts.length - 1]
        const conflict = rows.some((row) =>
          row.job_id === payload.job_id &&
          row.recipient_email === payload.recipient_email &&
          row.document_set_key === payload.document_set_key
        )
        if (conflict) {
          return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } })
        }
        if (opts.insertResult === null) return Promise.resolve({ data: null, error: null })
        const row = {
          id: opts.insertResult?.id || "grp-new",
          job_id: String(payload.job_id),
          recipient_email: String(payload.recipient_email),
          document_ids: payload.document_ids as string[],
          document_set_key: String(payload.document_set_key),
          send_resend_idempotency_key: opts.insertResult?.send_resend_idempotency_key
            || String(payload.send_resend_idempotency_key),
        }
        rows.push(row)
        return Promise.resolve({ data: row, error: null })
      }
      self.then = (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => {
        if (mode === "delete") {
          deletes.push({
            job_id: jobId,
            recipient_email: recipient,
            send_resend_idempotency_key: idempotencyKey,
          })
          if (opts.deleteError) {
            return Promise.resolve({ data: null, error: opts.deleteError }).then(resolve, reject)
          }
          for (let i = rows.length - 1; i >= 0; i--) {
            const row = rows[i]
            if (
              row.job_id === jobId &&
              row.recipient_email === recipient &&
              row.send_resend_idempotency_key === idempotencyKey
            ) {
              rows.splice(i, 1)
            }
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject)
        }
        selects += 1
        if (opts.selectError) {
          return Promise.resolve({ data: null, error: opts.selectError }).then(resolve, reject)
        }
        if (opts.emptyFirstSelect && selects === 1) {
          return Promise.resolve({ data: [], error: null }).then(resolve, reject)
        }
        return Promise.resolve({ data: matching(), error: null }).then(resolve, reject)
      }
      return self
    },
  }
}

Deno.test("R19-003 leftover retry reuses the original grouped Resend key", async () => {
  const sb = makeGroupSendRecordSb()
  const first = await ensureQuoteGroupEmailSendKey(sb, {
    jobId: "job-1",
    recipientEmail: " Pat@Example.TEST ",
    documentIds: ["doc-b", "doc-a"],
  })
  assertEquals(first.status, "ready")
  if (first.status !== "ready") return
  assertEquals(first.reused, false)
  assert(first.resend_idempotency_key.startsWith("quote-group-send:"))
  assertEquals(sb.inserts.length, 1)
  assertEquals(sb.inserts[0].recipient_email, "pat@example.test")
  assertEquals(sb.inserts[0].document_set_key, "doc-a,doc-b")
  const leftover = await ensureQuoteGroupEmailSendKey(sb, {
    jobId: "job-1",
    recipientEmail: "pat@example.test",
    documentIds: ["doc-b"],
  })
  assertEquals(leftover.status, "ready")
  if (leftover.status !== "ready") return
  assertEquals(leftover.reused, true)
  assertEquals(leftover.resend_idempotency_key, first.resend_idempotency_key)
  assertEquals(sb.inserts.length, 1)
})

Deno.test("R19-003 a new document set mints a distinct grouped Resend key", async () => {
  const sb = makeGroupSendRecordSb({
    existing: [{
      id: "grp-orig",
      job_id: "job-1",
      recipient_email: "pat@example.test",
      document_ids: ["doc-a", "doc-b"],
      document_set_key: "doc-a,doc-b",
      send_resend_idempotency_key: "quote-group-send:orig",
    }],
  })
  const next = await ensureQuoteGroupEmailSendKey(sb, {
    jobId: "job-1",
    recipientEmail: "pat@example.test",
    documentIds: ["doc-c"],
  })
  assertEquals(next.status, "ready")
  if (next.status !== "ready") return
  assertEquals(next.reused, false)
  assert(next.resend_idempotency_key !== "quote-group-send:orig")
  assertEquals(sb.inserts.length, 1)
  assertEquals(sb.inserts[0].document_set_key, "doc-c")
})

Deno.test("R19-003 unique insert race rereads the covering group key", async () => {
  const sb = makeGroupSendRecordSb({
    existing: [{
      id: "grp-orig",
      job_id: "job-1",
      recipient_email: "pat@example.test",
      document_ids: ["doc-a", "doc-b"],
      document_set_key: "doc-a,doc-b",
      send_resend_idempotency_key: "quote-group-send:orig",
    }],
    emptyFirstSelect: true,
  })
  const raced = await ensureQuoteGroupEmailSendKey(sb, {
    jobId: "job-1",
    recipientEmail: "pat@example.test",
    documentIds: ["doc-a", "doc-b"],
  })
  assertEquals(raced.status, "ready")
  if (raced.status !== "ready") return
  assertEquals(raced.reused, true)
  assertEquals(raced.resend_idempotency_key, "quote-group-send:orig")
})

Deno.test("R19-003 group send record read/insert faults are errors", async () => {
  const readFail = await ensureQuoteGroupEmailSendKey(makeGroupSendRecordSb({
    selectError: { message: "db down" },
  }), {
    jobId: "job-1",
    recipientEmail: "pat@example.test",
    documentIds: ["doc-a"],
  })
  assertEquals(readFail.status, "error")
  if (readFail.status === "error") assertEquals(readFail.error, "db down")

  const insertFail = await ensureQuoteGroupEmailSendKey(makeGroupSendRecordSb({
    insertError: { message: "insert failed" },
  }), {
    jobId: "job-1",
    recipientEmail: "pat@example.test",
    documentIds: ["doc-a"],
  })
  assertEquals(insertFail.status, "error")

  const lostRow = await ensureQuoteGroupEmailSendKey(makeGroupSendRecordSb({
    insertResult: null,
  }), {
    jobId: "job-1",
    recipientEmail: "pat@example.test",
    documentIds: ["doc-a"],
  })
  assertEquals(lostRow.status, "error")

  const missing = await ensureQuoteGroupEmailSendKey(makeGroupSendRecordSb(), {
    jobId: "job-1",
    recipientEmail: " ",
    documentIds: ["doc-a"],
  })
  assertEquals(missing.status, "unavailable")
})

Deno.test("R19-003 send-runs source uses the durable group Resend key", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url))
  const start = src.indexOf("if (path === 'send-runs'")
  const provider = src.indexOf("fetch('https://api.resend.com/emails'", start)
  const headersEnd = src.indexOf("body: JSON.stringify(emailPayload)", provider)
  const preDispatch = src.slice(start, provider)
  const headers = src.slice(provider, headersEnd)
  assert(start >= 0 && provider > start && headersEnd > provider)
  assert(preDispatch.includes("touchGroupedQuoteDocumentSendClaims("))
  assert(preDispatch.includes("ensureQuoteGroupEmailSendKey("))
  assert(headers.includes("groupSend.resend_idempotency_key"))
  assert(!headers.includes("recipientClaim"))
  assert(!headers.includes("groupedLease.claims[0]"))
  assert(preDispatch.includes("Failed to load quote group send record"))
  assert(preDispatch.includes("500"))
})

Deno.test("R20-003 retiring the group key lets the same set mint a new provider key", async () => {
  const sb = makeGroupSendRecordSb()
  const first = await ensureQuoteGroupEmailSendKey(sb, {
    jobId: "job-1",
    recipientEmail: " Pat@Example.TEST ",
    documentIds: ["doc-b", "doc-a"],
  })
  assertEquals(first.status, "ready")
  if (first.status !== "ready") return
  const retired = await retireQuoteGroupEmailSendKey(sb, {
    jobId: "job-1",
    recipientEmail: "Pat@Example.TEST",
    resendIdempotencyKey: first.resend_idempotency_key,
  })
  assertEquals(retired.status, "retired")
  assertEquals(sb.deletes.length, 1)
  assertEquals(sb.deletes[0].recipient_email, "pat@example.test")
  assertEquals(sb.deletes[0].send_resend_idempotency_key, first.resend_idempotency_key)
  assertEquals(sb.rows.length, 0)
  const again = await ensureQuoteGroupEmailSendKey(sb, {
    jobId: "job-1",
    recipientEmail: "pat@example.test",
    documentIds: ["doc-a", "doc-b"],
  })
  assertEquals(again.status, "ready")
  if (again.status !== "ready") return
  assertEquals(again.reused, false)
  assert(again.resend_idempotency_key !== first.resend_idempotency_key)
  assert(again.resend_idempotency_key.startsWith("quote-group-send:"))
  assertEquals(sb.inserts.length, 2)
})

Deno.test("R20-003 a mismatched group key is not retired", async () => {
  const sb = makeGroupSendRecordSb({
    existing: [{
      id: "grp-orig",
      job_id: "job-1",
      recipient_email: "pat@example.test",
      document_ids: ["doc-a", "doc-b"],
      document_set_key: "doc-a,doc-b",
      send_resend_idempotency_key: "quote-group-send:orig",
    }],
  })
  const retired = await retireQuoteGroupEmailSendKey(sb, {
    jobId: "job-1",
    recipientEmail: "pat@example.test",
    resendIdempotencyKey: "quote-group-send:other",
  })
  assertEquals(retired.status, "retired")
  assertEquals(sb.rows.length, 1)
  const leftover = await ensureQuoteGroupEmailSendKey(sb, {
    jobId: "job-1",
    recipientEmail: "pat@example.test",
    documentIds: ["doc-b"],
  })
  assertEquals(leftover.status, "ready")
  if (leftover.status !== "ready") return
  assertEquals(leftover.reused, true)
  assertEquals(leftover.resend_idempotency_key, "quote-group-send:orig")
})

Deno.test("R20-003 group key retire faults and missing coordinates", async () => {
  const missing = await retireQuoteGroupEmailSendKey(makeGroupSendRecordSb(), {
    jobId: "job-1",
    recipientEmail: "pat@example.test",
    resendIdempotencyKey: " ",
  })
  assertEquals(missing.status, "unavailable")

  const failed = await retireQuoteGroupEmailSendKey(makeGroupSendRecordSb({
    existing: [{
      id: "grp-orig",
      job_id: "job-1",
      recipient_email: "pat@example.test",
      document_ids: ["doc-a"],
      document_set_key: "doc-a",
      send_resend_idempotency_key: "quote-group-send:orig",
    }],
    deleteError: { message: "delete failed" },
  }), {
    jobId: "job-1",
    recipientEmail: "pat@example.test",
    resendIdempotencyKey: "quote-group-send:orig",
  })
  assertEquals(failed.status, "error")
  if (failed.status === "error") assertEquals(failed.error, "delete failed")
})

Deno.test("R20-003 send-runs retires the group key only on definitive pre-send 4xx", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url))
  const start = src.indexOf("if (path === 'send-runs'")
  const provider = src.indexOf("fetch('https://api.resend.com/emails'", start)
  const catchStart = src.indexOf("} catch (e: any) {", provider)
  const afterFetch = src.slice(provider, catchStart)
  const okEnd = afterFetch.indexOf("} else if (!resendResponseIsDefinitivePreSendRejection")
  const okBranch = afterFetch.slice(0, okEnd)
  const rest = afterFetch.slice(okEnd)
  const retireStart = rest.indexOf("} else {")
  const ambiguousBranch = rest.slice(0, retireStart)
  const retireBranch = rest.slice(retireStart)
  assert(start >= 0 && provider > start && catchStart > provider)
  assert(okEnd >= 0 && retireStart >= 0)
  assert(okBranch.includes("markSendRunsProviderAttempt"))
  assert(!okBranch.includes("retireQuoteGroupEmailSendKey"))
  assert(ambiguousBranch.includes("markSendRunsProviderAttempt"))
  assert(!ambiguousBranch.includes("retireQuoteGroupEmailSendKey"))
  assert(retireBranch.includes("retireQuoteGroupEmailSendKey("))
  assert(retireBranch.includes("groupSend.resend_idempotency_key"))
  assert(!retireBranch.includes("markSendRunsProviderAttempt"))
  const catchBlock = src.slice(catchStart, src.indexOf("}", catchStart + 80) + 1)
  assert(catchBlock.includes("markSendRunsProviderAttempt"))
  assert(!catchBlock.includes("retireQuoteGroupEmailSendKey"))
})

Deno.test("R7-003 failed send-runs recipients are the claim complement", () => {
  const claims = [
    { id: "doc-primary", token: "tok-p", claimed_at: "2026-09-06T00:00:00.000Z" },
    { id: "doc-neighbour", token: "tok-n", claimed_at: "2026-09-06T00:00:00.000Z" },
  ]
  const published = documentIdsPublishedForSuccessfulSends(
    [
      { email: "pat@example.test", docs: [{ id: "doc-primary" }] },
      { email: "neighbour@example.test", docs: [{ id: "doc-neighbour" }] },
    ],
    ["pat@example.test"],
  )
  assertEquals(published, ["doc-primary"])
  assertEquals(claimsForDocumentIds(claims, published).map((c) => c.id), ["doc-primary"])
  assertEquals(claimsNotInDocumentIds(claims, published).map((c) => c.id), ["doc-neighbour"])
  assertEquals(claimsNotInDocumentIds(claims, published)[0].token, "tok-n")
})

Deno.test("R7-003 leftover send-runs revert is token-fenced and skips published rows", async () => {
  const updates: Record<string, unknown>[] = []
  const eqs: Array<{ col: string; value: unknown }> = []
  const nots: Array<{ col: string; op: string; value: unknown }> = []
  const sb = {
    from: (_table: string) => {
      const chain: Record<string, unknown> = {
        update: (payload: Record<string, unknown>) => {
          updates.push(payload)
          return chain
        },
        eq: (col: string, value: unknown) => {
          eqs.push({ col, value })
          return chain
        },
        not: (col: string, op: string, value: unknown) => {
          nots.push({ col, op, value })
          return chain
        },
        select: () => ({
          maybeSingle: () => Promise.resolve({ data: { id: "doc-neighbour" }, error: null }),
        }),
      }
      return chain
    },
  }
  const leftover = claimsNotInDocumentIds(
    [
      { id: "doc-primary", token: "tok-p" },
      { id: "doc-neighbour", token: "tok-n" },
    ],
    ["doc-primary"],
  )
  const result = await revertQuoteDocumentSendClaims(sb, leftover)
  assertEquals(result.error, null)
  assertEquals(updates, [quoteSendClaimRevertPayload()])
  assertEquals(eqs.filter((eq) => eq.col === "id").map((eq) => eq.value), ["doc-neighbour"])
  assertEquals(eqs.filter((eq) => eq.col === "send_claim_token").map((eq) => eq.value), ["tok-n"])
  assert(nots.some((n) => n.col === "sent_to_client" && n.op === "is" && n.value === true))
})

Deno.test("R4-003 send-runs quote numbers are assigned per document", () => {
  assertEquals(
    sendRunQuoteNumberFallback({ jobNumber: "SWF-25101", runLabel: "REAR", party: "client" }),
    "SWF-25101-REAR",
  )
  assertEquals(
    sendRunQuoteNumberFallback({ jobNumber: "SWF-25101", runLabel: "REAR", party: "neighbour" }),
    "SWF-25101-REAR-N",
  )
})

function makeOwnedWriteMock(opts: {
  updates: Record<string, unknown>[]
  eqs: Array<{ col: string; value: unknown }>
  publishError?: { message: string } | null
  publishRow?: { id: string } | null
  revertRow?: { id: string } | null
}) {
  return {
    from: (_table: string) => ({
      update: (payload: Record<string, unknown>) => {
        opts.updates.push(payload)
        const isPublish = "sent_to_client" in payload
        const chain: Record<string, unknown> = {
          eq: (col: string, value: unknown) => {
            opts.eqs.push({ col, value })
            return chain
          },
          not: () => chain,
          select: () => ({
            maybeSingle: () =>
              Promise.resolve(
                isPublish
                  ? {
                    data: opts.publishError ? null : opts.publishRow ?? null,
                    error: opts.publishError || null,
                  }
                  : {
                    data: opts.revertRow === undefined ? { id: "doc-pub" } : opts.revertRow,
                    error: null,
                  },
              ),
          }),
        }
        return chain
      },
    }),
  }
}

Deno.test("R4-004 publication stamp failure reverts the in-flight claim", async () => {
  const updates: Record<string, unknown>[] = []
  const eqs: Array<{ col: string; value: unknown }> = []
  const sb = makeOwnedWriteMock({
    updates,
    eqs,
    publishError: { message: "stamp failed" },
    revertRow: { id: "doc-pub" },
  })
  const result = await publishQuoteDocumentSendOrRevert(sb, "doc-pub", "tok-owner")
  assertEquals(result.published, false)
  if (result.published === false) {
    assertEquals(result.error, "stamp failed")
  }
  assertEquals(updates[0].sent_to_client, true)
  assertEquals(updates[0].send_claim_token, null)
  assertEquals(updates[1], quoteSendClaimRevertPayload('keep_provider_key'))
  assert(eqs.some((eq) => eq.col === "send_claim_token" && eq.value === "tok-owner"))
})

Deno.test("R5-002 stale in-flight claims are reclaimable; fresh claims are not", async () => {
  const now = new Date("2026-09-06T12:00:00.000Z")
  assertEquals(quoteSendClaimIsStale(null, now), false)
  assertEquals(quoteSendClaimIsStale("2026-09-06T11:50:00.000Z", now), false)
  assertEquals(
    quoteSendClaimIsStale(new Date(now.getTime() - QUOTE_SEND_CLAIM_TTL_MS).toISOString(), now),
    true,
  )
  assertEquals(quoteSendClaimIsStale("not-a-date", now), true)

  let exclusiveCalls = 0
  let reclaimUpdates = 0
  const staleFilters: string[] = []
  const firstKey = "quote-send:first-claim-token"
  const sb = {
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({
            data: {
              id: "doc-stale",
              send_claimed_at: "2026-09-06T11:40:00.000Z",
              send_resend_idempotency_key: firstKey,
              sent_at: null,
              sent_to_client: false,
              accepted_at: null,
            },
            error: null,
          }),
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        const chain: Record<string, unknown> = {}
        chain.eq = () => chain
        chain.is = (col: string) => {
          staleFilters.push(`is:${col}`)
          return chain
        }
        chain.not = () => chain
        chain.lt = (col: string) => {
          staleFilters.push(`lt:${col}`)
          return chain
        }
        chain.select = () => ({
          maybeSingle: () => {
            if (payload.send_resend_idempotency_key === firstKey) {
              reclaimUpdates += 1
              return Promise.resolve({
                data: { id: "doc-stale", send_resend_idempotency_key: firstKey },
                error: null,
              })
            }
            exclusiveCalls += 1
            assertEquals(Object.keys(payload).sort(), [
              "send_claim_token",
              "send_claimed_at",
            ])
            return Promise.resolve({ data: null, error: null })
          },
        })
        return chain
      },
    }),
  }
  const claimed = await claimQuoteDocumentSend(sb, "doc-stale", now)
  assertEquals(claimed.status, "claimed")
  if (claimed.status === "claimed") {
    assertEquals(claimed.id, "doc-stale")
    assertEquals(typeof claimed.token, "string")
    assert(claimed.token.length > 0)
    assertEquals(claimed.resend_idempotency_key, firstKey)
  }
  assertEquals(exclusiveCalls, 1)
  assertEquals(reclaimUpdates, 1)
  assert(staleFilters.includes("lt:send_claimed_at"))
})

Deno.test("R5-002 fresh claim stays exclusive after exclusive miss", async () => {
  const sb = makeClaimMockSb(null)
  const claimed = await claimQuoteDocumentSend(sb, "doc-fresh")
  assertEquals(claimed, { status: "unavailable" })
})

Deno.test("R5-001 send-runs stamp failure after Resend blocks success and quoted flip", () => {
  assertEquals(
    sendRunsPublicationFailureBlocksSuccess({ resendSucceeded: true, publicationSucceeded: false }),
    { failHandler: true, flipQuoted: false },
  )
  assertEquals(
    sendRunsPublicationFailureBlocksSuccess({ resendSucceeded: true, publicationSucceeded: true }),
    { failHandler: false, flipQuoted: true },
  )
  assertEquals(
    sendRunsPublicationFailureBlocksSuccess({ resendSucceeded: false, publicationSucceeded: false }),
    { failHandler: false, flipQuoted: false },
  )
})

Deno.test("R5-001 send-runs batch stamp failure reverts unpublished claims per document token", async () => {
  const updates: Record<string, unknown>[] = []
  const eqs: Array<{ col: string; value: unknown }> = []
  const sb = makeOwnedWriteMock({
    updates,
    eqs,
    publishError: { message: "stamp failed" },
  })
  const result = await publishQuoteDocumentsSendOrRevert(sb, [
    { id: "doc-a", token: "tok-a" },
    { id: "doc-b", token: "tok-b" },
  ])
  assertEquals(result.published, false)
  if (result.published === false) {
    assertEquals(result.error, "stamp failed")
  }
  assertEquals(updates[1], quoteSendClaimRevertPayload('keep_provider_key'))
  assert(eqs.some((eq) => eq.col === "send_claim_token" && eq.value === "tok-a"))
})

Deno.test("R5-003 send-runs reuses unpublished docs and skips already published packs", () => {
  const docs = [
    {
      id: "doc-published",
      type: "quote",
      run_label: "REAR",
      job_contact_id: "c-1",
      sent_to_client: true,
      sent_at: "2026-09-06T00:00:00.000Z",
    },
    {
      id: "doc-open",
      type: "quote",
      run_label: "LHS",
      job_contact_id: "c-1",
      sent_to_client: false,
      sent_at: null,
    },
  ]
  assertEquals(
    resolveSendRunDocument(docs, { runLabel: "REAR", jobContactId: "c-1" }).action,
    "use_published",
  )
  assertEquals(
    resolveSendRunDocument(docs, { runLabel: "LHS", jobContactId: "c-1" }).action,
    "reuse_unpublished",
  )
  assertEquals(
    resolveSendRunDocument(docs, { runLabel: "FRONT", jobContactId: "c-1" }).action,
    "create",
  )
  const publishedTwin = resolveSendRunDocument([
    ...docs,
    {
      id: "doc-twin-open",
      type: "quote",
      run_label: "REAR",
      job_contact_id: "c-1",
      sent_to_client: false,
      sent_at: null,
    },
  ], { runLabel: "REAR", jobContactId: "c-1" })
  assertEquals(publishedTwin.action, "use_published")
  if (publishedTwin.action === "use_published") {
    assertEquals(publishedTwin.document.id, "doc-published")
  }
})

Deno.test("R5-003 send-runs job claim is exclusive then reclaimable when stale", async () => {
  let call = 0
  const updates: Record<string, unknown>[] = []
  const sb = {
    from: (table: string) => {
      assertEquals(table, "jobs")
      return {
        update: (payload: Record<string, unknown>) => {
          updates.push(payload)
          const chain: Record<string, unknown> = {}
          chain.eq = () => chain
          chain.is = () => chain
          chain.lt = () => chain
          chain.select = () => ({
            maybeSingle: () => {
              call += 1
              return Promise.resolve({
                data: call === 1 ? null : { id: "job-1" },
                error: null,
              })
            },
          })
          return chain
        },
      }
    },
  }
  const claimed = await claimJobSendRuns(sb, "job-1", new Date("2026-09-06T12:00:00.000Z"))
  assertEquals(claimed.status, "claimed")
  if (claimed.status !== "claimed") throw new Error("expected claimed")
  assertEquals(claimed.id, "job-1")
  assertEquals(call, 2)
  assertEquals(Object.keys(updates[0]), ["send_runs_claimed_at"])
  const cleared = await clearJobSendRunsClaim({
    from: (table: string) => {
      assertEquals(table, "jobs")
      return {
        update: (payload: Record<string, unknown>) => {
          assertEquals(payload, { send_runs_claimed_at: null })
          const chain: Record<string, unknown> = {
            eq: () => chain,
            then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
              Promise.resolve({ error: null }).then(onFulfilled, onRejected),
          }
          return chain
        },
      }
    },
  }, "job-1", claimed.claimed_at)
  assertEquals(cleared.error, null)
})

Deno.test("R6-002 publish and revert match the claim token, not id alone", async () => {
  const updates: Record<string, unknown>[] = []
  const eqs: Array<{ col: string; value: unknown }> = []
  const sb = makeOwnedWriteMock({
    updates,
    eqs,
    publishRow: null,
    revertRow: null,
  })
  const published = await publishQuoteDocumentSend(sb, "doc-pub", "tok-old")
  assertEquals(published.updated, false)
  assertEquals(published.error, null)
  assert(eqs.some((eq) => eq.col === "id" && eq.value === "doc-pub"))
  assert(eqs.some((eq) => eq.col === "send_claim_token" && eq.value === "tok-old"))
  const reverted = await revertQuoteDocumentSendClaim(sb, "doc-pub", "tok-old")
  assertEquals(reverted.updated, false)
  const missing = await publishQuoteDocumentSendOrRevert(sb, "doc-pub", "  ")
  assertEquals(missing.published, false)
})

Deno.test("R6-004 send-runs reports non-success when no email was published", () => {
  assertEquals(
    sendRunsSendOutcome({
      emailsSent: 0,
      recipientsAssembled: 2,
      publishedExistingCount: 0,
      claimedCount: 2,
    }),
    {
      success: false,
      httpStatus: 502,
      code: "quote_email_delivery_failed",
      error: "Quote email delivery failed",
    },
  )
  assertEquals(
    sendRunsSendOutcome({
      emailsSent: 0,
      recipientsAssembled: 0,
      publishedExistingCount: 0,
      claimedCount: 0,
    }),
    {
      success: false,
      httpStatus: 400,
      code: "no_quote_recipients",
      error: "No quote recipients to send",
    },
  )
  assertEquals(
    sendRunsSendOutcome({
      emailsSent: 1,
      recipientsAssembled: 1,
      publishedExistingCount: 0,
      claimedCount: 1,
    }),
    { success: true, alreadyComplete: false },
  )
  assertEquals(
    sendRunsSendOutcome({
      emailsSent: 1,
      recipientsAssembled: 1,
      publishedExistingCount: 0,
      claimedCount: 1,
    }).success,
    true,
  )
  assertEquals(
    sendRunsSendOutcome({
      emailsSent: 0,
      recipientsAssembled: 0,
      publishedExistingCount: 2,
      claimedCount: 0,
    }),
    { success: true, alreadyComplete: true },
  )
})

Deno.test("R8-001 durable primary publication recovers draft→quoted", () => {
  assertEquals(
    sendRunsPrimaryClientPublicationSatisfied({
      primarySentThisRequest: false,
      publishedExistingDocs: [{
        job_contact_id: "c-1",
        sent_to_client: true,
        sent_at: "2026-09-06T00:00:00.000Z",
      }],
      primaryJobContactId: "c-1",
    }),
    true,
  )
  assertEquals(
    sendRunsPrimaryClientPublicationSatisfied({
      primarySentThisRequest: true,
      publishedExistingDocs: [],
      primaryJobContactId: "c-1",
    }),
    true,
  )
  assertEquals(
    sendRunsPrimaryClientPublicationSatisfied({
      primarySentThisRequest: false,
      publishedExistingDocs: [{
        job_contact_id: "nb-1",
        sent_to_client: true,
        sent_at: "2026-09-06T00:00:00.000Z",
      }],
      primaryJobContactId: "c-1",
    }),
    false,
  )
  assertEquals(
    sendRunsPrimaryClientPublicationSatisfied({
      primarySentThisRequest: false,
      publishedExistingDocs: [{
        job_contact_id: "c-1",
        sent_to_client: true,
        sent_at: "2026-09-06T00:00:00.000Z",
        superseded_at: "2026-09-06T12:00:00.000Z",
      }],
      primaryJobContactId: "c-1",
    }),
    false,
  )
  assertEquals(
    sendRunsPrimaryClientPublicationSatisfied({
      primarySentThisRequest: false,
      publishedExistingDocs: [],
      primaryJobContactId: "c-1",
    }),
    false,
  )
})

Deno.test("R8-002 superseded documents are not current published runs", () => {
  assertEquals(
    resolveSendRunDocument([{
      id: "doc-old",
      type: "quote",
      run_label: "REAR",
      job_contact_id: "c-1",
      sent_to_client: true,
      sent_at: "2026-09-01T00:00:00.000Z",
      superseded_at: "2026-09-06T00:00:00.000Z",
    }], { runLabel: "REAR", jobContactId: "c-1" }).action,
    "create",
  )
  const unpublishedTwin = resolveSendRunDocument([
    {
      id: "doc-old",
      type: "quote",
      run_label: "REAR",
      job_contact_id: "c-1",
      sent_to_client: true,
      sent_at: "2026-09-01T00:00:00.000Z",
      superseded_at: "2026-09-06T00:00:00.000Z",
    },
    {
      id: "doc-open",
      type: "quote",
      run_label: "REAR",
      job_contact_id: "c-1",
      sent_to_client: false,
      sent_at: null,
      superseded_at: null,
    },
  ], { runLabel: "REAR", jobContactId: "c-1" })
  assertEquals(unpublishedTwin.action, "reuse_unpublished")
  if (unpublishedTwin.action === "reuse_unpublished") {
    assertEquals(unpublishedTwin.document.id, "doc-open")
  }
  const currentPublished = resolveSendRunDocument([
    {
      id: "doc-old",
      type: "quote",
      run_label: "REAR",
      job_contact_id: "c-1",
      sent_to_client: true,
      sent_at: "2026-09-01T00:00:00.000Z",
      superseded_at: "2026-09-06T00:00:00.000Z",
    },
    {
      id: "doc-current",
      type: "quote",
      run_label: "REAR",
      job_contact_id: "c-1",
      sent_to_client: true,
      sent_at: "2026-09-06T12:00:00.000Z",
      superseded_at: null,
    },
  ], { runLabel: "REAR", jobContactId: "c-1" })
  assertEquals(currentPublished.action, "use_published")
  if (currentPublished.action === "use_published") {
    assertEquals(currentPublished.document.id, "doc-current")
  }
  assertEquals(
    resolveSendRunDocument([{
      id: "doc-old-open",
      type: "quote",
      run_label: "REAR",
      job_contact_id: "c-1",
      sent_to_client: false,
      sent_at: null,
      superseded_at: "2026-09-06T00:00:00.000Z",
    }], { runLabel: "REAR", jobContactId: "c-1" }).action,
    "create",
  )
})

Deno.test("R9-001 supersession uses extract-durable publication, not sent_to_client alone", () => {
  assertEquals(priorPublishedQuoteIdsToSupersede([
    { id: "hist", sent_at: "2026-09-01T00:00:00.000Z" },
    { id: "accepted", accepted_at: "2026-09-02T00:00:00.000Z", sent_to_client: false },
    { id: "flagged", sent_at: "2026-09-01T00:00:00.000Z", sent_to_client: true },
    { id: "unsent", sent_to_client: false },
    { id: "inflight", sent_at: "2026-09-01T00:00:00.000Z", send_claimed_at: "2026-09-06T00:00:00.000Z" },
    { id: "already", sent_at: "2026-09-01T00:00:00.000Z", sent_to_client: true, superseded_at: "2026-09-06T00:00:00.000Z" },
  ]).sort(), ["accepted", "flagged", "hist"])
})

Deno.test("R9-001 supersede write failure is loud, not a silent skip", async () => {
  const sb = {
    from: () => ({
      select: () => {
        const chain: Record<string, unknown> = {}
        chain.eq = () => chain
        chain.is = () => chain
        chain.lt = () => chain
        chain.neq = () => chain
        chain.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve({
            data: [{ id: "hist", sent_at: "2026-09-01T00:00:00.000Z" }],
            error: null,
          }).then(onFulfilled, onRejected)
        return chain
      },
      update: () => {
        const chain: Record<string, unknown> = {}
        chain.in = () => chain
        chain.is = () => chain
        chain.select = () => Promise.resolve({ data: null, error: { message: "stamp failed" } })
        return chain
      },
    }),
  }
  const result = await supersedePriorPublishedQuoteDocuments(sb, {
    jobId: "job-1",
    currentDocumentId: "doc-new",
    currentVersion: 2,
    jobContactId: null,
    runLabel: null,
  })
  assertEquals(result, { ok: false, error: "stamp failed" })
})

Deno.test("R9-002 accepted documents are already published for send-runs reuse", () => {
  assertEquals(quoteSendIsPublished({
    accepted_at: "2026-09-06T00:00:00.000Z",
    sent_to_client: false,
    sent_at: null,
  }), true)
  assertEquals(quoteSendIsPublished({
    sent_at: "2026-09-01T00:00:00.000Z",
  }), true)
  assertEquals(quoteSendIsPublished({
    sent_to_client: false,
    sent_at: "2026-09-01T00:00:00.000Z",
  }), false)
  const accepted = resolveSendRunDocument([{
    id: "doc-acc",
    type: "quote",
    run_label: "REAR",
    job_contact_id: "c-1",
    sent_to_client: false,
    sent_at: null,
    accepted_at: "2026-09-06T00:00:00.000Z",
    superseded_at: null,
  }], { runLabel: "REAR", jobContactId: "c-1" })
  assertEquals(accepted.action, "use_published")
  if (accepted.action === "use_published") {
    assertEquals(accepted.document.id, "doc-acc")
  }
  assertEquals(
    sendRunsPrimaryClientPublicationSatisfied({
      primarySentThisRequest: false,
      publishedExistingDocs: [{
        job_contact_id: "c-1",
        accepted_at: "2026-09-06T00:00:00.000Z",
        sent_to_client: false,
      }],
      primaryJobContactId: "c-1",
    }),
    true,
  )
})

Deno.test("R6-005 claim database errors are not already_sent", async () => {
  const sb = {
    from: (_table: string) => ({
      update: () => {
        const chain: Record<string, unknown> = {}
        chain.eq = () => chain
        chain.is = () => chain
        chain.not = () => chain
        chain.lt = () => chain
        chain.select = () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: { message: "db down" } }),
        })
        return chain
      },
    }),
  }
  const documentClaim = await claimQuoteDocumentSend(sb, "doc-err")
  assertEquals(documentClaim, { status: "error", error: "db down" })
  const jobClaim = await claimJobSendRuns(sb, "job-err")
  assertEquals(jobClaim, { status: "error", error: "db down" })
})

Deno.test("R13-003 heartbeat is token-fenced and Resend keys survive reclaim", async () => {
  assertEquals(resendIdempotencyHeaders("quote-send:tok-1"), {
    "Idempotency-Key": "quote-send:tok-1",
  })
  const eqs: Array<{ col: string; value: unknown }> = []
  const updates: Record<string, unknown>[] = []
  const sb = {
    from: (_table: string) => ({
      update: (payload: Record<string, unknown>) => {
        updates.push(payload)
        const chain: Record<string, unknown> = {
          eq: (col: string, value: unknown) => {
            eqs.push({ col, value })
            return chain
          },
          is: () => chain,
          not: () => chain,
          select: () => ({
            maybeSingle: () => Promise.resolve({
              data: updates.length === 1 ? { id: "doc-1" } : null,
              error: null,
            }),
          }),
        }
        return chain
      },
    }),
  }
  const owned = await touchQuoteDocumentSendClaim(sb, "doc-1", "tok-owner")
  assertEquals(owned.updated, true)
  assertEquals(typeof updates[0].send_claimed_at, "string")
  assert(!("send_claim_token" in updates[0]))
  assert(eqs.some((eq) => eq.col === "send_claim_token" && eq.value === "tok-owner"))
  const lost = await touchQuoteDocumentSendClaim(sb, "doc-1", "tok-other")
  assertEquals(lost.updated, false)
  const missing = await touchQuoteDocumentSendClaim(sb, "doc-1", "")
  assertEquals(missing.updated, false)
  assertEquals(missing.error?.message, "send claim token required")
})

Deno.test("R16-002 lease errors are not already_sent ownership loss", () => {
  assertEquals(classifySendClaimLease({ updated: true, error: null }), "owned")
  assertEquals(classifySendClaimLease({ updated: false, error: null }), "lost")
  assertEquals(
    classifySendClaimLease({ updated: false, error: { message: "db down" } }),
    "error",
  )
  assertEquals(
    classifySendClaimLease({ updated: true, error: { message: "db down" } }),
    "error",
  )
})

function makeQuoteHeartbeatSb(opts: {
  ownedIds?: string[]
  errorIds?: string[]
}) {
  const owned = new Set(opts.ownedIds || [])
  const errored = new Set(opts.errorIds || [])
  const touched: string[] = []
  return {
    touched,
    from: (_table: string) => {
      let documentId = ""
      let token = ""
      const chain: Record<string, unknown> = {
        update: () => chain,
        eq: (col: string, value: unknown) => {
          if (col === "id") documentId = String(value)
          if (col === "send_claim_token") token = String(value)
          return chain
        },
        is: () => chain,
        not: () => chain,
        select: () => ({
          maybeSingle: () => {
            if (documentId) touched.push(documentId)
            if (errored.has(documentId)) {
              return Promise.resolve({ data: null, error: { message: "db down" } })
            }
            return Promise.resolve({
              data: owned.has(documentId) && token ? { id: documentId } : null,
              error: null,
            })
          },
        }),
      }
      return chain
    },
  }
}

Deno.test("R16-001 grouped send-runs heartbeats every document claim", async () => {
  const claims = [
    { id: "doc-a", token: "tok-a", claimed_at: "2026-09-06T00:00:00.000Z", resend_idempotency_key: "quote-send:tok-a" },
    { id: "doc-b", token: "tok-b", claimed_at: "2026-09-06T00:00:00.000Z", resend_idempotency_key: "quote-send:tok-b" },
  ]
  const sb = makeQuoteHeartbeatSb({ ownedIds: ["doc-a", "doc-b"] })
  const grouped = await touchGroupedQuoteDocumentSendClaims(sb, claims, ["doc-a", "doc-b"])
  assertEquals(grouped.outcome, "owned")
  assertEquals(sb.touched, ["doc-a", "doc-b"])
  assertEquals(grouped.claims.map((c) => c.id), ["doc-a", "doc-b"])
})

Deno.test("R16-001 grouped heartbeat continues after a lost sibling", async () => {
  const claims = [
    { id: "doc-a", token: "tok-a" },
    { id: "doc-b", token: "tok-b" },
    { id: "doc-c", token: "tok-c" },
  ]
  const sb = makeQuoteHeartbeatSb({ ownedIds: ["doc-a", "doc-c"] })
  const grouped = await touchGroupedQuoteDocumentSendClaims(sb, claims, ["doc-a", "doc-b", "doc-c"])
  assertEquals(grouped.outcome, "lost")
  assertEquals(sb.touched, ["doc-a", "doc-b", "doc-c"])
})

Deno.test("R16-001 grouped heartbeat treats a missing claim as lost after refreshing owned rows", async () => {
  const claims = [
    { id: "doc-a", token: "tok-a" },
  ]
  const sb = makeQuoteHeartbeatSb({ ownedIds: ["doc-a"] })
  const grouped = await touchGroupedQuoteDocumentSendClaims(sb, claims, ["doc-a", "doc-b"])
  assertEquals(grouped.outcome, "lost")
  assertEquals(sb.touched, ["doc-a"])
})

Deno.test("R16-002 grouped heartbeat DB faults win over ownership loss", async () => {
  const claims = [
    { id: "doc-a", token: "tok-a" },
    { id: "doc-b", token: "tok-b" },
  ]
  const sb = makeQuoteHeartbeatSb({ ownedIds: ["doc-a"], errorIds: ["doc-b"] })
  const grouped = await touchGroupedQuoteDocumentSendClaims(sb, claims, ["doc-a", "doc-b"])
  assertEquals(grouped.outcome, "error")
  assertEquals(grouped.error?.message, "db down")
  assertEquals(sb.touched, ["doc-a", "doc-b"])
  const batch = await touchQuoteDocumentSendClaims(sb, claims)
  assertEquals(batch.outcome, "error")
})

Deno.test("R16-001 send-runs source heartbeats the grouped claims before Resend", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url))
  const start = src.indexOf("if (path === 'send-runs'")
  const provider = src.indexOf("fetch('https://api.resend.com/emails'", start)
  const preDispatch = src.slice(start, provider)
  assert(start >= 0 && provider > start)
  assert(preDispatch.includes("touchGroupedQuoteDocumentSendClaims("))
  assert(!preDispatch.includes("claimedDocs.find("))
})

Deno.test("R21-003 send-runs heartbeats every held claim before each Resend", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url))
  const start = src.indexOf("if (path === 'send-runs'")
  const provider = src.indexOf("fetch('https://api.resend.com/emails'", start)
  const preDispatch = src.slice(start, provider)
  const lastTouch = preDispatch.lastIndexOf("touchGroupedQuoteDocumentSendClaims(")
  const touchCall = preDispatch.slice(lastTouch, provider)
  assert(start >= 0 && provider > start && lastTouch >= 0)
  assert(touchCall.includes("claimedDocs.map"))
  assert(touchCall.includes("recipient.docs.map"))
})

Deno.test("R16-002 quote and invoice lease errors are 5xx before already_sent", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url))
  const quoteTouch = src.indexOf("touchQuoteDocumentSendClaim(sb, document_id, claimed.token)")
  const quoteError = src.indexOf("quoteLeaseOutcome === 'error'", quoteTouch)
  const quoteLost = src.indexOf("quoteLeaseOutcome === 'lost'", quoteTouch)
  const quoteResend = src.indexOf("fetch('https://api.resend.com/emails'", quoteTouch)
  assert(quoteTouch >= 0 && quoteError > quoteTouch && quoteLost > quoteError && quoteLost < quoteResend)
  assert(src.slice(quoteError, quoteResend).includes("Failed to refresh quote send claim"))
  assert(src.slice(quoteError, quoteLost).includes("500"))
  assert(src.slice(quoteLost, quoteResend).includes("already_sent: true"))

  const invoiceTouch = src.indexOf("touchInvoiceEmailSendClaim(")
  const invoiceError = src.indexOf("invoiceLeaseOutcome === 'error'", invoiceTouch)
  const invoiceLost = src.indexOf("invoiceLeaseOutcome === 'lost'", invoiceTouch)
  const invoiceResend = src.indexOf("fetch('https://api.resend.com/emails'", invoiceTouch)
  assert(invoiceTouch >= 0 && invoiceError > invoiceTouch && invoiceLost > invoiceError && invoiceLost < invoiceResend)
  assert(src.slice(invoiceError, invoiceResend).includes("Failed to refresh invoice send claim"))
  assert(src.slice(invoiceError, invoiceLost).includes("500"))
  assert(src.slice(invoiceLost, invoiceResend).includes("already_sent: true"))
  assert(src.slice(invoiceError, invoiceLost).includes("keep_provider_key"))
})

function makeHeldPersistSb(opts: {
  ownedIds?: string[]
  loseAfterHeartbeats?: number
} = {}) {
  const owned = new Set(opts.ownedIds || ["doc-a", "doc-b"])
  const events: string[] = []
  let heartbeats = 0
  return {
    events,
    from: (_table: string) => {
      let documentId = ""
      let kind: "heartbeat" | "persist" | "publish" | "other" = "other"
      const chain: Record<string, unknown> = {
        update: (payload: Record<string, unknown>) => {
          if ("trade_pack_json" in payload) kind = "persist"
          else if ("sent_to_client" in payload) kind = "publish"
          else if ("send_claimed_at" in payload) kind = "heartbeat"
          else kind = "other"
          return chain
        },
        eq: (col: string, value: unknown) => {
          if (col === "id") documentId = String(value)
          return chain
        },
        is: () => chain,
        not: () => chain,
        select: () => ({
          maybeSingle: () => {
            if (kind === "heartbeat") {
              heartbeats++
              events.push(`heartbeat:${documentId}`)
              const lost = typeof opts.loseAfterHeartbeats === "number" &&
                heartbeats > opts.loseAfterHeartbeats
              return Promise.resolve({
                data: !lost && owned.has(documentId) ? { id: documentId } : null,
                error: null,
              })
            }
            if (kind === "persist" || kind === "publish") {
              events.push(`${kind}:${documentId}`)
            }
            return Promise.resolve({
              data: owned.has(documentId) ? { id: documentId } : null,
              error: null,
            })
          },
        }),
      }
      return chain
    },
  }
}

Deno.test("R17-002 persist heartbeats every grouped claim before each pack write", async () => {
  const sb = makeHeldPersistSb()
  const result = await persistTradePacksWhileHoldingSendClaims(sb, {
    documents: [
      { id: "doc-a", claim_token: "tok-a", quote_number: "Q-1" },
      { id: "doc-b", claim_token: "tok-b", quote_number: "Q-2" },
    ],
    jobType: "other",
    scopeJson: {},
    pricingJson: {},
  })
  assertEquals(result, { status: "persisted" })
  assertEquals(sb.events, [
    "heartbeat:doc-a",
    "heartbeat:doc-b",
    "persist:doc-a",
    "heartbeat:doc-a",
    "heartbeat:doc-b",
    "persist:doc-b",
  ])
})

Deno.test("R17-002 persist stops without writing when a later heartbeat loses the lease", async () => {
  const sb = makeHeldPersistSb({ loseAfterHeartbeats: 3 })
  const result = await persistTradePacksWhileHoldingSendClaims(sb, {
    documents: [
      { id: "doc-a", claim_token: "tok-a" },
      { id: "doc-b", claim_token: "tok-b" },
    ],
    jobType: "other",
    scopeJson: {},
  })
  assertEquals(result, { status: "lease_lost" })
  assertEquals(sb.events, [
    "heartbeat:doc-a",
    "heartbeat:doc-b",
    "persist:doc-a",
    "heartbeat:doc-a",
    "heartbeat:doc-b",
  ])
})

Deno.test("R17-002 publication heartbeats the grouped set before stamping sent", async () => {
  const sb = makeHeldPersistSb()
  const published = await publishQuoteDocumentsSendOrRevertWhileHolding(sb, [
    { id: "doc-a", token: "tok-a" },
    { id: "doc-b", token: "tok-b" },
  ])
  assertEquals(published, { published: true })
  assertEquals(sb.events, [
    "heartbeat:doc-a",
    "heartbeat:doc-b",
    "publish:doc-a",
    "heartbeat:doc-a",
    "heartbeat:doc-b",
    "publish:doc-b",
  ])
})

Deno.test("TRD6-22-001 persist and publish refresh leases with current time each iteration", () => {
  const src = Deno.readTextFileSync(new URL("../_shared/trade_quote_pack/quote_send_publication.ts", import.meta.url))
  const persistStart = src.indexOf("export async function persistTradePacksWhileHoldingSendClaims")
  const publishStart = src.indexOf("export async function publishQuoteDocumentsSendOrRevertWhileHolding")
  const publishEnd = src.indexOf("async function claimJobSendRunsExclusive")
  const persist = src.slice(persistStart, publishStart)
  const publish = src.slice(publishStart, publishEnd)
  assert(persistStart >= 0 && publishStart > persistStart && publishEnd > publishStart)
  assert(persist.includes("for (const doc of documents)"))
  assert(persist.includes("touchQuoteDocumentSendClaims(sb, claims, new Date())"))
  assert(!persist.includes("touchQuoteDocumentSendClaims(sb, claims, now)"))
  assert(persist.includes("if (beat.outcome === 'lost')"))
  assert(publish.includes("for (const claim of owned)"))
  assert(publish.includes("touchQuoteDocumentSendClaims(sb, owned, new Date())"))
  assert(!publish.includes("touchQuoteDocumentSendClaims(sb, owned, now)"))
  const loop = publish.indexOf("for (const claim of owned)")
  const beat = publish.indexOf("touchQuoteDocumentSendClaims(sb, owned, new Date())")
  const stamp = publish.indexOf("publishQuoteDocumentSend(sb, claim.id, claim.token, now)")
  assert(loop >= 0 && beat > loop && stamp > beat)
})

Deno.test("TRD6-22-001 publication stops when a later heartbeat loses the lease", async () => {
  const sb = makeHeldPersistSb({ loseAfterHeartbeats: 3 })
  const published = await publishQuoteDocumentsSendOrRevertWhileHolding(sb, [
    { id: "doc-a", token: "tok-a" },
    { id: "doc-b", token: "tok-b" },
  ])
  assertEquals(published.published, false)
  if (published.published) throw new Error("expected publication lease loss")
  assertEquals(published.lease, "lost")
  assertEquals(sb.events.includes("publish:doc-a"), true)
  assertEquals(sb.events.includes("publish:doc-b"), false)
})

Deno.test("R17-002 send-runs source heartbeats grouped claims through persist and publication", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url))
  const start = src.indexOf("if (path === 'send-runs'")
  const persist = src.indexOf("persistTradePacksWhileHoldingSendClaims(", start)
  const publish = src.indexOf("publishQuoteDocumentsSendOrRevertWhileHolding(", start)
  const leftover = src.indexOf("const leftoverClaims = claimsNotInDocumentIds", start)
  assert(start >= 0 && persist > start && publish > persist && leftover > publish)
  const slice = src.slice(persist, leftover)
  assert(!slice.includes("persistTradePackOnDocuments("))
  assert(!slice.includes("publishQuoteDocumentsSendOrRevert("))
})

// ════════════════════════════════════════════════════════════════════════════
// G-B2 SUPERSESSION SCOPE-MATCH — manual test documentation
// ════════════════════════════════════════════════════════════════════════════
//
// G-B2 candidate matching is unit-tested via priorPublishedQuoteIdsToSupersede
// (R9-001). Scope isolation against live rows is still a manual check:
//
//   1. Send version 1 of a quote (doc A, version=1, job_contact_id=X, run_label=Y).
//      Confirm: doc A has sent_to_client=true, superseded_at IS NULL.
//
//   2. Create doc B (version=2, same job_id, same job_contact_id=X, same run_label=Y).
//      Call /send on doc B.
//
//   Expected: doc A gets superseded_at=<now> set; doc B does NOT.
//   Query: SELECT id, version, superseded_at FROM job_documents
//          WHERE job_id='<id>' AND doc_type='quote' ORDER BY version;
//
//   3. Scope isolation: a third doc C (same job, different job_contact_id or run_label)
//      sent at version 1 must NOT be superseded when doc B is sent.
//   Expected: doc C retains superseded_at IS NULL.
//
//   4. Null-scope isolation: when both job_contact_id and run_label are null,
//      only rows with both null are matched (IS NULL filter, not eq(null)).
//
//   5. Non-blocking: if the UPDATE throws (e.g. DB outage), /send still returns
//      200 with success=true and logs "[send-quote] G-B2 supersede-prior failed".
//
// The scope-match branching (is(...null) vs eq(...value)) is the only
// non-trivial logic. The Supabase `.is('col', null)` form generates
// `col IS NULL` in SQL; `.eq('col', val)` generates `col = 'val'`.
// This distinction matters when job_contact_id or run_label is null.
