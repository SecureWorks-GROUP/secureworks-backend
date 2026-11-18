import { assert, assertEquals } from 'jsr:@std/assert@1'
import { draftJobIds, problemsInWords, recordXeroDraft, type RecordXeroDraftInput } from './xero_draft_register.ts'
import { linesFingerprint } from './xero_draft_standard.ts'
import { approvedSnapshotLines } from '../xero-sync/draft_approval_check.ts'

const ORG = '00000000-0000-0000-0000-0000000000aa'
const JOB = '11111111-2222-4333-8444-555555555555'
const DOC = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

type Answer = { data: unknown; error: unknown }
type Call = { table: string; op: string; row?: Record<string, unknown>; options?: unknown }

function fakeClient(opts: {
  switchOn?: boolean
  options?: Answer
  rules?: Answer
  upsertError?: unknown
  rpc?: Answer | 'throw'
} = {}) {
  const calls: Call[] = []
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = []
  const register = new Map<string, Record<string, unknown>>()
  const read = (table: string): Answer => {
    if (table === 'feature_flags') return { data: [{ enabled: opts.switchOn === true }], error: null }
    if (table === 'xero_tracking_options') {
      return opts.options ?? { data: [{ option_name: 'SW - FENCING' }, { option_name: 'SW - PATIOS' }], error: null }
    }
    if (table === 'xero_account_rules') return opts.rules ?? { data: [], error: null }
    return { data: null, error: { code: 'unexpected_table' } }
  }
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {
        select() {
          calls.push({ table, op: 'select' })
          return chain
        },
        eq() {
          return chain
        },
        limit() {
          return chain
        },
        upsert(row: Record<string, unknown>, options: unknown) {
          calls.push({ table, op: 'upsert', row, options })
          if (opts.upsertError) return Promise.resolve({ data: null, error: opts.upsertError })
          const key = `${row.org_id}|${row.xero_document_id}`
          register.set(key, { ...(register.get(key) || { drafted_at: 'first' }), ...row })
          return Promise.resolve({ data: null, error: null })
        },
        then(resolve: (a: Answer) => unknown, reject?: (e: unknown) => unknown) {
          return Promise.resolve(read(table)).then(resolve, reject)
        },
      }
      return chain
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args })
      if (opts.rpc === 'throw') throw new Error('network')
      return Promise.resolve(opts.rpc ?? { data: 'item-1', error: null })
    },
  }
  return { client, calls, rpcCalls, register }
}

function bill(over: Partial<RecordXeroDraftInput> = {}): RecordXeroDraftInput {
  return {
    orgId: ORG,
    xeroDocumentId: DOC,
    documentType: 'ACCPAY',
    sourceKind: 'supplier_bill',
    sourceId: null,
    registerRow: 'X9',
    jobIds: [JOB],
    payload: {
      Type: 'ACCPAY',
      Date: '2026-11-18',
      Status: 'DRAFT',
      LineItems: [
        { Description: '[SWF-ZZTEST01] Posts', AccountCode: '310', Quantity: 2, UnitAmount: 12.5, Tracking: [{ Name: 'Business Unit', Option: 'SW - FENCING' }] },
        { Description: '[SWF-ZZTEST01] Rails', AccountCode: '310', Quantity: 1, UnitAmount: 40, Tracking: [{ Name: 'Business Unit', Option: 'SW - FENCING' }] },
      ],
    },
    hasSourceDocument: true,
    raise: true,
    ...over,
  }
}

const upserts = (calls: Call[]) => calls.filter((c) => c.op === 'upsert')

Deno.test('switch off: reads only the switch, writes nothing, raises nothing', async () => {
  const f = fakeClient({ switchOn: false })
  const out = await recordXeroDraft(f.client, bill({ payload: { LineItems: [{ Quantity: 1 }] } }))
  assertEquals(out, { recorded: false, skipped: 'switch_off' })
  assertEquals(f.calls.map((c) => c.table), ['feature_flags'])
  assertEquals(f.rpcCalls.length, 0)
})

