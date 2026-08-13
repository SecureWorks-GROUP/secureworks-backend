// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _deriveMakesafeBoardStage,
  _deriveMakesafeSurfacing,
  _enrichMakesafeBoardJobForTest,
} from "./index.ts";
import {
  buildCanonicalMakesafeRows,
  projectOpsMakesafeBoard,
  projectTradeMakesafeBoard,
} from "./makesafe_board_read_model.ts";
import { docsReady } from "./makesafe_computed_status.ts";
import { projectCycleScopedEvidence } from "./makesafe_cycle_evidence.ts";
import {
  makesafeHasQualifyingCurrentDraftInvoice,
  qualifyMakesafeCurrentDraftInvoice,
  selectCurrentMakesafeReceivableInvoice,
} from "./makesafe_docs_ready_invoice.ts";
import { deriveSesStageV2 } from "./ses_stage_engine_v2.ts";

const SNAPSHOT_NOW = "2026-08-03T08:02:19.172Z";

const linkedInvoice = (status: string) => ({
  id: "invoice-current",
  xero_invoice_id: "xero-current",
  job_id: "job-current",
  invoice_type: "ACCREC",
  status,
  reference: "MLB-99999",
  invoice_date: "2026-08-03",
  created_at: "2026-08-03T01:00:00Z",
});

Deno.test("current DRAFT qualifier rejects every wrong lifecycle/link/type/reference shape", () => {
  const job = {
    id: "job-current",
    job_number: "SWMS-TEST-1",
    metadata: {},
  };
  const detail = { external_ref: "MLB-99999" };
  const valid = linkedInvoice("DRAFT");

  assertEquals(
    qualifyMakesafeCurrentDraftInvoice(job, detail, valid),
    { qualifies: true, reason: "qualifying_draft" },
  );
  assertEquals(
    makesafeHasQualifyingCurrentDraftInvoice(job, detail, {
      ...valid,
      reference: "MLB-99999PO-54321",
    }),
    true,
  );

  for (
    const status of [
      "AUTHORISED",
      "SUBMITTED",
      "PAID",
      "VOIDED",
      "DELETED",
    ]
  ) {
    assertEquals(
      qualifyMakesafeCurrentDraftInvoice(job, detail, {
        ...valid,
        status,
      }).reason,
      "wrong_status",
      status,
    );
  }

  const negatives: Array<[string, any, string]> = [
    ["missing", null, "missing_invoice"],
    ["payable", { ...valid, invoice_type: "ACCPAY" }, "wrong_type"],
    ["unlinked", { ...valid, job_id: null }, "wrong_job"],
    ["sibling", { ...valid, job_id: "job-sibling" }, "wrong_job"],
    ["unrelated", { ...valid, job_id: "job-unrelated" }, "wrong_job"],
    ["missing-reference", { ...valid, reference: null }, "missing_reference"],
    [
      "wrong-reference",
      { ...valid, reference: "MLB-88888" },
      "wrong_reference",
    ],
    [
      "numeric-sibling-reference",
      { ...valid, reference: "MLB-999990" },
      "wrong_reference",
    ],
  ];
  for (const [name, invoice, reason] of negatives) {
    assertEquals(
      qualifyMakesafeCurrentDraftInvoice(job, detail, invoice),
      { qualifies: false, reason },
      name,
    );
  }
});

Deno.test("current candidate selection never lets an older DRAFT outrank a newer lifecycle row", () => {
  const olderDraft = {
    ...linkedInvoice("DRAFT"),
    id: "invoice-a",
    invoice_date: "2026-08-01",
  };
  for (
    const status of ["AUTHORISED", "SUBMITTED", "PAID", "VOIDED", "DELETED"]
  ) {
    const selected = selectCurrentMakesafeReceivableInvoice([
      olderDraft,
      {
        ...linkedInvoice(status),
        id: "invoice-b",
        invoice_date: "2026-08-02",
      },
    ]);
    assertEquals(selected?.status, status, status);
    assertEquals(
      makesafeHasQualifyingCurrentDraftInvoice(
        { id: "job-current", job_number: "SWMS-TEST-1" },
        { external_ref: "MLB-99999" },
        selected,
      ),
      false,
      status,
    );
  }

  const sameInvoiceDate = selectCurrentMakesafeReceivableInvoice([
    olderDraft,
    {
      ...olderDraft,
      id: "invoice-newer",
      status: "DELETED",
      created_at: "2026-08-03T02:00:00Z",
    },
  ]);
  assertEquals(sameInvoiceDate?.status, "DELETED");
});

