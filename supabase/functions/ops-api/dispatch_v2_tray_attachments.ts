// deno-lint-ignore-file no-explicit-any
// Dispatch v2 item 16 part 1 (Shaun, 16 Nov 2026): the files on an email in
// the Unmatched supplier emails tray.
// Contract: docs/dispatch-v2-board-contract.md, section 3i.
//
// The rules, in business words:
//   * Each tray card lists the email's attachments, every type (PDF, picture,
//     Word, Excel, anything else), as "PDF: name, size". Pictures inside the
//     email itself (signature logos) are not attachments and are not listed.
//   * Open shows the file in a new tab through a link that works for two
//     minutes (TRAY_SIGNED_URL_SECONDS). Staff only, the same front door as
//     the tray itself. The files stay in the private capture bucket; the link
//     is made fresh on each press and is never stored.
//   * Put on job also saves that email's files to the job's documents:
//     office only (visible_to_trades false, so the crew does not see them
//     until someone ticks them on in Sources), once only per file on a job
//     (by the file's SHA-256), as type material_order so the job page lists
//     them under Material Documents.
//   * A file the capture reader did not keep (too large, not a file, failed)
//     is listed with the reason and cannot be opened or saved.
//
// Where the files come from: the email capture reader (outlook-mail-capture)
// keeps each email's file attachments in the private bucket
// context-email-attachments, one context_email_attachments row each, joined
// to the tray's dispatch_v2_supplier_emails row on provider_message_id. A
// file the reader had already kept from another email is recorded as
// skipped_duplicate with no copy of its own: its copy is found by its hash,
// as dispatch_v2_order_documents.ts does.
//
// What it writes (Put on job only): one object in job-documents, one
// job_documents row and one job_events audit row per file saved. Never a job,
// job status, stage, order, supplier, Xero, GHL, SMS or email. The save never
// throws: a failure is reported per file and the email stays put on the job.
//
// Not in this build (item 16 Q4): reading the scans to suggest a job. Scanned
// PDFs have no context_document_texts row, so there are no words to read.

import { ATTACHMENT_STATUS_WORDS } from "./context_message_original.ts";
import {
  DISPATCH_DOC_TYPE,
  DISPATCH_DOCS_BUCKET,
  dispatchDocSafeName,
  sha256HexOf,
} from "./dispatch_v2_order_documents.ts";
import { dispatchPdfText } from "./dispatch_order_pdf.ts";

export const DISPATCH_V2_TRAY_ATTACHMENT_OPEN_ACTION =
  "dispatch_v2_tray_attachment_open";
export const TRAY_SIGNED_URL_SECONDS = 120;
export const TRAY_CAPTURE_BUCKET = "context-email-attachments";
// The most attachment rows one tray read joins (the tray lists at most 200
// emails; the capture reader keeps at most 10 files per email).
const TRAY_ATTACHMENT_ROW_CAP = 2000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA_RE = /^[0-9a-f]{64}$/i;

export class TrayAttachmentError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
  get body() {
    return { error: this.message, code: this.code };
  }
}

export type TrayAttachmentRow = {
  id: string;
  provider_message_id: string;
  file_name: string | null;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  status: string;
};

export type TrayEmailRow = {
  id: string;
  provider_message_id: string | null;
  supplier_name: string | null;
};

/** What the screen draws for one file. */
export type TrayAttachment = {
  id: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number | null;
  size_label: string | null;
  kind_label: string;
  // A kept copy exists: Open works and Put on job saves it.
  openable: boolean;
  status: string;
  // Why it cannot be opened, in staff words; null when it can.
  not_kept_reason: string | null;
};

