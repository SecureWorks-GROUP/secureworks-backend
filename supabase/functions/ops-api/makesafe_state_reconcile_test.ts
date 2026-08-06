// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  chunkMakesafeStateRows,
  type MakesafeReconcileRow,
  planMakesafeStateReconciliation,
  summarizeMakesafeStateSeedChunks,
} from "./makesafe_state_reconcile.ts";
import {
  EMPTY_CANCELLATION,
  EMPTY_TERMINAL_PROOF,
  type MakesafeStateV2,
} from "./makesafe_state_projection.ts";

const COMPUTED_AT = "2026-07-27T07:15:00.000Z";

function state(
  stage: MakesafeStateV2["ops_stage"],
  overrides: Partial<MakesafeStateV2> = {},
): MakesafeStateV2 {
  return {
    contract_version: "makesafe-state.v2",
    computed_at: COMPUTED_AT,
    identity: {
      authority_kind: "effective_intake_case",
      authority_revision_id: "case-1",
      source_instruction_id: "instruction-1",
      lineage_id: "lineage-1",
      case_id: "case-1",
      job_id: "job-1",
      job_number: "SWMS-1",
      property_id: null,
      attendance_cycle_ids: ["cycle-1"],
      current_attendance_cycle_id: "cycle-1",
    },
    substatus: null,
    ops_stage: stage,
    ops_label: stage,
    trade_column: stage === "new" ? "New" : "Allocated",
    stage_evidence: {
      determinate: true,
      reason: `Exact evidence derives ${stage}.`,
      evidence_refs: [`evidence-${stage}`],
    },
    readiness: {
      state: "absent",
      ready: false,
      readiness_revision: null,
      dependency_generation: 0,
      attendance_cycle_set_hash: null,
      invalidated_at: null,
      invalidation_reason: null,
    },
    blocker: { blocked: false, primary: null, active: [] },
    cancellation: EMPTY_CANCELLATION(),
    terminal_proof: EMPTY_TERMINAL_PROOF(),
    next_action: {
      code: "none",
      owner_role: "none",
      since: COMPUTED_AT,
      due_at: null,
      reason: "No action.",
      action_ref: "job-1",
    },
    diagnostics: [],
    ...overrides,
  };
}

function row(
  jobNumber: string,
  before: string,
  projected: MakesafeStateV2,
  overrides: Partial<MakesafeReconcileRow> = {},
): MakesafeReconcileRow {
  return {
    id: `id-${jobNumber}`,
    job_number: jobNumber,
    job_state: "processing",
    declared_stage: before,
    canonical_stage: before,
    state_v2: projected,
    ...overrides,
  };
}

Deno.test("reconciliation corrects a determinate v2 disagreement with evidence", () => {
  const plan = planMakesafeStateReconciliation([
    row("SWMS-1", "new", state("allocated")),
  ]);

  assertEquals(plan.trustworthy, 1);
  assertEquals(plan.captain_marked, 0);
  assertEquals(plan.neither, 0);
  assertEquals(plan.transitions.length, 1);
  assertEquals(plan.transitions[0].after_status, "allocated");
  assertStringIncludes(
    plan.transitions[0].computed_reasons.join(" "),
    "Exact evidence derives allocated",
  );
  assertStringIncludes(
    plan.transitions[0].computed_reasons.join(" "),
    "evidence-allocated",
  );
});

Deno.test("known missing report still determines Allocated and is corrected", () => {
  const projected = state("allocated", {
    blocker: {
      blocked: true,
      primary: {
        code: "missing_current_cycle_report",
        source: "derived",
        severity: "warning",
        attendance_cycle_id: "cycle-1",
        reason: "No report.",
        held_since: COMPUTED_AT,
        owner_role: "trade",
        recovery_action: "submit_trade_report",
        recovery_instruction: "Submit the current-cycle service report.",
        evidence_refs: [],
      },
      active: [],
    },
  });
  projected.blocker.active = [projected.blocker.primary!];

  const plan = planMakesafeStateReconciliation([
    row("SWMS-2", "report_ready", projected),
  ]);
  assertEquals(plan.trustworthy, 1);
  assertEquals(plan.transitions[0].after_status, "allocated");
});

Deno.test("ambiguous cycle becomes a visible Captain instruction, never a status", () => {
  const ambiguity = {
    code: "backfill_cycle_scope" as const,
    source: "derived" as const,
    severity: "hard" as const,
    attendance_cycle_id: "cycle-1",
    reason: "Evidence spans two cycles.",
    held_since: COMPUTED_AT,
    owner_role: "ops" as const,
    recovery_action: "bind_cycle_evidence" as const,
    recovery_instruction: "Bind the report to one exact cycle.",
    evidence_refs: ["report-1"],
  };
  const projected = state("new", {
    stage_evidence: {
      determinate: false,
      reason: "Cycle evidence is ambiguous.",
      evidence_refs: [],
    },
    blocker: {
      blocked: true,
      primary: ambiguity,
      active: [ambiguity],
    },
  });

  const plan = planMakesafeStateReconciliation([
    row("SWMS-3", "report_ready", projected),
  ]);
  assertEquals(plan.transitions, []);
  assertEquals(plan.trustworthy, 0);
  assertEquals(plan.captain_marked, 1);
  assertEquals(plan.neither, 0);
  assertEquals(
    plan.attention_applications[0].code,
    "attendance_cycle_ruling",
  );
  assertStringIncludes(
    plan.attention_applications[0].message,
    "choose which attendance cycle",
  );
  assertEquals(plan.attention_applications[0].evidence_refs, ["report-1"]);
});