Deno.test("current-cycle gate rejects a prior draft and accepts a post-reattend draft", () => {
  const job = {
    id: "job-current",
    job_number: "SWMS-TEST-1",
    metadata: {},
  };
  const detail = {
    external_ref: "MLB-99999",
    reattend_count: 1,
    last_reattend_at: "2026-08-03T02:00:00Z",
  };
  const priorRow = _enrichMakesafeBoardJobForTest(
    job,
    detail,
    [],
    null,
    linkedInvoice("DRAFT"),
    [],
    false,
    null,
  );

  assertEquals(priorRow.invoice_qualifies_as_current_draft, false);
  assertEquals(
    priorRow.invoice_draft_qualification_reason,
    "prior_cycle_commercial",
  );

  const currentRow = _enrichMakesafeBoardJobForTest(
    job,
    detail,
    [],
    null,
    {
      ...linkedInvoice("DRAFT"),
      created_at: "2026-08-03T03:00:00Z",
    },
    [],
    false,
    null,
  );

  assertEquals(currentRow.invoice_qualifies_as_current_draft, true);
  assertEquals(
    currentRow.invoice_draft_qualification_reason,
    "qualifying_draft",
  );
});

Deno.test("a qualifying DRAFT satisfies only the invoice prerequisite", () => {
  const job = {
    id: "job-current",
    job_number: "SWMS-TEST-1",
    status: "scheduled",
  };
  const detail = {
    external_ref: "MLB-99999",
    substatus: "waiting_on_trade_report",
  };
  assertEquals(
    makesafeHasQualifyingCurrentDraftInvoice(
      job,
      detail,
      linkedInvoice("DRAFT"),
    ),
    true,
  );
  assertEquals(
    _deriveMakesafeBoardStage(
      job,
      detail,
      [{ id: "assignment-1" }],
      undefined,
      linkedInvoice("DRAFT"),
      SNAPSHOT_NOW,
      {
        has_invoice_doc: false,
        has_report_doc: false,
        has_swms_doc: false,
      },
    ),
    "allocated",
  );
});

Deno.test("old-behaviour regression: raw ready_to_invoice without DRAFT derives Allocated", () => {
  assertEquals(
    _deriveMakesafeBoardStage(
      { id: "job-current", job_number: "SWMS-TEST-1", status: "accepted" },
      { substatus: "ready_to_invoice", external_ref: "MLB-99999" },
      [],
      undefined,
      undefined,
      SNAPSHOT_NOW,
      {
        has_invoice_doc: false,
        has_report_doc: false,
        has_swms_doc: false,
      },
    ),
    "allocated",
  );
});

Deno.test("old-behaviour regression: U4 readiness cannot bypass the current DRAFT prerequisite", () => {
  const surf = _deriveMakesafeSurfacing(
    { id: "job-current", job_number: "SWMS-TEST-1", status: "processing" },
    {
      substatus: "admin_to_send_report",
      external_ref: "MLB-99999",
      report_received_at: "2026-08-03T01:00:00Z",
    },
    { status: "submitted" },
    null,
    undefined,
    false,
    {
      status: "drafted",
      docket_revision_id: "revision-u4",
      pre_xero_docs_ready: true,
    },
  );
  assertEquals(surf.readyForReview, false);
  assertEquals(surf.tradeReportIn, true);
});

