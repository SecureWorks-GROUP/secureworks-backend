// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _assertNoSyntheticLivefireInvoiceForTest,
  _assertNoSyntheticLivefireJobsForTest,
  _assertNoSyntheticLivefireReleaseRevisionForTest,
  _deriveMakesafeBoardStage,
  _loadCanonicalMakesafeBoardForTest,
} from "./index.ts";
import {
  archiveOnDemandMeta,
  buildCanonicalMakesafeRows,
  buildMakesafeContact,
  checkMakesafeBoardParity,
  countOpsCanonicalStages,
  filterCanonicalRowsByColumnScope,
  isCanonicalLiveMakesafeBoardJobStatus,
  isExcludedTerminalSyntheticBoardRow,
  isSyntheticLivefireJob,
  isTerminalSyntheticLivefireJob,
  makesafeBoardJobStatusExclusionFilter,
  mapOpsStageToTradeColumn,
  OPS_MAKESAFE_STAGES,
  parseMakesafeBoardColumnScope,
  parseMakesafeBoardFields,
  portalCapturesFromLedger,
  projectOpsMakesafeBoard,
  projectOpsMakesafeCardRow,
  projectTradeMakesafeBoard,
  TRADE_MAKESAFE_COLUMNS,
} from "./makesafe_board_read_model.ts";
import { observerPopulationForJobStatus } from "../../../scripts/ses-f7-prime-portal-observer.ts";

const NOW = "2026-07-20T12:00:00Z";

function baseJob(
  stage: string,
  id = `job-${stage}`,
  over: Record<string, unknown> = {},
) {
  return {
    id,
    job_number: `SWMS-${id}`,
    type: "makesafe",
    status: stage === "cancelled" ? "cancelled" : "scheduled",
    board_stage: stage,
    board_label: stage,
    substatus: stage === "new"
      ? "company_contact_required"
      : "waiting_on_trade_report",
    client_name: "Kim Client",
    client_phone: "0400 111 222",
    site_address: "10 Sample Street",
    site_suburb: "Perth",
    requesting_company_name: "ML Builders",
    external_ref: "MLB-100",
    metadata: {
      builder_claim_ref: "MLB-100",
      builder_po_number: `PO-${id}`,
      makesafe_job_family: "general_makesafe",
    },
    makesafe_details: { substatus: "waiting_on_trade_report", cycle_number: 1 },
    assignments: [{
      id: `assignment-${id}`,
      user_id: "trade-1",
      status: "scheduled",
      scheduled_date: "2026-07-20",
      start_time: "09:00",
      users: { id: "trade-1", name: "Hugo", phone: "0400 000 001" },
    }],
    report_status: "waiting_on_trade_report",
    sent_to_builder: false,
    age_hours: 20,
    ...over,
  };
}

type LoaderQueryCall = {
  table: string;
  selected?: string;
  not?: { column: string; operator: string; value: string };
};

