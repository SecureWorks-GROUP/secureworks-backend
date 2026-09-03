// deno-lint-ignore-file no-import-prefix

import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  attachPdfBase64ToXeroInvoice,
  attachPdfToXeroInvoiceUntilAttached,
  decodePdfBase64,
  distinctXeroPdfFilenames,
  hasXeroPdfBase64Payload,
  MAX_XERO_PDF_BYTES,
  sanitizeXeroPdfFilename,
  XeroPdfAttachError,
} from "./xero_attachment.ts";

const PDF_BYTES = (() => {
  const encoded = new TextEncoder().encode("%PDF-1.4\n1 0 obj\nendobj\n");
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(encoded);
  return bytes;
})();
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

Deno.test("audit and client PDFs never share a Xero attachment name", () => {
  const names = distinctXeroPdfFilenames("SW-INV-I-260828-001");
  assertEquals(names.audit, "SW-INV-I-260828-001-audit.pdf");
  assertEquals(names.client, "SW-INV-I-260828-001-submitted.pdf");
  assertEquals(names.audit === names.client, false);
  const sameAsSanitize = sanitizeXeroPdfFilename("SW-INV-I-260828-001");
  assertEquals(names.audit === sameAsSanitize, false);
  assertEquals(names.client === sameAsSanitize, false);
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

Deno.test("hasXeroPdfBase64Payload is false when there were never any bytes", () => {
  assertEquals(hasXeroPdfBase64Payload(undefined), false);
  assertEquals(hasXeroPdfBase64Payload(""), false);
  assertEquals(hasXeroPdfBase64Payload("   "), false);
  assertEquals(hasXeroPdfBase64Payload(PDF_B64), true);
});

Deno.test("PDF attach retries transient Xero failures then succeeds", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls < 3) return new Response("busy", { status: 502 });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  await attachPdfToXeroInvoiceUntilAttached({
    invoiceId: "bill-1",
    filename: "audit.pdf",
    pdfBytes: PDF_BYTES,
    accessToken: "token",
    tenantId: "tenant",
    fetchImpl,
  });
  assertEquals(calls, 3);
});

Deno.test("PDF attach does not retry an invalid payload as success", async () => {
  const fetchImpl = (async () => new Response("bad", { status: 400 })) as typeof fetch;
  try {
    await attachPdfBase64ToXeroInvoice({
      invoiceId: "bill-1",
      filename: "audit.pdf",
      pdfBase64: PDF_B64,
      accessToken: "token",
      tenantId: "tenant",
      fetchImpl,
    });
    throw new Error("expected throw");
  } catch (error) {
    assertEquals(error instanceof XeroPdfAttachError, true);
    assertEquals((error as XeroPdfAttachError).status, 400);
  }
});

