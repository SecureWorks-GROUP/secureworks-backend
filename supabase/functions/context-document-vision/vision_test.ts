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
import { type ClaimOutcome, type ClaimRequest, DESCRIBED_CODE, type LeasedDocument, LIMITS, previewVision, submitReading, type VisionDeps, type VisionPolicy, type VisionRecord } from "./vision.ts";

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
  policy?: VisionPolicy;
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
    policy: () => Promise.resolve(over.policy ?? POLICY),
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

// Owner's decision D6 (12 Oct 2026): a photo with no writing is described.
// The fixtures are shaped like SWF-261469's 9 Oct email: three photos of the
// finished fence sent by the customer, no writing in any of them, which the
// reader returned as "no writing" and so kept nothing of.
const SWF_261469_PHOTOS = [
  {
    source_id: "44444444-4444-4444-8444-444444444441",
    sha256: "d".repeat(64),
    file_name: "IMG_0001.jpeg",
    text:
      "A steel fence post set in the ground with an open gap in the soil beside its base.",
  },
  {
    source_id: "44444444-4444-4444-8444-444444444442",
    sha256: "e".repeat(64),
    file_name: "IMG_0002.jpeg",
    text:
      "Two fence panels meet at a join where the cut metal ends of the rails are exposed.",
  },
  {
    source_id: "44444444-4444-4444-8444-444444444443",
    sha256: "f".repeat(64),
    file_name: "IMG_0003.jpeg",
    text:
      "The ground along the base of a new fence is uneven, with loose soil and rubble.",
  },
];

const ROOMY: VisionPolicy = { ...POLICY, max_chars: 40_000 };

function emailedPhoto(
  photo: typeof SWF_261469_PHOTOS[number],
  over: Partial<LeasedDocument> = {},
): LeasedDocument {
  return lease({
    source_kind: "email_attachment",
    source_id: photo.source_id,
    file_kind: "image",
    sha256: photo.sha256,
    page_count: null,
    image_count: 1,
    doc_type: "email_attachment",
    file_name: photo.file_name,
    content_type: "image/jpeg",
    doc_at: "2026-10-09T09:11:00Z",
    capture_mode: "live",
    ...over,
  });
}

Deno.test("SWF-261469: three emailed photos with no writing are each kept as a description of the work shown", async () => {
  for (const photo of SWF_261469_PHOTOS) {
    const f = fake({ leased: emailedPhoto(photo), policy: ROOMY });
    const out = await submitReading(f.deps, {
      reservation_id: RESV,
      model: "gpt-6-luna",
      answer: {
        kind: "photo_of_work",
        text: photo.text,
        confidence: 0.82,
        people_visible: false,
      },
    });
    assertEquals(out, {
      outcome: "saved",
      event_id: "ev-1",
      code: "photo_described",
    });
    assertEquals(f.captured.length, 1);
    const row = f.captured[0] as Row;
    // The same kind of evidence row, key and job as written words: the job
    // reader's packet takes it by its event type and reads payload.text.
    assertEquals(row.event_type, "document.text_extracted");
    assertEquals(row.channel, "document");
    assertEquals(row.job_id, JOB);
    assertEquals(row.entity_type, "email_attachment");
    assertEquals(row.entity_id, photo.source_id);
    assertEquals(row.provider_message_id, `doctext:${JOB}:${photo.sha256}`);
    assertEquals(row.privacy_classification, "staff_only");
    assertEquals(row.body_preview, photo.text);
    // Headed as a description, so it is never taken for written words, for
    // the customer's own words, or for a finding checked on site.
    assertEquals(
      row.payload.text,
      `[Photo description: Email attachment "${photo.file_name}", a photo. The photo has no readable writing. What it shows, described by a vision model (gpt-6-luna, confidence 0.82). Not words written in the photo, not a message from anyone, and not a checked finding.]\n\n${photo.text}`,
    );
    assertStringIncludes(
      String(row.safe_summary),
      "described by a vision model",
    );
    assert(!String(row.safe_summary).includes(photo.text), "no words there");
    assertEquals(row.payload.document.writing_kind, "photo_of_work");
    assertEquals(row.payload.document.described, true);
    assertEquals(row.payload.document.method, "vision");
    assertEquals(row.payload.document.truncated, false);
    assert(!/\u2014/.test(JSON.stringify(row)), "no em dashes");
    // The read record: saved, under its own code, on the lease's reservation.
    assertEquals(f.records.length, 1);
    assertEquals(f.records[0].result, "saved");
    assertEquals(f.records[0].code, DESCRIBED_CODE);
    assertEquals(f.records[0].reservation_id, RESV);
    assertEquals(f.records[0].sha256, photo.sha256);
    assertEquals(f.records[0].char_count, photo.text.length);
    assertEquals(f.records[0].people_visible, false);
    // A live photo wakes its own read.
    assertEquals(f.relists, []);
  }
});

