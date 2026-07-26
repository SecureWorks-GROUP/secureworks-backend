// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type {
  DeterministicCasePlan,
  DeterministicIntakePlan,
  DeterministicSourceItem,
} from "./makesafe_deterministic_intake.ts";
import {
  buildFiveFatesReplayReport,
  catalogueHistoricalEmailShape,
  type DurableCaseRow,
  type HugoBoardObservation,
  type IndependentShapeExpectation,
  structuralHash,
} from "./makesafe_intake_five_fates_replay.ts";
import { assertReadOnlyRequest } from "../../../scripts/replay-makesafe-five-fates.ts";

const RECEIVED = "2026-07-26T00:00:00.000Z";

function source(
  postId: string,
  subject = "NEW WORK ORDER",
): DeterministicSourceItem {
  return {
    postId,
    fromEmail: "dispatch@primeeco.tech",
    subject,
    body:
      "Work Order No: WO-12345\nClient: Example Person\nAddress: 1 Test Road",
    receivedAt: RECEIVED,
    attachments: [],
    links: [],
    direction: "inbound",
  };
}

function planCase(
  key: string,
  postId: string,
  state: DeterministicCasePlan["state"],
  options: {
    reasonCode?: DeterministicCasePlan["reasonCode"];
    blockedReasons?: string[];
    parentRelation?: DeterministicCasePlan["parentRelation"];
  } = {},
): DeterministicCasePlan {
  return {
    instructionKey: key,
    instructionFingerprint: `${key}-fingerprint`,
    lineageClusterKey: `${key}-lineage`,
    parentInstructionKey: options.parentRelation ? "root" : null,
    parentRelation: options.parentRelation || null,
    cycle: options.parentRelation === "reopen_of" ? 2 : 1,
    state,
    reasonCode: options.reasonCode || null,
    blockedReasons: options.blockedReasons || [],
    sourcePostIds: [postId],
    sourceClassifications: [{
      postId,
      instructionKey: key,
      outcome: state === "confirmed_live_job"
        ? "confirmed_canonical_input"
        : state === "blocked_live_job"
        ? "visible_blocked_with_recovery"
        : state === "accounted_non_wo"
        ? "accounted_non_work"
        : "reason_coded_exception",
      reasonCode: options.reasonCode || null,
    }],
  } as unknown as DeterministicCasePlan;
}

function deterministicPlan(
  cases: DeterministicCasePlan[],
): DeterministicIntakePlan {
  const classifications = cases.flatMap((item) => item.sourceClassifications);
  return {
    version: "test",
    aiCalls: 0,
    cases,
    sourceClassifications: classifications,
    totals: {
      sources: classifications.length,
      cases: cases.length,
      confirmed: 0,
      blocked: 0,
      exceptions: 0,
      nonWork: 0,
      unaccounted: 0,
    },
  };
}

function shapeExpectation(
  item: DeterministicSourceItem,
  shapeId: string,
  expectedFate: IndependentShapeExpectation["expected_fate"],
): IndependentShapeExpectation {
  return {
    shape_id: shapeId,
    count: 1,
    builder: "fixture",
    tail: false,
    expected_fate: expectedFate,
    fate_reason: "independent fixture expectation",
    independent_handling_assessment: "handled",
    identifies: "sanitized fixture",
    example_source_hash: structuralHash(item.postId),
  };
}

function hugoBoard(
  visibleJobIds: string[],
  observedAt = "2026-07-26T00:04:00.000Z",
): HugoBoardObservation {
  return {
    observed_at: observedAt,
    method: "shared_server_read_model_with_production_hugo_profile",
    contract_version: "makesafe-board@fixture",
    viewer_profile_hash: "hugo-profile-fixture",
    visible_job_ids: visibleJobIds,
    permissions: { sees_all_makesafes: true, can_allocate: true },
  };
}

