// deno-lint-ignore-file no-explicit-any
// Dispatch v2 Tweak 1, part 2 (Shaun, 4 Nov 2026): once a supplier order is
// confirmed, the supplier's own PDFs go on the job, where the crew sees them.
// Contract: docs/dispatch-v2-board-contract.md, section 3e.2.
// Deploy note: first shipped live by the 5 Nov redeploy PR, because the
// #1319 deploy run stopped on a migration version clash (fixed in #1334).
//
// The rules, in business words:
//   * Every real PDF on a supplier reply MATCHED to the order (state
//     'matched', the order named) is saved to the job once. A reply still
//     waiting for a person to confirm a guess does not count: those are often
//     statements, lead emails or someone else's invoice.
//   * Inline pictures (signature logos) are never saved. The capture reader
//     already skips them; this file only takes PDFs, and checks the bytes
//     really are a PDF.
//   * Once only: the same file (same bytes, by its SHA-256) is saved to a job
//     once, however many replies carry it and however often this runs.
//   * Each one is named for what it is, from its file name, then the email's
//     subject, then its first words: "Stratco order confirmation",
//     "B&D invoice", "R&R quote"; otherwise "<Supplier> order document".
//   * Later invoices count too: the reply scan sweeps confirmed orders every
//     five minutes and saves any new PDF. Newest shows on top (the job's
//     documents read newest first). Prices do not matter: the crew must see
//     the document.
//   * LATEST ONLY (Shaun, 11 Nov 2026), which narrows the two rules above:
//     one supplier document per order, the newest proper one (the newest
//     email's invoice, else its sales order or confirmation, else its
//     quote). Price lists, drawings, terms and other side files are never
//     saved. A newer one replaces the older one this rule saved; documents
//     saved before the rule or added by hand are never removed. See
//     pickLatestSupplierDocument and saveDispatchSupplierDocuments.
//   * Saved as job_documents type 'material_order', visible_to_trades true:
//     the trade app shows that type (it is not one of the money types it
//     hides, TRADE_MONEY_DOC_TYPES in trade.html), and the ops dashboard
//     lists it under Material Documents. Names never say "work order" or
//     "WO", so the trade app's priced work order lock does not hide them.
//
// Where the PDFs come from: the email capture reader (outlook-mail-capture)
// already keeps each email's file attachments in the private bucket
// context-email-attachments, one context_email_attachments row each, with
// the file's SHA-256. This file copies the PDF from there into the job's
// documents (bucket job-documents). It never calls Outlook.
//
// What it writes: dispatch_v2_order_documents (the once-only memory), one
// object in job-documents, one job_documents row and one job_events audit
// row per document. Never a job, job status, stage, supplier, Xero, GHL,
// SMS or email. It never throws.
//
// The order's own photos (Tweak 5, Shaun 5 Nov 2026): when the supplier
// sends no PDF, the photos that went on our order email are saved to the job
// too, so the crew sees what was ordered: "<Supplier> order photo 1", "... 2"
// and so on, once per photo (by its SHA-256, the same claim as a PDF). A
// photo-only order gets its photos INSTEAD of our one-page order sheet (a
// sheet with no lines says nothing); an order with lines and photos gets the
// sheet AND the photos. See saveDispatchOrderPhotos below and contract
// section 3e.4.

import { dispatchPdfText } from "./dispatch_order_pdf.ts";
import { DISPATCH_V2_PHOTO_BUCKET } from "./dispatch_v2_emails.ts";

export const DISPATCH_DOCS_BUCKET = "job-documents";
export const DISPATCH_DOC_TYPE = "material_order";
// A claim older than this was left by a run that died part way: the next
// run may take it over.
export const DISPATCH_DOC_CLAIM_STALE_MS = 10 * 60_000;

export type DispatchSupplierDocKind =
  | "order_confirmation"
  | "invoice"
  | "quote"
  | "order_document";

// supplier_reply: a PDF from a matched reply. order_sheet: our one-page
// Material order sheet. order_photo: a photo that went on our order email.
export type DispatchDocSource = "supplier_reply" | "order_sheet" | "order_photo";

// ── Rules (pure) ────────────────────────────────────────────────────────────

const KIND_PATTERNS: Array<[Exclude<DispatchSupplierDocKind, "order_document">, RegExp]> = [
  ["invoice", /\b(?:tax\s+)?invoice\b|\bpro[\s_-]?forma\b/i],
  ["quote", /\bquot(?:e|ation)\b|\bestimate\b/i],
  [
    "order_confirmation",
    /\border[\s_-]*confirmation\b|\bconfirmation\b|\bconfirmed\b|\backnowledge?ment\b|\bsales[\s_-]*order\b/i,
  ],
];

