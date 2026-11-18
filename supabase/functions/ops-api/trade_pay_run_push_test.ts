// deno-lint-ignore-file no-explicit-any no-import-prefix
// P1-10.5: push an approved run's invoices and mark its super paid.
// The Xero push is a stub here: no network. Every value and id is made up.
import "./trade_app_visibility_rules_test_env.ts";
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  markPayRunSuperPaid,
  type PayBackReceipt,
  type PayRunPushDeps,
  payRunPushDepsFromClient,
  type PayRunRunRow,
  pushPayRunInvoice,
  TradePayRunError,
} from "./trade_pay_run.ts";
import {
  _opsApiActionNeedsStaffRole,
  AGENT_READ_ALLOWED_ACTIONS,
  LEAD_INSTALLER_READ_ACTIONS,
} from "./index.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-000000000002";
const APPROVER = "0a200000-0000-4000-8000-000000000001";
const STAFF = "0a200000-0000-4000-8000-000000000009";
const RUN = "0b300000-0000-4000-8000-000000000001";
const INV_A = "0c400000-0000-4000-8000-00000000000a";
const INV_B = "0c400000-0000-4000-8000-00000000000b";
const INV_STOPPED = "0c400000-0000-4000-8000-00000000000c";
const INV_OUT = "0c400000-0000-4000-8000-00000000000d";

type Row = {
  pays?: number;
  verdict: string;
  pushed_at: string | null;
  xero_bill_id: string | null;
};

type World = {
  switchOn?: boolean;
  approvers?: string[] | "fail";
  run?: PayRunRunRow | null | "fail";
  rows?: Record<string, Row>;
  invoices?: Record<string, Record<string, any> | null>;
  push?: (id: string) => Promise<Record<string, unknown>>;
  /** The run's own status move; false when the invoice changed. */
  ready?: boolean | "fail";
  /** What the status move does to the stored figures (a repayment re-check). */
  afterReady?: Record<string, any>;
  /** The push claim RPC fails. */
  claim?: "fail";
  /** The invoice's pay-back receipts read now, or a failed read. */
  receipts?: Record<string, PayBackReceipt[]> | "fail";
};

function makeDeps(w: World) {
  const calls = {
    push: [] as string[],
    markPushed: [] as string[],
    markRunPushed: 0,
    markSuperPaid: [] as string[],
    reads: 0,
    ready: [] as string[],
    claims: [] as string[],
    releases: [] as string[],
  };
  // Live push claims by invoice (the database's claim_trade_pay_run_push).
  const claims = new Map<string, string>();
  let tick = 0;
  // Option A: a run's invoice keeps its press status until the run's push.
  const moved = new Set<string>();
  const rows: Record<string, Row> = structuredClone(w.rows ?? {});
  const run = w.run === "fail"
    ? "fail"
    : w.run === undefined
    ? baseRun()
    : w.run;
  const deps: PayRunPushDeps = {
    switchOn: () => Promise.resolve(w.switchOn ?? true),
    approvers: () => {
      if (w.approvers === "fail") {
        return Promise.reject(
          new TradePayRunError("pay_run_unreadable", "x", 503),
        );
      }
      return Promise.resolve(w.approvers ?? [APPROVER]);
    },
    runById: () => {
      calls.reads += 1;
      if (run === "fail") {
        return Promise.reject(
          new TradePayRunError("pay_run_unreadable", "x", 503),
        );
      }
      return Promise.resolve(run ? { ...run } : null);
    },
    runInvoice: (_r, id) =>
      Promise.resolve(rows[id] ? { pays: 940, ...rows[id] } : null),
    invoiceForPush: (id) => {
      const inv = (w.invoices ?? {})[id];
      if (inv !== undefined) return Promise.resolve(inv);
      return Promise.resolve(
        rows[id]
          ? {
            pay_run_id: RUN,
            status: moved.has(id) ? "approved" : "pending_ops_review",
            xero_bill_id: null,
            net_pay: 940,
            gst: 0,
            gst_on: false,
            recurring_deduction_amount: null,
            ...(moved.has(id) ? w.afterReady ?? {} : {}),
          }
          : null,
      );
    },
    payBackReceipts: (id) => {
      if (w.receipts === "fail") {
        return Promise.reject(new TradePayRunError("pay_run_unreadable", "x", 503));
      }
      return Promise.resolve((w.receipts ?? {})[id] ?? []);
    },
    readyForRunPush: (_r, id) => {
      calls.ready.push(id);
      if (w.ready === "fail") {
        return Promise.reject(new TradePayRunError("pay_run_write_failed", "x", 503));
      }
      if (w.ready === false) return Promise.resolve(false);
      moved.add(id);
      return Promise.resolve(true);
    },
    claimPush: (_r, id) => {
      if (w.claim === "fail") {
        return Promise.reject(new TradePayRunError("pay_run_write_failed", "x", 503));
      }
      if (claims.has(id) || rows[id]?.pushed_at) return Promise.resolve(null);
      const stamp = `2026-11-20T00:00:${String(++tick).padStart(2, "0")}Z`;
      claims.set(id, stamp);
      calls.claims.push(id);
      return Promise.resolve(stamp);
    },
    releasePush: (_r, id, stamp) => {
      if (claims.get(id) === stamp) {
        claims.delete(id);
        calls.releases.push(id);
      }
      return Promise.resolve();
    },
    push: (id) => {
      calls.push.push(id);
      return w.push ? w.push(id) : Promise.resolve({
        success: true,
        xero_bill_id: `bill-${id.slice(-1)}`,
        pdf_attached: true,
      });
    },
    markPushed: (_r, id, bill) => {
      calls.markPushed.push(id);
      rows[id] = {
        ...rows[id],
        pushed_at: "2026-11-20T01:00:00Z",
        xero_bill_id: bill,
      };
      return Promise.resolve();
    },
    cleanUnpushed: () =>
      Promise.resolve(
        Object.values(rows).filter((r) => r.verdict === "clean" && !r.pushed_at)
          .length,
      ),
    markRunPushed: () => {
      calls.markRunPushed += 1;
      return Promise.resolve();
    },
    markSuperPaid: (_r, actor) => {
      calls.markSuperPaid.push(actor);
      return Promise.resolve({
        super_marked_paid_at: "2026-11-20T02:00:00Z",
        super_marked_paid_by: actor,
      });
    },
    log: () => {},
  };
  return { deps, calls, rows, claims };
}

