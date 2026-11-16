// House-plans upload guard (upload_plans.ts), director's ruling 5.
// Run: deno test --allow-read supabase/functions/send-quote/upload_plans_test.ts
import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import { handleUploadPlans, resolveUploadPlansJob, safePlanFilename } from './upload_plans.ts'

const JOB = 'job-a'
const OTHER_JOB = 'job-b'
const TOKEN = 'token-for-job-a'
const PDF = btoa('%PDF-1.4 plans')

type World = {
  docs: Record<string, { job_id: string; jobs?: unknown }>
  readError?: boolean
  submission?: { id: string; steps: any[] } | null
}

function harness(world: World, opts: { storeError?: unknown; storeThrows?: boolean } = {}) {
  const writes: { table: string; op: string; row: unknown }[] = []
  const stored: string[] = []
  const evidence: unknown[] = []
  const sb = {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { filters[c] = v; return q },
        maybeSingle: async () => {
          if (table === 'job_documents') {
            if (world.readError) return { data: null, error: { message: 'down' } }
            return { data: world.docs[String(filters.share_token)] ?? null, error: null }
          }
          if (table === 'council_submissions') return { data: world.submission ?? null, error: null }
          return { data: null, error: null }
        },
        insert: (row: unknown) => { writes.push({ table, op: 'insert', row }); return Promise.resolve({ error: null }) },
        update: (row: unknown) => {
          writes.push({ table, op: 'update', row })
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
      return q
    },
  }
  const deps = {
    sb,
    store: async (path: string) => {
      if (opts.storeThrows) throw new Error('storage offline')
      if (opts.storeError) return { error: opts.storeError }
      stored.push(path)
      return { error: null }
    },
    publicUrl: (path: string) => `https://files.example/${path}`,
    recordEvidence: async (row: unknown) => { evidence.push(row) },
    orgId: 'org-1',
    now: () => new Date('2026-11-12T12:00:00Z'),
  }
  return { deps, writes, stored, evidence }
}

function pendingSubmission() {
  return { id: 'sub-1', steps: [{ status: 'pending' }, { status: 'pending' }] }
}

function assertNothingWritten(h: ReturnType<typeof harness>) {
  assertEquals(h.stored, [], 'stored a file')
  assertEquals(h.evidence, [], 'recorded evidence')
  assertEquals(h.writes, [], 'wrote a row')
}

Deno.test('success: stored, then recorded, then council step moves; answers received', async () => {
  const h = harness({ docs: { [TOKEN]: { job_id: JOB } }, submission: pendingSubmission() })
  const r = await handleUploadPlans(h.deps, { token: TOKEN, job_id: JOB, filename: 'plans.pdf', content_base64: PDF })
  assertEquals(r.status, 200)
  assertEquals(r.body.success, true)
  assertEquals(h.stored.length, 1)
  assert(h.stored[0].startsWith(`${JOB}/council/house-plans/`))
  assertEquals(h.evidence.length, 1)
  assertEquals(h.writes.map((w) => `${w.table}:${w.op}`), ['ai_annotations:insert', 'council_submissions:update'])
  const step = (h.writes[1].row as any).steps[0]
  assertEquals(step.status, 'complete')
})

Deno.test('success with no job named: the token decides the job', async () => {
  const h = harness({ docs: { [TOKEN]: { job_id: JOB } } })
  const r = await handleUploadPlans(h.deps, { token: TOKEN, content_base64: PDF })
  assertEquals(r.status, 200)
  assert(h.stored[0].startsWith(`${JOB}/`))
})

Deno.test('wrong token: refused, nothing written', async () => {
  const h = harness({ docs: { [TOKEN]: { job_id: JOB } }, submission: pendingSubmission() })
  const r = await handleUploadPlans(h.deps, { token: 'made-up', job_id: JOB, content_base64: PDF })
  assertEquals(r.status, 404)
  assert(r.body.error)
  assertNothingWritten(h)
})

