// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  pgrestIlikeOrContains,
  quotePgrestFilterValue,
} from "./pgrest.ts";

Deno.test("quotePgrestFilterValue wraps reserved characters in one quoted token", () => {
  assertEquals(quotePgrestFilterValue("SWF-261132, SWF-26824"), '"SWF-261132, SWF-26824"');
  assertEquals(quotePgrestFilterValue("SWF-261132"), '"SWF-261132"');
  assertEquals(quotePgrestFilterValue('He said "pay"'), '"He said \\"pay\\""');
  assertEquals(quotePgrestFilterValue("a\\b"), '"a\\\\b"');
});

Deno.test("pgrestIlikeOrContains keeps a comma inside each quoted ILIKE pattern", () => {
  assertEquals(
    pgrestIlikeOrContains(
      ["reference", "invoice_number"],
      "SWF-261132, SWF-26824",
    ),
    'reference.ilike."%SWF-261132, SWF-26824%",invoice_number.ilike."%SWF-261132, SWF-26824%"',
  );
});

Deno.test("listInvoices quotes the reference OR filter instead of interpolating raw text", async () => {
  const index = await Deno.readTextFile(
    new URL("../ops-api/index.ts", import.meta.url),
  );
  const start = index.indexOf("async function listInvoices");
  const end = index.indexOf("async function financeHealthSummary");
  assert(start >= 0 && end > start, "listInvoices slice missing");
  const fn = index.slice(start, end);
  assert(
    !fn.includes("reference.ilike.%${invoiceRef}%"),
    "listInvoices must not interpolate the raw search string into .or()",
  );
  assert(
    fn.includes("pgrestIlikeOrContains"),
    "listInvoices must quote/escape the reference filter via pgrestIlikeOrContains",
  );
});
