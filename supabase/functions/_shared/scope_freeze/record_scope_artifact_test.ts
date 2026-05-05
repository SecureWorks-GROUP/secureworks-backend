// Scope-Memory-Saving Loop 1, step 5 — fixture tests for recordScopeArtifact.
//
// Mirrors the scope_freeze_test.ts approach: in-memory mock client that
// reproduces only the query shapes the helper actually calls plus a tiny
// storage stub, so we can prove validation, hash verification, and the
// frozen-revision gate without any network or live Supabase.

import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts'

import {
  recordScopeArtifact,
  isArtifactType,
  ARTIFACT_TYPES,
  type ArtifactType,
} from './record_scope_artifact.ts'

// ── In-memory mock ─────────────────────────────────────────────────────────

type Row = Record<string, unknown>

type DbTable = 'scope_revisions' | 'scope_artifacts'
type State = {
  scope_revisions: Row[]
  scope_artifacts: Row[]
  storage_uploads: { bucket: string; path: string; bytes: Uint8Array; contentType: string }[]
}

class MockChain {
  table: DbTable
  state: State
  filters: Array<[string, unknown]> = []
  insertPayload: Row | null = null
  selectCols: string | null = null
  method: 'select' | 'insert' | null = null

  constructor(table: DbTable, state: State) {
    this.table = table
    this.state = state
  }

  select(cols: string) { this.selectCols = cols; if (this.method == null) this.method = 'select'; return this }
  insert(payload: Row) { this.method = 'insert'; this.insertPayload = payload; return this }
  eq(col: string, v: unknown) { this.filters.push([col, v]); return this }

  async maybeSingle(): Promise<{ data: Row | null; error: any }> {
    return this._resolve('maybeSingle')
  }
  async single(): Promise<{ data: Row | null; error: any }> {
    return this._resolve('single')
  }
  private _resolve(kind: 'single' | 'maybeSingle'): { data: any; error: any } {
    if (this.method === 'insert') {
      const payload = this.insertPayload as Row
      // Mirror the migration's append-only + hash-regex constraints.
      if (this.table === 'scope_artifacts') {
        const sha = String(payload.sha256 ?? '')
        if (!/^[0-9a-f]{64}$/.test(sha)) {
          return { data: null, error: { message: 'check constraint sha256 format' } }
        }
      }
      const id = `art-${Math.random().toString(36).slice(2, 10)}`
      const row: Row = { id, created_at: new Date().toISOString(), spine_event_id: null, ...payload }
      this.state[this.table].push(row)
      return { data: row, error: null }
    }
    // select path
    const rows = this.state[this.table].filter(
      (r) => this.filters.every(([c, v]) => r[c] === v),
    )
    if (kind === 'single') {
      if (rows.length === 1) return { data: rows[0], error: null }
      return { data: null, error: { message: rows.length === 0 ? 'no rows' : 'multiple rows' } }
    }
    return { data: rows[0] ?? null, error: null }
  }
}

function makeMock(seed: Partial<State> = {}, opts: { uploadFails?: boolean; duplicate?: boolean } = {}) {
  const state: State = {
    scope_revisions: seed.scope_revisions ?? [],
    scope_artifacts: seed.scope_artifacts ?? [],
    storage_uploads: [],
  }
  const client = {
    from(table: string) { return new MockChain(table as DbTable, state) },
    storage: {
      from(bucket: string) {
        return {
          upload: async (path: string, bytes: Uint8Array, options: { contentType: string; upsert: boolean }) => {
            if (opts.uploadFails) {
              return { data: null, error: { message: 'upload denied', statusCode: '500' } }
            }
            if (opts.duplicate) {
              return { data: null, error: { message: 'The resource already exists', statusCode: '409' } }
            }
            state.storage_uploads.push({ bucket, path, bytes, contentType: options.contentType })
            return { data: { path }, error: null }
          },
        }
      },
    },
    _state: state,
  }
  return client
}

// ── Fixture helpers ────────────────────────────────────────────────────────

const SHA256_RE = /^[0-9a-f]{64}$/

