import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildTradeWorkOrderBrief,
  readTradeWorkOrderBriefs,
} from "./trade_work_order_brief.ts";

const SAMPLE = [
  "Work Order",
  "Job Number BLD-1001 Date 20/11/2026",
  "Supervisor Name Sam Example Supervisor Contact 0400 000 000",
  "Policyholders Name Pat Sample",
  "Site Address 1 Test Street, Testville",
  "Notes/Instructions:",
  "Restoration",
  "Restoration",
  "Please attend to provide a quote to dry the wet laundry walls.",
  "DAL: $1k",
  "Labour 3 hours at 90",
  "Subtotal $270.00",
  "GST N/A",
  "Total $270.00",
  "Example Builder Pty Ltd ABN: 00 000 000 000",
  "PLEASE NOTE",
  "By accepting this Offer you agree to pay $500 on breach.",
].join("\n");

Deno.test("work order brief keeps the instructions and drops every money line", () => {
  const out = buildTradeWorkOrderBrief(SAMPLE);
  assertEquals(out.includes("Please attend to provide a quote"), true);
  assertEquals(out.includes("Supervisor Name Sam Example"), true);
  assertEquals(out.includes("$"), false);
  assertEquals(/total|gst|dal:/i.test(out), false);
  assertEquals(out.includes("Labour 3 hours"), false);
  assertEquals(out.includes("ABN"), false);
  assertEquals(out.includes("breach"), false);
  assertEquals(out.split("\n").filter((l) => l === "Restoration").length, 1);
});

Deno.test("a scope line that mentions a rate keeps its words and loses the figure", () => {
  const out = buildTradeWorkOrderBrief([
    "Notes/Instructions:",
    "Restoration - Labour Rate",
    "3x Qualified Technicians at $60 per tech, per hour - Move bedroom furniture out - Uplift carpet and underlay",
    "RCD Safety Box",
    "Qty: 3",
    "Cost: $3.50",
    "Waste Disposal - General (per m3)",
    "Subtotal $3,182.50",
  ].join("\n"));
  assertEquals(out.includes("Move bedroom furniture out"), true);
  assertEquals(out.includes("Uplift carpet and underlay"), true);
  assertEquals(out.includes("3x Qualified Technicians"), true);
  assertEquals(out.includes("$"), false);
  assertEquals(/\b60\b/.test(out), false);
  assertEquals(out.includes("3.50"), false);
  assertEquals(out.includes("3,182"), false);
  assertEquals(out.includes("Qty: 3"), true);
});

Deno.test("work order brief answers nothing for no text", () => {
  assertEquals(buildTradeWorkOrderBrief(null), "");
  assertEquals(buildTradeWorkOrderBrief("   "), "");
});

function fakeClient(rows: unknown[], fail = false) {
  return {
    from() {
      const q: any = {
        select: () => q,
        in: () => q,
        not: () => q,
        limit: () =>
          Promise.resolve(
            fail ? { data: null, error: { message: "boom" } } : { data: rows, error: null },
          ),
      };
      return q;
    },
  };
}

Deno.test("briefs are read by the document's own file hash", async () => {
  const sha = "a".repeat(64);
  const briefs = await readTradeWorkOrderBriefs(
    fakeClient([{ sha256: sha, name: "wo.pdf", pdf_extraction_text: SAMPLE }]),
    [
      { id: "d1", type: "work_order", file_name: "wo.pdf", storage_url: `x/sha256-${sha}.pdf` },
      { id: "d2", type: "quote", file_name: "q.pdf" },
    ],
  );
  assertEquals(briefs.length, 1);
  assertEquals(briefs[0].document_id, "d1");
  assertEquals(briefs[0].text.includes("$"), false);
});

Deno.test("a failed read answers an empty list", async () => {
  const briefs = await readTradeWorkOrderBriefs(fakeClient([], true), [
    { id: "d1", type: "work_order", file_name: "wo.pdf", storage_url: `x/sha256-${"b".repeat(64)}.pdf` },
  ]);
  assertEquals(briefs, []);
});
