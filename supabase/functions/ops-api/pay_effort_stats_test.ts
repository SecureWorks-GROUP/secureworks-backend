import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  EffortStatsUnreadable,
  readPayEffortStats,
} from "./pay_effort_stats.ts";
import { rejectTradeInvoiceStorage } from "./trade_invoice_rejection.ts";

const org = "00000000-0000-4000-8000-000000000001";
const empty = {
  week_start: "2026-11-16",
  sent: 0,
  sent_back_or_corrected: 0,
  share: null,
  on_target: null,
  accepted_untouched: 0,
  auto_sent: 0,
  median_confirm_seconds: null,
  changed_lines: 0,
  held: [],
  no_work_order_trend: "flat",
  told_no_after_sent: { invoices: 0, trades: 0, amount_ex: 0 },
};

Deno.test("one aggregate read uses the caller organisation and defaults to eight weeks", async () => {
  let calls = 0;
  const weeks = Array.from({ length: 8 }, () => empty);
  const result = await readPayEffortStats(
    {
      rpc(name, args) {
        calls++;
        assertEquals(name, "pay_effort_stats");
        assertEquals(args, { p_weeks: 8, p_org_id: org });
        return Promise.resolve({ data: weeks, error: null });
      },
    },
    null,
    org,
  );
  assertEquals(calls, 1);
  assertEquals(result, { ok: true, target_share: 0.05, weeks });
});

Deno.test("missing, partial and failed effort reads refuse; retry uses a fresh read", async () => {
  for (const bad of [null, [], [{}], [null]]) {
    await assertRejects(
      () =>
        readPayEffortStats(
          { rpc: () => Promise.resolve({ data: bad, error: null }) },
          "1",
          org,
        ),
      EffortStatsUnreadable,
    );
  }
  let calls = 0;
  const client = {
    rpc() {
      calls++;
      return calls === 1
        ? Promise.reject(new Error("provider detail"))
        : Promise.resolve({ data: [empty], error: null });
    },
  };
  await assertRejects(
    () => readPayEffortStats(client, "1", org),
    EffortStatsUnreadable,
    "effort_stats_unreadable",
  );
  assertEquals(
    (await readPayEffortStats(client, "1", org)).weeks[0].share,
    null,
  );
});

Deno.test("invalid window or missing organisation reads nothing", async () => {
  let reads = 0;
  const client = {
    rpc() {
      reads++;
      throw new Error();
    },
  };
  for (const weeks of ["27", "0", "1.5"]) {
    await assertRejects(() => readPayEffortStats(client, weeks, org));
  }
  await assertRejects(() => readPayEffortStats(client, "1", null));
  assertEquals(reads, 0);
});

Deno.test("staff GET is required before reading any aggregate", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const block = source.split("case 'pay_effort_stats': {")[1].split(
    "case 'trade_pay_run_check'",
  )[0];
  const door = new Function(
    "ctx",
    "return (async()=>{with(ctx) {" +
      block.slice(0, block.lastIndexOf("}")) + "}})()",
  );
  let reads = 0;
  const ctx = {
    req: { method: "GET" },
    authMode: "jwt",
    authUser: { role: "trade", orgId: org },
    ApiError: Error,
    _opsApiStaffOperatorRole: (r: string) => r === "admin",
    json: (x: unknown) => x,
    readPayEffortStats: () => ++reads,
    client: {},
    url: new URL("https://example.invalid"),
  };
  await assertRejects(() => door(ctx), Error, "staff_required");
  await assertRejects(
    () => door({ ...ctx, req: { method: "POST" } }),
    Error,
    "method_not_allowed",
  );
  assertEquals(reads, 0);
  assertEquals(
    await door({ ...ctx, authUser: { role: "admin", orgId: org } }),
    1,
  );
});

Deno.test("office list selects invoice and line suggestion evidence", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const select = source.split("const TRADE_BILLS_COLUMNS = '")[1].split("'")[0];
  const [header, lines] = select.split("lines:trade_invoice_lines(");
  for (
    const key of [
      "accepted_untouched",
      "auto_sent",
      "confirm_seconds",
      "office_sent_back_at",
    ]
  ) {
    assert(header.split(", ").includes(key));
  }
  for (const key of ["suggested", "changed_from_suggestion"]) {
    assert(lines.split(", ").includes(key));
  }
});

Deno.test("reject stores the timestamp in the Xero-guarded office update", async () => {
  let changes: Record<string, unknown> = {};
  const absent: string[] = [];
  const query = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    is(key: string) {
      absent.push(key);
      return this;
    },
    update(row: Record<string, unknown>) {
      changes = row;
      return this;
    },
    maybeSingle: () =>
      Promise.resolve({ data: { id: "ZZTEST-invoice", enabled: false } }),
  };
  await rejectTradeInvoiceStorage(
    { from: () => query },
    "ZZTEST-invoice",
    "ZZTEST",
    "office",
  );
  assertEquals(absent, ["xero_bill_id", "xero_pushed_at"]);
  assertEquals(changes.status, "ops-reject");
  assert(Number.isFinite(Date.parse(String(changes.office_sent_back_at))));
});

Deno.test("office work-order presentation keeps each sorted line's own suggestion", async () => {
  // The imported handler reads its URL at module load. Use only local placeholders.
  Deno.env.set("SUPABASE_URL", "http://127.0.0.1:9");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  const { _listTradeInvoicesForTest } = await import("./index.ts");
  const line = {
    line_type: "labour",
    job_number: "ZZTEST-1",
    job_id: "job",
    source_work_order_id: "order",
    quantity: 1,
    line_total_ex: 2,
    unit_rate: 2,
  };
  const invoice = {
    id: "invoice",
    week_start: empty.week_start,
    invoice_source: "weekly_work_order",
    gst_on: false,
    super_basis: "employer_12_v2",
    super_rate: 0.12,
    subtotal_ex: 4,
    gross_earned: 4,
    net_pay: 4,
    super_amount: 0.48,
    gst: 0,
    total_inc: 4,
    job_grand_total_ex: 4,
    final_deductions_total_ex: 0,
    to_be_paid_ex: 4,
    accepted_untouched: false,
    lines: [{
      ...line,
      line_position: 2,
      suggested: null,
      changed_from_suggestion: true,
    }, {
      ...line,
      line_position: 1,
      suggested: { quantity: 1 },
      changed_from_suggestion: false,
    }],
  };
  const client = {
    from(table: string) {
      let weekly = false;
      const query = {
        select() {
          return this;
        },
        not() {
          weekly = true;
          return this;
        },
        order() {
          return this;
        },
        eq() {
          return this;
        },
        limit() {
          return this;
        },
        is() {
          return this;
        },
        lte() {
          return this;
        },
        or() {
          return this;
        },
        then(resolve: (result: unknown) => void) {
          resolve({
            data: table === "trade_invoices" && weekly ? [invoice] : [],
          });
        },
      };
      return query;
    },
  };
  const result = await _listTradeInvoicesForTest(
    client,
    new URLSearchParams("status=approved"),
  );
  assertEquals(result.invoices[0].accepted_untouched, false);
  assertEquals(
    result.invoices[0].lines.map((
      l: typeof invoice.lines[number],
    ) => [l.suggested, l.changed_from_suggestion]),
    [[{ quantity: 1 }, false], [null, true]],
  );
});
