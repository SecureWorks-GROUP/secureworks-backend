import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@1'
import {
  accountRuleFor,
  checkDraft,
  divisionTrackingOption,
  loadDraftStandard,
  linesFingerprint,
  withJobPrefix,
  type XeroAccountRule,
} from './xero_draft_standard.ts'
import { _trackingCategoryForJob } from '../ops-api/index.ts'

type Example = { job_number: string | null; job_type: string | null; expect: string }
const examples: Example[] = JSON.parse(
  await Deno.readTextFile(new URL('./division_examples.json', import.meta.url)),
)

Deno.test('division examples: divisionTrackingOption and trackingCategoryForJob both give each expect', () => {
  for (const e of examples) {
    assertEquals(
      divisionTrackingOption({ job_number: e.job_number, job_type: e.job_type }),
      e.expect,
      `divisionTrackingOption(${e.job_number}, ${e.job_type})`,
    )
    assertEquals(
      _trackingCategoryForJob(e.job_number ?? '', e.job_type),
      e.expect,
      `trackingCategoryForJob(${e.job_number}, ${e.job_type})`,
    )
  }
})

Deno.test('stock division: an SW option is taken as it is; a division word maps in any case; anything else falls to the job', () => {
  assertEquals(divisionTrackingOption({ stock_division: 'SW - PATIOS' }), 'SW - PATIOS')
  const words: [string, string][] = [
    ['patio', 'SW - PATIOS'], ['Patios', 'SW - PATIOS'], ['FENCING', 'SW - FENCING'], ['fence', 'SW - FENCING'],
    ['decking', 'SW - DECKING'], ['Deck', 'SW - DECKING'], ['roofing', 'SW - PRIVATE ROOFING'],
    ['makesafe', 'SW - MAKESAFE'], ['Insurance', 'SW - INSURANCE WORK'], ['restoration', 'SW - RESTORATION'],
  ]
  for (const [word, option] of words) assertEquals(divisionTrackingOption({ stock_division: word }), option, word)
  // The stock division wins over the job.
  assertEquals(divisionTrackingOption({ stock_division: 'fencing', job_number: 'SWP-ZZTEST01' }), 'SW - FENCING')
  // Unknown words do not invent a division.
  assertEquals(divisionTrackingOption({ stock_division: 'carpentry' }), '')
  assertEquals(divisionTrackingOption({ stock_division: 'carpentry', job_number: 'SWF-ZZTEST01' }), 'SW - FENCING')
})

Deno.test('settled loose divisions require stored authority, and expenses default to SW Group', () => {
  for (const job_type of ['misc', 'miscellaneous', 'general']) {
    assertEquals(divisionTrackingOption({ job_type, job_number: 'SWP-ZZTEST03' }), '')
    assertEquals(divisionTrackingOption({ job_type, activeOptions: new Set(['Private Renovations']) }), 'Private Renovations')
    assertEquals(divisionTrackingOption({ job_type, activeOptions: new Set(['SW - PATIOS']) }), '')
  }
  for (const stock_division of ['fuel', 'PARKING', 'meals']) {
    assertEquals(divisionTrackingOption({ stock_division }), 'SW Group')
  }
})

const rules: XeroAccountRule[] = [
  { source_kind: 'trade_invoice', line_kind: 'labour', account_code: '306' },
  { source_kind: 'supplier_bill', line_kind: 'default', account_code: '306' },
  { source_kind: 'expense_receipt', line_kind: 'receipt_job', account_code: '400' },
]

Deno.test('accountRuleFor: exact pair, then the default row, then null', () => {
  assertEquals(accountRuleFor(rules, 'trade_invoice', 'labour')?.account_code, '306')
  assertEquals(accountRuleFor(rules, 'supplier_bill', 'materials')?.line_kind, 'default')
  assertEquals(accountRuleFor(rules, 'trade_invoice', 'travel'), null)
  assertEquals(accountRuleFor(rules, 'supplier_credit', 'default'), null)
  assertEquals(accountRuleFor(null, 'supplier_bill', 'default'), null)
})

