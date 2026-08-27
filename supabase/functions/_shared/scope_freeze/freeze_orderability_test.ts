// Fence freeze orderability — proof that a frozen revision either carries a
// supplier-pickable materials list or names exactly what is missing, and that
// live autosave drift is visible as a dollar delta. Hand-built fixtures; no
// network. Perturbing a required field must flip the verdict.

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { canonicalJsonAndHash } from '../release_packet/canonicalize.ts'
import {
  FREEZE_ORDERABILITY_CONTRACT_VERSION,
  inspectFreezeOrderability,
  inspectStoredFreezeOrderability,
  summariseFreezeOrderability,
  type FrozenRevisionForOrderability,
} from './freeze_orderability.ts'

const JOB_ID = 'job-fence-orderability-1'
const REVISION_ID = 'rev-fence-orderability-1'
const FROZEN_BY = 'user-estimator-1'
const FROZEN_AT = '2026-08-01T00:00:00.000Z'
const SNAPSHOT_ID = 'fence-pricebook-2026-08-01'

const siteScope = {
  job: {
    address: '12 Example Street',
    suburb: 'Mosman Park',
    runs: [
      { id: 'run-a', name: 'Front', length: 24.5, panels: 11, sheetHeight: 1800 },
    ],
  },
  tool: 'fence-designer',
  version: 'fence-designer@test',
}

const linealMetrePricing = {
  source: 'fence-designer',
  line_items: [
    {
      description: 'Colorbond fencing',
      quantity: 24.5,
      unit: 'm',
      unit_price: 125,
      cost_price: null,
    },
  ],
  totalCostEstimate: 4902,
  labourCostEstimate: 2100,
  materialCostEstimate: 2200,
  commissionCostEstimate: 602,
}

const completeMaterials = [
  {
    line_id: 'mat-panels',
    run_id: 'run-a',
    sku: 'CB-PAN-1800-P',
    description: 'Colorbond panels 1800mm',
    specification: '0.42 BMT, Woodland Grey, 1800 x 2370',
    quantity: 11,
    unit: 'sheet',
    supplier: 'bunnings',
    unit_cost_ex_gst: 85,
    price_snapshot_id: SNAPSHOT_ID,
  },
  {
    line_id: 'mat-posts',
    run_id: 'run-a',
    sku: 'CB-POST-2400',
    description: 'Steel posts 2400mm',
    specification: '60 x 40 x 1.6 SHS, 2400mm',
    quantity: 12,
    unit: 'ea',
    supplier: 'bunnings',
    unit_cost_ex_gst: 42,
    price_snapshot_id: SNAPSHOT_ID,
  },
  {
    line_id: 'mat-concrete',
    run_id: 'run-a',
    sku: 'CONC-20KG',
    description: 'Rapid set concrete',
    specification: '20kg bag',
    quantity: 24,
    unit: 'bag',
    supplier: 'bunnings',
    unit_cost_ex_gst: 8.5,
    price_snapshot_id: SNAPSHOT_ID,
  },
  {
    line_id: 'mat-fixings',
    run_id: 'run-a',
    sku: 'TEK-12-14',
    description: 'Tek screws',
    specification: '12-14 x 20mm hex',
    quantity: 200,
    unit: 'ea',
    supplier: 'bunnings',
    unit_cost_ex_gst: 0.12,
    price_snapshot_id: SNAPSHOT_ID,
  },
]

function completePricing(materials = completeMaterials) {
  return {
    source: 'fence-designer',
    price_snapshot_id: SNAPSHOT_ID,
    materials_list: materials,
    totalCostEstimate: 4902,
    labourCostEstimate: 2100,
    materialCostEstimate: 2200,
    commissionCostEstimate: 602,
  }
}

async function revisionFrom(
  scope: unknown,
  pricing: unknown,
  overrides: Partial<FrozenRevisionForOrderability> = {},
): Promise<FrozenRevisionForOrderability> {
  const { hash: scope_hash } = await canonicalJsonAndHash(scope)
  const { hash: pricing_hash } = await canonicalJsonAndHash(pricing)
  return {
    id: REVISION_ID,
    job_id: JOB_ID,
    tool_kind: 'fencing',
    tool_version: 'fence-designer@test',
    scope_hash,
    pricing_hash,
    frozen_at: FROZEN_AT,
    frozen_by_user_id: FROZEN_BY,
    scope,
    pricing,
    ...overrides,
  }
}