async function bytesToBase64(bytes: Uint8Array): Promise<string> {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

const FROZEN_REV: Row = { id: 'rev-frozen', status: 'frozen' }
const DRAFT_REV: Row = { id: 'rev-draft', status: 'draft' }

function makeTinyPng(): Uint8Array {
  // Minimum valid 1×1 PNG (red pixel). 67 bytes, correct sha256 for the
  // bytes — we recompute via SubtleCrypto in the test, so any bytes work.
  return new Uint8Array([
    0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,
    0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x02,0x00,0x00,0x00,0x90,0x77,0x53,
    0xDE,0x00,0x00,0x00,0x0C,0x49,0x44,0x41,0x54,0x08,0x99,0x63,0xF8,0xCF,0xC0,0x00,
    0x00,0x00,0x03,0x00,0x01,0x5B,0x67,0xD3,0x82,0x00,0x00,0x00,0x00,0x49,0x45,0x4E,
    0x44,0xAE,0x42,0x60,0x82,
  ])
}

// ── Tests ──────────────────────────────────────────────────────────────────

Deno.test('isArtifactType — accepts every enum value, rejects others', () => {
  for (const t of ARTIFACT_TYPES) assert(isArtifactType(t))
  for (const v of ['', 'render_unknown', 'PNG', null, undefined, 42]) assert(!isArtifactType(v as any))
})

Deno.test('recordScopeArtifact — rejects missing scope_revision_id', async () => {
  const c = makeMock()
  const r = await recordScopeArtifact(c as any, {
    scope_revision_id: '',
    artifact_type: 'render_hero',
    content_base64: 'AA==',
    content_type: 'image/png',
    sha256: 'a'.repeat(64),
  })
  assertEquals(r.ok, false)
  if (!r.ok) {
    assertEquals(r.error.code, 'invalid_input')
    if (r.error.code === 'invalid_input') assertEquals(r.error.field, 'scope_revision_id')
  }
})

Deno.test('recordScopeArtifact — rejects unknown artifact_type', async () => {
  const c = makeMock({ scope_revisions: [FROZEN_REV] })
  const r = await recordScopeArtifact(c as any, {
    scope_revision_id: 'rev-frozen',
    artifact_type: 'render_kayak' as ArtifactType,
    content_base64: 'AA==',
    content_type: 'image/png',
    sha256: 'a'.repeat(64),
  })
  assertEquals(r.ok, false)
  if (!r.ok) assertEquals(r.error.code, 'invalid_artifact_type')
})

Deno.test('recordScopeArtifact — rejects content_type not in allowlist', async () => {
  const c = makeMock({ scope_revisions: [FROZEN_REV] })
  const r = await recordScopeArtifact(c as any, {
    scope_revision_id: 'rev-frozen',
    artifact_type: 'render_hero',
    content_base64: 'AA==',
    content_type: 'image/webp',
    sha256: 'a'.repeat(64),
  })
  assertEquals(r.ok, false)
  if (!r.ok) assertEquals(r.error.code, 'invalid_content_type')
})

Deno.test('recordScopeArtifact — rejects malformed sha256 (non-hex / wrong length)', async () => {
  const c = makeMock({ scope_revisions: [FROZEN_REV] })
  const bad = ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 'NOT-A-HASH']
  for (const sha of bad) {
    const r = await recordScopeArtifact(c as any, {
      scope_revision_id: 'rev-frozen',
      artifact_type: 'render_hero',
      content_base64: 'AA==',
      content_type: 'image/png',
      sha256: sha,
    })
    assertEquals(r.ok, false, `expected refusal for sha256 "${sha}"`)
    if (!r.ok) assertEquals(r.error.code, 'invalid_sha256_format')
  }
})

Deno.test('recordScopeArtifact — rejects empty content_base64', async () => {
  const c = makeMock({ scope_revisions: [FROZEN_REV] })
  const r = await recordScopeArtifact(c as any, {
    scope_revision_id: 'rev-frozen',
    artifact_type: 'render_hero',
    content_base64: '',
    content_type: 'image/png',
    sha256: 'a'.repeat(64),
  })
  assertEquals(r.ok, false)
  if (!r.ok) {
    assertEquals(r.error.code, 'invalid_input')
    if (r.error.code === 'invalid_input') assertEquals(r.error.field, 'content_base64')
  }
})

