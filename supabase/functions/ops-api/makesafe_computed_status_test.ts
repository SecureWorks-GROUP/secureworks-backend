// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildMakesafeDisagreementList,
  checkMakesafeStatusCanary,
  computeMakesafeStatus,
} from "./makesafe_computed_status.ts";

const NOW = "2026-07-23T04:00:00.000Z";

function physical(overrides: Record<string, unknown> = {}) {
  return {
    job: {
      status: "scheduled",
      metadata: { makesafe_job_family: "general_makesafe" },
    },
    detail: { report_type: null, cycle_number: 1 },
    evidence: {
      assignments: [],
      serviceReports: [],
      completionPhotoCount: 0,
      portalCaptures: [],
      documents: { report: false, invoice: false, swms: false },
      ...overrides,
    },
    nowIso: NOW,
  };
}

Deno.test("computed status: physical New, Allocated, and Trade Report In are evidence-derived", () => {
  assertEquals(computeMakesafeStatus(physical()).status, "new");
  assertEquals(
    computeMakesafeStatus(physical({ assignments: [{ id: "a1" }] })).status,
    "allocated",
  );
  const reportIn = computeMakesafeStatus(physical({
    serviceReports: [{ status: "submitted", cycle_number: 1 }],
    completionPhotoCount: 5,
  }));
  assertEquals(reportIn.status, "trade_report_in");
  assertStringIncludes(reportIn.reasons[0], "completion photo floor");
});

Deno.test("computed status: physical report fails closed on stale cycle or photos below floor", () => {
  const stale = computeMakesafeStatus({
    ...physical({
      assignments: [{ id: "a1" }],
      serviceReports: [{ status: "submitted", cycle_number: 1 }],
      completionPhotoCount: 9,
    }),
    detail: { report_type: null, cycle_number: 2 },
  });
  assertEquals(stale.status, "allocated");
  assert(stale.missing.includes("current-cycle submitted service report"));

  const short = computeMakesafeStatus(physical({
    serviceReports: [{ status: "submitted", cycle_number: 1 }],
    completionPhotoCount: 4,
  }));
  assertEquals(short.status, "new");
  assert(short.missing.some((value) => value.includes("found 4")));
});

Deno.test("computed status: roof requires one typed done capture with screenshot", () => {
  const base = {
    job: {
      status: "accepted",
      metadata: { makesafe_job_family: "roof_report" },
    },
    detail: {
      report_type: "roof_report",
      cycle_number: 1,
      external_links: [{ kind: "roof_report", url: "https://portal.test/r" }],
    },
    evidence: { assignments: [], portalCaptures: [] },
    nowIso: NOW,
  };
  assertEquals(computeMakesafeStatus(base).status, "allocated");
  assertEquals(
    computeMakesafeStatus({
      ...base,
      evidence: {
        portalCaptures: [{
          status: "done",
          role: "roof_report",
          screenshot: "/tmp/roof.png",
          cycle_number: 1,
        }],
      },
    }).status,
    "trade_report_in",
  );
});

Deno.test("computed status: assessment is fail-closed until all three typed captures are done", () => {
  const base = {
    job: { status: "accepted" },
    detail: {
      report_type: "assessment_report",
      cycle_number: 3,
      external_links: [{
        kind: "assessment_report",
        url: "https://portal.test/a",
      }],
    },
    evidence: {
      portalCaptures: [{
        status: "done",
        role: "assessment_report",
        cycle_number: 3,
      }],
    },
    nowIso: NOW,
  };
  const oneOfThree = computeMakesafeStatus(base);
  assertEquals(oneOfThree.status, "allocated");
  assert(
    oneOfThree.missing.includes(
      "The work order email contains no photos link - ask the builder to send it.",
    ),
  );
  assert(
    oneOfThree.missing.includes(
      "The work order email contains no quote/scope link - ask the builder to send it.",
    ),
  );

  const threeOfThree = computeMakesafeStatus({
    ...base,
    detail: {
      ...base.detail,
      external_links: [
        ...base.detail.external_links,
        { kind: "photos", url: "https://portal.test/p" },
        { kind: "scope", url: "https://portal.test/q" },
      ],
    },
    evidence: {
      portalCaptures: [
        {
          status: "done",
          role: "assessment_report",
          screenshot: "/tmp/assessment.png",
          cycle_number: 3,
        },
        {
          status: "done",
          role: "photos",
          screenshot: "/tmp/photos.png",
          cycle_number: 3,
        },
        {
          status: "done",
          role: "quote",
          screenshot: "/tmp/quote.png",
          cycle_number: 3,
        },
      ],
    },
  });
  assertEquals(threeOfThree.status, "trade_report_in");
});

