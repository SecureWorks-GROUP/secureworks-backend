// The document text reader (gap plan B-5; done-definition row 5 "Documents").
//
// Reads the words inside the documents of live jobs and saves them as
// evidence: one document.text_extracted row per document per job, keyed
// doctext:<job id>:<sha-256 of the bytes>, so the same bytes on one job are one
// row. The row names its job (match_method direct_job_id), and the database
// ladder keeps a writer's job, so it lands on the document's own job.
//
// What it reads (context_document_text_due, newest first, 20 a run):
//   * job_documents of live jobs: our quotes, reports, purchase and work
//     orders, builder work orders and any other uploaded file;
//   * PDFs the email reader stored privately (context_email_attachments) whose
//     email sits on a live job.
// How:
//   * a PDF is downloaded from our own storage and read with the bounded text
//     layer extractor make-safe intake already uses (ops-api/makesafe_pdf_text.ts:
//     5 MB, 25 pages, 40,000 characters, never throws). No model is called.
//   * a PDF with no text layer (a scan) and a photo are recorded no_text_layer
//     and saved as nothing: the vision reader (B-5b) picks them up from the
//     records. Any other file kind is not_supported.
//   * a link outside our own Supabase storage is never fetched (no_file).
// Waking a read: a document from the last 48 hours is saved capture_mode live
// and wakes its job like any new evidence (cadence K1). An older document is
// history (backfill): after the run the jobs given history rows are listed for
// reading through the one history re-list, context_catchup_list_backfill (B-1).
// Every outcome is recorded by record_context_document_text, which owns the
// backoff. Idle, with no read and no run row, while the flag
// context_document_text_v1 or the capture lane is off.
//
// Read requests (migration 20261104130000, context_document_text_requests):
// documents someone named are listed by context_document_text_requested_due
// and read first in each run.
//   * An email attachment named by a request whose email is on NO job is read
//     on no job: its row carries no job, is keyed doctext:no_job:<sha-256>,
//     and is marked automated so the attribution ladder never places it (the
//     words of a supplier bill name job numbers and addresses the ladder would
//     otherwise follow). It wakes no read and lists no job.
//   * A request may raise one PDF's size limit (up to request_max_pdf_bytes,
//     20 MB); pages and characters keep their limits.
//
// A file that stops the worker (20261104180000): before it downloads and reads
// any PDF the reader records the attempt (read_started), so a file that stops
// the worker backs off and ends failed:read_started after the usual 5 tries
// instead of being taken again every run. The writer counts the mark and the
// read's outcome as one attempt. Each run also closes, as failed:run_stale,
// any earlier run of this reader still marked running after the stale window
// (a worker that stopped never closes its own run).
//
// Logs and results carry ids, counts and codes only, never words.

export const FLAG = "context_document_text_v1";
export const ACTOR = "workflow:context-document-text";
/** The attempt mark recorded before a PDF is downloaded and read. */
export const READ_STARTED = "read_started";

/** The thresholds the reader takes from context_document_text_policy(). */
export interface ReaderPolicy {
  run_source: string;
  event_source: string;
  event_type: string;
  key_prefix: string;
  batch_limit: number;
  catchup_priority: number;
  /** Key segment of a read on no job (20261104130000); "no_job". */
  no_job_key?: string;
  /** The most a read request may raise one PDF's size limit to. */
  request_max_pdf_bytes?: number;
}

/** The key segment of a read on no job, as the policy names it. The vision
 * reader keys the same way (its own policy has no such field). */
export const NO_JOB_KEY = "no_job";

/** Local limits of one invocation (not business thresholds). */
export const LIMITS = {
  timeBudgetMs: 100_000,
  runningStaleMs: 10 * 60_000,
  /** Matches the extractor's own cap; checked before extraction too. */
  maxPdfBytes: 5_000_000,
  /** The most any read request may raise one PDF to (the extractor's own
   * request cap), whatever the policy says. */
  requestMaxPdfBytes: 20_000_000,
  previewMax: 100,
  /** How far back the history re-list looks for this reader's rows. */
  relistWindowMs: 24 * 60 * 60_000,
};

/** One document due a read, as context_document_text_due (or
 * context_document_text_requested_due) returns it. */
