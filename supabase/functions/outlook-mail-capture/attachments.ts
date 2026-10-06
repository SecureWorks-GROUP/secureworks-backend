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
// 30 MB per email, the rest skipped_message_cap. A group file Microsoft sent
// without its bytes is skipped_no_content (it cannot be fetched another way
// with the reader's login; see graph.ts).
//
// The ses@ group's attachments are not read at all: the make-safe intake
// already stores them, so the reader never asks Microsoft for them and writes
// no row (lanes health, 6 Oct 2026; before, it asked on every poll and was
// refused every time).
//
// Idempotent: an attachment already in the ledger for this email is never read
// again, so a re-read (poll overlap, sweep) costs one ledger read. A group post
// is read with every file's bytes (graph.ts), so once the ledger holds any row
// for its email it is read again only by the sweep or a history run
// (recheck), and only to retry a recorded failure. A file whose row and whose
// failure row both failed to write is therefore not retried for a group post
// that has other rows (a user mailbox message lists its files again and
// heals); the run counts it in attachment_errors.
//
// One file, one stored copy per email (review round 3, 6 Oct 2026). The same
// email can reach a group and a member's own mailbox, and each copy lists its
// files under different attachment ids; polls read sources in source_key
// order, so either copy can come first. Before a file is uploaded its bytes
// are hashed: a file whose sha-256 is already stored for the same email is
// recorded skipped_duplicate (with that hash, no file) and not stored again.
// The same file attached twice to one email is stored once the same way.
//
// Failures (lanes health, 6 Oct 2026). A failed list, download or upload used
// to write nothing, so every poll tried again (finance@ failed 82 times in a
// day) and the code was logged nowhere. Now a failure is a ledger row: status
// failed, its error_code, keyed sha-256 of "failed:" plus the attachment's own
// key (or of "failed:list" when the list itself was refused), written once.
// A poll never tries a recorded failure again; a recheck (the nightly sweep,
// history runs) does, and on success writes the attachment's own stored row
// beside it. A failure row's key is derived from the attachment's key, so SQL
// can tell a failure that later succeeded from one still open.

import type { AttachmentHome, ListedAttachment } from "./graph.ts";

export const ATTACHMENT_POLICY = {
  bucket: "context-email-attachments",
  maxFileBytes: 15 * 1024 * 1024,
  maxFilesPerEmail: 10,
  maxBytesPerEmail: 30 * 1024 * 1024,
  /** Scope labels whose attachments are not read here at all. */
  skipScopes: ["ses"],
} as const;

export type AttachmentStatus =
  | "stored"
  | "skipped_inline"
  | "skipped_kind"
  | "skipped_too_large"
  | "skipped_message_cap"
  | "skipped_scope"
  | "skipped_no_content"
  | "skipped_duplicate"
  | "failed";

/** The ledger key of a refused attachment list: sha-256 of "failed:list". */
export const LIST_FAILURE_KEY =
  "f00077086bc3b5369393e87af4a835e277f8bdc296dc01455b53cb3f80d2896f";

export interface AttachmentDecision {
  attachment: ListedAttachment;
  decision: AttachmentStatus;
}

