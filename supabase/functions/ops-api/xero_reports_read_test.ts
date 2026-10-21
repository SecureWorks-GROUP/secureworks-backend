// deno-lint-ignore-file no-import-prefix no-explicit-any
//
// Accounting report reads. Pins the Xero query each action sends, the refusal
// of a bad request before any token or provider call, and the row grid the
// Jarvis wrappers will read.
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  readXeroAgedPayables,
  readXeroBalanceSheet,
  readXeroProfitAndLoss,
  readXeroTrialBalance,
  XeroReceivablesReadError,
} from "./xero_receivables_read.ts";

const TENANT = "10000000-0000-4000-8000-000000000001";
const ACCOUNT = "20000000-0000-4000-8000-000000000002";
const CATEGORY = "30000000-0000-4000-8000-000000000003";
const OPTION = "30000000-0000-4000-8000-000000000004";
const CATEGORY_2 = "30000000-0000-4000-8000-000000000005";
const OPTION_2 = "30000000-0000-4000-8000-000000000006";
const CONTACT = "60000000-0000-4000-8000-000000000006";
const INVOICE = "70000000-0000-4000-8000-000000000007";
const NOW = "2026-10-15T02:00:00.000Z";
const META = {
  shared_cooldown: null,
  request_id: null,
  quota: {
    minute_remaining: null,
    day_remaining: null,
    app_minute_remaining: null,
    limit_problem: null,
  },
};
const noDatabase = new Proxy({}, {
  get() {
    throw new Error("The read module must not access business/cache tables");
  },
});

function fixture(result: unknown) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  let tokenCalls = 0;
  return {
    calls,
    tokenCalls: () => tokenCalls,
    deps: {
      getToken: (client: unknown) => {
        tokenCalls += 1;
        assertStrictEquals(client, noDatabase);
        return Promise.resolve({
          accessToken: "fixture-only-token",
          tenantId: TENANT,
        });
      },
      xeroGet: (
        path: string,
        _t: string,
        _tenant: string,
        params?: Record<string, string>,
      ) => {
        calls.push({ path, params });
        return Promise.resolve({ data: result, metadata: META });
      },
      now: () => new Date(NOW),
    },
  };
}

function cell(value: string, account = false) {
  return account
    ? {
      Value: value,
      Attributes: [{ Id: "account", Value: ACCOUNT.toUpperCase() }],
    }
    : { Value: value };
}

function profitAndLoss() {
  return {
    Reports: [{
      ReportID: "ProfitAndLoss",
      ReportName: "Profit and Loss",
      ReportType: "ProfitAndLoss",
      ReportDate: "15 October 2026",
      ReportTitles: [
        "Profit & Loss",
        "SecureWorks Group",
        "1 October 2026 to 31 October 2026",
      ],
      Rows: [
        {
          RowType: "Header",
          Cells: [{ Value: "" }, { Value: "31 Oct 2026" }, {
            Value: "30 Sep 2026",
          }],
        },
        {
          RowType: "Section",
          Title: "Income",
          Rows: [
            {
              RowType: "Row",
              Cells: [cell("Sales", true), cell("1020.22"), cell("")],
            },
            {
              RowType: "Row",
              Cells: [cell("Other"), cell("(250.00)"), cell("  ")],
            },
            {
              RowType: "SummaryRow",
              Cells: [cell("Total Income"), cell("770.22"), cell("0.00")],
            },
          ],
        },
        {
          RowType: "Section",
          Title: "",
          Rows: [
            {
              RowType: "Section",
              Title: "Less Operating Expenses",
              Rows: [
                {
                  RowType: "Row",
                  Cells: [cell("Wages", true), cell("1,500.50"), cell("0")],
                },
              ],
            },
          ],
        },
      ],
    }],
  };
}

Deno.test("profit and loss: October 2026 is one calendar month, and cells keep blanks and credits", async () => {
  const f = fixture(profitAndLoss());
  const out = await readXeroProfitAndLoss(
    noDatabase,
    { month: "2026-10" },
    f.deps,
  );
  assertEquals(f.calls, [{
    path: "/Reports/ProfitAndLoss",
    params: { fromDate: "2026-10-01", toDate: "2026-10-31" },
  }]);
  assertEquals(f.tokenCalls(), 1);
  assertEquals(out.report.id, "ProfitAndLoss");
  assertEquals(out.report.columns, ["", "31 Oct 2026", "30 Sep 2026"]);
  assertEquals(out.filters, {
    month: "2026-10",
    date_from: "2026-10-01",
    date_to: "2026-10-31",
    periods: null,
    timeframe: null,
    tracking_category_id: null,
    tracking_option_id: null,
    tracking_category_id_2: null,
    tracking_option_id_2: null,
  });
  assertEquals(out.sections.length, 2);
  const sales = out.sections[0].rows[0];
  assertEquals(out.sections[0].title, "Income");
  assertEquals(sales.row_type, "Row");
  assertEquals(sales.cells[0].attributes, [{ id: "account", value: ACCOUNT }]);
  assertEquals(sales.cells[1].amount, 1020.22);
  assertEquals(sales.cells[2].amount, null, "empty cell is not zero");
  assertEquals(
    out.sections[0].rows[1].cells[1].amount,
    -250,
    "a parenthesised credit is negative",
  );
  assertEquals(
    out.sections[0].rows[1].cells[2].amount,
    null,
    "whitespace is not zero",
  );
  assertEquals(out.sections[0].rows[2].row_type, "SummaryRow");
  assertEquals(out.sections[0].rows[2].cells[2].amount, 0);
  assertEquals(out.sections[1].title, "Less Operating Expenses");
  assertEquals(out.sections[1].rows[0].cells[1].amount, 1500.5);
  assertEquals(JSON.stringify(out).includes("fixture-only-token"), false);
  assertEquals(out.coverage.source, "xero_reports_profit_and_loss");
});