function makeCanonicalLoaderClient(failTable?: string) {
  const sourceUrl = "https://www.primeeco.tech/share/loader-fixture";
  const rowsByTable: Record<string, any[]> = {
    jobs: [{
      id: "loader-job",
      job_number: "SWMS-LOADER-1",
      type: "makesafe",
      status: "accepted",
      metadata: {
        makesafe_job_family: "roof_report",
        own_template_requested: true,
      },
      created_at: "2026-07-20T10:00:00Z",
      updated_at: "2026-07-20T10:00:00Z",
    }],
    makesafe_job_details: [{
      job_id: "loader-job",
      external_ref: "MLB-LOADER-1",
      report_type: "roof_report",
      external_links: [{ kind: "roof_report", url: sourceUrl }],
      cycle_number: 1,
      attendance_cycle_id: "loader-cycle-1",
      substatus: "waiting_on_trade_report",
    }],
    makesafe_portal_capture_revisions: [{
      id: "loader-capture-1",
      job_id: "loader-job",
      attendance_cycle_id: "loader-cycle-1",
      role: "roof_report",
      status: "verified",
      makesafe_fact_version: 1,
      capture_result: "done",
      source_url: sourceUrl,
      source_content_hash: `sha256:${"a".repeat(64)}`,
      builder_reference: "MLB-LOADER-1",
      captured_at: NOW,
      capture_producer: "capture_portal_evidence.py/v1",
      signal: "submitted and locked",
      screenshot_object_key:
        "makesafe-docket-artifacts/portal-captures/loader/cycle/roof.png",
      screenshot_media_type: "image/png",
      screenshot_content_hash: `sha256:${"b".repeat(64)}`,
      screenshot_size_bytes: 2048,
    }],
  };
  const calls: LoaderQueryCall[] = [];

  function builder(table: string) {
    const call: LoaderQueryCall = { table };
    calls.push(call);
    const predicates: Array<(row: any) => boolean> = [];
    const query: any = {
      select: (columns?: string) => {
        call.selected = columns;
        return query;
      },
      eq: (column: string, value: unknown) => {
        predicates.push((row) => row?.[column] === value);
        return query;
      },
      neq: (column: string, value: unknown) => {
        predicates.push((row) => row?.[column] !== value);
        return query;
      },
      not: (column: string, operator: string, value: string) => {
        call.not = { column, operator, value };
        if (operator === "in") {
          const excluded = value.replace(/[()"']/g, "").split(",");
          predicates.push((row) => !excluded.includes(String(row?.[column])));
        }
        return query;
      },
      in: (column: string, values: unknown[]) => {
        predicates.push((row) => values.includes(row?.[column]));
        return query;
      },
      gte: (column: string, value: unknown) => {
        predicates.push((row) => String(row?.[column] ?? "") >= String(value));
        return query;
      },
      or: () => query,
      order: () => query,
      limit: () => query,
      range: (from: number, to: number) => {
        if (table === failTable) {
          return { data: null, error: { message: `${table} fixture failure` } };
        }
        return {
          data: (rowsByTable[table] || []).filter((row) =>
            predicates.every((predicate) => predicate(row))
          ).slice(from, to + 1),
          error: null,
        };
      },
      then: (resolve: (value: any) => any) => {
        if (table === failTable) {
          return resolve({
            data: null,
            error: { message: `${table} fixture failure` },
          });
        }
        return resolve({
          data: (rowsByTable[table] || []).filter((row) =>
            predicates.every((predicate) => predicate(row))
          ),
          error: null,
        });
      },
    };
    return query;
  }

  return {
    client: { from: (table: string) => builder(table) },
    calls,
  };
}

Deno.test("parity: every ops stage maps exactly once to the captain's four trade columns", () => {
  const rows = buildCanonicalMakesafeRows(
    OPS_MAKESAFE_STAGES.map((stage) => baseJob(stage)),
  );
  const parity = checkMakesafeBoardParity(rows);
  assertEquals(parity.ok, true);
  assertEquals(parity.checked, OPS_MAKESAFE_STAGES.length);
  assertEquals(parity.errors, []);
  assertEquals(parity.unmapped_stage_job_ids, []);

  const trade = projectTradeMakesafeBoard(rows, {
    userId: "hugo-id",
    name: "Hugo",
    role: "installer",
    managedVerticals: ["makesafe"],
  });
  assertEquals(Object.keys(trade.columns), [...TRADE_MAKESAFE_COLUMNS]);
  assert(
    !Object.keys(trade.columns).some((name) =>
      name.toLowerCase().includes("office")
    ),
  );
  assertEquals(trade.columns.New.map((r) => r.canonical_stage), ["new"]);
  assertEquals(trade.columns.Allocated.map((r) => r.canonical_stage), [
    "allocated",
  ]);
  assertEquals(
    trade.columns.Complete.map((r) => r.canonical_stage),
    ["trade_report_in", "report_ready"],
  );
  assertEquals(
    trade.columns.Archive.map((r) => r.canonical_stage),
    ["completed", "archive", "cancelled"],
  );
});

Deno.test("historical divergence: assignment complete without a report remains Allocated", () => {
  const stage = _deriveMakesafeBoardStage(
    { status: "scheduled" },
    { substatus: "waiting_on_trade_report" },
    [{ user_id: "trade-1", status: "complete" }],
    undefined,
  );
  assertEquals(stage, "allocated");
  assertEquals(mapOpsStageToTradeColumn(stage).column, "Allocated");
});

Deno.test("historical divergence: Docs Ready/report_ready deterministically appears in Complete", () => {
  assertEquals(mapOpsStageToTradeColumn("report_ready"), {
    column: "Complete",
    mapped: true,
  });
});

Deno.test("F7 board read model consumes one exact-cycle screenshot-backed ledger revision without moving canonical stage", () => {
  const sourceUrl = "https://www.primeeco.tech/share/portal-fixture";
  const source = baseJob("allocated", "portal-ledger", {
    external_ref: "MLB-PORTAL-1",
    metadata: { makesafe_job_family: "roof_report" },
    makesafe_details: {
      substatus: "waiting_on_trade_report",
      report_type: "roof_report",
      external_ref: "MLB-PORTAL-1",
      external_links: [{ kind: "roof_report", url: sourceUrl }],
      cycle_number: 2,
      attendance_cycle_id: "cycle-current",
    },
  });
  const revision = {
    id: "capture-1",
    job_id: "portal-ledger",
    attendance_cycle_id: "cycle-current",
    role: "roof_report",
    status: "verified",
    makesafe_fact_version: 1,
    capture_result: "done",
    source_url: sourceUrl,
    source_content_hash: `sha256:${"1".repeat(64)}`,
    builder_reference: "MLB-PORTAL-1",
    captured_at: NOW,
    capture_producer: "capture_portal_evidence.py/v1",
    signal: "submitted/locked observed, 21 of 23 fields answered",
    screenshot_object_key:
      "makesafe-docket-artifacts/portal-captures/job/cycle/roof/image.png",
    screenshot_media_type: "image/png",
    screenshot_content_hash: `sha256:${"2".repeat(64)}`,
    screenshot_size_bytes: 4096,
  };

  const [row] = buildCanonicalMakesafeRows([source], {
    portalCaptureRowsByJobId: { "portal-ledger": [revision] },
    computedAt: NOW,
  });
  assertEquals(row.canonical_stage, "allocated");
  assertEquals(row.computed_status, "trade_report_in");
  assertEquals(row.computed_status_evidence.has_current_portal_capture, true);
  assertEquals(row.computed_status_evidence.portal_capture_revisions, [{
    id: "capture-1",
    role: "roof_report",
    status: "done",
    signal: "submitted/locked observed, 21 of 23 fields answered",
    captured_at: NOW,
    screenshot_available: true,
  }]);
});

Deno.test("F7 newest exact ledger truth suppresses an older embedded detail capture", () => {
  const sourceUrl = "https://www.primeeco.tech/share/portal-precedence";
  const source = baseJob("allocated", "portal-precedence", {
    external_ref: "MLB-PORTAL-ORDER",
    metadata: { makesafe_job_family: "roof_report" },
    makesafe_details: {
      report_type: "roof_report",
      external_ref: "MLB-PORTAL-ORDER",
      external_links: [{ kind: "roof_report", url: sourceUrl }],
      portal_captures: [{
        status: "done",
        role: "roof_report",
        url: sourceUrl,
        locked: true,
        screenshot: "legacy-detail-capture.png",
        cycle_number: 1,
      }],
      cycle_number: 1,
      attendance_cycle_id: "cycle-current",
    },
  });
  const [row] = buildCanonicalMakesafeRows([source], {
    portalCaptureRowsByJobId: {
      "portal-precedence": [{
        id: "capture-newer",
        job_id: "portal-precedence",
        attendance_cycle_id: "cycle-current",
        role: "roof_report",
        status: "captured",
        makesafe_fact_version: 2,
        capture_result: "not_done",
        source_url: sourceUrl,
        source_content_hash: `sha256:${"5".repeat(64)}`,
        builder_reference: "MLB-PORTAL-ORDER",
        captured_at: NOW,
        capture_producer: "capture_portal_evidence.py/v1",
        signal: "in progress: 8 of 23 fields answered",
        screenshot_object_key:
          "makesafe-docket-artifacts/portal-captures/job/cycle/roof/newer.png",
        screenshot_media_type: "image/png",
        screenshot_content_hash: `sha256:${"6".repeat(64)}`,
        screenshot_size_bytes: 4096,
      }],
    },
    computedAt: NOW,
  });

  assertEquals(row.canonical_stage, "allocated");
  assertEquals(row.computed_status, "allocated");
  assertEquals(row.computed_status_evidence.has_current_portal_capture, false);
  assertEquals(
    row.computed_status_evidence.portal_capture_revisions[0].status,
    "not_done",
  );
});

Deno.test("F7 board capture projection rejects stale cycle, wrong URL, missing reference, and missing screenshot", () => {
  const sourceUrl = "https://www.primeeco.tech/share/portal-fixture";
  const source = baseJob("allocated", "portal-invalid", {
    external_ref: "MLB-PORTAL-2",
    metadata: { makesafe_job_family: "ordinary_roof_portal" },
    makesafe_details: {
      report_type: null,
      external_ref: "MLB-PORTAL-2",
      external_links: [{ kind: "builder_portal", url: sourceUrl }],
      cycle_number: 3,
      attendance_cycle_id: "cycle-current",
    },
  });
  const validShape = {
    id: "capture-invalid",
    job_id: "portal-invalid",
    attendance_cycle_id: "cycle-current",
    role: "roof_report",
    status: "verified",
    makesafe_fact_version: 1,
    capture_result: "done",
    source_url: sourceUrl,
    source_content_hash: `sha256:${"3".repeat(64)}`,
    builder_reference: "MLB-PORTAL-2",
    captured_at: NOW,
    capture_producer: "capture_portal_evidence.py/v1",
    signal: "submitted/locked observed",
    screenshot_object_key:
      "makesafe-docket-artifacts/portal-captures/job/cycle/roof/image.png",
    screenshot_media_type: "image/png",
    screenshot_content_hash: `sha256:${"4".repeat(64)}`,
    screenshot_size_bytes: 4096,
  };
  assertEquals(portalCapturesFromLedger(source, [validShape]).length, 1);
  assertEquals(
    portalCapturesFromLedger(source, [{
      ...validShape,
      attendance_cycle_id: "cycle-stale",
    }]),
    [],
  );
  assertEquals(
    portalCapturesFromLedger(source, [{
      ...validShape,
      source_url: "https://www.primeeco.tech/share/other",
    }]),
    [],
  );
  const sourceWithoutReference = {
    ...source,
    external_ref: "",
    makesafe_details: {
      ...source.makesafe_details,
      external_ref: "",
    },
  };
  assertEquals(
    portalCapturesFromLedger(sourceWithoutReference, [validShape]).length,
    1,
  );
  assertEquals(
    portalCapturesFromLedger(sourceWithoutReference, [{
      ...validShape,
      builder_reference: "",
    }]),
    [],
  );
  assertEquals(
    portalCapturesFromLedger(source, [{
      ...validShape,
      screenshot_object_key: null,
    }]),
    [],
  );
});

Deno.test("F7 canonical board loader executes the capture-ledger handoff", async () => {
  const { client, calls } = makeCanonicalLoaderClient();
  const rows = await _loadCanonicalMakesafeBoardForTest(client);

  assert(
    calls.some((call) => call.table === "makesafe_portal_capture_revisions"),
  );
  assertEquals(rows.length, 1);
  assertEquals(
    rows[0].computed_status_evidence.portal_capture_revisions.map((row: any) =>
      row.id
    ),
    ["loader-capture-1"],
  );
  assertEquals(
    rows[0].computed_status_evidence.has_current_portal_capture,
    true,
  );
});

Deno.test("F7 observer and canonical loader share one live-board population predicate", async () => {
  assertEquals(
    makesafeBoardJobStatusExclusionFilter(false),
    '("cancelled","archived","lost")',
  );
  assertEquals(
    makesafeBoardJobStatusExclusionFilter(true),
    '("cancelled","lost")',
  );
  assertEquals(isCanonicalLiveMakesafeBoardJobStatus("allocated"), true);
  assertEquals(isCanonicalLiveMakesafeBoardJobStatus("archived"), false);
  assertEquals(isCanonicalLiveMakesafeBoardJobStatus("cancelled"), false);
  assertEquals(isCanonicalLiveMakesafeBoardJobStatus("lost"), false);
  assertEquals(
    ["allocated", "archived", "cancelled", "lost"].map((status) =>
      observerPopulationForJobStatus(status)
    ),
    [
      "canonical_live_board",
      "off_board_observed",
      "off_board_observed",
      "off_board_observed",
    ],
  );

  const { client, calls } = makeCanonicalLoaderClient();
  await _loadCanonicalMakesafeBoardForTest(client);
  assert(
    calls.some((call) =>
      call.table === "jobs" &&
      call.not?.column === "status" &&
      call.not.operator === "in" &&
      call.not.value === makesafeBoardJobStatusExclusionFilter(true)
    ),
  );
});

Deno.test("canonical loader logs explicit degradation evidence for additive evidence read failures", async () => {
  const failures = [
    {
      table: "makesafe_portal_capture_revisions",
      message: "makesafe board portal capture read unavailable",
    },
    {
      table: "makesafe_board_status_current",
      message: "makesafe_board status application read unavailable",
    },
    {
      table: "makesafe_roof_report_drafts",
      message: "own-template roof draft read unavailable",
    },
    {
      table: "makesafe_terminal_proofs_current_v2",
      message: "makesafe terminal proof read unavailable",
    },
  ];

  for (const failure of failures) {
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) =>
      logged.push(args.map(String).join(" "));
    try {
      const { client } = makeCanonicalLoaderClient(failure.table);
      const rows = await _loadCanonicalMakesafeBoardForTest(client);
      assertEquals(rows.length, 1, failure.table);
    } finally {
      console.error = originalError;
    }
    assert(
      logged.some((line) =>
        line.includes(failure.message) &&
        line.includes(`${failure.table} fixture failure`)
      ),
      `${failure.table} failure must be distinguishable from clean absence: ${
        logged.join(" | ")
      }`,
    );
  }
});

Deno.test("historical divergence: unknown stage never vanishes silently", () => {
  const rows = buildCanonicalMakesafeRows([
    baseJob("mystery_status", "job-mystery"),
  ]);
  const ops = projectOpsMakesafeBoard(rows);
  const trade = projectTradeMakesafeBoard(rows, {
    userId: "hugo-id",
    name: "Hugo",
    managedVerticals: ["makesafe"],
  });
  assertEquals(ops.columns.new[0].id, "job-mystery");
  assertEquals(trade.columns.New[0].id, "job-mystery");
  assert(trade.columns.New[0].projection_warning.includes("mystery_status"));
  assertEquals(checkMakesafeBoardParity(rows).unmapped_stage_job_ids, [
    "job-mystery",
  ]);
});

Deno.test("parseMakesafeBoardFields defaults to card; diagnostics opt in to full", () => {
  assertEquals(parseMakesafeBoardFields(null), "card");
  assertEquals(parseMakesafeBoardFields(undefined), "card");
  assertEquals(parseMakesafeBoardFields("card"), "card");
  assertEquals(parseMakesafeBoardFields("slim"), "card");
  assertEquals(parseMakesafeBoardFields("full"), "full");
  assertEquals(parseMakesafeBoardFields("all"), "full");
  assertEquals(parseMakesafeBoardFields(null, "1"), "full");
  assertEquals(parseMakesafeBoardFields("card", "true"), "full");
  // Unknown values stay on the fast path rather than dumping diagnostics.
  assertEquals(parseMakesafeBoardFields("mystery"), "card");
});

Deno.test("parseMakesafeBoardColumnScope defaults to active; full/include_archive widen", () => {
  assertEquals(parseMakesafeBoardColumnScope(null, null, "card"), "active");
  assertEquals(
    parseMakesafeBoardColumnScope(undefined, undefined, "card"),
    "active",
  );
  assertEquals(parseMakesafeBoardColumnScope("active", null, "card"), "active");
  assertEquals(
    parseMakesafeBoardColumnScope("archive", null, "card"),
    "archive",
  );
  assertEquals(parseMakesafeBoardColumnScope("all", null, "card"), "all");
  assertEquals(parseMakesafeBoardColumnScope(null, "1", "card"), "all");
  assertEquals(parseMakesafeBoardColumnScope(null, "true", "card"), "all");
  // fields=full always hauls every column so diagnostics never silently drop history.
  assertEquals(parseMakesafeBoardColumnScope(null, null, "full"), "all");
  assertEquals(parseMakesafeBoardColumnScope("active", null, "full"), "all");
  // Unknown stays on the fast active path.
  assertEquals(
    parseMakesafeBoardColumnScope("mystery", null, "card"),
    "active",
  );
});

Deno.test("active column scope drops archive without moving other cards", () => {
  const full = buildCanonicalMakesafeRows([
    baseJob("new", "job-new"),
    baseJob("allocated", "job-alloc"),
    baseJob("report_ready", "job-ready", {
      has_wo: true,
      has_report_doc: true,
      invoice_status: "draft",
    }),
    baseJob("archive", "job-arch"),
    baseJob("cancelled", "job-cancel", { status: "cancelled" }),
  ], {
    statusApplicationsByJobId: {
      // Overlay parks a Docs Ready card into archive — active scope must drop it,
      // and the census must still count it under archive.
      "job-ready": {
        run_key: "cap-arch",
        source_status: "report_ready",
        before_status: "report_ready",
        after_status: "archive",
        evidence_ref: "captain",
        applied_by: "captain",
        applied_at: NOW,
      },
    },
  }, "card");

  assertEquals(
    full.find((r) => r.id === "job-ready")?.canonical_stage,
    "archive",
  );
  assertEquals(
    full.find((r) => r.id === "job-arch")?.canonical_stage,
    "archive",
  );

  const census = countOpsCanonicalStages(full);
  assertEquals(census.new, 1);
  assertEquals(census.allocated, 1);
  assertEquals(census.report_ready, 0);
  assertEquals(census.archive, 2);
  assertEquals(census.cancelled, 1);

  const active = filterCanonicalRowsByColumnScope(full, "active");
  assertEquals(active.map((r) => r.id).sort(), [
    "job-alloc",
    "job-cancel",
    "job-new",
  ]);
  // Placement of the remaining active cards is unchanged.
  assertEquals(active.find((r) => r.id === "job-new")?.canonical_stage, "new");
  assertEquals(
    active.find((r) => r.id === "job-alloc")?.canonical_stage,
    "allocated",
  );
  assertEquals(
    active.find((r) => r.id === "job-cancel")?.canonical_stage,
    "cancelled",
  );

  const opsActive = projectOpsMakesafeBoard(active, { fields: "card" });
  assertEquals(opsActive.columns.archive.length, 0);
  assertEquals(opsActive.columns.new.length, 1);
  assertEquals(opsActive.columns.allocated.length, 1);
  assertEquals(opsActive.columns.cancelled.length, 1);
  assertEquals(opsActive.row_count, 3);

  const archiveOnly = filterCanonicalRowsByColumnScope(full, "archive");
  assertEquals(archiveOnly.map((r) => r.id).sort(), ["job-arch", "job-ready"]);

  const paged = filterCanonicalRowsByColumnScope(full, "archive", {
    limit: 1,
    offset: 0,
  });
  assertEquals(paged.length, 1);

  const meta = archiveOnDemandMeta({
    scope: "active",
    columnCounts: census,
    archiveReturned: 0,
  });
  assertEquals(meta.included, false);
  assertEquals(meta.total, 2);
  assertEquals(meta.returned, 0);
  assert(meta.fetch.include_archive.includes("include_archive=1"));
  assert(meta.fetch.archive_only.includes("columns=archive"));
  assert(meta.fetch.full_diagnostics.includes("fields=full"));
});

Deno.test("card shape preserves placement and drops diagnostic / detail payloads", () => {
  const full = buildCanonicalMakesafeRows([
    baseJob("report_ready", "job-card", {
      has_wo: true,
      has_report_doc: true,
      invoice_status: "draft",
      site_suburb: "Bertram",
      requesting_company_slug: "mlb",
    }),
  ], {
    notesByJobId: {
      "job-card": [{
        id: "n1",
        detail_json: { text: "ops note", from_ops: true },
        users: { name: "Hugo" },
        created_at: NOW,
      }],
    },
    statusApplicationsByJobId: {
      "job-card": {
        run_key: "cap-1",
        source_status: "report_ready",
        before_status: "report_ready",
        after_status: "archive",
        evidence_ref: "captain",
        applied_by: "captain",
        applied_at: NOW,
      },
    },
  }, "full");
  const card = buildCanonicalMakesafeRows([
    baseJob("report_ready", "job-card", {
      has_wo: true,
      has_report_doc: true,
      invoice_status: "draft",
      site_suburb: "Bertram",
      requesting_company_slug: "mlb",
    }),
  ], {
    statusApplicationsByJobId: {
      "job-card": {
        run_key: "cap-1",
        source_status: "report_ready",
        before_status: "report_ready",
        after_status: "archive",
        evidence_ref: "captain",
        applied_by: "captain",
        applied_at: NOW,
      },
    },
  }, "card");

  // Placement is identical: the captain display overlay still archives the card.
  assertEquals(full[0].canonical_stage, "archive");
  assertEquals(card[0].canonical_stage, "archive");
  assertEquals(full[0].declared_stage, card[0].declared_stage);

  // Diagnostics and detail-view blobs are gone from card.
  assertEquals(card[0].notes, undefined);
  assertEquals(card[0].computed_status_evidence, undefined);
  assertEquals(card[0].derived_stage_v2, undefined);
  assertEquals(card[0].derived_stage_v2_reasons, undefined);
  assertEquals(card[0].roof_report_confirmation, undefined);
  assertEquals(card[0].job_identity, undefined);
  assertEquals(card[0].declared_stage_engine_version, undefined);

  // Presentation keys the card paints without the pipeline dual-fetch.
  assertEquals(card[0].has_wo, true);
  assertEquals(card[0].site_suburb, "Bertram");
  assertEquals(card[0].requesting_company_slug, "mlb");
  assertEquals(card[0].invoice_status, "draft");

  const opsCard = projectOpsMakesafeBoard(card, { fields: "card" });
  assertEquals(opsCard.shape, "card");
  assertEquals(opsCard.rows, undefined);
  assertEquals(opsCard.columns.archive.length, 1);
  assertEquals(opsCard.columns.archive[0].id, "job-card");
  assertEquals(opsCard.row_count, 1);

  // Stripping a full row through projectOpsMakesafeCardRow never moves stage.
  const stripped = projectOpsMakesafeCardRow(full[0]);
  assertEquals(stripped.canonical_stage, full[0].canonical_stage);
  assertEquals(stripped.computed_status_evidence, undefined);
  assertEquals(stripped.notes, undefined);
});

Deno.test("trade visibility is server-shaped: ordinary allocated-only, Hugo all, Khairo make-safe allocated-only", () => {
  const rows = buildCanonicalMakesafeRows([
    baseJob("new", "mine", {
      assignments: [{
        user_id: "ordinary",
        status: "scheduled",
        users: { name: "Ordinary" },
      }],
    }),
    baseJob("allocated", "other", {
      assignments: [{
        user_id: "other-trade",
        status: "scheduled",
        users: { name: "Other" },
      }],
    }),
  ]);

  const ordinary = projectTradeMakesafeBoard(rows, {
    userId: "ordinary",
    name: "Sam Trade",
    role: "installer",
    managedVerticals: [],
  });
  assertEquals(ordinary.rows.map((r) => r.id), ["mine"]);
  assertEquals(ordinary.rows[0].assignments.map((a: any) => a.user_id), [
    "ordinary",
  ]);

  const hugo = projectTradeMakesafeBoard(rows, {
    userId: "hugo",
    name: "Hugo",
    role: "installer",
    managedVerticals: ["makesafe"],
  });
  assertEquals(new Set(hugo.rows.map((r) => r.id)), new Set(["mine", "other"]));
  assertEquals(hugo.permissions.can_allocate, true);

  const khairo = projectTradeMakesafeBoard(rows, {
    userId: "khairo",
    name: "Khairo",
    role: "installer",
    managedVerticals: ["fencing"],
  });
  assertEquals(khairo.rows, []);
  assertEquals(khairo.permissions.fencing_view_only, true);
  assertEquals(khairo.permissions.can_allocate, false);
});

Deno.test("contact actions are always live-linked or explicitly unavailable", () => {
  const [linked] = buildCanonicalMakesafeRows([baseJob("allocated")]);
  assertEquals(linked.contact.client_name, "Kim Client");
  assertEquals(linked.contact.phone, "0400 111 222");
  assertEquals(linked.contact.actions.call.href, "tel:0400111222");
  assertEquals(linked.contact.actions.text.href, "sms:0400111222");
  assert(
    linked.contact.actions.navigate.href.includes(
      encodeURIComponent("10 Sample Street, Perth"),
    ),
  );

  const [missing] = buildCanonicalMakesafeRows([
    baseJob("new", "missing-contact", {
      client_name: null,
      client_phone: null,
      site_address: null,
      site_suburb: null,
    }),
  ]);
  assertEquals(missing.contact.actions.call.available, false);
  assertEquals(missing.contact.actions.call.href, null);
  assertEquals(missing.contact.actions.navigate.available, false);
  assert(missing.contact.actions.call.unavailable_reason.length > 0);
});

Deno.test("client-facing contact name never falls back past jobs.client_name", () => {
  const contact = buildMakesafeContact({ client_name: null }, [{
    status: "active",
    is_primary: true,
    client_name: "Auxiliary contact must not become the site contact",
  }]);
  assertEquals(contact.client_name, null);
});

Deno.test("canonical row carries report/photos, pack/send, notes, age and separates stale substatus", () => {
  const [row] = buildCanonicalMakesafeRows([
    baseJob("allocated", "facts", {
      substatus: "company_contact_required",
      makesafe_details: {
        substatus: "company_contact_required",
        report_received_at: NOW,
        report_type: "roof_report",
      },
      report: { status: "submitted", submitted_at: NOW, cycle_number: 2 },
      report_pack: { status: "drafted", report_doc_id: "doc-1", sent_at: null },
      docs_missing: true,
      missing_docs: ["invoice"],
      age_hours: 60,
    }),
  ], {
    photoCountByJobId: { facts: 7 },
    notesByJobId: {
      facts: [{
        id: "note-1",
        user_id: "trade-1",
        detail_json: { text: "Client not reachable" },
        users: { name: "Hugo" },
        created_at: NOW,
      }],
    },
  });

  assertEquals(row.report.submitted_at, NOW);
  assertEquals(row.report.photo_count, 7);
  assertEquals(row.pack.state, "drafted");
  assertEquals(row.notes[0].text, "Client not reachable");
  assertEquals(row.age.target_hours, 48);
  assertEquals(row.age.target_state, "over_target");
  assertEquals(
    row.blockers.stale_artifacts[0].code,
    "stale_company_contact_substatus",
  );
  assert(
    !row.blockers.real.some((b: any) => b.code === "client_contact_required"),
  );
  assert(
    row.blockers.real.some((b: any) => b.code === "closeout_documents_missing"),
  );
});

Deno.test("canonical row preserves the visible plain-English Captain action", () => {
  const [row] = buildCanonicalMakesafeRows([
    baseJob("allocated", "captain-action", {
      captain_action: {
        code: "attendance_cycle_ruling",
        message:
          "Need you to choose which attendance cycle owns the submitted report.",
        evidence_refs: ["job_service_reports:report-1"],
        since: NOW,
      },
    }),
  ]);

  assertEquals(row.captain_action, {
    code: "attendance_cycle_ruling",
    message:
      "Need you to choose which attendance cycle owns the submitted report.",
    evidence_refs: ["job_service_reports:report-1"],
    since: NOW,
  });
});

Deno.test("canonical board exposes U4 Docs Ready identity and typed blockers without money facts", () => {
  const [ready] = buildCanonicalMakesafeRows([
    baseJob("report_ready", "u4-ready", {
      report_pack: {
        status: "drafted",
        review_state: "READY",
        docket_revision_id: "revision-ready",
        pre_xero_docs_ready: true,
        blockers: [],
        presentation_kind: "ready",
        presentation_reason: null,
        local_invoice_proposal: { total_inc: 999999 },
      },
    }),
  ]);
  assertEquals(ready.pack.docket_revision_id, "revision-ready");
  assertEquals(ready.pack.pre_xero_docs_ready, true);
  assertEquals(ready.pack.drafted, true);
  assertEquals(ready.pack.presentation_kind, "ready");
  assertEquals(ready.pack.state, "drafted");
  assertEquals(ready.blockers.real, []);
  assertEquals("local_invoice_proposal" in ready.pack, false);

  const [blocked] = buildCanonicalMakesafeRows([
    baseJob("trade_report_in", "u4-blocked", {
      report_pack: {
        status: "refused",
        review_state: "U4_BLOCKED",
        docket_revision_id: "revision-blocked",
        pre_xero_docs_ready: false,
        presentation_kind: "refused",
        presentation_reason: "not projected to the board",
        local_invoice_proposal: { total_inc: 999999 },
        blockers: [{
          reason_code: "spine_missing_source",
          reason: "not projected to the board",
          fact: "not projected to the board",
        }],
      },
    }),
  ]);
  assertEquals(blocked.pack.pre_xero_docs_ready, false);
  assertEquals(blocked.pack.presentation_kind, "refused");
  assertEquals(blocked.pack.state, "refused");
  assertEquals(blocked.blockers.real, [{
    code: "spine_missing_source",
    category: "ses_docket",
    docket_revision_id: "revision-blocked",
    fact: "not projected to the board",
  }]);
  assertEquals("local_invoice_proposal" in blocked.pack, false);
});

Deno.test("legacy failed pack over a ready docket presents ready, not failed", () => {
  const [row] = buildCanonicalMakesafeRows([
    baseJob("report_ready", "legacy-failed-ready-docket", {
      report_pack: {
        // Stale legacy status that used to green-tick or red-lie on the board.
        status: "failed",
        review_state: "READY",
        docket_revision_id: "revision-live",
        pre_xero_docs_ready: true,
        blockers: [],
        legacy_pack_status: "failed",
      },
    }),
  ]);
  assertEquals(row.pack.presentation_kind, "ready");
  assertEquals(row.pack.state, "drafted");
  assertEquals(row.pack.pre_xero_docs_ready, true);
  assertEquals(row.pack.legacy_pack_status, "failed");
  assertEquals(row.blockers.real, []);
});

Deno.test("restoration stays explicitly typed and sealed through ops and trade board projections", () => {
  const [canonical] = buildCanonicalMakesafeRows([
    baseJob("new", "restoration-card", {
      type: "insurance",
      job_number: "SWMS-26936",
      metadata: {
        insurance_job_type: "restoration",
        insurance_job_type_label: "Restoration Insurance Work",
        makesafe_job_family: "general_makesafe",
      },
      report_pack: {
        status: "refused",
        review_state: "U4_BLOCKED",
        docket_revision_id: "restoration-revision",
        pre_xero_docs_ready: false,
        presentation_kind: "refused",
        presentation_reason: "no curated report yet",
        blockers: [{
          reason_code: "curated_source_missing",
          reason: "no curated report yet",
          fact: "no curated report yet",
        }],
      },
    }),
  ]);
  assertEquals(canonical.type, "insurance");
  assertEquals(canonical.ses_family, "restoration");
  assertEquals(canonical.ses_family_label, "Restoration");
  assertEquals(canonical.ses_recipe_state, "sealed");
  assertEquals(canonical.makesafe_type, "Restoration");
  assertEquals(canonical.blockers.real, [{
    code: "curated_source_missing",
    category: "ses_docket",
    docket_revision_id: "restoration-revision",
    fact: "no curated report yet",
  }]);

  const trade = projectTradeMakesafeBoard([canonical], {
    userId: "trade-1",
    name: "Hugo",
    role: "installer",
    managedVerticals: ["makesafe"],
  });
  assertEquals(trade.rows[0].ses_family, "restoration");
  assertEquals(trade.rows[0].ses_family_label, "Restoration");
  assertEquals(trade.rows[0].ses_recipe_state, "sealed");
  assertEquals(trade.rows[0].makesafe_type, "Restoration");
});

Deno.test("repair stays explicitly typed and sealed through board projection", () => {
  const [canonical] = buildCanonicalMakesafeRows([
    baseJob("new", "repair-card", {
      metadata: { makesafe_job_family: "repair" },
    }),
  ]);
  assertEquals(canonical.ses_family, "repair");
  assertEquals(canonical.ses_family_label, "Repair");
  assertEquals(canonical.ses_recipe_state, "sealed");
});

Deno.test("captain-applied status is a display overlay and never rewrites declared or raw state", () => {
  const source = baseJob("new", "overlay", {
    substatus: "company_contact_required",
    makesafe_details: {
      substatus: "company_contact_required",
      cycle_number: 1,
    },
  });
  const [row] = buildCanonicalMakesafeRows([source], {
    statusApplicationsByJobId: {
      overlay: {
        run_key: "makesafe-stage1-20260724",
        job_id: "overlay",
        source_status: "new",
        before_status: "new",
        after_status: "allocated",
        evidence_ref: "review://makesafe-board-review-surface-v1",
        applied_by: "captain-approved-cutover",
        applied_at: NOW,
      },
    },
  });

  assertEquals(row.declared_stage, "new");
  assertEquals(row.canonical_stage, "allocated");
  assertEquals(row.canonical_stage_label, "Allocated");
  assertEquals(row.substatus, "company_contact_required");
  assertEquals(
    (source.makesafe_details as any).substatus,
    "company_contact_required",
  );
  assertEquals(row.status_application, {
    // R8 — additive provenance keys. The overlay still binds and the card
    // still lands in the same column; these say WHICH kind of decision it is.
    effect: "override",
    applies_to_display: true,
    decision_kind: "display_override",
    run_key: "makesafe-stage1-20260724",
    before_status: "new",
    after_status: "allocated",
    evidence_ref: "review://makesafe-board-review-surface-v1",
    applied_by: "captain-approved-cutover",
    applied_at: NOW,
    // An ordinary cutover transition carries no duplicate pointer; only the
    // duplicate-survivor archive path populates these.
    duplicate_of_job_id: null,
    duplicate_of_job_number: null,
    duplicate_rule: null,
  });
  assertEquals(row.duplicate_of_job_id, null);
  assertEquals(row.duplicate_of_job_number, null);
});

Deno.test("a duplicate-survivor archive displays as archive and points at its survivor", () => {
  const source = baseJob("allocated", "dup-loser", {
    job_number: "SWMS-26920",
  });
  const [row] = buildCanonicalMakesafeRows([source], {
    statusApplicationsByJobId: {
      "dup-loser": {
        run_key: "makesafe-duplicate-survivors-20260801",
        job_id: "dup-loser",
        source_status: "allocated",
        before_status: "allocated",
        after_status: "archive",
        evidence_ref:
          "docs/evidence/makesafe-duplicate-survivors-2026-08-01.md",
        applied_by: "captain-approved-duplicate-survivors",
        applied_at: NOW,
        duplicate_of_job_id: "job-dup-survivor",
        duplicate_of_job_number: "SWMS-26845",
        duplicate_rule: "activity_evidence",
      },
    },
  });

  // Display moves; the raw declared stage is untouched.
  assertEquals(row.declared_stage, "allocated");
  assertEquals(row.canonical_stage, "archive");
  assertEquals(row.canonical_stage_label, "Archive");
  assertEquals(row.job_state, "scheduled");
  // The pointer is what stops an archived duplicate reading as lost work.
  assertEquals(row.status_application?.duplicate_of_job_number, "SWMS-26845");
  assertEquals(row.status_application?.duplicate_rule, "activity_evidence");
  assertEquals(row.duplicate_of_job_id, "job-dup-survivor");
});

Deno.test("display overlay fails closed when its source is stale or the card is terminal", () => {
  const rows = buildCanonicalMakesafeRows([
    baseJob("new", "stale"),
    baseJob("archive", "terminal"),
    baseJob("new", "closed-job", { status: "closed" }),
  ], {
    statusApplicationsByJobId: {
      stale: {
        source_status: "allocated",
        before_status: "allocated",
        after_status: "trade_report_in",
      },
      terminal: {
        source_status: "archive",
        before_status: "archive",
        after_status: "allocated",
      },
      "closed-job": {
        source_status: "new",
        before_status: "new",
        after_status: "allocated",
      },
    },
  });

  assertEquals(rows[0].canonical_stage, "new");
  assertEquals(rows[0].status_application, null);
  assertEquals(rows[1].canonical_stage, "archive");
  assertEquals(rows[1].computed_status, "archive");
  assertEquals(rows[1].status_application, null);
  assertEquals(rows[2].canonical_stage, "new");
  assertEquals(rows[2].computed_status, "completed");
  assertEquals(rows[2].status_application, null);
});

Deno.test("computed closeout reads the actual ACCREC status, not a synthetic board invoice label", () => {
  const [row] = buildCanonicalMakesafeRows([
    baseJob("allocated", "no-invoice", {
      invoice_status: "invoiced",
      invoice_raw_status: null,
      pack_sent: true,
      report_pack: { status: "sent", sent_at: NOW },
      has_invoice_doc: false,
      has_report_doc: false,
    }),
  ]);

  assertEquals(row.canonical_stage, "allocated");
  assertEquals(row.computed_status, "allocated");
});

Deno.test("same property claim keeps one card per PO and links siblings", () => {
  const rows = buildCanonicalMakesafeRows([
    baseJob("allocated", "po-a", {
      metadata: { builder_claim_ref: "MLB-900", builder_po_number: "PO-1" },
      external_ref: "MLB-900",
    }),
    baseJob("new", "po-b", {
      metadata: { builder_claim_ref: "MLB-900", builder_po_number: "PO-2" },
      external_ref: "MLB-900",
    }),
  ]);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].lineage.one_card_per_po, true);
  assertEquals(rows[0].lineage.siblings[0].job_id, "po-b");
  assertEquals(rows[0].lineage.siblings[0].builder_po_number, "PO-2");
  assertEquals(rows[0].job_identity, {
    contract: "makesafe-job-identity.v1",
    work_order_number: "MLB-900",
    purchase_order_number: "PO-1",
    job_grain_key: null,
    complete: false,
    authority: "typed_job_metadata",
  });
});

