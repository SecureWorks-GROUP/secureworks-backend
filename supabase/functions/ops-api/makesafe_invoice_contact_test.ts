import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canonicalMakesafeBuilderDisplayName,
  canonicalMakesafeInvoiceContactName,
} from "./makesafe_invoice_contact.ts";

// The bug this module exists to prevent: on 2026-08-04 the SES draft path passed
// the raw builder label to Xero, which had no contact by that name and created
// one. MLB ended up split across three contacts ("mlb", "ML Builders",
// "Major Loss Builders"), with real money authorised against two of them.

Deno.test("bare slug 'mlb' canonicalises even with no reference", () => {
  // This is the exact value that leaked. It is the company slug, and the old
  // alias list did not contain it - only the reference check would have caught
  // it, so a missing or non-MLB reference let it straight through.
  assertEquals(canonicalMakesafeInvoiceContactName("", "mlb"), "Major Loss Builders");
  assertEquals(canonicalMakesafeInvoiceContactName(null, "MLB"), "Major Loss Builders");
  assertEquals(canonicalMakesafeInvoiceContactName("", "  mlb  "), "Major Loss Builders");
});

Deno.test("every observed MLB spelling maps to the one contact", () => {
  for (const name of ["mlb", "ML Builders", "M L Builders", "Major Loss Builder", "Major Loss Builders"]) {
    assertEquals(
      canonicalMakesafeInvoiceContactName("MLB-27419PO-58488", name),
      "Major Loss Builders",
      `spelling ${JSON.stringify(name)} must bill to the canonical contact`,
    );
  }
});

Deno.test("an MLB-scoped reference wins over whatever label the caller passed", () => {
  // References seen live on the mis-billed drafts.
  for (const ref of ["MLB-27419PO-58488", "MLB-RR-26836PO-57602", "SWMS-26651 / MLB-26003", "MLB-25947"]) {
    assertEquals(
      canonicalMakesafeInvoiceContactName(ref, "mlb"),
      "Major Loss Builders",
      `reference ${ref} must resolve to the canonical contact`,
    );
  }
});

// AJ hit the identical bug on the identical day: an "aj" contact appeared in
// Xero on 2026-08-04 and took 3 paid + 2 authorised invoices, while the real
// contact "AJ Building & Restoration" holds 94 paid. Captain ruling 2026-08-13.

Deno.test("bare slug 'aj' canonicalises even with no reference", () => {
  assertEquals(canonicalMakesafeInvoiceContactName("", "aj"), "AJ Building & Restoration");
  assertEquals(canonicalMakesafeInvoiceContactName(null, "AJ"), "AJ Building & Restoration");
});

Deno.test("every observed AJ spelling maps to the one contact", () => {
  for (const name of ["aj", "AJ Building & Restoration", "AJ Building and Restoration", "ajbuilding"]) {
    assertEquals(
      canonicalMakesafeInvoiceContactName("AJBR-70781", name),
      "AJ Building & Restoration",
      `spelling ${JSON.stringify(name)} must bill to the canonical contact`,
    );
  }
});

Deno.test("an AJBR reference wins over whatever label the caller passed", () => {
  // Reference shapes seen live, including the SES-suffixed and space-separated forms.
  for (
    const ref of [
      "AJBR-70781",
      "AJBR 67457",
      "AJBR-70271 | SES-bb5c7017-9105-54ad-909e-08fb0cfb488d",
      "AJBR-70488",
    ]
  ) {
    assertEquals(
      canonicalMakesafeInvoiceContactName(ref, "aj"),
      "AJ Building & Restoration",
      `reference ${ref} must resolve to the canonical contact`,
    );
  }
});

Deno.test("AJS is a different builder and must NOT be swept into AJ", () => {
  // This is why the rule keys on AJBR and never a bare "AJ". AJS Group has its
  // own Xero contact; canonicalising it into AJ Building & Restoration would be
  // the same bug pointed the other way.
  assertEquals(canonicalMakesafeInvoiceContactName("AJS-123", "AJS Group"), "AJS Group");
  assertEquals(canonicalMakesafeInvoiceContactName("AJS-456", "aj s group"), "aj s group");
  // A person whose name merely starts with the letters.
  assertEquals(canonicalMakesafeInvoiceContactName("", "Ajay Unni"), "Ajay Unni");
  // A longer contact CONTAINING the alias is not an exact alias match. Its own
  // AJBR reference still routes it, which is correct: new AJBR work bills to the
  // live contact, not this legacy March-2026 entity.
  assertEquals(
    canonicalMakesafeInvoiceContactName("", "Insurebuild Pty Ltd WA (AJ Building & Restoration)"),
    "Insurebuild Pty Ltd WA (AJ Building & Restoration)",
  );
});

Deno.test("builders with no rule are returned untouched", () => {
  assertEquals(canonicalMakesafeInvoiceContactName("BW-1", "Builderwest Pty Ltd"), "Builderwest Pty Ltd");
  assertEquals(canonicalMakesafeInvoiceContactName("KBA-9", "KBA Insurance Repairs"), "KBA Insurance Repairs");
  assertEquals(canonicalMakesafeInvoiceContactName("WB-2", "Western Building"), "Western Building");
});

Deno.test("empty contact stays empty so callers still fail closed", () => {
  // createMakesafeDraftInvoice throws 'contact_name required' on a falsy contact.
  // Canonicalising must not invent a contact out of nothing when there is also
  // no MLB reference to justify it.
  assertEquals(canonicalMakesafeInvoiceContactName("", ""), "");
  assertEquals(canonicalMakesafeInvoiceContactName(null, null), "");
});

Deno.test("display name falls back through requested then company", () => {
  assertEquals(canonicalMakesafeBuilderDisplayName("MLB-26003", "mlb", "ML Builders"), "Major Loss Builders");
  assertEquals(canonicalMakesafeBuilderDisplayName("AJBR-1", null, "AJ Building & Restoration"), "AJ Building & Restoration");
  assertEquals(canonicalMakesafeBuilderDisplayName("", null, null), "");
});
