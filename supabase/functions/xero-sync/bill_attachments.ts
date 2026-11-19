// Read supplier-bill PDFs already stored from email, or from Xero when no
// stored PDF matches, and keep only the findings (job number, PO, delivery
// address). The PDF text itself is never stored. Off until
// xero_bill_attachment_read_v1 is on: no Xero call and no write.
// Proposals only. This module never places a cost.

import { readSwitch } from "../_shared/switch_cache.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import { PDF_TEXT_MAX_BYTES, extractPdfText } from "../ops-api/makesafe_pdf_text.ts";
import {
  fileNameCarriesInvoice,
  invoiceNumberKey,
  jobNumbersIn,
} from "./bill_prematch.ts";
import { BILL_ATTACHMENT_READ_FLAG } from "./match/doc_clues.ts";

export { BILL_ATTACHMENT_READ_FLAG };
export const BILL_ATTACHMENT_DEFAULT_LIMIT = 20;
export const BILL_ATTACHMENT_MAX_LIMIT = 40;
export const CONTEXT_EMAIL_ATTACHMENTS_BUCKET = "context-email-attachments";

const SCAN_PAGE = 100;
const SCAN_PAGES = 8;
const PO_RE = /(?<![A-Z0-9])PO(?![A-Z])[\s#:.-]{0,3}(\d{4,10})(?!\d)/gi;
const ORDER_REF_RE =
  /(?:order\s*ref(?:erence)?|your\s*ref(?:erence)?|customer\s*ref(?:erence)?|job\s*ref(?:erence)?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9./-]{2,40})/i;
const DELIVERY_RE =
  /(?:delivery\s+address|deliver\s+to|ship\s+to)\s*[:\-]?\s*([^\n\r]{6,160})/i;

export interface BillAttachmentXeroFile {
  attachment_id: string;
  file_name: string | null;
  mime_type: string | null;
  content_length: number | null;
}

export interface BillAttachmentXero {
  list(invoiceId: string): Promise<BillAttachmentXeroFile[]>;
  download(invoiceId: string, fileName: string): Promise<Uint8Array>;
}

export interface ReadBillAttachmentsOptions {
  orgId: string;
  limit?: number;
  xero?: BillAttachmentXero;
  extractText?: (bytes: Uint8Array) => Promise<{ text: string; note?: string }>;
}

export function billAttachmentLimit(raw: string | null | undefined): number {
  if (raw == null || String(raw).trim() === "") return BILL_ATTACHMENT_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return BILL_ATTACHMENT_DEFAULT_LIMIT;
  return Math.min(BILL_ATTACHMENT_MAX_LIMIT, Math.max(1, Math.floor(n)));
}

export function poNumbersIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(new RegExp(PO_RE.source, "gi"))) {
    const token = `PO-${match[1]}`;
    if (!out.includes(token)) out.push(token);
    if (out.length >= 10) break;
  }
  return out;
}

export interface BillAttachmentFindings {
  job_numbers: string[];
  po_numbers: string[];
  order_ref: string | null;
  delivery_address: string | null;
}

/** Findings only. The source text is not part of the result. */
export function findingsFromText(text: string): BillAttachmentFindings {
  const jobs: string[] = [];
  for (const n of jobNumbersIn(text)) {
    if (!jobs.includes(n)) jobs.push(n);
    if (jobs.length >= 10) break;
  }
  const ref = text.match(ORDER_REF_RE)?.[1]?.trim().slice(0, 80) ?? null;
  let delivery: string | null = null;
  const line = text.match(DELIVERY_RE)?.[1]?.trim().slice(0, 160) ?? "";
  if (/\d/.test(line) && /[A-Za-z]/.test(line)) delivery = line;
  return {
    job_numbers: jobs,
    po_numbers: poNumbersIn(text),
    order_ref: ref && ref.length > 0 ? ref : null,
    delivery_address: delivery,
  };
}

function errCode(err: unknown): string {
  // deno-lint-ignore no-explicit-any
  const raw = String((err as any)?.code || (err as any)?.name || "error");
  const clean = raw.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
  return clean || "error";
}

function isPdf(mime: string | null, fileName: string | null): boolean {
  if ((mime ?? "").toLowerCase().includes("pdf")) return true;
  return (fileName ?? "").toLowerCase().endsWith(".pdf");
}

function lengthOrNull(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0 || value > 2_147_483_647) return null;
  return Math.floor(value);
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function toBytes(payload: unknown): Promise<Uint8Array | null> {
  if (!payload) return null;
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  // deno-lint-ignore no-explicit-any
  const blobLike = payload as any;
  if (typeof blobLike.arrayBuffer === "function") {
    return new Uint8Array(await blobLike.arrayBuffer());
  }
  return null;
}

