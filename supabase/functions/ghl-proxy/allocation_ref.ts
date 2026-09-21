// Stratco allocation reference on GHL opportunities.
//
// One allocation, one opportunity, ever. Lookup must not certify absence from a
// malformed or failed provider response: an unreadable read refuses create.
// The custom field id is config-only; this module never creates the field.

import { buildGhlOpportunitySearchRequest } from './hardening_helpers.ts'
import { rethrowIfGhlRateLimited } from './provider_reads.ts'

export const ALLOCATION_FIELD_ENV = 'GHL_STRATCO_ALLOCATION_FIELD_ID'
export const ALLOCATION_RETRY_PREFIX = 'stratco-allocation:'

export type GhlFn = (path: string, init?: Record<string, unknown>) => Promise<any>

export type AllocationCustomField = { id: string; field_value: string }

export type PrepareAllocationCreate =
  | { kind: 'refuse'; status: number; body: Record<string, unknown> }
  | { kind: 'reuse'; status: number; body: Record<string, unknown> }
  | { kind: 'create'; fieldId: string; ref: string }

function nonempty(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length ? trimmed : null
}

export function readAllocationFieldId(
  getEnv: (name: string) => string | undefined = (name) => Deno.env.get(name),
): string | null {
  return nonempty(getEnv(ALLOCATION_FIELD_ENV))
}

export function parseAllocationReference(value: unknown): string | null {
  const raw = nonempty(value)
  if (!raw) return null
  if (raw.toLowerCase().startsWith(ALLOCATION_RETRY_PREFIX)) {
    return nonempty(raw.slice(ALLOCATION_RETRY_PREFIX.length))
  }
  return raw
}

export function allocationOpportunityCustomFields(
  fieldId: string,
  ref: string,
): AllocationCustomField[] {
  return [{ id: fieldId, field_value: ref }]
}

function fieldUnconfiguredBody(): Record<string, unknown> {
  return {
    error:
      `${ALLOCATION_FIELD_ENV} is not configured; create the opportunity custom field in GHL and set its id before writing an allocation reference`,
    code: 'allocation_field_unconfigured',
  }
}

function lookupUnreadableBody(): Record<string, unknown> {
  return {
    error:
      'Could not read GHL opportunities for this allocation reference; refusing to treat that as none found',
    code: 'allocation_lookup_unreadable',
  }
}

function customFieldValue(field: Record<string, unknown>): string | null {
  return nonempty(field.fieldValue ?? field.field_value ?? field.value)
}

export function opportunityCarriesAllocationRef(
  opportunity: unknown,
  fieldId: string,
  ref: string,
): boolean {
  if (!opportunity || typeof opportunity !== 'object') return false
  const customFields = (opportunity as { customFields?: unknown }).customFields
  if (customFields == null) return false
  if (!Array.isArray(customFields)) return false
  return customFields.some((field) => {
    if (!field || typeof field !== 'object') return false
    const row = field as Record<string, unknown>
    const id = nonempty(row.id)
    return id === fieldId && customFieldValue(row) === ref
  })
}

export function parseOpportunitySearchResponse(
  data: unknown,
): { ok: true; opportunities: unknown[] } | { ok: false } {
  if (!data || typeof data !== 'object') return { ok: false }
  const opportunities = (data as { opportunities?: unknown }).opportunities
  if (!Array.isArray(opportunities)) return { ok: false }
  return { ok: true, opportunities }
}

function opportunityIdOf(opportunity: unknown): string | null {
  if (!opportunity || typeof opportunity !== 'object') return null
  const row = opportunity as Record<string, unknown>
  return nonempty(row.id)
}

function contactIdOf(opportunity: unknown): string | null {
  if (!opportunity || typeof opportunity !== 'object') return null
  const row = opportunity as Record<string, unknown>
  const nested = row.contact && typeof row.contact === 'object'
    ? nonempty((row.contact as Record<string, unknown>).id)
    : null
  return nonempty(row.contactId) || nested
}

function rowCustomFieldsUnreadable(opportunity: unknown): boolean {
  if (!opportunity || typeof opportunity !== 'object') return true
  const customFields = (opportunity as { customFields?: unknown }).customFields
  return !Array.isArray(customFields)
}

export type AllocationLookup =
  | { ok: true; found: true; opportunityId: string; contactId: string | null }
  | { ok: true; found: false }
  | { ok: false; status: number; code: string; error: string }

