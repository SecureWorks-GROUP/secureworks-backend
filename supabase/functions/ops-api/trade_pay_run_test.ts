// deno-lint-ignore-file no-explicit-any no-import-prefix
// P1-10.2: the weekly pay run read. Every value, id and name is made up (ZZTEST).
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cleanIdsHash,
  defaultPayRunWeek,
  payRunCutOff,
  payRunEligible,
  payRunPlacement,
  type PayRunReads,
  payRunWeek,
  readPayRun,
  TradePayRunError,
} from "./trade_pay_run.ts";
import {
  _opsApiActionNeedsStaffRole,
  AGENT_READ_ALLOWED_ACTIONS,
  LEAD_INSTALLER_READ_ACTIONS,
} from "./index.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const WEEK = "2026-11-16";
const APPROVER = "0a200000-0000-4000-8000-000000000001";
const OFFICE = "0a200000-0000-4000-8000-000000000002";
const id = (n: number) => `0a200000-0000-4000-8000-0000000003${10 + n}`;
const user = (n: number) => `0a200000-0000-4000-8000-0000000000${10 + n}`;

// Invoice n: n x 1120 inclusive of n x 120 super, no GST.
function invoice(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: id(n),
    org_id: ORG,
    invoice_number: `ZZTEST-P102-${n}`,
    user_id: user(n),
    week_start: WEEK,
    week_end: "2026-11-22",
    status: "pending_ops_review",
    invoice_kind: "standard",
    submitted_at: "2026-11-20T01:00:00Z",
    created_at: "2026-11-20T01:00:00Z",
    pay_run_id: null,
    xero_bill_id: null,
    subtotal_ex: n * 1120,
    gross_earned: n * 1120,
    super_amount: n * 120,
    net_pay: n * 1000,
    gst: 0,
    gst_on: false,
    total_inc: n * 1120,
    super_rate: 0.12,
    super_basis: "inclusive_12_112_v1",
    super_base_ex: null,
    recurring_deduction_amount: null,
    recurring_deduction_label: null,
    ...extra,
  };
}

function v2Entry(row: any, stops: Array<{ code: string; words: string }> = []) {
  return {
    invoice_id: row.id,
    trade_name: `ZZTEST Trade ${row.invoice_number.slice(-1)}`,
    verdict: stops.length ? "stopped" : "clean",
    stops,
  };
}

type World = {
  rows: any[];
  v2Stops?: Record<string, Array<{ code: string; words: string }>>;
  v2Omit?: string[];
  standingStops?: Record<string, Array<{ code: string; words: string }>>;
  runBlocked?: boolean;
  run?: any;
  runInvoices?: Array<{ invoice_id: string; pushed_at: string | null }>;
  lines?: any[];
  held?: any[];
  approvers?: string[];
  fail?: string;
};

function reads(w: World, calls: Record<string, any[]> = {}): PayRunReads {
  const log = (k: string, v: any) => (calls[k] ??= []).push(v);
  const failIf = (k: string) => {
    if (w.fail === k) {
      throw new TradePayRunError("pay_run_unreadable", `ZZTEST ${k}`, 503);
    }
  };
  return {
    run: () => (failIf("run"), Promise.resolve(w.run ?? null)),
    runInvoices: () => Promise.resolve(w.runInvoices ?? []),
    candidates: () => (failIf("candidates"), Promise.resolve(w.rows)),
    invoicesById: (ids) =>
      Promise.resolve(w.rows.filter((r) => ids.includes(r.id))),
    lines: () => Promise.resolve(w.lines ?? []),
    heldLines: () => Promise.resolve(w.held ?? []),
    approvers:
      () => (failIf("approvers"), Promise.resolve(w.approvers ?? [APPROVER])),
    checkV2: (p) => {
      log("v2", p);
      failIf("v2");
      return Promise.resolve({
        rule: "trade-pay-check-v2",
        stage: p.p_stage,
        invoices: w.rows
          .filter((r) => !(w.v2Omit ?? []).includes(r.id))
          .map((r) => v2Entry(r, w.v2Stops?.[r.id] ?? [])),
      });
    },
    standing: (p) => {
      log("standing", p);
      failIf("standing");
      return Promise.resolve({
        rule: "pay-run-standing-v1",
        stage: p.p_stage,
        checks: [{ code: "zztest", ok: true }],
        stopped_invoices: Object.entries(w.standingStops ?? {})
          .filter(([k]) => p.p_invoice_ids.includes(k))
          .map(([invoice_id, stops]) => ({ invoice_id, stops })),
        run_blocked: w.runBlocked ?? false,
        run_blocked_words: w.runBlocked
          ? "ZZTEST pay and job cost differ"
          : null,
      });
    },
  };
}

