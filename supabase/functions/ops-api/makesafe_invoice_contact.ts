/**
 * Canonical Xero contact naming for make-safe invoices.
 *
 * MLB/Prime jobs must bill through ONE Xero contact. Intake and board labels for
 * the same builder vary ("mlb", "ML Builders", "Major Loss Builders"), and Xero
 * creates a brand new contact for any name it does not already hold. Three
 * contacts for one builder splits their aged receivables and makes the ledger
 * unreconcilable.
 *
 * This lived as a private function inside index.ts. The SES draft path
 * (ses_reporting_actions.ts) cannot import index.ts without a cycle, so it
 * passed the raw builder name straight to Xero and silently minted an "mlb"
 * contact on 2026-08-04. Both paths now import from here so they cannot drift
 * again - that was the stated intent of the original comment, but a private
 * function in index.ts could never deliver it.
 */

const CANONICAL_MLB_CONTACT = "Major Loss Builders";

// Builder-name spellings that all mean MLB, compared after stripping every
// non-alphanumeric character and lowercasing. "mlb" is included deliberately:
// it is the company slug, and it is what leaked into Xero.
const MLB_NAME_ALIASES = new Set([
  "mlb",
  "mlbuilder",
  "mlbuilders",
  "majorlossbuilder",
  "majorlossbuilders",
]);

/**
 * Resolve the Xero contact name for a make-safe invoice.
 *
 * An MLB-scoped reference is authoritative: any reference carrying an MLB token
 * bills to Major Loss Builders regardless of the label the caller passed. When
 * the reference is absent or non-MLB, the contact name itself is matched against
 * the known aliases, so a bare "mlb" still canonicalises.
 *
 * Any other builder is returned untouched. This function deliberately does NOT
 * canonicalise other builders (AJ has the same split) because no ruling exists
 * on their canonical spelling yet - inventing one here would repeat this bug in
 * the other direction.
 */
export function canonicalMakesafeInvoiceContactName(
  reference: unknown,
  contact: unknown,
): string {
  const raw = String(contact || "").trim();
  const ref = String(reference || "").trim().toUpperCase();
  const norm = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const hasMlbRef = /(^|[^A-Z0-9])MLB([^A-Z0-9]|$)/.test(ref) ||
    /(^|[^A-Z0-9])MLB[-\s]*\d+/.test(ref) ||
    ref.startsWith("MLB");
  if (hasMlbRef || MLB_NAME_ALIASES.has(norm)) {
    return CANONICAL_MLB_CONTACT;
  }
  return raw;
}

/** Display label for a builder, resolved through the same canonical rule. */
export function canonicalMakesafeBuilderDisplayName(
  reference: unknown,
  requestedName: unknown,
  companyName: unknown,
): string {
  return canonicalMakesafeInvoiceContactName(
    reference,
    requestedName || companyName || "",
  );
}
