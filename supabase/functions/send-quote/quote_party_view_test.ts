import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts"
import {
  currentQuoteForParty,
  quoteRunAcceptanceDecision,
  everyQuotePartyAccepted,
  normaliseQuoteRunLabel,
  otherPartyRunDocumentIdsToRetire,
  type QuotePartyDocument,
  quoteDocumentAcceptable,
  quoteDocumentRunLabel,
  quotePartyGreetingName,
  quotePartyKey,
  quoteViewDecision,
  quoteAcceptanceReadFailed,
  quoteViewRetryPage,
  retireOtherPublishedPartyRunDocuments,
  withPendingAcceptance,
  sameQuoteParty,
  sendRetiresPriorPartyQuotes,
} from "./quote_party_view.ts"
import { findQuoteRun, persistSendRunRows, quoteRunDepositAmount } from "./quote_run.ts"

// ── Fixtures: the stored quote documents of five live fencing jobs, read
// read-only with sw_list_job_documents on 2026-09-24. Ids and contacts are
// synthetic stand-ins; party layout, run labels, versions, send flags and
// creation times follow the stored rows. Share tokens are never read.

function doc(
  id: string,
  over: Partial<QuotePartyDocument> & { created_at: string },
): QuotePartyDocument {
  return {
    id,
    job_contact_id: null,
    run_label: null,
    share_token: `tok-${id}`,
    sent_to_client: true,
    sent_at: over.created_at,
    accepted_at: null,
    declined_at: null,
    superseded_at: null,
    version: 1,
    ...over,
  }
}

// SWF-26646 Ballajura: 9 send-runs x (client + neighbour) on run RHS, all
// version 1, none retired.
const SWF_26646_TIMES = [
  "2026-06-16T04:43:01Z", "2026-06-18T10:47:01Z", "2026-06-18T10:47:21Z",
  "2026-06-18T23:57:01Z", "2026-06-18T23:57:31Z", "2026-06-19T00:03:01Z",
  "2026-06-19T00:04:01Z", "2026-06-19T00:10:01Z", "2026-06-19T01:12:01Z",
]
const SWF_26646: QuotePartyDocument[] = SWF_26646_TIMES.flatMap((t, i) => [
  doc(`26646-c${i}`, { job_contact_id: "client", run_label: "RHS", created_at: t }),
  doc(`26646-n${i}`, { job_contact_id: "neighbour", run_label: "RHS", created_at: t }),
])

// SWF-26333 Quinns Rocks: whole-job v1 (May), then client v2 and neighbour v3.
const SWF_26333: QuotePartyDocument[] = [
  doc("26333-v1", { version: 1, created_at: "2026-05-15T02:43:42Z" }),
  doc("26333-a", { version: 2, job_contact_id: "client", created_at: "2026-08-28T02:24:58Z" }),
  doc("26333-b", { version: 3, job_contact_id: "neighbour", created_at: "2026-08-28T02:24:59Z" }),
]

// SWF-261276 Ballajura: client v1 and neighbour v2, then a whole-job v3.
const SWF_261276: QuotePartyDocument[] = [
  doc("261276-a", { version: 1, job_contact_id: "client", created_at: "2026-08-20T06:31:12Z" }),
  doc("261276-b", { version: 2, job_contact_id: "neighbour", created_at: "2026-08-20T06:31:13Z" }),
  doc("261276-v3", { version: 3, created_at: "2026-08-31T09:03:25Z" }),
]

// SWF-26670 Wilson: five documents in six minutes; v1/v2 never sent.
const SWF_26670: QuotePartyDocument[] = [
  doc("26670-v1a", { version: 1, job_contact_id: "client", sent_to_client: false, sent_at: null, created_at: "2026-06-18T04:37:38Z" }),
  doc("26670-v2b", { version: 2, job_contact_id: "neighbour", sent_to_client: false, sent_at: null, created_at: "2026-06-18T04:37:39Z" }),
  doc("26670-v3a", { version: 3, job_contact_id: "client", created_at: "2026-06-18T04:39:46Z" }),
  doc("26670-v4b", { version: 4, job_contact_id: "neighbour", created_at: "2026-06-18T04:39:47Z" }),
  doc("26670-v5", { version: 5, created_at: "2026-06-18T04:41:56Z" }),
]

// SWF-26760 Stirling: client and neighbour on run RHS.
const SWF_26760: QuotePartyDocument[] = [
  doc("26760-c", { job_contact_id: "client", run_label: "RHS", created_at: "2026-06-23T03:04:01Z" }),
  doc("26760-n", { job_contact_id: "neighbour", run_label: "RHS", created_at: "2026-06-23T03:04:02Z" }),
]