export type TrayAttachmentStore = {
  emailsByIds(orgId: string, ids: string[]): Promise<TrayEmailRow[]>;
  attachmentsFor(providerMessageIds: string[]): Promise<TrayAttachmentRow[]>;
  storedBySha(shas: string[]): Promise<TrayAttachmentRow[]>;
  signedUrl(
    bucket: string,
    path: string,
    seconds: number,
  ): Promise<string | null>;
  download(bucket: string, path: string): Promise<Uint8Array | null>;
  // The SHA-256s of the files already on the job: its documents' own
  // metadata.content_sha256 and the order-document claims.
  jobFileShas(jobId: string, shas: string[]): Promise<Set<string>>;
  upload(
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<string | null>;
  insertJobDocument(row: Record<string, unknown>): Promise<string | null>;
  logJobEvent(row: Record<string, unknown>): Promise<void>;
};

// ── Words ───────────────────────────────────────────────────────────────────

/** "PDF", "Image", "Word", "Excel" or "File", from the type, then the name. */
export function trayKindLabel(
  contentType: unknown,
  fileName: unknown,
): string {
  const t = String(contentType ?? "").toLowerCase().split(";")[0].trim();
  const ext = (String(fileName ?? "").toLowerCase().match(/\.([a-z0-9]+)$/) ||
    [])[1] || "";
  if (t === "application/pdf" || ext === "pdf") return "PDF";
  if (t.startsWith("image/") || /^(jpe?g|png|gif|webp|heic|bmp|tiff?)$/.test(ext)) {
    return "Image";
  }
  if (/wordprocessingml|msword/.test(t) || /^(docx?|rtf)$/.test(ext)) {
    return "Word";
  }
  if (/spreadsheetml|ms-excel|csv/.test(t) || /^(xlsx?|csv)$/.test(ext)) {
    return "Excel";
  }
  return "File";
}

/** "188 KB", "1.4 MB", "900 bytes". */
export function traySizeLabel(bytes: unknown): string | null {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0 || bytes === null || bytes === undefined) {
    return null;
  }
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isInline(row: TrayAttachmentRow) {
  return row.status === "skipped_inline";
}

function hasOwnCopy(row: TrayAttachmentRow) {
  return row.status === "stored" && !!row.storage_path &&
    row.storage_bucket === TRAY_CAPTURE_BUCKET && !!row.sha256;
}

function shaOf(row: TrayAttachmentRow): string | null {
  return row.sha256 && SHA_RE.test(row.sha256) ? row.sha256.toLowerCase() : null;
}

/** The kept copy of a file: its own, else (skipped_duplicate) the stored
 * row with the same hash. */
function copyOf(
  row: TrayAttachmentRow,
  stored: Map<string, TrayAttachmentRow>,
): TrayAttachmentRow | null {
  if (hasOwnCopy(row)) return row;
  const sha = shaOf(row);
  if (row.status === "skipped_duplicate" && sha) return stored.get(sha) ?? null;
  return null;
}

export function projectTrayAttachment(
  row: TrayAttachmentRow,
  stored: Map<string, TrayAttachmentRow>,
): TrayAttachment {
  const copy = copyOf(row, stored);
  const name = String(row.file_name || "").trim() || "Unnamed file";
  return {
    id: row.id,
    file_name: name,
    content_type: row.content_type ?? null,
    size_bytes: row.size_bytes ?? null,
    size_label: traySizeLabel(row.size_bytes),
    kind_label: trayKindLabel(row.content_type, row.file_name),
    openable: !!copy,
    status: row.status,
    not_kept_reason: copy
      ? null
      : row.status === "skipped_duplicate"
      ? "Not saved: the kept copy of this file could not be found"
      : ATTACHMENT_STATUS_WORDS[row.status] ?? "Not saved",
  };
}

async function storedCopies(
  store: TrayAttachmentStore,
  rows: TrayAttachmentRow[],
): Promise<Map<string, TrayAttachmentRow>> {
  const need = [
    ...new Set(
      rows.filter((r) => r.status === "skipped_duplicate")
        .map(shaOf).filter((s): s is string => !!s),
    ),
  ];
  const out = new Map<string, TrayAttachmentRow>();
  // An email's own stored files count as copies too.
  for (const r of rows) {
    const sha = shaOf(r);
    if (sha && hasOwnCopy(r)) out.set(sha, r);
  }
  const missing = need.filter((s) => !out.has(s));
  if (missing.length === 0) return out;
  for (const r of await store.storedBySha(missing)) {
    const sha = shaOf(r);
    if (sha && hasOwnCopy(r) && !out.has(sha)) out.set(sha, r);
  }
  return out;
}

// ── The tray read: each email's files ──────────────────────────────────────

/** Adds attachments[] to every email of a dispatch_v2_replies_unmatched
 * answer, and attachments_read 'ok' | 'failed'. A failed read leaves each
 * email's attachments null (never an empty list) and the tray still works. */
export async function addTrayAttachments<T extends { emails?: any[] }>(
  store: TrayAttachmentStore,
  orgId: string,
  answer: T,
): Promise<T & { attachments_read: "ok" | "failed" }> {
  const emails = Array.isArray(answer?.emails) ? answer.emails : [];
  if (emails.length === 0) return { ...answer, attachments_read: "ok" };
  try {
    const rows = await store.emailsByIds(
      orgId,
      emails.map((e) => String(e?.id ?? "")).filter((id) => UUID_RE.test(id)),
    );
    const pmidById = new Map<string, string>();
    for (const r of rows) {
      if (r.provider_message_id) pmidById.set(r.id, r.provider_message_id);
    }
    const atts = pmidById.size
      ? await store.attachmentsFor([...new Set(pmidById.values())])
      : [];
    const listed = atts.filter((a) => !isInline(a));
    const stored = await storedCopies(store, listed);
    const byMessage = new Map<string, TrayAttachment[]>();
    for (const a of listed) {
      const list = byMessage.get(a.provider_message_id) ?? [];
      list.push(projectTrayAttachment(a, stored));
      byMessage.set(a.provider_message_id, list);
    }
    for (const list of byMessage.values()) {
      list.sort((x, y) => x.file_name.localeCompare(y.file_name));
    }
    return {
      ...answer,
      emails: emails.map((e) => {
        const pmid = pmidById.get(String(e?.id ?? ""));
        return { ...e, attachments: pmid ? byMessage.get(pmid) ?? [] : [] };
      }),
      attachments_read: "ok",
    };
  } catch (e) {
    console.error("[dispatch_v2_tray_attachments] tray read failed:", e);
    return {
      ...answer,
      emails: emails.map((m) => ({ ...m, attachments: null })),
      attachments_read: "failed",
    };
  }
}

// ── Open: a two-minute link ─────────────────────────────────────────────────

async function emailAndFiles(
  store: TrayAttachmentStore,
  orgId: string,
  emailId: string,
) {
  const [email] = await store.emailsByIds(orgId, [emailId]);
  if (!email) {
    throw new TrayAttachmentError(404, "email_not_found", "Supplier email not found");
  }
  const atts = email.provider_message_id
    ? await store.attachmentsFor([email.provider_message_id])
    : [];
  return { email, atts: atts.filter((a) => !isInline(a)) };
}

function uuidOf(value: unknown, field: string): string {
  const v = String(value ?? "").trim();
  if (!UUID_RE.test(v)) {
    throw new TrayAttachmentError(400, "bad_request", `${field} must be a uuid`);
  }
  return v;
}

/** GET ?action=dispatch_v2_tray_attachment_open&email_id=&attachment_id=
 * A link to one of the email's files that works for two minutes. */
export async function openTrayAttachment(
  store: TrayAttachmentStore,
  orgId: string,
  params: URLSearchParams,
) {
  const emailId = uuidOf(params.get("email_id"), "email_id");
  const attachmentId = uuidOf(params.get("attachment_id"), "attachment_id");
  const { atts } = await emailAndFiles(store, orgId, emailId);
  const row = atts.find((a) => a.id === attachmentId);
  if (!row) {
    throw new TrayAttachmentError(
      404,
      "attachment_not_found",
      "That file is not on this email",
    );
  }
  const stored = await storedCopies(store, [row]);
  const copy = copyOf(row, stored);
  if (!copy) {
    throw new TrayAttachmentError(
      409,
      "attachment_not_kept",
      projectTrayAttachment(row, stored).not_kept_reason ?? "Not saved",
    );
  }
  const url = await store.signedUrl(
    TRAY_CAPTURE_BUCKET,
    String(copy.storage_path),
    TRAY_SIGNED_URL_SECONDS,
  );
  if (!url) {
    throw new TrayAttachmentError(500, "link_failed", "Could not make a link to the file");
  }
  return {
    ok: true,
    url,
    expires_in: TRAY_SIGNED_URL_SECONDS,
    file_name: String(row.file_name || "").trim() || "Unnamed file",
    content_type: row.content_type ?? null,
  };
}

// ── Put on job: the email's files to the job's documents ────────────────────

export type TraySaveResult = {
  read: "ok" | "failed";
  saved: Array<{ job_document_id: string; name: string; sha256: string }>;
  skipped: Array<{ file_name: string; reason: string }>;
};

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "text/csv": "csv",
};

