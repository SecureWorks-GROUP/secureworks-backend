import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyLines,
  type HoldLine,
  type LineHoldFacts,
  LineHoldFactsUnreadable,
  readLineHoldFacts,
} from "./trade_line_hold.ts";
import type { JobCommissionRecord } from "./job_commission.ts";

const line = (extra: Partial<HoldLine> = {}): HoldLine => ({
  job_id: "ZZTEST-JOB",
  line_type: "materials",
  quantity: 1,
  rate: 120,
  line_total_ex: 120,
  description: "ZZTEST work",
  work_date: "2026-11-16",
  week_start: "2026-11-16",
  rate_source: "server_resolved",
  ...extra,
});
const facts = (): LineHoldFacts => ({
  userId: "ZZTEST-TRADE",
  jobs: {
    "ZZTEST-JOB": {
      job_number: "ZZTEST-01",
      workOrder: { id: "ZZTEST-WO", status: "approved", agreed_ex: 1120 },
      allowed_ex: 1120,
      backed_billed_ex: 1000,
      hourly: false,
    },
  },
  receipts: {},
  notJobTypes: {},
  commissions: {},
  rateRules: { ok: true, rules: [] },
  tradeRates: [],
  split_group_ids: Array.from(
    { length: 100 },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  ),
});
const commission = (
  extra: Partial<JobCommissionRecord> = {},
): JobCommissionRecord => ({
  job_id: "ZZTEST-JOB",
  commission_id: "ZZTEST-COMMISSION",
  budget_id: "ZZTEST-BUDGET",
  version: 1,
  state: "named",
  salesperson_user_id: "ZZTEST-TRADE",
  rule_id: null,
  percent: null,
  expected_amount_ex_gst: 80,
  claimed_ex_gst: 0,
  remaining_ex_gst: 80,
  ...extra,
});

Deno.test("hold precedence and off-crew fallback do not spend the job balance", () => {
  const cases = [
    {
      change: (f: LineHoldFacts) => {
        f.jobs["ZZTEST-JOB"].workOrder = null;
      },
      reason: "no_work_order",
    },
    {
      change: (f: LineHoldFacts) => {
        f.jobs["ZZTEST-JOB"].workOrder!.status = "draft";
      },
      reason: "no_amount",
    },
    {
      change: (f: LineHoldFacts) => {
        f.jobs["ZZTEST-JOB"].workOrder!.agreed_ex = null;
      },
      reason: "no_amount",
    },
    {
      change: (f: LineHoldFacts) => {
        f.jobs["ZZTEST-JOB"].workOrder = null;
        f.jobs["ZZTEST-JOB"].hourly = true;
      },
      reason: "hourly_no_maximum",
      hourly: true,
    },
    {
      change: (f: LineHoldFacts) => {
        f.jobs["ZZTEST-JOB"].workOrder!.status = "draft";
        f.jobs["ZZTEST-JOB"].hourly = true;
      },
      reason: "hourly_no_maximum",
      hourly: true,
    },
    {
      change: (f: LineHoldFacts) => {
        f.jobs["ZZTEST-JOB"].backed_billed_ex = 1120;
      },
      reason: "over_amount",
    },
  ];
  for (const c of cases) {
    const f = facts();
    c.change(f);
    const l = line(c.hourly ? { line_type: "labour", total_hours: 1 } : {});
    assertEquals(classifyLines([l], f).held[0].hold_reason, c.reason);
    f.jobs["ZZTEST-JOB"].off_crew = true;
    const held = classifyLines([l], f).held[0];
    assertEquals(held.hold_reason, "not_on_crew");
    assertEquals(held.hold_detail?.fallback_reason, c.reason);
  }
  const f = facts();
  f.jobs["ZZTEST-JOB"].off_crew = true;
  const result = classifyLines([line()], f);
  assertEquals(result.held[0].hold_detail?.fallback_reason, null);
  assertEquals(result.held[0].hold_detail?.left_ex, 120);
});

Deno.test("missing job and active not-job types hold with the right reason", () => {
  const f = facts();
  f.notJobTypes = { "ZZTEST-TYPE": "Training" };
  const result = classifyLines([
    line({ job_id: null }),
    line({ job_id: null, not_job_work_type_id: "ZZTEST-TYPE" }),
    line({ job_id: null, not_job_work_type_id: "ZZTEST-INACTIVE" }),
  ], f);
  assertEquals(result.held.map((l) => l.hold_reason), [
    "no_job",
    "not_job_work",
    "no_job",
  ]);
  assertEquals(
    result.held[1].words,
    "With the office: Training is waiting for approval.",
  );
});

