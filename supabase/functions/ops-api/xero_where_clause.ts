/**
 * Xero where-clause builders.
 *
 * Xero's IQueryable parser refuses operations on optional fields unless the
 * field is null-guarded first:
 *   QueryParseException: "Operations on optional fields must be preceded by a null guard"
 *
 * Equality (`Field=="x"`, `Type=="ACCREC"`) does not need this guard.
 * Methods on optional strings (`.Contains`, and by the same rule
 * `.StartsWith` / `.EndsWith`) do.
 */

/**
 * Build a Xero-safe `Field!=null AND Field.Contains("...")` fragment for an
 * optional string field. `safeValue` must already be escaped for embedding
 * inside a double-quoted Xero string literal (callers own escaping).
 *
 * Adding the null guard excludes rows where the field is null — which is the
 * correct semantics, because a null value cannot contain the token.
 */
export function xeroOptionalContains(
  field: string,
  safeValue: string,
): string {
  return `${field}!=null AND ${field}.Contains("${safeValue}")`
}

/** ACCREC invoice search by Reference token (mint reconcile + job sync). */
export function xeroAccrecReferenceContainsWhere(safeToken: string): string {
  return `${xeroOptionalContains("Reference", safeToken)} AND Type=="ACCREC"`
}

/** Contact name search (Name is optional on Xero Contact). */
export function xeroContactNameContainsWhere(safeName: string): string {
  return xeroOptionalContains("Name", safeName)
}

/**
 * Supplier-bill search token: trade ACCPAY stores the SW number on Reference,
 * R&R-style bills use InvoiceNumber (e.g. INV-81742). Match either field.
 */
export function xeroInvoiceRefOrNumberWhere(safeToken: string): string {
  return `(InvoiceNumber=="${safeToken}" OR (${xeroOptionalContains("Reference", safeToken)}))`
}
