// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  buildSesCardEvidenceInventory,
  type MeasureCardInput,
  parseStageOption,
  renderMeasurement,
} from "../ses-measure-card-evidence.ts";

const NO_DOCS = {
  has_wo: false,
  has_report_doc: false,
  has_invoice_doc: false,
  has_swms_doc: false,
};

function card(overrides: Partial<MeasureCardInput> = {}): MeasureCardInput {
  return {
    job: {
      id: "11111111-1111-4111-8111-111111111111",
      job_number: "SWMS-260001",
      type: "makesafe",
      status: "in_progress",
      makesafe_job_family: "general_makesafe",
    },
    detail: { cycle_number: 1, external_links: [] },
    assignments: [],
    serviceReports: [],
    documents: [],
    docFlags: { ...NO_DOCS },
    media: [],
    invoices: [],
    packs: [],
    statusApplication: null,
    ...overrides,
  };
}

function photos(count: number): any[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `media-${index}`,
    type: "photo",
    phase: "completion",
    storage_url: `storage/photo-${index}.jpg`,
  }));
}

function itemOf(
  result: ReturnType<typeof buildSesCardEvidenceInventory>,
  item: string,
) {
  const row = result.reading?.items.find((entry) => entry.item === item);
  assert(row, `no reading for ${item}`);
  return row;
}

Deno.test("--stage accepts only the seven Ops stages", () => {
  assertEquals(parseStageOption(undefined), null);
  assertEquals(parseStageOption("report_ready"), "report_ready");
  assertEquals(parseStageOption("ARCHIVE"), "archive");
  assertThrows(() => parseStageOption("docs_ready"), Error, "--stage must be");
});

Deno.test("a fully evidenced physical card at trade_report_in is undetermined only on PO", () => {
  const result = buildSesCardEvidenceInventory(card({
    docFlags: { ...NO_DOCS, has_wo: true },
    documents: [{ type: "work_order", storage_url: "storage/wo.pdf" }],
    serviceReports: [{ job_id: "j", status: "submitted", cycle_number: 1 }],
    media: photos(6),
    assignments: [{ status: "accepted" }],
    stageOverride: "trade_report_in",
  }));
  assertEquals(result.family, "physical_makesafe");
  assertEquals(result.stage, "trade_report_in");
  assertEquals(result.stage_source, "explicit --stage");
  assertEquals(result.completion_photo_count, 6);
  assertEquals(itemOf(result, "builder_wo_doc").status, "present");
  assertEquals(itemOf(result, "trade_report").status, "present");
  assertEquals(itemOf(result, "photos_media").status, "present");
  assertEquals(itemOf(result, "prime_link").status, "not_required");
  assertEquals(result.reading?.missing, []);
  assertEquals(result.reading?.unresolved, ["po"]);
  assertEquals(result.reading?.verdict, "undetermined");
});

Deno.test("the five-photo floor is the physical photo evidence rule", () => {
  const result = buildSesCardEvidenceInventory(card({
    docFlags: { ...NO_DOCS, has_wo: true },
    serviceReports: [{ status: "approved", cycle_number: 1 }],
    media: photos(4),
    stageOverride: "trade_report_in",
  }));
  assertEquals(result.reading?.verdict, "fail");
  assertEquals(result.reading?.missing, ["photos_media"]);
});

Deno.test("a submitted report with zero photos reads as lost in transit", () => {
  const result = buildSesCardEvidenceInventory(card({
    docFlags: { ...NO_DOCS, has_wo: true },
    serviceReports: [{ status: "submitted", cycle_number: 1 }],
    media: [],
    stageOverride: "trade_report_in",
  }));
  const item = itemOf(result, "photos_media");
  assertEquals(item.status, "missing");
  assertEquals(item.signal, "lost_in_transit");
  assertEquals(result.reading?.lost_in_transit, ["photos_media"]);
});

Deno.test("a media row with no stored artifact reads as lost in transit", () => {
  const result = buildSesCardEvidenceInventory(card({
    docFlags: { ...NO_DOCS, has_wo: true },
    serviceReports: [{ status: "submitted", cycle_number: 1 }],
    media: [
      ...photos(2),
      { id: "m-x", type: "photo", phase: "completion", storage_url: "" },
    ],
    stageOverride: "trade_report_in",
  }));
  assertEquals(itemOf(result, "photos_media").signal, "lost_in_transit");
  assertStringIncludes(
    itemOf(result, "photos_media").detail || "",
    "without a stored artifact",
  );
});

Deno.test("a work-order row with no stored artifact is distinguished from none at all", () => {
  const lost = buildSesCardEvidenceInventory(card({
    documents: [{ type: "work_order", storage_url: "" }],
    stageOverride: "new",
  }));
  assertEquals(itemOf(lost, "builder_wo_doc").status, "missing");
  assertEquals(itemOf(lost, "builder_wo_doc").signal, "lost_in_transit");

  const absent = buildSesCardEvidenceInventory(card({ stageOverride: "new" }));
  assertEquals(itemOf(absent, "builder_wo_doc").status, "missing");
  assertEquals(itemOf(absent, "builder_wo_doc").signal, "none");
});