Deno.test("typed rate rule precedes crew and work-order rules and retains the suggestion", () => {
  const f = facts();
  f.rateRules = {
    ok: true,
    rules: [{ line_type: "materials", max_unit_rate_ex: 30 }],
  };
  f.jobs["ZZTEST-JOB"].off_crew = true;
  const held = classifyLines([
    line({ rate_source: "client_entered", suggested: { amount_ex: 30 } }),
  ], f).held[0];
  assertEquals(held.hold_reason, "rate_above_rule");
  assertEquals(held.hold_detail?.expected, { amount_ex: 30 });
});

Deno.test("amount splits preserve cents and ordered lines consume only what is backed", () => {
  assertEquals(classifyLines([line()], facts()).backed[0].sent_amount_ex, 120);
  const result = classifyLines([
    line({ line_total_ex: 120.01 }),
    line({ line_total_ex: 1 }),
  ], facts());
  assertEquals(result.backed.map((l) => l.line_total_ex), [120]);
  assertEquals(result.held.map((l) => l.line_total_ex), [0.01, 1]);
  assertEquals(result.backed[0].split_group_id, result.held[0].split_group_id);
  assertEquals(
    result.held[0].description,
    "ZZTEST work (part over the job's amount)",
  );
  assertEquals(result.held[0].hold_detail?.asked_ex, 120.01);
  const f = facts();
  f.jobs["ZZTEST-JOB"].allowed_ex = 1030;
  const material = classifyLines([line({ line_total_ex: 50 })], f);
  assertEquals(material.backed[0].sent_amount_ex, 30);
  assertEquals(material.held[0].sent_amount_ex, 20);
  const ordered = classifyLines([
    line({ line_total_ex: 100 }),
    line({ line_total_ex: 30 }),
  ], facts());
  assertEquals(ordered.backed.map((l) => l.sent_amount_ex), [100, 20]);
  assertEquals(ordered.held[0].sent_amount_ex, 10);
});

Deno.test("hour splits use whole quarter hours and keep the original sent cents", () => {
  const l = line({
    line_type: "labour",
    total_hours: 8,
    quantity: 8,
    rate: 56,
    line_total_ex: 448,
  });
  const result = classifyLines([l], facts());
  assertEquals(result.backed[0].total_hours, 2);
  assertEquals(result.backed[0].line_total_ex, 112);
  assertEquals(result.held[0].total_hours, 6);
  assertEquals(result.held[0].line_total_ex, 336);
  const f = facts();
  f.jobs["ZZTEST-JOB"].allowed_ex = 1010;
  assertEquals(classifyLines([l], f).backed.length, 0);
  assertEquals(classifyLines([l], f).held[0].line_total_ex, 448);
  f.jobs["ZZTEST-JOB"].allowed_ex = 1000.07;
  const small = classifyLines([
    line({
      line_type: "labour",
      total_hours: 2,
      quantity: 2,
      rate: 0.07,
      line_total_ex: 0.14,
    }),
  ], f);
  assertEquals(small.backed[0].total_hours, 1);
  assertEquals(small.backed[0].sent_amount_ex, 0.07);
  assertEquals(small.held[0].sent_amount_ex, 0.07);
});

Deno.test("receipt approval controls reimbursement without consuming left", () => {
  const f = facts();
  f.receipts = {
    "ZZTEST-OK": { approved: true },
    "ZZTEST-WAIT": { approved: false },
  };
  const result = classifyLines([
    line({
      line_type: "reimbursement",
      expense_receipt_id: "ZZTEST-OK",
      line_total_ex: 50,
    }),
    line({
      line_type: "reimbursement",
      expense_receipt_id: "ZZTEST-WAIT",
      line_total_ex: 40,
    }),
    line({
      line_type: "reimbursement",
      job_id: null,
      expense_receipt_id: "ZZTEST-OK",
    }),
    line(),
  ], f);
  assertEquals(result.backed.map((l) => l.sent_amount_ex), [50, 120]);
  assertEquals(result.held.map((l) => l.hold_reason), [
    "reimbursement",
    "no_job",
  ]);
});

Deno.test("commission uses server figure once, never consumes left, and no figure holds zero", () => {
  const f = facts();
  f.commissions["ZZTEST-JOB"] = commission();
  const result = classifyLines([
    line({ line_type: "commission", line_total_ex: 999 }),
    line({ line_type: "commission" }),
    line(),
  ], f);
  assertEquals(result.backed.map((l) => l.sent_amount_ex), [80, 120]);
  assertEquals(result.skipped_items[0].reason, "claimed");
  f.commissions["ZZTEST-JOB"] = commission({
    state: "no_amount",
    expected_amount_ex_gst: null,
    remaining_ex_gst: null,
  });
  const missing = classifyLines([
    line({ line_type: "commission", line_total_ex: 999 }),
    line(),
  ], f);
  assertEquals(missing.held[0].hold_reason, "commission_no_figure");
  assertEquals(missing.held[0].line_total_ex, 0);
  assertEquals(missing.held[0].sent_amount_ex, 0);
  assertEquals(missing.backed[0].sent_amount_ex, 120);
});