Deno.test("old-behaviour regression: shadow Docs Ready positives require the same DRAFT fact", () => {
  const readyPackWithoutDraft = {
    job: {
      status: "in_progress",
      metadata: { makesafe_job_family: "physical_makesafe" },
    },
    detail: { cycle_number: 1 },
    evidence: {
      packState: "READY",
      invoiceQualifiesAsCurrentDraft: false,
      serviceReports: [{ id: "report-1", status: "submitted" }],
      completionPhotoCount: 6,
    },
  } as any;
  assertEquals(docsReady(readyPackWithoutDraft), false);

  const roof = {
    job: {
      status: "in_progress",
      metadata: { makesafe_job_family: "roof_report" },
    },
    detail: {
      cycle_number: 1,
      external_links: [{
        role: "roof_report",
        url: "https://portal.primeeco.tech/s/example",
      }],
    },
    evidence: {
      packState: "READY",
      invoiceQualifiesAsCurrentDraft: false,
      assignments: [{ id: "assignment-1" }],
      portalCaptures: [{
        status: "done",
        role: "roof_report",
        url: "https://portal.primeeco.tech/s/example",
        locked: true,
        screenshot: "private/test-capture.png",
        cycle_number: 1,
      }],
    },
    ses_family: "ordinary_roof_portal",
    nowIso: SNAPSHOT_NOW,
  } as any;
  assertEquals(deriveSesStageV2(roof).stage, "trade_report_in");
});

Deno.test("named-branch preservation: every pre-existing physical Docs Ready condition remains independent", () => {
  const complete = {
    job: {
      status: "in_progress",
      metadata: { makesafe_job_family: "physical_makesafe" },
    },
    detail: { cycle_number: 1 },
    evidence: {
      packState: "READY",
      invoiceStatus: "DRAFT",
      invoiceQualifiesAsCurrentDraft: true,
      packSent: false,
      pack: {
        status: "drafted",
        report_doc_id: "report-doc",
        invoice_doc_id: "invoice-doc",
        swms_doc_id: "swms-doc",
      },
      documents: { report: true, invoice: true, swms: true },
      swmsRequired: true,
      serviceReports: [{ id: "report-1", status: "submitted" }],
      completionPhotoCount: 6,
    },
    ses_family: "physical_makesafe",
    nowIso: SNAPSHOT_NOW,
  } as any;
  assertEquals(deriveSesStageV2(complete).stage, "report_ready");

  const submittedReportWithoutBoundDocument = structuredClone(complete);
  submittedReportWithoutBoundDocument.evidence.packState = null;
  submittedReportWithoutBoundDocument.evidence.pack.report_doc_id = null;
  submittedReportWithoutBoundDocument.evidence.documents.report = false;
  assertEquals(docsReady(submittedReportWithoutBoundDocument), true);
  assertEquals(
    deriveSesStageV2(submittedReportWithoutBoundDocument).stage,
    "report_ready",
  );

  const mutations: Array<[string, (input: any) => void]> = [
    ["qualifying current DRAFT", (input) => {
      input.evidence.invoiceQualifiesAsCurrentDraft = false;
    }],
    ["READY pack state", (input) => input.evidence.packState = "U4_BLOCKED"],
    ["unsent pack", (input) => input.evidence.pack.status = "sent"],
    ["submitted report", (input) => {
      input.evidence.pack.report_doc_id = null;
      input.evidence.documents.report = false;
      input.evidence.serviceReports = [];
    }],
    ["required SWMS", (input) => {
      input.evidence.pack.swms_doc_id = null;
      input.evidence.documents.swms = false;
    }],
  ];
  for (const [name, mutate] of mutations) {
    const input = structuredClone(complete);
    mutate(input);
    assertNotEquals(deriveSesStageV2(input).stage, "report_ready", name);
  }
});

/**
 * The invoice-gated card, as the R12 evidence engine sees it.
 *
 * A `ready_to_invoice` substatus is a CLAIM about money that the card's own
 * evidence has to back. `invoice_qualifies_as_current_draft: false` is what
 * makes it unbacked, and it is the fact the gate turns on.
 */
function invoiceGatedCard(over: Record<string, any> = {}) {
  return {
    id: "job-current",
    job_number: "SWMS-TEST-1",
    type: "makesafe",
    status: "accepted",
    board_stage: "allocated",
    board_label: "Allocated",
    board_stage_engine_version: "test",
    substatus: "ready_to_invoice",
    // R12: the engine reads the card's family to pick an evidence recipe, so a
    // fixture has to declare one. Physical make-safe is the standard path.
    metadata: { makesafe_job_family: "general_makesafe" },
    makesafe_details: {
      substatus: "ready_to_invoice",
      external_ref: "MLB-99999",
      cycle_number: 1,
    },
    external_ref: "MLB-99999",
    assignments: [],
    invoice_qualifies_as_current_draft: false,
    ...over,
  };
}

