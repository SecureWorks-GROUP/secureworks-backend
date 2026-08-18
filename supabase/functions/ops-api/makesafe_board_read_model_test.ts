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
  _enrichMakesafeBoardJobForTest,
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
  presentMakesafeBoardSubstatus,
  projectMakesafePortalCaptures,
  projectOpsMakesafeBoard,
  projectOpsMakesafeCardRow,
  projectTradeMakesafeBoard,
  TRADE_MAKESAFE_COLUMNS,
} from "./makesafe_board_read_model.ts";
import { MAKESAFE_SUBSTATUS_AWAITING_PORTAL_COMPLETION } from "./makesafe_computed_status.ts";
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

// ── Release 12 fixture evidence ─────────────────────────────────────────────
//
// R12 flipped placement authority to the corrected evidence engine, so a card's
// column is no longer whatever `board_stage` claims: it is what the evidence on
// the card proves. A fixture therefore has to CARRY that evidence. `evidenceFor`
// is the single place that knows how, so when a predicate in the engine moves,
// one helper moves with it instead of twenty inlined blobs.
//
// Every fixture here is the physical make-safe family (`general_makesafe`), the
// path `baseJob` already declares.
const SUBMITTED_REPORT = {
  status: "submitted",
  cycle_number: 1,
  submitted_at: NOW,
};
const READY_UNSENT_PACK = {
  status: "drafted",
  review_state: "READY",
  report_doc_id: "doc-report",
  invoice_doc_id: "doc-invoice",
  swms_doc_id: "doc-swms",
  docket_revision_id: "rev-ready",
  pre_xero_docs_ready: true,
  blockers: [],
};

/** Base-row overrides that make the corrected engine derive `stage`. */
function evidenceFor(stage: string): Record<string, unknown> {
  switch (stage) {
    // No allocation and no report: the card exists and nothing else is proved.
    case "new":
      return { assignments: [] };
    // An active assignment, no submitted report.
    case "allocated":
      return {};
    // Trade report submitted this cycle (plus the photo floor from `extras`).
    case "trade_report_in":
      return { report: SUBMITTED_REPORT };
    // Report-in evidence PLUS an assembled, READY, unsent pack with a current
    // draft invoice — the captain's "one click from sending".
    case "report_ready":
      return {
        report: SUBMITTED_REPORT,
        report_pack: READY_UNSENT_PACK,
        invoice_id: "invoice-row-ready",
        invoice_status: "draft",
        invoice_qualifies_as_current_draft: true,
        has_report_doc: true,
        has_invoice_doc: true,
        has_swms_doc: true,
        missing_docs: [],
      };
    // Raw state claims the job is finished, but no issued invoice corroborates
    // it and no other evidence proves any column. A captain question.
    case "decision_required":
      return { status: "complete", assignments: [] };
    // Finished and corroborated by an issued invoice inside the seven-day clock.
    case "completed":
      return {
        status: "complete",
        invoice_status: "invoiced",
        invoice_date: "2026-07-18T00:00:00Z",
      };
    case "archive":
      return { status: "archived" };
    case "cancelled":
      return { status: "cancelled" };
    default:
      throw new Error(`evidenceFor has no recipe for stage ${stage}`);
  }
}

/**
 * Completion photos are PLACEMENT evidence since R12 (card mode loads them
 * too), so any fixture that has to clear the floor gets it from here.
 */
