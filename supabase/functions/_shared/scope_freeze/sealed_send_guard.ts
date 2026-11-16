// deno-lint-ignore-file no-explicit-any
// Ruling 18 K2: a fence or patio quote goes to a customer only from its sealed
// revision. send-quote /send and /send-runs judge every fence and patio send:
//
//   no_named_revision            the send names no sealed revision (the old
//                                fence page from before 4 Nov, Create Job rows,
//                                any caller that names none)
//   revision_not_sealed          the named revision's frozen pricing does not
//                                say revision.sealed === true
//   revision_not_newest          the named revision is not the job's newest
//                                frozen revision
//   document_revision_unrecorded /send: the quote document has no revision
//                                recorded at prepare (ghl-proxy prepare_quote
//                                and prepare_neighbour_quotes record the one
//                                the producer names)
//   document_revision_mismatch   /send: the document was prepared for another
//                                revision
//   document_pdf_not_from_revision /send: the PDF the document links to now is
//                                not one of the quote PDFs recorded on the
//                                revision (scope_artifacts quote_pdf /
//                                per_contact_pdf), or is not on our storage
//   run_pdf_not_from_revision    /send-runs: a run PDF is not one of the quote
//                                PDFs recorded on the revision (scope_artifacts)
//   check_unreadable             one of the reads above failed
//
// Behind quote_send_sealed_revision_required_v1 (seeded off; missing or
// unreadable reads as off). Off: every send goes exactly as today, and each
// send the guard would have refused writes one row to
// quote_send_sealed_revision_misses (ids, codes and the calling page only; no
// customer details). On: the send is refused before any email, with words that
// tell the scoper what to do, and the refusal is written to the same table.
//
// The PDF is proved by its bytes, never by a label: the guard reads it once and
// hands the checked bytes back. While the switch is on the caller sends only
// those bytes: /send pins them as a content-addressed copy the document then
// links to (pinSealedQuotePdf), /send-runs attaches them and links the run
// documents to their pinned copies. A PDF uploaded over the original address
// afterwards never reaches the customer.
//
// A send whose named revision cannot be proved at all is already refused by
// sealedSendSource; this guard does not judge it again.

import type { SealedSendSource } from "./quote_scope_revision_link.ts";
import { namedScopeRevisionAbsent } from "./quote_scope_revision_link.ts";
import { approvedQuotePdf } from "./owner_price_approval.ts";

export const SEALED_REVISION_SEND_FLAG = "quote_send_sealed_revision_required_v1";
export const SEALED_SEND_MISSES_TABLE = "quote_send_sealed_revision_misses";

/** The job types the guard judges. Every other send goes as today. */
export const SEALED_SEND_GUARDED_TYPES: ReadonlySet<string> = new Set(["fencing", "patio"]);

export type SealedSendPath = "send" | "send-runs";

export type SealedSendMissReason =
  | "no_named_revision"
  | "revision_not_sealed"
  | "revision_not_newest"
  | "document_revision_unrecorded"
  | "document_revision_mismatch"
  | "document_pdf_not_from_revision"
  | "run_pdf_not_from_revision"
  | "check_unreadable";

export const SEALED_SEND_MISS_REASONS: ReadonlyArray<SealedSendMissReason> = [
  "no_named_revision",
  "revision_not_sealed",
  "revision_not_newest",
  "document_revision_unrecorded",
  "document_revision_mismatch",
  "document_pdf_not_from_revision",
  "run_pdf_not_from_revision",
  "check_unreadable",
];

export const SEALED_REVISION_REQUIRED_WORDS =
  "Nothing was sent. This page is out of date or the quote is not sealed. Open the Scope Engine, seal and save the quote, then send.";
export const SEALED_REVISION_CHECK_FAILED_WORDS =
  "Could not check that this is the sealed quote. Nothing was sent. Try again.";

export type SealedSendVerifiedPdf = { sha256: string; bytes: Uint8Array };

export type SealedSendRefusalBody = { error: string; code: string; reason: SealedSendMissReason };