Deno.test('regression: a valid token for another job cannot upload to (or complete the council step of) this job', async () => {
  const h = harness({ docs: { [TOKEN]: { job_id: JOB } }, submission: pendingSubmission() })
  const r = await handleUploadPlans(h.deps, { token: TOKEN, job_id: OTHER_JOB, content_base64: PDF })
  assertEquals(r.status, 403)
  assertEquals(r.body.error, 'link_not_for_this_job')
  assertNothingWritten(h)
})

Deno.test('no token: refused, nothing written (a job id alone is not enough)', async () => {
  for (const token of [undefined, '', '   ']) {
    const h = harness({ docs: { [TOKEN]: { job_id: JOB } }, submission: pendingSubmission() })
    const r = await handleUploadPlans(h.deps, { token, job_id: JOB, content_base64: PDF })
    assert(r.status >= 400 && r.status < 500, `status ${r.status}`)
    assertNothingWritten(h)
  }
})

Deno.test('link read fails: refused, nothing written', async () => {
  const h = harness({ docs: { [TOKEN]: { job_id: JOB } }, readError: true, submission: pendingSubmission() })
  const r = await handleUploadPlans(h.deps, { token: TOKEN, job_id: JOB, content_base64: PDF })
  assertEquals(r.status, 503)
  assertNothingWritten(h)
})

for (const [label, opts] of [
  ['storage returns an error', { storeError: { message: 'bucket full' } }],
  ['storage throws', { storeThrows: true }],
] as const) {
  Deno.test(`regression: ${label}: never says received, records nothing, council step not moved`, async () => {
    const h = harness({ docs: { [TOKEN]: { job_id: JOB } }, submission: pendingSubmission() }, opts)
    const r = await handleUploadPlans(h.deps, { token: TOKEN, job_id: JOB, content_base64: PDF })
    assertEquals(r.status, 502)
    assertEquals(r.body.error, 'upload_failed')
    assert(r.body.success !== true)
    assertNothingWritten(h)
  })
}

Deno.test('unreadable or empty file: refused, nothing written', async () => {
  for (const content_base64 of ['%%%not base64%%%', btoa('')]) {
    const h = harness({ docs: { [TOKEN]: { job_id: JOB } } })
    const r = await handleUploadPlans(h.deps, { token: TOKEN, job_id: JOB, content_base64: content_base64 || 'x' })
    assertEquals(r.status, 400)
    assertNothingWritten(h)
  }
})

Deno.test('file name cannot climb out of the job folder', () => {
  assertEquals(safePlanFilename('../../job-b/council/evil.pdf'), 'evil.pdf')
  assertEquals(safePlanFilename('..\\x.pdf'), 'x.pdf')
  assertEquals(safePlanFilename('..'), 'house-plans.pdf')
  assertEquals(safePlanFilename(undefined), 'house-plans.pdf')
  assertEquals(safePlanFilename('plans.pdf'), 'plans.pdf')
})

Deno.test('page (GET): an unknown token or another job is refused', async () => {
  const sb = harness({ docs: { [TOKEN]: { job_id: JOB } } }).deps.sb
  assertEquals((await resolveUploadPlansJob(sb, 'made-up', JOB)).ok, false)
  assertEquals((await resolveUploadPlansJob(sb, TOKEN, OTHER_JOB)).ok, false)
  assertEquals((await resolveUploadPlansJob(sb, null, JOB)).ok, false)
  const ok = await resolveUploadPlansJob(sb, TOKEN, JOB)
  assertEquals(ok.ok && ok.jobId, JOB)
})

Deno.test('index.ts routes both upload doors through the guard; pages say received only on success', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url))
  assert(src.includes("from './upload_plans.ts'"))
  assert(src.includes("resolveUploadPlansJob(sb, url.searchParams.get('token'), url.searchParams.get('job'))"))
  assert(src.includes('const result = await handleUploadPlans({'))
  assert(!src.includes('const jId = job_id || doc?.job_id'), 'old job-id-over-token rule still present')
  assertEquals((src.match(/data\.success !== true/g) || []).length, 2, 'both upload pages must require success')
  // The bucket's visibility is not changed: the existing create call is kept as it was.
  assertEquals((src.match(/createBucket\('job-documents', \{ public: true \}\)/g) || []).length, 1)
})