Deno.test('recordScopeArtifact — rejects sha256/bytes mismatch (tamper guard)', async () => {
  const bytes = makeTinyPng()
  const realSha = await sha256Hex(bytes)
  const wrongSha = 'f'.repeat(64)
  assertNotEquals(realSha, wrongSha)
  const c = makeMock({ scope_revisions: [FROZEN_REV] })
  const r = await recordScopeArtifact(c as any, {
    scope_revision_id: 'rev-frozen',
    artifact_type: 'render_hero',
    content_base64: await bytesToBase64(bytes),
    content_type: 'image/png',
    sha256: wrongSha,
  })
  assertEquals(r.ok, false)
  if (!r.ok && r.error.code === 'sha256_mismatch') {
    assertEquals(r.error.client_sha256, wrongSha)
    assertEquals(r.error.server_sha256, realSha)
  } else {
    throw new Error('expected sha256_mismatch')
  }
})

Deno.test('recordScopeArtifact — refuses bytes_too_large (> 25 MB)', async () => {
  // Skip building 25MB of bytes — instead build 26MB of base64 from a
  // pattern, so the helper rejects after the size check without us holding
  // 25MB in memory more than necessary.
  const oversize = new Uint8Array(26214401) // 25 MB + 1 byte
  oversize.fill(0x42)
  const sha = await sha256Hex(oversize)
  const c = makeMock({ scope_revisions: [FROZEN_REV] })
  const r = await recordScopeArtifact(c as any, {
    scope_revision_id: 'rev-frozen',
    artifact_type: 'render_hero',
    content_base64: await bytesToBase64(oversize),
    content_type: 'image/png',
    sha256: sha,
  })
  assertEquals(r.ok, false)
  if (!r.ok && r.error.code === 'bytes_too_large') {
    assertEquals(r.error.size_bytes, 26214401)
    assertEquals(r.error.limit, 26214400)
  } else {
    throw new Error('expected bytes_too_large')
  }
})

Deno.test('recordScopeArtifact — rejects when scope_revision is not found', async () => {
  const bytes = makeTinyPng()
  const sha = await sha256Hex(bytes)
  const c = makeMock() // no scope_revisions
  const r = await recordScopeArtifact(c as any, {
    scope_revision_id: 'rev-missing',
    artifact_type: 'render_hero',
    content_base64: await bytesToBase64(bytes),
    content_type: 'image/png',
    sha256: sha,
  })
  assertEquals(r.ok, false)
  if (!r.ok) assertEquals(r.error.code, 'scope_revision_not_found')
})

Deno.test('recordScopeArtifact — rejects when scope_revision is still draft', async () => {
  const bytes = makeTinyPng()
  const sha = await sha256Hex(bytes)
  const c = makeMock({ scope_revisions: [DRAFT_REV] })
  const r = await recordScopeArtifact(c as any, {
    scope_revision_id: 'rev-draft',
    artifact_type: 'render_hero',
    content_base64: await bytesToBase64(bytes),
    content_type: 'image/png',
    sha256: sha,
  })
  assertEquals(r.ok, false)
  if (!r.ok && r.error.code === 'scope_revision_not_frozen') {
    assertEquals(r.error.current_status, 'draft')
  } else {
    throw new Error('expected scope_revision_not_frozen')
  }
})

Deno.test('recordScopeArtifact — happy path: uploads bytes, inserts row, content-addressable storage path', async () => {
  const bytes = makeTinyPng()
  const sha = await sha256Hex(bytes)
  assert(SHA256_RE.test(sha))
  const c = makeMock({ scope_revisions: [FROZEN_REV] })
  const r = await recordScopeArtifact(c as any, {
    scope_revision_id: 'rev-frozen',
    artifact_type: 'render_hero',
    content_base64: await bytesToBase64(bytes),
    content_type: 'image/png',
    sha256: sha,
    label: 'Hero render — patio test fixture',
  })
  assert(r.ok); if (!r.ok) return
  assertEquals(r.scope_revision_id, 'rev-frozen')
  assertEquals(r.artifact_type, 'render_hero')
  assertEquals(r.bucket_id, 'scope-artifacts')
  assertEquals(r.storage_path, `rev-frozen/${sha}.png`)
  assertEquals(r.sha256, sha)
  assertEquals(r.size_bytes, bytes.length)
  assertEquals(r.content_type, 'image/png')

  // Storage upload happened with correct bucket + path + content type.
  assertEquals(c._state.storage_uploads.length, 1)
  const up = c._state.storage_uploads[0]
  assertEquals(up.bucket, 'scope-artifacts')
  assertEquals(up.path, `rev-frozen/${sha}.png`)
  assertEquals(up.contentType, 'image/png')
  assertEquals(up.bytes.length, bytes.length)

  // scope_artifacts row carries the full metadata + label.
  assertEquals(c._state.scope_artifacts.length, 1)
  const row = c._state.scope_artifacts[0] as any
  assertExists(row.id)
  assertEquals(row.scope_revision_id, 'rev-frozen')
  assertEquals(row.artifact_type, 'render_hero')
  assertEquals(row.bucket_id, 'scope-artifacts')
  assertEquals(row.storage_path, `rev-frozen/${sha}.png`)
  assertEquals(row.sha256, sha)
  assertEquals(row.size_bytes, bytes.length)
  assertEquals(row.content_type, 'image/png')
  assertEquals(row.label, 'Hero render — patio test fixture')
})

