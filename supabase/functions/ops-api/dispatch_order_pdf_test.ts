// deno-lint-ignore-file no-import-prefix
// Dispatch slice 5 (docs/dispatch-slice-5-contract.md): the purchase order PDF.
// The fixture is made up. The PDF's text is read back by inflating its content
// streams, so the test checks what a person would read, not the code.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dispatchOrderPdfPath,
  renderDispatchOrderPdf,
} from "./dispatch_order_pdf.ts";
import type { DispatchOrderLine } from "./dispatch_orders.ts";

function lines(n: number): DispatchOrderLine[] {
  return Array.from({ length: n }, (_, i) => ({
    line_id: `c1000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    description: i === 0
      ? "Colorbond sheet 2.1 m (Monument) with a description long enough that it has to wrap onto a second line in the item column"
      : `Material line ${i + 1}`,
    quantity: i + 1,
    unit: i % 2 === 0 ? "ea" : null,
  }));
}

const INPUT = {
  poNumber: "PO-1000001",
  version: 1,
  orderedAt: "2026-10-14T03:00:00Z",
  jobNumber: "SWF-900001",
  supplierName: "Example Steel",
  deliverTo: "1 Example St, Exampleton",
};

// Every string jsPDF drew, in order, from the inflated page streams.
async function pdfText(bytes: Uint8Array): Promise<string> {
  const raw = new TextDecoder("latin1").decode(bytes);
  const out: string[] = [];
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    const chunk = bytes.slice(start, end);
    let text: string;
    try {
      const ds = new Blob([chunk]).stream().pipeThrough(
        new DecompressionStream("deflate"),
      );
      text = new TextDecoder("latin1").decode(
        await new Response(ds).arrayBuffer(),
      );
    } catch {
      text = new TextDecoder("latin1").decode(chunk);
    }
    for (const t of text.matchAll(/\((.*?)(?<!\\)\)\s*Tj/g)) {
      out.push(t[1].replace(/\\([()\\])/g, "$1"));
    }
  }
  return out.join("\n");
}

Deno.test("pdf: 3 lines, the order and job, the quote-back line, every line, and no price, notes, client or phone", async () => {
  const pdf = await renderDispatchOrderPdf({ ...INPUT, lines: lines(3) });
  assertEquals(pdf.lineCount, 3);
  assertEquals(pdf.pageCount, 1);
  const text = await pdfText(pdf.bytes);
  for (
    const expected of [
      "PURCHASE ORDER",
      "SecureWorks Group",
      "orders@secureworksgroup.app",
      "PO-1000001",
      "14/10/2026",
      "SWF-900001",
      "Please quote SWF-900001 on your delivery docket and invoice.",
      "Example Steel",
      "1 Example St, Exampleton",
      "ITEM",
      "QTY",
      "UNIT",
      "Material line 2",
      "Material line 3",
      "Page 1 of 1",
    ]
  ) {
    assert(text.includes(expected), `missing: ${expected}`);
  }
  assert(text.includes("Colorbond sheet 2.1 m (Monument)"));
  for (
    const banned of [
      "$",
      "Price",
      "Total",
      "TOTAL",
      "GST",
      "Notes",
      "Client",
      "Phone",
    ]
  ) {
    assert(!text.includes(banned), `must not print ${banned}`);
  }
});

Deno.test("pdf: 60 lines run onto further pages, head repeated, none cut", async () => {
  const pdf = await renderDispatchOrderPdf({ ...INPUT, lines: lines(60) });
  assertEquals(pdf.lineCount, 60);
  assert(pdf.pageCount >= 2, `pages ${pdf.pageCount}`);
  const text = await pdfText(pdf.bytes);
  const drawn = new Set(text.split("\n"));
  for (let i = 2; i <= 60; i++) {
    assert(drawn.has(`Material line ${i}`), `line ${i}`);
  }
  assertEquals((text.match(/^ITEM$/gm) || []).length, pdf.pageCount);
  assert(text.includes(`Page ${pdf.pageCount} of ${pdf.pageCount}`));
});

Deno.test("pdf: the same order makes the same bytes; another version does not", async () => {
  const a = await renderDispatchOrderPdf({ ...INPUT, lines: lines(60) });
  const b = await renderDispatchOrderPdf({ ...INPUT, lines: lines(60) });
  assertEquals(a.sha256, b.sha256);
  assertEquals(a.bytes, b.bytes);
  const v2 = await renderDispatchOrderPdf({
    ...INPUT,
    version: 2,
    lines: lines(60),
  });
  assert(v2.sha256 !== a.sha256);
  assert((await pdfText(v2.bytes)).includes("Updated, version 2"));
});

Deno.test("pdf: no line is refused, and the path is job, order and version", async () => {
  let threw = false;
  try {
    await renderDispatchOrderPdf({ ...INPUT, lines: [] });
  } catch {
    threw = true;
  }
  assert(threw);
  assertEquals(
    dispatchOrderPdfPath("job-1", "PO-1000001", 2),
    "job-1/PO-1000001-v2.pdf",
  );
});

Deno.test("pdf: a line with no quantity says To confirm in the quantity column", async () => {
  const pdf = await renderDispatchOrderPdf({
    ...INPUT,
    lines: [{ ...lines(1)[0], quantity: null }],
  });
  const text = await pdfText(pdf.bytes);
  assert(text.includes("To confirm"), "missing: To confirm");
});