function missingFields(report: { missing: Array<{ field: string; line_id?: string }> }): string[] {
  return report.missing.map((m) => m.line_id ? `${m.field}@${m.line_id}` : m.field)
}

Deno.test('lineal-metres-only fence freeze is not_orderable and names sku, supplier, unit-cost', async () => {
  const revision = await revisionFrom(siteScope, linealMetrePricing)
  const report = await inspectFreezeOrderability({ revision })
  assertEquals(report.contract_version, FREEZE_ORDERABILITY_CONTRACT_VERSION)
  assertEquals(report.verdict, 'not_orderable')
  assertEquals(report.identity.job_id, true)
  assertEquals(report.identity.family, true)
  assertEquals(report.site.address, true)
  assertEquals(report.site.suburb, true)
  assertEquals(report.lines.length, 1)
  const fields = report.missing.map((m) => m.field)
  assert(fields.includes('sku'), `missing sku, got ${fields.join(',')}`)
  assert(fields.includes('supplier'), `missing supplier, got ${fields.join(',')}`)
  assert(fields.includes('unit_cost_ex_gst'), `missing unit_cost_ex_gst, got ${fields.join(',')}`)
  assert(report.lines[0].sku === false)
  assert(report.lines[0].supplier === false)
  assert(report.lines[0].unit_cost_ex_gst === false)
  // Sell unit_price must never count as a unit cost.
  assert(report.lines[0].missing.includes('unit_cost_ex_gst'))
})

Deno.test('complete freeze with panels, posts, concrete, fixings is orderable', async () => {
  const revision = await revisionFrom(siteScope, completePricing())
  const report = await inspectFreezeOrderability({ revision })
  assertEquals(report.verdict, 'orderable')
  assertEquals(report.missing, [])
  assertEquals(report.lines.length, 4)
  const ids = report.lines.map((l) => l.line_id).sort()
  assertEquals(ids, ['mat-concrete', 'mat-fixings', 'mat-panels', 'mat-posts'])
  for (const line of report.lines) {
    assertEquals(line.source, 'materials_list')
    assertEquals(line.sku, true)
    assertEquals(line.description, true)
    assertEquals(line.specification, true)
    assertEquals(line.quantity, true)
    assertEquals(line.unit, true)
    assertEquals(line.supplier, true)
    assertEquals(line.unit_cost_ex_gst, true)
    assertEquals(line.price_snapshot_id, true)
    assertEquals(line.missing, [])
  }
})

Deno.test('live pricing drift reports the exact dollar delta ($5,693 vs $4,902)', async () => {
  const frozenPricing = linealMetrePricing
  const livePricing = { ...linealMetrePricing, totalCostEstimate: 5693 }
  const revision = await revisionFrom(siteScope, frozenPricing)
  const live = { scope_json: siteScope, pricing_json: livePricing }
  const report = await inspectFreezeOrderability({ revision, live })
  assertEquals(report.drift.compared, true)
  assertEquals(report.drift.scope_hash_match, true)
  assertEquals(report.drift.pricing_hash_match, false)
  assertEquals(report.drift.drifted, true)
  assertEquals(report.drift.frozen_cost_ex_gst, 4902)
  assertEquals(report.drift.live_cost_ex_gst, 5693)
  assertEquals(report.drift.dollar_delta, 791)
})

Deno.test('pricing-only live compare does not invent a scope-hash mismatch', async () => {
  const frozenPricing = linealMetrePricing
  const livePricing = { ...linealMetrePricing, totalCostEstimate: 5693 }
  const revision = await revisionFrom(siteScope, frozenPricing)
  const report = await inspectFreezeOrderability({
    revision,
    live: { pricing_json: livePricing },
  })
  assertEquals(report.drift.compared, true)
  assertEquals(report.drift.scope_hash_match, null)
  assertEquals(report.drift.pricing_hash_match, false)
  assertEquals(report.drift.drifted, true)
  assertEquals(report.drift.dollar_delta, 791)
})