Deno.test('complete draft: one upsert keyed on org and document, no raise', async () => {
  const f = fakeClient({ switchOn: true })
  const out = await recordXeroDraft(f.client, bill())
  assertEquals(out.recorded, true)
  assertEquals(out.problems, 0)
  assertEquals(f.rpcCalls.length, 0)
  const up = upserts(f.calls)
  assertEquals(up.length, 1)
  assertEquals(up[0].table, 'xero_draft_register')
  assertEquals(up[0].options, { onConflict: 'org_id,xero_document_id' })
  const row = up[0].row!
  assertEquals(row.org_id, ORG)
  assertEquals(row.xero_document_id, DOC)
  assertEquals(row.register_row, 'X9')
  assertEquals(row.job_ids, [JOB])
  assertEquals([row.has_account_codes, row.has_division_tags, row.has_job_reference, row.has_source_document], [true, true, true, true])
  assertEquals(row.problems, [])
  // The daily check owns these; a record never sends them.
  for (const k of ['drafted_at', 'approved_seen_at', 'approved_fingerprint', 'edited_before_approval']) {
    assert(!(k in row), k)
  }
})

Deno.test('incomplete with raise: one upsert and one draft_incomplete item', async () => {
  const f = fakeClient({ switchOn: true })
  const lines = [{ Description: 'Posts', Quantity: 1, UnitAmount: 10, Tracking: [] }]
  const out = await recordXeroDraft(f.client, bill({ payload: { Date: '2026-11-18', LineItems: lines }, hasSourceDocument: false }))
  assertEquals(out.recorded, true)
  assertEquals(out.raised, true)
  assertEquals(upserts(f.calls).length, 1)
  assertEquals(f.rpcCalls.length, 1)
  const { fn, args } = f.rpcCalls[0]
  assertEquals(fn, 'reconcile_item_raise')
  assertEquals(args.p_kind, 'draft_incomplete')
  assertEquals(args.p_subject_table, 'xero_draft_register')
  assertEquals(args.p_subject_id, DOC)
  assertEquals(args.p_job_ids, [JOB])
  assertEquals(args.p_suggestion, null)
  assertEquals(args.p_raised_by, 'phase3:books')
  assertEquals(args.p_org_id, ORG)
  // deno-lint-ignore no-explicit-any
  const ev = args.p_evidence as any
  assertEquals(ev.reason, 'draft_incomplete')
  assertEquals(ev.document_type, 'ACCPAY')
  assertEquals(ev.amount_ex, null)
  assertEquals(ev.document_date, '2026-11-18')
  assertEquals(ev.summary.words, 'Draft bill is missing an account code, a division tag and its source document')
  assertEquals(ev.summary.problems.map((p: { code: string }) => p.code), ['account_code_missing', 'division_not_known', 'source_document_missing'])
  const row = upserts(f.calls)[0].row!
  assertEquals([row.has_account_codes, row.has_division_tags, row.has_source_document], [false, false, false])
})

Deno.test('incomplete with raise false: recorded, nothing raised', async () => {
  const f = fakeClient({ switchOn: true })
  const out = await recordXeroDraft(f.client, bill({ raise: false, hasSourceDocument: false, registerRow: 'X6', sourceKind: 'trade_invoice' }))
  assertEquals(out.recorded, true)
  assertEquals(out.problems, 1)
  assertEquals(f.rpcCalls.length, 0)
})

Deno.test('an upsert error is answered, never thrown, and raises nothing', async () => {
  const f = fakeClient({ switchOn: true, upsertError: { code: '42501' } })
  const out = await recordXeroDraft(f.client, bill({ hasSourceDocument: false }))
  assertEquals(out, { recorded: false })
  assertEquals(f.rpcCalls.length, 0)
})

Deno.test('a second call for the same document updates the same row and keeps drafted_at', async () => {
  const f = fakeClient({ switchOn: true })
  await recordXeroDraft(f.client, bill({ hasSourceDocument: false, raise: false }))
  await recordXeroDraft(f.client, bill({ hasSourceDocument: true, raise: false }))
  assertEquals(f.register.size, 1)
  const row = [...f.register.values()][0]
  assertEquals(row.has_source_document, true)
  assertEquals(row.drafted_at, 'first')
})

