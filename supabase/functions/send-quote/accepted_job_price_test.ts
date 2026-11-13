// B1 follow-on: an accepted quote sets the job's price to its own (accepted_job_price.ts, wired into /accept).
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts"
import { samePricing, setJobPriceToAcceptedQuote } from "./accepted_job_price.ts"

type Rev = { id: string; job_document_id: string; sent_at: string | null; pricing_snapshot_json: unknown }

/** quote_revisions and jobs as the job system answers them, with the job's generated quoted_value. */
function jobSystem(init: { revisions: Rev[]; jobPricing: Record<string, unknown>; readFails?: boolean; writeFails?: boolean }) {
  const job = { id: "job-1", pricing_json: init.jobPricing as Record<string, unknown> }
  const writes: Record<string, unknown>[] = []
  const quotedValue = () => Number((job.pricing_json as any)?.totalIncGST ?? NaN)
  const sb = {
    from(table: string) {
      const eqs: Array<[string, unknown]> = []
      const notNull: string[] = []
      let patch: Record<string, unknown> | null = null
      let desc = false
      const q: any = {
        select() { return q },
        eq(c: string, v: unknown) { eqs.push([c, v]); return q },
        not(c: string, op: string, v: unknown) { if (op === "is" && v === null) notNull.push(c); return q },
        order(_c: string, o?: { ascending?: boolean }) { desc = o?.ascending === false; return q },
        limit() { return q },
        update(p: Record<string, unknown>) { patch = p; return q },
        then(onF: any, onR: any) {
          if (table === "quote_revisions") {
            if (init.readFails) return Promise.resolve({ data: null, error: { message: "timeout" } }).then(onF, onR)
            let rows = init.revisions.filter((r) => eqs.every(([c, v]) => (r as any)[c] === v) && notNull.every((c) => (r as any)[c] != null))
            rows = rows.sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)) * (desc ? 1 : -1))
            return Promise.resolve({ data: rows.slice(0, 1), error: null }).then(onF, onR)
          }
          if (table === "jobs" && patch) {
            if (init.writeFails) return Promise.resolve({ error: { message: "denied" } }).then(onF, onR)
            if (eqs.every(([c, v]) => (job as any)[c] === v)) { Object.assign(job, patch); writes.push(patch) }
            return Promise.resolve({ error: null }).then(onF, onR)
          }
          return Promise.reject(new Error(`unexpected call on ${table}`)).then(onF, onR)
        },
      }
      return q
    },
  }
  return { sb, job, writes, quotedValue }
}

// SWF-261620's shape, made-up figures: v1 sent at A, v2 (a re-quote with plinths) sent at B and accepted; the job
// reads A. Each document has its released row, as every send has since #1271.
const A = { totalIncGST: 5000, deposit: { percent: 50 }, runs: [{ run_label: "LHS", lengthM: 12 }] }
const B = { totalIncGST: 5794.5, deposit: { percent: 50 }, runs: [{ run_label: "LHS", lengthM: 12, plinth: true }] }
const revisions: Rev[] = [
  { id: "rev-v1", job_document_id: "doc-v1", sent_at: "2026-10-24T03:00:58Z", pricing_snapshot_json: { raw: A } },
  { id: "rev-v2", job_document_id: "doc-v2", sent_at: "2026-10-26T04:40:34Z", pricing_snapshot_json: { raw: B } },
]

Deno.test("B1 an accepted re-quote sets the job's price (and quoted value) to the accepted quote's own", async () => {
  const s = jobSystem({ revisions, jobPricing: A })
  const r = await setJobPriceToAcceptedQuote(s.sb, { job_id: "job-1", document_id: "doc-v2", job_pricing: s.job.pricing_json })
  assertEquals(r.updated, true)
  assertEquals(s.job.pricing_json, B, "the job's pricing is the accepted quote's")
  assertEquals(s.quotedValue(), 5794.5, "the job's quoted value follows")
  assertEquals(r.updated && r.revisionId, "rev-v2")
})

Deno.test("B1 the job already carries the accepted price: nothing is written", async () => {
  const s = jobSystem({ revisions, jobPricing: { deposit: { percent: 50 }, runs: B.runs, totalIncGST: 5794.5 } })
  const r = await setJobPriceToAcceptedQuote(s.sb, { job_id: "job-1", document_id: "doc-v2", job_pricing: s.job.pricing_json })
  assertEquals(r, { updated: false, reason: "already_the_accepted_price" })
  assertEquals(s.writes.length, 0)
})

Deno.test("B1 a quote sent before #1271 (no released row) keeps the job's price and says why", async () => {
  const s = jobSystem({ revisions: [revisions[0]], jobPricing: A })
  const r = await setJobPriceToAcceptedQuote(s.sb, { job_id: "job-1", document_id: "doc-v2", job_pricing: s.job.pricing_json })
  assertEquals(r, { updated: false, reason: "no_released_quote" })
  assertEquals(s.job.pricing_json, A)
})

Deno.test("B1 a failed read or write changes nothing and never throws", async () => {
  const read = jobSystem({ revisions, jobPricing: A, readFails: true })
  assertEquals(await setJobPriceToAcceptedQuote(read.sb, { job_id: "job-1", document_id: "doc-v2", job_pricing: A }), { updated: false, reason: "release_read_failed" })
  assertEquals(read.job.pricing_json, A)
  const write = jobSystem({ revisions, jobPricing: A, writeFails: true })
  assertEquals(await setJobPriceToAcceptedQuote(write.sb, { job_id: "job-1", document_id: "doc-v2", job_pricing: A }), { updated: false, reason: "job_price_write_failed" })
})

Deno.test("B1 samePricing ignores key order only", () => {
  assert(samePricing({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 }))
  assert(samePricing(JSON.stringify({ a: 1 }), { a: 1 }))
  assert(!samePricing({ a: 1 }, { a: 2 }))
})

Deno.test("B1 /accept sets the job's price from the accepted quote before the status, expected costs and deposit, whole quote with one party only", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url))
  const accept = src.indexOf("if ((path === 'accept' && req.method === 'POST') || staffAccept)")
  const runBranch = src.indexOf("// ── PER-RUN ACCEPTANCE (multi-neighbour fencing) ──", accept)
  const wholeBranch = src.indexOf("// Track invoice result for Next Steps page (existing non-run flow)", runBranch)
  const set = src.indexOf("setJobPriceToAcceptedQuote(sb, {", accept)
  const status = src.indexOf("status: newStatus,", wholeBranch)
  const baseline = src.indexOf("freezeExpectedCostsOnAcceptance(sb, {", wholeBranch)
  const deposit = src.indexOf("action=send_acceptance_invoice", wholeBranch)
  assert(accept > 0 && runBranch > accept && wholeBranch > runBranch)
  assert(set > wholeBranch, "set in the whole-quote branch, not the run branch")
  assert(set < status && set < baseline && set < deposit, "before the status, the expected-cost baseline and the deposit")
  assert(src.slice(wholeBranch, set).includes("if (!isMultiContact && job) {"), "one quote party only")
})