// The earliest kind word in one piece of text, or null.
function kindIn(textValue: unknown): DispatchSupplierDocKind | null {
  const s = String(textValue ?? "").replace(/[_]+/g, " ");
  let best: { kind: DispatchSupplierDocKind; at: number } | null = null;
  for (const [kind, re] of KIND_PATTERNS) {
    const m = s.match(re);
    if (m && m.index !== undefined && (!best || m.index < best.at)) {
      best = { kind, at: m.index };
    }
  }
  return best ? best.kind : null;
}

/** What a supplier's document is: its file name first, then the email's
 * subject, then its first words. In each, the earliest kind word wins
 * ("PROFORMA TAX INVOICE" is an invoice; "please see attached order
 * confirmation" a confirmation). Nothing found: an order document. */
export function dispatchSupplierDocumentKind(input: {
  fileName?: unknown;
  subject?: unknown;
  snippet?: unknown;
}): DispatchSupplierDocKind {
  return kindIn(input.fileName) ?? kindIn(input.subject) ??
    kindIn(input.snippet) ?? "order_document";
}

const KIND_WORDS: Record<DispatchSupplierDocKind, string> = {
  order_confirmation: "order confirmation",
  invoice: "invoice",
  quote: "quote",
  order_document: "order document",
};

/** The name the crew sees: "Stratco order confirmation", "B&D invoice". */
export function dispatchSupplierDocumentName(
  supplier: unknown,
  kind: DispatchSupplierDocKind,
): string {
  const name = typeof supplier === "string" && supplier.trim()
    ? supplier.trim()
    : "Supplier";
  return `${name} ${KIND_WORDS[kind]}`;
}

// ── Latest only (Shaun, 11 Nov 2026) ────────────────────────────────────────
//
// Shaun: "against the email thread, I only want the latest documents ... if
// they send me a quote and a price list, you don't save the price list, you
// save the quote. If they send two documents, you only save one."
//
// So one supplier document per order: the newest proper one. Side files are
// never saved: price lists, drawings, terms, brochures, credit forms,
// statements and the like, judged by the file's own name (the email's words
// describe the main document, not the extras: Bondor's "please see attached
// quote" also carried a price list).

const SIDE_FILE =
  /price[\s_-]*list|price[\s_-]*book|\bdrawings?\b|\bdwg\b|\bterms\b|conditions|\bt\s*&\s*c|brochure|catalogue|\bcatalog\b|credit[\s_-]*app|account[\s_-]*app|application[\s_-]*form|statement|spec(?:ification)?s?[\s_-]*sheet|data[\s_-]*sheet|\bm?sds\b|warranty|install(?:ation)?[\s_-]*(?:guide|instructions|manual)|colou?r[\s_-]*chart|remittance/i;

/** A side file the latest-only rule never saves (by its own file name). */
export function dispatchDocIsSideFile(fileName: unknown): boolean {
  return SIDE_FILE.test(String(fileName ?? "").replace(/[_]+/g, " "));
}

const KIND_RANK: Record<DispatchSupplierDocKind, number> = {
  invoice: 3,
  order_confirmation: 2,
  quote: 1,
  order_document: 0,
};

/** The one document to keep for an order: from the newest supplier email
 * that carries a proper document, the best one in it. A file whose own name
 * says what it is beats one that does not; then invoice (or pro forma), then
 * sales order or order confirmation, then quote. Side files never count.
 * Null when there is nothing proper. */
export function pickLatestSupplierDocument<
  T extends {
    file_name: string | null;
    received_at: string | null;
    kind: DispatchSupplierDocKind;
  },
>(candidates: T[]): T | null {
  const proper = candidates.filter((c) => !dispatchDocIsSideFile(c.file_name));
  if (proper.length === 0) return null;
  const when = (c: T) => {
    const t = Date.parse(String(c.received_at ?? ""));
    return Number.isFinite(t) ? t : -Infinity;
  };
  const newest = Math.max(...proper.map(when));
  const score = (c: T) => {
    const named = kindIn(c.file_name);
    return named ? 10 + KIND_RANK[named] : KIND_RANK[c.kind];
  };
  let best: T | null = null;
  for (const c of proper) {
    if (when(c) !== newest) continue;
    if (!best || score(c) > score(best)) best = c;
  }
  return best;
}

/** A file the capture reader kept that may be a PDF: a PDF type, or a .pdf
 * name with a generic type (Stratco sends application/octet-stream). The
 * bytes are checked as well before anything is saved. */
export function isDispatchPdfCandidate(att: {
  file_name?: unknown;
  content_type?: unknown;
}): boolean {
  const type = String(att.content_type ?? "").toLowerCase().split(";")[0]
    .trim();
  const name = String(att.file_name ?? "").toLowerCase().trim();
  if (type === "application/pdf" || type === "application/x-pdf") return true;
  const generic = type === "" || type === "application/octet-stream" ||
    type === "binary/octet-stream" || type === "application/download";
  return generic && name.endsWith(".pdf");
}

