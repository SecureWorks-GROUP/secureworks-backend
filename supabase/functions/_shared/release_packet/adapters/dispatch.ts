// Adapter dispatch + registry.
//
// Picks the right adapter for a `jobs.type` value and runs it. The dispatcher
// is the only thing that needs to know about the full registry — call sites
// (send-quote / ops-api) just pass `inputs` and get the adapter output back.
//
// `jobs.type` values today: 'patio', 'fencing', 'general' (Quick Quote),
// plus future kinds. Dispatch maps the live string to the V2 scope kind.

import type {
  AdapterInputs,
  AdapterOutput,
  AdapterRegistry,
  BuildScopeBlock,
} from '../adapter_interface.ts'
import { buildPatioScopeBlock, _patioPresenceReport } from './patio_adapter.ts'
import { buildFenceScopeBlock, _fencePresenceReport } from './fence_adapter.ts'
import { buildQuickQuoteScopeBlock, _quickQuotePresenceReport } from './quick_quote_adapter.ts'

export const defaultAdapterRegistry: AdapterRegistry = {
  patio: buildPatioScopeBlock,
  fence: buildFenceScopeBlock,
  quick_quote: buildQuickQuoteScopeBlock,
  // decking/gate/repair: not implemented in P1; future loops register them.
}

export type DispatchOk = { ok: true; output: AdapterOutput; matched_kind: string }
export type DispatchFail = { ok: false; reason: string; matched_kind: string | null }

/**
 * Dispatch on `jobs.type`. Returns `{ok:true, output}` when an adapter is
 * registered for the matching kind, otherwise `{ok:false, reason}`. The
 * caller decides how to handle unknown kinds (typically: refuse the send).
 */
export function dispatchAdapter(
  inputs: AdapterInputs,
  registry: AdapterRegistry = defaultAdapterRegistry,
): DispatchOk | DispatchFail {
  const kind = mapJobTypeToKind(inputs.job.type)
  if (!kind) {
    return {
      ok: false,
      reason: `unknown jobs.type='${inputs.job.type}' — no V2 adapter registered`,
      matched_kind: null,
    }
  }
  const adapter: BuildScopeBlock | undefined = (registry as Record<string, BuildScopeBlock | undefined>)[kind]
  if (!adapter) {
    return { ok: false, reason: `no adapter for kind=${kind}`, matched_kind: kind }
  }
  return { ok: true, output: adapter(inputs), matched_kind: kind }
}

/** Maps `jobs.type` to the V2 `scope.kind`. Open list — extend per service. */
export function mapJobTypeToKind(jobType: string): string | null {
  switch (jobType) {
    case 'patio':
      return 'patio'
    case 'fencing':
      return 'fence'
    case 'general':
    case 'misc':
    case 'quick_quote':
      return 'quick_quote'
    case 'decking':
      return 'decking'
    case 'gate':
      return 'gate'
    case 'repair':
    case 'make_safe':
    case 'roof_repair':
      return 'repair'
    default:
      return null
  }
}

// ── Presence-report dispatch ────────────────────────────────────────────────
//
// Mirrors `dispatchAdapter` but returns the presence report instead of the
// AdapterOutput. The dry-run tool aggregates these across many sample jobs
// to produce the Loop 2 dry-run report.

export type PresenceReport = {
  matched_kind: string | null
  captured: string[]
  missing: string[]
  partial: string[]
}

export function dispatchPresenceReport(inputs: AdapterInputs): PresenceReport {
  const kind = mapJobTypeToKind(inputs.job.type)
  if (kind === 'patio') return { matched_kind: 'patio', ..._patioPresenceReport(inputs) }
  if (kind === 'fence') return { matched_kind: 'fence', ..._fencePresenceReport(inputs) }
  if (kind === 'quick_quote') return { matched_kind: 'quick_quote', ..._quickQuotePresenceReport(inputs) }
  return {
    matched_kind: kind,
    captured: [],
    missing: ['(no presence report for unknown kind)'],
    partial: [],
  }
}
