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

/** A stored model; `label` is what the bytes claim (never served), `fov` tells revisions apart. */
function modelOf(label: string, fov = 40): Row {
  return {
    what: "patio",
    revision: "frozen-rev-id-should-not-leave",
    shapes: [{ kind: "run", outer: [0, 0, 1, 0, 1, 1], holes: [], length: 3.2 }],
    surfaces: [{ look: "colour:Monument", color: "#333333", roughness: 0.5, metalness: 0, clearcoat: 0, clearcoatRoughness: 0, doubleSided: false, lawn: false }],
    pieces: [{ shape: 0, surface: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], clip: [], notches: [] }],
    subject: [0, 0, 0, 1, 1, 1],
    house: null,
    front: [0, 1],
    ground: null,
    start: { key: "start", label, eye: [1, 2, 3], at: [0, 0, 0], fov },
    views: [],
  }
}

const sameJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as Row), kb = Object.keys(b as Row)
  return ka.length === kb.length && ka.every((k) => sameJson((a as Row)[k], (b as Row)[k]))
}
/** A column filter's value: a plain column, or a jsonb text path (metadata->>key). */
const colValue = (r: Row, c: string): unknown => {
  const [col, key] = c.split("->>")
  if (key === undefined) return r[col] ?? null
  const v = r[col]
  return v && typeof v === "object" && v[key] != null ? String(v[key]) : null
}

/**
 * A small PostgREST + Storage fake: equality filters (a jsonb column compares
 * by value, as Postgres does), is-null on a column or a metadata->>key path,
 * order, limit, maybeSingle, update (returning the rows it matched).
 */
function fakeClient(tables: Record<string, Row[]>, files: Record<string, Uint8Array>, fail: Set<string> = new Set()) {
  const updates: Array<{ table: string; values: Row; id: unknown; matched: number }> = []
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
        updates.push({ table, values, id: eqId, matched: rows.length })
        return { data: rows, error: null }
      }
      return { data: rows, error: null }
    }
    const q: any = {
      select: () => q,
      update: (v: Row) => { mode = "update"; values = v; return q },
      eq: (c: string, v: unknown) => {
        if (c === "id") eqId = v
        filters.push(c === "metadata" && typeof v === "string" ? (r) => sameJson(r[c], JSON.parse(v)) : (r) => r[c] === v)
        return q
      },
      is: (c: string, v: unknown) => { filters.push((r) => colValue(r, c) === v); return q },
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
  const bytesB = new TextEncoder().encode(JSON.stringify(modelOf("rev B view", 41)))
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
  assertEquals((r.body.model.start as Row).fov, 40)
})

Deno.test("model route: wrong-revision trap, a later draft's model is never shown", async () => {
  // Revision B (later, frozen, with its own model) must not be served for a link released as A.
  const { tables, files } = await world({ modelOnA: false, modelOnB: true })
  const r = await readCustomerModelForToken(fakeClient(tables, files), TOKEN)
  assertEquals(r.status, 404)
  const both = await world()
  const r2 = await readCustomerModelForToken(fakeClient(both.tables, both.files), TOKEN)
  assertEquals(r2.status, 200)
  if (r2.status === 200) assertEquals((r2.body.model.start as Row).fov, 40)
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
  // Unknown top-level keys are dropped; text that is not plain words is dropped or blanked.
  const extra = customerSafeModel({ ...modelOf("x"), clientName: "A Person", site_address: "1 Some St", price: 9 }) as Row
  assertEquals(extra.clientName, undefined)
  assertEquals(extra.site_address, undefined)
  assertEquals(extra.price, undefined)
  assertEquals((customerSafeModel({ ...modelOf("x"), contextNote: "Total $4,500" }) as Row).contextNote, undefined)
  assertEquals((customerSafeModel({ ...modelOf("x"), contextNote: "Call 0400 000 000" }) as Row).contextNote, undefined)
  assertEquals((customerSafeModel({ ...modelOf("x"), contextNote: "The house and surroundings are indicative." }) as Row).contextNote,
    "The house and surroundings are indicative.")
  assertEquals((customerSafeModel({ ...modelOf("x"), contextNote: "The house and surroundings are indicative. Wall fixing shown in cutaway; anchor heads, washers and order lengths are to confirm." }) as Row).contextNote,
    "The house and surroundings are indicative. Wall fixing shown in cutaway; anchor heads, washers and order lengths are to confirm.")
  // Labels are rebuilt from the key, never read from the bytes.
  assertEquals((customerSafeModel(modelOf("someone@example.com")) as Row).start, { key: "start", label: "Your patio", eye: [1, 2, 3], at: [0, 0, 0], fov: 40 })
  assertEquals((customerSafeModel({ ...modelOf("x"), what: "fence" }) as Row).start.label, "Your fence")
  assertEquals(customerSafeModel({ what: "deck" }), null)
})

