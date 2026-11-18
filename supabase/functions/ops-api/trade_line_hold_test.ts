import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyLines,
  HOLD_WORDS,
  type HoldLine,
  LEFT_HIDDEN_WORDS,
  type LineHoldFacts,
  LineHoldFactsUnreadable,
  readJobAmountsLeft,
  readJobAmountsState,
  readLineHoldFacts,
} from "./trade_line_hold.ts";
import type { JobCommissionRecord } from "./job_commission.ts";
import { readBilledOnJobs } from "./work_order_total_cap.ts";

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

// The database's one billed sum (work_order_backed_billed), as the fakes
// answer it: one row per requested job from rows.backed_billed. The TS side
// never works it out from lines (FU49 item 8).
function billedRpc(rows: Record<string, any>, fault = "") {
  return (name: string, args: any, crew: unknown = false) => {
    if (name !== "work_order_backed_billed") {
      return Promise.resolve({ data: crew, error: null });
    }
    if (fault === "work_order_backed_billed") {
      return Promise.resolve({ data: null, error: { code: "ZZTEST" } });
    }
    const billed = rows.backed_billed ?? {};
    return Promise.resolve({
      data: (args.p_job_ids as string[]).map((job_id) => ({
        job_id,
        billed_ex: billed[job_id] ?? 0,
      })),
      error: null,
    });
  };
}
// FU49-9b: every job the fakes are asked about is under the cap unless a test
// says otherwise, so the P1-05.8 cases keep the rule they were written for.
const inScope = (args: any, out: readonly string[] = []) =>
  Promise.resolve({
    data: [...new Set<string>(args?.p_job_ids ?? [])].map((job_id) => ({
      job_id,
      in_scope: !out.includes(job_id),
    })),
    error: null,
  });
// Crew answers from a test's own fake; the cap scope answered as in scope.
const crewRpc = (crew: (name: string, args: any) => Promise<any>) =>
(name: string, args: any) =>
  name === "work_order_cap_scope" ? inScope(args) : crew(name, args);

// A tiny PostgREST fake supplies rows, not business verdicts. No network or writes.
function client(rows: Record<string, any>, fault = "", throws = false) {
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
    rpc: crewRpc(billedRpc(rows, fault) as (name: string, args: any) => Promise<any>),
  };
}
const readRows = (): Record<string, any> => ({
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
  // What the database counts as billed on the job (made-up figure).
  backed_billed: { "ZZTEST-JOB": 1000 },
});
Deno.test("batched facts take billed from the database's one sum, and fresh reads reflect office changes", async () => {
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
      "work_order_backed_billed",
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
            // Commission records are read only for a commission line.
            line({ line_type: "commission" }),
          ]),
        LineHoldFactsUnreadable,
      );
    }
  }
  const bad = client(readRows());
  const answer = bad.rpc;
  bad.rpc = (name: string, args: any) =>
    name === "work_order_backed_billed"
      ? answer(name, args)
      : Promise.resolve({ data: null, error: { code: "ZZTEST" } } as any);
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

Deno.test("billed facts include cap changes and crew holds spend nothing across weeks", async () => {
  const rows: Record<string, any> = readRows();
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
  const answer = billedRpc(rows);
  db.rpc = crewRpc((name, args) => answer(name, args, args.p_week_start === "2026-11-16"));
  const f = await readLineHoldFacts(db, "ZZTEST-TRADE", l);
  assertEquals(f.jobs["ZZTEST-JOB"].allowed_ex, 1150);
  assertEquals(f.jobs["ZZTEST-JOB"].backed_billed_ex, 1000);
  const result = classifyLines(l, f);
  assertEquals(result.held[0].hold_reason, "not_on_crew");
  assertEquals(result.held[0].hold_detail?.fallback_reason, null);
  assertEquals(result.backed[0].sent_amount_ex, 120);
});

