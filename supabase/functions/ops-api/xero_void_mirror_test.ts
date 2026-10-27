// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { voidMirrorPatch } from "./xero_void_mirror.ts";

const ID = "30000000-0000-4000-8000-000000000003";

Deno.test("a void Xero confirms for this invoice is copied, with Xero's record", () => {
  const inv = { InvoiceID: ID, Status: "VOIDED", AmountDue: 0 };
  assertEquals(voidMirrorPatch({ Invoices: [inv] }, ID), {
    status: "VOIDED",
    amount_due: 0,
    raw_json: inv,
  });
  assertEquals(
    voidMirrorPatch({ Invoices: [{ InvoiceID: ID.toUpperCase(), Status: "deleted" }] }, ID)
      ?.status,
    "DELETED",
  );
});

Deno.test("no status is guessed: an answer that does not confirm leaves the copy alone", () => {
  // No invoice in the answer: the old code wrote the status it asked for.
  assertEquals(voidMirrorPatch({}, ID), null);
  assertEquals(voidMirrorPatch(null, ID), null);
  assertEquals(voidMirrorPatch({ Invoices: [] }, ID), null);
  // Another invoice, or a status that is not a void or delete.
  assertEquals(
    voidMirrorPatch({ Invoices: [{ InvoiceID: "30000000-0000-4000-8000-000000000009", Status: "VOIDED" }] }, ID),
    null,
  );
  assertEquals(voidMirrorPatch({ Invoices: [{ InvoiceID: ID, Status: "AUTHORISED" }] }, ID), null);
  assertEquals(voidMirrorPatch({ Invoices: [{ InvoiceID: ID }] }, ID), null);
});
