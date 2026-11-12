// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts"
import {
  CUSTOMER_3D_PAGE_DEFAULT_URL,
  customer3dLink,
  customer3dPageOrigin,
  customer3dPageUrl,
  customerModelEmailBlock,
  customerSafeModel,
  handleCustomerModelRequest,
  readCustomerModelForToken,
  scopeRevisionHasCustomerModel,
  stampRunDocumentsRelease,
} from "./customer_model.ts"
import { buildQuoteEmail, buildRunsQuoteEmail } from "./index.ts"

type Row = Record<string, any>

const JOB = "11111111-1111-4111-8111-111111111111"
const DOC = "22222222-2222-4222-8222-222222222222"
const REL = "33333333-3333-4333-8333-333333333333"
const REV_A = "44444444-4444-4444-8444-444444444444"
const REV_B = "55555555-5555-4555-8555-555555555555"
const TOKEN = "tok-live"

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

function modelOf(label: string): Row {
  return {
    what: "patio",
    revision: "frozen-rev-id-should-not-leave",
    shapes: [{ kind: "run", outer: [0, 0, 1, 0, 1, 1], holes: [], length: 3.2 }],
    surfaces: [{ look: "colour:Monument", color: "#333", roughness: 0.5, metalness: 0, clearcoat: 0, clearcoatRoughness: 0, doubleSided: false, lawn: false }],
    pieces: [{ shape: 0, surface: 0, matrix: [1, 0, 0, 0], clip: [], notches: [] }],
    subject: [0, 0, 0, 1, 1, 1],
    house: null,
    front: [0, 1],
    ground: null,
    start: { key: "start", label, eye: [1, 2, 3], at: [0, 0, 0], fov: 40 },
    views: [],
  }
}

/** A small PostgREST + Storage fake: equality filters, order, limit, maybeSingle, update. */
function fakeClient(tables: Record<string, Row[]>, files: Record<string, Uint8Array>, fail: Set<string> = new Set()) {
  const updates: Array<{ table: string; values: Row; id: unknown }> = []
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    const orders: Array<{ col: string; asc: boolean }> = []
    let lim: number | null = null
    let mode: "select" | "update" = "select"
    let values: Row = {}
    let eqId: unknown = null
    const run = () => {
      if (fail.has(table)) return { data: null, error: { message: `${table} read failed` } }
      let rows = (tables[table] || []).filter((r) => filters.every((f) => f(r)))
      for (const o of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => (a[o.col] < b[o.col] ? -1 : a[o.col] > b[o.col] ? 1 : 0) * (o.asc ? 1 : -1))
      }
      if (lim != null) rows = rows.slice(0, lim)
      if (mode === "update") {
        for (const r of rows) Object.assign(r, values)
        updates.push({ table, values, id: eqId })
        return { data: rows, error: null }
      }
      return { data: rows, error: null }
    }
    const q: any = {
      select: () => q,
      update: (v: Row) => { mode = "update"; values = v; return q },
      eq: (c: string, v: unknown) => { if (c === "id") eqId = v; filters.push((r) => r[c] === v); return q },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return q },
      order: (c: string, o?: { ascending?: boolean }) => { orders.push({ col: c, asc: o?.ascending !== false }); return q },
      limit: (n: number) => { lim = n; return q },
      maybeSingle: async () => {
        const r = run()
        if (r.error) return r
        return { data: (r.data as Row[])[0] ?? null, error: null }
      },
      then: (ok: any, bad: any) => Promise.resolve(run()).then(ok, bad),
    }
    return q
  }
  const storage = {
    from: (bucket: string) => ({
      download: async (path: string) => {
        if (fail.has("storage")) return { data: null, error: { message: "storage down" } }
        const bytes = files[`${bucket}/${path}`]
        return bytes ? { data: new Blob([bytes as BlobPart]), error: null } : { data: null, error: { message: "not found" } }
      },
    }),
  }
  return { from, storage, updates }
}

