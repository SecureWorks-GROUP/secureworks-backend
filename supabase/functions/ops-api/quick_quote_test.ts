// Tests for sendQuickQuoteEmail Cap 0 release-truth wiring.
//
// Two slices under test:
//
// Q1 — CAP0-QUICKQUOTE-FRESH-SELECT-RACE-SAFETY (2026-05-01)
//   The conditional UPDATE returns post-UPDATE row state via .select(...). The
//   canonical event payload reads job_number / type / client_name / pricing
//   from those FRESH values, not from the function-entry SELECT, so a parallel
//   writer flipping `jobs.type` between entry and UPDATE can't poison the
//   canonical bus with stale state.
//
// Q2 — CAP0-QUOTE-REVISION-QUICKQUOTE
//   On successful draft → quoted transition, the helper writes a quote_revisions
//   row (sent_at NOT NULL, no staging) and the canonical events carry the
//   revision id in payload.quote_revision_id and related_entities[].
//
// Notes:
//   - The full helper body is mirrored inline below (intentional duplication —
//     matches the recordReleasedQuoteRevision-in-send-quote/_test pattern).
//     Drift caught at PR review.
//   - No network. No live Supabase. No Resend. The handler is split into the
//     just-the-release-block we care about; the email-send portion is exercised
//     in production via the synthetic Q-R-* probes, not here.

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { canonicalJsonAndHash } from "../_shared/release_packet/canonicalize.ts"
import { buildMinimalReleaseManifest } from "../_shared/release_packet/build_minimal_manifest.ts"
import type { CouncilStatus } from "../_shared/release_packet/manifest_types.ts"

// In production this comes from Deno.env.get('SUPABASE_URL'); here we hardcode
// the project URL so the manifest_url assertions are stable.
const SUPABASE_URL = 'https://kevgrhcjxspbxgovpmfl.supabase.co'

// ── Mirror of recordReleasedQuoteRevision body from index.ts ───────────────
type QuickQuoteRecordReleaseInput = {
  job_id: string
  job_document_id: string | null
  version: number
  recipient_email: string
  recipient_label: string | null
  build_kind: 'patio' | 'fence' | 'misc'
  council_status?: CouncilStatus
  neighbours_required?: boolean | null
  scope: {
    client_name: string | null
    site_address: string | null
    site_suburb: string | null
    job_type: string | null
    job_number: string | null
  }
  pricing_json: unknown
  pdf_url: string
  released_via: 'ops-api/send_quick_quote_email'
  org_id: string
}