Deno.test("U1 diagnostics keep planner, durable ledger and independent ground truth separate", () => {
  const sources = [
    source("live"),
    source("blocked"),
    source("exception"),
    source("revision", "RE: Revised work order"),
    source("nonwork", "Thank you"),
  ];
  const cases = [
    planCase("instruction-live", "live", "confirmed_live_job"),
    planCase("instruction-blocked", "blocked", "blocked_live_job", {
      blockedReasons: ["missing:client_phone"],
    }),
    planCase("instruction-exception", "exception", "exception", {
      reasonCode: "below_identity_floor",
    }),
    planCase("instruction-revision", "revision", "confirmed_live_job", {
      parentRelation: "revision_of",
    }),
    planCase("instruction-nonwork", "nonwork", "accounted_non_wo", {
      reasonCode: "non_makesafe",
    }),
  ];
  const durableCases: DurableCaseRow[] = cases.map((item, index) => ({
    id: `case-${index}`,
    instruction_key: item.instructionKey,
    lineage_id: `lineage-${index}`,
    parent_case_id: item.parentRelation ? "case-root" : null,
    parent_relation: item.parentRelation,
    state: item.state,
    reason_code: item.reasonCode,
    blocked_reasons: item.blockedReasons,
    job_id: ["confirmed_live_job", "blocked_live_job"].includes(item.state)
      ? `job-${index}`
      : null,
  }));
  const expectations = [
    shapeExpectation(sources[0], "REAL-LIVE", "live_job"),
    shapeExpectation(sources[1], "REAL-BLOCKED", "blocked_live_job"),
    shapeExpectation(sources[2], "REAL-EXCEPTION", "reason_coded_exception"),
    shapeExpectation(
      sources[3],
      "REAL-REVISION",
      "revision_or_reattendance",
    ),
    shapeExpectation(sources[4], "REAL-NONWORK", "accounted_non_work"),
  ];
  const report = buildFiveFatesReplayReport({
    plan: deterministicPlan(cases),
    sources: sources.map((item) => ({
      source: item,
      rawBody: "<html></html>",
    })),
    caseSources: sources.map((item, index) => ({
      post_id: item.postId,
      case_id: `case-${index}`,
    })),
    cases: durableCases,
    jobs: durableCases.flatMap((item, index) =>
      item.job_id
        ? [{
          id: item.job_id,
          created_at: index === 3
            ? "2026-07-25T00:00:00.000Z"
            : "2026-07-26T00:02:00.000Z",
        }]
        : []
    ),
    sourceExceptions: [],
    independentShapes: expectations,
    hugoBoard: hugoBoard(["job-0", "job-1", "job-3"]),
    nowIso: "2026-07-26T00:04:00.000Z",
  });

  assertEquals(report.proof_status, "not_proved");
  assertEquals(report.corpus.planner_self_consistent, 5);
  assertEquals(report.corpus.durable_fated, 5);
  assertEquals(report.independent_ground_truth.catalogue_shapes, 5);
  assertEquals(report.independent_ground_truth.planner_matches, 5);
  assertEquals(report.independent_ground_truth.durable_matches, 5);
  assertEquals(report.planner_fate_counts, {
    live_job: 1,
    blocked_live_job: 1,
    reason_coded_exception: 1,
    revision_or_reattendance: 1,
    accounted_non_work: 1,
  });
  assertEquals(report.five_minute_hugo_visibility.measured, 1);
  assertEquals(report.five_minute_hugo_visibility.within_law, 1);
  assertEquals("correct" in report.corpus, false);
  for (const verdict of report.verdicts) {
    assert(verdict.correlation.source_instruction_id.startsWith("source:"));
    assert(verdict.correlation.instruction_id?.startsWith("instruction:"));
    assertEquals("correct" in verdict, false);
    assert(!JSON.stringify(verdict).includes("primeeco.tech"));
    assert(!JSON.stringify(verdict).includes("Example Person"));
  }
});

Deno.test("U1 diagnostics name a missing durable fate without converting planner agreement into correctness", () => {
  const item = source("real-shape-unaccounted");
  const intakeCase = planCase(
    "instruction-unaccounted",
    item.postId,
    "exception",
    { reasonCode: "adapter_parse_failure" },
  );
  const report = buildFiveFatesReplayReport({
    plan: deterministicPlan([intakeCase]),
    sources: [{ source: item }],
    caseSources: [],
    cases: [],
    jobs: [],
    sourceExceptions: [],
    independentShapes: [
      shapeExpectation(item, "REAL-UNACCOUNTED", "live_job"),
    ],
    hugoBoard: hugoBoard([]),
    nowIso: "2026-07-26T01:00:00.000Z",
  });

  assertEquals(report.corpus.durable_missing, 1);
  assertEquals(report.independent_ground_truth.planner_matches, 0);
  assertEquals(report.independent_ground_truth.durable_missing, 1);
  assert(report.verdicts[0].diagnostics.includes("source_has_no_durable_fate"));
  assert(
    report.verdicts[0].diagnostics.includes(
      "ground_truth_live_example_not_hugo_visible",
    ),
  );
});

