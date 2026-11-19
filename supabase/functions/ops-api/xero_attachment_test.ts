// deno-lint-ignore-file no-import-prefix

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  attachFileToXeroDocument,
  attachPdfBase64ToXeroInvoice,
  attachPdfToXeroInvoiceUntilAttached,
  canEnterPushTradeInvoiceToXero,
  decodePdfBase64,
  distinctXeroPdfFilenames,
  hasXeroPdfBase64Payload,
  MAX_XERO_PDF_BYTES,
  mustReuseExistingXeroBillForPdfRetry,
  sanitizeXeroPdfFilename,
  XeroPdfAttachError,
} from "./xero_attachment.ts";
import {
  createXeroCooldownFetch,
  XeroCooldownError,
  type XeroCooldownState,
  type XeroCooldownStore,
} from "../_shared/xero_cooldown.ts";

const BILL_ID = "11111111-1111-4111-8111-111111111111";
const CREDIT_ID = "22222222-2222-4222-8222-222222222222";
const BANK_ID = "33333333-3333-4333-8333-333333333333";

const PDF_BYTES = (() => {
  const encoded = new TextEncoder().encode("%PDF-1.4\n1 0 obj\nendobj\n");
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(encoded);
  return bytes;
})();
const PDF_B64 = btoa(String.fromCharCode(...PDF_BYTES));

Deno.test("file attachment accepts bounded PDF and photos on bills or credit notes, and refuses before dispatch", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const deps = {
    accessToken: "fixture-token",
    tenantId: "fixture-tenant",
    fetchImpl: ((url, init) => {
      calls.push({ url: String(url), init: init! });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
  };
  const jpeg = new Uint8Array(9 * 1024 * 1024);
  jpeg.set([0xff, 0xd8, 0xff]);
  await attachFileToXeroDocument(deps, {
    endpoint: "Invoices",
    documentId: BILL_ID,
    filename: "../receipt photo.jpg",
    bytes: jpeg,
    contentType: "image/jpeg",
  });
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    `https://api.xero.com/api.xro/2.0/Invoices/${BILL_ID}/Attachments/_receipt_photo.jpg`,
  );
  assertEquals(calls[0].init.method, "PUT");
  assertEquals(
    new Headers(calls[0].init.headers).get("Content-Type"),
    "image/jpeg",
  );
  assertEquals(calls[0].init.body, jpeg);

  const png = new Uint8Array(10 * 1024 * 1024);
  png.set([0x89, 0x50, 0x4e, 0x47]);
  await attachFileToXeroDocument(deps, {
    endpoint: "CreditNotes",
    documentId: CREDIT_ID,
    filename: "receipt.png",
    bytes: png,
    contentType: "image/png",
  });
  assertEquals(calls.length, 2);
  assertEquals(
    calls[1].url,
    `https://api.xero.com/api.xro/2.0/CreditNotes/${CREDIT_ID}/Attachments/receipt.png`,
  );
  assertEquals(
    new Headers(calls[1].init.headers).get("Content-Type"),
    "image/png",
  );
  await attachFileToXeroDocument(deps, {
    endpoint: "CreditNotes",
    documentId: CREDIT_ID,
    filename: "credit",
    bytes: PDF_BYTES,
    contentType: "application/pdf",
  });
  assertEquals(calls[2].url.endsWith("/Attachments/credit.pdf"), true);
  assertEquals(
    new Headers(calls[2].init.headers).get("Content-Type"),
    "application/pdf",
  );

  const rejected = async (
    bytes: Uint8Array,
    contentType: "application/pdf" | "image/jpeg" | "image/png",
    code: string,
  ) => {
    const error = await assertRejects(() =>
      attachFileToXeroDocument(deps, {
        endpoint: "Invoices",
        documentId: BILL_ID,
        filename: "receipt",
        bytes,
        contentType,
      }), XeroPdfAttachError);
    assertEquals(error.code, code);
    assertEquals(calls.length, 3);
  };
  await rejected(
    new Uint8Array(11 * 1024 * 1024),
    "image/jpeg",
    "FILE_TOO_LARGE",
  );
  for (const type of ["application/pdf", "image/jpeg", "image/png"] as const) {
    await rejected(new Uint8Array(), type, "FILE_TYPE_NOT_ALLOWED");
    await rejected(
      new Uint8Array([0, 1, 2, 3, 4]),
      type,
      "FILE_TYPE_NOT_ALLOWED",
    );
  }
  await rejected(PDF_BYTES, "image/jpeg", "FILE_TYPE_NOT_ALLOWED");
  await rejected(jpeg, "image/png", "FILE_TYPE_NOT_ALLOWED");
});