async function recordReleasedQuoteRevision(
  sb: any,
  input: QuickQuoteRecordReleaseInput,
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
    // release-manifests bucket. Real URL on success; falls back to stub on
    // upload failure (manifest_canonical_text is the inline verification source).
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
    } catch { /* swallow; stub fallback in place */ }
    const totals = manifest.totals_snapshot
    const sentAtIso = new Date().toISOString()
    const { data: inserted, error: insErr } = await sb.from('quote_revisions')
      .insert({
        job_id: input.job_id,
        job_document_id: input.job_document_id,
        version: input.version,
        recipient_email: input.recipient_email,
        recipient_label: input.recipient_label,
        scope_snapshot_json: manifest.scope_snapshot,
        pricing_snapshot_json: manifest.pricing_snapshot,
        totals_snapshot_json: totals,
        manifest_url: manifestUrl,
        manifest_hash: hash,
        manifest_canonical_text: canonical,
        pdf_url: input.pdf_url,
        council_status: input.council_status ?? 'unknown',
        build_kind: input.build_kind,
        neighbours_required: input.neighbours_required ?? null,
        released_via: input.released_via,
        sent_at: sentAtIso,
        schema_version: '1.0',
      })
      .select('id')
      .single()
    if (!insErr && inserted) return inserted.id
    const { data: existing } = await sb.from('quote_revisions')
      .select('id, sent_at')
      .eq('job_id', input.job_id).eq('version', input.version).maybeSingle()
    if (existing && existing.sent_at !== null) return existing.id
    return null
  } catch {
    return null
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Mock supabase client tailored to the release-block under test.
// Captures: the conditional UPDATE filter+payload, the .select() spec used to
// return fresh rows, the quote_revisions insert payload, and any
// business_events insert payloads. Returns whatever the test scenario asked
// for as updatedRows.
// ────────────────────────────────────────────────────────────────────────────

type MockState = {
  jobsUpdates: Array<{ payload: Record<string, unknown>; filters: Array<[string, unknown]>; selectCols?: string }>
  jobEventsInserts: Array<Record<string, unknown>>
  quoteRevisionInserts: Array<Record<string, unknown>>
  businessEventsInserts: Array<Record<string, unknown>>
  emailEventsInserts: Array<Record<string, unknown>>
  uploaded: Array<{ bucket: string; path: string; bytes: string }>
}

function makeStubClient(opts: {
  // What the conditional UPDATE returns (post-UPDATE row state OR empty for no-op).
  updateReturns: Array<Record<string, unknown>>
  // Whether the quote_revisions INSERT succeeds.
  quoteRevInsertOk?: boolean
  insertedRevisionId?: string
  // Storage upload behaviour:
  //   undefined or 'ok' → upload returns {error:null}
  //   'fail'            → returns {error:{message:'upload denied', statusCode:'500'}}
  //   'duplicate'       → returns {error:{message:'The resource already exists', statusCode:'409'}}
  uploadResult?: 'ok' | 'fail' | 'duplicate'
}) {
  const state: MockState = {
    jobsUpdates: [],
    jobEventsInserts: [],
    quoteRevisionInserts: [],
    businessEventsInserts: [],
    emailEventsInserts: [],
    uploaded: [],
  }

  const makeChain = (table: string) => {
    const chain: any = {
      _captured: { method: '', payload: null as any, filters: [] as Array<[string, unknown]>, selectCols: '' },
      insert(payload: any) {
        this._captured.method = 'insert'
        this._captured.payload = payload
        if (table === 'quote_revisions') state.quoteRevisionInserts.push(payload)
        if (table === 'business_events') state.businessEventsInserts.push(payload)
        if (table === 'job_events') state.jobEventsInserts.push(payload)
        if (table === 'email_events') state.emailEventsInserts.push(payload)
        return this
      },
      update(payload: any) {
        this._captured.method = 'update'
        this._captured.payload = payload
        return this
      },
      eq(col: string, val: any) { this._captured.filters.push([col, val]); return this },
      is(col: string, val: any) { this._captured.filters.push([col, val]); return this },
      select(cols: string) {
        this._captured.selectCols = cols
        // Resolve the chain — for jobs.update, return updateReturns
        if (table === 'jobs' && this._captured.method === 'update') {
          state.jobsUpdates.push({
            payload: this._captured.payload,
            filters: this._captured.filters,
            selectCols: cols,
          })
          return Promise.resolve({ data: opts.updateReturns, error: null })
        }
        return this
      },
      single() {
        if (table === 'quote_revisions' && this._captured.method === 'insert') {
          if (opts.quoteRevInsertOk === false) {
            return Promise.resolve({ data: null, error: { message: 'simulated insert failure' } })
          }
          return Promise.resolve({
            data: { id: opts.insertedRevisionId || 'rev-default' },
            error: null,
          })
        }
        return Promise.resolve({ data: null, error: null })
      },
      maybeSingle() {
        return Promise.resolve({ data: null, error: null })
      },
    }
    return chain
  }

  const sb = {
    from: (table: string) => makeChain(table),
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, body: Uint8Array, _opts: any) => {
          const text = new TextDecoder().decode(body)
          if (opts.uploadResult === 'fail') {
            return { data: null, error: { message: 'upload denied', statusCode: '500' } }
          }
          if (opts.uploadResult === 'duplicate') {
            // Don't record bytes — the existing object is already there.
            return { data: null, error: { message: 'The resource already exists', statusCode: '409' } }
          }
          state.uploaded.push({ bucket, path, bytes: text })
          return { data: { path }, error: null }
        },
      }),
    },
    _state: state,
  }
  return sb as any
}

// ────────────────────────────────────────────────────────────────────────────
// Extracted release block — the part of sendQuickQuoteEmail we care about.
//
// Mirrors index.ts after the "if (!resendResp.ok) throw" line. Takes the
// post-Resend stub-job (entry-time SELECT) and the client_email/totalIncGST
// the email actually went out with, runs the conditional UPDATE + canonical
// emit + revision recording, and returns the released revision id (or null).
// ────────────────────────────────────────────────────────────────────────────

const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001'

