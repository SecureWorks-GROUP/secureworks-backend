// profitability-job-costing M1 (profit-baseline-freeze) U2 — write-once
// expected-cost baseline populated at the acceptance transition.
//
// WHY THIS EXISTS
// ---------------
// jobs.pricing_json is a LIVE MIRROR: fence-designer/integration.js rebuilds it
// on every auto-save, so post-acceptance edits silently rewrite what a job was
// "supposed to cost" (proven drift: one accepted fence job reads cost $5,693
// live vs $4,902 at freeze). Expected-vs-actual variance is therefore
// untrustworthy today. This helper copies the expected cost figures into an
// IMMUTABLE jobs.expected_costs snapshot at the moment a job first reaches
// status='accepted', so the baseline stops moving.
//
// SOURCE ORDER (CP1, ratified by Marnin 2026-07-05):
//   1. The accepted frozen scope_revisions row when one exists — authoritative,
//      hash-verified (pricing_canonical_text + pricing_hash). confidence =
//      'frozen_revision'.
//   2. Else jobs.pricing_json at accept-time — best-effort. confidence =
//      'live_fallback'.
//   3. Else (no frozen revision AND no usable pricing) — NO snapshot is
//      written. The read path (v_job_expected_cost_facts) reports suppressed.
//      No fabricated baseline. This is the NULL-PRICING RULE.
//
// This helper is a SEPARATE accept-time path from freezeScope() in
// ../scope_freeze/scope_freeze.ts. It must NOT change freezeScope's null
// rejection (scope_freeze.ts `job_missing_pricing`) — it does not route through
// it.
//
// The immutability itself is DB-enforced by the write-once trigger added in the
// migration supabase/migrations/_drafts/20260705000001_job_expected_cost_baseline.sql
// (trg_jobs_expected_costs_write_once). This helper additionally guards in
// application code (skip when already frozen; UPDATE ... WHERE expected_costs
// IS NULL) so it is idempotent and race-safe even before the trigger applies.
//
// Injected Supabase client (PostgREST builder shape), same pattern as
// scope_freeze.ts, so it unit-tests against the in-memory mock and runs against
// the real service-role client when wired through send-quote / ops-api.

import { jsonHash } from '../release_packet/canonicalize.ts'

// ── The canonical cost keys ──────────────────────────────────────────────────
// Verified identical across live jobs.pricing_json and frozen
// scope_revisions.pricing_canonical_text (top-level finite numbers, ex-GST
// cost figures). Cost math is computed in patio-tool/index.html:29513-29522 and
// the fence-designer equivalent, then frozen verbatim.
const LANE_COST_KEY = {
  labour: 'labourCostEstimate',
  materials: 'materialCostEstimate',
  commission: 'commissionCostEstimate',
} as const

export type ExpectedLane = keyof typeof LANE_COST_KEY // 'labour' | 'materials' | 'commission'
export const EXPECTED_LANES: ReadonlyArray<ExpectedLane> = ['labour', 'materials', 'commission']

const TOTAL_COST_KEY = 'totalCostEstimate'
const MARGIN_PCT_KEY = 'margin_pct'

export const EXPECTED_COSTS_SCHEMA_VERSION = 1

export type ExpectedCostConfidence = 'frozen_revision' | 'live_fallback'

// The jsonb blob written to jobs.expected_costs. Self-describing so the read
// path (v_job_expected_cost_facts) is a pure projection with no branching.
export type ExpectedCostsSnapshot = {
  version: number
  confidence: ExpectedCostConfidence
  // Explicit provenance the read path surfaces verbatim as `source_ref`:
  //   frozen_revision -> the scope_revisions.id
  //   live_fallback   -> the jobs.id that carries this snapshot
  source_ref: string
  scope_revision_id: string | null
  // Hash of the frozen pricing_canonical_text used (frozen_revision only).
  pricing_hash: string | null
  // Provenance timestamps. accepted_at is the job's transition time; frozen_at
  // is when this baseline was pinned (mirrored into the expected_frozen_at col).
  accepted_at: string | null
  frozen_at: string
  // Only lanes that were present as finite numbers appear here. An absent lane
  // is suppressed downstream (no fabricated $0).
  lanes: Partial<Record<ExpectedLane, { amount_ex_gst: number }>>
  totals: {
    total_cost_ex_gst: number | null
    margin_pct: number | null
  }
}

