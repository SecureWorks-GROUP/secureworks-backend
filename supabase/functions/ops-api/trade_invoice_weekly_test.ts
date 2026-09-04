// deno-lint-ignore-file no-import-prefix

import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildWeeklyWorkOrderInvoice,
  WeeklyInvoiceError,
  workOrderIsInvoiceReady,
} from "./trade_invoice_weekly.ts";

type ScopeLine = {
  description?: string;
  item?: string;
  name?: string;
  quantity?: number | string;
  metres?: number | string;
  qty?: number | string;
  unit?: string;
  unit_price?: number | string;
  unit_price_ex?: number | string;
  rate?: number | string;
  price?: number | string;
  total?: number | string;
};

type CrewDeduction = {
  line_id: string;
  trade_name: string;
  description: string;
  source_line_type: string;
  quantity: number;
  unit: string;
  source_unit_rate: number;
  amount_ex: number;
};

function jobBlock(
  sequence: number,
  jobNumber: string,
  scopeItems: ScopeLine[],
  crewDeductions: CrewDeduction[] = [],
  labourDeductions: Array<{
    user_id: string;
    user_name: string;
    hours: number;
    rate: number;
    assignment_id: string;
    trade_rate_id: string;
  }> = [],
) {
  return {
    work_order: {
      id: `wo-${sequence}`,
      job_id: `job-${sequence}`,
      wo_number: `WO-${sequence}`,
      status: "complete",
      completed_at: "2026-08-24T08:00:00Z",
      scheduled_date: "2026-08-24",
      site_address: `${sequence} Test Street, Perth WA`,
      scope_items: scopeItems,
      jobs: {
        id: `job-${sequence}`,
        job_number: jobNumber,
        client_name: `Client ${sequence}`,
        type: jobNumber.startsWith("SWP-") ? "patio" : "fencing",
        status: "complete",
        site_address: `${sequence} Test Street`,
        site_suburb: "Perth",
      },
    },
    crew_deductions: crewDeductions,
    labour_deductions: labourDeductions,
  };
}

function scope(
  description: string,
  quantity: number,
  unit: string,
  unitPrice: number,
): ScopeLine {
  return { description, quantity, unit, unit_price: unitPrice };
}

function crew(
  id: string,
  tradeName: string,
  description: string,
  quantity: number,
  unit: string,
  unitRate: number,
  lineType = "labour",
  approvedAmount?: number,
): CrewDeduction {
  return {
    line_id: id,
    trade_name: tradeName,
    description,
    source_line_type: lineType,
    quantity,
    unit,
    source_unit_rate: unitRate,
    amount_ex: approvedAmount === undefined
      ? -Math.round(quantity * unitRate * 100) / 100
      : -Math.abs(approvedAmount),
  };
}