/** The name on the job: "<Supplier> <file name as sent>", the extension
 * kept (or added from the type). */
export function trayDocumentName(
  supplierName: unknown,
  fileName: unknown,
  contentType: unknown,
): { name: string; extension: string } {
  const raw = dispatchPdfText(String(fileName ?? "").trim()) || "file";
  const m = raw.match(/^(.*?)(?:\.([A-Za-z0-9]{1,8}))?$/);
  const base = (m?.[1] || raw).trim() || "file";
  const t = String(contentType ?? "").toLowerCase().split(";")[0].trim();
  const extension = (m?.[2] || EXTENSIONS[t] || "bin").toLowerCase();
  const supplier = dispatchPdfText(String(supplierName ?? "").trim());
  const name = supplier && !base.toLowerCase().startsWith(supplier.toLowerCase())
    ? `${supplier} ${base}`
    : base;
  return { name: name.slice(0, 200), extension };
}

export function trayStoragePath(
  jobId: string,
  sha256: string,
  name: string,
  extension: string,
): string {
  return `${jobId}/dispatch-tray/${sha256.slice(0, 16)}-${
    dispatchDocSafeName(name)
  }.${dispatchDocSafeName(extension)}`;
}

/** After Put on job: save each of the email's kept files to the job once,
 * office only. Never throws. */