Deno.test("computed status: assessment READY pack still requires triad evidence", () => {
  const result = computeMakesafeStatus({
    job: { status: "accepted" },
    detail: {
      report_type: "assessment_report",
      cycle_number: 1,
      external_links: [{
        kind: "assessment_report",
        url: "https://portal.test/a",
      }],
    },
    evidence: {
      portalCaptures: [],
      packState: "READY",
    },
    nowIso: NOW,
  });
  assertEquals(result.status, "allocated");
  assert(result.missing.some((item) => item.includes("headless capture")));
});

Deno.test("computed status: Docs Ready reads durable draft-pack records", () => {
  const result = computeMakesafeStatus(physical({
    serviceReports: [{ status: "submitted", cycle_number: 1 }],
    completionPhotoCount: 8,
    invoiceStatus: "DRAFT",
    swmsRequired: true,
    pack: {
      status: "drafted",
      report_doc_id: "report-doc",
      invoice_doc_id: "invoice-doc",
      swms_doc_id: "swms-doc",
    },
  }));
  assertEquals(result.status, "report_ready");
});

Deno.test("computed status: close-out truth splits Completed and Archive at seven days", () => {
  const evidence = {
    serviceReports: [{ status: "submitted", cycle_number: 1 }],
    completionPhotoCount: 8,
    invoiceStatus: "AUTHORISED",
    packSent: true,
    documents: { report: true, invoice: true, swms: false },
    pack: { status: "sent", sent_at: "2026-07-20T04:00:00.000Z" },
  };
  assertEquals(computeMakesafeStatus(physical(evidence)).status, "completed");
  assertEquals(
    computeMakesafeStatus(physical({
      ...evidence,
      pack: { status: "sent", sent_at: "2026-07-01T04:00:00.000Z" },
    })).status,
    "archive",
  );
});

Deno.test("computed status: durable sent-pack plus issued invoice beats missing report-type captures", () => {
  const result = computeMakesafeStatus({
    job: {
      status: "processing",
      metadata: { makesafe_job_family: "roof_report" },
    },
    detail: {
      report_type: "roof_report",
      cycle_number: 1,
      external_links: [{ kind: "roof_report", url: "https://portal.test/r" }],
    },
    evidence: {
      assignments: [{ id: "assignment-1" }],
      portalCaptures: [],
      invoiceStatus: "PAID",
      invoiceDate: "2026-07-01T00:00:00.000Z",
      packSent: true,
      pack: { status: "sent" },
      documents: { report: false, invoice: false, swms: false },
    },
    nowIso: NOW,
  });

  assertEquals(result.status, "archive");
  assertStringIncludes(
    result.reasons[0],
    "durable sent-pack evidence and authorised invoice",
  );
  assertEquals(result.missing, []);
});

Deno.test("computed status: completion timestamp follows invoice, detail, and job fallbacks", () => {
  const closeout = {
    invoiceStatus: "AUTHORISED",
    packSent: true,
    pack: { status: "sent" },
  };
  assertEquals(
    computeMakesafeStatus(physical({
      ...closeout,
      invoiceDate: "2026-07-21T00:00:00.000Z",
    })).status,
    "completed",
  );
  assertEquals(
    computeMakesafeStatus(physical({
      ...closeout,
      invoiceCreatedAt: "2026-07-01T00:00:00.000Z",
    })).status,
    "archive",
  );
  assertEquals(
    computeMakesafeStatus({
      ...physical(closeout),
      detail: {
        report_type: null,
        cycle_number: 1,
        invoice_ready_at: "2026-07-21T00:00:00.000Z",
      },
    }).status,
    "completed",
  );
  assertEquals(
    computeMakesafeStatus({
      ...physical(closeout),
      job: {
        status: "processing",
        updated_at: "2026-07-01T00:00:00.000Z",
        metadata: { makesafe_job_family: "general_makesafe" },
      },
    }).status,
    "archive",
  );
  assertEquals(
    computeMakesafeStatus(physical(closeout)).status,
    "completed",
    "unknown completion time must remain visible in Completed",
  );
});

