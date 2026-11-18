// deno-lint-ignore-file no-explicit-any
// The unallocated credit raiser. Fake client only; made-up ids and amounts.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CREDIT_REASON, creditSweep, creditSweepRequest } from "./credit_run.ts";

const JOB = "11111111-1111-4111-8111-111111111111";
const ORG = "00000000-0000-0000-0000-000000000001";

const CLUE_TYPES = [
  ["job_number", "key", "doc_text", "counts"],
].map(([code, cls, family, mode]) => ({ code, class: cls, family, mode }));

type World = {
  lines?: Record<string, any[]>; // credit id -> its cost lines
  notes?: Record<string, any>; // credit id -> xero_supplier_credit_notes row
  openItems?: string[];
  tradeUsers?: string[];
  fail?: string;
  applyError?: Record<string, unknown>;
  queries: Array<{ table: string; filters: Record<string, unknown> }>;
  rpcs: Array<{ fn: string; args: any }>;
};

function fake(w: World) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const result = () => {
        w.queries.push({ table, filters });
        if (w.fail === table) return { data: null, error: { code: "XX000" } };
        switch (table) {
          case "match_clue_types":
            return { data: CLUE_TYPES, error: null };
          case "job_cost_lines": {
            if (filters.document_id !== undefined) {
              return { data: w.lines?.[String(filters.document_id)] ?? [], error: null };
            }
            // The sweep's selector.
            const rows = Object.entries(w.lines ?? {}).flatMap(([id, ls]) =>
              ls.filter((l) =>
                filters.document_kind === "xero_credit_note" && l.line_key === filters.line_key &&
                l.state === filters.state && l.needs_reason === filters.needs_reason
              ).map(() => ({ document_id: id }))
            ).filter((r) => filters["lt:document_id"] === undefined || r.document_id < String(filters["lt:document_id"]))
              .sort((a, b) => (a.document_id < b.document_id ? 1 : -1))
              .slice(0, Number(filters.limit ?? 1e9));
            return { data: rows, error: null };
          }
          case "xero_supplier_credit_notes":
            return { data: w.notes?.[String(filters.xero_credit_note_id)] ?? null, error: null };
          case "reconcile_items": {
            const asked = (filters["in:subject_id"] as string[]) ?? [];
            return { data: asked.filter((s) => (w.openItems ?? []).includes(s)).map((subject_id) => ({ subject_id })), error: null };
          }
          case "users":
            return { data: (w.tradeUsers ?? []).filter((c) => c === filters.xero_contact_id).map((c) => ({ id: `u-${c}` })), error: null };
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
          default:
            return { data: [], error: null };
        }
      };
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => ((filters[k] = v), chain),
        lt: (k: string, v: unknown) => ((filters[`lt:${k}`] = v), chain),
        in: (k: string, v: unknown) => ((filters[`in:${k}`] = v), chain),
        or: () => chain,
        order: () => chain,
        limit: (n: number) => ((filters.limit = n), chain),
        maybeSingle: () => Promise.resolve(result()),
        then: (res: any, rej: any) => Promise.resolve(result()).then(res, rej),
      };
      return chain;
    },
    rpc(fn: string, args: any) {
      w.rpcs.push({ fn, args });
      if (fn === "match_apply" && w.applyError) return Promise.resolve({ data: null, error: w.applyError });
      return Promise.resolve({ data: { applied: "shadow" }, error: null });
    },
  };
}

const unallocated = (over: Record<string, unknown> = {}) => ({
  org_id: ORG,
  line_key: "unallocated",
  amount_ex: -80,
  state: "needs_person",
  needs_reason: CREDIT_REASON,
  document_number: "CN-9",
  document_date: "2026-11-10",
  party_id: "supplier-1",
  party_name: "Supplier",
  ...over,
});
const note = (reference: string | null = "Return for SWF-26123") => ({
  credit_note_number: "CN-9",
  reference,
  xero_contact_id: "supplier-1",
  contact_name: "Supplier",
  credit_note_date: "2026-11-10",
  line_items: [{ Description: "Returned posts" }],
});
const world = (over: Partial<World> = {}): World => ({ queries: [], rpcs: [], ...over });
const applies = (w: World) => w.rpcs.filter((r) => r.fn === "match_apply");

Deno.test("an unallocated credit naming a job: a proposal of item kind credit, never auto", async () => {
  const w = world({ lines: { c1: [unallocated()] }, notes: { c1: note() } });
  const out = await creditSweep(fake(w));
  const [call] = applies(w);
  assertEquals([call.args.p_item_kind, call.args.p_subject_id], ["credit", "xero_credit_note:c1"]);
  assertEquals(call.args.p_clues.map((c: any) => c.clue_code), ["job_number"]);
  assertEquals([call.args.p_result.result, call.args.p_result.job_id], ["suggest", JOB]);
  assert(call.args.p_result.result !== "auto");
  assertEquals(call.args.p_summary.amount_ex, -80);
  assertEquals(call.args.p_result.reason, CREDIT_REASON, "the line keeps its reason");
  assertEquals([out.swept, out.run, out.done], [1, 1, true]);
});

