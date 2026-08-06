// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { planMakesafeStatusApplications } from "./makesafe_status_apply.ts";

const COMPUTED_AT = "2026-07-23T14:28:07.864Z";

function row(
  jobNumber: string,
  before: string,
  after: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `id-${jobNumber}`,
    job_number: jobNumber,
    job_state: "processing",
    declared_stage: before,
    canonical_stage: before,
    computed_status: after,
    computed_status_at: COMPUTED_AT,
    computed_status_reasons: [`${before} evidence resolves to ${after}`],
    computed_status_missing: [],
    ...overrides,
  };
}

Deno.test("status apply planner produces exactly the seven reviewed clean live transitions", () => {
  const rows = [
    row("SWMS-261019", "new", "allocated"),
    row("SWMS-26633", "report_ready", "allocated"),
    row("SWMS-26791", "report_ready", "allocated"),
    row("SWMS-26810", "new", "allocated"),
    row("SWMS-26934", "new", "allocated"),
    row("SWMS-26953", "report_ready", "trade_report_in"),
    row("SWMS-26998", "new", "allocated"),
  ];

  const plan = planMakesafeStatusApplications(
    rows,
    rows.map((candidate) => candidate.job_number),
  );

  assertEquals(plan.requested, 7);
  assertEquals(plan.skipped, []);
  assertEquals(plan.transitions.length, 7);
  assertEquals(plan.before_counts, { new: 4, report_ready: 3 });
  assertEquals(plan.after_counts, {
    new: 0,
    report_ready: 0,
    allocated: 6,
    trade_report_in: 1,
  });
  assertEquals(
    plan.transitions.map((transition) => [
      transition.job_number,
      transition.before_status,
      transition.after_status,
      transition.computed_at,
    ]),
    [
      ["SWMS-261019", "new", "allocated", COMPUTED_AT],
      ["SWMS-26633", "report_ready", "allocated", COMPUTED_AT],
      ["SWMS-26791", "report_ready", "allocated", COMPUTED_AT],
      ["SWMS-26810", "new", "allocated", COMPUTED_AT],
      ["SWMS-26934", "new", "allocated", COMPUTED_AT],
      ["SWMS-26953", "report_ready", "trade_report_in", COMPUTED_AT],
      ["SWMS-26998", "new", "allocated", COMPUTED_AT],
    ],
  );
});

Deno.test("status apply planner cannot touch displayed-terminal or terminal-job cards", () => {
  const rows = [
    row("SWMS-ARCHIVE", "archive", "allocated"),
    row("SWMS-COMPLETED", "completed", "trade_report_in"),
    row("SWMS-CLOSED", "report_ready", "allocated", { job_state: "closed" }),
    row("SWMS-CANCELLED", "cancelled", "new"),
  ];

  const plan = planMakesafeStatusApplications(rows);

  assertEquals(plan.transitions, []);
  assertEquals(
    plan.skipped.map((skip) => [skip.job_number, skip.reason]),
    [
      ["SWMS-ARCHIVE", "terminal_display_status"],
      ["SWMS-COMPLETED", "terminal_display_status"],
      ["SWMS-CLOSED", "terminal_job_status"],
      ["SWMS-CANCELLED", "terminal_display_status"],
    ],
  );
  assertEquals(plan.before_counts, {
    archive: 1,
    completed: 1,
    report_ready: 1,
    cancelled: 1,
  });
  assertEquals(plan.after_counts, plan.before_counts);
  assertEquals(plan.terminal_untouched, {
    completed: 1,
    archive: 1,
    cancelled: 1,
  });
});

Deno.test("status apply planner reports missing and already-matching rows without inventing transitions", () => {
  const rows = [
    row("SWMS-SAME", "allocated", "allocated"),
    row("SWMS-NO-COMPUTED", "new", "", { computed_status: null }),
    row("SWMS-NO-EVIDENCE", "new", "allocated", {
      computed_status_at: null,
    }),
  ];

  const plan = planMakesafeStatusApplications(rows, [
    "SWMS-SAME",
    "SWMS-NO-COMPUTED",
    "SWMS-NO-EVIDENCE",
    "SWMS-NOT-FOUND",
  ]);

  assertEquals(plan.transitions, []);
  assertEquals(
    plan.skipped.map((skip) => [skip.job_number, skip.reason]),
    [
      ["SWMS-SAME", "already_matches"],
      ["SWMS-NO-COMPUTED", "missing_computed_status"],
      ["SWMS-NO-EVIDENCE", "missing_computed_evidence"],
      ["SWMS-NOT-FOUND", "not_found"],
    ],
  );
});

Deno.test("R12: source_status anchors on the derived stage, not the legacy ladder", () => {
  const rows = [
    row("SWMS-DIVERGED", "report_ready", "allocated", {
      declared_stage: "trade_report_in",
      canonical_stage: "report_ready",
      derived_stage_v2: "report_ready",
    }),
  ];

  const plan = planMakesafeStatusApplications(rows, ["SWMS-DIVERGED"]);

  assertEquals(plan.skipped, []);
  assertEquals(plan.transitions.length, 1);
  assertEquals(plan.transitions[0].source_status, "report_ready");
  assertEquals(plan.transitions[0].before_status, "report_ready");
  assertEquals(plan.transitions[0].after_status, "allocated");
});

Deno.test("R12: a row without derived_stage_v2 falls back to canonical_stage", () => {
  const rows = [
    row("SWMS-NO-V2", "report_ready", "allocated", {
      declared_stage: "trade_report_in",
      canonical_stage: "report_ready",
    }),
  ];

  const plan = planMakesafeStatusApplications(rows, ["SWMS-NO-V2"]);

  assertEquals(plan.transitions[0].source_status, "report_ready");
});

Deno.test("R12: a decision_required card is parked, never planned", () => {
  const rows = [
    row("SWMS-26517", "decision_required", "allocated", {
      declared_stage: "trade_report_in",
      canonical_stage: "decision_required",
      derived_stage_v2: "decision_required",
    }),
    row("SWMS-CLEAN", "new", "allocated", { derived_stage_v2: "new" }),
  ];

  const plan = planMakesafeStatusApplications(rows, [
    "SWMS-26517",
    "SWMS-CLEAN",
  ]);

  assertEquals(
    plan.skipped.map((skip) => [skip.job_number, skip.reason]),
    [["SWMS-26517", "decision_required_display_status"]],
  );
  assertEquals(
    plan.transitions.map((transition) => transition.job_number),
    ["SWMS-CLEAN"],
  );
});
