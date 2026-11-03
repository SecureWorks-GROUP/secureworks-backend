// The document text reader (gap plan B-5): file kinds, the own-storage-only
// location rule, the text gate, the evidence row, and one run end to end on
// fake reads and writes. No network, no model, no real PDF parser: the
// extractor is ops-api/makesafe_pdf_text.ts, tested there; here it is a stub
// returning the shapes that module returns.

// deno-lint-ignore no-import-prefix
import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildDocumentTextRow, type CaptureOutcome, type Download, documentsDue, type DueDocument, type PdfText, pdfByteLimit, previewDocumentText, processDocument, type ReaderDeps, type ReaderPolicy, type ReadRecord, runDocumentText, sha256Hex } from "./read.ts";

const SUPABASE = "https://kevgrhcjxspbxgovpmfl.supabase.co";
const JOB = "11111111-1111-4111-8111-111111111111";

const POLICY: ReaderPolicy = {
  run_source: "context_document_text",
  event_source: "context-document-text",
  event_type: "document.text_extracted",
  key_prefix: "doctext:",
  batch_limit: 20,
  catchup_priority: 2,
};

function doc(over: Partial<DueDocument> = {}): DueDocument {
  return {
    source_kind: "job_document",
    source_id: "22222222-2222-4222-8222-222222222222",
    job_id: JOB,
    job_number: "SWF-26101",
    file_name: "quote-Q1001.pdf",
    doc_type: "quote",
    content_type: null,
    storage_bucket: null,
    storage_path: null,
    storage_url: `${JOB}/quote-Q1001.pdf`,
    pdf_url:
      `${SUPABASE}/storage/v1/object/public/job-documents/${JOB}/quote-Q1001.pdf`,
    fingerprint: "0123456789abcdef0123456789abcdef",
    doc_at: "2026-10-04T02:00:00.000Z",
    capture_mode: "live",
    attempts: 0,
    ...over,
  };
}

const QUOTE_WORDS =
  "SecureWorks Group quote Q-1001 for 12 Example Street. Supply and install 24 metres of Colorbond fencing, 1.8 m high, two gates, removal of the old fence and disposal. Price includes GST. Deposit of 30 per cent on acceptance, balance on completion of the work.";

function textPdf(text = QUOTE_WORDS, pages = 2): PdfText {
  return {
    text,
    rawText: text,
    charCount: text.length,
    mode: "text",
    extractor: "unpdf@1.6.2",
    pageCount: pages,
    truncated: false,
  };
}

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 fixture bytes");

interface Calls {
  downloads: string[];
  extracts: number;
  extractLimits: (number | undefined)[];
  captures: Record<string, unknown>[];
  records: ReadRecord[];
  runs: Record<string, unknown>[];
  relists: { source: string; since: string; priority: number }[];
}

