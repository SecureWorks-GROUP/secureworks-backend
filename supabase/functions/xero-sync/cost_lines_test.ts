import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { billCostDocument, collectBillCostDocument } from "./cost_lines.ts";
import { LABOUR } from "../_shared/people_accounts_test_support.ts";
import { labourAccounts } from "../_shared/people_accounts.ts";
const ctx = {
  orgId: "10000000-0000-4000-8000-000000000001",
  mirrorBillIds: new Set<string>(),
  labour: LABOUR,
};
const bill = {
  xero_invoice_id: "ZZTEST-bill",
  invoice_type: "ACCPAY",
  status: "AUTHORISED",
  xero_contact_id: "ZZTEST-supplier",
  raw_json: { LineAmountTypes: "Exclusive" },
  line_items: [
    { LineItemID: "one", LineAmount: 400, TaxAmount: 40, AccountCode: "310" },
    { LineAmount: 600, TaxAmount: 60, AccountCode: "461" },
  ],
};
Deno.test("bill costs: source amounts, lanes, identities and mirror exclusion", () => {
  const d = billCostDocument(bill, ctx)!;
  assertEquals(d.live, true);
  assertEquals(d.party_id, "ZZTEST-supplier");
  assertEquals(d.lines.map((l) => [l.line_key, l.amount_ex, l.lane, l.kind]), [
    ["one", 400, "materials", "supplier_bill"],
    ["n:2", 600, "other", "supplier_bill"],
  ]);
  const inclusive = billCostDocument({
    ...bill,
    raw_json: { LineAmountTypes: "Inclusive" },
  }, ctx)!;
  assertEquals(inclusive.lines.map((l) => l.amount_ex), [360, 540]);
  const installer = billCostDocument({
    ...bill,
    line_items: [{ LineAmount: 800, AccountCode: "306" }],
  }, ctx)!;
  assertEquals([installer.lines[0].kind, installer.lines[0].lane], [
    "installer_bill",
    "labour",
  ]);
  assertEquals(
    billCostDocument({ ...bill, status: "VOIDED" }, ctx)!.live,
    false,
  );
  assertEquals(
    billCostDocument(bill, {
      ...ctx,
      mirrorBillIds: new Set([bill.xero_invoice_id]),
    }),
    null,
  );
  assertEquals(
    billCostDocument({ ...bill, invoice_type: "ACCREC" }, ctx),
    null,
  );
  assertEquals(
    billCostDocument({ ...bill, line_items: [{ LineAmount: 0 }] }, ctx)!.lines,
    [],
  );
});

Deno.test("bill costs: no stored lines retains the ex GST header total", () => {
  for (const line_items of [[], null, {}]) {
    const d = billCostDocument(
      { ...bill, line_items, sub_total: 123.45 },
      ctx,
    )!;
    assertEquals(d.lines.map((l) => [l.line_key, l.amount_ex]), [[
      "n:1",
      123.45,
    ]]);
  }
});
Deno.test("bill costs: stated employer contribution follows each non-withheld line", () => {
  const d = billCostDocument({
    ...bill,
    line_items: [
      {
        LineItemID: "base-a",
        LineAmount: 300,
        TaxAmount: 0,
        AccountCode: "306",
      },
      {
        LineItemID: "base-b",
        LineAmount: 500,
        TaxAmount: 0,
        AccountCode: "306",
      },
      {
        LineAmount: -40,
        Description: "Superannuation. Company contribution $80.00",
      },
    ],
  }, { ...ctx, employerSuperOn: true })!;
  assertEquals(
    d.lines.filter((l) => l.kind === "employer_super").map(
      (l) => [l.line_key, l.follows_line_key, l.amount_ex, l.paid],
    ),
    [
      ["base-a:employer_super", "base-a", 30, false],
      ["base-b:employer_super", "base-b", 50, false],
    ],
  );
  assertEquals(
    d.lines.filter((l) => l.kind !== "employer_super").map((l) => l.amount_ex),
    [300, 500],
  );
  assertEquals(
    billCostDocument(bill, ctx)!.lines.some((l) => l.kind === "employer_super"),
    false,
  );
});