async function logBusinessEvent(client: any, event: any) {
  try {
    await client.from('business_events').insert({
      event_type: event.event_type,
      source: event.source || 'app/office',
      entity_type: event.entity_type,
      entity_id: event.entity_id,
      correlation_id: event.correlation_id || null,
      job_id: event.job_id || null,
      payload: event.payload || {},
      metadata: { ...(event.metadata || {}) },
      schema_version: '1.0',
    })
  } catch { /* swallow */ }
}

async function runReleaseBlock(
  client: any,
  args: {
    job_id: string
    job: { client_email: string; site_address: string | null; site_suburb: string | null }
    pdf_url: string | undefined
    totalIncGST: number
  },
): Promise<{ transitioned: boolean; releasedRevisionId: string | null }> {
  const { job_id, job, pdf_url, totalIncGST } = args
  const nowIso = new Date().toISOString()

  const { data: updatedRows } = await client.from('jobs')
    .update({ status: 'quoted', quoted_at: nowIso })
    .eq('id', job_id)
    .eq('status', 'draft')
    .select('id, job_number, type, client_name, pricing_json')
  const transitioned = Array.isArray(updatedRows) && updatedRows.length > 0

  await client.from('job_events').insert({
    job_id,
    event_type: 'quote_sent',
    detail_json: { sent_to: job.client_email, source: 'quick_quote' },
  })

  let releasedRevisionId: string | null = null

  if (transitioned) {
    const fresh = updatedRows[0]
    const freshPricing = (fresh.pricing_json ?? {}) as Record<string, unknown>
    const freshTotalIncGSTRaw = freshPricing.totalIncGST ?? freshPricing.total ?? freshPricing.grandTotal
    const totalIncGSTNum = typeof freshTotalIncGSTRaw === 'number' && Number.isFinite(freshTotalIncGSTRaw)
      ? freshTotalIncGSTRaw
      : (Number(totalIncGST) || 0)

    const buildKind: 'patio' | 'fence' | 'misc' =
      fresh.type === 'fencing' ? 'fence' :
      fresh.type === 'patio' ? 'patio' : 'misc'

    releasedRevisionId = await recordReleasedQuoteRevision(client, {
      job_id,
      job_document_id: null,
      version: 1,
      recipient_email: job.client_email,
      recipient_label: null,
      build_kind: buildKind,
      scope: {
        client_name: fresh.client_name,
        site_address: job.site_address || null,
        site_suburb: job.site_suburb || null,
        job_type: fresh.type,
        job_number: fresh.job_number,
      },
      pricing_json: fresh.pricing_json ?? null,
      pdf_url: pdf_url || '',
      released_via: 'ops-api/send_quick_quote_email',
      org_id: DEFAULT_ORG_ID,
    }, { handler: 'ops-api/send_quick_quote_email', job_id })

    await logBusinessEvent(client, {
      event_type: 'quote.sent',
      source: 'send-quick-quote-email',
      entity_type: 'job',
      entity_id: job_id,
      correlation_id: job_id,
      job_id,
      payload: {
        quote_revision_id: releasedRevisionId,
        job_number: fresh.job_number || null,
        job_type: fresh.type || null,
        sent_to: job.client_email,
        total_inc_gst: totalIncGSTNum,
      },
      metadata: { handler: 'ops-api/send_quick_quote_email' },
    })

    await logBusinessEvent(client, {
      event_type: 'job.status_changed',
      source: 'send-quick-quote-email',
      entity_type: 'job',
      entity_id: job_id,
      correlation_id: job_id,
      job_id,
      payload: {
        entity: { id: job_id, name: fresh.job_number || fresh.client_name || '' },
        changes: { status: { from: 'draft', to: 'quoted' } },
        financial: { amount: totalIncGSTNum },
        related_entities: releasedRevisionId
          ? [{ type: 'quote_revision', id: releasedRevisionId }]
          : [],
      },
      metadata: { reason: 'quote_sent', handler: 'ops-api/send_quick_quote_email' },
    })
  }

  return { transitioned, releasedRevisionId }
}

// ────────────────────────────────────────────────────────────────────────────
// Q1 — CAP0-QUICKQUOTE-FRESH-SELECT-RACE-SAFETY
// ────────────────────────────────────────────────────────────────────────────

