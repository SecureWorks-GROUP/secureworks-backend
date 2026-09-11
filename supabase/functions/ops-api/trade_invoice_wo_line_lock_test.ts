/**
 * Regression: a job billed as a Work Order or Commission line never locked the
 * trade's job card, so the same job could be billed twice.
 *
 * Production case (read-only observation, 2026-09-11):
 *   • trade "Alyx" (users.id 2f00f91e-8b76-4856-8dec-ab6041f04e1d)
 *   • invoice SW-INV-A-260830-025, week 2026-08-24..30, PAID on Xero bill
 *     4c720ac9-143d-4c54-9eb3-7cec62c5dcd9
 *   • line 1: "SWF-261063 | Work order $1477.00. Less labour: Sonny 14.5h x
 *     $35 = $507.50 ... Net payable $969.50"
 *   • job_assignments a4019f76-8b8c-4c7e-86bd-8ae0758e8635 on SWF-261063,
 *     scheduled 2026-08-24, lead_installer, invoiced_in NULL
 *
 * Layer B built its stamp set only from labour lines' assignment_ids. The Work
 * Order line travelled as an extra item and stamped nothing, so my_hours kept
 * the card under the paid week.
 *
 * Does NOT prove: that PostgREST composes the candidate filters as expected,
 * or production row counts. The migration contract covers the backfill SQL.
 */
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  describeAssignmentLockBlock,
  isWorkOrderLockLine,
  planAssignmentLock,
  selectWorkOrderLineAssignmentIds,
  workOrderLockJobs,
} from "./trade_invoice_assignment_lock.ts";

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

const JOB_SWF_261063 = "5f0e4a3c-0000-4000-8000-000000261063";
const ALYX_CARD = "a4019f76-8b8c-4c7e-86bd-8ae0758e8635";
const PAID_INVOICE = "0d7c2a11-0000-4000-8000-00000000a025";
const RELEASED_DRAFT = "0d7c2a11-0000-4000-8000-0000000000d1";
const WEEK_START = "2026-08-24";
const WEEK_END = "2026-08-30";

/** The extra line the submit path built for Alyx's first line. */
const ALYX_WO_LINE = {
  line_type: "work order", // trade app 'Work Order', lower-cased by submit
  job_id: JOB_SWF_261063,
  job_number: "SWF-261063",
  description:
    "Work order $1477.00. Less labour: Sonny 14.5h x $35 = $507.50 ... Net payable $969.50",
  source_work_order_id: null,
};

Deno.test("the invoice week in the Alyx case is a Monday-keyed week", () => {
  assertEquals(new Date(WEEK_START + "T00:00:00Z").getUTCDay(), 1);
});

Deno.test("a Work Order line with a job locks that job (was: stamped nothing)", () => {
  assert(isWorkOrderLockLine(ALYX_WO_LINE));
  const { jobIds, jobLabelByJobId } = workOrderLockJobs([ALYX_WO_LINE]);
  assertEquals(jobIds, [JOB_SWF_261063]);
  assertEquals(jobLabelByJobId[JOB_SWF_261063], "SWF-261063");
});

Deno.test("Commission and work_order line types lock the job too", () => {
  assert(isWorkOrderLockLine({ line_type: "commission", job_id: "j1" }));
  assert(isWorkOrderLockLine({ line_type: "Commission ", job_id: "j1" }));
  assert(isWorkOrderLockLine({ line_type: "work_order", job_id: "j1" }));
});

Deno.test("lines that are not job-level billing never lock a card", () => {
  // Hours lines carry their own assignment ids; materials/other extras bill
  // stuff, not the job card; a line without a job has nothing to lock.
  for (const lineType of ["labour", "materials", "other", "make safe", "adjustment"]) {
    assert(!isWorkOrderLockLine({ line_type: lineType, job_id: "j1" }), lineType);
  }
  assert(!isWorkOrderLockLine({ line_type: "work order", job_id: null }));
  assert(!isWorkOrderLockLine({ line_type: "commission" }));
});

Deno.test("weekly work-order scope lines lock the job, deductions do not", () => {
  const scope = { line_type: "labour", job_id: "j1", source_work_order_id: "wo1" };
  const deduction = {
    line_type: "labour_deduction",
    job_id: "j1",
    source_work_order_id: "wo1",
  };
  const crew = {
    line_type: "crew_work_order_deduction",
    job_id: "j2",
    source_work_order_id: "wo2",
  };
  assert(isWorkOrderLockLine(scope));
  assert(!isWorkOrderLockLine(deduction));
  assert(!isWorkOrderLockLine(crew));
  assertEquals(workOrderLockJobs([scope, deduction, crew]).jobIds, ["j1"]);
});

Deno.test("weekly invoice stamps the trade's in-week card on the WO job (the Alyx card)", () => {
  const ids = selectWorkOrderLineAssignmentIds({
    candidates: [
      { id: ALYX_CARD, job_id: JOB_SWF_261063, scheduled_date: "2026-08-24", invoiced_in: null },
    ],
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    liveInvoiceIds: new Set(),
    notAfter: "2026-09-11",
  });
  assertEquals(ids, [ALYX_CARD]);
  const plan = planAssignmentLock({
    expectedIds: ids,
    candidates: [{ id: ALYX_CARD, invoiced_in: null }],
    releasedInvoiceIds: [PAID_INVOICE],
  });
  assert(plan.ok);
  assertEquals(plan.claimableIds, [ALYX_CARD]);
});