/** A captain decision trying to promote the card into Docs Ready. */
const PROMOTE_TO_REPORT_READY = {
  run_key: "test-display-override",
  job_id: "job-current",
  source_status: "allocated",
  before_status: "allocated",
  after_status: "report_ready",
  evidence_ref: "test://invoice-gate",
  applied_by: "test",
  applied_at: SNAPSHOT_NOW,
};

Deno.test("canonical overlay and Ops/Trade projections cannot re-promote an invoice-gated card", () => {
  // R12 cutover: the fixture used to reach `allocated` by declaring
  // `board_stage`, with no allocation evidence on the card at all. Placement
  // now follows the evidence, so it carries a real assignment — and that makes
  // the gate a SHARPER test than before, not a weaker one. The overlay's
  // `source_status` matches the derived stage exactly, so source-staleness is
  // ruled out as the reason it fails, and the ONLY thing left refusing the
  // promotion is the money gate: `after_status` is `report_ready` and no
  // qualifying current draft invoice backs it.
  const [canonical] = buildCanonicalMakesafeRows([
    invoiceGatedCard({
      assignments: [{ id: "a1", user_id: "u1", status: "scheduled" }],
    }),
  ], {
    computedAt: SNAPSHOT_NOW,
    statusApplicationsByJobId: { "job-current": PROMOTE_TO_REPORT_READY },
  });

  assertEquals(canonical.declared_stage, "allocated");
  assertEquals(canonical.derived_stage_v2, "allocated");
  assertEquals(canonical.canonical_stage, "allocated");
  // Refused outright: an overlay the gate rejects attaches no provenance.
  assertEquals(canonical.status_application, null);

  const ops = projectOpsMakesafeBoard([canonical]);
  assertEquals(ops.columns.allocated.map((row: any) => row.job_number), [
    "SWMS-TEST-1",
  ]);
  assertEquals(ops.columns.report_ready.length, 0);

  const trade = projectTradeMakesafeBoard([canonical], {
    userId: "ops-reviewer",
    role: "ops_manager",
    managedVerticals: ["makesafe"],
  });
  assertEquals(trade.columns.Allocated.map((row: any) => row.job_number), [
    "SWMS-TEST-1",
  ]);
  assertEquals(trade.columns.Complete.length, 0);
});

Deno.test("an invoice-gated card with no identifiable family is refused, not guessed into a column", () => {
  // The original fixture for the test above, preserved: a `ready_to_invoice`
  // money claim with no allocation, no report, no qualifying draft AND no
  // declared job family. Before R12 it rendered wherever `board_stage` said.
  //
  // It now derives `decision_required`, and the honest reason is the family,
  // not the money: with no identifiable family there is no evidence recipe, so
  // nothing downstream can say what would advance this card. The engine refuses
  // rather than reading it as a physical make-safe — the failure mode that
  // silently mislabelled 19 cards at the 2026-08-02 snapshot. The money gate
  // still holds underneath it: the promotion to `report_ready` does not bind.
  const [canonical] = buildCanonicalMakesafeRows([
    invoiceGatedCard({ metadata: undefined }),
  ], {
    computedAt: SNAPSHOT_NOW,
    statusApplicationsByJobId: { "job-current": PROMOTE_TO_REPORT_READY },
  });

  assertEquals(canonical.canonical_stage, "decision_required");
  assertEquals(canonical.derived_stage_v2_conflicts, ["family_unknown"]);
  assertEquals(canonical.status_application, null);

  const ops = projectOpsMakesafeBoard([canonical]);
  assertEquals(
    ops.columns.decision_required.map((row: any) => row.job_number),
    [
      "SWMS-TEST-1",
    ],
  );
  assertEquals(ops.columns.report_ready.length, 0);
  // A real rendered column since R12, so the card is visible rather than parked
  // in `new` as an unrecognised stage.
  assertEquals(ops.unmapped_stage_job_ids.length, 0);
});

