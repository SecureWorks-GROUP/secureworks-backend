// deno-lint-ignore-file no-import-prefix

import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildPerMetreWorkOrderScope,
  isPerMetreWorkOrder,
  PER_METRE_FENCING_RATE,
  PER_METRE_WORK_ORDER_MARKER,
  perMetreScopeMetres,
  planPerMetreWorkOrder,
  pricedWorkOrderScopeLines,
  WeeklyInvoiceError,
  workOrderHasPricedScope,
  workOrderIsInvoiceReady,
} from "./trade_invoice_weekly.ts";

const henry = {
  id: "henry",
  orgId: "org-1",
  managedVerticals: ["fencing"],
};

const fencingJob = {
  id: "job-1",
  org_id: "org-1",
  job_number: "SWF-26869",
  type: "fencing",
  status: "get_review",
};

const ownAssignment = {
  id: "asn-1",
  user_id: "henry",
  status: "complete",
  scheduled_date: "2026-09-03",
};

function plan(overrides: Partial<Parameters<typeof planPerMetreWorkOrder>[0]> = {}) {
  return planPerMetreWorkOrder({
    viewer: henry,
    isPerMetreUser: true,
    job: fencingJob,
    jobVertical: "fencing",
    assignments: [ownAssignment],
    existingWorkOrders: [],
    existingWorkOrderInvoiceUses: [],
    metres: 12,
    ...overrides,
  });
}

Deno.test("perMetreScopeMetres sums scoping-tool run lengths", () => {
  const scope = {
    job: {
      runs: [{ length: 12 }, { length: 15.1 }, { lengthM: 3.4 }, { name: "no length" }],
    },
  };
  assertEquals(perMetreScopeMetres(scope), 30.5);
  assertEquals(perMetreScopeMetres(JSON.stringify(scope)), 30.5);
  assertEquals(perMetreScopeMetres({ config: { totalLength: 22 } }), 22);
  assertEquals(perMetreScopeMetres(null), 0);
  assertEquals(perMetreScopeMetres("not json"), 0);
});

Deno.test("per-metre scope prices through the weekly builder grammar", () => {
  const scope = buildPerMetreWorkOrderScope(12.5);
  assertEquals(scope, [{
    description: "Fencing installation",
    quantity: 12.5,
    unit: "m",
    rate: PER_METRE_FENCING_RATE,
    total: 437.5,
  }]);
  assert(workOrderHasPricedScope(scope));
  const [line] = pricedWorkOrderScopeLines(scope, "SWF-26869");
  assertEquals(line.qty, 12.5);
  assertEquals(line.price, 35);
  assertEquals(line.amount_ex, 437.5);
  assertEquals(line.unit, "m");
});

Deno.test("per-metre quantity fails closed on zero, negative and absurd metres", () => {
  assertThrows(() => buildPerMetreWorkOrderScope(0), WeeklyInvoiceError);
  assertThrows(() => buildPerMetreWorkOrderScope(-3), WeeklyInvoiceError);
  assertThrows(() => buildPerMetreWorkOrderScope("abc"), WeeklyInvoiceError);
  assertThrows(() => buildPerMetreWorkOrderScope(5001), WeeklyInvoiceError);
});

Deno.test("planPerMetreWorkOrder creates a complete work order the weekly builder accepts", () => {
  const result = plan();
  assertEquals(result.mode, "create");
  assertEquals(result.existing_work_order_id, null);
  assertEquals(result.work_date, "2026-09-03");
  assertEquals(result.metres, 12);
  assertEquals(result.rate, 35);
  assertEquals(result.amount_ex, 420);
  assert(workOrderIsInvoiceReady({ status: "complete", jobs: fencingJob }));
});

Deno.test("planPerMetreWorkOrder uses the latest own assignment date unless a work date is given", () => {
  const result = plan({
    assignments: [
      ownAssignment,
      { ...ownAssignment, id: "asn-2", scheduled_date: "2026-09-05" },
      { id: "asn-other", user_id: "someone", status: "complete", scheduled_date: "2026-09-06" },
    ],
  });
  assertEquals(result.work_date, "2026-09-05");
  assertEquals(plan({ work_date: "2026-09-04" }).work_date, "2026-09-04");
});

Deno.test("planPerMetreWorkOrder refuses hourly users, foreign jobs and unmanaged verticals", () => {
  assertThrows(() => plan({ isPerMetreUser: false }), WeeklyInvoiceError, "per-metre");
  assertThrows(() => plan({ job: { ...fencingJob, org_id: "org-2" } }), WeeklyInvoiceError, "not found");
  assertThrows(() => plan({ job: null }), WeeklyInvoiceError, "not found");
  assertThrows(() => plan({ jobVertical: "patio" }), WeeklyInvoiceError, "outside the work you manage");
});

Deno.test("planPerMetreWorkOrder requires the trade to hold a live assignment on the job", () => {
  assertThrows(() => plan({ assignments: [] }), WeeklyInvoiceError, "not assigned");
  assertThrows(
    () => plan({ assignments: [{ ...ownAssignment, status: "cancelled" }] }),
    WeeklyInvoiceError,
    "not assigned",
  );
  assertThrows(
    () => plan({ assignments: [{ ...ownAssignment, user_id: "someone" }] }),
    WeeklyInvoiceError,
    "not assigned",
  );
});

Deno.test("planPerMetreWorkOrder never duplicates an ops-issued work order", () => {
  assertThrows(
    () => plan({ existingWorkOrders: [{ id: "wo-ops", status: "sent", assigned_user_id: "henry" }] }),
    WeeklyInvoiceError,
    "already has a work order",
  );
  // Cancelled ops work orders do not block.
  assertEquals(
    plan({ existingWorkOrders: [{ id: "wo-ops", status: "cancelled", assigned_user_id: "henry" }] }).mode,
    "create",
  );
});

Deno.test("planPerMetreWorkOrder re-measures its own uninvoiced work order", () => {
  const own = {
    id: "wo-mine",
    status: "complete",
    assigned_user_id: "henry",
    special_instructions: `${PER_METRE_WORK_ORDER_MARKER}: created in the Trade app`,
  };
  assert(isPerMetreWorkOrder(own));
  const result = plan({ existingWorkOrders: [own], metres: 14 });
  assertEquals(result.mode, "update");
  assertEquals(result.existing_work_order_id, "wo-mine");
  assertEquals(result.amount_ex, 490);

  // A draft use is fine (the trade is still building the week).
  assertEquals(
    plan({
      existingWorkOrders: [own],
      existingWorkOrderInvoiceUses: [{ source_work_order_id: "wo-mine", status: "draft" }],
    }).mode,
    "update",
  );
  // A submitted use locks the metres.
  assertThrows(
    () => plan({
      existingWorkOrders: [own],
      existingWorkOrderInvoiceUses: [{ source_work_order_id: "wo-mine", status: "pending_acknowledgment" }],
    }),
    WeeklyInvoiceError,
    "already been invoiced",
  );
  // Someone else's per-metre work order on the job is not ours to change.
  assertThrows(
    () => plan({ existingWorkOrders: [{ ...own, assigned_user_id: "someone" }] }),
    WeeklyInvoiceError,
    "already has a work order",
  );
});
