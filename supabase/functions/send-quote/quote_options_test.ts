// deno-lint-ignore-file no-explicit-any no-import-prefix
// Ruling 14 step 1: options ticked at acceptance. Proves the pure rules
// (quote_options.ts), the Accept page card (quote_options_page.ts), the reads
// and record write (quote_options_store.ts), and the handler's wiring by its
// source, the same way accepted_job_price_test.ts pins /accept.
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  acceptedPricing,
  chooseOptions,
  optionAcceptanceRecord,
  optionRefusalMessage,
  partyOptionDeposit,
  readQuoteOptions,
  type QuoteOptionsOffer,
} from './quote_options.ts'
import { buildQuoteOptionsCard, optionFigures } from './quote_options_page.ts'
import {
  loadDocumentOptions,
  optionFates,
  acceptDocumentWithOptions,
  readOptionAcceptances,
} from './quote_options_store.ts'

// ── fixtures ────────────────────────────────────────────────────────────────

const LIGHTS = {
  id: 'lights', name: 'Two downlights', line: 'Two LED downlights in the ceiling',
  quantity: 1, unit: 'each', sell_ex_gst: 400, gst: 40, sell_inc_gst: 440,
  payer_id: '__client__', goes: 'supplier', cost_ex_gst: 180, cost_kind: 'materials',
  order_line: { id: 'l1', description: 'Two downlights', quantity: 1, unit: 'each', colour: null },
}
const GUTTER = {
  id: 'gutter', name: 'Extra gutter', line: '',
  quantity: 6, unit: 'm', sell_ex_gst: 1000, gst: 100, sell_inc_gst: 1100,
  payer_id: '__client__', goes: 'crew', cost_ex_gst: 600, cost_kind: 'labour',
  labour_line: { line_key: 'opt:gutter', description: 'Extra gutter', source: 'option', quantity: 1, unit: 'job', rate: null, total: 600 },
}

function combo(ids: string[], ex: number, gst: number, inc: number, dep: number) {
  return {
    option_ids: ids, totalExGST: ex, gst, totalIncGST: inc, deposit_inc_gst: dep,
    payment_schedule: { version: 1, payments: [
      { id: 'deposit', label: 'Deposit', amount_inc_gst: dep },
      { id: 'final', label: 'Final', amount_inc_gst: Math.round((inc - dep) * 100) / 100 },
    ] },
  }
}

function patioPricing(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    totalExGST: 10000, gst: 1000, totalIncGST: 11000,
    deposit: { percent: 50, fixed_amount: null, council_fees: 0, description: 'Deposit', total_deposit_inc_gst: 5500 },
    line_items: [{ category: 'custom', description: 'Base' }],
    payment_schedule: { version: 1, payments: [
      { id: 'deposit', label: 'Deposit', amount_inc_gst: 5500 },
      { id: 'final', label: 'Final', amount_inc_gst: 5500 },
    ] },
    optional_extras: {
      version: 1,
      sentence: 'Tell us which options you want when you accept.',
      options: [LIGHTS, GUTTER],
      combinations: [
        combo([], 10000, 1000, 11000, 5500),
        combo(['lights'], 10400, 1040, 11440, 5720),
        combo(['gutter'], 11000, 1100, 12100, 6050),
        combo(['lights', 'gutter'], 11400, 1140, 12540, 6270),
      ],
    },
    ...over,
  }
}

function offerOf(pricing: unknown): QuoteOptionsOffer {
  const read = readQuoteOptions(pricing)
  if (read.kind !== 'offer') throw new Error(`expected an offer, got ${JSON.stringify(read)}`)
  return read.offer
}

function withBlock(mut: (block: any) => void): Record<string, any> {
  const p = structuredClone(patioPricing())
  mut(p.optional_extras)
  return p
}

// ── the offer is checked before anything can be ticked ───────────────────────

Deno.test('R14 an old sealed quote with no options block reads as none', () => {
  const p = patioPricing()
  delete p.optional_extras
  assertEquals(readQuoteOptions(p), { kind: 'none' })
  assertEquals(readQuoteOptions(null), { kind: 'none' })
})