Deno.test("model route: planted fields at every level never reach the public answer", async () => {
  // Stored bytes with a valid hash but extra content: notes, unknown keys, and a
  // price, token or supplier nested under allowed keys. The route rebuilds the
  // declared geometry and none of it leaves.
  const planted = modelOf("Your patio") as Row
  planted.notes = ["Hardware kit from a named supplier, 1 Some St"]
  planted.secretTop = "tok-planted-top"
  planted.surfaces[0].price = 412.5
  planted.surfaces[0].token = "tok-planted-surface"
  planted.pieces[0].supplier = "Named Supplier Pty Ltd"
  planted.shapes[0].cost = { ex: 99 }
  planted.start.owner = "A Person"
  planted.houseWalls = [{ from: [0, 0, 0], to: [1, 0, 0], out: [0, 0, 1], height: 2.4, address: "1 Some St" }]
  planted.runs = [{ a: [0, 0], b: [1, 0], out: [0, 1], gaps: [[0.2, 1.1]], gate_price: 800 }]
  // Planted text in the three text places: the house note, a known view's
  // label, and a view under a key the tool never makes.
  planted.contextNote = "Arranged by Jo Bloggs, mobile 0400 111 222, deposit paid"
  planted.start.label = "Quote for Jo Bloggs"
  planted.views = [
    { key: "side", label: "Jo Bloggs side yard, 12 Example Rd", eye: [4, 2, 0], at: [0, 0, 0], fov: 42 },
    { key: "under", label: "Kit price list", eye: [1, 1, 1], at: [0, 0, 0], fov: 42, cutaway: true },
    { key: "invoice", label: "Balance owing", eye: [2, 2, 2], at: [0, 0, 0], fov: 42 },
  ]
  const { tables, files } = await world({ modelOnB: false })
  const bytes = new TextEncoder().encode(JSON.stringify(planted))
  const sha = await sha256Hex(bytes)
  Object.assign(tables.scope_artifacts[0], { sha256: sha, storage_path: `${REV_A}/${sha}.json` })
  files[`scope-artifacts/${REV_A}/${sha}.json`] = bytes
  const res = await handleCustomerModelRequest(
    new Request(`https://x.supabase.co/functions/v1/send-quote/model?token=${TOKEN}`),
    fakeClient(tables, files),
    CUSTOMER_3D_PAGE_DEFAULT_URL,
  )
  assertEquals(res.status, 200)
  const body = await res.json()
  const text = JSON.stringify(body)
  for (const leak of ["Jo Bloggs", "0400", "deposit", "Quote for", "Example Rd", "Kit price", "invoice", "Balance owing", "contextNote", "notes", "Hardware", "secretTop", "tok-planted", "price", "412.5", "token", "supplier", "Supplier", "cost", "owner", "A Person", "address", "Some St", "gate_price", "revision", "Monument"]) {
    assert(!text.includes(leak), `leaked: ${leak}`)
  }
  const m = body.model
  assertEquals(Object.keys(m.surfaces[0]).sort(), ["clearcoat", "clearcoatRoughness", "color", "doubleSided", "lawn", "look", "metalness", "roughness"])
  assertEquals(m.surfaces[0].look, "colour:")
  assertEquals(Object.keys(m.pieces[0]).sort(), ["clip", "matrix", "notches", "shape", "surface"])
  assertEquals(m.houseWalls, [{ from: [0, 0, 0], to: [1, 0, 0], out: [0, 0, 1], height: 2.4 }])
  assertEquals(m.runs, [{ a: [0, 0], b: [1, 0], out: [0, 1], gaps: [[0.2, 1.1]] }])
  assertEquals(m.start.label, "Your patio")
  assertEquals(m.views, [
    { key: "side", label: "From the side", eye: [4, 2, 0], at: [0, 0, 0], fov: 42 },
    { key: "under", label: "Wall fixing (cutaway)", eye: [1, 1, 1], at: [0, 0, 0], fov: 42, cutaway: true },
  ])
})

