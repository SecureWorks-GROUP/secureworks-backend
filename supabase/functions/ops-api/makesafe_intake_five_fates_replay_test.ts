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

Deno.test("U1 five-fates replay proves exactly one durable fate and correlation per source", () => {
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
          // Revision jobs legitimately pre-date the revision source. The clean
          // five-minute metric applies only to the root live-job fate.
          created_at: index === 3
            ? "2026-07-25T00:00:00.000Z"
            : "2026-07-26T00:02:00.000Z",
        }]
        : []
    ),
    nowIso: "2026-07-26T00:03:00.000Z",
  });

  assertEquals(report.corpus.sources, 5);
  assertEquals(report.corpus.correct, 5);
  assertEquals(report.corpus.silent_disappearances, 0);
  assertEquals(report.fate_counts, {
    live_job: 1,
    blocked_live_job: 1,
    reason_coded_exception: 1,
    revision_or_reattendance: 1,
    accounted_non_work: 1,
  });
  assertEquals(report.five_minute_live_job.measured, 1);
  assertEquals(report.five_minute_live_job.within_law, 1);
  for (const verdict of report.verdicts) {
    assert(verdict.correlation.source_instruction_id.startsWith("source:"));
    assert(verdict.correlation.instruction_id?.startsWith("instruction:"));
    assert(!JSON.stringify(verdict).includes("primeeco.tech"));
    assert(!JSON.stringify(verdict).includes("Example Person"));
  }
});

Deno.test("U1 five-fates replay calls an email with no durable case a silent disappearance", () => {
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
    nowIso: "2026-07-26T01:00:00.000Z",
  });

  assertEquals(report.corpus.silent_disappearances, 1);
  assertEquals(report.corpus.incorrect, 1);
  assertEquals(report.verdicts[0].why, ["source_has_no_durable_fate"]);
});

Deno.test("U1 clean live-job replay fails the measured five-minute law", () => {
  const item = source("real-shape-late-live");
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
    jobs: [{ id: "job-late", created_at: "2026-07-26T00:05:01.000Z" }],
    nowIso: "2026-07-26T00:06:00.000Z",
  });

  assertEquals(report.five_minute_live_job.breached, 1);
  assertEquals(report.verdicts[0].correct, false);
  assertEquals(report.verdicts[0].why, [
    "clean_live_job_exceeded_five_minutes",
  ]);
});

Deno.test("historical shape catalogue is structural and contains no source content", () => {
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
  assertThrows(
    () => assertReadOnlyRequest({ method: "POST" }),
    Error,
    "forbids",
  );
  assertThrows(
    () => assertReadOnlyRequest({ method: "PATCH" }),
    Error,
    "forbids",
  );
  assertThrows(
    () => assertReadOnlyRequest({ method: "PUT" }),
    Error,
    "forbids",
  );
  assertThrows(
    () => assertReadOnlyRequest({ method: "DELETE" }),
    Error,
    "forbids",
  );
});