Deno.test("P1-05.8: an undated counted line is held not_on_crew with its fallback, never thrown", async () => {
  const rows: Record<string, any> = readRows();
  let rpcCalls = 0;
  const db = client(rows);
  const answer = billedRpc(rows);
  db.rpc = crewRpc((name: string, args: any) => {
    if (name === "trade_is_off_job_crew") rpcCalls++;
    return answer(name, args);
  });
  const undated = line({ week_start: undefined, work_date: undefined });
  const f = await readLineHoldFacts(db, "ZZTEST-TRADE", [undated]);
  assertEquals(rpcCalls, 0);
  const result = classifyLines([undated], f);
  assertEquals(result.backed.length, 0);
  assertEquals(result.held[0].hold_reason, "not_on_crew");
  assertEquals(result.held[0].hold_detail?.fallback_reason, null);
  // A dated line on the same send still reads the crew as before.
  const dated = line();
  const both = await readLineHoldFacts(db, "ZZTEST-TRADE", [undated, dated]);
  assertEquals(rpcCalls, 1);
  const sorted = classifyLines([undated, dated], both);
  assertEquals(sorted.held.map((l) => l.hold_reason), ["not_on_crew"]);
  assertEquals(sorted.backed[0].sent_amount_ex, 120);
});

Deno.test("P1-05.8 ruling 1: a send keeps only a same-rate hours split exact to the cent", () => {
  const hours = (extra: Partial<HoldLine> = {}) =>
    line({
      line_type: "labour",
      total_hours: 7.5,
      quantity: undefined,
      rate: 40,
      line_total_ex: 300,
      ...extra,
    });
  // 120 left: 3 h backed (120.00), 4.5 h held (180.00), same rate.
  const split = classifyLines([hours()], facts(), { sameRateSplitOnly: true });
  assertEquals(split.backed[0].total_hours, 3);
  assertEquals(split.backed[0].line_total_ex, 120);
  assertEquals(split.held[0].total_hours, 4.5);
  assertEquals(split.held[0].line_total_ex, 180);
  assertEquals(split.backed[0].rate, split.held[0].rate);
  assertEquals(split.backed[0].split_group_id, split.held[0].split_group_id);
  // An amount line is never split by a send: held whole.
  const amount = classifyLines([line({ line_total_ex: 200, rate: 200 })], facts(), {
    sameRateSplitOnly: true,
  });
  assertEquals(amount.backed.length, 0);
  assertEquals(amount.held[0].line_total_ex, 200);
  assertEquals(amount.held[0].hold_reason, "over_amount");
  // Hours times rate that does not make the line's own total: held whole.
  const odd = classifyLines([hours({ line_total_ex: 301 })], facts(), {
    sameRateSplitOnly: true,
  });
  assertEquals(odd.backed.length, 0);
  assertEquals(odd.held[0].line_total_ex, 301);
  // A line whose start and finish make its hours: held whole.
  const timed = classifyLines(
    [hours({ start_time: "07:00", finish_time: "14:30" })],
    facts(),
    { sameRateSplitOnly: true },
  );
  assertEquals(timed.backed.length, 0);
  assertEquals(timed.held[0].total_hours, 7.5);
  // A rate past two decimals cannot be stored the same on both parts: whole.
  const fine = classifyLines(
    [hours({ rate: 40.001, line_total_ex: 300.01 })],
    facts(),
    { sameRateSplitOnly: true },
  );
  assertEquals(fine.backed.length, 0);
  // The default sorter is unchanged (P1-05.7 behaviour).
  assertEquals(classifyLines([line({ line_total_ex: 200, rate: 200 })], facts()).backed[0].line_total_ex, 120);
});

