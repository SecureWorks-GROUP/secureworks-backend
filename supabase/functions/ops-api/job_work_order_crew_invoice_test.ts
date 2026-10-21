// deno-lint-ignore-file no-explicit-any
// Crew invoices on the job work order. Pure rules only: no index.ts, no database.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ACTIVE_JOB_WORK_ORDER_WINDOW_MS,
  decideOfficeWrite,
  hardRuleRefusal,
  crewWorkOrderCreateRefusal,
  hideRetiredCrewWorkOrder,
  isActiveJobWorkOrderBackfillCandidate,
  jobTypeFillsFromQuote,
  jobTypeOpensWorkOrder,
  MARNIN_BACKUP_APPROVER_USER_ID,
  namedWorkOrderApprover,
  planCrewWorkOrderRetirement,
  planJobWorkOrderStamp,
  SHAUN_APPROVER_USER_ID,
  visibleCrewPayWorkOrders,
  xeroSyncRefusal,
} from "./crew_invoice_job_work_order.ts";

function refusalCode(decision: ReturnType<typeof decideOfficeWrite>): string {
  if (decision.ok) throw new Error("expected a refusal");
  return decision.code;
}

const AS_OF = new Date("2026-10-21T04:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function at(msBefore: number): string {
  return new Date(AS_OF.getTime() - msBefore).toISOString();
}

Deno.test("rule widening: fencing and patio always open; other types only while the flag is on", () => {
  assertEquals(jobTypeOpensWorkOrder("fencing", false), true);
  assertEquals(jobTypeOpensWorkOrder("patio", false), true);
  assertEquals(jobTypeOpensWorkOrder("makesafe", false), false);
  assertEquals(jobTypeOpensWorkOrder("repair", false), false);
  assertEquals(jobTypeOpensWorkOrder("makesafe", true), true);
  assertEquals(jobTypeOpensWorkOrder("repair", true), true);
  assertEquals(jobTypeOpensWorkOrder("insurance", true), true);
  assertEquals(jobTypeOpensWorkOrder("", true), false);
  assertEquals(jobTypeOpensWorkOrder("   ", true), false);
  assertEquals(jobTypeOpensWorkOrder(null, true), false);
  assertEquals(jobTypeOpensWorkOrder(" fencing ", false), true);
});

Deno.test("quote fill stays fencing and patio", () => {
  assertEquals(jobTypeFillsFromQuote("fencing"), true);
  assertEquals(jobTypeFillsFromQuote("patio"), true);
  assertEquals(jobTypeFillsFromQuote("makesafe"), false);
  assertEquals(jobTypeFillsFromQuote("repair"), false);
  assertEquals(jobTypeFillsFromQuote(null), false);
});

Deno.test("backfill selects jobs touched in 30 days and leaves a stale processing make-safe", () => {
  const fresh = {
    status: "processing",
    updated_at: at(10 * DAY),
    has_job_work_order: false,
  };
  assertEquals(isActiveJobWorkOrderBackfillCandidate(fresh, AS_OF), true);
  assertEquals(
    isActiveJobWorkOrderBackfillCandidate(
      { ...fresh, updated_at: at(ACTIVE_JOB_WORK_ORDER_WINDOW_MS) },
      AS_OF,
    ),
    true,
  );
  assertEquals(
    isActiveJobWorkOrderBackfillCandidate(
      { ...fresh, updated_at: at(ACTIVE_JOB_WORK_ORDER_WINDOW_MS + 1) },
      AS_OF,
    ),
    false,
  );
  assertEquals(
    isActiveJobWorkOrderBackfillCandidate(
      { status: "processing", updated_at: at(40 * DAY), has_job_work_order: false },
      AS_OF,
    ),
    false,
  );
  assertEquals(
    isActiveJobWorkOrderBackfillCandidate(
      { status: "scheduled", updated_at: at(1 * DAY), has_job_work_order: false },
      AS_OF,
    ),
    true,
  );
  for (const status of ["complete", "draft", "quoted", "cancelled", "archived"]) {
    assertEquals(
      isActiveJobWorkOrderBackfillCandidate(
        { status, updated_at: at(1 * DAY), has_job_work_order: false },
        AS_OF,
      ),
      false,
      status,
    );
  }
  assertEquals(
    isActiveJobWorkOrderBackfillCandidate(
      { status: "processing", updated_at: at(1 * DAY), has_job_work_order: true },
      AS_OF,
    ),
    false,
  );
  assertEquals(
    isActiveJobWorkOrderBackfillCandidate(
      { status: "processing", has_job_work_order: false },
      AS_OF,
    ),
    false,
  );
});

