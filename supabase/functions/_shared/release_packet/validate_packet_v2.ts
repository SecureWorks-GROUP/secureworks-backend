// Cap 0 Full Release Packet V2 — validator.
//
// Two-layer enforcement (per plan rev 2 §7.4):
//   1. Scoping-tool side (browser): runs inline as the scoper builds. Hard-
//      blockers prevent the "Send" button from firing. Loop 2 work.
//   2. Server side (send-quote / ops-api): runs again at the send endpoint.
//      This is the load-bearing check — never trust the client. Loop 3 work.
//
// This file implements the validator core. Both layers import it. The
// builder calls it with mode='enforce'; the dry-run/UI integration calls it
// with mode='warn'. In 'warn' mode every hard-blocker becomes a warning so
// the scope tool can render gentle yellow indicators without refusing.
//
// Dispatch on scope.kind for adapter-specific rules. Envelope rules are
// common across kinds.

import type {
  QuoteReleasePacketV2,
  ScopeBlock,
  PatioScopeBlock,
  FenceScopeBlock,
  QuickQuoteScopeBlock,
} from './manifest_v2_types.ts'
import type { InternalCostSnapshot } from './internal_cost_types.ts'

export type ValidationError = { rule: string; message: string }
export type ValidationWarning = { rule: string; message: string }

export type ValidatePacketV2Result = {
  ok: boolean
  errors: ValidationError[]
  warnings: ValidationWarning[]
  hard_blockers_passed: string[]
}

export type ValidatePacketV2Options = {
  // 'enforce' = hard-blockers fail the validation; 'warn' = everything is
  // surfaced as a warning, validation passes regardless.
  mode: 'enforce' | 'warn'
  // Override-operator allowlist. Each qa.overrides[].operator_user_id must
  // appear in this list, otherwise the override is rejected. Per §9 default
  // populated with Marnin/Shaun UUIDs at runtime by the caller.
  override_operator_allowlist: string[]
}

// ── Rule registry ───────────────────────────────────────────────────────────
//
// Each rule has a stable id (used in error messages, logs, and the
// `hard_blockers_passed` list sealed in the manifest). Rule severity is
// either 'hard' (block) or 'soft' (warn).

type RuleSeverity = 'hard' | 'soft'

type Rule = {
  id: string
  severity: RuleSeverity
  // Returns null if pass; returns a message string if fail.
  check: (
    packet: QuoteReleasePacketV2,
    internal_cost: InternalCostSnapshot,
    opts: ValidatePacketV2Options,
  ) => string | null
}

// ── Envelope rules (apply to every scope.kind) ──────────────────────────────

