import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveReimbursementExtras,
  retryReimbursementClaims,
} from "./trade_invoice_reimbursement.ts";
import { calculateTradeInvoiceMoney } from "./trade_invoice_money.ts";

const receipt = (extra = {}) => ({
  id: "ZZTEST-receipt",
  submitted_by: "ZZTEST-trade",
  payment_method: "personal_card",
  receipt_storage_path: "ZZTEST/receipt.png",
  status: "pending",
  total_amount: 80,
  vendor_name: "ZZTEST supplier",
  receipt_date: "2026-11-16",
  job_id: "ZZTEST-job",
  jobs: { job_number: "ZZTEST-01" },
  ...extra,
});
function client(row: unknown, claims: unknown[] = []) {
  return {
    from(table: string) {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle() {
          return Promise.resolve({ data: row });
        },
        then(resolve: (r: unknown) => unknown) {
          return Promise.resolve({ data: claims }).then(resolve);
        },
      };
    },
  };
}
const resolve = (row: unknown, options = {}, claims: unknown[] = []) =>
  resolveReimbursementExtras(client(row, claims), {
    userId: "ZZTEST-trade",
    items: [{
      type: " Reimbursement ",
      expense_receipt_id: "ZZTEST-receipt",
      rate: 500,
    }],
    flagOn: true,
    basis: "inclusive_12_112_v1",
    ...options,
  });

Deno.test("ZZTEST reimbursement checks skip only the receipt in the required order", async () => {
  const cases: [unknown, Record<string, unknown>, unknown[], string][] = [
    [null, { flagOn: false }, [], "reimbursement_switch_off"],
    [null, { basis: null }, [], "reimbursement_switch_off"],
    [null, {}, [], "reimbursement_not_yours"],
    [
      receipt({ submitted_by: "ZZTEST-other" }),
      {},
      [],
      "reimbursement_not_yours",
    ],
    [
      receipt({ payment_method: "company_card", receipt_storage_path: null }),
      {},
      [],
      "reimbursement_not_personal_spend",
    ],
    [
      receipt({
        receipt_storage_path: "",
        receipt_photo_url: "",
        status: "rejected",
      }),
      {},
      [],
      "reimbursement_receipt_required",
    ],
    [
      receipt({ no_receipt_reason: "ZZTEST missing" }),
      {},
      [],
      "reimbursement_receipt_required",
    ],
    [receipt({ status: "rejected" }), {}, [], "reimbursement_rejected"],
    [receipt(), {}, [{
      trade_invoice_id: "ZZTEST-invoice",
      invoice: { status: "submitted" },
    }], "reimbursement_already_claimed"],
    [
      receipt({ xero_bill_id: "ZZTEST-bill" }),
      {},
      [],
      "reimbursement_already_claimed",
    ],
  ];
  for (const [row, options, claims, code] of cases) {
    const result = await resolve(row, options, claims);
    assertEquals(result.lines, []);
    assertEquals(result.skipped_items.map((s: any) => s.code), [code]);
    const hours = [{ line_type: "labour", line_total_ex: 560 }];
    assertEquals([...hours, ...result.lines], hours);
  }
});
Deno.test("ZZTEST receipt sets the amount and its office backing, with no job held", async () => {
  for (
    const [row, hold] of [[receipt(), "reimbursement"], [
      receipt({ status: "approved" }),
      null,
    ], [
      receipt({ job_id: null, jobs: null, status: "approved" }),
      "no_job",
    ]] as const
  ) {
    const result = await resolve(row);
    assertEquals(result.skipped_items, []);
    assertEquals(result.lines.length, 1);
    assertEquals(result.lines[0].line_total_ex, 80);
    assertEquals(result.lines[0].unit_rate, 80);
    assertEquals(result.lines[0].hold_reason, hold);
    assertEquals(
      result.lines[0].office_review_status,
      hold ? "awaiting" : "approved",
    );
    assertEquals(result.lines[0].job_id, row.job_id);
  }
});
Deno.test("ZZTEST any stored receipt line is claimed, including draft and ops-reject", async () => {
  for (const status of ["draft", "ops-reject", "submitted", null]) {
    const result = await resolve(receipt(), {}, [{ trade_invoice_id: "ZZTEST-existing", invoice: { status } }]);
    assertEquals(result.lines, []);
    assertEquals(result.skipped_items.map((s) => s.code), ["reimbursement_already_claimed"]);
  }
});
Deno.test("ZZTEST only the selected replacement draft can reuse its receipt", async () => {
  const claims = [{ trade_invoice_id: "ZZTEST-draft" }];
  const own = await resolve(receipt(), { replacingDraftId: "ZZTEST-draft" }, claims);
  assertEquals(own.lines.length, 1);
  const other = await resolve(receipt(), { replacingDraftId: "ZZTEST-other" }, claims);
  assertEquals(other.lines, []);
});
Deno.test("ZZTEST weekly receipt stays out of the super base and hours", async () => {
  const result = await resolve(receipt());
  const money = calculateTradeInvoiceMoney({
    grossEarned: 560 + result.lines[0].line_total_ex,
    gstOn: false,
    earningsDate: "2026-11-16",
    superBasis: "inclusive_12_112_v1",
    reimbursementEx: 80,
  });
  assertEquals([
    money.gross_earned,
    money.super_base_ex,
    money.super_amount,
    money.net_pay,
  ], [640, 560, 60, 580]);
  assertEquals(result.lines[0].total_hours ?? 0, 0);
});

