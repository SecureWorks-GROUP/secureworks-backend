// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  MakesafeAttendanceCycleBindingRecoveryError,
  type RoofCycleBindingRecoverySnapshot,
  runRoofCycleBindingRecovery,
} from "./makesafe_attendance_cycle_binding_recovery.ts";

const JOB_NUMBER = "SWMS-261079";
const JOB_ID = "00000000-0000-4000-8000-000000261079";
const BUILDER_REFERENCE = "MLB-TEST-ROOF";

function snapshot(jobNumber = JOB_NUMBER): RoofCycleBindingRecoverySnapshot {
  return {
    job: {
      id: JOB_ID,
      jobNumber,
      type: "makesafe",
      status: "accepted",
      family: "roof_report",
    },
    detail: {
      jobId: JOB_ID,
      externalRef: BUILDER_REFERENCE,
      reportType: "roof_report",
      cycleNumber: 1,
      attendanceCycleId: null,
      cycleAttribution: null,
    },
    cycles: [],
    intakeCases: [{
      id: "00000000-0000-4000-8000-000000000001",
      state: "confirmed_live_job",
      jobId: JOB_ID,
      targetJobId: null,
      instructionKey: "builder:test/po:one",
      builderWorkOrder: BUILDER_REFERENCE,
      builderPurchaseOrder: "PO-TEST-ONE",
      externalRef: BUILDER_REFERENCE,
    }],
    evidenceCounts: {
      assignments: 0,
      serviceReports: 0,
      media: 0,
      packs: 0,
      portalCaptures: 0,
      roofReportDrafts: 0,
      docketRevisions: 0,
      roofReportDocuments: 0,
    },
  };
}

function harness(initial = snapshot()) {
  const state = structuredClone(initial);
  const writes: string[] = [];
  return {
    writes,
    current: () => structuredClone(state),
    deps: {
      loadSnapshot: async () => structuredClone(state),
      bindInitialCycle: async ({
        jobId,
        cycleNumber,
        openReason,
        expectedCaseId,
        expectedCycleCount,
        expectedExistingCycleId,
        requireZeroOperationalEvidence,
      }: {
        jobId: string;
        cycleNumber: number;
        openReason: string;
        expectedCaseId: string;
        expectedCycleCount: 0 | 1;
        expectedExistingCycleId: string | null;
        requireZeroOperationalEvidence: boolean;
      }) => {
        writes.push(`atomic-bind:${jobId}:${cycleNumber}:${openReason}`);
        if (
          state.cycles.length !== expectedCycleCount ||
          state.intakeCases[0]?.id !== expectedCaseId ||
          (expectedCycleCount === 1 &&
            state.cycles[0]?.id !== expectedExistingCycleId) ||
          (requireZeroOperationalEvidence &&
            Object.values(state.evidenceCounts).some((count) => count !== 0))
        ) {
          throw new Error("atomic guard refused drift");
        }
        if (
          !state.detail || state.detail.jobId !== jobId ||
          state.detail.cycleNumber !== cycleNumber ||
          state.detail.attendanceCycleId !== null ||
          state.detail.cycleAttribution !== null
        ) throw new Error("atomic detail guard refused drift");
        const cycleCreated = expectedCycleCount === 0;
        const attendanceCycleId = cycleCreated
          ? "00000000-0000-4000-8000-000000000010"
          : state.cycles[0].id;
        if (cycleCreated) {
          state.cycles.push({
            id: attendanceCycleId,
            jobId,
            cycleNumber,
            openReason,
          });
        }
        state.detail.attendanceCycleId = attendanceCycleId;
        state.detail.cycleAttribution = "bound";
        return {
          attendanceCycleId,
          cycleNumber,
          cycleCreated,
          cycleBound: true,
        };
      },
    },
  };
}

async function preview(test: ReturnType<typeof harness>) {
  return await runRoofCycleBindingRecovery({
    job_numbers: [JOB_NUMBER],
    dry_run: true,
    plan_token: null,
  }, test.deps);
}

async function applyPreviewed(test: ReturnType<typeof harness>) {
  const planned = await preview(test);
  return await runRoofCycleBindingRecovery({
    job_numbers: [JOB_NUMBER],
    dry_run: false,
    plan_token: planned.plan_token as string,
  }, test.deps);
}

Deno.test("five-card recovery is dry-run first and materializes only from exact canonical zero-evidence state", async () => {
  const test = harness();
  const result = await runRoofCycleBindingRecovery({
    job_numbers: [JOB_NUMBER],
    dry_run: true,
    plan_token: null,
  }, test.deps);

  assertEquals(result.ok, true);
  assertEquals(result.dry_run, true);
  assertEquals(result.writes_applied, 0);
  assertEquals(
    /^sha256:[0-9a-f]{64}$/.test(result.plan_token as string),
    true,
  );
  assertEquals(test.writes, []);
  assertEquals((result.plans as any[])[0].disposition, "materialize_and_bind");
  assertEquals(
    (result.plans as any[])[0].reason_code,
    "post_migration_initial_cycle_omission",
  );
  assertEquals((result.plans as any[])[0].confidence, "high");
  assertEquals(
    (result.plans as any[])[0].exact_facts.canonical_builder_reference,
    BUILDER_REFERENCE,
  );
  assertEquals(
    (result.plans as any[])[0].human_decision.action,
    "apply_exact_cycle_binding",
  );
  assertEquals((result.review_queue as any).groups, [{
    confidence: "high",
    count: 1,
    reasons: [{
      reason_code: "post_migration_initial_cycle_omission",
      count: 1,
      items: result.plans as any,
    }],
  }]);
});

