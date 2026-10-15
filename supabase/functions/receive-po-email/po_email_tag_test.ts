// deno-lint-ignore-file no-import-prefix
// The reply reader's tag parser (Dispatch slice 5, docs/dispatch-slice-5-contract.md).
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseEmailTag, parseSubjectForPO } from "./po_email_tag.ts";

Deno.test("tag: a Dispatch order on a repair job parses as that order and job", () => {
  assertEquals(
    parseEmailTag("orders+PO-1000001-SWR-261499@secureworksgroup.app"),
    {
      poNumber: "PO-1000001",
      jobNumber: "SWR-261499",
    },
  );
});

Deno.test("tag: the shapes read before still read the same", () => {
  assertEquals(
    parseEmailTag("orders+PO-467989-SWP-25008@secureworksgroup.app"),
    {
      poNumber: "PO-467989",
      jobNumber: "SWP-25008",
    },
  );
  assertEquals(parseEmailTag("orders+PO001-SWP25019@secureworksgroup.app"), {
    poNumber: "PO001",
    jobNumber: "SWP25019",
  });
  assertEquals(parseEmailTag("orders+PO-467989@secureworksgroup.app"), {
    poNumber: "PO-467989",
    jobNumber: null,
  });
  assertEquals(
    parseEmailTag("orders+PO-683376-SWF-26824@secureworksgroup.app"),
    {
      poNumber: "PO-683376",
      jobNumber: "SWF-26824",
    },
  );
  assertEquals(parseEmailTag("someone@example.com"), {
    poNumber: null,
    jobNumber: null,
  });
});

Deno.test("tag: other SW job prefixes of one to three letters parse too", () => {
  assertEquals(
    parseEmailTag("orders+PO-1000002-SWMS-26898@secureworksgroup.app")
      .jobNumber,
    "SWMS-26898",
  );
  assertEquals(
    parseEmailTag("orders+PO-1000003-SWD-26001@secureworksgroup.app").jobNumber,
    "SWD-26001",
  );
});

Deno.test("subject: the order number with or without its hyphen", () => {
  assertEquals(
    parseSubjectForPO("Re: Purchase order PO-1000001 for SWF-261525"),
    "PO-1000001",
  );
  assertEquals(parseSubjectForPO("Re: PO467989 delivery"), "PO467989");
  assertEquals(parseSubjectForPO("Re: delivery"), null);
  assertEquals(parseSubjectForPO("PO-12 too short"), null);
});