export async function saveTrayAttachmentsToJob(
  store: TrayAttachmentStore,
  input: {
    orgId: string;
    emailId: string;
    jobId: string;
    operatorUserId: string | null;
    operatorEmail: string | null;
    via: string;
  },
): Promise<TraySaveResult> {
  const out: TraySaveResult = { read: "ok", saved: [], skipped: [] };
  let atts: TrayAttachmentRow[];
  let email: TrayEmailRow;
  let stored: Map<string, TrayAttachmentRow>;
  try {
    const got = await emailAndFiles(store, input.orgId, input.emailId);
    email = got.email;
    atts = got.atts;
    stored = await storedCopies(store, atts);
  } catch (e) {
    console.error("[dispatch_v2_tray_attachments] save read failed:", e);
    return { read: "failed", saved: [], skipped: [] };
  }
  const nameOf = (a: TrayAttachmentRow) =>
    String(a.file_name || "").trim() || "Unnamed file";
  const kept: Array<{ row: TrayAttachmentRow; copy: TrayAttachmentRow; sha: string }> = [];
  const seen = new Set<string>();
  for (const a of atts) {
    const copy = copyOf(a, stored);
    const sha = copy ? shaOf(copy) : null;
    if (!copy || !sha) {
      out.skipped.push({ file_name: nameOf(a), reason: "not_kept" });
      continue;
    }
    if (seen.has(sha)) {
      out.skipped.push({ file_name: nameOf(a), reason: "same_file_twice" });
      continue;
    }
    seen.add(sha);
    kept.push({ row: a, copy, sha });
  }
  if (kept.length === 0) return out;
  let onJob: Set<string>;
  try {
    onJob = await store.jobFileShas(input.jobId, kept.map((k) => k.sha));
  } catch (e) {
    console.error("[dispatch_v2_tray_attachments] job files read failed:", e);
    return { read: "failed", saved: [], skipped: out.skipped };
  }
  for (const k of kept) {
    const fileName = nameOf(k.row);
    if (onJob.has(k.sha)) {
      out.skipped.push({ file_name: fileName, reason: "already_on_job" });
      continue;
    }
    try {
      const bytes = await store.download(
        String(k.copy.storage_bucket),
        String(k.copy.storage_path),
      );
      if (!bytes) {
        out.skipped.push({ file_name: fileName, reason: "download_failed" });
        continue;
      }
      if ((await sha256HexOf(bytes)) !== k.sha) {
        out.skipped.push({ file_name: fileName, reason: "hash_mismatch" });
        continue;
      }
      const contentType = String(k.row.content_type || k.copy.content_type || "")
        .split(";")[0].trim() || "application/octet-stream";
      const { name, extension } = trayDocumentName(
        email.supplier_name,
        k.row.file_name,
        contentType,
      );
      const path = trayStoragePath(input.jobId, k.sha, name, extension);
      const url = await store.upload(path, bytes, contentType);
      if (!url) {
        out.skipped.push({ file_name: fileName, reason: "upload_failed" });
        continue;
      }
      const docName = `${name}.${extension}`;
      const docId = await store.insertJobDocument({
        job_id: input.jobId,
        type: DISPATCH_DOC_TYPE,
        file_name: docName,
        pdf_url: url,
        storage_url: url,
        // Office only: the crew sees it once someone ticks it on in Sources.
        visible_to_trades: false,
        uploaded_by: input.operatorUserId,
        metadata: {
          source: "dispatch_v2_tray_put_on_job",
          content_sha256: k.sha,
          reply_email_id: email.id,
          attachment_id: k.row.id,
          source_file_name: k.row.file_name ?? null,
          content_type: contentType,
          storage_path: path,
          office_only: true,
        },
      });
      if (!docId) {
        out.skipped.push({ file_name: fileName, reason: "document_failed" });
        continue;
      }
      onJob.add(k.sha);
      out.saved.push({ job_document_id: docId, name: docName, sha256: k.sha });
      try {
        await store.logJobEvent({
          job_id: input.jobId,
          user_id: input.operatorUserId,
          event_type: "dispatch_v2_tray_file_saved",
          detail_json: {
            email_id: email.id,
            attachment_id: k.row.id,
            job_document_id: docId,
            name: docName,
            visible_to_trades: false,
            operator_email: input.operatorEmail,
            via: input.via,
          },
        });
      } catch (e) {
        console.error("[dispatch_v2_tray_attachments] audit failed:", e);
      }
    } catch (e) {
      console.error("[dispatch_v2_tray_attachments] save failed:", e);
      out.skipped.push({ file_name: fileName, reason: "document_failed" });
    }
  }
  return out;
}

