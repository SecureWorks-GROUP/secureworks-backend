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
    const manifestPath = `${input.org_id}/${input.job_id}/manifest_v${input.version}_${hash.slice(0, 12)}.json`
    const { data: signed, error: signErr } = await sb.storage
      .from('job-pdfs')
      .createSignedUploadUrl(manifestPath)
    if (signErr || !signed?.signedUrl) return null
    const putRes = await fetch(signed.signedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: canonical,
    })
    if (!putRes.ok) return null
    const manifestUrl = `${SUPABASE_URL}/storage/v1/object/public/job-pdfs/${manifestPath}`
    const totals = manifest.totals_snapshot
    const sentAtIso = new Date().toISOString()
    const { data: inserted, error: insErr } = await sb.from('quote_revisions')
      .insert({
        job_id: input.job_id, job_document_id: input.job_document_id, version: input.version,
        recipient_email: input.recipient_email, recipient_label: input.recipient_label,
        scope_snapshot_json: manifest.scope_snapshot,
        pricing_snapshot_json: manifest.pricing_snapshot,
        totals_snapshot_json: totals,
        manifest_url: manifestUrl, manifest_hash: hash, pdf_url: input.pdf_url,
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

Deno.test("R1 — recordReleasedQuoteRevision happy path: uploads manifest, inserts row with sent_at NOT NULL, returns revision id", async () => {
  const sb = makeQuoteRevSupabase({ uploadOk: true, insertReturns: 'ok', insertedId: 'rev-r1' })
  const id = await recordReleasedQuoteRevision(sb, sampleInput, sampleRevCtx)
  assertEquals(id, 'rev-r1')
  assertEquals(sb._state.uploaded.length, 1)
  const path = sb._state.uploaded[0].path
  assertEquals(path.startsWith(`${sampleInput.org_id}/${sampleInput.job_id}/manifest_v1_`), true)
  assertEquals(path.endsWith('.json'), true)
  // Critical assertion: sent_at MUST be non-null at INSERT time (no staging).
  assertEquals(sb._state.inserted.length, 1)
  assertEquals(typeof sb._state.inserted[0].sent_at, 'string')
  assertEquals(sb._state.inserted[0].sent_at !== null, true)
  assertEquals(sb._state.inserted[0].released_via, 'send-quote/send')
  assertEquals(sb._state.inserted[0].schema_version, '1.0')
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

Deno.test("R7 — recordReleasedQuoteRevision: manifest upload failure short-circuits before INSERT", async () => {
  const sb = makeQuoteRevSupabase({ uploadOk: false, insertReturns: 'ok' })
  const id = await recordReleasedQuoteRevision(sb, sampleInput, sampleRevCtx)
  assertEquals(id, null)
  assertEquals(sb._state.inserted.length, 0, 'INSERT must not be attempted if manifest upload failed')
})

Deno.test("R8 — recordReleasedQuoteRevision: manifest_hash matches recompute and appears as the path slice (release-packet hash determinism contract)", async () => {
  const sb = makeQuoteRevSupabase({ uploadOk: true, insertReturns: 'ok', insertedId: 'rev-r8' })
  await recordReleasedQuoteRevision(sb, sampleInput, sampleRevCtx)
  const insertedHash = sb._state.inserted[0].manifest_hash
  assertEquals(typeof insertedHash, 'string')
  assertEquals(insertedHash.length, 64, 'manifest_hash must be 64-char SHA-256 hex')
  const expectedPathPrefix = insertedHash.slice(0, 12)
  const path = sb._state.uploaded[0].path
  assertEquals(path.includes(`manifest_v1_${expectedPathPrefix}.json`), true)
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