const envelopeRules: Rule[] = [
  {
    id: 'envelope.schema_version',
    severity: 'hard',
    check: (p) =>
      p.schema_version === '2.0' ? null : `schema_version must be '2.0', got '${p.schema_version}'`,
  },
  {
    id: 'envelope.release_id_set',
    severity: 'hard',
    check: (p) => (p.release_id && p.release_id.length > 0 ? null : 'release_id required'),
  },
  {
    id: 'envelope.job_id_set',
    severity: 'hard',
    check: (p) => (p.job_id && p.job_id.length > 0 ? null : 'job_id required'),
  },
  {
    id: 'envelope.version_positive',
    severity: 'hard',
    check: (p) => (p.version > 0 ? null : 'version must be > 0'),
  },
  {
    id: 'customer.email_set',
    severity: 'hard',
    check: (p) => (p.customer.email && p.customer.email.length > 0 ? null : 'customer.email required'),
  },
  {
    id: 'customer.mobile_set',
    severity: 'hard',
    check: (p) =>
      p.customer.mobile && p.customer.mobile.length > 0
        ? null
        : 'customer.mobile required (capture during scoping)',
  },
  {
    id: 'qa.customer_facing_summary_min_length',
    severity: 'hard',
    check: (p) => {
      const s = p.qa.customer_facing_summary ?? ''
      return s.length >= 40 ? null : `qa.customer_facing_summary must be ≥40 chars (got ${s.length})`
    },
  },
  {
    id: 'qa.council_status_known',
    severity: 'hard',
    check: (p) =>
      p.qa.council_status === 'unknown'
        ? `qa.council_status='unknown' — capture during scoping or apply override`
        : null,
  },
  {
    id: 'media.has_site_photo',
    severity: 'soft',
    check: (p) => {
      const hasSitePhoto = p.media.some((m) => m.type === 'site_photo')
      return hasSitePhoto ? null : 'no site_photo in media[] — soft warn'
    },
  },
  {
    id: 'pricing.reconciles',
    severity: 'hard',
    check: (p) => {
      const sumLines = p.pricing_public.line_items.reduce(
        (acc, li) => acc + (Number(li.line_total_ex) || 0),
        0,
      )
      const sub = Number(p.pricing_public.totals.subtotal_ex_gst) || 0
      // Tolerance: 1 cent (rounding).
      if (Math.abs(sumLines - sub) > 0.01) {
        return `pricing reconciliation: sum(line_total_ex)=${sumLines.toFixed(2)} ≠ subtotal_ex_gst=${sub.toFixed(2)}`
      }
      return null
    },
  },
  {
    id: 'pricing.totals_consistency',
    severity: 'hard',
    check: (p) => {
      const sub = Number(p.pricing_public.totals.subtotal_ex_gst) || 0
      const gst = Number(p.pricing_public.totals.gst) || 0
      const totalEx = Number(p.pricing_public.totals.total_ex_gst) || 0
      const totalInc = Number(p.pricing_public.totals.total_inc_gst) || 0
      if (Math.abs(sub - totalEx) > 0.01) {
        return `subtotal_ex_gst (${sub}) must equal total_ex_gst (${totalEx})`
      }
      if (Math.abs(totalEx + gst - totalInc) > 0.01) {
        return `total_ex_gst + gst (${(totalEx + gst).toFixed(2)}) must equal total_inc_gst (${totalInc.toFixed(2)})`
      }
      return null
    },
  },
  {
    id: 'pricing.material_lines_have_supplier',
    severity: 'hard',
    check: (p, ic) => {
      // Cross-checks pricing_public.line_items[category=material] against
      // internal_cost.line_costs[].supplier_name. The internal snapshot is the
      // source of truth for supplier names.
      const materialLines = p.pricing_public.line_items.filter((li) => li.category === 'material')
      const internalByLineId = new Map(ic.line_costs.map((lc) => [lc.line_id, lc]))
      for (const ml of materialLines) {
        const ic_row = internalByLineId.get(ml.line_id)
        if (!ic_row || !ic_row.supplier_name || ic_row.supplier_name.trim() === '') {
          return `material line_id=${ml.line_id} (${ml.description}) has no supplier_name in internal_cost`
        }
      }
      return null
    },
  },
  {
    id: 'internal_cost.margin_override_required_when_breached',
    severity: 'hard',
    check: (_p, ic) => {
      if (ic.margin.floor_breached) {
        const reason = (ic.margin.override_reason ?? '').trim()
        const approver = ic.margin.override_approver_user_id
        if (!reason) {
          return 'margin floor breached — internal_cost.margin.override_reason required'
        }
        if (!approver) {
          return 'margin floor breached — internal_cost.margin.override_approver_user_id required'
        }
      }
      return null
    },
  },
  {
    id: 'qa.overrides_operator_allowed',
    severity: 'hard',
    check: (p, _ic, opts) => {
      // Each override entry must have an operator_user_id in the allowlist.
      // If the allowlist is empty, no overrides are allowed.
      for (const ov of p.qa.overrides) {
        if (!opts.override_operator_allowlist.includes(ov.operator_user_id)) {
          return `qa.overrides[].operator_user_id=${ov.operator_user_id} not in override allowlist`
        }
        if (!ov.reason || ov.reason.trim() === '') {
          return `qa.overrides[rule=${ov.rule_name}] missing reason`
        }
        if (!ov.category || ov.category.trim() === '') {
          return `qa.overrides[rule=${ov.rule_name}] missing category`
        }
        if (!ov.timestamp || ov.timestamp.trim() === '') {
          return `qa.overrides[rule=${ov.rule_name}] missing timestamp`
        }
      }
      return null
    },
  },
  {
    id: 'send.recipients_present',
    severity: 'hard',
    check: (p) =>
      p.send.recipients.length > 0 ? null : 'send.recipients[] cannot be empty',
  },
  {
    id: 'documents.quote_pdf_hashed',
    severity: 'hard',
    check: (p) => {
      const sha = p.documents.quote_pdf?.sha256 ?? ''
      return /^[0-9a-f]{64}$/.test(sha)
        ? null
        : `documents.quote_pdf.sha256 must be 64-char SHA-256 hex (got '${sha}')`
    },
  },
  {
    id: 'media.sha256_format',
    severity: 'hard',
    check: (p) => {
      for (const m of p.media) {
        if (!/^[0-9a-f]{64}$/.test(m.sha256)) {
          return `media[id=${m.id}].sha256 must be 64-char SHA-256 hex (got '${m.sha256}')`
        }
      }
      return null
    },
  },
]

// ── Adapter-specific rules ──────────────────────────────────────────────────

const patioRules: Rule[] = [
  {
    id: 'patio.structure_type_set',
    severity: 'hard',
    check: (p) => {
      const s = (p.scope as PatioScopeBlock).structure_type
      return s && s.length > 0 ? null : 'patio.structure_type required'
    },
  },
  {
    id: 'patio.dimensions_positive',
    severity: 'hard',
    check: (p) => {
      const d = (p.scope as PatioScopeBlock).dimensions
      if (!d || !(d.width_m > 0) || !(d.depth_m > 0)) {
        return 'patio.dimensions.width_m and depth_m must be > 0'
      }
      return null
    },
  },
  {
    id: 'patio.demo_pre_install_photo',
    severity: 'soft',
    check: (p) => {
      const demo = (p.scope as PatioScopeBlock).demo_yes_no
      if (!demo) return null
      const hasPreInstall = p.media.some((m) => m.phase === 'pre_install')
      return hasPreInstall ? null : 'patio.demo_yes_no=true but no pre_install media — soft warn'
    },
  },
]

