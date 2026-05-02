// ════════════════════════════════════════════════════════════
// send-po-email — recipient verification tests
//
// Mirrors T2's approve_and_send_test.ts pattern: stub the Supabase client,
// invoke `_verifyPoEmailRecipient`, assert each rejection code + happy path.
//
// Run: npx -y deno test --no-check --allow-env --allow-net=127.0.0.1 \
//   supabase/functions/send-po-email/send_po_email_test.ts
// ════════════════════════════════════════════════════════════

import { _verifyPoEmailRecipient } from "./index.ts"

interface StubFixtures {
  po?: any | null;
  poError?: any;
  supplier?: any | null;
  supplierError?: any;
}

function makeStubClient(fix: StubFixtures = {}): { client: any; calls: Array<{ table: string; method: string; args?: any }> } {
  const calls: Array<{ table: string; method: string; args?: any }> = []
  const client = {
    from: (table: string) => {
      const builder: any = {
        _table: table,
        _filters: {} as Record<string, any>,
        select: (s: string) => { calls.push({ table, method: "select", args: s }); return builder },
        eq: (k: string, v: any) => { calls.push({ table, method: "eq", args: { k, v } }); builder._filters[k] = v; return builder },
        ilike: (k: string, v: any) => { calls.push({ table, method: "ilike", args: { k, v } }); builder._filters[k] = v; return builder },
        maybeSingle: async () => {
          calls.push({ table, method: "maybeSingle" })
          if (table === "purchase_orders") {
            if (fix.poError) return { data: null, error: fix.poError }
            return { data: fix.po === undefined ? null : fix.po, error: null }
          }
          if (table === "suppliers") {
            if (fix.supplierError) return { data: null, error: fix.supplierError }
            return { data: fix.supplier === undefined ? null : fix.supplier, error: null }
          }
          return { data: null, error: null }
        },
      }
      return builder
    },
  }
  return { client, calls }
}

async function readBody(r: Response): Promise<any> { return await r.json() }

const SAMPLE_PO = { id: "po1", po_number: "PO-001", job_id: "j1", supplier_name: "Bondor", reference: null }
const SAMPLE_SUPPLIER = { id: "s1", name: "Bondor", email: "orders@bondor.example" }

// ════════════════════════════════════════════════════════════
// Test cases
// ════════════════════════════════════════════════════════════

Deno.test("PO.1: po_id not found → 404 po_not_found", async () => {
  const { client } = makeStubClient({ po: null })
  const r = await _verifyPoEmailRecipient({ client }, { po_id: "missing" })
  if (r.ok) throw new Error("expected reject")
  const body = await readBody(r.response)
  if (r.response.status !== 404) throw new Error(`expected 404, got ${r.response.status}`)
  if (body.code !== "po_not_found") throw new Error(`expected po_not_found, got ${body.code}`)
})

Deno.test("PO.2: PO row exists but supplier_name is empty → 400 supplier_email_unverifiable", async () => {
  const { client } = makeStubClient({ po: { ...SAMPLE_PO, supplier_name: "" } })
  const r = await _verifyPoEmailRecipient({ client }, { po_id: "po1" })
  if (r.ok) throw new Error("expected reject")
  const body = await readBody(r.response)
  if (r.response.status !== 400) throw new Error(`expected 400, got ${r.response.status}`)
  if (body.code !== "supplier_email_unverifiable") throw new Error(`expected supplier_email_unverifiable, got ${body.code}`)
})

Deno.test("PO.3: caller `supplier` differs from PO supplier_name → 400 supplier_name_mismatch", async () => {
  const { client } = makeStubClient({ po: SAMPLE_PO, supplier: SAMPLE_SUPPLIER })
  const r = await _verifyPoEmailRecipient({ client }, { po_id: "po1", supplier: "Stratco" })
  if (r.ok) throw new Error("expected reject")
  const body = await readBody(r.response)
  if (body.code !== "supplier_name_mismatch") throw new Error(`expected supplier_name_mismatch, got ${body.code}`)
  if (body.received !== "Stratco") throw new Error(`received expected Stratco`)
  if (body.expected !== "Bondor") throw new Error(`expected supplier expected Bondor`)
})

Deno.test("PO.3b: caller `supplier` matches case-insensitively → no rejection on this rule", async () => {
  const { client } = makeStubClient({ po: SAMPLE_PO, supplier: SAMPLE_SUPPLIER })
  const r = await _verifyPoEmailRecipient({ client }, { po_id: "po1", supplier: "  bondor  " })
  if (!r.ok) throw new Error(`expected ok; rejected with ${(await readBody(r.response)).code}`)
})

Deno.test("PO.4: caller job_id differs from PO job_id → 400 job_po_mismatch", async () => {
  const { client } = makeStubClient({ po: SAMPLE_PO, supplier: SAMPLE_SUPPLIER })
  const r = await _verifyPoEmailRecipient({ client }, { po_id: "po1", job_id: "j999" })
  if (r.ok) throw new Error("expected reject")
  const body = await readBody(r.response)
  if (body.code !== "job_po_mismatch") throw new Error(`expected job_po_mismatch, got ${body.code}`)
  if (body.expected_job_id !== "j1") throw new Error("expected_job_id wrong")
})

Deno.test("PO.4b: caller omits job_id → ok (verifiedJobId inherited from PO)", async () => {
  const { client } = makeStubClient({ po: SAMPLE_PO, supplier: SAMPLE_SUPPLIER })
  const r = await _verifyPoEmailRecipient({ client }, { po_id: "po1" })
  if (!r.ok) throw new Error("expected ok")
  if (r.verifiedJobId !== "j1") throw new Error(`verifiedJobId expected j1, got ${r.verifiedJobId}`)
})

