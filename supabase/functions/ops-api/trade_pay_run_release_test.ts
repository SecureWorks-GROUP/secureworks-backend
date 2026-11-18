// deno-lint-ignore-file no-explicit-any no-import-prefix
// cl-payrun-escape: an approver takes one invoice back out of an approved
// pay run, to review. cl-payrun-xero-lookup: on a lapsed push claim the server
// searches Xero itself. No network, no database, no Xero: every value and id
// is made up and the Xero search is a stub.
import "./trade_app_visibility_rules_test_env.ts";
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PAY_RUN_RELEASE_REFUSALS,
  type PayRunPushDeps,
  type PayRunReleaseXeroCheck,
  RELEASED_FROM_RUN_WORDS,
  type PayRunReleaseDeps,
  payRunEligible,
  payRunPlacement,
  payRunReleaseDepsFromClient,
  type PayRunRunRow,
  pushPayRunInvoice,
  releasePayRunInvoice,
  TradePayRunError,
} from "./trade_pay_run.ts";
import { payRunHeldRefusalFor } from "./trade_pay_run_hold.ts";
import {
  _opsApiActionNeedsStaffRole,
  AGENT_READ_ALLOWED_ACTIONS,
  LEAD_INSTALLER_READ_ACTIONS,
} from "./index.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-000000000002";
const APPROVER = "0a210000-0000-4000-8000-000000000001";
const STAFF = "0a210000-0000-4000-8000-000000000009";
const RUN = "0b310000-0000-4000-8000-000000000001";
const INV = "0c410000-0000-4000-8000-00000000000a";
const REASON = "ZZTEST the repayment changed at the push";

function baseRun(extra: Partial<PayRunRunRow> = {}): PayRunRunRow {
  return {
    id: RUN,
    org_id: ORG,
    week_start: "2026-11-16",
    status: "approved",
    super_marked_paid_at: null,
    super_marked_paid_by: null,
    ...extra,
  };
}

/**
 * One made-up database: the run row, the invoice and its run row, shared by
 * the run's push and the release, so a test can walk the whole loop.
 */
