// Shared Xero invoice/bill PDF attach. Used by the trade submit path
// (so a tax invoice cannot be skipped after the ACCPAY draft is created)
// and by the Books supplier-bill door.

export const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";
export const MAX_XERO_PDF_BYTES = 5 * 1024 * 1024;

export class XeroPdfAttachError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "PDF_ATTACH_INVALID") {
    super(message);
    this.name = "XeroPdfAttachError";
    this.status = status;
    this.code = code;
  }
}

export function sanitizeXeroPdfFilename(raw: unknown, fallback = "invoice"): string {
  const cleaned = String(raw || "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  const base = cleaned || fallback;
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

/**
 * Xero PUT /Attachments/{name} replaces any prior file of that name.
 * Audit and client PDFs must never share a stem, or Books only sees the last PUT.
 */
export function distinctXeroPdfFilenames(invoiceNumber: unknown): {
  audit: string;
  client: string;
} {
  const stem = sanitizeXeroPdfFilename(invoiceNumber || "trade-invoice")
    .replace(/\.pdf$/i, "")
    .slice(0, 100) || "trade-invoice";
  return {
    audit: `${stem}-audit.pdf`,
    client: `${stem}-submitted.pdf`,
  };
}

export function hasXeroPdfBase64Payload(raw: unknown): boolean {
  const pdfBase64 = String(raw || "")
    .replace(/^data:application\/pdf;base64,/i, "")
    .replace(/\s/g, "");
  return pdfBase64.length > 0;
}

export const XERO_PDF_ATTACH_ATTEMPTS = 3;

export function decodePdfBase64(raw: unknown): Uint8Array<ArrayBuffer> {
  const pdfBase64 = String(raw || "")
    .replace(/^data:application\/pdf;base64,/i, "")
    .replace(/\s/g, "");
  if (!pdfBase64) {
    throw new XeroPdfAttachError("PDF payload is required", 400);
  }
  if (pdfBase64.length > Math.ceil(MAX_XERO_PDF_BYTES * 4 / 3) + 16) {
    throw new XeroPdfAttachError("PDF payload size is invalid", 413);
  }
  let pdfBytes: Uint8Array<ArrayBuffer>;
  try {
    const decoded = Uint8Array.from(atob(pdfBase64), (c: string) => c.charCodeAt(0));
    pdfBytes = new Uint8Array(decoded.byteLength);
    pdfBytes.set(decoded);
  } catch {
    throw new XeroPdfAttachError("Invalid PDF payload", 400);
  }
  if (pdfBytes.length === 0 || pdfBytes.length > MAX_XERO_PDF_BYTES) {
    throw new XeroPdfAttachError("PDF payload size is invalid", 413);
  }
  if (String.fromCharCode(...pdfBytes.slice(0, 5)) !== "%PDF-") {
    throw new XeroPdfAttachError("PDF payload must be a PDF document", 400);
  }
  return pdfBytes;
}

export async function attachPdfToXeroInvoice(input: {
  invoiceId: string;
  filename: string;
  pdfBytes: Uint8Array<ArrayBuffer>;
  accessToken: string;
  tenantId: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const invoiceId = String(input.invoiceId || "").trim();
  if (!invoiceId) {
    throw new XeroPdfAttachError("xero invoice id required", 400);
  }
  const filename = sanitizeXeroPdfFilename(input.filename);
  const fetchImpl = input.fetchImpl || fetch;
  const attachRes = await fetchImpl(
    `${XERO_API_BASE}/Invoices/${
      encodeURIComponent(invoiceId)
    }/Attachments/${encodeURIComponent(filename)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Xero-tenant-id": input.tenantId,
        "Content-Type": "application/pdf",
        "Content-Length": String(input.pdfBytes.length),
      },
      body: input.pdfBytes,
    },
  );
  if (!attachRes.ok) {
    const errText = await attachRes.text();
    throw new XeroPdfAttachError(
      `Xero attachment failed: ${attachRes.status} ${errText}`.slice(0, 500),
      attachRes.status >= 400 && attachRes.status < 600 ? attachRes.status : 502,
      "XERO_PDF_ATTACH_FAILED",
    );
  }
}

function isRetryablePdfAttachError(error: unknown): boolean {
  if (!(error instanceof XeroPdfAttachError)) return true;
  if (error.status === 429) return true;
  return error.status >= 500 || error.status === 0;
}

export async function attachPdfToXeroInvoiceUntilAttached(
  input: Parameters<typeof attachPdfToXeroInvoice>[0] & {
    attempts?: number;
  },
): Promise<void> {
  const attempts = Math.max(1, input.attempts ?? XERO_PDF_ATTACH_ATTEMPTS);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await attachPdfToXeroInvoice(input);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryablePdfAttachError(error) || attempt === attempts) {
        throw error;
      }
    }
  }
  throw lastError;
}

export async function attachPdfBase64ToXeroInvoice(input: {
  invoiceId: string;
  filename: string;
  pdfBase64: unknown;
  accessToken: string;
  tenantId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ filename: string; bytes: number }> {
  const pdfBytes = decodePdfBase64(input.pdfBase64);
  const filename = sanitizeXeroPdfFilename(input.filename);
  await attachPdfToXeroInvoiceUntilAttached({
    ...input,
    filename,
    pdfBytes,
  });
  return { filename, bytes: pdfBytes.length };
}

/** Attach when bytes exist. Returns false when there were never any bytes. Throws if bytes exist but attach fails. */
export async function attachTradeInvoicePdfIfPresent(input: {
  invoiceId: string;
  filename: string;
  pdfBase64: unknown;
  accessToken: string;
  tenantId: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  if (!hasXeroPdfBase64Payload(input.pdfBase64)) return false;
  await attachPdfBase64ToXeroInvoice(input);
  return true;
}
