import { listExpenseReceipts } from "./expense_list.ts";
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  receiptHasLiveTradeInvoice,
  resolveReimbursementExtras,
  REIMBURSEMENT_FLAG,
} from "./trade_invoice_reimbursement.ts";
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
function fake(invoiceStatus: string | null, enabled = false) {
  return {
    from(table: string) {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        in() { return this; },
        update() {
          return this;
        },
        maybeSingle() {
          return Promise.resolve({ data: { enabled } });
        },
        single() {
          return Promise.resolve({
            data: { id: "ZZTEST-receipt", status: "approved" },
          });
        },
        then(resolve: any) {
          return Promise.resolve({
            data: table === "trade_invoice_lines" && invoiceStatus
              ? [{ expense_receipt_id: "ZZTEST-receipt", invoice: { status: invoiceStatus } }]
              : [],
          }).then(resolve);
        },
      };
    },
  };
}
Deno.test("ZZTEST expense push is unchanged switch-off and any claim stops Xero switch-on", async () => {
  for (const enabled of [false, true]) {
    for (const status of ["submitted", "draft", "ops-reject"]) {
      let calls = 0;
      const push = new AsyncFunction(
        "client",
        "body",
        "authCtx",
        "ApiError",
        "receiptHasLiveTradeInvoice",
        "REIMBURSEMENT_FLAG",
        "preflightExpense",
        "getToken",
        "buildXeroExpenseBillBody",
        "xeroPost",
        "logBusinessEvent",
        pushBody,
      );
      const run = () =>
        push(
          fake(status, enabled),
          { expense_id: "ZZTEST-receipt" },
          { mode: "api_key" },
          ApiError,
          receiptHasLiveTradeInvoice,
          REIMBURSEMENT_FLAG,
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
      if (enabled || status === "submitted") {
        const error = await assertRejects(run, ApiError);
        assertEquals(error.status, 409);
        assertEquals(error.detail.code, "expense_on_trade_invoice");
        assertEquals(calls, 0);
      } else {
        await run();
        assertEquals(calls, 2);
      }
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

const receipt = (id: string, owner = "ZZTEST-trade", extra = {}) => ({
  id,
  submitted_by: owner,
  payment_method: "cash",
  receipt_storage_path: "ZZTEST.png",
  status: "approved",
  total_amount: 1,
  job_id: "ZZTEST-job",
  created_at: "2026-11-17",
  jobs: { job_number: "ZZTEST-1", client_name: null },
  internal_ocr: "private",
  ...extra,
});
function listFake(rows: any[], enabled = false, claims: any[] = [], fail = "") {
  const reads: string[] = [], selections: string[] = [], filters: string[] = [];
  const client = {
    from(table: string) {
      let columns = "*", cap = Infinity;
      const predicates: ((row: any) => boolean)[] = [];
      return {
        select(value: string) {
          columns = value;
          selections.push(`${table}:${value}`);
          return this;
        },
        order() {
          return this;
        },
        limit(value: number) {
          cap = value;
          return this;
        },
        eq(key: string, value: string) {
          filters.push(`${table}.${key}=${value}`);
          predicates.push((row) => row[key] === value);
          return this;
        },
        in(key: string, values: string[]) {
          predicates.push((row) => values.includes(row[key]));
          return this;
        },
        maybeSingle() {
          return this;
        },
        then(resolve: any) {
          reads.push(table);
          let data: any = table === "feature_flags"
            ? { enabled }
            : (table === "trade_invoice_lines" ? claims : rows).filter((row) =>
              predicates.every((p) => p(row))
            ).slice(0, cap);
          if (Array.isArray(data) && !columns.startsWith("*")) {
            const keys = columns.replace(/jobs:job_id\([^)]*\)/, "jobs").split(
              ",",
            ).map((k) => k.trim());
            data = data.map((row) =>
              Object.fromEntries(
                keys.filter((k) => k in row).map((k) => [k, row[k]]),
              )
            );
          }
          return Promise.resolve({
            data: fail === table ? null : data,
            error: fail === table ? new Error("ZZTEST unreadable") : null,
          }).then(resolve);
        },
      };
    },
  };
  return { client, reads, selections, filters };
}
const trade = { id: "ZZTEST-trade", role: "trade" };
const basis = async () => "inclusive_12_112_v1";
Deno.test("ZZTEST trade only gets own receipts with either switch state and another job filter", async () => {
  for (const enabled of [false, true]) {
    for (const jobId of [null, "ZZTEST-other-job"]) {
      const fake = listFake([
        receipt("ZZTEST-own"),
        receipt("ZZTEST-crew", "ZZTEST-other-trade"),
        receipt("ZZTEST-other-job-own", trade.id, {
          job_id: "ZZTEST-other-job",
        }),
        receipt("ZZTEST-other-job-crew", "ZZTEST-other-trade", {
          job_id: "ZZTEST-other-job",
        }),
      ], enabled);
      const result = await listExpenseReceipts(
        fake.client,
        new URLSearchParams(jobId ? { job_id: jobId } : {}),
        trade,
        basis,
      );
      assertEquals(
        result.expenses.map((r: any) => r.id),
        jobId
          ? ["ZZTEST-other-job-own"]
          : ["ZZTEST-own", "ZZTEST-other-job-own"],
      );
      assertEquals(
        result.expenses.every((r: any) => !("internal_ocr" in r)),
        true,
      );
      assertEquals(
        fake.filters.includes("expense_receipts.submitted_by=ZZTEST-trade"),
        true,
      );
      assertEquals(
        fake.reads.filter((t) => t === "expense_receipts").length,
        1,
      );
      assertEquals(
        fake.reads.filter((t) => t === "trade_invoice_lines").length,
        enabled ? 1 : 0,
      );
    }
  }
});
Deno.test("ZZTEST office roles and ops key retain the existing full response and requested limit", async () => {
  const rows = Array.from(
    { length: 130 },
    (_, i) => receipt(`ZZTEST-${i}`, i % 2 ? trade.id : "ZZTEST-other-trade"),
  );
  for (const role of ["admin", "owner", "ops_manager", "ADMIN", null]) {
    const fake = listFake(rows, true);
    const result = await listExpenseReceipts(
      fake.client,
      new URLSearchParams({ limit: "120" }),
      role ? { id: "ZZTEST-office", role } : undefined,
      async () => {
        throw Error("must not read pay");
      },
    );
    assertEquals(result, { expenses: rows.slice(0, 120) });
    assertEquals(fake.reads, ["expense_receipts"]);
  }
});
Deno.test("ZZTEST trade limits are bounded and claimability is one query for every row", async () => {
  for (
    const [limit, count] of [["999999", 100], ["Infinity", 50], ["bad", 50], [
      "-1",
      50,
    ], ["3.8", 3]] as const
  ) {
    const fake = listFake(
      Array.from({ length: 150 }, (_, i) => receipt(`ZZTEST-${i}`)),
      true,
      [{ expense_receipt_id: "ZZTEST-0" }],
    );
    const result = await listExpenseReceipts(
      fake.client,
      new URLSearchParams({ limit }),
      trade,
      basis,
    );
    assertEquals(result.expenses.length, count);
    assertEquals(result.expenses[0].reimbursement, {
      claimable: false,
      reason: "reimbursement_already_claimed",
    });
    assertEquals(result.expenses[1].reimbursement, {
      claimable: true,
      reason: null,
    });
    assertEquals(fake.reads, [
      "expense_receipts",
      "feature_flags",
      "trade_invoice_lines",
    ]);
  }
});
Deno.test("ZZTEST missing receipt evidence and office edits are reflected on each read", async () => {
  const cases = [
    [{ receipt_storage_path: null }, "reimbursement_receipt_required"],
    [{ payment_method: "company_card" }, "reimbursement_not_personal_spend"],
    [{ status: "rejected" }, "reimbursement_rejected"],
    [{ xero_bill_id: "ZZTEST-bill" }, "reimbursement_already_claimed"],
  ] as const;
  for (const [edit, reason] of cases) {
    const rows = [receipt("ZZTEST-own")], fake = listFake(rows, true);
    assertEquals(
      (await listExpenseReceipts(
        fake.client,
        new URLSearchParams(),
        trade,
        basis,
      )).expenses[0].reimbursement.claimable,
      true,
    );
    Object.assign(rows[0], edit);
    assertEquals(
      (await listExpenseReceipts(
        fake.client,
        new URLSearchParams(),
        trade,
        basis,
      )).expenses[0].reimbursement,
      { claimable: false, reason },
    );
  }
});
Deno.test("ZZTEST failed claim read refuses and a retry reads current claims", async () => {
  const failed = listFake(
    [receipt("ZZTEST-own")],
    true,
    [],
    "trade_invoice_lines",
  );
  await assertRejects(
    () =>
      listExpenseReceipts(failed.client, new URLSearchParams(), trade, basis),
    Error,
    "Could not read",
  );
  const retry = listFake([receipt("ZZTEST-own")], true, [{
    expense_receipt_id: "ZZTEST-own",
  }]);
  assertEquals(
    (await listExpenseReceipts(
      retry.client,
      new URLSearchParams(),
      trade,
      basis,
    )).expenses[0].reimbursement.claimable,
    false,
  );
  const missingFlag = listFake(
    [receipt("ZZTEST-own")],
    true,
    [],
    "feature_flags",
  );
  assertEquals(
    (await listExpenseReceipts(
      missingFlag.client,
      new URLSearchParams(),
      trade,
      async () => {
        throw Error("pay unavailable");
      },
    )).expenses[0].reimbursement,
    undefined,
  );
  const missingRows = listFake([], true);
  assertEquals(
    await listExpenseReceipts(
      missingRows.client,
      new URLSearchParams(),
      trade,
      basis,
    ),
    { expenses: [] },
  );
  const failedRows = listFake([], true, [], "expense_receipts");
  await assertRejects(() =>
    listExpenseReceipts(failedRows.client, new URLSearchParams(), trade, basis)
  );
});
Deno.test("ZZTEST list_expenses dispatch passes server caller through the shared reader", () => {
  assertEquals(
    source.includes(
      "listExpenses(client, url.searchParams, authUser ?? undefined)",
    ),
    true,
  );
  assertEquals(
    source.includes("return await listExpenseReceipts(client, params, caller,"),
    true,
  );
});
Deno.test("ZZTEST crew limits are bounded and office roles retain full rows and requested limit", async () => {
  const rows = Array.from({ length: 130 }, (_, i) => receipt(`ZZTEST-${i}`));
  for (
    const [value, expected] of [
      ["999999", 100],
      ["Infinity", 50],
      ["NaN", 50],
      ["-1", 50],
      ["0", 50],
      ["2.8", 2],
    ] as const
  ) {
    const fake = listFake(rows);
    assertEquals(
      (await listExpenseReceipts(
        fake.client,
        new URLSearchParams({ limit: value }),
        trade,
        basis,
      )).expenses.length,
      expected,
    );
  }
  for (const role of ["admin", "owner", "ops_manager"]) {
    const fake = listFake([
      ...rows,
      receipt("ZZTEST-other", "ZZTEST-other-trade"),
    ], true);
    const result = await listExpenseReceipts(
      fake.client,
      new URLSearchParams({ limit: "200" }),
      { ...trade, role },
      async () => {
        throw Error("office must not read pay");
      },
    );
    assertEquals(result.expenses, [
      ...rows,
      receipt("ZZTEST-other", "ZZTEST-other-trade"),
    ]);
    assertEquals(fake.reads, ["expense_receipts"]);
    const filtered = listFake([
      receipt("ZZTEST-own"),
      receipt("ZZTEST-other", "ZZTEST-other-trade", {
        job_id: "ZZTEST-other-job",
      }),
    ]);
    assertEquals(
      (await listExpenseReceipts(
        filtered.client,
        new URLSearchParams({ job_id: "ZZTEST-job", status: "approved" }),
        { ...trade, role },
        basis,
      )).expenses.map((r: any) => r.id),
      ["ZZTEST-own"],
    );
  }
});
Deno.test("ZZTEST one claim query covers the full crew page without receipt rereads", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => receipt(`ZZTEST-${i}`));
  const fake = listFake(rows, true, [{ expense_receipt_id: "ZZTEST-1" }, {
    expense_receipt_id: "ZZTEST-outside-page",
  }]);
  const result = await listExpenseReceipts(
    fake.client,
    new URLSearchParams({ limit: "100" }),
    trade,
    basis,
  );
  assertEquals(
    result.expenses.filter((r: any) => !r.reimbursement.claimable).map((
      r: any,
    ) => r.id),
    ["ZZTEST-1"],
  );
  assertEquals(fake.reads, [
    "expense_receipts",
    "feature_flags",
    "trade_invoice_lines",
  ]);
});

Deno.test("cx-reimb-rest unread amount refuses only its row in both list and save, then office correction works", async () => {
  for (const amount of [null, "", "unread", 0, -1, Infinity]) {
    const rows = [receipt("ZZTEST-unread", trade.id, { total_amount: amount }), receipt("ZZTEST-valid")];
    const fake = listFake(rows, true);
    const list = await listExpenseReceipts(fake.client, new URLSearchParams(), trade, basis);
    assertEquals(list.expenses.map((row: any) => row.reimbursement), [
      { claimable: false, reason: "reimbursement_amount_unreadable" },
      { claimable: true, reason: null },
    ]);
    // Save uses the same current receipt and retains the other reimbursement.
    const saveClient = { from(table: string) {
      const q = fake.client.from(table);
      if (table === "expense_receipts") q.maybeSingle = () => {
        const original = q.then.bind(q);
        return { then: (fn: any) => original((r: any) => fn({ ...r, data: r.data?.[0] ?? null })) } as any;
      };
      return q;
    } };
    const save = () => resolveReimbursementExtras(saveClient, {
      userId: trade.id, flagOn: true, basis: "inclusive_12_112_v1",
      items: rows.map((row) => ({ type: "reimbursement", expense_receipt_id: row.id })),
    });
    const result = await save();
    assertEquals(result.lines.map((line) => line.expense_receipt_id), ["ZZTEST-valid"]);
    assertEquals(result.skipped_items.map((item) => item.code), ["reimbursement_amount_unreadable"]);
    Object.assign(rows[0], { total_amount: 1 });
    assertEquals((await save()).lines.length, 2);
    assertEquals((await listExpenseReceipts(fake.client, new URLSearchParams(), trade, basis))
      .expenses.every((row: any) => row.reimbursement.claimable), true);
  }
});

Deno.test("cx-reimb-rest list and save agree on retained draft/rejected claims and released receipts", async () => {
  for (const status of ["draft", "ops-reject", "submitted", null]) {
    for (const retained of [true, false]) {
      for (const total_amount of [1, null]) {
        const claims = retained ? [{ expense_receipt_id: "ZZTEST-own", trade_invoice_id: "ZZTEST-invoice", invoice: { status } }] : [];
        const fake = listFake([receipt("ZZTEST-own", trade.id, { total_amount })], true, claims);
        const listed = await listExpenseReceipts(fake.client, new URLSearchParams(), trade, basis);
        const saveClient = { from(table: string) {
          const q = fake.client.from(table);
          if (table === "expense_receipts") q.maybeSingle = () => {
            const original = q.then.bind(q);
            return { then: (fn: any) => original((r: any) => fn({ ...r, data: r.data?.[0] ?? null })) } as any;
          };
          return q;
        } };
        const saved = await resolveReimbursementExtras(saveClient, {
          userId: trade.id, flagOn: true, basis: "inclusive_12_112_v1",
          items: [{ type: "reimbursement", expense_receipt_id: "ZZTEST-own" }],
        });
        const reason = retained ? "reimbursement_already_claimed" : total_amount === null ? "reimbursement_amount_unreadable" : null;
        assertEquals(listed.expenses[0].reimbursement, { claimable: reason === null, reason });
        assertEquals(saved.skipped_items.map((item) => item.code), reason ? [reason] : []);
        assertEquals(saved.lines.length, reason ? 0 : 1);
        assertEquals(await receiptHasLiveTradeInvoice(fake.client, "ZZTEST-own"), retained);
        // Server-selected atomic draft replacement is the only exception at save.
        if (status === "draft") {
          assertEquals(await receiptHasLiveTradeInvoice(fake.client, "ZZTEST-own", "ZZTEST-invoice"), false);
        }
      }
    }
  }
});