Deno.test("Q1.a — UPDATE's .select() requests fresh state columns (id, job_number, type, client_name, pricing_json)", async () => {
  // The race-safety contract: the conditional UPDATE asks for the post-UPDATE
  // values of job_number, type, client_name, and pricing_json. If anyone ever
  // narrows this select() back to just 'id', this test fails.
  const sb = makeStubClient({
    updateReturns: [{
      id: 'job-1',
      job_number: 'SWG-001',
      type: 'general',
      client_name: 'CAP0 TEST Q1.a',
      pricing_json: { totalIncGST: 100 },
    }],
  })
  await runReleaseBlock(sb, {
    job_id: 'job-1',
    job: { client_email: 'marnin@secureworkswa.com.au', site_address: '1 Test St', site_suburb: 'Perth' },
    pdf_url: undefined,
    totalIncGST: 100,
  })
  assertEquals(sb._state.jobsUpdates.length, 1)
  assertEquals(sb._state.jobsUpdates[0].selectCols, 'id, job_number, type, client_name, pricing_json')
})

Deno.test("Q1.b — canonical event payload uses POST-UPDATE job_type, NOT entry-time job.type (Codex stale-snapshot regression)", async () => {
  // Simulates the race: function-entry SELECT was 'general' (not yet
  // re-classified), but a parallel writer flipped jobs.type to 'patio'
  // before our UPDATE fired. The post-UPDATE state is 'patio'; canonical
  // events MUST reflect 'patio', not 'general'.
  const sb = makeStubClient({
    updateReturns: [{
      id: 'job-2',
      job_number: 'SWP-2700',
      type: 'patio', // post-UPDATE state — re-classified by parallel writer
      client_name: 'CAP0 TEST Q1.b',
      pricing_json: { totalIncGST: 5500 },
    }],
  })
  await runReleaseBlock(sb, {
    job_id: 'job-2',
    job: { client_email: 'marnin@secureworkswa.com.au', site_address: null, site_suburb: null },
    pdf_url: undefined,
    totalIncGST: 5500,
  })
  // 2 canonical events (quote.sent + job.status_changed) since transition.
  assertEquals(sb._state.businessEventsInserts.length, 2)
  const quoteSent = sb._state.businessEventsInserts.find((e: any) => e.event_type === 'quote.sent') as any
  assertEquals(quoteSent.payload.job_type, 'patio', 'must reflect post-UPDATE state')
  assertEquals(quoteSent.payload.job_number, 'SWP-2700', 'must reflect post-UPDATE state')
})

Deno.test("Q1.c — quote_revisions row uses POST-UPDATE values for build_kind, job_type, job_number, client_name", async () => {
  // Race-safety extends to the immutable revision row: the manifest the hash
  // is computed from carries fresh state, not stale entry-time values.
  const sb = makeStubClient({
    updateReturns: [{
      id: 'job-3',
      job_number: 'SWF-2800',
      type: 'fencing',
      client_name: 'CAP0 TEST Q1.c',
      pricing_json: { totalIncGST: 3300, totalExGST: 3000, gst: 300 },
    }],
    quoteRevInsertOk: true,
    insertedRevisionId: 'rev-q1c',
  })
  await runReleaseBlock(sb, {
    job_id: 'job-3',
    job: { client_email: 'marnin@secureworkswa.com.au', site_address: '5 Fence Way', site_suburb: 'Joondalup' },
    pdf_url: undefined,
    totalIncGST: 3300,
  })
  assertEquals(sb._state.quoteRevisionInserts.length, 1)
  const rev = sb._state.quoteRevisionInserts[0] as any
  assertEquals(rev.build_kind, 'fence', 'fencing → fence')
  assertEquals(rev.scope_snapshot_json.job_type, 'fencing')
  assertEquals(rev.scope_snapshot_json.job_number, 'SWF-2800')
  assertEquals(rev.scope_snapshot_json.client_name, 'CAP0 TEST Q1.c')
  // Pricing snapshot captures the verbatim post-UPDATE pricing_json.
  assertEquals((rev.pricing_snapshot_json.raw as any).totalIncGST, 3300)
})

// ────────────────────────────────────────────────────────────────────────────
// Q2 — CAP0-QUOTE-REVISION-QUICKQUOTE
// ────────────────────────────────────────────────────────────────────────────