function makeWorld() {
  const db = {
    run: baseRun(),
    row: {
      verdict: "clean",
      pays: 940,
      pushed_at: null as string | null,
      xero_bill_id: null as string | null,
      released_at: null as string | null,
      // A push claim set and never given back, older than its lease.
      claim_lapsed: false,
    },
    invoice: {
      id: INV,
      pay_run_id: RUN as string | null,
      status: "pending_ops_review",
      invoice_kind: "standard",
      week_start: "2026-11-16",
      submitted_at: "2026-11-20T01:00:00Z",
      xero_bill_id: null as string | null,
      net_pay: 940,
      gst: 0,
      gst_on: false,
      recurring_deduction_amount: null as number | null,
    },
    pushes: 0,
    searches: [] as string[],
    bills: [] as Array<Record<string, unknown>>,
    checks: [] as Array<PayRunReleaseXeroCheck | null>,
    recorded: [] as Array<{ runId: string; invoiceId: string; actor: string; found: any }>,
    invoiceNumber: "ZZTEST-INV-7" as string | null,
    logs: [] as Record<string, unknown>[],
  };
  const pushDeps: PayRunPushDeps = {
    switchOn: () => Promise.resolve(true),
    approvers: () => Promise.resolve([APPROVER]),
    runById: () => Promise.resolve({ ...db.run }),
    runInvoice: () =>
      Promise.resolve({ ...db.row }),
    invoiceForPush: () => Promise.resolve({ ...db.invoice }),
    readyForRunPush: () => {
      if (
        db.invoice.pay_run_id !== RUN ||
        !["pending_ops_review", "queried"].includes(db.invoice.status)
      ) return Promise.resolve(false);
      // The repayment save lock re-checks the deduction at this move.
      db.invoice.status = "approved";
      db.invoice.recurring_deduction_amount = 40;
      return Promise.resolve(true);
    },
    claimPush: () =>
      Promise.resolve(db.row.verdict === "clean" ? "2026-11-24T01:00:00Z" : null),
    releasePush: () => Promise.resolve(),
    push: () => {
      db.pushes += 1;
      return Promise.resolve({ xero_bill_id: "ZZTEST-BILL" });
    },
    markPushed: () => Promise.resolve(),
    cleanUnpushed: () => Promise.resolve(0),
    markRunPushed: () => Promise.resolve(),
    markSuperPaid: () =>
      Promise.resolve({ super_marked_paid_at: "x", super_marked_paid_by: APPROVER }),
    log: (line) => db.logs.push(line),
  };
  // The database function's rules (release_trade_pay_run_invoice), on the
  // same rows; the contract proves the real one.
  const releaseDeps: PayRunReleaseDeps = {
    switchOn: pushDeps.switchOn,
    approvers: pushDeps.approvers,
    runById: pushDeps.runById,
    log: pushDeps.log,
    now: () => "2026-11-24T02:00:00.000Z",
    invoiceNumber: () => Promise.resolve(db.invoiceNumber),
    recordFound: (runId, invoiceId, actor, found) => {
      db.recorded.push({ runId, invoiceId, actor, found });
      return Promise.resolve();
    },
    searchXero: (number) => {
      db.searches.push(number);
      return Promise.resolve(db.bills);
    },
    release: (_runId, _invoiceId, actor, _reason, check) => {
      db.checks.push(check);
      if (db.row.released_at) {
        return Promise.resolve({ already_released: true, run_status: db.run.status });
      }
      if (db.row.claim_lapsed && check?.source !== "ops_api_xero_lookup") {
        const r = PAY_RUN_RELEASE_REFUSALS.pay_run_push_claim_lapsed;
        return Promise.reject(new TradePayRunError(r.code, r.words, r.status));
      }
      if (db.invoice.xero_bill_id) {
        const r = PAY_RUN_RELEASE_REFUSALS.pay_run_invoice_billed;
        return Promise.reject(new TradePayRunError(r.code, r.words, r.status));
      }
      if (db.invoice.status === "approved") db.invoice.status = "pending_ops_review";
      db.invoice.pay_run_id = null;
      db.row.verdict = "stopped";
      db.row.released_at = "2026-11-24T02:00:00Z";
      db.row.claim_lapsed = false;
      db.run.status = "pushed";
      return Promise.resolve({
        already_released: false,
        released_by: actor,
        status: db.invoice.status,
        run_status: db.run.status,
      });
    },
  };
  return { db, pushDeps, releaseDeps };
}

function press(deps: PayRunReleaseDeps, extra: Record<string, unknown> = {}) {
  return releasePayRunInvoice(deps, {
    orgId: ORG,
    actorUserId: APPROVER,
    runId: RUN,
    invoiceId: INV,
    reason: REASON,
    ...extra,
  });
}

async function refused(p: Promise<unknown>, code: string, status: number) {
  const e = await assertRejects(() => p, TradePayRunError);
  assertEquals((e as TradePayRunError).code, code);
  assertEquals((e as TradePayRunError).status, status);
}

Deno.test("release: the stuck invoice goes back to review and a later run can take it (the whole loop)", async () => {
  const { db, pushDeps, releaseDeps } = makeWorld();
  const pushPress = () =>
    pushPayRunInvoice(pushDeps, {
      orgId: ORG,
      actorUserId: APPROVER,
      runId: RUN,
      invoiceId: INV,
    });
  // The push moves it to approved; the repayment changed what it pays.
  await refused(pushPress(), "pay_run_pays_changed", 409);
  assertEquals(db.invoice.status, "approved");
  assertEquals(db.pushes, 0);
  // Stuck: every old door refuses it, and the push refuses it again.
  assertEquals(payRunHeldRefusalFor(db.invoice)?.code, "invoice_in_pay_run");
  await refused(pushPress(), "pay_run_pays_changed", 409);
  assertEquals(payRunEligible(db.invoice as any), false);

  const out = await press(releaseDeps);
  assertEquals(out.ok, true);
  assertEquals(out.already_released, false);
  assertEquals(db.invoice.status, "pending_ops_review");
  assertEquals(db.invoice.pay_run_id, null);
  // Free again: the old doors (office review) take it, the next run lists it.
  assertEquals(payRunHeldRefusalFor(db.invoice), null);
  assertEquals(payRunEligible(db.invoice as any), true);
  assertEquals(payRunPlacement(db.invoice as any, "2026-11-23"), "in_run");
  // The old run's push never sends it.
  await refused(pushPress(), "invoice_not_clean", 409);
  assertEquals(db.pushes, 0);
  // A second press says so and changes nothing.
  const again = await press(releaseDeps);
  assertEquals(again.already_released, true);
});

