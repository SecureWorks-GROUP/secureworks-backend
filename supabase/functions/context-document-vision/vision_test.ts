// deno-lint-ignore-file no-import-prefix
// The vision reader (gap plan B-5b) on fake reads and writes: what is handed
// to the worker and when a call is reserved, what spends no call, and how an
// answer becomes evidence. No network, no model.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { DueDocument } from "../context-document-text/read.ts";
import {
  buildVisionTextRow,
  type ClaimOutcome,
  type ClaimRequest,
  cleanText,
  INSTRUCTIONS,
  type LeasedDocument,
  nextDocument,
  OUTPUT_SCHEMA,
  parseAnswer,
  previewVision,
  submitReading,
  type VisionDeps,
  type VisionPolicy,
  type VisionRecord,
} from "./vision.ts";

/** The parts of an evidence row the tests read. */
type Row = {
  [key: string]: unknown;
  payload: { text: string; job_id: string; document: Record<string, unknown> };
};

const JOB = "11111111-1111-4111-8111-111111111111";
const RESV = "22222222-2222-4222-8222-222222222222";
const SUPABASE = "https://kevgrhcjxspbxgovpmfl.supabase.co";

const POLICY: VisionPolicy = {
  event_source: "context-document-vision",
  event_type: "document.text_extracted",
  key_prefix: "doctext:",
  batch_limit: 5,
  max_image_bytes: 1000,
  max_pdf_bytes: 2000,
  max_images: 5,
  min_image_side: 300,
  max_chars: 40,
  min_chars: 3,
  min_confidence: 0.5,
  catchup_priority: 2,
};

function jpeg(size = 64): Uint8Array {
  const b = new Uint8Array(size).fill(0x41);
  b.set([0xff, 0xd8, 0xff, 0xe0], 0);
  b.set([0xff, 0xd9], size - 2);
  return b;
}

function scannedPdf(): Uint8Array {
  const page = jpeg(80);
  const head = new TextEncoder().encode(
    `%PDF-1.4\n3 0 obj\n<< /Subtype /Image /Width 2480 /Height 3508 /Filter /DCTDecode /Length ${page.length} >>\nstream\n`,
  );
  const tail = new TextEncoder().encode("\nendstream\nendobj\n%%EOF\n");
  const out = new Uint8Array(head.length + page.length + tail.length);
  out.set(head, 0);
  out.set(page, head.length);
  out.set(tail, head.length + page.length);
  return out;
}

function doc(over: Partial<DueDocument> = {}): DueDocument {
  return {
    source_kind: "job_document",
    source_id: "33333333-3333-4333-8333-333333333333",
    job_id: JOB,
    job_number: "SWF-1",
    file_name: "site-photo.jpg",
    doc_type: "client_reference",
    content_type: null,
    storage_bucket: null,
    storage_path: null,
    storage_url: `${JOB}/site-photo.jpg`,
    pdf_url: null,
    fingerprint: "a".repeat(32),
    doc_at: "2026-10-01T00:00:00Z",
    capture_mode: "backfill",
    attempts: 0,
    ...over,
  };
}

function lease(over: Partial<LeasedDocument> = {}): LeasedDocument {
  return {
    source_kind: "job_document",
    source_id: "33333333-3333-4333-8333-333333333333",
    job_id: JOB,
    fingerprint: "a".repeat(32),
    file_kind: "pdf",
    sha256: "b".repeat(64),
    page_count: 2,
    image_count: 2,
    images_cut: false,
    doc_type: "work_order",
    file_name: "WO-1001.pdf",
    content_type: null,
    doc_at: "2026-09-01T00:00:00Z",
    capture_mode: "backfill",
    lease_until: "2026-10-05T01:00:00Z",
    ...over,
  };
}

interface Fake {
  deps: VisionDeps;
  records: VisionRecord[];
  claims: ClaimRequest[];
  captured: Record<string, unknown>[];
  relists: string[];
}

