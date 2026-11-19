// Idempotency rows for a file put on a Xero document.
// One attached sha per org, entity and file. A failed attempt does not block a retry.
import type { XeroAttachmentEndpoint } from "./xero_attachment.ts";

export type XeroDocumentAttachmentKey = {
  orgId: string;
  entityType: XeroAttachmentEndpoint;
  entityId: string;
  fileSha256: string;
};

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function findAttachedXeroDocument(
  client: { from: (table: string) => any },
  key: XeroDocumentAttachmentKey,
): Promise<"attached" | "absent" | "unreadable"> {
  try {
    const { data, error } = await client.from("xero_document_attachments")
      .select("id")
      .eq("org_id", key.orgId)
      .eq("xero_entity_type", key.entityType)
      .eq("xero_entity_id", key.entityId)
      .eq("file_sha256", key.fileSha256)
      .eq("status", "attached")
      .limit(1);
    if (error) return "unreadable";
    const row = Array.isArray(data) ? data[0] : data;
    return row ? "attached" : "absent";
  } catch {
    return "unreadable";
  }
}

export async function recordXeroDocumentAttachment(
  client: { from: (table: string) => any },
  row: XeroDocumentAttachmentKey & {
    fileName: string;
    contentType: string;
    byteSize: number;
    status: "attached" | "failed";
    errorCode?: string | null;
  },
): Promise<{ recorded: boolean }> {
  try {
    const { error } = await client.from("xero_document_attachments").insert({
      org_id: row.orgId,
      xero_entity_type: row.entityType,
      xero_entity_id: row.entityId,
      file_sha256: row.fileSha256,
      file_name: row.fileName,
      content_type: row.contentType,
      byte_size: row.byteSize,
      status: row.status,
      error_code: row.errorCode || null,
      attached_at: row.status === "attached" ? new Date().toISOString() : null,
    });
    if (!error) return { recorded: true };
    if (error.code === "23505") return { recorded: true };
    return { recorded: false };
  } catch {
    return { recorded: false };
  }
}
