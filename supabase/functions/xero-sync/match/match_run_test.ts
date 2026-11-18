// deno-lint-ignore-file no-explicit-any
// P2-02.7: the matcher runner. Fake client only; made-up amounts and ids.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  MATCH_BACKLOG_STATE_KEY,
  matchPending,
  matchPendingRequest,
  matchSweep,
  matchSweepRequest,
  proposalOnly,
  readMatcherSwitch,
  runMatchFor,
  syncMatchRun,
} from "./match_run.ts";

const JOB = "11111111-1111-4111-8111-111111111111";
const BILL = "bill-1";

const CLUE_TYPES = [
  ["job_number", "key", "doc_text", "counts"],
  ["order_number", "key", "order", "counts"],
  ["sealed_scope_order", "key", "order", "counts"],
  ["trade_app_link", "key", "trade_app", "counts"],
  ["order_amount", "clue", "order", "suggest_only"],
  ["delivery_address", "clue", "address", "suggest_only"],
  ["supplier_mail", "clue", "mail", "suggest_only"],
  ["learned_rule", "clue", "rule", "suggest_only"],
  ["overhead_account", "clue", "account", "suggest_only"],
  ["group_tag", "clue", "tag", "suggest_only"],
].map(([code, cls, family, mode]) => ({ code, class: cls, family, mode }));

type World = {
  lines?: Record<string, any[]>;
  orders?: any[];
  fail?: string; // a table whose read fails
  applyError?: Record<string, unknown>;
  queue?: any[];
  waiting?: Array<{ document_kind: string; document_id: string; created_at?: string; kind?: string }>; // needs_person lines
  openItems?: string[]; // subject_ids with an open item
  switchOn?: boolean | "fail";
  tradeUsers?: string[]; // xero_contact_ids that are Trade App users
  backlogAt?: { cursor_at: string | null; note: string | null } | null; // xero_sync_state row
  queries: Array<{ table: string; op: string }>;
  rpcs: Array<{ fn: string; args: any }>;
  upserts?: Array<{ table: string; rows: any; timed: boolean }>;
};

