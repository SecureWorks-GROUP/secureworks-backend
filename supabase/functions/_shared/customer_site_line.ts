// The site address a customer reads: the street line, with the suburb added unless the street
// line already ENDS with it as its own comma part (ignoring case and an optional trailing state
// and postcode). Never a substring test: a street named after its suburb ("5 Baldivis Road")
// still gets the suburb, and "3 Test St, Baldivis" with suburb "Baldivis" prints it once.
// Every customer page, email and pack that joins site_address and site_suburb uses this.

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function words(v: string): string {
  return v.replace(/\s+/g, ' ').trim().toLowerCase()
}

const TRAILING_STATE_POSTCODE = /(?:\s+(?:WA|NSW|VIC|QLD|SA|TAS|NT|ACT))?(?:\s+\d{4})?\s*$/i

/** Whether the street line's last comma part is the suburb (optionally followed by state and postcode). */
function endsWithSuburb(street: string, suburb: string): boolean {
  const parts = street.split(',')
  // A last part that is only a state and/or postcode ("..., Baldivis, WA 6171") is skipped.
  if (parts.length > 1 && parts[parts.length - 1].replace(TRAILING_STATE_POSTCODE, '').trim() === '') parts.pop()
  const last = parts[parts.length - 1]
  const want = words(suburb)
  return words(last) === want || words(last.replace(TRAILING_STATE_POSTCODE, '')) === want
}

/** "street, suburb", or the street alone when its last comma part is already the suburb. */
export function customerSiteLine(siteAddress: unknown, siteSuburb: unknown, separator = ', '): string {
  const street = text(siteAddress)
  const suburb = text(siteSuburb)
  if (!suburb || (street && endsWithSuburb(street, suburb))) return street
  return [street, suburb].filter(Boolean).join(separator)
}