function fakeDeps(opts: {
  due?: DueDocument[];
  requested?: DueDocument[];
  requestedThrows?: boolean;
  download?: (bucket: string, path: string) => Download;
  extract?: PdfText;
  capture?: (row: Record<string, unknown>) => CaptureOutcome;
  record?: (rec: ReadRecord) => { outcome?: string; error?: string };
  relist?: { listed?: number; error?: string };
  flag?: boolean;
  lane?: boolean;
  latest?: { id: string; status: string; started_at: string } | null;
  dueThrows?: boolean;
  clock?: () => number;
} = {}): { deps: ReaderDeps; calls: Calls } {
  const calls: Calls = {
    downloads: [],
    extracts: 0,
    extractLimits: [],
    captures: [],
    records: [],
    runs: [],
    relists: [],
  };
  let n = 0;
  const deps: ReaderDeps = {
    now: opts.clock ?? (() => Date.parse("2026-10-05T00:00:00Z")),
    supabaseUrl: SUPABASE,
    flagOn: () => Promise.resolve(opts.flag ?? true),
    laneOn: () => Promise.resolve(opts.lane ?? true),
    policy: () => Promise.resolve(POLICY),
    latestRun: () => Promise.resolve(opts.latest ?? null),
    recordRun(run) {
      calls.runs.push(run);
      return Promise.resolve(
        (run.run_id as string) ?? "33333333-3333-4333-8333-333333333333",
      );
    },
    dueDocuments() {
      if (opts.dueThrows) {
        return Promise.reject(
          Object.assign(new Error("x"), { code: "due_documents_unreadable" }),
        );
      }
      return Promise.resolve(opts.due ?? [doc()]);
    },
    requestedDocuments() {
      if (opts.requestedThrows) {
        return Promise.reject(
          Object.assign(new Error("x"), { code: "requested_unreadable" }),
        );
      }
      return Promise.resolve(opts.requested ?? []);
    },
    download(bucket, path) {
      calls.downloads.push(`${bucket}/${path}`);
      return Promise.resolve(
        opts.download?.(bucket, path) ?? { ok: true, bytes: PDF_BYTES },
      );
    },
    extract(_bytes, o) {
      calls.extracts++;
      calls.extractLimits.push(o?.maxBytes);
      return Promise.resolve(opts.extract ?? textPdf());
    },
    capture(row) {
      calls.captures.push(row);
      return Promise.resolve(
        opts.capture?.(row) ??
          {
            outcome: "inserted",
            id: `44444444-4444-4444-8444-44444444444${n++}`,
          },
      );
    },
    record(rec) {
      calls.records.push(rec);
      return Promise.resolve(opts.record?.(rec) ?? { outcome: rec.result });
    },
    relistBackfill(source, since, priority) {
      calls.relists.push({ source, since, priority });
      return Promise.resolve(opts.relist ?? { listed: 1 });
    },
  };
  return { deps, calls };
}

// ── One document ───────────────────────────────────────────────────────

Deno.test("document: a text PDF is saved on its job and recorded with its evidence row", async () => {
  const { deps, calls } = fakeDeps();
  const step = await processDocument(doc(), POLICY, deps);
  assertEquals(step.outcome, "saved");
  assertEquals(step.savedMode, "live");
  assertEquals(calls.downloads, [`job-documents/${JOB}/quote-Q1001.pdf`]);
  assertEquals(calls.captures.length, 1);
  assertEquals(calls.records.length, 1);
  const rec = calls.records[0];
  assertEquals(rec.result, "saved");
  assertEquals(rec.event_id, "44444444-4444-4444-8444-444444444440");
  assertEquals(rec.sha256, await sha256Hex(PDF_BYTES));
  assertEquals(rec.page_count, 2);
  assertEquals(rec.file_kind, "pdf");
  assertEquals(rec.fingerprint, doc().fingerprint);
});

Deno.test("document: the same bytes already saved on the job are recorded saved (dedupe)", async () => {
  const { deps, calls } = fakeDeps({
    capture: () => ({
      outcome: "duplicate",
      id: "55555555-5555-4555-8555-555555555555",
    }),
  });
  const step = await processDocument(doc(), POLICY, deps);
  assertEquals(step.outcome, "duplicate");
  assertEquals(calls.records[0].result, "saved");
  assertEquals(
    calls.records[0].event_id,
    "55555555-5555-4555-8555-555555555555",
  );
});

