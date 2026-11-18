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
  PAY_RUN_STAMP_STATUSES,
  approvePayRun,
  cleanIdsHash,
  defaultPayRunWeek,
  PAY_RUN_CHECK_RULE,
  PAY_RUN_REACH,
  type PayRunApproveDeps,
  payRunApproveDepsFromClient,
  payRunCutOff,
  payRunEligible,
  payRunPlacement,
  type PayRunReads,
  payRunReadsFromClient,
  payRunWeek,
  HOURLY_NO_AGREED_AMOUNT_NOTE,
  readPayRun,
  xeroBillFoundStop,
  xeroSearchBeforeReleaseNote,
  type ReconcileRaise,
  type ReconcileWithdraw,
  STANDING_CHECK_CODES,
  storedRunPays,
  TradePayRunError,
  TradePayRunRefusal,
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
const JOB_A = "0a200000-0000-4000-8000-000000000801";
const JOB_B = "0a200000-0000-4000-8000-000000000802";

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

function v2Entry(
  row: any,
  stops: Array<{ code: string; words: string }> = [],
  notes: Array<{ code: string; words: string }> = [],
) {
  return {
    invoice_id: row.id,
    trade_name: `ZZTEST Trade ${row.invoice_number.slice(-1)}`,
    verdict: stops.length ? "stopped" : "clean",
    stops,
    notes,
  };
}

type World = {
  rows: any[];
  v2Stops?: Record<string, Array<{ code: string; words: string }>>;
  v2Notes?: Record<string, Array<{ code: string; words: string }>>;
  v2Omit?: string[];
  standingStops?: Record<string, Array<{ code: string; words: string }>>;
  runBlocked?: boolean;
  run?: any;
  runInvoices?: Array<
    {
      invoice_id: string;
      pushed_at: string | null;
      released_at?: string | null;
      release_xero_found?: Record<string, unknown> | null;
      push_claimed_at?: string | null;
    }
  >;
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
    candidates: (_o, _w, reach) => (
      failIf("candidates"), log("reach", reach), Promise.resolve(w.rows)
    ),
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
          .map((r) => v2Entry(r, w.v2Stops?.[r.id] ?? [], w.v2Notes?.[r.id] ?? [])),
      });
    },
    standing: (p) => {
      log("standing", p);
      failIf("standing");
      const stopped = Object.entries(w.standingStops ?? {})
        .filter(([k]) => p.p_invoice_ids.includes(k))
        .map(([invoice_id, stops]) => ({ invoice_id, stops }));
      return Promise.resolve(standingAnswer(p.p_stage, stopped, w.runBlocked));
    },
  };
}

/** The six results, as pay-run-standing-v1 returns them; a stop named
 * standing_<code> fails that result and lists its invoice. */