async function defaultExtract(bytes: Uint8Array): Promise<{ text: string; note?: string }> {
  const res = await extractPdfText(bytes);
  return { text: res.text || "", note: res.note };
}

interface CandidateBill {
  xero_invoice_id: string;
  invoice_number: string | null;
  has_attachments: boolean;
}

interface StoredRead {
  org_id: string;
  xero_invoice_id: string;
  attachment_id: string;
  source: "xero" | "email";
  file_name: string | null;
  mime_type: string | null;
  content_length: number | null;
  state: "listed" | "text_read" | "no_text" | "too_large" | "unsupported" | "failed";
  text_sha256: string | null;
  text_chars: number | null;
  job_numbers: string[];
  po_numbers: string[];
  order_ref: string | null;
  delivery_address: string | null;
  error_code: string | null;
}

function emptyRead(
  orgId: string,
  invoiceId: string,
  attachmentId: string,
  source: "xero" | "email",
  state: StoredRead["state"],
  errorCode: string | null,
): StoredRead {
  return {
    org_id: orgId,
    xero_invoice_id: invoiceId,
    attachment_id: attachmentId,
    source,
    file_name: null,
    mime_type: null,
    content_length: null,
    state,
    text_sha256: null,
    text_chars: null,
    job_numbers: [],
    po_numbers: [],
    order_ref: null,
    delivery_address: null,
    error_code: errorCode,
  };
}

// deno-lint-ignore no-explicit-any
async function loadSeen(sb: any, orgId: string): Promise<Set<string> | null> {
  const { data, error } = await sb.from("xero_bill_attachment_reads")
    .select("xero_invoice_id").eq("org_id", orgId).limit(2000);
  if (error) return null;
  return new Set((data ?? []).map((row: { xero_invoice_id?: string }) => String(row.xero_invoice_id || "")).filter(Boolean));
}

// deno-lint-ignore no-explicit-any
async function loadCandidates(sb: any, orgId: string, limit: number, seen: Set<string>): Promise<CandidateBill[] | null> {
  const out: CandidateBill[] = [];
  let after = "";
  for (let page = 0; page < SCAN_PAGES && out.length < limit; page++) {
    let query = sb.from("xero_invoices")
      .select("xero_invoice_id,invoice_number,reference,has_attachments:raw_json->>HasAttachments")
      .eq("org_id", orgId)
      .eq("invoice_type", "ACCPAY")
      .not("status", "in", "(VOIDED,DELETED)")
      .or("reference.is.null,reference.eq.,raw_json->>HasAttachments.eq.true")
      .order("xero_invoice_id", { ascending: true })
      .limit(SCAN_PAGE);
    if (after) query = query.gt("xero_invoice_id", after);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) return null;
    if (!data.length) break;
    after = String(data[data.length - 1]?.xero_invoice_id || after);
    const ids = data.map((row: { xero_invoice_id?: string }) => String(row.xero_invoice_id || "")).filter(Boolean);
    const { data: trade, error: tradeErr } = await sb.from("trade_invoices")
      .select("xero_bill_id").in("xero_bill_id", ids);
    if (tradeErr) return null;
    const tradeIds = new Set((trade ?? []).map((row: { xero_bill_id?: string }) => String(row.xero_bill_id || "")));
    for (const row of data) {
      const id = String(row?.xero_invoice_id || "");
      if (!id || seen.has(id) || tradeIds.has(id)) continue;
      const reference = typeof row.reference === "string" ? row.reference.trim() : "";
      const attached = String(row.has_attachments) === "true";
      if (reference && !attached) continue;
      out.push({
        xero_invoice_id: id,
        invoice_number: typeof row.invoice_number === "string" ? row.invoice_number : null,
        has_attachments: attached,
      });
      if (out.length >= limit) break;
    }
    if (data.length < SCAN_PAGE) break;
  }
  return out;
}

interface EmailPdf {
  id: string;
  file_name: string | null;
  content_type: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  size_bytes: number | null;
}

// deno-lint-ignore no-explicit-any
async function emailPdfs(sb: any, invoiceNumber: string | null): Promise<EmailPdf[] | null> {
  const key = invoiceNumberKey(invoiceNumber);
  const digits = (key ?? "").replace(/[^0-9]/g, "");
  if (!key || digits.length < 4) return [];
  const { data, error } = await sb.from("context_email_attachments")
    .select("id,file_name,content_type,storage_bucket,storage_path,size_bytes")
    .eq("status", "stored")
    .eq("content_type", "application/pdf")
    .ilike("file_name", `%${digits}%`)
    .limit(20);
  if (error || !Array.isArray(data)) return null;
  return (data as EmailPdf[]).filter((row) => fileNameCarriesInvoice(row.file_name, key)).slice(0, 5);
}