Deno.test("document: a photo and a scan are no_text_layer for the vision reader; nothing saved", async () => {
  const photo = fakeDeps();
  const s1 = await processDocument(
    doc({
      file_name: "site.jpg",
      pdf_url: null,
      storage_url: `${JOB}/site.jpg`,
    }),
    POLICY,
    photo.deps,
  );
  assertEquals(s1, { outcome: "no_text_layer", code: "image" });
  assertEquals(photo.calls.downloads.length, 0);
  assertEquals(photo.calls.captures.length, 0);
  assertEquals(photo.calls.records[0].file_kind, "image");

  const scan = fakeDeps({
    extract: {
      text: "",
      rawText: "",
      charCount: 0,
      mode: "none",
      note: "no_text_layer",
      pageCount: 3,
    },
  });
  const s2 = await processDocument(doc(), POLICY, scan.deps);
  assertEquals(s2.outcome, "no_text_layer");
  assertEquals(scan.calls.captures.length, 0);
  assertEquals(scan.calls.records[0].result, "no_text_layer");
  assertEquals(scan.calls.records[0].page_count, 3);
  assertMatch(scan.calls.records[0].sha256 ?? "", /^[0-9a-f]{64}$/);
});

Deno.test("document: other kinds, foreign links and missing objects are terminal and fetch nothing", async () => {
  const other = fakeDeps();
  assertEquals(
    (await processDocument(
      doc({
        file_name: "plans.dwg",
        pdf_url: null,
        storage_url: `${JOB}/plans.dwg`,
      }),
      POLICY,
      other.deps,
    )).outcome,
    "not_supported",
  );
  assertEquals(other.calls.downloads.length, 0);

  const foreign = fakeDeps();
  const s = await processDocument(
    doc({ pdf_url: "https://drive.example/quote.pdf", storage_url: null }),
    POLICY,
    foreign.deps,
  );
  assertEquals(s, { outcome: "no_file", code: "unsupported_location" });
  assertEquals(foreign.calls.downloads.length, 0);

  const missing = fakeDeps({
    download: () => ({ ok: false, code: "missing", missing: true }),
  });
  assertEquals(await processDocument(doc(), POLICY, missing.deps), {
    outcome: "no_file",
    code: "object_missing",
  });
  assertEquals(missing.calls.records[0].result, "no_file");
});

Deno.test("preview: lists what a run would take, reads and writes nothing, flag off or on", async () => {
  const due = [
    doc(),
    doc({
      file_name: "site.jpg",
      pdf_url: null,
      storage_url: `${JOB}/site.jpg`,
    }),
  ];
  const { deps, calls } = fakeDeps({ due, flag: false });
  const p = await previewDocumentText(deps, 20);
  assertEquals(p.flag_on, false);
  assertEquals(p.due.map((d) => [d.file_kind, d.location]), [[
    "pdf",
    "storage:job-documents",
  ], ["image", "not_read"]]);
  assertEquals([
    calls.downloads.length,
    calls.extracts,
    calls.captures.length,
    calls.records.length,
    calls.runs.length,
  ], [0, 0, 0, 0, 0]);
});

// ── Read requests (20261104130000) ─────────────────────────────────────

const REQ_POLICY: ReaderPolicy = {
  ...POLICY,
  no_job_key: "no_job",
  request_max_pdf_bytes: 20_000_000,
};

/** A requested supplier bill whose email is on no job. */
function noJobBill(over: Partial<DueDocument> = {}): DueDocument {
  return doc({
    source_kind: "email_attachment",
    source_id: "66666666-6666-4666-8666-666666666666",
    job_id: null,
    job_number: null,
    file_name: "Invoice_10095132.pdf",
    doc_type: "email_attachment",
    content_type: "application/pdf",
    storage_bucket: "context-email-attachments",
    storage_path: "msg/abc/Invoice_10095132.pdf",
    storage_url: null,
    pdf_url: null,
    capture_mode: "backfill",
    max_pdf_bytes: null,
    ...over,
  });
}

const BILL_WORDS =
  "TAX INVOICE 10095132. Deliver to SWF-261562, 12 Example Street. 6 x 2400 mm posts, 12 x rails, 1 x gate kit. Total includes GST. Payment due on the 20th of the month following.";