const LIVE_JOBS: Record<string, QuotePartyDocument[]> = {
  "SWF-26646": SWF_26646,
  "SWF-26333": SWF_26333,
  "SWF-261276": SWF_261276,
  "SWF-26670": SWF_26670,
  "SWF-26760": SWF_26760,
}

function liveSent(docs: QuotePartyDocument[]) {
  return docs.filter((d) => d.sent_to_client === true && !d.superseded_at)
}

/** Quotes a link's page shows with an Accept button, following one forward. */
function acceptableQuotesOnPage(opened: QuotePartyDocument, jobDocs: QuotePartyDocument[]): QuotePartyDocument[] {
  const siblings = liveSent(jobDocs).filter((d) => d.id !== opened.id)
  const decision = quoteViewDecision(opened, siblings)
  if (decision.kind === "forward") {
    return acceptableQuotesOnPage(decision.current, jobDocs)
  }
  const shown = decision.kind === "options" ? decision.documents : [opened]
  return shown.filter((d) => !d.accepted_at && !d.declined_at && quoteDocumentAcceptable(d, siblings))
}

function partyOf(d: QuotePartyDocument) {
  return `${d.job_contact_id ?? "-"}|${d.run_label ?? "-"}`
}

// ── Regression: the neighbour leak ──────────────────────────────────────────

for (const [job, docs] of Object.entries(LIVE_JOBS)) {
  Deno.test(`leak regression ${job}: every link shows exactly one quote and one Accept, all its own party`, () => {
    for (const opened of liveSent(docs)) {
      const shown = acceptableQuotesOnPage(opened, docs)
      assertEquals(shown.length, 1, `${job} ${opened.id} shows ${shown.length} acceptable quotes`)
      assertEquals(partyOf(shown[0]), partyOf(opened), `${job} ${opened.id} shows another party's quote`)
    }
  })

  Deno.test(`leak regression ${job}: each party has one acceptable document`, () => {
    const parties = new Map<string, number>()
    const siblingsFor = (d: QuotePartyDocument) => liveSent(docs).filter((x) => x.id !== d.id)
    for (const d of liveSent(docs)) {
      if (quoteDocumentAcceptable(d, siblingsFor(d))) parties.set(partyOf(d), (parties.get(partyOf(d)) ?? 0) + 1)
    }
    for (const [party, count] of parties) assertEquals(count, 1, `${job} party ${party} has ${count} acceptable documents`)
  })
}

Deno.test("before the fix SWF-26646 showed 18 options with 18 Accept buttons on every link", () => {
  // The old /view query: every live sent quote on the job except the opened one.
  const opened = SWF_26646[1]
  const oldSiblings = liveSent(SWF_26646).filter((d) => d.id !== opened.id)
  assertEquals([opened, ...oldSiblings].length, 18)
  assertEquals([opened, ...oldSiblings].filter((d) => d.job_contact_id === "client").length, 9)
})

Deno.test("an older SWF-26646 duplicate forwards to the same party's newest run document", () => {
  const opened = SWF_26646.find((d) => d.id === "26646-n0")!
  const decision = quoteViewDecision(opened, liveSent(SWF_26646).filter((d) => d.id !== opened.id))
  assertEquals(decision.kind, "forward")
  if (decision.kind === "forward") {
    assertEquals(decision.current.id, "26646-n8")
    assertEquals(decision.current.job_contact_id, "neighbour")
  }
})

Deno.test("the newest run document shows its own run page, not an options page", () => {
  const opened = SWF_26646.find((d) => d.id === "26646-c8")!
  assertEquals(quoteViewDecision(opened, liveSent(SWF_26646)).kind, "single")
})

Deno.test("a party's newest run document stays current after an older one was accepted", () => {
  const docs = SWF_26646.map((d) => d.id === "26646-c2" ? { ...d, accepted_at: "2026-06-20T00:00:00Z" } : d)
  assertEquals(currentQuoteForParty(docs, { job_contact_id: "client", run_label: "RHS" })?.id, "26646-c8")
})

Deno.test("run party ordering uses version before sent and creation times", () => {
  const docs = [
    doc("newer-time-lower-version", {
      job_contact_id: "client",
      run_label: "RHS",
      version: 1,
      created_at: "2026-09-24T10:00:00Z",
      sent_at: "2026-09-24T10:00:00Z",
    }),
    doc("higher-version", {
      job_contact_id: "client",
      run_label: "RHS",
      version: 2,
      created_at: "2026-09-24T09:00:00Z",
      sent_at: "2026-09-24T09:00:00Z",
    }),
  ]
  assertEquals(currentQuoteForParty(docs, { job_contact_id: "client", run_label: "RHS" })?.id, "higher-version")
})