Deno.test("trade payload is an allow-list with no pricing or invoice data", () => {
  const [row] = buildCanonicalMakesafeRows([baseJob("allocated")]);
  (row as any).pricing_json = { total: 999 };
  (row as any).xero_invoice = { amount: 999 };
  (row as any).trade_invoices = [{ user_id: "other" }];
  const trade = projectTradeMakesafeBoard([row], {
    userId: "hugo",
    name: "Hugo",
    managedVerticals: ["makesafe"],
  });
  const payload = JSON.stringify(trade);
  assert(!payload.includes("pricing_json"));
  assert(!payload.includes("xero_invoice"));
  assert(!payload.includes("trade_invoices"));
  assert(!payload.includes("999"));
});

Deno.test("terminally accounted synthetic live-fire jobs disappear from both boards", () => {
  const synthetic = baseJob("cancelled", "synthetic-terminal", {
    metadata: {
      synthetic_livefire_marker:
        "SWG-SES-LIVEFIRE-TEST-ONLY-018F7F2C-4DB4-7C61-92C7-2B2B97E0A111",
      synthetic_livefire_terminal_at: NOW,
    },
  });
  assertEquals(isSyntheticLivefireJob(synthetic), true);
  assertEquals(isTerminalSyntheticLivefireJob(synthetic), true);
  assertEquals(buildCanonicalMakesafeRows([synthetic]).length, 1);
  assertEquals(
    buildCanonicalMakesafeRows([synthetic], {
      terminalSyntheticLivefireJobIds: new Set([synthetic.id]),
    }),
    [],
  );

  const lookalike = baseJob("cancelled", "ordinary-cancelled", {
    metadata: { synthetic_livefire_terminal_at: NOW },
  });
  assertEquals(isTerminalSyntheticLivefireJob(lookalike), false);
  assertEquals(buildCanonicalMakesafeRows([lookalike]).length, 1);

  const prefixLookalike = baseJob("cancelled", "prefix-lookalike", {
    metadata: {
      synthetic_livefire_marker: "SWG-SES-LIVEFIRE-TEST-ONLY-not-a-uuid",
      synthetic_livefire_terminal_at: NOW,
    },
  });
  assertEquals(isSyntheticLivefireJob(prefixLookalike), false);
  assertEquals(isTerminalSyntheticLivefireJob(prefixLookalike), false);
});