function baseRun(over: Partial<PayRunRunRow> = {}): PayRunRunRow {
  return {
    id: RUN,
    org_id: ORG,
    week_start: "2026-11-16",
    status: "approved",
    super_marked_paid_at: null,
    super_marked_paid_by: null,
    ...over,
  };
}

const twoClean = (): Record<string, Row> => ({
  [INV_A]: { verdict: "clean", pushed_at: null, xero_bill_id: null },
  [INV_B]: { verdict: "clean", pushed_at: null, xero_bill_id: null },
  [INV_STOPPED]: { verdict: "stopped", pushed_at: null, xero_bill_id: null },
});

const press = (
  deps: PayRunPushDeps,
  invoiceId: unknown,
  over: Record<string, unknown> = {},
) =>
  pushPayRunInvoice(deps, {
    orgId: ORG,
    actorUserId: APPROVER,
    runId: RUN,
    invoiceId,
    ...over,
  });

async function refused(p: Promise<unknown>, code: string, status: number) {
  const err = await assertRejects(
    () => p as Promise<unknown>,
    TradePayRunError,
  );
  assertEquals([err.code, err.status], [code, status]);
}

// ── Who may press ──────────────────────────────────────────────────────────

Deno.test("push: switch off is 409 before any read or push", async () => {
  const { deps, calls } = makeDeps({ switchOn: false, rows: twoClean() });
  await refused(press(deps, INV_A), "pay_run_switch_off", 409);
  assertEquals([calls.reads, calls.push.length], [0, 0]);
});

Deno.test("push: the server key alone (no signed-in person) is 403", async () => {
  const { deps, calls } = makeDeps({ rows: twoClean() });
  await refused(
    press(deps, INV_A, { actorUserId: null }),
    "pay_run_named_person_required",
    403,
  );
  assertEquals(calls.push.length, 0);
});

Deno.test("push: staff who are not on the approver list are 403 before the run is read", async () => {
  const { deps, calls } = makeDeps({ rows: twoClean() });
  await refused(
    press(deps, INV_A, { actorUserId: STAFF }),
    "pay_run_not_approver",
    403,
  );
  assertEquals([calls.reads, calls.push.length], [0, 0]);
});

Deno.test("push: an unreadable approver list or run refuses 503, never pushes", async () => {
  for (const w of [{ approvers: "fail" as const }, { run: "fail" as const }]) {
    const { deps, calls } = makeDeps({ ...w, rows: twoClean() });
    await refused(press(deps, INV_A), "pay_run_unreadable", 503);
    assertEquals(calls.push.length, 0);
  }
});

Deno.test("push: a run of another company, or no run, is 404", async () => {
  for (const run of [null, baseRun({ org_id: OTHER_ORG })]) {
    const { deps, calls } = makeDeps({ run, rows: twoClean() });
    await refused(press(deps, INV_A), "pay_run_not_found", 404);
    assertEquals(calls.push.length, 0);
  }
});

// ── Which invoice ──────────────────────────────────────────────────────────

Deno.test("push: an invoice not in the run is 409 invoice_not_in_run", async () => {
  const { deps, calls } = makeDeps({ rows: twoClean() });
  await refused(press(deps, INV_OUT), "invoice_not_in_run", 409);
  assertEquals(calls.push.length, 0);
});

Deno.test("push: a stopped invoice is 409 invoice_not_clean", async () => {
  const { deps, calls } = makeDeps({ rows: twoClean() });
  await refused(press(deps, INV_STOPPED), "invoice_not_clean", 409);
  assertEquals(calls.push.length, 0);
});

Deno.test("push: an invoice whose stamp no longer names the run is 409, never pushed", async () => {
  const { deps, calls } = makeDeps({
    rows: twoClean(),
    invoices: { [INV_A]: { pay_run_id: null, status: "approved" } },
  });
  await refused(press(deps, INV_A), "invoice_not_in_run", 409);
  assertEquals(calls.push.length, 0);
});

// ── The push ───────────────────────────────────────────────────────────────

Deno.test("push: a clean invoice is pushed once, recorded with its bill, run stays approved", async () => {
  const { deps, calls } = makeDeps({ rows: twoClean() });
  const out = await press(deps, INV_A);
  assertEquals(calls.push, [INV_A]);
  assertEquals(calls.markPushed, [INV_A]);
  assertEquals(calls.markRunPushed, 0);
  assertEquals([out.xero_bill_id, out.run_status, out.already_pushed], [
    "bill-a",
    "approved",
    false,
  ]);
});

Deno.test("push: the last clean invoice moves the run to pushed (stopped rows do not count)", async () => {
  const { deps, calls } = makeDeps({ rows: twoClean() });
  await press(deps, INV_A);
  const out = await press(deps, INV_B);
  assertEquals(calls.markRunPushed, 1);
  assertEquals(out.run_status, "pushed");
});

Deno.test("push: pressing again on a pushed invoice calls nothing and says so", async () => {
  const rows = twoClean();
  rows[INV_A] = {
    verdict: "clean",
    pushed_at: "2026-11-20T01:00:00Z",
    xero_bill_id: "bill-a",
  };
  const { deps, calls } = makeDeps({ rows });
  const out = await press(deps, INV_A);
  assertEquals(calls.push.length, 0);
  assertEquals([out.already_pushed, out.xero_bill_id], [true, "bill-a"]);
});