Deno.test("release: switch off, server key, someone off the list, another org: refused before the release", async () => {
  let calls = 0;
  const { releaseDeps } = makeWorld();
  const deps: PayRunReleaseDeps = {
    ...releaseDeps,
    release: (...a) => (calls += 1, releaseDeps.release(...a)),
  };
  await refused(press({ ...deps, switchOn: () => Promise.resolve(false) }), "pay_run_switch_off", 409);
  await refused(press(deps, { actorUserId: null }), "pay_run_named_person_required", 403);
  await refused(press(deps, { actorUserId: STAFF }), "pay_run_not_approver", 403);
  await refused(press(deps, { orgId: OTHER_ORG }), "pay_run_not_found", 404);
  await refused(press(deps, { runId: "not-a-run" }), "pay_run_id_invalid", 400);
  await refused(press(deps, { invoiceId: "not-an-invoice" }), "pay_run_invoice_invalid", 400);
  for (const reason of [undefined, "", "  abc ", "z".repeat(501), 12345]) {
    await refused(press(deps, { reason }), "pay_run_release_reason_required", 400);
  }
  assertEquals(calls, 0);
});

Deno.test("release: no lapsed claim, no Xero search, and a check sent in the request is never read", async () => {
  const { db, releaseDeps } = makeWorld();
  const out = await press(releaseDeps, {
    xeroCheck: { in_xero: false, checked_by: APPROVER, checked_at: "2026-11-24T02:00:00Z" },
    xero_check: { in_xero: false },
  });
  assertEquals(out.already_released, false);
  assertEquals(db.searches, []);
  assertEquals(db.checks, [null]);
});

Deno.test("release: a lapsed claim, the server searches Xero, finds no bill and sends what it found", async () => {
  const { db, releaseDeps } = makeWorld();
  db.row.claim_lapsed = true;
  const out = await press(releaseDeps);
  assertEquals(out.already_released, false);
  assertEquals(db.searches, ["ZZTEST-INV-7"]);
  assertEquals(db.checks, [null, {
    in_xero: false,
    checked_by: APPROVER,
    checked_at: "2026-11-24T02:00:00.000Z",
    source: "ops_api_xero_lookup",
    searched_number: "ZZTEST-INV-7",
    bills_found: 0,
  }]);
  assertEquals(db.invoice.status, "pending_ops_review");
  assert(JSON.stringify(db.logs).includes('"xero_searched":true'));
});

Deno.test("release: a lapsed claim and a bill in Xero: refused, nothing released, the bill kept on the run row", async () => {
  const { db, releaseDeps } = makeWorld();
  db.row.claim_lapsed = true;
  db.bills = [{
    InvoiceID: "ZZTEST-XERO-BILL-1",
    InvoiceNumber: "ZZTEST-INV-7",
    Status: "DRAFT",
    Reference: "ZZTEST a trade name",
    Total: 112,
  }];
  await refused(press(releaseDeps), "pay_run_xero_check_found_in_xero", 409);
  assertEquals(db.checks, [null]);
  assertEquals(db.row.released_at, null);
  assertEquals(db.invoice.pay_run_id, RUN);
  // Who, when, the number searched, the bill (id, number, status only), the count.
  assertEquals(db.recorded, [{
    runId: RUN,
    invoiceId: INV,
    actor: APPROVER,
    found: {
      checked_by: APPROVER,
      checked_at: "2026-11-24T02:00:00.000Z",
      source: "ops_api_xero_lookup",
      searched_number: "ZZTEST-INV-7",
      bills_found: 1,
      bills: [{ xero_bill_id: "ZZTEST-XERO-BILL-1", number: "ZZTEST-INV-7", status: "DRAFT" }],
    },
  }]);
  const logged = JSON.stringify(db.logs);
  assert(logged.includes("ZZTEST-XERO-BILL-1"));
  assert(logged.includes('"recorded":true'));
  assertEquals(logged.includes("trade name"), false);
});

