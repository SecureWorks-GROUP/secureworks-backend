/**
 * Regression: Xero optional-field .Contains must carry a null guard.
 *
 * Production failure (create_ses_invoice_draft mint path):
 *   QueryParseException on /Invoices:
 *   "Operations on optional fields must be preceded by a null guard"
 *
 * A happy-path mock of xeroGet never exercises the real parser, so this suite
 * asserts the *generated where-clause string* and pins every call site in
 * index.ts to the builders. That is what would have caught this before
 * production.
 *
 * Does NOT prove: that Xero still accepts the clause shape, that live mint
 * succeeds, or that equality-only where clauses remain valid. Those need a
 * live Xero read (out of scope for ops-api unit tests).
 */
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  xeroAccrecReferenceContainsWhere,
  xeroContactNameContainsWhere,
  xeroInvoiceRefOrNumberWhere,
  xeroOptionalContains,
} from "./xero_where_clause.ts";

const INDEX = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);

Deno.test("xeroOptionalContains emits Field!=null AND Field.Contains", () => {
  assertEquals(
    xeroOptionalContains("Reference", "SWMS-261065"),
    'Reference!=null AND Reference.Contains("SWMS-261065")',
  );
  assertEquals(
    xeroOptionalContains("Name", "Acme"),
    'Name!=null AND Name.Contains("Acme")',
  );
});

Deno.test("xeroAccrecReferenceContainsWhere guards Reference then filters ACCREC", () => {
  const where = xeroAccrecReferenceContainsWhere("TOKEN");
  // Exact production-safe shape the mint path must send.
  assertEquals(
    where,
    'Reference!=null AND Reference.Contains("TOKEN") AND Type=="ACCREC"',
  );
  // Null guard MUST precede the method call (Xero rule).
  const guardAt = where.indexOf("Reference!=null");
  const containsAt = where.indexOf("Reference.Contains");
  assert(guardAt >= 0 && containsAt > guardAt, "null guard must precede Contains");
});

Deno.test("xeroContactNameContainsWhere guards optional Name", () => {
  assertEquals(
    xeroContactNameContainsWhere("Acme Pty"),
    'Name!=null AND Name.Contains("Acme Pty")',
  );
});

Deno.test("xeroInvoiceRefOrNumberWhere matches InvoiceNumber or Reference", () => {
  assertEquals(
    xeroInvoiceRefOrNumberWhere("INV-81742"),
    '(InvoiceNumber=="INV-81742" OR (Reference!=null AND Reference.Contains("INV-81742")))',
  );
});

Deno.test("index.ts mint + sync paths use the guarded ACCREC builder", () => {
  // Call-site pin: both invoice Reference searches must go through the helper.
  // A re-inlined `Reference.Contains("` without the builder would re-break mint.
  assertStringIncludes(INDEX, "xeroAccrecReferenceContainsWhere(safeToken)");
  const uses = INDEX.match(/xeroAccrecReferenceContainsWhere\(/g) || [];
  assertEquals(
    uses.length,
    2,
    "readSesXeroInvoicesByToken + sync_job_invoices must both call the builder",
  );
});

Deno.test("index.ts contact search uses the guarded Name builder", () => {
  assertStringIncludes(INDEX, "xeroContactNameContainsWhere(");
});

Deno.test("index.ts has no unguarded optional-field .Contains in a where:", () => {
  // Catches anyone re-inlining the broken form instead of the helpers.
  const unguarded = [
    ...INDEX.matchAll(
      /where:\s*(?:`|xeroGet\([^)]*)[^`]*?(?<![!=\w])([A-Za-z]+)\.Contains\(/g,
    ),
  ];
  // After the fix, zero raw Field.Contains should appear inside where templates.
  // Helpers live in xero_where_clause.ts; index only calls them.
  const rawContainsInWhere = [
    ...INDEX.matchAll(/where:\s*`[^`]*\.Contains\(/g),
  ];
  assertEquals(
    rawContainsInWhere.length,
    0,
    `unguarded where:\`...Contains(...)\` still present: ${
      rawContainsInWhere.map((m) => m[0]).join(" | ")
    }`,
  );
  // Silence unused if the first pattern stays for future extension.
  void unguarded;
});

Deno.test("xero-sync has no optional-field .Contains where clauses", async () => {
  const xeroSync = await Deno.readTextFile(
    new URL("../xero-sync/index.ts", import.meta.url),
  );
  const raw = [...xeroSync.matchAll(/where:\s*`[^`]*\.Contains\(/g)];
  assertEquals(
    raw.length,
    0,
    "xero-sync introduced a .Contains where without a null-guard builder",
  );
});
