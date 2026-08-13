/**
 * Canonical Xero contact naming for make-safe invoices.
 *
 * A builder must bill through ONE Xero contact. Intake and board labels for the
 * same builder vary (the slug "mlb", the display name "ML Builders", the real
 * Xero contact "Major Loss Builders"), and Xero creates a brand new contact for
 * any name it does not already hold. Several contacts for one builder splits
 * their aged receivables and makes the ledger unreconcilable.
 *
 * This lived as a private function inside index.ts. The SES draft path
 * (ses_reporting_actions.ts) cannot import index.ts without a cycle, so it
 * passed the raw builder label straight to Xero and silently minted "mlb" and
 * "aj" contacts on 2026-08-04. Both paths now import from here so they cannot
 * drift again - that was the stated intent of the original comment, but a
 * private function in index.ts could never deliver it.
 */

interface BuilderContactRule {
  /** The one Xero contact this builder bills through. */
  canonical: string;
  /**
   * Reference tokens that scope an invoice to this builder. Matched against the
   * UPPERCASED reference. Must be specific enough not to catch a sibling: "AJBR"
   * rather than "AJ", because AJS Group is a different contact entirely.
   */
  refTokens: string[];
  /**
   * Builder labels meaning this builder, compared after lowercasing and
   * stripping every non-alphanumeric character. Exact match only, so a longer
   * name that merely contains one of these is not swept in.
   */
  aliases: string[];
}

// Order matters only if a reference could carry two builders' tokens, which does
// not happen in practice. MLB stays first because it was the original rule.
const BUILDER_CONTACT_RULES: BuilderContactRule[] = [
  {
    canonical: "Major Loss Builders",
    refTokens: ["MLB"],
    // "mlb" is the company slug and is what leaked into Xero on 2026-08-04.
    aliases: ["mlb", "mlbuilder", "mlbuilders", "majorlossbuilder", "majorlossbuilders"],
  },
  {
    canonical: "AJ Building & Restoration",
    // AJBR, never a bare AJ: "AJS-123" must NOT resolve here.
    refTokens: ["AJBR"],
    aliases: ["aj", "ajbuilding", "ajbuildingrestoration", "ajbuildingandrestoration"],
  },
];

function referenceCarriesToken(refUpper: string, token: string): boolean {
  if (!refUpper) return false;
  // Same three shapes the original MLB check used: the token standing alone, the
  // token immediately followed by its number ("AJBR 67457", "MLB-26003"), or the
  // reference simply starting with it.
  const bounded = new RegExp(`(^|[^A-Z0-9])${token}([^A-Z0-9]|$)`);
  const numbered = new RegExp(`(^|[^A-Z0-9])${token}[-\\s]*\\d+`);
  return bounded.test(refUpper) || numbered.test(refUpper) || refUpper.startsWith(token);
}

/**
 * Resolve the Xero contact name for a make-safe invoice.
 *
 * A builder-scoped reference is authoritative: an invoice referencing MLB bills
 * to Major Loss Builders regardless of the label the caller passed. When the
 * reference is absent or unrecognised, the contact name itself is matched
 * against the known aliases, so a bare "mlb" or "aj" still canonicalises.
 *
 * Any builder without a rule is returned untouched. Adding one is a commercial
 * decision about which Xero contact is real, not a code guess - inventing a
 * canonical spelling here would repeat the original bug in the other direction.
 */
export function canonicalMakesafeInvoiceContactName(
  reference: unknown,
  contact: unknown,
): string {
  const raw = String(contact || "").trim();
  const ref = String(reference || "").trim().toUpperCase();
  const norm = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (const rule of BUILDER_CONTACT_RULES) {
    const byRef = rule.refTokens.some((token) => referenceCarriesToken(ref, token));
    if (byRef || rule.aliases.includes(norm)) {
      return rule.canonical;
    }
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
