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
  await attachPdfToXeroInvoice({
    ...input,
    filename,
    pdfBytes,
  });
  return { filename, bytes: pdfBytes.length };
}