export type SealedSendGuard =
  /** Not a fence or patio send, or sealedSendSource already refuses it. */
  | { kind: "not_judged" }
  | {
    kind: "pass";
    switch_on: boolean;
    /** /send: the document's PDF, read once and checked against the revision. */
    verified_pdf?: SealedSendVerifiedPdf;
    /** /send-runs: each run PDF the caller named, checked, by run label. */
    verified_run_pdfs?: Map<string, SealedSendVerifiedPdf>;
  }
  | {
    kind: "miss";
    switch_on: boolean;
    reason: SealedSendMissReason;
    /** The revision the send names, when it names one. */
    named_scope_revision_id: string | null;
    status: 409 | 503;
    body: SealedSendRefusalBody;
  };

function miss(
  switchOn: boolean,
  reason: SealedSendMissReason,
  named: string | null,
): Extract<SealedSendGuard, { kind: "miss" }> {
  const unreadable = reason === "check_unreadable";
  return {
    kind: "miss",
    switch_on: switchOn,
    reason,
    named_scope_revision_id: named,
    status: unreadable ? 503 : 409,
    body: {
      error: unreadable ? SEALED_REVISION_CHECK_FAILED_WORDS : SEALED_REVISION_REQUIRED_WORDS,
      code: unreadable ? "sealed_revision_check_failed" : "sealed_revision_required",
      reason,
    },
  };
}

/** The refusal when the checked bytes could not be pinned or linked (switch
 * on): nothing is sent, and it is recorded like any other miss. */
export function sealedCopyFailed(named: string | null): Extract<SealedSendGuard, { kind: "miss" }> {
  return miss(true, "check_unreadable", named);
}

/** The switch, or null when it cannot be read (the caller counts it as off). */
async function readSwitch(sb: any): Promise<boolean | null> {
  try {
    const { data, error } = await sb.from("feature_flags").select("enabled")
      .eq("flag_name", SEALED_REVISION_SEND_FLAG).maybeSingle();
    if (error) return null;
    return data?.enabled === true;
  } catch {
    return null;
  }
}

/** The job's newest frozen revision id, null when it has none, or
 * "unreadable". */
async function newestFrozenRevisionId(sb: any, jobId: string): Promise<string | null | "unreadable"> {
  try {
    const { data, error } = await sb.from("scope_revisions").select("id")
      .eq("job_id", jobId).eq("status", "frozen")
      .order("revision_number", { ascending: false }).limit(1);
    if (error || !Array.isArray(data)) return "unreadable";
    const id = data[0]?.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return "unreadable";
  }
}

/** The sha256 of every quote PDF recorded on the revision, or null when the
 * list cannot be read. */
async function revisionQuotePdfs(sb: any, revisionId: string): Promise<string[] | null> {
  try {
    const { data, error } = await sb.rpc("scope_revision_quote_documents", {
      p_scope_revision_id: revisionId,
    });
    if (error || !Array.isArray(data)) return null;
    if (!data.every((v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v))) return null;
    return data as string[];
  } catch {
    return null;
  }
}

/**
 * Judge one send. Reads nothing for a job type it does not guard or a send
 * sealedSendSource already refuses. Otherwise reads the switch, and judges the
 * same way whether it is on or off, so the record made while it is off is the
 * list of sends it would refuse. Never throws.
 */