const NOW = new Date("2026-11-25T02:00:00Z"); // Wednesday 25 Nov, Perth
const STOP = [{ code: "work_order_over_agreed", words: "ZZTEST over" }];

function run(
  w: World,
  actor: string | null = APPROVER,
  calls?: Record<string, any[]>,
) {
  return readPayRun(reads(w, calls), {
    orgId: ORG,
    weekStart: WEEK,
    actorUserId: actor,
    now: NOW,
  });
}

Deno.test("pay run: three clean and one stopped give the counts and totals to the cent", async () => {
  const rows = [1, 2, 3, 4].map((n) => invoice(n));
  const calls: Record<string, any[]> = {};
  const out: any = await run(
    { rows, v2Stops: { [id(4)]: STOP } },
    APPROVER,
    calls,
  );
  assertEquals(out.counts, { clean: 3, stopped: 1, late: 0 });
  assertEquals(out.totals, {
    total_inc_super: 6720,
    paid_to_you: 6000,
    super: 720,
    gst: 0,
    reimbursements: 0,
    into_bank: 6000,
  });
  assertEquals(out.stage, "before_xero");
  assertEquals(calls.v2[0], {
    p_as_of: "2026-11-22",
    p_weeks: 8,
    p_org_id: ORG,
    p_stage: "before_xero",
  });
  assertEquals(calls.standing[0].p_invoice_ids, [id(1), id(2), id(3)].sort());
  assertEquals(out.invoices[0].verdict, "stopped"); // stopped first
  assertEquals(out.invoices[0].stops, STOP);
  assertEquals(out.super_by_person.map((p: any) => p.super_amount), [
    120,
    240,
    360,
  ]);
  assertEquals(out.cut_off, "2026-11-22T23:59:59+08:00");
  assertEquals(
    out.clean_ids_hash,
    await cleanIdsHash([
      { invoice_id: id(1), into_bank: 1000 },
      { invoice_id: id(2), into_bank: 2000 },
      { invoice_id: id(3), into_bank: 3000 },
    ]),
  );
});

Deno.test("pay run: a standing check stop takes the invoice out of the totals and the hash only", async () => {
  const rows = [1, 2, 3, 4].map((n) => invoice(n));
  const stop = [{
    code: "standing_super_is_12_over_112",
    words: "ZZTEST super",
  }];
  const out: any = await run({ rows, standingStops: { [id(2)]: stop } });
  assertEquals(out.counts, { clean: 3, stopped: 1, late: 0 });
  const two = out.invoices.find((i: any) => i.invoice_id === id(2));
  assertEquals(two.verdict, "stopped");
  assertEquals(two.stops, stop);
  assertEquals(out.totals.into_bank, 1000 + 3000 + 4000);
  assertEquals(out.totals.super, 120 + 360 + 480);
  for (const n of [1, 3, 4]) {
    assertEquals(
      out.invoices.find((i: any) => i.invoice_id === id(n)).verdict,
      "clean",
    );
  }
  assertEquals(
    out.clean_ids_hash,
    await cleanIdsHash([
      { invoice_id: id(1), into_bank: 1000 },
      { invoice_id: id(3), into_bank: 3000 },
      { invoice_id: id(4), into_bank: 4000 },
    ]),
  );
  assertEquals(out.run_blocked, false);
  assertEquals(out.standing, [{ code: "zztest", ok: true }]);
});

Deno.test("pay run: the hash changes when one amount changes by a cent", async () => {
  const a: any = await run({ rows: [1, 2, 3].map((n) => invoice(n)) });
  const changed = [
    invoice(1, { net_pay: 999.99, super_amount: 120.01 }),
    invoice(2),
    invoice(3),
  ];
  // The money no longer reconciles, so it is stopped and leaves the hash.
  const b: any = await run({ rows: changed });
  assertNotEquals(a.clean_ids_hash, b.clean_ids_hash);
  const h1 = await cleanIdsHash([{ invoice_id: id(1), into_bank: 1000 }]);
  const h2 = await cleanIdsHash([{ invoice_id: id(1), into_bank: 1000.01 }]);
  assertNotEquals(h1, h2);
  assertEquals(b.invoices[0].stops.map((s: any) => s.code), [
    "money_unreadable",
  ]);
});