Deno.test("a source-level handoff exception is a durable reason-coded fate without a case", () => {
  const item = source("source-handoff-exception");
  const intakeCase = planCase(
    "instruction-handoff-exception",
    item.postId,
    "exception",
    { reasonCode: "below_identity_floor" },
  );
  const report = buildFiveFatesReplayReport({
    plan: deterministicPlan([intakeCase]),
    sources: [{ source: item }],
    caseSources: [],
    cases: [],
    jobs: [],
    sourceExceptions: [{
      post_id: item.postId,
      change_type: "intake_exception_scan_completed_without_case_fate",
      exclusion_reason: "scan_completed_without_case_fate",
    }],
    independentShapes: [
      shapeExpectation(item, "HANDOFF-EXCEPTION", "reason_coded_exception"),
    ],
    hugoBoard: hugoBoard([]),
    nowIso: "2026-07-26T01:00:00.000Z",
  });

  assertEquals(report.corpus.durable_missing, 0);
  assertEquals(report.verdicts[0].durable_fate, "reason_coded_exception");
  assertEquals(
    report.verdicts[0].durable_reason_code,
    "scan_completed_without_case_fate",
  );
  assertEquals(
    report.verdicts[0].diagnostics.includes("source_has_no_durable_fate"),
    false,
  );
});

Deno.test("U1 five-minute law stops at Hugo projection observation, not job creation", () => {
  const item = source("real-shape-late-visible");
  const intakeCase = planCase(
    "instruction-late",
    item.postId,
    "confirmed_live_job",
  );
  const report = buildFiveFatesReplayReport({
    plan: deterministicPlan([intakeCase]),
    sources: [{ source: item }],
    caseSources: [{ post_id: item.postId, case_id: "case-late" }],
    cases: [{
      id: "case-late",
      instruction_key: intakeCase.instructionKey,
      lineage_id: "lineage-late",
      state: "confirmed_live_job",
      reason_code: null,
      blocked_reasons: [],
      job_id: "job-late",
    }],
    jobs: [{ id: "job-late", created_at: "2026-07-26T00:01:00.000Z" }],
    sourceExceptions: [],
    independentShapes: [shapeExpectation(item, "REAL-LIVE", "live_job")],
    hugoBoard: hugoBoard(["job-late"], "2026-07-26T00:05:01.000Z"),
    nowIso: "2026-07-26T00:06:00.000Z",
  });

  const latency = report.verdicts[0].five_minute_hugo_visibility;
  assertEquals(latency.job_created_latency_seconds, 60);
  assertEquals(latency.visibility_upper_bound_seconds, 301);
  assertEquals(latency.within_law, false);
  assertEquals(report.five_minute_hugo_visibility.breached, 1);
});

Deno.test("diagnostic axis catalogue is structural and contains no source content", () => {
  const item = source("shape", "FWD: NEW WORK ORDER - MLB-REDACTED");
  const shape = catalogueHistoricalEmailShape({
    source: {
      ...item,
      attachments: [{
        id: "attachment",
        sourcePostId: item.postId,
        name: "Work Order.pdf",
        contentType: "application/pdf",
        storagePath: "private/path.pdf",
        status: "uploaded",
      }],
      links: [{
        url: "https://portal.invalid/item",
        sourcePostId: item.postId,
      }],
    },
    rawBody: "<html>Client: Example Person</html>",
  });

  assertEquals(shape.subject_form, "forward");
  assertEquals(shape.attachment_form, "pdf");
  assertEquals(shape.link_form, "link");
  assert(!JSON.stringify(shape).includes("Example Person"));
  assert(!JSON.stringify(shape).includes("MLB-REDACTED"));
});

Deno.test("production replay transport rejects every mutation method", () => {
  assertReadOnlyRequest();
  assertReadOnlyRequest({ method: "HEAD" });
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    assertThrows(
      () => assertReadOnlyRequest({ method }),
      Error,
      "forbids",
    );
  }
});