Deno.test("ZZTEST database claim race skips only the losing receipt and saves the remaining week", async () => {
  const result = await resolve(receipt());
  let saved: unknown[] = [], attempts = 0, gross = 640;
  const id = await retryReimbursementClaims(
    client(null, [{ invoice: { status: "submitted" } }]),
    result,
    async () => {
      if (attempts++ === 0) throw new Error("reimbursement_already_claimed");
      saved = [{ line_type: "labour", line_total_ex: 560 }, ...result.lines];
      return "ZZTEST-saved";
    },
    async (removed) => {
      gross -= removed.reduce((s, l) => s + l.line_total_ex, 0);
    },
  );
  assertEquals(id, "ZZTEST-saved");
  assertEquals(saved, [{ line_type: "labour", line_total_ex: 560 }]);
  assertEquals(gross, 560);
  assertEquals(result.skipped_items.map((s) => s.code), [
    "reimbursement_already_claimed",
  ]);
});

Deno.test("ZZTEST unique receipt index race retries and preserves the remaining week", async () => {
  const result = await resolve(receipt());
  let attempts = 0, repriced = 0;
  const saved = await retryReimbursementClaims(client(null, [{ trade_invoice_id: "ZZTEST-rejected" }]), result,
    async () => {
      if (attempts++ === 0) throw new Error('duplicate key value violates unique constraint "trade_invoice_lines_one_receipt"');
      return "ZZTEST-week";
    }, async (removed) => { repriced += removed.length; });
  assertEquals(saved, "ZZTEST-week");
  assertEquals(attempts, 2);
  assertEquals(repriced, 1);
  assertEquals(result.lines, []);
  assertEquals(result.skipped_items.map((s) => s.code), ["reimbursement_already_claimed"]);
});
Deno.test("ZZTEST unrelated unique errors are not receipt retries", async () => {
  const result = await resolve(receipt());
  let repriced = 0;
  await assertRejects(() => retryReimbursementClaims(client(null, [{ trade_invoice_id: "ZZTEST-other" }]), result,
    async () => { throw new Error('duplicate key value violates unique constraint "other_index"'); },
    async () => { repriced++; }), Error, "other_index");
  assertEquals(repriced, 0);
  assertEquals(result.lines.length, 1);
});

Deno.test("ZZTEST standalone SQL fixture uses the exact existing persist functions", async () => {
  const baseline = await Deno.readTextFile(new URL("../../migrations/20260831021701_trade_invoice_weekly_deductions.sql", import.meta.url));
  const fixture = await Deno.readTextFile(new URL("../../tests/migration-contracts/20261117194401_trade_reimbursement_receipt_replacement/baseline_functions.sql", import.meta.url));
  assertEquals(fixture, (baseline.slice(baseline.indexOf("CREATE OR REPLACE FUNCTION public.trade_invoice_first_numeric_candidate_v1("), baseline.indexOf("CREATE OR REPLACE FUNCTION public.persist_trade_work_order_invoice_v1(")) + baseline.slice(baseline.indexOf("CREATE OR REPLACE FUNCTION public.persist_weekly_trade_invoice_v1("), baseline.indexOf("-- Preserve existing source values"))).trimEnd() + "\n");
});

Deno.test("ZZTEST receipt-bearing dated hourly submission uses atomic save; switch-off stays legacy", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const start = source.indexOf("            const invoiceId = await retryReimbursementClaims(client, reimbursements,");
  const end = source.indexOf("            const invoice = { id: invoiceId }", start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const submit = new AsyncFunction("ctx", "with (ctx) {" + source.slice(start, end).replace(/: (any|number)\b/g, "") + "return invoiceId; }");
  for (const enabled of [false, true]) {
    const result = await resolve(receipt(), { flagOn: enabled });
    let atomic = 0, legacy = 0;
    const saved = await submit({
      client: {}, reimbursements: result, priorDraftId: "ZZTEST-draft", week_start: "2026-11-16",
      weeklyInvoice: null, invoicePayload: { status: "pending_acknowledgment" }, tradeUser: { orgId: "ZZTEST-org" },
      lineItems: [{ line_total_ex: 560 }], extraLineItems: result.lines,
      retryReimbursementClaims: (_client: unknown, _result: unknown, persist: () => Promise<string>) => persist(),
      persistWithFreeNumber: async (persist: () => Promise<string>) => await persist(),
      toTradeInvoiceLineRow: (_id: string, row: unknown) => row,
      _persistTradeInvoiceWeekDraft: (_client: unknown, header: unknown, lines: unknown[], prior: string) => {
        atomic++;
        assertEquals(header, { status: "pending_acknowledgment", org_id: "ZZTEST-org" });
        assertEquals(prior, "ZZTEST-draft");
        assertEquals(lines.length, 2);
        return "ZZTEST-atomic";
      },
      replaceTradeInvoiceDraftKeepingPrior: () => { legacy++; return "ZZTEST-legacy"; },
    });
    assertEquals(atomic, enabled ? 1 : 0);
    assertEquals(legacy, enabled ? 0 : 1);
    assertEquals(saved, enabled ? "ZZTEST-atomic" : "ZZTEST-legacy");
  }
});