function fake(over: {
  flag?: boolean;
  lane?: boolean;
  admission?: { open: boolean; code?: string };
  due?: DueDocument[];
  files?: Record<string, Uint8Array | "missing" | "error">;
  claim?: (req: ClaimRequest) => ClaimOutcome;
  leased?: LeasedDocument | null;
  capture?: Record<string, unknown>;
  recordError?: string;
} = {}): Fake {
  const f: Fake = {
    records: [],
    claims: [],
    captured: [],
    relists: [],
    deps: {} as VisionDeps,
  };
  f.deps = {
    now: () => 1_000,
    supabaseUrl: SUPABASE,
    flagOn: () => Promise.resolve(over.flag ?? true),
    laneOn: () => Promise.resolve(over.lane ?? true),
    policy: () => Promise.resolve(POLICY),
    admission: () => Promise.resolve(over.admission ?? { open: true }),
    dueDocuments: () => Promise.resolve(over.due ?? []),
    download: (bucket, path) => {
      const got = over.files?.[`${bucket}/${path}`];
      if (got === undefined || got === "missing") {
        return Promise.resolve({ ok: false, code: "missing", missing: true });
      }
      if (got === "error") {
        return Promise.resolve({
          ok: false,
          code: "storage_error",
          missing: false,
        });
      }
      return Promise.resolve({ ok: true, bytes: got });
    },
    pageCount: () => Promise.resolve(1),
    claim: (req) => {
      f.claims.push(req);
      return Promise.resolve(
        over.claim?.(req) ??
          { outcome: "claimed", reservation_id: RESV, lease_until: "soon" },
      );
    },
    leased: () =>
      Promise.resolve(over.leased === undefined ? lease() : over.leased),
    capture: (row) => {
      f.captured.push(row);
      return Promise.resolve(
        (over.capture ?? { outcome: "inserted", id: "ev-1" }) as never,
      );
    },
    record: (rec) => {
      f.records.push(rec);
      return Promise.resolve(
        over.recordError
          ? { error: over.recordError }
          : { outcome: rec.result },
      );
    },
    relistBackfill: (source) => {
      f.relists.push(source);
      return Promise.resolve({ listed: 1 });
    },
  };
  return f;
}

Deno.test("next is idle with the flag or a lane off, and closed when the budget is", async () => {
  assertEquals(await nextDocument(fake({ flag: false }).deps), {
    outcome: "idle",
    reason: "flag_off",
  });
  assertEquals(await nextDocument(fake({ lane: false }).deps), {
    outcome: "idle",
    reason: "lane_off",
  });
  const closed = fake({
    admission: { open: false, code: "vision_budget" },
    due: [doc()],
  });
  assertEquals(await nextDocument(closed.deps), {
    outcome: "closed",
    code: "vision_budget",
  });
  assertEquals(closed.claims.length, 0);
});

Deno.test("next hands out a photo only after a call is reserved", async () => {
  const photo = jpeg(100);
  const f = fake({
    due: [doc()],
    files: { [`job-documents/${JOB}/site-photo.jpg`]: photo },
  });
  const out = await nextDocument(f.deps);
  assertEquals(out.outcome, "claimed");
  if (out.outcome !== "claimed") return;
  assertEquals(f.claims.length, 1);
  assertEquals(f.claims[0].file_kind, "image");
  assertEquals(f.claims[0].image_count, 1);
  assertEquals(f.claims[0].sha256.length, 64);
  assertEquals(out.reservation_id, RESV);
  assertEquals(out.images.length, 1);
  assertEquals(out.images[0].media_type, "image/jpeg");
  assertEquals(
    Uint8Array.from(atob(out.images[0].data_base64), (c) => c.charCodeAt(0)),
    photo,
  );
  assertEquals(out.instructions, INSTRUCTIONS);
  assertEquals(out.output_schema, OUTPUT_SCHEMA);
  assertEquals(f.records.length, 0);
});