Deno.test("push: a Xero failure records nothing, and the press can be repeated once its claim lapses", async () => {
  let fail = true;
  const { deps, calls, claims } = makeDeps({
    rows: twoClean(),
    push: () =>
      fail
        ? Promise.reject(new Error("xero 500"))
        : Promise.resolve({ success: true, xero_bill_id: "bill-a" }),
  });
  await assertRejects(() => press(deps, INV_A), Error, "xero 500");
  assertEquals([calls.markPushed.length, calls.markRunPushed], [0, 0]);
  fail = false;
  // Straight after, the claim is still live: refused, no second Xero call.
  await assertRejects(() => press(deps, INV_A), TradePayRunError, "already being pushed");
  claims.clear(); // ten minutes later (claim_trade_pay_run_push's lease)
  const out = await press(deps, INV_A);
  assertEquals(calls.push, [INV_A, INV_A]);
  assertEquals(out.xero_bill_id, "bill-a");
});

Deno.test("push: an invoice that already has its bill is recorded with it, Xero is not called again", async () => {
  const { deps, calls } = makeDeps({
    rows: twoClean(),
    invoices: {
      [INV_A]: {
        pay_run_id: RUN,
        status: "pushed_to_xero",
        xero_bill_id: "bill-made-earlier",
      },
    },
  });
  const out = await press(deps, INV_A);
  assertEquals(calls.push.length, 0);
  assertEquals(calls.markPushed, [INV_A]);
  assertEquals([out.xero_bill_id, out.recorded_existing_bill], [
    "bill-made-earlier",
    true,
  ]);
});

Deno.test("push: an invoice that no longer pays what the run recorded is 409, never pushed", async () => {
  // The repayment was re-checked since the press: the stored deduction moved.
  const { deps, calls } = makeDeps({
    rows: twoClean(),
    invoices: {
      [INV_A]: {
        pay_run_id: RUN,
        status: "approved",
        xero_bill_id: null,
        net_pay: 940,
        gst: 0,
        gst_on: false,
        recurring_deduction_amount: 25,
      },
    },
  });
  await refused(press(deps, INV_A), "pay_run_pays_changed", 409);
  assertEquals(calls.push.length, 0);
});

// ── A pay-back receipt the office has not confirmed (director 21:45) ──────

Deno.test("push: a pay-back receipt marked not booked and not confirmed now is 409, never pushed, no claim taken", async () => {
  // Confirmed at the press; the office has not confirmed it since.
  for (const status of ["pending", "pending_approval", "", null]) {
    const { deps, calls } = makeDeps({
      rows: twoClean(),
      receipts: { [INV_A]: [{ status, unbooked_job_id: "0c400000-0000-4000-8000-0000000000aa" }] },
    });
    await refused(press(deps, INV_A), "pay_run_receipt_not_confirmed", 409);
    assertEquals([calls.push.length, calls.claims.length, calls.ready.length], [0, 0, 0]);
  }
});

// ── SEC-465 (c): a receipt queried or rejected after the run was approved ──

Deno.test("push: a pay-back receipt the office queried or rejected, marked or not, is 409, never pushed, no claim taken", async () => {
  for (const unbooked_job_id of [null, "0c400000-0000-4000-8000-0000000000aa"]) {
    for (const status of ["queried", "rejected", "Queried", " REJECTED "]) {
      const { deps, calls } = makeDeps({
        rows: twoClean(),
        receipts: { [INV_A]: [{ status: "approved", unbooked_job_id: null }, { status, unbooked_job_id }] },
      });
      await refused(press(deps, INV_A), "pay_run_receipt_queried_or_rejected", 409);
      assertEquals([calls.push.length, calls.claims.length, calls.ready.length], [0, 0, 0]);
    }
  }
});

Deno.test("push: a receipt approved or pushed to Xero, marked or not, is pushed as before", async () => {
  for (const receipt of [
    { status: "approved", unbooked_job_id: "0c400000-0000-4000-8000-0000000000aa" },
    { status: "pushed_to_xero", unbooked_job_id: "0c400000-0000-4000-8000-0000000000aa" },
    { status: "approved", unbooked_job_id: null },
    { status: "pushed_to_xero", unbooked_job_id: null },
  ]) {
    const { deps, calls } = makeDeps({ rows: twoClean(), receipts: { [INV_A]: [receipt] } });
    const out: any = await press(deps, INV_A);
    assertEquals(out.ok, true);
    assertEquals(calls.push, [INV_A]);
  }
});

// ── SEC-465 allow-list (director 23:14), the same rows as the check's contract ──
// supabase/tests/migration-contracts/20261118194800_trade_pay_run_receipt_allow_list
// (zz_matrix): the push refuses exactly where the check stops, with the matching reason.
const MARK = "0c400000-0000-4000-8000-0000000000aa";
// Ruling B (director 18 Nov 23:46): one office approval is enough. Columns:
// receipt status, marked not booked, the office approved the line, the check's
// receipt stops, the push's refusal (null: pushed).
const SAME_STOPS: Array<[unknown, boolean, boolean, string[], string | null]> = [
  ["approved", false, false, [], null],
  ["APPROVED", false, false, [], null],
  ["pushed_to_xero", false, false, [], null],
  ["Pushed_To_Xero", false, false, [], null],
  ["approved", true, false, [], null],
  ["pushed_to_xero", true, false, [], null],
  ["approved", false, true, [], null],
  ["pending", false, true, [], null],
  ["pending_extraction", false, true, [], null],
  ["PENDING", false, true, [], null],
  ["pending", false, false, ["reimbursement_receipt_not_approved"], "pay_run_receipt_not_approved"],
  ["pending_extraction", false, false, ["reimbursement_receipt_not_approved"], "pay_run_receipt_not_approved"],
  ["zz_new_status", false, false, ["reimbursement_receipt_not_approved"], "pay_run_receipt_not_approved"],
  ["zz_new_status", false, true, ["reimbursement_receipt_not_approved"], "pay_run_receipt_not_approved"],
  [" approved ", false, false, ["reimbursement_receipt_not_approved"], "pay_run_receipt_not_approved"],
  [" pending ", false, true, ["reimbursement_receipt_not_approved"], "pay_run_receipt_not_approved"],
  ["", false, false, ["reimbursement_receipt_not_approved"], "pay_run_receipt_not_approved"],
  ["", false, true, ["reimbursement_receipt_not_approved"], "pay_run_receipt_not_approved"],
  [null, false, false, ["reimbursement_receipt_not_approved"], "pay_run_receipt_not_approved"],
  [null, false, true, ["reimbursement_receipt_not_approved"], "pay_run_receipt_not_approved"],
  ["queried", false, false, ["reimbursement_queried_or_rejected"], "pay_run_receipt_queried_or_rejected"],
  ["rejected", false, false, ["reimbursement_queried_or_rejected"], "pay_run_receipt_queried_or_rejected"],
  ["Queried", false, false, ["reimbursement_queried_or_rejected"], "pay_run_receipt_queried_or_rejected"],
  [" REJECTED ", false, false, ["reimbursement_queried_or_rejected"], "pay_run_receipt_queried_or_rejected"],
  ["queried", false, true, ["reimbursement_queried_or_rejected"], "pay_run_receipt_queried_or_rejected"],
  ["rejected", false, true, ["reimbursement_queried_or_rejected"], "pay_run_receipt_queried_or_rejected"],
  ["pending", true, false, ["reimbursement_not_booked_unconfirmed"], "pay_run_receipt_not_confirmed"],
  ["pending", true, true, ["reimbursement_not_booked_unconfirmed"], "pay_run_receipt_not_confirmed"],
  ["pending_extraction", true, true, ["reimbursement_not_booked_unconfirmed"], "pay_run_receipt_not_confirmed"],
  ["zz_new_status", true, false, ["reimbursement_not_booked_unconfirmed"], "pay_run_receipt_not_confirmed"],
  [null, true, false, ["reimbursement_not_booked_unconfirmed"], "pay_run_receipt_not_confirmed"],
  ["queried", true, false, ["reimbursement_not_booked_unconfirmed", "reimbursement_queried_or_rejected"], "pay_run_receipt_queried_or_rejected"],
  ["rejected", true, true, ["reimbursement_not_booked_unconfirmed", "reimbursement_queried_or_rejected"], "pay_run_receipt_queried_or_rejected"],
];

