// Cap 0 Job Release Packet V1 — deterministic canonicalization + hashing.
//
// CRITICAL: do NOT replace this with `JSON.stringify(obj, Object.keys(obj).sort())`.
// That pattern only filters TOP-level keys; it does not deep-sort, so two
// equivalent payloads with reordered nested keys produce different hashes,
// silently breaking idempotence. The recursive form below is the only
// acceptable approach for the manifest_hash contract.
//
// Reference: cio/reports/2026-04-30-job-release-packet-v1/release-packet-contract-v1.md §1
//            cio/reports/2026-04-30-job-release-packet-v1/scaffold/build_manifest.ts

export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const sortedKeys = Object.keys(value as Record<string, unknown>).sort()
  const out: Record<string, unknown> = {}
  for (const k of sortedKeys) {
    out[k] = canonicalize((value as Record<string, unknown>)[k])
  }
  return out
}

export async function jsonHash(obj: unknown): Promise<string> {
  const canonical = JSON.stringify(canonicalize(obj))
  const data = new TextEncoder().encode(canonical)
  const hashBuf = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// Convenience: returns both the canonical JSON string and its SHA-256 hash,
// so callers that need to upload the canonical bytes (manifest_url) and
// record the hash (manifest_hash) don't have to re-canonicalize.
export async function canonicalJsonAndHash(
  obj: unknown,
): Promise<{ canonical: string; hash: string }> {
  const canonical = JSON.stringify(canonicalize(obj))
  const data = new TextEncoder().encode(canonical)
  const hashBuf = await crypto.subtle.digest('SHA-256', data)
  const hash = Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
  return { canonical, hash }
}