Deno.test("Henry invoice 31 weekly blocks are server-totalled exactly", () => {
  const invoice = buildWeeklyWorkOrderInvoice({
    job_blocks: [
      jobBlock(1, "SWF-261111", [
        scope("Fence Installation", 12.8, "m", 35),
        scope("Fence Removal", 12.8, "m", 10),
        scope("Plinths", 12, "ea", 10),
        scope("Logistics - Disposal/Pickup", 3, "hr", 40),
      ], [
        crew("1-israel", "Israel", "Fence Installation", 12.8, "m", 38),
        crew("1-plinths", "Israel", "Plinths", 12, "ea", 5, "materials"),
        crew("1-disposal", "Israel", "Disposal", 3, "hr", 35, "travel"),
      ]),
      jobBlock(2, "SWF-261132", [
        scope("Fence Installation", 25.6, "m", 35),
        scope("Fence Removal", 25.6, "m", 10),
        scope("Plinths", 11, "ea", 10),
        scope("Logistics - Disposal", 2, "hr", 40),
      ], [
        crew("2-israel", "Israel", "Fence Installation", 25.6, "m", 38),
        crew("2-plinths", "Israel", "Plinths", 11, "ea", 5, "materials"),
        crew("2-disposal", "Israel", "Disposal", 2, "hr", 35, "travel"),
      ]),
      jobBlock(3, "SWF-261108", [
        scope("Fence Installation", 4.8, "m", 35),
        scope("Fence Removal", 4.8, "m", 10),
        scope("Plinths", 2, "ea", 10),
        scope("Logistics - Disposal", 1, "hr", 40),
      ], [
        crew("3-ryan", "Ryan", "Fence Installation", 4.8, "m", 38),
        crew("3-plinths", "Ryan", "Plinths", 2, "ea", 5, "materials"),
        crew("3-disposal", "Ryan", "Disposal", 1, "hr", 35, "travel"),
      ]),
      jobBlock(
        4,
        "SWF-26984",
        [
          scope("Fence Installation", 60, "m", 35),
          scope("Gate Install", 2, "ea", 250),
          scope("Plinths", 39, "ea", 10),
          scope("Extra Labour x 2 Trades", 6, "hr", 80),
          scope("Logistics - Disposal/Pickup", 4, "hr", 40),
        ],
        [],
        [
          {
            user_id: "isaac",
            user_name: "Isaac",
            hours: 26,
            rate: 40,
            assignment_id: "assignment-isaac",
            trade_rate_id: "rate-isaac",
          },
          {
            user_id: "hugo",
            user_name: "Hugo",
            hours: 2,
            rate: 40,
            assignment_id: "assignment-hugo",
            trade_rate_id: "rate-hugo",
          },
        ],
      ),
      jobBlock(5, "SWF-26667", [
        scope("Fence Installation", 17, "m", 35),
        scope("Fence Removal", 17, "m", 10),
        scope("Plinths", 21, "ea", 10),
        scope("Patio Tubes", 8, "ea", 10),
        scope("Logistics - Material Pickup/Disposal", 2, "hr", 40),
      ], [
        crew("5-alyx", "Alyx", "Fence Installation", 17, "m", 38),
        crew("5-plinths", "Alyx", "Plinths", 21, "ea", 5, "materials"),
        crew("5-tubes", "Alyx", "Patio Tubes", 8, "ea", 5, "materials"),
        crew("5-disposal", "Alyx", "Pickup/Disposal", 2, "hr", 35, "travel"),
      ]),
      jobBlock(6, "SWF-26889", [
        scope("Fence Installation", 14.2, "m", 35),
        scope("Fence Removal", 14.2, "m", 10),
        scope("Logistics - Disposal", 2, "hr", 40),
        scope("Plinths", 5, "ea", 10),
      ], [
        crew("6-alyx", "Alyx", "Fence Installation", 14.2, "m", 45),
        crew("6-plinths", "Alyx", "Plinths", 5, "ea", 5, "materials"),
        crew("6-disposal", "Alyx", "Disposal", 2, "hr", 35, "travel"),
      ]),
      jobBlock(7, "SWF-26824", [
        scope("Fence Installation", 43.4, "m", 35),
        scope("Fence Removal/Asbestos", 30, "m", 40),
        scope("Plinths", 41, "ea", 10),
        scope("Patio Tubes", 5, "ea", 10),
        scope("Logistics - Disposal", 3, "hr", 40),
      ], [
        crew(
          "7-israel",
          "Israel",
          "Fence Installation",
          43.4,
          "m",
          30,
          "labour",
          1262,
        ),
        crew("7-removal", "Israel", "Removal", 30, "m", 30, "labour", 860),
        crew("7-plinths", "Israel", "Plinths", 41, "ea", 5, "materials"),
        crew("7-tubes", "Israel", "Patio Tubes", 5, "ea", 5, "materials"),
        crew("7-disposal", "Israel", "Disposal", 3, "hr", 35, "travel"),
      ]),
      jobBlock(8, "SWG-20260713-BE", [
        scope("Fence Installation", 7.2, "m", 35),
        scope("Fence Removal", 4.8, "m", 10),
        scope("Lattice", 7.2, "ea", 25),
        scope("Logistics - Disposal/Pickup/Travel", 4, "hr", 40),
      ]),
      jobBlock(9, "SWP-SHIRLEY", [
        scope("Patio Installation", 9, "ea", 45),
      ]),
    ],
    final_deductions: [{
      description: "Car Loan",
      quantity: 1,
      unit: "ea",
      unit_rate: 350,
    }],
  });

  assertEquals(
    invoice.job_blocks.map((block) => block.subtotal),
    [164.6, 244.2, 48.6, 2510, 274, 35, 842, 640, 405],
  );
  assertEquals(
    invoice.job_blocks.map((block) => block.source_work_order_id),
    ["wo-1", "wo-2", "wo-3", "wo-4", "wo-5", "wo-6", "wo-7", "wo-8", "wo-9"],
  );
  assertEquals(invoice.job_blocks[0].site_address, "1 Test Street, Perth WA");
  assertEquals(invoice.grand_total, 5163.4);
  assertEquals(invoice.final_deductions_total, 350);
  assertEquals(invoice.to_be_paid, 4813.4);
  assertEquals(
    invoice.lines.reduce((sum, line) => sum + line.line_total_ex, 0),
    4813.4,
  );
  assertEquals(
    invoice.final_deductions,
    [{
      line_type: "final_payout_deduction",
      description: "Car Loan",
      quantity: 1,
      unit: "ea",
      unit_rate: -350,
      line_total_ex: -350,
      job_id: null,
      job_number: null,
      client_name: null,
      site_address: null,
      line_date: null,
      division: null,
      source_work_order_id: null,
      source_trade_invoice_line_id: null,
      deduction_user_id: null,
      deduction_assignment_id: null,
      deduction_trade_rate_id: null,
    }],
  );
  assertEquals(
    new Set(
      invoice.lines.filter((line) => line.line_total_ex < 0).map((line) =>
        line.line_type
      ),
    ),
    new Set([
      "crew_work_order_deduction",
      "labour_deduction",
      "travel_logistics_deduction",
      "materials_deduction",
      "final_payout_deduction",
    ]),
  );
});

