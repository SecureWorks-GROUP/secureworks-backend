// Scope-Memory-Saving Loop 1, step 5 — server-side scope_artifacts uploader.
//
// Single safe surface used by both patio-tool and fence-designer to persist
// canonical render PNGs (or any other allowed artefact) for a frozen
// scope_revision. Validates inputs, decodes base64 bytes, recomputes sha256
// server-side as a tamper guard, uploads to the private scope-artifacts
// bucket, and INSERTs the scope_artifacts row.
//
// Hard rules enforced here AND backstopped by the migration triggers:
//   * scope_revision_id must exist and be status='frozen'.
//   * artifact_type must be in the migration enum.
//   * sha256 must be a 64-char lower-case hex string and MUST match the
//     server-recomputed sha256 of the decoded bytes (defense in depth —
//     callers compute on the client; we recompute and refuse on mismatch).
//   * size_bytes must equal the actual decoded length and be within the
//     bucket's 25 MB cap.
//   * content_type must be in the allowlist (PNG / JPEG / PDF / GLB).
//   * No artefact is persisted without a verified sha256.
//
// The helper does NOT touch scope_revisions itself — append-only artefact
// rows are independent of the freeze lifecycle and the migration's frozen
// invariant. It only refuses to attach to a non-frozen revision so callers
// don't ship renders against a still-mutable draft.

// ── Types ──────────────────────────────────────────────────────────────────

export type ArtifactType =
  | 'render_hero'
  | 'render_front'
  | 'render_side'
  | 'render_site_plan'
  | 'render_riser'
  | 'render_post_detail'
  | 'render_profile'
  | 'render_3d_scene'
  | 'quote_pdf'
  | 'per_contact_pdf'
  | 'work_order_pdf'
  | 'material_order_pdf'
  | 'model_glb'
  | 'drawing'
  // Added 2026-05-04 alongside the additive enum migration
  // 20260504000002_extend_artifact_type_enum.sql so Patio's gable-only
  // gutter and ridge details can persist with proper semantics rather than
  // being lossy-mapped onto 'drawing'. ridge is gable-only (the patio code
  // only emits ridgeDetail when the roof style is gable).
  | 'render_gutter_detail'
  | 'render_ridge_detail'

export const ARTIFACT_TYPES: ReadonlyArray<ArtifactType> = [
  'render_hero', 'render_front', 'render_side', 'render_site_plan',
  'render_riser', 'render_post_detail', 'render_profile', 'render_3d_scene',
  'quote_pdf', 'per_contact_pdf', 'work_order_pdf', 'material_order_pdf',
  'model_glb', 'drawing',
  'render_gutter_detail', 'render_ridge_detail',
]

export function isArtifactType(v: unknown): v is ArtifactType {
  return typeof v === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(v)
}

const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'application/pdf',
  'model/gltf-binary',
])

// Mirror of the bucket-level 25 MB cap from the applied migration. Enforced
// here so a 26 MB upload fails fast with a structured error before bytes
// hit the bucket and triggers a less-helpful Storage error.
const MAX_ARTIFACT_BYTES = 26214400

const SHA256_RE = /^[0-9a-f]{64}$/
const BUCKET_ID = 'scope-artifacts'

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
  'model/gltf-binary': 'glb',
}

export type RecordScopeArtifactInput = {
  scope_revision_id: string
  artifact_type: ArtifactType
  // base64 encoding of the artifact bytes. For browser callers, the typical
  // path is canvas.toDataURL('image/png') → strip 'data:image/png;base64,' →
  // pass the remaining base64 here. For server callers, base64-encode bytes
  // directly. The helper rejects empty / malformed base64.
  content_base64: string
  content_type: string
  // sha256 of the decoded bytes (lower-case 64-char hex). Required.
  sha256: string
  // Optional human label stored on the row. Useful for distinguishing
  // multiple artefacts of the same artifact_type (e.g. fence_run_id for a
  // batch of render_profile rows that share a revision).
  label?: string | null
}

export type RecordScopeArtifactError =
  | { code: 'invalid_input'; field: string; message: string }
  | { code: 'invalid_artifact_type'; provided: unknown }
  | { code: 'invalid_content_type'; provided: string }
  | { code: 'invalid_sha256_format'; provided: string }
  | { code: 'bytes_too_large'; size_bytes: number; limit: number }
  | { code: 'bytes_empty' }
  | { code: 'sha256_mismatch'; client_sha256: string; server_sha256: string }
  | { code: 'scope_revision_not_found' }
  | { code: 'scope_revision_not_frozen'; current_status: string }
  | { code: 'storage_upload_failed'; message: string }
  | { code: 'db_error'; message: string }

export type RecordScopeArtifactResult =
  | {
      ok: true
      scope_artifact_id: string
      scope_revision_id: string
      artifact_type: ArtifactType
      bucket_id: string
      storage_path: string
      sha256: string
      size_bytes: number
      content_type: string
    }
  | { ok: false; error: RecordScopeArtifactError }

// ── Internals ──────────────────────────────────────────────────────────────

