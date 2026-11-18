// deno-lint-ignore-file no-explicit-any
// P2-02.7: the matcher runner. Fake client only; made-up amounts and ids.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { matchPending, proposalOnly, runMatchFor } from "./match_run.ts";

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
  queries: Array<{ table: string; op: string }>;
  rpcs: Array<{ fn: string; args: any }>;
};

function fake(w: World) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let op = "select";
      const result = () => {
        w.queries.push({ table, op });
        if (w.fail === table) return { data: null, error: { code: "XX000" } };
        switch (table) {
          case "match_clue_types":
            return { data: CLUE_TYPES, error: null };
          case "job_cost_lines":
            if (filters.document_number) return { data: [], error: null };
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
        select: () => chain,
        delete: () => ((op = "delete"), chain),
        eq: (k: string, v: unknown) => ((filters[k] = v), chain),
        like: (k: string, v: string) => ((filters[`like:${k}`] = v), chain),
        neq: () => chain,
        not: () => chain,
        or: () => chain,
        in: () => chain,
        gte: () => chain,
        lte: () => chain,
        order: () => chain,
        limit: () => chain,
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
  const requeued = w.rpcs.filter((r) => r.fn === "match_requeue");
  assertEquals(requeued.map((r) => r.args.p_subject_id), ids.slice(50));
  assertEquals(requeued[0].args.p_reason, "over_run_cap");
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
    assertEquals(w.rpcs.filter((r) => r.fn === "match_requeue")[0]?.args.p_reason, "read_failed", table);
    assertEquals(Object.values(report.failed), [1], table);
  }
  const w = world({ fail: "match_clue_types" });
  const report = await runMatchFor(fake(w), [`xero_bill:${BILL}`], { ruleVersion: "v1" });
  assertEquals([applies(w).length, report.requeued], [0, 1]);
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