Deno.test("requested: a bill on no job is saved on no job, keyed no_job, marked automated, and lists no job", async () => {
  const { deps, calls } = fakeDeps({
    requested: [noJobBill()],
    due: [],
    extract: textPdf(BILL_WORDS, 1),
  });
  const run = await runDocumentText({ ...deps, policy: () => Promise.resolve(REQ_POLICY) });
  if (run.outcome !== "ran") throw new Error(run.outcome);
  assertEquals(run.status, "succeeded");
  assertEquals(run.counts.requested, 1);
  assertEquals(run.counts.saved, 1);
  assertEquals(run.counts.no_job_saved, 1);
  assertEquals(run.counts.backfill_saved, 0);
  assertEquals(calls.relists.length, 0);
  assertEquals(calls.downloads, ["context-email-attachments/msg/abc/Invoice_10095132.pdf"]);
  const row = calls.captures[0];
  const sha = await sha256Hex(PDF_BYTES);
  assertEquals("job_id" in row, false);
  assertEquals("match_method" in row, false);
  assertEquals(row.provider_message_id, `doctext:no_job:${sha}`);
  const payload = row.payload as Record<string, unknown>;
  assertEquals(payload.automated, true);
  assertEquals(payload.no_job, true);
  assertEquals(payload.job_id, null);
  assertEquals(row.metadata, { capture_mode: "backfill", writer: "workflow:context-document-text", requested_read: true });
  assertEquals(calls.records.length, 1);
  assertEquals(calls.records[0].job_id, null);
  assertEquals(calls.records[0].result, "saved");
  assertEquals(calls.extractLimits, [5_000_000]);
});

Deno.test("requested: a document on a job keeps exactly its old evidence row", () => {
  const read = { sha256: "c".repeat(64), text: QUOTE_WORDS, pageCount: 2, truncated: false, extractor: "unpdf@1.6.2" };
  const row = buildDocumentTextRow(doc(), read, REQ_POLICY);
  assertEquals(row.job_id, JOB);
  assertEquals(row.match_method, "direct_job_id");
  assertEquals(row.provider_message_id, `doctext:${JOB}:${"c".repeat(64)}`);
  assertEquals(row.metadata, { capture_mode: "live", writer: "workflow:context-document-text" });
  const payload = row.payload as Record<string, unknown>;
  assertEquals("automated" in payload, false);
  assertEquals("no_job" in payload, false);
  assertEquals(payload.job_id, JOB);
  // Same row with the old policy shape (no no_job_key): nothing about a job's row depends on it.
  assertEquals(buildDocumentTextRow(doc(), read, POLICY), row);
});

Deno.test("requested: requested documents run first and the ordinary list fills the batch", async () => {
  const asked: number[] = [];
  const listed = await documentsDue({
    requestedDocuments: () => Promise.resolve([noJobBill()]),
    dueDocuments: (n) => {
      asked.push(n);
      return Promise.resolve([doc(), doc({ source_id: "77777777-7777-4777-8777-777777777777" })]);
    },
  }, 20);
  assertEquals(listed.requested, 1);
  assertEquals(listed.documents.map((d) => d.source_id), [
    "66666666-6666-4666-8666-666666666666",
    "22222222-2222-4222-8222-222222222222",
    "77777777-7777-4777-8777-777777777777",
  ]);
  assertEquals(asked, [19]);
  // A full requested list leaves no room: the ordinary list is not asked.
  const full = await documentsDue({
    requestedDocuments: () => Promise.resolve([noJobBill(), noJobBill()]),
    dueDocuments: () => { throw new Error("not asked"); },
  }, 2);
  assertEquals(full.documents.length, 2);
});

Deno.test("requested: an unreadable requested list leaves the ordinary list to run", async () => {
  const { deps, calls } = fakeDeps({ requestedThrows: true });
  const run = await runDocumentText(deps);
  if (run.outcome !== "ran") throw new Error(run.outcome);
  assertEquals(run.status, "partial");
  assertEquals(run.error_code, "requested_unreadable");
  assertEquals(run.counts.saved, 1);
  assertEquals(calls.captures.length, 1);
});