function decodeBase64ToBytes(b64: string): Uint8Array {
  // atob is available in Deno + browsers; fast path. Strips any whitespace
  // the caller may have left in (some encoders wrap at 76 chars).
  const cleaned = b64.replace(/\s+/g, '')
  const bin = atob(cleaned)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  // Cast through BufferSource — TS lib in Deno 2.7 narrows ArrayBufferLike
  // unions (SharedArrayBuffer | ArrayBuffer) and crypto.subtle.digest only
  // accepts the latter. The runtime accepts both.
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ── Public entry point ─────────────────────────────────────────────────────

export async function recordScopeArtifact(
  client: any,
  input: RecordScopeArtifactInput,
): Promise<RecordScopeArtifactResult> {
  // 1. Validate scalar inputs first (cheap, no I/O).
  if (!input || typeof input !== 'object') {
    return { ok: false, error: { code: 'invalid_input', field: 'body', message: 'POST body required' } }
  }
  if (!input.scope_revision_id || typeof input.scope_revision_id !== 'string') {
    return { ok: false, error: { code: 'invalid_input', field: 'scope_revision_id', message: 'scope_revision_id required' } }
  }
  if (!isArtifactType(input.artifact_type)) {
    return { ok: false, error: { code: 'invalid_artifact_type', provided: input.artifact_type } }
  }
  if (typeof input.content_type !== 'string' || !ALLOWED_CONTENT_TYPES.has(input.content_type)) {
    return { ok: false, error: { code: 'invalid_content_type', provided: String(input.content_type) } }
  }
  if (typeof input.sha256 !== 'string' || !SHA256_RE.test(input.sha256)) {
    return { ok: false, error: { code: 'invalid_sha256_format', provided: String(input.sha256) } }
  }
  if (typeof input.content_base64 !== 'string' || input.content_base64.length === 0) {
    return { ok: false, error: { code: 'invalid_input', field: 'content_base64', message: 'content_base64 required' } }
  }

  // 2. Decode bytes + compute server-side sha256 + size_bytes.
  let bytes: Uint8Array
  try {
    bytes = decodeBase64ToBytes(input.content_base64)
  } catch (e) {
    return { ok: false, error: { code: 'invalid_input', field: 'content_base64', message: `base64 decode failed: ${(e as Error)?.message ?? e}` } }
  }
  if (bytes.length === 0) {
    return { ok: false, error: { code: 'bytes_empty' } }
  }
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    return { ok: false, error: { code: 'bytes_too_large', size_bytes: bytes.length, limit: MAX_ARTIFACT_BYTES } }
  }

  const server_sha256 = await sha256HexOf(bytes)
  if (server_sha256 !== input.sha256) {
    // Client-supplied hash didn't match the bytes we actually decoded. This
    // catches transit corruption, accidental re-encoding, and adversarial
    // mismatches. Refusing here makes the row's sha256 verifiable purely
    // from the bytes after the fact.
    return {
      ok: false,
      error: { code: 'sha256_mismatch', client_sha256: input.sha256, server_sha256 },
    }
  }

  // 3. Verify the parent revision exists and is frozen. Append-only artefact
  // rows would still INSERT against a draft, but emitting renders for a
  // mutable scope opens a footgun where the operator edits the draft after
  // upload and the render no longer matches the canonical text. Refuse.
  let revision: { id: string; status: 'draft' | 'frozen' | 'superseded' } | null = null
  try {
    const { data, error } = await client.from('scope_revisions')
      .select('id, status')
      .eq('id', input.scope_revision_id)
      .maybeSingle()
    if (error) return { ok: false, error: { code: 'db_error', message: String(error.message ?? error) } }
    revision = (data as any) ?? null
  } catch (e) {
    return { ok: false, error: { code: 'db_error', message: String((e as Error)?.message ?? e) } }
  }
  if (!revision) return { ok: false, error: { code: 'scope_revision_not_found' } }
  if (revision.status !== 'frozen') {
    return { ok: false, error: { code: 'scope_revision_not_frozen', current_status: revision.status } }
  }

  // 4. Upload to the private bucket. Path: <scope_revision_id>/<sha256>.<ext>
  // — content-addressable per revision so duplicate uploads of the same
  // bytes for the same revision land at the same key (storage upsert
  // collapses them; row insert is the canonical record).
  const ext = EXTENSION_BY_CONTENT_TYPE[input.content_type] ?? 'bin'
  const storage_path = `${input.scope_revision_id}/${input.sha256}.${ext}`
  try {
    const { error } = await client.storage
      .from(BUCKET_ID)
      .upload(storage_path, bytes, { contentType: input.content_type, upsert: true })
    if (error) {
      const dup = (error as any)?.statusCode === '409'
        || /already exists|duplicate/i.test((error as any)?.message ?? '')
      if (!dup) {
        return { ok: false, error: { code: 'storage_upload_failed', message: String(error?.message ?? error) } }
      }
      // Duplicate is fine — same bytes already present at this content-
      // addressable path. Continue to row insert.
    }
  } catch (e) {
    return { ok: false, error: { code: 'storage_upload_failed', message: String((e as Error)?.message ?? e) } }
  }

  // 5. INSERT the scope_artifacts row. The append-only trigger refuses
  // UPDATE / DELETE post-insert; the hash regex constraint refuses any
  // non-hex sha256 (paranoia layer).
  try {
    const { data, error } = await client.from('scope_artifacts')
      .insert({
        scope_revision_id: input.scope_revision_id,
        artifact_type: input.artifact_type,
        storage_path,
        bucket_id: BUCKET_ID,
        sha256: input.sha256,
        size_bytes: bytes.length,
        content_type: input.content_type,
        label: input.label ?? null,
      })
      .select('id, storage_path, bucket_id, sha256, size_bytes, content_type, artifact_type')
      .single()
    if (error || !data) {
      return { ok: false, error: { code: 'db_error', message: String(error?.message ?? 'insert returned no row') } }
    }
    return {
      ok: true,
      scope_artifact_id: data.id,
      scope_revision_id: input.scope_revision_id,
      artifact_type: data.artifact_type,
      bucket_id: data.bucket_id,
      storage_path: data.storage_path,
      sha256: data.sha256,
      size_bytes: data.size_bytes,
      content_type: data.content_type,
    }
  } catch (e) {
    return { ok: false, error: { code: 'db_error', message: String((e as Error)?.message ?? e) } }
  }
}