Deno.test('matching live blobs report no drift and a zero dollar delta', async () => {
  const revision = await revisionFrom(siteScope, completePricing())
  const live = { scope_json: siteScope, pricing_json: completePricing() }
  const report = await inspectFreezeOrderability({ revision, live })
  assertEquals(report.verdict, 'orderable')
  assertEquals(report.drift.compared, true)
  assertEquals(report.drift.scope_hash_match, true)
  assertEquals(report.drift.pricing_hash_match, true)
  assertEquals(report.drift.drifted, false)
  assertEquals(report.drift.dollar_delta, 0)
})

Deno.test('freeze missing only its price-snapshot binding is not_orderable for that reason alone', async () => {
  const materials = completeMaterials.map((line) => {
    const { price_snapshot_id: _drop, ...rest } = line
    return rest
  })
  const pricing = {
    source: 'fence-designer',
    materials_list: materials,
    totalCostEstimate: 4902,
  }
  const revision = await revisionFrom(siteScope, pricing)
  const report = await inspectFreezeOrderability({ revision })
  assertEquals(report.verdict, 'not_orderable')
  assertEquals(new Set(report.missing.map((m) => m.field)), new Set(['price_snapshot_id']))
  assert(report.missing.some((m) => m.field === 'price_snapshot_id' && m.line_id == null))
  for (const line of report.lines) {
    assertEquals(line.sku, true)
    assertEquals(line.supplier, true)
    assertEquals(line.unit_cost_ex_gst, true)
    assertEquals(line.price_snapshot_id, false)
    assertEquals(line.missing, ['price_snapshot_id'])
  }
})

Deno.test('perturbation: removing one line supplier flips verdict and names that line', async () => {
  const intact = await inspectFreezeOrderability({
    revision: await revisionFrom(siteScope, completePricing()),
  })
  assertEquals(intact.verdict, 'orderable')

  const perturbedMaterials = completeMaterials.map((line) =>
    line.line_id === 'mat-posts' ? { ...line, supplier: '' } : line,
  )
  const perturbed = await inspectFreezeOrderability({
    revision: await revisionFrom(siteScope, completePricing(perturbedMaterials)),
  })
  assertEquals(perturbed.verdict, 'not_orderable')
  assert(
    perturbed.missing.some((m) => m.field === 'supplier' && m.line_id === 'mat-posts'),
    `expected supplier@mat-posts, got ${missingFields(perturbed).join(',')}`,
  )
  const posts = perturbed.lines.find((l) => l.line_id === 'mat-posts')
  assert(posts)
  assertEquals(posts.supplier, false)
  assertEquals(posts.missing, ['supplier'])
  // Other lines stay clean so the flip is isolated to the perturbed field.
  for (const line of perturbed.lines) {
    if (line.line_id === 'mat-posts') continue
    assertEquals(line.missing, [])
  }
})

Deno.test('summarise counts orderable vs not and the most common missing field', async () => {
  const lineal = await inspectFreezeOrderability({
    revision: await revisionFrom(siteScope, linealMetrePricing),
  })
  const complete = await inspectFreezeOrderability({
    revision: await revisionFrom(siteScope, completePricing()),
  })
  const summary = summariseFreezeOrderability([lineal, complete, lineal])
  assertEquals(summary.examined, 3)
  assertEquals(summary.orderable, 1)
  assertEquals(summary.not_orderable, 2)
  assert(summary.most_common_missing_field != null)
  assert((summary.missing_field_counts[summary.most_common_missing_field] ?? 0) >= 2)
})

// ── stored-revision loader (same shape freeze_scope persists) ──────────────

type Row = Record<string, unknown>
type State = { jobs: Row[]; scope_revisions: Row[] }

class MockChain {
  table: keyof State
  state: State
  filters: Array<[string, unknown]> = []
  constructor(table: keyof State, state: State) {
    this.table = table
    this.state = state
  }
  select(_cols: string) { return this }
  eq(col: string, v: unknown) { this.filters.push([col, v]); return this }
  async maybeSingle(): Promise<{ data: Row | null; error: unknown }> {
    const rows = this.state[this.table].filter((r) => this.filters.every(([c, v]) => r[c] === v))
    return { data: rows[0] ?? null, error: null }
  }
}