Deno.test("requested: a raised limit reads a 5.4 MB PDF after recording the attempt; without it the PDF is too large", async () => {
  const bytes = new Uint8Array(5_412_737);
  bytes.set(new TextEncoder().encode("%PDF-1.4"));
  const sha = await sha256Hex(bytes);
  const quote = doc({
    source_kind: "email_attachment",
    job_id: JOB,
    content_type: "application/pdf",
    storage_bucket: "context-email-attachments",
    storage_path: "msg/q/quote.pdf",
    storage_url: null,
    pdf_url: null,
    capture_mode: "backfill",
  });
  // No request: too large, nothing extracted.
  const plain = fakeDeps({ download: () => ({ ok: true, bytes }) });
  assertEquals((await processDocument(quote, REQ_POLICY, plain.deps)).outcome, "too_large");
  assertEquals(plain.calls.extracts, 0);
  // A request for 20 MB: the attempt is recorded, then the read at 20 MB.
  const raised = fakeDeps({ download: () => ({ ok: true, bytes }), extract: textPdf(QUOTE_WORDS, 3) });
  const step = await processDocument({ ...quote, max_pdf_bytes: 20_000_000 }, REQ_POLICY, raised.deps);
  assertEquals(step.outcome, "saved");
  assertEquals(raised.calls.records.map((r) => [r.result, r.code ?? null]), [["error", "large_read_started"], ["saved", null]]);
  assertEquals(raised.calls.records[0].sha256, sha);
  assertEquals(raised.calls.extractLimits, [20_000_000]);
  assertEquals(raised.calls.records[1].page_count, 3);
  // A failed attempt record stops before the read.
  const blocked = fakeDeps({ download: () => ({ ok: true, bytes }), record: () => ({ error: "document_text_source_not_found" }) });
  assertEquals((await processDocument({ ...quote, max_pdf_bytes: 20_000_000 }, REQ_POLICY, blocked.deps)).outcome, "record_failed");
  assertEquals(blocked.calls.extracts, 0);
});

Deno.test("requested: the size limit never passes the policy or 20 MB, and a PDF under 5 MB records no extra attempt", async () => {
  assertEquals(pdfByteLimit(doc(), REQ_POLICY), 5_000_000);
  assertEquals(pdfByteLimit(doc({ max_pdf_bytes: 4_000_000 }), REQ_POLICY), 5_000_000);
  assertEquals(pdfByteLimit(doc({ max_pdf_bytes: 12_000_000 }), REQ_POLICY), 12_000_000);
  assertEquals(pdfByteLimit(doc({ max_pdf_bytes: 90_000_000 }), REQ_POLICY), 20_000_000);
  assertEquals(pdfByteLimit(doc({ max_pdf_bytes: 12_000_000 }), { ...REQ_POLICY, request_max_pdf_bytes: 8_000_000 }), 8_000_000);
  // An old policy without the field never raises.
  assertEquals(pdfByteLimit(doc({ max_pdf_bytes: 12_000_000 }), POLICY), 5_000_000);
  const small = fakeDeps();
  await processDocument(doc({ max_pdf_bytes: 20_000_000 }), REQ_POLICY, small.deps);
  assertEquals(small.calls.records.map((r) => r.result), ["saved"]);
  assertEquals(small.calls.extractLimits, [20_000_000]);
});

Deno.test("requested: preview shows requested documents first and marks a read on no job", async () => {
  const { deps } = fakeDeps({ requested: [noJobBill({ max_pdf_bytes: 20_000_000 })], due: [doc()] });
  const result = await previewDocumentText(deps, 10);
  assertEquals(result.due.map((d) => [d.on_no_job, d.max_pdf_bytes ?? null, d.location]), [
    [true, 20_000_000, "storage:context-email-attachments"],
    [false, null, "storage:job-documents"],
  ]);
});