// Hold 1590 (b): records every read so a test can say what was never fetched.
function recordingClient(rows: Record<string, any>) {
  const reads: Array<{ table: string; columns: string; eq: Record<string, unknown> }> = [];
  return {
    reads,
    from(table: string) {
      const read = { table, columns: "", eq: {} as Record<string, unknown> };
      reads.push(read);
      const q: any = {
        select: (columns: string) => {
          read.columns = columns;
          return q;
        },
        in: () => q,
        eq: (col: string, val: unknown) => {
          read.eq[col] = val;
          return q;
        },
        order: () => q,
        range: () => q,
        then(resolve: any, reject: any) {
          const data = ((rows[table] ?? []) as any[]).filter((row: any) =>
            Object.entries(read.eq).every(([col, val]) =>
              !(col in row) || row[col] === val
            )
          );
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return q;
    },
    rpc: crewRpc(billedRpc(rows) as (name: string, args: any) => Promise<any>),
  };
}
const FIGURES = ["expected_amount_ex_gst", "claimed_ex_gst", "remaining_ex_gst", "salesperson_user_id"];

Deno.test("hold 1590: a send never reads another salesperson's commission id or figures, and still skips that claim", async () => {
  const rows: Record<string, any[]> = {
    ...readRows(),
    jobs: [
      { id: "ZZTEST-JOB", job_number: "ZZTEST-01", type: "fencing", metadata: {} },
      { id: "ZZTEST-OWN", job_number: "ZZTEST-02", type: "fencing", metadata: {} },
    ],
    v_job_commission: [
      commission({ salesperson_user_id: "ZZTEST-OTHER", expected_amount_ex_gst: 700, remaining_ex_gst: 700 }),
      commission({ job_id: "ZZTEST-OWN" }),
    ],
  };
  const db = recordingClient(rows);
  const lines = [
    line({ line_type: "commission" }),
    line({ job_id: "ZZTEST-OWN", line_type: "commission" }),
  ];
  const f = await readLineHoldFacts(db, "ZZTEST-TRADE", lines);
  const commissionReads = db.reads.filter((r) => r.table === "v_job_commission");
  assertEquals(commissionReads.length, 2);
  // Figures only with the caller scoped in the query itself.
  for (const r of commissionReads) {
    const asksFigures = FIGURES.some((c) => r.columns.split(",").includes(c));
    assertEquals(asksFigures ? r.eq.salesperson_user_id : "no figures", asksFigures ? "ZZTEST-TRADE" : "no figures");
  }
  assertEquals(commissionReads[1].columns, "job_id");
  // Nothing of the other salesperson's record reaches the facts.
  assertEquals(f.commissions["ZZTEST-JOB"]?.salesperson_user_id, null);
  assertEquals(f.commissions["ZZTEST-JOB"]?.expected_amount_ex_gst, null);
  assertEquals(f.commissions["ZZTEST-OWN"]?.remaining_ex_gst, 80);
  const result = classifyLines(lines, f);
  assertEquals(result.skipped_items.map((s) => [s.index, s.reason]), [[0, "not_yours"]]);
  assertEquals(result.backed.map((l) => [l.job_id, l.line_type, l.sent_amount_ex]), [
    ["ZZTEST-OWN", "commission", 80],
  ]);
});

Deno.test("hold 1590: a send with no commission line reads no commission record at all", async () => {
  const db = recordingClient({ ...readRows(), v_job_commission: [commission({ salesperson_user_id: "ZZTEST-OTHER" })] });
  await readLineHoldFacts(db, "ZZTEST-TRADE", [line()]);
  assertEquals(db.reads.filter((r) => r.table === "v_job_commission"), []);
});

Deno.test("hold 1590: my_hours' balance read fetches no commission, salesperson, rate or receipt", async () => {
  const rows: Record<string, any[]> = {
    ...readRows(),
    v_job_commission: [commission({ salesperson_user_id: "ZZTEST-OTHER" })],
    trade_rates: [{ id: "ZZTEST-RATE", hourly_rate: 50, effective_from: "2026-01-01", effective_to: null }],
  };
  const db = recordingClient(rows);
  const left = await readJobAmountsLeft(db, "ZZTEST-TRADE", ["ZZTEST-JOB", "ZZTEST-JOB"]);
  // approved 1,120.00 less the database's 1,000.00 billed
  assertEquals(left, { "ZZTEST-JOB": 120 });
  assertEquals(
    [...new Set(db.reads.map((r) => r.table))].sort(),
    // trade_invoice_lines: only whose lines are billed (#1667's owner rule),
    // never returned and never summed here.
    ["jobs", "trade_invoice_lines", "users", "work_order_amount_changes", "work_order_customer_variations", "work_orders"],
  );
  for (const r of db.reads) {
    for (const c of FIGURES) assertEquals(r.columns.split(",").includes(c), false, `${r.table} reads ${c}`);
  }
});

Deno.test("hold 1590: my_hours' balance read: no approved order is null, any failed read refuses, never 0", async () => {
  const rows = readRows();
  rows.work_orders[0].status = "draft";
  assertEquals(await readJobAmountsLeft(recordingClient(rows), "ZZTEST-TRADE", ["ZZTEST-JOB"]), { "ZZTEST-JOB": null });
  assertEquals(await readJobAmountsLeft(recordingClient(readRows()), "ZZTEST-TRADE", []), {});
  for (const table of ["users", "jobs", "work_orders", "work_order_backed_billed", "work_order_customer_variations", "work_order_amount_changes"]) {
    for (const throws of [false, true]) {
      await assertRejects(
        () => readJobAmountsLeft(client(readRows(), table, throws), "ZZTEST-TRADE", ["ZZTEST-JOB"]),
        LineHoldFactsUnreadable,
      );
    }
  }
});

Deno.test("FU49 item 8: awaiting and rejected lines count the same in the send, my_hours and the cap: the database's one sum", async () => {
  const rows: Record<string, any> = {
    ...readRows(),
    feature_flags: [{ flag_name: "trade_line_hold_v1", enabled: true }],
    // On a billed standard invoice: one approved line, one the office has
    // not reviewed yet (awaiting) and one it rejected. Main's classifier
    // added all three (1,000 + 200 + 300); the database counts the approved
    // one only, and its answer is the only figure any side may use.
    trade_invoice_lines: [
      { id: "ZZTEST-A", job_id: "ZZTEST-JOB", line_type: "labour", line_total_ex: 1000, office_review_status: "approved", trade_invoices: { user_id: "ZZTEST-TRADE", status: "approved", invoice_kind: "standard" } },
      { id: "ZZTEST-W", job_id: "ZZTEST-JOB", line_type: "labour", line_total_ex: 200, office_review_status: "awaiting", trade_invoices: { user_id: "ZZTEST-TRADE", status: "approved", invoice_kind: "standard" } },
      { id: "ZZTEST-R", job_id: "ZZTEST-JOB", line_type: "labour", line_total_ex: 300, office_review_status: "rejected", trade_invoices: { user_id: "ZZTEST-TRADE", status: "approved", invoice_kind: "standard" } },
    ],
    backed_billed: { "ZZTEST-JOB": 1000 },
  };
  const db = recordingClient(rows);
  const calls: any[] = [];
  const answer = db.rpc;
  db.rpc = (name: string, args: any) => {
    calls.push({ name, args });
    return answer(name, args);
  };
  const facts = await readLineHoldFacts(db, "ZZTEST-TRADE", [line()]);
  const left = await readJobAmountsLeft(db, "ZZTEST-TRADE", ["ZZTEST-JOB"]);
  const cap = await readBilledOnJobs(db, ["ZZTEST-JOB"]);
  assertEquals(facts.jobs["ZZTEST-JOB"].backed_billed_ex, 1000);
  assertEquals(left, { "ZZTEST-JOB": 120 });
  assertEquals(cap.get("ZZTEST-JOB"), 1000);
  // 120 left, so the 120 line is paid whole. Counting the awaiting and
  // rejected lines (main) would have left nothing and held it all.
  const sorted = classifyLines([line()], facts);
  assertEquals(sorted.held, []);
  assertEquals(sorted.backed[0].sent_amount_ex, 120);
  // No side reads lines to make its own sum: the two line reads are the
  // send's and my_hours' owner check (#1667's rule), and the cap reads none.
  assertEquals(db.reads.filter((r) => r.table === "trade_invoice_lines").length, 2);
  const billedCalls = calls.filter((c) => c.name === "work_order_backed_billed");
  assertEquals(billedCalls.length, 3);
  for (const c of billedCalls) assertEquals(c.args.p_job_ids, ["ZZTEST-JOB"]);
});

Deno.test("FU49 item 8: only jobs read are asked, and an answer missing a job refuses, never 0", async () => {
  const rows: Record<string, any> = readRows();
  const db = client(rows);
  const asked: string[][] = [];
  const answer = db.rpc;
  db.rpc = (name: string, args: any) => {
    if (name === "work_order_backed_billed") asked.push(args.p_job_ids);
    return answer(name, args);
  };
  // A line naming a job the jobs read does not return is not sent to the sum.
  await readLineHoldFacts(db, "ZZTEST-TRADE", [line(), line({ job_id: "ZZTEST-GONE" })]);
  assertEquals(asked, [["ZZTEST-JOB"]]);
  const short = client(rows);
  short.rpc = (name: string, args: any) =>
    name === "work_order_backed_billed"
      ? Promise.resolve({ data: [], error: null })
      : answer(name, args);
  await assertRejects(() => readLineHoldFacts(short, "ZZTEST-TRADE", [line()]), LineHoldFactsUnreadable);
  await assertRejects(() => readJobAmountsLeft(short, "ZZTEST-TRADE", ["ZZTEST-JOB"]), LineHoldFactsUnreadable);
  const unknown = client(rows);
  unknown.rpc = (name: string, args: any) =>
    name === "work_order_backed_billed"
      ? Promise.resolve({ data: [{ job_id: "ZZTEST-JOB", billed_ex: null }], error: null })
      : answer(name, args);
  await assertRejects(() => readLineHoldFacts(unknown, "ZZTEST-TRADE", [line()]), LineHoldFactsUnreadable);
});

// FU49-9b: the cap reaches only jobs whose job work order was approved on or after the
// start date in work_order_cap_settings (work_order_cap_scope; null start: no job).
const scopeClient = (rows: Record<string, any[]>, answer: (ids: string[]) => any) => {
  const db = recordingClient(rows);
  const base = db.rpc;
  db.rpc = (name: string, args: any) =>
    name === "work_order_cap_scope" ? Promise.resolve(answer(args.p_job_ids)) : base(name, args);
  return db;
};
const outOf = (ids: string[]) => ({ data: ids.map((job_id) => ({ job_id, in_scope: false })), error: null });

Deno.test("cap start date: an out-of-scope job holds no work order reason, other holds stay", () => {
  const changes: Array<[string, (f: LineHoldFacts) => void, boolean]> = [
    ["no_work_order", (f) => { f.jobs["ZZTEST-JOB"].workOrder = null; }, false],
    ["no_amount", (f) => { f.jobs["ZZTEST-JOB"].workOrder!.status = "draft"; }, false],
    ["over_amount", (f) => { f.jobs["ZZTEST-JOB"].backed_billed_ex = 1120; }, false],
    ["hourly_no_maximum", (f) => { f.jobs["ZZTEST-JOB"].workOrder = null; f.jobs["ZZTEST-JOB"].hourly = true; }, true],
  ];
  for (const [reason, change, hourly] of changes) {
    const f = facts();
    change(f);
    const l = line(hourly ? { line_type: "labour", total_hours: 1 } : { line_total_ex: 500, rate: 500 });
    assertEquals(classifyLines([l], f).held[0]?.hold_reason, reason);
    f.jobs["ZZTEST-JOB"].cap_in_scope = false;
    const out = classifyLines([l], f);
    assertEquals(out.held, [], reason);
    assertEquals(out.backed[0].sent_amount_ex, l.line_total_ex);
    // Off the crew still holds, with no work order fallback.
    f.jobs["ZZTEST-JOB"].off_crew = true;
    const held = classifyLines([l], f).held[0];
    assertEquals(held.hold_reason, "not_on_crew");
    assertEquals(held.hold_detail?.fallback_reason, null);
  }
  // A job missing from the facts is still held.
  const f = facts();
  f.jobs["ZZTEST-JOB"].cap_in_scope = false;
  assertEquals(classifyLines([line({ job_id: "ZZTEST-OTHER" })], f).held.length, 1);
});

Deno.test("cap start date: the send's facts carry the scope, and a failed or short scope read refuses", async () => {
  const inScope = await readLineHoldFacts(recordingClient(readRows()), "ZZTEST-TRADE", [line()]);
  assertEquals(inScope.jobs["ZZTEST-JOB"].cap_in_scope, true);
  const out = await readLineHoldFacts(scopeClient(readRows(), outOf), "ZZTEST-TRADE", [line()]);
  assertEquals(out.jobs["ZZTEST-JOB"].cap_in_scope, false);
  for (
    const bad of [
      () => ({ data: null, error: { message: "ZZTEST" } }),
      () => ({ data: [], error: null }),
      () => ({ data: [{ job_id: "ZZTEST-ELSE", in_scope: true }], error: null }),
      () => ({ data: [{ job_id: "ZZTEST-JOB", in_scope: null }], error: null }),
      () => ({ data: [{ job_id: "ZZTEST-JOB", in_scope: true }, { job_id: "ZZTEST-JOB", in_scope: true }], error: null }),
      () => { throw new Error("ZZTEST transport"); },
    ]
  ) {
    await assertRejects(
      () => readLineHoldFacts(scopeClient(readRows(), bad), "ZZTEST-TRADE", [line()]),
      LineHoldFactsUnreadable,
    );
  }
});

Deno.test("cap start date: my_hours' balance is null and capped false outside the scope; a failed scope read refuses", async () => {
  assertEquals(await readJobAmountsState(recordingClient(readRows()), "ZZTEST-TRADE", ["ZZTEST-JOB"]), {
    left: { "ZZTEST-JOB": 120 },
    capped: { "ZZTEST-JOB": true },
    hidden: { "ZZTEST-JOB": false },
  });
  assertEquals(await readJobAmountsState(scopeClient(readRows(), outOf), "ZZTEST-TRADE", ["ZZTEST-JOB"]), {
    left: { "ZZTEST-JOB": null },
    capped: { "ZZTEST-JOB": false },
    hidden: { "ZZTEST-JOB": false },
  });
  assertEquals(await readJobAmountsLeft(scopeClient(readRows(), outOf), "ZZTEST-TRADE", ["ZZTEST-JOB"]), { "ZZTEST-JOB": null });
  await assertRejects(
    () => readJobAmountsLeft(scopeClient(readRows(), () => ({ data: null, error: { message: "ZZTEST" } })), "ZZTEST-TRADE", ["ZZTEST-JOB"]),
    LineHoldFactsUnreadable,
  );
});

Deno.test("cap start date: the scope is read 25 jobs a call", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `ZZTEST-J${i}`);
  const calls: string[][] = [];
  const { readWorkOrderCapScope } = await import("./work_order_cap_scope.ts");
  const scope = await readWorkOrderCapScope({
    rpc: (_n: string, a: any) => {
      calls.push(a.p_job_ids);
      return Promise.resolve({ data: a.p_job_ids.map((job_id: string) => ({ job_id, in_scope: job_id === "ZZTEST-J29" })), error: null });
    },
  }, [...ids, ids[0], ""]);
  assertEquals(calls.map((c) => c.length), [25, 5]);
  assertEquals(scope.size, 30);
  assertEquals([...scope].filter(([, v]) => v).map(([k]) => k), ["ZZTEST-J29"]);
});