Deno.test("a description keeps the work and only flags that a person was in the photo", async () => {
  const photo = SWF_261469_PHOTOS[0];
  const f = fake({ leased: emailedPhoto(photo), policy: ROOMY });
  await submitReading(f.deps, {
    reservation_id: RESV,
    model: "gpt-6-luna",
    answer: {
      kind: "photo_of_work",
      text: photo.text,
      confidence: 0.9,
      people_visible: true,
    },
  });
  assertEquals(f.records[0].result, "saved");
  assertEquals(f.records[0].people_visible, true);
  // The flag is on the read record only; the evidence row has no field for a person.
  const row = f.captured[0] as Row;
  assert(!("people_visible" in row.payload.document));
  assert(!JSON.stringify(row).includes("people_visible"));
});

Deno.test("a description is kept short, needs the same confidence, and is only for a photo", async () => {
  const photo = SWF_261469_PHOTOS[1];
  const base = { reservation_id: RESV, model: "gpt-6-luna" };

  // Longer than the door keeps: cut, and the row says so.
  const long = fake({ leased: emailedPhoto(photo), policy: ROOMY });
  await submitReading(long.deps, {
    ...base,
    answer: {
      kind: "photo_of_work",
      text: "Fence panel. ".repeat(100),
      confidence: 0.9,
      people_visible: false,
    },
  });
  const row = long.captured[0] as Row;
  assertEquals(row.payload.document.char_count, LIMITS.maxDescriptionChars);
  assertEquals(row.payload.document.truncated, true);
  assertStringIncludes(row.payload.text, "cut at the character limit");
  assertEquals(long.records[0].truncated, true);

  // Below the policy's confidence: nothing kept, as for written words.
  const unsure = fake({ leased: emailedPhoto(photo), policy: ROOMY });
  assertEquals(
    await submitReading(unsure.deps, {
      ...base,
      answer: {
        kind: "photo_of_work",
        text: photo.text,
        confidence: 0.4,
        people_visible: false,
      },
    }),
    { outcome: "low_confidence" },
  );
  assertEquals(unsure.captured.length, 0);

  // An empty description is no description.
  const empty = fake({ leased: emailedPhoto(photo), policy: ROOMY });
  assertEquals(
    await submitReading(empty.deps, {
      ...base,
      answer: {
        kind: "photo_of_work",
        text: "  ",
        confidence: 0.9,
        people_visible: false,
      },
    }),
    { outcome: "no_text" },
  );
  assertEquals(empty.records[0].code, "no_writing");

  // A scanned PDF is never described: no row, at no further call.
  const scan = fake({ policy: ROOMY });
  assertEquals(
    await submitReading(scan.deps, {
      ...base,
      answer: {
        kind: "photo_of_work",
        text: photo.text,
        confidence: 0.9,
        people_visible: false,
      },
    }),
    { outcome: "no_text" },
  );
  assertEquals(scan.captured.length, 0);
  assertEquals(scan.records.map((r) => [r.result, r.code]), [
    ["no_text", "description_not_a_photo"],
  ]);
});

Deno.test("written words are still kept as words: the row and the record are unchanged", async () => {
  const photo = SWF_261469_PHOTOS[2];
  const f = fake({ leased: emailedPhoto(photo), policy: ROOMY });
  const out = await submitReading(f.deps, {
    reservation_id: RESV,
    model: "gpt-6-luna",
    answer: {
      kind: "photo_with_writing",
      text: "DELIVERY DOCKET 5 SHEETS",
      confidence: 0.9,
      people_visible: false,
    },
  });
  assertEquals(out, { outcome: "saved", event_id: "ev-1" });
  const row = f.captured[0] as Row;
  assertStringIncludes(
    row.payload.text,
    '[Document text: Email attachment "IMG_0003.jpeg", a photo. Words read from the document image by a vision model (gpt-6-luna, confidence 0.9), not a message.]',
  );
  assert(!("described" in row.payload.document));
  assert(!("code" in f.records[0]));
});