Deno.test("the archive census excludes exactly what the canonical build excludes", () => {
  const marker =
    "SWG-SES-LIVEFIRE-TEST-ONLY-018F7F2C-4DB4-7C61-92C7-2B2B97E0A111";
  const syntheticArchive = baseJob("archive", "synthetic-archived", {
    metadata: { synthetic_livefire_marker: marker },
  });
  const realArchive = baseJob("archive", "real-archived");
  const active = baseJob("allocated", "job-alloc");
  const terminalIds = new Set([syntheticArchive.id]);

  assertEquals(
    isExcludedTerminalSyntheticBoardRow(syntheticArchive, terminalIds),
    true,
  );
  assertEquals(
    isExcludedTerminalSyntheticBoardRow(realArchive, terminalIds),
    false,
  );
  // A synthetic job whose run has not been terminally accounted stays on board.
  assertEquals(
    isExcludedTerminalSyntheticBoardRow(syntheticArchive, new Set()),
    false,
  );

  const baseRows = [active, realArchive, syntheticArchive];
  // include_archive=1 census: one canonical build over every base row.
  const allScope = countOpsCanonicalStages(
    buildCanonicalMakesafeRows(baseRows, {
      terminalSyntheticLivefireJobIds: terminalIds,
    }, "card"),
  );
  assertEquals(allScope.archive, 1);
  assertEquals(allScope.allocated, 1);

  // Default active census: declared-archive rows are added back outside the
  // build, so they must drop the same terminal synthetic rows.
  const activeScope = countOpsCanonicalStages(
    buildCanonicalMakesafeRows(
      baseRows.filter((row) => row.board_stage !== "archive"),
      { terminalSyntheticLivefireJobIds: terminalIds },
      "card",
    ),
  );
  activeScope.archive +=
    baseRows.filter((row) =>
      row.board_stage === "archive" &&
      !isExcludedTerminalSyntheticBoardRow(row, terminalIds)
    ).length;
  assertEquals(activeScope, allScope);
});

