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

Deno.test("non-MLB builders are returned untouched", () => {
  // AJ has the same slug/label split but no ruling on its canonical spelling.
  // Guessing one here would repeat this bug in the other direction.
  assertEquals(canonicalMakesafeInvoiceContactName("AJBR-70781", "aj"), "aj");
  assertEquals(
    canonicalMakesafeInvoiceContactName("AJBR-70781", "AJ Building & Restoration"),
    "AJ Building & Restoration",
  );
  assertEquals(canonicalMakesafeInvoiceContactName("AJS-123", "AJS Group"), "AJS Group");
  assertEquals(canonicalMakesafeInvoiceContactName("BW-1", "Builderwest Pty Ltd"), "Builderwest Pty Ltd");
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