Deno.test('recordScopeArtifact — accepts render_gutter_detail (added 2026-05-04 alongside enum-extension migration)', async () => {
  const bytes = makeTinyPng()
  const sha = await sha256Hex(bytes)
  const c = makeMock({ scope_revisions: [FROZEN_REV] })
  const r = await recordScopeArtifact(c as any, {
    scope_revision_id: 'rev-frozen',
    artifact_type: 'render_gutter_detail',
    content_base64: await bytesToBase64(bytes),
    content_type: 'image/png',
    sha256: sha,
    label: 'patio:gutterDetail',
  })
  assert(r.ok, 'render_gutter_detail must be accepted by the server helper post-migration')
  if (!r.ok) return
  assertEquals(r.artifact_type, 'render_gutter_detail')
  assertEquals(r.storage_path, `rev-frozen/${sha}.png`)
  assertEquals((c._state.scope_artifacts[0] as any).artifact_type, 'render_gutter_detail')
  assertEquals((c._state.scope_artifacts[0] as any).label, 'patio:gutterDetail')
})

Deno.test('recordScopeArtifact — accepts render_ridge_detail (gable-only patio render)', async () => {
  const bytes = makeTinyPng()
  const sha = await sha256Hex(bytes)
  const c = makeMock({ scope_revisions: [FROZEN_REV] })
  const r = await recordScopeArtifact(c as any, {
    scope_revision_id: 'rev-frozen',
    artifact_type: 'render_ridge_detail',
    content_base64: await bytesToBase64(bytes),
    content_type: 'image/png',
    sha256: sha,
    label: 'patio:ridgeDetail',
  })
  assert(r.ok, 'render_ridge_detail must be accepted by the server helper post-migration')
  if (!r.ok) return
  assertEquals(r.artifact_type, 'render_ridge_detail')
  assertEquals((c._state.scope_artifacts[0] as any).artifact_type, 'render_ridge_detail')
  assertEquals((c._state.scope_artifacts[0] as any).label, 'patio:ridgeDetail')
})

Deno.test('recordScopeArtifact — duplicate storage upload (409) is treated as success and the row still inserts', async () => {
  const bytes = makeTinyPng()
  const sha = await sha256Hex(bytes)
  const c = makeMock({ scope_revisions: [FROZEN_REV] }, { duplicate: true })
  const r = await recordScopeArtifact(c as any, {
    scope_revision_id: 'rev-frozen',
    artifact_type: 'render_hero',
    content_base64: await bytesToBase64(bytes),
    content_type: 'image/png',
    sha256: sha,
  })
  assert(r.ok); if (!r.ok) return
  assertEquals(c._state.scope_artifacts.length, 1, 'row inserted even though storage reported duplicate')
})

Deno.test('recordScopeArtifact — non-409 storage failure is returned as storage_upload_failed', async () => {
  const bytes = makeTinyPng()
  const sha = await sha256Hex(bytes)
  const c = makeMock({ scope_revisions: [FROZEN_REV] }, { uploadFails: true })
  const r = await recordScopeArtifact(c as any, {
    scope_revision_id: 'rev-frozen',
    artifact_type: 'render_hero',
    content_base64: await bytesToBase64(bytes),
    content_type: 'image/png',
    sha256: sha,
  })
  assertEquals(r.ok, false)
  if (!r.ok) assertEquals(r.error.code, 'storage_upload_failed')
  assertEquals(c._state.scope_artifacts.length, 0, 'no row inserted when upload fails')
})

