import { assert, assertEquals, assertNotEquals } from 'jsr:@std/assert@1'
import {
  accountRuleFor,
  checkDraft,
  divisionTrackingOption,
  draftDivisionTrackingOption,
  loadDraftStandard,
  linesFingerprint,
  withJobPrefix,
  type XeroAccountRule,
} from './xero_draft_standard.ts'
import { _trackingCategoryForJob } from '../ops-api/index.ts'

type Example = {
  job_number: string | null
  job_type: string | null
  stock_division?: string
  expect: string // Legacy invoice or switch off.
  ruled?: string // When the owner ruling changes the answer.
  option_state?: 'ACTIVE' | 'ARCHIVED' | 'other_org' | 'missing'
}
const examples: Example[] = JSON.parse(
  await Deno.readTextFile(new URL('./division_examples.json', import.meta.url)),
)

Deno.test('division examples: divisionTrackingOption and trackingCategoryForJob both give each expect', () => {
  for (const e of examples) {
    assertEquals(
      divisionTrackingOption(e.job_number ?? '', e.job_type),
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

Deno.test('division examples: switched-on drafts follow the same table as SQL', async () => {
  for (const row of examples) {
    const client = fakeClient({
      feature_flags: { data: [{ enabled: true }], error: null },
      xero_tracking_options: {
        data: row.option_state === 'ACTIVE' ? [{ option_name: 'Private Renovations' }] : [],
        error: null,
      },
    })
    assertEquals(await draftDivisionTrackingOption(client, 'org-1', row), row.ruled ?? row.expect, JSON.stringify(row))
    for (const read of client.calls.filter((call) => call.table === 'xero_tracking_options')) {
      assertEquals(read.filters, [['org_id', 'org-1'], ['status', 'ACTIVE'], ['option_name', 'Private Renovations']])
    }
  }
})

Deno.test('existing invoice path pins main: granny flat stays untagged and general/misc keep prefix fallback', () => {
  for (const jobNumber of ['SWP-ZZTEST01', 'SWF-ZZTEST01', '']) {
    assertEquals(_trackingCategoryForJob(jobNumber, 'granny_flat'), '')
  }
  for (const type of ['general', 'miscellaneous', 'misc', ' GENERAL ']) {
    assertEquals(_trackingCategoryForJob('SWP-ZZTEST01', type), 'SW - PATIOS')
    assertEquals(_trackingCategoryForJob('SWF-ZZTEST01', type), 'SW - FENCING')
    assertEquals(_trackingCategoryForJob('SWM-ZZTEST01', type), '')
  }
})

Deno.test('stock division: switched-on drafts take SW options and division words, else fall to the job', async () => {
  const client = fakeClient({ feature_flags: { data: [{ enabled: true }], error: null } })
  const pick = (input: Parameters<typeof draftDivisionTrackingOption>[2]) => draftDivisionTrackingOption(client, 'org-1', input)
  assertEquals(await pick({ stock_division: 'SW - PATIOS' }), 'SW - PATIOS')
  const words: [string, string][] = [
    ['patio', 'SW - PATIOS'], ['Patios', 'SW - PATIOS'], ['FENCING', 'SW - FENCING'], ['fence', 'SW - FENCING'],
    ['decking', 'SW - DECKING'], ['Deck', 'SW - DECKING'], ['roofing', 'SW - PRIVATE ROOFING'],
    ['makesafe', 'SW - MAKESAFE'], ['Insurance', 'SW - INSURANCE WORK'], ['restoration', 'SW - RESTORATION'],
  ]
  for (const [word, option] of words) assertEquals(await pick({ stock_division: word }), option, word)
  assertEquals(await pick({ stock_division: 'fencing', job_number: 'SWP-ZZTEST01' }), 'SW - FENCING')
  assertEquals(await pick({ stock_division: 'carpentry' }), '')
  assertEquals(await pick({ stock_division: 'carpentry', job_number: 'SWF-ZZTEST01' }), 'SW - FENCING')
})

Deno.test('settled draft divisions require switch and stored active option; expenses use SW Group', async () => {
  const client = fakeClient({
    feature_flags: { data: [{ enabled: true }], error: null },
    xero_tracking_options: { data: [{ option_name: 'Private Renovations' }], error: null },
  })
  for (const job_type of ['granny_flat', ' GRANNY_FLAT ']) {
    assertEquals(await draftDivisionTrackingOption(client, 'org-1', { job_type, job_number: 'SWP-ZZTEST03' }), 'SecureBuild')
  }
  for (const job_type of ['misc', 'miscellaneous', 'general']) {
    assertEquals(await draftDivisionTrackingOption(client, 'org-1', { job_type, job_number: 'SWP-ZZTEST03' }), 'Private Renovations')
  }
  const optionCalls = client.calls.filter((c) => c.table === 'xero_tracking_options')
  assertEquals(optionCalls.length, 3)
  for (const call of optionCalls) {
    assertEquals(call.filters, [['org_id', 'org-1'], ['status', 'ACTIVE'], ['option_name', 'Private Renovations']])
  }
  for (const stock_division of ['fuel', 'PARKING', 'meals']) {
    assertEquals(await draftDivisionTrackingOption(client, 'org-1', { stock_division }), 'SW Group')
  }
  // Enabling new drafts does not change the existing invoice path.
  assertEquals(_trackingCategoryForJob('SWP-ZZTEST03', 'granny_flat'), '')
  assertEquals(_trackingCategoryForJob('SWP-ZZTEST03', 'general'), 'SW - PATIOS')
})

Deno.test('draft rules off, missing, malformed or unreadable reproduce every legacy example and ignore stock', async () => {
  const answers = [
    { data: [{ enabled: false }], error: null },
    { data: [], error: null },
    { data: [{ enabled: 'true' }], error: null },
    { data: [{ enabled: true }], error: { message: 'unreadable' } },
  ]
  for (const answer of answers) {
    const client = fakeClient({ feature_flags: answer })
    for (const e of examples) {
      assertEquals(await draftDivisionTrackingOption(client, 'org-1', { ...e, stock_division: 'fuel' }), e.expect)
    }
    assert(client.calls.every((c) => c.table === 'feature_flags'))
    assertEquals(client.calls[0].filters, [['flag_name', 'xero_draft_standard_v1']])
  }
  const client = { from() { throw new Error('unreadable') } }
  assertEquals(await draftDivisionTrackingOption(client, 'org-1', { job_type: 'granny_flat' }), '')
  assertEquals(await draftDivisionTrackingOption(client, 'org-1', { job_number: 'SWP-ZZTEST03', job_type: 'general' }), 'SW - PATIOS')
})

Deno.test('loose draft division stays unknown for absent, wrong or unreadable stored option', async () => {
  for (const optionAnswer of [
    { data: [], error: null },
    { data: [{ option_name: 'SW - PATIOS' }], error: null },
    { data: [{ option_name: 'Private Renovations' }], error: { message: 'unreadable' } },
  ]) {
    const client = fakeClient({
      feature_flags: { data: [{ enabled: true }], error: null },
      xero_tracking_options: optionAnswer,
    })
    for (const job_type of ['misc', 'miscellaneous', 'general']) {
      assertEquals(await draftDivisionTrackingOption(client, 'org-1', { job_type, job_number: 'SWP-ZZTEST03' }), '')
    }
  }
  const flags = fakeClient({ feature_flags: { data: [{ enabled: true }], error: null } })
  const client = { from(table: string) {
    if (table === 'feature_flags') return flags.from(table)
    throw new Error('option read failed')
  } }
  assertEquals(await draftDivisionTrackingOption(client, 'org-1', { job_type: 'general' }), '')
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
        limit: () => q,
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