Deno.test("same-party A/B options still show together; another party's never joins", () => {
  const optionA = doc("opt-a", { version: 1, created_at: "2026-09-01T00:00:00Z" })
  const optionB = doc("opt-b", { version: 2, created_at: "2026-09-01T00:00:01Z" })
  const neighbour = doc("opt-n", { version: 3, job_contact_id: "neighbour", created_at: "2026-09-01T00:00:02Z" })
  const decision = quoteViewDecision(optionA, [optionB, neighbour])
  assertEquals(decision.kind, "options")
  if (decision.kind === "options") assertEquals(decision.documents.map((d) => d.id), ["opt-a", "opt-b"])
})

Deno.test("party identity: null matches only null; contact and run both count", () => {
  assert(sameQuoteParty({ job_contact_id: null, run_label: null }, { job_contact_id: "", run_label: " " }))
  assert(!sameQuoteParty({ job_contact_id: null }, { job_contact_id: "client" }))
  assert(!sameQuoteParty({ job_contact_id: "client", run_label: "RHS" }, { job_contact_id: "client", run_label: "LHS" }))
})

Deno.test("blank quote run labels normalize to the null party value", () => {
  assertEquals(normaliseQuoteRunLabel(null), null)
  assertEquals(normaliseQuoteRunLabel(undefined), null)
  assertEquals(normaliseQuoteRunLabel("  \t "), null)
  assertEquals(normaliseQuoteRunLabel(" RHS "), " RHS ")
  assertEquals(quotePartyKey({ run_label: " RHS " }).runLabel, " RHS ")
  assert(!sameQuoteParty({ run_label: " RHS " }, { run_label: "RHS" }))
})

Deno.test("padded run labels preserve their run data and deposit basis", () => {
  const label = normaliseQuoteRunLabel(" RHS ")!
  const run = findQuoteRun({
    deposit: { percent: 50 },
    runs: [{
      run_label: " RHS ",
      run_name: "Right side",
      totals: { client_share_inc: 275.5, neighbour_share_inc: 119.25 },
    }],
  }, label)
  assertEquals(run?.run_name, "Right side")
  assertEquals(quoteRunDepositAmount(run, true, 50), 137.75)
  assertEquals(quoteRunDepositAmount(run, false, 50), 59.63)
})

Deno.test("quote read retry page asks the customer to retry without an Accept action", () => {
  const page = quoteViewRetryPage()
  assert(page.includes("Please try again shortly."))
  assert(!page.includes("<button"))
  assert(!page.includes("<a "))
})

Deno.test("a retired document is never acceptable", () => {
  assert(!quoteDocumentAcceptable({ ...SWF_26760[0], superseded_at: "2026-09-17T00:25:02Z" }, []))
})

// ── Acceptance counting ─────────────────────────────────────────────────────

Deno.test("all accepted counts current documents only: one revision no longer sticks at partial", () => {
  const docs = [
    doc("accept-old-client", { job_contact_id: "client", accepted_at: null, superseded_at: "2026-09-02T00:00:00Z", created_at: "2026-09-01T00:00:00Z" }),
    doc("accept-old-neighbour", { job_contact_id: "neighbour", accepted_at: null, superseded_at: "2026-09-02T00:00:00Z", created_at: "2026-09-01T00:00:00Z" }),
    doc("accept-client", { job_contact_id: "client", accepted_at: "2026-09-03T00:00:00Z", created_at: "2026-09-03T00:00:00Z" }),
    doc("accept-neighbour", { job_contact_id: "neighbour", accepted_at: "2026-09-04T00:00:00Z", created_at: "2026-09-04T00:00:00Z" }),
  ]
  // Old rule: accepted docs (2) >= all contact docs (4) was false.
  assert(!(docs.filter((d) => d.accepted_at).length >= docs.length))
  assert(everyQuotePartyAccepted(docs))
})

Deno.test("all accepted stays false while a current party has not accepted", () => {
  assert(!everyQuotePartyAccepted([
    doc("whole-client", { job_contact_id: "client", accepted_at: "2026-09-03T00:00:00Z", created_at: "2026-09-03T00:00:00Z" }),
    doc("whole-neighbour", { job_contact_id: "neighbour", accepted_at: null, created_at: "2026-09-03T00:00:00Z" }),
  ]))
  assert(!everyQuotePartyAccepted([]))
})

