// Ruling 17 merge condition: no `budget` key (and no commission figure) reaches a
// customer, a trade or a crew document. These pin every read that hands pricing
// to one of them (docs/job-budget-v1.md, "Who can see it").

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { redactTradeScopeQuote, stripTradePrivateCarriers } from './index.ts'
import { withoutBudget } from '../_shared/job_budget/budget_v1.ts'
import { patioBase } from '../_shared/job_budget/budget_examples.ts'
import savedFence from '../_shared/job_budget/fixtures/native-fence-scope-saved.json' with { type: 'json' }

const here = new URL('.', import.meta.url)
const read = (rel: string) => Deno.readTextFile(new URL(rel, here))

Deno.test('trade scope reads drop a budget at any depth', () => {
  const scope = {
    job: { runs: [{ length: 10 }], budget: patioBase() },
    patios: [{ options: [{ name: 'Gable', budget: patioBase() }] }],
    budget: patioBase(),
    notes: { general: 'Site access via side gate' },
  }
  const out = redactTradeScopeQuote(structuredClone(scope))
  const text = JSON.stringify(out)
  assert(!text.includes('"budget"'), 'a budget key reached the trade scope')
  assert(!text.includes('278.8'), 'the commission figure reached the trade scope')
  assertEquals(out.notes.general, 'Site access via side gate')
})

Deno.test('ruling 17a: no commission or salesperson key reaches the trade scope, at any depth', () => {
  // The shape a sealed fence revision saves (commission metadata on the job,
  // on each revision pack and in its snapshot).
  const scope = {
    job: {
      runs: [{ length: 10, label: 'A' }],
      commissionBasis: 'gross_profit',
      commission_basis: 'gross_profit',
      salespersonId: '00000000-0000-4000-8000-00000000000b',
      salesperson: { id: '00000000-0000-4000-8000-00000000000b', name: 'ZZTEST Seller' },
      revisionPacks: [{
        commissionFrom: 'app',
        commission: { rule_id: 'fence_15', percent: 15 },
        snapshot: { commissionBasis: 'gross_profit', runs: [{ length: 10 }] },
      }],
    },
    notes: { general: 'Site access via side gate' },
  }
  const out = redactTradeScopeQuote(structuredClone(scope))
  const keys: string[] = []
  const walk = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(walk)
    if (x && typeof x === 'object') {
      for (const [k, v] of Object.entries(x)) {
        keys.push(k)
        walk(v)
      }
    }
  }
  walk(out)
  assertEquals(keys.filter((k) => /commission|salesperson|budget/i.test(k)), [])
  assert(!JSON.stringify(out).includes('ZZTEST Seller'))
  assertEquals(out.job.runs, [{ length: 10, label: 'A' }])
  assertEquals(out.job.revisionPacks[0].snapshot.runs, [{ length: 10 }])
  assertEquals(out.notes.general, 'Site access via side gate')
})

Deno.test('the pricing strip keeps everything but the budget', () => {
  const pricing = { totalIncGST: 11000, runs: [{ label: 'A' }], budget: patioBase() }
  assertEquals(withoutBudget(pricing) as unknown, { totalIncGST: 11000, runs: [{ label: 'A' }] })
  const asText = withoutBudget(JSON.stringify(pricing))
  assert(!asText.includes('budget'))
})

Deno.test('the pricing strip drops the sealed order list with the budget (ruling 17b-1: shown nowhere new)', () => {
  const order = { version: 'order.v1', rows: [{ id: 'patio:SL-1', description: 'ZZTEST post', kind: 'item', cost_by: 'line' }] }
  const pricing = { totalIncGST: 11000, budget: patioBase(), order }
  assertEquals(withoutBudget(pricing) as unknown, { totalIncGST: 11000 })
  assertEquals(withoutBudget({ totalIncGST: 1, order }) as unknown, { totalIncGST: 1 })
  const asText = withoutBudget(JSON.stringify(pricing))
  assert(!asText.includes('order.v1') && !asText.includes('ZZTEST post'))
})

// Review 1427/1279 finding 4: the tool seals the order list on each fence
// revision pack, not only on the pricing record. The fence scope exactly as
// the paired tool saves it, through both Trade App boundaries: the trade scope
// redactor and the every-tier private carrier strip, as an object and as JSON
// text. Every order list goes; the scope's own facts stay.
const orderLists = (x: unknown): number => {
  let n = 0
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      const t = v.trim()
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          walk(JSON.parse(t))
        } catch { /* plain text */ }
      }
      return
    }
    if (Array.isArray(v)) return v.forEach(walk)
    if (v && typeof v === 'object') {
      for (const [k, w] of Object.entries(v)) {
        if (k === 'order' && w && typeof w === 'object' && /^order\./.test(String((w as any).version))) n++
        walk(w)
      }
    }
  }
  walk(x)
  return n
}

