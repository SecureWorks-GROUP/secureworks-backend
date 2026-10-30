// Read-only doors for one posted Xero record: its History and Notes (who
// created or changed it, and when) and its attachments. No writes. Attachment
// content is limited to PDFs and images within a fixed size.
import {
  type GetTokenFn,
  SupplierBillError,
  type XeroGetFn,
} from "./xero_accpay_books.ts";
import { LINE_CORRECTION_KINDS } from "./xero_line_corrections.ts";

type Row = Record<string, any>;
export type XeroGetBinaryFn = (
  path: string,
  accessToken: string,
  tenantId: string,
  accept: string,
) => Promise<{ bytes: Uint8Array; contentType: string | null }>;
export type RecordReadDeps = {
  getToken: GetTokenFn;
  xeroGet: XeroGetFn;
  xeroGetBinary?: XeroGetBinaryFn;
};
export const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
const ATTACHMENT_TYPES = /^(application\/pdf|image\/(png|jpeg|gif|webp|tiff))$/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireValue(
  ok: unknown,
  message: string,
  code = "XERO_READ_INVALID",
  status = 400,
): asserts ok {
  if (!ok) throw new SupplierBillError(message, status, code);
}

function target(params: URLSearchParams) {
  const kind = params.get("kind") || "";
  const id = params.get("id") || "";
  requireValue(
    Object.hasOwn(LINE_CORRECTION_KINDS, kind),
    "kind must be invoice, credit_note or bank_transaction",
  );
  requireValue(uuid.test(id), "Record UUID required");
  return {
    kind,
    id,
    path: `${LINE_CORRECTION_KINDS[kind].path}/${encodeURIComponent(id)}`,
  };
}

export async function readXeroHistory(
  client: any,
  params: URLSearchParams,
  deps: RecordReadDeps,
) {
  const { kind, id, path } = target(params);
  const { accessToken, tenantId } = await deps.getToken(client);
  const response = await deps.xeroGet(`${path}/History`, accessToken, tenantId);
  requireValue(
    Array.isArray(response?.HistoryRecords),
    "Xero returned no history list",
    "XERO_RESPONSE_INVALID",
    502,
  );
  return {
    ok: true,
    kind,
    id,
    tenant_id: tenantId,
    records: response.HistoryRecords.map((r: Row) => ({
      date_utc: r.DateUTCString ?? r.DateUTC ?? null,
      user: r.User ?? null,
      changes: r.Changes ?? null,
      details: r.Details ?? null,
    })),
  };
}

async function attachmentList(
  path: string,
  accessToken: string,
  tenantId: string,
  deps: RecordReadDeps,
): Promise<Row[]> {
  const response = await deps.xeroGet(
    `${path}/Attachments`,
    accessToken,
    tenantId,
  );
  requireValue(
    Array.isArray(response?.Attachments),
    "Xero returned no attachment list",
    "XERO_RESPONSE_INVALID",
    502,
  );
  return response.Attachments.map((a: Row) => ({
    attachment_id: a.AttachmentID ?? null,
    file_name: a.FileName ?? null,
    mime_type: a.MimeType ?? null,
    content_length: a.ContentLength ?? null,
  }));
}

export async function listXeroAttachments(
  client: any,
  params: URLSearchParams,
  deps: RecordReadDeps,
) {
  const { kind, id, path } = target(params);
  const { accessToken, tenantId } = await deps.getToken(client);
  return {
    ok: true,
    kind,
    id,
    tenant_id: tenantId,
    attachments: await attachmentList(path, accessToken, tenantId, deps),
  };
}

export async function getXeroAttachment(
  client: any,
  params: URLSearchParams,
  deps: RecordReadDeps,
) {
  const { kind, id, path } = target(params);
  const attachmentId = params.get("attachment_id") || "";
  requireValue(uuid.test(attachmentId), "Attachment UUID required");
  requireValue(deps.xeroGetBinary, "Binary reads unavailable", "XERO_READ_INVALID", 500);
  const { accessToken, tenantId } = await deps.getToken(client);
  // Check type and size from Xero's own listing before downloading anything.
  const meta = (await attachmentList(path, accessToken, tenantId, deps))
    .find((a) => a.attachment_id === attachmentId);
  requireValue(meta, "Attachment is not on this record", "ATTACHMENT_NOT_FOUND", 404);
  requireValue(
    ATTACHMENT_TYPES.test(meta.mime_type || ""),
    "Only PDF and image attachments can be read",
    "ATTACHMENT_TYPE_UNSUPPORTED",
    415,
  );
  requireValue(
    typeof meta.content_length === "number" &&
      meta.content_length <= ATTACHMENT_MAX_BYTES,
    "Attachment is larger than 4 MiB",
    "ATTACHMENT_TOO_LARGE",
    413,
  );
  const { bytes } = await deps.xeroGetBinary(
    `${path}/Attachments/${encodeURIComponent(attachmentId)}`,
    accessToken,
    tenantId,
    meta.mime_type,
  );
  requireValue(
    bytes.length <= ATTACHMENT_MAX_BYTES,
    "Attachment is larger than 4 MiB",
    "ATTACHMENT_TOO_LARGE",
    413,
  );
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return {
    ok: true,
    kind,
    id,
    tenant_id: tenantId,
    attachment_id: attachmentId,
    file_name: meta.file_name,
    mime_type: meta.mime_type,
    content_length: bytes.length,
    base64: btoa(binary),
  };
}