export interface DueDocument {
  source_kind: "job_document" | "email_attachment";
  source_id: string;
  /** NULL: a requested email attachment read on no job. */
  job_id: string | null;
  job_number: string | null;
  file_name: string | null;
  doc_type: string | null;
  content_type: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  storage_url: string | null;
  pdf_url: string | null;
  fingerprint: string;
  doc_at: string | null;
  capture_mode: "live" | "backfill";
  attempts: number;
  /** A read request's raised PDF size limit (requested list only). */
  max_pdf_bytes?: number | null;
}

/** The extractor's result, as ops-api/makesafe_pdf_text.ts returns it. */
export interface PdfText {
  text: string;
  rawText: string;
  charCount: number;
  mode: "text" | "none";
  extractor?: string;
  pageCount?: number;
  truncated?: boolean;
  note?: string;
}

export type Download =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: string; missing: boolean };

export type CaptureOutcome =
  | { outcome: "inserted"; id?: string }
  | { outcome: "duplicate"; id?: string }
  | { outcome: "capture_disabled" }
  | { outcome: "error"; code?: string };

export type ReadResult =
  | "saved"
  | "no_text_layer"
  | "not_supported"
  | "too_large"
  | "too_many_pages"
  | "unreadable"
  | "no_file"
  | "error";

export interface ReadRecord {
  source_kind: string;
  source_id: string;
  job_id: string | null;
  fingerprint: string;
  file_kind: FileKind;
  result: ReadResult;
  code?: string;
  sha256?: string;
  page_count?: number;
  char_count?: number;
  truncated?: boolean;
  event_id?: string;
}

export interface ReaderDeps {
  now(): number;
  supabaseUrl: string;
  flagOn(): Promise<boolean>;
  laneOn(): Promise<boolean>;
  policy(): Promise<ReaderPolicy>;
  latestRun(
    source: string,
  ): Promise<{ id: string; status: string; started_at: string } | null>;
  recordRun(run: Record<string, unknown>): Promise<string>;
  /** Close this reader's runs still running after the stale window
   * (close_stale_context_document_text_runs, 20261104180000). */
  closeStaleRuns(): Promise<{ closed?: number; error?: string }>;
  dueDocuments(limit: number): Promise<DueDocument[]>;
  /** Requested documents due a read (context_document_text_requested_due). */
  requestedDocuments(limit: number): Promise<DueDocument[]>;
  download(bucket: string, path: string): Promise<Download>;
  extract(bytes: Uint8Array, opts?: { maxBytes?: number }): Promise<PdfText>;
  capture(row: Record<string, unknown>): Promise<CaptureOutcome>;
  record(rec: ReadRecord): Promise<{ outcome?: string; error?: string }>;
  relistBackfill(
    source: string,
    since: string,
    priority: number,
  ): Promise<{ listed?: number; error?: string }>;
}

export type FileKind = "pdf" | "image" | "other";

const IMAGE_EXT = /\.(jpe?g|png|heic|heif|webp|gif|tiff?|bmp)$/i;

