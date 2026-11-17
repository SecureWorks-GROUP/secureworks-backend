import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  loadUndatedReimbursementDraft,
  isReimbursementItem,
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
        in() { return this; },
        maybeSingle() {
          return Promise.resolve({ data: row });
        },
        then(resolve: (r: unknown) => unknown) {
          return Promise.resolve({ data: claims.map((claim: any) => ({ expense_receipt_id: "ZZTEST-receipt", ...claim })) }).then(resolve);
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

const undatedDraft = (extra = {}) => ({
  id: "ZZTEST-draft", org_id: "ZZTEST-org", user_id: "ZZTEST-trade",
  status: "draft", invoice_source: "hourly", week_start: null, week_end: null,
  xero_bill_id: null, xero_pushed_at: null,
  gross_earned: 80, super_basis: "inclusive_12_112_v1", super_base_ex: 0,
  ...extra,
});
const undatedInput = { userId: "ZZTEST-trade", orgId: "ZZTEST-org", draftId: "ZZTEST-draft", flagOn: true };

Deno.test("FU17 undated draft selection refuses a missing, changed or unreadable draft", async () => {
  for (const row of [null, undatedDraft({ org_id: "ZZTEST-other" }),
    undatedDraft({ user_id: "ZZTEST-other" }), undatedDraft({ status: "ops-reject" }),
    undatedDraft({ invoice_source: "work_order" }), undatedDraft({ week_start: "2026-11-16" }),
    undatedDraft({ week_end: "2026-11-22" }), undatedDraft({ xero_bill_id: "ZZTEST-bill" }),
    undatedDraft({ xero_pushed_at: "2026-11-17T00:00:00Z" })]) {
    await assertRejects(() => loadUndatedReimbursementDraft(client(row), undatedInput), Error, "no longer replaceable");
  }
  const failedRead = { from: () => ({ select() { return this; }, eq() { return this; },
    maybeSingle: () => Promise.resolve({ data: undatedDraft(), error: { message: "ZZTEST read failed" } }) }) };
  await assertRejects(() => loadUndatedReimbursementDraft(failedRead, undatedInput), Error, "Could not read");
  // A retry re-reads the same explicit row; it never chooses another draft.
  assertEquals(await loadUndatedReimbursementDraft(client(undatedDraft()), undatedInput), undatedDraft());
  const noRead = { from() { throw new Error("unexpected draft read"); } };
  assertEquals(await loadUndatedReimbursementDraft(noRead, { ...undatedInput, flagOn: false }), null);
  assertEquals(await loadUndatedReimbursementDraft(noRead, { ...undatedInput, draftId: null }), null);
});

Deno.test("FU17 undated save keeps its own receipt through the real handler path; off stays legacy", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const selectionStart = source.indexOf("            // FU17: keep an undated receipt");
  const selectionEnd = source.indexOf("            const weeklyInvoice =", selectionStart);
  const saveStart = source.indexOf("            const draftId = await retryReimbursementClaims(client, draftReimbursements,");
  const saveEnd = source.indexOf("            await markTradeInvoiceJobsChanged", saveStart);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const select = new AsyncFunction("ctx", "with (ctx) {" + source.slice(selectionStart, selectionEnd)
    .replace(": string | null", "") + "return { existingDraft, existingDraftId, undatedReimbursementSave }; }");
  const save = new AsyncFunction("ctx", "with (ctx) {" + source.slice(saveStart, saveEnd)
    .replace(/: (any|number)\b/g, "") + "return draftId; }");
  for (const enabled of [false, true]) {
    let draftReads = 0, atomic = 0, legacy = 0;
    const db = { from(table: string) {
      if (table === "trade_invoices") draftReads++;
      return { select() { return this; }, eq() { return this; }, in() { return this; },
        maybeSingle: () => Promise.resolve({ data: table === "feature_flags" ? { enabled } : undatedDraft() }) };
    } };
    const selected = await select({ client: db, existingDraft: null, weeklyShape: false,
      draftWeekStart: null, body: { draft_id: "ZZTEST-draft" }, draftExtras: [],
      tradeUser: { id: "ZZTEST-trade", orgId: "ZZTEST-org" }, REIMBURSEMENT_FLAG: "trade_reimbursement_line_v1",
      isReimbursementItem, loadUndatedReimbursementDraft });
    assertEquals(draftReads, enabled ? 1 : 0);
    const claims = [{ trade_invoice_id: "ZZTEST-draft" }];
    const eligibilityStart = source.indexOf("            const draftReimbursements = await invoiceReimbursements(");
    const eligibilityEnd = source.indexOf("\n", eligibilityStart);
    const eligibility = new AsyncFunction("ctx", "with (ctx) {" + source.slice(eligibilityStart, eligibilityEnd) + "; return draftReimbursements; }");
    const draftReimbursements = await eligibility({ ...selected, client: client(receipt(), claims),
      draftWeekStart: null, tradeUser: { id: "ZZTEST-trade" }, draftExtras: [], draftSuperBasis: "inclusive_12_112_v1",
      invoiceReimbursements: (_db: unknown, _user: string, _items: unknown, _basis: unknown, replacingDraftId: string | null, resolvedFlagOn: boolean) => {
        assertEquals(resolvedFlagOn, enabled);
        return resolve(receipt(), { flagOn: resolvedFlagOn, replacingDraftId }, claims);
      },
    });
    assertEquals(draftReimbursements.lines.length, enabled ? 1 : 0);
    assertEquals(draftReimbursements.skipped_items.map((s) => s.code), enabled ? [] : ["reimbursement_switch_off"]);
    const saved = await save({ ...selected, client: client(receipt(), claims), draftReimbursements,
      weeklyInvoice: null, draftWeekStart: null, hourlyDraftPayload: { week_start: null, week_end: null },
      hourlyDraftLineRows: draftReimbursements.lines, retryReimbursementClaims,
      _persistTradeInvoiceWeekDraft: (_db: unknown, header: unknown, rows: any[], prior: string) => {
        atomic++; assertEquals(header, { week_start: null, week_end: null });
        assertEquals(prior, "ZZTEST-draft"); assertEquals(rows[0].expense_receipt_id, "ZZTEST-receipt");
        return "ZZTEST-saved";
      },
      replaceTradeInvoiceDraftKeepingPrior: () => { legacy++; return "ZZTEST-legacy"; },
    });
    assertEquals(atomic, enabled ? 1 : 0);
    assertEquals(legacy, enabled ? 0 : 1);
    assertEquals(saved, enabled ? "ZZTEST-saved" : "ZZTEST-legacy");
  }
});

