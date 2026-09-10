// Xero contact addresses from our stored job address (2026-09-10).
//
// Jobs keep the address the way Google gave it to the scoping tool:
//   "12 Pebbly Way, Clarkson WA 6030, Australia"
//   "3/3 Alga St, Scarborough WA 6019"
//   "3 HODGSON STREET, Tuart Hill"       (make-safe intake, no state/postcode)
//   "16 Wright Ave"                      (suburb only in jobs.site_suburb)
// Xero wants it split (AddressLine1 / City / Region / PostalCode), and it
// prints the POBOX (postal) address on invoices and statements, so a contact
// with only a STREET address invoices with no address block at all.

export interface ParsedAuAddress {
  street: string
  suburb: string
  state: string
  postcode: string
}

const AU_STATES = ['WA', 'NSW', 'VIC', 'QLD', 'SA', 'TAS', 'NT', 'ACT']
const STATE_RE = new RegExp(`^(.*?)[\\s,]+(${AU_STATES.join('|')})\\b\\s*(\\d{4})?\\s*$`, 'i')

function clean(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

function titleCaseIfShouting(s: string): string {
  // Make-safe intake arrives SHOUTING ("3 HODGSON STREET"). Leave mixed case alone.
  if (!s || s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s
  return s.toLowerCase().replace(/(^|[\s\/-])([a-z])/g, (_m, p, c) => p + c.toUpperCase())
}

/** Split a stored address into street / suburb / state / postcode. */
export function parseAuAddress(address: unknown, suburbHint?: unknown): ParsedAuAddress | null {
  let raw = clean(address)
  const hint = clean(suburbHint)
  raw = raw.replace(/,?\s*Australia\s*$/i, '').trim()
  if (!raw && !hint) return null

  let street = raw
  let suburb = ''
  let state = ''
  let postcode = ''

  const m = raw.match(STATE_RE)
  if (m) {
    street = clean(m[1]).replace(/,$/, '')
    state = m[2].toUpperCase()
    postcode = m[3] || ''
  }

  // Street and suburb are comma separated; the suburb is the last part.
  const parts = street.split(',').map(clean).filter(Boolean)
  if (parts.length >= 2) {
    suburb = parts[parts.length - 1]
    street = parts.slice(0, -1).join(', ')
  } else if (parts.length === 1) {
    street = parts[0]
  }

  // Suburb may have landed in the street when there was no comma ("16 Wright Ave Swanbourne").
  if (!suburb && hint) {
    const tail = new RegExp(`\\s+${hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
    if (tail.test(street)) street = street.replace(tail, '').trim()
    suburb = hint
  }
  if (!suburb) suburb = hint
  if (suburb && street.toLowerCase() === suburb.toLowerCase()) street = ''

  street = titleCaseIfShouting(street)
  suburb = titleCaseIfShouting(suburb)
  if (!street && !suburb) return null
  return { street, suburb, state: state || 'WA', postcode }
}

export interface XeroAddress {
  AddressType: 'POBOX' | 'STREET' | 'DELIVERY'
  AddressLine1?: string
  City?: string
  Region?: string
  PostalCode?: string
  Country?: string
}

function xeroAddress(type: XeroAddress['AddressType'], p: ParsedAuAddress): XeroAddress {
  const a: XeroAddress = { AddressType: type, Country: 'Australia' }
  if (p.street) a.AddressLine1 = p.street
  if (p.suburb) a.City = p.suburb
  if (p.state) a.Region = p.state
  if (p.postcode) a.PostalCode = p.postcode
  return a
}

/** Addresses for a NEW Xero contact: postal (what invoices print) and street. */
export function xeroAddressesFor(address: unknown, suburbHint?: unknown): XeroAddress[] {
  const p = parseAuAddress(address, suburbHint)
  if (!p) return []
  return [xeroAddress('POBOX', p), xeroAddress('STREET', p)]
}

function addressHasContent(a: any): boolean {
  return !!(a && (clean(a.AddressLine1) || clean(a.City) || clean(a.PostalCode)))
}

/** True when a Xero contact has no usable postal address (the one invoices print). */
export function contactNeedsPostalAddress(contact: any): boolean {
  const list: any[] = Array.isArray(contact?.Addresses) ? contact.Addresses : []
  return !list.some((a: any) => String(a?.AddressType || '').toUpperCase() === 'POBOX' && addressHasContent(a))
}

/**
 * Update payload for an EXISTING Xero contact that is missing a postal address.
 * Keeps whatever STREET/DELIVERY entries Xero already has, adds POBOX (and a
 * STREET if there was none). Returns null when nothing should change.
 */
export function contactAddressUpdate(contact: any, address: unknown, suburbHint?: unknown): { ContactID: string; Addresses: XeroAddress[] } | null {
  if (!contact?.ContactID) return null
  if (!contactNeedsPostalAddress(contact)) return null
  const p = parseAuAddress(address, suburbHint)
  if (!p) return null
  const existing: any[] = (Array.isArray(contact.Addresses) ? contact.Addresses : [])
    .filter((a: any) => String(a?.AddressType || '').toUpperCase() !== 'POBOX' && addressHasContent(a))
  const hasStreet = existing.some((a: any) => String(a?.AddressType || '').toUpperCase() === 'STREET')
  const next: XeroAddress[] = [xeroAddress('POBOX', p), ...existing]
  if (!hasStreet) next.push(xeroAddress('STREET', p))
  return { ContactID: contact.ContactID, Addresses: next }
}
