// Cap 0 Job Release Packet V1 — minimal manifest builder.
//
// CAP0-QUOTE-REVISION-MINIMAL builds a MinimalReleaseManifest from data already
// available at send-time (jobs + job_documents + pricing_json). The full
// PacketManifest with QA hard-blocker validation is deferred to
// CAP0-QUOTE-REVISION-HARD-BLOCKERS once the scoping tools capture the
// additional fields.
//
// The minimal manifest is the canonical bytes that get hashed (manifest_hash)
// and uploaded to Storage (manifest_url). It is the immutable snapshot of what
// was sent, suitable for the release-packet read API to merge with the
// downstream PO/WO/event chain in later slices.
//
// IMPORTANT: ban binary/base64 fields. The manifest must be a small, plaintext
// JSON document. PDFs live at pdf_url; media live at media_ids (in the full
// PacketManifest). Embedding base64-encoded media here would break:
//   - hash determinism (binary output is sensitive to encoding wobble)
//   - storage costs (manifest is read frequently by the read API)
//   - human auditability

import type { MinimalReleaseManifest, CouncilStatus } from './manifest_types.ts'

export type BuildMinimalManifestInput = {
  job_id: string
  // Nullable: Quick Quote releases (`ops-api/send_quick_quote_email`) don't have
  // a corresponding job_documents row. Send-quote /send + /send-runs always do.
  job_document_id: string | null
  version: number
  recipient_email: string
  recipient_label: string | null
  build_kind: 'patio' | 'fence' | 'misc'
  council_status?: CouncilStatus
  neighbours_required?: boolean | null
  scope: {
    client_name: string | null
    site_address: string | null
    site_suburb: string | null
    job_type: string | null
    job_number: string | null
    runs?: Array<{
      run_label: string
      run_name: string | null
      neighbour_id: string | null
      items_count: number
    }>
  }
  pricing_json: unknown // jobs.pricing_json verbatim
  pdf_url: string
  margin_pct?: number | null
  margin_floor_breached?: boolean
  override_reason?: string | null
  released_via: 'send-quote/send' | 'send-quote/send-runs' | 'ops-api/send_quick_quote_email'
}

export function buildMinimalReleaseManifest(
  input: BuildMinimalManifestInput,
): MinimalReleaseManifest {
  const pj = (input.pricing_json ?? {}) as Record<string, unknown>
  const totalIncGst = numberOrNull(
    pj.totalIncGST ?? (pj as any).total ?? (pj as any).grandTotal,
  )
  const totalExGst = numberOrNull(
    pj.totalExGST ?? (pj as any).subtotal,
  )
  const gst = numberOrNull(pj.gst)

  const manifest: MinimalReleaseManifest = {
    schema_version: '1.0-minimal',
    captured_at: new Date().toISOString(),
    job_id: input.job_id,
    job_document_id: input.job_document_id,
    version: input.version,
    recipient_email: input.recipient_email,
    recipient_label: input.recipient_label ?? null,
    sent_at: null, // staged
    build_kind: input.build_kind,
    council_status: input.council_status ?? 'unknown',
    neighbours_required: input.neighbours_required ?? null,
    scope_snapshot: {
      client_name: input.scope.client_name,
      site_address: input.scope.site_address,
      site_suburb: input.scope.site_suburb,
      job_type: input.scope.job_type,
      job_number: input.scope.job_number,
      ...(input.scope.runs ? { runs: input.scope.runs } : {}),
    },
    pricing_snapshot: {
      raw: input.pricing_json ?? null,
    },
    totals_snapshot: {
      total_ex_gst: totalExGst,
      gst: gst,
      total_inc_gst: totalIncGst,
    },
    pdf_url: input.pdf_url,
    margin_pct: input.margin_pct ?? null,
    margin_floor_breached: Boolean(input.margin_floor_breached),
    override_reason: input.override_reason ?? null,
    released_via: input.released_via,
  }

  // Belt-and-braces: refuse to build a manifest with any base64 data: URI
  // hidden inside string fields. Catches accidental future drift like a UI
  // dropping a photo into customer_facing_summary or a PDF blob into pdf_url.
  assertNoBase64DataUri(manifest)

  return manifest
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

// Refuses any string field that looks like a `data:...;base64,` URI. Recursive.
// Throws if found; calling code should fail-closed (do NOT swallow).
export function assertNoBase64DataUri(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    if (/^data:[^;]+;base64,/i.test(value)) {
      throw new Error(
        `release packet manifest contains a base64 data URI at ${path}; ` +
          `binary content must be uploaded to Storage and referenced by URL only`,
      )
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoBase64DataUri(item, `${path}[${i}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertNoBase64DataUri(v, `${path}.${k}`)
    }
  }
}
