// Cap 0 Full Release Packet V2 — pure builder.
//
// Takes envelope inputs + adapter output, runs the validator, and returns:
//   - the assembled QuoteReleasePacketV2
//   - manifest_canonical_text + manifest_hash (client-facing, sealed)
//   - the InternalCostSnapshot
//   - internal_cost_canonical_text + internal_cost_hash (private, sealed)
//
// NO side effects. No DB writes. No storage uploads. No Resend. The caller
// (send-quote / ops-api in Loop 3) is responsible for INSERTing the row,
// uploading both canonical texts to the private release-manifests bucket,
// and emitting canonical events. This function is pure — same inputs always
// produce the same outputs (modulo the timestamps the caller passes in).

import { canonicalJsonAndHash } from './canonicalize.ts'
import { assertNoBase64DataUri } from './build_minimal_manifest.ts'
import type {
  QuoteReleasePacketV2,
  ScopeBlock,
  Customer,
  Contact,
  Site,
  Documents,
  MediaItem,
  QaOverride,
  Send,
  Terms,
  Provenance,
  ReleasedVia,
} from './manifest_v2_types.ts'
import type { InternalCostSnapshot } from './internal_cost_types.ts'
import type { AdapterOutput } from './adapter_interface.ts'
import { validatePacketV2 } from './validate_packet_v2.ts'

export type BuildFullReleasePacketInput = {
  // Identity (caller provides — typically allocated upstream so the same UUID
  // flows into the row and the canonical bytes).
  release_id: string
  job_id: string
  version: number
  released_via: ReleasedVia
  released_at: string
  released_by_user_id: string | null

  // Adapter output (custom capture).
  adapter_output: AdapterOutput

  // Envelope-level inputs (caller fetches from DB / scope tool).
  customer: Customer
  contacts: Contact[]
  site: Site
  documents: Documents
  media: MediaItem[]
  send: Send
  terms: Terms
  provenance: Provenance

  // Optional structural fields.
  option_label: string | null
  superseded_by_revision_id: string | null

  // Hard-blocker overrides issued by Marnin/Shaun (per §9 default). When
  // empty, no overrides are in play. The validator checks each entry against
  // an allowlist of operator UUIDs supplied by the caller.
  overrides: QaOverride[]
  override_operator_allowlist: string[]
}

export type BuildResultOk = {
  ok: true
  manifest: QuoteReleasePacketV2
  manifest_canonical_text: string
  manifest_hash: string
  internal_cost_snapshot: InternalCostSnapshot
  internal_cost_canonical_text: string
  internal_cost_hash: string
  hard_blockers_passed: string[]
  soft_warnings: string[]
}

export type BuildResultFail = {
  ok: false
  errors: Array<{ rule: string; message: string }>
  warnings: Array<{ rule: string; message: string }>
}

export type BuildResult = BuildResultOk | BuildResultFail

const SUPPORTED_KINDS: ReadonlyArray<ScopeBlock['kind']> = [
  'patio',
  'fence',
  'quick_quote',
  'decking',
  'gate',
  'repair',
]

export async function buildFullReleasePacket(
  input: BuildFullReleasePacketInput,
): Promise<BuildResult> {
  // 1. Reject unknown scope.kind early.
  const kind = input.adapter_output.scope.kind
  if (!SUPPORTED_KINDS.includes(kind)) {
    return {
      ok: false,
      errors: [{
        rule: 'scope.kind_supported',
        message: `unknown scope.kind=${kind}; supported: ${SUPPORTED_KINDS.join(', ')}`,
      }],
      warnings: [],
    }
  }

  // 2. Build the InternalCostSnapshot. Adapter has already shaped it.
  const internal_cost: InternalCostSnapshot = {
    schema_version: '2.0',
    release_id: input.release_id,
    job_id: input.job_id,
    version: input.version,
    captured_at: input.released_at,
    line_costs: input.adapter_output.internal_cost.line_costs,
    cost_estimates: input.adapter_output.internal_cost.cost_estimates,
    margin: input.adapter_output.internal_cost.margin,
    commission: input.adapter_output.internal_cost.commission,
  }

  // 3. Build the preliminary manifest (no qa.hard_blockers_passed /
  //    soft_warnings yet — those come from the validator).
  const preliminaryManifest: QuoteReleasePacketV2 = {
    schema_version: '2.0',
    release_id: input.release_id,
    job_id: input.job_id,
    version: input.version,
    released_via: input.released_via,
    released_at: input.released_at,
    released_by_user_id: input.released_by_user_id,

    customer: input.customer,
    contacts: input.contacts,
    site: input.site,

    scope: input.adapter_output.scope,

    pricing_public: input.adapter_output.pricing_public,

    documents: input.documents,

    media: input.media,

    qa: {
      // Filled in below post-validation.
      hard_blockers_passed: [],
      soft_warnings: [],
      council_status: input.adapter_output.qa_facts.council_status,
      customer_facing_summary: input.adapter_output.qa_facts.customer_facing_summary,
      overrides: input.overrides,
      qa_passed_by: input.adapter_output.qa_facts.qa_passed_by,
    },

    send: input.send,
    terms: input.terms,
    provenance: input.provenance,

    option_label: input.option_label,
    superseded_by_revision_id: input.superseded_by_revision_id,
  }

  // 4. Run the validator. It looks at the manifest + internal_cost together
  //    and returns hard-blocker results. Adapter-specific rules dispatch on
  //    scope.kind inside the validator.
  const validation = validatePacketV2(preliminaryManifest, internal_cost, {
    mode: 'enforce',
    override_operator_allowlist: input.override_operator_allowlist,
  })

  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      warnings: validation.warnings,
    }
  }

  // 5. Attach hard_blockers_passed + soft_warnings to qa block. These go
  //    into the canonical bytes so audits can verify which gates were live.
  const manifest: QuoteReleasePacketV2 = {
    ...preliminaryManifest,
    qa: {
      ...preliminaryManifest.qa,
      hard_blockers_passed: validation.hard_blockers_passed,
      soft_warnings: validation.warnings.map((w) => w.rule),
    },
  }

  // 6. Belt-and-braces: refuse base64 data URIs anywhere in the manifest or
  //    the internal cost snapshot. Carries over the V1 invariant: binary
  //    content lives in storage referenced by hash, not embedded.
  assertNoBase64DataUri(manifest)
  assertNoBase64DataUri(internal_cost)

  // 7. Hash the manifest (client-facing). Internal cost is excluded by
  //    construction — it lives in a separate object.
  const manifestHashOut = await canonicalJsonAndHash(manifest)

  // 8. Hash the internal cost snapshot independently. Same canonical-JSON
  //    discipline. Privacy invariant: internal_cost never appears inside the
  //    manifest's canonical text.
  const internalCostHashOut = await canonicalJsonAndHash(internal_cost)

  return {
    ok: true,
    manifest,
    manifest_canonical_text: manifestHashOut.canonical,
    manifest_hash: manifestHashOut.hash,
    internal_cost_snapshot: internal_cost,
    internal_cost_canonical_text: internalCostHashOut.canonical,
    internal_cost_hash: internalCostHashOut.hash,
    hard_blockers_passed: validation.hard_blockers_passed,
    soft_warnings: validation.warnings.map((w) => w.rule),
  }
}