Deno.test("same stops: the push refuses exactly where the check stops, an unknown or new status included", async () => {
  for (const [status, marked, lineApproved, checkStops, code] of SAME_STOPS) {
    const label = `status ${status} marked ${marked} line approved ${lineApproved}`;
    // The check stops the invoice exactly when the push refuses it.
    assertEquals(checkStops.length > 0, code !== null, label);
    const { deps, calls } = makeDeps({
      rows: twoClean(),
      receipts: {
        [INV_A]: [
          { status: "approved", unbooked_job_id: null },
          { status, unbooked_job_id: marked ? MARK : null, line_approved: lineApproved },
        ],
      },
    });
    if (code === null) {
      const out: any = await press(deps, INV_A);
      assertEquals([out.ok, calls.push], [true, [INV_A]], label);
    } else {
      await refused(press(deps, INV_A), code, 409);
      assertEquals([calls.push.length, calls.claims.length, calls.ready.length], [0, 0, 0], label);
    }
  }
});

Deno.test("allow-list: a pay-back line with no receipt, or a receipt that is gone, is refused as not approved", async () => {
  const { deps, calls } = makeDeps({
    rows: twoClean(),
    receipts: { [INV_A]: [{ status: "approved", unbooked_job_id: null }, { status: null, unbooked_job_id: null, missing: true }] },
  });
  await refused(press(deps, INV_A), "pay_run_receipt_not_approved", 409);
  assertEquals([calls.push.length, calls.claims.length], [0, 0]);
  // A deleted receipt stops even when the office approved its line.
  const approvedLine = makeDeps({
    rows: twoClean(),
    receipts: { [INV_A]: [{ status: null, unbooked_job_id: null, line_approved: true, missing: true }] },
  });
  await refused(press(approvedLine.deps, INV_A), "pay_run_receipt_not_approved", 409);
  // An invoice with no pay-back line has nothing to allow and pushes as before.
  const none = makeDeps({ rows: twoClean(), receipts: { [INV_A]: [] } });
  assertEquals(((await press(none.deps, INV_A)) as any).ok, true);
});

Deno.test("allow-list: the words name the next step", async () => {
  const { deps } = makeDeps({ rows: twoClean(), receipts: { [INV_A]: [{ status: "pending", unbooked_job_id: null }] } });
  const err = await assertRejects(() => press(deps, INV_A), TradePayRunError);
  assertEquals(
    err.message,
    "A pay-back receipt on this invoice is not approved by the office, or cannot be found, so the invoice is not pushed. Approve the receipt, or take the invoice out of the run.",
  );
});

Deno.test("push: an invoice refused for a receipt can be pressed again once the receipt is approved", async () => {
  const receipts = { [INV_A]: [{ status: "queried", unbooked_job_id: null }] };
  const { deps, calls } = makeDeps({ rows: twoClean(), receipts });
  await refused(press(deps, INV_A), "pay_run_receipt_queried_or_rejected", 409);
  receipts[INV_A] = [{ status: "approved", unbooked_job_id: null }];
  const out: any = await press(deps, INV_A);
  assertEquals(out.ok, true);
  assertEquals(calls.push, [INV_A]);
});

Deno.test("push: pay-back receipts that cannot be read refuse 503, never push", async () => {
  const { deps, calls } = makeDeps({ rows: twoClean(), receipts: "fail" });
  await refused(press(deps, INV_A), "pay_run_unreadable", 503);
  assertEquals([calls.push.length, calls.claims.length], [0, 0]);
});