Deno.test("all accepted counts a contact's separate current runs as separate parties", () => {
  assert(!everyQuotePartyAccepted([
    doc("client-rhs", { job_contact_id: "client", run_label: "RHS", accepted_at: "2026-09-03T00:00:00Z", created_at: "2026-09-03T00:00:00Z" }),
    doc("client-lhs", { job_contact_id: "client", run_label: "LHS", accepted_at: null, created_at: "2026-09-04T00:00:00Z" }),
  ]))
  assert(everyQuotePartyAccepted([
    doc("client-rhs-accepted", { job_contact_id: "client", run_label: "RHS", accepted_at: "2026-09-03T00:00:00Z", created_at: "2026-09-03T00:00:00Z" }),
    doc("client-lhs-accepted", { job_contact_id: "client", run_label: "LHS", accepted_at: "2026-09-04T00:00:00Z", created_at: "2026-09-04T00:00:00Z" }),
  ]))
})

Deno.test("run acceptance uses only the newest document; whole-quote options accept any current option", () => {
  const runDocs = [
    doc("old-run", { job_contact_id: "client", run_label: "RHS", version: 1, accepted_at: "2026-09-03T00:00:00Z", created_at: "2026-09-03T00:00:00Z" }),
    doc("new-run", { job_contact_id: "client", run_label: "RHS", version: 2, accepted_at: null, created_at: "2026-09-04T00:00:00Z" }),
  ]
  assert(!everyQuotePartyAccepted(runDocs))
  assert(everyQuotePartyAccepted([
    ...runDocs.map((d) => d.id === "new-run" ? { ...d, accepted_at: "2026-09-05T00:00:00Z" } : d),
    doc("whole-option-a", { job_contact_id: "neighbour", accepted_at: null, created_at: "2026-09-03T00:00:00Z" }),
    doc("whole-option-b", { job_contact_id: "neighbour", accepted_at: "2026-09-04T00:00:00Z", created_at: "2026-09-04T00:00:00Z" }),
  ]))
})

// ── Retirement on send ──────────────────────────────────────────────────────

Deno.test("/send retires the party's earlier quotes by default; explicit false opts out", () => {
  assert(sendRetiresPriorPartyQuotes(undefined))
  assert(sendRetiresPriorPartyQuotes(true))
  assert(sendRetiresPriorPartyQuotes(null))
  assert(!sendRetiresPriorPartyQuotes(false))
})

Deno.test("send-runs retirement on SWF-26646 keeps one document per party and retires the other 16", () => {
  const keep = [SWF_26646.find((d) => d.id === "26646-c8")!, SWF_26646.find((d) => d.id === "26646-n8")!]
  const retire = otherPartyRunDocumentIdsToRetire(keep, SWF_26646)
  assertEquals(retire.length, 16)
  assert(!retire.includes("26646-c8") && !retire.includes("26646-n8"))
})

Deno.test("send-runs retirement preserves another party, unsent drafts, and whole-job docs", () => {
  const rows = [
    doc("keep", { job_contact_id: "client", run_label: "LHS", created_at: "2026-09-15T10:16:18Z" }),
    doc("old", { job_contact_id: "client", run_label: "LHS", created_at: "2026-09-01T00:00:00Z" }),
    doc("draft", { job_contact_id: "client", run_label: "LHS", sent_to_client: false, sent_at: null, created_at: "2026-09-02T00:00:00Z" }),
    doc("accepted", { job_contact_id: "client", run_label: "LHS", accepted_at: "2026-09-03T00:00:00Z", created_at: "2026-09-03T00:00:00Z" }),
    doc("neighbour", { job_contact_id: "neighbour", run_label: "LHS", created_at: "2026-09-01T00:00:00Z" }),
    doc("whole", { created_at: "2026-09-01T00:00:00Z" }),
  ]
  assertEquals(otherPartyRunDocumentIdsToRetire([rows[0]], rows), ["accepted", "old"])
  assertEquals(otherPartyRunDocumentIdsToRetire([rows[5]], rows), [])
})

Deno.test("send-runs retirement keeps the newest duplicate even when the requested row is older", () => {
  const rows = [
    doc("requested-older", { job_contact_id: "client", run_label: "RHS", version: 1, created_at: "2026-09-01T00:00:00Z" }),
    doc("published-newest", { job_contact_id: "client", run_label: "RHS", version: 2, created_at: "2026-08-31T00:00:00Z" }),
  ]
  assertEquals(otherPartyRunDocumentIdsToRetire([rows[0]], rows), [])
  assertEquals(otherPartyRunDocumentIdsToRetire([rows[1]], rows), ["requested-older"])
})

