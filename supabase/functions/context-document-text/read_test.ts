// The document text reader (gap plan B-5): file kinds, the own-storage-only
// location rule, the text gate, the evidence row, and one run end to end on
// fake reads and writes. No network, no model, no real PDF parser: the
// extractor is ops-api/makesafe_pdf_text.ts, tested there; here it is a stub
// returning the shapes that module returns.

// deno-lint-ignore no-import-prefix
import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type CaptureOutcome, type Download, type DueDocument, type PdfText, previewDocumentText, processDocument, type ReaderDeps, type ReaderPolicy, type ReadRecord, sha256Hex } from "./read.ts";

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
