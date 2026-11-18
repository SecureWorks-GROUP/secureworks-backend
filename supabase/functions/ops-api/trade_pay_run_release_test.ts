// deno-lint-ignore-file no-explicit-any no-import-prefix
// cl-payrun-escape: an approver takes one invoice back out of an approved
// pay run, to review. No network, no database: every value and id is made up.
import "./trade_app_visibility_rules_test_env.ts";
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PAY_RUN_RELEASE_REFUSALS,
  type PayRunPushDeps,
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
    release: (_runId, _invoiceId, actor, _reason) => {
      if (db.row.released_at) {
        return Promise.resolve({ already_released: true, run_status: db.run.status });
      }
      if (db.invoice.xero_bill_id) {
        const r = PAY_RUN_RELEASE_REFUSALS.pay_run_invoice_billed;
        return Promise.reject(new TradePayRunError(r.code, r.words, r.status));
      }
      if (db.invoice.status === "approved") db.invoice.status = "pending_ops_review";
      db.invoice.pay_run_id = null;
      db.row.verdict = "stopped";
      db.row.released_at = "2026-11-24T02:00:00Z";
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

Deno.test("release: only a true xero_checked says Xero was checked", async () => {
  const { releaseDeps } = makeWorld();
  const seen: boolean[] = [];
  const deps: PayRunReleaseDeps = {
    ...releaseDeps,
    release: (r, i, a, reason, checked) => (seen.push(checked), releaseDeps.release(r, i, a, reason, checked)),
  };
  for (const xeroChecked of [undefined, "true", 1, false, true]) {
    await press(deps, { xeroChecked });
  }
  assertEquals(seen, [false, false, false, false, true]);
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

function rpcClient(answer: { data?: unknown; error?: { message: string } | null }) {
  const calls: Array<{ name: string; params: any }> = [];
  return {
    calls,
    client: {
      rpc: (name: string, params: any) => {
        calls.push({ name, params });
        return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null });
      },
      from: () => {
        throw new Error("ZZTEST the release reads nothing itself");
      },
    },
  };
}

Deno.test("release: the database call and every refusal it can raise", async () => {
  const ok = rpcClient({ data: { already_released: false, run_status: "approved" } });
  const deps = payRunReleaseDepsFromClient(ok.client, () => Promise.resolve(true));
  assertEquals(await deps.release(RUN, INV, APPROVER, REASON, false), {
    already_released: false,
    run_status: "approved",
  });
  assertEquals(ok.calls, [{
    name: "release_trade_pay_run_invoice",
    params: { p_run_id: RUN, p_invoice_id: INV, p_actor: APPROVER, p_reason: REASON, p_xero_checked: false },
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
      payRunReleaseDepsFromClient(c.client, () => Promise.resolve(true)).release(RUN, INV, APPROVER, REASON, false),
      code,
      status,
    );
  }
  const empty = rpcClient({ data: null });
  await refused(
    payRunReleaseDepsFromClient(empty.client, () => Promise.resolve(true)).release(RUN, INV, APPROVER, REASON, false),
    "pay_run_write_failed",
    503,
  );
});

Deno.test("release: the door is staff only at the front door, POST only, a signed-in approver, no Xero", () => {
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
  assert(body.includes("xeroChecked: body?.xero_checked"));
  assert(body.includes("payRunReleaseDepsFromClient(client, () => readFlag(client, PAY_RUN_SWITCH))"));
  for (const banned of ["pushTradeInvoiceToXeroAction", "xeroPost", "getXero", "Xero(", "body?.actor", "body?.user_id"]) {
    assertEquals(body.includes(banned), false, banned);
  }
});
