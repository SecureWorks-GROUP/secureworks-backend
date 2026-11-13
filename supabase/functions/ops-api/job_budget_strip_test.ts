// Ruling 17 merge condition: no `budget` key (and no commission figure) reaches a
// customer, a trade or a crew document. These pin every read that hands pricing
// to one of them (docs/job-budget-v1.md, "Who can see it").

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { redactTradeScopeQuote } from './index.ts'
import { withoutBudget } from '../_shared/job_budget/budget_v1.ts'
import { patioBase } from '../_shared/job_budget/budget_examples.ts'

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

Deno.test('the pricing strip keeps everything but the budget', () => {
  const pricing = { totalIncGST: 11000, runs: [{ label: 'A' }], budget: patioBase() }
  assertEquals(withoutBudget(pricing) as unknown, { totalIncGST: 11000, runs: [{ label: 'A' }] })
  const asText = withoutBudget(JSON.stringify(pricing))
  assert(!asText.includes('budget'))
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