function fakeClient(answers: Record<string, { data: unknown; error: unknown }>) {
  const calls: { table: string; filters: [string, unknown][] }[] = []
  return {
    calls,
    from(table: string) {
      const call = { table, filters: [] as [string, unknown][] }
      calls.push(call)
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          call.filters.push([col, val])
          return q
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(answers[table]).then(res, rej),
      }
      return q
    },
  }
}

Deno.test('loadDraftStandard: two reads; ACTIVE options of the org', async () => {
  const client = fakeClient({
    xero_account_rules: { data: rules, error: null },
    xero_tracking_options: { data: [{ option_name: 'SW - PATIOS' }, { option_name: 'SW - FENCING' }], error: null },
  })
  const s = await loadDraftStandard(client, 'org-1')
  assertEquals(client.calls.length, 2)
  assertEquals(s.rules.length, 3)
  assert(s.activeOptions.has('SW - PATIOS'))
  assertEquals(s.optionsLoaded, true)
  const optionsCall = client.calls.find((c) => c.table === 'xero_tracking_options')!
  assertEquals(optionsCall.filters, [['org_id', 'org-1'], ['status', 'ACTIVE']])
})

Deno.test('loadDraftStandard: options not loaded when the read fails or finds no row', async () => {
  const failed = await loadDraftStandard(fakeClient({
    xero_account_rules: { data: rules, error: null },
    xero_tracking_options: { data: null, error: { message: 'boom' } },
  }), 'org-1')
  assertEquals(failed.optionsLoaded, false)
  assertEquals(failed.activeOptions.size, 0)
  const empty = await loadDraftStandard(fakeClient({
    xero_account_rules: { data: rules, error: null },
    xero_tracking_options: { data: [], error: null },
  }), 'org-1')
  assertEquals(empty.optionsLoaded, false)
})

Deno.test('withJobPrefix: adds the prefix once; no job number leaves the words', () => {
  assertEquals(withJobPrefix('SWP-ZZTEST01', 'Posts'), '[SWP-ZZTEST01] Posts')
  assertEquals(withJobPrefix('SWP-ZZTEST01', '[SWP-ZZTEST01] Posts'), '[SWP-ZZTEST01] Posts')
  assertEquals(withJobPrefix(null, 'Posts'), 'Posts')
  assertEquals(withJobPrefix('', 'Posts'), 'Posts')
})

const loaded = { activeOptions: new Set(['SW - PATIOS', 'SW - FENCING']), optionsLoaded: true }

Deno.test('checkDraft: a complete bill has no problem and every flag true', () => {
  const c = checkDraft({
    documentType: 'ACCPAY',
    lines: [
      { accountCode: '306', trackingOption: 'SW - PATIOS', description: '[SWP-ZZTEST01] Posts', jobNumber: 'SWP-ZZTEST01' },
      { accountCode: '306', trackingOption: 'SW - FENCING', description: 'Panels', jobNumber: 'SWF-ZZTEST01' },
    ],
    billNumber: 'INV-ZZTEST SWF-ZZTEST01',
    hasSourceDocument: true,
  }, loaded)
  assertEquals(c.problems, [])
  assertEquals([c.has_account_codes, c.has_division_tags, c.has_job_reference, c.has_source_document], [true, true, true, true])
})

Deno.test('checkDraft: a missing tag and a missing account are named by line', () => {
  const c = checkDraft({
    documentType: 'ACCPAY',
    lines: [
      { accountCode: '306', trackingOption: 'SW - PATIOS', description: '[SWP-ZZTEST01] Posts', jobNumber: 'SWP-ZZTEST01' },
      { accountCode: '', trackingOption: '', description: '[SWP-ZZTEST01] Screws', jobNumber: 'SWP-ZZTEST01' },
    ],
    hasSourceDocument: true,
  }, loaded)
  assertEquals(c.problems.map((p) => [p.code, p.line]), [['account_code_missing', 2], ['division_not_known', 2]])
  assertEquals(c.has_division_tags, false)
  assertEquals(c.has_account_codes, false)
  assertEquals(c.has_job_reference, true)
})