Deno.test("Q2.a — successful release writes one quote_revisions row with sent_at NOT NULL, job_document_id NULL, released_via='ops-api/send_quick_quote_email'", async () => {
  const sb = makeStubClient({
    updateReturns: [{
      id: 'job-4',
      job_number: 'SWP-2900',
      type: 'patio',
      client_name: 'CAP0 TEST Q2.a',
      pricing_json: { totalIncGST: 5500 },
    }],
    quoteRevInsertOk: true,
    insertedRevisionId: 'rev-q2a',
  })
  const { releasedRevisionId } = await runReleaseBlock(sb, {
    job_id: 'job-4',
    job: { client_email: 'marnin@secureworkswa.com.au', site_address: '1 Test St', site_suburb: 'Perth' },
    pdf_url: 'https://example.com/quote.pdf',
    totalIncGST: 5500,
  })
  assertEquals(releasedRevisionId, 'rev-q2a')
  assertEquals(sb._state.quoteRevisionInserts.length, 1)
  const rev = sb._state.quoteRevisionInserts[0] as any
  assertEquals(rev.job_document_id, null, 'Quick Quote has no job_documents row')
  assertEquals(rev.released_via, 'ops-api/send_quick_quote_email')
  assertEquals(typeof rev.sent_at, 'string')
  assert(rev.sent_at !== null, 'sent_at must be NOT NULL — record-on-release-only')
  assertEquals(rev.schema_version, '1.0')
  assertEquals(rev.version, 1)
  assertEquals(rev.manifest_hash.length, 64)
  // CAP0-QUOTE-REVISION-MANIFEST-STORAGE: real private-bucket object URL on success.
  assertEquals(rev.manifest_url, `${SUPABASE_URL}/storage/v1/object/release-manifests/${rev.manifest_hash}.json`)
  assertEquals(rev.recipient_email, 'marnin@secureworkswa.com.au')
})

Deno.test("Q2.b — canonical events carry quote_revision_id in payload + related_entities", async () => {
  const sb = makeStubClient({
    updateReturns: [{
      id: 'job-5',
      job_number: 'SWG-3000',
      type: 'general',
      client_name: 'CAP0 TEST Q2.b',
      pricing_json: { totalIncGST: 1100 },
    }],
    quoteRevInsertOk: true,
    insertedRevisionId: 'rev-q2b',
  })
  await runReleaseBlock(sb, {
    job_id: 'job-5',
    job: { client_email: 'marnin@secureworkswa.com.au', site_address: null, site_suburb: null },
    pdf_url: undefined,
    totalIncGST: 1100,
  })
  const quoteSent = sb._state.businessEventsInserts.find((e: any) => e.event_type === 'quote.sent') as any
  const statusChanged = sb._state.businessEventsInserts.find((e: any) => e.event_type === 'job.status_changed') as any
  assertEquals(quoteSent.payload.quote_revision_id, 'rev-q2b')
  assertEquals(statusChanged.payload.related_entities.length, 1)
  assertEquals(statusChanged.payload.related_entities[0].type, 'quote_revision')
  assertEquals(statusChanged.payload.related_entities[0].id, 'rev-q2b')
})

Deno.test("Q2.c — resend on already-quoted job (conditional UPDATE returns []) writes ZERO canonical events and ZERO quote_revisions rows", async () => {
  // The transition gate is the affected-row count of the conditional UPDATE.
  // No transition → no canonical emit → no revision recording.
  const sb = makeStubClient({
    updateReturns: [], // empty: row was already 'quoted', UPDATE no-op
  })
  const { transitioned, releasedRevisionId } = await runReleaseBlock(sb, {
    job_id: 'job-6',
    job: { client_email: 'marnin@secureworkswa.com.au', site_address: null, site_suburb: null },
    pdf_url: undefined,
    totalIncGST: 5500,
  })
  assertEquals(transitioned, false)
  assertEquals(releasedRevisionId, null)
  assertEquals(sb._state.businessEventsInserts.length, 0)
  assertEquals(sb._state.quoteRevisionInserts.length, 0)
  // Legacy job_events.quote_sent is still written (mirrors send-quote/send semantics)
  assertEquals(sb._state.jobEventsInserts.length, 1)
})