function fake(w: World) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let op = "select";
      let cols = "";
      let upserted: any = null;
      let timed = false;
      const result = () => {
        w.queries.push({ table, op });
        if (w.fail === table || w.fail === `${table}:${op}`) return { data: null, error: { code: "XX000" } };
        if (op === "upsert") {
          (w.upserts ??= []).push({ table, rows: upserted, timed });
          if (table === "xero_sync_state") w.backlogAt = { cursor_at: upserted.cursor_at, note: upserted.note };
          return { data: null, error: null };
        }
        switch (table) {
          case "feature_flags":
            if (w.switchOn === "fail") return { data: null, error: { code: "XX000" } };
            return { data: w.switchOn === undefined ? null : { enabled: w.switchOn }, error: null };
          case "xero_sync_state":
            return { data: w.backlogAt ?? null, error: null };
          case "users":
            return {
              data: (w.tradeUsers ?? []).filter((c) => c === filters.xero_contact_id).map((c) => ({ id: `u-${c}`, xero_contact_id: c })),
              error: null,
            };
          case "match_clue_types":
            return { data: CLUE_TYPES, error: null };
          case "job_cost_lines":
            if (filters.document_number) return { data: [], error: null };
            if (filters["in:kind"]) {
              // The backlog's labour read.
              const ids = filters["in:document_id"] as string[];
              const kinds = filters["in:kind"] as string[];
              return {
                data: (w.waiting ?? []).filter((r) => ids.includes(r.document_id) && kinds.includes(r.kind ?? ""))
                  .map((r) => ({ document_id: r.document_id })),
                error: null,
              };
            }
            if (cols.includes("created_at")) {
              // The backlog's oldest-first read.
              const rows = (w.waiting ?? [])
                .filter((r) => r.document_kind === filters.document_kind)
                .filter((r) => filters.created_at === undefined || r.created_at === filters.created_at)
                .filter((r) => filters["gt:document_id"] === undefined || r.document_id > String(filters["gt:document_id"]))
                .filter((r) => filters["gt:created_at"] === undefined || String(r.created_at) > String(filters["gt:created_at"]))
                .sort((a, b) =>
                  String(a.created_at) === String(b.created_at)
                    ? (a.document_id < b.document_id ? -1 : 1)
                    : (String(a.created_at) < String(b.created_at) ? -1 : 1)
                )
                .slice(0, Number(filters.limit ?? 1e9));
              return { data: rows.map((r) => ({ document_id: r.document_id, created_at: r.created_at })), error: null };
            }
            if (filters.state === "needs_person" && filters.document_id === undefined) {
              const rows = (w.waiting ?? [])
                .filter((r) => r.document_kind === filters.document_kind)
                .filter((r) => filters["lt:document_id"] === undefined || r.document_id < String(filters["lt:document_id"]))
                .sort((a, b) => (a.document_id < b.document_id ? 1 : -1))
                .slice(0, Number(filters.limit ?? 1e9));
              return { data: rows.map((r) => ({ document_id: r.document_id })), error: null };
            }
            return { data: w.lines?.[String(filters.document_id)] ?? [], error: null };
          case "xero_invoices":
            return {
              data: {
                xero_invoice_id: filters.xero_invoice_id,
                invoice_number: "INV-9",
                reference: "SWF-26123",
                xero_contact_id: "supplier-1",
                contact_name: "Supplier",
                invoice_date: "2026-11-10",
              },
              error: null,
            };
          case "jobs":
            return {
              data: [{
                id: JOB,
                job_number: "SWF-26123",
                status: "accepted",
                created_at: "2026-10-01T00:00:00Z",
                site_address: null,
                site_suburb: null,
                holding: null,
              }],
              error: null,
            };
          case "reconcile_items": {
            const asked = (filters["in:subject_id"] as string[]) ?? [];
            const hit = asked.filter((s) => (w.openItems ?? []).includes(s));
            return { data: hit.map((subject_id) => ({ subject_id })), error: null };
          }
          case "v_job_orders":
            return { data: w.orders ?? [], error: null };
          case "match_queue": {
            if (op === "delete") return { data: null, error: null };
            const prefix = String(filters["like:subject_id"] ?? "%").replace(/%$/, "");
            return { data: (w.queue ?? []).filter((r) => String(r.subject_id).startsWith(prefix)), error: null };
          }
          default:
            return { data: [], error: null };
        }
      };
      const chain: any = {
        select: (c = "") => ((cols = c), chain),
        delete: () => ((op = "delete"), chain),
        upsert: (rows: any) => ((op = "upsert"), (upserted = rows), chain),
        abortSignal: () => ((timed = true), chain),
        gt: (k: string, v: unknown) => ((filters[`gt:${k}`] = v), chain),
        eq: (k: string, v: unknown) => ((filters[k] = v), chain),
        like: (k: string, v: string) => ((filters[`like:${k}`] = v), chain),
        neq: () => chain,
        not: () => chain,
        or: () => chain,
        in: (k: string, v: unknown) => ((filters[`in:${k}`] = v), chain),
        lt: (k: string, v: unknown) => ((filters[`lt:${k}`] = v), chain),
        gte: () => chain,
        lte: () => chain,
        order: () => chain,
        limit: (n: number) => ((filters.limit = n), chain),
        maybeSingle: () => Promise.resolve(result()),
        then: (res: any, rej: any) => Promise.resolve(result()).then(res, rej),
      };
      return chain;
    },
    rpc(fn: string, args: any) {
      w.rpcs.push({ fn, args });
      if (fn === "match_apply") {
        return Promise.resolve(w.applyError ? { data: null, error: w.applyError } : { data: { applied: "shadow" }, error: null });
      }
      if (fn === "context_job_evidence_for_bills" && w.fail === fn) {
        return Promise.resolve({ data: null, error: { code: "XX000" } });
      }
      return Promise.resolve({ data: [], error: null });
    },
  };
}

const billLines = (id = BILL) => ({
  [id]: [{
    line_key: "n:1",
    line_no: 1,
    description: "Posts for SWF-26123",
    account_code: "300",
    xero_tracking_option: null,
    amount_ex: 500,
    state: "needs_person",
    document_number: "INV-9",
    document_date: "2026-11-10",
    party_id: "supplier-1",
    party_name: "Supplier",
  }],
});
const sealedOrder = {
  order_kind: "dispatch_order",
  order_id: "order-1",
  order_number: null,
  job_id: JOB,
  job_live: true,
  party_id: "supplier-1",
  party_name_key: "supplier",
  sent_on: "2026-11-01",
  cost_ex: 500,
  from_sealed_scope: true,
  matched: false,
};
const world = (over: Partial<World> = {}): World => ({ queries: [], rpcs: [], ...over });
const applies = (w: World) => w.rpcs.filter((r) => r.fn === "match_apply");
const requeues = (w: World) => (w.upserts ?? []).filter((u) => u.table === "match_queue");

