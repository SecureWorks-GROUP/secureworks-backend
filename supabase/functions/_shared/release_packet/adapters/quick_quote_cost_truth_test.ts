// Synthetic inputs reuse the existing release fixture. No catalogue prices.
// Drives the real frozen-source reader, adapter and sealed-cost builder.
// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { dispatchAdapter } from './dispatch.ts'
import { qqInputValid } from '../fixtures_v2.ts'
import { buildFullReleasePacket } from '../build_full_release_packet.ts'
import type { AdapterInputs } from '../adapter_interface.ts'
import { canonicalJsonAndHash } from '../canonicalize.ts'
import { quoteSendBuildSource, sealedSendSource, startNamedScopeRevisionRead } from '../../scope_freeze/quote_scope_revision_link.ts'

function inputs(costs: unknown[]): AdapterInputs {
  const existing = qqInputValid.adapter_output.pricing_public
  const seed = existing.line_items[0]
  return {
    job: {
      id: qqInputValid.job_id, type: 'general', org_id: 'test-org',
      client_name: null, client_email: null, client_phone: null,
      site_address: null, site_suburb: null, site_lat: null, site_lng: null,
      job_number: null, scope_json: { tool: 'misc-scoper', kind: 'quote_only' },
      notes: null,
      pricing_json: {
        source: 'quick_quote', job_type_label: 'Custom work',
        job_description: 'Synthetic quote-only draft, no customer or supplier.',
        line_items: costs.map((cost_price, index) => ({
          description: 'Synthetic line', category: index === 1 ? 'labour' : 'material',
          quantity: seed.qty, unit: seed.unit, unit_price: seed.unit_sell,
          total: seed.line_total_ex, cost_price,
        })),
        totalExGST: existing.totals.total_ex_gst,
        gst: existing.totals.gst,
        totalIncGST: existing.totals.total_inc_gst,
      },
    },
    supplemental: {},
  }
}

function adapt(costs: unknown[]) {
  const result = dispatchAdapter(inputs(costs))
  assert(result.ok)
  return result.output
}

async function frozenPricing(input: AdapterInputs) {
  const scope = await canonicalJsonAndHash(input.job.scope_json)
  const pricing = await canonicalJsonAndHash(input.job.pricing_json)
  const row = {
    id: qqInputValid.release_id, job_id: input.job.id, status: 'frozen',
    scope_hash: scope.hash, scope_canonical_text: scope.canonical,
    pricing_hash: pricing.hash, pricing_canonical_text: pricing.canonical,
  }
  const query = {
    select: () => query, eq: () => query,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  }
  const source = sealedSendSource(await startNamedScopeRevisionRead(
    { from: () => query }, row.id, { withFrozenBlobs: true },
  ), input.job.id)
  assertEquals(source.kind, 'sealed')
  const blobs = quoteSendBuildSource(source, { pricing_json: { stale: true } })
  return blobs.pricing_json as Record<string, unknown>
}

Deno.test('quick quote unknown unit costs and derived material costs stay null', () => {
  for (const unknown of [undefined, null, '', ' ', 'unconfirmed', NaN, Infinity, false]) {
    const output = adapt([unknown])
    assertEquals(output.internal_cost.line_costs[0].unit_cost, null)
    assertEquals(output.internal_cost.line_costs[0].line_cost_total_ex, null)
    assertEquals(output.internal_cost.cost_estimates.material_total, null)
  }
})

Deno.test('quick quote explicit numeric and string zero costs remain known zero', () => {
  for (const zero of [0, '0']) {
    const output = adapt([zero, zero])
    assertEquals(output.internal_cost.line_costs.map((line) => line.unit_cost), [0, 0])
    assertEquals(output.internal_cost.line_costs.map((line) => line.line_cost_total_ex), [0, 0])
    assertEquals(output.internal_cost.cost_estimates.material_total, 0)
    assertEquals(output.internal_cost.cost_estimates.labour_total, 0)
  }
})

Deno.test('quick quote mixed known and unknown costs do not report a partial category total', () => {
  const known = qqInputValid.adapter_output.internal_cost.line_costs[0].unit_cost
  assert(known !== null)
  const output = adapt([known, 0, null])
  const qty = qqInputValid.adapter_output.pricing_public.line_items[0].qty
  assertEquals(output.internal_cost.line_costs[0].unit_cost, known)
  assertEquals(output.internal_cost.line_costs[0].line_cost_total_ex, Math.round(known * qty * 100) / 100)
  assertEquals(output.internal_cost.cost_estimates.material_total, null)
  assertEquals(output.internal_cost.cost_estimates.labour_total, 0)
  assertEquals(output.pricing_public, adapt([known, 0, known]).pricing_public)
})