function fakeClient(rows: QuotePartyDocument[], opts: { readError?: string; writeError?: string } = {}) {
  const updates: Array<{ ids: string[]; payload: Record<string, unknown> }> = []
  const client = {
    from(_table: string) {
      const state: { ids?: string[]; payload?: Record<string, unknown> } = {}
      const chain: Record<string, unknown> = {}
      const self = () => chain
      Object.assign(chain, {
        select: self, eq: self, is: self,
        in(_col: string, ids: string[]) { state.ids = ids; return chain },
        update(payload: Record<string, unknown>) { state.payload = payload; return chain },
        then(resolve: (v: unknown) => void) {
          if (state.payload) {
            if (opts.writeError) return resolve({ data: null, error: { message: opts.writeError } })
            updates.push({ ids: state.ids || [], payload: state.payload })
            return resolve({ data: (state.ids || []).map((id) => ({ id })), error: null })
          }
          if (opts.readError) return resolve({ data: null, error: { message: opts.readError } })
          return resolve({ data: rows, error: null })
        },
      })
      return chain
    },
  }
  return { client, updates }
}

Deno.test("retireOtherPublishedPartyRunDocuments retires only the kept parties' older duplicates", async () => {
  const { client, updates } = fakeClient(SWF_26646)
  const result = await retireOtherPublishedPartyRunDocuments(client, {
    jobId: "job", keepIds: ["26646-c8", "26646-n8"], now: new Date("2026-09-24T00:00:00Z"),
  })
  assert(result.ok)
  if (result.ok) assertEquals(result.retiredIds.length, 16)
  assertEquals(updates.length, 1)
  assertEquals(updates[0].payload, { superseded_at: "2026-09-24T00:00:00.000Z" })
})

Deno.test("retireOtherPublishedPartyRunDocuments with nothing kept writes nothing; faults surface", async () => {
  const none = fakeClient(SWF_26646)
  const empty = await retireOtherPublishedPartyRunDocuments(none.client, { jobId: "job", keepIds: [] })
  assert(empty.ok)
  assertEquals(none.updates.length, 0)
  const readFault = await retireOtherPublishedPartyRunDocuments(fakeClient(SWF_26646, { readError: "boom" }).client, { jobId: "job", keepIds: ["26646-c8"] })
  assert(!readFault.ok)
  const writeFault = await retireOtherPublishedPartyRunDocuments(fakeClient(SWF_26646, { writeError: "boom" }).client, { jobId: "job", keepIds: ["26646-c8"] })
  assert(!writeFault.ok)
})

// ── Greeting on the "quote was updated" page ────────────────────────────────

Deno.test("a neighbour's retired link greets the neighbour, never the job client", () => {
  assertEquals(quotePartyGreetingName({ job_contact_id: "n", job_contacts: { client_name: "Fiona" }, jobs: { client_name: "Stephen" } }), "Fiona")
  assertEquals(quotePartyGreetingName({ job_contact_id: "n", job_contacts: null, jobs: { client_name: "Stephen" } }), "")
  assertEquals(quotePartyGreetingName({ job_contact_id: null, jobs: { client_name: "Stephen" } }), "Stephen")
})