Deno.test('R14 a valid offer reads with every option and combination', () => {
  const offer = offerOf(patioPricing())
  assertEquals(offer.options.map((o) => o.id), ['lights', 'gutter'])
  assertEquals(offer.combinations.length, 4)
  assertEquals(offer.combinations[0].option_ids, [])
})

Deno.test('R14 a broken offer is refused with its reason, never trusted', () => {
  const cases: Array<[string, (b: any) => void]> = [
    ['options_version_unsupported', (b) => { b.version = 2 }],
    ['options_empty', (b) => { b.options = [] }],
    ['option_id_duplicate', (b) => { b.options[1] = { ...b.options[1], id: 'lights' } }],
    ['combinations_incomplete', (b) => { b.combinations.pop() }],
    ['combination_total_not_base_plus_options', (b) => { b.combinations[1].totalIncGST = 11441; b.combinations[1].gst = 1041 }],
    ['combination_ex_plus_gst_not_inc', (b) => { b.combinations[1].totalIncGST = 11441 }],
    ['base_combination_deposit_mismatch', (b) => { b.combinations[0].deposit_inc_gst = 5000; b.combinations[0].payment_schedule.payments = [{ amount_inc_gst: 5000 }, { amount_inc_gst: 6000 }] }],
    ['combination_deposit_out_of_range', (b) => { b.combinations[1].deposit_inc_gst = 20000 }],
    ['combination_schedule_not_total', (b) => { b.combinations[2].payment_schedule.payments[1].amount_inc_gst = 1 }],
    ['combination_base_not_first', (b) => { b.combinations.reverse() }],
  ]
  for (const [reason, mut] of cases) {
    const read = readQuoteOptions(withBlock(mut))
    assertEquals(read.kind, 'invalid', reason)
    assertEquals((read as { reason: string }).reason, reason)
  }
})

Deno.test('R14 an option with no price or a wrong GST is refused', () => {
  const zero = readQuoteOptions(withBlock((b) => { b.options[0] = { ...b.options[0], sell_ex_gst: 0, gst: 0, sell_inc_gst: 0 } }))
  assertEquals(zero.kind, 'invalid')
  const gst = readQuoteOptions(withBlock((b) => { b.options[0] = { ...b.options[0], gst: 41, sell_inc_gst: 441 } }))
  assertEquals(gst.kind, 'invalid')
})

// ── none, one and two ticked: total, deposit and record ──────────────────────

const ticks: Array<{ ticked: string[]; total: number; ex: number; gst: number; deposit: number }> = [
  { ticked: [], total: 11000, ex: 10000, gst: 1000, deposit: 5500 },
  { ticked: ['lights'], total: 11440, ex: 10400, gst: 1040, deposit: 5720 },
  { ticked: ['gutter', 'lights'], total: 12540, ex: 11400, gst: 1140, deposit: 6270 },
]

for (const t of ticks) {
  Deno.test(`R14 ${t.ticked.length} ticked: total, deposit, job price and record`, () => {
    const pricing = patioPricing()
    const offer = offerOf(pricing)
    const choice = chooseOptions(offer, t.ticked)
    assert(choice.ok)
    assertEquals(choice.combination.totalIncGST, t.total)
    assertEquals(choice.combination.deposit_inc_gst, t.deposit)
    assertEquals(choice.taken.map((o) => o.id).sort(), [...t.ticked].sort())

    const accepted = acceptedPricing(pricing, offer, choice)
    assertEquals([accepted.totalExGST, accepted.gst, accepted.totalIncGST], [t.ex, t.gst, t.total])
    assertEquals((accepted.deposit as any).total_deposit_inc_gst, t.deposit)
    assertEquals((accepted.deposit as any).percent, 50, 'the sealed deposit percent is unchanged')
    assertEquals((accepted.payment_schedule as any).payments[0].amount_inc_gst, t.deposit)
    assertEquals((accepted.optional_extras as any).accepted_option_ids, choice.taken.map((o) => o.id))
    assertEquals(pricing.totalIncGST, 11000, 'the released pricing is never changed in place')

    const record = optionAcceptanceRecord({
      jobId: 'job-1', documentId: 'doc-1', revisionId: 'rev-1', via: 'public_link', staffUserId: null, offer, choice,
    })
    assertEquals(record.offered.map((o) => [o.id, o.sell_ex_gst, o.gst, o.sell_inc_gst]), [
      ['lights', 400, 40, 440], ['gutter', 1000, 100, 1100],
    ])
    assertEquals(record.base_total_inc_gst, 11000)
    assertEquals([record.accepted_total_ex_gst, record.accepted_gst, record.accepted_total_inc_gst], [t.ex, t.gst, t.total])
    assertEquals(record.accepted_deposit_inc_gst, t.deposit)
    assertEquals(record.accepted_total_inc_gst, record.accepted_total_ex_gst + record.accepted_gst)

    const fates = optionFates(record)
    for (const f of fates) {
      assertEquals(f.label, t.ticked.includes(f.id) ? 'taken' : 'offered, not taken')
    }
  })
}