Deno.test('raise function not reachable (PGRST202) or throwing: the row stays recorded', async () => {
  for (const rpc of [{ data: null, error: { code: 'PGRST202' } }, 'throw' as const, { data: null, error: { code: 'P0001' } }]) {
    const f = fakeClient({ switchOn: true, rpc })
    const out = await recordXeroDraft(f.client, bill({ hasSourceDocument: false }))
    assertEquals(out.recorded, true)
    assertEquals(out.raised, false)
    assertEquals(upserts(f.calls).length, 1)
  }
})

Deno.test('only a document Xero holds as DRAFT is recorded', async () => {
  const f = fakeClient({ switchOn: true })
  const out = await recordXeroDraft(f.client, bill({ returned: { InvoiceID: DOC, Status: 'AUTHORISED', LineItems: [] } }))
  assertEquals(out, { recorded: false, skipped: 'not_draft' })
  assertEquals(upserts(f.calls).length, 0)
  const none = await recordXeroDraft(fakeClient({ switchOn: true }).client, bill({ xeroDocumentId: '' }))
  assertEquals(none, { recorded: false, skipped: 'no_document_id' })
})

Deno.test('a failed option read is named, never counted as tagged', async () => {
  const f = fakeClient({ switchOn: true, options: { data: null, error: { code: '57014' } } })
  const out = await recordXeroDraft(f.client, bill({ raise: false }))
  assertEquals(out.recorded, true)
  const row = upserts(f.calls)[0].row!
  assertEquals(row.has_division_tags, false)
  // deno-lint-ignore no-explicit-any
  assertEquals((row.problems as any[]).map((p) => p.code), ['options_not_loaded'])
})

Deno.test('fingerprint matches the daily check for an unedited draft (Xero lines preferred)', async () => {
  const f = fakeClient({ switchOn: true })
  const returned = {
    InvoiceID: DOC,
    Status: 'DRAFT',
    LineItems: [
      { AccountCode: '310', Quantity: 2, UnitAmount: 12.5, Tracking: [{ Name: 'Business Unit', Option: 'SW - FENCING' }] },
      { AccountCode: '310', Quantity: 1, UnitAmount: 40, Tracking: [{ Name: 'Business Unit', Option: 'SW - FENCING' }] },
    ],
  }
  await recordXeroDraft(f.client, bill({ returned }))
  const recorded = upserts(f.calls)[0].row!.lines_fingerprint
  const daily = await linesFingerprint(approvedSnapshotLines({ status: 'AUTHORISED', lines: returned.LineItems })!)
  assertEquals(recorded, daily)
  // A changed account on approval reads as edited.
  const edited = structuredClone(returned.LineItems)
  edited[0].AccountCode = '311'
  assert(recorded !== await linesFingerprint(approvedSnapshotLines({ status: 'AUTHORISED', lines: edited })!))
})

Deno.test('customer invoice and credit note words; job ids are real ids only', async () => {
  const f = fakeClient({ switchOn: true })
  await recordXeroDraft(f.client, bill({
    documentType: 'ACCREC', registerRow: 'X3', sourceKind: 'customer_invoice', hasSourceDocument: false,
    payload: { LineItems: [{ AccountCode: '200', Quantity: 1, UnitAmount: 100, Tracking: [{ Option: 'SW - OLD' }] }] },
    jobIds: [JOB, 'nojob', null, JOB],
  }))
  // deno-lint-ignore no-explicit-any
  const ev = f.rpcCalls[0].args.p_evidence as any
  assertEquals(ev.summary.words, 'Draft customer invoice is missing an active division tag')
  assertEquals(f.rpcCalls[0].args.p_job_ids, [JOB])
  assertEquals(ev.document_date, null)
  assertEquals(draftJobIds(['x', JOB.toUpperCase(), '']), [JOB.toUpperCase()])
  assertEquals(problemsInWords([{ code: 'source_document_missing', line: null, text: '' }]), 'its source document')
})