Deno.test("read-side readiness fingerprint changes with current invoice lifecycle inputs", () => {
  const scoped = (invoice: any) =>
    projectCycleScopedEvidence({
      detail: { cycle_number: 1, reattend_count: 0 },
      assignments: [],
      reports: [],
      docs: [],
      invoice,
      invoiceQualifiesAsCurrentDraft: invoice?.status === "DRAFT",
    } as any).readiness_revision;

  const missing = scoped(null);
  const draft = scoped(linkedInvoice("DRAFT"));
  const authorised = scoped(linkedInvoice("AUTHORISED"));
  const deleted = scoped(linkedInvoice("DELETED"));
  const unlinked = scoped({ ...linkedInvoice("DRAFT"), job_id: null });

  assertNotEquals(draft, missing);
  assertNotEquals(authorised, draft);
  assertNotEquals(deleted, draft);
  assertNotEquals(unlinked, draft);
  assertEquals(scoped(null), missing);
});

const frozenFailures = [
  ["SWMS-261123", "accepted", "ready_to_invoice", 0, false, null, "allocated"],
  ["SWMS-261116", "accepted", "ready_to_invoice", 0, false, null, "allocated"],
  [
    "SWMS-261115",
    "accepted",
    "admin_to_send_report",
    1,
    true,
    null,
    "trade_report_in",
  ],
  ["SWMS-261114", "accepted", "ready_to_invoice", 0, false, null, "allocated"],
  ["SWMS-261113", "accepted", "ready_to_invoice", 0, false, null, "allocated"],
  [
    "SWMS-261109",
    "accepted",
    "admin_to_send_report",
    1,
    true,
    null,
    "trade_report_in",
  ],
  [
    "SWMS-261080",
    "accepted",
    "admin_to_send_report",
    1,
    true,
    null,
    "trade_report_in",
  ],
  ["SWMS-261079", "accepted", "ready_to_invoice", 0, false, null, "allocated"],
  [
    "SWMS-261065",
    "accepted",
    "admin_to_send_report",
    1,
    true,
    null,
    "trade_report_in",
  ],
  [
    "SWMS-261059",
    "complete",
    "company_contact_required",
    0,
    false,
    null,
    "completed",
  ],
  [
    "SWMS-261029",
    "processing",
    "admin_to_send_report",
    2,
    true,
    null,
    "trade_report_in",
  ],
  [
    "SWMS-261025",
    "complete",
    "admin_to_send_report",
    1,
    true,
    null,
    "trade_report_in",
  ],
  [
    "SWMS-261020",
    "processing",
    "admin_to_send_report",
    1,
    true,
    null,
    "trade_report_in",
  ],
  [
    "SWMS-261017",
    "processing",
    "admin_to_send_report",
    1,
    true,
    null,
    "trade_report_in",
  ],
  ["SWMS-26832", "invoiced", "complete", 2, false, null, "allocated"],
  [
    "SWMS-26585",
    "scheduled",
    "waiting_on_trade_report",
    4,
    false,
    "AUTHORISED",
    "allocated",
  ],
] as const;

Deno.test("frozen 2026-08-03 failures derive to the reported existing stages without writes", () => {
  for (
    const [
      jobNumber,
      jobStatus,
      substatus,
      assignmentCount,
      hasReport,
      invoiceStatus,
      expected,
    ] of frozenFailures
  ) {
    const invoice = invoiceStatus
      ? {
        ...linkedInvoice(invoiceStatus),
        reference: jobNumber === "SWMS-26585" ? "PO20919" : "MLB-99999",
      }
      : null;
    const stage = _deriveMakesafeBoardStage(
      {
        id: "job-current",
        job_number: jobNumber,
        status: jobStatus,
        completed_at: jobNumber === "SWMS-261059"
          ? "2026-07-31T06:48:39.196Z"
          : null,
      },
      {
        substatus,
        external_ref: jobNumber === "SWMS-26585" ? "PO20919" : "MLB-99999",
        report_received_at: hasReport ? "2026-08-01T01:00:00Z" : null,
      },
      Array.from({ length: assignmentCount }, (_, index) => ({
        id: `assignment-${index}`,
      })),
      hasReport ? { id: "report-current", status: "submitted" } : undefined,
      invoice,
      SNAPSHOT_NOW,
      {
        has_invoice_doc: jobNumber === "SWMS-261059",
        has_report_doc: ["SWMS-261059", "SWMS-26832"].includes(jobNumber),
        has_swms_doc: jobNumber === "SWMS-261059",
      },
      false,
      null,
    );
    assertEquals(stage, expected, jobNumber);
  }
});
