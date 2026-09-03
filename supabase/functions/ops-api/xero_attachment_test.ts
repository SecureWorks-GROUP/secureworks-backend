// deno-lint-ignore-file no-import-prefix

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  attachPdfBase64ToXeroInvoice,
  decodePdfBase64,
  MAX_XERO_PDF_BYTES,
  sanitizeXeroPdfFilename,
  XeroPdfAttachError,
} from "./xero_attachment.ts";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n1 0 obj\nendobj\n");
const PDF_B64 = btoa(String.fromCharCode(...PDF_BYTES));

Deno.test("decodePdfBase64 accepts a bounded PDF and rejects junk", () => {
  const bytes = decodePdfBase64(PDF_B64);
  assertEquals(bytes[0], 37);
  assertEquals(String.fromCharCode(...bytes.slice(0, 5)), "%PDF-");
});

Deno.test("decodePdfBase64 rejects a non-PDF payload before any Xero call", () => {
  try {
    decodePdfBase64(btoa("hello"));
    throw new Error("expected throw");
  } catch (error) {
    assertEquals(error instanceof XeroPdfAttachError, true);
    assertEquals((error as XeroPdfAttachError).message.includes("must be a PDF"), true);
  }
});

Deno.test("decodePdfBase64 rejects an oversized payload", () => {
  const tooBig = "A".repeat(Math.ceil(MAX_XERO_PDF_BYTES * 4 / 3) + 20);
  try {
    decodePdfBase64(tooBig);
    throw new Error("expected throw");
  } catch (error) {
    assertEquals((error as XeroPdfAttachError).status, 413);
  }
});

Deno.test("sanitizeXeroPdfFilename keeps a safe .pdf name", () => {
  assertEquals(sanitizeXeroPdfFilename("SW-INV Israel.pdf"), "SW-INV_Israel.pdf");
  assertEquals(sanitizeXeroPdfFilename("tax invoice"), "tax_invoice.pdf");
});

Deno.test("attachPdfBase64ToXeroInvoice PUTs the PDF onto the Xero bill", async () => {
  const calls: Array<{ url: string; method: string; contentType: string }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method || "GET"),
      contentType: String((init?.headers as Record<string, string>)?.["Content-Type"] || ""),
    });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const result = await attachPdfBase64ToXeroInvoice({
    invoiceId: "bill-1",
    filename: "Israel-tax-invoice.pdf",
    pdfBase64: PDF_B64,
    accessToken: "token",
    tenantId: "tenant",
    fetchImpl,
  });
  assertEquals(result.filename, "Israel-tax-invoice.pdf");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "PUT");
  assertEquals(calls[0].contentType, "application/pdf");
  assertEquals(calls[0].url.includes("/Invoices/bill-1/Attachments/"), true);
});
