// Attach a receipt photo or PDF to one Xero bank transaction.
// Off unless xero_bank_txn_receipt_attach_v1 is on. A 429 is not retried.
import { readSwitch } from "../_shared/switch_cache.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import {
  assertStorageObjectRef,
  attachFileToXeroDocument,
  isXeroEntityUuid,
  MAX_XERO_FILE_BYTES,
  sniffXeroAttachmentType,
  XeroPdfAttachError,
} from "./xero_attachment.ts";
import {
  findAttachedXeroDocument,
  recordXeroDocumentAttachment,
  sha256Hex,
} from "./xero_document_attachment_store.ts";

export const XERO_BANK_TXN_RECEIPT_ATTACH_FLAG = "xero_bank_txn_receipt_attach_v1";
export const BANK_RECEIPT_ATTACH_ACTION = "attach_bank_transaction_receipt";

const ALLOWED_ROLES = new Set(["owner", "admin", "ops_manager", "bookkeeper"]);

export class BankReceiptAttachError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "BANK_RECEIPT_ATTACH_INVALID") {
    super(message);
    this.name = "BankReceiptAttachError";
    this.status = status;
    this.code = code;
  }
}

export function bankReceiptDoorDecision(
  authMode: string,
  role: unknown,
): { ok: true } | { ok: false; status: 403; code: "forbidden"; error: string } {
  const allowed = authMode === "jwt" &&
    ALLOWED_ROLES.has(String(role || "").toLowerCase());
  if (allowed) return { ok: true };
  return {
    ok: false,
    status: 403,
    code: "forbidden",
    error: "Bank transaction receipt attachment is limited to the owner, an admin, an ops manager, or the bookkeeper.",
  };
}

export type BankReceiptCaller = {
  authMode: string;
  role?: string | null;
  orgId?: string | null;
};

