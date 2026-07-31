// deno-lint-ignore-file no-import-prefix

import {
  assertReadOnlyRequest,
  assertReportPrivacy,
  auditJob,
  type AuditResult,
  buildAudit,
  fetchAllPages,
  filterCanonicalRowsForAudit,
  type RawInvoice,
  type RawJob,
  type RawPack,
  renderMarkdown,
} from "../ses-evidence-stage-checker.ts";
import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const RAW_JOB: RawJob = {
  id: "job-1",
  job_number: "SWMS-TEST-1",
  type: "makesafe",
  status: "scheduled",
  archived: false,
  updated_at: "2026-07-01T00:00:00Z",
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    job_number: "SWMS-TEST-1",
    canonical_stage: "allocated",
    assignments: [],
    computed_status_job_type: "physical_makesafe",
    computed_status_evidence: {
      has_submitted_service_report: false,
      has_current_portal_capture: false,
    },
    report: { photo_count: 0 },
    pack: {
      sent: false,
      state: "not_started",
      pre_xero_docs_ready: false,
    },
    ...overrides,
  };
}

function audit(overrides: {
  canonicalRow?: Record<string, unknown>;
  rawJob?: RawJob;
  invoices?: RawInvoice[];
  packs?: RawPack[];
  documentFlags?: {
    has_invoice_doc: boolean;
    has_report_doc: boolean;
    has_swms_doc: boolean;
  };
  swmsRequired?: boolean;
}) {
  return auditJob({
    canonicalRow: row(overrides.canonicalRow),
    rawJob: overrides.rawJob || RAW_JOB,
    documents: [],
    invoices: overrides.invoices || [],
    packs: overrides.packs || [],
    documentFlags: overrides.documentFlags || {
      has_invoice_doc: false,
      has_report_doc: false,
      has_swms_doc: false,
    },
    swmsRequired: overrides.swmsRequired || false,
    v2Row: null,
    generatedAt: "2026-07-31T00:00:00Z",
  });
}

Deno.test("read-only transport rejects every mutation method", () => {
  assertReadOnlyRequest();
  assertReadOnlyRequest({ method: "HEAD" });
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assertThrows(
      () => assertReadOnlyRequest({ method }),
      Error,
      `forbids production mutation method ${method}`,
    );
  }
});

Deno.test("allocated claim without an active assignment fails", () => {
  const result = audit({});
  assertEquals(result.evidence_stage, "new");
  assertEquals(
    result.findings.map((finding) => finding.code),
    ["stage_ahead_of_evidence", "missing_active_assignment"],
  );
});

Deno.test("physical current-cycle report plus five photos derives Trade Report In", () => {
  const result = audit({
    canonicalRow: {
      canonical_stage: "trade_report_in",
      assignments: [{ status: "scheduled" }],
      computed_status_evidence: {
        has_submitted_service_report: true,
        has_current_portal_capture: false,
      },
      report: { photo_count: 5 },
    },
  });
  assertEquals(result.evidence_stage, "trade_report_in");
  assertEquals(result.findings, []);
});

Deno.test("durably sent authorised closeout stays terminal while missing docs remain visible", () => {
  const result = audit({
    canonicalRow: {
      canonical_stage: "archive",
      pack: { sent: true, state: "sent", pre_xero_docs_ready: false },
    },
    rawJob: {
      ...RAW_JOB,
      status: "archived",
      archived: true,
      updated_at: "2026-07-01T00:00:00Z",
    },
    invoices: [{
      job_id: "job-1",
      invoice_type: "ACCREC",
      status: "AUTHORISED",
      invoice_date: "2026-07-01",
    }],
  });
  assertEquals(result.evidence_stage, "archive");
  assertEquals(result.terminal_proven, true);
  assertEquals(
    result.findings.map((finding) => finding.code),
    ["terminal_pack_document_gap"],
  );
});

Deno.test("raw invoiced state without linked invoice is critical", () => {
  const result = audit({
    rawJob: { ...RAW_JOB, status: "invoiced" },
  });
  assertEquals(
    result.findings.some((finding) =>
      finding.code === "invoiced_state_without_invoice" &&
      finding.severity === "critical"
    ),
    true,
  );
});

Deno.test("range reader walks beyond the PostgREST 1000-row cap", async () => {
  const source = Array.from({ length: 1_205 }, (_, index) => ({ id: index }));
  const ranges: Array<[number, number]> = [];
  const stats: Record<string, { pages: number; rows: number }> = {};
  const rows = await fetchAllPages<{ id: number }>(
    "fixture",
    () => ({
      range: (from: number, to: number) => {
        ranges.push([from, to]);
        return Promise.resolve({
          data: source.slice(from, to + 1),
          error: null,
        });
      },
    }),
    stats,
  );
  assertEquals(rows.length, 1_205);
  assertEquals(ranges, [[0, 999], [1000, 1999]]);
  assertEquals(stats.fixture, { pages: 2, rows: 1_205 });
});

Deno.test("canonical audit rows exclude terminal synthetic IDs beyond page one", () => {
  const terminalIds = new Set(
    Array.from({ length: 1_205 }, (_, index) => `synthetic-${index}`),
  );
  const canonicalRows = Array.from({ length: 1_205 }, (_, index) => ({
    id: `synthetic-${index}`,
    job_number: `SWMS-SYNTHETIC-${index}`,
  }));
  assertEquals(
    filterCanonicalRowsForAudit(canonicalRows, terminalIds),
    [],
  );
});

Deno.test("report renderer rejects client personal data", () => {
  assertThrows(
    () => assertReportPrivacy("client_name: Example Person"),
    Error,
    "privacy guard",
  );
  assertThrows(
    () => assertReportPrivacy("Call 0412 345 678"),
    Error,
    "privacy guard",
  );
});

Deno.test("empty report fixture remains privacy-safe", async () => {
  const result: AuditResult = {
    generated_at: "2026-07-31T00:00:00Z",
    population_count: 0,
    canonical_board_count: 0,
    coverage_missing_from_board: [],
    coverage_extra_on_board: [],
    claimed_stage_counts: {},
    evidence_stage_counts: {},
    failure_counts: {},
    severity_counts: {},
    v2_blocker_counts: {},
    v2_diagnostic_counts: {},
    projection_health: null,
    v2_load_error: null,
    page_stats: {},
    jobs: [],
  };
  const markdown = renderMarkdown(result, "/tmp/report.md");
  await assertRejects(
    async () => {
      assertReportPrivacy(`${markdown}\ncontact.phone`);
      await Promise.resolve();
    },
    Error,
    "privacy guard",
  );
});

Deno.test("reconciliation work-list includes board coverage findings", () => {
  const result = buildAudit({
    canonicalRows: [{ ...row(), id: "job-extra", job_number: "SWMS-EXTRA" }],
    rawJobs: [RAW_JOB],
    documents: [],
    invoices: [],
    packs: [],
    documentFlagsByJob: new Map(),
    swmsRequiredJobIds: new Set(),
    v2RowsByJob: new Map(),
    projectionHealth: null,
    v2LoadError: null,
    generatedAt: "2026-07-31T00:00:00Z",
    pageStats: {},
  });
  const markdown = renderMarkdown(result, "/tmp/report.md");
  assertEquals(markdown.includes("SWMS-TEST-1"), true);
  assertEquals(
    markdown.includes("coverage_missing_from_canonical_board"),
    true,
  );
  assertEquals(markdown.includes("SWMS-EXTRA"), true);
  assertEquals(markdown.includes("coverage_extra_on_canonical_board"), true);
});