Deno.test("synthetic live-fire jobs are refused before any release operation", async () => {
  const client = {
    from(table: string) {
      assertEquals(table, "jobs");
      return {
        select(columns: string) {
          assertEquals(columns, "id,metadata");
          return {
            in(column: string, ids: string[]) {
              assertEquals(column, "id");
              assertEquals(ids, ["synthetic-job"]);
              return Promise.resolve({
                data: [{
                  id: "synthetic-job",
                  metadata: {
                    synthetic_livefire_marker:
                      "SWG-SES-LIVEFIRE-TEST-ONLY-018F7F2C-4DB4-7C61-92C7-2B2B97E0A111",
                  },
                }],
                error: null,
              });
            },
          };
        },
      };
    },
  };

  await assertRejects(
    () =>
      _assertNoSyntheticLivefireJobsForTest(
        client,
        ["synthetic-job"],
        "release",
      ),
    Error,
    "synthetic_livefire_release_forbidden",
  );
});

Deno.test("synthetic-linked invoices are refused before invoice effects", async () => {
  const marker =
    "SWG-SES-LIVEFIRE-TEST-ONLY-018F7F2C-4DB4-7C61-92C7-2B2B97E0A111";
  const client = {
    from(table: string) {
      if (table === "xero_invoices") {
        return {
          select(columns: string) {
            assertEquals(columns, "job_id");
            return {
              eq(column: string, id: string) {
                assertEquals(column, "xero_invoice_id");
                assertEquals(id, "invoice-1");
                return {
                  maybeSingle: () =>
                    Promise.resolve({
                      data: { job_id: "synthetic-job" },
                      error: null,
                    }),
                };
              },
            };
          },
        };
      }
      assertEquals(table, "jobs");
      return {
        select(columns: string) {
          assertEquals(columns, "id,metadata");
          return {
            in: () =>
              Promise.resolve({
                data: [{
                  id: "synthetic-job",
                  metadata: { synthetic_livefire_marker: marker },
                }],
                error: null,
              }),
          };
        },
      };
    },
  };

  await assertRejects(
    () =>
      _assertNoSyntheticLivefireInvoiceForTest(
        client,
        "invoice-1",
        "void_invoice",
      ),
    Error,
    "synthetic_livefire_release_forbidden",
  );

  const unresolvedClient = {
    from(table: string) {
      assertEquals(table, "xero_invoices");
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: () => Promise.resolve({ data: null, error: null }),
              };
            },
          };
        },
      };
    },
  };
  await assertRejects(
    () =>
      _assertNoSyntheticLivefireInvoiceForTest(
        unresolvedClient,
        "missing",
        "void_invoice",
      ),
    Error,
    "synthetic_livefire_invoice_unresolved",
  );
});