// deno-lint-ignore no-explicit-any
async function storeRead(sb: any, row: StoredRead): Promise<boolean> {
  const { error } = await sb.from("xero_bill_attachment_reads")
    .upsert(row, { onConflict: "org_id,attachment_id" });
  if (error) {
    console.error("[bill_attachments] store failed:", row.attachment_id, errCode(error));
    return false;
  }
  return true;
}

async function readFromText(
  base: StoredRead,
  text: string,
): Promise<StoredRead> {
  const trimmed = text.trim();
  if (!trimmed) return { ...base, state: "no_text", error_code: "no_text" };
  const findings = findingsFromText(trimmed);
  return {
    ...base,
    state: "text_read",
    text_sha256: await sha256Hex(trimmed),
    text_chars: trimmed.length,
    job_numbers: findings.job_numbers,
    po_numbers: findings.po_numbers,
    order_ref: findings.order_ref,
    delivery_address: findings.delivery_address,
    error_code: null,
  };
}

function noteState(note: string | undefined): StoredRead["state"] | null {
  if (note === "pdf_too_large" || note === "pdf_too_many_pages") return "too_large";
  if (note === "not_pdf") return "unsupported";
  if (note) return "no_text";
  return null;
}

export async function readBillAttachments(
  // deno-lint-ignore no-explicit-any
  sb: any,
  opts: ReadBillAttachmentsOptions,
): Promise<Record<string, unknown>> {
  if (!(await readSwitch(sb, BILL_ATTACHMENT_READ_FLAG))) {
    return { skipped: "switch_off" };
  }
  const orgId = String(opts.orgId || "").trim();
  if (!orgId) return { error: "org_id_required", bills: 0 };
  const limit = billAttachmentLimit(opts.limit == null ? null : String(opts.limit));
  const extract = opts.extractText ?? defaultExtract;
  const counts = {
    bills: 0,
    attachments: 0,
    text_read: 0,
    email: 0,
    xero: 0,
    no_text: 0,
    too_large: 0,
    unsupported: 0,
    failed: 0,
  };
  const bump = (state: StoredRead["state"]) => {
    counts.attachments++;
    if (state === "text_read") counts.text_read++;
    else if (state === "no_text") counts.no_text++;
    else if (state === "too_large") counts.too_large++;
    else if (state === "unsupported") counts.unsupported++;
    else if (state === "failed") counts.failed++;
  };

  const seen = await loadSeen(sb, orgId);
  if (!seen) return { ...counts, error: "reads_unreadable" };
  const bills = await loadCandidates(sb, orgId, limit, seen);
  if (!bills) return { ...counts, error: "candidates_unreadable" };

  try {
    for (const bill of bills) {
      counts.bills++;
      const emails = await emailPdfs(sb, bill.invoice_number);
      if (emails === null) {
        counts.failed++;
        continue;
      }
      if (emails.length) {
        for (const file of emails) {
          const row = await readEmailPdf(sb, orgId, bill.xero_invoice_id, file, extract);
          bump(row.state);
          counts.email++;
          await storeRead(sb, row);
        }
        continue;
      }
      if (!bill.has_attachments) {
        const row = emptyRead(orgId, bill.xero_invoice_id, `scan:${bill.xero_invoice_id}`, "email", "no_text", "no_pdf");
        bump(row.state);
        await storeRead(sb, row);
        continue;
      }
      if (!opts.xero) {
        counts.failed++;
        continue;
      }
      let listed: BillAttachmentXeroFile[];
      try {
        listed = await opts.xero.list(bill.xero_invoice_id);
      } catch (err) {
        if (err instanceof XeroCooldownError) throw err;
        console.error("[bill_attachments] list failed:", bill.xero_invoice_id, errCode(err));
        const row = emptyRead(orgId, bill.xero_invoice_id, `list:${bill.xero_invoice_id}`, "xero", "failed", "list_failed");
        bump(row.state);
        counts.xero++;
        await storeRead(sb, row);
        continue;
      }
      const files = (listed ?? []).filter((file) => file?.attachment_id);
      if (!files.length) {
        const row = emptyRead(orgId, bill.xero_invoice_id, `scan:${bill.xero_invoice_id}`, "xero", "no_text", "no_xero_attachment");
        bump(row.state);
        counts.xero++;
        await storeRead(sb, row);
        continue;
      }
      for (const file of files) {
        const row = await readXeroFile(opts.xero, orgId, bill.xero_invoice_id, file, extract);
        bump(row.state);
        counts.xero++;
        await storeRead(sb, row);
      }
    }
  } catch (err) {
    if (err instanceof XeroCooldownError) return { ...counts, stopped: "cooldown" };
    throw err;
  }
  return counts;
}

