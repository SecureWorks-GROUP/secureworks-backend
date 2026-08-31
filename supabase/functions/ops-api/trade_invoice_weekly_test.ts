// deno-lint-ignore-file no-import-prefix

import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildWeeklyWorkOrderInvoice,
  WeeklyInvoiceError,
} from "./trade_invoice_weekly.ts";

type ScopeLine = {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
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