Deno.test("held lines do not sync to Xero; a rejected line is reported first", () => {
  assertEquals(
    xeroSyncRefusal([
      { office_review_status: "awaiting" },
      { office_review_status: "rejected" },
    ])?.code,
    "lines_rejected",
  );
  assertEquals(
    xeroSyncRefusal([{ office_review_status: "awaiting" }])?.code,
    "lines_awaiting_office_review",
  );
  assertEquals(
    xeroSyncRefusal([{ office_review_status: "queried" }])?.code,
    "lines_awaiting_office_review",
  );
  assertEquals(
    xeroSyncRefusal([
      { office_review_status: null },
      { office_review_status: "approved" },
      {},
    ]),
    null,
  );
  assertEquals(xeroSyncRefusal([]), null);
});

Deno.test("office fill and approve are named approvers, and only while that switch is on", () => {
  const lists = {
    primaryIds: [SHAUN_APPROVER_USER_ID],
    backupIds: [MARNIN_BACKUP_APPROVER_USER_ID],
  };
  assertEquals(
    refusalCode(decideOfficeWrite({
      staff: false,
      userId: SHAUN_APPROVER_USER_ID,
      action: "fill",
      officeFlagOn: true,
      reviewFlagOn: true,
      ...lists,
    })),
    "operator_access_required",
  );
  assertEquals(
    refusalCode(decideOfficeWrite({
      staff: true,
      userId: SHAUN_APPROVER_USER_ID,
      action: "approve",
      officeFlagOn: false,
      reviewFlagOn: true,
      ...lists,
    })),
    "job_work_order_office_fill_off",
  );
  assertEquals(
    refusalCode(decideOfficeWrite({
      staff: true,
      userId: null,
      action: "fill",
      officeFlagOn: true,
      reviewFlagOn: false,
      ...lists,
    })),
    "not_approver",
  );
  assertEquals(
    refusalCode(decideOfficeWrite({
      staff: true,
      userId: "11111111-1111-1111-1111-111111111111",
      action: "fill",
      officeFlagOn: true,
      reviewFlagOn: false,
      ...lists,
    })),
    "not_approver",
  );
  assertEquals(
    refusalCode(decideOfficeWrite({
      staff: true,
      userId: MARNIN_BACKUP_APPROVER_USER_ID,
      action: "approve",
      officeFlagOn: false,
      reviewFlagOn: false,
      ...lists,
    })),
    "job_work_order_office_fill_off",
  );
  assertEquals(
    decideOfficeWrite({
      staff: true,
      userId: SHAUN_APPROVER_USER_ID,
      action: "fill",
      officeFlagOn: true,
      reviewFlagOn: false,
      ...lists,
    }),
    { ok: true },
  );
  assertEquals(
    decideOfficeWrite({
      staff: true,
      userId: MARNIN_BACKUP_APPROVER_USER_ID,
      action: "approve",
      officeFlagOn: true,
      reviewFlagOn: false,
      ...lists,
    }),
    { ok: true },
  );
  assertEquals(
    namedWorkOrderApprover(MARNIN_BACKUP_APPROVER_USER_ID, {
      ...lists,
      officeFlagOn: false,
    }),
    false,
  );
  assertEquals(
    namedWorkOrderApprover(SHAUN_APPROVER_USER_ID, {
      ...lists,
      officeFlagOn: false,
    }),
    true,
  );
});