/** The bytes start like a PDF ("%PDF-" within the first 1 KB). */
export function hasPdfMagic(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, Math.min(bytes.length, 1024));
  for (let i = 0; i + 4 < head.length; i++) {
    if (
      head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 &&
      head[i + 3] === 0x46 && head[i + 4] === 0x2d
    ) return true;
  }
  return false;
}

/** The name the crew sees for the order's own photos (Tweak 5):
 * "Stratco order photo 1", "Stratco order photo 2". */
export function dispatchOrderPhotoName(supplier: unknown, number: number): string {
  const name = typeof supplier === "string" && supplier.trim()
    ? supplier.trim()
    : "Supplier";
  return `${name} order photo ${number}`;
}

/** Is this order just photos (Tweak 5)? No material line on the order and at
 * least one photo. Such an order gets its photos on the job instead of our
 * order sheet. order: a dispatch_supplier_order_emails row (order_lines,
 * photo_ids). */
export function dispatchOrderIsPhotoOnly(order: {
  order_lines?: unknown;
  photo_ids?: unknown;
}): boolean {
  const lines = Array.isArray(order?.order_lines) ? order.order_lines : [];
  const photos = Array.isArray(order?.photo_ids) ? order.photo_ids : [];
  return lines.length === 0 && photos.length > 0;
}

// The file kinds a saved document may be. A PDF is the default; the order's
// photos are JPEG, PNG or WebP (the only kinds Dispatch takes).
const FILE_KINDS: Record<string, { extension: string }> = {
  "application/pdf": { extension: "pdf" },
  "image/jpeg": { extension: "jpg" },
  "image/png": { extension: "png" },
  "image/webp": { extension: "webp" },
};

/** Do the bytes really hold the kind of file we are about to save? A PDF
 * starts with "%PDF-"; a JPEG, PNG or WebP has its own first bytes. */
export function dispatchDocBytesAre(
  bytes: Uint8Array,
  contentType: string,
): boolean {
  if (contentType === "application/pdf") return hasPdfMagic(bytes);
  if (contentType === "image/jpeg") {
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/png") {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
      bytes[3] === 0x47;
  }
  if (contentType === "image/webp") {
    const ascii = (from: number, to: number) =>
      String.fromCharCode(...bytes.subarray(from, to));
    return bytes.length >= 12 && ascii(0, 4) === "RIFF" &&
      ascii(8, 12) === "WEBP";
  }
  return false;
}

/** A storage-safe file name: letters, digits, dot, dash, underscore. */
export function dispatchDocSafeName(name: string): string {
  const s = name.replace(/&/g, "and").replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-").replace(/^-|-$/g, "");
  return (s || "document").slice(0, 80);
}

/** Where a saved document lives in the job-documents bucket. The hash in
 * the path makes a retry write the same object. */
export function dispatchDocStoragePath(
  jobId: string,
  sha256: string,
  displayName: string,
  extension = "pdf",
): string {
  return `${jobId}/dispatch-orders/${sha256.slice(0, 16)}-${
    dispatchDocSafeName(displayName)
  }.${extension}`;
}

export async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

// ── Reads ───────────────────────────────────────────────────────────────────

function log(label: string, error: unknown) {
  console.error(`[dispatch_v2_order_documents] ${label}:`, error);
}

export type DispatchPdfCandidate = {
  sha256: string;
  file_name: string | null;
  attachment_id: string | null;
  storage_bucket: string;
  storage_path: string;
  reply_email_id: string;
  received_at: string | null;
  kind: DispatchSupplierDocKind;
};

const REPLY_SELECT =
  "id, org_id, order_id, state, provider_message_id, subject, snippet, received_at";
const ATTACHMENT_SELECT =
  "id, provider_message_id, file_name, content_type, sha256, storage_bucket, storage_path, status";

/** The PDFs on the order's matched replies, one per file (by SHA-256),
 * oldest reply first, so the newest is saved last and shows on top.
 * read: 'failed' when the replies or their files could not be read. */