Deno.test("Q2.d — quote_revisions INSERT failure: canonical events still emit with quote_revision_id=null (release moment is irreversible)", async () => {
  // The release moment (email sent + jobs.status flipped) is not rolled back
  // by a quote_revisions write failure. Canonical events emit without the
  // revision id; operator logs surface the [quote-revision-record-fail] line.
  const sb = makeStubClient({
    updateReturns: [{
      id: 'job-7',
      job_number: 'SWP-3100',
      type: 'patio',
      client_name: 'CAP0 TEST Q2.d',
      pricing_json: { totalIncGST: 5500 },
    }],
    quoteRevInsertOk: false, // simulate Supabase failure
  })
  const { transitioned, releasedRevisionId } = await runReleaseBlock(sb, {
    job_id: 'job-7',
    job: { client_email: 'marnin@secureworkswa.com.au', site_address: '1 Test St', site_suburb: 'Perth' },
    pdf_url: undefined,
    totalIncGST: 5500,
  })
  assertEquals(transitioned, true)
  assertEquals(releasedRevisionId, null, 'helper returns null when both INSERT and existing-row lookup fail')
  // Canonical events still fired
  assertEquals(sb._state.businessEventsInserts.length, 2)
  const quoteSent = sb._state.businessEventsInserts.find((e: any) => e.event_type === 'quote.sent') as any
  assertEquals(quoteSent.payload.quote_revision_id, null)
  const statusChanged = sb._state.businessEventsInserts.find((e: any) => e.event_type === 'job.status_changed') as any
  assertEquals(statusChanged.payload.related_entities.length, 0, 'no quote_revision link in related_entities')
})

Deno.test("Q2.e — manifest_canonical_text is captured AND sha256(canonical) === manifest_hash (verifiability contract)", async () => {
  const sb = makeStubClient({
    updateReturns: [{
      id: 'job-8',
      job_number: 'SWG-3200',
      type: 'general',
      client_name: 'CAP0 TEST Q2.e',
      pricing_json: { totalIncGST: 1100 },
    }],
    quoteRevInsertOk: true,
    insertedRevisionId: 'rev-q2e',
  })
  await runReleaseBlock(sb, {
    job_id: 'job-8',
    job: { client_email: 'marnin@secureworkswa.com.au', site_address: null, site_suburb: null },
    pdf_url: undefined,
    totalIncGST: 1100,
  })
  const rev = sb._state.quoteRevisionInserts[0] as any
  assertEquals(typeof rev.manifest_canonical_text, 'string')
  assert(rev.manifest_canonical_text.length > 0)
  // Recompute SHA-256 of the canonical bytes; must equal manifest_hash.
  const enc = new TextEncoder().encode(rev.manifest_canonical_text)
  const digest = await crypto.subtle.digest('SHA-256', enc)
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
  assertEquals(hex, rev.manifest_hash, 'sha256(manifest_canonical_text) must equal manifest_hash')
})

Deno.test("Q2.f — build_kind derives from POST-UPDATE jobs.type: patio→patio, fencing→fence, anything else→misc", async () => {
  for (const [type, expected] of [
    ['patio', 'patio'],
    ['fencing', 'fence'],
    ['general', 'misc'],
    ['roof_repair', 'misc'],
    [null, 'misc'],
  ] as Array<[string | null, 'patio' | 'fence' | 'misc']>) {
    const sb = makeStubClient({
      updateReturns: [{
        id: `job-${type}`,
        job_number: 'SWX-9999',
        type,
        client_name: 'CAP0 TEST Q2.f',
        pricing_json: { totalIncGST: 100 },
      }],
      quoteRevInsertOk: true,
      insertedRevisionId: `rev-${type}`,
    })
    await runReleaseBlock(sb, {
      job_id: `job-${type}`,
      job: { client_email: 'marnin@secureworkswa.com.au', site_address: null, site_suburb: null },
      pdf_url: undefined,
      totalIncGST: 100,
    })
    const rev = sb._state.quoteRevisionInserts[0] as any
    assertEquals(rev.build_kind, expected, `type=${type} → build_kind=${expected}`)
  }
})

// ────────────────────────────────────────────────────────────────────────────
// Q3 — CAP0-QUOTE-REVISION-MANIFEST-STORAGE
// ────────────────────────────────────────────────────────────────────────────