Deno.test("release: a found bill that cannot be kept still refuses, and the log says it was not kept", async () => {
  const { db, releaseDeps } = makeWorld();
  db.row.claim_lapsed = true;
  db.bills = [{ InvoiceID: "ZZTEST-XERO-BILL-1" }];
  await refused(
    press({ ...releaseDeps, recordFound: () => Promise.reject(new Error("ZZTEST write failed")) }),
    "pay_run_xero_check_found_in_xero",
    409,
  );
  assertEquals(db.checks, [null]);
  assertEquals(db.row.released_at, null);
  assert(JSON.stringify(db.logs).includes('"recorded":false'));
});

Deno.test("release: a lapsed claim and Xero cannot be searched, or no number to search: refused, nothing released", async () => {
  const failing = makeWorld();
  failing.db.row.claim_lapsed = true;
  await refused(
    press({ ...failing.releaseDeps, searchXero: () => Promise.reject(new Error("ZZTEST Xero down")) }),
    "pay_run_xero_lookup_failed",
    503,
  );
  await refused(
    press({ ...failing.releaseDeps, searchXero: () => Promise.resolve(null as any) }),
    "pay_run_xero_lookup_failed",
    503,
  );
  await refused(
    press({ ...failing.releaseDeps, invoiceNumber: () => Promise.reject(new Error("ZZTEST read failed")) }),
    "pay_run_xero_lookup_failed",
    503,
  );
  assertEquals(failing.db.row.released_at, null);
  const unnumbered = makeWorld();
  unnumbered.db.row.claim_lapsed = true;
  for (const n of [null, "", "   "]) {
    unnumbered.db.invoiceNumber = n;
    await refused(press(unnumbered.releaseDeps), "pay_run_xero_lookup_no_number", 409);
  }
  assertEquals(unnumbered.db.searches, []);
  assertEquals(unnumbered.db.row.released_at, null);
});

Deno.test("release: the answer says the invoice went back to review, and a queried invoice stays queried", async () => {
  const { db, releaseDeps } = makeWorld();
  db.invoice.status = "queried";
  const out = await press(releaseDeps);
  assertEquals(out.status, "queried");
  assertEquals(out.words, RELEASED_FROM_RUN_WORDS);
  assert(RELEASED_FROM_RUN_WORDS.includes("went back to the office for review"));
  assert(RELEASED_FROM_RUN_WORDS.includes("a queried invoice stays queried"));
  // A second press says already released, with no new words.
  assertEquals((await press(releaseDeps)).words, undefined);
});

Deno.test("release: the reason is trimmed, passed to the database and never logged", async () => {
  const { db, releaseDeps } = makeWorld();
  let sent = "";
  const deps: PayRunReleaseDeps = {
    ...releaseDeps,
    release: (r, i, a, reason, checked) => (sent = reason, releaseDeps.release(r, i, a, reason, checked)),
  };
  await press(deps, { reason: `  ${REASON}  ` });
  assertEquals(sent, REASON);
  const logged = JSON.stringify(db.logs);
  assert(logged.includes("release_pay_run_invoice"));
  assertEquals(logged.includes("repayment changed"), false);
  // A refusal logs its code and ids only.
  const failing = makeWorld();
  failing.db.invoice.xero_bill_id = "ZZTEST-BILL";
  await refused(press(failing.releaseDeps), "pay_run_invoice_billed", 409);
  assertEquals(JSON.stringify(failing.db.logs).includes("repayment changed"), false);
  assert(JSON.stringify(failing.db.logs).includes("pay_run_invoice_billed"));
});