Deno.test("PO.5: suppliers query throws → 400 recipient_lookup_failed", async () => {
  const { client } = makeStubClient({ po: SAMPLE_PO, supplierError: { message: "RLS denied" } })
  const r = await _verifyPoEmailRecipient({ client }, { po_id: "po1" })
  if (r.ok) throw new Error("expected reject")
  const body = await readBody(r.response)
  if (body.code !== "recipient_lookup_failed") throw new Error(`expected recipient_lookup_failed, got ${body.code}`)
  if (body.detail !== "RLS denied") throw new Error("detail propagation wrong")
})

Deno.test("PO.6: supplier exists but email is null → 400 supplier_email_unverifiable", async () => {
  const { client } = makeStubClient({ po: SAMPLE_PO, supplier: { ...SAMPLE_SUPPLIER, email: null } })
  const r = await _verifyPoEmailRecipient({ client }, { po_id: "po1" })
  if (r.ok) throw new Error("expected reject")
  const body = await readBody(r.response)
  if (body.code !== "supplier_email_unverifiable") throw new Error(`expected supplier_email_unverifiable, got ${body.code}`)
  if (body.supplier_name !== "Bondor") throw new Error("supplier_name propagation wrong")
})

Deno.test("PO.6b: supplier email is empty string → 400 supplier_email_unverifiable", async () => {
  const { client } = makeStubClient({ po: SAMPLE_PO, supplier: { ...SAMPLE_SUPPLIER, email: "  " } })
  const r = await _verifyPoEmailRecipient({ client }, { po_id: "po1" })
  if (r.ok) throw new Error("expected reject")
  if ((await readBody(r.response)).code !== "supplier_email_unverifiable") throw new Error("wrong code")
})

Deno.test("PO.7: caller to_email differs from supplier.email → 400 recipient_mismatch", async () => {
  const { client } = makeStubClient({ po: SAMPLE_PO, supplier: SAMPLE_SUPPLIER })
  const r = await _verifyPoEmailRecipient({ client }, { po_id: "po1", to_email: "not-bondor@example.invalid" })
  if (r.ok) throw new Error("expected reject")
  const body = await readBody(r.response)
  if (body.code !== "recipient_mismatch") throw new Error(`expected recipient_mismatch, got ${body.code}`)
  if (body.received !== "not-bondor@example.invalid") throw new Error("received wrong")
  if (body.expected !== "orders@bondor.example") throw new Error("expected supplier email wrong")
})

Deno.test("PO.7b: caller to_email matches supplier.email case-insensitively → ok", async () => {
  const { client } = makeStubClient({ po: SAMPLE_PO, supplier: SAMPLE_SUPPLIER })
  const r = await _verifyPoEmailRecipient({ client }, { po_id: "po1", to_email: "  ORDERS@bondor.EXAMPLE  " })
  if (!r.ok) throw new Error(`expected ok; got ${(await readBody(r.response)).code}`)
  if (r.finalToEmail !== "orders@bondor.example") throw new Error("finalToEmail not normalised correctly")
})

Deno.test("PO.8: HAPPY PATH — caller omits to_email → resolved supplier.email used", async () => {
  const { client, calls } = makeStubClient({ po: SAMPLE_PO, supplier: SAMPLE_SUPPLIER })
  const r = await _verifyPoEmailRecipient({ client }, { po_id: "po1" })
  if (!r.ok) throw new Error("expected ok")
  if (r.finalToEmail !== "orders@bondor.example") throw new Error(`finalToEmail wrong: ${r.finalToEmail}`)
  if (r.verifiedJobId !== "j1") throw new Error("verifiedJobId wrong")
  if (r.supplierName !== "Bondor") throw new Error("supplierName wrong")
  // Sanity: both queries were made
  const tablesQueried = new Set(calls.filter((c) => c.method === "select").map((c) => c.table))
  if (!tablesQueried.has("purchase_orders")) throw new Error("did not query purchase_orders")
  if (!tablesQueried.has("suppliers")) throw new Error("did not query suppliers")
})

Deno.test("PO.9: HAPPY PATH — caller provides matching supplier + job_id + to_email → ok", async () => {
  const { client } = makeStubClient({ po: SAMPLE_PO, supplier: SAMPLE_SUPPLIER })
  const r = await _verifyPoEmailRecipient({ client }, {
    po_id: "po1",
    supplier: "Bondor",
    job_id: "j1",
    to_email: "orders@bondor.example",
  })
  if (!r.ok) throw new Error("expected ok")
  if (r.finalToEmail !== "orders@bondor.example") throw new Error("finalToEmail wrong")
})

Deno.test("PO.10: PO has no job_id → caller's job_id is accepted (no mismatch check trigger)", async () => {
  const poNoJob = { ...SAMPLE_PO, job_id: null }
  const { client } = makeStubClient({ po: poNoJob, supplier: SAMPLE_SUPPLIER })
  const r = await _verifyPoEmailRecipient({ client }, { po_id: "po1", job_id: "j-anything" })
  if (!r.ok) throw new Error("expected ok (PO has no job_id to mismatch against)")
  if (r.verifiedJobId !== null) throw new Error("verifiedJobId should be null for unlinked PO")
})

Deno.test("PO.11: po_id query returns DB error (not just null) → 400 po_not_found", async () => {
  const { client } = makeStubClient({ poError: { message: "connection lost" } })
  const r = await _verifyPoEmailRecipient({ client }, { po_id: "po1" })
  if (r.ok) throw new Error("expected reject")
  const body = await readBody(r.response)
  if (body.code !== "po_not_found") throw new Error(`expected po_not_found, got ${body.code}`)
  if (r.response.status !== 400) throw new Error(`expected 400 (DB error), got ${r.response.status}`)
})