Deno.test("an ordinary roof card needs a typed link plus a done capture", () => {
  const base = card({
    job: {
      id: "22222222-2222-4222-8222-222222222222",
      job_number: "SWMS-260002",
      makesafe_job_family: "roof_report",
    },
    docFlags: { ...NO_DOCS, has_wo: true },
    stageOverride: "trade_report_in",
  });

  const linkOnly = buildSesCardEvidenceInventory({
    ...base,
    detail: {
      cycle_number: 1,
      external_links: [{ role: "roof_report", url: "https://prime.test/r/1" }],
    },
  });
  assertEquals(linkOnly.family, "ordinary_roof_portal");
  assertEquals(itemOf(linkOnly, "prime_link").status, "missing");
  assertEquals(itemOf(linkOnly, "trade_report").status, "not_required");
  assertEquals(itemOf(linkOnly, "photos_media").status, "not_required");

  const captured = buildSesCardEvidenceInventory({
    ...base,
    detail: {
      cycle_number: 1,
      external_links: [{
        role: "roof_report",
        url: "https://prime.test/r/1",
        status: "done",
      }],
    },
  });
  assertEquals(itemOf(captured, "prime_link").status, "present");
  assertEquals(captured.reading?.missing, []);
});

Deno.test("a GHL-only portal link is reported undetermined, not missing", () => {
  const result = buildSesCardEvidenceInventory(card({
    job: {
      id: "33333333-3333-4333-8333-333333333333",
      job_number: "SWMS-260003",
      makesafe_job_family: "roof_report",
    },
    detail: {
      cycle_number: 1,
      external_links: [{
        role: "roof_report",
        url: "https://link.msgsndr.com/widget/form/abc",
      }],
    },
    docFlags: { ...NO_DOCS, has_wo: true },
    stageOverride: "trade_report_in",
  }));
  const prime = itemOf(result, "prime_link");
  assertEquals(prime.status, "unresolved_question");
  assertEquals(prime.open_questions, ["ghl_equivalence"]);
  assertEquals(result.reading?.missing, []);
  assertEquals(result.reading?.verdict, "undetermined");
});

Deno.test("strata authority routes a roof card to the own-document family", () => {
  const result = buildSesCardEvidenceInventory(card({
    job: {
      id: "44444444-4444-4444-8444-444444444444",
      job_number: "SWMS-260004",
      makesafe_job_family: "roof_report",
      strata: "true",
    },
    docFlags: { ...NO_DOCS, has_wo: true },
    documents: [
      { type: "work_order", storage_url: "storage/wo.pdf" },
      { type: "roof_report", storage_url: "storage/roof.pdf" },
    ],
    stageOverride: "report_ready",
  }));
  assertEquals(result.family, "own_template_roof");
  // The SecureWorks roof PDF occupies the trade-report column for this family.
  assertEquals(itemOf(result, "trade_report").status, "present");
  assertEquals(itemOf(result, "prime_link").status, "unresolved_question");
  assertEquals(
    itemOf(result, "prime_link").open_questions,
    ["own_document_roof_report_in"],
  );
  assertEquals(result.reading?.missing, []);
});

Deno.test("assessment photo evidence is the typed Prime capture, not a local pack", () => {
  const result = buildSesCardEvidenceInventory(card({
    job: {
      id: "55555555-5555-4555-8555-555555555555",
      job_number: "SWMS-260005",
      makesafe_job_family: "assessment_report",
    },
    detail: {
      cycle_number: 1,
      external_links: [
        { role: "assessment", url: "https://prime.test/a", status: "done" },
        { role: "photos", url: "https://prime.test/p", status: "done" },
        { role: "scope", url: "https://prime.test/s", status: "done" },
      ],
    },
    docFlags: { ...NO_DOCS, has_wo: true },
    // Zero local photos: the family owes the typed schedule, not a photo pack.
    media: [],
    stageOverride: "trade_report_in",
  }));
  assertEquals(result.family, "assessment_quote");
  assertEquals(itemOf(result, "photos_media").status, "present");
  assertEquals(itemOf(result, "prime_link").status, "present");
  assertEquals(itemOf(result, "trade_report").status, "not_required");
  assertEquals(result.reading?.missing, []);
  // SWMS and PO are both open Captain questions for this family.
  assertEquals(result.reading?.unresolved, ["swms", "po"]);
});

Deno.test("a terminal stage needs an issued invoice, not a draft", () => {
  const draft = buildSesCardEvidenceInventory(card({
    invoices: [{ status: "DRAFT", invoice_type: "ACCREC" }],
    stageOverride: "completed",
  }));
  assertEquals(itemOf(draft, "invoice").status, "missing");
  assertEquals(draft.reading?.verdict, "fail");

  const authorised = buildSesCardEvidenceInventory(card({
    invoices: [{ status: "AUTHORISED", invoice_type: "ACCREC" }],
    stageOverride: "completed",
  }));
  assertEquals(itemOf(authorised, "invoice").status, "present");
  assertEquals(authorised.reading?.missing, []);
  assertEquals(authorised.reading?.verdict, "undetermined");
});