Deno.test('current party decisions agree across view, accept, status and deposits', () => {
  const early = '2026-09-01T00:00:00Z'
  const late = '2026-09-02T00:00:00Z'
  const make = (id: string, overrides: Partial<QuotePartyDocument> = {}) =>
    doc(id, { run_label: 'RHS', job_contact_id: 'client', sent_at: early, ...overrides, created_at: overrides.created_at ?? early })
  const cases = [
    {
      name: 'tied versions use sent time before creation',
      docs: [make('old', { created_at: late }), make('new', { sent_at: late })],
      current: 'new', view: 'forward', acceptable: false,
    },
    {
      name: 'tied versions without sent times use creation',
      docs: [make('old', { sent_at: null, accepted_at: early }), make('new', { sent_at: null, created_at: late, accepted_at: late })],
      current: 'new', view: 'forward', acceptable: false,
    },
    {
      name: 'a sent timestamp outranks missing sent time',
      docs: [make('old', { sent_at: null, created_at: late, accepted_at: early }), make('new')],
      current: 'new', view: 'forward', acceptable: false,
    },
    {
      name: 'older accepted client and newly accepting neighbour cannot unlock deposits',
      docs: [
        make('old', { accepted_at: early }),
        make('new', { sent_at: late }),
        make('neighbour', { job_contact_id: 'neighbour', accepted_at: late }),
      ],
      current: 'new', view: 'forward', acceptable: false,
    },
    {
      name: 'unpublished required neighbour keeps the job partially accepted',
      docs: [
        make('old', { accepted_at: early }),
        make('neighbour', { job_contact_id: 'neighbour', sent_to_client: false, sent_at: null }),
      ],
      current: 'old', view: 'single', acceptable: true,
    },
    {
      name: 'pending required neighbour keeps the job partially accepted',
      docs: [make('old', { accepted_at: early }), make('neighbour', { job_contact_id: 'neighbour' })],
      current: 'old', view: 'single', acceptable: true,
    },
    {
      name: 'R9 whole quote with unpublished neighbour cannot complete the job',
      docs: [
        make('old', { run_label: null }),
        make('neighbour', { run_label: null, job_contact_id: 'neighbour', sent_to_client: false, sent_at: null }),
      ],
      current: 'old', view: 'single', acceptable: true, acceptedAfterWrite: false,
    },
    {
      name: 'R10 replacement is acceptable after accepted predecessor retires',
      docs: [
        make('new', { run_label: null, sent_at: late }),
        make('old', { run_label: null, accepted_at: early, superseded_at: late }),
      ],
      current: 'new', view: 'single', acceptable: true, acceptedAfterWrite: true,
    },
    {
      name: 'R10 live accepted alternative still blocks competing option',
      docs: [
        make('old', { run_label: null }),
        make('new', { run_label: null, accepted_at: early, sent_at: late }),
      ],
      current: 'new', view: 'options', acceptable: false,
    },
    {
      name: 'same-send whole-quote options stay acceptable',
      docs: [make('old', { run_label: null, accepted_at: early }), make('new', { run_label: null })],
      current: 'old', view: 'options', acceptable: true,
    },
    {
      name: 'blank labels share null identity',
      docs: [make('old', { run_label: '  ' }), make('new', { run_label: null })],
      current: 'old', view: 'options', acceptable: true,
    },
    {
      name: 'nonblank padded labels remain separate parties',
      docs: [make('old', { run_label: ' RHS ' }), make('new', { sent_at: late })],
      current: 'old', view: 'single', acceptable: true,
    },
    {
      name: 'retired links resolve only their own current party',
      docs: [
        make('old', { superseded_at: late }),
        make('new'),
        make('other', { job_contact_id: 'neighbour', version: 10 }),
      ],
      current: 'new', view: 'forward', acceptable: false,
    },
  ]
  for (const scenario of cases) {
    const linked = scenario.docs[0]
    assertEquals(currentQuoteForParty(scenario.docs, linked)?.id, scenario.current, scenario.name)
    assertEquals(quoteViewDecision(linked, scenario.docs).kind, scenario.view, scenario.name)
    assertEquals(quoteDocumentAcceptable(linked, scenario.docs), scenario.acceptable, scenario.name)
    if ('acceptedAfterWrite' in scenario) {
      const afterWrite = scenario.docs.map((document) =>
        document.id === linked.id ? { ...document, accepted_at: late } : document
      )
      assertEquals(everyQuotePartyAccepted(afterWrite), scenario.acceptedAfterWrite, scenario.name)
    }
    const acceptances = scenario.docs.map((document) => ({
      job_document_id: document.id,
      job_contact_id: document.job_contact_id ?? null,
      run_label: document.run_label ?? null,
      status: document.accepted_at ? 'accepted' : 'pending',
      accepted_at: document.accepted_at,
    }))
    const decision = quoteRunAcceptanceDecision(scenario.docs, acceptances, 'RHS', 'neighbour')
    assertEquals(decision.depositAcceptances, [], scenario.name)
    assertEquals(decision.jobStatus === 'accepted', false, scenario.name)
    if (scenario.name.includes('required neighbour keeps')) {
      assertEquals(decision.jobStatus, 'partially_accepted', scenario.name)
    }
    if (scenario.name === 'older accepted client and newly accepting neighbour cannot unlock deposits') {
      const acceptedDocs = scenario.docs.map((document) =>
        document.id === 'new' ? { ...document, accepted_at: late } : document
      )
      const completed = quoteRunAcceptanceDecision(acceptedDocs, [...acceptances.filter((row) => row.job_document_id !== 'new'), {
        job_document_id: 'new', job_contact_id: 'client', run_label: 'RHS',
        status: 'accepted', accepted_at: late,
      }], 'RHS', 'neighbour')
      assertEquals(completed.jobStatus, 'accepted')
      assertEquals(completed.depositAcceptances.map((row) => row.job_document_id).sort(), ['neighbour', 'new'])
      const otherRunPending = quoteRunAcceptanceDecision(acceptedDocs, [...acceptances.filter((row) => row.job_document_id !== 'new'), {
        job_document_id: 'new', job_contact_id: 'client', run_label: 'RHS',
        status: 'accepted', accepted_at: late,
      }, {
        job_document_id: 'unsent-other-run', job_contact_id: 'neighbour', run_label: 'LHS',
        status: 'pending', accepted_at: null,
      }], 'RHS', 'neighbour')
      assertEquals(otherRunPending.jobStatus, 'partially_accepted')

    }
  }
})