/** What to do with each attachment of one email, in the order Graph listed them. */
export function attachmentDecisions(
  attachments: ListedAttachment[],
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

/** The ledger key of a failed attachment: sha-256 of "failed:" plus its own key. */
export function failureKey(attachmentKey: string): Promise<string> {
  return sha256Hex(`failed:${attachmentKey}`);
}

/**
 * Whether an email's ledger rows hold a failure nothing has healed since: a
 * refused list with no other row, or a failed attachment whose own key holds
 * no row.
 */
export async function hasOpenFailure(
  rows: Map<string, AttachmentStatus>,
): Promise<boolean> {
  const done = [...rows].filter(([, status]) => status !== "failed").map((
    [key],
  ) => key);
  const healed = new Set(await Promise.all(done.map(failureKey)));
  return [...rows].some(([key, status]) =>
    status === "failed" &&
    (key === LIST_FAILURE_KEY ? done.length === 0 : !healed.has(key))
  );
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
  /** Only on a failed row (the column is new in 20261006050000). */
  error_code?: string;
}

export interface AttachmentDeps {
  list(home: AttachmentHome): Promise<ListedAttachment[]>;
  bytes(
    home: AttachmentHome,
    attachment: ListedAttachment,
    maxBytes: number,
  ): Promise<Uint8Array>;
  /** The ledger's rows for this email: attachment_key to status. */
  existing(providerMessageId: string): Promise<Map<string, AttachmentStatus>>;
  /** The sha-256 of every file stored for this email, under any copy of it. */
  storedHashes(providerMessageId: string): Promise<Set<string>>;
  /** Upload to the private bucket; an object already at the path counts as stored. */
  upload(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** One ledger row; a row already at its key is left as it is. */
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
  return typeof c === "string" && /^[a-z0-9][a-z0-9_.:-]{0,59}$/i.test(c)
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
    /** The nightly sweep and history runs: read again and retry failures. */
    recheck?: boolean;
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
  // ses@: never asked for (the make-safe intake stores these files).
  if ((policy.skipScopes as readonly string[]).includes(args.scopeLabel)) {
    return result;
  }
  const recheck = args.recheck === true;
  const blank = {
    provider_message_id: args.providerMessageId,
    business_event_id: args.businessEventId,
    sha256: null,
    storage_bucket: null,
    storage_path: null,
  };
  // A failure is written once (its key is fixed); a ledger fault here only
  // means the next read may try again.
  const recordFailure = async (
    key: string,
    attachment: ListedAttachment | null,
    code: string,
    have: Map<string, AttachmentStatus>,
  ): Promise<void> => {
    if (have.has(key)) return;
    try {
      await deps.record({
        ...blank,
        attachment_key: key,
        file_name: attachment?.name ? attachment.name.slice(0, 255) : null,
        content_type: attachment?.contentType
          ? attachment.contentType.slice(0, 255)
          : null,
        size_bytes: typeof attachment?.size === "number"
          ? attachment.size
          : null,
        status: "failed",
        error_code: code,
      });
    } catch {
      // Counted in errors already; nothing more to do.
    }
  };
  const fail = (e: unknown): string => {
    const code = errorCode(e);
    result.errors++;
    result.error_code ??= code;
    return code;
  };

  let have: Map<string, AttachmentStatus>;
  try {
    have = await deps.existing(args.providerMessageId);
  } catch (e) {
    fail(e);
    return result;
  }
  // Not read again: an email whose list was refused, until a recheck; a group
  // post (whose read carries every file's bytes) once its email has any row,
  // unless a recheck has an open failure to retry.
  if (
    (!recheck && have.has(LIST_FAILURE_KEY)) ||
    (args.home.kind === "post" && have.size > 0 &&
      !(recheck && await hasOpenFailure(have)))
  ) {
    result.already += have.size;
    return result;
  }
  let list: ListedAttachment[];
  try {
    list = await deps.list(args.home);
  } catch (e) {
    await recordFailure(LIST_FAILURE_KEY, null, fail(e), have);
    return result;
  }
  const emailKey = (await sha256Hex(args.providerMessageId)).slice(0, 32);
  // The files already stored for this email (any copy), read once, when the
  // first file's bytes are in hand.
  let storedHashes: Set<string> | null = null;
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
    const failKey = await failureKey(key);
    // A recorded failure waits for the sweep or a history run.
    if (!recheck && have.has(failKey)) {
      result.already++;
      continue;
    }
    const base: AttachmentLedgerRow = {
      ...blank,
      attachment_key: key,
      file_name: attachment.name ? attachment.name.slice(0, 255) : null,
      content_type: attachment.contentType
        ? attachment.contentType.slice(0, 255)
        : null,
      size_bytes: typeof attachment.size === "number" ? attachment.size : null,
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
        bytes = await deps.bytes(args.home, attachment, policy.maxFileBytes);
      } catch (e) {
        const code = (e as { code?: unknown })?.code;
        if (
          code === "attachment_too_large" || code === "attachment_no_content"
        ) {
          await deps.record({
            ...base,
            status: code === "attachment_too_large"
              ? "skipped_too_large"
              : "skipped_no_content",
          });
          result.skipped++;
          continue;
        }
        throw e;
      }
      const sha = await sha256Hex(bytes);
      // Already stored for this email (another mailbox copy, or the same
      // file attached twice): recorded with its hash, never stored again.
      storedHashes ??= await deps.storedHashes(args.providerMessageId);
      if (storedHashes.has(sha)) {
        await deps.record({
          ...base,
          size_bytes: bytes.byteLength,
          sha256: sha,
          status: "skipped_duplicate",
        });
        result.skipped++;
        continue;
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
        sha256: sha,
        storage_bucket: policy.bucket,
        storage_path: path,
      });
      storedHashes.add(sha);
      result.stored++;
    } catch (e) {
      await recordFailure(failKey, attachment, fail(e), have);
    }
  }
  return result;
}