Deno.test("writes: the push reads the invoice's pay-back lines, then their receipts by id", async () => {
  const seen: string[] = [];
  const answers: Record<string, any> = {
    trade_invoice_lines: {
      data: [
        { expense_receipt_id: "r1", office_review_status: "approved" },
        { expense_receipt_id: "r1", office_review_status: "awaiting" },
        { expense_receipt_id: "r2", office_review_status: "approved" },
      ],
      error: null,
    },
    expense_receipts: { data: [{ id: "r1", status: "queried", unbooked_job_id: "j1" }], error: null },
  };
  const client = {
    from(table: string) {
      const q: any = {
        select(cols: string) { seen.push(`${table}.select(${cols})`); return q; },
        eq(c: string, v: unknown) { seen.push(`${table}.eq(${c},${v})`); return q; },
        in(c: string, v: unknown[]) { seen.push(`${table}.in(${c},${v.join("|")})`); return q; },
        then(r: any, j: any) { return Promise.resolve(answers[table]).then(r, j); },
      };
      return q;
    },
  };
  const deps = payRunPushDepsFromClient(client, () => Promise.resolve(true), () => Promise.resolve({}));
  // One per pay-back line, with whether the office approved that line; r2's
  // row is gone, so it reads missing (refused, never "none").
  assertEquals(await deps.payBackReceipts(INV_A), [
    { status: "queried", unbooked_job_id: "j1", line_approved: true },
    { status: "queried", unbooked_job_id: "j1", line_approved: false },
    { status: null, unbooked_job_id: null, line_approved: true, missing: true },
  ]);
  assertEquals(seen, [
    "trade_invoice_lines.select(expense_receipt_id, office_review_status)",
    `trade_invoice_lines.eq(trade_invoice_id,${INV_A})`,
    "trade_invoice_lines.eq(line_type,reimbursement)",
    "expense_receipts.select(id, status, unbooked_job_id)",
    "expense_receipts.in(id,r1|r2)",
  ]);
  // A pay-back line with no receipt id reads missing, without a receipt read.
  answers.trade_invoice_lines = { data: [{ expense_receipt_id: null, office_review_status: "approved" }], error: null };
  const before = seen.length;
  assertEquals(await deps.payBackReceipts(INV_A), [
    { status: null, unbooked_job_id: null, line_approved: true, missing: true },
  ]);
  assertEquals(seen.slice(before).some((q) => q.startsWith("expense_receipts")), false);
  answers.trade_invoice_lines = { data: null, error: { message: "x" } };
  await refused(deps.payBackReceipts(INV_A), "pay_run_unreadable", 503);
  answers.trade_invoice_lines = { data: [], error: null };
  assertEquals(await deps.payBackReceipts(INV_A), []);
  answers.trade_invoice_lines = { data: [{ expense_receipt_id: "r1" }], error: null };
  answers.expense_receipts = { data: null, error: { message: "x" } };
  await refused(deps.payBackReceipts(INV_A), "pay_run_unreadable", 503);
});

// ── Option A: the run's push moves its own held invoice ───────────────────

Deno.test("push: a run's invoice keeps its press status until the run's push moves it to approved, before Xero", async () => {
  let readyAtPush = -1;
  const w: World = { rows: twoClean() };
  const { deps, calls } = makeDeps({
    ...w,
    push: (id) => {
      readyAtPush = calls.ready.length;
      return Promise.resolve({ success: true, xero_bill_id: `bill-${id.slice(-1)}` });
    },
  });
  const out = await press(deps, INV_A);
  assertEquals(calls.ready, [INV_A]);
  assertEquals(readyAtPush, 1);
  assertEquals(calls.push, [INV_A]);
  assertEquals(out.xero_bill_id, "bill-a");
});

Deno.test("push: a held invoice the status move cannot take (it changed) is 409, never pushed", async () => {
  const { deps, calls } = makeDeps({ rows: twoClean(), ready: false });
  await refused(press(deps, INV_A), "invoice_changed", 409);
  assertEquals([calls.push.length, calls.markPushed.length], [0, 0]);
});

Deno.test("push: a failed status move refuses 503, never pushed", async () => {
  const { deps, calls } = makeDeps({ rows: twoClean(), ready: "fail" });
  await refused(press(deps, INV_A), "pay_run_write_failed", 503);
  assertEquals(calls.push.length, 0);
});

Deno.test("push: a pay change already made before the move refuses 409 and never moves the invoice", async () => {
  const { deps, calls } = makeDeps({
    rows: twoClean(),
    invoices: {
      [INV_A]: {
        pay_run_id: RUN,
        status: "pending_ops_review",
        xero_bill_id: null,
        net_pay: 940,
        gst: 0,
        gst_on: false,
        recurring_deduction_amount: 25,
      },
    },
  });
  await refused(press(deps, INV_A), "pay_run_pays_changed", 409);
  assertEquals([calls.ready.length, calls.push.length], [0, 0]);
});

Deno.test("push: a repayment re-checked by the status move changes the pay: 409, never pushed", async () => {
  const { deps, calls } = makeDeps({
    rows: twoClean(),
    afterReady: { recurring_deduction_amount: 25 },
  });
  await refused(press(deps, INV_A), "pay_run_pays_changed", 409);
  assertEquals(calls.ready, [INV_A]);
  assertEquals(calls.push.length, 0);
});

Deno.test("writes: the status move takes only this run's held invoice, with no bill", async () => {
  const c = recordingClient({ readyUpdate: { id: INV_A, status: "approved" } });
  const deps = payRunPushDepsFromClient(c, () => Promise.resolve(true), () => Promise.resolve({}));
  assertEquals(await deps.readyForRunPush(RUN, INV_A), true);
  const [move] = c.ops;
  assertEquals([move.table, move.update], ["trade_invoices", { status: "approved" }]);
  assertEquals(move.filters, [
    ["eq", "id", INV_A],
    ["eq", "pay_run_id", RUN],
    ["in", "status", ["pending_ops_review", "queried"]],
    ["is", "xero_bill_id", null],
  ]);
  assertEquals(await payRunPushDepsFromClient(recordingClient({}), () => Promise.resolve(true), () => Promise.resolve({}))
    .readyForRunPush(RUN, INV_A), false);
  await refused(
    payRunPushDepsFromClient(recordingClient({ readyError: { code: "XX000" } }), () => Promise.resolve(true), () => Promise.resolve({}))
      .readyForRunPush(RUN, INV_A),
    "pay_run_write_failed",
    503,
  );
});

Deno.test("push: pay figures that cannot be read refuse 503, never push", async () => {
  const { deps, calls } = makeDeps({
    rows: twoClean(),
    invoices: {
      [INV_A]: {
        pay_run_id: RUN,
        status: "approved",
        xero_bill_id: null,
        net_pay: null,
        gst_on: false,
      },
    },
  });
  await refused(press(deps, INV_A), "pay_run_unreadable", 503);
  assertEquals(calls.push.length, 0);
});