async function readEmailPdf(
  // deno-lint-ignore no-explicit-any
  sb: any,
  orgId: string,
  invoiceId: string,
  file: EmailPdf,
  extract: (bytes: Uint8Array) => Promise<{ text: string; note?: string }>,
): Promise<StoredRead> {
  const base = emptyRead(orgId, invoiceId, String(file.id), "email", "failed", null);
  base.file_name = file.file_name;
  base.mime_type = file.content_type;
  base.content_length = lengthOrNull(file.size_bytes);
  if (!isPdf(file.content_type, file.file_name)) {
    return { ...base, state: "unsupported", error_code: "unsupported" };
  }
  if (file.size_bytes != null && file.size_bytes > PDF_TEXT_MAX_BYTES) {
    return { ...base, state: "too_large", error_code: "too_large" };
  }
  const bucket = String(file.storage_bucket || "");
  const path = typeof file.storage_path === "string" ? file.storage_path.trim() : "";
  if (bucket !== CONTEXT_EMAIL_ATTACHMENTS_BUCKET || !path || path.startsWith("/") || path.includes("..")) {
    return { ...base, state: "failed", error_code: "attachment_location_invalid" };
  }
  try {
    const { data, error } = await sb.storage.from(bucket).download(path);
    if (error || !data) return { ...base, state: "failed", error_code: "attachment_download_failed" };
    const bytes = await toBytes(data);
    if (!bytes) return { ...base, state: "failed", error_code: "attachment_bytes_unreadable" };
    return await readPdfBytes(base, bytes, extract);
  } catch (err) {
    if (err instanceof XeroCooldownError) throw err;
    console.error("[bill_attachments] email pdf failed:", file.id, errCode(err));
    return { ...base, state: "failed", error_code: errCode(err) };
  }
}

async function readXeroFile(
  xero: BillAttachmentXero,
  orgId: string,
  invoiceId: string,
  file: BillAttachmentXeroFile,
  extract: (bytes: Uint8Array) => Promise<{ text: string; note?: string }>,
): Promise<StoredRead> {
  const base = emptyRead(orgId, invoiceId, file.attachment_id, "xero", "failed", null);
  base.file_name = file.file_name;
  base.mime_type = file.mime_type;
  base.content_length = lengthOrNull(file.content_length);
  if (!isPdf(file.mime_type, file.file_name)) {
    return { ...base, state: "unsupported", error_code: "unsupported" };
  }
  if (file.content_length != null && file.content_length > PDF_TEXT_MAX_BYTES) {
    return { ...base, state: "too_large", error_code: "too_large" };
  }
  const name = (file.file_name || "").trim();
  if (!name) return { ...base, state: "failed", error_code: "file_name_missing" };
  try {
    const bytes = await xero.download(invoiceId, name);
    return await readPdfBytes(base, bytes, extract);
  } catch (err) {
    if (err instanceof XeroCooldownError) throw err;
    console.error("[bill_attachments] xero pdf failed:", file.attachment_id, errCode(err));
    return { ...base, state: "failed", error_code: errCode(err) };
  }
}

async function readPdfBytes(
  base: StoredRead,
  bytes: Uint8Array,
  extract: (bytes: Uint8Array) => Promise<{ text: string; note?: string }>,
): Promise<StoredRead> {
  if (bytes.byteLength > PDF_TEXT_MAX_BYTES) {
    return { ...base, content_length: bytes.byteLength, state: "too_large", error_code: "too_large" };
  }
  try {
    const extracted = await extract(bytes);
    const noted = noteState(extracted.note);
    if (noted && !extracted.text.trim()) {
      return { ...base, content_length: bytes.byteLength, state: noted, error_code: extracted.note ?? noted };
    }
    const row = await readFromText({ ...base, content_length: bytes.byteLength }, extracted.text || "");
    return row;
  } catch (err) {
    if (err instanceof XeroCooldownError) throw err;
    console.error("[bill_attachments] pdf extract failed:", base.attachment_id, errCode(err));
    return { ...base, state: "failed", error_code: "pdf_extract_failed" };
  }
}

function serviceKeyRefusal(req: Request, serviceKey: string): { status: number; body: Record<string, unknown> } | null {
  if (!serviceKey || req.headers.get("authorization") !== `Bearer ${serviceKey}`) {
    return { status: 403, body: { error: "service_key_required" } };
  }
  if (req.method !== "POST") return { status: 405, body: { error: "post_required" } };
  return null;
}

/** The read_bill_attachments door. Exact service key, POST only. */
export async function readBillAttachmentsRequest(
  req: Request,
  // deno-lint-ignore no-explicit-any
  sb: any,
  serviceKey: string,
  opts: ReadBillAttachmentsOptions,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const refused = serviceKeyRefusal(req, serviceKey);
  if (refused) return refused;
  const rawLimit = new URL(req.url).searchParams.get("limit");
  const body = await readBillAttachments(sb, {
    ...opts,
    limit: billAttachmentLimit(rawLimit),
  });
  return { status: 200, body };
}