Deno.test("follow-up 31: non-salesperson commissions are omitted even without a figure or salesperson", () => {
  for (
    const record of [
      commission({ salesperson_user_id: "ZZTEST-OTHER" }),
      commission({
        state: "no_amount",
        salesperson_user_id: "ZZTEST-OTHER",
        expected_amount_ex_gst: null,
      }),
      commission({ state: "salesperson_not_found", salesperson_user_id: null }),
      commission({ remaining_ex_gst: 0 }),
    ]
  ) {
    const f = facts();
    f.commissions["ZZTEST-JOB"] = record;
    const result = classifyLines([line({ line_type: "commission" })], f);
    assertEquals(result.backed.length + result.held.length, 0);
    assertEquals(
      result.skipped_items[0].reason,
      record.remaining_ex_gst === 0 ? "claimed" : "not_yours",
    );
  }
});

Deno.test("200 repeatable random sends conserve every cent and do not mutate inputs", () => {
  let seed = 17;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let send = 0; send < 200; send++) {
    const f = facts();
    f.jobs["ZZTEST-JOB"].allowed_ex = (next() % 200000) / 100;
    const lines = Array.from({ length: 20 }, () => {
      const hours = (next() % 40 + 1) / 4;
      const rate = (next() % 10000 + 1) / 100;
      return next() % 2
        ? line({ line_total_ex: (next() % 100000) / 100 })
        : line({
          line_type: "labour",
          total_hours: hours,
          quantity: hours,
          rate,
          line_total_ex: Math.round(hours * rate * 100) / 100,
        });
    });
    const before = JSON.stringify({ lines, f });
    const result = classifyLines(lines, f);
    const cents = (ls: Array<{ line_total_ex: number }>) =>
      ls.reduce((s, l) => s + Math.round(l.line_total_ex * 100), 0);
    assertEquals(cents([...result.backed, ...result.held]), cents(lines));
    assertEquals(
      [...result.backed, ...result.held].reduce(
        (s, l) => s + Math.round(l.sent_amount_ex * 100),
        0,
      ),
      cents(lines),
    );
    assertEquals(JSON.stringify({ lines, f }), before);
    assertEquals(classifyLines(lines, f), result);
  }
});