Deno.test("synthetic live-fire release members cannot be approved or executed", async () => {
  const marker =
    "SWG-SES-LIVEFIRE-TEST-ONLY-018F7F2C-4DB4-7C61-92C7-2B2B97E0A111";
  const client = {
    from(table: string) {
      if (table === "makesafe_release_revision_members") {
        return {
          select(columns: string) {
            assertEquals(columns, "job_id");
            return {
              eq(column: string, id: string) {
                assertEquals(column, "release_revision_id");
                assertEquals(id, "release-1");
                return Promise.resolve({
                  data: [{ job_id: "synthetic-job" }],
                  error: null,
                });
              },
            };
          },
        };
      }
      assertEquals(table, "jobs");
      return {
        select(columns: string) {
          assertEquals(columns, "id,metadata");
          return {
            in(column: string, ids: string[]) {
              assertEquals(column, "id");
              assertEquals(ids, ["synthetic-job"]);
              return Promise.resolve({
                data: [{
                  id: "synthetic-job",
                  metadata: { synthetic_livefire_marker: marker },
                }],
                error: null,
              });
            },
          };
        },
      };
    },
  };

  await assertRejects(
    () =>
      _assertNoSyntheticLivefireReleaseRevisionForTest(
        client,
        "release-1",
        "execute_ses_release_revision",
      ),
    Error,
    "synthetic_livefire_release_forbidden",
  );
});