Deno.test("pay run: only a named approver can approve; the server key never can", async () => {
  const rows = [invoice(1)];
  assertEquals((await run({ rows }, APPROVER) as any).can_approve, true);
  assertEquals((await run({ rows }, OFFICE) as any).can_approve, false);
  assertEquals((await run({ rows }, null) as any).can_approve, false);
  assertEquals(
    (await run({ rows, approvers: [] }, APPROVER) as any).can_approve,
    false,
  );
});

Deno.test("pay run: reimbursements and GST from the trade's own pay view", async () => {
  const row = invoice(1, {
    subtotal_ex: 1200,
    gross_earned: 1200,
    super_base_ex: 1120,
    super_amount: 120,
    net_pay: 1080,
    gst_on: true,
    gst: 112,
    total_inc: 1312,
  });
  const out: any = await run({
    rows: [row],
    lines: [
      { trade_invoice_id: id(1), line_type: "labour", line_total_ex: 1120 },
      {
        trade_invoice_id: id(1),
        line_type: "reimbursement",
        line_total_ex: 80,
      },
    ],
  });
  assertEquals(out.totals, {
    total_inc_super: 1120,
    paid_to_you: 1000,
    super: 120,
    gst: 112,
    reimbursements: 80,
    into_bank: 1192,
  });
});

Deno.test("pay run: every failed read is 503, never a smaller week", async () => {
  const rows = [invoice(1), invoice(2)];
  for (const fail of ["run", "candidates", "v2", "standing", "approvers"]) {
    const err = await assertRejects(
      () => run({ rows, fail }),
      TradePayRunError,
    );
    assertEquals(err.status, 503, fail);
  }
  // An invoice inside the window the check left out.
  const err = await assertRejects(
    () => run({ rows, v2Omit: [id(2)] }),
    TradePayRunError,
  );
  assertEquals([err.status, err.code], [503, "pay_run_unreadable"]);
  // A malformed answer: a stop with no verdict to match.
  const bad = reads({ rows });
  bad.checkV2 = () =>
    Promise.resolve({
      rule: "trade-pay-check-v2",
      stage: "before_xero",
      invoices: [
        { invoice_id: id(1), verdict: "clean", stops: STOP },
        v2Entry(rows[1]),
      ],
    });
  await assertRejects(
    () => readPayRun(bad, { orgId: ORG, weekStart: WEEK, now: NOW }),
    TradePayRunError,
  );
  // A standing answer naming an invoice it was not given.
  const odd = reads({ rows, standingStops: {} });
  odd.standing = () =>
    Promise.resolve({
      rule: "pay-run-standing-v1",
      stage: "before_xero",
      checks: [],
      stopped_invoices: [{ invoice_id: id(9), stops: STOP }],
      run_blocked: false,
    });
  await assertRejects(
    () => readPayRun(odd, { orgId: ORG, weekStart: WEEK, now: NOW }),
    TradePayRunError,
  );
});

Deno.test("pay run: an invoice older than eight weeks is stopped by hand", async () => {
  const old = invoice(1, {
    week_start: "2026-09-14",
    submitted_at: "2026-09-18T01:00:00Z",
  });
  const out: any = await run({ rows: [old, invoice(2)], v2Omit: [id(1)] });
  assertEquals(out.invoices[0].stops, [{
    code: "older_than_run_window",
    words:
      "This invoice is for a week more than 8 weeks ago. Check it by hand.",
  }]);
  assertEquals(out.counts, { clean: 1, stopped: 1, late: 0 });
});

Deno.test("pay run: late invoices are counted and shown, an earlier week sent late joins", async () => {
  const late = invoice(1, { submitted_at: "2026-11-22T16:00:01Z" }); // Mon 00:00:01 Perth
  const onTime = invoice(2, { submitted_at: "2026-11-22T15:59:59Z" }); // Sun 23:59:59 Perth
  const earlier = invoice(3, {
    week_start: "2026-11-09",
    submitted_at: "2026-11-19T01:00:00Z",
  });
  const next = invoice(4, {
    week_start: "2026-11-23",
    submitted_at: "2026-11-21T01:00:00Z",
  });
  const out: any = await run({ rows: [late, onTime, earlier, next] });
  assertEquals(out.counts, { clean: 2, stopped: 0, late: 1 });
  assertEquals(out.late_invoices.map((i: any) => i.invoice_id), [id(1)]);
  assertEquals(out.invoices.map((i: any) => i.invoice_id).sort(), [
    id(2),
    id(3),
  ]);
});

