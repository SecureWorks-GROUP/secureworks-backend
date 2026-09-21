// Stratco allocation reference on GHL opportunities.
//
// One allocation, one opportunity, ever, on the known contact. Lookup pages
// that contact's opportunities (status=all) and hydrates list rows that do not
// carry readable customFields. Absence is proven only when every opportunity
// of that contact was read in full. A q text search is never used. Two
// different contacts for one allocation are not caught; Sales keys one
// allocation to one contact. The custom field id is config-only; this module
// never creates the field. Nothing live was proven. Phone duplicate search
// still normalises to 0-prefix, not +61.

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

export function readCreateAllocationRef(body: Record<string, unknown>): string | null {
  return parseAllocationReference(body.allocationRef)
}

export function readLookupAllocationQuery(params: {
  get(name: string): string | null
}): { ref: string | null; contactId: string | null } {
  return {
    ref: parseAllocationReference(params.get('allocationRef')),
    contactId: nonempty(params.get('contactId')),
  }
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

function contactRequiredBody(): Record<string, unknown> {
  return {
    error:
      'contactId is required to look up an allocation opportunity; absence cannot be proved without a contact',
    code: 'allocation_contact_required',
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

function listRowNeedsHydration(opportunity: unknown): boolean {
  if (!opportunity || typeof opportunity !== 'object') return true
  const customFields = (opportunity as { customFields?: unknown }).customFields
  if (!Array.isArray(customFields)) return true
  return customFields.length === 0
}

function parseOpportunityRecord(data: unknown): unknown | null {
  if (!data || typeof data !== 'object') return null
  const row = data as Record<string, unknown>
  if (row.opportunity && typeof row.opportunity === 'object') return row.opportunity
  if (nonempty(row.id)) return row
  return null
}

function nextSearchCursor(
  data: unknown,
  rows: unknown[],
): { startAfter: string | number; startAfterId: string } | null {
  const meta = data && typeof data === 'object'
    ? (data as { meta?: Record<string, unknown> }).meta
    : undefined
  const last = rows[rows.length - 1]
  const lastRow = last && typeof last === 'object' ? last as Record<string, unknown> : null
  const sort = lastRow && Array.isArray(lastRow.sort) ? lastRow.sort : null
  const startAfter = meta && meta.startAfter != null
    ? meta.startAfter
    : sort && sort[0] != null
    ? sort[0]
    : null
  const startAfterId = nonempty(meta?.startAfterId) ||
    (sort ? nonempty(sort[1]) : null) ||
    (lastRow ? nonempty(lastRow.contactId) : null) ||
    opportunityIdOf(last)
  if (startAfter == null || startAfter === '' || !startAfterId) return null
  return { startAfter: startAfter as string | number, startAfterId }
}

function unreadableLookup(): Extract<AllocationLookup, { ok: false }> {
  const body = lookupUnreadableBody()
  return {
    ok: false,
    status: 502,
    code: String(body.code),
    error: String(body.error),
  }
}

export type AllocationLookup =
  | { ok: true; found: true; opportunityId: string; contactId: string | null }
  | { ok: true; found: false }
  | { ok: false; status: number; code: string; error: string }

const SEARCH_LIMIT = 100
const MAX_SEARCH_PAGES = 20

async function readOpportunityForAllocation(
  opportunity: unknown,
  args: { ghl: GhlFn; fieldId: string; ref: string; contactId: string },
): Promise<
  | { ok: true; carries: boolean; opportunity: unknown }
  | { ok: false }
> {
  const listedContact = contactIdOf(opportunity)
  if (listedContact && listedContact !== args.contactId) return { ok: false }

  let row = opportunity
  if (listRowNeedsHydration(row)) {
    const id = opportunityIdOf(row)
    if (!id) return { ok: false }
    let data: unknown
    try {
      data = await args.ghl(`/opportunities/${encodeURIComponent(id)}`)
    } catch (error) {
      rethrowIfGhlRateLimited(error)
      return { ok: false }
    }
    const full = parseOpportunityRecord(data)
    if (!full || rowCustomFieldsUnreadable(full)) return { ok: false }
    const fullContact = contactIdOf(full)
    if (fullContact && fullContact !== args.contactId) return { ok: false }
    row = full
  }

  return {
    ok: true,
    carries: opportunityCarriesAllocationRef(row, args.fieldId, args.ref),
    opportunity: row,
  }
}

export async function lookupOpportunityByAllocationRef(args: {
  ghl: GhlFn
  locationId: string
  fieldId: string
  ref: string
  contactId?: string | null
}): Promise<AllocationLookup> {
  const contactId = nonempty(args.contactId)
  if (!contactId) {
    const body = contactRequiredBody()
    return {
      ok: false,
      status: 400,
      code: String(body.code),
      error: String(body.error),
    }
  }

  let startAfter: string | number | null = null
  let startAfterId: string | null = null

  for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
    const search = buildGhlOpportunitySearchRequest({
      locationId: args.locationId,
      fallbackLocationId: args.locationId,
      contactId,
      limit: SEARCH_LIMIT,
      startAfter,
      startAfterId,
    })
    const path = search.path.includes('status=') ? search.path : `${search.path}&status=all`

    let data: unknown
    try {
      data = await args.ghl(path, { headers: search.headers })
    } catch (error) {
      rethrowIfGhlRateLimited(error)
      return unreadableLookup()
    }

    const parsed = parseOpportunitySearchResponse(data)
    if (!parsed.ok) return unreadableLookup()

    for (const opportunity of parsed.opportunities) {
      const read = await readOpportunityForAllocation(opportunity, {
        ghl: args.ghl,
        fieldId: args.fieldId,
        ref: args.ref,
        contactId,
      })
      if (!read.ok) return unreadableLookup()
      if (read.carries) {
        const opportunityId = opportunityIdOf(read.opportunity)
        if (!opportunityId) return unreadableLookup()
        return {
          ok: true,
          found: true,
          opportunityId,
          contactId: contactIdOf(read.opportunity) || contactId,
        }
      }
    }

    if (parsed.opportunities.length < SEARCH_LIMIT) {
      return { ok: true, found: false }
    }

    const cursor = nextSearchCursor(data, parsed.opportunities)
    if (!cursor) return unreadableLookup()
    startAfter = cursor.startAfter
    startAfterId = cursor.startAfterId
  }

  return unreadableLookup()
}

export async function prepareAllocationCreate(args: {
  ref: string
  fieldId: string | null
  locationId: string
  ghl: GhlFn
  contactId?: string | null
  contactJustCreated?: boolean
}): Promise<PrepareAllocationCreate> {
  if (!args.fieldId) {
    return { kind: 'refuse', status: 400, body: fieldUnconfiguredBody() }
  }
  if (args.contactJustCreated) {
    return { kind: 'create', fieldId: args.fieldId, ref: args.ref }
  }
  const looked = await lookupOpportunityByAllocationRef({
    ghl: args.ghl,
    locationId: args.locationId,
    fieldId: args.fieldId,
    ref: args.ref,
    contactId: args.contactId,
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
  contactId?: unknown
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
  const contactId = nonempty(args.contactId)
  if (!contactId) {
    return { status: 400, body: contactRequiredBody() }
  }
  if (!args.fieldId) {
    return { status: 400, body: fieldUnconfiguredBody() }
  }
  const looked = await lookupOpportunityByAllocationRef({
    ghl: args.ghl,
    locationId: args.locationId,
    fieldId: args.fieldId,
    ref,
    contactId,
  })
  if (!looked.ok) {
    return {
      status: looked.status,
      body: { error: looked.error, code: looked.code },
    }
  }
  if (!looked.found) {
    return {
      status: 200,
      body: { found: false, opportunityId: null, contactId },
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