Deno.test("five-card recovery hard-gates binding on the sealed submitted-and-locked portal verdict", async () => {
  const cases = [
    [
      "SWMS-261079",
      true,
      "2026-08-03T14:20:01+08:00",
      "sha256:878059f52ff1ebb8cca31eaa7729a6815cca8f1f86c5492f4602c44e69c4ac01",
    ],
    [
      "SWMS-261113",
      false,
      "2026-08-03T21:19:07+08:00",
      "sha256:ad0a1ede89d8a71f351f3cf236a9b4eadfc66397679a08776f3be9ba19ae0aaa",
    ],
    [
      "SWMS-261114",
      true,
      "2026-08-03T21:19:17+08:00",
      "sha256:ad0a1ede89d8a71f351f3cf236a9b4eadfc66397679a08776f3be9ba19ae0aaa",
    ],
    [
      "SWMS-261116",
      true,
      "2026-08-03T21:19:28+08:00",
      "sha256:ad0a1ede89d8a71f351f3cf236a9b4eadfc66397679a08776f3be9ba19ae0aaa",
    ],
    [
      "SWMS-261123",
      false,
      "2026-08-03T21:19:38+08:00",
      "sha256:ad0a1ede89d8a71f351f3cf236a9b4eadfc66397679a08776f3be9ba19ae0aaa",
    ],
  ] as const;

  for (
    const [jobNumber, submittedAndLocked, observedAt, evidenceSha256] of cases
  ) {
    const test = harness(snapshot(jobNumber));
    const result = await runRoofCycleBindingRecovery({
      job_numbers: [jobNumber],
      dry_run: true,
      plan_token: null,
    }, test.deps);
    const plan = (result.plans as any[])[0];

    assertEquals(test.writes, [], jobNumber);
    assertEquals(
      plan.exact_facts.portal_evidence,
      {
        observed_at: observedAt,
        submitted_and_locked: submittedAndLocked,
        verdict: submittedAndLocked
          ? "submitted_locked"
          : "unfinished_unlocked",
        evidence_sha256: evidenceSha256,
      },
      jobNumber,
    );

    if (submittedAndLocked) {
      assertEquals(result.ok, true, jobNumber);
      assertEquals(plan.disposition, "materialize_and_bind", jobNumber);
      continue;
    }

    assertEquals(result.ok, false, jobNumber);
    assertEquals(plan.disposition, "refused", jobNumber);
    assertEquals(
      plan.reason_code,
      "portal_not_submitted_locked",
      jobNumber,
    );
    await assertRejects(
      () =>
        runRoofCycleBindingRecovery({
          job_numbers: [jobNumber],
          dry_run: false,
          plan_token: result.plan_token as string,
        }, test.deps),
      MakesafeAttendanceCycleBindingRecoveryError,
      "at least one exact job is ineligible",
    );
    assertEquals(test.writes, [], jobNumber);
  }
});

Deno.test("exact apply binds one cycle, stays unassigned, and is idempotent", async () => {
  const test = harness();
  const first = await applyPreviewed(test);
  assertEquals(first.ok, true);
  assertEquals(first.writes_applied, 2);
  assertEquals(test.current().cycles.length, 1);
  assertEquals(test.current().detail?.cycleAttribution, "bound");
  assertEquals(test.current().evidenceCounts.assignments, 0);

  test.writes.length = 0;
  const repeat = await applyPreviewed(test);
  assertEquals(repeat.ok, true);
  assertEquals(repeat.writes_applied, 0);
  assertEquals(test.writes, []);
  assertEquals(test.current().cycles.length, 1);
});

Deno.test("recovery binds one existing exact cycle without minting another", async () => {
  const initial = snapshot();
  initial.cycles = [{
    id: "00000000-0000-4000-8000-000000000020",
    jobId: JOB_ID,
    cycleNumber: 1,
    openReason: "existing_first_attendance",
  }];
  const test = harness(initial);
  const result = await applyPreviewed(test);
  assertEquals(result.ok, true);
  assertEquals(test.writes.length, 1);
  assertEquals(test.writes[0].startsWith("atomic-bind:"), true);
  assertEquals(test.current().cycles.length, 1);
});