Deno.test("push: GST on is part of the pays compare", async () => {
  const ok = makeDeps({
    rows: {
      [INV_A]: {
        verdict: "clean",
        pays: 1034,
        pushed_at: null,
        xero_bill_id: null,
      },
    },
    invoices: {
      [INV_A]: {
        pay_run_id: RUN,
        status: "approved",
        xero_bill_id: null,
        net_pay: 940,
        gst: 94,
        gst_on: true,
        recurring_deduction_amount: null,
      },
    },
  });
  await press(ok.deps, INV_A);
  assertEquals(ok.calls.push, [INV_A]);
});

Deno.test("push: a push answer with no bill id records nothing (502 unconfirmed)", async () => {
  const { deps, calls } = makeDeps({
    rows: twoClean(),
    push: () => Promise.resolve({ success: true }),
  });
  await refused(press(deps, INV_A), "pay_run_push_unconfirmed", 502);
  assertEquals(calls.markPushed.length, 0);
});

// ── Super paid ─────────────────────────────────────────────────────────────

const superPress = (deps: PayRunPushDeps, over: Record<string, unknown> = {}) =>
  markPayRunSuperPaid(deps, {
    orgId: ORG,
    actorUserId: APPROVER,
    runId: RUN,
    ...over,
  });

Deno.test("super paid: refused 409 until the run is pushed", async () => {
  const { deps, calls } = makeDeps({ rows: twoClean() });
  await refused(superPress(deps), "pay_run_not_pushed", 409);
  assertEquals(calls.markSuperPaid.length, 0);
});

Deno.test("super paid: on a pushed run it stamps once, and a second press returns the same stamp", async () => {
  const { deps, calls } = makeDeps({ run: baseRun({ status: "pushed" }) });
  const out = await superPress(deps);
  assertEquals(calls.markSuperPaid, [APPROVER]);
  assertEquals([out.super_marked_paid_by, out.already_marked], [
    APPROVER,
    false,
  ]);
  const again = makeDeps({
    run: baseRun({
      status: "pushed",
      super_marked_paid_at: "2026-11-20T02:00:00Z",
      super_marked_paid_by: APPROVER,
    }),
  });
  const out2 = await superPress(again.deps);
  assertEquals(again.calls.markSuperPaid.length, 0);
  assertEquals([out2.super_marked_paid_at, out2.already_marked], [
    "2026-11-20T02:00:00Z",
    true,
  ]);
});

Deno.test("super paid: same gates as the push (switch, person, approver list)", async () => {
  await refused(
    superPress(makeDeps({ switchOn: false }).deps),
    "pay_run_switch_off",
    409,
  );
  await refused(
    superPress(makeDeps({}).deps, { actorUserId: null }),
    "pay_run_named_person_required",
    403,
  );
  await refused(
    superPress(makeDeps({}).deps, { actorUserId: STAFF }),
    "pay_run_not_approver",
    403,
  );
});

// ── The real writes through a fake client ───────────────────────────────────

function recordingClient(
  answers: {
    superUpdate?: any;
    superRead?: any;
    count?: number | null;
    countError?: any;
    readyUpdate?: any;
    readyError?: any;
  },
) {
  const ops: any[] = [];
  return {
    ops,
    from(table: string) {
      const op: any = { table, filters: [] as any[] };
      const q: any = {
        select(cols: string, opt?: any) {
          op.select = cols;
          op.opt = opt;
          if (opt?.head) {
            ops.push(op);
          }
          return q;
        },
        update(p: any) {
          op.update = p;
          return q;
        },
        eq(c: string, v: unknown) {
          op.filters.push(["eq", c, v]);
          return q;
        },
        is(c: string, v: unknown) {
          op.filters.push(["is", c, v]);
          return q;
        },
        in(c: string, v: unknown) {
          op.filters.push(["in", c, v]);
          return q;
        },
        maybeSingle() {
          ops.push(op);
          if (op.update && op.table === "trade_invoices") {
            return Promise.resolve({
              data: answers.readyUpdate ?? null,
              error: answers.readyError ?? null,
            });
          }
          if (op.update) {
            return Promise.resolve({
              data: answers.superUpdate ?? null,
              error: null,
            });
          }
          return Promise.resolve({
            data: answers.superRead ?? null,
            error: null,
          });
        },
        then(res: any, rej: any) {
          if (!op.opt?.head) ops.push(op);
          const out = op.opt?.head
            ? {
              count: answers.count ?? null,
              error: answers.countError ?? null,
            }
            : { error: null };
          return Promise.resolve(out).then(res, rej);
        },
      };
      return q;
    },
  };
}

Deno.test("writes: pushed stamp only on a clean, unpushed row; run moves only from approved", async () => {
  const c = recordingClient({});
  const deps = payRunPushDepsFromClient(
    c,
    () => Promise.resolve(true),
    () => Promise.resolve({}),
  );
  await deps.markPushed(RUN, INV_A, "bill-a");
  await deps.markRunPushed(RUN);
  const [pushed, runMove] = c.ops;
  assertEquals(pushed.table, "trade_pay_run_invoices");
  assertEquals(pushed.update.xero_bill_id, "bill-a");
  assert(typeof pushed.update.pushed_at === "string");
  assertEquals(pushed.filters, [
    ["eq", "run_id", RUN],
    ["eq", "invoice_id", INV_A],
    ["eq", "verdict", "clean"],
    ["is", "pushed_at", null],
  ]);
  assertEquals([runMove.table, runMove.update], ["trade_pay_runs", {
    status: "pushed",
  }]);
  assertEquals(runMove.filters, [["eq", "id", RUN], [
    "eq",
    "status",
    "approved",
  ]]);
});

Deno.test("writes: an unreadable unpushed count refuses 503, never reads as zero", async () => {
  for (const answers of [{ countError: { code: "XX000" } }, { count: null }]) {
    const deps = payRunPushDepsFromClient(
      recordingClient(answers),
      () => Promise.resolve(true),
      () => Promise.resolve({}),
    );
    await refused(deps.cleanUnpushed(RUN), "pay_run_unreadable", 503);
  }
});

