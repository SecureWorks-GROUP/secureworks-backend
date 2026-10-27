// Scope Engine links for the `link` action (integrations I-4).
//
// The GHL scope note links staff back to the scoper that made the scope. Until
// the Scope Engine pages are released, the note keeps the old tool addresses.
// The release owner switches a trade over by setting SCOPE_ENGINE_PATIO_URL or
// SCOPE_ENGINE_FENCE_URL. An unset, non-https or non-allowlisted value keeps
// the old address, so nothing changes until a valid one is set.

export const LEGACY_TOOL_URLS: Record<'patio' | 'fencing', string> = {
  patio: 'https://secureworks-group.github.io/patio/',
  fencing: 'https://secureworks-group.github.io/fence-designer/',
}

// Hosts the scopers are published on (GitHub Pages for the org and the owner).
const ALLOWED_HOSTS = new Set(['secureworks-group.github.io', 'marninms98-dotcom.github.io'])

export function scopeToolUrl(
  tool: 'patio' | 'fencing',
  env: { patio?: string | null; fencing?: string | null },
): string {
  const raw = String((tool === 'fencing' ? env.fencing : env.patio) || '').trim()
  if (raw) {
    try {
      const u = new URL(raw)
      if (u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname) && !u.search && !u.hash) {
        return u.href.endsWith('/') ? u.href : `${u.href}/`
      }
    } catch (_e) { /* fall through to the legacy address */ }
  }
  return LEGACY_TOOL_URLS[tool]
}

// Note lines for a scope saved by the Scope Engine patio scoper
// (scope_json.tool === 'patio-scoper'). The record carries no customer, so
// name and address come from the job row.
export function patioScoperNoteLines(
  scope: Record<string, any>,
  jobData: { client_name?: string | null; site_address?: string | null; site_suburb?: string | null; job_number?: string | null },
): string[] {
  const lines: string[] = []
  if (jobData.client_name) lines.push(`👤 ${jobData.client_name}`)
  const place = `${jobData.site_address || ''} ${jobData.site_suburb || ''}`.trim()
  if (place) lines.push(`📍 ${place}`)
  lines.push('')
  if (typeof scope.family === 'string' && scope.family) lines.push(`🏠 Patio: ${scope.family}`)
  const rev = scope.revision || {}
  if (typeof rev.n === 'number') lines.push(`📄 Sealed revision ${rev.n}${Array.isArray(scope.earlier) && scope.earlier.length ? ` (${scope.earlier.length} earlier)` : ''}`)
  if (Array.isArray(scope.lines)) lines.push(`🧾 Order lines: ${scope.lines.length}`)
  if (scope.supported === false) lines.push('⚠️ Not yet a quoted patio type: check before quoting')
  lines.push('')
  if (jobData.job_number) lines.push(`📝 Job Ref: ${jobData.job_number}`)
  return lines
}

// The Scope Engine patio tool calls `link` once GHL is switched on and before Xero is: it sends
// `skip_xero: true`, and the Xero contact step is left out. Only an exact true skips it, so every
// other caller (the old patio and fence pages) keeps the Xero contact as before.
export function linkSkipsXero(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { skip_xero?: unknown }).skip_xero === true
}