const SEARCH_LIMIT = 100

export async function lookupOpportunityByAllocationRef(args: {
  ghl: GhlFn
  locationId: string
  fieldId: string
  ref: string
}): Promise<AllocationLookup> {
  const search = buildGhlOpportunitySearchRequest({
    locationId: args.locationId,
    fallbackLocationId: args.locationId,
    q: args.ref,
    limit: SEARCH_LIMIT,
  })
  const path = search.path.includes('status=') ? search.path : `${search.path}&status=all`

  let data: unknown
  try {
    data = await args.ghl(path, { headers: search.headers })
  } catch (error) {
    rethrowIfGhlRateLimited(error)
    const body = lookupUnreadableBody()
    return {
      ok: false,
      status: 502,
      code: String(body.code),
      error: String(body.error),
    }
  }

  const parsed = parseOpportunitySearchResponse(data)
  if (!parsed.ok) {
    const body = lookupUnreadableBody()
    return {
      ok: false,
      status: 502,
      code: String(body.code),
      error: String(body.error),
    }
  }

  let unreadableRow = false
  const matches: unknown[] = []
  for (const opportunity of parsed.opportunities) {
    if (rowCustomFieldsUnreadable(opportunity)) {
      unreadableRow = true
      continue
    }
    if (opportunityCarriesAllocationRef(opportunity, args.fieldId, args.ref)) {
      matches.push(opportunity)
    }
  }
  if (matches.length > 0) {
    const opportunity = matches[0]
    const opportunityId = opportunityIdOf(opportunity)
    if (!opportunityId) {
      const body = lookupUnreadableBody()
      return {
        ok: false,
        status: 502,
        code: String(body.code),
        error: String(body.error),
      }
    }
    return {
      ok: true,
      found: true,
      opportunityId,
      contactId: contactIdOf(opportunity),
    }
  }

  // Missing customFields, a malformed row, or a full unmatched page is an
  // unproven tail: do not certify absence.
  if (unreadableRow || parsed.opportunities.length >= SEARCH_LIMIT) {
    const body = lookupUnreadableBody()
    return {
      ok: false,
      status: 502,
      code: String(body.code),
      error: String(body.error),
    }
  }

  return { ok: true, found: false }
}

export async function prepareAllocationCreate(args: {
  ref: string
  fieldId: string | null
  locationId: string
  ghl: GhlFn
}): Promise<PrepareAllocationCreate> {
  if (!args.fieldId) {
    return { kind: 'refuse', status: 400, body: fieldUnconfiguredBody() }
  }
  const looked = await lookupOpportunityByAllocationRef({
    ghl: args.ghl,
    locationId: args.locationId,
    fieldId: args.fieldId,
    ref: args.ref,
  })
  if (!looked.ok) {
    return {
      kind: 'refuse',
      status: looked.status,
      body: { error: looked.error, code: looked.code },
    }
  }
  if (looked.found) {
    return {
      kind: 'reuse',
      status: 200,
      body: {
        contactId: looked.contactId,
        opportunityId: looked.opportunityId,
        contactExisted: true,
        opportunityExisted: true,
      },
    }
  }
  return { kind: 'create', fieldId: args.fieldId, ref: args.ref }
}

export async function lookupAllocationOpportunityAction(args: {
  method: string
  ref: unknown
  fieldId: string | null
  locationId: string
  ghl: GhlFn
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (args.method !== 'GET') {
    return {
      status: 405,
      body: {
        error: 'lookup_allocation_opportunity is GET only',
        code: 'method_not_allowed',
      },
    }
  }
  const ref = parseAllocationReference(args.ref)
  if (!ref) {
    return {
      status: 400,
      body: { error: 'allocationRef is required', code: 'allocation_ref_required' },
    }
  }
  if (!args.fieldId) {
    return { status: 400, body: fieldUnconfiguredBody() }
  }
  const looked = await lookupOpportunityByAllocationRef({
    ghl: args.ghl,
    locationId: args.locationId,
    fieldId: args.fieldId,
    ref,
  })
  if (!looked.ok) {
    return {
      status: looked.status,
      body: { error: looked.error, code: looked.code, found: false },
    }
  }
  if (!looked.found) {
    return {
      status: 200,
      body: { found: false, opportunityId: null, contactId: null },
    }
  }
  return {
    status: 200,
    body: {
      found: true,
      opportunityId: looked.opportunityId,
      contactId: looked.contactId,
    },
  }
}
