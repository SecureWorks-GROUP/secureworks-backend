import { commissionCapCodeFromDbError } from "./job_commission.ts";
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { officeSentBackNote } from "./trade_invoice_office_note.ts";

// Drive the actual action, including its preflight and compare-and-set outcome.
async function action(client: any, invoiceId = "ZZTEST-invoice") {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const start = source.indexOf("      case 'reject_trade_invoice': {");
  const end = source.indexOf("      case 'push_trade_invoice_to_xero':", start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("ctx", "with (ctx) {" + source.slice(start, end)
    .replace("case 'reject_trade_invoice':", "") + "}");
  class ApiError extends Error {
    constructor(message: string, public status: number) { super(message); }
  }
  return await run({ client, body: { invoice_id: invoiceId, note: "ZZTEST correct the week", actor: "ZZTEST-spoof" },
    // A status, when the door gives one, rides along so a test can read it.
    json: (value: any, status?: number) => (status === undefined ? value : { ...value, status }),
    ApiError, officeSentBackNote,
    authUser: { id: "ZZTEST-office" },
    reviewActorLabel: (user: any) => `user:${user.id}`,
    tradeInvoiceHasExternalXeroIdentity: (i: any) => Boolean(i.xero_bill_id || i.xero_pushed_at),
    rejectTradeInvoiceStorage: async (...args: [any, string, string, string]) =>
      (await import("./trade_invoice_rejection.ts")).rejectTradeInvoiceStorage(...args),
    payRunHeldRefusalFor: (await import("./trade_pay_run_hold.ts")).payRunHeldRefusalFor,
    PAY_RUN_HELD_CODE: (await import("./trade_pay_run_hold.ts")).PAY_RUN_HELD_CODE,
  });
}

function store(
  options: {
    enabled?: boolean;
    flagError?: boolean;
    rpcError?: boolean;
    raced?: boolean;
    xero?: boolean;
    // A pay run approves the invoice after the door's read: the write refuses
    // it and the row now carries the run's id.
    runApprovedMeanwhile?: boolean;
    rereadError?: boolean;
  } = {},
) {
  const invoice: any = { id: "ZZTEST-invoice", status: "pending_ops_review", xero_bill_id: options.xero ? "ZZTEST-bill" : null, xero_pushed_at: null, pay_run_id: null };
  const claims = [{ trade_invoice_id: invoice.id, expense_receipt_id: "ZZTEST-receipt" }];
  let rpcCalls = 0;
  let invoiceReads = 0;
  const runApproves = () => {
    if (options.runApprovedMeanwhile) invoice.pay_run_id = "ZZTEST-run";
  };
  return { invoice, claims, get rpcCalls() { return rpcCalls; }, get invoiceReads() { return invoiceReads; },
    client: {
      from(table: string) {
        let changes: any = null;
        return {
          select() { return this; }, eq() { return this; }, is() { return this; },
          update(value: unknown) { changes = value; return this; },
          maybeSingle() {
            if (table === "feature_flags") return Promise.resolve({ data: options.flagError ? null : { enabled: options.enabled === true }, error: options.flagError ? { message: "ZZTEST unreadable" } : null });
            if (changes) {
              if (options.raced || options.runApprovedMeanwhile) {
                runApproves();
                return Promise.resolve({ data: null });
              }
              Object.assign(invoice, changes);
            }
            invoiceReads++;
            if (options.rereadError && invoiceReads > 1) return Promise.resolve({ data: null, error: { message: "ZZTEST unreadable" } });
            return Promise.resolve({ data: { ...invoice } });
          },
        };
      },
      rpc(name: string, args: any) {
        rpcCalls++;
        assertEquals(name, "reject_trade_invoice_v1");
        assertEquals(args, { p_invoice_id: invoice.id, p_note: officeSentBackNote("ZZTEST correct the week"), p_actor: "user:ZZTEST-office" });
        if (options.rpcError) return Promise.resolve({ data: null, error: { message: "ZZTEST release failed" } });
        if (options.raced || options.runApprovedMeanwhile) {
          runApproves();
          return Promise.resolve({ data: null });
        }
        invoice.status = "ops-reject";
        invoice.query_note = args.p_note;
        claims.splice(0);
        return Promise.resolve({ data: invoice.id });
      },
    },
  };
}

Deno.test("FU17 real reject action frees its receipt for a corrected invoice", async () => {
  const s = store({ enabled: true });
  assertEquals(await action(s.client), { success: true, invoice_id: s.invoice.id, status: "ops-reject" });
  assertEquals(s.claims, []);
  assertEquals(s.invoice.query_note, officeSentBackNote("ZZTEST correct the week"));
  assertEquals(s.rpcCalls, 1);
});
Deno.test("FU17 switch off or unreadable preserves main's rejection write and receipt", async () => {
  for (const options of [{ enabled: false }, { flagError: true }]) {
    const s = store(options);
    assertEquals(await action(s.client), { success: true, invoice_id: s.invoice.id, status: "ops-reject" });
    assertEquals(s.invoice.status, "ops-reject");
    assertEquals(s.claims.length, 1);
    assertEquals(s.rpcCalls, 0);
  }
});
Deno.test("FU17 failed receipt release cannot report rejection success", async () => {
  const s = store({ enabled: true, rpcError: true });
  await assertRejects(() => action(s.client), Error, "ZZTEST release failed");
  assertEquals(s.invoice.status, "pending_ops_review");
  assertEquals(s.claims.length, 1);
});
Deno.test("FU17 concurrent Xero identity refuses rejection and retains receipt", async () => {
  const s = store({ enabled: true, raced: true });
  await assertRejects(() => action(s.client), Error, "Cannot reject an invoice while its Xero identity is being recorded");
  assertEquals(s.invoice.status, "pending_ops_review");
  assertEquals(s.claims.length, 1);
});
Deno.test("FU17 existing Xero identity is refused before the release operation", async () => {
  const s = store({ enabled: true, xero: true });
  await assertRejects(() => action(s.client), Error, "Cannot reject an invoice already in Xero/paid");
  assertEquals(s.rpcCalls, 0);
  assertEquals(s.claims.length, 1);
});

Deno.test("FU17 hourly submit passes labour, group share and receipt to the same atomic save", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  // P1-05.8 names the standard save saveStandard (the held-line send calls it
  // too); with the switch off the door awaits it once, as before.
  const start = source.indexOf("            const saveStandard = () => retryReimbursementClaims(client, reimbursements,");
  const end = source.indexOf("            // ── P1-05.8: save the pay, then the office's part", start);
  assert(start > 0 && end > start);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const submit = new AsyncFunction("ctx", "with (ctx) {" + source.slice(start, end)
    .replace(/: (any|number)\b/g, "") + "return await saveStandard(); }");
  const labour = { line_type: "labour", job_id: "ZZTEST-hourly", line_total_ex: 560 };
  const group = { line_type: "group share", job_id: "ZZTEST-group", group_share_id: "ZZTEST-share", line_total_ex: 280 };
  const receipt = { line_type: "reimbursement", expense_receipt_id: "ZZTEST-receipt", line_total_ex: 80 };
  const header = { status: "pending_acknowledgment", gross_earned: 920, super_basis: "inclusive_12_112_v1", super_base_ex: 840, super_amount: 90, net_pay: 830 };
  let saves = 0;
  const id = await submit({ client: {}, reimbursements: { lines: [receipt], skipped_items: [] },
    week_start: "2026-11-16", priorDraftId: null, weeklyInvoice: null,
    invoicePayload: header, tradeUser: { orgId: "ZZTEST-org" }, lineItems: [labour], extraLineItems: [group, receipt],
    // PR 1640 declares lineJobOrder one line above the slice read here;
    // PR 1426's catch reads the commission cap code. Both come from index.ts.
    lineJobOrder: { jobOrder: false }, commissionCapCodeFromDbError,
    retryReimbursementClaims: (_c: unknown, _r: unknown, persist: () => Promise<string>) => persist(),
    persistWithFreeNumber: async (persist: () => Promise<string>) => await persist(),
    toTradeInvoiceLineRow: (_id: string, row: unknown) => row,
    _persistTradeInvoiceWeekDraft: (_c: unknown, h: unknown, lines: unknown[], prior: unknown) => {
      saves++;
      assertEquals(h, { ...header, org_id: "ZZTEST-org" });
      assertEquals(lines, [labour, group, receipt]);
      assertEquals(prior, null);
      return "ZZTEST-saved";
    },
    replaceTradeInvoiceDraftKeepingPrior: () => { throw new Error("Mixed submit bypassed the atomic save"); },
  });
  assertEquals(id, "ZZTEST-saved");
  assertEquals(saves, 1);
});