Deno.test("bill costs: conversion error is recorded and later bills still sync", () => {
  const documents: NonNullable<ReturnType<typeof billCostDocument>>[] = [];
  const errors: string[] = [];
  collectBillCostDocument(
    { ...bill, line_items: [null] },
    ctx,
    documents,
    errors,
  );
  assertEquals(documents, []);
  assertEquals(errors.length, 1);
  collectBillCostDocument(bill, ctx, documents, errors);
  assertEquals(documents.length, 1);
});
Deno.test("bill costs: employer super stays gated and missing evidence stays absent", () => {
  const withSuper = {
    ...bill,
    line_items: [
      { LineAmount: 110, TaxAmount: 10, AccountCode: "306" },
      {
        LineAmount: -10,
        Description: "Super guarantee. Company contribution $20",
      },
    ],
    raw_json: { LineAmountTypes: "Inclusive" },
  };
  assertEquals(
    billCostDocument(withSuper, ctx)!.lines.map((l) => l.amount_ex),
    [100],
  );
  assertEquals(
    billCostDocument(withSuper, { ...ctx, employerSuperOn: true })!.lines.map(
      (l) => l.amount_ex,
    ),
    [100, 20],
  );
  assertEquals(
    billCostDocument({ ...withSuper, status: "VOIDED" }, {
      ...ctx,
      employerSuperOn: true,
    })!.lines.length,
    1,
  );
  assertEquals(
    billCostDocument({
      ...withSuper,
      line_items: [{ LineAmount: 100, Description: "Work" }],
    }, { ...ctx, employerSuperOn: true })!.lines.length,
    1,
  );
});

Deno.test("bill costs: an unknown no-line total stays unknown", () => {
  assertEquals(
    billCostDocument({ ...bill, line_items: [], sub_total: null }, ctx)!
      .lines[0].amount_ex,
    null,
  );
});

Deno.test("bill costs: employer super preserves six places for database cents rounding", () => {
  const d = billCostDocument({
    ...bill,
    line_items: [
      { LineAmount: -100.10, Description: "Adjustment" },
      { LineAmount: 1100.10, Description: "Work" },
      {
        LineAmount: -10,
        Description: "Super guarantee. Company contribution $50",
      },
    ],
  }, { ...ctx, employerSuperOn: true })!;
  assertEquals(
    d.lines.filter((l) => l.kind === "employer_super").map((l) => l.amount_ex),
    [-5.005, 55.005],
  );
});

Deno.test("bill costs: six-place rounding breaks negative ties away from zero", () => {
  const d = billCostDocument({
    ...bill,
    line_items: [
      { LineAmount: -1, Description: "Adjustment" },
      { LineAmount: 1000001, Description: "Work" },
      {
        LineAmount: -1,
        Description: "Super guarantee. Company contribution $0.50",
      },
    ],
  }, { ...ctx, employerSuperOn: true })!;
  assertEquals(
    d.lines.filter((l) => l.kind === "employer_super").map((l) => l.amount_ex),
    [-0.000001, 0.500001],
  );
});

Deno.test("labour flag: 306 is an installer line; 475 (hidden, not labour) and a padded 306 keep their kind; no figure moves", () => {
  const on = (code: string) => billCostDocument({ ...bill, line_items: [{ LineAmount: 500, AccountCode: code }] }, ctx)!.lines[0];
  assertEquals([on("306").kind, on("306").lane], ["installer_bill", "labour"]);
  assertEquals([on("475").kind, on("475").lane], ["supplier_bill", "other"]);
  assertEquals([on(" 306").kind, on(" 306").lane], ["supplier_bill", "other"]);
  // The flag decides, not code.
  const flagged = billCostDocument({ ...bill, line_items: [{ LineAmount: 500, AccountCode: "475" }] }, { ...ctx, labour: labourAccounts(["301", "306", "475"]) })!;
  assertEquals([flagged.lines[0].kind, flagged.lines[0].lane], ["installer_bill", "labour"]);
});