// A tiny PostgREST fake supplies rows, not business verdicts. No network or writes.
function client(rows: Record<string, any[]>, fault = "", throws = false) {
  return {
    from(table: string) {
      const q: any = {
        select: () => q,
        in: () => q,
        eq: () => q,
        order: () => q,
        range: (start: number, end: number) => {
          q.start = start;
          q.end = end;
          return q;
        },
        then(resolve: any, reject: any) {
          if (table === fault && throws) {
            return Promise.reject(
              new Error("ZZTEST fault"),
            ).then(resolve, reject);
          }
          return Promise.resolve(
            table === fault ? { data: null, error: { code: "ZZTEST" } } : {
              data: (rows[table] ?? []).slice(
                q.start ?? 0,
                (q.end ?? 99999) + 1,
              ),
              error: null,
            },
          ).then(resolve, reject);
        },
      };
      return q;
    },
    rpc: (_name: string, _args: any) =>
      Promise.resolve({ data: false, error: null }),
  };
}
const readRows = () => ({
  users: [{ id: "ZZTEST-TRADE", org_id: "ZZTEST-ORG", invoice_type: null }],
  jobs: [{
    id: "ZZTEST-JOB",
    job_number: "ZZTEST-01",
    type: "fencing",
    metadata: {},
  }],
  work_orders: [{
    id: "ZZTEST-WO",
    job_id: "ZZTEST-JOB",
    kind: "job",
    status: "approved",
    agreed_labour_ex: 1120,
  }],
  trade_invoice_lines: [
    {
      id: "ZZTEST-1",
      job_id: "ZZTEST-JOB",
      line_type: "materials",
      line_total_ex: 1000,
      trade_invoices: { status: "approved", invoice_kind: "standard" },
    },
    ...["draft", "ops-reject", "paid"].map((status, i) => ({
      id: `ZZTEST-${i + 2}`,
      job_id: "ZZTEST-JOB",
      line_type: "materials",
      line_total_ex: 99,
      trade_invoices: {
        status,
        invoice_kind: status === "paid" ? "held" : "standard",
      },
    })),
  ],
});
Deno.test("batched facts exclude draft, rejected and held money, and fresh reads reflect office changes", async () => {
  const rows = readRows();
  const f = await readLineHoldFacts(client(rows), "ZZTEST-TRADE", [line()]);
  assertEquals(f.jobs["ZZTEST-JOB"].backed_billed_ex, 1000);
  assertEquals(classifyLines([line()], f).backed[0].sent_amount_ex, 120);
  rows.work_orders[0].agreed_labour_ex = 1100;
  const fresh = await readLineHoldFacts(client(rows), "ZZTEST-TRADE", [line()]);
  assertEquals(classifyLines([line()], fresh).held[0].sent_amount_ex, 20);
});
Deno.test("every facts read fault throws the same 503 and retry reads again", async () => {
  for (
    const table of [
      "users",
      "jobs",
      "work_orders",
      "trade_invoice_lines",
      "work_order_customer_variations",
      "work_order_amount_changes",
      "v_job_commission",
      "trade_invoice_extra_rate_rules",
      "trade_rates",
      "job_budgets",
      "group_work_orders",
      "feature_flags",
      "expense_receipts",
      "not_job_work_types",
    ]
  ) {
    for (const throws of [false, true]) {
      await assertRejects(
        () =>
          readLineHoldFacts(client(readRows(), table, throws), "ZZTEST-TRADE", [
            line({
              expense_receipt_id: "ZZTEST-RECEIPT",
              not_job_work_type_id: "ZZTEST-TYPE",
            }),
          ]),
        LineHoldFactsUnreadable,
      );
    }
  }
  const bad = client(readRows());
  bad.rpc = () =>
    Promise.resolve({ data: null, error: { code: "ZZTEST" } } as any);
  await assertRejects(
    () => readLineHoldFacts(bad, "ZZTEST-TRADE", [line()]),
    LineHoldFactsUnreadable,
  );
  const error = new LineHoldFactsUnreadable();
  assertEquals(error.status, 503);
  assertEquals(error.code, "pay_facts_unreadable");
  assertEquals(
    classifyLines(
      [line()],
      await readLineHoldFacts(client(readRows()), "ZZTEST-TRADE", [line()]),
    ).backed.length,
    1,
  );
});

Deno.test("paged billed facts include cap changes and crew holds spend nothing across weeks", async () => {
  const rows: Record<string, any[]> = readRows();
  rows.trade_invoice_lines = Array.from({ length: 1001 }, (_, i) => ({
    id: `ZZTEST-${i}`,
    job_id: "ZZTEST-JOB",
    line_type: "materials",
    line_total_ex: 1,
    trade_invoices: { status: "approved", invoice_kind: "standard" },
  }));
  rows.trade_invoice_lines.push({
    id: "ZZTEST-CREDIT",
    job_id: "ZZTEST-JOB",
    line_type: "other",
    line_total_ex: 7,
    override_amount: -1,
    trade_invoices: { status: "paid", invoice_kind: "follow_on" },
  });
  rows.work_order_customer_variations = [
    {
      id: "ZZTEST-V1",
      job_id: "ZZTEST-JOB",
      work_order_id: "ZZTEST-WO",
      status: "approved",
      trade_allocation_ex: 20,
    },
    {
      id: "ZZTEST-V2",
      job_id: "ZZTEST-JOB",
      work_order_id: "ZZTEST-WO",
      status: "draft",
      trade_allocation_ex: 99,
    },
  ];
  rows.work_order_amount_changes = [{
    id: "ZZTEST-CHANGE",
    work_order_id: "ZZTEST-WO",
    delta_ex: 10,
  }];
  const l = [
    line(),
    line({ week_start: "2026-11-23", work_date: "2026-11-23" }),
  ];
  const db = client(rows);
  db.rpc = (_name, args) =>
    Promise.resolve({ data: args.p_week_start === "2026-11-16", error: null });
  const f = await readLineHoldFacts(db, "ZZTEST-TRADE", l);
  assertEquals(f.jobs["ZZTEST-JOB"].allowed_ex, 1150);
  assertEquals(f.jobs["ZZTEST-JOB"].backed_billed_ex, 1000);
  const result = classifyLines(l, f);
  assertEquals(result.held[0].hold_reason, "not_on_crew");
  assertEquals(result.held[0].hold_detail?.fallback_reason, null);
  assertEquals(result.backed[0].sent_amount_ex, 120);
});