Deno.test("job number and one fitting sealed order: two clues, sent as a proposal, never auto", async () => {
  const w = world({ lines: billLines(), orders: [sealedOrder] });
  const report = await runMatchFor(fake(w), [`xero_bill:${BILL}`], { ruleVersion: "v1" });
  const [call] = applies(w);
  assertEquals(call.args.p_result, {
    result: "suggest",
    reason: "office_confirms",
    outcome: "job",
    job_id: JOB,
    from_clue_index: 0,
    would_place: true,
    clue_indexes: [0, 1],
  });
  assertEquals(call.args.p_clues.map((c: any) => c.clue_code), ["job_number", "sealed_scope_order"]);
  assertEquals([call.args.p_item_kind, call.args.p_subject_id, call.args.p_rule_version], ["bill", `xero_bill:${BILL}`, "v1"]);
  assert(!w.rpcs.some((r) => r.fn === "match_apply" && r.args.p_result.result === "auto"));
  assertEquals(report.applied, { shadow: 1 });
});

Deno.test("job number only: a suggestion with one clue", async () => {
  const w = world({ lines: billLines() });
  await runMatchFor(fake(w), [`xero_bill:${BILL}`], { ruleVersion: "v1" });
  const r = applies(w)[0].args.p_result;
  assertEquals([r.result, r.reason, r.job_id, r.would_place], ["suggest", "one_clue", JOB, undefined]);
});

Deno.test("60 subjects: 50 run, 10 requeued", async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `xero_bill:b${i}`);
  const lines = Object.assign({}, ...ids.map((id) => billLines(id.slice(10))));
  const w = world({ lines });
  const report = await runMatchFor(fake(w), ids, { ruleVersion: "v1" });
  assertEquals([report.run, applies(w).length, report.requeued], [50, 50, 10]);
  // One statement for all ten, with a time limit; never one call per bill.
  assertEquals(requeues(w).length, 1);
  assert(requeues(w)[0].timed);
  assertEquals(requeues(w)[0].rows.map((r: any) => r.subject_id), ids.slice(50));
  assertEquals(new Set(requeues(w)[0].rows.map((r: any) => r.reason)), new Set(["over_run_cap"]));
  assert(!w.rpcs.some((r) => r.fn === "match_requeue"));
});

Deno.test("out of time: the rest wait in the queue", async () => {
  let t = 0;
  const w = world({ lines: Object.assign({}, billLines("a"), billLines("b")) });
  const report = await runMatchFor(fake(w), ["xero_bill:a", "xero_bill:b"], {
    ruleVersion: "v1",
    budgetMs: 5,
    now: () => (t += 10),
  });
  assertEquals([report.run, report.requeued], [0, 2]);
  assertEquals(applies(w).length, 0);
});

Deno.test("a failed read is not 'no clue': nothing applied, the bill requeued", async () => {
  for (const table of ["v_job_orders", "jobs", "job_cost_lines", "xero_invoices"]) {
    const w = world({ lines: billLines(), orders: [sealedOrder], fail: table });
    const report = await runMatchFor(fake(w), [`xero_bill:${BILL}`], { ruleVersion: "v1" });
    assertEquals(applies(w).length, 0, table);
    assertEquals(requeues(w)[0]?.rows[0]?.reason, "read_failed", table);
    assertEquals(Object.values(report.failed), [1], table);
  }
  const w = world({ fail: "match_clue_types" });
  const report = await runMatchFor(fake(w), [`xero_bill:${BILL}`], { ruleVersion: "v1" });
  assertEquals([applies(w).length, report.requeued, requeues(w).length], [0, 1, 1]);
});

Deno.test("only bills are matched; a credit or trade invoice is skipped", async () => {
  const w = world();
  const report = await runMatchFor(fake(w), ["xero_credit_note:c1", "trade_invoice:t1"], { ruleVersion: "v1" });
  assertEquals(report.skipped, { subject_not_a_bill: 2 });
  assertEquals(applies(w).length, 0);
});