export type FreezeExpectedCostsInput = {
  job_id: string
  // Overridable clock for tests + so callers can pin frozen_at to the exact
  // accept moment. Defaults to now().
  now_iso?: string
}

export type FreezeExpectedCostsResult =
  // A snapshot was written this call.
  | {
      ok: true
      snapshot: true
      confidence: ExpectedCostConfidence
      source_ref: string
      scope_revision_id: string | null
      expected_frozen_at: string
      lanes_written: ExpectedLane[]
    }
  // No snapshot written; structured reason. Never an error for the caller —
  // suppression is a valid, expected outcome (null-pricing rule) and so is a
  // write-once skip.
  | {
      ok: true
      snapshot: false
      reason:
        | 'already_frozen' // baseline already present — write-once, left intact
        | 'no_pricing_source' // no frozen revision and no usable pricing_json
        | 'no_cost_lanes' // a pricing object exists but carries no cost lanes
        | 'zero_filled_pricing' // lanes present but all 0 — fabricated placeholder, not a baseline
        | 'frozen_hash_mismatch_no_live' // frozen row failed verification, no live fallback
      existing_confidence?: ExpectedCostConfidence
    }
  | { ok: false; error: { code: 'job_not_found' | 'db_error'; message?: string } }

// ── internal helpers ─────────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// pricing may arrive as a jsonb object (normal) or a JSON string (legacy rows).
function coercePricing(v: unknown): Record<string, unknown> | null {
  if (isPlainObject(v)) return v
  if (typeof v === 'string' && v.trim().length > 0) {
    try {
      const parsed = JSON.parse(v)
      return isPlainObject(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

function finiteNumberOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function extractLanes(
  pricing: Record<string, unknown>,
): Partial<Record<ExpectedLane, { amount_ex_gst: number }>> {
  const out: Partial<Record<ExpectedLane, { amount_ex_gst: number }>> = {}
  for (const lane of EXPECTED_LANES) {
    const amt = finiteNumberOrNull(pricing[LANE_COST_KEY[lane]])
    if (amt !== null) out[lane] = { amount_ex_gst: amt }
  }
  return out
}

type JobRow = {
  id: string
  pricing_json: unknown
  accepted_at: string | null
  expected_costs: unknown
}

async function fetchJob(
  client: any,
  job_id: string,
): Promise<{ ok: true; row: JobRow } | { ok: false; error: { code: 'job_not_found' | 'db_error'; message?: string } }> {
  try {
    const { data, error } = await client.from('jobs')
      .select('id, pricing_json, accepted_at, expected_costs')
      .eq('id', job_id)
      .maybeSingle()
    if (error) return { ok: false, error: { code: 'db_error', message: String(error?.message ?? error) } }
    if (!data) return { ok: false, error: { code: 'job_not_found' } }
    return { ok: true, row: data as JobRow }
  } catch (e) {
    return { ok: false, error: { code: 'db_error', message: String((e as Error)?.message ?? e) } }
  }
}

type FrozenRevisionRow = {
  id: string
  pricing_canonical_text: string
  pricing_hash: string
  frozen_at?: string | null
}

// The frozen scope_revisions row that was the job's CURRENT frozen scope AT
// ACCEPTANCE: the latest revision frozen at/before accepted_at.
//
// This is a TIME resolver, not a revision-number one (adversarial CP2 blocker,
// Codex 2026-07-05). A revision frozen AFTER acceptance is a post-accept edit
// and must never become the baseline source. Ordering by revision_number DESC
// would pick it; we must not. The "at most one frozen row per job" invariant is
// only APPLICATION-level — healFrozenInvariant is best-effort and the migration
// index idx_scope_revisions_current_frozen is NON-unique — so we cannot lean on
// "the single frozen row is the right one".
//
// We also consider 'superseded' rows, not just 'frozen': if a post-accept freeze
// superseded the revision that was current at acceptance, that accepted revision
// is now 'superseded' but is still the correct source. Selecting by frozen_at
// (not status) recovers it. Frozen/superseded rows are immutable, so a
// superseded row's pricing_canonical_text is just as safe to trust.
async function fetchFrozenRevisionAsOfAcceptance(
  client: any,
  job_id: string,
  accepted_at: string | null,
): Promise<{ ok: true; row: FrozenRevisionRow | null } | { ok: false; error: { code: 'db_error'; message: string } }> {
  // No acceptance timestamp -> no time anchor -> we cannot certify any revision
  // as pre-acceptance. Fall back to the live pricing path (CP1).
  if (!accepted_at) return { ok: true, row: null }
  try {
    const { data, error } = await client.from('scope_revisions')
      .select('id, pricing_canonical_text, pricing_hash, frozen_at')
      .eq('job_id', job_id)
      .in('status', ['frozen', 'superseded'])
      .lte('frozen_at', accepted_at) // excludes NULL frozen_at (NULL <= x is not true)
      .order('frozen_at', { ascending: false })
      .limit(1)
    if (error) return { ok: false, error: { code: 'db_error', message: String(error?.message ?? error) } }
    const arr = (data as FrozenRevisionRow[] | null) ?? []
    return { ok: true, row: arr[0] ?? null }
  } catch (e) {
    return { ok: false, error: { code: 'db_error', message: String((e as Error)?.message ?? e) } }
  }
}

// ── freezeExpectedCostsOnAcceptance ──────────────────────────────────────────
// Idempotent, write-once. Call at every acceptance transition (status ->
// 'accepted'). Safe to call more than once and from more than one site: an
// already-frozen job is left untouched.
export async function freezeExpectedCostsOnAcceptance(
  client: any,
  input: FreezeExpectedCostsInput,
): Promise<FreezeExpectedCostsResult> {
  const now_iso = input.now_iso ?? new Date().toISOString()

  const jobRes = await fetchJob(client, input.job_id)
  if (!jobRes.ok) return jobRes
  const job = jobRes.row

  // Write-once guard #1 (application-level): baseline already present.
  if (job.expected_costs != null) {
    const existing = isPlainObject(job.expected_costs) ? job.expected_costs : null
    const existing_confidence = existing?.confidence
    return {
      ok: true,
      snapshot: false,
      reason: 'already_frozen',
      ...(existing_confidence === 'frozen_revision' || existing_confidence === 'live_fallback'
        ? { existing_confidence }
        : {}),
    }
  }

  // Resolve the SOURCE per the CP1 order: frozen revision AS OF ACCEPTANCE first
  // (hash-verified), else live pricing_json, else suppress.
  const frozenRes = await fetchFrozenRevisionAsOfAcceptance(client, input.job_id, job.accepted_at)
  if (!frozenRes.ok) return { ok: false, error: frozenRes.error }

  let confidence: ExpectedCostConfidence | null = null
  let sourcePricing: Record<string, unknown> | null = null
  let scope_revision_id: string | null = null
  let pricing_hash: string | null = null
  let source_ref: string | null = null
  let frozenHashMismatch = false

  if (frozenRes.row) {
    const frozen = frozenRes.row
    // pricing_canonical_text IS the frozen bytes; JSON.parse then re-hash to
    // prove tamper-evidence before trusting it. On mismatch we DO NOT trust the
    // frozen row (corruption) and fall through to the live fallback.
    let parsed: Record<string, unknown> | null = null
    try {
      const p = JSON.parse(frozen.pricing_canonical_text)
      parsed = isPlainObject(p) ? p : null
    } catch {
      parsed = null
    }
    if (parsed) {
      const recomputed = await jsonHash(parsed)
      if (recomputed === frozen.pricing_hash) {
        confidence = 'frozen_revision'
        sourcePricing = parsed
        scope_revision_id = frozen.id
        pricing_hash = frozen.pricing_hash
        source_ref = frozen.id
      } else {
        frozenHashMismatch = true
      }
    } else {
      frozenHashMismatch = true
    }
  }

  if (confidence === null) {
    const live = coercePricing(job.pricing_json)
    if (live) {
      confidence = 'live_fallback'
      sourcePricing = live
      scope_revision_id = null
      pricing_hash = null
      source_ref = job.id
    }
  }

  // NULL-PRICING RULE: no frozen revision and no usable pricing -> no snapshot.
  if (confidence === null || sourcePricing === null || source_ref === null) {
    return {
      ok: true,
      snapshot: false,
      reason: frozenHashMismatch ? 'frozen_hash_mismatch_no_live' : 'no_pricing_source',
    }
  }

  const lanes = extractLanes(sourcePricing)
  const lanes_written = EXPECTED_LANES.filter((l) => lanes[l] !== undefined)
  // A pricing object with none of the three cost lanes is not a baseline —
  // suppress rather than fabricate an all-zero snapshot.
  if (lanes_written.length === 0) {
    return { ok: true, snapshot: false, reason: 'no_cost_lanes' }
  }
  // Adversarial CP2 finding (Codex 2026-07-05): a 0/0/0 pricing blob (all lane
  // keys present but every cost zero) is a fabricated placeholder, not a real
  // baseline — writing it would emit $0 expected facts. Only pin a snapshot when
  // at least one lane carries a positive cost. (A real quote with one positive
  // lane and an incidental $0 in another lane is a genuine baseline and still
  // written — that $0 is real pricing, not a fabricated placeholder.)
  const hasPositiveLane = lanes_written.some((l) => (lanes[l] as { amount_ex_gst: number }).amount_ex_gst > 0)
  if (!hasPositiveLane) {
    return { ok: true, snapshot: false, reason: 'zero_filled_pricing' }
  }

  const snapshot: ExpectedCostsSnapshot = {
    version: EXPECTED_COSTS_SCHEMA_VERSION,
    confidence,
    source_ref,
    scope_revision_id,
    pricing_hash,
    accepted_at: job.accepted_at ?? null,
    frozen_at: now_iso,
    lanes,
    totals: {
      total_cost_ex_gst: finiteNumberOrNull(sourcePricing[TOTAL_COST_KEY]),
      margin_pct: finiteNumberOrNull(sourcePricing[MARGIN_PCT_KEY]),
    },
  }

  // Write-once guard #2 (race-safe): only write when still null. The DB trigger
  // trg_jobs_expected_costs_write_once is the ultimate backstop.
  try {
    const { data, error } = await client.from('jobs')
      .update({ expected_costs: snapshot, expected_frozen_at: now_iso })
      .eq('id', input.job_id)
      .is('expected_costs', null)
      .select('id')
    if (error) return { ok: false, error: { code: 'db_error', message: String(error?.message ?? error) } }
    const wrote = ((data as unknown[] | null) ?? []).length
    if (wrote === 0) {
      // A concurrent acceptance beat us to it — treat as already frozen.
      return { ok: true, snapshot: false, reason: 'already_frozen' }
    }
  } catch (e) {
    return { ok: false, error: { code: 'db_error', message: String((e as Error)?.message ?? e) } }
  }

  return {
    ok: true,
    snapshot: true,
    confidence,
    source_ref,
    scope_revision_id,
    expected_frozen_at: now_iso,
    lanes_written,
  }
}