function rpcClient(answer: {
  data?: unknown;
  error?: { message: string } | null;
  invoice?: { data: unknown; error: unknown };
}) {
  const calls: Array<{ name: string; params: any }> = [];
  return {
    calls,
    client: {
      rpc: (name: string, params: any) => {
        calls.push({ name, params });
        return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null });
      },
      from: (table: string) => {
        calls.push({ name: `from:${table}`, params: null });
        const q: any = {
          select: () => q,
          eq: (col: string, val: unknown) => (calls.push({ name: "eq", params: [col, val] }), q),
          maybeSingle: () => Promise.resolve(answer.invoice ?? { data: null, error: null }),
        };
        return q;
      },
    },
  };
}

const noSearch = () => Promise.reject(new Error("ZZTEST no Xero in this test"));

Deno.test("release: the found bill is kept through the database, and anything but recorded throws", async () => {
  const found = {
    checked_by: APPROVER,
    checked_at: "2026-11-24T02:00:00.000Z",
    source: "ops_api_xero_lookup" as const,
    searched_number: "ZZTEST-INV-7",
    bills_found: 1,
    bills: [{ xero_bill_id: "ZZTEST-XERO-BILL-1", number: null, status: null }],
  };
  const ok = rpcClient({ data: { recorded: true } });
  await payRunReleaseDepsFromClient(ok.client, () => Promise.resolve(true), noSearch)
    .recordFound(RUN, INV, APPROVER, found);
  assertEquals(ok.calls, [{
    name: "record_trade_pay_run_xero_found",
    params: { p_run_id: RUN, p_invoice_id: INV, p_actor: APPROVER, p_found: found },
  }]);
  for (const answer of [{ error: { message: "pay_run_xero_found_invalid" } }, { data: null }, { data: { recorded: false } }]) {
    const c = rpcClient(answer);
    await assertRejects(() =>
      payRunReleaseDepsFromClient(c.client, () => Promise.resolve(true), noSearch)
        .recordFound(RUN, INV, APPROVER, found)
    );
  }
});

Deno.test("release: the invoice number is read by id, and a failed read throws", async () => {
  const ok = rpcClient({ invoice: { data: { invoice_number: "ZZTEST-INV-7" }, error: null } });
  const deps = payRunReleaseDepsFromClient(ok.client, () => Promise.resolve(true), noSearch);
  assertEquals(await deps.invoiceNumber(INV), "ZZTEST-INV-7");
  assertEquals(ok.calls, [{ name: "from:trade_invoices", params: null }, { name: "eq", params: ["id", INV] }]);
  const missing = rpcClient({ invoice: { data: null, error: null } });
  assertEquals(await payRunReleaseDepsFromClient(missing.client, () => Promise.resolve(true), noSearch).invoiceNumber(INV), null);
  const broken = rpcClient({ invoice: { data: null, error: { message: "ZZTEST" } } });
  await assertRejects(() => payRunReleaseDepsFromClient(broken.client, () => Promise.resolve(true), noSearch).invoiceNumber(INV));
});