Deno.test("Q3.a — successful upload: bytes land in release-manifests bucket at <hash>.json, manifest_url is the real private object URL", async () => {
  const sb = makeStubClient({
    updateReturns: [{
      id: 'job-q3a', job_number: 'SWP-3300', type: 'patio',
      client_name: 'CAP0 TEST Q3.a', pricing_json: { totalIncGST: 5500 },
    }],
    quoteRevInsertOk: true,
    insertedRevisionId: 'rev-q3a',
    uploadResult: 'ok',
  })
  await runReleaseBlock(sb, {
    job_id: 'job-q3a',
    job: { client_email: 'marnin@secureworkswa.com.au', site_address: '1 Test St', site_suburb: 'Perth' },
    pdf_url: undefined,
    totalIncGST: 5500,
  })
  // Exactly one upload to the dedicated bucket.
  assertEquals(sb._state.uploaded.length, 1)
  assertEquals(sb._state.uploaded[0].bucket, 'release-manifests')
  // Path is <hash>.json (sha256 hex + extension).
  assert(/^[0-9a-f]{64}\.json$/.test(sb._state.uploaded[0].path), `expected <hash>.json, got ${sb._state.uploaded[0].path}`)
  // Uploaded bytes hash to the stored manifest_hash (round-trip integrity).
  const rev = sb._state.quoteRevisionInserts[0] as any
  const recomputed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sb._state.uploaded[0].bytes))
  const recomputedHex = Array.from(new Uint8Array(recomputed)).map((b) => b.toString(16).padStart(2, '0')).join('')
  assertEquals(recomputedHex, rev.manifest_hash, 'sha256(uploaded body) === manifest_hash')
  // manifest_url is the real private object URL.
  assertEquals(rev.manifest_url, `${SUPABASE_URL}/storage/v1/object/release-manifests/${rev.manifest_hash}.json`)
})

Deno.test("Q3.b — upload failure: manifest_url falls back to internal stub; row is still INSERTed; canonical events still emit", async () => {
  // Upload failure (non-409) is best-effort: log [quote-revision-upload-fail],
  // fall back to stub URL, INSERT row with canonical bytes inline.
  const sb = makeStubClient({
    updateReturns: [{
      id: 'job-q3b', job_number: 'SWP-3400', type: 'patio',
      client_name: 'CAP0 TEST Q3.b', pricing_json: { totalIncGST: 5500 },
    }],
    quoteRevInsertOk: true,
    insertedRevisionId: 'rev-q3b',
    uploadResult: 'fail',
  })
  const { transitioned, releasedRevisionId } = await runReleaseBlock(sb, {
    job_id: 'job-q3b',
    job: { client_email: 'marnin@secureworkswa.com.au', site_address: null, site_suburb: null },
    pdf_url: undefined,
    totalIncGST: 5500,
  })
  // Release moment NOT rolled back.
  assertEquals(transitioned, true)
  assertEquals(releasedRevisionId, 'rev-q3b')
  // No bytes recorded (upload failed).
  assertEquals(sb._state.uploaded.length, 0)
  // Row is INSERTed with stub URL fallback.
  const rev = sb._state.quoteRevisionInserts[0] as any
  assertEquals(rev.manifest_url, `supabase-internal://manifest/${rev.manifest_hash}`)
  // Canonical bytes preserved inline → hash still verifiable.
  const recomputed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rev.manifest_canonical_text))
  const recomputedHex = Array.from(new Uint8Array(recomputed)).map((b) => b.toString(16).padStart(2, '0')).join('')
  assertEquals(recomputedHex, rev.manifest_hash)
  // Canonical events still fired with revision id.
  assertEquals(sb._state.businessEventsInserts.length, 2)
  const quoteSent = sb._state.businessEventsInserts.find((e: any) => e.event_type === 'quote.sent') as any
  assertEquals(quoteSent.payload.quote_revision_id, 'rev-q3b')
})

Deno.test("Q3.c — duplicate upload (409): treated as success, manifest_url is the real URL (same hash = same content)", async () => {
  // A retry with identical input produces the same hash; upload returns 409.
  // The existing object IS our content (sha256 collision-free assumption), so
  // we use the real URL — falling back to the stub would be a regression.
  const sb = makeStubClient({
    updateReturns: [{
      id: 'job-q3c', job_number: 'SWP-3500', type: 'patio',
      client_name: 'CAP0 TEST Q3.c', pricing_json: { totalIncGST: 5500 },
    }],
    quoteRevInsertOk: true,
    insertedRevisionId: 'rev-q3c',
    uploadResult: 'duplicate',
  })
  await runReleaseBlock(sb, {
    job_id: 'job-q3c',
    job: { client_email: 'marnin@secureworkswa.com.au', site_address: null, site_suburb: null },
    pdf_url: undefined,
    totalIncGST: 5500,
  })
  const rev = sb._state.quoteRevisionInserts[0] as any
  assertEquals(rev.manifest_url, `${SUPABASE_URL}/storage/v1/object/release-manifests/${rev.manifest_hash}.json`)
})