Deno.test("recovery refuses non-null, multiple-candidate, missing-authority, and evidence-bearing missing-cycle state", async () => {
  const cases: Array<
    [string, (value: RoofCycleBindingRecoverySnapshot) => void]
  > = [
    ["nonnull_current_cycle_drifted", (value) => {
      value.detail!.attendanceCycleId = "out-of-set-cycle";
      value.detail!.cycleAttribution = "bound";
    }],
    ["multiple_cycle_candidates", (value) => {
      value.cycles = [1, 2].map((cycleNumber) => ({
        id: `cycle-${cycleNumber}`,
        jobId: JOB_ID,
        cycleNumber,
        openReason: "unexpected",
      }));
    }],
    ["canonical_intake_case_missing", (value) => {
      value.intakeCases = [];
    }],
    ["missing_cycle_with_operational_evidence", (value) => {
      value.evidenceCounts.roofReportDrafts = 1;
    }],
  ];

  for (const [reasonCode, mutate] of cases) {
    const initial = snapshot();
    mutate(initial);
    const test = harness(initial);
    const result = await runRoofCycleBindingRecovery({
      job_numbers: [JOB_NUMBER],
      dry_run: true,
      plan_token: null,
    }, test.deps);
    assertEquals(result.ok, false, reasonCode);
    assertEquals((result.plans as any[])[0].reason_code, reasonCode);
    assertEquals((result.plans as any[])[0].confidence, "low");
    assertEquals(
      (result.plans as any[])[0].human_decision.action,
      "resolve_refusal",
    );
    assertEquals(test.writes, []);
    const error = await assertRejects(
      () =>
        runRoofCycleBindingRecovery({
          job_numbers: [JOB_NUMBER],
          dry_run: false,
          plan_token: result.plan_token as string,
        }, test.deps),
      MakesafeAttendanceCycleBindingRecoveryError,
      "at least one exact job is ineligible",
    );
    const body = (error as MakesafeAttendanceCycleBindingRecoveryError)
      .body as any;
    assertEquals(body.plans[0].reason_code, reasonCode);
    assertEquals(
      body.plans[0].human_decision.action,
      "resolve_refusal",
    );
    assertEquals(test.writes, []);
  }
});

Deno.test("recovery skips all writes when state drifts after planning", async () => {
  const initial = snapshot();
  const planned = await preview(harness(initial));
  let loads = 0;
  const writes: string[] = [];
  await assertRejects(
    () =>
      runRoofCycleBindingRecovery({
        job_numbers: [JOB_NUMBER],
        dry_run: false,
        plan_token: planned.plan_token as string,
      }, {
        loadSnapshot: async () => {
          loads++;
          const value = structuredClone(initial);
          if (loads > 1) value.job!.status = "processing";
          return value;
        },
        bindInitialCycle: async () => {
          writes.push("atomic-bind");
          return {
            attendanceCycleId: "cycle",
            cycleNumber: 1,
            cycleCreated: true,
            cycleBound: true,
          };
        },
      }),
    MakesafeAttendanceCycleBindingRecoveryError,
    "drifted after planning",
  );
  assertEquals(writes, []);
});

Deno.test("recovery cannot widen to a revision, duplicate, or unrelated card", async () => {
  let loads = 0;
  await assertRejects(
    () =>
      runRoofCycleBindingRecovery({
        job_numbers: ["SWMS-999999"],
        dry_run: true,
        plan_token: null,
      }, {
        loadSnapshot: async () => {
          loads++;
          return snapshot();
        },
        bindInitialCycle: async () => ({
          attendanceCycleId: "cycle",
          cycleNumber: 1,
          cycleCreated: true,
          cycleBound: true,
        }),
      }),
    MakesafeAttendanceCycleBindingRecoveryError,
    "outside the authorized roof cycle recovery scope",
  );
  assertEquals(loads, 0);

  const duplicate = snapshot();
  duplicate.intakeCases.push({
    ...duplicate.intakeCases[0],
    id: "00000000-0000-4000-8000-000000000002",
  });
  const test = harness(duplicate);
  const result = await runRoofCycleBindingRecovery({
    job_numbers: [JOB_NUMBER],
    dry_run: true,
    plan_token: null,
  }, test.deps);
  assertEquals(
    (result.plans as any[])[0].reason_code,
    "canonical_intake_case_ambiguous",
  );
  assertEquals(test.writes, []);
});

Deno.test("apply requires one exact card and the token returned by its prior dry run", async () => {
  const test = harness();
  const stale = await assertRejects(
    () =>
      runRoofCycleBindingRecovery({
        job_numbers: [JOB_NUMBER],
        dry_run: false,
        plan_token: `sha256:${"0".repeat(64)}`,
      }, test.deps),
    MakesafeAttendanceCycleBindingRecoveryError,
    "plan token is stale",
  );
  const staleBody = (stale as MakesafeAttendanceCycleBindingRecoveryError)
    .body as any;
  assertEquals(staleBody.plans[0].job_number, JOB_NUMBER);
  assertEquals(staleBody.plans[0].confidence, "high");
  assertEquals(test.writes, []);

  await assertRejects(
    () =>
      runRoofCycleBindingRecovery({
        job_numbers: [JOB_NUMBER, "SWMS-261113"],
        dry_run: false,
        plan_token: `sha256:${"1".repeat(64)}`,
      }, test.deps),
    MakesafeAttendanceCycleBindingRecoveryError,
    "apply accepts exactly one previously previewed job",
  );
  assertEquals(test.writes, []);
});