export async function judgeSealedSend(
  sb: any,
  input: {
    path: SealedSendPath;
    job_id: string;
    job_type: unknown;
    sealed: SealedSendSource;
    /** /send: the quote document being sent. */
    document?: { scope_revision_id?: unknown; pdf_url?: unknown } | null;
    /** /send-runs: the run PDFs the caller names, by run label. */
    run_pdfs?: unknown;
  },
  // The project URL whose public storage the PDFs must sit on. Required: a
  // caller that leaves it out would refuse every PDF (money14, 1450).
  deps: { storageBaseUrl: string; fetchImpl?: typeof fetch; pdfTimeoutMs?: number },
): Promise<SealedSendGuard> {
  if (typeof input.job_type !== "string" || !SEALED_SEND_GUARDED_TYPES.has(input.job_type)) {
    return { kind: "not_judged" };
  }
  if (!input.sealed || input.sealed.kind === "refused") return { kind: "not_judged" };
  const switchRead = await readSwitch(sb);
  if (switchRead === null) {
    console.error("[sealed-send] switch unreadable; sending as today");
  }
  const on = switchRead === true;
  if (input.sealed.kind !== "sealed") return miss(on, "no_named_revision", null);

  const named = input.sealed.revision_id;
  const revision = (input.sealed.pricing_json as any)?.revision;
  if (!revision || typeof revision !== "object" || revision.sealed !== true) {
    return miss(on, "revision_not_sealed", named);
  }
  const newest = await newestFrozenRevisionId(sb, input.job_id);
  if (newest === "unreadable") return miss(on, "check_unreadable", named);
  if (newest !== named) return miss(on, "revision_not_newest", named);

  const timedFetch = pdfFetchWithTimeout(deps.fetchImpl ?? fetch, deps.pdfTimeoutMs ?? SEALED_SEND_PDF_TIMEOUT_MS);
  const checkPdf = async (
    gate: { kind: "approved"; approval_id: string; scope_revision_id: string; quote_document_sha256s: string[] },
    url: unknown,
  ): Promise<SealedSendVerifiedPdf | "not_from_revision" | "unreadable"> => {
    // Only our own public storage is read: a PDF anywhere else cannot be shown
    // to be the revision's, and the guard never fetches an address a caller
    // chose.
    if (typeof url !== "string" || !onOwnStorage(url, deps.storageBaseUrl)) return "not_from_revision";
    const checked = await approvedQuotePdf(gate, url, timedFetch);
    if (checked.ok) return { sha256: checked.sha256, bytes: checked.bytes };
    return checked.status === 409 ? "not_from_revision" : "unreadable";
  };
  const gateFor = async () => {
    const recorded = await revisionQuotePdfs(sb, named);
    return recorded === null
      ? null
      : { kind: "approved" as const, approval_id: "", scope_revision_id: named, quote_document_sha256s: recorded };
  };

  if (input.path === "send") {
    const recorded = input.document?.scope_revision_id;
    if (typeof recorded !== "string" || !recorded) return miss(on, "document_revision_unrecorded", named);
    if (recorded.toLowerCase() !== named) return miss(on, "document_revision_mismatch", named);
    // The label says which revision the document was prepared for; the bytes
    // it links to now must be one of that revision's recorded quote PDFs.
    const gate = await gateFor();
    if (gate === null) return miss(on, "check_unreadable", named);
    const pdf = await checkPdf(gate, input.document?.pdf_url);
    if (pdf === "unreadable") return miss(on, "check_unreadable", named);
    if (pdf === "not_from_revision") return miss(on, "document_pdf_not_from_revision", named);
    return { kind: "pass", switch_on: on, verified_pdf: pdf };
  }

  const entries = runPdfEntries(input.run_pdfs);
  const verified = new Map<string, SealedSendVerifiedPdf>();
  if (entries.length > 0) {
    const gate = await gateFor();
    if (gate === null) return miss(on, "check_unreadable", named);
    for (const [label, url] of entries) {
      const pdf = await checkPdf(gate, url);
      if (pdf === "unreadable") return miss(on, "check_unreadable", named);
      if (pdf === "not_from_revision") return miss(on, "run_pdf_not_from_revision", named);
      verified.set(label, pdf);
    }
  }
  return { kind: "pass", switch_on: on, verified_run_pdfs: verified };
}

/** A run PDF read that takes longer than this counts as unreadable. */
export const SEALED_SEND_PDF_TIMEOUT_MS = 15_000;

function pdfFetchWithTimeout(fetchImpl: typeof fetch, ms: number): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchImpl(input, { ...(init ?? {}), signal: AbortSignal.timeout(ms) })) as typeof fetch;
}

/** True only for a public object in this project's own storage. */
export function onOwnStorage(url: string, storageBaseUrl: string | undefined): boolean {
  if (!storageBaseUrl) return false;
  try {
    const u = new URL(url);
    const base = new URL(storageBaseUrl);
    return u.protocol === "https:" && u.origin === base.origin &&
      u.pathname.startsWith("/storage/v1/object/public/") && !u.username && !u.password;
  } catch {
    return false;
  }
}

