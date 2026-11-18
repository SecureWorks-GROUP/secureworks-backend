// deno-lint-ignore-file no-explicit-any no-import-prefix
// cl-1622-fix, director ruling 14:35 (option A): a pay run's invoice keeps its
// status and carries pay_run_id; every old door refuses it through one helper;
// only the run's own push moves it. Every id and figure is made up.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  invoiceIsRunHeld,
  PAY_RUN_HELD_CODE,
  PAY_RUN_HOLD_UNREADABLE_CODE,
  payRunHeldRefusalFor,
} from "./trade_pay_run_hold.ts";
import { rejectTradeInvoiceStorage } from "./trade_invoice_rejection.ts";
import {
  JobWorkOrderOfficeError,
  reviewCrewInvoiceLine,
} from "./job_work_order_office.ts";
import { readyUnreleasedGroupInvoiceIds } from "./group_work_order.ts";
import { canEnterPushTradeInvoiceToXero } from "./xero_attachment.ts";

const RUN = "0b300000-0000-4000-8000-000000000001";
const OTHER_RUN = "0b300000-0000-4000-8000-000000000002";
const INV = "0c400000-0000-4000-8000-00000000000a";
const LINE = "0c500000-0000-4000-8000-00000000000a";

type Answer = { data?: any; error?: any; throws?: boolean };