Deno.test('the saved fence scope: no order list (order.v1) reaches the Trade App at either boundary, object or JSON text', () => {
  const saved = savedFence.scope
  assertEquals(orderLists(saved), 1, 'the native pack carries one order list')
  const scope = redactTradeScopeQuote(structuredClone(saved))
  const carrier = stripTradePrivateCarriers({ scope_json: structuredClone(saved) })
  const text = stripTradePrivateCarriers({ scope_json: JSON.stringify(saved) })
  const packText = stripTradePrivateCarriers({ scope_json: { ...structuredClone(saved), revisionPacks: [{ ...saved.revisionPacks[0], order: JSON.stringify(saved.revisionPacks[0].order) }] } })
  const scopeText = redactTradeScopeQuote({ ...structuredClone(saved), revisionPacks: [{ ...saved.revisionPacks[0], order: JSON.stringify(saved.revisionPacks[0].order) }] })
  for (const [name, out] of Object.entries({ scope, carrier, text, packText, scopeText })) {
    assertEquals(orderLists(out), 0, name)
    assert(!JSON.stringify(out).includes('order.v1'), name)
    assert(!JSON.stringify(out).includes('"budget"'), name)
  }
  // The scope's own facts stay: the runs, the gates, the pack's number and code.
  assertEquals(carrier.scope_json.runs, saved.runs)
  assertEquals(carrier.scope_json.gates, saved.gates)
  assertEquals([carrier.scope_json.revisionPacks[0].n, carrier.scope_json.revisionPacks[0].code], [saved.revisionPacks[0].n, saved.revisionPacks[0].code])
  assertEquals(JSON.parse(text.scope_json).runs, saved.runs)
  assertEquals(scope.revisionPacks[0].code, saved.revisionPacks[0].code)
})

Deno.test('an order list of any version or without one goes; a number or plain words under order stay', () => {
  const rows = [{ id: 'fence:group:0:0', description: 'ZZTEST sheet', quantity: 9, unit: 'each', cost_by: 'line' }]
  const scope = {
    runs: [{ label: 'A', order: 1 }],
    photos: [{ order: 'Front first' }],
    later: { order: { version: 'order.v2', rows } },
    unversioned: { order: { rows } },
    unreadable: { order: '{"version":"order.v1","rows":[' },
  }
  const redacted = redactTradeScopeQuote(structuredClone(scope))
  const carried = stripTradePrivateCarriers(structuredClone(scope))
  // The every-tier strip keeps both; the redactor keeps the words (its own
  // rule for bare numbers, unchanged here, keeps only named measures).
  assertEquals(carried.runs, [{ label: 'A', order: 1 }])
  assertEquals(redacted.runs, [{ label: 'A' }])
  for (const out of [redacted, carried]) {
    assertEquals(out.photos, [{ order: 'Front first' }])
    assertEquals([out.later, out.unversioned, out.unreadable], [{}, {}, {}])
    assert(!JSON.stringify(out).includes('ZZTEST sheet'))
  }
})

Deno.test('every customer and trade read that receives pricing strips or drops it', async () => {
  const ops = await read('./index.ts')
  // trade_job_detail: the quote packer gets the pricing without its budget, and
  // the job payload drops pricing_json entirely.
  assert(ops.includes('livePricingJson: withoutBudget(jobRes.data?.pricing_json),'))
  assert(ops.includes('const { metadata: _tradeJobMetadata, pricing_json: _tradePricingJson, ...tradeSafeJob } = jobRes.data || {}'))
  // my_jobs: pricing_json is deleted before the card goes out.
  assert(ops.includes("delete a.jobs.pricing_json // don't send pricing data to trades"))
  // The trade scope denylist carries the budget key.
  assert(/TRADE_SCOPE_QUOTE_KEYS = new Set\(\[[\s\S]*?'budget',[\s\S]*?\]\)/.test(ops))
  // The customer's run quote page reads the job's pricing without its budget.
  const sq = await read('../send-quote/index.ts')
  assert(sq.includes('if (fullJob) fullJob.pricing_json = withoutBudget(fullJob.pricing_json)'))
})