Deno.test("weekly invoice refuses unsigned deductions and client total claims", () => {
  assertThrows(
    () =>
      buildWeeklyWorkOrderInvoice({
        job_blocks: [jobBlock(1, "SWF-1", [scope("Install", 1, "ea", 100)], [{
          ...crew("bad", "Crew", "Install", 1, "ea", 50),
          amount_ex: 50,
        }])],
        final_deductions: [],
      }),
    WeeklyInvoiceError,
    "crew deduction must be negative",
  );

  assertThrows(
    () =>
      buildWeeklyWorkOrderInvoice({
        job_blocks: [jobBlock(1, "SWF-1", [scope("Install", 1, "ea", 100)])],
        final_deductions: [{
          description: "Bad deduction",
          quantity: 1,
          unit: "ea",
          unit_rate: -50,
          total: 999,
        }],
      }),
    WeeklyInvoiceError,
    "final deduction rate must be positive",
  );
});

Deno.test("weekly blocks keep distinct work orders on the same job", () => {
  const first = jobBlock(10, "SWF-200", [scope("Install", 2, "m", 35)]);
  const second = jobBlock(11, "SWF-200", [scope("Gate", 1, "ea", 250)]);
  first.work_order.completed_at = "2026-08-25T08:00:00Z";
  second.work_order.completed_at = "2026-08-26T08:00:00Z";
  first.work_order.site_address = "10 First Street, Balcatta";
  second.work_order.job_id = first.work_order.job_id;
  second.work_order.jobs = first.work_order.jobs;
  second.work_order.site_address = "20 Second Street, Balcatta";

  const invoice = buildWeeklyWorkOrderInvoice({
    job_blocks: [first, second],
  });

  assertEquals(
    invoice.job_blocks.map((block) => ({
      source_work_order_id: block.source_work_order_id,
      job_id: block.job_id,
      line_date: block.line_date,
      site_address: block.site_address,
      subtotal: block.subtotal,
    })),
    [{
      source_work_order_id: "wo-10",
      job_id: "job-10",
      line_date: "2026-08-25",
      site_address: "10 First Street, Balcatta",
      subtotal: 70,
    }, {
      source_work_order_id: "wo-11",
      job_id: "job-10",
      line_date: "2026-08-26",
      site_address: "20 Second Street, Balcatta",
      subtotal: 250,
    }],
  );
});

Deno.test("weekly scope lines skip blank numeric candidates", () => {
  const block = jobBlock(12, "SWF-201", [{
    description: "Fence Installation",
    quantity: "",
    metres: 12,
    unit: "m",
    unit_price: "",
    rate: 35,
  }]);
  block.work_order.site_address = "10 Main St, Balcatta";
  block.work_order.jobs.site_suburb = "Balcatta";

  const invoice = buildWeeklyWorkOrderInvoice({ job_blocks: [block] });

  assertEquals(invoice.lines[0].quantity, 12);
  assertEquals(invoice.lines[0].unit_rate, 35);
  assertEquals(invoice.lines[0].line_total_ex, 420);
  assertEquals(invoice.job_blocks[0].site_address, "10 Main St, Balcatta");
});

