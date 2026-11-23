import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildTradeWorkOrderBrief,
  layoutTradeWorkOrderBrief,
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


Deno.test("layout: facts from the header, one item per task or piece of equipment, no money", () => {
  const brief = buildTradeWorkOrderBrief([
    "Work Order",
    "Work Order Assigned Our Company Pty Ltd Work Order Number ABC-100PO-200",
    "Job Number ABC-100 Date 23/11/2026",
    "Supervisor Name Sam Person Supervisor Contact 0400 000 000",
    "Policyholders Name A CLIENT",
    "Insurer Name An Insurer Pty Ltd",
    "Additional",
    "Notes/Instructions:",
    "ABC-100PO-200",
    "Restoration",
    "Restoration - TO BE COMPLETED",
    "Restoration - Labour Rate",
    "2x Qualified Technicians at $60 per tech, per hour Hallway and Bathroom - Protect floors - Strip wall lining to about 1.6m",
    "high - Install drying equipment",
    "Equipment - Air Mover (per day)",
    "Qty: 3 Days: 5",
    "RCD safety box hire",
    "Qty: 2",
    "Days: 5",
    "Cost: $3.50",
    "Restoration - Labour Rate",
    "Equipment removal: final readings, collect equipment",
    "A Builder Pty Ltd",
    "39 Some Way Malaga WA 6090",
    "Totals Totals",
    "Subtotal $2,430.00",
    "PLEASE NOTE",
    "terms",
  ].join("\n"));
  const layout = layoutTradeWorkOrderBrief(brief);
  assertEquals(layout?.facts, [
    { label: "Builder work order", value: "ABC-100PO-200" },
    { label: "Issued", value: "23/11/2026" },
    { label: "Builder supervisor", value: "Sam Person, 0400 000 000" },
    { label: "Insurer", value: "An Insurer Pty Ltd" },
  ]);
  assertEquals(layout?.items, [
    {
      title: "Hallway and Bathroom",
      lines: ["Protect floors", "Strip wall lining to about 1.6m high", "Install drying equipment"],
      crew: "2 technicians",
    },
    { title: "Air Mover", lines: [], qty: "3, for 5 days" },
    { title: "RCD safety box hire", lines: [], qty: "2, for 5 days" },
    { title: "Equipment removal", lines: ["final readings, collect equipment"] },
  ]);
  assertEquals(JSON.stringify(layout).includes("$"), false);
  // A layout it does not know answers null, and the plain text is shown.
  assertEquals(layoutTradeWorkOrderBrief("Please fix the fence.\nThanks"), null);
});
