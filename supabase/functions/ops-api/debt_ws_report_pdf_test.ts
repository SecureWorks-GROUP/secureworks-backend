// deno-lint-ignore-file no-import-prefix no-explicit-any
// The debt report PDF (debt_ws_report_pdf.ts), drawn with the real jsPDF from the synthetic
// fixture in debt_ws_test_fakes.ts. The PDF's text is read back by inflating its content
// streams, so the test checks what Marnin would read, not the code.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resetDebtWsBankCacheForTest,
  runDebtWsAction,
} from "./debt_ws_actions.ts";
import { fakeDeps, FakeStore, STAFF } from "./debt_ws_test_fakes.ts";
import type { DebtReport } from "./debt_ws_report.ts";
import { renderDebtReportPdf, reportPdfText } from "./debt_ws_report_pdf.ts";

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

async function fixtureReport(store = new FakeStore()): Promise<DebtReport> {
  const { deps } = fakeDeps(store);
  _resetDebtWsBankCacheForTest();
  const res = await runDebtWsAction(
    "debt_ws_report",
    "GET",
    new URLSearchParams(),
    {},
    STAFF,
    deps,
  );
  assertEquals(res.status, 200);
  return (res.body as any).report as DebtReport;
}

Deno.test("report pdf: the summary, the tie to Xero, the companies, every invoice and the notes are all in it", async () => {
  const report = await fixtureReport();
  const pdf = await renderDebtReportPdf(report);
  assert(pdf.pageCount >= 2, `pages: ${pdf.pageCount}`);
  assertEquals(new TextDecoder().decode(pdf.bytes.slice(0, 5)), "%PDF-");
  const text = await pdfText(pdf.bytes);
  for (
    const expected of [
      "SECUREWORKS GROUP",
      "Debt position",
      "CASH AT BANK (ALL ACCOUNTS)",
      "$108,266.51",
      "Total debt",
      "$4,080.00",
      "Adds up to total owed to us",
      "TOTAL OWED TO US",
      "$10,131.00",
      "Operations",
      "Total received",
      "Due in the next 7 days",
      "Major Loss Builders",
      "Not sent yet this week",
      "Every open invoice",
      "INV-2001",
      "Alex Sample",
      "Builderwest Pty Ltd",
      "Key points",
      "Notes",
      `Page 1 of ${pdf.pageCount}`,
    ]
  ) {
    assert(text.includes(expected), `missing from the PDF: ${expected}`);
  }
  assert(/to the cent/.test(text.replace(/\n/g, " ")), "no tie line");
});

Deno.test("report pdf: a long book runs over many pages with every invoice drawn", async () => {
  const store = new FakeStore();
  const base = store.invoices[0];
  for (let i = 0; i < 160; i++) {
    store.invoices.push({
      ...base,
      xero_invoice_id: `10000000-0000-4000-8000-${String(900000 + i).padStart(12, "0")}`,
      invoice_number: `INV-${5000 + i}`,
      contact_name: `Payer Number ${i} With A Rather Long Name For Wrapping`,
      amount_due: 100 + i,
      total: 100 + i,
    });
  }
  const report = await fixtureReport(store);
  assertEquals(report.tie.ok, true);
  const pdf = await renderDebtReportPdf(report);
  assert(pdf.pageCount >= 6, `pages: ${pdf.pageCount}`);
  const text = await pdfText(pdf.bytes);
  for (const n of [5000, 5080, 5159]) {
    assert(text.includes(`INV-${n}`), `INV-${n} missing`);
  }
});

Deno.test("report pdf: text outside the PDF font is replaced, never breaking the file", () => {
  assertEquals(reportPdfText("O\u2019Brien \u2014 caf\u00E9"), "O'Brien - caf\u00E9");
  assertEquals(reportPdfText("\u{1F600}"), "??");
});