// ── The live store ──────────────────────────────────────────────────────────

const ATT_SELECT =
  "id, provider_message_id, file_name, content_type, size_bytes, sha256, storage_bucket, storage_path, status";

function must<T>(res: { data: T; error: any }, label: string): T {
  if (res.error) throw new Error(`${label}: ${res.error.message ?? res.error}`);
  return res.data;
}

export function postgrestTrayAttachmentStore(client: any): TrayAttachmentStore {
  return {
    async emailsByIds(orgId, ids) {
      if (ids.length === 0) return [];
      const data = must(
        await client.from("dispatch_v2_supplier_emails")
          .select("id, provider_message_id, supplier_name")
          .eq("org_id", orgId)
          .in("id", ids),
        "tray emails read",
      );
      return (data || []) as TrayEmailRow[];
    },
    async attachmentsFor(pmids) {
      if (pmids.length === 0) return [];
      const data = must(
        await client.from("context_email_attachments")
          .select(ATT_SELECT)
          .in("provider_message_id", pmids)
          .limit(TRAY_ATTACHMENT_ROW_CAP),
        "tray attachments read",
      );
      return (data || []) as TrayAttachmentRow[];
    },
    async storedBySha(shas) {
      if (shas.length === 0) return [];
      const data = must(
        await client.from("context_email_attachments")
          .select(ATT_SELECT)
          .in("sha256", shas)
          .eq("status", "stored")
          .limit(TRAY_ATTACHMENT_ROW_CAP),
        "stored copies read",
      );
      return (data || []) as TrayAttachmentRow[];
    },
    async signedUrl(bucket, path, seconds) {
      const { data, error } = await client.storage.from(bucket)
        .createSignedUrl(path, seconds);
      if (error) {
        console.error("[dispatch_v2_tray_attachments] sign failed:", error);
        return null;
      }
      return data?.signedUrl || data?.signedURL || null;
    },
    async download(bucket, path) {
      const { data, error } = await client.storage.from(bucket).download(path);
      if (error || !data) {
        console.error("[dispatch_v2_tray_attachments] download failed:", error);
        return null;
      }
      return new Uint8Array(await data.arrayBuffer());
    },
    async jobFileShas(jobId, shas) {
      const out = new Set<string>();
      if (shas.length === 0) return out;
      const docs = must(
        await client.from("job_documents")
          .select("metadata->>content_sha256")
          .eq("job_id", jobId)
          .in("metadata->>content_sha256", shas),
        "job documents read",
      );
      for (const d of (docs || []) as any[]) {
        const v = (d as any).content_sha256;
        if (v) out.add(String(v).toLowerCase());
      }
      const claims = must(
        await client.from("dispatch_v2_order_documents")
          .select("content_sha256")
          .eq("job_id", jobId)
          .in("content_sha256", shas),
        "order documents read",
      );
      for (const c of (claims || []) as any[]) {
        if (c.content_sha256) out.add(String(c.content_sha256).toLowerCase());
      }
      return out;
    },
    async upload(path, bytes, contentType) {
      const bucket = client.storage.from(DISPATCH_DOCS_BUCKET);
      const up = await bucket.upload(path, bytes, { contentType, upsert: true });
      if (up?.error) {
        console.error("[dispatch_v2_tray_attachments] upload failed:", up.error);
        return null;
      }
      return bucket.getPublicUrl(path)?.data?.publicUrl ?? null;
    },
    async insertJobDocument(row) {
      const res = await client.from("job_documents").insert(row).select("id")
        .maybeSingle();
      if (res.error || !res.data?.id) {
        console.error("[dispatch_v2_tray_attachments] document insert failed:", res.error);
        return null;
      }
      return String(res.data.id);
    },
    async logJobEvent(row) {
      const { error } = await client.from("job_events").insert(row);
      if (error) console.error("[dispatch_v2_tray_attachments] audit insert failed:", error);
    },
  };
}
