// deno-lint-ignore-file no-import-prefix
// Debt Workshop dependencies (debt_ws_deps.ts): the bank-feed page read. Synthetic data only.
// The paging, the RECEIVE filter and the 15-minute cache are in debt_ws_actions.ts
// (debt_ws_actions_test.ts); this pins the one-page read those rest on.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createDebtWsDeps } from "./debt_ws_deps.ts";

const TENANT = "10000000-0000-4000-8000-000000000001";
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

function tx(k: number, type = "RECEIVE") {
  return {
    BankTransactionID: `50000000-0000-4000-8000-${String(k).padStart(12, "0")}`,
    Type: type,
    Status: "AUTHORISED",
    IsReconciled: false,
    DateString: "2026-09-10T00:00:00",
    Total: 100 + k,
    Reference: `Ref ${k}`,
    Contact: {
      ContactID: "60000000-0000-4000-8000-000000000006",
      Name: "Payer",
    },
    LineItems: [{ Description: `Line ${k}` }],
  };
}

function depsWith(rows: unknown[]) {
  const calls: Array<Record<string, string> | undefined> = [];
  const unused = () => Promise.reject(new Error("not used in this test"));
  const deps = createDebtWsDeps({
    client: {},
    getToken: () =>
      Promise.resolve({ accessToken: "fixture-token", tenantId: TENANT }),
    xeroGet: (_path, _token, _tenant, params) => {
      calls.push(params);
      return Promise.resolve({
        data: { BankTransactions: rows },
        metadata: META,
      });
    },
    sendChaseSms: unused,
    sendStaffSms: unused,
    getJobConversation: unused,
    updateJobStatus: unused,
    sendEmail: unused,
    invoicePdf: unused,
    searchContacts: unused,
    insuranceRead: unused,
    env: () => undefined,
  });
  return { deps, calls };
}

Deno.test("deps: one bank page per call, the page and date_from passed on, has_more from a full page", async () => {
  const full = depsWith(Array.from({ length: 100 }, (_, k) => tx(k)));
  const page = await full.deps.bankTransactions("2026-03-01", 3);
  assertEquals(full.calls.length, 1);
  assertEquals(full.calls[0]!.page, "3");
  assertEquals(full.calls[0]!.pageSize, "100");
  assert(full.calls[0]!.where.includes("IsReconciled==false"));
  assert(full.calls[0]!.where.includes("Date>=DateTime(2026, 3, 1)"));
  assertEquals(page.has_more, true);
  assertEquals(page.transactions.length, 100);
  assertEquals(page.transactions[0], {
    bank_transaction_id: "50000000-0000-4000-8000-000000000000",
    type: "RECEIVE",
    date: "2026-09-10T00:00:00",
    total: 100,
    reference: "Ref 0",
    contact_name: "Payer",
    line_item_descriptions: ["Line 0"],
  });

  // A short page is the last; spends come back from Xero (no Type filter there).
  const short = depsWith([tx(1), tx(2, "SPEND")]);
  const last = await short.deps.bankTransactions(null, 1);
  assertEquals(last.has_more, false);
  assertEquals(last.transactions.map((t) => t.type), ["RECEIVE", "SPEND"]);
  assert(!short.calls[0]!.where.includes("Date>="));
});
