// deno-lint-ignore-file no-explicit-any no-import-prefix

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _persistWeeklyTradeInvoice,
  _persistWorkOrderInvoice,
  _resolveWeeklyWorkOrderInvoice,
  type TradeAuthContext,
} from "./index.ts";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const HENRY: TradeAuthContext = {
  id: "00000000-0000-0000-0000-000000000010",
  email: "henry@example.com",
  orgId: ORG_ID,
  role: "lead_installer",
  managedVerticals: ["fencing"],
};

type ResolverFixtures = {
  workOrders: any[];
  charges?: any[];
  workOrderUses?: any[];
  chargeUses?: any[];
  individualInvoices?: any[];
  users?: any[];
  rates?: any[];
  assignments?: any[];
};

function resolverClient(fixtures: ResolverFixtures): any {
  return {
    from(table: string) {
      let selected = "";
      const builder: any = {
        select(columns: string) {
          selected = columns;
          return builder;
        },
        eq: () => builder,
        in: () => builder,
        lte: () => builder,
        or: () => builder,
        order: () => builder,
        then(resolve: (value: unknown) => void) {
          let data: any[] = [];
          if (table === "work_orders") data = fixtures.workOrders;
          if (table === "trade_invoices") {
            data = fixtures.individualInvoices || [];
          }
          if (table === "trade_invoice_lines") {
            if (selected.startsWith("source_work_order_id")) {
              data = fixtures.workOrderUses || [];
            } else if (selected.startsWith("source_trade_invoice_line_id")) {
              data = fixtures.chargeUses || [];
            } else {
              data = fixtures.charges || [];
            }
          }
          if (table === "users") data = fixtures.users || [];
          if (table === "trade_rates") data = fixtures.rates || [];
          if (table === "job_assignments") {
            data = fixtures.assignments || [];
          }
          resolve({ data, error: null });
        },
      };
      return builder;
    },
  };
}

function completedWorkOrder(date = "2026-08-26T09:30:00Z") {
  return {
    id: "00000000-0000-0000-0000-000000000100",
    org_id: ORG_ID,
    job_id: "00000000-0000-0000-0000-000000000200",
    wo_number: "WO-100",
    status: "complete",
    completed_at: date,
    scheduled_date: "2026-08-26",
    assigned_user_id: HENRY.id,
    site_address: "10 Test Street",
    scope_items: [
      {
        description: "Fence Installation",
        quantity: 20,
        unit: "m",
        unit_price: 35,
      },
      { description: "Gate Install", quantity: 1, unit: "ea", unit_price: 250 },
    ],
    jobs: {
      id: "00000000-0000-0000-0000-000000000200",
      org_id: ORG_ID,
      job_number: "SWF-100",
      client_name: "Test Client",
      type: "fencing",
      site_address: "10 Test Street",
      site_suburb: "Perth",
    },
  };
}