Deno.test("computed status: displayed terminal cards and closed jobs never revive", () => {
  assertEquals(
    computeMakesafeStatus({ ...physical(), displayedStatus: "archive" }).status,
    "archive",
  );
  assertEquals(
    computeMakesafeStatus({ ...physical(), displayedStatus: "completed" })
      .status,
    "completed",
  );
  assertEquals(
    computeMakesafeStatus({
      ...physical(),
      displayedStatus: "archive",
      job: {
        status: "closed",
        metadata: { makesafe_job_family: "general_makesafe" },
      },
    }).status,
    "archive",
    "the displayed terminal stage wins over a different terminal job state",
  );
  assertEquals(
    computeMakesafeStatus({
      ...physical(),
      job: {
        status: "closed",
        metadata: { makesafe_job_family: "general_makesafe" },
      },
    }).status,
    "completed",
  );
});

Deno.test("computed status: D3 hold stays a badge on the evidence column", () => {
  const result = computeMakesafeStatus(physical({
    serviceReports: [{ status: "submitted", cycle_number: 1 }],
    completionPhotoCount: 5,
    hold: {
      id: "hold-1",
      reason_code: "manual_review",
      note: "Builder asked us to wait",
    },
  }));
  assertEquals(result.status, "trade_report_in");
  assertEquals(result.hold?.reason_code, "manual_review");
  assert(result.reasons.includes("hold badge: manual_review"));
});

Deno.test("known diagnosed cards reconcile per captain D1, while SWMS-26953 is listed", () => {
  const genuineReportIn = (jobNumber: string, photos: number) => ({
    id: jobNumber,
    job_number: jobNumber,
    substatus: "admin_to_send_report",
    declared_status: "trade_report_in",
    computation: computeMakesafeStatus(physical({
      serviceReports: [{ status: "submitted", cycle_number: 1 }],
      completionPhotoCount: photos,
    })),
  });
  const cards = [
    genuineReportIn("SWMS-261036", 18),
    genuineReportIn("SWMS-261037", 29),
    genuineReportIn("SWMS-261038", 35),
    {
      id: "SWMS-26953",
      job_number: "SWMS-26953",
      substatus: "waiting_on_trade_report",
      // Existing declared board reads the stale report_received stamp as Docs Ready.
      declared_status: "report_ready",
      computation: computeMakesafeStatus(physical({
        assignments: [{ id: "assignment-hugo" }],
        serviceReports: [{ status: "submitted", cycle_number: 1 }],
        completionPhotoCount: 12,
      })),
    },
  ];

  const disagreements = buildMakesafeDisagreementList(cards);
  assertEquals(disagreements.map((row) => row.job_number), ["SWMS-26953"]);
  assertEquals(disagreements[0].declared_substatus, "waiting_on_trade_report");
  assertEquals(disagreements[0].computed_status, "trade_report_in");
  // D1 is binding: 261036/37/38 have genuine reports + 18-35 photos, so their
  // lack of a historical assignment is not a status disagreement.
  for (const number of ["SWMS-261036", "SWMS-261037", "SWMS-261038"]) {
    assert(!disagreements.some((row) => row.job_number === number));
  }
});

Deno.test("canary alarms on empty stamp and regressed substatus, and never changes input", () => {
  const card = {
    id: "empty-stamp",
    job_number: "SWMS-EMPTY",
    substatus: "waiting_on_trade_report",
    declared_status: "report_ready",
    computation: computeMakesafeStatus(physical()),
    report_received_at: "2026-07-22T00:00:00Z",
    has_submitted_service_report: false,
    has_current_portal_capture: false,
  };
  const before = JSON.stringify(card);
  const result = checkMakesafeStatusCanary([card]);
  assertEquals(result.ok, false);
  assert(
    result.alarms.some((alarm) =>
      alarm.code === "report_received_without_evidence"
    ),
  );
  assert(
    result.alarms.some((alarm) =>
      alarm.code === "report_received_with_pre_report_substatus"
    ),
  );
  assertEquals(JSON.stringify(card), before, "canary is read-only");
});
