// The site address a customer reads: the street line, with the suburb added only when the
// street line does not already name it. The same rule the scoping tools use (scope-engine
// patio/scoper/src/jobsystem.ts jobCustomer), so a street typed as "3 Test St, Baldivis"
// with suburb "Baldivis" prints once, never "3 Test St, Baldivis, Baldivis".
// Every customer page, email and pack that joins site_address and site_suburb uses this.

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** "street, suburb", or the street alone when it already names the suburb. */
export function customerSiteLine(siteAddress: unknown, siteSuburb: unknown, separator = ', '): string {
  const street = text(siteAddress)
  const suburb = text(siteSuburb)
  if (!suburb || street.toLowerCase().includes(suburb.toLowerCase())) return street
  return [street, suburb].filter(Boolean).join(separator)
}
