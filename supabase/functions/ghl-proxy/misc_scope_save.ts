// Misc's existing-job draft save cannot overwrite another tool or an office
// edit. This guard is deliberately absent from every legacy tool's path.
import { requestedBaseScopeHash, scopeJsonHash } from './hardening_helpers.ts'

type Row = Record<string, unknown>
type Refusal = { status: 409; code: string; error: string }

export function isMiscScopeSave(scope: unknown): boolean {
  return !!scope && typeof scope === 'object' && !Array.isArray(scope) &&
    (scope as Row).tool === 'misc-scoper'
}

function emptyOrMisc(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).length === 0 || (value as Row).tool === 'misc-scoper'
}

export async function miscScopeSaveRefusal(
  target: Row,
  incomingScope: unknown,
  meta: Row = {},
): Promise<Refusal | null> {
  if (!isMiscScopeSave(incomingScope)) return null
  const refuse = (code: string, error: string): Refusal => ({ status: 409, code, error })
  const pricing = meta.pricing_json
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing) ||
      (pricing as Row).tool !== 'misc-scoper' || (pricing as Row).source !== 'quick_quote') {
    return refuse('misc_pricing_payload_required', 'Custom work must save its matching scope and pricing together.')
  }
  if (target.type !== 'general' || target.status !== 'draft') {
    return refuse('misc_draft_job_required', 'Custom work can only save to its existing general draft job. Reload the job.')
  }
  if (!emptyOrMisc(target.scope_json)) {
    return refuse('misc_foreign_scope', 'This job already holds another tool\'s scope. The custom draft was not saved.')
  }
  if (!emptyOrMisc(target.pricing_json)) {
    return refuse('misc_foreign_pricing', 'This job already holds another quote\'s pricing. The custom draft was not saved.')
  }
  const scopeHash = requestedBaseScopeHash(meta)
  if (!scopeHash) {
    return refuse('misc_scope_cursor_required', 'Reload the job before saving so its scope cursor is known.')
  }
  const pricingHash = typeof meta.base_pricing_hash === 'string' ? meta.base_pricing_hash.trim() : ''
  if (!pricingHash) {
    return refuse('misc_pricing_cursor_required', 'Reload the job before saving so its pricing cursor is known.')
  }
  if (scopeHash !== await scopeJsonHash(target.scope_json || {})) {
    return refuse('scope_hash_conflict', 'The job scope changed after it was loaded. Reload before saving.')
  }
  if (pricingHash !== await scopeJsonHash(target.pricing_json || {})) {
    return refuse('misc_pricing_hash_conflict', 'The job pricing changed after it was loaded. Reload before saving.')
  }
  return null
}