export async function listDispatchOrderPdfs(
  client: any,
  orgId: string,
  orderId: string,
): Promise<{ read: "ok" | "failed"; candidates: DispatchPdfCandidate[] }> {
  const replies = await client.from("dispatch_v2_supplier_emails")
    .select(REPLY_SELECT)
    .eq("order_id", orderId)
    .eq("org_id", orgId)
    .eq("state", "matched")
    .order("received_at", { ascending: true })
    .limit(50);
  if (replies.error) {
    log("matched replies read failed", replies.error);
    return { read: "failed", candidates: [] };
  }
  const rows = (replies.data || []).filter((r: any) => r.provider_message_id);
  if (rows.length === 0) return { read: "ok", candidates: [] };
  const byMessage = new Map<string, any>();
  for (const r of rows) byMessage.set(String(r.provider_message_id), r);

  const atts = await client.from("context_email_attachments")
    .select(ATTACHMENT_SELECT)
    .in("provider_message_id", [...byMessage.keys()])
    .in("status", ["stored", "skipped_duplicate"]);
  if (atts.error) {
    log("attachments read failed", atts.error);
    return { read: "failed", candidates: [] };
  }
  const pdfs = (atts.data || []).filter((a: any) =>
    isDispatchPdfCandidate(a) && typeof a.sha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(a.sha256)
  );
  // A file the reader had already kept from another email is recorded as
  // skipped_duplicate with no copy of its own: find the copy by its hash.
  const needCopy = [
    ...new Set(
      pdfs.filter((a: any) => a.status !== "stored" || !a.storage_path)
        .map((a: any) => String(a.sha256).toLowerCase()),
    ),
  ];
  const copies = new Map<string, any>();
  if (needCopy.length > 0) {
    const stored = await client.from("context_email_attachments")
      .select(ATTACHMENT_SELECT)
      .in("sha256", needCopy)
      .eq("status", "stored");
    if (stored.error) log("stored copies read failed", stored.error);
    for (const a of stored.data || []) {
      if (a.storage_path && a.storage_bucket) {
        copies.set(String(a.sha256).toLowerCase(), a);
      }
    }
  }

  const seen = new Set<string>();
  const out: DispatchPdfCandidate[] = [];
  // Oldest reply first.
  const ordered = [...pdfs].sort((a: any, b: any) => {
    const ra = byMessage.get(String(a.provider_message_id))?.received_at ?? "";
    const rb = byMessage.get(String(b.provider_message_id))?.received_at ?? "";
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
  for (const a of ordered) {
    const sha = String(a.sha256).toLowerCase();
    if (seen.has(sha)) continue;
    const copy = a.status === "stored" && a.storage_path && a.storage_bucket
      ? a
      : copies.get(sha);
    if (!copy) continue;
    seen.add(sha);
    const reply = byMessage.get(String(a.provider_message_id));
    out.push({
      sha256: sha,
      file_name: typeof a.file_name === "string" ? a.file_name : null,
      attachment_id: copy.id ? String(copy.id) : null,
      storage_bucket: String(copy.storage_bucket),
      storage_path: String(copy.storage_path),
      reply_email_id: String(reply.id),
      received_at: reply.received_at ?? null,
      kind: dispatchSupplierDocumentKind({
        fileName: a.file_name,
        subject: reply.subject,
        snippet: reply.snippet,
      }),
    });
  }
  return { read: "ok", candidates: out };
}

// ── Saving one document (shared with the order sheet) ───────────────────────

export type DispatchSaveDocInput = {
  orgId: string;
  jobId: string;
  orderId: string;
  supplierId: string | null;
  source: DispatchDocSource;
  kind: DispatchSupplierDocKind | "order_sheet" | "order_photo";
  displayName: string;
  sha256: string;
  replyEmailId?: string | null;
  attachmentId?: string | null;
  sourceFileName?: string | null;
  // The bytes, or how to fetch them (from the private capture bucket).
  bytes: () => Promise<Uint8Array | null>;
  // The file's type: left out, a PDF. The order's photos pass image/jpeg,
  // image/png or image/webp.
  contentType?: string;
  // Saved under the latest-only rule (Shaun, 11 Nov 2026): a newer supplier
  // document for the same order replaces it. Marked on the job document as
  // metadata.latest_only, so only these are ever removed by the rule.
  latestOnly?: boolean;
  trigger: string;
  operatorUserId?: string | null;
  now: string;
};

export type DispatchSaveDocResult =
  | { saved: true; job_document_id: string; name: string; sha256: string }
  | {
    saved: false;
    reason:
      | "already_saved"
      | "in_progress"
      | "claim_failed"
      | "not_a_pdf"
      | "not_an_image"
      | "hash_mismatch"
      | "download_failed"
      | "upload_failed"
      | "document_failed";
    sha256: string;
  };

async function claimDoc(
  client: any,
  input: DispatchSaveDocInput,
): Promise<{ id: string } | DispatchSaveDocResult> {
  const row = {
    org_id: input.orgId,
    job_id: input.jobId,
    order_id: input.orderId,
    supplier_id: input.supplierId,
    source: input.source,
    kind: input.kind,
    content_sha256: input.sha256,
    reply_email_id: input.replyEmailId ?? null,
    attachment_id: input.attachmentId ?? null,
    source_file_name: input.sourceFileName ?? null,
    state: "claimed",
    claimed_at: input.now,
  };
  const ins = await client.from("dispatch_v2_order_documents").insert(row)
    .select("id").maybeSingle();
  if (!ins.error && ins.data?.id) return { id: String(ins.data.id) };
  if (ins.error && String(ins.error.code ?? "") !== "23505") {
    log("document claim failed", ins.error);
    return { saved: false, reason: "claim_failed", sha256: input.sha256 };
  }
  // Already claimed (same file on this job, or this order's sheet).
  const existing = await client.from("dispatch_v2_order_documents")
    .select("id, state, claimed_at")
    .eq("job_id", input.jobId)
    .eq("content_sha256", input.sha256)
    .maybeSingle();
  if (existing.error || !existing.data) {
    return { saved: false, reason: "already_saved", sha256: input.sha256 };
  }
  if (existing.data.state === "saved") {
    return { saved: false, reason: "already_saved", sha256: input.sha256 };
  }
  const claimedAt = Date.parse(String(existing.data.claimed_at ?? ""));
  if (
    Number.isFinite(claimedAt) &&
    Date.parse(input.now) - claimedAt < DISPATCH_DOC_CLAIM_STALE_MS
  ) {
    return { saved: false, reason: "in_progress", sha256: input.sha256 };
  }
  // A claim left by a run that died: take it over, only while it is still
  // the same stale claim.
  const take = await client.from("dispatch_v2_order_documents")
    .update({ claimed_at: input.now })
    .eq("id", existing.data.id)
    .eq("state", "claimed")
    .eq("claimed_at", existing.data.claimed_at)
    .select("id");
  if (take.error || !(take.data || []).length) {
    return { saved: false, reason: "in_progress", sha256: input.sha256 };
  }
  return { id: String(existing.data.id) };
}

async function releaseClaim(client: any, claimId: string) {
  const { error } = await client.from("dispatch_v2_order_documents").delete()
    .eq("id", claimId)
    .eq("state", "claimed");
  if (error) log("document claim release failed", error);
}

/** Save one file (a PDF, or one of the order's photos) to the job once:
 * claim, fetch and check the bytes, upload to job-documents, add the
 * job_documents row (material_order, crew-visible), then mark the claim
 * saved. A failure gives the claim back. Never throws. */
export async function saveDispatchOrderDocument(
  client: any,
  input: DispatchSaveDocInput,
): Promise<DispatchSaveDocResult> {
  const fail = (reason: any): DispatchSaveDocResult => ({
    saved: false,
    reason,
    sha256: input.sha256,
  });
  const contentType = input.contentType ?? "application/pdf";
  const fileKind = FILE_KINDS[contentType];
  // A type we do not save is refused before anything is claimed.
  if (!fileKind) return fail("not_an_image");
  let claimId: string | null = null;
  try {
    const claim = await claimDoc(client, input);
    if (!("id" in claim)) return claim;
    claimId = claim.id;

    let bytes: Uint8Array | null = null;
    try {
      bytes = await input.bytes();
    } catch (e) {
      log("document download failed", e);
    }
    if (!bytes) {
      await releaseClaim(client, claimId);
      return fail("download_failed");
    }
    if (!dispatchDocBytesAre(bytes, contentType)) {
      await releaseClaim(client, claimId);
      return fail(contentType === "application/pdf" ? "not_a_pdf" : "not_an_image");
    }
    if ((await sha256HexOf(bytes)) !== input.sha256) {
      await releaseClaim(client, claimId);
      return fail("hash_mismatch");
    }

    const path = dispatchDocStoragePath(
      input.jobId,
      input.sha256,
      input.displayName,
      fileKind.extension,
    );
    const bucket = client.storage.from(DISPATCH_DOCS_BUCKET);
    const up = await bucket.upload(path, bytes, {
      contentType,
      upsert: true,
    });
    if (up?.error) {
      log("document upload failed", up.error);
      await releaseClaim(client, claimId);
      return fail("upload_failed");
    }
    const url = bucket.getPublicUrl(path)?.data?.publicUrl ?? null;
    if (!url) {
      await releaseClaim(client, claimId);
      return fail("upload_failed");
    }
    const fileName = `${dispatchPdfText(input.displayName)}.${fileKind.extension}`;
    const doc = await client.from("job_documents").insert({
      job_id: input.jobId,
      type: DISPATCH_DOC_TYPE,
      file_name: fileName,
      pdf_url: url,
      storage_url: url,
      visible_to_trades: true,
      uploaded_by: input.operatorUserId ?? null,
      metadata: {
        source: "dispatch_v2_order_confirmed",
        document_source: input.source,
        kind: input.kind,
        order_id: input.orderId,
        supplier_id: input.supplierId,
        content_sha256: input.sha256,
        reply_email_id: input.replyEmailId ?? null,
        storage_path: path,
        trigger: input.trigger,
        ...(input.latestOnly ? { latest_only: true } : {}),
      },
    }).select("id").maybeSingle();
    if (doc.error || !doc.data?.id) {
      log("job document insert failed", doc.error);
      await releaseClaim(client, claimId);
      return fail("document_failed");
    }
    const jobDocumentId = String(doc.data.id);
    const mark = await client.from("dispatch_v2_order_documents")
      .update({
        state: "saved",
        saved_at: input.now,
        job_document_id: jobDocumentId,
        storage_path: path,
      })
      .eq("id", claimId);
    if (mark.error) log("document claim mark failed", mark.error);
    const audit = await client.from("job_events").insert({
      job_id: input.jobId,
      user_id: input.operatorUserId ?? null,
      event_type: "dispatch_v2_order_document_saved",
      detail_json: {
        order_id: input.orderId,
        supplier_id: input.supplierId,
        job_document_id: jobDocumentId,
        name: fileName,
        kind: input.kind,
        source: input.source,
        trigger: input.trigger,
      },
    });
    if (audit.error) log("document audit insert failed", audit.error);
    return {
      saved: true,
      job_document_id: jobDocumentId,
      name: fileName,
      sha256: input.sha256,
    };
  } catch (e) {
    log("document save failed", e);
    if (claimId) await releaseClaim(client, claimId);
    return fail("document_failed");
  }
}

// ── The supplier's documents for one order ──────────────────────────────────

export type DispatchOrderDocumentsResult = {
  read: "ok" | "failed";
  // How many PDFs the order's matched replies carry (saved before or now).
  found: number;
  saved: Array<{ job_document_id: string; name: string }>;
  skipped: Array<{ sha256: string; reason: string }>;
  // Older latest-only documents of this order taken off the job because a
  // newer one replaced them.
  replaced: Array<{ job_document_id: string; name: string | null }>;
};

// Reasons a file was left alone on purpose (not a failure).
export const DISPATCH_DOC_SKIP_OK = new Set([
  "already_saved",
  "in_progress",
  "side_file",
  "not_latest",
]);

/** Take the order's older latest-only supplier documents off the job, keeping
 * the file with keepSha. Only job documents this rule saved (metadata
 * latest_only) are removed: anything saved before the rule, or added by
 * hand, stays. The memory row stays 'saved' (migration 20261111150000), so a
 * removed file is never saved again. The file stays in the supplier's email.
 * Never throws. */
async function removeReplacedSupplierDocuments(
  client: any,
  input: {
    jobId: string;
    orderId: string;
    keepSha: string;
    trigger: string;
    operatorUserId?: string | null;
  },
): Promise<Array<{ job_document_id: string; name: string | null }>> {
  try {
    const mem = await client.from("dispatch_v2_order_documents")
      .select("content_sha256, job_document_id, state, source")
      .eq("job_id", input.jobId)
      .eq("order_id", input.orderId)
      .eq("source", "supplier_reply")
      .eq("state", "saved");
    if (mem.error) {
      log("replaced documents read failed", mem.error);
      return [];
    }
    const ids = (mem.data || [])
      .filter((r: any) =>
        r.job_document_id && String(r.content_sha256) !== input.keepSha
      )
      .map((r: any) => String(r.job_document_id));
    if (ids.length === 0) return [];
    const docs = await client.from("job_documents")
      .select("id, file_name, metadata")
      .in("id", ids);
    if (docs.error) {
      log("replaced job documents read failed", docs.error);
      return [];
    }
    const gone = (docs.data || []).filter((d: any) =>
      d?.metadata?.latest_only === true
    ).map((d: any) => ({
      job_document_id: String(d.id),
      name: typeof d.file_name === "string" ? d.file_name : null,
    }));
    if (gone.length === 0) return [];
    const goneIds = gone.map((g: { job_document_id: string }) => g.job_document_id);
    const del = await client.from("job_documents").delete().in("id", goneIds);
    if (del.error) {
      log("replaced job documents delete failed", del.error);
      return [];
    }
    // The foreign key already clears these; said here too so the memory
    // never points at a removed document whatever the database does.
    const clear = await client.from("dispatch_v2_order_documents")
      .update({ job_document_id: null })
      .in("job_document_id", goneIds);
    if (clear.error) log("replaced memory clear failed", clear.error);
    const audit = await client.from("job_events").insert({
      job_id: input.jobId,
      user_id: input.operatorUserId ?? null,
      event_type: "dispatch_v2_order_document_replaced",
      detail_json: {
        order_id: input.orderId,
        kept_sha256: input.keepSha,
        removed: gone,
        trigger: input.trigger,
      },
    });
    if (audit.error) log("replaced audit insert failed", audit.error);
    return gone;
  } catch (e) {
    log("replace failed", e);
    return [];
  }
}

/** Latest only (Shaun, 11 Nov 2026): keep ONE supplier document per order on
 * the job, the newest proper one (pickLatestSupplierDocument). When a newer
 * one arrives it is saved and the older one this rule saved is taken off the
 * job. Side files and older documents are never saved. order: a
 * dispatch_supplier_order_emails row (id, job_id, supplier_id,
 * supplier_name). Never throws. */
export async function saveDispatchSupplierDocuments(
  client: any,
  input: {
    orgId: string;
    order: any;
    trigger: string;
    operatorUserId?: string | null;
    now: string;
  },
): Promise<DispatchOrderDocumentsResult> {
  const result: DispatchOrderDocumentsResult = {
    read: "ok",
    found: 0,
    saved: [],
    skipped: [],
    replaced: [],
  };
  try {
    const orderId = String(input.order.id);
    const listed = await listDispatchOrderPdfs(client, input.orgId, orderId);
    result.read = listed.read;
    // Proper documents only: side files do not count, so an order whose
    // supplier sent only a price list still gets our order sheet.
    result.found = listed.candidates.filter((c) =>
      !dispatchDocIsSideFile(c.file_name)
    ).length;
    if (listed.candidates.length === 0) return result;
    const chosen = pickLatestSupplierDocument(listed.candidates);
    for (const c of listed.candidates) {
      if (c === chosen) continue;
      result.skipped.push({
        sha256: c.sha256,
        reason: dispatchDocIsSideFile(c.file_name) ? "side_file" : "not_latest",
      });
    }
    if (!chosen) return result;
    const jobId = String(input.order.job_id);
    // Already on the job (or saved once and deleted by the office): no claim.
    const have = await client.from("dispatch_v2_order_documents")
      .select("content_sha256, state")
      .eq("job_id", jobId)
      .eq("content_sha256", chosen.sha256);
    const already = (have.error ? [] : have.data || []).some((r: any) =>
      r.state === "saved"
    );
    let onJob = already;
    if (already) {
      result.skipped.push({ sha256: chosen.sha256, reason: "already_saved" });
    }
    for (const c of already ? [] : [chosen]) {
      const saved = await saveDispatchOrderDocument(client, {
        orgId: input.orgId,
        jobId,
        orderId,
        supplierId: input.order.supplier_id ?? null,
        source: "supplier_reply",
        kind: c.kind,
        displayName: dispatchSupplierDocumentName(
          input.order.supplier_name,
          c.kind,
        ),
        sha256: c.sha256,
        replyEmailId: c.reply_email_id,
        attachmentId: c.attachment_id,
        sourceFileName: c.file_name,
        bytes: async () => {
          const { data, error } = await client.storage.from(c.storage_bucket)
            .download(c.storage_path);
          if (error || !data) {
            log("capture copy download failed", error);
            return null;
          }
          return new Uint8Array(await data.arrayBuffer());
        },
        latestOnly: true,
        trigger: input.trigger,
        operatorUserId: input.operatorUserId ?? null,
        now: input.now,
      });
      if (saved.saved) {
        onJob = true;
        result.saved.push({
          job_document_id: saved.job_document_id,
          name: saved.name,
        });
      } else {
        result.skipped.push({ sha256: c.sha256, reason: saved.reason });
      }
    }
    // Only once the newest one is safely on the job (or already was) does
    // the older one come off.
    if (onJob) {
      result.replaced = await removeReplacedSupplierDocuments(client, {
        jobId,
        orderId,
        keepSha: chosen.sha256,
        trigger: input.trigger,
        operatorUserId: input.operatorUserId ?? null,
      });
    }
    return result;
  } catch (e) {
    log("supplier documents failed", e);
    return { ...result, read: "failed" };
  }
}

// ── The order's own photos (Tweak 5) ────────────────────────────────────────

const PHOTO_SELECT = "id, job_id, file_name, content_type, sha256, storage_path";

/** Save the photos that went on our order email to the job, once each,
 * named "<Supplier> order photo 1", "2", ... in the order they were attached.
 * The caller decides WHEN: only after the matched replies were read and none
 * carries a PDF (dispatch_v2_order_confirmed_write.ts). order: a
 * dispatch_supplier_order_emails row with id, job_id, supplier_id,
 * supplier_name and photo_ids. The photos are copied from the private
 * dispatch-material-photos bucket; a photo whose bytes no longer match the
 * SHA-256 recorded at upload is not saved. Never throws. */
export async function saveDispatchOrderPhotos(
  client: any,
  input: {
    orgId: string;
    order: any;
    trigger: string;
    operatorUserId?: string | null;
    now: string;
  },
): Promise<DispatchOrderDocumentsResult> {
  const result: DispatchOrderDocumentsResult = {
    read: "ok",
    found: 0,
    saved: [],
    skipped: [],
    replaced: [],
  };
  try {
    const ids: string[] = (Array.isArray(input.order?.photo_ids)
      ? input.order.photo_ids
      : []).map(String);
    if (ids.length === 0) return result;
    const jobId = String(input.order.job_id);
    const read = await client.from("dispatch_material_photos")
      .select(PHOTO_SELECT)
      .eq("job_id", jobId)
      .in("id", ids);
    if (read.error) {
      log("order photos read failed", read.error);
      return { ...result, read: "failed" };
    }
    const rows = read.data || [];
    const supplier = String(input.order.supplier_name ?? "").trim() ||
      "Supplier";
    for (let i = 0; i < ids.length; i++) {
      const photo = rows.find((r: any) => String(r.id) === ids[i]);
      const sha = String(photo?.sha256 ?? "").toLowerCase();
      // A photo removed since the send, or one with no hash on file, cannot
      // be checked, so it is not saved.
      if (!photo || !/^[0-9a-f]{64}$/.test(sha) || !photo.storage_path) {
        result.skipped.push({ sha256: sha, reason: "photo_not_found" });
        continue;
      }
      result.found++;
      const saved = await saveDispatchOrderDocument(client, {
        orgId: input.orgId,
        jobId,
        orderId: String(input.order.id),
        supplierId: input.order.supplier_id ?? null,
        source: "order_photo",
        kind: "order_photo",
        displayName: dispatchOrderPhotoName(supplier, i + 1),
        sha256: sha,
        sourceFileName: typeof photo.file_name === "string"
          ? photo.file_name
          : null,
        contentType: String(photo.content_type ?? ""),
        bytes: async () => {
          const { data, error } = await client.storage.from(
            DISPATCH_V2_PHOTO_BUCKET,
          ).download(photo.storage_path);
          if (error || !data) {
            log("order photo download failed", error);
            return null;
          }
          return new Uint8Array(await data.arrayBuffer());
        },
        trigger: input.trigger,
        operatorUserId: input.operatorUserId ?? null,
        now: input.now,
      });
      if (saved.saved) {
        result.saved.push({
          job_document_id: saved.job_document_id,
          name: saved.name,
        });
      } else {
        result.skipped.push({ sha256: sha, reason: saved.reason });
      }
    }
    return result;
  } catch (e) {
    log("order photos failed", e);
    return { ...result, read: "failed" };
  }
}

// ── The five-minute sweep for later documents ───────────────────────────────

// How far back the sweep looks for confirmed orders (by their first crew
// line). A supplier's invoice usually lands within days of the order.
export const DISPATCH_DOC_SWEEP_DAYS = 45;
const SWEEP_ORDER_LIMIT = 200;
// Only orders whose matched replies changed this recently are opened.
export const DISPATCH_DOC_SWEEP_REPLY_DAYS = 7;

/** After each reply scan: for every order confirmed in the last 45 days (it
 * has a crew pickup line) with a matched reply that changed in the last 7
 * days, save any new PDF on its matched replies, such as a later invoice. Orders confirmed before Tweak 1 shipped have no crew line,
 * so they are never swept (no backfill). Never throws. */
export async function sweepDispatchV2OrderDocuments(
  client: any,
  input: { orgId: string; now: string },
): Promise<{ orders: number; saved: number; failed: number }> {
  const out = { orders: 0, saved: 0, failed: 0 };
  try {
    const since = new Date(
      Date.parse(input.now) - DISPATCH_DOC_SWEEP_DAYS * 86_400_000,
    ).toISOString();
    const lines = await client.from("dispatch_v2_order_crew_lines")
      .select("order_id, created_at")
      .eq("org_id", input.orgId)
      .eq("seq", 1)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(SWEEP_ORDER_LIMIT);
    if (lines.error) {
      log("sweep crew lines read failed", lines.error);
      return out;
    }
    const confirmed = [
      ...new Set((lines.data || []).map((l: any) => String(l.order_id))),
    ];
    if (confirmed.length === 0) return out;
    // Only orders with a matched reply that changed in the last week: a new
    // reply, or one a person tied to the order. The rest have nothing new.
    const recent = new Date(
      Date.parse(input.now) - DISPATCH_DOC_SWEEP_REPLY_DAYS * 86_400_000,
    ).toISOString();
    const fresh = await client.from("dispatch_v2_supplier_emails")
      .select("order_id, updated_at")
      .eq("org_id", input.orgId)
      .eq("state", "matched")
      .in("order_id", confirmed)
      .gte("updated_at", recent);
    if (fresh.error) {
      log("sweep replies read failed", fresh.error);
      return out;
    }
    const orderIds = [
      ...new Set((fresh.data || []).map((r: any) => String(r.order_id))),
    ];
    if (orderIds.length === 0) return out;
    const orders = await client.from("dispatch_supplier_order_emails")
      .select("id, org_id, job_id, supplier_id, supplier_name")
      .in("id", orderIds);
    if (orders.error) {
      log("sweep orders read failed", orders.error);
      return out;
    }
    for (const order of orders.data || []) {
      if (String(order.org_id ?? input.orgId) !== input.orgId) continue;
      out.orders++;
      const r = await saveDispatchSupplierDocuments(client, {
        orgId: input.orgId,
        order,
        trigger: "sweep",
        now: input.now,
      });
      out.saved += r.saved.length;
      out.failed += r.skipped.filter((s) => !DISPATCH_DOC_SKIP_OK.has(s.reason))
        .length;
    }
    return out;
  } catch (e) {
    log("sweep failed", e);
    return out;
  }
}