Deno.test('send-runs label table persists and links documents, acceptances and line items', async () => {
  for (const sourceLabel of ['   ', '', ' RHS ', 'RHS']) {
    const stored = new Map<string, any[]>()
    const sb = {
      from(table: string) {
        const write = (input: any) => {
          const rows = Array.isArray(input) ? input : [input]
          for (const row of rows) {
            if (table !== 'job_documents' && row.run_label == null) {
              throw new Error('run_label violates NOT NULL')
            }
          }
          stored.set(table, structuredClone(rows))
          return Promise.resolve({ data: rows, error: null })
        }
        return { insert: write, upsert: write }
      },
    }
    const sourceRun = { run_label: sourceLabel, run_name: 'Right side', totals: { client_share_inc: 200 } }
    await persistSendRunRows(sb, 'job_documents', {
      id: 'quote', job_contact_id: 'client', run_label: sourceRun.run_label,
      sent_to_client: true, sent_at: '2026-09-24T00:00:00Z',
      data_snapshot_json: { run: sourceRun },
    })
    await persistSendRunRows(sb, 'run_acceptances', {
      job_document_id: 'quote', job_contact_id: 'client', run_label: sourceRun.run_label, status: 'pending',
    })
    await persistSendRunRows(sb, 'run_line_items', [{
      job_contact_id: 'client', run_label: sourceRun.run_label, description: 'Fence', quantity: 1,
    }])
    const document = stored.get('job_documents')![0]
    const acceptance = stored.get('run_acceptances')![0]
    const lineItem = stored.get('run_line_items')![0]
    assertEquals(document.run_label, sourceLabel.trim() ? sourceLabel : null)
    assertEquals(acceptance.run_label, sourceLabel)
    assertEquals(lineItem.run_label, sourceLabel)
    assertEquals(document.data_snapshot_json.run, sourceRun)
    assert(sameQuoteParty(document, acceptance))
    assert(sameQuoteParty(document, lineItem))
    assertEquals(currentQuoteForParty([document], acceptance)?.id, acceptance.job_document_id)
    assertEquals(findQuoteRun({ runs: [sourceRun] }, document.run_label), sourceRun)
    assertEquals(quoteRunDepositAmount(findQuoteRun({ runs: [sourceRun] }, document.run_label), true, 50), 100)
  }
})

Deno.test('snapshot routing keeps blank-labelled documents in the run view and acceptance flow', () => {
  for (const label of ['', '   ', ' RHS ']) {
    const run = { run_label: label, totals: { client_share_inc: 200, neighbour_share_inc: 100 } }
    const client = doc('client', {
      created_at: '2026-09-24T00:00:00Z',
      job_contact_id: 'client', run_label: normaliseQuoteRunLabel(label),
      data_snapshot_json: { run },
    })
    const neighbour = { ...client, id: 'neighbour', job_contact_id: 'neighbour' }
    const sourceLabel = quoteDocumentRunLabel(client)
    assertEquals(sourceLabel, label)
    assertEquals(quoteViewDecision(client, [client, neighbour]).kind, 'single')
    assertEquals(findQuoteRun({ runs: [run] }, sourceLabel), run)
    assert(quoteDocumentAcceptable(client, [client, neighbour]))
    const acceptedClient = { ...client, accepted_at: '2026-09-25T00:00:00Z' }
    const acceptance = {
      job_document_id: client.id, job_contact_id: client.job_contact_id!,
      run_label: sourceLabel, status: 'accepted', accepted_at: acceptedClient.accepted_at,
    }
    const waiting = quoteRunAcceptanceDecision([acceptedClient, neighbour], [acceptance, {
      job_document_id: neighbour.id, job_contact_id: neighbour.job_contact_id,
      run_label: label, status: 'pending',
    }], sourceLabel!, neighbour.job_contact_id)
    assertEquals(waiting.jobStatus, 'partially_accepted')
    assertEquals(waiting.depositAcceptances, [])
    const completed = quoteRunAcceptanceDecision([acceptedClient, {
      ...neighbour, accepted_at: acceptedClient.accepted_at,
    }], [acceptance, {
      job_document_id: neighbour.id, job_contact_id: neighbour.job_contact_id,
      run_label: label, status: 'accepted', accepted_at: acceptedClient.accepted_at,
    }], sourceLabel!, neighbour.job_contact_id)
    assertEquals(completed.jobStatus, 'accepted')
    assertEquals(completed.depositAcceptances.length, 2)
    assert(completed.depositAcceptances.every((row) => row.run_label === label))
    const replacement = { ...client, id: 'replacement', version: 2 }
    assertEquals(quoteViewDecision(client, [client, replacement]).kind, 'forward')
    assert(!quoteDocumentAcceptable(client, [client, replacement]))
  }
  assertEquals(quoteDocumentRunLabel({ run_label: null }), null)
})