/** A sent patio quote released as revision A, with a model saved on A and a later draft B with its own model. */
async function world(opts: { modelOnA?: boolean; modelOnB?: boolean; superseded?: boolean; link?: boolean } = {}) {
  const { modelOnA = true, modelOnB = true, superseded = false, link = true } = opts
  const bytesA = new TextEncoder().encode(JSON.stringify(modelOf("rev A view")))
  const bytesB = new TextEncoder().encode(JSON.stringify(modelOf("rev B view")))
  const shaA = await sha256Hex(bytesA)
  const shaB = await sha256Hex(bytesB)
  const artifacts: Row[] = []
  if (modelOnA) artifacts.push({ id: "art-a", scope_revision_id: REV_A, artifact_type: "customer_model", bucket_id: "scope-artifacts", storage_path: `${REV_A}/${shaA}.json`, sha256: shaA, content_type: "application/json", created_at: "2026-11-12T10:00:00Z" })
  if (modelOnB) artifacts.push({ id: "art-b", scope_revision_id: REV_B, artifact_type: "customer_model", bucket_id: "scope-artifacts", storage_path: `${REV_B}/${shaB}.json`, sha256: shaB, content_type: "application/json", created_at: "2026-11-12T11:00:00Z" })
  const tables: Record<string, Row[]> = {
    job_documents: [{
      id: DOC, job_id: JOB, type: "quote", share_token: TOKEN, sent_to_client: true,
      quote_revision_id: link ? REL : null, superseded_at: superseded ? "2026-11-12T12:00:00Z" : null, metadata: null,
    }],
    quote_revisions: [{ id: REL, job_id: JOB, job_document_id: DOC, sent_at: "2026-11-12T10:05:00Z", scope_revision_id: REV_A, released_via: "send-quote/send" }],
    scope_revisions: [
      { id: REV_A, job_id: JOB, revision_number: 1, status: "superseded" },
      { id: REV_B, job_id: JOB, revision_number: 2, status: "frozen" },
    ],
    scope_artifacts: artifacts,
  }
  const files = {
    [`scope-artifacts/${REV_A}/${shaA}.json`]: bytesA,
    [`scope-artifacts/${REV_B}/${shaB}.json`]: bytesB,
  }
  return { tables, files }
}

Deno.test("model route: a sent quote answers 200 with its released revision's model and label", async () => {
  const { tables, files } = await world()
  const r = await readCustomerModelForToken(fakeClient(tables, files), TOKEN)
  assertEquals(r.status, 200)
  if (r.status !== 200) return
  assertEquals(r.body.rev_label, "Rev 1")
  assertEquals((r.body.model.start as Row).label, "rev A view")
})

Deno.test("model route: wrong-revision trap, a later draft's model is never shown", async () => {
  // Revision B (later, frozen, with its own model) must not be served for a link released as A.
  const { tables, files } = await world({ modelOnA: false, modelOnB: true })
  const r = await readCustomerModelForToken(fakeClient(tables, files), TOKEN)
  assertEquals(r.status, 404)
  const both = await world()
  const r2 = await readCustomerModelForToken(fakeClient(both.tables, both.files), TOKEN)
  assertEquals(r2.status, 200)
  if (r2.status === 200) assertEquals((r2.body.model.start as Row).label, "rev A view")
})

Deno.test("model route: a replaced quote answers 410 { current: true }", async () => {
  const { tables, files } = await world({ superseded: true })
  const r = await readCustomerModelForToken(fakeClient(tables, files), TOKEN)
  assertEquals(r.status, 410)
  assertEquals(r.body, { current: true })
})

Deno.test("model route: no model answers 404", async () => {
  const { tables, files } = await world({ modelOnA: false, modelOnB: false })
  assertEquals((await readCustomerModelForToken(fakeClient(tables, files), TOKEN)).status, 404)
})

Deno.test("model route: a send with no recorded release answers 404", async () => {
  const { tables, files } = await world({ link: false })
  assertEquals((await readCustomerModelForToken(fakeClient(tables, files), TOKEN)).status, 404)
})

Deno.test("model route: wrong or empty token answers 404", async () => {
  const { tables, files } = await world()
  const c = fakeClient(tables, files)
  assertEquals((await readCustomerModelForToken(c, "tok-nope")).status, 404)
  assertEquals((await readCustomerModelForToken(c, "")).status, 404)
  assertEquals((await readCustomerModelForToken(c, null)).status, 404)
})

Deno.test("model route: a release made for another document is not followed", async () => {
  const { tables, files } = await world()
  tables.quote_revisions[0].job_document_id = "99999999-9999-4999-8999-999999999999"
  assertEquals((await readCustomerModelForToken(fakeClient(tables, files), TOKEN)).status, 404)
})

Deno.test("model route: a model whose bytes no longer match its recorded hash is not served", async () => {
  const { tables, files } = await world()
  files[`scope-artifacts/${tables.scope_artifacts[0].storage_path}`] = new TextEncoder().encode(JSON.stringify(modelOf("tampered")))
  assertEquals((await readCustomerModelForToken(fakeClient(tables, files), TOKEN)).status, 404)
})