Deno.test("profit and loss: date range, comparison periods and both tracking pairs", async () => {
  const f = fixture(profitAndLoss());
  const out = await readXeroProfitAndLoss(noDatabase, {
    date_from: "2026-10-01",
    date_to: "2026-10-31",
    periods: "3",
    timeframe: "month",
    tracking_category_id: CATEGORY.toUpperCase(),
    tracking_option_id: OPTION,
    tracking_category_id_2: CATEGORY_2,
    tracking_option_id_2: OPTION_2,
  }, f.deps);
  assertEquals(f.calls[0].params, {
    fromDate: "2026-10-01",
    toDate: "2026-10-31",
    periods: "3",
    timeframe: "MONTH",
    trackingCategoryID: CATEGORY,
    trackingOptionID: OPTION,
    trackingCategoryID2: CATEGORY_2,
    trackingOptionID2: OPTION_2,
  });
  assertEquals(out.filters.periods, 3);
  assertEquals(out.filters.timeframe, "MONTH");
  assertEquals(out.filters.month, null);
  assertEquals(out.filters.tracking_category_id, CATEGORY);
});

Deno.test("profit and loss: a bad request never asks for a token", async () => {
  const bad = [
    { month: "2026-13" },
    { month: "2026-00" },
    { month: "2026-10-01" },
    { month: "2026-10", date_from: "2026-10-01" },
    { date_from: "2026-10-31", date_to: "2026-10-01" },
    { date_from: "2026-02-30" },
    { periods: "3" },
    { timeframe: "MONTH" },
    { periods: "0", timeframe: "MONTH" },
    { periods: "12", timeframe: "YEAR" },
    { periods: "1.5", timeframe: "QUARTER" },
    { timeframe: "WEEK", periods: "1" },
    { tracking_category_id: CATEGORY },
    { tracking_option_id: OPTION },
    { tracking_category_id: "not-a-uuid", tracking_option_id: OPTION },
    { tracking_category_id_2: CATEGORY_2 },
    { tenant_id: TENANT },
    { payments_only: "true" },
  ];
  for (const params of bad) {
    const g = fixture(profitAndLoss());
    await assertRejects(
      () => readXeroProfitAndLoss(noDatabase, params as any, g.deps),
      XeroReceivablesReadError,
    );
    assertEquals(
      g.calls.length,
      0,
      `no provider call for ${JSON.stringify(params)}`,
    );
    assertEquals(
      g.tokenCalls(),
      0,
      `no token read for ${JSON.stringify(params)}`,
    );
  }
  const leap = fixture(profitAndLoss());
  await readXeroProfitAndLoss(noDatabase, { month: "2024-02" }, leap.deps);
  assertEquals(leap.calls[0].params, {
    fromDate: "2024-02-01",
    toDate: "2024-02-29",
  });
  const plain = fixture(profitAndLoss());
  await readXeroProfitAndLoss(noDatabase, { month: "2026-02" }, plain.deps);
  assertEquals(plain.calls[0].params, {
    fromDate: "2026-02-01",
    toDate: "2026-02-28",
  });
});

Deno.test("profit and loss refuses a different report after the provider answers", async () => {
  const f = fixture({
    Reports: [{
      ReportID: "BalanceSheet",
      ReportType: "BalanceSheet",
      Rows: [],
    }],
  });
  await assertRejects(
    () => readXeroProfitAndLoss(noDatabase, { month: "2026-10" }, f.deps),
    XeroReceivablesReadError,
    "ProfitAndLoss",
  );
  const inconsistent = fixture({
    Reports: [{
      ReportID: "ProfitAndLoss",
      ReportType: "BalanceSheet",
      Rows: [],
    }],
  });
  await assertRejects(
    () => readXeroProfitAndLoss(noDatabase, {}, inconsistent.deps),
    XeroReceivablesReadError,
    "ProfitAndLoss",
  );
  const extra = fixture({
    Reports: [{ ReportID: "ProfitAndLoss" }, { ReportID: "ProfitAndLoss" }],
  });
  await assertRejects(
    () => readXeroProfitAndLoss(noDatabase, {}, extra.deps),
    XeroReceivablesReadError,
    "ProfitAndLoss",
  );
});