Deno.test("weekly resolver ignores client money and pins every deduction to server sources", async () => {
  const crewUserId = "00000000-0000-0000-0000-000000000020";
  const chargeLineId = "00000000-0000-0000-0000-000000000300";
  const assignmentId = "00000000-0000-0000-0000-000000000400";
  const oldRateId = "00000000-0000-0000-0000-000000000500";
  const client = resolverClient({
    workOrders: [completedWorkOrder()],
    charges: [{
      id: chargeLineId,
      job_id: "00000000-0000-0000-0000-000000000200",
      line_type: "labour",
      description: "Fence Installation",
      quantity: 10,
      unit: "m",
      unit_rate: 38,
      line_total_ex: 380,
      override_amount: null,
      acknowledgment_status: "acknowledged",
      trade_invoices: {
        org_id: ORG_ID,
        user_id: "00000000-0000-0000-0000-000000000030",
        status: "pushed_to_xero",
        users: { name: "Israel" },
      },
    }],
    users: [{ id: crewUserId, org_id: ORG_ID, name: "Isaac" }],
    // The later rate overlaps the week but is not effective on this work
    // order's 26 August completion date. The resolver must choose the dated
    // $40 source, not simply the newest row in the week.
    rates: [{
      id: "00000000-0000-0000-0000-000000000501",
      user_id: crewUserId,
      hourly_rate: 45,
      effective_from: "2026-08-27",
      effective_to: null,
    }, {
      id: oldRateId,
      user_id: crewUserId,
      hourly_rate: 40,
      effective_from: "2026-01-01",
      effective_to: "2026-08-26",
    }],
    assignments: [{
      id: assignmentId,
      job_id: "00000000-0000-0000-0000-000000000200",
      user_id: crewUserId,
      status: "complete",
    }],
  });

  const invoice = await _resolveWeeklyWorkOrderInvoice(
    client,
    HENRY,
    false,
    "2026-08-24",
    "2026-08-30",
    {
      work_order_blocks: [{
        work_order_id: "00000000-0000-0000-0000-000000000100",
        crew_charge_line_ids: [chargeLineId],
        labour_deductions: [{
          user_id: crewUserId,
          hours: 2,
          rate: 999,
          line_total_ex: 1,
        }],
      }],
      final_deductions: [{
        description: "Car Loan",
        quantity: 1,
        unit_rate: 50,
        line_total_ex: 1,
      }],
      total: 1,
    },
  );

  assertEquals(invoice.job_blocks.map((block) => block.subtotal), [490]);
  assertEquals(
    invoice.job_blocks[0].source_work_order_id,
    completedWorkOrder().id,
  );
  assertEquals(invoice.job_blocks[0].site_address, "10 Test Street");
  assertEquals(invoice.grand_total, 490);
  assertEquals(invoice.final_deductions_total, 50);
  assertEquals(invoice.to_be_paid, 440);

  const crewLine = invoice.lines.find((line) =>
    line.line_type === "crew_work_order_deduction"
  );
  assertEquals(crewLine?.line_total_ex, -380);
  assertEquals(crewLine?.source_trade_invoice_line_id, chargeLineId);

  const labourLine = invoice.lines.find((line) =>
    line.line_type === "labour_deduction"
  );
  assertEquals(labourLine?.unit_rate, -40);
  assertEquals(labourLine?.line_total_ex, -80);
  assertEquals(labourLine?.deduction_assignment_id, assignmentId);
  assertEquals(labourLine?.deduction_trade_rate_id, oldRateId);
  assertEquals(invoice.final_deductions[0].line_total_ex, -50);
});

Deno.test("weekly resolver refuses a completed work order outside the selected week", async () => {
  await assertRejects(
    () =>
      _resolveWeeklyWorkOrderInvoice(
        resolverClient({
          workOrders: [completedWorkOrder("2026-08-31T09:30:00Z")],
        }),
        HENRY,
        false,
        "2026-08-24",
        "2026-08-30",
        {
          work_order_blocks: [{
            work_order_id: "00000000-0000-0000-0000-000000000100",
          }],
        },
      ),
    Error,
    "inside the selected week",
  );
});

Deno.test("weekly resolver assigns late UTC completion to the Perth week", async () => {
  const workOrder = completedWorkOrder("2026-08-30T16:30:00Z");
  const invoice = await _resolveWeeklyWorkOrderInvoice(
    resolverClient({ workOrders: [workOrder] }),
    HENRY,
    false,
    "2026-08-31",
    "2026-09-06",
    {
      work_order_blocks: [{ work_order_id: workOrder.id }],
    },
  );

  assertEquals(invoice.job_blocks[0].line_date, "2026-08-31");
  assertEquals(
    new Set(invoice.lines.map((line) => line.line_date)),
    new Set(["2026-08-31"]),
  );
});

Deno.test("weekly resolver refuses the same crew charge twice", async () => {
  const chargeLineId = "00000000-0000-0000-0000-000000000300";
  await assertRejects(
    () =>
      _resolveWeeklyWorkOrderInvoice(
        resolverClient({ workOrders: [completedWorkOrder()] }),
        HENRY,
        false,
        "2026-08-24",
        "2026-08-30",
        {
          work_order_blocks: [{
            work_order_id: "00000000-0000-0000-0000-000000000100",
            crew_charge_line_ids: [chargeLineId, chargeLineId],
          }],
        },
      ),
    Error,
    "only be deducted once",
  );
});

