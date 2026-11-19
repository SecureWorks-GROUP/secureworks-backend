// Shared Xero invoice/bill PDF attach. Used by the trade submit path
// (so a tax invoice cannot be skipped after the ACCPAY draft is created)
// and by the Books supplier-bill door.
import {
  XeroCooldownError,
  xeroRateLimitError,
} from "../_shared/xero_cooldown.ts";

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

export function sanitizeXeroPdfFilename(
  raw: unknown,
  fallback = "invoice",
): string {
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

/** Push may create/reuse an ACCPAY from acknowledged|approved, or retry PDF attach onto an existing bill. */
export function canEnterPushTradeInvoiceToXero(
  status: unknown,
  xeroBillId?: unknown,
): boolean {
  const current = String(status || "");
  if (current === "acknowledged" || current === "approved") return true;
  return current === "pushed_to_xero" &&
    Boolean(String(xeroBillId || "").trim());
}

/** Rows already pushed_to_xero must attach onto the existing xero_bill_id — never mint a second ACCPAY. */
export function mustReuseExistingXeroBillForPdfRetry(status: unknown): boolean {
  return String(status || "") === "pushed_to_xero";
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
    const decoded = Uint8Array.from(
      atob(pdfBase64),
      (c: string) => c.charCodeAt(0),
    );
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
  signal?: AbortSignal;
}): Promise<void> {
  const invoiceId = String(input.invoiceId || "").trim();
  if (!invoiceId) {
    throw new XeroPdfAttachError("xero invoice id required", 400);
  }
  const filename = sanitizeXeroPdfFilename(input.filename);
  const fetchImpl = input.fetchImpl || fetch;
  let attachRes: Response;
  try {
    attachRes = await fetchImpl(
      `${XERO_API_BASE}/Invoices/${encodeURIComponent(invoiceId)}/Attachments/${
        encodeURIComponent(filename)
      }`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Xero-tenant-id": input.tenantId,
          "Content-Type": "application/pdf",
          "Content-Length": String(input.pdfBytes.length),
        },
        body: input.pdfBytes,
        signal: input.signal,
      },
    );
    if (attachRes.status === 429) throw xeroRateLimitError(attachRes);
  } catch (error) {
    if (error instanceof XeroCooldownError) {
      throw new XeroCooldownError(error.message, error.status, error.code, {
        ...error.details,
        provider_operation: "invoice_pdf_attachment",
        xero_invoice_id: invoiceId,
        pdf_attachment_confirmed: false,
      });
    }
    throw error;
  }
  if (!attachRes.ok) {
    const errText = await attachRes.text();
    throw new XeroPdfAttachError(
      `Xero attachment failed: ${attachRes.status} ${errText}`.slice(0, 500),
      attachRes.status >= 400 && attachRes.status < 600
        ? attachRes.status
        : 502,
      "XERO_PDF_ATTACH_FAILED",
    );
  }
}

export const MAX_XERO_FILE_BYTES = 10 * 1024 * 1024;
export const XERO_ATTACHMENT_BUCKET = "expense-receipts";

export type XeroAttachmentEndpoint = "Invoices" | "CreditNotes" | "BankTransactions";
export type XeroAttachmentContentType =
  | "application/pdf"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

const XERO_ENTITY_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isXeroEntityUuid(value: unknown): boolean {
  return XERO_ENTITY_UUID.test(String(value || "").trim());
}

