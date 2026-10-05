// The document text reader (gap plan B-5): file kinds, the own-storage-only
// location rule, the text gate, the evidence row, and one run end to end on
// fake reads and writes. No network, no model, no real PDF parser: the
// extractor is ops-api/makesafe_pdf_text.ts, tested there; here it is a stub
// returning the shapes that module returns.

// deno-lint-ignore no-import-prefix
import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDocumentTextRow,
  type CaptureOutcome,
  documentLabel,
  type Download,
  type DueDocument,
  fileKind,
  noTextResult,
  type PdfText,
  previewDocumentText,
  processDocument,
  readableText,
  type ReaderDeps,
  type ReaderPolicy,
  type ReadRecord,
  resolveLocation,
  runDocumentText,
  sha256Hex,
} from "./read.ts";

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
  captures: Record<string, unknown>[];
  records: ReadRecord[];
  runs: Record<string, unknown>[];
  relists: { source: string; since: string; priority: number }[];
}

function fakeDeps(opts: {
  due?: DueDocument[];
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
    download(bucket, path) {
      calls.downloads.push(`${bucket}/${path}`);
      return Promise.resolve(
        opts.download?.(bucket, path) ?? { ok: true, bytes: PDF_BYTES },
      );
    },
    extract() {
      calls.extracts++;
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

// ── File kind and location ─────────────────────────────────────────────

Deno.test("file kind: content type first, then the name, then the location", () => {
  assertEquals(fileKind(doc()), "pdf");
  assertEquals(
    fileKind(doc({ file_name: "IMG_2041.HEIC", pdf_url: null })),
    "image",
  );
  assertEquals(
    fileKind(doc({ file_name: "site.jpg", pdf_url: null })),
    "image",
  );
  assertEquals(
    fileKind(doc({ file_name: "plans.dwg", pdf_url: null })),
    "other",
  );
  assertEquals(
    fileKind(
      doc({
        source_kind: "email_attachment",
        content_type: "application/pdf",
        file_name: "scan",
      }),
    ),
    "pdf",
  );
  assertEquals(
    fileKind(
      doc({
        source_kind: "email_attachment",
        content_type: "image/png",
        file_name: "a.pdf",
      }),
    ),
    "image",
  );
  // No name: pdf_url is only ever set for a PDF.
  assertEquals(fileKind(doc({ file_name: null, storage_url: null })), "pdf");
  assertEquals(
    fileKind(doc({ file_name: null, storage_url: null, pdf_url: null })),
    "other",
  );
});

Deno.test("location: only our own storage is ever read", () => {
  assertEquals(resolveLocation(doc(), SUPABASE), {
    ok: true,
    bucket: "job-documents",
    path: `${JOB}/quote-Q1001.pdf`,
  });
  // A bare stored path is the job-documents bucket.
  assertEquals(resolveLocation(doc({ pdf_url: null }), SUPABASE), {
    ok: true,
    bucket: "job-documents",
    path: `${JOB}/quote-Q1001.pdf`,
  });
  // Encoded names decode; signed links resolve to the object.
  assertEquals(
    resolveLocation(
      doc({
        pdf_url:
          `${SUPABASE}/storage/v1/object/sign/job-documents/${JOB}/Work%20Order.pdf?token=abc`,
      }),
      SUPABASE,
    ),
    { ok: true, bucket: "job-documents", path: `${JOB}/Work Order.pdf` },
  );
  // Somebody else's host, plain http, or a path escape: never fetched.
  assertEquals(
    resolveLocation(
      doc({
        pdf_url:
          "https://evil.example/storage/v1/object/public/job-documents/x.pdf",
        storage_url: null,
      }),
      SUPABASE,
    ),
    { ok: false, code: "unsupported_location" },
  );
  assertEquals(
    resolveLocation(
      doc({
        pdf_url: SUPABASE.replace("https", "http") +
          "/storage/v1/object/public/job-documents/x.pdf",
        storage_url: null,
      }),
      SUPABASE,
    ),
    { ok: false, code: "unsupported_location" },
  );
  assertEquals(
    resolveLocation(
      doc({ pdf_url: null, storage_url: "../secrets/x.pdf" }),
      SUPABASE,
    ),
    { ok: false, code: "unsupported_location" },
  );
  assertEquals(
    resolveLocation(doc({ pdf_url: null, storage_url: "  " }), SUPABASE),
    {
      ok: false,
      code: "no_location",
    },
  );
  // An email attachment lives only in the private reader bucket.
  assertEquals(
    resolveLocation(
      doc({
        source_kind: "email_attachment",
        storage_bucket: "context-email-attachments",
        storage_path: "abc/def.pdf",
      }),
      SUPABASE,
    ),
    { ok: true, bucket: "context-email-attachments", path: "abc/def.pdf" },
  );
  assertEquals(
    resolveLocation(
      doc({
        source_kind: "email_attachment",
        storage_bucket: "job-documents",
        storage_path: "abc/def.pdf",
      }),
      SUPABASE,
    ),
    { ok: false, code: "no_location" },
  );
});

// ── The text gate ───────────────────────────────────────────────────────

Deno.test("text: the extractor's text, or a short clean purchase order it held back", () => {
  assertEquals(readableText(textPdf()), QUOTE_WORDS);
  const po = "Purchase Order PO-56001 Supplier Stratco 24 posts";
  assertEquals(
    readableText({
      text: "",
      rawText: po,
      charCount: po.length,
      mode: "none",
      note: "low_quality_text",
    }),
    po,
  );
  // Mojibake, one repeated token, a scan with nothing: no text.
  assertEquals(
    readableText({
      text: "",
      rawText: "ÿþ\u0001\u0002 ~~~ ### ;;; ééééééé",
      charCount: 30,
      mode: "none",
      note: "low_quality_text",
    }),
    null,
  );
  const locale = Array(30).fill("en-AU").join(" ");
  assertEquals(
    readableText({
      text: "",
      rawText: locale,
      charCount: locale.length,
      mode: "none",
      note: "low_quality_text",
    }),
    null,
  );
  assertEquals(
    readableText({
      text: "",
      rawText: "",
      charCount: 0,
      mode: "none",
      note: "no_text_layer",
    }),
    null,
  );
});

Deno.test("text: why a PDF gave no text, as a record outcome", () => {
  const none = (note: string): PdfText => ({
    text: "",
    rawText: "",
    charCount: 0,
    mode: "none",
    note,
  });
  assertEquals(noTextResult(none("no_text_layer")), {
    result: "no_text_layer",
    code: "no_text_layer",
  });
  assertEquals(noTextResult(none("low_quality_text")), {
    result: "no_text_layer",
    code: "low_quality_text",
  });
  assertEquals(noTextResult(none("pdf_too_large")), {
    result: "too_large",
    code: "pdf_too_large",
  });
  assertEquals(noTextResult(none("pdf_too_many_pages")), {
    result: "too_many_pages",
    code: "pdf_too_many_pages",
  });
  assertEquals(noTextResult(none("not_pdf")), {
    result: "unreadable",
    code: "not_pdf",
  });
  assertEquals(noTextResult(none("pdf_parse_failed")), {
    result: "unreadable",
    code: "pdf_parse_failed",
  });
});

// ── The evidence row ───────────────────────────────────────────────────

Deno.test("row: keyed by job and content hash, on the document's own job, marked as document text", async () => {
  const sha = await sha256Hex(PDF_BYTES);
  assertMatch(sha, /^[0-9a-f]{64}$/);
  const row = buildDocumentTextRow(doc({ capture_mode: "backfill" }), {
    sha256: sha,
    text: QUOTE_WORDS,
    pageCount: 2,
    truncated: false,
    extractor: "unpdf@1.6.2",
  }, POLICY);
  assertEquals(row.provider_message_id, `doctext:${JOB}:${sha}`);
  assertEquals(row.event_type, "document.text_extracted");
  assertEquals(row.source, "context-document-text");
  assertEquals(row.job_id, JOB);
  assertEquals(row.match_method, "direct_job_id");
  assertEquals(row.channel, "document");
  assertEquals(row.event_at, "2026-10-04T02:00:00.000Z");
  assertEquals(
    (row.metadata as Record<string, unknown>).capture_mode,
    "backfill",
  );
  const payload = row.payload as Record<string, unknown>;
  assertEquals(payload.document_text, true);
  // The ladder's admission rule: a payload job equal to the row's job.
  assertEquals(payload.job_id, JOB);
  const text = payload.text as string;
  assert(text.startsWith('[Document text: Quote "quote-Q1001.pdf", 2 pages.'));
  assertStringIncludes(text, "not a message.]");
  assert(text.endsWith(QUOTE_WORDS));
  assertEquals(row.body_preview, QUOTE_WORDS.slice(0, 500));
  // The summary carries no words and no file name.
  assertEquals(
    row.safe_summary,
    `[Document text: Quote, 2 pages, ${QUOTE_WORDS.length} characters.]`,
  );
  // Only business_events columns (capture_business_event refuses others).
  for (const k of Object.keys(row)) {
    assert(
      [
        "event_type",
        "source",
        "entity_type",
        "entity_id",
        "job_id",
        "match_method",
        "event_at",
        "provider_message_id",
        "channel",
        "direction",
        "thread_key",
        "body_preview",
        "safe_summary",
        "privacy_classification",
        "retention_class",
        "payload",
        "metadata",
      ].includes(k),
      k,
    );
  }
});

Deno.test("row: labels for each document kind", () => {
  assertEquals(documentLabel("work_order"), "Work order");
  assertEquals(documentLabel("supplier_invoice"), "Supplier invoice");
  assertEquals(documentLabel("email_attachment"), "Email attachment");
  assertEquals(documentLabel("roof_report"), "Roof report");
  assertEquals(documentLabel(null), "Document");
});

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

Deno.test("document: a storage fault is an error the database backs off", async () => {
  const { deps, calls } = fakeDeps({
    download: () => ({ ok: false, code: "storage_error", missing: false }),
  });
  assertEquals(await processDocument(doc(), POLICY, deps), {
    outcome: "error",
    code: "download_storage_error",
  });
  assertEquals(calls.records[0].result, "error");
  assertEquals(calls.records[0].code, "download_storage_error");
});

Deno.test("document: over 5 MB is too_large before any parse", async () => {
  const big = new Uint8Array(5_000_001);
  big.set(PDF_BYTES);
  const { deps, calls } = fakeDeps({
    download: () => ({ ok: true, bytes: big }),
  });
  assertEquals(
    (await processDocument(doc(), POLICY, deps)).outcome,
    "too_large",
  );
  assertEquals(calls.extracts, 0);
});

Deno.test("document: the capture lane switched off mid-run stops the run and records nothing", async () => {
  const { deps, calls } = fakeDeps({
    capture: () => ({ outcome: "capture_disabled" }),
  });
  const step = await processDocument(doc(), POLICY, deps);
  assertEquals(step.stop, "capture_disabled");
  assertEquals(calls.records.length, 0);
});

Deno.test("document: a refused save is an error with the writer's code", async () => {
  const { deps, calls } = fakeDeps({
    capture: () => ({ outcome: "error", code: "capture_row_unknown_column" }),
  });
  assertEquals(await processDocument(doc(), POLICY, deps), {
    outcome: "error",
    code: "capture_capture_row_unknown_column",
  });
  assertEquals(calls.records[0].result, "error");
});

// ── A run ──────────────────────────────────────────────────────────────

Deno.test("run: idle with no run row while the flag or the capture lane is off", async () => {
  const off = fakeDeps({ flag: false });
  assertEquals(await runDocumentText(off.deps), {
    outcome: "idle",
    reason: "flag_off",
  });
  assertEquals(off.calls.runs.length, 0);
  const lane = fakeDeps({ lane: false });
  assertEquals(await runDocumentText(lane.deps), {
    outcome: "idle",
    reason: "capture_lane_off",
  });
  assertEquals(lane.calls.runs.length, 0);
});

Deno.test("run: a fresh run in progress is left alone", async () => {
  const { deps, calls } = fakeDeps({
    latest: { id: "r1", status: "running", started_at: "2026-10-04T23:58:00Z" },
  });
  assertEquals(await runDocumentText(deps), {
    outcome: "run_in_progress",
    run_id: "r1",
  });
  assertEquals(calls.runs.length, 0);
});

Deno.test("run: a mixed batch, counted, and history documents listed for reading", async () => {
  const due = [
    doc({ source_id: "a0000000-0000-4000-8000-000000000001" }),
    doc({
      source_id: "a0000000-0000-4000-8000-000000000002",
      capture_mode: "backfill",
      doc_type: "work_order",
      file_name: "wo.pdf",
    }),
    doc({
      source_id: "a0000000-0000-4000-8000-000000000003",
      file_name: "site.jpg",
      pdf_url: null,
      storage_url: `${JOB}/site.jpg`,
    }),
    doc({
      source_id: "a0000000-0000-4000-8000-000000000004",
      pdf_url: "https://drive.example/x.pdf",
      storage_url: null,
    }),
  ];
  const { deps, calls } = fakeDeps({ due });
  const result = await runDocumentText(deps);
  assert(result.outcome === "ran");
  assertEquals(result.status, "succeeded");
  assertEquals(result.counts.selected, 4);
  assertEquals(result.counts.saved, 2);
  assertEquals(result.counts.live_saved, 1);
  assertEquals(result.counts.backfill_saved, 1);
  assertEquals(result.counts.no_text_layer, 1);
  assertEquals(result.counts.image, 1);
  assertEquals(result.counts.no_file, 1);
  assertEquals(result.counts.relisted_jobs, 1);
  assertEquals(calls.relists, [{
    source: "context-document-text",
    since: "2026-10-04T00:00:00.000Z",
    priority: 2,
  }]);
  // Opened running, closed once with the counts.
  assertEquals(calls.runs[0].status, "running");
  assertEquals(calls.runs[1].status, "succeeded");
  // Results carry ids and codes only, never words.
  assert(!JSON.stringify(result).includes("Colorbond"));
});

Deno.test("run: no history saved, no re-list", async () => {
  const { deps, calls } = fakeDeps();
  const result = await runDocumentText(deps);
  assert(result.outcome === "ran");
  assertEquals(calls.relists.length, 0);
});

Deno.test("run: a failed re-list or a failed record makes the run partial", async () => {
  const relist = fakeDeps({
    due: [doc({ capture_mode: "backfill" })],
    relist: { error: "relist_failed" },
  });
  const r1 = await runDocumentText(relist.deps);
  assert(r1.outcome === "ran");
  assertEquals([r1.status, r1.error_code], ["partial", "relist_failed"]);

  const rec = fakeDeps({
    record: () => ({ error: "document_text_event_not_found" }),
  });
  const r2 = await runDocumentText(rec.deps);
  assert(r2.outcome === "ran");
  assertEquals([r2.status, r2.error_code, r2.counts.record_failed], [
    "partial",
    "record_failed",
    1,
  ]);
});

Deno.test("run: an unreadable due list fails the run with its code", async () => {
  const { deps, calls } = fakeDeps({ dueThrows: true });
  const r = await runDocumentText(deps);
  assert(r.outcome === "ran");
  assertEquals([r.status, r.error_code], [
    "failed",
    "due_documents_unreadable",
  ]);
  assertEquals(calls.runs[1].error_code, "due_documents_unreadable");
});

Deno.test("run: the time budget stops the run partial", async () => {
  let t = Date.parse("2026-10-05T00:00:00Z");
  const { deps } = fakeDeps({
    due: [doc(), doc({ source_id: "a0000000-0000-4000-8000-000000000009" })],
    clock: () => {
      const now = t;
      t += 60_000;
      return now;
    },
  });
  const r = await runDocumentText(deps);
  assert(r.outcome === "ran");
  assertEquals([r.status, r.error_code], ["partial", "time_budget"]);
  assertEquals(r.counts.selected, 1);
});

Deno.test("run: a step that throws is recorded as an error, the run carries on", async () => {
  const { deps, calls } = fakeDeps({
    due: [doc(), doc({ source_id: "a0000000-0000-4000-8000-000000000010" })],
  });
  let first = true;
  deps.extract = () => {
    if (first) {
      first = false;
      return Promise.reject(new Error("boom"));
    }
    return Promise.resolve(textPdf());
  };
  const r = await runDocumentText(deps);
  assert(r.outcome === "ran");
  assertEquals(r.counts.errors, 1);
  assertEquals(r.counts.saved, 1);
  assertEquals(calls.records[0].result, "error");
  assertEquals(calls.records[0].code, "threw_error");
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