Deno.test("weekly resolver refuses duplicate direct-labour rows", async () => {
  const crewUserId = "00000000-0000-0000-0000-000000000020";
  await assertRejects(
    () =>
      _resolveWeeklyWorkOrderInvoice(
        resolverClient({ workOrders: [completedWorkOrder()] }),
        HENRY,
        false,
        "2026-08-24",
        "2026-08-30",
        {
          work_order_blocks: [{
            work_order_id: "00000000-0000-0000-0000-000000000100",
            labour_deductions: [
              { user_id: crewUserId, hours: 1 },
              { user_id: crewUserId, hours: 2 },
            ],
          }],
        },
      ),
    Error,
    "one combined labour deduction",
  );
});

Deno.test("weekly persistence sends one complete server-owned invoice to the database boundary", async () => {
  const workOrder = completedWorkOrder();
  const resolved = await _resolveWeeklyWorkOrderInvoice(
    resolverClient({ workOrders: [workOrder] }),
    HENRY,
    false,
    "2026-08-24",
    "2026-08-30",
    {
      work_order_blocks: [{ work_order_id: workOrder.id }],
    },
  );
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const invoiceId = await _persistWeeklyTradeInvoice(
    {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: "00000000-0000-0000-0000-000000000900",
          error: null,
        });
      },
    },
    {
      user_id: HENRY.id,
      org_id: ORG_ID,
      week_start: "2026-08-24",
      subtotal_ex: resolved.to_be_paid,
    },
    resolved,
    null,
  );

  assertEquals(invoiceId, "00000000-0000-0000-0000-000000000900");
  const call = calls[0];
  if (!call) throw new Error("weekly persistence RPC was not called");
  assertEquals(call.name, "persist_weekly_trade_invoice_v1");
  assertEquals(call.args.p_requested_prior_draft_id, null);
  assertEquals(
    (call.args.p_lines as Array<Record<string, unknown>>).map((line) => ({
      line_position: line.line_position,
      total_hours: line.total_hours,
      hourly_rate: line.hourly_rate,
      line_total_ex: line.line_total_ex,
      source_work_order_id: line.source_work_order_id,
    })),
    [
      {
        line_position: 0,
        total_hours: null,
        hourly_rate: null,
        line_total_ex: 700,
        source_work_order_id: workOrder.id,
      },
      {
        line_position: 1,
        total_hours: null,
        hourly_rate: null,
        line_total_ex: 250,
        source_work_order_id: workOrder.id,
      },
    ],
  );
});

Deno.test("single-work-order persistence uses the same atomic source-claim boundary", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const invoiceId = await _persistWorkOrderInvoice(
    {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: "00000000-0000-0000-0000-000000000901",
          error: null,
        });
      },
    },
    {
      org_id: ORG_ID,
      user_id: HENRY.id,
      work_order_id: "00000000-0000-0000-0000-000000000100",
      invoice_source: "work_order",
      subtotal_ex: 320,
    },
    [{
      job_id: "00000000-0000-0000-0000-000000000200",
      line_type: "crew_work_order_deduction",
      line_total_ex: -380,
      source_trade_invoice_line_id: "00000000-0000-0000-0000-000000000300",
    }],
    "00000000-0000-0000-0000-000000000800",
  );

  assertEquals(invoiceId, "00000000-0000-0000-0000-000000000901");
  assertEquals(calls, [{
    name: "persist_trade_work_order_invoice_v1",
    args: {
      p_invoice: {
        org_id: ORG_ID,
        user_id: HENRY.id,
        work_order_id: "00000000-0000-0000-0000-000000000100",
        invoice_source: "work_order",
        subtotal_ex: 320,
      },
      p_lines: [{
        job_id: "00000000-0000-0000-0000-000000000200",
        line_type: "crew_work_order_deduction",
        line_total_ex: -380,
        source_trade_invoice_line_id: "00000000-0000-0000-0000-000000000300",
        line_position: 0,
      }],
      p_requested_prior_draft_id: "00000000-0000-0000-0000-000000000800",
    },
  }]);
});