Deno.test('R14 a bad tick set is refused with plain words', () => {
  const offer = offerOf(patioPricing())
  const bad: Array<[unknown, string]> = [
    ['lights', 'option_ids_not_a_list'],
    [['nope'], 'option_not_on_this_quote'],
    [['lights', 'lights'], 'option_id_duplicate'],
    [[1], 'option_id_not_text'],
    [['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'option_ids_more_than_six'],
  ]
  for (const [ticked, reason] of bad) {
    const choice = chooseOptions(offer, ticked)
    assertEquals(choice, { ok: false, reason })
    const words = optionRefusalMessage(reason)
    assert(words.length > 0 && !words.includes('_') && !words.includes('—'), reason)
  }
  assert(chooseOptions(offer, undefined).ok, 'no ticks at all is the base price')
})

Deno.test('R14 phone acceptance records the staff member', () => {
  const offer = offerOf(patioPricing())
  const choice = chooseOptions(offer, ['gutter'])
  assert(choice.ok)
  const record = optionAcceptanceRecord({
    jobId: 'job-1', documentId: 'doc-1', revisionId: 'rev-1', via: 'staff_phone', staffUserId: 'staff-1', offer, choice,
  })
  assertEquals(record.accepted_via, 'staff_phone')
  assertEquals(record.accepted_by, 'staff-1')
  assertEquals(record.taken_option_ids, ['gutter'])
})

Deno.test('R14 fence: a taken option adds its line item; a not-taken one does not', () => {
  const fence = withBlock((b) => {
    b.options[0] = { ...b.options[0], line_item: { category: 'custom', description: 'Lights', total_sell: 400 } }
    b.options[1] = { ...b.options[1], line_item: { category: 'custom', description: 'Gutter', total_sell: 1000 } }
  })
  const offer = offerOf(fence)
  const choice = chooseOptions(offer, ['lights'])
  assert(choice.ok)
  const items = acceptedPricing(fence, offer, choice).line_items as Array<{ description: string }>
  assertEquals(items.map((i) => i.description), ['Base', 'Lights'])
})

Deno.test('R14 a fence with payers: every combination must carry the parties', () => {
  const p = patioPricing({ parties: [{ id: '__client__', ex_gst: 10000, gst: 1000, inc_gst: 11000 }] })
  const read = readQuoteOptions(p)
  assertEquals(read, { kind: 'invalid', reason: 'combination_parties_missing' })
})

// ── the Accept page card ─────────────────────────────────────────────────────

Deno.test('R14 the Accept page lists each option with a tick box and the base figures', () => {
  const offer = offerOf(patioPricing())
  const html = buildQuoteOptionsCard(offer)
  assert(html.includes('Options you can add'))
  assertEquals((html.match(/class="opt-tick"/g) || []).length, 2)
  assert(html.includes('value="lights"') && html.includes('value="gutter"'))
  assert(html.includes('+$440.00') && html.includes('+$1,100.00'))
  assert(html.includes('id="optTotal">$11,000.00<'))
  assert(html.includes('id="optDeposit">$5,500.00<'))
  assert(!html.includes('—'), 'no em dashes in customer text')
  const figures = optionFigures(offer)
  assertEquals(figures['lights|gutter'], { total: '$12,540.00', deposit: '$6,270.00' })
  assertEquals(figures[''], { total: '$11,000.00', deposit: '$5,500.00' })
})

Deno.test('R14 the card escapes option words', () => {
  const offer = offerOf(withBlock((b) => { b.options[0] = { ...b.options[0], name: '<script>x</script>' } }))
  const html = buildQuoteOptionsCard(offer)
  assert(!html.includes('<script>x</script>'))
  assert(html.includes('&lt;script&gt;x&lt;/script&gt;'))
})

// ── reads and the record write ───────────────────────────────────────────────

type Result = { data?: unknown; error?: unknown }
function fakeSb(tables: Record<string, Result | (() => Result)>, inserted: Record<string, unknown[]> = {}) {
  return {
    from(table: string) {
      const q: any = {}
      for (const m of ['select', 'eq', 'in', 'not', 'order', 'limit', 'is']) q[m] = () => q
      q.insert = (row: unknown) => {
        ;(inserted[table] ||= []).push(row)
        const r = tables[`insert:${table}`]
        return Promise.resolve(typeof r === 'function' ? r() : r ?? { error: null })
      }
      q.then = (ok: (r: Result) => unknown, bad: (e: unknown) => unknown) => {
        const r = tables[table]
        return Promise.resolve(typeof r === 'function' ? r() : r ?? { data: [], error: null }).then(ok, bad)
      }
      return q
    },
  }
}

const release = (pricing: unknown) => ({ data: [{ id: 'rev-1', pricing_snapshot_json: { raw: pricing }, sent_at: 'x' }], error: null })

Deno.test('R14 the offer is read from the released revision; an old quote has none', async () => {
  const old = patioPricing()
  delete old.optional_extras
  assertEquals(await loadDocumentOptions(fakeSb({ quote_revisions: release(old) }), { id: 'd', job_id: 'j' }, null), { kind: 'none' })

  const loaded = await loadDocumentOptions(
    fakeSb({ quote_revisions: release(patioPricing()), job_contacts: { data: [{ id: 'c1' }], error: null } }),
    { id: 'd', job_id: 'j' }, null,
  )
  assertEquals(loaded.kind, 'offer')
  assertEquals((loaded as any).shared, false)
  assertEquals((loaded as any).revisionId, 'rev-1')
})

Deno.test('R14 a fence run document never offers options; a shared job offers them on the client quote, not a neighbour quote', async () => {
  const sb = fakeSb({ quote_revisions: release(patioPricing()), job_contacts: { data: [{ id: 'c1' }, { id: 'c2' }], error: null } })
  assertEquals(await loadDocumentOptions(sb, { id: 'd', job_id: 'j' }, 'RHS'), { kind: 'none' })
  const client = await loadDocumentOptions(sb, { id: 'd', job_id: 'j', job_contacts: { contact_label: 'A' } }, null)
  assertEquals([client.kind, (client as any).shared, (client as any).neighbour], ['offer', true, false])
  const neighbour = await loadDocumentOptions(sb, { id: 'd', job_id: 'j', job_contacts: { contact_label: 'B' } }, null)
  assertEquals((neighbour as any).neighbour, true)
})

Deno.test('R14 a failed read is unreadable, never "no options"', async () => {
  const relFail = fakeSb({ quote_revisions: { data: null, error: { message: 'down' } } })
  assertEquals((await loadDocumentOptions(relFail, { id: 'd', job_id: 'j' }, null)).kind, 'unreadable')
  const partiesFail = fakeSb({ quote_revisions: release(patioPricing()), job_contacts: { data: null, error: { message: 'down' } } })
  assertEquals((await loadDocumentOptions(partiesFail, { id: 'd', job_id: 'j' }, null)).kind, 'unreadable')
  assertEquals(await readOptionAcceptances(fakeSb({ quote_option_acceptances: { data: null, error: { code: 'x' } } }), ['d']), null)
})

function rpcSb(answer: Result | (() => never)) {
  const calls: Array<[string, any]> = []
  return {
    calls,
    sb: {
      from() { throw new Error('the acceptance never writes a table directly') },
      rpc(fn: string, args: any) {
        calls.push([fn, args])
        return typeof answer === 'function' ? answer() : Promise.resolve(answer)
      },
    },
  }
}

Deno.test('R14 the acceptance and its record are one database call; a failure accepts nothing', async () => {
  const rec = { job_document_id: 'd' } as any
  const ok = rpcSb({ data: { claimed: true }, error: null })
  assertEquals(await acceptDocumentWithOptions(ok.sb, 'd', 't', rec), { ok: true, claimed: true })
  assertEquals(ok.calls, [['accept_quote_document_with_options', { p_document_id: 'd', p_accepted_at: 't', p_record: rec }]])
  assertEquals(await acceptDocumentWithOptions(rpcSb({ data: { claimed: false }, error: null }).sb, 'd', 't', rec), { ok: true, claimed: false })
  // The migration not applied: the function is missing, so nothing is accepted and the customer retries.
  assertEquals(await acceptDocumentWithOptions(rpcSb({ data: null, error: { code: 'PGRST202' } }).sb, 'd', 't', rec), { ok: false, reason: 'PGRST202' })
  assertEquals(await acceptDocumentWithOptions(rpcSb({ data: null, error: null }).sb, 'd', 't', rec), { ok: false, reason: 'accept_answer_unreadable' })
  assertEquals((await acceptDocumentWithOptions(rpcSb(() => { throw new Error('down') }).sb, 'd', 't', rec)).ok, false)
})

Deno.test('R14 the record carries the taken options and the ticked combination exactly as sealed', () => {
  const pricing = patioPricing()
  const offer = offerOf(pricing)
  const choice = chooseOptions(offer, ['gutter'])
  assert(choice.ok)
  const record = optionAcceptanceRecord({ jobId: 'j', documentId: 'd', revisionId: 'r', via: 'public_link', staffUserId: null, offer, choice })
  assertEquals(record.taken_options, [GUTTER])
  assertEquals(record.accepted_combination, pricing.optional_extras.combinations[2])
})

// ── the handler's wiring, pinned by its source ───────────────────────────────

const SRC = Deno.readTextFileSync(new URL('./index.ts', import.meta.url))
const ACCEPT = SRC.indexOf("if ((path === 'accept' && req.method === 'POST') || staffAccept)")

Deno.test('R14 options are chosen and checked before the acceptance is written', () => {
  const plan = SRC.indexOf('const loaded = await loadDocumentOptions(sb, doc, sourceRunLabel)', ACCEPT)
  const write = SRC.indexOf('const acceptedAt = new Date().toISOString()', ACCEPT)
  assert(ACCEPT > 0 && plan > ACCEPT && write > plan)
  const between = SRC.slice(plan, write)
  assert(between.includes("refuseAccept(optionRefusalMessage('options_on_neighbour_quote')"))
  assert(!between.includes('loaded.shared &&'), 'a shared fence client may take options on the whole quote')
  assert(between.includes('chooseOptions(loaded.offer, tickedOptionIds)'))
  assert(between.includes("loaded.kind === 'unreadable') return retryAccept()"))
})

Deno.test('R14 staff phone acceptance needs an identified office session on its own tenant', () => {
  assert(SRC.includes("path === 'send' || path === 'send-invoice' || path === 'send-runs' || path === 'accept-for-customer'"))
  const head = SRC.slice(ACCEPT, SRC.indexOf('const loaded = await loadDocumentOptions', ACCEPT))
  assert(head.includes("'identified_staff_required'"))
  assert(head.includes('quoteSendTenantAccess'))
  assert(head.includes("const acceptVia"), 'the way in is recorded')
})

Deno.test('R14 an option acceptance is claimed with its record in one call, and a failure accepts nothing', () => {
  const call = SRC.indexOf('const accepted = await acceptDocumentWithOptions(sb, doc.id, acceptedAt, optionAcceptanceRecord({', ACCEPT)
  assert(call > ACCEPT)
  const block = SRC.slice(call, call + 1200)
  assert(block.includes('if (!accepted.ok) {') && block.includes('return retryAccept()'))
  assert(block.includes("if (!accepted.claimed) return jsonResponse({ error: 'Already accepted' }"))
  assert(!SRC.includes("'quote_options_record_failed'"), 'no accepted document is ever left without its record')
})

Deno.test('R14 the deposit is raised on the accepted combination only when options were taken', () => {
  const dep = SRC.indexOf('const optionCombination = optionsTaken.length > 0 && optionPlan ? optionPlan.choice.combination : null', ACCEPT)
  assert(dep > ACCEPT)
  const block = SRC.slice(dep, dep + 3000)
  assert(block.includes('partyOptionDeposit(optionPlan!.pricing, optionCombination, optionsTaken[0].payer_id)'), 'a shared fence client pays their own share')
  assert(block.includes('invoiceBody.deposit_amount = optionDeposit'))
  assert(block.includes('invoiceBody.council_fees = 0'), 'the council fee is inside the combination deposit, never added twice')
  assert(block.includes("'quote_options_party_deposit_unknown'"))
  assert(block.includes("'quote_options_job_price_not_set'"))
})

Deno.test('R14 an old quote with no options sends the same deposit request as before', () => {
  // With optionPlan null: optionsTaken is [], optionCombination null, and the
  // deposit body keeps only its old keys.
  assert(SRC.includes('const optionsTaken = optionPlan ? optionPlan.choice.taken : []'))
  const dep = SRC.indexOf('const optionCombination =', ACCEPT)
  const block = SRC.slice(dep, dep + 3000)
  assert(/else if \(optionCombination && optionDeposit !== null\)/.test(block), 'the option deposit keys are set only with a taken combination')
})

Deno.test('R14 taken options reach the expected cost; their destinations follow from the record', () => {
  assert(SRC.includes('accepted_options: optionsTaken.map((o) => ({ id: o.id, cost_ex_gst: o.cost_ex_gst, cost_kind: o.cost_kind }))'))
  assert(SRC.includes("event_type: 'quote_options_taken'"))
})

// F3: contradictory deposit and payment structures are refused, never trusted.
Deno.test('R14 a deposit that is not the first payment, a negative payment, or a missing schedule is refused', () => {
  const cases: Array<[string, (b: any) => void]> = [
    ['deposit not first payment', (b) => { b.combinations[1].deposit_inc_gst = 0 }],
    ['negative payment', (b) => {
      b.combinations[1].payment_schedule.payments[0].amount_inc_gst = -1
      b.combinations[1].payment_schedule.payments[1].amount_inc_gst = 11441
      b.combinations[1].deposit_inc_gst = -1
    }],
    ['missing schedule', (b) => { delete b.combinations[1].payment_schedule }],
  ]
  for (const [what, mut] of cases) {
    assertEquals(readQuoteOptions(withBlock(mut)).kind, 'invalid', what)
  }
})

Deno.test('R14 the accepted pricing never keeps the base payment schedule or stages', () => {
  const pricing = patioPricing({ local_invoice_stages: { version: 1, stages: [] } })
  delete pricing.local_invoice_stages
  const offer = offerOf(pricing)
  const choice = chooseOptions(offer, ['lights'])
  assert(choice.ok)
  const accepted = acceptedPricing(pricing, offer, choice)
  assertEquals((accepted.payment_schedule as any).payments.map((p: any) => p.amount_inc_gst), [5720, 5720])
  assertEquals('local_invoice_stages' in accepted, false)
})

Deno.test('R14 a shared fence: the client pays their share of the first payment', () => {
  const pricing: any = { deposit: { percent: 50 } }
  const combination: any = {
    totalIncGST: 3740,
    parties: [{ id: 'a', inc_gst: 2640 }, { id: 'b', inc_gst: 1100 }],
    local_invoice_stages: { stages: [{ payers: [{ payer_id: 'a', amount_inc_gst: 1320 }, { payer_id: 'b', amount_inc_gst: 550 }] }] },
  }
  assertEquals(partyOptionDeposit(pricing, combination, 'a'), 1320)
  delete combination.local_invoice_stages
  assertEquals(partyOptionDeposit(pricing, combination, 'a'), 1320, 'no stages: the party total at the deposit percent')
  assertEquals(partyOptionDeposit({}, combination, 'a'), null, 'unknown is never guessed')
})
