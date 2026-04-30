// CAP0-QA-CANONICAL-EVENTS-HARDENING — Phase 0.4 binding evidence.
//
// Tests the THREE failure modes of safeBusinessEventInsert:
//   1. happy path: insert resolves OK -> NO log emitted
//   2. resolved-error path: insert returns {error: {message: 'simulated'}} ->
//      [canonical-event-fail] JSON logged
//   3. thrown-exception path: insert throws -> [canonical-event-fail] JSON logged
//
// LOCAL-ONLY. Not committed in this Phase 0 turn. The helper under test is a
// non-exported top-level async function in `index.ts`; importing index.ts here
// would start the production HTTP server via `serve(...)` at module-load time.
// To avoid that, the helper body is copied exactly from index.ts:108-132 so
// the verification report can show line-by-line equivalence. Any future drift
// between this copy and the deployed helper is the operator's responsibility.
//
// Run: /Users/marninstobbe/.deno/bin/deno test --allow-none index_test.ts

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts"

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