export async function attachBankTransactionReceipt(
  client: any,
  body: any,
  deps: {
    caller: BankReceiptCaller;
    getToken: (client: any) => Promise<{ accessToken: string; tenantId: string }>;
    fetchImpl?: typeof fetch;
    downloadStorage?: (bucket: string, path: string) => Promise<Uint8Array>;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const door = bankReceiptDoorDecision(deps.caller.authMode, deps.caller.role);
  if (!door.ok) {
    return { status: door.status, body: { ok: false, code: door.code, error: door.error } };
  }
  try {
    return await attachBankTransactionReceiptInner(client, body, deps);
  } catch (error) {
    if (error instanceof BankReceiptAttachError || error instanceof XeroPdfAttachError) {
      return { status: error.status, body: { ok: false, code: error.code, error: error.message } };
    }
    if (error instanceof XeroCooldownError) {
      return { status: error.status, body: { ok: false, code: error.code, error: error.message } };
    }
    return {
      status: 500,
      body: { ok: false, code: "BANK_RECEIPT_ATTACH_FAILED", error: "Receipt attachment failed" },
    };
  }
}

async function attachBankTransactionReceiptInner(
  client: any,
  body: any,
  deps: {
    caller: BankReceiptCaller;
    getToken: (client: any) => Promise<{ accessToken: string; tenantId: string }>;
    fetchImpl?: typeof fetch;
    downloadStorage?: (bucket: string, path: string) => Promise<Uint8Array>;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const orgId = String(deps.caller.orgId || "").trim();
  if (!isXeroEntityUuid(orgId)) {
    throw new BankReceiptAttachError("Organisation access required", 403, "forbidden");
  }
  if (!await readSwitch(client, XERO_BANK_TXN_RECEIPT_ATTACH_FLAG)) {
    throw new BankReceiptAttachError(
      "Bank transaction receipt attachment is off",
      409,
      "xero_bank_txn_receipt_attach_disabled",
    );
  }

  const requestedId = String(body?.xero_bank_transaction_id || "").trim();
  if (!isXeroEntityUuid(requestedId)) {
    throw new BankReceiptAttachError(
      "xero_bank_transaction_id must be a UUID",
      400,
      "XERO_ENTITY_ID_INVALID",
    );
  }
  const txn = await loadBankTransaction(client, orgId, requestedId);
  if (!txn) {
    throw new BankReceiptAttachError("Bank transaction not found", 404, "BANK_TXN_NOT_FOUND");
  }
  const xeroTxnId = String(txn.xero_txn_id || "").trim();
  if (!isXeroEntityUuid(xeroTxnId)) {
    throw new BankReceiptAttachError(
      "Bank transaction has no Xero id",
      409,
      "XERO_ENTITY_ID_INVALID",
    );
  }

  const located = await locateReceipt(client, orgId, body);
  const bytes = await downloadReceipt(client, located.bucket, located.path, deps.downloadStorage);
  if (bytes.length === 0 || bytes.length > MAX_XERO_FILE_BYTES) {
    throw new BankReceiptAttachError("File exceeds 10 MB", 413, "FILE_TOO_LARGE");
  }
  const contentType = sniffXeroAttachmentType(bytes);
  if (!contentType) {
    throw new BankReceiptAttachError("File does not match its type", 400, "FILE_TYPE_NOT_ALLOWED");
  }
  const fileSha256 = await sha256Hex(bytes);
  const filename = String(body?.file_name || located.path.split("/").pop() || "receipt");
  const key = {
    orgId,
    entityType: "BankTransactions" as const,
    entityId: xeroTxnId,
    fileSha256,
  };
  const existing = await findAttachedXeroDocument(client, key);
  if (existing === "unreadable") {
    throw new BankReceiptAttachError("Attachment audit could not be read", 503, "AUDIT_UNREADABLE");
  }
  if (existing === "attached") {
    return {
      status: 200,
      body: {
        ok: true,
        attached: false,
        skipped: "already_attached",
        xero_bank_transaction_id: xeroTxnId,
        file_sha256: fileSha256,
      },
    };
  }

  const { accessToken, tenantId } = await deps.getToken(client);
  let attachedName = filename;
  try {
    const attached = await attachFileToXeroDocument(
      { accessToken, tenantId, fetchImpl: deps.fetchImpl },
      {
        endpoint: "BankTransactions",
        documentId: xeroTxnId,
        filename,
        bytes,
        contentType,
      },
    );
    attachedName = attached.filename;
  } catch (error) {
    await recordXeroDocumentAttachment(client, {
      ...key,
      fileName: filename.slice(0, 200),
      contentType,
      byteSize: bytes.length,
      status: "failed",
      errorCode: errorCode(error),
    });
    throw error;
  }
  await recordXeroDocumentAttachment(client, {
    ...key,
    fileName: attachedName,
    contentType,
    byteSize: bytes.length,
    status: "attached",
  });
  return {
    status: 200,
    body: {
      ok: true,
      attached: true,
      xero_bank_transaction_id: xeroTxnId,
      filename: attachedName,
      content_type: contentType,
      file_sha256: fileSha256,
    },
  };
}

function errorCode(error: unknown): string {
  if (error instanceof XeroPdfAttachError || error instanceof XeroCooldownError ||
    error instanceof BankReceiptAttachError) {
    return error.code;
  }
  return "XERO_FILE_ATTACH_FAILED";
}

async function loadBankTransaction(client: any, orgId: string, id: string): Promise<any | null> {
  const byXero = await oneRow(
    client.from("xero_bank_transactions").select("id, org_id, xero_txn_id")
      .eq("org_id", orgId).eq("xero_txn_id", id).limit(1),
    "BANK_TXN_UNREADABLE",
  );
  if (byXero) return byXero;
  return await oneRow(
    client.from("xero_bank_transactions").select("id, org_id, xero_txn_id")
      .eq("org_id", orgId).eq("id", id).limit(1),
    "BANK_TXN_UNREADABLE",
  );
}

async function locateReceipt(
  client: any,
  orgId: string,
  body: any,
): Promise<{ bucket: string; path: string }> {
  const directPath = String(body?.storage_path || "").trim();
  if (directPath) {
    return assertStorageObjectRef(body?.storage_bucket, directPath);
  }
  const receiptId = String(body?.expense_receipt_id || body?.receipt_id || "").trim();
  if (!isXeroEntityUuid(receiptId)) {
    throw new BankReceiptAttachError("storage_path or a receipt id is required", 400, "RECEIPT_FILE_MISSING");
  }
  const receipt = await oneRow(
    client.from("expense_receipts")
      .select("id, org_id, receipt_storage_bucket, receipt_storage_path")
      .eq("org_id", orgId).eq("id", receiptId).limit(1),
    "RECEIPT_UNREADABLE",
  );
  if (!receipt) {
    throw new BankReceiptAttachError("Receipt not found", 404, "RECEIPT_NOT_FOUND");
  }
  return assertStorageObjectRef(receipt.receipt_storage_bucket, receipt.receipt_storage_path);
}

async function downloadReceipt(
  client: any,
  bucket: string,
  path: string,
  downloadStorage?: (bucket: string, path: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  if (downloadStorage) return await downloadStorage(bucket, path);
  const storage = client?.storage;
  if (!storage?.from) {
    throw new BankReceiptAttachError("Receipt file is not in storage", 404, "RECEIPT_FILE_MISSING");
  }
  const { data, error } = await storage.from(bucket).download(path);
  if (error || !data) {
    throw new BankReceiptAttachError("Receipt file is not in storage", 404, "RECEIPT_FILE_MISSING");
  }
  return new Uint8Array(await data.arrayBuffer());
}

async function oneRow(query: Promise<{ data: any; error: any }>, code: string): Promise<any | null> {
  const { data, error } = await query;
  if (error) throw new BankReceiptAttachError("The record could not be read", 503, code);
  return Array.isArray(data) ? data[0] || null : data || null;
}