Deno.test("a false terminal display is not auto-reopened and names the ruling", () => {
  const plan = planMakesafeStateReconciliation([
    row("SWMS-4", "completed", state("allocated"), {
      job_state: "processing",
    }),
  ]);

  assertEquals(plan.transitions, []);
  assertEquals(plan.captain_marked, 1);
  assertEquals(plan.neither, 0);
  assertEquals(plan.attention_applications[0].code, "terminal_status_ruling");
  assertStringIncludes(
    plan.attention_applications[0].message,
    "stay completed or be reopened at allocated",
  );
});

Deno.test("confirmed cancellation is trustworthy only from its decision id", () => {
  const projected = state("new", {
    stage_evidence: {
      determinate: false,
      reason: "Other operational facts are incomplete.",
      evidence_refs: [],
    },
    cancellation: {
      state: "confirmed",
      reason_code: "builder_cancelled",
      note: null,
      decided_by: "ops",
      decided_at: COMPUTED_AT,
      decision_id: "cancel-1",
    },
  });
  const plan = planMakesafeStateReconciliation([
    row("SWMS-5", "cancelled", projected, { job_state: "cancelled" }),
  ]);
  assertEquals(plan.trustworthy, 1);
  assertEquals(plan.captain_marked, 0);
  assertEquals(plan.neither, 0);
});

Deno.test("every full-board row is exactly trustworthy or Captain-marked", () => {
  const rows = Array.from({ length: 393 }, (_, index) => {
    const jobNumber = `SWMS-${index + 1}`;
    if (index < 53) {
      return row(jobNumber, "archive", state("new"), {
        job_state: "archived",
      });
    }
    return row(
      jobNumber,
      index % 2 ? "new" : "allocated",
      state(
        index % 2 ? "allocated" : "allocated",
      ),
    );
  });
  const plan = planMakesafeStateReconciliation(rows);
  assertEquals(plan.requested, 393);
  assertEquals(plan.trustworthy, 340);
  assertEquals(plan.captain_marked, 53);
  assertEquals(plan.neither, 0);
  assertEquals(plan.outcomes.length, 393);
});

Deno.test("full-board RPC writes split into resumable chunks", () => {
  const rows = Array.from({ length: 1001 }, (_, index) => index);
  const chunks = chunkMakesafeStateRows(rows);
  assertEquals(chunks.map((chunk) => chunk.length), [500, 500, 1]);
  assertEquals(chunks.flat(), rows);
  assertEquals(chunkMakesafeStateRows(rows).flat(), rows);
});

Deno.test("seed chunks account for seeded, missing, and out-of-scope cards", () => {
  const summary = summarizeMakesafeStateSeedChunks([
    { requested: 500, accounted: 500, seeded: 498, skipped: 2 },
    { requested: 101, accounted: 101, seeded: 100, skipped: 1 },
  ], 601);

  assertEquals(summary, {
    valid: true,
    requested: 601,
    accounted: 601,
    seeded: 598,
    skipped: 3,
    error: null,
  });
});

Deno.test("seed chunk accounting fails closed on an unaccounted card", () => {
  const summary = summarizeMakesafeStateSeedChunks([
    { requested: 430, accounted: 429, seeded: 429, skipped: 0 },
  ], 430);

  assertEquals(summary.valid, false);
  assertStringIncludes(summary.error || "", "did not partition every request");
});

Deno.test("seed chunk accounting never coerces a missing count to zero", () => {
  const summary = summarizeMakesafeStateSeedChunks([
    { requested: 1, accounted: 1, seeded: null, skipped: 0 },
  ], 1);

  assertEquals(summary.valid, false);
  assertStringIncludes(summary.error || "", "invalid accounting");
});

Deno.test("R12: a decision_required card parks as a Captain question and never aborts the run", () => {
  const plan = planMakesafeStateReconciliation([
    row("SWMS-26517", "decision_required", state("allocated"), {
      declared_stage: "trade_report_in",
      derived_stage_v2: "decision_required",
    }),
    row("SWMS-CLEAN", "new", state("allocated"), {
      derived_stage_v2: "new",
    }),
  ]);

  assertEquals(plan.requested, 2);
  assertEquals(plan.captain_marked, 1);
  assertEquals(plan.trustworthy, 1);
  assertEquals(plan.neither, 0);
  assertEquals(
    plan.transitions.map((transition) => transition.job_number),
    ["SWMS-CLEAN"],
  );
  const parked = plan.outcomes.find((outcome) =>
    outcome.job_number === "SWMS-26517"
  );
  assertEquals(parked?.outcome, "captain_marked");
  assertEquals(parked?.fact_derived_status, null);
  const attention = plan.attention_applications.find((item) =>
    item.job_number === "SWMS-26517"
  );
  assertEquals(attention?.code, "board_evidence_contradiction_ruling");
  assertEquals(attention?.state, "active");
});

Deno.test("R12: reconciliation stamps source_status from the derived stage", () => {
  const plan = planMakesafeStateReconciliation([
    row("SWMS-DIVERGED", "report_ready", state("allocated"), {
      declared_stage: "trade_report_in",
      derived_stage_v2: "report_ready",
    }),
  ]);

  assertEquals(plan.transitions[0].source_status, "report_ready");
  assertEquals(plan.transitions[0].before_status, "report_ready");
});