Deno.test("crew-pay qty/item/rate lines invoice submitted amounts and skip $0 materials", () => {
  const block = jobBlock(14, "SWF-26041", [
    {
      qty: 59,
      item: "Colorbond fence install — 59m Sameside Monument 1800mm",
      rate: 30,
      unit: "m",
      total: 1770,
    },
    {
      qty: 27,
      item: "Retaining plinth install",
      rate: 10,
      unit: "ea",
      total: 270,
    },
    {
      qty: 20,
      item: "Timber fence removal & disposal",
      rate: 10,
      unit: "m",
      total: 200,
    },
    {
      qty: 54,
      item: "Kwikset (2 bags per post, 27 posts)",
      rate: 0,
      unit: "bags",
      total: 0,
    },
  ]);
  block.work_order.status = "sent";
  block.work_order.completed_at = "";
  block.work_order.scheduled_date = "2026-04-07";
  block.work_order.jobs.status = "archived";

  const invoice = buildWeeklyWorkOrderInvoice({ job_blocks: [block] });

  assertEquals(
    invoice.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unit_rate: line.unit_rate,
      line_total_ex: line.line_total_ex,
    })),
    [
      {
        description: "Colorbond fence install — 59m Sameside Monument 1800mm",
        quantity: 59,
        unit_rate: 30,
        line_total_ex: 1770,
      },
      {
        description: "Retaining plinth install",
        quantity: 27,
        unit_rate: 10,
        line_total_ex: 270,
      },
      {
        description: "Timber fence removal & disposal",
        quantity: 20,
        unit_rate: 10,
        line_total_ex: 200,
      },
    ],
  );
  assertEquals(invoice.job_blocks[0].subtotal, 2240);
  assertEquals(invoice.to_be_paid, 2240);
});

Deno.test("quote unit_price_ex lines are not trade pay and refuse an unpriced order", () => {
  const block = jobBlock(15, "SWF-quote", [{
    quantity: 6,
    description: "Basalt Trimclad fencing — 6.0m",
    unit: "m",
    unit_price_ex: 81,
  }]);
  assertThrows(
    () => buildWeeklyWorkOrderInvoice({ job_blocks: [block] }),
    WeeklyInvoiceError,
    "has no priced work-order scope items",
  );
});

Deno.test("sent work orders are invoice-ready only on a finished job", () => {
  assertEquals(workOrderIsInvoiceReady({ status: "complete" }), true);
  assertEquals(
    workOrderIsInvoiceReady({
      status: "sent",
      jobs: { status: "archived" },
    }),
    true,
  );
  assertEquals(
    workOrderIsInvoiceReady({
      status: "accepted",
      jobs: { status: "invoiced" },
    }),
    true,
  );
  assertEquals(
    workOrderIsInvoiceReady({
      status: "sent",
      jobs: { status: "in_progress" },
    }),
    false,
  );
  assertEquals(
    workOrderIsInvoiceReady({
      status: "draft",
      jobs: { status: "archived" },
    }),
    false,
  );
});

Deno.test("weekly money is calculated from the two-decimal values that are stored", () => {
  const invoice = buildWeeklyWorkOrderInvoice({
    job_blocks: [jobBlock(13, "SWF-202", [
      scope("Fence Installation", 1.005, "m", 100),
    ])],
    final_deductions: [{
      description: "Equipment repayment",
      quantity: 1.005,
      unit: "ea",
      unit_rate: 10,
    }],
  });

  assertEquals(invoice.lines[0].quantity, 1.01);
  assertEquals(invoice.lines[0].unit_rate, 100);
  assertEquals(invoice.lines[0].line_total_ex, 101);
  assertEquals(invoice.job_blocks[0].subtotal, 101);
  assertEquals(invoice.final_deductions[0].quantity, 1.01);
  assertEquals(invoice.final_deductions[0].line_total_ex, -10.1);
  assertEquals(invoice.to_be_paid, 90.9);
});