Deno.test("a non-terminal stage accepts a draft invoice as present", () => {
  const result = buildSesCardEvidenceInventory(card({
    docFlags: { ...NO_DOCS, has_wo: true },
    invoices: [{ status: "DRAFT", invoice_type: "ACCREC" }],
    stageOverride: "allocated",
  }));
  assertEquals(itemOf(result, "invoice").status, "present");
});

Deno.test("a voided invoice is not evidence", () => {
  const result = buildSesCardEvidenceInventory(card({
    invoices: [{ status: "VOIDED", invoice_type: "ACCREC" }],
    stageOverride: "completed",
  }));
  assertEquals(itemOf(result, "invoice").status, "missing");
});

Deno.test("a PO token is recovered from the persisted external ref", () => {
  const withPo = buildSesCardEvidenceInventory(card({
    detail: {
      cycle_number: 1,
      external_links: [],
      external_ref: "MLB-26344 PO 57087",
    },
    stageOverride: "new",
  }));
  assertEquals(withPo.inventory.po.present, true);
  // PO stays an unresolved Captain question regardless of the observed fact.
  assertEquals(itemOf(withPo, "po").status, "unresolved_question");
  assertEquals(itemOf(withPo, "po").observed_present, true);

  const withoutPo = buildSesCardEvidenceInventory(
    card({ stageOverride: "new" }),
  );
  assertEquals(withoutPo.inventory.po.present, false);
  assertEquals(itemOf(withoutPo, "po").status, "unresolved_question");
});

Deno.test("restoration authority outranks a stale family token", () => {
  const result = buildSesCardEvidenceInventory(card({
    job: {
      id: "66666666-6666-4666-8666-666666666666",
      job_number: "SWMS-260006",
      type: "insurance",
      makesafe_job_family: "general_makesafe",
      insurance_job_type: "restoration",
    },
    stageOverride: "allocated",
  }));
  assertEquals(result.family, "restoration");
  assertEquals(result.reading?.verdict, "undetermined");
  assertEquals(result.reading?.missing, []);
});

Deno.test("an unknown family is refused rather than measured against a guess", () => {
  const result = buildSesCardEvidenceInventory(card({
    job: {
      id: "77777777-7777-4777-8777-777777777777",
      job_number: "SWMS-260007",
    },
    detail: { cycle_number: 1, external_links: [] },
    stageOverride: "new",
  }));
  assertEquals(result.family, null);
  assertEquals(result.reading, null);
  assertStringIncludes(result.family_refusal || "", "refuses to measure");
  assertStringIncludes(renderMeasurement(result), "VERDICT: refused");
});

Deno.test("with no --stage the measured stage comes from the M1 engine", () => {
  const result = buildSesCardEvidenceInventory(card({
    docFlags: { ...NO_DOCS, has_wo: true },
    serviceReports: [{ status: "submitted", cycle_number: 1 }],
    media: photos(5),
    assignments: [{ status: "accepted" }],
  }));
  assertEquals(result.stage, "trade_report_in");
  assertEquals(result.computed_stage, "trade_report_in");
  assertEquals(result.display_overlay_stage, null);
  assertStringIncludes(result.stage_source, "M1 computed status");
});

Deno.test("an applied display overlay is reported and honoured", () => {
  const result = buildSesCardEvidenceInventory(card({
    statusApplication: { source_status: "new", after_status: "archive" },
  }));
  assertEquals(result.display_overlay_stage, "archive");
  assertEquals(result.stage, "archive");
  assertStringIncludes(result.stage_source, "display overlay");
});

Deno.test("the rendered report names the ruler, the verdict and no client data", () => {
  const result = buildSesCardEvidenceInventory(card({
    docFlags: { ...NO_DOCS, has_wo: true },
    serviceReports: [{ status: "submitted", cycle_number: 1 }],
    media: photos(5),
    stageOverride: "trade_report_in",
  }));
  const rendered = renderMeasurement(result);
  assertStringIncludes(rendered, "SWMS-260001");
  assertStringIncludes(rendered, "ses-evidence-requirements/c1-draft-v1");
  assertStringIncludes(rendered, "VERDICT: UNDETERMINED");
  assertStringIncludes(rendered, "Open Captain questions");
  assertStringIncludes(rendered, "no write, no backfill and no stage move");
  // The privacy guard the board checker uses rejects client-shaped output.
  for (
    const pattern of [
      /client_name/i,
      /site_address/i,
      /@[a-z0-9.-]+\.[a-z]{2,}/i,
    ]
  ) {
    assertEquals(pattern.test(rendered), false, String(pattern));
  }
});