const fenceRules: Rule[] = [
  {
    id: 'fence.at_least_one_run',
    severity: 'hard',
    check: (p) => {
      const runs = (p.scope as FenceScopeBlock).runs
      return runs && runs.length > 0 ? null : 'fence.runs[] must have ≥1 run'
    },
  },
  {
    id: 'fence.run_lineal_m_positive',
    severity: 'hard',
    check: (p) => {
      const runs = (p.scope as FenceScopeBlock).runs
      for (const r of runs) {
        if (!(r.lineal_m > 0)) {
          return `fence.runs[run_label=${r.run_label}].lineal_m must be > 0 (got ${r.lineal_m})`
        }
      }
      return null
    },
  },
  {
    id: 'fence.demo_pre_install_photo',
    severity: 'soft',
    check: (p) => {
      const runs = (p.scope as FenceScopeBlock).runs
      const anyDemo = runs.some((r) => r.demo)
      if (!anyDemo) return null
      const hasPreInstall = p.media.some((m) => m.phase === 'pre_install')
      return hasPreInstall ? null : 'fence has demo run(s) but no pre_install media — soft warn'
    },
  },
  {
    id: 'fence.long_run_drawing_present',
    severity: 'soft',
    check: (p) => {
      const runs = (p.scope as FenceScopeBlock).runs
      const hasLongRun = runs.some((r) => r.lineal_m > 20)
      if (!hasLongRun) return null
      const hasDrawing = p.media.some((m) => m.type === 'drawing') ||
        (p.scope as FenceScopeBlock).boundary_plan_attached
      return hasDrawing ? null : 'fence has run >20m but no drawing/boundary plan — soft warn'
    },
  },
]

const quickQuoteRules: Rule[] = [
  {
    id: 'quick_quote.label_set',
    severity: 'hard',
    check: (p) => {
      const l = (p.scope as QuickQuoteScopeBlock).label
      return l && l.length > 0 ? null : 'quick_quote.label required'
    },
  },
  {
    id: 'quick_quote.description_set',
    severity: 'hard',
    check: (p) => {
      const d = (p.scope as QuickQuoteScopeBlock).description
      return d && d.length > 0 ? null : 'quick_quote.description required'
    },
  },
]

function adapterRulesFor(kind: ScopeBlock['kind']): Rule[] {
  switch (kind) {
    case 'patio':
      return patioRules
    case 'fence':
      return fenceRules
    case 'quick_quote':
      return quickQuoteRules
    case 'decking':
    case 'gate':
    case 'repair':
      // Future adapters: no rules in P0 — they'll register their own when the
      // adapters land in P4. The validator never silently passes unknown
      // kinds; the builder rejects unknown kinds upstream. These are kinds
      // we structurally allow but haven't defined rules for yet.
      return []
    default: {
      // Exhaustiveness check — TypeScript flags any new kind added without
      // updating this switch.
      const _exhaustive: never = kind
      void _exhaustive
      return []
    }
  }
}

// ── Override resolution ─────────────────────────────────────────────────────
//
// A hard-blocker can be bypassed by an entry in `qa.overrides[]` whose
// `rule_name` matches the rule id. The override-allowlist gate (above) still
// has to pass. When a rule is overridden, it's removed from `errors` and the
// override is sealed in the manifest.

function isOverridden(packet: QuoteReleasePacketV2, ruleId: string): boolean {
  return packet.qa.overrides.some((ov) => ov.rule_name === ruleId)
}

// ── Top-level entry point ───────────────────────────────────────────────────

export function validatePacketV2(
  packet: QuoteReleasePacketV2,
  internal_cost: InternalCostSnapshot,
  opts: ValidatePacketV2Options,
): ValidatePacketV2Result {
  const allRules = [
    ...envelopeRules,
    ...adapterRulesFor(packet.scope.kind),
  ]

  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []
  const passed: string[] = []

  for (const rule of allRules) {
    let result: string | null
    try {
      result = rule.check(packet, internal_cost, opts)
    } catch (e: any) {
      // Defensive: a rule throwing should never crash the validator.
      result = `validator rule '${rule.id}' threw: ${e?.message ?? String(e)}`
    }

    if (result === null) {
      passed.push(rule.id)
      continue
    }

    // Rule failed. Apply override + mode logic.
    const overridden = isOverridden(packet, rule.id)
    if (overridden) {
      // Override is honoured; rule is treated as passed but flagged in
      // warnings so audits can see it was bypassed.
      passed.push(rule.id)
      warnings.push({
        rule: rule.id,
        message: `${result} — overridden by qa.overrides[]`,
      })
      continue
    }

    if (rule.severity === 'soft' || opts.mode === 'warn') {
      warnings.push({ rule: rule.id, message: result })
    } else {
      errors.push({ rule: rule.id, message: result })
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    hard_blockers_passed: passed,
  }
}