Deno.test("no job named: still raised as a credit with no clue, so the list can show it", async () => {
  const w = world({ lines: { c1: [unallocated()] }, notes: { c1: note(null) } });
  await creditSweep(fake(w));
  const [call] = applies(w);
  assertEquals([call.args.p_item_kind, call.args.p_clues.length, call.args.p_result.result], ["credit", 0, "none"]);
  assertEquals(call.args.p_result.reason, CREDIT_REASON);
});

Deno.test("a credit with any allocation line follows a bill and is never raised", async () => {
  const alloc = { ...unallocated({ line_key: "alloc:1", needs_reason: "follows_undecided" }) };
  const w = world({ lines: { c1: [unallocated(), alloc] }, notes: { c1: note() } });
  const out = await creditSweep(fake(w));
  assertEquals(applies(w).length, 0);
  assertEquals(out.skipped, { has_allocations: 1 });
});

Deno.test("the selector asks for unallocated credits waiting with reason credit_not_allocated only", async () => {
  const w = world({ lines: { c1: [unallocated({ needs_reason: "other_reason" })] }, notes: { c1: note() } });
  const out = await creditSweep(fake(w));
  assertEquals([out.swept, applies(w).length], [0, 0]);
  const sel = w.queries.find((q) => q.table === "job_cost_lines")!.filters;
  assertEquals([sel.document_kind, sel.line_key, sel.state, sel.needs_reason],
    ["xero_credit_note", "unallocated", "needs_person", CREDIT_REASON]);
});

Deno.test("a credit with an open item is left; an unreadable item list runs nothing and keeps the cursor", async () => {
  const w = world({ lines: { c1: [unallocated()], c2: [unallocated()] }, notes: { c1: note(), c2: note() }, openItems: ["xero_credit_note:c2"] });
  const out = await creditSweep(fake(w));
  assertEquals(applies(w).map((a) => a.args.p_subject_id), ["xero_credit_note:c1"]);
  assertEquals(out.with_open_item, 1);
  const bad = world({ lines: { c1: [unallocated()] }, notes: { c1: note() }, fail: "reconcile_items" });
  const r = await creditSweep(fake(bad), { after: "c9" });
  assertEquals([r.error, r.next, r.done, applies(bad).length], ["items_unreadable", "c9", false, 0]);
});

Deno.test("a failed read of the credit note is counted, not raised", async () => {
  const w = world({ lines: { c1: [unallocated()] }, notes: { c1: note() }, fail: "xero_supplier_credit_notes" });
  const out = await creditSweep(fake(w));
  assertEquals([applies(w).length, out.failed], [0, { read_credit_note: 1 }]);
});

Deno.test("60 waiting credits: 50 a call, then the rest after the cursor", async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `c${String(i).padStart(2, "0")}`);
  const lines = Object.fromEntries(ids.map((id) => [id, [unallocated()]]));
  const notes = Object.fromEntries(ids.map((id) => [id, note(null)]));
  const w = world({ lines, notes });
  const first = await creditSweep(fake(w));
  assertEquals([first.swept, first.done, first.next], [50, false, "c10"]);
  const w2 = world({ lines, notes });
  const second = await creditSweep(fake(w2), { after: String(first.next) });
  assertEquals([second.swept, second.done, second.next], [10, true, null]);
});

Deno.test("credit_sweep door: only a POST with the exact server key; nothing read otherwise", async () => {
  const url = "https://x.invalid/xero-sync?action=credit_sweep";
  for (const [method, auth, status] of [
    ["POST", "Bearer anon-or-user-jwt", 403],
    ["POST", null, 403],
    ["GET", "Bearer server-key", 405],
  ] as const) {
    const w = world({ lines: { c1: [unallocated()] }, notes: { c1: note() } });
    const headers: Record<string, string> = auth ? { authorization: auth } : {};
    const out = await creditSweepRequest(new Request(url, { method, headers }), fake(w), "server-key");
    assertEquals(out.status, status);
    assertEquals([w.queries.length, w.rpcs.length], [0, 0]);
  }
  const w = world({ lines: { c1: [unallocated()] }, notes: { c1: note() } });
  const ok = await creditSweepRequest(
    new Request(url, { method: "POST", headers: { authorization: "Bearer server-key" } }), fake(w), "server-key");
  assertEquals([ok.status, ok.body.swept], [200, 1]);
});

Deno.test("a credit from a Trade App user is a person's pay: never raised; an unreadable user list is counted, not raised", async () => {
  const w = world({ lines: { c1: [unallocated()] }, notes: { c1: note() }, tradeUsers: ["supplier-1"] });
  const out = await creditSweep(fake(w));
  assertEquals([applies(w).length, out.skipped], [0, { labour_credit: 1 }]);
  const bad = world({ lines: { c1: [unallocated()] }, notes: { c1: note() }, fail: "users" });
  const r = await creditSweep(fake(bad));
  assertEquals([applies(bad).length, r.failed], [0, { read_trade_user: 1 }]);
});