Deno.test('checkDraft: an archived option is not active', () => {
  const c = checkDraft({
    documentType: 'ACCPAYCREDIT',
    lines: [{ accountCode: '306', trackingOption: 'SW - DECKING', description: '[SWD-ZZTEST01] Credit', jobNumber: 'SWD-ZZTEST01' }],
    hasSourceDocument: true,
  }, loaded)
  assertEquals(c.problems.map((p) => p.code), ['division_option_not_active'])
  assertEquals(c.has_division_tags, false)
})

Deno.test('checkDraft: options not loaded is one problem, not one per line, and tags are not shown complete', () => {
  const c = checkDraft({
    documentType: 'ACCPAY',
    lines: [
      { accountCode: '306', trackingOption: 'SW - PATIOS', description: '[SWP-ZZTEST01] A', jobNumber: 'SWP-ZZTEST01' },
      { accountCode: '306', trackingOption: 'SW - PATIOS', description: '[SWP-ZZTEST01] B', jobNumber: 'SWP-ZZTEST01' },
    ],
    hasSourceDocument: true,
  }, { activeOptions: new Set(), optionsLoaded: false })
  assertEquals(c.problems.map((p) => [p.code, p.line]), [['options_not_loaded', null]])
  assertEquals(c.has_division_tags, false)
})

Deno.test('checkDraft: a bill line without its job prefix, and no bill number carrying it', () => {
  const c = checkDraft({
    documentType: 'ACCPAY',
    lines: [{ accountCode: '306', trackingOption: 'SW - PATIOS', description: 'Posts for SWP-ZZTEST01', jobNumber: 'SWP-ZZTEST01' }],
    billNumber: 'INV-ZZTEST',
    hasSourceDocument: false,
  }, loaded)
  assertEquals(c.problems.map((p) => p.code), ['job_reference_missing', 'source_document_missing'])
  assertEquals(c.has_job_reference, false)
  assertEquals(c.has_source_document, false)
})

Deno.test('checkDraft: a customer invoice with no document is never short of one; its reference must carry the job', () => {
  const ok = checkDraft({
    documentType: 'ACCREC',
    lines: [{ accountCode: '200', trackingOption: 'SW - FENCING', description: 'Fence', jobNumber: 'SWF-ZZTEST01' }],
    reference: 'SWF-ZZTEST01',
    hasSourceDocument: false,
  }, loaded)
  assertEquals(ok.problems, [])
  assertEquals(ok.has_source_document, true)
  const noRef = checkDraft({
    documentType: 'ACCREC',
    lines: [{ accountCode: '200', trackingOption: 'SW - FENCING', description: '[SWF-ZZTEST01] Fence', jobNumber: 'SWF-ZZTEST01' }],
    reference: '',
    hasSourceDocument: false,
  }, loaded)
  assertEquals(noRef.problems.map((p) => p.code), ['job_reference_missing'])
})

Deno.test('linesFingerprint: same lines give the same print; one account code changes it', async () => {
  const lines = [
    { accountCode: '306', trackingOption: 'SW - PATIOS', quantity: 2 },
    { accountCode: '306', trackingOption: 'SW - PATIOS', quantity: 1 },
  ]
  const a = await linesFingerprint(lines)
  const b = await linesFingerprint(lines.map((l) => ({ ...l })))
  assertEquals(a, b)
  assert(/^[0-9a-f]{64}$/.test(a))
  const changed = await linesFingerprint([{ ...lines[0], accountCode: '400' }, lines[1]])
  assertNotEquals(a, changed)
})