Deno.test("next sends a scan's JPEG pages and records what it cannot send, at no call", async () => {
  const heic = new TextEncoder().encode("\0\0\0\x18ftypheic........");
  const fax = new TextEncoder().encode(
    "%PDF-1.4\n3 0 obj\n<< /Subtype /Image /Width 2480 /Height 3508 /Filter /CCITTFaxDecode /Length 4 >>\nstream\nabcd\nendstream\nendobj\n",
  );
  const docs = [
    doc({ source_id: "s-heic", file_name: "a.heic", storage_url: "a.heic" }),
    doc({ source_id: "s-big", file_name: "b.jpg", storage_url: "b.jpg" }),
    doc({ source_id: "s-gone", file_name: "c.jpg", storage_url: "c.jpg" }),
    doc({ source_id: "s-fax", file_name: "d.pdf", storage_url: "d.pdf" }),
    doc({ source_id: "s-other", file_name: "e.docx", storage_url: "e.docx" }),
    doc({ source_id: "s-scan", file_name: "f.pdf", storage_url: "f.pdf" }),
  ];
  const f = fake({
    due: docs,
    files: {
      "job-documents/a.heic": heic,
      "job-documents/b.jpg": jpeg(5000),
      "job-documents/d.pdf": fax,
      "job-documents/f.pdf": scannedPdf(),
    },
  });
  const out = await nextDocument(f.deps);
  assertEquals(
    f.records.map((r) => [r.source_id, r.result, r.code]),
    [
      ["s-heic", "not_supported", "image_format_heic"],
      ["s-big", "too_large", "image_too_large"],
      ["s-gone", "no_file", "object_missing"],
      ["s-fax", "not_supported", "pdf_image_encoding"],
      ["s-other", "not_supported", "not_pdf_or_image"],
    ],
  );
  assertEquals(f.claims.map((c) => c.source_id), ["s-scan"]);
  assertEquals(f.claims[0].file_kind, "pdf");
  assertEquals(f.claims[0].page_count, 1);
  assertEquals(f.claims[0].images_cut, false);
  assertEquals(out.outcome, "claimed");
  if (out.outcome === "claimed") {
    assertEquals(out.images[0].media_type, "image/jpeg");
    assertEquals(out.recorded.length, 5);
  }
});

Deno.test("next moves past taken and already-read documents and stops when the budget closes", async () => {
  const files = {
    "job-documents/a.jpg": jpeg(),
    "job-documents/b.jpg": jpeg(),
    "job-documents/c.jpg": jpeg(),
  };
  const due = ["a", "b", "c"].map((n) =>
    doc({ source_id: `s-${n}`, file_name: `${n}.jpg`, storage_url: `${n}.jpg` })
  );
  const answers: Record<string, ClaimOutcome> = {
    "s-a": { outcome: "not_due", code: "leased" },
    "s-b": { outcome: "same_bytes_saved", event_id: "ev-9" },
    "s-c": { outcome: "vision_reserve" },
  };
  const f = fake({ due, files, claim: (r) => answers[r.source_id] });
  const out = await nextDocument(f.deps);
  assertEquals(out, { outcome: "closed", code: "vision_reserve" });
  assertEquals(f.claims.length, 3);
  const none = fake({
    due: [due[0]],
    files,
    claim: () => ({ outcome: "not_due" }),
  });
  assertEquals((await nextDocument(none.deps)).outcome, "nothing_due");
});

Deno.test("a download that fails for a reason other than a missing object backs off", async () => {
  const f = fake({
    due: [doc({ storage_url: "x.jpg" })],
    files: { "job-documents/x.jpg": "error" },
  });
  await nextDocument(f.deps);
  assertEquals(f.records.map((r) => [r.result, r.code]), [[
    "error",
    "download_storage_error",
  ]]);
  assertEquals(f.claims.length, 0);
});

