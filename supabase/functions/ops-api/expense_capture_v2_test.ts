import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ApiError,
  approveExpense,
  pushExpenseToXero,
  submitExpense,
  updateExpense,
} from "./index.ts";
import { ExpenseCaptureError } from "./expense_capture_v2.ts";

const expenseId = "ZZTEST-receipt";
const job = "ZZTEST-job";
const staff = { mode: "api_key" } as const;

function store(fields: Record<string, unknown> = {}) {
  let row: Record<string, unknown> = {
    id: expenseId,
    status: "approved",
    updated_at: "initial",
    job_id: null,
    stock_division: null,
    payment_method: "company_card",
    total_amount: 1,
    category: "materials",
    gst_status: "included",
    vendor_name: "ZZTEST",
    no_receipt_reason: "unavailable",
    receipt_date: new Date().toISOString().slice(0, 10),
    ...fields,
  };
  const state = {
    enabled: true as boolean | null,
    fail: "",
    editBeforeSave: false,
    tokenReads: 0,
  };
  const client = {
    from(table: string) {
      let changes: Record<string, unknown> | undefined;
      const matches: [string, unknown][] = [];
      return {
        select() {
          return this;
        },
        eq(key: string, value: unknown) {
          matches.push([key, value]);
          return this;
        },
        is(key: string, value: null) {
          matches.push([key, value]);
          return this;
        },
        ilike() {
          return this;
        },
        limit() {
          return this;
        },
        insert(value: Record<string, unknown>) {
          if (table === "expense_receipts") {
            row = { ...value, id: expenseId, updated_at: "initial" };
          }
          return this;
        },
        update(value: Record<string, unknown>) {
          changes = value;
          return this;
        },
        single() {
          return this.maybeSingle();
        },
        maybeSingle() {
          if (table === state.fail || (changes && state.fail === "write")) {
            return { error: {} };
          }
          switch (table) {
            case "feature_flags":
              return {
                data: matches.some(([, v]) => v === "spend_capture_v2")
                  ? (state.enabled == null ? null : { enabled: state.enabled })
                  : { enabled: false },
              };
            case "expense_receipts":
              if (state.editBeforeSave && changes) {
                Object.assign(row, { job_id: job, updated_at: "office-edit" });
                state.editBeforeSave = false;
              }
              if (!matches.every(([k, v]) => (row[k] ?? null) === v)) {
                return { data: null };
              }
              Object.assign(row, changes);
              return { data: { ...row } };
            case "xero_tokens":
              state.tokenReads++;
              return { data: { expires_at: "2099-01-01" } };
            default:
              return { data: null };
          }
        },
        then(resolve: (value: unknown) => void) {
          if (table === "expense_receipts") resolve(this.maybeSingle());
          else resolve({ data: [], error: null });
        },
      };
    },
  };
  return { client, state, read: () => ({ ...row }) };
}

Deno.test("version two needs a destination only when enabled, and the same receipt can be corrected", async () => {
  const { client, read, state } = store();
  const body = { expense_id: expenseId, capture_version: 2 };
  const before = read();
  const err = await assertRejects(
    () => updateExpense(client, body),
    ExpenseCaptureError,
  );
  assertEquals(err.status, 409);
  assertEquals(err.body, {
    error: "expense_needs_job_or_division",
    message: "Pick the job or the stock this was for.",
  });
  assertEquals(read(), before);
  assertEquals(
    (await updateExpense(client, { ...body, stock_division: "fencing" }))
      .next_step,
    "saved_to_stock",
  );
  assertEquals([
    read().job_id,
    read().stock_division,
    read().business_category,
    read().capture_version,
  ], [null, "fencing", "general_stock", 2]);
  assertEquals(
    (await updateExpense(client, { ...body, job_id: job })).next_step,
    "saved_against_job",
  );
  assertEquals([read().job_id, read().stock_division], [job, null]);
  assertEquals(
    (await updateExpense(client, body)).next_step,
    "saved_against_job",
  );
  state.enabled = false;
  await updateExpense(client, { ...body, job_id: null });
  assertEquals(read().job_id, null);
});

Deno.test("legacy save keeps its answer and accepts no destination without reading the switch", async () => {
  const { client, state, read } = store({ capture_version: 2 });
  state.fail = "feature_flags";
  assertEquals(
    await updateExpense(client, {
      expense_id: expenseId,
      payment_method: "cash",
    }),
    {
      success: true,
      expense_id: expenseId,
      updated_fields: ["payment_method"],
      next_step: "draft_bill",
    },
  );
  assertEquals(read().job_id, null);
  assertEquals(read().stock_division, null);
});

Deno.test("submit and update report the next step for the saved payment method and destination", async () => {
  for (
    const [payment_method, destination, next] of [
      ["company_card", { stock_division: "insurance" }, "saved_to_stock"],
      ["company_card", { job_id: job }, "saved_against_job"],
      ["personal_card", { job_id: job }, "reimbursed_on_next_invoice"],
      ["cash", { stock_division: "patios" }, "draft_bill"],
      ["supplier_invoice", { job_id: job }, "evidence_for_supplier_bill"],
    ] as const
  ) {
    const { client, read } = store();
    const saved = await submitExpense(client, {
      ...destination,
      capture_version: 2,
      payment_method,
      no_receipt_reason: "unavailable",
    });
    assertEquals(saved.next_step, next);
    assertEquals(read().capture_version, 2);
    if ("stock_division" in destination) {
      assertEquals([
        read().stock_division,
        read().job_id,
        read().business_category,
      ], [destination.stock_division, null, "general_stock"]);
    }
    const reviewed = await updateExpense(client, {
      expense_id: expenseId,
      capture_version: 2,
    });
    assertEquals(reviewed.next_step, next);
  }
});