// ── Browser-parity proof ───────────────────────────────────────────────────
// The patio-tool + fence-designer freeze helpers (index.html top-level
// _parseDataUrl / _base64ToBytes / _sha256Hex) execute the EXACT same data
// URL → bytes → sha256 path the server-side helper expects. The patio +
// fence index.html files cannot be unit-tested directly without a DOM, but
// the byte-level transformation can: this test mimics those three functions
// in plain TypeScript and proves the result round-trips through the
// recordScopeArtifact server helper.

Deno.test('browser-parity proof — data URL → atob → SubtleCrypto sha256 round-trips through the server helper', async () => {
  // Same regex as patio-tool _parseDataUrl + fence-designer _fenceParseDataUrl.
  const parseDataUrl = (dataUrl: string): { contentType: string; base64: string } | null => {
    const m = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl ?? ''))
    if (!m) return null
    return { contentType: m[1], base64: m[2] }
  }
  // Same atob + Uint8Array path as the browser helpers.
  const base64ToBytes = (b64: string): Uint8Array => {
    const bin = atob(String(b64).replace(/\s+/g, ''))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  // Same SubtleCrypto digest as the browser helpers.
  const sha256HexBrowserStyle = async (bytes: Uint8Array): Promise<string> => {
    const buf = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  // Simulate canvas.toDataURL('image/png') for a small PNG.
  const png = makeTinyPng()
  let bin = ''
  for (let i = 0; i < png.length; i++) bin += String.fromCharCode(png[i])
  const dataUrl = `data:image/png;base64,${btoa(bin)}`

  const parsed = parseDataUrl(dataUrl)
  assertExists(parsed)
  if (!parsed) return
  assertEquals(parsed.contentType, 'image/png')

  const bytes = base64ToBytes(parsed.base64)
  // Bytes round-trip exactly.
  assertEquals(bytes.length, png.length)
  for (let i = 0; i < png.length; i++) assertEquals(bytes[i], png[i])

  const browserSha = await sha256HexBrowserStyle(bytes)
  // And the resulting sha256 is accepted by the server helper without
  // tripping the sha256_mismatch tamper guard — proving the patio + fence
  // browser code paths produce exactly the value the server expects.
  const c = makeMock({ scope_revisions: [FROZEN_REV] })
  const r = await recordScopeArtifact(c as any, {
    scope_revision_id: 'rev-frozen',
    artifact_type: 'render_hero',
    content_base64: parsed.base64,
    content_type: parsed.contentType,
    sha256: browserSha,
    label: 'browser-parity-proof',
  })
  assert(r.ok, 'browser-style sha256 should match server-recomputed sha256')
  if (!r.ok) return
  assertEquals(r.sha256, browserSha)
  assertEquals(r.size_bytes, png.length)
})

Deno.test('recordScopeArtifact — multiple artefacts of same type are allowed (e.g. one render_profile per fence run)', async () => {
  const bytesA = new Uint8Array([0x01, 0x02, 0x03, 0x04])
  const bytesB = new Uint8Array([0x05, 0x06, 0x07, 0x08])
  const shaA = await sha256Hex(bytesA)
  const shaB = await sha256Hex(bytesB)
  assertNotEquals(shaA, shaB)
  const c = makeMock({ scope_revisions: [FROZEN_REV] })
  // For this test we relax the content_type — a tiny PNG header isn't valid
  // here, but the helper doesn't actually validate PNG bytes; only the
  // declared content_type is checked.
  const a = await recordScopeArtifact(c as any, {
    scope_revision_id: 'rev-frozen',
    artifact_type: 'render_profile',
    content_base64: await bytesToBase64(bytesA),
    content_type: 'image/png',
    sha256: shaA,
    label: 'fence_run_id=run-A',
  })
  const b = await recordScopeArtifact(c as any, {
    scope_revision_id: 'rev-frozen',
    artifact_type: 'render_profile',
    content_base64: await bytesToBase64(bytesB),
    content_type: 'image/png',
    sha256: shaB,
    label: 'fence_run_id=run-B',
  })
  assert(a.ok && b.ok)
  if (!a.ok || !b.ok) return
  assertNotEquals(a.scope_artifact_id, b.scope_artifact_id)
  assertEquals(c._state.scope_artifacts.length, 2)
})