function extOf(value: string | null | undefined): string {
  const v = (value ?? "").split(/[?#]/)[0];
  const m = v.match(/\.[A-Za-z0-9]{1,5}$/);
  return m ? m[0].toLowerCase() : "";
}

/** What kind of file a document is: by content type, then file name, then location. */
export function fileKind(doc: DueDocument): FileKind {
  const ct = (doc.content_type ?? "").toLowerCase();
  if (ct === "application/pdf" || ct === "application/x-pdf") return "pdf";
  if (ct.startsWith("image/")) return "image";
  for (
    const name of [
      doc.file_name,
      doc.storage_path,
      doc.pdf_url,
      doc.storage_url,
    ]
  ) {
    const ext = extOf(name);
    if (!ext) continue;
    if (ext === ".pdf") return "pdf";
    if (IMAGE_EXT.test(ext)) return "image";
    return "other";
  }
  // job_documents.pdf_url is set only for PDF files.
  if (doc.pdf_url) return "pdf";
  return "other";
}

export type Location =
  | { ok: true; bucket: string; path: string }
  | { ok: false; code: "no_location" | "unsupported_location" };

const SAFE_BUCKET = /^[a-z0-9][a-z0-9_-]{1,62}$/;

function safePath(path: string): string | null {
  const p = path.replace(/^\/+/, "");
  if (
    !p || p.length > 1024 || p.split("/").some((s) => s === ".." || s === ".")
  ) {
    return null;
  }
  return p;
}

/**
 * Where a document's bytes live in OUR storage. Only our project's own
 * storage is ever read: a bare path is the job-documents bucket, a URL must be
 * this project's /storage/v1/object/{public|sign|authenticated}/<bucket>/<path>.
 * Anything else is never fetched.
 */
export function resolveLocation(
  doc: DueDocument,
  supabaseUrl: string,
): Location {
  if (doc.source_kind === "email_attachment") {
    const path = safePath(doc.storage_path ?? "");
    if (doc.storage_bucket !== "context-email-attachments" || !path) {
      return { ok: false, code: "no_location" };
    }
    return { ok: true, bucket: doc.storage_bucket, path };
  }
  let ourHost = "";
  try {
    ourHost = new URL(supabaseUrl).host;
  } catch {
    ourHost = "";
  }
  const candidates = [doc.pdf_url, doc.storage_url]
    .map((v) => (v ?? "").trim())
    .filter((v) => v.length > 0);
  if (candidates.length === 0) return { ok: false, code: "no_location" };
  for (const raw of candidates) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      const path = safePath(raw.replace(/^\/*job-documents\//, ""));
      if (path) return { ok: true, bucket: "job-documents", path };
      continue;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || !ourHost || url.host !== ourHost) continue;
    const m = url.pathname.match(
      /^\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/,
    );
    if (!m) continue;
    let bucket: string;
    let path: string | null;
    try {
      bucket = decodeURIComponent(m[1]);
      path = safePath(decodeURIComponent(m[2]));
    } catch {
      continue;
    }
    if (!SAFE_BUCKET.test(bucket) || !path) continue;
    return { ok: true, bucket, path };
  }
  return { ok: false, code: "unsupported_location" };
}

/**
 * The PDF size limit one document is read at: the 5 MB default, or a read
 * request's raised limit, never above the policy's request_max_pdf_bytes nor
 * the extractor's own request cap.
 */
export function pdfByteLimit(doc: DueDocument, policy: ReaderPolicy): number {
  const asked = doc.max_pdf_bytes;
  if (
    typeof asked !== "number" || !Number.isInteger(asked) ||
    asked <= LIMITS.maxPdfBytes
  ) return LIMITS.maxPdfBytes;
  const most = typeof policy.request_max_pdf_bytes === "number" &&
      Number.isFinite(policy.request_max_pdf_bytes)
    ? Math.min(policy.request_max_pdf_bytes, LIMITS.requestMaxPdfBytes)
    : LIMITS.maxPdfBytes;
  return Math.max(LIMITS.maxPdfBytes, Math.min(asked, most));
}

/** The job segment of a document's evidence key: its job, or no_job. */
export function jobKey(
  doc: Pick<DueDocument, "job_id">,
  policy: Pick<ReaderPolicy, "no_job_key">,
): string {
  return doc.job_id ?? policy.no_job_key ?? NO_JOB_KEY;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The extractor's quality gate is tuned for intake (it wants 200 characters
 * before it hands text to a model). Evidence also wants a short purchase
 * order, so text the extractor kept as rawText counts when it is clean:
 * at least 20 characters, mostly printable, a fair share of letters, and not
 * one token repeated (generated PDFs sometimes expose only locale tags).
 */
export function readableText(result: PdfText): string | null {
  if (result.mode === "text" && result.text.trim()) return result.text.trim();
  if (result.note !== "low_quality_text") return null;
  const t = (result.rawText ?? "").trim();
  if (t.length < 20) return null;
  let printable = 0;
  let letters = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)) printable++;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters++;
  }
  if (printable / t.length < 0.85 || letters / t.length < 0.25) return null;
  const words = t.toLowerCase().match(/[a-z][a-z0-9'-]{1,}/g) ?? [];
  if (words.length < 3) return null;
  const counts = new Map<string, number>();
  let top = 0;
  for (const w of words) {
    const n = (counts.get(w) ?? 0) + 1;
    counts.set(w, n);
    if (n > top) top = n;
  }
  if (words.length >= 20 && (counts.size < 8 || top / words.length >= 0.45)) {
    return null;
  }
  return t;
}

/** Why a PDF gave no readable text, as a record result. */
export function noTextResult(result: PdfText): {
  result: ReadResult;
  code: string;
} {
  switch (result.note) {
    case "pdf_too_large":
      return { result: "too_large", code: "pdf_too_large" };
    case "pdf_too_many_pages":
      return { result: "too_many_pages", code: "pdf_too_many_pages" };
    case "no_text_layer":
    case "low_quality_text":
    case "no_pages":
      return { result: "no_text_layer", code: result.note };
    case "not_pdf":
      return { result: "unreadable", code: "not_pdf" };
    case "empty":
      return { result: "unreadable", code: "empty_file" };
    default:
      return { result: "unreadable", code: "pdf_parse_failed" };
  }
}

const TYPE_LABELS: Record<string, string> = {
  quote: "Quote",
  variation: "Variation",
  work_order: "Work order",
  material_order: "Material order",
  sheets_order: "Sheets order",
  supplier_quote: "Supplier quote",
  supplier_work_order: "Supplier work order",
  supplier_invoice: "Supplier invoice",
  approval: "Approval",
  council_plans: "Council plans",
  engineering: "Engineering",
  client_reference: "Client reference",
  asbestos: "Asbestos report",
  email_attachment: "Email attachment",
};

export function documentLabel(docType: string | null): string {
  const t = (docType ?? "").trim();
  if (!t) return "Document";
  if (TYPE_LABELS[t]) return TYPE_LABELS[t];
  const words = t.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Document";
}

const EXCERPT = 500;

/** The evidence row for one document's text. */
export function buildDocumentTextRow(
  doc: DueDocument,
  read: {
    sha256: string;
    text: string;
    pageCount: number | null;
    truncated: boolean;
    extractor: string | null;
  },
  policy: Pick<
    ReaderPolicy,
    "event_type" | "event_source" | "key_prefix" | "no_job_key"
  >,
): Record<string, unknown> {
  const label = documentLabel(doc.doc_type);
  const pages = read.pageCount;
  const pagePart = pages === null
    ? ""
    : `, ${pages} page${pages === 1 ? "" : "s"}`;
  const cutPart = read.truncated ? ", cut at 40,000 characters" : "";
  const fileName = (doc.file_name ?? "").replace(/[\r\n"]+/g, " ").trim()
    .slice(0, 200);
  const header = `[Document text: ${label}${
    fileName ? ` "${fileName}"` : ""
  }${pagePart}${cutPart}. Words read from the PDF text layer, not a message.]`;
  const summary =
    `[Document text: ${label}${pagePart}, ${read.text.length} characters${cutPart}.]`;
  const words = `${header}\n\n${read.text}`;
  const row: Record<string, unknown> = {
    event_type: policy.event_type,
    source: policy.event_source,
    entity_type: doc.source_kind,
    entity_id: doc.source_id,
    job_id: doc.job_id,
    match_method: "direct_job_id",
    event_at: doc.doc_at,
    provider_message_id: `${policy.key_prefix}${
      jobKey(doc, policy)
    }:${read.sha256}`,
    channel: "document",
    direction: "internal",
    thread_key: null,
    body_preview: read.text.slice(0, EXCERPT),
    safe_summary: summary.slice(0, 280),
    privacy_classification: "staff_only",
    retention_class: "7y_audit",
    payload: {
      document_text: true,
      words: true,
      channel: "document",
      text: words,
      job_id: doc.job_id,
      document: {
        source_kind: doc.source_kind,
        source_id: doc.source_id,
        doc_type: doc.doc_type,
        label,
        file_name: fileName || null,
        content_type: doc.content_type,
        sha256: read.sha256,
        page_count: pages,
        char_count: read.text.length,
        truncated: read.truncated,
        extractor: read.extractor,
      },
      event_at_source: doc.doc_at ? "document" : "missing",
    },
    metadata: { capture_mode: doc.capture_mode, writer: ACTOR },
  };
  return doc.job_id === null ? onNoJob(row) : row;
}

/**
 * A requested read on no job (20261104130000): the row names no job and no
 * match method, is marked automated so the attribution ladder never places it
 * (its words name job numbers and addresses), and is history that wakes no
 * read. Shared with the vision reader.
 */
export function onNoJob(row: Record<string, unknown>): Record<string, unknown> {
  const { job_id: _job, match_method: _method, ...rest } = row;
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  return {
    ...rest,
    payload: { ...payload, job_id: null, automated: true, no_job: true },
    metadata: { ...metadata, capture_mode: "backfill", requested_read: true },
  };
}

function codePart(value: unknown, fallback = "error"): string {
  const s = String(value ?? "").toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^[^a-z0-9]+/, "").slice(0, 80);
  return s || fallback;
}

export interface StepResult {
  outcome: ReadResult | "duplicate" | "record_failed";
  code?: string;
  /** Stop the run: the capture lane went off mid-run. */
  stop?: string;
  savedMode?: "live" | "backfill" | "no_job";
}

/** One document: locate, download, extract, save, record. */
export async function processDocument(
  doc: DueDocument,
  policy: ReaderPolicy,
  deps: ReaderDeps,
): Promise<StepResult> {
  const kind = fileKind(doc);
  const base = {
    source_kind: doc.source_kind,
    source_id: doc.source_id,
    job_id: doc.job_id,
    fingerprint: doc.fingerprint,
    file_kind: kind,
  };
  const finish = async (
    rec: Omit<ReadRecord, keyof typeof base>,
    step: StepResult,
  ): Promise<StepResult> => {
    const r = await deps.record({ ...base, ...rec });
    if (r.error) return { outcome: "record_failed", code: r.error };
    return step;
  };

  if (kind === "image") {
    // A photo has no text layer: the vision reader (B-5b) takes it next.
    return finish({ result: "no_text_layer", code: "image" }, {
      outcome: "no_text_layer",
      code: "image",
    });
  }
  if (kind === "other") {
    return finish({ result: "not_supported", code: "not_pdf_or_image" }, {
      outcome: "not_supported",
      code: "not_pdf_or_image",
    });
  }
  const where = resolveLocation(doc, deps.supabaseUrl);
  if (!where.ok) {
    return finish({ result: "no_file", code: where.code }, {
      outcome: "no_file",
      code: where.code,
    });
  }
  // A download or read may stop the worker (on 30 Oct 2026 a corrupt PDF did,
  // every run, before anything was recorded). Record the attempt first: the
  // document then backs off (15 min, 1 h, 6 h, 24 h) and ends
  // failed:read_started instead of being taken again every run. The writer
  // counts this mark and the outcome below as one attempt (20261104180000).
  const started = await deps.record({
    ...base,
    result: "error",
    code: READ_STARTED,
  });
  if (started.error) return { outcome: "record_failed", code: started.error };
  const got = await deps.download(where.bucket, where.path);
  if (!got.ok) {
    if (got.missing) {
      return finish({ result: "no_file", code: "object_missing" }, {
        outcome: "no_file",
        code: "object_missing",
      });
    }
    const code = codePart(`download_${got.code}`);
    return finish({ result: "error", code }, { outcome: "error", code });
  }
  const sha = await sha256Hex(got.bytes);
  const limit = pdfByteLimit(doc, policy);
  if (got.bytes.byteLength > limit) {
    return finish({ result: "too_large", code: "pdf_too_large", sha256: sha }, {
      outcome: "too_large",
      code: "pdf_too_large",
    });
  }
  const pdf = await deps.extract(got.bytes, { maxBytes: limit });
  const text = readableText(pdf);
  if (!text) {
    const why = noTextResult(pdf);
    return finish({
      result: why.result,
      code: why.code,
      sha256: sha,
      ...(typeof pdf.pageCount === "number"
        ? { page_count: pdf.pageCount }
        : {}),
    }, { outcome: why.result, code: why.code });
  }
  const row = buildDocumentTextRow(doc, {
    sha256: sha,
    text,
    pageCount: typeof pdf.pageCount === "number" ? pdf.pageCount : null,
    truncated: pdf.truncated === true,
    extractor: pdf.extractor ?? null,
  }, policy);
  const saved = await deps.capture(row);
  if (saved.outcome === "capture_disabled") {
    return {
      outcome: "error",
      code: "capture_disabled",
      stop: "capture_disabled",
    };
  }
  if (saved.outcome === "error" || !("id" in saved) || !saved.id) {
    const code = codePart(
      `capture_${saved.outcome === "error" ? saved.code ?? "error" : "no_id"}`,
    );
    return finish({ result: "error", code, sha256: sha }, {
      outcome: "error",
      code,
    });
  }
  const savedMode = doc.job_id === null ? "no_job" : doc.capture_mode;
  const step: StepResult = saved.outcome === "duplicate"
    ? { outcome: "duplicate", savedMode }
    : { outcome: "saved", savedMode };
  return finish({
    result: "saved",
    sha256: sha,
    event_id: saved.id,
    char_count: text.length,
    truncated: pdf.truncated === true,
    ...(typeof pdf.pageCount === "number" ? { page_count: pdf.pageCount } : {}),
  }, step);
}

export function emptyCounts(): Record<string, number> {
  return {
    selected: 0,
    saved: 0,
    duplicate: 0,
    live_saved: 0,
    backfill_saved: 0,
    no_job_saved: 0,
    requested: 0,
    no_text_layer: 0,
    image: 0,
    not_supported: 0,
    too_large: 0,
    too_many_pages: 0,
    unreadable: 0,
    no_file: 0,
    errors: 0,
    record_failed: 0,
    relisted_jobs: 0,
    stale_runs_closed: 0,
  };
}

function tally(counts: Record<string, number>, step: StepResult): void {
  switch (step.outcome) {
    case "saved":
    case "duplicate":
      counts[step.outcome]++;
      // A read on no job lists no job for reading.
      if (step.savedMode === "no_job") counts.no_job_saved++;
      else if (step.savedMode === "backfill") counts.backfill_saved++;
      else counts.live_saved++;
      break;
    case "no_text_layer":
      counts.no_text_layer++;
      if (step.code === "image") counts.image++;
      break;
    case "error":
      counts.errors++;
      break;
    case "record_failed":
      counts.record_failed++;
      break;
    default:
      counts[step.outcome]++;
  }
}

export type RunResult =
  | { outcome: "idle"; reason: "flag_off" | "capture_lane_off" }
  | { outcome: "run_in_progress"; run_id: string }
  | {
    outcome: "ran";
    run_id: string;
    status: "succeeded" | "partial" | "failed";
    error_code: string | null;
    counts: Record<string, number>;
    documents: { source_id: string; outcome: string; code?: string }[];
  };

/**
 * The documents a run takes: requested ones first (named by someone), then the
 * ordinary list, together at most the batch. A requested list that cannot be
 * read (the migration missing) leaves the ordinary list to run on.
 */
export async function documentsDue(
  deps: Pick<ReaderDeps, "dueDocuments" | "requestedDocuments">,
  limit: number,
): Promise<
  { documents: DueDocument[]; requested: number; requestedError?: string }
> {
  let requested: DueDocument[] = [];
  let requestedError: string | undefined;
  try {
    requested = (await deps.requestedDocuments(limit)).slice(0, limit);
  } catch {
    requestedError = "requested_unreadable";
  }
  const rest = limit - requested.length;
  const ordinary = rest > 0 ? await deps.dueDocuments(rest) : [];
  return {
    documents: [...requested, ...ordinary.slice(0, Math.max(rest, 0))],
    requested: requested.length,
    ...(requestedError ? { requestedError } : {}),
  };
}

/** One run: the documents due now, then the history re-list. */
export async function runDocumentText(deps: ReaderDeps): Promise<RunResult> {
  if (!(await deps.flagOn())) return { outcome: "idle", reason: "flag_off" };
  if (!(await deps.laneOn())) {
    return { outcome: "idle", reason: "capture_lane_off" };
  }
  const policy = await deps.policy();
  const started = deps.now();
  const latest = await deps.latestRun(policy.run_source);
  if (
    latest?.status === "running" &&
    started - Date.parse(latest.started_at) < LIMITS.runningStaleMs
  ) {
    return { outcome: "run_in_progress", run_id: latest.id };
  }
  // A run whose worker stopped is never closed by it: close every such run
  // first (failed:run_stale), so each run row ends closed.
  const stale = await deps.closeStaleRuns();
  const runId = await deps.recordRun({
    source: policy.run_source,
    status: "running",
    cursor: { actor: ACTOR, mode: "live" },
  });
  const counts = emptyCounts();
  const documents: { source_id: string; outcome: string; code?: string }[] = [];
  let status: "succeeded" | "partial" | "failed" = "succeeded";
  let errorCode: string | null = null;
  if (stale.error) {
    status = "partial";
    errorCode = codePart(stale.error);
  } else {
    counts.stale_runs_closed = stale.closed ?? 0;
  }
  try {
    const due = await documentsDue(deps, policy.batch_limit);
    if (due.requestedError) {
      status = "partial";
      errorCode = due.requestedError;
    }
    counts.requested = due.requested;
    for (const doc of due.documents) {
      if (deps.now() - started > LIMITS.timeBudgetMs) {
        status = "partial";
        errorCode = "time_budget";
        break;
      }
      counts.selected++;
      let step: StepResult;
      try {
        step = await processDocument(doc, policy, deps);
      } catch (error) {
        // A failure outside the bounded steps is recorded as an error so
        // the document backs off rather than blocking every run.
        const code = codePart(
          `threw_${(error as { code?: string })?.code ?? "error"}`,
        );
        const r = await deps.record({
          source_kind: doc.source_kind,
          source_id: doc.source_id,
          job_id: doc.job_id,
          fingerprint: doc.fingerprint,
          file_kind: fileKind(doc),
          result: "error",
          code,
        });
        step = r.error
          ? { outcome: "record_failed", code: r.error }
          : { outcome: "error", code };
      }
      tally(counts, step);
      documents.push({
        source_id: doc.source_id,
        outcome: step.outcome,
        ...(step.code ? { code: step.code } : {}),
      });
      if (step.stop) {
        status = "partial";
        errorCode = step.stop;
        break;
      }
    }
  } catch (error) {
    status = "failed";
    errorCode = codePart(
      (error as { code?: string })?.code ?? "due_documents_unreadable",
    );
  }
  if (counts.backfill_saved > 0) {
    const since = new Date(started - LIMITS.relistWindowMs).toISOString();
    const listed = await deps.relistBackfill(
      policy.event_source,
      since,
      policy.catchup_priority,
    );
    if (listed.error) {
      if (status === "succeeded") {
        status = "partial";
        errorCode = codePart(listed.error);
      }
    } else {
      counts.relisted_jobs = listed.listed ?? 0;
    }
  }
  if (counts.record_failed > 0 && status !== "failed") {
    status = "partial";
    errorCode = "record_failed";
  }
  await deps.recordRun({
    run_id: runId,
    source: policy.run_source,
    status,
    counts,
    ...(errorCode ? { error_code: errorCode } : {}),
  });
  return {
    outcome: "ran",
    run_id: runId,
    status,
    error_code: errorCode,
    counts,
    documents,
  };
}

export interface PreviewResult {
  outcome: "preview";
  flag_on: boolean;
  lane_on: boolean;
  due: {
    source_kind: string;
    source_id: string;
    job_number: string | null;
    on_no_job: boolean;
    max_pdf_bytes?: number;
    file_kind: FileKind;
    location: string;
    capture_mode: string;
    attempts: number;
  }[];
}

/**
 * Read-only preview: the documents a run would take now and how each would be
 * read. No download, no extraction, no write; works with the flag off.
 */
export async function previewDocumentText(
  deps: Pick<
    ReaderDeps,
    "flagOn" | "laneOn" | "dueDocuments" | "requestedDocuments" | "supabaseUrl"
  >,
  limit: number,
): Promise<PreviewResult> {
  const [flagOn, laneOn, listed] = await Promise.all([
    deps.flagOn(),
    deps.laneOn(),
    documentsDue(deps, limit),
  ]);
  const due = listed.documents;
  return {
    outcome: "preview",
    flag_on: flagOn,
    lane_on: laneOn,
    due: due.map((d) => {
      const kind = fileKind(d);
      const where = kind === "pdf"
        ? resolveLocation(d, deps.supabaseUrl)
        : null;
      return {
        source_kind: d.source_kind,
        source_id: d.source_id,
        job_number: d.job_number,
        on_no_job: d.job_id === null,
        ...(typeof d.max_pdf_bytes === "number"
          ? { max_pdf_bytes: d.max_pdf_bytes }
          : {}),
        file_kind: kind,
        location: where === null
          ? "not_read"
          : where.ok
          ? `storage:${where.bucket}`
          : where.code,
        capture_mode: d.capture_mode,
        attempts: d.attempts,
      };
    }),
  };
}