Deno.test("match_pending: an empty queue makes exactly one query", async () => {
  const w = world({ queue: [] });
  assertEquals(await matchPending(fake(w)), { matched: 0 });
  assertEquals(w.queries.length, 1);
  assertEquals(w.rpcs.length, 0);
});

Deno.test("match_pending: queued bills are taken off the queue and run", async () => {
  const w = world({ queue: [{ subject_kind: "cost_document", subject_id: `xero_bill:${BILL}` }], lines: billLines() });
  const out = await matchPending(fake(w));
  assertEquals(out.matched, 1);
  assert(w.queries.some((q) => q.table === "match_queue" && q.op === "delete"));
  assertEquals(applies(w).length, 1);
});

Deno.test("proposalOnly leaves a suggestion or no clue as it is", () => {
  assertEquals(proposalOnly({ result: "none", reason: "no_clue" }), { result: "none", reason: "no_clue" });
  assertEquals(proposalOnly({ result: "suggest", reason: "one_clue" }).result, "suggest");
});

Deno.test("a bill with no line waiting for a person is left alone", async () => {
  const lines = billLines();
  lines[BILL][0].state = "on_job";
  const w = world({ lines });
  const report = await runMatchFor(fake(w), [`xero_bill:${BILL}`], { ruleVersion: "v1" });
  assertEquals(report.skipped, { nothing_waiting: 1 });
  assertEquals(applies(w).length, 0);
});

Deno.test("a failed evidence read requeues; a match_apply refusal is counted and not requeued, an unreadable switch is", async () => {
  const ev = world({ lines: billLines(), fail: "context_job_evidence_for_bills" });
  const r1 = await runMatchFor(fake(ev), [`xero_bill:${BILL}`], { ruleVersion: "v1" });
  assertEquals([applies(ev).length, r1.failed, r1.requeued], [0, { read_bill_evidence: 1 }, 1]);
  const refused = world({ lines: billLines(), applyError: { code: "P0001", message: "match_clue_root_required" } });
  const r2 = await runMatchFor(fake(refused), [`xero_bill:${BILL}`], { ruleVersion: "v1" });
  assertEquals([r2.failed, r2.requeued], [{ "apply:match_clue_root_required": 1 }, 0]);
  const off = world({ lines: billLines(), applyError: { code: "P0001", message: "match_switch_unreadable" } });
  const r3 = await runMatchFor(fake(off), [`xero_bill:${BILL}`], { ruleVersion: "v1" });
  assertEquals(r3.requeued, 1);
  const odd = world({ lines: billLines(), applyError: { code: "57014", message: "canceling statement" } });
  const r4 = await runMatchFor(fake(odd), [`xero_bill:${BILL}`], { ruleVersion: "v1" });
  assertEquals([r4.failed, r4.requeued], [{ apply_failed: 1 }, 1]);
});

Deno.test("match_pending never takes a queued credit off the queue", async () => {
  const w = world({ queue: [{ subject_kind: "cost_document", subject_id: "xero_credit_note:c1" }] });
  assertEquals(await matchPending(fake(w)), { matched: 0 });
  assert(!w.queries.some((q) => q.op === "delete"));
});

const waitingBills = (ids: string[]) => ids.map((document_id) => ({ document_kind: "xero_bill", document_id }));

Deno.test("match_sweep: a bill with an open item is left; a bill without one is run", async () => {
  const w = world({
    waiting: [...waitingBills(["b1", "b2"]), { document_kind: "xero_credit_note", document_id: "c1" }],
    openItems: ["xero_bill:b2"],
    lines: Object.assign({}, billLines("b1"), billLines("b2")),
  });
  const out = await matchSweep(fake(w));
  assertEquals(applies(w).map((a) => a.args.p_subject_id), ["xero_bill:b1"]);
  assertEquals([out.swept, out.with_open_item, out.run, out.done, out.next], [2, 1, 1, true, null]);
  // A waiting credit note is not swept: the read asks for bills only.
  assert(!applies(w).some((a) => String(a.args.p_subject_id).startsWith("xero_credit_note")));
});