Deno.test("cap start date: an hourly job over its sealed maximum but outside the scope is paid on a send", () => {
  const f = facts();
  f.jobs["ZZTEST-JOB"].hourly = true;
  f.jobs["ZZTEST-JOB"].backed_billed_ex = 1120;
  const l = line({ line_type: "labour", total_hours: 2, rate: 60, line_total_ex: 120 });
  assertEquals(classifyLines([l], f).held[0]?.hold_reason, "over_amount");
  f.jobs["ZZTEST-JOB"].cap_in_scope = false;
  assertEquals(classifyLines([l], f).held, []);
});

// Cap left (director ruling 18 Nov 2026, as #1667): the amount left is the
// agreed amount less every trade's billing, so a trade sees it only on a job
// where every billed line is their own. Made-up amounts, roles only.
const billedLine = (id: string, userId: string, status = "approved") => ({
  id, trade_invoice_id: `inv-${id}`, job_id: "ZZTEST-JOB", line_type: "labour", line_total_ex: 100,
  trade_invoices: { id: `inv-${id}`, user_id: userId, status, invoice_kind: "standard" },
});

Deno.test("cap left: the send's hold words carry the amount left only when every billed line on the job is the trade's own", async () => {
  const over = line({ line_total_ex: 200, rate: 200 });
  // Trade A billed alone: the words name what was left.
  const alone = await readLineHoldFacts(recordingClient({ ...readRows(), trade_invoice_lines: [billedLine("a1", "ZZTEST-TRADE")] }), "ZZTEST-TRADE", [over]);
  assertEquals(alone.jobs["ZZTEST-JOB"].left_shown, true);
  const shown = classifyLines([over], alone).held[0];
  assertEquals(shown.words, "With the office: this job's amount is used up. $120.00 was left, so $80.00 is waiting.");
  assertEquals([shown.hold_detail?.left_ex, shown.hold_detail?.left_hidden], [120, undefined]);
  // Trade B billed on the same job: A's words carry no amount left.
  const shared = await readLineHoldFacts(recordingClient({ ...readRows(), trade_invoice_lines: [billedLine("a1", "ZZTEST-TRADE"), billedLine("b1", "ZZTEST-TRADE-B")] }), "ZZTEST-TRADE", [over]);
  assertEquals(shared.jobs["ZZTEST-JOB"].left_shown, false);
  const hidden = classifyLines([over], shared).held[0];
  assertEquals(hidden.hold_reason, "over_amount");
  assertEquals(hidden.words, "With the office: this line is more than this job's work order has left, so $80.00 is waiting.");
  assertEquals([hidden.hold_detail?.left_ex, hidden.hold_detail?.left_hidden], [null, true]);
  // Neither the agreed amount nor the remainder is saved on a hidden line:
  // agreed beside asked and held would give the remainder back.
  assertEquals(hidden.hold_detail?.allowed_ex, null, "no agreed amount saved when hidden");
  assertEquals(Object.values(hidden.hold_detail ?? {}).includes(120), false, "no remainder in the detail");
  assertEquals(Object.values(hidden.hold_detail ?? {}).includes(1120), false, "no agreed amount in the detail");
  // Shown job: both figures saved as before.
  assertEquals([shown.hold_detail?.allowed_ex, shown.hold_detail?.left_ex], [1120, 120]);
  // The cap itself is unchanged: the same split, only the words differ.
  assertEquals(classifyLines([over], shared).backed.map((l) => l.sent_amount_ex), classifyLines([over], alone).backed.map((l) => l.sent_amount_ex));
  // Another trade's draft invoice hides nothing.
  const draft = await readLineHoldFacts(recordingClient({ ...readRows(), trade_invoice_lines: [billedLine("b1", "ZZTEST-TRADE-B", "draft")] }), "ZZTEST-TRADE", [over]);
  assertEquals(draft.jobs["ZZTEST-JOB"].left_shown, true);
});