/** A small PostgREST stand-in: answers by table (and op), records filters. */
function fakeClient(answers: Record<string, Answer | Answer[]>) {
  const ops: any[] = [];
  const used: Record<string, number> = {};
  const take = (key: string): Answer => {
    const a = answers[key];
    if (!Array.isArray(a)) return a ?? { data: null, error: null };
    const n = used[key] ?? 0;
    used[key] = n + 1;
    return a[Math.min(n, a.length - 1)];
  };
  return {
    ops,
    from(table: string) {
      const op: any = { table, kind: "select", filters: [] as any[] };
      ops.push(op);
      const answer = () => {
        const a = take(`${table}.${op.kind}`);
        if (a.throws) throw new Error("ZZTEST network");
        return { data: a.data ?? null, error: a.error ?? null };
      };
      const q: any = {
        select(cols: string) {
          op.select = cols;
          return q;
        },
        update(p: any) {
          op.kind = "update";
          op.update = p;
          return q;
        },
        eq(c: string, v: unknown) {
          op.filters.push(["eq", c, v]);
          return q;
        },
        neq(c: string, v: unknown) {
          op.filters.push(["neq", c, v]);
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
        not(c: string, o: string, v: unknown) {
          op.filters.push(["not", c, o, v]);
          return q;
        },
        order() {
          return q;
        },
        limit() {
          return q;
        },
        range() {
          return q;
        },
        maybeSingle() {
          return Promise.resolve().then(answer);
        },
        then(res: any, rej: any) {
          return Promise.resolve().then(answer).then(res, rej);
        },
      };
      return q;
    },
    rpc(name: string) {
      ops.push({ rpc: name });
      const a = take(`rpc.${name}`);
      return Promise.resolve({ data: a.data ?? null, error: a.error ?? null });
    },
  };
}

// ── The one rule ───────────────────────────────────────────────────────────

Deno.test("rule: an invoice is the run's once the run stamped its id, whatever its status", () => {
  assertEquals(invoiceIsRunHeld({ pay_run_id: RUN }), true);
  assertEquals(invoiceIsRunHeld({ pay_run_id: null }), false);
  assertEquals(invoiceIsRunHeld({ pay_run_id: "" }), false);
  assertEquals(invoiceIsRunHeld({}), false);
});

Deno.test("rule on the door's own row: held is 409, free is null, a missing invoice is the door's own 404", () => {
  const held = payRunHeldRefusalFor({ id: INV, pay_run_id: RUN });
  assertEquals([held?.code, held?.status], [PAY_RUN_HELD_CODE, 409]);
  assertEquals(payRunHeldRefusalFor({ id: INV, pay_run_id: null }), null);
  assertEquals(payRunHeldRefusalFor(null), null);
});

Deno.test("rule: a row read without pay_run_id refuses 503, never reads as free", () => {
  const refusal = payRunHeldRefusalFor({ id: INV, status: "approved" });
  assertEquals([refusal?.code, refusal?.status], [PAY_RUN_HOLD_UNREADABLE_CODE, 503]);
});

Deno.test("rule: only the run's own push passes, and only for its own run", () => {
  assertEquals(payRunHeldRefusalFor({ pay_run_id: RUN }, { runPushFor: RUN }), null);
  assertEquals(payRunHeldRefusalFor({ pay_run_id: RUN }, { runPushFor: OTHER_RUN })?.code, PAY_RUN_HELD_CODE);
});

// ── Doors, by behaviour ────────────────────────────────────────────────────

Deno.test("reject storage: the plain write never takes a pay run's invoice", async () => {
  const c = fakeClient({
    "feature_flags.select": { data: { enabled: false } },
    "trade_invoices.update": { data: null },
  });
  await rejectTradeInvoiceStorage(c, INV, "ZZTEST note", "ZZTEST actor");
  const write = c.ops.find((o) => o.kind === "update");
  assert(write.filters.some((f: any[]) => f[0] === "is" && f[1] === "pay_run_id" && f[2] === null));
});

Deno.test("line review: a line on a pay run's invoice is refused before any line or invoice write", async () => {
  const c = fakeClient({
    "trade_invoice_lines.select": {
      data: {
        id: LINE,
        trade_invoice_id: INV,
        office_review_status: "awaiting",
        trade_invoices: { id: INV, status: "pending_ops_review", user_id: null, xero_bill_id: null, query_note: null, pay_run_id: RUN },
      },
    },
    "work_order_settings.select": { data: { approver_user_ids: [], backup_approver_user_ids: [] } },
    "feature_flags.select": { data: [{ enabled: true }] },
  });
  const err = await assertRejects(
    () => reviewCrewInvoiceLine(c, { line_id: LINE, decision: "approve" }, { staff: true, userId: "0a200000-0000-4000-8000-000000000009", label: "ZZTEST" } as any),
    JobWorkOrderOfficeError,
  );
  assertEquals((err as any).code, PAY_RUN_HELD_CODE);
  assertEquals(c.ops.filter((o) => o.kind === "update").length, 0);
  // The run is read off the line's own invoice embed: no extra read.
  assert(String(c.ops[0].select).includes("pay_run_id"));
  assertEquals(c.ops.filter((o) => o.table === "trade_invoices").length, 0);
});

Deno.test("crew release timer: the sweep's invoice read leaves out every pay run invoice (condition iii)", async () => {
  const SHARE = "0c600000-0000-4000-8000-00000000000a";
  const GROUP = "0c700000-0000-4000-8000-00000000000a";
  const c = fakeClient({
    "feature_flags.select": { data: [{ enabled: true }] },
    "group_work_orders.select": {
      data: [{ id: GROUP, pay_basis: "all_in_12_v2", status: "issued", split_frozen_at: "2026-11-18T00:00:00Z" }],
    },
    "group_work_order_releases.select": { data: [] },
    "rpc.group_work_order_release_state": { data: { ready: true, released: false } },
    "group_work_order_shares.select": { data: [{ id: SHARE }] },
    "trade_invoice_lines.select": { data: [{ trade_invoice_id: INV }] },
    // The database applies the filter; a stamped invoice is not returned.
    "trade_invoices.select": { data: [] },
  });
  assertEquals(await readyUnreleasedGroupInvoiceIds(c), []);
  const read = c.ops.find((o) => o.table === "trade_invoices");
  assert(read, "the sweep reads the group's invoices");
  assert(read.filters.some((f: any[]) => f[0] === "is" && f[1] === "pay_run_id" && f[2] === null));
});

// ── Doors, by source (each old door asks the one helper) ──────────────────

const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const caseBody = (name: string) => {
  const at = src.indexOf(`case '${name}': {`);
  assert(at > 0, `case ${name}`);
  return src.slice(at, src.indexOf("\n      case '", at + 10));
};

Deno.test("doors: office approve asks the helper before its write, which is pay_run_id-guarded", () => {
  const body = caseBody("approve_trade_invoice");
  assert(body.includes(".select('id, status, invoice_kind, pay_run_id')"));
  const ask = body.indexOf("const aprHold = payRunHeldRefusalFor(aprInv)");
  const write = body.indexOf(".update({ status: 'approved'");
  assert(ask > 0 && write > ask);
  assert(body.indexOf(".is('pay_run_id', null)", write) > write);
});

Deno.test("doors: office reject asks the helper before the storage write", () => {
  const body = caseBody("reject_trade_invoice");
  assert(body.includes("xero_pushed_at, pay_run_id')"));
  const ask = body.indexOf("payRunHeldRefusalFor(rejInv)");
  const write = body.indexOf("await rejectTradeInvoiceStorage(");
  assert(ask > 0 && write > ask);
});

Deno.test("doors: every push (office, crew siblings, line review, sweep, a crewmate's send) starts with the helper", () => {
  const head = src.indexOf("async function pushTradeInvoiceToXeroAction(");
  const fnBody = src.slice(head, src.indexOf("\n}\n", head));
  const ask = fnBody.indexOf(
    "payRunHeldRefusalFor(inv, { runPushFor: opts.payRunId })",
  );
  // On the invoice row it already reads ('*' carries pay_run_id), before
  // the lines, the group release or Xero.
  const invRead = fnBody.indexOf("let { data: inv } = await readInvoice()");
  const linesRead = fnBody.indexOf("client.from('trade_invoice_lines')");
  assert(invRead > 0 && ask > invRead && ask < linesRead, "rule after the invoice read, before the lines");
  // The run's id reaches the push only from push_pay_run_invoice, as an argument.
  assertEquals(src.split("{ payRunId: runId }").length - 1, 1);
  assert(!/payRunId:\s*body/.test(src), "never from a request body");
});

Deno.test("run push: a Xero failure leaves the run's invoice at approved, which the run's next press can push again once its claim lapses", () => {
  const head = src.indexOf("async function pushTradeInvoiceToXeroAction(");
  const fnBody = src.slice(head, src.indexOf("\n}\n", head));
  // The push never marks its own failure: it throws, so the retry mark (which
  // refuses a run's invoice) is never reached from the run's push.
  assert(!fnBody.includes("markTradeInvoiceRetryable("), "the push itself never calls the retry mark");
  // The run's move left it approved, and approved can enter the push again.
  assert(canEnterPushTradeInvoiceToXero("approved", null));
});

Deno.test("doors: the retry mark and the trade's line acknowledgement never move a pay run's invoice", async () => {
  const retry = src.slice(src.indexOf("async function markTradeInvoiceRetryable("));
  assert(retry.slice(0, 600).includes(".is('pay_run_id', null)"));
  const ack = await Deno.readTextFile(new URL("./trade_invoice_line_ack.ts", import.meta.url));
  const move = ack.indexOf('.update({ status: "acknowledged"');
  assert(move > 0 && ack.indexOf('.is("pay_run_id", null)', move) > move);
  const office = await Deno.readTextFile(new URL("./job_work_order_office.ts", import.meta.url));
  for (const status of ['"ops-reject"', '"approved"']) {
    const at = office.indexOf(`.update({ status: ${status}`);
    assert(at > 0 && office.indexOf('.is("pay_run_id", null)', at) > at, status);
  }
});

// ── Every trade_invoices writer is accounted for ──────────────────────────
//
// A new update or delete of trade_invoices fails here until it is added with
// why it cannot move a pay run's invoice (pending_ops_review or queried, with
// pay_run_id and no bill).

const WRITERS: Record<string, string> = {
  "ops-api/index.ts noteTradeRecurringDeductionNotTaken update": "note only, no status",
  "ops-api/index.ts checkpointTradeInvoiceXeroIdentity update": "inside a push, which the helper gates",
  "ops-api/index.ts markTradeInvoiceXeroSplitReconciled update": "inside a push, which the helper gates",
  "ops-api/index.ts markTradeInvoiceRetryable update": "pay_run_id is null filter",
  "ops-api/index.ts approve_trade_invoice update": "helper, then pay_run_id is null filter",
  "ops-api/index.ts raise update": "work order hold: from draft only",
  "ops-api/index.ts save_trade_invoice_draft delete": "removes the replacement draft it just made",
  "ops-api/index.ts delete_trade_invoice delete": "draft only",
  "ops-api/index.ts generate_trade_invoice delete": "removes the invoice it just made",
  "ops-api/index.ts generate_trade_invoice update x6": "the invoice this send just made (no run id yet)",
  "ops-api/job_work_order_office.ts reviewCrewInvoiceLine update x2": "helper, then pay_run_id is null filter",
  "ops-api/trade_invoice_line_ack.ts acknowledgeTradeInvoiceLine update": "pay_run_id is null filter",
  "ops-api/trade_invoice_rejection.ts rejectTradeInvoiceStorage update": "door asks the helper; plain write pay_run_id is null",
  "ops-api/trade_invoice_stuck.ts markTradeInvoiceReadyForXero update": "from pending_acknowledgment only",
  "ops-api/trade_invoice_stuck.ts resolveStuckTradeInvoice update": "from pending_acknowledgment only",
  "ops-api/trade_invoice_voided_release.ts writeRelease update": "needs a Xero bill, which a waiting run invoice has not",
  "ops-api/trade_line_send.ts deleteHoldingInvoice delete": "a holding invoice this send just made (invoice_kind held, never in a run)",
  "ops-api/trade_line_send.ts releaseStandardInvoice update": "the standard invoice this send just made, before any run could stamp it",
  "ops-api/trade_line_send.ts saveHoldingInvoice update": "a holding invoice this send just made, draft to pending_ops_review only",
  "ops-api/trade_line_send.ts stampStandardSend update": "send_id only, on the invoice this send just made",
  "ops-api/trade_pay_run.ts payRunPushDepsFromClient update": "the run's own push (its own run id)",
  "ops-api/trade_pay_run_wait.ts holdTradeInvoiceForPayRun update": "from the saved status at send only",
  "xero-sync/index.ts sweepTradeBillPdfs update": "keyed on a Xero bill",
  "xero-sync/index.ts syncInvoices update x2": "keyed on a Xero bill",
  "xero-sync/trade_bill_status.ts catchUpTradeBillStatusFromMirror update x2": "keyed on a Xero bill",
};

Deno.test("writers: every update, upsert or delete of trade_invoices in the edge functions is on the list", async () => {
  const root = new URL("../", import.meta.url);
  const files: string[] = [];
  const walk = async (rel: string) => {
    for await (const e of Deno.readDir(new URL(rel || ".", root))) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) await walk(path);
      else if (e.name.endsWith(".ts") && !e.name.endsWith("_test.ts")) files.push(path);
    }
  };
  await walk("");
  const counts = new Map<string, number>();
  for (const file of files.sort()) {
    const s = await Deno.readTextFile(new URL(file, root));
    const re = /\.from\(\s*['"]trade_invoices['"]\s*\)\s*\.(update|upsert|delete)\(/g;
    for (const m of s.matchAll(re)) {
      const before = s.slice(0, m.index);
      const names = [...before.matchAll(/(?:async\s+)?function\s+(\w+)|case\s+'([a-z0-9_]+)'\s*:/g)];
      const last = names[names.length - 1];
      const key = `${file} ${last ? last[1] ?? last[2] : "?"} ${m[1]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const found = [...counts].map(([k, n]) => (n > 1 ? `${k} x${n}` : k)).sort();
  assertEquals(found, Object.keys(WRITERS).sort());
});