Deno.test("invalid inputs, missing settings, read and write failures never report a save", async () => {
  const { client, state, read } = store();
  const body = { expense_id: expenseId, capture_version: 2 };
  const before = read();
  for (
    const fields of [{ capture_version: 1.5 }, { stock_division: "unknown" }]
  ) {
    const err = await assertRejects(
      () => updateExpense(client, { ...body, ...fields }),
      ExpenseCaptureError,
    );
    assertEquals(err.status, 400);
  }
  state.enabled = null;
  assertEquals(
    (await assertRejects(() => updateExpense(client, body), ApiError)).status,
    503,
  );
  for (const table of ["expense_receipts", "feature_flags", "write"]) {
    state.enabled = false;
    state.fail = table;
    assertEquals(
      (await assertRejects(() => updateExpense(client, body), ApiError)).status,
      503,
    );
  }
  assertEquals(read(), before);
});

Deno.test("an office edit wins a concurrent save and the next review sees that edit", async () => {
  const { client, state, read } = store();
  state.editBeforeSave = true;
  const stale = await assertRejects(
    () =>
      updateExpense(client, {
        expense_id: expenseId,
        stock_division: "fencing",
      }),
    ApiError,
  );
  assertEquals(stale.status, 409);
  assertEquals([read().stock_division, read().job_id], [null, job]);
  assertEquals(
    (await updateExpense(client, { expense_id: expenseId, capture_version: 2 }))
      .next_step,
    "saved_against_job",
  );
});

Deno.test("a receipt already billed refuses both ways to request reimbursement", async () => {
  const { client, read } = store({
    status: "pushed_to_xero",
    xero_bill_id: "ZZTEST-bill",
  });
  const before = read();
  for (
    const conversion of [{ flow: "reimbursement" }, {
      payment_method: "personal_card",
    }]
  ) {
    const err = await assertRejects(
      () => updateExpense(client, { expense_id: expenseId, ...conversion }),
      ExpenseCaptureError,
    );
    assertEquals([err.status, err.code], [409, "expense_already_billed"]);
  }
  assertEquals(read(), before);
});

Deno.test("non-cash and unclassified receipts refuse before Xero even with all switches off", async () => {
  for (
    const payment_method of [
      "company_card",
      "personal_card",
      "supplier_invoice",
      "unknown",
      null,
    ]
  ) {
    const { client, state } = store({ payment_method, job_id: job });
    state.enabled = false;
    let requests = 0;
    const fakeFetch = () => {
      requests++;
      throw new Error("unexpected transport");
    };
    const push = () =>
      pushExpenseToXero(client, { expense_id: expenseId }, staff, fakeFetch);
    for (let attempt = 0; attempt < 2; attempt++) {
      const err = await assertRejects(push, ExpenseCaptureError);
      assertEquals([err.status, err.code, err.message], [
        409,
        "expense_not_billable",
        "Only a company cash receipt becomes a bill.",
      ]);
    }
    assertEquals([state.tokenReads, requests], [0, 0]);
  }
});

Deno.test("cash sends one original draft payload and records the bill", async () => {
  const { client, state, read } = store({
    payment_method: "cash",
    job_id: job,
  });
  state.enabled = false;
  const requests: unknown[] = [];
  await pushExpenseToXero(
    client,
    { expense_id: expenseId },
    staff,
    (input, init) => {
      requests.push([
        String(input),
        init?.method,
        new Headers(init?.headers).get("Idempotency-Key"),
        JSON.parse(String(init?.body)),
      ]);
      return Promise.resolve(
        Response.json({ Invoices: [{ InvoiceID: "ZZTEST-bill" }] }),
      );
    },
  );
  const date = read().receipt_date;
  assertEquals(requests, [[
    "https://api.xero.com/api.xro/2.0/Invoices",
    "POST",
    "expense-" + expenseId,
    {
      Invoices: [{
        Type: "ACCPAY",
        Status: "DRAFT",
        Contact: { Name: "ZZTEST" },
        Date: date,
        DueDate: date,
        Reference: "Receipt",
        LineItems: [{
          Description: "Receipt from ZZTEST",
          Quantity: 1,
          UnitAmount: 1,
          AccountCode: "400",
        }],
      }],
    },
  ]]);
  assertEquals([read().status, read().xero_bill_id], [
    "pushed_to_xero",
    "ZZTEST-bill",
  ]);
});

Deno.test("office approval of a company-card receipt records approval without a bill", async () => {
  const { client, state, read } = store({ status: "pending" });
  await approveExpense(client, { expense_id: expenseId }, staff);
  assertEquals([read().status, read().xero_bill_id, state.tokenReads], [
    "approved",
    undefined,
    0,
  ]);
});