function runPdfEntries(runPdfs: unknown): Array<[string, string]> {
  if (!runPdfs || typeof runPdfs !== "object" || Array.isArray(runPdfs)) return [];
  return Object.entries(runPdfs as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0);
}

// ── While the switch is on: the customer gets only the checked bytes ──
//
// A checked PDF is stored once more at a content-addressed path
// (job-pdfs/sealed-quotes/<job>/<sha256>.pdf) that no upload address is ever
// issued for: ghl-proxy's prepare never reuses a path under this prefix
// (sealedQuoteCopyPath). The customer link points there, so a later upload
// over the PDF's original address changes nothing the customer sees.

export const SEALED_QUOTE_COPY_BUCKET = "job-pdfs";
export const SEALED_QUOTE_COPY_PREFIX = "sealed-quotes/";

/** True for a storage path (inside job-pdfs) that is a pinned sealed copy. */
export function isSealedQuoteCopyPath(path: unknown): boolean {
  return typeof path === "string" && path.startsWith(SEALED_QUOTE_COPY_PREFIX);
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Store the checked bytes at their content address and return its public
 * URL. An object already there (an earlier attempt) is accepted only when its
 * bytes hash the same. Anything else is a failure: the caller refuses the send. */
export async function pinSealedQuotePdf(
  sb: any,
  jobId: string,
  pdf: SealedSendVerifiedPdf,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; url: string } | { ok: false }> {
  if (!UUID.test(jobId) || !/^[0-9a-f]{64}$/.test(pdf.sha256)) return { ok: false };
  if ((await sha256Of(pdf.bytes)) !== pdf.sha256) return { ok: false };
  const path = `${SEALED_QUOTE_COPY_PREFIX}${jobId.toLowerCase()}/${pdf.sha256}.pdf`;
  try {
    const store = sb.storage.from(SEALED_QUOTE_COPY_BUCKET);
    const { error } = await store.upload(path, pdf.bytes, { contentType: "application/pdf", upsert: false });
    const url = store.getPublicUrl(path)?.data?.publicUrl;
    if (typeof url !== "string" || !url) return { ok: false };
    if (error) {
      const res = await pdfFetchWithTimeout(fetchImpl, SEALED_SEND_PDF_TIMEOUT_MS)(url);
      if (!res.ok) return { ok: false };
      if ((await sha256Of(new Uint8Array(await res.arrayBuffer()))) !== pdf.sha256) return { ok: false };
    }
    return { ok: true, url };
  } catch {
    return { ok: false };
  }
}

/** Point quote documents at a pinned copy. /send passes the URL it checked as
 * `from`, so a document whose PDF address moved since is not overwritten.
 * True only when every named row was written. */
export async function linkDocumentsToSealedCopy(
  sb: any,
  documentIds: string[],
  url: string,
  from?: string,
): Promise<boolean> {
  if (documentIds.length === 0) return true;
  try {
    let q = sb.from("job_documents").update({ pdf_url: url }).in("id", documentIds);
    if (from !== undefined) q = q.eq("pdf_url", from);
    const { data, error } = await q.select("id");
    return !error && Array.isArray(data) && data.length === documentIds.length;
  } catch {
    return false;
  }
}

/** Which page or caller sent: the browser's Origin, the Referer cut to its
 * origin and path (never a query or fragment), and the names (never the
 * values) of the request body's top-level keys. No customer details. */
export type SealedSendCaller = {
  origin: string | null;
  referer: string | null;
  body_keys: string[];
};

export function sealedSendCaller(req: Request, body: unknown): SealedSendCaller {
  const origin = (() => {
    const raw = req.headers.get("origin");
    if (!raw) return null;
    try {
      return new URL(raw).origin.slice(0, 200);
    } catch {
      return null;
    }
  })();
  const referer = (() => {
    const raw = req.headers.get("referer");
    if (!raw) return null;
    try {
      const u = new URL(raw);
      return `${u.origin}${u.pathname}`.slice(0, 300);
    } catch {
      return null;
    }
  })();
  const body_keys = body && typeof body === "object" && !Array.isArray(body)
    ? Object.keys(body as object).filter((k) => /^[A-Za-z0-9_]{1,64}$/.test(k)).sort().slice(0, 40)
    : [];
  return { origin, referer, body_keys };
}

export type SealedSendMissRecord = {
  job_id: string;
  path: SealedSendPath;
  document_id: string | null;
  sender_mode: "api_key" | "jwt";
  sender_user_id: string | null;
  caller: SealedSendCaller;
};

/** One row per send the guard misses, refused (switch on) or sent as today
 * (switch off). Best effort: a row that cannot be written is logged and never
 * changes the send. */
export async function recordSealedSendMiss(
  sb: any,
  guard: Extract<SealedSendGuard, { kind: "miss" }>,
  rec: SealedSendMissRecord,
): Promise<boolean> {
  try {
    const { error } = await sb.from(SEALED_SEND_MISSES_TABLE).insert({
      job_id: rec.job_id,
      path: rec.path,
      document_id: rec.document_id,
      named_scope_revision_id: guard.named_scope_revision_id,
      reason: guard.reason,
      switch_on: guard.switch_on,
      sender_mode: rec.sender_mode,
      sender_user_id: rec.sender_user_id,
      caller_origin: rec.caller.origin,
      caller_referer: rec.caller.referer,
      body_keys: rec.caller.body_keys,
    });
    if (!error) return true;
    console.error("[sealed-send] miss not recorded:", error.code ?? "error");
  } catch {
    console.error("[sealed-send] miss record unreachable");
  }
  return false;
}

// ── At prepare: which sealed revision a quote document is made from ──
//
// ghl-proxy prepare_quote and prepare_neighbour_quotes take the frozen
// revision the producer will render the PDF from (source_scope_revision_id,
// the same id it later names on the send) and record it on the document
// (job_documents.scope_revision_id), only when that row is this job's and
// frozen at the read. Anything else records null. Never refuses a prepare.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type QuoteDocumentRevisionRecord =
  | { scope_revision_id: string; reason: "recorded" }
  | {
    scope_revision_id: null;
    reason:
      | "named_id_absent"
      | "named_id_malformed"
      | "named_revision_missing"
      | "named_revision_other_job"
      | "named_revision_not_frozen"
      | "named_revision_read_failed";
  };

export async function quoteDocumentRevisionToRecord(
  sb: any,
  jobId: string,
  raw: unknown,
): Promise<QuoteDocumentRevisionRecord> {
  if (namedScopeRevisionAbsent(raw)) return { scope_revision_id: null, reason: "named_id_absent" };
  if (typeof raw !== "string" || !UUID.test(raw)) return { scope_revision_id: null, reason: "named_id_malformed" };
  const id = raw.toLowerCase();
  try {
    const { data, error } = await sb.from("scope_revisions").select("id, job_id, status")
      .eq("id", id).maybeSingle();
    if (error) return { scope_revision_id: null, reason: "named_revision_read_failed" };
    if (!data) return { scope_revision_id: null, reason: "named_revision_missing" };
    if (data.job_id !== jobId) return { scope_revision_id: null, reason: "named_revision_other_job" };
    if (data.status !== "frozen") return { scope_revision_id: null, reason: "named_revision_not_frozen" };
    return { scope_revision_id: id, reason: "recorded" };
  } catch {
    return { scope_revision_id: null, reason: "named_revision_read_failed" };
  }
}

/** On a reused draft document: record the revision this prepare names, or
 * clear a recorded one when it names none (the PDF about to be uploaded over
 * it is no longer that revision's). Best effort: a failed write is logged and
 * never stops the prepare; the send then finds no matching record. */
export async function bindQuoteDocumentRevision(
  sb: any,
  documentId: string,
  scopeRevisionId: string | null,
): Promise<boolean> {
  try {
    const { error } = await sb.from("job_documents")
      .update({ scope_revision_id: scopeRevisionId }).eq("id", documentId);
    if (!error) return true;
    console.error("[sealed-send] document revision not recorded:", error.code ?? "error");
  } catch {
    console.error("[sealed-send] document revision record unreachable");
  }
  return false;
}