Deno.test("line review needs the review switch; Marnin also needs the office switch", () => {
  const lists = {
    primaryIds: [SHAUN_APPROVER_USER_ID],
    backupIds: [MARNIN_BACKUP_APPROVER_USER_ID],
  };
  assertEquals(
    refusalCode(decideOfficeWrite({
      staff: true,
      userId: SHAUN_APPROVER_USER_ID,
      action: "review",
      officeFlagOn: true,
      reviewFlagOn: false,
      ...lists,
    })),
    "crew_invoice_line_office_review_off",
  );
  assertEquals(
    decideOfficeWrite({
      staff: true,
      userId: SHAUN_APPROVER_USER_ID,
      action: "review",
      officeFlagOn: false,
      reviewFlagOn: true,
      ...lists,
    }),
    { ok: true },
  );
  assertEquals(
    refusalCode(decideOfficeWrite({
      staff: true,
      userId: MARNIN_BACKUP_APPROVER_USER_ID,
      action: "review",
      officeFlagOn: false,
      reviewFlagOn: true,
      ...lists,
    })),
    "not_approver",
  );
  assertEquals(
    decideOfficeWrite({
      staff: true,
      userId: MARNIN_BACKUP_APPROVER_USER_ID,
      action: "review",
      officeFlagOn: true,
      reviewFlagOn: true,
      ...lists,
    }),
    { ok: true },
  );
});

Deno.test("hard rule is off by default and, on, refuses a job line with no work order", () => {
  const travel = [{ job_id: "job-1", line_type: "Travel" }];
  const jobs = { "job-1": { hasWorkOrder: false } as const };
  assertEquals(hardRuleRefusal({ flagOn: false, lines: travel, jobs }), null);
  assertEquals(
    hardRuleRefusal({ flagOn: true, lines: travel, jobs })?.code,
    "job_work_order_required",
  );
  assertEquals(
    hardRuleRefusal({
      flagOn: true,
      lines: [{ line_type: "final_payout_deduction" }, { job_id: null, line_type: "adjustment" }],
      jobs: {},
    }),
    null,
  );
  assertEquals(
    hardRuleRefusal({
      flagOn: true,
      lines: travel,
      jobs: { "job-1": { hasWorkOrder: true } },
    }),
    null,
  );
  assertEquals(
    hardRuleRefusal({
      flagOn: true,
      lines: travel,
      jobs: { "job-1": "unreadable" },
    })?.code,
    "job_work_order_unreadable",
  );
  assertEquals(
    hardRuleRefusal({ flagOn: true, lines: travel, jobs: {} })?.code,
    "job_work_order_unreadable",
  );
});

Deno.test("travel keeps no crew work order id and does not lock a day card", () => {
  const travel = planJobWorkOrderStamp({
    stampFlagOn: true,
    line: { job_id: "job-1", line_type: "Travel", source_work_order_id: null },
    jobWorkOrderId: "wo-job",
  });
  assertEquals(travel.job_work_order_id, "wo-job");
  assertEquals(travel.source_work_order_id, null);
  assertEquals(travel.locksAssignment, false);

  const labourOnlyJob = planJobWorkOrderStamp({
    stampFlagOn: true,
    line: { job_id: "job-1", line_type: "labour" },
    jobWorkOrderId: "wo-job",
  });
  assertEquals(labourOnlyJob.locksAssignment, false);
  assertEquals(labourOnlyJob.source_work_order_id, null);

  const labourCrew = planJobWorkOrderStamp({
    stampFlagOn: true,
    line: { job_id: "job-1", line_type: "labour", source_work_order_id: "wo-crew" },
    jobWorkOrderId: "wo-job",
  });
  assertEquals(labourCrew.source_work_order_id, "wo-crew");
  assertEquals(labourCrew.job_work_order_id, "wo-job");
  assertEquals(labourCrew.locksAssignment, true);

  const patioCrew = planJobWorkOrderStamp({
    stampFlagOn: false,
    line: { job_id: "job-1", line_type: "patio", source_work_order_id: "wo-crew" },
    jobWorkOrderId: "wo-job",
  });
  assertEquals(patioCrew.job_work_order_id, null);
  assertEquals(patioCrew.locksAssignment, true);

  const workOrderLine = planJobWorkOrderStamp({
    stampFlagOn: false,
    line: { job_id: "job-1", line_type: "Work Order" },
    jobWorkOrderId: null,
  });
  assertEquals(workOrderLine.locksAssignment, true);
  assertEquals(workOrderLine.job_work_order_id, null);

  const alreadyStamped = planJobWorkOrderStamp({
    stampFlagOn: true,
    line: { job_id: "job-1", line_type: "labour", job_work_order_id: "kept" },
    jobWorkOrderId: "wo-job",
  });
  assertEquals(alreadyStamped.job_work_order_id, "kept");
});