Deno.test("pay run: placement and reach rules", () => {
  assertEquals(payRunPlacement(invoice(1), WEEK), "in_run");
  assertEquals(
    payRunPlacement(
      invoice(1, { week_start: null, submitted_at: "2026-11-22T15:00:00Z" }),
      WEEK,
    ),
    "in_run",
  );
  assertEquals(
    payRunPlacement(
      invoice(1, { week_start: null, submitted_at: "2026-11-22T16:30:00Z" }),
      WEEK,
    ),
    "not_yet",
  );
  assertEquals(payRunEligible(invoice(1)), true);
  assertEquals(payRunEligible(invoice(1, { invoice_kind: "held" })), false);
  assertEquals(payRunEligible(invoice(1, { status: "draft" })), false);
  assertEquals(payRunEligible(invoice(1, { status: "ops-reject" })), false);
  assertEquals(payRunEligible(invoice(1, { pay_run_id: id(9) })), false);
  // Already billed the one-off way: not run material (decision pay-run-history).
  assertEquals(
    payRunEligible(invoice(1, { xero_bill_id: "ZZTEST-BILL" })),
    false,
  );
  assertEquals(payRunEligible(invoice(1, { invoice_kind: "follow_on" })), true);
});

Deno.test("pay run: week, default week and cut-off", () => {
  assertEquals(
    defaultPayRunWeek(new Date("2026-11-25T02:00:00Z")),
    "2026-11-16",
  ); // Wednesday
  assertEquals(
    defaultPayRunWeek(new Date("2026-11-23T00:30:00Z")),
    "2026-11-16",
  ); // Monday Perth
  assertEquals(
    defaultPayRunWeek(new Date("2026-11-22T15:00:00Z")),
    "2026-11-09",
  ); // Sunday 23:00 Perth
  assertEquals(payRunWeek(null, NOW), "2026-11-16");
  assertEquals(payRunWeek("2026-11-09", NOW), "2026-11-09");
  for (const bad of ["2026-11-17", "2026-02-30", "16/11/2026"]) {
    const err = assertThrows(() => payRunWeek(bad, NOW), TradePayRunError);
    assertEquals([err.status, err.code], [400, "pay_run_week_invalid"]);
  }
  assertEquals(payRunCutOff("2026-11-16"), "2026-11-22T23:59:59+08:00");
});

Deno.test("pay run: once recorded, the run reads its own invoices after Xero", async () => {
  const rows = [
    invoice(1, { pay_run_id: "run-1", status: "approved" }),
    invoice(2),
    invoice(3, { status: "pending_ops_review" }),
  ];
  const calls: Record<string, any[]> = {};
  const out: any = await run(
    {
      rows,
      run: { id: "run-1", week_start: WEEK },
      runInvoices: [{ invoice_id: id(1), pushed_at: "2026-11-24T01:00:00Z" }, {
        invoice_id: id(2),
        pushed_at: null,
      }],
      v2Stops: { [id(2)]: STOP },
    },
    APPROVER,
    calls,
  );
  assertEquals(calls.v2[0].p_stage, "after_xero");
  assertEquals(calls.standing[0].p_stage, "after_xero");
  assertEquals(
    out.invoices.map((i: any) => [i.invoice_id, i.verdict, i.pushed]),
    [[id(2), "stopped", false], [id(1), "clean", true]],
  );
});

Deno.test("pay run: held lines are summed by reason and not in the run", async () => {
  const out: any = await run({
    rows: [invoice(1)],
    held: [
      { hold_reason: "no_work_order", line_total_ex: 100.1 },
      { hold_reason: "no_work_order", line_total_ex: 0.2 },
      { hold_reason: "not_booked", line_total_ex: 50 },
    ],
  });
  assertEquals(out.held, {
    lines_waiting: 3,
    amount_ex: 150.3,
    by_reason: [{ reason: "no_work_order", lines: 2, amount_ex: 100.3 }, {
      reason: "not_booked",
      lines: 1,
      amount_ex: 50,
    }],
  });
  assertEquals(out.totals.into_bank, 1000);
});

Deno.test("pay run: no organisation is refused before any read", async () => {
  let touched = false;
  const r = reads({ rows: [] });
  r.run = () => {
    touched = true;
    return Promise.resolve(null);
  };
  const err = await assertRejects(
    () => readPayRun(r, { orgId: "", now: NOW }),
    TradePayRunError,
  );
  assertEquals(err.status, 403);
  assert(!touched);
});

Deno.test("pay run: staff only at the ops-api front door", () => {
  const url = new URL("https://example.invalid/ops-api?action=pay_run");
  assertEquals(_opsApiActionNeedsStaffRole(url), true);
  assertEquals(AGENT_READ_ALLOWED_ACTIONS.has("pay_run"), false);
  assertEquals(LEAD_INSTALLER_READ_ACTIONS.has("pay_run"), false);
});
