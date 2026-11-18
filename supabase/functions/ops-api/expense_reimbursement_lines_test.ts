// P2-06.6: own-money receipts join the trade's next invoice through P1-03's
// door. Made-up amounts and ZZTEST ids only.
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  OWN_MONEY_SWEEP_LIMIT,
  ownMoneyReimbursementItems,
  reimbursementSkipAnswer,
  resolveReimbursementExtras,
} from "./trade_invoice_reimbursement.ts";
import { calculateTradeInvoiceMoney } from "./trade_invoice_money.ts";

const TRADE = "ZZTEST-trade";
const BASIS = "inclusive_12_112_v1";

const receipt = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  created_at: `2026-11-1${id.slice(-1)}T01:00:00Z`,
  submitted_by: TRADE,
  payment_method: "personal_card",
  receipt_storage_path: `ZZTEST/${id}.png`,
  receipt_photo_url: null,
  no_receipt_reason: null,
  status: "pending",
  total_amount: 55,
  gst_amount: 5,
  vendor_name: "ZZTEST supplier",
  receipt_date: "2026-11-16",
  job_id: "ZZTEST-job-a",
  stock_division: null,
  xero_bill_id: null,
  jobs: { job_number: "ZZTEST-01" },
  ...extra,
});

type Filter = (row: any) => boolean;
// A small PostgREST stand-in that applies the filters the sweep sends, so a
// company card or billed receipt is left out by the query, not by the test.
function fakeClient(opts: {
  flag?: boolean | "error";
  receipts?: any[];
  claims?: { expense_receipt_id: string; trade_invoice_id: string }[];
  listError?: boolean;
}) {
  const reads: { table: string; filters: string[]; limit?: number; order: string[] }[] = [];
  const client = {
    reads,
    from(table: string) {
      const filters: Filter[] = [];
      const read = { table, filters: [] as string[], limit: undefined as number | undefined, order: [] as string[] };
      reads.push(read);
      const rows = (): any[] => {
        if (table === "expense_receipts") return opts.receipts || [];
        if (table === "trade_invoice_lines") return opts.claims || [];
        return [];
      };
      const run = () => {
        let out = rows().filter((row) => filters.every((f) => f(row)));
        if (read.order.length) {
          out = [...out].sort((a, b) =>
            String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id))
          );
        }
        if (read.limit !== undefined) out = out.slice(0, read.limit);
        return out;
      };
      const q: any = {
        select() { return q; },
        eq(col: string, value: unknown) {
          read.filters.push(`eq:${col}`);
          filters.push((row) => row[col] === value);
          return q;
        },
        is(col: string, value: unknown) {
          read.filters.push(`is:${col}`);
          filters.push((row) => (row[col] ?? null) === value);
          return q;
        },
        not(col: string, op: string, value: string) {
          read.filters.push(`not:${col}:${op}`);
          const list = value.replace(/[()]/g, "").split(",");
          filters.push((row) => !list.includes(String(row[col])));
          return q;
        },
        or(expr: string) {
          read.filters.push(`or:${expr}`);
          filters.push((row) => row.job_id != null || row.stock_division != null);
          return q;
        },
        in(col: string, values: unknown[]) {
          read.filters.push(`in:${col}`);
          filters.push((row) => values.includes(row[col]));
          return q;
        },
        order(col: string) { read.order.push(col); return q; },
        limit(n: number) { read.limit = n; return q; },
        maybeSingle() {
          if (table === "feature_flags") {
            if (opts.flag === "error") return Promise.resolve({ data: null, error: { message: "down" } });
            return Promise.resolve({ data: { enabled: opts.flag === true }, error: null });
          }
          return Promise.resolve({ data: run()[0] ?? null, error: null });
        },
        then(resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) {
          if (table === "expense_receipts" && opts.listError) {
            return Promise.resolve({ data: null, error: { code: "57014" } }).then(resolve, reject);
          }
          return Promise.resolve({ data: run(), error: null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return client;
}

const sweep = (client: any, extra: Record<string, unknown> = {}) =>
  ownMoneyReimbursementItems(client, {
    userId: TRADE,
    basis: BASIS,
    requested: [],
    replacingDraftId: null,
    groupShare: false,
    ...extra,
  });

// The generate path: sweep, then the door with the swept items appended.
async function generate(client: any, requested: any[] = [], replacingDraftId: string | null = null) {
  const own = await sweep(client, { requested, replacingDraftId });
  const result = await resolveReimbursementExtras(client, {
    userId: TRADE,
    items: [...requested, ...own.items],
    flagOn: own.flagOn === true,
    basis: BASIS,
    replacingDraftId,
  });
  return { own, result, answer: reimbursementSkipAnswer(result, own.autoIds) };
}

Deno.test("ZZTEST own-money receipt of 55.00 with GST 5.00 becomes one reimbursement line paying 55.00, super 0", async () => {
  const client = fakeClient({ flag: true, receipts: [receipt("ZZTEST-r1")] });
  const { result, answer } = await generate(client);
  assertEquals(result.lines.length, 1);
  const line = result.lines[0];
  assertEquals(line.line_type, "reimbursement");
  assertEquals(line.expense_receipt_id, "ZZTEST-r1");
  assertEquals(line.job_id, "ZZTEST-job-a");
  assertEquals(line.line_total_ex, 55); // the full amount the trade paid
  assertEquals(answer, { skipped_items: [], not_added: [] });
  const money = calculateTradeInvoiceMoney({
    grossEarned: 55,
    gstOn: true,
    earningsDate: "2026-11-23",
    superBasis: BASIS,
    reimbursementEx: 55,
  });
  assertEquals(money.super_amount, 0);
  assertEquals(money.gst_amount, 0);
  assertEquals(money.trade_payable, 55);
});

Deno.test("ZZTEST generating again adds no second line for a receipt already on an invoice", async () => {
  const client = fakeClient({
    flag: true,
    receipts: [receipt("ZZTEST-r1")],
    claims: [{ expense_receipt_id: "ZZTEST-r1", trade_invoice_id: "ZZTEST-inv-1" }],
  });
  const { own, result } = await generate(client);
  assertEquals(own.items, []);
  assertEquals(result.lines, []);
});

Deno.test("ZZTEST the replaceable draft's own receipt is carried onto the replacement, once", async () => {
  const client = fakeClient({
    flag: true,
    receipts: [receipt("ZZTEST-r1")],
    claims: [{ expense_receipt_id: "ZZTEST-r1", trade_invoice_id: "ZZTEST-draft" }],
  });
  const { result } = await generate(client, [], "ZZTEST-draft");
  assertEquals(result.lines.map((l: any) => l.expense_receipt_id), ["ZZTEST-r1"]);
});

Deno.test("ZZTEST company card, billed, queried, rejected and no-job-no-stock receipts add none", async () => {
  const client = fakeClient({
    flag: true,
    receipts: [
      receipt("ZZTEST-r1", { payment_method: "company_card" }),
      receipt("ZZTEST-r2", { xero_bill_id: "ZZTEST-bill" }),
      receipt("ZZTEST-r3", { status: "queried" }),
      receipt("ZZTEST-r4", { status: "rejected" }),
      receipt("ZZTEST-r5", { job_id: null, stock_division: null }),
      receipt("ZZTEST-r6", { payment_method: "cash" }),
    ],
  });
  const { own, result } = await generate(client);
  assertEquals(own.items, []);
  assertEquals(result.lines, []);
  const list = client.reads.find((r) => r.table === "expense_receipts")!;
  assertEquals(list.filters, [
    "eq:submitted_by",
    "eq:payment_method",
    "is:xero_bill_id",
    "not:status:in",
    "or:job_id.not.is.null,stock_division.not.is.null",
  ]);
  assertEquals(list.limit, OWN_MONEY_SWEEP_LIMIT);
});

Deno.test("ZZTEST a stock receipt goes through the door and is held for the office as no job", async () => {
  const client = fakeClient({
    flag: true,
    receipts: [receipt("ZZTEST-r1", { job_id: null, jobs: null, stock_division: "fencing" })],
  });
  const { result } = await generate(client);
  assertEquals(result.lines.length, 1);
  assertEquals(result.lines[0].hold_reason, "no_job");
  assertEquals(result.lines[0].office_review_status, "awaiting");
});

Deno.test("ZZTEST a swept receipt the door refuses is listed under not_added; an asked-for one stays in skipped_items", async () => {
  const client = fakeClient({
    flag: true,
    receipts: [
      receipt("ZZTEST-r1", { receipt_storage_path: null }),
      receipt("ZZTEST-r2", { total_amount: 0 }),
    ],
  });
  const { result, answer } = await generate(client, [{ type: "reimbursement", expense_receipt_id: "ZZTEST-r2" }]);
  assertEquals(result.lines, []);
  assertEquals(answer.skipped_items.map((s) => [s.expense_receipt_id, s.code]), [["ZZTEST-r2", "reimbursement_amount_unreadable"]]);
  assertEquals(answer.not_added!.map((s) => [s.expense_receipt_id, s.code]), [["ZZTEST-r1", "reimbursement_receipt_required"]]);
});

Deno.test("ZZTEST several receipts go on oldest first, each once", async () => {
  const client = fakeClient({
    flag: true,
    receipts: [receipt("ZZTEST-r3"), receipt("ZZTEST-r1"), receipt("ZZTEST-r2")],
  });
  const { result } = await generate(client, [{ type: "reimbursement", expense_receipt_id: "ZZTEST-r2" }]);
  assertEquals(result.lines.map((l: any) => l.expense_receipt_id), ["ZZTEST-r2", "ZZTEST-r1", "ZZTEST-r3"]);
});

Deno.test("ZZTEST switch off, switch unreadable, old super rule or a group share: no receipt read and main's answer", async () => {
  for (const [opts, extra] of [
    [{ flag: false }, {}],
    [{ flag: "error" }, {}],
    [{ flag: true }, { basis: "employer_super_v1" }],
    [{ flag: true }, { basis: null }],
    [{ flag: true }, { groupShare: true }],
  ] as const) {
    const client = fakeClient({ ...opts, receipts: [receipt("ZZTEST-r1")] });
    const own = await sweep(client, extra);
    assertEquals(own.items, []);
    assertEquals(own.autoIds, null);
    assertEquals(client.reads.some((r) => r.table === "expense_receipts" || r.table === "trade_invoice_lines"), false);
    const skips = [{ expense_receipt_id: "ZZTEST-x", code: "reimbursement_switch_off" as const, words: "w" }];
    assertEquals(reimbursementSkipAnswer({ skipped_items: skips }, own.autoIds), { skipped_items: skips });
    assertEquals(Object.keys(reimbursementSkipAnswer({ skipped_items: [] }, own.autoIds)), ["skipped_items"]);
  }
});

Deno.test("ZZTEST a failed receipt list read refuses instead of reading as nothing to pay back", async () => {
  const client = fakeClient({ flag: true, listError: true });
  await assertRejects(() => sweep(client), Error, "Could not read your receipts to pay back");
});

Deno.test("ZZTEST line-hold answer keeps main's combined skips and adds not_added only for swept receipts", () => {
  const swept = { expense_receipt_id: "ZZTEST-r1", code: "reimbursement_already_claimed" as const, words: "w" };
  const asked = { expense_receipt_id: "ZZTEST-r2", code: "reimbursement_rejected" as const, words: "w" };
  const other = { code: "line_left_out" };
  assertEquals(
    reimbursementSkipAnswer({ skipped_items: [asked, swept] }, new Set(["ZZTEST-r1"]), [other]),
    { skipped_items: [asked, other], not_added: [swept] },
  );
  assertEquals(
    reimbursementSkipAnswer({ skipped_items: [asked] }, null, [other]),
    { skipped_items: [asked, other] },
  );
});