Deno.test("cap left: my_hours' balance read withholds the amount on a job another trade billed on", async () => {
  const alone = await readJobAmountsState(recordingClient({ ...readRows(), trade_invoice_lines: [billedLine("a1", "ZZTEST-TRADE")] }), "ZZTEST-TRADE", ["ZZTEST-JOB"]);
  assertEquals([alone.left["ZZTEST-JOB"], alone.hidden["ZZTEST-JOB"]], [120, false]);
  const shared = await readJobAmountsState(recordingClient({ ...readRows(), trade_invoice_lines: [billedLine("a1", "ZZTEST-TRADE"), billedLine("b1", "ZZTEST-TRADE-B")] }), "ZZTEST-TRADE", ["ZZTEST-JOB"]);
  assertEquals([shared.left["ZZTEST-JOB"], shared.capped["ZZTEST-JOB"], shared.hidden["ZZTEST-JOB"]], [null, true, true]);
  assertEquals(await readJobAmountsLeft(recordingClient({ ...readRows(), trade_invoice_lines: [billedLine("b1", "ZZTEST-TRADE-B")] }), "ZZTEST-TRADE", ["ZZTEST-JOB"]), { "ZZTEST-JOB": null });
});

Deno.test("cap left: an unreadable owner read hides the amount in both places, never shows it on a guess", async () => {
  for (const throws of [false, true]) {
    const state = await readJobAmountsState(client(readRows(), "trade_invoice_lines", throws), "ZZTEST-TRADE", ["ZZTEST-JOB"]);
    assertEquals([state.left["ZZTEST-JOB"], state.hidden["ZZTEST-JOB"]], [null, true]);
    const f = await readLineHoldFacts(client(readRows(), "trade_invoice_lines", throws), "ZZTEST-TRADE", [line({ line_total_ex: 200, rate: 200 })]);
    assertEquals(f.jobs["ZZTEST-JOB"].left_shown, false);
    assertEquals(classifyLines([line({ line_total_ex: 200, rate: 200 })], f).held[0].hold_detail?.left_ex, null);
  }
});

Deno.test("cap left: the label table has no amount left, no codes and no em dashes; other hold words are unchanged", () => {
  for (const words of Object.values(LEFT_HIDDEN_WORDS)) {
    assertEquals(words.includes("<left>") || words.includes("$"), false, words);
    assertEquals(/[\u2014]|_/.test(words), false, words);
  }
  const f = facts();
  f.jobs["ZZTEST-JOB"].left_shown = false;
  f.jobs["ZZTEST-JOB"].workOrder = null;
  assertEquals(classifyLines([line()], f).held[0].words, HOLD_WORDS.no_work_order);
});