Deno.test("file attachment surfaces refusal once and lets an explicit retry replace the same file", async () => {
  let calls = 0;
  const urls: string[] = [];
  const deps = {
    accessToken: "fixture-token",
    tenantId: "fixture-tenant",
    fetchImpl: ((url) => {
      urls.push(String(url));
      return Promise.resolve(
        ++calls === 1
          ? new Response(null, {
            status: 429,
            headers: { "Retry-After": "60" },
          })
          : new Response("{}", { status: 200 }),
      );
    }) as typeof fetch,
  };
  const input = {
    endpoint: "Invoices" as const,
    documentId: BILL_ID,
    filename: "receipt.pdf",
    bytes: PDF_BYTES,
    contentType: "application/pdf" as const,
  };
  await assertRejects(
    () => attachFileToXeroDocument(deps, input),
    XeroCooldownError,
  );
  assertEquals(calls, 1);
  await attachFileToXeroDocument(deps, input);
  assertEquals(calls, 2);
  assertEquals(urls[0], urls[1]);
  deps.fetchImpl = (() => {
    calls++;
    return Promise.resolve(new Response("unavailable", { status: 502 }));
  }) as typeof fetch;
  const error = await assertRejects(
    () => attachFileToXeroDocument(deps, input),
    XeroPdfAttachError,
  );
  assertEquals(error.status, 502);
  assertEquals(calls, 3);
});

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
    assertEquals(
      (error as XeroPdfAttachError).message.includes("must be a PDF"),
      true,
    );
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
  assertEquals(
    sanitizeXeroPdfFilename("SW-INV Israel.pdf"),
    "SW-INV_Israel.pdf",
  );
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
  const fetchImpl = ((url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method || "GET"),
      contentType: String(
        (init?.headers as Record<string, string>)?.["Content-Type"] || "",
      ),
    });
    return Promise.resolve(new Response("{}", { status: 200 }));
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
  const fetchImpl = (() => {
    calls += 1;
    if (calls < 3) {
      return Promise.resolve(new Response("busy", { status: 502 }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
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

Deno.test("PDF429 is attempted once, persists shared hold and blocks later attachment writes", async () => {
  let state: XeroCooldownState | null = null;
  const store: XeroCooldownStore = {
    read: () => Promise.resolve(structuredClone(state)),
    compareAndSwap: (_scope, expected, next) => {
      if ((state?.revision ?? null) !== expected) return Promise.resolve(false);
      state = structuredClone(next);
      return Promise.resolve(true);
    },
  };
  let calls = 0;
  const fetchImpl = createXeroCooldownFetch({
    store,
    orgId: "fixture-org",
    appKey: "fixture-app",
    timeoutMs: 90_000,
    fetchFn: (_url, init) => {
      calls++;
      assertEquals(init?.method, "PUT");
      assertEquals(init?.body, PDF_BYTES);
      return Promise.resolve(
        new Response(null, {
          status: 429,
          headers: {
            "Retry-After": "19079",
            "Xero-Correlation-Id": "pdf-request",
          },
        }),
      );
    },
  });
  const attach = () =>
    attachPdfToXeroInvoiceUntilAttached({
      invoiceId: "bill-1",
      filename: "audit.pdf",
      pdfBytes: PDF_BYTES,
      accessToken: "fixture-token",
      tenantId: "fixture-tenant",
      fetchImpl,
    });
  const first = await assertRejects(attach, XeroCooldownError);
  assertEquals(first.details.provider_call_made, true);
  assertEquals(first.details.request_id, "pdf-request");
  assertEquals(first.details.xero_invoice_id, "bill-1");
  assertEquals(first.details.provider_operation, "invoice_pdf_attachment");
  assertEquals(first.details.pdf_attachment_confirmed, false);
  const held = await assertRejects(attach, XeroCooldownError);
  assertEquals(held.details.provider_call_made, false);
  assertEquals(held.code, "XERO_COOLDOWN_ACTIVE");
  assertEquals(calls, 1);
});

Deno.test("PDF attach does not retry an invalid payload as success", async () => {
  const fetchImpl =
    (() =>
      Promise.resolve(new Response("bad", { status: 400 }))) as typeof fetch;
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

Deno.test("push can retry PDF attach onto an existing bill after pushed_to_xero", () => {
  assertEquals(canEnterPushTradeInvoiceToXero("acknowledged", null), true);
  assertEquals(canEnterPushTradeInvoiceToXero("approved", ""), true);
  assertEquals(
    canEnterPushTradeInvoiceToXero("pushed_to_xero", "bill-1"),
    true,
  );
  assertEquals(canEnterPushTradeInvoiceToXero("pushed_to_xero", "  "), false);
  assertEquals(canEnterPushTradeInvoiceToXero("pushed_to_xero", null), false);
  assertEquals(canEnterPushTradeInvoiceToXero("paid", "bill-1"), false);
  assertEquals(mustReuseExistingXeroBillForPdfRetry("pushed_to_xero"), true);
  assertEquals(mustReuseExistingXeroBillForPdfRetry("approved"), false);
});

Deno.test("bank transaction and webp attachments require a UUID and do not retry a 429", async () => {
  const calls: string[] = [];
  const deps = {
    accessToken: "fixture-token",
    tenantId: "fixture-tenant",
    fetchImpl: ((url) => {
      calls.push(String(url));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
  };
  const webp = new Uint8Array(12);
  webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  await attachFileToXeroDocument(deps, {
    endpoint: "BankTransactions",
    documentId: BANK_ID,
    filename: "ZZTEST receipt.webp",
    bytes: webp,
    contentType: "image/webp",
  });
  assertEquals(
    calls,
    [`https://api.xero.com/api.xro/2.0/BankTransactions/${BANK_ID}/Attachments/ZZTEST_receipt.webp`],
  );
  const refused = await assertRejects(
    () =>
      attachFileToXeroDocument(deps, {
        endpoint: "BankTransactions",
        documentId: "ZZTEST-not-a-uuid",
        filename: "receipt.webp",
        bytes: webp,
        contentType: "image/webp",
      }),
    XeroPdfAttachError,
  );
  assertEquals(refused.code, "XERO_ENTITY_ID_INVALID");
  assertEquals(calls.length, 1);
  let limited = 0;
  deps.fetchImpl = (() => {
    limited += 1;
    return Promise.resolve(new Response(null, { status: 429, headers: { "Retry-After": "30" } }));
  }) as typeof fetch;
  const once = () =>
    attachFileToXeroDocument(deps, {
      endpoint: "BankTransactions",
      documentId: BANK_ID,
      filename: "receipt.webp",
      bytes: webp,
      contentType: "image/webp",
    });
  await assertRejects(once, XeroCooldownError);
  assertEquals(limited, 1);
});