Deno.test("balance sheet and trial balance send the as-of date and nothing else", async () => {
  const sheet = {
    Reports: [{
      ReportID: "BalanceSheet",
      ReportName: "Balance Sheet",
      ReportType: "BalanceSheet",
      ReportTitles: ["Balance Sheet", "As at 31 October 2026"],
      Rows: [
        { RowType: "Header", Cells: [{ Value: "" }, { Value: "31 Oct 2026" }] },
        {
          RowType: "Section",
          Title: "Assets",
          Rows: [
            { RowType: "Row", Cells: [cell("Bank", true), cell("24300.25")] },
          ],
        },
      ],
    }],
  };
  const balance = fixture(sheet);
  const out = await readXeroBalanceSheet(
    noDatabase,
    { date: "2026-10-31" },
    balance.deps,
  );
  assertEquals(balance.calls, [{
    path: "/Reports/BalanceSheet",
    params: { date: "2026-10-31" },
  }]);
  assertEquals(out.filters, { date: "2026-10-31" });
  assertEquals(out.sections[0].rows[0].cells[1].amount, 24300.25);
  assertEquals(out.coverage.source, "xero_reports_balance_sheet");
  const omitted = fixture({
    Reports: [{
      ReportID: "TrialBalance",
      ReportType: "TrialBalance",
      Rows: [],
    }],
  });
  const trial = await readXeroTrialBalance(noDatabase, {}, omitted.deps);
  assertEquals(omitted.calls, [{ path: "/Reports/TrialBalance", params: {} }]);
  assertEquals(trial.filters, { date: null });
  assertEquals(trial.report.columns, []);
  assertEquals(trial.sections, []);
  for (
    const bad of [{ date: "31/10/2026" }, { date: "2026-02-30" }, {
      periods: "1",
    }]
  ) {
    const g = fixture(sheet);
    await assertRejects(
      () => readXeroBalanceSheet(noDatabase, bad as any, g.deps),
      XeroReceivablesReadError,
    );
    assertEquals(g.tokenCalls(), 0);
  }
});

Deno.test("aged payables is one contact, and a ReportType-only payload still counts", async () => {
  const report = {
    Reports: [{
      ReportName: "Aged Payables By Contact",
      ReportType: "AgedPayablesByContact",
      ReportDate: "31 October 2026",
      Rows: [
        {
          RowType: "Header",
          Cells: [{ Value: "Date" }, { Value: "Reference" }, { Value: "Due" }],
        },
        {
          RowType: "Section",
          Title: "",
          Rows: [
            {
              RowType: "Row",
              Cells: [
                {
                  Value: "2026-10-09T00:00:00",
                  Attributes: [{ Id: "invoiceID", Value: INVOICE }],
                },
                {
                  Value: "BILL-14",
                  Attributes: [{ Id: "invoiceID", Value: INVOICE }],
                },
                {
                  Value: "250.00",
                  Attributes: [{ Id: "invoiceID", Value: INVOICE }],
                },
              ],
            },
            {
              RowType: "SummaryRow",
              Cells: [{ Value: "Total" }, { Value: "" }, { Value: "250.00" }],
            },
          ],
        },
      ],
    }],
  };
  const f = fixture(report);
  const out = await readXeroAgedPayables(noDatabase, {
    contact_id: CONTACT.toUpperCase(),
    date: "2026-10-31",
  }, f.deps);
  assertEquals(f.calls, [{
    path: "/Reports/AgedPayablesByContact",
    params: { contactId: CONTACT, date: "2026-10-31" },
  }]);
  assertEquals(out.report.id, "AgedPayablesByContact");
  assertEquals(out.filters, { contact_id: CONTACT, date: "2026-10-31" });
  const bill = out.sections[0].rows[0];
  assertEquals(bill.cells[0].attributes[0], {
    id: "invoiceID",
    value: INVOICE,
  });
  assertEquals(bill.cells[1].amount, null, "a bill number is not an amount");
  assertEquals(bill.cells[2].amount, 250);
  assertEquals(out.sections[0].title, null);
  assertEquals(out.coverage.source, "xero_reports_aged_payables_by_contact");
  for (
    const bad of [{}, { date: "2026-10-31" }, { contact_id: "not-a-uuid" }, {
      contact_id: CONTACT,
      from_date: "2026-10-01",
    }]
  ) {
    const g = fixture(report);
    await assertRejects(
      () => readXeroAgedPayables(noDatabase, bad as any, g.deps),
      XeroReceivablesReadError,
    );
    assertEquals(g.calls.length, 0);
    assertEquals(g.tokenCalls(), 0);
  }
});

Deno.test("a report row the parser does not know is a provider fault, not a dropped figure", async () => {
  const f = fixture({
    Reports: [{
      ReportID: "TrialBalance",
      ReportType: "TrialBalance",
      Rows: [{ RowType: "Note", Cells: [{ Value: "hidden 10.00" }] }],
    }],
  });
  await assertRejects(
    () => readXeroTrialBalance(noDatabase, { date: "2026-10-31" }, f.deps),
    XeroReceivablesReadError,
    "unsupported row",
  );
});