// ── R7: decide from a pre-write snapshot, so a failed read writes nothing ──

Deno.test("R7 a failed pre-acceptance read is detected before anything is written", () => {
  assert(quoteAcceptanceReadFailed([{ error: null }, { error: { message: "boom" } }, { error: null }]))
  assert(quoteAcceptanceReadFailed([{ error: null }, null]))
  assert(!quoteAcceptanceReadFailed([{ error: null }, { error: null }, { error: null }]))
})

Deno.test("R7 the last party's pending acceptance completes the run from the pre-write snapshot", () => {
  const client = doc("r7-c", { job_contact_id: "client", run_label: "RHS", created_at: "2026-09-20T00:00:00Z" })
  const neighbour = doc("r7-n", { job_contact_id: "neighbour", run_label: "RHS", created_at: "2026-09-20T00:00:01Z" })
  // Before the write: the client already accepted, the neighbour is pending.
  const before = {
    documents: [{ ...client, accepted_at: "2026-09-21T00:00:00Z" }, neighbour],
    acceptances: [
      { job_document_id: "r7-c", job_contact_id: "client", run_label: "RHS", status: "accepted", accepted_at: "2026-09-21T00:00:00Z" },
      { job_document_id: "r7-n", job_contact_id: "neighbour", run_label: "RHS", status: "pending", accepted_at: null },
    ],
    runNeighbourId: "neighbour",
  }
  const beforeDecision = quoteRunAcceptanceDecision(before.documents, before.acceptances, "RHS", "neighbour")
  assertEquals(beforeDecision.depositAcceptances.length, 0)

  const after = withPendingAcceptance(before, neighbour, "RHS", "2026-09-22T00:00:00Z")
  assertEquals(after.acceptances.filter((row) => row.job_contact_id === "neighbour").length, 1)
  const decision = quoteRunAcceptanceDecision(after.documents, after.acceptances, "RHS", "neighbour")
  assertEquals(decision.jobStatus, "accepted")
  assertEquals(decision.depositAcceptances.map((row) => row.job_contact_id).sort(), ["client", "neighbour"])
})

Deno.test("R7 the pending acceptance replaces the party's row by its source label and leaves others alone", () => {
  const padded = doc("r7-p", { job_contact_id: "client", run_label: " RHS ", created_at: "2026-09-20T00:00:00Z" })
  const snapshot = {
    documents: [padded],
    acceptances: [
      { job_document_id: "old", job_contact_id: "client", run_label: " RHS ", status: "pending", accepted_at: null },
      { job_document_id: "other", job_contact_id: "client", run_label: "LHS", status: "pending", accepted_at: null },
    ],
    runNeighbourId: null,
  }
  const after = withPendingAcceptance(snapshot, padded, " RHS ", "2026-09-22T00:00:00Z")
  assertEquals(after.acceptances.map((row) => `${row.run_label}|${row.job_document_id}|${row.status}`).sort(), [
    " RHS |r7-p|accepted",
    "LHS|other|pending",
  ])
  assertEquals(after.documents[0].accepted_at, "2026-09-22T00:00:00Z")
})

Deno.test("R7 a whole-job acceptance is judged on the snapshot with the accepted document", () => {
  const client = doc("r7-wc", { job_contact_id: "client", created_at: "2026-09-20T00:00:00Z" })
  const neighbour = doc("r7-wn", { job_contact_id: "neighbour", created_at: "2026-09-20T00:00:01Z", accepted_at: "2026-09-21T00:00:00Z" })
  const snapshot = { documents: [client, neighbour], acceptances: [], runNeighbourId: null }
  assert(!everyQuotePartyAccepted(snapshot.documents, snapshot.acceptances))
  const after = withPendingAcceptance(snapshot, client, null, "2026-09-22T00:00:00Z")
  assertEquals(after.acceptances, [])
  assert(everyQuotePartyAccepted(after.documents, after.acceptances))
})