Deno.test("writes: super stamp keeps the first stamp (is null guard), reads it back when already set", async () => {
  const first = recordingClient({
    superUpdate: { super_marked_paid_at: "t1", super_marked_paid_by: APPROVER },
  });
  const d1 = payRunPushDepsFromClient(
    first,
    () => Promise.resolve(true),
    () => Promise.resolve({}),
  );
  assertEquals(await d1.markSuperPaid(RUN, APPROVER), {
    super_marked_paid_at: "t1",
    super_marked_paid_by: APPROVER,
  });
  assertEquals(first.ops[0].filters, [["eq", "id", RUN], [
    "eq",
    "status",
    "pushed",
  ], ["is", "super_marked_paid_at", null]]);
  const raced = recordingClient({
    superUpdate: null,
    superRead: { super_marked_paid_at: "t0", super_marked_paid_by: STAFF },
  });
  const d2 = payRunPushDepsFromClient(
    raced,
    () => Promise.resolve(true),
    () => Promise.resolve({}),
  );
  assertEquals(await d2.markSuperPaid(RUN, APPROVER), {
    super_marked_paid_at: "t0",
    super_marked_paid_by: STAFF,
  });
});

// ── The doors ──────────────────────────────────────────────────────────────

Deno.test("doors: staff only at the front door, POST only, signed-in person, no routine or agent key", () => {
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  const routine = src.slice(
    src.indexOf("const ROUTINE_ALLOWED_ACTIONS = new Set(["),
  );
  for (const action of ["push_pay_run_invoice", "mark_pay_run_super_paid"]) {
    const url = new URL(`https://example.invalid/ops-api?action=${action}`);
    assertEquals(_opsApiActionNeedsStaffRole(url), true, action);
    assertEquals(AGENT_READ_ALLOWED_ACTIONS.has(action), false, action);
    assertEquals(LEAD_INSTALLER_READ_ACTIONS.has(action), false, action);
    assertEquals(
      routine.slice(0, routine.indexOf("])")).includes(`'${action}'`),
      false,
      action,
    );
  }
  const at = src.indexOf("case 'push_pay_run_invoice':");
  const body = src.slice(at, src.indexOf("case 'pay_run': {", at));
  assert(body.includes("req.method !== 'POST'"));
  assert(body.includes("requestActor.source === 'jwt'"));
  // One invoice per press through the existing push, named by the run; no
  // crew sibling push, no authorise, no payment.
  assert(body.includes("pushTradeInvoiceToXeroAction("));
  assert(body.includes("`ops-api:push_pay_run_invoice:${runId}`"));
  for (
    const banned of [
      "pushReleasedGroupSiblings",
      "releaseGroupCrewBills",
      "AUTHORISED",
      "/Payments",
      "body?.pay_run",
    ]
  ) {
    assertEquals(body.includes(banned), false, banned);
  }
});

// ── The real door and the real push, against a PostgREST-shaped stub ────────
// A stamped invoice reaches the existing push past its entry gate; when the
// push fails, nothing is recorded on the run.

const SAVED = INV_A;
const LINE = "0d500000-0000-4000-8000-000000000001";

async function realPress(world: { switchOn: boolean }) {
  const { _opsApiRequestHandlerForTest } = await import("./index.ts");
  const writes: Array<{ table: string; method: string; query: string }> = [];
  const reads: string[] = [];
  const outside: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1") {
      outside.push(url.hostname);
      return Promise.resolve(Response.json({}, { status: 500 }));
    }
    const method = String(init?.method ?? "GET").toUpperCase();
    const accept = new Headers(init?.headers).get("accept") || "";
    const reply = (rows: any[]) => {
      if (!accept.includes("vnd.pgrst.object")) {
        return Promise.resolve(Response.json(rows));
      }
      if (rows.length === 1) return Promise.resolve(Response.json(rows[0]));
      if (accept.includes("nulls=stripped")) {
        return Promise.resolve(Response.json(null));
      }
      return Promise.resolve(
        Response.json({ code: "PGRST116", message: "no rows" }, {
          status: 406,
        }),
      );
    };
    if (url.pathname.startsWith("/auth/v1/user")) {
      return Promise.resolve(
        Response.json({ id: APPROVER, email: "", aud: "authenticated" }),
      );
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const fn = url.pathname.replace(/^\/rest\/v1\/rpc\//, "");
      reads.push("rpc:" + fn);
      // The push claim (director 15:22 (b)) answers with its stamp.
      return Promise.resolve(Response.json(
        fn === "claim_trade_pay_run_push" ? "2026-11-20T00:00:01+00:00" : null,
      ));
    }
    const table = url.pathname.replace(/^\/rest\/v1\//, "");
    if (method !== "GET" && method !== "HEAD") {
      writes.push({ table, method, query: url.search });
    } else reads.push(table);
    if (table === "users") {
      return reply([{
        id: APPROVER,
        org_id: ORG,
        role: "admin",
        managed_verticals: [],
        trade_sees_all_jobs: true,
        name: "Fixture Approver",
      }]);
    }
    if (table === "feature_flags") {
      return reply([{
        flag_name: "trade_pay_run_v1",
        enabled: world.switchOn,
      }]);
    }
    if (table === "trade_pay_settings") {
      return reply([{ pay_run_approver_user_ids: [APPROVER] }]);
    }
    if (table === "trade_pay_runs") return reply([baseRun()]);
    if (table === "trade_pay_run_invoices") {
      if (
        method === "HEAD" || url.searchParams.get("select") === "invoice_id"
      ) {
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: { "content-range": "*/1" },
          }),
        );
      }
      return reply([{
        verdict: "clean",
        pays: 940,
        pushed_at: null,
        xero_bill_id: null,
      }]);
    }
    if (table === "trade_invoices") {
      return reply([{
        id: SAVED,
        org_id: ORG,
        user_id: STAFF,
        pay_run_id: RUN,
        status: "approved",
        xero_bill_id: null,
        net_pay: 940,
        gst: 0,
        gst_on: false,
        recurring_deduction_amount: null,
        subtotal_ex: 1000,
        total_inc: 1000,
        gross_earned: 1000,
        super_rate: 0.12,
        super_amount: 120,
        invoice_number: "ZZT-0001",
        user: {
          id: STAFF,
          name: "Fixture Trade",
          email: "",
          xero_contact_id: null,
        },
      }]);
    }
    if (table === "trade_invoice_lines") {
      // The invoice has no pay-back line: the push's receipt read asks for
      // line_type reimbursement and finds none.
      if (url.searchParams.get("line_type") === "eq.reimbursement") {
        return reply([]);
      }
      return reply([{
        id: LINE,
        trade_invoice_id: SAVED,
        line_type: "materials",
        description: "Materials",
        quantity: 1,
        rate: 1000,
        line_total_ex: 1000,
        review_status: null,
        job_number: "ZZF-0001",
      }]);
    }
    if (table === "xero_tokens") return reply([]);
    return reply([]);
  }) as typeof fetch;
  console.log = () => {};
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", "push_pay_run_invoice");
    const res = await _opsApiRequestHandlerForTest(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: "Bearer staff-jwt",
          "content-type": "application/json",
        },
        body: JSON.stringify({ run_id: RUN, invoice_id: SAVED }),
      }),
    );
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body, writes, reads, outside };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
}