function photoFloorFor(...ids: string[]): Record<string, number> {
  return Object.fromEntries(ids.map((id) => [id, 8]));
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
      // Historical roof cards use the generic kind even though the family and
      // validated capture role establish that this is the roof-report portal.
      external_links: [{ kind: "builder_portal", url: sourceUrl }],
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
  // R12 cutover: this used to declare each stage with `board_stage`. Placement
  // now follows the corrected engine, so every fixture carries the evidence for
  // its own stage — and the guarantee is unchanged: one card, exactly one ops
  // column, exactly one trade column. It now also covers `decision_required`,
  // which R12 promoted from a cutover-stopper to a real rendered column.
  const ids = OPS_MAKESAFE_STAGES.map((stage) => `job-${stage}`);
  const rows = buildCanonicalMakesafeRows(
    OPS_MAKESAFE_STAGES.map((stage) =>
      baseJob(stage, `job-${stage}`, evidenceFor(stage))
    ),
    { photoCountByJobId: photoFloorFor(...ids), computedAt: NOW },
  );
  // The fixtures really do derive the stage they are named for; without this
  // the column assertions below could pass on a board that placed nothing.
  assertEquals(rows.map((r) => r.canonical_stage), [...OPS_MAKESAFE_STAGES]);
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
  // R12: `decision_required` joins the captain's Archive lane — a captain
  // question is not trade work, so it stays off the trade's active columns.
  assertEquals(
    trade.columns.Archive.map((r) => r.canonical_stage),
    ["decision_required", "completed", "archive", "cancelled"],
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

Deno.test("F7 board read model consumes one exact-cycle screenshot-backed ledger revision, and R12 places the card on it", () => {
  // Evolved from "…without moving canonical stage". The F7 guarantee that
  // survives is about the LEDGER: exactly one exact-cycle, screenshot-backed
  // revision is projected, with its provenance intact. What changed at the R12
  // cutover is the consequence — that accepted capture is now placement
  // evidence, so the card lands on the column the evidence proves
  // (`trade_report_in`) instead of staying wherever the legacy ladder had it.
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
  assertEquals(row.canonical_stage, "trade_report_in");
  assertEquals(row.report.state, "submitted");
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

Deno.test("Prime completion is monotonic: a later unreachable result retains the last locked capture and report state", () => {
  const sourceUrl = "https://www.primeeco.tech/share/locked-then-expired";
  const source = baseJob("allocated", "locked-then-expired", {
    external_ref: "MLB-LOCKED-THEN-EXPIRED",
    metadata: { makesafe_job_family: "roof_report" },
    makesafe_details: {
      substatus: "waiting_on_trade_report",
      report_type: "roof_report",
      external_ref: "MLB-LOCKED-THEN-EXPIRED",
      external_links: [{ kind: "roof_report", url: sourceUrl }],
      cycle_number: 1,
      attendance_cycle_id: "cycle-current",
    },
  });
  const done = {
    id: "capture-done",
    job_id: "locked-then-expired",
    attendance_cycle_id: "cycle-current",
    role: "roof_report",
    status: "verified",
    makesafe_fact_version: 1,
    capture_result: "done",
    source_url: sourceUrl,
    source_content_hash: `sha256:${"7".repeat(64)}`,
    builder_reference: "MLB-LOCKED-THEN-EXPIRED",
    captured_at: "2026-08-02T12:00:00Z",
    capture_producer: "capture_portal_evidence.py/v1",
    signal: "form locked/submitted, 21 of 23 answered",
    screenshot_object_key:
      "makesafe-docket-artifacts/portal-captures/job/cycle/roof/locked.png",
    screenshot_media_type: "image/png",
    screenshot_content_hash: `sha256:${"8".repeat(64)}`,
    screenshot_size_bytes: 4096,
  };
  const unreachable = {
    ...done,
    id: "capture-unreachable",
    status: "rejected",
    makesafe_fact_version: 2,
    capture_result: "unreachable",
    source_content_hash: `sha256:${"9".repeat(64)}`,
    captured_at: "2026-08-13T07:10:00Z",
    signal: "Prime link expired or no longer active",
    screenshot_object_key: null,
    screenshot_media_type: null,
    screenshot_content_hash: null,
    screenshot_size_bytes: null,
  };

  const [row] = buildCanonicalMakesafeRows([source], {
    portalCaptureRowsByJobId: {
      "locked-then-expired": [done, unreachable],
    },
    computedAt: NOW,
  });

  assertEquals(row.canonical_stage, "trade_report_in");
  assertEquals(row.report.state, "submitted");
  assertEquals(row.pack.closeout_documents.report, true);
  assertEquals(row.computed_status_evidence.has_current_portal_capture, true);
  assertEquals(
    row.computed_status_evidence.portal_capture_revisions.map((
      capture: any,
    ) => [capture.id, capture.status, capture.screenshot_available]),
    [
      ["capture-unreachable", "unreachable", false],
      ["capture-done", "done", true],
    ],
  );
});

Deno.test("Prime completion is monotonic for the screenshot-less trade tick too", () => {
  const sourceUrl = "https://www.primeeco.tech/share/tick-then-expired";
  const source = baseJob("allocated", "tick-then-expired", {
    external_ref: "MLB-TICK-THEN-EXPIRED",
    metadata: { makesafe_job_family: "roof_report" },
    makesafe_details: {
      substatus: "waiting_on_trade_report",
      report_type: "roof_report",
      external_ref: "MLB-TICK-THEN-EXPIRED",
      external_links: [{ kind: "roof_report", url: sourceUrl }],
      cycle_number: 1,
      attendance_cycle_id: "cycle-current",
    },
  });
  const tick = {
    id: "trade-tick-done",
    job_id: "tick-then-expired",
    attendance_cycle_id: "cycle-current",
    role: "roof_report",
    status: "verified",
    makesafe_fact_version: 1,
    capture_result: "done",
    source_url: sourceUrl,
    source_content_hash: `sha256:${"a".repeat(64)}`,
    builder_reference: "MLB-TICK-THEN-EXPIRED",
    captured_at: "2026-08-02T12:00:00Z",
    captured_by: "trade-1",
    capture_producer: "trade_portal_confirmation/v1",
    signal: "assigned trade confirmed roof report done",
    screenshot_object_key: null,
    screenshot_media_type: null,
    screenshot_content_hash: null,
    screenshot_size_bytes: null,
  };
  const unreachable = {
    ...tick,
    id: "reader-unreachable",
    status: "rejected",
    makesafe_fact_version: 2,
    capture_result: "unreachable",
    source_content_hash: `sha256:${"b".repeat(64)}`,
    captured_at: "2026-08-13T07:10:00Z",
    capture_producer: "capture_portal_evidence.py/v1",
    signal: "Prime link expired or no longer active",
  };

  const [row] = buildCanonicalMakesafeRows([source], {
    portalCaptureRowsByJobId: {
      "tick-then-expired": [tick, unreachable],
    },
    computedAt: NOW,
  });

  assertEquals(row.canonical_stage, "trade_report_in");
  assertEquals(row.report.state, "submitted");
  assertEquals(row.pack.closeout_documents.report, true);
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

Deno.test("F7 board capture projection follows producer-owned reference authority and still rejects bad evidence", () => {
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
  // The deterministic writer validates builder_reference against the canonical
  // U4 input before committing. That value can differ from the card's legacy
  // makesafe_job_details.external_ref (Gwelup) or legitimately be empty
  // (Kardinya). The board must not re-validate it against a different authority.
  assertEquals(
    portalCapturesFromLedger(source, [{
      ...validShape,
      builder_reference: "MLB-CANONICAL-U4",
    }]).length,
    1,
  );
  assertEquals(
    portalCapturesFromLedger(source, [{
      ...validShape,
      builder_reference: "",
    }]).length,
    1,
  );
  // The trade producer derives the legacy card reference server-side and must
  // still bind to it exactly; only the deterministic U4 writer owns the
  // canonical/empty-reference exception.
  assertEquals(
    portalCapturesFromLedger(source, [{
      ...validShape,
      builder_reference: "MLB-WRONG-TRADE-REF",
      capture_producer: "trade_portal_confirmation/v1",
      captured_by: "trade-1",
      screenshot_object_key: null,
      screenshot_media_type: null,
      screenshot_content_hash: null,
      screenshot_size_bytes: null,
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

Deno.test("free-form portal evidence cannot self-issue trusted proof markers", () => {
  const source = baseJob("allocated", "hostile-portal-proof", {
    makesafe_details: {
      portal_captures: [{
        status: "done",
        role: "roof_report",
        attested_producer: "capture_portal_evidence.py/v1",
        legacy_verified: true,
        validated_ledger_capture: true,
      }],
    },
  });
  const [capture] = projectMakesafePortalCaptures(source, []);
  assertEquals(capture.attested_producer, undefined);
  assertEquals((capture as any).legacy_verified, undefined);
  assertEquals(capture.validated_ledger_capture, undefined);
});

Deno.test("Prime placement: locked and submitted-plus-expired roofs both reach TRI by evidence", () => {
  const lockedUrl = "https://www.primeeco.tech/share/locked-roof";
  const expiredUrl = "https://www.primeeco.tech/share/expired-roof";
  const roof = (id: string, url: string) =>
    baseJob("allocated", id, {
      metadata: { makesafe_job_family: "roof_report" },
      makesafe_details: {
        report_type: "roof_report",
        external_ref: `MLB-LEGACY-${id}`,
        external_links: [{ kind: "builder_portal", url }],
        cycle_number: 1,
        attendance_cycle_id: `cycle-${id}`,
      },
      attendance_cycle_id: `cycle-${id}`,
      report: SUBMITTED_REPORT,
    });
  const capture = (
    id: string,
    url: string,
    result: "done" | "unreachable",
  ) => ({
    id: `capture-${id}`,
    job_id: id,
    attendance_cycle_id: `cycle-${id}`,
    role: "roof_report",
    status: result === "done" ? "verified" : "rejected",
    makesafe_fact_version: 1,
    capture_result: result,
    source_url: url,
    source_content_hash: `sha256:${"7".repeat(64)}`,
    // Canonical U4 authority deliberately differs from the legacy detail ref;
    // the expired card models U4's legitimate empty-reference shape.
    builder_reference: result === "done" ? "MLB-CANONICAL" : "",
    captured_at: NOW,
    captured_by: "capture-runner",
    capture_producer: "capture_portal_evidence.py/v1",
    signal: result === "done"
      ? "form locked/submitted"
      : "builder link is expired or no longer active",
    screenshot_object_key: result === "done"
      ? "makesafe-docket-artifacts/portal-captures/locked.png"
      : null,
    screenshot_media_type: result === "done" ? "image/png" : null,
    screenshot_content_hash: result === "done"
      ? `sha256:${"8".repeat(64)}`
      : null,
    screenshot_size_bytes: result === "done" ? 4096 : null,
  });

  const rows = buildCanonicalMakesafeRows([
    roof("locked-roof", lockedUrl),
    roof("expired-roof", expiredUrl),
  ], {
    portalCaptureRowsByJobId: {
      "locked-roof": [capture("locked-roof", lockedUrl, "done")],
      "expired-roof": [capture(
        "expired-roof",
        expiredUrl,
        "unreachable",
      )],
    },
    computedAt: NOW,
  });

  assertEquals(rows.map((row) => row.canonical_stage), [
    "trade_report_in",
    "trade_report_in",
  ]);
  assertEquals(rows[1].derived_stage_v2_conflicts, []);
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
  // R12 cutover: the old fixture produced an unknown canonical stage by giving
  // a base job an unrecognised `board_stage`. Placement no longer reads
  // `board_stage`, so that route is closed and the engine can only ever emit a
  // known stage. The guarantee itself is about the PROJECTIONS, not about how
  // the bad value arrived — a row carrying a canonical stage neither projection
  // recognises must still be parked in `new`, flagged, and counted — so the
  // fixture is now a raw row that carries the unknown value directly. That is
  // also the honest shape of the real risk after R12: a drifted or replayed row
  // reaching the projection from somewhere other than today's engine.
  const rows = [{
    contract_version: "makesafe-board.v1",
    id: "job-mystery",
    job_number: "SWMS-job-mystery",
    type: "makesafe",
    job_state: "scheduled",
    declared_stage: "mystery_status",
    canonical_stage: "mystery_status",
    canonical_stage_label: "mystery_status",
    assignments: [],
    contact: { client_name: "Kim Client", phone: null, address: null },
  }];
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

Deno.test("card report tick stays false for a current-cycle submitted service report without a report document", () => {
  const id = "submitted-report-no-document";
  const [card] = buildCanonicalMakesafeRows([
    baseJob("trade_report_in", id, {
      report: SUBMITTED_REPORT,
      has_report_doc: false,
    }),
  ], {
    photoCountByJobId: photoFloorFor(id),
    computedAt: NOW,
  }, "card");

  assertEquals(card.canonical_stage, "trade_report_in");
  assertEquals(card.pack.closeout_documents.report, false);
});

Deno.test("card report tick stays false without a submitted report or report document", () => {
  const [card] = buildCanonicalMakesafeRows(
    [
      baseJob("allocated", "no-report-evidence", {
        has_report_doc: false,
      }),
    ],
    { computedAt: NOW },
    "card",
  );

  assertEquals(card.canonical_stage, "allocated");
  assertEquals(card.pack.closeout_documents.report, false);
});

Deno.test("Heathridge SWMS-261174: temp-fence trade report + DRAFT invoice is not Docs Ready without a bound report PDF", () => {
  // Live 2026-08-14: AJBR-70781 / temp_fence_makesafe. Trade submitted a
  // service report (13 photos). Pack drafted, INV-1205 DRAFT bound,
  // invoice_doc_id set, pack.report_doc_id NULL, no makesafe_report row.
  // The board still placed the card in Docs Ready and greened the report
  // tile off trade-report-in. A submitted checklist is TRI, never Docs Ready.
  const id = "heathridge-261174";
  const [card] = buildCanonicalMakesafeRows([
    baseJob("report_ready", id, {
      job_number: "SWMS-261174",
      external_ref: "AJBR-70781",
      site_suburb: "Heathridge",
      metadata: {
        builder_claim_ref: "AJBR-70781",
        builder_po_number: "PO-70781",
        makesafe_job_family: "temp_fence_makesafe",
      },
      report: SUBMITTED_REPORT,
      report_pack: {
        id: "26dab9d2-63eb-419f-9d90-58dae19c7f39",
        status: "drafted",
        review_state: "READY",
        report_doc_id: null,
        invoice_doc_id: "invoice-1205",
        pre_xero_docs_ready: true,
        blockers: [
          { code: "canonical_draft_pack_output_missing" },
          { code: "curated_source_missing" },
        ],
      },
      invoice_status: "DRAFT",
      invoice_qualifies_as_current_draft: true,
      has_report_doc: false,
      has_invoice_doc: true,
      has_swms_doc: false,
    }),
  ], {
    photoCountByJobId: photoFloorFor(id),
    computedAt: NOW,
  }, "card");

  assertEquals(card.ses_family, "temporary_fencing");
  assertEquals(card.canonical_stage, "trade_report_in");
  assertEquals(card.pack.closeout_documents.report, false);
  assertEquals(card.pack.closeout_documents.invoice, true);
});

Deno.test("repair cards do not inherit a make-safe Docs Ready floor from a trade report alone", () => {
  const id = "repair-trade-report-only";
  const [card] = buildCanonicalMakesafeRows([
    baseJob("report_ready", id, {
      metadata: {
        builder_claim_ref: "MLB-REPAIR",
        builder_po_number: "PO-REPAIR",
        makesafe_job_family: "repair",
      },
      report: SUBMITTED_REPORT,
      report_pack: {
        ...READY_UNSENT_PACK,
        report_doc_id: null,
      },
      invoice_status: "DRAFT",
      invoice_qualifies_as_current_draft: true,
      has_report_doc: false,
      has_invoice_doc: true,
    }),
  ], {
    photoCountByJobId: photoFloorFor(id),
    computedAt: NOW,
  }, "card");

  assertEquals(card.ses_family, "repair");
  assertEquals(card.canonical_stage, "trade_report_in");
  assertEquals(card.pack.closeout_documents.report, false);
});

Deno.test("card report tick stays off for an attach without pack.report_doc_id", () => {
  // Attach tick is not a bind — physical closeout report requires the pack
  // pointer. has_report_doc alone must not green the tile.
  const [card] = buildCanonicalMakesafeRows(
    [
      baseJob("allocated", "report-document-only", {
        has_report_doc: true,
      }),
    ],
    { computedAt: NOW },
    "card",
  );

  assertEquals(card.canonical_stage, "allocated");
  assertEquals(card.pack.closeout_documents.report, false);
});

Deno.test("card report tick is done only when pack.report_doc_id is bound", () => {
  const [card] = buildCanonicalMakesafeRows(
    [
      baseJob("allocated", "report-bound", {
        has_report_doc: true,
        report_pack: {
          status: "drafted",
          report_doc_id: "doc-report-bound",
        },
      }),
    ],
    { computedAt: NOW },
    "card",
  );

  assertEquals(card.canonical_stage, "allocated");
  assertEquals(card.pack.closeout_documents.report, true);
  assertEquals(card.pack.report_doc_id, "doc-report-bound");
});

Deno.test("Docs Ready refuses has_report_doc without pack.report_doc_id (attach ≠ bind)", () => {
  // Live honesty class: 7 of 15 report_ready cards had null report_doc_id
  // while has_report_doc was true. Placement must stay Trade Report In.
  const id = "attach-not-bind-docs-ready";
  const [card] = buildCanonicalMakesafeRows([
    baseJob("report_ready", id, {
      report: SUBMITTED_REPORT,
      report_pack: {
        ...READY_UNSENT_PACK,
        report_doc_id: null,
      },
      invoice_status: "DRAFT",
      invoice_qualifies_as_current_draft: true,
      has_report_doc: true,
      has_invoice_doc: true,
      has_swms_doc: true,
    }),
  ], {
    photoCountByJobId: photoFloorFor(id),
    computedAt: NOW,
  }, "card");

  assertEquals(card.canonical_stage, "trade_report_in");
  assertEquals(card.pack.report_doc_id, null);
  assertEquals(card.has_report_doc, true);
  assertEquals(card.pack.closeout_documents.report, false);
  assertEquals(card.pack.presentation_kind === "ready", false);
});

Deno.test("Docs Ready refuses has_swms_doc without pack.swms_doc_id (attach ≠ bind)", () => {
  // MLB physical requires SWMS; an attached SWMS document without the pack
  // pointer must not present ready or place Docs Ready.
  const id = "attach-not-bind-swms";
  const [card] = buildCanonicalMakesafeRows([
    baseJob("report_ready", id, {
      report: SUBMITTED_REPORT,
      report_pack: {
        ...READY_UNSENT_PACK,
        swms_doc_id: null,
      },
      // Stale pipeline stamp claiming ready must be re-derived off live binds.
      pack_presentation: { kind: "ready", state: "drafted" },
      invoice_status: "DRAFT",
      invoice_qualifies_as_current_draft: true,
      has_report_doc: true,
      has_invoice_doc: true,
      has_swms_doc: true,
    }),
  ], {
    photoCountByJobId: photoFloorFor(id),
    computedAt: NOW,
  }, "card");

  assertEquals(card.canonical_stage, "trade_report_in");
  assertEquals(card.pack.swms_doc_id, null);
  assertEquals(card.pack.closeout_documents.swms, false);
  assertEquals(card.pack.presentation_kind === "ready", false);
  assertEquals(card.pack.pre_xero_docs_ready, false);
});

Deno.test("SWMS-261243 assessment pack cannot look ready without family report evidence", () => {
  const id = "assess-261243";
  const [card] = buildCanonicalMakesafeRows([
    baseJob("new", id, {
      job_number: "SWMS-261243",
      metadata: { makesafe_job_family: "assessment_quote" },
      makesafe_details: {
        substatus: "company_contact_required",
        report_type: "assessment_report",
        cycle_number: 1,
        external_links: [],
      },
      assignments: [],
      report_pack: {
        status: "drafted",
        review_state: "READY",
        report_doc_id: null,
        invoice_doc_id: null,
        swms_doc_id: null,
        docket_revision_id: "rev-assess-ready-stamp",
        pre_xero_docs_ready: true,
        blockers: [],
      },
      has_report_doc: false,
      has_wo: false,
      invoice_status: "not_ready",
    }),
  ], { computedAt: NOW }, "card");

  assertEquals(card.ses_family, "assessment_quote");
  assertEquals(card.canonical_stage, "new");
  assertEquals(card.pack.presentation_kind, "incomplete");
  assertEquals(card.pack.pre_xero_docs_ready, false);
  assertEquals(card.pack.report_doc_id, null);
});

Deno.test("canonical placement floors durable ready/processed report states at TRI without inventing Docs Ready", () => {
  const readyId = "legacy-ready-report";
  const processedId = "legacy-processed-report";
  const rows = buildCanonicalMakesafeRows([
    baseJob("allocated", readyId, {
      report_status: "ready_for_reporting_skill",
      makesafe_details: {
        substatus: "waiting_on_trade_report",
        cycle_number: 1,
        report_received_at: NOW,
      },
      report_pack: { status: "drafted", report_doc_id: null },
      invoice_raw_status: "DRAFT",
      invoice_qualifies_as_current_draft: true,
      has_report_doc: false,
    }),
    baseJob("allocated", processedId, {
      status: "completed",
      report_status: "processed",
      makesafe_details: {
        substatus: "waiting_on_trade_report",
        cycle_number: 1,
        report_received_at: NOW,
      },
      report_pack: { status: "drafted", report_doc_id: null },
      invoice_raw_status: null,
      has_report_doc: false,
    }),
  ], { computedAt: NOW });

  assertEquals(rows.map((row) => row.declared_stage), [
    "allocated",
    "allocated",
  ]);
  assertEquals(rows.map((row) => row.canonical_stage), [
    "trade_report_in",
    "trade_report_in",
  ]);
  assertEquals(rows.map((row) => row.report.state), [
    "ready_for_reporting_skill",
    "processed",
  ]);
  assert(rows.every((row) => row.canonical_stage !== "report_ready"));
});

Deno.test("captain lock: MLB physical cards without SWMS stay Trade Report In", () => {
  for (const jobNumber of ["SWMS-261190", "SWMS-261179", "SWMS-261175"]) {
    const id = `missing-swms-${jobNumber}`;
    const [card] = buildCanonicalMakesafeRows([
      baseJob("trade_report_in", id, {
        job_number: jobNumber,
        report: SUBMITTED_REPORT,
        report_pack: {
          ...READY_UNSENT_PACK,
          review_state: null,
          swms_doc_id: null,
        },
        invoice_status: "DRAFT",
        invoice_qualifies_as_current_draft: true,
        has_report_doc: true,
        has_invoice_doc: false,
        has_swms_doc: false,
      }),
    ], {
      photoCountByJobId: photoFloorFor(id),
      computedAt: NOW,
    }, "card");

    assertEquals(card.canonical_stage, "trade_report_in", jobNumber);
    assertEquals(card.pack.drafted, true);
    assertEquals(card.pack.closeout_documents.invoice, true);
    assertEquals(card.pack.closeout_documents.swms, false);

    const readyId = `with-swms-${jobNumber}`;
    const [readyCard] = buildCanonicalMakesafeRows([
      baseJob("trade_report_in", readyId, {
        job_number: jobNumber,
        report: SUBMITTED_REPORT,
        report_pack: {
          ...READY_UNSENT_PACK,
          review_state: null,
        },
        invoice_status: "DRAFT",
        invoice_qualifies_as_current_draft: true,
        has_report_doc: true,
        has_invoice_doc: false,
        has_swms_doc: true,
      }),
    ], {
      photoCountByJobId: photoFloorFor(readyId),
      computedAt: NOW,
    }, "card");

    assertEquals(readyCard.canonical_stage, "report_ready", jobNumber);
    assertEquals(readyCard.pack.closeout_documents, {
      report: true,
      invoice: true,
      swms: true,
    });
  }
});

Deno.test("card ticks consume the same drafted-pack artifacts as placement", () => {
  const id = "mlb-physical-with-swms";
  const [card] = buildCanonicalMakesafeRows([
    baseJob("report_ready", id, {
      ...evidenceFor("report_ready"),
      has_report_doc: false,
      has_invoice_doc: false,
      has_swms_doc: false,
    }),
  ], {
    photoCountByJobId: photoFloorFor(id),
    computedAt: NOW,
  }, "card");

  assertEquals(card.canonical_stage, "report_ready");
  assertEquals(card.pack.drafted, true);
  assertEquals(card.pack.closeout_documents, {
    report: true,
    invoice: true,
    swms: true,
  });
});

Deno.test("AJS physical Docs Ready never blocks on a missing SWMS", () => {
  const id = "ajs-physical-no-swms";
  const [card] = buildCanonicalMakesafeRows([
    baseJob("report_ready", id, {
      ...evidenceFor("report_ready"),
      requesting_company_name: "AJS",
      external_ref: "AJBR-70001",
      metadata: {
        builder_claim_ref: "AJBR-70001",
        builder_po_number: "PO-AJS-1",
        makesafe_job_family: "physical_makesafe",
      },
      report_pack: { ...READY_UNSENT_PACK, swms_doc_id: null },
      has_swms_doc: false,
    }),
  ], {
    photoCountByJobId: photoFloorFor(id),
    computedAt: NOW,
  }, "card");

  assertEquals(card.canonical_stage, "report_ready");
  assertEquals(card.pack.closeout_documents.swms, false);
});

Deno.test("active column scope drops archive without moving other cards", () => {
  // R12 cutover: the fixtures now derive their stages from evidence rather than
  // declaring them with `board_stage`, and the overlay anchors on that derived
  // stage. The scope invariants under test are unchanged.
  const full = buildCanonicalMakesafeRows([
    baseJob("new", "job-new", evidenceFor("new")),
    baseJob("allocated", "job-alloc", evidenceFor("allocated")),
    baseJob("report_ready", "job-ready", {
      ...evidenceFor("report_ready"),
      has_wo: true,
    }),
    baseJob("archive", "job-arch", evidenceFor("archive")),
    baseJob("cancelled", "job-cancel", evidenceFor("cancelled")),
  ], {
    photoCountByJobId: photoFloorFor("job-ready"),
    computedAt: NOW,
    statusApplicationsByJobId: {
      // Overlay parks a Docs Ready card into archive — active scope must drop it,
      // and the census must still count it under archive. Its `source_status`
      // now has to match the DERIVED stage, which the evidence supplies.
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
  // R12 cutover: card mode now loads and projects the same placement evidence
  // full mode does (portal captures, holds, photo counts), because the
  // corrected engine reads them. That makes "card places identically to full"
  // a stronger claim than it was, so both builds below are given the SAME
  // evidence and the same extras — including the photo floor, which card mode
  // previously never even loaded.
  const source = () =>
    baseJob("report_ready", "job-card", {
      ...evidenceFor("report_ready"),
      has_wo: true,
      site_suburb: "Bertram",
      requesting_company_slug: "mlb",
    });
  const application = {
    run_key: "cap-1",
    source_status: "report_ready",
    before_status: "report_ready",
    after_status: "archive",
    evidence_ref: "captain",
    applied_by: "captain",
    applied_at: NOW,
  };
  const full = buildCanonicalMakesafeRows([source()], {
    photoCountByJobId: photoFloorFor("job-card"),
    computedAt: NOW,
    notesByJobId: {
      "job-card": [{
        id: "n1",
        detail_json: { text: "ops note", from_ops: true },
        users: { name: "Hugo" },
        created_at: NOW,
      }],
    },
    statusApplicationsByJobId: { "job-card": application },
  }, "full");
  const card = buildCanonicalMakesafeRows([source()], {
    photoCountByJobId: photoFloorFor("job-card"),
    computedAt: NOW,
    statusApplicationsByJobId: { "job-card": application },
  }, "card");

  // Placement is identical: the captain display overlay still archives the card.
  assertEquals(full[0].canonical_stage, "archive");
  assertEquals(card[0].canonical_stage, "archive");
  assertEquals(full[0].declared_stage, card[0].declared_stage);
  // R12 stamps which engine placed the card, in both shapes and identically.
  assertEquals(
    card[0].placement_engine_version,
    full[0].placement_engine_version,
  );
  assert(String(card[0].placement_engine_version).endsWith("+overlay-r12"));

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
  assertEquals(card[0].report_doc_id, "doc-report");
  assertEquals(card[0].has_report_doc, true);
  assertEquals(card[0].invoice_id, "invoice-row-ready");
  assertEquals(full[0].report_doc_id, "doc-report");
  assertEquals(full[0].has_report_doc, true);
  assertEquals(full[0].invoice_id, "invoice-row-ready");

  const opsCard = projectOpsMakesafeBoard(card, { fields: "card" });
  assertEquals(opsCard.shape, "card");
  assertEquals(opsCard.rows, undefined);
  assertEquals(opsCard.columns.archive.length, 1);
  assertEquals(opsCard.columns.archive[0].id, "job-card");
  assertEquals(opsCard.columns.archive[0].report_doc_id, "doc-report");
  assertEquals(opsCard.columns.archive[0].has_report_doc, true);
  assertEquals(opsCard.columns.archive[0].invoice_id, "invoice-row-ready");
  assertEquals(opsCard.columns.archive[0].pack.report_doc_id, "doc-report");
  assertEquals(opsCard.columns.archive[0].pack.invoice_doc_id, "doc-invoice");
  assertEquals(opsCard.columns.archive[0].pack.swms_doc_id, "doc-swms");
  assertEquals(opsCard.row_count, 1);

  // Stripping a full row through projectOpsMakesafeCardRow never moves stage
  // and never loses the record of which engine placed it.
  const stripped = projectOpsMakesafeCardRow(full[0]);
  assertEquals(stripped.canonical_stage, full[0].canonical_stage);
  assertEquals(
    stripped.placement_engine_version,
    full[0].placement_engine_version,
  );
  assertEquals(stripped.computed_status_evidence, undefined);
  assertEquals(stripped.notes, undefined);
  assertEquals(stripped.report_doc_id, "doc-report");
  assertEquals(stripped.has_report_doc, true);
  assertEquals(stripped.invoice_id, "invoice-row-ready");
});

Deno.test("card JSON always includes report and invoice coordinates", () => {
  const enriched = _enrichMakesafeBoardJobForTest(
    baseJob("report_ready", "job-direct-coordinates"),
    { substatus: "waiting_on_trade_report", cycle_number: 1 },
    [],
    SUBMITTED_REPORT,
    {
      id: "invoice-row-direct",
      xero_invoice_id: "xero-direct",
      job_id: "job-direct-coordinates",
      invoice_type: "ACCREC",
      status: "DRAFT",
      reference: "SWMS-job-direct-coordinates",
    },
    [{ id: "doc-report-direct", type: "makesafe_report" }],
    false,
    {
      ...READY_UNSENT_PACK,
      report_doc_id: "doc-report-direct",
    },
  );
  const [withEvidence] = buildCanonicalMakesafeRows([enriched], {}, "card");
  assertEquals(withEvidence.report_doc_id, "doc-report-direct");
  assertEquals(withEvidence.has_report_doc, true);
  assertEquals(withEvidence.invoice_id, "invoice-row-direct");
  assertEquals(withEvidence.pack.report_doc_id, "doc-report-direct");
  assertEquals(withEvidence.pack.invoice_doc_id, "doc-invoice");

  const [withoutEvidence] = buildCanonicalMakesafeRows(
    [baseJob("new", "job-empty-coordinates", { assignments: [] })],
    {},
    "card",
  );
  for (const key of ["report_doc_id", "has_report_doc", "invoice_id"]) {
    assert(key in withoutEvidence, `${key} must be present on every card`);
  }
  assertEquals(withoutEvidence.report_doc_id, null);
  assertEquals(withoutEvidence.has_report_doc, false);
  assertEquals(withoutEvidence.invoice_id, null);

  const staleReattend = _enrichMakesafeBoardJobForTest(
    baseJob("trade_report_in", "job-stale-coordinates"),
    {
      substatus: "admin_to_send_report",
      external_ref: "MLB-OLD",
      reattend_count: 1,
      last_reattend_at: "2026-07-19T12:00:00Z",
      attendance_cycle_id: "cycle-2",
      cycle_number: 2,
    },
    [],
    {
      ...SUBMITTED_REPORT,
      attendance_cycle_id: "cycle-2",
      cycle_number: 2,
    },
    {
      id: "invoice-prior-cycle",
      xero_invoice_id: "xero-prior-cycle",
      job_id: "job-stale-coordinates",
      invoice_type: "ACCREC",
      status: "DRAFT",
      reference: "MLB-OLD",
      created_at: "2026-07-18T12:00:00Z",
    },
    [{ id: "doc-prior-cycle", type: "makesafe_report" }],
    false,
    {
      ...READY_UNSENT_PACK,
      report_doc_id: "doc-prior-cycle",
      cycle_attribution: null,
    },
  );
  const [staleCard] = buildCanonicalMakesafeRows(
    [staleReattend],
    {},
    "card",
  );
  assertEquals(staleCard.report_doc_id, null);
  assertEquals(staleCard.has_report_doc, false);
  assertEquals(staleCard.invoice_id, null);
});

Deno.test("cancelled detail block keys on the derived stage, not a stale board_stage", () => {
  // A builder-cancelled job whose stored board_stage never caught up: R12
  // derives `cancelled` from job status, and the reason/note/by/at must render
  // with the card in the Cancelled column instead of vanishing.
  const rows = buildCanonicalMakesafeRows(
    [
      baseJob("allocated", "job-stale-cancel", {
        status: "cancelled",
        cancel_reason: "builder_cancelled",
        cancel_note: "WO withdrawn by MLB",
        cancelled_by: "ops",
        cancelled_at: NOW,
      }),
    ],
    { computedAt: NOW },
    "full",
  );
  assertEquals(rows[0].canonical_stage, "cancelled");
  assertEquals(rows[0].declared_stage, "allocated");
  assertEquals(rows[0].cancelled, {
    reason: "builder_cancelled",
    note: "WO withdrawn by MLB",
    by: "ops",
    at: NOW,
  });
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

Deno.test("presentMakesafeBoardSubstatus demotes unbacked ready_to_invoice by family", () => {
  // Pure presentation helper: ready_to_invoice is an operator CLAIM and may
  // only surface when report-in evidence backs it.
  assertEquals(
    presentMakesafeBoardSubstatus({
      rawSubstatus: "ready_to_invoice",
      reportInSatisfied: false,
      detail: { report_type: "roof_report" },
      job: { metadata: { makesafe_job_family: "roof_report" } },
    }),
    {
      substatus: MAKESAFE_SUBSTATUS_AWAITING_PORTAL_COMPLETION,
      declared_substatus: "ready_to_invoice",
      demoted: true,
    },
  );
  assertEquals(
    presentMakesafeBoardSubstatus({
      rawSubstatus: "ready_to_invoice",
      reportInSatisfied: false,
      detail: {},
      job: { metadata: { makesafe_job_family: "general_makesafe" } },
    }),
    {
      substatus: "waiting_on_trade_report",
      declared_substatus: "ready_to_invoice",
      demoted: true,
    },
  );
  assertEquals(
    presentMakesafeBoardSubstatus({
      rawSubstatus: "ready_to_invoice",
      reportInSatisfied: true,
      detail: { report_type: "roof_report" },
      job: { metadata: { makesafe_job_family: "roof_report" } },
    }),
    {
      substatus: "ready_to_invoice",
      declared_substatus: "ready_to_invoice",
      demoted: false,
    },
  );
  assertEquals(
    presentMakesafeBoardSubstatus({
      rawSubstatus: "waiting_on_trade_report",
      reportInSatisfied: false,
      detail: { report_type: "roof_report" },
      job: {},
    }).demoted,
    false,
  );
});

Deno.test("ready_to_invoice cannot appear on Allocated roofs without portal capture (SWMS-261113/261123 class)", () => {
  // Live defect: stored substatus ready_to_invoice while report is still
  // waiting, no portal capture, no invoice. Engine correctly keeps allocated;
  // the board must not paint the unbacked "ready" claim.
  const source = baseJob("allocated", "261113", {
    job_number: "SWMS-261113",
    status: "accepted",
    substatus: "ready_to_invoice",
    metadata: { makesafe_job_family: "roof_report" },
    makesafe_details: {
      substatus: "ready_to_invoice",
      report_type: "roof_report",
      external_ref: "MLB-261113",
      external_links: [{
        kind: "roof_report",
        url: "https://www.primeeco.tech/share/no-capture-yet",
      }],
      cycle_number: 1,
      attendance_cycle_id: "cycle-261113",
    },
    report: null,
    report_status: "waiting_on_trade_report",
    invoice_qualifies_as_current_draft: false,
  });

  const [row] = buildCanonicalMakesafeRows([source], { computedAt: NOW });
  assertEquals(row.canonical_stage, "allocated");
  assertEquals(row.report.state, "waiting_on_trade_report");
  assertEquals(row.substatus, MAKESAFE_SUBSTATUS_AWAITING_PORTAL_COMPLETION);
  assertEquals(row.substatus, "awaiting_portal_completion");
  assert(
    row.substatus !== "ready_to_invoice",
    "unbacked ready_to_invoice must not appear on the board",
  );
  assertEquals(
    row.blockers.stale_artifacts.some((a: any) =>
      a.code === "stale_ready_to_invoice_substatus"
    ),
    true,
  );

  const ops = projectOpsMakesafeBoard([row]);
  const card = ops.columns.allocated.find((r: any) =>
    r.job_number === "SWMS-261113"
  );
  assert(card, "card stays Allocated");
  assertEquals(card.substatus, "awaiting_portal_completion");

  const trade = projectTradeMakesafeBoard([row], {
    userId: "ops-reviewer",
    role: "ops_manager",
    managedVerticals: ["makesafe"],
  });
  const tradeCard = trade.columns.Allocated.find((r: any) =>
    r.job_number === "SWMS-261113"
  );
  assert(tradeCard, "trade board keeps the card Allocated");
  assertEquals(tradeCard.substatus, "awaiting_portal_completion");
});

Deno.test("ready_to_invoice surfaces only when portal lock evidence backs it", () => {
  const sourceUrl = "https://www.primeeco.tech/share/roof-ready-backed";
  const source = baseJob("allocated", "roof-ready-backed", {
    job_number: "SWMS-261123",
    status: "accepted",
    substatus: "ready_to_invoice",
    metadata: { makesafe_job_family: "roof_report" },
    makesafe_details: {
      substatus: "ready_to_invoice",
      report_type: "roof_report",
      external_ref: "MLB-261123",
      external_links: [{ kind: "roof_report", url: sourceUrl }],
      cycle_number: 1,
      attendance_cycle_id: "cycle-261123",
    },
    report: null,
    report_status: "waiting_on_trade_report",
  });
  const revision = {
    id: "capture-roof-ready",
    job_id: "roof-ready-backed",
    attendance_cycle_id: "cycle-261123",
    role: "roof_report",
    status: "verified",
    makesafe_fact_version: 1,
    capture_result: "done",
    source_url: sourceUrl,
    source_content_hash: `sha256:${"c".repeat(64)}`,
    builder_reference: "MLB-261123",
    captured_at: NOW,
    capture_producer: "capture_portal_evidence.py/v1",
    signal: "submitted/locked observed",
    screenshot_object_key:
      "makesafe-docket-artifacts/portal-captures/job/cycle/roof/image.png",
    screenshot_media_type: "image/png",
    screenshot_content_hash: `sha256:${"d".repeat(64)}`,
    screenshot_size_bytes: 4096,
  };

  const [row] = buildCanonicalMakesafeRows([source], {
    portalCaptureRowsByJobId: { "roof-ready-backed": [revision] },
    computedAt: NOW,
  });

  // Capture is placement evidence (at least TRI); the stored claim may stand.
  assertEquals(row.report.state, "submitted");
  assertEquals(row.substatus, "ready_to_invoice");
  assertEquals(
    row.blockers.stale_artifacts.some((a: any) =>
      a.code === "stale_ready_to_invoice_substatus"
    ),
    false,
  );
});

Deno.test("unbacked ready_to_invoice on physical cards presents waiting_on_trade_report", () => {
  const [row] = buildCanonicalMakesafeRows([
    baseJob("allocated", "physical-unbacked-ready", {
      substatus: "ready_to_invoice",
      metadata: { makesafe_job_family: "general_makesafe" },
      makesafe_details: {
        substatus: "ready_to_invoice",
        cycle_number: 1,
      },
      report: null,
      report_status: "waiting_on_trade_report",
    }),
  ], { computedAt: NOW });

  assertEquals(row.canonical_stage, "allocated");
  assertEquals(row.substatus, "waiting_on_trade_report");
  assertEquals(
    row.blockers.stale_artifacts[0],
    {
      code: "stale_ready_to_invoice_substatus",
      source: "unbacked_operator_claim",
      declared_substatus: "ready_to_invoice",
      presented_substatus: "waiting_on_trade_report",
    },
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
        report_doc_id: "doc-report",
        swms_doc_id: "doc-swms",
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
        report_doc_id: "doc-report",
        swms_doc_id: "doc-swms",
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
  assertEquals(canonical.makesafe_type, "Repair");
});

Deno.test("repair family authority in ses_family or report_type leaves the Captain Decision column", () => {
  const fixtures = [
    {
      id: "repair-from-ses-family",
      metadata: { ses_family: "repair" },
      detail: {},
    },
    {
      id: "repair-from-report-type",
      metadata: {},
      detail: { report_type: "repair" },
    },
  ];

  for (const fixture of fixtures) {
    const [canonical] = buildCanonicalMakesafeRows([
      baseJob("new", fixture.id, {
        status: "accepted",
        assignments: [],
        substatus: "company_contact_required",
        metadata: fixture.metadata,
        makesafe_details: {
          substatus: "company_contact_required",
          cycle_number: 1,
          ...fixture.detail,
        },
      }),
    ], { computedAt: NOW });

    assertEquals(canonical.ses_family, "repair", fixture.id);
    assertEquals(canonical.ses_family_label, "Repair", fixture.id);
    assertEquals(canonical.ses_recipe_state, "sealed", fixture.id);
    assertEquals(canonical.makesafe_type, "Repair", fixture.id);
    assertEquals(canonical.canonical_stage, "new", fixture.id);
    assertEquals(canonical.derived_stage_v2_conflicts, [], fixture.id);
    assertEquals(canonical.blockers.real, [{
      code: "client_contact_required",
      category: "client_availability",
    }], fixture.id);
  }
});

Deno.test("repair family authority preserves a genuine Captain Decision", () => {
  const [canonical] = buildCanonicalMakesafeRows([
    baseJob("decision_required", "repair-with-terminal-conflict", {
      status: "complete",
      assignments: [],
      metadata: { ses_family: "repair" },
      makesafe_details: {
        report_type: "repair",
        substatus: "company_contact_required",
        cycle_number: 1,
      },
    }),
  ], { computedAt: NOW });

  assertEquals(canonical.ses_family, "repair");
  assertEquals(canonical.ses_recipe_state, "sealed");
  assertEquals(canonical.canonical_stage, "decision_required");
  assertEquals(canonical.derived_stage_v2_conflicts, [
    "terminal_without_issued_invoice",
    "terminal_without_supporting_evidence",
  ]);
});

Deno.test("captain-applied status is a display overlay and never rewrites declared or raw state", () => {
  // R12 cutover: the overlay's `source_status` is matched against the DERIVED
  // stage now, not the declared one, so the card carries the evidence that
  // derives `new` (no allocation, no report). The guarantee is untouched: an
  // overlay moves the DISPLAY and rewrites neither the declared stage nor any
  // raw state on the source row.
  const source = baseJob("new", "overlay", {
    ...evidenceFor("new"),
    substatus: "company_contact_required",
    makesafe_details: {
      substatus: "company_contact_required",
      cycle_number: 1,
    },
  });
  const [row] = buildCanonicalMakesafeRows([source], {
    computedAt: NOW,
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
  // R12 cutover: all three refusals now anchor on the DERIVED stage. The card
  // shapes are chosen so each refusal is still the one being tested —
  //  - `stale`:     derives `new`, the overlay claims a source of `allocated`;
  //  - `terminal`:  derives `archive` from its archived job state, and a
  //                 terminal derived stage can never be overridden;
  //  - `closed-job`: derives `allocated` and its overlay names that exact
  //                 source, so the ONLY thing refusing it is the terminal raw
  //                 job state — which is the guard this row is here to prove.
  const rows = buildCanonicalMakesafeRows([
    baseJob("new", "stale", evidenceFor("new")),
    baseJob("archive", "terminal", evidenceFor("archive")),
    baseJob("new", "closed-job", {
      ...evidenceFor("allocated"),
      status: "closed",
    }),
  ], {
    computedAt: NOW,
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
        source_status: "allocated",
        before_status: "allocated",
        after_status: "trade_report_in",
      },
    },
  });

  assertEquals(rows[0].canonical_stage, "new");
  assertEquals(rows[0].status_application, null);
  assertEquals(rows[1].canonical_stage, "archive");
  assertEquals(rows[1].computed_status, "archive");
  assertEquals(rows[1].status_application, null);
  assertEquals(rows[2].canonical_stage, "allocated");
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
  // R12 cutover: the archive rows now derive `archive` from an archived job
  // state rather than declaring it with `board_stage`. The invariant is
  // unchanged — the census added back OUTSIDE the canonical build must exclude
  // exactly the rows the build itself excludes.
  const syntheticArchive = baseJob("archive", "synthetic-archived", {
    ...evidenceFor("archive"),
    metadata: {
      makesafe_job_family: "general_makesafe",
      synthetic_livefire_marker: marker,
    },
  });
  const realArchive = baseJob(
    "archive",
    "real-archived",
    evidenceFor("archive"),
  );
  const active = baseJob("allocated", "job-alloc", evidenceFor("allocated"));
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