export function sniffXeroAttachmentType(
  bytes: Uint8Array,
): XeroAttachmentContentType | null {
  if (bytes.length >= 5 &&
    bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
    bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return "application/pdf";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 &&
    bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

export function xeroAttachmentFilename(
  raw: string,
  contentType: XeroAttachmentContentType,
): string {
  const extension = contentType === "application/pdf"
    ? "pdf"
    : contentType === "image/jpeg"
    ? "jpg"
    : contentType === "image/png"
    ? "png"
    : "webp";
  // Reuse the existing filename cleaning without appending .pdf to photos.
  const cleaned = sanitizeXeroPdfFilename(raw).replace(/\.pdf$/i, "");
  const suffix = extension === "jpg"
    ? /\.jpe?g$/i
    : new RegExp(`\\.${extension}$`, "i");
  return suffix.test(cleaned) ? cleaned : `${cleaned}.${extension}`;
}

/** Receipt bytes live in the expense-receipts bucket. A path cannot climb out of it. */
export function assertStorageObjectRef(
  bucket: unknown,
  path: unknown,
): { bucket: string; path: string } {
  const chosenBucket = String(bucket || XERO_ATTACHMENT_BUCKET).trim();
  const chosenPath = String(path || "").trim();
  const pathOk = /^[A-Za-z0-9._/-]{1,400}$/.test(chosenPath) &&
    !chosenPath.includes("..") && !chosenPath.startsWith("/");
  if (chosenBucket !== XERO_ATTACHMENT_BUCKET || !pathOk) {
    throw new XeroPdfAttachError("Storage path is invalid", 400, "STORAGE_PATH_INVALID");
  }
  return { bucket: chosenBucket, path: chosenPath };
}

/** File attach for a supplier bill, a supplier credit note, or a bank transaction. Callers prove ownership first. One PUT; a 429 is not retried. */
export async function attachFileToXeroDocument(
  deps: Pick<
    Parameters<typeof attachPdfToXeroInvoice>[0],
    "accessToken" | "tenantId" | "fetchImpl" | "signal"
  >,
  input: {
    endpoint: XeroAttachmentEndpoint;
    documentId: string;
    filename: string;
    bytes: Uint8Array;
    contentType: XeroAttachmentContentType;
  },
): Promise<{ filename: string }> {
  if (input.bytes.length > MAX_XERO_FILE_BYTES) {
    throw new XeroPdfAttachError("File exceeds 10 MB", 413, "FILE_TOO_LARGE");
  }
  if (sniffXeroAttachmentType(input.bytes) !== input.contentType) {
    throw new XeroPdfAttachError(
      "File does not match its type",
      400,
      "FILE_TYPE_NOT_ALLOWED",
    );
  }
  const documentId = String(input.documentId || "").trim();
  if (!documentId ||
    !["Invoices", "CreditNotes", "BankTransactions"].includes(input.endpoint)) {
    throw new XeroPdfAttachError("Xero document id and endpoint required", 400);
  }
  if (!isXeroEntityUuid(documentId)) {
    throw new XeroPdfAttachError(
      "Xero document id must be a UUID",
      400,
      "XERO_ENTITY_ID_INVALID",
    );
  }
  const filename = xeroAttachmentFilename(input.filename, input.contentType);
  const fetchImpl = deps.fetchImpl || fetch;
  const headers = {
    Authorization: `Bearer ${deps.accessToken}`,
    "Xero-tenant-id": deps.tenantId,
    "Content-Type": input.contentType,
    "Content-Length": String(input.bytes.length),
  };
  const body = new Uint8Array(input.bytes);
  // Each URL is a literal so the write register sees the endpoint.
  // A 429 throws once. This function does not retry it.
  const response = input.endpoint === "CreditNotes"
    ? await fetchImpl(
      `${XERO_API_BASE}/CreditNotes/${encodeURIComponent(documentId)}/Attachments/${
        encodeURIComponent(filename)
      }`,
      { method: "PUT", headers, body, signal: deps.signal },
    )
    : input.endpoint === "BankTransactions"
    ? await fetchImpl(
      `${XERO_API_BASE}/BankTransactions/${encodeURIComponent(documentId)}/Attachments/${
        encodeURIComponent(filename)
      }`,
      { method: "PUT", headers, body, signal: deps.signal },
    )
    : await fetchImpl(
      `${XERO_API_BASE}/Invoices/${encodeURIComponent(documentId)}/Attachments/${
        encodeURIComponent(filename)
      }`,
      { method: "PUT", headers, body, signal: deps.signal },
    );
  if (response.status === 429) {
    const limited = xeroRateLimitError(response);
    throw new XeroCooldownError(limited.message, limited.status, limited.code, {
      ...limited.details,
      provider_operation: "document_file_attachment",
      xero_endpoint: input.endpoint,
      xero_document_id: documentId,
    });
  }
  if (!response.ok) {
    throw new XeroPdfAttachError(
      `Xero attachment failed: ${response.status} ${await response.text()}`
        .slice(0, 500),
      response.status >= 400 && response.status < 600 ? response.status : 502,
      "XERO_FILE_ATTACH_FAILED",
    );
  }
  return { filename };
}

function isRetryablePdfAttachError(error: unknown): boolean {
  if (error instanceof XeroCooldownError) return false;
  if (!(error instanceof XeroPdfAttachError)) return true;
  if (error.status === 429) return false;
  return error.status >= 500 || error.status === 0;
}

export async function attachPdfToXeroInvoiceUntilAttached(
  input: Parameters<typeof attachPdfToXeroInvoice>[0] & {
    attempts?: number;
  },
): Promise<void> {
  const attempts = Math.max(1, input.attempts ?? XERO_PDF_ATTACH_ATTEMPTS);
  // Replacing the same named PDF remains retryable for transient failures, but
  // the whole operation must fit inside its120s caller including persistence.
  const deadline = AbortSignal.timeout(90_000);
  const signal = input.signal
    ? AbortSignal.any([input.signal, deadline])
    : deadline;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await attachPdfToXeroInvoice({ ...input, signal });
      return;
    } catch (error) {
      lastError = error;
      if (
        signal.aborted || !isRetryablePdfAttachError(error) ||
        attempt === attempts
      ) {
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
