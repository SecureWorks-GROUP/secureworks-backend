// Email attachments for the reader (slice EM2). The evidence row carries the
// names, types and sizes; the file bytes go to the PRIVATE storage bucket
// context-email-attachments, one ledger row per attachment in
// public.context_email_attachments (stored, or skipped with the reason).
// Nothing here makes a public URL or touches job_documents (email.md M11:
// no new public filing).
//
// Limits (attachmentDecisions): file attachments only (an attached email or a
// cloud link is recorded skipped_kind); inline images (signatures, logos) are
// skipped_inline; a file over 15 MB is skipped_too_large; at most 10 files and
// 30 MB per email, the rest skipped_message_cap; the ses@ group's attachments
// are skipped_scope (the make-safe intake already stores them).
//
// Idempotent: an attachment already in the ledger for this email is never read
// again, so a re-read (poll overlap, sweep, a second mailbox copy) costs one
// ledger read. A failed download or upload writes no ledger row, so the next
// re-read of the email retries it.

import type { OutlookAttachmentMeta } from "../_shared/evidence/outlook_mail.ts";
import type { AttachmentHome } from "./graph.ts";

export const ATTACHMENT_POLICY = {
  bucket: "context-email-attachments",
  maxFileBytes: 15 * 1024 * 1024,
  maxFilesPerEmail: 10,
  maxBytesPerEmail: 30 * 1024 * 1024,
  /** Scope labels whose attachments are not stored here. */
  skipScopes: ["ses"],
} as const;

export type AttachmentStatus =
  | "stored"
  | "skipped_inline"
  | "skipped_kind"
  | "skipped_too_large"
  | "skipped_message_cap"
  | "skipped_scope";

export interface AttachmentDecision {
  attachment: OutlookAttachmentMeta;
  decision: AttachmentStatus;
}

/** What to do with each attachment of one email, in the order Graph listed them. */
export function attachmentDecisions(
  attachments: OutlookAttachmentMeta[],
  scopeLabel: string,
  policy = ATTACHMENT_POLICY,
): AttachmentDecision[] {
  let files = 0;
  let bytes = 0;
  const skipScope = (policy.skipScopes as readonly string[]).includes(
    scopeLabel,
  );
  return attachments.map((attachment) => {
    if (skipScope) return { attachment, decision: "skipped_scope" };
    if ((attachment.kind ?? "file") !== "file") {
      return { attachment, decision: "skipped_kind" };
    }
    if (attachment.isInline === true) {
      return { attachment, decision: "skipped_inline" };
    }
    const size = typeof attachment.size === "number" ? attachment.size : 0;
    if (size > policy.maxFileBytes) {
      return { attachment, decision: "skipped_too_large" };
    }
    if (
      files >= policy.maxFilesPerEmail || bytes + size > policy.maxBytesPerEmail
    ) {
      return { attachment, decision: "skipped_message_cap" };
    }
    files++;
    bytes += size;
    return { attachment, decision: "stored" };
  });
}

/** A storage-safe file name: letters, digits, dot, dash, underscore; at most 100 characters. */
export function safeFileName(name: string | null | undefined): string {
  const cleaned = String(name ?? "").replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+/, "").slice(-100);
  return cleaned || "attachment";
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface AttachmentLedgerRow {
  provider_message_id: string;
  attachment_key: string;
  business_event_id: string | null;
  file_name: string | null;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  status: AttachmentStatus;
}

export interface AttachmentDeps {
  list(home: AttachmentHome): Promise<OutlookAttachmentMeta[]>;
  bytes(
    home: AttachmentHome,
    attachmentId: string,
    maxBytes: number,
  ): Promise<Uint8Array>;
  /** attachment_key values already in the ledger for this email. */
  existing(providerMessageId: string): Promise<Set<string>>;
  /** Upload to the private bucket; an object already at the path counts as stored. */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  record(row: AttachmentLedgerRow): Promise<void>;
}

export interface AttachmentResult {
  stored: number;
  skipped: number;
  already: number;
  errors: number;
  /** The first error code, ids and codes only. */
  error_code: string | null;
}

function errorCode(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^[a-z0-9_.:-]{1,60}$/i.test(c)
    ? c.toLowerCase()
    : "attachment_error";
}

export async function storeEmailAttachments(
  deps: AttachmentDeps,
  args: {
    home: AttachmentHome;
    providerMessageId: string;
    businessEventId: string | null;
    scopeLabel: string;
  },
  policy = ATTACHMENT_POLICY,
): Promise<AttachmentResult> {
  const result: AttachmentResult = {
    stored: 0,
    skipped: 0,
    already: 0,
    errors: 0,
    error_code: null,
  };
  const fail = (e: unknown) => {
    result.errors++;
    result.error_code ??= errorCode(e);
  };
  let list: OutlookAttachmentMeta[];
  let have: Set<string>;
  try {
    list = await deps.list(args.home);
    have = await deps.existing(args.providerMessageId);
  } catch (e) {
    fail(e);
    return result;
  }
  const emailKey = (await sha256Hex(args.providerMessageId)).slice(0, 32);
  for (
    const { attachment, decision } of attachmentDecisions(
      list,
      args.scopeLabel,
      policy,
    )
  ) {
    const key = await sha256Hex(attachment.id);
    if (have.has(key)) {
      result.already++;
      continue;
    }
    const base: AttachmentLedgerRow = {
      provider_message_id: args.providerMessageId,
      attachment_key: key,
      business_event_id: args.businessEventId,
      file_name: attachment.name ? attachment.name.slice(0, 255) : null,
      content_type: attachment.contentType
        ? attachment.contentType.slice(0, 255)
        : null,
      size_bytes: typeof attachment.size === "number" ? attachment.size : null,
      sha256: null,
      storage_bucket: null,
      storage_path: null,
      status: decision,
    };
    try {
      if (decision !== "stored") {
        await deps.record(base);
        result.skipped++;
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await deps.bytes(args.home, attachment.id, policy.maxFileBytes);
      } catch (e) {
        if ((e as { code?: unknown })?.code === "attachment_too_large") {
          await deps.record({ ...base, status: "skipped_too_large" });
          result.skipped++;
          continue;
        }
        throw e;
      }
      const path = `${emailKey}/${key.slice(0, 32)}/${
        safeFileName(attachment.name)
      }`;
      await deps.upload(
        path,
        bytes,
        attachment.contentType || "application/octet-stream",
      );
      await deps.record({
        ...base,
        size_bytes: bytes.byteLength,
        sha256: await sha256Hex(bytes),
        storage_bucket: policy.bucket,
        storage_path: path,
      });
      result.stored++;
    } catch (e) {
      fail(e);
    }
  }
  return result;
}