Deno.test({
  name: "real door: switch off is 409 and the invoice is never read",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const out = await realPress({ switchOn: false });
    assertEquals([out.status, out.body.error], [409, "pay_run_switch_off"]);
    assertEquals(out.reads.includes("trade_invoices"), false);
    assertEquals(out.writes.filter((w) => w.table.startsWith("trade_")), []);
    assertEquals(out.outside, []);
  },
});

Deno.test({
  name:
    "real door: a stamped invoice reaches the real push; a push that fails records nothing",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const out = await realPress({ switchOn: true });
    assert(out.status >= 400, JSON.stringify(out.body));
    // The real push took the stamped invoice past its entry gate (status
    // approved) and read its lines; it then refused before any Xero call.
    assert(out.reads.includes("trade_invoice_lines"), out.reads.join(","));
    // The press claimed the row before the push and, once the push was
    // called, kept the claim (outcome unknown; it lapses after ten minutes).
    assert(out.reads.includes("rpc:claim_trade_pay_run_push"), out.reads.join(","));
    assertEquals(out.reads.includes("rpc:release_trade_pay_run_push"), false);
    assertEquals(
      String(out.body.error ?? "").startsWith("pay_run_"),
      false,
      JSON.stringify(out.body),
    );
    assertEquals(
      out.writes.filter((w) =>
        w.table === "trade_pay_run_invoices" || w.table === "trade_pay_runs"
      ),
      [],
    );
    assertEquals(out.outside, []);
  },
});

// ── Director 15:22 (b): one press at a time per invoice ───────────────────

Deno.test("claim: two presses at once, the second is refused 409 and Xero is called once", async () => {
  let finish!: (v: Record<string, unknown>) => void;
  const { deps, calls } = makeDeps({
    rows: { [INV_A]: { verdict: "clean", pushed_at: null, xero_bill_id: null } },
    push: () => new Promise((resolve) => { finish = resolve; }),
  });
  const press = { orgId: ORG, actorUserId: APPROVER, runId: RUN, invoiceId: INV_A };
  const first = pushPayRunInvoice(deps, press);
  // Let the first press reach the Xero call and wait there.
  for (let i = 0; i < 20 && calls.push.length === 0; i++) await Promise.resolve();
  assertEquals(calls.push, [INV_A]);
  const second = await pushPayRunInvoice(deps, press).then(
    () => null,
    (e) => e,
  );
  assert(second instanceof TradePayRunError);
  assertEquals([second.code, second.status], ["pay_run_push_in_progress", 409]);
  finish({ success: true, xero_bill_id: "bill-a", pdf_attached: true });
  await first;
  assertEquals(calls.push, [INV_A]);
  assertEquals(calls.markPushed, [INV_A]);
});

Deno.test("claim: a refusal before Xero gives the claim back, so the next press can claim", async () => {
  const { deps, calls, claims } = makeDeps({
    rows: { [INV_A]: { verdict: "clean", pushed_at: null, xero_bill_id: null } },
    ready: false,
  });
  const press = { orgId: ORG, actorUserId: APPROVER, runId: RUN, invoiceId: INV_A };
  const err = await pushPayRunInvoice(deps, press).catch((e) => e);
  assertEquals(err.code, "invoice_changed");
  assertEquals([calls.claims, calls.releases, calls.push], [[INV_A], [INV_A], []]);
  assertEquals(claims.size, 0);
});

Deno.test("claim: a failed Xero call keeps the claim (outcome unknown), so a second press is refused", async () => {
  const { deps, calls, claims } = makeDeps({
    rows: { [INV_A]: { verdict: "clean", pushed_at: null, xero_bill_id: null } },
    push: () => Promise.reject(new TradePayRunError("xero_unavailable", "x", 502)),
  });
  const press = { orgId: ORG, actorUserId: APPROVER, runId: RUN, invoiceId: INV_A };
  assertEquals((await pushPayRunInvoice(deps, press).catch((e) => e)).code, "xero_unavailable");
  assertEquals([calls.releases, claims.has(INV_A)], [[], true]);
  assertEquals((await pushPayRunInvoice(deps, press).catch((e) => e)).code, "pay_run_push_in_progress");
  assertEquals(calls.push, [INV_A]);
});

Deno.test("claim: a claim that cannot be made is 503 and Xero is never called", async () => {
  const { deps, calls } = makeDeps({
    rows: { [INV_A]: { verdict: "clean", pushed_at: null, xero_bill_id: null } },
    claim: "fail",
  });
  const err = await pushPayRunInvoice(deps, { orgId: ORG, actorUserId: APPROVER, runId: RUN, invoiceId: INV_A })
    .catch((e) => e);
  assertEquals([err.code, err.status], ["pay_run_write_failed", 503]);
  assertEquals([calls.push, calls.ready], [[], []]);
});
