import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { receiptHasLiveTradeInvoice, resolveReimbursementExtras, REIMBURSEMENT_FLAG } from "./trade_invoice_reimbursement.ts";
const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
class ApiError extends Error {
  constructor(message: string, public status: number, public detail?: any) {
    super(message);
  }
}
// Drive the actual route body with fake storage/transport, without starting ops-api.
const pushStart = source.indexOf("async function pushExpenseToXero(");
const pushBody = source.slice(
  source.indexOf("\n) {", pushStart) + 5,
  source.indexOf("\nasync function listExpenses", pushStart),
).trim().replace(/}$/, "");
function fake(invoiceStatus: string | null) {
  return {
    from(table: string) {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        update() {
          return this;
        },
        single() {
          return Promise.resolve({
            data: { id: "ZZTEST-receipt", status: "approved" },
          });
        },
        then(resolve: any) {
          return Promise.resolve({
            data: table === "trade_invoice_lines" && invoiceStatus
              ? [{ invoice: { status: invoiceStatus } }]
              : [],
          }).then(resolve);
        },
      };
    },
  };
}
Deno.test("ZZTEST expense on submitted invoice stops before Xero, draft-only expense can push", async () => {
  for (const status of ["submitted", "draft", "ops-reject"]) {
    let calls = 0;
    const push = new AsyncFunction(
      "client",
      "body",
      "authCtx",
      "ApiError",
      "receiptHasLiveTradeInvoice",
      "preflightExpense",
      "getToken",
      "buildXeroExpenseBillBody",
      "xeroPost",
      "logBusinessEvent",
      pushBody,
    );
    const run = () =>
      push(
        fake(status),
        { expense_id: "ZZTEST-receipt" },
        { mode: "api_key" },
        ApiError,
        receiptHasLiveTradeInvoice,
        () => ({ ok: true }),
        async () => {
          calls++;
          return {};
        },
        () => ({}),
        async () => {
          calls++;
          return { Invoices: [{ InvoiceID: "ZZTEST-bill" }] };
        },
        () => {},
      );
    if (status === "submitted") {
      const error = await assertRejects(run, ApiError);
      assertEquals(error.status, 409);
      assertEquals(error.detail.code, "expense_on_trade_invoice");
      assertEquals(calls, 0);
    } else {
      await run();
      assertEquals(calls, 2);
    }
  }
});
const accountStart = source.indexOf("async function reimbursementXeroAccount(");
const accountBody = source.slice(
  source.indexOf(" {\n", accountStart) + 3,
  source.indexOf("\n}\n", accountStart) + 2,
).trim().replace(/}$/, "");
Deno.test("ZZTEST missing reimbursement account refuses before token or Xero transport", async () => {
  const account = new AsyncFunction(
    "client",
    "lines",
    "isReimbursementItem",
    "ApiError",
    accountBody,
  );
  const client = {
    from() {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return { data: { reimbursement_account_code: null } };
        },
      };
    },
  };
  let calls = 0;
  const push = async () => {
    await account(
      client,
      [{ line_type: "reimbursement" }],
      () => true,
      ApiError,
    );
    calls++;
  };
  const error = await assertRejects(push, ApiError);
  assertEquals(error.status, 409);
  assertEquals(error.detail.code, "reimbursement_account_not_set");
  assertEquals(calls, 0);
});

const listStart = source.indexOf("async function listExpenses(");
const listBody = source.slice(
  source.indexOf(" {\n", listStart) + 3,
  source.indexOf("\nasync function listUnreconciledTransactions", listStart),
).trim().replace(/}$/, "");
Deno.test("ZZTEST receipt list preserves crew receipts with switch off and adds eligibility only when on", async () => {
  const rows = ["ZZTEST-own", "ZZTEST-crew"].map((id) => ({
    id, submitted_by: id === "ZZTEST-own" ? "ZZTEST-trade" : "ZZTEST-other-trade",
    payment_method: "cash", receipt_storage_path: "ZZTEST-receipt.png", status: "approved",
    total_amount: 1, job_id: "ZZTEST-job", jobs: { job_number: "ZZTEST-1" },
  }));
  const list = new AsyncFunction("client", "params", "caller", "REIMBURSEMENT_FLAG",
    "tradePayBasisForSave", "resolveReimbursementExtras", listBody);
  for (const enabled of [false, true]) {
    const reads: string[] = [];
    const filters: string[] = [];
    let payRuleReads = 0;
    const client = {
      from(table: string) {
        let id: string | null = null;
        return {
          select() { return this; }, order() { return this; }, limit() { return this; },
          eq(key: string, value: string) { filters.push(`${table}.${key}=${value}`); if (key === "id") id = value; return this; },
          maybeSingle() { return this; },
          then(resolve: any) {
            reads.push(table);
            return Promise.resolve({ data: table === "feature_flags" ? { enabled }
              : table === "trade_invoice_lines" ? []
              : id ? rows.find((row) => row.id === id) : rows }).then(resolve);
          },
        };
      },
    };
    const result = await list(client, new URLSearchParams({ job_id: "ZZTEST-job" }),
      { id: "ZZTEST-trade", role: "lead_installer" }, REIMBURSEMENT_FLAG,
      async () => {
        payRuleReads++;
        if (!enabled) throw new Error("ZZTEST pay settings unavailable");
        return "inclusive_12_112_v1";
      }, resolveReimbursementExtras);
    assertEquals(filters.includes("expense_receipts.submitted_by=ZZTEST-trade"), false);
    assertEquals(reads.filter((table) => table === "feature_flags").length, 1);
    assertEquals(payRuleReads, enabled ? 1 : 0);
    if (!enabled) {
      assertEquals(result, { expenses: rows });
      assertEquals(reads.filter((table) => table === "expense_receipts").length, 1);
      assertEquals(reads.includes("trade_invoice_lines"), false);
    } else {
      assertEquals(result.expenses.map((row: any) => [row.id, row.reimbursement]), [
        ["ZZTEST-own", { claimable: true, reason: null }],
        ["ZZTEST-crew", { claimable: false, reason: "reimbursement_not_yours" }],
      ]);
    }
  }
});
