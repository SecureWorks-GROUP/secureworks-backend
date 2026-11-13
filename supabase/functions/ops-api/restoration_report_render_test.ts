// deno-lint-ignore-file no-import-prefix no-explicit-any
// Restoration report: the renderer (restoration_report_render.ts), the shared
// gallery layout (report_design.ts) and the restoration_render_report action
// (restoration_report_store.ts). Privacy-safe fixtures only; no network.
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 --allow-read \
//        supabase/functions/ops-api/restoration_report_render_test.ts
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  layoutGalleryRows,
  REPORT_PAGE,
  reportText,
} from "./report_design.ts";
import {
  captionWithoutStage,
  renderRestorationReportPdf,
  type RestorationReportInput,
  restorationPhotoStage,
  restorationReportFacts,
  restorationReportFileName,
  restorationReportWordingProblems,
} from "./restoration_report_render.ts";
import {
  renderRestorationReportAction,
  restorationReportPhotoChoices,
} from "./restoration_report_store.ts";
import { RestorationWorkflowError } from "./restoration_workflow.ts";

const ONE_PIXEL_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  ),
  (c) => c.charCodeAt(0),
);

function countPdfPages(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(bytes);
  return (text.match(/\/Type\s*\/Page\b/g) || []).length;
}

function pdfText(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

const BASE: RestorationReportInput = {
  job_number: "SWRESTO-269999",
  builder_name: "Example Builders",
  builder_reference: "MLR-40001",
  builder_purchase_order: "PO-60001",
  site_address: "1 Example Way, Lynwood WA 6147",
  policyholder: "Jordan Example",
  attended_on: "Friday 13 November 2026",
  arrived_at: "7:00am",
  crew_line: "Two SecureWorks technicians, 3.5 hours each",
  outcome: "Cabinetry removed and kept on site. The wall is clear.",
  subtitle: "Cabinetry removal from the wet wall",
  work_order_instruction: "Remove the cabinetry against the wet wall.",
  approved_quote_note: "Quote SWMS-269999-Q1, approved on 11 November 2026.",
  findings: {
    paragraphs: ["The room had a built-in wall unit fixed to the wet wall."],
    bullets: ["A wall-mounted rail framework.", "Steel wall brackets."],
    closing: ["The wall could not be reached until the unit came off."],
  },
  works_completed: {
    paragraphs: ["Two technicians took the unit apart in order."],
    bullets: ["Removed the shelving.", "Lifted out each panel.", "Stacked every part."],
    closing: ["Nothing was taken away."],
  },
  materials: "No materials were used.",
};

function photos(count: number) {
  return Array.from({ length: count }, (_unused, i) => ({
    bytes: ONE_PIXEL_PNG,
    mime: "image/png",
    caption: i === 1
      ? "Before: unit fixed to the wall"
      : i === count - 1
      ? "After: wall clear"
      : `Site photo ${i + 1}`,
    area: "Activity room",
    cover: i === 0,
  }));
}

Deno.test("file name: stable per job and builder reference, and its own name", () => {
  assertEquals(
    restorationReportFileName("SWRESTO-269999", "MLR-40001"),
    "Restoration Report - SWRESTO-269999 - MLR-40001.pdf",
  );
  assertEquals(
    restorationReportFileName("SWRESTO-269999", null),
    "Restoration Report - SWRESTO-269999.pdf",
  );
});

Deno.test("facts: builder work order and purchase order share one fact, one per line", () => {
  const facts = restorationReportFacts(BASE);
  assertEquals(facts.map((f) => f.label), [
    "Our reference",
    "Builder",
    "Builder reference",
    "Policyholder",
  ]);
  assertEquals(facts[2].value, "MLR-40001\nPO-60001");
  assertEquals(
    restorationReportFacts({ ...BASE, builder_name: null, policyholder: null })
      .map((f) => f.label),
    ["Our reference", "Builder reference"],
  );
});

Deno.test("photo stage: given, or read from how the caption starts", () => {
  assertEquals(restorationPhotoStage({ caption: "Before: wall unit" }), "before");
  assertEquals(restorationPhotoStage({ caption: "after the works" }), "after");
  assertEquals(restorationPhotoStage({ caption: "Wall clear after removal" }), null);
  assertEquals(
    restorationPhotoStage({ caption: "Wall clear", stage: "after" }),
    "after",
  );
  assertEquals(captionWithoutStage("Before: wall unit"), "Wall unit");
  assertEquals(captionWithoutStage("Wall clear after removal"), "Wall clear after removal");
});

Deno.test("wording: money and our internal words are refused by field", async () => {
  assertEquals(restorationReportWordingProblems(BASE), []);
  assertEquals(
    restorationReportWordingProblems({
      ...BASE,
      outcome: "Done for $950 inc GST",
      materials: "See the docket for details.",
    }),
    ["outcome", "materials"],
  );
  await assertRejects(
    () => renderRestorationReportPdf({ ...BASE, crew_line: "Two trades, invoice to follow" }),
    Error,
    "crew_line",
  );
});

Deno.test("render: no photos gives a short report that says so", async () => {
  const rendered = await renderRestorationReportPdf({ ...BASE, photos: [] });
  assertEquals(new TextDecoder().decode(rendered.bytes.slice(0, 5)), "%PDF-");
  assertEquals(rendered.pages, countPdfPages(rendered.bytes));
  assert(rendered.pages >= 1 && rendered.pages <= 2, `pages ${rendered.pages}`);
  assertEquals(rendered.photos_embedded, 0);
  const text = pdfText(rendered.bytes);
  for (
    const expected of [
      "What we found",
      "Works completed",
      "Materials",
      "Photo record",
      "No photos were supplied with this report.",
      "Cabinetry removal from the wet wall",
      "SWRESTO-269999",
      "MLR-40001",
      "PO-60001",
      "Jordan Example",
      "Stacked every part.",
      "Page 1 of",
    ]
  ) {
    assertStringIncludes(text, expected);
  }
});

Deno.test("render: ten photos, with a cover and a before and after pair", async () => {
  const rendered = await renderRestorationReportPdf({ ...BASE, photos: photos(10) });
  assertEquals(rendered.photos_embedded, 10);
  assert(rendered.pages >= 2 && rendered.pages <= 6, `pages ${rendered.pages}`);
  const text = pdfText(rendered.bytes);
  assertStringIncludes(text, "Before and after");
  assertStringIncludes(text, "9 photos, plus the cover photo");
  // The stage is a tag on the photo, so the caption does not repeat it.
  assertStringIncludes(text, "Unit fixed to the wall");
  assert(!text.includes("Before: unit fixed"));
  // One image is stored once however often it is drawn (cover, pair, gallery).
  // A PNG is an image plus its mask, so: (ten photos + the logo) x 2.
  const images = (text.match(/\/Subtype \/Image/g) || []).length;
  assert(images <= (10 + 1) * 2, `image objects ${images}`);
});

Deno.test("render: thirty photos and very long text page cleanly", async () => {
  const long = Array.from(
    { length: 40 },
    (_unused, i) =>
      `Paragraph ${i + 1}. The wall system was fixed into the wall along its whole length, and each part had to be released in turn before the next could be lowered without marking the wall or the floor.`,
  );
  const rendered = await renderRestorationReportPdf({
    ...BASE,
    subtitle:
      "Cabinetry, shelving and wall unit removal from the wet wall in the activity room and the adjoining hallway",
    findings: { paragraphs: long, bullets: long.slice(0, 12) },
    works_completed: { bullets: long.slice(0, 14), closing: long.slice(0, 3) },
    photos: photos(30),
  });
  assertEquals(rendered.photos_embedded, 30);
  assert(rendered.pages >= 5 && rendered.pages <= 16, `pages ${rendered.pages}`);
  const text = pdfText(rendered.bytes);
  assertStringIncludes(text, `Page ${rendered.pages} of ${rendered.pages}`);
  assertStringIncludes(text, "Paragraph 40.");
});

Deno.test("text: long dashes and curly quotes never reach a builder-facing page", () => {
  assertEquals(
    reportText("wall \u2014 clear \u2013 done, it\u2019s \u201Cdry\u201D\r\nnext"),
    "wall - clear - done, it's \"dry\"\nnext",
  );
  assertEquals(reportText(null), "");
});

Deno.test("render: the same input gives the same bytes", async () => {
  const normalise = (pdf: Uint8Array) =>
    pdfText(pdf).replace(/\/ID \[ <[0-9A-F]+> <[0-9A-F]+> \]/, "/ID [ <ID> <ID> ]");
  const first = await renderRestorationReportPdf({ ...BASE, photos: photos(3) });
  const second = await renderRestorationReportPdf({ ...BASE, photos: photos(3) });
  assertEquals(normalise(first.bytes), normalise(second.bytes));
});

Deno.test("render: job number and site address are required", async () => {
  await assertRejects(
    () => renderRestorationReportPdf({ ...BASE, job_number: "" }),
    Error,
    "job number required",
  );
  await assertRejects(
    () => renderRestorationReportPdf({ ...BASE, site_address: " " }),
    Error,
    "site address required",
  );
});

Deno.test("gallery layout: every photo placed once, in order, inside the width", () => {
  const width = REPORT_PAGE.CONTENT_W;
  const shapes = [
    [2.23, 0.75, 0.75, 0.75, 1.33, 0.75, 0.75, 0.75, 0.75, 0.75],
    [1.5],
    [0.75],
    Array.from({ length: 30 }, (_unused, i) => (i % 3 === 0 ? 1.5 : 0.75)),
    [3.5, 3.5, 0.4, 0.4, 0.4],
  ];
  for (const aspects of shapes) {
    const rows = layoutGalleryRows(aspects, width, 72, 4);
    assertEquals(rows.flat().map((cell) => cell.index), aspects.map((_a, i) => i));
    for (const row of rows) {
      const total = row.reduce((sum, cell) => sum + cell.w, 0) + 4 * (row.length - 1);
      assert(total <= width + 0.01, `row is ${total} wide`);
      // One height per row, and each photo keeps its own shape.
      for (const cell of row) {
        assertEquals(Math.round(cell.h * 100), Math.round(row[0].h * 100));
        assert(Math.abs(cell.w / cell.h - aspects[cell.index]) < 1e-6);
        assert(cell.h <= 72 * 1.9 + 0.01, `photo is ${cell.h} tall`);
      }
    }
  }
  assertEquals(layoutGalleryRows([], width, 72, 4), []);
});

// ── The action ──────────────────────────────────────────────────────────────

const ORG = "00000000-0000-0000-0000-000000000001";
const RESTORATION_JOB = "11111111-1111-4111-8111-111111111111";
const MAKESAFE_JOB = "22222222-2222-4222-8222-222222222222";
const PHOTO_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHOTO_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PHOTO_RECEIPT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PHOTO_SCOPING = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const STAFF = { label: "office@example.invalid", userId: null, orgId: ORG };

function store(): Record<string, any[]> {
  return {
    jobs: [
      {
        id: RESTORATION_JOB,
        org_id: ORG,
        job_number: "SWRESTO-269999",
        type: "makesafe",
        status: "accepted",
        client_name: "Jordan Example",
        site_address: "1 Example Way",
        site_suburb: "Lynwood",
        notes: "",
        metadata: {
          makesafe_job_family: "restoration",
          builder_po_number: "PO-60001",
        },
      },
      {
        id: MAKESAFE_JOB,
        org_id: ORG,
        job_number: "SWMS-261000",
        type: "makesafe",
        status: "accepted",
        site_address: "2 Example Way",
        metadata: { makesafe_job_family: "general_makesafe" },
      },
    ],
    makesafe_job_details: [
      {
        job_id: RESTORATION_JOB,
        external_ref: "MLR-40001",
        requesting_company_name: "mlb",
        requesting_company_slug: "mlb",
        requesting_company_id: "company-1",
      },
    ],
    makesafe_companies: [{ id: "company-1", name: "Example Builders" }],
    makesafe_docket_revisions: [],
    job_documents: [],
    job_media: [
      { id: PHOTO_B, job_id: RESTORATION_JOB, storage_url: "https://storage.example.invalid/b.jpg", label: "After: wall clear", type: "photo", phase: "completion", created_at: "2026-11-13T02:00:00Z" },
      { id: PHOTO_A, job_id: RESTORATION_JOB, storage_url: "https://storage.example.invalid/a.jpg", label: "Before: unit on the wall", type: "photo", phase: "completion", created_at: "2026-11-13T01:00:00Z" },
      { id: PHOTO_RECEIPT, job_id: RESTORATION_JOB, storage_url: "https://storage.example.invalid/r.jpg", label: "Receipt", type: "photo", phase: "receipt", created_at: "2026-11-13T03:00:00Z" },
      { id: PHOTO_SCOPING, job_id: RESTORATION_JOB, storage_url: "https://storage.example.invalid/s.jpg", label: "Scoping", type: "photo", phase: "quote_builder", created_at: "2026-11-13T04:00:00Z" },
    ],
  };
}

function fakeClient(data: Record<string, any[]>) {
  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let orderKey: string | null = null;
    let limitN: number | null = null;
    const run = () => {
      let rows = (data[table] || []).filter((r) => preds.every((p) => p(r)));
      if (orderKey) {
        const key = orderKey;
        rows = [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    };
    const builder: any = {
      select: () => builder,
      eq(key: string, value: any) {
        preds.push((r) => r[key] === value);
        return builder;
      },
      is(key: string, value: any) {
        preds.push((r) => (r[key] ?? null) === value);
        return builder;
      },
      order(key: string) {
        orderKey = key;
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
      then: (resolve: (value: any) => any) =>
        Promise.resolve({ data: run(), error: null }).then(resolve),
    };
    return builder;
  }
  return { from };
}

function actionDeps(log: { fetched: string[]; persisted: any[]; attached: any[] }, unreadable: string[] = []) {
  return {
    fetchPhoto: (media: { id: string; storage_url: string }) => {
      log.fetched.push(media.id);
      return Promise.resolve(
        unreadable.includes(media.id)
          ? null
          : { bytes: ONE_PIXEL_PNG, mime: "image/png" },
      );
    },
    persistPdf: (args: { jobId: string; fileName: string; bytes: Uint8Array }) => {
      log.persisted.push({ jobId: args.jobId, fileName: args.fileName, bytes: args.bytes.byteLength });
      return Promise.resolve({
        publicUrl: `https://storage.example.invalid/${args.jobId}/report.pdf`,
        storagePath: `${args.jobId}/report.pdf`,
      });
    },
    attachDocument: (body: Record<string, unknown>) => {
      log.attached.push(body);
      return Promise.resolve({ document_id: "doc-1", url: String(body.url) });
    },
  };
}

const REPORT = {
  subtitle: "Cabinetry removal from the wet wall",
  attended_on: "Friday 13 November 2026",
  arrived_at: "7:00am",
  crew_line: "Two SecureWorks technicians",
  work_order_instruction: "Remove the cabinetry against the wet wall.",
  findings: { paragraphs: ["A wall unit was fixed to the wet wall."] },
  works_completed: { bullets: ["Removed the unit.", "Stacked every part."] },
  materials: "No materials were used.",
};

Deno.test("action: dry run is the default, fills the job facts and writes nothing", async () => {
  const log = { fetched: [] as string[], persisted: [] as any[], attached: [] as any[] };
  const result: any = await renderRestorationReportAction(
    fakeClient(store()),
    { job_number: "swresto-269999", report: REPORT },
    STAFF,
    actionDeps(log),
  );
  assertEquals(result.dry_run, true);
  assertEquals(result.file_name, "Restoration Report - SWRESTO-269999 - MLR-40001.pdf");
  assertEquals(result.facts, {
    builder_name: "Example Builders",
    builder_reference: "MLR-40001",
    builder_purchase_order: "PO-60001",
    site_address: "1 Example Way, Lynwood",
    policyholder: "Jordan Example",
  });
  // Site photos only, in upload order: no receipt, no scoping photo.
  assertEquals(log.fetched, [PHOTO_A, PHOTO_B]);
  assertEquals(result.photos, 2);
  assert(result.pages >= 1);
  assertEquals(atob(result.pdf_base64).slice(0, 5), "%PDF-");
  assertEquals(atob(result.pdf_base64).length, result.bytes);
  assertEquals(log.persisted, []);
  assertEquals(log.attached, []);
});

Deno.test("action: a live call files the PDF as the job's make-safe report document", async () => {
  const log = { fetched: [] as string[], persisted: [] as any[], attached: [] as any[] };
  const result: any = await renderRestorationReportAction(
    fakeClient(store()),
    {
      job_id: RESTORATION_JOB,
      report: REPORT,
      dry_run: false,
      photos: [
        { media_id: PHOTO_B, caption: "Wall clear", stage: "after" },
        { media_id: PHOTO_A, cover: true },
      ],
    },
    STAFF,
    actionDeps(log),
  );
  assertEquals(result.dry_run, false);
  assertEquals(result.document_id, "doc-1");
  assert(String(result.url).startsWith("https://"));
  assertEquals(result.pdf_base64, undefined);
  // The caller's order, not upload order.
  assertEquals(log.fetched, [PHOTO_B, PHOTO_A]);
  assertEquals(log.persisted.length, 1);
  assertEquals(log.attached.length, 1);
  assertEquals(log.attached[0].type, "makesafe_report");
  assertEquals(log.attached[0].job_id, RESTORATION_JOB);
  assertEquals(log.attached[0].file_name, "Restoration Report - SWRESTO-269999 - MLR-40001.pdf");
  assertEquals(log.attached[0].pdf_base64, undefined);
});

Deno.test("action: refusals name the reason and change nothing", async () => {
  const cases: Array<[any, string, number, string[]?]> = [
    [{ job_id: MAKESAFE_JOB, report: REPORT, dry_run: false }, "not_a_restoration_job", 409],
    [{ job_number: "SWRESTO-000000", report: REPORT }, "job_not_found", 404],
    [{ job_id: RESTORATION_JOB }, "report_required", 400],
    [{ job_id: RESTORATION_JOB, report: { findings: "Found." } }, "report_sections_required", 400],
    [{ job_id: RESTORATION_JOB, report: REPORT, photo_media_ids: [PHOTO_RECEIPT] }, "photo_not_on_job", 409],
    [{ job_id: RESTORATION_JOB, report: REPORT, photo_media_ids: ["not-an-id"] }, "photo_id_invalid", 400],
    [{ job_id: RESTORATION_JOB, report: { ...REPORT, materials: "Materials at $40 ex GST." }, dry_run: false }, "report_wording_not_allowed", 400],
    [{ job_id: RESTORATION_JOB, report: REPORT, dry_run: false }, "photo_unreadable", 503, [PHOTO_B]],
  ];
  for (const [body, code, status, unreadable] of cases) {
    const log = { fetched: [] as string[], persisted: [] as any[], attached: [] as any[] };
    const error = await assertRejects(
      () =>
        renderRestorationReportAction(
          fakeClient(store()),
          body,
          STAFF,
          actionDeps(log, unreadable || []),
        ),
      RestorationWorkflowError,
    );
    assertEquals(error.code, code, code);
    assertEquals(error.status, status, code);
    assertEquals(log.persisted, [], code);
    assertEquals(log.attached, [], code);
  }
});

Deno.test("action: photo choices come from photos, or from bare ids with a cover", () => {
  assertEquals(restorationReportPhotoChoices({}), null);
  assertEquals(
    restorationReportPhotoChoices({
      photo_media_ids: [PHOTO_A, PHOTO_B],
      cover_photo_media_id: PHOTO_B,
    }),
    [{ media_id: PHOTO_A, cover: false }, { media_id: PHOTO_B, cover: true }],
  );
  assertEquals(
    restorationReportPhotoChoices({
      photos: [{ media_id: PHOTO_A, caption: " Front ", stage: "AFTER", area: "Street" }],
    }),
    [{ media_id: PHOTO_A, caption: "Front", area: "Street", stage: "after", cover: false }],
  );
});