Deno.test('quick quote explicit category estimates retain their existing independent value', () => {
  const input = inputs([null, null])
  const estimate = qqInputValid.adapter_output.internal_cost.cost_estimates.material_total
  input.job.pricing_json!.materialCostEstimate = estimate
  input.job.pricing_json!.labourCostEstimate = 0
  const result = dispatchAdapter(input)
  assert(result.ok)
  assertEquals(result.output.internal_cost.cost_estimates.material_total, estimate)
  assertEquals(result.output.internal_cost.cost_estimates.labour_total, 0)
  assertEquals(result.output.internal_cost.line_costs.map((line) => line.unit_cost), [null, null])
})

Deno.test('frozen quick quote read and release serialization preserve unknown costs without changing client totals', async () => {
  const input = inputs([null, 0])
  const adapted = dispatchAdapter({
    ...input,
    job: { ...input.job, pricing_json: await frozenPricing(input) },
  })
  assert(adapted.ok)
  const built = await buildFullReleasePacket({
    ...qqInputValid, adapter_output: adapted.output, mode: 'warn',
  })
  assert(built.ok)
  const costs = JSON.parse(built.internal_cost_canonical_text)
  assertEquals(costs.line_costs[0].unit_cost, null)
  assertEquals(costs.line_costs[0].line_cost_total_ex, null)
  assertEquals(costs.line_costs[1].unit_cost, 0)
  assertEquals(costs.cost_estimates.material_total, null)
  assertEquals(costs.cost_estimates.labour_total, 0)
  assertEquals(built.manifest.pricing_public.totals, adapted.output.pricing_public.totals)
  assertEquals(built.manifest.pricing_public.totals.total_inc_gst, qqInputValid.adapter_output.pricing_public.totals.total_inc_gst)
})

Deno.test('frozen incomplete new Misc quote has an explicit missing-input result instead of a partial public price', async () => {
  const input = inputs([null])
  input.job.pricing_json = {
    ...input.job.pricing_json, tool: 'misc-scoper', pricing_complete: false,
    totalExGST: null, gst: null, totalIncGST: null,
    line_items: [{ description: 'Unpriced custom work', quantity: 1, unit_price: null, total: null }],
  }
  input.job.pricing_json = await frozenPricing(input)
  assertEquals(input.job.pricing_json.totalIncGST, null)
  assertEquals(dispatchAdapter(input), {
    ok: false, reason: 'misc_quote_pricing_incomplete', matched_kind: 'quick_quote',
  })
})

Deno.test('completed Misc quote and legacy Quick Quote keep existing public pricing behavior', () => {
  const known = qqInputValid.adapter_output.internal_cost.line_costs[0].unit_cost
  const input = inputs([known])
  const legacy = dispatchAdapter(input)
  assert(legacy.ok)
  input.job.pricing_json = { ...input.job.pricing_json, tool: 'misc-scoper', pricing_complete: true }
  const complete = dispatchAdapter(input)
  assert(complete.ok)
  assertEquals(complete.output, legacy.output)
  input.job.pricing_json = { ...input.job.pricing_json, tool: 'legacy-quick-quote', pricing_complete: false }
  const legacyFlag = dispatchAdapter(input)
  assert(legacyFlag.ok)
  assertEquals(legacyFlag.output, legacy.output)
})

Deno.test('new Misc missing or unproven completion flag cannot derive public zero or partial price', () => {
  for (const flag of [undefined, null, false, 'true']) {
    const input = inputs([null])
    input.job.pricing_json = { ...input.job.pricing_json, tool: 'misc-scoper', pricing_complete: flag }
    assertEquals(dispatchAdapter(input), {
      ok: false, reason: 'misc_quote_pricing_incomplete', matched_kind: 'quick_quote',
    })
  }
})

Deno.test('new Misc claimed complete still retains missing or nonfinite sell inputs as incomplete', () => {
  for (const value of [undefined, null, '', 'unconfirmed', NaN, Infinity]) {
    for (const field of ['totalExGST', 'gst', 'totalIncGST', 'quantity', 'unit_price', 'total']) {
      const input = inputs([null])
      const pricing = input.job.pricing_json!
      Object.assign(pricing, { tool: 'misc-scoper', pricing_complete: true })
      if (['quantity', 'unit_price', 'total'].includes(field)) {
        (pricing.line_items as Array<Record<string, unknown>>)[0][field] = value
      } else pricing[field] = value
      assertEquals(dispatchAdapter(input), {
        ok: false, reason: 'misc_quote_pricing_incomplete', matched_kind: 'quick_quote',
      })
    }
  }
})

Deno.test('new Misc explicitly known zero sell inputs remain known zero', () => {
  const input = inputs([0])
  input.job.pricing_json = {
    ...input.job.pricing_json, tool: 'misc-scoper', pricing_complete: true,
    totalExGST: 0, gst: 0, totalIncGST: 0,
    line_items: [{ description: 'Known zero fixture', quantity: 1, unit_price: 0, total: 0, cost_price: 0 }],
  }
  const result = dispatchAdapter(input)
  assert(result.ok)
  assertEquals(result.output.pricing_public.totals.total_inc_gst, 0)
  assertEquals(result.output.pricing_public.line_items[0].unit_sell, 0)
  assertEquals(result.output.internal_cost.line_costs[0].unit_cost, 0)
})
