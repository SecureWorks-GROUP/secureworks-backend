// deno-lint-ignore-file no-import-prefix no-explicit-any
//
// Xero bank evidence reads (CIO, 2026-09-11). Pins:
//   1. Unreconciled listing filters on IsReconciled==false and AUTHORISED, one
//      provider page, matcher inputs lifted beside the raw row, no DB access.
//   2. Bank account, date range and status ALL are explicit; bad inputs refuse
//      before any provider call; a reconciled row inside an UNRECONCILED page is
//      a provider filter mismatch, not silently accepted.
//   3. Bank Summary flattens one line per account with opening, received, spent
//      and closing balances and states that this is Xero's ledger balance.
import { assertEquals, assertRejects, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { listXeroBankTransactions, readXeroBankSummary, XeroReceivablesReadError } from "./xero_receivables_read.ts";

const TENANT = "10000000-0000-4000-8000-000000000001";
const ACCOUNT = "40000000-0000-4000-8000-000000000004";
const NOW = "2026-09-11T02:00:00.000Z";
const META = { shared_cooldown: null, request_id: null, quota: { minute_remaining: null, day_remaining: null, app_minute_remaining: null, limit_problem: null } };
const noDatabase = new Proxy({}, { get() { throw new Error("The read module must not access business/cache tables"); } });

function fixture(result: unknown) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  return {
    calls,
    deps: {
      getToken: (client: unknown) => { assertStrictEquals(client, noDatabase); return Promise.resolve({ accessToken: "fixture-only-token", tenantId: TENANT }); },
      xeroGet: (path: string, _t: string, _tenant: string, params?: Record<string, string>) => { calls.push({ path, params }); return Promise.resolve({ data: result, metadata: META }); },
      now: () => new Date(NOW),
    },
  };
}
function tx(extra: Record<string, unknown> = {}) {
  return {
    BankTransactionID: "50000000-0000-4000-8000-000000000005", Type: "RECEIVE", Status: "AUTHORISED", IsReconciled: false,
    Date: "/Date(1757462400000+0000)/", DateString: "2026-09-10T00:00:00", Total: 2546.54, SubTotal: 2315.04, Reference: "SWP-261336 Rina",
    Contact: { ContactID: "60000000-0000-4000-8000-000000000006", Name: "Rina" },
    BankAccount: { AccountID: ACCOUNT, Name: "SecureWorks Trading" },
    LineItems: [{ Description: "Deposit SWP-261336" }],
    ...extra,
  };
}

Deno.test("1. unreconciled listing: exact where clause, one page, matcher inputs lifted", async () => {
  const f = fixture({ BankTransactions: [tx()] });
  const out = await listXeroBankTransactions(noDatabase, new URLSearchParams(""), f.deps);
  assertEquals(f.calls[0].path, "/BankTransactions");
  assertEquals(f.calls[0].params, { page: "1", pageSize: "100", order: "Date DESC, BankTransactionID ASC", where: 'IsReconciled==false AND Status=="AUTHORISED"' });
  assertEquals(out.transactions.length, 1);
  const t = out.transactions[0];
  assertEquals(t.total, 2546.54);
  assertEquals(t.reference, "SWP-261336 Rina");
  assertEquals(t.contact_name, "Rina");
  assertEquals(t.bank_account_id, ACCOUNT);
  assertEquals(t.line_item_descriptions, ["Deposit SWP-261336"]);
  assertEquals(t.is_reconciled, false);
  assertEquals(out.pagination.has_more, false);
  assertEquals(out.coverage.statement_lines, "not_exposed_by_xero_api");
});

Deno.test("2. filters are explicit; bad inputs and provider mismatches refuse", async () => {
  const f = fixture({ BankTransactions: [] });
  await listXeroBankTransactions(noDatabase, { status: "all", bank_account_id: ACCOUNT, date_from: "2026-08-01", date_to: "2026-09-10", page: "2", page_size: "50" }, f.deps);
  assertEquals(f.calls[0].params?.where, `BankAccount.AccountID==Guid("${ACCOUNT}") AND Date>=DateTime(2026, 8, 1) AND Date<=DateTime(2026, 9, 10)`);
  assertEquals(f.calls[0].params?.page, "2");
  for (const bad of [{ status: "PAID" }, { bank_account_id: "not-a-uuid" }, { date_from: "10/09/2026" }, { date_from: "2026-09-10", date_to: "2026-09-01" }, { page: "0" }, { page_size: "101" }, { tenant_id: TENANT }]) {
    const g = fixture({ BankTransactions: [] });
    await assertRejects(() => listXeroBankTransactions(noDatabase, bad as any, g.deps), XeroReceivablesReadError);
    assertEquals(g.calls.length, 0, `no provider call for ${JSON.stringify(bad)}`);
  }
  const reconciled = fixture({ BankTransactions: [tx({ IsReconciled: true })] });
  await assertRejects(() => listXeroBankTransactions(noDatabase, {}, reconciled.deps), XeroReceivablesReadError, "outside the requested filter");
  const dup = fixture({ BankTransactions: [tx(), tx()] });
  await assertRejects(() => listXeroBankTransactions(noDatabase, {}, dup.deps), XeroReceivablesReadError, "duplicate");
});

Deno.test("3. bank summary flattens one line per account with balances and names its coverage", async () => {
  const report = {
    Reports: [{
      ReportID: "BankSummary", ReportName: "Bank Summary", ReportDate: "11 September 2026", ReportTitles: ["Bank Summary", "SecureWorks Group", "From 1 September 2026 to 11 September 2026"],
      Rows: [
        { RowType: "Header", Cells: [{ Value: "Bank Accounts" }, { Value: "Opening Balance" }, { Value: "Cash Received" }, { Value: "Cash Spent" }, { Value: "Closing Balance" }] },
        { RowType: "Section", Title: "", Rows: [
          { RowType: "Row", Cells: [{ Value: "SecureWorks Trading", Attributes: [{ Id: "accountID", Value: ACCOUNT }] }, { Value: "12000.00" }, { Value: "30500.50" }, { Value: "18200.25" }, { Value: "24300.25" }] },
          { RowType: "SummaryRow", Cells: [{ Value: "Total" }, { Value: "12000.00" }, { Value: "30500.50" }, { Value: "18200.25" }, { Value: "24300.25" }] },
        ] },
      ],
    }],
  };
  const f = fixture(report);
  const out = await readXeroBankSummary(noDatabase, { date_from: "2026-09-01", date_to: "2026-09-11" }, f.deps);
  assertEquals(f.calls[0].path, "/Reports/BankSummary");
  assertEquals(f.calls[0].params, { fromDate: "2026-09-01", toDate: "2026-09-11" });
  assertEquals(out.accounts.length, 1);
  assertEquals(out.accounts[0], { account_name: "SecureWorks Trading", account_id: ACCOUNT, opening_balance: 12000, cash_received: 30500.5, cash_spent: 18200.25, closing_balance: 24300.25, raw_cells: ["SecureWorks Trading", "12000.00", "30500.50", "18200.25", "24300.25"] });
  assertEquals(out.report.columns, ["Bank Accounts", "Opening Balance", "Cash Received", "Cash Spent", "Closing Balance"]);
  assertEquals(out.coverage.source, "xero_reports_bank_summary");
  const wrong = fixture({ Reports: [{ ReportID: "ProfitAndLoss", Rows: [] }] });
  await assertRejects(() => readXeroBankSummary(noDatabase, {}, wrong.deps), XeroReceivablesReadError, "Bank Summary");
});
