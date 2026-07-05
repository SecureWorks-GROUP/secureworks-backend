// ════════════════════════════════════════════════════════════
// MATERIALS EMAIL ENRICHMENT + DEEP-READ SCAFFOLD TESTS (U3 SECONDARY)
//
// Pure-Deno, no network (the Graph fetcher is a stub). Proves the supplier-invoice
// parser recovers a printed job ref + invoice number + amount, that enrichment
// never fabricates a fact, and that the archive pagination loop honours its
// maxMessages cap and sinceIso floor.
//
// RUN:
//   ~/.deno/bin/deno test --no-check --allow-none \
//     supabase/functions/xero-sync/materials_email_enrich_test.ts
// ════════════════════════════════════════════════════════════

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  enrichBill,
  type GraphPage,
  paginateGraphMessages,
  parseSupplierInvoiceText,
} from "./materials_email_enrich.ts";

Deno.test("parseSupplierInvoiceText — FWWA tax invoice", () => {
  const text = `Fencing Warehouse WA
Tax Invoice 80012345
Account 001185
Job SWF-25010
Subtotal (ex GST)  $1,000.00
GST                $100.00
Total Due          $1,100.00`;
  const p = parseSupplierInvoiceText(text);
  assertEquals(p.supplierClass, "fwwa");
  assertEquals(p.invoiceNumber, "80012345");
  assertEquals(p.jobRef, "SWF-25010"); // ref discipline recovered from the PDF
  assertEquals(p.amountExGst, 1000);
  assertEquals(p.amountIncGst, 1100);
});

Deno.test("parseSupplierInvoiceText — B&D Metals with embedded make-safe ref", () => {
  const text = `B & D Metals Group Pty Ltd
INVOICE No: BD-2299
Reference: SWMS-26878
Total (inc GST) $540.00`;
  const p = parseSupplierInvoiceText(text);
  assertEquals(p.supplierClass, "bnd");
  assertEquals(p.jobRef, "SWMS-26878");
  assert(p.invoiceNumber !== null);
});

Deno.test("enrichBill — recovers a job ref ONLY when the Xero bill had none", () => {
  const parsed = parseSupplierInvoiceText("Job SWF-25010\nTotal Due $1,100.00");
  // Xero bill has no reference → recover it.
  const e1 = enrichBill({
    xero_invoice_id: "B1",
    reference: null,
    sub_total: 1000,
    total: 1100,
  }, parsed);
  assertEquals(e1.recoveredJobRef, "SWF-25010");
  // Xero bill already carries a ref → do not override.
  const e2 = enrichBill({
    xero_invoice_id: "B1",
    reference: "SWP-25029",
    sub_total: 1000,
    total: 1100,
  }, parsed);
  assertEquals(e2.recoveredJobRef, null);
});

Deno.test("enrichBill — amount cross-check flags a mismatch, never invents a fact", () => {
  const parsed = parseSupplierInvoiceText("Total Due $1,100.00");
  const ok = enrichBill({
    xero_invoice_id: "B1",
    reference: "SWF-25010",
    sub_total: 1000,
    total: 1100,
  }, parsed);
  assertEquals(ok.amountCrossCheckOk, true);
  const bad = enrichBill({
    xero_invoice_id: "B1",
    reference: "SWF-25010",
    sub_total: 1000,
    total: 2000,
  }, parsed);
  assertEquals(bad.amountCrossCheckOk, false);
  // enrichBill returns signals only — there is no "fact" field on the result.
  assert(!("fact" in (ok as unknown as Record<string, unknown>)));
});

Deno.test("paginateGraphMessages — walks nextLink to exhaustion", async () => {
  const pages: GraphPage[] = [
    {
      value: [{ id: "1", receivedDateTime: "2026-07-05T00:00:00Z" }, {
        id: "2",
        receivedDateTime: "2026-07-04T00:00:00Z",
      }],
      nextLink: "p2",
    },
    {
      value: [{ id: "3", receivedDateTime: "2026-07-03T00:00:00Z" }],
      nextLink: null,
    },
  ];
  let call = 0;
  const fetchPage = (_next: string | null) => Promise.resolve(pages[call++]);
  const msgs = await paginateGraphMessages(fetchPage, {});
  assertEquals(msgs.map((m) => m.id), ["1", "2", "3"]);
});

Deno.test("paginateGraphMessages — maxMessages cap stops early", async () => {
  const fetchPage = (_next: string | null) =>
    Promise.resolve<GraphPage>({
      value: [{ id: "a" }, { id: "b" }, { id: "c" }],
      nextLink: "more",
    });
  const msgs = await paginateGraphMessages(fetchPage, { maxMessages: 2 });
  assertEquals(msgs.length, 2);
});

Deno.test("paginateGraphMessages — sinceIso floor halts at the archive boundary", async () => {
  const pages: GraphPage[] = [
    {
      value: [{ id: "new", receivedDateTime: "2026-07-05T00:00:00Z" }, {
        id: "old",
        receivedDateTime: "2026-05-01T00:00:00Z",
      }],
      nextLink: "p2",
    },
    {
      value: [{ id: "unreached", receivedDateTime: "2026-04-01T00:00:00Z" }],
      nextLink: null,
    },
  ];
  let call = 0;
  const fetchPage = (_next: string | null) => Promise.resolve(pages[call++]);
  const msgs = await paginateGraphMessages(fetchPage, {
    sinceIso: "2026-06-01T00:00:00Z",
  });
  assertEquals(msgs.map((m) => m.id), ["new"]); // stops as soon as it crosses the floor
});
