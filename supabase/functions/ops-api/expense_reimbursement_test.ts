import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { receiptHasLiveTradeInvoice } from "./trade_invoice_reimbursement.ts";
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
  source.indexOf("\nfunction persistedTradeInvoiceMoney", accountStart),
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