Deno.test("match_sweep: 60 waiting bills, 50 a call; the next call picks up after the cursor", async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `b${String(i).padStart(2, "0")}`);
  const lines = Object.assign({}, ...ids.map((id) => billLines(id)));
  const w = world({ waiting: waitingBills(ids), lines });
  const first = await matchSweep(fake(w));
  assertEquals([first.swept, first.done, first.next, applies(w).length], [50, false, "b10", 50]);
  const w2 = world({ waiting: waitingBills(ids), lines });
  const second = await matchSweep(fake(w2), { after: String(first.next) });
  assertEquals([second.swept, second.done, second.next], [10, true, null]);
  assertEquals(applies(w2).map((a) => a.args.p_subject_id), ids.slice(0, 10).reverse().map((d) => `xero_bill:${d}`));
});

Deno.test("match_sweep: an unreadable item list or waiting list runs nothing and keeps the cursor", async () => {
  const items = world({ waiting: waitingBills(["b1"]), lines: billLines("b1"), fail: "reconcile_items" });
  const r1 = await matchSweep(fake(items), { after: "b9" });
  assertEquals([r1.error, r1.next, r1.done, applies(items).length], ["items_unreadable", "b9", false, 0]);
  const lines = world({ waiting: waitingBills(["b1"]), fail: "job_cost_lines" });
  const r2 = await matchSweep(fake(lines), { after: "b9" });
  assertEquals([r2.error, r2.next, applies(lines).length], ["lines_unreadable", "b9", 0]);
});

Deno.test("match_sweep: nothing waiting is done in one read", async () => {
  const w = world({ waiting: [] });
  assertEquals(await matchSweep(fake(w)), { swept: 0, with_open_item: 0, next: null, done: true });
  assertEquals(w.queries.length, 1);
});

Deno.test("match_sweep: out of time mid-sweep, the rest are requeued and the cursor still moves on", async () => {
  let t = 0;
  const w = world({ waiting: waitingBills(["a", "b"]), lines: Object.assign({}, billLines("a"), billLines("b")) });
  const out = await matchSweep(fake(w), { budgetMs: 5, now: () => (t += 10) });
  assertEquals([out.run, out.requeued, out.done], [0, 2, true]);
  assertEquals(requeues(w).length, 1);
  assertEquals(requeues(w)[0].rows.map((r: any) => r.reason), ["over_run_time", "over_run_time"]);
});

Deno.test("match_sweep door: only a POST with the exact server key; nothing read otherwise", async () => {
  const url = "https://x.invalid/xero-sync?action=match_sweep";
  for (const [method, auth, status] of [
    ["POST", "Bearer anon-or-user-jwt", 403],
    ["POST", null, 403],
    ["GET", "Bearer server-key", 405],
  ] as const) {
    const w = world({ waiting: waitingBills(["b1"]), lines: billLines("b1") });
    const headers: Record<string, string> = auth ? { authorization: auth } : {};
    const out = await matchSweepRequest(new Request(url, { method, headers }), fake(w), "server-key");
    assertEquals(out.status, status);
    assertEquals([w.queries.length, w.rpcs.length], [0, 0]);
  }
  const bad = await matchSweepRequest(
    new Request(`${url}&after=`, { method: "POST", headers: { authorization: "Bearer server-key" } }), fake(world()), "server-key");
  assertEquals(bad.status, 400);
  const w = world({ waiting: waitingBills(["b1"]), lines: billLines("b1") });
  const ok = await matchSweepRequest(
    new Request(url, { method: "POST", headers: { authorization: "Bearer server-key" } }), fake(w), "server-key");
  assertEquals([ok.status, ok.body.swept, ok.body.done], [200, 1, true]);
  // An empty server key refuses everyone.
  assertEquals((await matchSweepRequest(new Request(url, { method: "POST", headers: { authorization: "Bearer " } }), fake(world()), "")).status, 403);
});

// ── The sync step (director 01:03) ──────────────────────────────────────────

const throwingClient = () =>
  new Proxy({}, {
    get() {
      throw new Error("the matcher touched the database with the switch off");
    },
  });

Deno.test("sync, switch off: no matcher read or write at all, whatever changed", async () => {
  const out = await syncMatchRun(throwingClient(), { on: false, changed: ["xero_bill:a", "xero_bill:b"] });
  assertEquals([out.switch, out.run, out.requeued, out.changed, out.backlog], ["off", 0, 0, 0, 0]);
});