Deno.test("model route: a model not of the declared shape is refused, never half-served", () => {
  const bad: Array<[string, (m: Row) => void]> = [
    ["text in a number list", (m) => { m.subject = [0, 0, 0, 1, 1, "tok"] }],
    ["object in a number list", (m) => { m.shapes[0].outer = [0, { price: 1 }] }],
    ["a surface colour that is not a colour", (m) => { m.surfaces[0].color = "tok-abc" }],
    ["a piece naming a shape that is not there", (m) => { m.pieces[0].shape = 4 }],
    ["an unknown shape kind", (m) => { m.shapes[0] = { kind: "text", value: "hello" } }],
    ["a view key that is not a key", (m) => { m.start.key = "a b c $5" }],
    ["a wall connection outside the list", (m) => { m.pieces[0].wallConnection = "supplier" }],
  ]
  for (const [why, plant] of bad) {
    const m = structuredClone(modelOf("x"))
    plant(m)
    assertEquals(customerSafeModel(m), null, why)
  }
  // An unknown look passes as blank, never as its text.
  const odd = structuredClone(modelOf("x"))
  odd.surfaces[0].look = "sku:ABC-123"
  assertEquals((customerSafeModel(odd) as Row).surfaces, [{ ...odd.surfaces[0], look: "" }])
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

/** Two stamping calls that both read the document before either writes. */
function racingClient(tables: Record<string, Row[]>, files: Record<string, Uint8Array>, readers = 2, between?: () => void) {
  const c = fakeClient(tables, files)
  let reads = 0
  let open!: () => void
  const gate = new Promise<void>((resolve) => { open = resolve })
  const from = (table: string) => {
    const q = c.from(table)
    if (table !== "job_documents") return q
    const maybeSingle = q.maybeSingle
    q.maybeSingle = async () => {
      const r = await maybeSingle()
      reads++
      if (reads <= readers) {
        if (reads === readers) { between?.(); open() }
        await gate
      }
      return r
    }
    return q
  }
  return { ...c, from }
}

Deno.test("fence runs: two calls racing on one document never write two release ids", async () => {
  const runDoc = "66666666-6666-4666-8666-666666666666"
  const OTHER = "77777777-7777-4777-8777-777777777777"
  const { tables, files } = await world()
  tables.job_documents.push({ id: runDoc, job_id: JOB, type: "quote", share_token: "tok-n", sent_to_client: true, quote_revision_id: null, superseded_at: null, metadata: { other: 1 } })
  const c = racingClient(tables, files)
  await Promise.all([
    stampRunDocumentsRelease(c, [runDoc], REL, { job_id: JOB }),
    stampRunDocumentsRelease(c, [runDoc], OTHER, { job_id: JOB }),
  ])
  const doc = tables.job_documents.find((d) => d.id === runDoc)!
  // Exactly one write landed; the loser re-read, saw a stamp, and left it.
  const writes = c.updates.filter((u) => u.table === "job_documents")
  assertEquals(writes.length, 2) // both tried
  assertEquals(writes.filter((u) => u.matched > 0).length, 1) // one landed
  assertEquals(doc.metadata.other, 1)
  assert(doc.metadata.released_quote_revision_id === REL || doc.metadata.released_quote_revision_id === OTHER)
  const winner = doc.metadata.released_quote_revision_id
  // Run again with the other id: still never moved.
  await stampRunDocumentsRelease(fakeClient(tables, files), [runDoc], winner === REL ? OTHER : REL, { job_id: JOB })
  assertEquals(doc.metadata.released_quote_revision_id, winner)
})

Deno.test("fence runs: a key another writer adds between the read and the stamp is kept", async () => {
  const runDoc = "66666666-6666-4666-8666-666666666666"
  const { tables, files } = await world()
  const row: Row = { id: runDoc, job_id: JOB, type: "quote", share_token: "tok-n", sent_to_client: true, quote_revision_id: null, superseded_at: null, metadata: null }
  tables.job_documents.push(row)
  const c = racingClient(tables, files, 1, () => { row.metadata = { viewed_at: "2026-11-12T12:00:00Z" } })
  await stampRunDocumentsRelease(c, [runDoc], REL, { job_id: JOB })
  assertEquals(row.metadata, { viewed_at: "2026-11-12T12:00:00Z", released_quote_revision_id: REL })
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