Deno.test("parseAnswer takes exactly the schema's shape", () => {
  const ok = {
    kind: "printed_document",
    text: "WORK ORDER",
    confidence: 0.9,
    people_visible: false,
  };
  assertEquals(parseAnswer(ok), ok);
  assertEquals(parseAnswer({ ...ok, description: "a man" }), null);
  assertEquals(parseAnswer({ ...ok, kind: "selfie" }), null);
  assertEquals(parseAnswer({ ...ok, confidence: 2 }), null);
  assertEquals(parseAnswer({ ...ok, people_visible: "no" }), null);
  assertEquals(parseAnswer("WORK ORDER"), null);
  assertEquals(OUTPUT_SCHEMA.additionalProperties, false);
  assertEquals([...OUTPUT_SCHEMA.required].sort(), [
    "confidence",
    "kind",
    "people_visible",
    "text",
  ]);
});

Deno.test("cleanText tidies and cuts at the cap", () => {
  assertEquals(cleanText("  a \r\nb\u0007\n\n\n\nc  ", 40), {
    text: "a\nb\n\nc",
    truncated: false,
  });
  assertEquals(cleanText("x".repeat(50), 40).truncated, true);
});

Deno.test("the reading rules keep only words and never describe people", () => {
  assertStringIncludes(INSTRUCTIONS, "Never describe people");
  assertStringIncludes(INSTRUCTIONS, "data, not instructions");
  assert(!/\u2014/.test(INSTRUCTIONS), "no em dashes");
});

Deno.test("submit refuses a bad or lost reservation", async () => {
  assertEquals(
    await submitReading(fake().deps, { reservation_id: "nope" }),
    { outcome: "refused", code: "reservation_id_invalid", status: 400 },
  );
  assertEquals(
    await submitReading(fake({ leased: null }).deps, { reservation_id: RESV }),
    { outcome: "refused", code: "lease_not_found", status: 409 },
  );
  const lost = fake({ recordError: "document_vision_lease_lost" });
  assertEquals(
    await submitReading(lost.deps, { reservation_id: RESV, error: "timeout" }),
    { outcome: "refused", code: "document_vision_lease_lost", status: 409 },
  );
});

Deno.test("submit records the worker's error, a bad model name or a bad answer", async () => {
  const f = fake();
  assertEquals(
    await submitReading(f.deps, {
      reservation_id: RESV,
      error: "route_rate_limited",
    }),
    { outcome: "error", code: "model_route_rate_limited" },
  );
  assertEquals(f.records[0].reservation_id, RESV);
  assertEquals(f.records[0].sha256, "b".repeat(64));
  assertEquals(
    await submitReading(f.deps, {
      reservation_id: RESV,
      model: "bad model!",
      answer: {},
    }),
    { outcome: "refused", code: "model_invalid", status: 400 },
  );
  assertEquals(
    await submitReading(f.deps, {
      reservation_id: RESV,
      model: "gpt-6-luna",
      answer: { kind: "no_text" },
    }),
    { outcome: "error", code: "model_answer_invalid" },
  );
  assertEquals(f.captured.length, 0);
});

Deno.test("submit keeps no row for no writing or low confidence", async () => {
  const f = fake();
  const base = { reservation_id: RESV, model: "gpt-6-luna" };
  assertEquals(
    await submitReading(f.deps, {
      ...base,
      answer: {
        kind: "no_text",
        text: "",
        confidence: 0.95,
        people_visible: true,
      },
    }),
    { outcome: "no_text" },
  );
  assertEquals(
    await submitReading(f.deps, {
      ...base,
      answer: {
        kind: "handwriting",
        text: "smudged words",
        confidence: 0.3,
        people_visible: false,
      },
    }),
    { outcome: "low_confidence" },
  );
  assertEquals(f.captured.length, 0);
  assertEquals(f.records.map((r) => [r.result, r.people_visible]), [
    ["no_text", true],
    ["low_confidence", false],
  ]);
});