Deno.test("sync: the switch is read once; missing, off or unreadable is off", async () => {
  for (const [on, want] of [[true, { on: true }], [false, { on: false }], [undefined, { on: false }], ["fail", { on: false, error: "matcher_switch_unreadable" }]] as const) {
    const w = world({ switchOn: on as any });
    assertEquals(await readMatcherSwitch(fake(w)), want);
    assertEquals(w.queries.map((q) => q.table), ["feature_flags"]);
  }
  const thrower = { from: () => { throw new Error("x"); } };
  assertEquals(await readMatcherSwitch(thrower), { on: false, error: "matcher_switch_unreadable" });
});

Deno.test("sync: index.ts reads the switch before the paging, collects changed bills only when on, and matches once after the paging", () => {
  const src = Deno.readTextFileSync(new URL("../index.ts", import.meta.url));
  const fn = src.slice(src.indexOf("async function syncInvoices("));
  const readAt = fn.indexOf("await readMatcherSwitch(sb)");
  const costSwitchAt = fn.indexOf("'job_cost_lines_sync_v1'");
  const pagingAt = fn.indexOf("hasMore = invoices.length === 100");
  const cursorAt = fn.indexOf("key: 'sync_invoices', cursor_at: runStartedAt");
  const stepAt = fn.indexOf("syncMatchStep(sb, { on: true, changed: [...matchChanged] })");
  assert(readAt > 0 && readAt < costSwitchAt, "switch read at the start, beside the cost-line switch");
  assert(stepAt > pagingAt && stepAt > cursorAt, "matching after the Xero paging");
  assertEquals(fn.split("syncMatchStep(").length - 1, 1, "one matcher step a sync");
  assertEquals(fn.split("syncMatchRun(").length - 1, 0, "bills and credits through the one step");
  assert(!/runMatchFor\(/.test(src), "no per-page runner call");
  assert(/if \(matcher\.on\) \{\s*for \(const id of data\?\.changed/.test(fn), "changed bills collected only when on");
  assert(/if \(matcher\.on\) \{\s*try \{\s*matchRun = await syncMatchStep/.test(fn), "the step runs only when on");
});

Deno.test("sync, switch on: 60 changed bills, 50 run, 10 requeued in one timed statement, no queue or backlog read", async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `xero_bill:b${String(i).padStart(2, "0")}`);
  const w = world({ lines: Object.assign({}, ...ids.map((id) => billLines(id.slice(10)))) });
  const out = await syncMatchRun(fake(w), { on: true, changed: [...ids, "xero_credit_note:c1"] });
  assertEquals([out.run, out.changed, out.queued, out.backlog, out.requeued], [50, 50, 0, 0, 10]);
  assertEquals(requeues(w).length, 1);
  assert(requeues(w)[0].timed);
  assertEquals(requeues(w)[0].rows.map((r: any) => [r.subject_id, r.reason]), ids.slice(50).map((id) => [id, "over_run_cap"]));
  assert(!w.queries.some((q) => q.table === "match_queue" && q.op === "select"));
  assert(!w.queries.some((q) => q.table === "xero_sync_state"));
});

Deno.test("sync, switch on: the budget starts when matching starts; out of time, the rest are one requeue", async () => {
  // The clock is already far past any start-of-sync time: the step still runs.
  let t = 9_000_000;
  const w = world({ lines: Object.assign({}, billLines("a"), billLines("b"), billLines("c")) });
  const out = await syncMatchRun(fake(w), {
    on: true,
    changed: ["xero_bill:a", "xero_bill:b", "xero_bill:c"],
    budgetMs: 25,
    now: () => (t += 10),
  });
  assertEquals(out.run, 1);
  assertEquals(requeues(w).length, 1);
  assertEquals(requeues(w)[0].rows.map((r: any) => r.reason), ["over_run_time", "over_run_time"]);
});

Deno.test("sync, switch on: queued bills are taken off the queue and run in the same 50", async () => {
  const w = world({
    queue: [{ subject_kind: "cost_document", subject_id: "xero_bill:q1" }],
    lines: Object.assign({}, billLines("a"), billLines("q1")),
    waiting: [],
  });
  const out = await syncMatchRun(fake(w), { on: true, changed: ["xero_bill:a"] });
  assertEquals([out.changed, out.queued, out.run], [1, 1, 2]);
  assert(w.queries.some((q) => q.table === "match_queue" && q.op === "delete"));
  assertEquals(applies(w).map((a) => a.args.p_subject_id), ["xero_bill:a", "xero_bill:q1"]);
});

const at = (n: number) => `2026-11-1${n}T00:00:00.123456+00:00`;
const waitingAt = (id: string, n: number, kind = "supplier_bill") => ({ document_kind: "xero_bill", document_id: id, created_at: at(n), kind });

Deno.test("sync backlog: up to 50 oldest waiting BILLS (not lines) with no open item and no labour line; the position moves and wraps", async () => {
  // 60 bills written in one statement (one created_at), each with three
  // waiting lines, plus older bills with an open item or a labour line.
  const tied = Array.from({ length: 60 }, (_, i) => `t${String(i).padStart(2, "0")}`);
  const waiting = [
    waitingAt("old-open", 1), waitingAt("old-labour", 1), waitingAt("old-labour", 1, "installer_bill"),
    ...tied.flatMap((id) => [waitingAt(id, 2), waitingAt(id, 2), waitingAt(id, 2)]),
  ];
  const lines = Object.assign({}, ...waiting.map((r) => billLines(r.document_id)));
  const w = world({ waiting, openItems: ["xero_bill:old-open"], lines, backlogAt: null });
  const first = await syncMatchRun(fake(w), { on: true, changed: [] });
  assertEquals([first.backlog, first.run, first.requeued], [50, 50, 0]);
  const ran = applies(w).map((a) => a.args.p_subject_id);
  assertEquals(ran, tied.slice(0, 50).map((id) => `xero_bill:${id}`), "oldest first, ties by id, each bill once; open-item and labour bills passed over");
  assertEquals(w.backlogAt, { cursor_at: at(2), note: "t49" }, "kept exactly as read");

  // The next run starts after t49 on the same instant, then reaches the end.
  const w2 = world({ waiting, openItems: ["xero_bill:old-open"], lines, backlogAt: w.backlogAt });
  const second = await syncMatchRun(fake(w2), { on: true, changed: [] });
  assertEquals(applies(w2).map((a) => a.args.p_subject_id), tied.slice(50).map((id) => `xero_bill:${id}`));
  assertEquals(second.backlog, 10);
  assertEquals(w2.backlogAt, { cursor_at: null, note: null }, "the end: start again from the oldest");
});

Deno.test("sync backlog: the budget ends mid-backlog: it stops cleanly, requeues no backlog bill, and the next run starts at the first bill not reached", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `b${i}`);
  const waiting = ids.map((id, i) => waitingAt(id, i < 5 ? 1 : 2));
  const lines = Object.assign({}, ...ids.map((id) => billLines(id)));
  let t = 0;
  // Each clock read costs 10 ms; the budget lets three bills run.
  const w = world({ waiting, lines, backlogAt: null });
  const out = await syncMatchRun(fake(w), { on: true, changed: [], budgetMs: 45, now: () => (t += 10) });
  assertEquals([out.run, out.backlog, out.requeued], [3, 3, 0]);
  assertEquals(requeues(w).length, 0, "a backlog bill not reached is not put on the queue");
  assertEquals(w.backlogAt, { cursor_at: at(1), note: "b2" }, "the position stops at the last bill run");
  const w2 = world({ waiting, lines, backlogAt: w.backlogAt });
  await syncMatchRun(fake(w2), { on: true, changed: [] });
  assertEquals(applies(w2)[0].args.p_subject_id, "xero_bill:b3");
  // Nothing reached at all: the position does not move.
  const w3 = world({ waiting, lines, backlogAt: { cursor_at: at(1), note: "b2" } });
  let t3 = 0;
  const none = await syncMatchRun(fake(w3), { on: true, changed: [], budgetMs: 15, now: () => (t3 += 10) });
  assertEquals([none.run, none.backlog], [0, 0]);
  assertEquals(w3.backlogAt, { cursor_at: at(1), note: "b2" });
});

Deno.test("sync backlog: a bill already run this sync is passed over; a failed open-item or position read takes nothing and keeps the position", async () => {
  const waiting = [waitingAt("x1", 1), waitingAt("x2", 1)];
  const lines = Object.assign({}, billLines("x1"), billLines("x2"));
  const w = world({ waiting, lines, backlogAt: null });
  const out = await syncMatchRun(fake(w), { on: true, changed: ["xero_bill:x1"] });
  assertEquals(applies(w).map((a) => a.args.p_subject_id), ["xero_bill:x1", "xero_bill:x2"]);
  assertEquals([out.changed, out.backlog], [1, 1]);
  for (const fail of ["reconcile_items", "xero_sync_state"]) {
    const pos = { cursor_at: at(0), note: "x0" };
    const bad = world({ waiting, lines, backlogAt: { ...pos }, fail });
    const r = await syncMatchRun(fake(bad), { on: true, changed: [] });
    assertEquals([r.backlog, applies(bad).length], [0, 0], fail);
    assertEquals(r.errors.length, 1, fail);
    assertEquals(bad.backlogAt, pos, fail);
  }
});

Deno.test("an installer-account line or a Trade App user's own bill is labour too: never matched", async () => {
  const acct: Record<string, any[]> = billLines();
  acct[BILL][0].account_code = "306";
  const w1 = world({ lines: acct });
  assertEquals((await runMatchFor(fake(w1), [`xero_bill:${BILL}`], { ruleVersion: "v1" })).skipped, { labour_bill: 1 });
  const w2 = world({ lines: billLines(), tradeUsers: ["supplier-1"] });
  const r2 = await runMatchFor(fake(w2), [`xero_bill:${BILL}`], { ruleVersion: "v1" });
  assertEquals([r2.skipped, applies(w2).length], [{ labour_bill: 1 }, 0]);
  assert(!w2.queries.some((q) => q.table === "xero_invoices"));
  // An unreadable user list is not "not a person": the bill is requeued.
  const w3 = world({ lines: billLines(), fail: "users" });
  const r3 = await runMatchFor(fake(w3), [`xero_bill:${BILL}`], { ruleVersion: "v1" });
  assertEquals([r3.failed, r3.requeued, applies(w3).length], [{ read_trade_user: 1 }, 1, 0]);
});

Deno.test("sync, switch on: a queued bill the sync also changed comes off the queue and runs once", async () => {
  const w = world({
    queue: [{ subject_kind: "cost_document", subject_id: "xero_bill:a" }],
    lines: billLines("a"),
    waiting: [],
  });
  const out = await syncMatchRun(fake(w), { on: true, changed: ["xero_bill:a"] });
  assertEquals([out.changed, out.queued, out.run, applies(w).length], [1, 0, 1, 1]);
  assert(w.queries.some((q) => q.table === "match_queue" && q.op === "delete"));
});

Deno.test("a bill with a person's labour on it is never matched: no bill read, no clue, no shadow row", async () => {
  for (const kind of ["installer_bill", "employer_super"]) {
    const lines: Record<string, any[]> = billLines();
    lines[BILL].push({ ...lines[BILL][0], line_key: "n:2", line_no: 2, kind });
    const w = world({ lines });
    const report = await runMatchFor(fake(w), [`xero_bill:${BILL}`], { ruleVersion: "v1" });
    assertEquals(report.skipped, { labour_bill: 1 }, kind);
    assertEquals(applies(w).length, 0, kind);
    assert(!w.queries.some((q) => q.table === "xero_invoices"), kind);
  }
});

Deno.test("match_pending door: only a POST with the exact server key; nothing read otherwise", async () => {
  const url = "https://x.invalid/xero-sync?action=match_pending";
  for (const [method, auth, key, status] of [
    ["POST", "Bearer anon-or-user-jwt", "server-key", 403],
    ["POST", null, "server-key", 403],
    ["GET", "Bearer server-key", "server-key", 405],
    ["POST", "Bearer ", "", 403],
  ] as const) {
    const w = world({ queue: [{ subject_kind: "cost_document", subject_id: `xero_bill:${BILL}` }], lines: billLines() });
    const headers: Record<string, string> = auth ? { authorization: auth } : {};
    const out = await matchPendingRequest(new Request(url, { method, headers }), fake(w), key);
    assertEquals(out.status, status);
    assertEquals([w.queries.length, w.rpcs.length], [0, 0]);
  }
  const w = world({ queue: [{ subject_kind: "cost_document", subject_id: `xero_bill:${BILL}` }], lines: billLines() });
  const ok = await matchPendingRequest(
    new Request(url, { method: "POST", headers: { authorization: "Bearer server-key" } }), fake(w), "server-key");
  assertEquals([ok.status, ok.body.matched], [200, 1]);
  assertEquals(MATCH_BACKLOG_STATE_KEY, "match_backlog");
});