Deno.test("FU17 undated eligibility reuses the selected switch result; dated callers still read it", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const start = source.indexOf("async function invoiceReimbursements(");
  const end = source.indexOf("async function markTradeInvoiceJobsChanged", start);
  const body = source.slice(source.indexOf("\n", start) + 1, end).replace(/}\s*$/, "");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const eligibility = new AsyncFunction("client", "userId", "items", "basis", "replacingDraftId", "resolvedFlagOn", "deps", "with (deps) {" + body + "}");
  for (const flag of [false, true, undefined]) {
    for (const unreadable of [false, true]) {
      let flagReads = 0;
      const db = { from(table: string) {
        if (table === "feature_flags") flagReads++;
        return { select() { return this; }, eq() { return this; }, in() { return this; },
          maybeSingle: () => Promise.resolve(table === "feature_flags"
            ? unreadable ? { data: null, error: { message: "ZZTEST read failed" } } : { data: { enabled: true } }
            : { data: receipt() }),
          then: (resolve: (r: unknown) => unknown) => Promise.resolve({ data: [] }).then(resolve),
        };
      } };
      const result = await eligibility(db, "ZZTEST-trade", [{ type: "reimbursement", expense_receipt_id: "ZZTEST-receipt" }],
        "inclusive_12_112_v1", null, flag, { isReimbursementItem, resolveReimbursementExtras, REIMBURSEMENT_FLAG: "trade_reimbursement_line_v1" });
      const enabled = flag ?? !unreadable;
      assertEquals(flagReads, flag === undefined ? 1 : 0);
      assertEquals(result.lines.length, enabled ? 1 : 0);
      assertEquals(result.skipped_items.map((s: any) => s.code), enabled ? [] : ["reimbursement_switch_off"]);
    }
  }
});

Deno.test("FU17 receipt-free undated drafts keep the group-share-capable legacy save", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const start = source.indexOf("            const draftId = await retryReimbursementClaims(client, draftReimbursements,");
  const end = source.indexOf("            await markTradeInvoiceJobsChanged", start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const save = new AsyncFunction("ctx", "with (ctx) {" + source.slice(start, end)
    .replace(/: (any|number)\b/g, "") + "return draftId; }");
  let atomic = 0, legacy = 0;
  const saved = await save({ client: {}, draftReimbursements: { lines: [], skipped_items: [] },
    weeklyInvoice: null, draftWeekStart: null, undatedReimbursementSave: true,
    existingDraftId: "ZZTEST-draft", hourlyDraftPayload: { week_start: null, week_end: null },
    hourlyDraftLineRows: [{ group_share_id: "ZZTEST-share", line_type: "group share" }],
    retryReimbursementClaims,
    _persistTradeInvoiceWeekDraft: () => { atomic++; return "ZZTEST-wrong-store"; },
    replaceTradeInvoiceDraftKeepingPrior: () => { legacy++; return "ZZTEST-legacy"; },
  });
  assertEquals(saved, "ZZTEST-legacy");
  assertEquals(atomic, 0);
  assertEquals(legacy, 1);
});