function mockClient(state: State) {
  return { from: (table: keyof State) => new MockChain(table, state) }
}

Deno.test('stored loader reads a frozen revision plus live job drift', async () => {
  const frozenPricing = linealMetrePricing
  const livePricing = { ...linealMetrePricing, totalCostEstimate: 5693 }
  const { canonical: scope_canonical_text, hash: scope_hash } = await canonicalJsonAndHash(siteScope)
  const { canonical: pricing_canonical_text, hash: pricing_hash } = await canonicalJsonAndHash(frozenPricing)
  const client = mockClient({
    scope_revisions: [{
      id: REVISION_ID,
      job_id: JOB_ID,
      tool_kind: 'fencing',
      tool_version: 'fence-designer@test',
      scope_canonical_text,
      scope_hash,
      pricing_canonical_text,
      pricing_hash,
      frozen_at: FROZEN_AT,
      frozen_by_user_id: FROZEN_BY,
    }],
    jobs: [{
      id: JOB_ID,
      scope_json: siteScope,
      pricing_json: livePricing,
    }],
  })
  const result = await inspectStoredFreezeOrderability(client, { scope_revision_id: REVISION_ID })
  assert(result.ok)
  assertEquals(result.report.verdict, 'not_orderable')
  assertEquals(result.report.drift.drifted, true)
  assertEquals(result.report.drift.dollar_delta, 791)
  assert(result.report.missing.some((m) => m.field === 'sku'))
})

Deno.test('stored loader returns revision_not_found for an unknown id', async () => {
  const client = mockClient({ scope_revisions: [], jobs: [] })
  const result = await inspectStoredFreezeOrderability(client, { scope_revision_id: 'missing' })
  assertEquals(result.ok, false)
  if (!result.ok) assertEquals(result.error.code, 'revision_not_found')
})

Deno.test('explicit empty materials_list does not fall back to sell lineal metres', async () => {
  const pricing = {
    ...linealMetrePricing,
    materials_list: [],
    price_snapshot_id: SNAPSHOT_ID,
  }
  const report = await inspectFreezeOrderability({
    revision: await revisionFrom(siteScope, pricing),
  })
  assertEquals(report.verdict, 'not_orderable')
  assertEquals(report.lines.length, 0)
  assert(report.missing.some((m) => m.field === 'materials_lines'))
})

Deno.test('job-wide supplier is not inherited onto a line', async () => {
  const pricing = {
    price_snapshot_id: SNAPSHOT_ID,
    materials_list: [{
      line_id: 'mat-panels',
      sku: 'CB-PAN-1800-P',
      description: 'Colorbond panels',
      specification: '1800mm Woodland Grey',
      quantity: 11,
      unit: 'sheet',
      unit_cost_ex_gst: 85,
      price_snapshot_id: SNAPSHOT_ID,
    }],
  }
  const scope = {
    job: {
      ...siteScope.job,
      supplier: 'bunnings',
    },
  }
  const report = await inspectFreezeOrderability({
    revision: await revisionFrom(scope, pricing),
  })
  assertEquals(report.verdict, 'not_orderable')
  assert(report.missing.some((m) => m.field === 'supplier' && m.line_id === 'mat-panels'))
})

Deno.test('identity gaps are named when freeze stamps are empty', async () => {
  const report = await inspectFreezeOrderability({
    revision: await revisionFrom(siteScope, completePricing(), {
      job_id: null,
      tool_kind: '',
      tool_version: '   ',
      frozen_by_user_id: null,
      frozen_at: null,
      scope_hash: 'not-a-hash',
    }),
  })
  assertEquals(report.verdict, 'not_orderable')
  const fields = report.missing.map((m) => m.field)
  for (const needed of [
    'identity.job_id',
    'identity.family',
    'identity.tool_version',
    'identity.content_hash',
    'identity.frozen_by',
    'identity.frozen_at',
  ]) {
    assert(fields.includes(needed), `expected ${needed} in ${fields.join(',')}`)
  }
})