Deno.test("model route: a failed read answers 503, never a guess", async () => {
  for (const t of ["job_documents", "quote_revisions", "scope_revisions", "scope_artifacts", "storage"]) {
    const { tables, files } = await world()
    const r = await readCustomerModelForToken(fakeClient(tables, files, new Set([t])), TOKEN)
    assertEquals(r.status, 503, t)
  }
})

Deno.test("model route: the answer carries no revision id, product code, price, name, address or email", async () => {
  const { tables, files } = await world()
  const r = await readCustomerModelForToken(fakeClient(tables, files), TOKEN)
  assertEquals(r.status, 200)
  const text = JSON.stringify(r.body)
  assert(!text.includes("frozen-rev-id-should-not-leave"))
  assert(!text.includes("Monument"))
  assertEquals(Object.keys(r.body).sort(), ["model", "rev_label"])
  // Keys the tool never sends are dropped; text with a price or an email refuses the model.
  const extra = customerSafeModel({ ...modelOf("x"), clientName: "A Person", site_address: "1 Some St", price: 9 }) as Row
  assertEquals(extra.clientName, undefined)
  assertEquals(extra.site_address, undefined)
  assertEquals(extra.price, undefined)
  assertEquals(customerSafeModel({ ...modelOf("x"), contextNote: "Total $4,500" }), null)
  assertEquals(customerSafeModel({ ...modelOf("x"), notes: ["call someone@example.com"] }), null)
  assertEquals(customerSafeModel({ what: "deck" }), null)
})

Deno.test("model route: cross-site reads only from the hosted page's origin, no-store", async () => {
  const { tables, files } = await world()
  const res = await handleCustomerModelRequest(
    new Request(`https://x.supabase.co/functions/v1/send-quote/model?token=${TOKEN}`, { headers: { Origin: "https://evil.example" } }),
    fakeClient(tables, files),
    CUSTOMER_3D_PAGE_DEFAULT_URL,
  )
  assertEquals(res.status, 200)
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "https://marninms98-dotcom.github.io")
  assertEquals(res.headers.get("Cache-Control"), "no-store")
  const pre = await handleCustomerModelRequest(
    new Request("https://x.supabase.co/functions/v1/send-quote/model", { method: "OPTIONS" }),
    fakeClient(tables, files),
    CUSTOMER_3D_PAGE_DEFAULT_URL,
  )
  assertEquals(pre.status, 204)
  assertEquals(pre.headers.get("Access-Control-Allow-Origin"), "https://marninms98-dotcom.github.io")
  const post = await handleCustomerModelRequest(
    new Request("https://x.supabase.co/functions/v1/send-quote/model", { method: "POST" }),
    fakeClient(tables, files),
    CUSTOMER_3D_PAGE_DEFAULT_URL,
  )
  assertEquals(post.status, 405)
  const gone = await handleCustomerModelRequest(
    new Request(`https://x.supabase.co/functions/v1/send-quote/model?token=${TOKEN}`),
    fakeClient((await world({ superseded: true })).tables, files),
    CUSTOMER_3D_PAGE_DEFAULT_URL,
  )
  assertEquals(gone.status, 410)
  assertEquals(await gone.json(), { current: true })
})

Deno.test("page address: only https on a tool host, else the default; origin and link", () => {
  assertEquals(customer3dPageUrl(null), CUSTOMER_3D_PAGE_DEFAULT_URL)
  assertEquals(customer3dPageUrl("http://marninms98-dotcom.github.io/x.html"), CUSTOMER_3D_PAGE_DEFAULT_URL)
  assertEquals(customer3dPageUrl("https://evil.example/quote-3d.html"), CUSTOMER_3D_PAGE_DEFAULT_URL)
  assertEquals(customer3dPageUrl("https://secureworks-group.github.io/patio/quote-3d.html"), "https://secureworks-group.github.io/patio/quote-3d.html")
  assertEquals(customer3dPageOrigin(CUSTOMER_3D_PAGE_DEFAULT_URL), "https://marninms98-dotcom.github.io")
  assertEquals(customer3dLink(CUSTOMER_3D_PAGE_DEFAULT_URL, "abc"), `${CUSTOMER_3D_PAGE_DEFAULT_URL}?token=abc`)
})

