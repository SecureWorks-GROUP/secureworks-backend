// Shared extraction helpers used by all adapters.
//
// Adapters read messy real-world `jobs.scope_json` + `jobs.pricing_json`
// shapes (multiple field-naming conventions accumulated since 2023). These
// helpers normalize the read so each adapter stays focused on its own
// service-specific shape. None of these helpers throw — adapters need to
// produce SOMETHING for every release, even when capture is partial. The
// validator is the gate that decides whether the resulting shape is enough
// to ship.

export function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

export function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

export function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

export function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

export function asNumberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

export function asBool(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.toLowerCase()
    if (s === 'true' || s === 'yes' || s === '1') return true
    if (s === 'false' || s === 'no' || s === '0') return false
  }
  return fallback
}

// Stable line_id derivation. The line content drives the id so reordering
// or re-saving doesn't change hashes when the content is the same. The
// order index is appended to disambiguate identical-description lines.
//
// Format: 'L-<index>-<short content hash>'. The short hash is the first
// 8 hex chars of sha256 over the canonical content. Async because it
// needs crypto.subtle.digest, but adapters call it once per line.
export async function deriveLineId(
  index: number,
  parts: Array<string | number | null | undefined>,
): Promise<string> {
  const content = parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('|')
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
  return `L-${index}-${hex.slice(0, 8)}`
}
