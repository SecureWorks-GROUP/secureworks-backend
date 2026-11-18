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
};

function makeDeps(w: World) {
  const calls = {
    push: [] as string[],
    markPushed: [] as string[],
    markRunPushed: 0,
    markSuperPaid: [] as string[],
    reads: 0,
  };
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
            status: "approved",
            xero_bill_id: null,
            net_pay: 940,
            gst: 0,
            gst_on: false,
            recurring_deduction_amount: null,
          }
          : null,
      );
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
  return { deps, calls, rows };
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

Deno.test("push: a Xero failure records nothing, and the press can be repeated", async () => {
  let fail = true;
  const { deps, calls } = makeDeps({
    rows: twoClean(),
    push: () =>
      fail
        ? Promise.reject(new Error("xero 500"))
        : Promise.resolve({ success: true, xero_bill_id: "bill-a" }),
  });
  await assertRejects(() => press(deps, INV_A), Error, "xero 500");
  assertEquals([calls.markPushed.length, calls.markRunPushed], [0, 0]);
  fail = false;
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
        maybeSingle() {
          ops.push(op);
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
      return Promise.resolve(Response.json(null));
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