Deno.test("fence runs: a stamped run document reaches the call's release; a stamp names only a runs release", async () => {
  const { tables, files } = await world()
  const runDoc = "66666666-6666-4666-8666-666666666666"
  tables.quote_revisions[0].released_via = "send-quote/send-runs"
  tables.job_documents.push({ id: runDoc, job_id: JOB, type: "quote", share_token: "tok-neighbour", sent_to_client: true, quote_revision_id: null, superseded_at: null, metadata: { other: 1 } })
  const c = fakeClient(tables, files)
  assertEquals((await readCustomerModelForToken(c, "tok-neighbour")).status, 404)
  await stampRunDocumentsRelease(c, [runDoc, runDoc], REL, { job_id: JOB })
  const stamped = tables.job_documents.find((d) => d.id === runDoc)!
  assertEquals(stamped.metadata, { other: 1, released_quote_revision_id: REL })
  assertEquals(c.updates.length, 1)
  assertEquals((await readCustomerModelForToken(c, "tok-neighbour")).status, 200)
  // An existing stamp is never moved.
  await stampRunDocumentsRelease(c, [runDoc], "77777777-7777-4777-8777-777777777777", { job_id: JOB })
  assertEquals(stamped.metadata.released_quote_revision_id, REL)
  // A stamp naming a non-runs release is not followed.
  tables.quote_revisions[0].released_via = "send-quote/send"
  assertEquals((await readCustomerModelForToken(c, "tok-neighbour")).status, 404)
})

Deno.test("email button: shown only when the sealed revision has a model", async () => {
  const { tables, files } = await world({ modelOnA: true, modelOnB: false })
  const c = fakeClient(tables, files)
  assert(await scopeRevisionHasCustomerModel(c, REV_A))
  assert(!(await scopeRevisionHasCustomerModel(c, REV_B)))
  assert(!(await scopeRevisionHasCustomerModel(c, null)))
  assert(!(await scopeRevisionHasCustomerModel(fakeClient(tables, files, new Set(["scope_artifacts"])), REV_A)))
})

Deno.test("patio quote email: third button with the same token, only with a model", () => {
  const base = {
    clientName: "there", viewUrl: "https://x/view?token=abc", pdfUrl: "https://x/q.pdf",
    projectType: "patio", suburb: "", customMessage: "", scoperName: "The SecureWorks Team",
  }
  const without = buildQuoteEmail(base)
  assert(!without.includes("in 3D"))
  const link = customer3dLink(CUSTOMER_3D_PAGE_DEFAULT_URL, "abc")
  const withModel = buildQuoteEmail({ ...base, model3dUrl: link, model3dWhat: "patio" })
  assertStringIncludes(withModel, "We have also drawn your patio in 3D from this quote. Turn it round and zoom in on your phone.")
  assertStringIncludes(withModel, "See your patio in 3D")
  assertStringIncludes(withModel, `href="${link}"`)
  assertStringIncludes(withModel, "View Your Quote")
  assert(!withModel.includes("—"), "no em dash")
})

Deno.test("fence runs email: third button with the recipient's token, only with a model", () => {
  const base = { recipientName: "there", message: "", suburb: "", runCount: 2, runLinks: "<a>runs</a>" }
  const without = buildRunsQuoteEmail(base)
  assert(!without.includes("in 3D"))
  const link = customer3dLink(CUSTOMER_3D_PAGE_DEFAULT_URL, "tok-run")
  const withModel = buildRunsQuoteEmail({ ...base, model3dUrl: link })
  assertStringIncludes(withModel, "We have also drawn your fence in 3D from this quote. Turn it round and zoom in on your phone.")
  assertStringIncludes(withModel, "See your fence in 3D")
  assertStringIncludes(withModel, `href="${link}"`)
  assert(!withModel.includes("—"), "no em dash")
  assertEquals(customerModelEmailBlock({ what: "fence", url: null }), "")
})

Deno.test("migration not applied: no model row can exist, so the route is a plain 404 and the email has no button", async () => {
  // Without the migration the database refuses every customer_model row, so a
  // sealed revision has none: exactly the no-model world.
  const { tables, files } = await world({ modelOnA: false, modelOnB: false })
  const c = fakeClient(tables, files)
  const res = await handleCustomerModelRequest(
    new Request(`https://x.supabase.co/functions/v1/send-quote/model?token=${TOKEN}`),
    c,
    CUSTOMER_3D_PAGE_DEFAULT_URL,
  )
  assertEquals(res.status, 404)
  assertEquals(await res.json(), { error: "not_available" })
  assert(!(await scopeRevisionHasCustomerModel(c, REV_A)))
  const email = buildQuoteEmail({
    clientName: "there", viewUrl: "https://x/view?token=abc", pdfUrl: "",
    projectType: "patio", suburb: "", customMessage: "", scoperName: "The SecureWorks Team",
    model3dUrl: (await scopeRevisionHasCustomerModel(c, REV_A)) ? customer3dLink(CUSTOMER_3D_PAGE_DEFAULT_URL, "abc") : null,
  })
  assert(!email.includes("in 3D"))
  assertStringIncludes(email, "View Your Quote")
})