Deno.test("cx-reimb-rest rejection passes the office session actor despite a request actor", async () => {
  const s = store({ enabled: true });
  await action(s.client);
  // The RPC fake asserts p_actor is user:ZZTEST-office, never body.actor.
  assertEquals(s.rpcCalls, 1);
});

// 1695 (director 12:01): the database reject refuses an invoice a pay run
// approved after the door's read; the office gets the pay run's own answer.
Deno.test("pay run: a run that approves the invoice mid-reject gets 409 invoice_in_pay_run, nothing changed", async () => {
  const s = store({ enabled: true, runApprovedMeanwhile: true });
  const out = await action(s.client);
  const { PAY_RUN_HELD_CODE, PAY_RUN_HELD_WORDS } = await import("./trade_pay_run_hold.ts");
  assertEquals(out, { ok: false, code: PAY_RUN_HELD_CODE, error: PAY_RUN_HELD_WORDS, status: 409 });
  assertEquals([s.invoice.status, s.claims.length, s.rpcCalls, s.invoiceReads], ["pending_ops_review", 1, 1, 2]);
});

Deno.test("pay run: an empty reject answer with no run on the row keeps the existing 409, a failed re-read too", async () => {
  for (const options of [{ raced: true }, { runApprovedMeanwhile: true, rereadError: true }]) {
    const s = store({ enabled: true, ...options });
    await assertRejects(() => action(s.client), Error, "Cannot reject an invoice while its Xero identity is being recorded");
    assertEquals([s.invoice.status, s.claims.length, s.invoiceReads], ["pending_ops_review", 1, 2]);
  }
});

Deno.test("MUST NOT CHANGE: the plain update used while reimbursements are off answers as before, with no re-read", async () => {
  for (const options of [{ enabled: false }, { flagError: true }]) {
    const s = store({ ...options, runApprovedMeanwhile: true });
    await assertRejects(() => action(s.client), Error, "Cannot reject an invoice while its Xero identity is being recorded");
    assertEquals([s.invoice.status, s.claims.length, s.rpcCalls, s.invoiceReads], ["pending_ops_review", 1, 0, 1]);
  }
});

Deno.test("pay run: a run already on the row is refused before any write, as before", async () => {
  const s = store({ enabled: true });
  s.invoice.pay_run_id = "ZZTEST-run";
  const out = await action(s.client);
  assertEquals([out.code, out.status, s.rpcCalls, s.invoiceReads], ["invoice_in_pay_run", 409, 0, 1]);
});