Deno.test("release: the database call and every refusal it can raise", async () => {
  const ok = rpcClient({ data: { already_released: false, run_status: "approved" } });
  const deps = payRunReleaseDepsFromClient(ok.client, () => Promise.resolve(true), noSearch);
  assertEquals(await deps.release(RUN, INV, APPROVER, REASON, null), {
    already_released: false,
    run_status: "approved",
  });
  assertEquals(ok.calls, [{
    name: "release_trade_pay_run_invoice",
    params: { p_run_id: RUN, p_invoice_id: INV, p_actor: APPROVER, p_reason: REASON, p_xero_check: null },
  }]);
  const cases: Array<[string, string, number]> = [
    ["pay_run_not_approver", "pay_run_not_approver", 403],
    ["pay_run_not_found", "pay_run_not_found", 404],
    ["pay_run_release_reason_required", "pay_run_release_reason_required", 400],
    ["pay_run_release_invalid", "pay_run_release_invalid", 400],
    ["invoice_not_in_run", "invoice_not_in_run", 409],
    ["invoice_not_clean", "invoice_not_clean", 409],
    ["pay_run_invoice_pushed", "pay_run_invoice_pushed", 409],
    ["pay_run_push_in_progress", "pay_run_push_in_progress", 409],
    ["pay_run_push_claim_lapsed", "pay_run_push_claim_lapsed", 409],
    // Director ruling 18 Nov: the three conditions on a lapsed claim's check.
    ["pay_run_xero_check_found_in_xero", "pay_run_xero_check_found_in_xero", 409],
    ["pay_run_xero_check_unnamed", "pay_run_xero_check_unnamed", 400],
    ["pay_run_xero_check_not_approver", "pay_run_xero_check_not_approver", 403],
    ["pay_run_xero_check_stale", "pay_run_xero_check_stale", 409],
    ["pay_run_xero_check_invalid", "pay_run_xero_check_invalid", 400],
    // cl-payrun-xero-lookup: a check that is not this server's own search.
    ["pay_run_xero_check_not_server", "pay_run_xero_check_not_server", 409],
    ["pay_run_invoice_billed", "pay_run_invoice_billed", 409],
    ["pay_run_invoice_status", "pay_run_invoice_status", 409],
    // The group release guard on trade_invoices (20261030133000).
    ["group_released", "pay_run_release_group_released", 409],
    // Anything else: nothing changed, never read as done.
    ["deadlock detected", "pay_run_write_failed", 503],
  ];
  for (const [message, code, status] of cases) {
    const c = rpcClient({ error: { message } });
    await refused(
      payRunReleaseDepsFromClient(c.client, () => Promise.resolve(true), noSearch).release(RUN, INV, APPROVER, REASON, null),
      code,
      status,
    );
  }
  const empty = rpcClient({ data: null });
  await refused(
    payRunReleaseDepsFromClient(empty.client, () => Promise.resolve(true), noSearch).release(RUN, INV, APPROVER, REASON, null),
    "pay_run_write_failed",
    503,
  );
});

Deno.test("release: the door is staff only at the front door, POST only, a signed-in approver, Xero read only", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  const routine = src.slice(src.indexOf("const ROUTINE_ALLOWED_ACTIONS = new Set(["));
  const action = "release_pay_run_invoice";
  const url = new URL(`https://example.invalid/ops-api?action=${action}`);
  assertEquals(_opsApiActionNeedsStaffRole(url), true);
  assertEquals(AGENT_READ_ALLOWED_ACTIONS.has(action), false);
  assertEquals(LEAD_INSTALLER_READ_ACTIONS.has(action), false);
  assertEquals(routine.slice(0, routine.indexOf("])")).includes(`'${action}'`), false);
  const at = src.indexOf(`case '${action}': {`);
  assert(at > 0);
  const body = src.slice(at, src.indexOf("case 'pay_run': {", at));
  assert(body.includes("req.method !== 'POST'"));
  assert(body.includes("requestActor.source === 'jwt'"));
  assert(body.includes("releasePayRunInvoice("));
  assert(body.includes("payRunReleaseDepsFromClient("));
  assert(body.includes("() => readFlag(client, PAY_RUN_SWITCH)"));
  // The one Xero call: the stuck-invoice release's live-bill search.
  assert(body.includes("findLiveTradeBillsByNumber(xeroGet, auth, invoiceNumber)"));
  for (const banned of ["pushTradeInvoiceToXeroAction", "xeroPost", "Xero(", "xero_check", "xeroCheck", "body?.actor", "body?.user_id"]) {
    assertEquals(body.includes(banned), false, banned);
  }
});