function standingAnswer(
  stage: string,
  stopped: Array<{ invoice_id: string; stops: Array<{ code: string }> }>,
  runBlocked = false,
) {
  return {
    rule: "pay-run-standing-v1",
    stage,
    checks: STANDING_CHECK_CODES.map((code) => {
      const failed = stopped.filter((s) =>
        s.stops.some((x) => x.code === `standing_${code}`)
      );
      return {
        code,
        pass: failed.length === 0,
        invoices: failed.map((s) => ({ invoice_id: s.invoice_id })),
      };
    }),
    stopped_invoices: stopped,
    run_blocked: runBlocked,
    run_blocked_words: runBlocked ? "ZZTEST pay and job cost differ" : null,
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

// Director ruling 15:54: an hourly line on a job whose work order has no
// agreed amount is a note. It is shown and counted on the run and stops
// nothing.
const HOURLY_NOTE = [{
  code: HOURLY_NO_AGREED_AMOUNT_NOTE,
  words: "ZZTEST hours not checked against an agreed amount",
}];

Deno.test("pay run: the hourly no-agreed-amount note is shown and counted, and does not stop", async () => {
  const rows = [1, 2, 3].map((n) => invoice(n));
  const out: any = await run({
    rows,
    v2Stops: { [id(3)]: STOP },
    v2Notes: { [id(1)]: HOURLY_NOTE, [id(3)]: HOURLY_NOTE },
  });
  // Invoice 1 carries the note and stays clean; its money is in the totals.
  assertEquals(out.counts.clean, 2);
  assertEquals(out.counts.stopped, 1);
  assertEquals(out.counts.stopped_by_code, [{ code: "work_order_over_agreed", invoices: 1 }]);
  // Counted whatever the verdict, so the whole group is one plain number.
  assertEquals(out.counts.noted_by_code, [{ code: HOURLY_NO_AGREED_AMOUNT_NOTE, invoices: 2 }]);
  const one = out.invoices.find((i: any) => i.invoice_id === id(1));
  assertEquals(one.verdict, "clean");
  assertEquals(one.stops, []);
  assertEquals(one.notes, HOURLY_NOTE);
  const clean = await run({ rows: [1, 2].map((n) => invoice(n)) });
  assertEquals(out.totals, clean.totals as any, "the noted invoice is paid like any clean one");
});

Deno.test("pay run: a check v2 answer without notes is unreadable, never read as no notes", async () => {
  const rows = [invoice(1)];
  const bad = reads({ rows });
  bad.checkV2 = (p: any) =>
    Promise.resolve({
      rule: "trade-pay-check-v2",
      stage: p.p_stage,
      invoices: [{ invoice_id: id(1), trade_name: "ZZTEST", verdict: "clean", stops: [] }],
    });
  const err = await assertRejects(
    () => readPayRun(bad, { orgId: ORG, weekStart: WEEK, actorUserId: APPROVER, now: NOW }),
    TradePayRunError,
  );
  assertEquals([err.status, err.code], [503, "pay_run_unreadable"]);
});

Deno.test("pay run: three clean and one stopped give the counts and totals to the cent", async () => {
  const rows = [1, 2, 3, 4].map((n) => invoice(n));
  const calls: Record<string, any[]> = {};
  const out: any = await run(
    { rows, v2Stops: { [id(4)]: STOP } },
    APPROVER,
    calls,
  );
  assertEquals(out.counts, { clean: 3, stopped: 1, late: 0, stopped_by_code: [{ code: "work_order_over_agreed", invoices: 1 }], noted_by_code: [] });
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
  assertEquals(out.counts, { clean: 3, stopped: 1, late: 0, stopped_by_code: [{ code: "standing_super_is_12_over_112", invoices: 1 }], noted_by_code: [] });
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
  assertEquals(
    out.standing.map((c: any) => [c.code, c.pass]),
    STANDING_CHECK_CODES.map((c) => [c, c !== "super_is_12_over_112"]),
  );
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

Deno.test("pay run: only the approver list sees named pay; office and the server key get none", async () => {
  // Ruling 34.13. The test changed from "can_approve false" (named figures
  // were still returned) to a refusal before any pay is read.
  const rows = [invoice(1)];
  assertEquals((await run({ rows }, APPROVER) as any).can_approve, true);
  for (
    const [label, actor, approvers] of [
      ["office non-approver", OFFICE, [APPROVER]],
      ["server key", null, [APPROVER]],
      ["empty approver list", APPROVER, []],
    ] as Array<[string, string | null, string[]]>
  ) {
    const calls: Record<string, any[]> = {};
    let payRead = false;
    const r = reads({ rows, approvers }, calls);
    for (
      const k of [
        "run",
        "candidates",
        "invoicesById",
        "lines",
        "heldLines",
        "checkV2",
        "standing",
      ] as const
    ) {
      (r as any)[k] = () => {
        payRead = true;
        return Promise.resolve(null);
      };
    }
    const err = await assertRejects(
      () =>
        readPayRun(r, {
          orgId: ORG,
          weekStart: WEEK,
          actorUserId: actor,
          now: NOW,
        }),
      TradePayRunError,
    );
    assertEquals([err.status, err.code], [403, "pay_run_approver_only"], label);
    assert(!payRead, `${label}: pay was read before the refusal`);
    assert(!JSON.stringify(err).includes("ZZTEST Trade"), label);
  }
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
        { invoice_id: id(1), verdict: "clean", stops: STOP, notes: [] },
        v2Entry(rows[1]),
      ],
    });
  const badErr = await assertRejects(
    () =>
      readPayRun(bad, {
        orgId: ORG,
        weekStart: WEEK,
        actorUserId: APPROVER,
        now: NOW,
      }),
    TradePayRunError,
  );
  assertEquals([badErr.status, badErr.code], [503, "pay_run_unreadable"]);
  // A standing answer naming an invoice it was not given.
  const odd = reads({ rows, standingStops: {} });
  odd.standing = () =>
    Promise.resolve(
      standingAnswer("before_xero", [{ invoice_id: id(9), stops: STOP }]),
    );
  const oddErr = await assertRejects(
    () =>
      readPayRun(odd, {
        orgId: ORG,
        weekStart: WEEK,
        actorUserId: APPROVER,
        now: NOW,
      }),
    TradePayRunError,
  );
  assertEquals([oddErr.status, oddErr.code], [503, "pay_run_unreadable"]);
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
  assertEquals(out.counts, { clean: 1, stopped: 1, late: 0, stopped_by_code: [{ code: "older_than_run_window", invoices: 1 }], noted_by_code: [] });
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
  assertEquals(out.counts, { clean: 2, stopped: 0, late: 1, stopped_by_code: [], noted_by_code: [] });
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

Deno.test("pay run: before a run, only the statuses the stamp takes can be clean", async () => {
  const statuses = ["pending_ops_review", "queried", "pending_acknowledgment", "acknowledged", "approved", "pushed_to_xero"];
  const out: any = await run({
    rows: statuses.map((status, n) => invoice(n + 1, { status })),
  }, APPROVER);
  const verdicts = Object.fromEntries(out.invoices.map((i: any) => [
    statuses[statuses.findIndex((_, n) => id(n + 1) === i.invoice_id)] ?? i.invoice_id,
    [i.verdict, i.stops.map((x: any) => x.code)],
  ]));
  assertEquals(verdicts, {
    pending_ops_review: ["clean", []],
    queried: ["clean", []],
    pending_acknowledgment: ["stopped", ["not_waiting_for_run"]],
    acknowledged: ["stopped", ["not_waiting_for_run"]],
    approved: ["stopped", ["not_waiting_for_run"]],
    pushed_to_xero: ["stopped", ["not_waiting_for_run"]],
  });
});

Deno.test("pay run: the read's stamp statuses are the newest migration's stamp statuses", async () => {
  const dir = new URL("../../migrations/", import.meta.url);
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.name.endsWith(".sql")) names.push(e.name);
  let stamp: string | null = null;
  for (const name of names.sort().reverse()) {
    const sql = await Deno.readTextFile(new URL(name, dir));
    if (!sql.includes("FUNCTION public.approve_trade_pay_run(")) continue;
    const m = sql.match(/UPDATE public\.trade_invoices i\s+SET[^;]*?i\.status IN \(([^)]*)\)/);
    assert(m, `${name}: the stamp's status list`);
    stamp = m[1];
    break;
  }
  assert(stamp, "a migration defines approve_trade_pay_run");
  const fromSql = stamp.split(",").map((x) => x.trim().replace(/^'|'$/g, "")).sort();
  assertEquals(fromSql, [...PAY_RUN_STAMP_STATUSES].sort());
});

Deno.test("pay run: option A, after the run its own unpushed invoice is not stopped as 'not approved'", async () => {
  const notApproved = { code: "invoice_not_approved", words: "ZZTEST not approved" };
  const notInXero = { code: "not_in_xero", words: "ZZTEST no bill" };
  const rows = [
    // Stamped by this run, waiting for its push: keeps its press status.
    invoice(1, { pay_run_id: "run-1", status: "pending_ops_review" }),
    // In the run's rows but stamped by another run: not this run's approval.
    invoice(2, { pay_run_id: "run-9", status: "pending_ops_review" }),
  ];
  const out: any = await run({
    rows,
    run: { id: "run-1", week_start: WEEK },
    runInvoices: [{ invoice_id: id(1), pushed_at: null }, { invoice_id: id(2), pushed_at: null }],
    v2Stops: { [id(1)]: [notApproved, notInXero], [id(2)]: [notApproved, notInXero] },
  }, APPROVER);
  const byId = new Map(out.invoices.map((i: any) => [i.invoice_id, i]));
  assertEquals((byId.get(id(1)) as any).stops.map((x: any) => x.code), ["not_in_xero"]);
  assertEquals((byId.get(id(2)) as any).stops.map((x: any) => x.code), ["invoice_not_approved", "not_in_xero"]);
});

Deno.test("pay run: an all-in crew bill is stopped (crew release path), never clean, before the run", async () => {
  const out: any = await run({
    rows: [invoice(1), invoice(2, { super_basis: "employer_12_v2" })],
  }, APPROVER);
  const crew = out.invoices.find((i: any) => i.invoice_id === id(2));
  assertEquals(crew.verdict, "stopped");
  // Its made-up figures need not fit the employer basis; the crew stop is
  // what keeps it out of the run.
  assert(crew.stops.some((x: any) => x.code === "crew_release_path"));
  assertEquals(out.invoices.find((i: any) => i.invoice_id === id(1)).verdict, "clean");
});

Deno.test("pay run: every stopped group is counted by its code, never lost in the total", async () => {
  const noWo = { code: "work_order_missing", words: "ZZTEST no work order" };
  const noAgreed = { code: "work_order_not_agreed", words: "ZZTEST no agreed amount" };
  const out: any = await run({
    rows: [invoice(1), invoice(2), invoice(3), invoice(4)],
    v2Stops: { [id(2)]: [noWo], [id(3)]: [noWo, noAgreed], [id(4)]: [noAgreed] },
  }, APPROVER);
  assertEquals(out.counts.stopped, 3);
  assertEquals(out.counts.stopped_by_code, [
    { code: "work_order_missing", invoices: 2 },
    { code: "work_order_not_agreed", invoices: 2 },
  ]);
  // Stopped invoices stay in the list, first, with their words.
  assertEquals(out.invoices.slice(0, 3).map((i: any) => i.verdict), ["stopped", "stopped", "stopped"]);
  assert(out.invoices.some((i: any) => i.stops.some((x: any) => x.words === "ZZTEST no agreed amount")));
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

Deno.test("pay run: the open decision is one line, its default kept", async () => {
  assertEquals(PAY_RUN_REACH, { skipBilledInXero: true });
  // pay-run-history: an invoice billed in Xero the one-off way.
  const billed = invoice(2, { xero_bill_id: "ZZTEST-BILL" });
  const off: any = await readPayRun(reads({ rows: [invoice(1), billed] }), {
    orgId: ORG,
    weekStart: WEEK,
    actorUserId: APPROVER,
    now: NOW,
  });
  assertEquals(off.invoices.map((i: any) => i.invoice_id), [id(1)]);
  const asWritten: any = await readPayRun(
    reads({ rows: [invoice(1), billed] }),
    {
      orgId: ORG,
      weekStart: WEEK,
      actorUserId: APPROVER,
      now: NOW,
      reach: { skipBilledInXero: false },
    },
  );
  assertEquals(asWritten.invoices.map((i: any) => i.invoice_id).sort(), [
    id(1),
    id(2),
  ]);
});

function approverRead(r: PayRunReads) {
  return readPayRun(r, {
    orgId: ORG,
    weekStart: WEEK,
    actorUserId: APPROVER,
    now: NOW,
  });
}

Deno.test("pay run: a held line with no amount is 503, never counted as 0", async () => {
  for (const bad of [null, undefined, "", "abc"]) {
    const err = await assertRejects(
      () =>
        approverRead(reads({
          rows: [invoice(1)],
          held: [
            { hold_reason: "no_work_order", line_total_ex: 10 },
            { hold_reason: "no_work_order", line_total_ex: bad },
          ],
        })),
      TradePayRunError,
    );
    assertEquals(
      [err.status, err.code],
      [503, "pay_run_unreadable"],
      String(bad),
    );
  }
  // A numeric string from the database still reads.
  const out: any = await approverRead(reads({
    rows: [invoice(1)],
    held: [{ hold_reason: "no_work_order", line_total_ex: "12.30" }],
  }));
  assertEquals(out.held.amount_ex, 12.3);
});

Deno.test("pay run: the standing answer needs all six results, else 503 and nothing clean", async () => {
  const rows = [invoice(1), invoice(2)];
  const full = standingAnswer("before_xero", []);
  const faults: Array<[string, any]> = [
    ["empty checks, no stops, not blocked", { ...full, checks: [] }],
    ["one result missing", { ...full, checks: full.checks.slice(1) }],
    ["a result twice", { ...full, checks: [...full.checks, full.checks[0]] }],
    ["an unknown result", {
      ...full,
      checks: [...full.checks.slice(1), { code: "zztest", pass: true }],
    }],
    ["a result with no pass answer", {
      ...full,
      checks: full.checks.map((c, n) => n === 2 ? { code: c.code } : c),
    }],
  ];
  for (const [label, answer] of faults) {
    const r = reads({ rows });
    r.standing = () => Promise.resolve(answer);
    const err = await assertRejects(() => approverRead(r), TradePayRunError);
    assertEquals([err.status, err.code], [503, "pay_run_unreadable"], label);
  }
});

// ── The production reader against the installed schema ─────────────────────
// payRunReadsFromClient is driven through a stand-in PostgREST client whose
// trade_pay_runs and trade_pay_run_invoices columns are read from the P1-10.1
// migration itself. A column the tables do not have answers like PostgREST
// (42703, no data), so a wrong name is a 503 here exactly as it is live.

async function installedColumns(): Promise<Map<string, Set<string>>> {
  // Found by name, not number, so a rename-only renumber keeps this test.
  const dir = new URL("../../migrations/", import.meta.url);
  let file: URL | null = null;
  for await (const e of Deno.readDir(dir)) {
    if (e.name.endsWith("_trade_pay_runs.sql")) file = new URL(e.name, dir);
  }
  assert(file, "the P1-10.1 migration is not in supabase/migrations");
  const sql = await Deno.readTextFile(file);
  const tables = new Map<string, Set<string>>();
  for (
    const m of sql.matchAll(
      /CREATE TABLE IF NOT EXISTS public\.(\w+) \(([\s\S]*?)\n\);/g,
    )
  ) {
    const cols = new Set<string>();
    for (const line of m[2].split("\n")) {
      const word = line.trim().match(/^(\w+)\s/)?.[1];
      if (word && !/^(PRIMARY|UNIQUE|CHECK|CONSTRAINT|FOREIGN)$/i.test(word)) {
        cols.add(word);
      }
    }
    tables.set(m[1], cols);
  }
  // Columns later pay run migrations add to the run rows (the push claim,
  // cl-payrun-escape's release record), found by name like the one above.
  for await (const e of Deno.readDir(dir)) {
    if (
      !e.name.endsWith("_trade_pay_run_holds_status.sql") &&
      !e.name.endsWith("_trade_pay_run_release.sql") &&
      !e.name.endsWith("_trade_pay_run_xero_found.sql")
    ) continue;
    const later = await Deno.readTextFile(new URL(e.name, dir));
    for (
      const m of later.matchAll(
        /ALTER TABLE public\.(\w+)\s+((?:ADD COLUMN IF NOT EXISTS \w+[^,;]*,?\s*)+);/g,
      )
    ) {
      for (const c of m[2].matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)) {
        tables.get(m[1])?.add(c[1]);
      }
    }
  }
  return tables;
}

function schemaClient(
  schema: Map<string, Set<string>>,
  data: Record<string, any[]>,
  rpc: Record<string, (p: any) => any>,
) {
  const bad = (col: string) => ({
    data: null,
    error: { code: "42703", message: `column ${col} does not exist` },
  });
  return {
    rpc: (name: string, params: any) =>
      Promise.resolve({ data: rpc[name](params), error: null }),
    from(table: string) {
      const known = schema.get(table);
      const filters: Array<(r: any) => boolean> = [];
      const used: string[] = [];
      let range: [number, number] | null = null;
      let single = false;
      const q: any = {
        select(cols: string) {
          used.push(...cols.split(",").map((c) => c.trim()));
          return q;
        },
        eq(col: string, v: unknown) {
          used.push(col);
          filters.push((r) => r[col] === v);
          return q;
        },
        in(col: string, vs: unknown[]) {
          used.push(col);
          filters.push((r) => vs.includes(r[col]));
          return q;
        },
        is(col: string, v: unknown) {
          used.push(col);
          filters.push((r) => (r[col] ?? null) === v);
          return q;
        },
        not(col: string) {
          used.push(col);
          return q;
        },
        or() {
          return q;
        },
        order(col: string) {
          used.push(col);
          return q;
        },
        range(a: number, b: number) {
          range = [a, b];
          return q;
        },
        maybeSingle() {
          single = true;
          return q;
        },
        then(resolve: (v: any) => unknown, reject: (e: unknown) => unknown) {
          const missing = known && used.find((c) => !known.has(c));
          if (missing) {
            return Promise.resolve(bad(missing)).then(resolve, reject);
          }
          let rows = (data[table] ?? []).filter((r) =>
            filters.every((f) => f(r))
          );
          if (range) rows = rows.slice(range[0], range[1] + 1);
          return Promise.resolve({
            data: single ? rows[0] ?? null : rows,
            error: null,
          }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

Deno.test("pay run: the production reader reads a recorded week against the installed run tables", async () => {
  const schema = await installedColumns();
  assert(schema.get("trade_pay_run_invoices")?.has("run_id"));
  assert(!schema.get("trade_pay_run_invoices")?.has("pay_run_id"));
  // cl-payrun-escape: the run read selects the release record.
  assert(schema.get("trade_pay_run_invoices")?.has("released_at"));
  // cl-payrun-xero-found: and the found Xero bill.
  assert(schema.get("trade_pay_run_invoices")?.has("release_xero_found"));
  const RUN = "0a200000-0000-4000-8000-000000000501";
  const rows = [
    invoice(1, { pay_run_id: RUN, status: "approved" }),
    invoice(2),
  ];
  const client = schemaClient(schema, {
    trade_pay_runs: [{
      id: RUN,
      org_id: ORG,
      week_start: WEEK,
      check_rule: "v2",
      approved_by: APPROVER,
      approved_at: "2026-11-24T01:00:00Z",
      standing: {},
      invoice_count: 1,
      total_pays: 1000,
      super_total: 120,
      status: "approved",
    }],
    trade_pay_run_invoices: [
      { run_id: RUN, invoice_id: id(1), pushed_at: null, verdict: "clean" },
      { run_id: RUN, invoice_id: id(2), pushed_at: null, verdict: "stopped" },
    ],
    trade_invoices: rows,
    trade_invoice_lines: [],
    trade_pay_settings: [{ id: 1, pay_run_approver_user_ids: [APPROVER] }],
  }, {
    trade_pay_run_check_v2: (p) => ({
      rule: "trade-pay-check-v2",
      stage: p.p_stage,
      invoices: [v2Entry(rows[0]), v2Entry(rows[1], STOP)],
    }),
    trade_pay_run_standing_checks: (p) => standingAnswer(p.p_stage, []),
  });
  const out: any = await approverRead(payRunReadsFromClient(client));
  assertEquals(out.run.id, RUN);
  assertEquals(out.stage, "after_xero");
  assertEquals(
    out.invoices.map((i: any) => [i.invoice_id, i.verdict]),
    [[id(2), "stopped"], [id(1), "clean"]],
  );
});

// ════════════════════════════════════════════════════════════
// P1-10.3: approve the run in one press. Every value, id and name is made up.
// ════════════════════════════════════════════════════════════

type ApproveWorld = World & {
  switchOn?: boolean;
  rpcError?: string;
  rpcAnswer?: any;
  raiseFails?: boolean;
  withdrawFails?: boolean;
  jobLines?: Array<
    {
      trade_invoice_id: string;
      job_id: string | null;
      job_number: string | null;
    }
  >;
  roles?: Array<{ id: string; role: string }>;
};

type ApproveCalls = {
  approve: any[];
  raise: ReconcileRaise[];
  withdraw: ReconcileWithdraw[];
  logs: Record<string, unknown>[];
  invoicesById: string[][];
};

function approveDeps(w: ApproveWorld, calls: ApproveCalls): PayRunApproveDeps {
  const base = reads(w);
  return {
    reads: {
      ...base,
      invoicesById: (ids) => {
        calls.invoicesById.push(ids);
        return base.invoicesById(ids);
      },
    },
    switchOn: () => Promise.resolve(w.switchOn ?? true),
    approve: (params) => {
      calls.approve.push(params);
      if (w.rpcError) {
        return Promise.resolve({
          data: null,
          error: { message: w.rpcError },
        });
      }
      const inv = (params.p_snapshot as any).invoices as any[];
      const clean = inv.filter((i) => i.verdict === "clean");
      // The database records the run: later reads see it.
      w.run = { id: RUN_ID, org_id: ORG, week_start: WEEK, status: "approved" };
      w.runInvoices = inv.map((i) => ({
        invoice_id: i.invoice_id,
        pushed_at: null,
      }));
      return Promise.resolve({
        data: w.rpcAnswer ?? {
          run_id: RUN_ID,
          week_start: WEEK,
          invoice_count: clean.length,
          stopped_count: inv.length - clean.length,
          run_invoice_rows: inv.length,
          approved_count: clean.length,
        },
        error: null,
      });
    },
    raise: (item) => {
      calls.raise.push(item);
      return w.raiseFails
        ? Promise.reject(new Error("ZZTEST raise down"))
        : Promise.resolve();
    },
    withdraw: (item) => {
      calls.withdraw.push(item);
      return w.withdrawFails
        ? Promise.reject(new Error("ZZTEST withdraw down"))
        : Promise.resolve();
    },
    invoiceJobs: (ids) =>
      Promise.resolve(
        (w.jobLines ?? []).filter((l) => ids.includes(l.trade_invoice_id)),
      ),
    userRoles: (ids) =>
      Promise.resolve((w.roles ?? []).filter((u) => ids.includes(u.id))),
    log: (line) => calls.logs.push(line),
  };
}

const RUN_ID = "0a200000-0000-4000-8000-000000000901";

function newCalls(): ApproveCalls {
  return { approve: [], raise: [], withdraw: [], logs: [], invoicesById: [] };
}

/** The hash the pay run read gives the approver for this world. */
async function shownHash(w: World): Promise<string> {
  const out: any = await run(structuredClone(w));
  return out.clean_ids_hash;
}

async function press(
  w: ApproveWorld,
  calls: ApproveCalls,
  opts: { actor?: string | null; hash?: unknown; week?: unknown } = {},
) {
  return await approvePayRun(approveDeps(w, calls), {
    orgId: ORG,
    weekStart: "week" in opts ? opts.week : WEEK,
    expectedHash: "hash" in opts ? opts.hash : await shownHash(w),
    actorUserId: "actor" in opts ? opts.actor : APPROVER,
    now: NOW,
  });
}

async function refusedWith(
  p: Promise<unknown>,
  code: string,
  status: number,
): Promise<TradePayRunError> {
  const e = await assertRejects(() => p, TradePayRunError);
  assertEquals((e as TradePayRunError).code, code);
  assertEquals((e as TradePayRunError).status, status);
  return e as TradePayRunError;
}

const noAmounts = (logs: Record<string, unknown>[]) => {
  for (const l of logs) {
    for (const v of Object.values(l)) {
      assert(
        typeof v !== "number",
        `log carries a number: ${JSON.stringify(l)}`,
      );
    }
  }
};

Deno.test("approve pay run: spec test 28, a non-approver is 403, an approver records the run, a second press is 409", async () => {
  const w: ApproveWorld = {
    rows: [1, 2, 3, 4].map((n) => invoice(n)),
    v2Stops: { [id(4)]: STOP },
  };
  const hash = await shownHash(w);

  // Office (signed in, not on the list): refused before any pay is read.
  const office = newCalls();
  const e = await refusedWith(
    press(w, office, { actor: OFFICE, hash }),
    "pay_run_not_approver",
    403,
  );
  assertEquals(
    e.message,
    "Only the bookkeeper and the owner can approve the run.",
  );
  assertEquals(office.approve.length, 0);

  // The approver records the run with the server's own snapshot.
  const calls = newCalls();
  const out: any = await press(w, calls, { hash });
  assertEquals(calls.approve.length, 1);
  const p = calls.approve[0];
  assertEquals(p.p_org_id, ORG);
  assertEquals(p.p_week_start, WEEK);
  assertEquals(p.p_actor, APPROVER);
  assertEquals(p.p_snapshot.check_rule, PAY_RUN_CHECK_RULE);
  assertEquals(
    p.p_snapshot.invoices.map((
      i: any,
    ) => [i.invoice_id, i.verdict, i.pays, i.super_amount]).sort(),
    [
      [id(1), "clean", 1000, 120],
      [id(2), "clean", 2000, 240],
      [id(3), "clean", 3000, 360],
      [id(4), "stopped", 4000, 480],
    ],
  );
  assertEquals(out.ok, true);
  assertEquals(out.run.run_id, RUN_ID);
  assertEquals(out.run.invoice_count, 3);
  assertEquals(out.clean_invoice_ids, [id(1), id(2), id(3)].sort());

  // A second press finds the run already recorded.
  const again = newCalls();
  await refusedWith(press(w, again, { hash }), "pay_run_already_approved", 409);
  assertEquals(again.approve.length, 0);
  noAmounts([...calls.logs, ...again.logs]);
});

Deno.test("approve pay run: the server key alone, or no signed-in person, is 403 before any read", async () => {
  const w: ApproveWorld = { rows: [invoice(1)] };
  for (const actor of [null, "", "not-a-uuid"]) {
    const calls = newCalls();
    await refusedWith(
      press(w, calls, { actor, hash: "a".repeat(64) }),
      "pay_run_named_person_required",
      403,
    );
    assertEquals(calls.approve.length, 0);
    assertEquals(calls.invoicesById.length, 0);
  }
});

Deno.test("approve pay run: the switch off gives 409 and nothing is read or written", async () => {
  const calls = newCalls();
  let read = false;
  const deps = approveDeps({ rows: [invoice(1)], switchOn: false }, calls);
  deps.reads.approvers = () => {
    read = true;
    return Promise.resolve([APPROVER]);
  };
  await refusedWith(
    approvePayRun(deps, {
      orgId: ORG,
      weekStart: WEEK,
      expectedHash: "a".repeat(64),
      actorUserId: APPROVER,
      now: NOW,
    }),
    "pay_run_switch_off",
    409,
  );
  assertEquals(read, false);
  assertEquals(calls.approve.length, 0);
});

Deno.test("approve pay run: an empty week cannot close (409, nothing written, the week stays open)", async () => {
  // No invoice at all, and every invoice stopped: neither reaches the database.
  const stoppedOnly: ApproveWorld = { rows: [invoice(1, { net_pay: null })] };
  for (const w of [{ rows: [] } as ApproveWorld, stoppedOnly]) {
    const calls = newCalls();
    const hash = await shownHash(w);
    await refusedWith(press(w, calls, { hash }), "pay_run_nothing_clean", 409);
    assertEquals(calls.approve.length, 0);
    assertEquals(calls.raise.length, 0);
  }
});

Deno.test("approve pay run: a week that changed since it was shown is 409 and writes nothing", async () => {
  const w: ApproveWorld = { rows: [1, 2, 3].map((n) => invoice(n)) };
  const hash = await shownHash(w);
  // The office changes one invoice by a cent after it was shown.
  w.rows[1] = invoice(2, { net_pay: 1999.99, super_amount: 240.01 });
  const calls = newCalls();
  const e = await refusedWith(
    press(w, calls, { hash }),
    "pay_run_changed_since_shown",
    409,
  );
  assertEquals(
    e.message,
    "The pay run changed since you opened it. Check it again.",
  );
  assertEquals(calls.approve.length, 0);
  assertEquals(calls.raise.length, 0);
  assertEquals(calls.withdraw.length, 0);
});

Deno.test("approve pay run: a blocked week is 409, records no run and raises one pay_run_stopped item", async () => {
  const w: ApproveWorld = {
    rows: [1, 2].map((n) => invoice(n)),
    runBlocked: true,
  };
  const calls = newCalls();
  const deps = approveDeps(w, calls);
  const base = deps.reads.standing;
  deps.reads.standing = async (p) => {
    const a = await base(p);
    a.checks[0].expected = 3000;
    a.checks[0].actual = 2875.5;
    return a;
  };
  const hash = await shownHash(w);
  const e = await assertRejects(
    () =>
      approvePayRun(deps, {
        orgId: ORG,
        weekStart: WEEK,
        expectedHash: hash,
        actorUserId: APPROVER,
        now: NOW,
      }),
    TradePayRunRefusal,
  );
  assertEquals(e.code, "pay_run_standing_check_failed");
  assertEquals(e.status, 409);
  assertEquals(e.extra.run_blocked_words, "ZZTEST pay and job cost differ");
  assertEquals(calls.approve.length, 0);
  assertEquals(calls.raise.length, 1);
  const item = calls.raise[0];
  assertEquals(item.kind, "pay_run_stopped");
  assertEquals(item.subject_table, "trade_pay_run_weeks");
  assertEquals(item.subject_id, `${ORG}:${WEEK}`);
  assertEquals(item.job_ids, []);
  assertEquals(item.suggestion, { action: "find_the_difference" });
  assertEquals(item.raised_by, "phase1:pay_run");
  assertEquals(item.evidence.reason, "run_total_mismatch");
  assertEquals(item.evidence.amount_ex, 124.5);
  assertEquals(item.evidence.document_date, WEEK);
  assertEquals(item.evidence.summary, {
    words: "ZZTEST pay and job cost differ",
    week_start: WEEK,
  });
  assert(Array.isArray(item.evidence.standing));
});

Deno.test("approve pay run: a blocked week whose office item fails still refuses and is logged by code", async () => {
  const w: ApproveWorld = {
    rows: [invoice(1)],
    runBlocked: true,
    raiseFails: true,
  };
  const calls = newCalls();
  await refusedWith(press(w, calls), "pay_run_standing_check_failed", 409);
  assertEquals(calls.approve.length, 0);
  assertEquals(calls.logs.map((l) => [l.event, l.op, l.code]), [
    ["pay_run_office_item_failed", "raise", "raise_failed"],
  ]);
});

Deno.test("approve pay run: a standing stop on one of four invoices approves the other three and raises its item", async () => {
  const w: ApproveWorld = {
    rows: [1, 2, 3, 4].map((n) => invoice(n)),
    standingStops: {
      [id(2)]: [{
        code: "standing_super_is_12_over_112",
        words: "ZZTEST super wrong",
      }],
    },
    jobLines: [
      { trade_invoice_id: id(2), job_id: JOB_A, job_number: "SWF-ZZ1" },
      { trade_invoice_id: id(2), job_id: JOB_B, job_number: "SWF-ZZ2" },
      { trade_invoice_id: id(2), job_id: JOB_A, job_number: "SWF-ZZ1" },
      { trade_invoice_id: id(1), job_id: JOB_B, job_number: "SWF-ZZ2" },
    ],
    roles: [{ id: user(2), role: "lead_installer" }],
  };
  const calls = newCalls();
  const out: any = await press(w, calls);
  const snap = calls.approve[0].p_snapshot.invoices;
  assertEquals(
    snap.filter((i: any) => i.verdict === "clean").map((i: any) => i.invoice_id)
      .sort(),
    [id(1), id(3), id(4)].sort(),
  );
  const stopped = snap.find((i: any) => i.invoice_id === id(2));
  assertEquals(stopped.verdict, "stopped");
  assertEquals(stopped.stops, [{
    code: "standing_super_is_12_over_112",
    words: "ZZTEST super wrong",
  }]);
  assertEquals(out.clean_invoice_ids, [id(1), id(3), id(4)].sort());

  assertEquals(calls.raise.length, 1);
  const item = calls.raise[0];
  assertEquals(item.kind, "pay_claim_stopped");
  assertEquals(item.subject_table, "trade_invoices");
  assertEquals(item.subject_id, id(2));
  assertEquals(item.job_ids, [JOB_A, JOB_B]);
  assertEquals(item.suggestion, { action: "fix_or_send_back" });
  assertEquals(item.raised_by, "phase1:pay_run");
  assertEquals(item.evidence.reason, "standing_super_is_12_over_112");
  assertEquals(item.evidence.amount_ex, 2240);
  assertEquals(item.evidence.document_date, WEEK);
  assertEquals(item.evidence.summary, {
    words: "ZZTEST super wrong",
    trade_user_id: user(2),
    trade_name: "ZZTEST Trade 2",
    trade_role: "lead_installer",
    job_number: "SWF-ZZ1",
    week_start: WEEK,
  });
  assertEquals(item.evidence.stops, stopped.stops);

  // Every invoice clean now has its old item withdrawn (a no-op when none).
  assertEquals(
    calls.withdraw.map((x) => [x.kind, x.subject_table, x.subject_id, x.reason])
      .sort(),
    [id(1), id(3), id(4)].sort().map((i) => [
      "pay_claim_stopped",
      "trade_invoices",
      i,
      "Clean in this pay run",
    ]),
  );
  assertEquals(out.office_items, { raised: 1, withdrawn: 3, failed: 0 });
});

Deno.test("approve pay run: each stopped invoice raises one item carrying its first stop's reason", async () => {
  const w: ApproveWorld = {
    rows: [1, 2, 3].map((n) => invoice(n)),
    v2Stops: {
      [id(1)]: [
        { code: "work_order_over_agreed", words: "ZZTEST over." },
        { code: "crew_not_accepted", words: "ZZTEST crew." },
      ],
      [id(3)]: [{ code: "no_work_order", words: "ZZTEST none." }],
    },
  };
  const calls = newCalls();
  await press(w, calls);
  assertEquals(
    calls.raise.map((
      r,
    ) => [r.subject_id, r.evidence.reason, (r.evidence.summary as any).words])
      .sort(),
    [
      [id(1), "work_order_over_agreed", "ZZTEST over. ZZTEST crew."],
      [id(3), "no_work_order", "ZZTEST none."],
    ].sort(),
  );
  assertEquals(calls.withdraw.map((x) => x.subject_id), [id(2)]);
});

Deno.test("approve pay run: a failed raise or withdraw is logged by code and never undoes the approval", async () => {
  const w: ApproveWorld = {
    rows: [1, 2].map((n) => invoice(n)),
    v2Stops: { [id(2)]: STOP },
    raiseFails: true,
    withdrawFails: true,
  };
  const calls = newCalls();
  const out: any = await press(w, calls);
  assertEquals(out.ok, true);
  assertEquals(out.run.run_id, RUN_ID);
  assertEquals(out.office_items, { raised: 0, withdrawn: 0, failed: 2 });
  assertEquals(
    calls.logs.filter((l) => l.event === "pay_run_office_item_failed").map((
      l,
    ) => [l.op, l.subject_id]).sort(),
    [["raise", id(2)], ["withdraw", id(1)]].sort(),
  );
  noAmounts(calls.logs);
});

Deno.test("approve pay run: the database's own refusals map to the ticket's answers", async () => {
  const cases: Array<[string, string, number]> = [
    ["pay_run_not_approver", "pay_run_not_approver", 403],
    ["pay_run_already_approved", "pay_run_already_approved", 409],
    ["pay_run_changed_since_shown", "pay_run_changed_since_shown", 409],
    ["pay_run_nothing_clean", "pay_run_nothing_clean", 409],
    ["pay_run_standing_check_failed", "pay_run_standing_check_failed", 409],
    ["pay_run_snapshot_invalid", "pay_run_snapshot_invalid", 503],
    ["pay_run_figures_unreadable", "pay_run_figures_unreadable", 503],
    [
      "pay_run_standing_check_unreadable",
      "pay_run_standing_check_unreadable",
      503,
    ],
    [
      "canceling statement due to statement timeout",
      "pay_run_approve_failed",
      503,
    ],
  ];
  for (const [raised, code, status] of cases) {
    const w: ApproveWorld = { rows: [invoice(1)], rpcError: raised };
    const calls = newCalls();
    const e = await refusedWith(press(w, calls), code, status);
    if (code === "pay_run_not_approver") {
      assertEquals(
        e.message,
        "Only the bookkeeper and the owner can approve the run.",
      );
    }
    if (code === "pay_run_standing_check_failed") {
      assert(e instanceof TradePayRunRefusal);
    }
    // A refused approval raises and withdraws nothing.
    assertEquals(calls.raise.length, 0);
    assertEquals(calls.withdraw.length, 0);
    noAmounts(calls.logs);
  }
});

Deno.test("approve pay run: an answer with no run id is 503, never reported as recorded", async () => {
  const w: ApproveWorld = { rows: [invoice(1)], rpcAnswer: { ok: true } };
  const calls = newCalls();
  await refusedWith(press(w, calls), "pay_run_approve_failed", 503);
  assertEquals(calls.withdraw.length, 0);
});

Deno.test("approve pay run: the snapshot's pays is what the database reads for GST and a recurring deduction", async () => {
  const gstRow = invoice(1, {
    subtotal_ex: 1200,
    gross_earned: 1200,
    super_base_ex: 1120,
    super_amount: 120,
    net_pay: 1080,
    gst_on: true,
    gst: 112,
    total_inc: 1312,
  });
  const deductionRow = invoice(2, {
    recurring_deduction_amount: 50,
    recurring_deduction_label: "ZZTEST deduction",
  });
  const w: ApproveWorld = { rows: [gstRow, deductionRow] };
  const calls = newCalls();
  await press(w, calls);
  const snap = calls.approve[0].p_snapshot.invoices as any[];
  for (const row of [gstRow, deductionRow]) {
    const e = snap.find((i) => i.invoice_id === row.id);
    assertEquals(e.verdict, "clean");
    // approve_trade_pay_run: round(net_pay + gst when on - deduction, 2).
    assertEquals(e.pays, storedRunPays(row));
    assertEquals(e.super_amount, row.super_amount);
  }
  assertEquals(snap.find((i) => i.invoice_id === id(1)).pays, 1192);
  assertEquals(snap.find((i) => i.invoice_id === id(2)).pays, 1950);
});

Deno.test("approve pay run: a stopped invoice whose figures could not be shown records its stored figures, or refuses", async () => {
  // Pay figures that do not add up: shown stopped money_unreadable.
  const broken = invoice(2, { net_pay: 1500 });
  const w: ApproveWorld = { rows: [invoice(1), broken] };
  const calls = newCalls();
  await press(w, calls);
  const e = (calls.approve[0].p_snapshot.invoices as any[]).find((i) =>
    i.invoice_id === id(2)
  );
  assertEquals(e.verdict, "stopped");
  assertEquals(e.pays, 1500);
  assertEquals(e.super_amount, 240);

  // Missing stored figures: refused, never sent as 0.
  const missing = invoice(2, { net_pay: null });
  const w2: ApproveWorld = { rows: [invoice(1), missing] };
  const calls2 = newCalls();
  await refusedWith(
    press(w2, calls2),
    "pay_run_stopped_figures_unreadable",
    503,
  );
  assertEquals(calls2.approve.length, 0);
});

Deno.test("approve pay run: the press must name its week and the hash it was shown; client ids are ignored", async () => {
  const w: ApproveWorld = { rows: [invoice(1)] };
  for (const week of [undefined, null, "", "2026-11-17", 20261116]) {
    const calls = newCalls();
    await refusedWith(
      press(w, calls, { week, hash: "a".repeat(64) }),
      "pay_run_week_invalid",
      400,
    );
    assertEquals(calls.approve.length, 0);
  }
  for (const hash of [undefined, null, "", "abc", 123, "g".repeat(64)]) {
    const calls = newCalls();
    await refusedWith(press(w, calls, { hash }), "pay_run_hash_required", 400);
    assertEquals(calls.approve.length, 0);
  }
  // Upper-case hex of the right hash is the same hash.
  const calls = newCalls();
  await press(w, calls, { hash: (await shownHash(w)).toUpperCase() });
  assertEquals(calls.approve.length, 1);
});

Deno.test("approve pay run: a failed read is 503 and nothing is written", async () => {
  for (const fail of ["approvers", "run", "candidates", "v2", "standing"]) {
    const w: ApproveWorld = { rows: [invoice(1)], fail };
    const calls = newCalls();
    await refusedWith(
      press(w, calls, { hash: "a".repeat(64) }),
      "pay_run_unreadable",
      503,
    );
    assertEquals(calls.approve.length, 0);
    assertEquals(calls.raise.length, 0);
  }
});

Deno.test("approve pay run: staff only at the ops-api front door, POST only, no routine or agent key", () => {
  const url = new URL("https://example.invalid/ops-api?action=approve_pay_run");
  assertEquals(_opsApiActionNeedsStaffRole(url), true);
  assertEquals(AGENT_READ_ALLOWED_ACTIONS.has("approve_pay_run"), false);
  assertEquals(LEAD_INSTALLER_READ_ACTIONS.has("approve_pay_run"), false);
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  const routine = src.slice(
    src.indexOf("const ROUTINE_ALLOWED_ACTIONS = new Set(["),
  );
  assertEquals(
    routine.slice(0, routine.indexOf("])")).includes("'approve_pay_run'"),
    false,
  );
  const caseAt = src.indexOf("case 'approve_pay_run': {");
  assert(caseAt > 0);
  const body = src.slice(
    caseAt,
    src.indexOf("case 'list_work_orders':", caseAt),
  );
  assert(body.includes("req.method !== 'POST'"));
  assert(body.includes("requestActor.source === 'jwt'"));
  // The approve path never reaches Xero.
  assertEquals(/xero/i.test(body.replace(/never calls Xero/, "")), false);
});

async function migrationText(suffix: string): Promise<string> {
  const dir = new URL("../../migrations/", import.meta.url);
  for await (const e of Deno.readDir(dir)) {
    if (e.name.endsWith(suffix)) {
      return await Deno.readTextFile(new URL(e.name, dir));
    }
  }
  throw new Error(`no migration ending ${suffix}`);
}

/** The named parameters of `public.<fn>(` as the migration declares them. */
function declaredParams(sql: string, fn: string): string[] {
  const at = sql.indexOf(`FUNCTION public.${fn}(`);
  assert(at >= 0, `${fn} not declared`);
  const open = at + `FUNCTION public.${fn}(`.length;
  const args = sql.slice(open, sql.indexOf(")", open));
  return args.split(",").map((a) => a.trim().split(/\s+/)[0]);
}

Deno.test("approve pay run: the production dependencies call what the migrations install", async () => {
  const calls: Array<{ kind: string; name: string; args: any }> = [];
  const selects = new Map<string, string[]>();
  const client = {
    rpc: (name: string, args: any) => {
      calls.push({ kind: "rpc", name, args });
      return Promise.resolve({ data: { run_id: RUN_ID }, error: null });
    },
    from(table: string) {
      const q: any = {
        select(cols: string) {
          selects.set(table, cols.split(",").map((c) => c.trim()));
          return q;
        },
        in: () => q,
        order: () => q,
        range: () => q,
        then: (res: (v: any) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(res),
      };
      return q;
    },
  };
  const deps = payRunApproveDepsFromClient(client, () => Promise.resolve(true));
  await deps.approve({
    p_org_id: ORG,
    p_week_start: WEEK,
    p_actor: APPROVER,
    p_snapshot: { check_rule: PAY_RUN_CHECK_RULE, invoices: [] },
  });
  await deps.withdraw({
    kind: "pay_claim_stopped",
    subject_table: "trade_invoices",
    subject_id: id(1),
    reason: "Clean in this pay run",
  });
  await deps.raise({
    kind: "pay_claim_stopped",
    subject_table: "trade_invoices",
    subject_id: id(1),
    job_ids: [],
    suggestion: {},
    evidence: { reason: "x" },
    raised_by: "phase1:pay_run",
  });
  await deps.invoiceJobs([id(1)]);
  await deps.userRoles([user(1)]);

  const runs = await migrationText("_trade_pay_runs.sql");
  assertEquals(
    Object.keys(calls.find((c) => c.name === "approve_trade_pay_run")!.args),
    declaredParams(runs, "approve_trade_pay_run"),
  );
  const reconcile = await migrationText("_reconcile_item_raise.sql");
  assertEquals(
    Object.keys(calls.find((c) => c.name === "reconcile_item_withdraw")!.args),
    declaredParams(reconcile, "reconcile_item_withdraw"),
  );
  // reconcile_item_raise declares its arguments by position, so PostgREST
  // cannot call it by name; the call goes through the named door, whose
  // declared parameters the call's names must match (all but the optional
  // p_org_id, last).
  assert(!calls.some((c) => c.name === "reconcile_item_raise"));
  const named = await migrationText("_reconcile_item_raise_named.sql");
  const namedParams = declaredParams(named, "reconcile_item_raise_named");
  assertEquals(namedParams.at(-1), "p_org_id");
  assertEquals(
    Object.keys(calls.find((c) => c.name === "reconcile_item_raise_named")!.args),
    namedParams.slice(0, -1),
  );

  // trade_invoice_lines job columns as created (20260325000003).
  const timer = await migrationText("_timer_invoice_system.sql");
  const lineTable = timer.slice(
    timer.indexOf("CREATE TABLE trade_invoice_lines ("),
  );
  const lineCols = lineTable.slice(0, lineTable.indexOf(");"));
  for (const col of selects.get("trade_invoice_lines")!) {
    assert(
      new RegExp(`\\b${col}\\b`).test(lineCols),
      `trade_invoice_lines.${col}`,
    );
  }
  assertEquals(selects.get("users"), ["id", "role"]);
});

Deno.test("pay run: an invoice released from the run is stopped there and out of its totals, even when the check reads it clean", async () => {
  const rows = [
    invoice(1, { pay_run_id: "run-1", status: "pushed_to_xero", xero_bill_id: "ZZTEST-BILL-1" }),
    // Released (cl-payrun-escape): back to review, no run id, no bill.
    invoice(2, { pay_run_id: null, status: "pending_ops_review" }),
  ];
  const out: any = await run({
    rows,
    run: { id: "run-1", week_start: WEEK },
    runInvoices: [
      { invoice_id: id(1), pushed_at: "2026-11-24T01:00:00Z" },
      { invoice_id: id(2), pushed_at: null, released_at: "2026-11-24T02:00:00Z" },
    ],
  }, APPROVER);
  const released = out.invoices.find((i: any) => i.invoice_id === id(2));
  assertEquals(released.verdict, "stopped");
  assertEquals(released.stops.map((x: any) => x.code), ["released_from_run"]);
  assertEquals(released.pushed, false);
  assertEquals(out.released_from_run, 1);
  assertEquals(out.counts.clean, 1);
  assertEquals(out.totals.super, 120);
  assertEquals(out.super_by_person.map((p: any) => p.super_amount), [120]);
});

Deno.test("pay run: a Xero bill a release press found shows on that run row, and only while it is neither pushed nor released", async () => {
  const found = {
    result: "found_in_xero",
    checked_by: APPROVER,
    checked_at: "2026-11-24T02:00:00Z",
    source: "ops_api_xero_lookup",
    searched_number: "ZZTEST-INV-2",
    bills_found: 1,
    bills: [{ xero_bill_id: "ZZTEST-XERO-BILL-2", number: "ZZTEST-INV-2", status: "DRAFT" }],
  };
  const rows = [
    invoice(1, { pay_run_id: "run-1", status: "pushed_to_xero", xero_bill_id: "ZZTEST-BILL-1" }),
    invoice(2, { pay_run_id: "run-1", status: "approved" }),
    invoice(3, { pay_run_id: null, status: "pending_ops_review" }),
  ];
  const out: any = await run({
    rows,
    run: { id: "run-1", week_start: WEEK },
    runInvoices: [
      { invoice_id: id(1), pushed_at: "2026-11-24T01:00:00Z", release_xero_found: found },
      { invoice_id: id(2), pushed_at: null, release_xero_found: found },
      { invoice_id: id(3), pushed_at: null, released_at: "2026-11-24T03:00:00Z", release_xero_found: found },
    ],
  }, APPROVER);
  const by = (n: number) => out.invoices.find((i: any) => i.invoice_id === id(n));
  const stop = by(2).stops.find((x: any) => x.code === "xero_bill_found_at_release");
  assertEquals(by(2).verdict, "stopped");
  assertEquals(
    stop.words,
    "Xero has a bill with this number or reference: ZZTEST-INV-2 (draft). Check it before releasing.",
  );
  assertEquals(by(1).stops.some((x: any) => x.code === "xero_bill_found_at_release"), false);
  assertEquals(by(3).stops.map((x: any) => x.code), ["released_from_run"]);
});

Deno.test("pay run: a run row whose push lapsed carries the director's search words; a live, pushed or released one does not", async () => {
  const rows = [1, 2, 3, 4, 5].map((n) => invoice(n, { pay_run_id: "run-1", status: "approved" }));
  const now = new Date("2026-11-24T02:00:00Z");
  const out: any = await readPayRun(reads({
    rows,
    run: { id: "run-1", week_start: WEEK },
    runInvoices: [
      // Lapsed: claimed 30 minutes ago, never given back.
      { invoice_id: id(1), pushed_at: null, push_claimed_at: "2026-11-24T01:30:00Z" },
      // Live: claimed 5 minutes ago.
      { invoice_id: id(2), pushed_at: null, push_claimed_at: "2026-11-24T01:55:00Z" },
      { invoice_id: id(3), pushed_at: "2026-11-24T01:31:00Z", push_claimed_at: "2026-11-24T01:30:00Z" },
      { invoice_id: id(4), pushed_at: null, push_claimed_at: "2026-11-24T01:30:00Z", released_at: "2026-11-24T01:50:00Z" },
      { invoice_id: id(5), pushed_at: null, push_claimed_at: null },
    ],
  }), { orgId: ORG, weekStart: WEEK, actorUserId: APPROVER, now });
  const has = (n: number) =>
    out.invoices.find((i: any) => i.invoice_id === id(n)).stops
      .filter((x: any) => x.code === "xero_search_before_release");
  const one = has(1);
  assertEquals(one.length, 1);
  const number = rows[0].invoice_number;
  assertEquals(
    one[0].words,
    `Xero is searched for bill number ${number} before release. If anyone changed this bill's number and reference in Xero by hand, the search will not find it: check Xero first.`,
  );
  for (const n of [2, 3, 4, 5]) assertEquals(has(n), []);
  assertEquals(out.invoices.find((i: any) => i.invoice_id === id(1)).verdict, "stopped");
});

Deno.test("pay run: the search words need a number, and are the director's words exactly", () => {
  assertEquals(xeroSearchBeforeReleaseNote(null), null);
  assertEquals(xeroSearchBeforeReleaseNote("  "), null);
  assertEquals(
    xeroSearchBeforeReleaseNote(" ZZTEST-7 ")?.words,
    "Xero is searched for bill number ZZTEST-7 before release. If anyone changed this bill's number and reference in Xero by hand, the search will not find it: check Xero first.",
  );
});

Deno.test("pay run: the found-bill words name each bill by number, else its Xero id, and never read a bad record", () => {
  assertEquals(xeroBillFoundStop(null), null);
  assertEquals(xeroBillFoundStop({ bills: [] }), null);
  assertEquals(xeroBillFoundStop({ bills: [{ number: " " }] }), null);
  assertEquals(
    xeroBillFoundStop({
      checked_at: "not a time",
      bills: [{ number: "ZZTEST-A", status: "PAID" }, { xero_bill_id: "ZZTEST-ID-B" }],
    })?.words,
    "Xero has a bill with this number or reference: ZZTEST-A (paid), ZZTEST-ID-B. Check it before releasing.",
  );
});

Deno.test("pay run: next week's read takes an invoice released from last week's run, clean", async () => {
  // Released from the 2026-11-16 run: back to review, no run id, no bill.
  const released = invoice(2, { pay_run_id: null, status: "pending_ops_review" });
  const out: any = await readPayRun(reads({ rows: [released] }), {
    orgId: ORG,
    weekStart: "2026-11-23",
    actorUserId: APPROVER,
    now: new Date("2026-12-02T02:00:00Z"),
  });
  assertEquals(out.invoices.map((i: any) => [i.invoice_id, i.verdict, i.week_start]), [
    [id(2), "clean", WEEK],
  ]);
  assertEquals(out.counts.clean, 1);
  assertEquals(out.totals.super, 240);
});