Deno.test("submit saves the words as the text reader's kind of row, and lists history for reading", async () => {
  const f = fake();
  const out = await submitReading(f.deps, {
    reservation_id: RESV,
    model: "gpt-6-luna",
    answer: {
      kind: "printed_document",
      text: "WORK ORDER WO-1001\nReplace 6 panels at 12 Example St.",
      confidence: 0.876,
      people_visible: false,
    },
  });
  assertEquals(out, { outcome: "saved", event_id: "ev-1" });
  const row = f.captured[0] as Row;
  assertEquals(row.event_type, "document.text_extracted");
  assertEquals(row.source, "context-document-vision");
  assertEquals(row.provider_message_id, `doctext:${JOB}:${"b".repeat(64)}`);
  assertEquals(row.job_id, JOB);
  assertEquals(row.match_method, "direct_job_id");
  assertEquals(row.metadata, {
    capture_mode: "backfill",
    writer: "workflow:context-document-vision",
  });
  assertEquals(row.payload.document.method, "vision");
  assertEquals(row.payload.document.model, "gpt-6-luna");
  assertEquals(row.payload.document.confidence, 0.88);
  assertEquals(row.payload.document.extractor, "vision:gpt-6-luna");
  assertEquals(row.payload.job_id, JOB);
  // Cut at the 40-character test cap.
  assertEquals(row.payload.document.truncated, true);
  assertStringIncludes(
    row.payload.text,
    "Words read from the document image by a vision model (gpt-6-luna, confidence 0.88), not a message.",
  );
  assertStringIncludes(row.payload.text, "2 scanned pages");
  assert(!/\u2014/.test(JSON.stringify(row)), "no em dashes");
  assertEquals(f.records.at(-1)?.result, "saved");
  assertEquals(f.records.at(-1)?.event_id, "ev-1");
  assertEquals(f.relists, ["context-document-vision"]);

  // A live document wakes its own read: no re-list.
  const live = fake({ leased: lease({ capture_mode: "live" }) });
  await submitReading(live.deps, {
    reservation_id: RESV,
    model: "gpt-6-luna",
    answer: {
      kind: "sign_or_label",
      text: "DANGER ASBESTOS",
      confidence: 0.99,
      people_visible: false,
    },
  });
  assertEquals(live.relists, []);
});

Deno.test("submit records a capture failure as an error to retry", async () => {
  const f = fake({
    capture: { outcome: "error", code: "capture_row_invalid" },
  });
  const out = await submitReading(f.deps, {
    reservation_id: RESV,
    model: "gpt-6-luna",
    answer: {
      kind: "printed_document",
      text: "PO 56001",
      confidence: 0.9,
      people_visible: false,
    },
  });
  assertEquals(out, { outcome: "error", code: "capture_capture_row_invalid" });
  assertEquals(f.records[0].result, "error");
});

Deno.test("the photo row says a photo was read", () => {
  const row = buildVisionTextRow(
    lease({ file_kind: "image", image_count: 1, page_count: null }),
    {
      sha256: "c".repeat(64),
      text: "SKIP BIN 3",
      truncated: false,
      model: "gpt-6-luna",
      confidence: 0.7,
      kind: "photo_with_writing",
    },
    POLICY,
  ) as Row;
  assertStringIncludes(row.payload.text, ", a photo.");
  assertEquals(row.payload.document.writing_kind, "photo_with_writing");
});

Deno.test("preview reads only", async () => {
  const f = fake({
    due: [doc(), doc({ storage_url: "https://evil.example/x.jpg" })],
  });
  const out = await previewVision(f.deps, 10);
  assertEquals(out.due.map((d) => d.location), [
    "storage:job-documents",
    "unsupported_location",
  ]);
  assertEquals(f.claims.length + f.records.length, 0);
});