Deno.test("retiring crew work orders hides kind crew and keeps quote-builder rows", () => {
  const crew = { id: "c", kind: "crew", quote_builder_version_id: null };
  const quoted = { id: "q", kind: "crew", quote_builder_version_id: "ver-1" };
  const job = { id: "j", kind: "job", quote_builder_version_id: null };
  const unkind = { id: "u", kind: null, quote_builder_version_id: null };
  assertEquals(hideRetiredCrewWorkOrder(crew, false), false);
  assertEquals(hideRetiredCrewWorkOrder(crew, true), true);
  assertEquals(hideRetiredCrewWorkOrder(quoted, true), false);
  assertEquals(hideRetiredCrewWorkOrder(job, true), false);
  assertEquals(hideRetiredCrewWorkOrder(unkind, true), false);
  assertEquals(
    visibleCrewPayWorkOrders([crew, quoted, job, unkind], false).map((row) => row.id),
    ["c", "q", "j", "u"],
  );
  assertEquals(
    visibleCrewPayWorkOrders([crew, quoted, job, unkind], true).map((row) => row.id),
    ["q", "j", "u"],
  );
});

Deno.test("create_work_order refuses a missing kind only while crew retirement is on", () => {
  assertEquals(crewWorkOrderCreateRefusal(undefined, false), null);
  assertEquals(crewWorkOrderCreateRefusal("crew", false), null);
  assertEquals(crewWorkOrderCreateRefusal("job", true), null);
  const missing = crewWorkOrderCreateRefusal(undefined, true);
  const crew = crewWorkOrderCreateRefusal("crew", true);
  assertEquals(missing?.code, "crew_work_order_retired");
  assertEquals(crew?.code, "crew_work_order_retired");
  assertEquals(missing?.error.includes("kind: 'job'"), true);
});

Deno.test("a retired crew row leaves the authorising list and a job work order stays", () => {
  const rows = [
    { id: "retired", kind: "crew", quote_builder_version_id: null, status: "cancelled" },
    { id: "still-sent", kind: "crew", quote_builder_version_id: null, status: "sent" },
    { id: "quoted", kind: "crew", quote_builder_version_id: "ver-1", status: "sent" },
    { id: "job", kind: "job", quote_builder_version_id: null, status: "approved" },
  ];
  assertEquals(
    visibleCrewPayWorkOrders(rows, true).map((row) => row.id),
    ["quoted", "job"],
  );
});

Deno.test("retirement plan cancels legacy crew rows and leaves quote-builder rows", () => {
  const plan = planCrewWorkOrderRetirement([
    { id: "s1", kind: "crew", status: "sent", job_id: "open-1", job_status: "scheduled" },
    { id: "s2", kind: "crew", status: "sent", sent_at: "2026-06-01", job_id: "open-1", job_status: "in_progress" },
    { id: "done", kind: "crew", status: "complete", job_id: "closed-1", job_status: "complete" },
    { id: "gone", kind: "crew", status: "cancelled", job_id: "open-1", job_status: "scheduled" },
    { id: "qb", kind: "crew", quote_builder_version_id: "ver-9", status: "sent", job_id: "open-2", job_status: "scheduled" },
    { id: "job", kind: "job", status: "approved", job_id: "open-3", job_status: "scheduled" },
  ]);
  assertEquals(plan.eligible, 4);
  assertEquals(plan.already_cancelled, 1);
  assertEquals(plan.to_retire, 3);
  assertEquals(plan.sent, 2);
  assertEquals(plan.with_sent_at, 1);
  assertEquals(plan.open_jobs, 1);
  assertEquals(plan.closed_jobs, 1);
  assertEquals(plan.ids, ["s1", "s2", "done"]);
});