Deno.test("weekly invoice leaves out-of-week and undated cards alone", () => {
  const ids = selectWorkOrderLineAssignmentIds({
    candidates: [
      { id: "before", job_id: "j1", scheduled_date: "2026-08-23", invoiced_in: null },
      { id: "after", job_id: "j1", scheduled_date: "2026-08-31", invoiced_in: null },
      { id: "undated", job_id: "j1", scheduled_date: null, invoiced_in: null },
      { id: "last-day", job_id: "j1", scheduled_date: "2026-08-30", invoiced_in: null },
    ],
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    liveInvoiceIds: new Set(),
    notAfter: "2026-09-11",
  });
  assertEquals(ids, ["last-day"]);
});

Deno.test("weekly WO line on a card already on a live invoice is refused by name, not billed twice", () => {
  const candidates = [
    { id: ALYX_CARD, job_id: JOB_SWF_261063, scheduled_date: "2026-08-24", invoiced_in: PAID_INVOICE },
  ];
  const ids = selectWorkOrderLineAssignmentIds({
    candidates,
    weekStart: WEEK_START,
    weekEnd: WEEK_END,
    liveInvoiceIds: new Set([PAID_INVOICE]),
    notAfter: "2026-09-11",
  });
  assertEquals(ids, [ALYX_CARD]);
  const plan = planAssignmentLock({
    expectedIds: ids,
    candidates,
    releasedInvoiceIds: ["new-invoice"],
  });
  assert(!plan.ok);
  assertStringIncludes(
    describeAssignmentLockBlock(plan, { [ALYX_CARD]: "SWF-261063" }),
    "already on a live invoice: SWF-261063",
  );
});

Deno.test("non-week invoice stamps past un-invoiced cards and skips live-held and future cards", () => {
  const ids = selectWorkOrderLineAssignmentIds({
    candidates: [
      { id: "free", job_id: "j1", scheduled_date: "2026-08-10", invoiced_in: null },
      { id: "released", job_id: "j1", scheduled_date: "2026-08-11", invoiced_in: RELEASED_DRAFT },
      { id: "live", job_id: "j1", scheduled_date: "2026-08-12", invoiced_in: PAID_INVOICE },
      { id: "future", job_id: "j1", scheduled_date: "2026-10-01", invoiced_in: null },
      { id: "undated", job_id: "j1", scheduled_date: null, invoiced_in: null },
      { id: "today", job_id: "j1", scheduled_date: "2026-09-11", invoiced_in: null },
    ],
    weekStart: null,
    weekEnd: null,
    liveInvoiceIds: new Set([PAID_INVOICE]),
    notAfter: "2026-09-11",
  });
  assertEquals(ids, ["free", "released", "undated", "today"]);
});

Deno.test("index.ts reads WO job cards for the submitting trade only, before persisting", () => {
  const readAt = INDEX.indexOf("const woLock = workOrderLockJobs(extraLineItems)");
  assert(readAt > 0, "submit path must derive WO lock jobs from the extra lines");
  const block = INDEX.slice(readAt, readAt + 2600);
  assertStringIncludes(block, ".eq('user_id', tradeUser.id)");
  assertStringIncludes(block, ".in('job_id', woLock.jobIds)");
  assertStringIncludes(block, ".gte('scheduled_date', week_start).lte('scheduled_date', weekEnd)");
  assertStringIncludes(block, "selectWorkOrderLineAssignmentIds({");
  const includedAt = INDEX.indexOf("const includedAssignmentIds = [...new Set([");
  const persistAt = INDEX.indexOf("? await _persistWeeklyTradeInvoice(", includedAt);
  assert(includedAt > readAt, "included ids must be built after the WO card read");
  assert(persistAt > includedAt, "the stamp set must exist before the invoice is persisted");
});

Deno.test("index.ts folds WO line cards into the same Layer B stamp and prior-draft transfer", () => {
  const includedAt = INDEX.indexOf("const includedAssignmentIds = [...new Set([");
  const included = INDEX.slice(includedAt, includedAt + 300);
  assertStringIncludes(included, "...woLineAssignmentIds,");
  // The prior-draft RPC and the Layer B CAS both still consume the one list.
  const submitAt = INDEX.indexOf("case 'generate_trade_invoice': {");
  const submit = INDEX.slice(submitAt);
  assertStringIncludes(submit, "includedAssignmentIds,\n                ),");
  assertStringIncludes(submit, "const expectedAssignmentIds = [...new Set(includedAssignmentIds)]");
  // Refusals keep naming job cards, now including WO-line cards.
  assertStringIncludes(
    submit,
    "const stampJobLabels: Record<string, string> = { ...woLineJobLabels }",
  );
});

Deno.test("index.ts WO card read fails loudly instead of silently skipping the lock", () => {
  assertStringIncludes(
    INDEX,
    "throw new Error('Failed to load the job cards behind work-order lines: ' + woCardErr.message)",
  );
});
