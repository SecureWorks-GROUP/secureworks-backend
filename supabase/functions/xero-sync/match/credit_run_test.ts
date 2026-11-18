// deno-lint-ignore-file no-explicit-any
// The unallocated credit raiser. Fake client only; made-up ids and amounts.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CREDIT_BACKLOG_STATE_KEY, CREDIT_REASON, creditSweep, creditSweepRequest, syncCreditRun, syncMatchStep } from "./credit_run.ts";

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
  people?: string[]; // people_account_codes rows (default 301, 306, 475)
  fail?: string;
  applyError?: Record<string, unknown>;
  switchOn?: boolean | "fail";
  state?: Record<string, { note: string | null }>; // xero_sync_state rows by key
  upserts?: Array<{ table: string; rows: any }>;
  queries: Array<{ table: string; filters: Record<string, unknown> }>;
  rpcs: Array<{ fn: string; args: any }>;
};

function fake(w: World) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let op = "select";
      let upserted: any = null;
      const result = () => {
        w.queries.push({ table, filters });
        if (w.fail === table) return { data: null, error: { code: "XX000" } };
        if (op === "upsert") {
          (w.upserts ??= []).push({ table, rows: upserted });
          if (table === "xero_sync_state") (w.state ??= {})[upserted.key] = { note: upserted.note };
          return { data: null, error: null };
        }
        switch (table) {
          case "feature_flags":
            if (w.switchOn === "fail") return { data: null, error: { code: "XX000" } };
            return { data: w.switchOn === undefined ? null : { enabled: w.switchOn }, error: null };
          case "xero_sync_state":
            return { data: w.state?.[String(filters.key)] ?? null, error: null };
          case "match_clue_types":
            return { data: CLUE_TYPES, error: null };
          case "people_account_codes":
            return { data: (w.people ?? ["301", "306", "475"]).map((account_code) => ({ account_code })), error: null };
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
              .filter((r) => filters["gt:document_id"] === undefined || r.document_id > String(filters["gt:document_id"]))
              .sort((a, b) => (a.document_id < b.document_id ? 1 : -1) * (filters.ascending ? -1 : 1))
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
        upsert: (rows: any) => ((op = "upsert"), (upserted = rows), chain),
        abortSignal: () => chain,
        eq: (k: string, v: unknown) => ((filters[k] = v), chain),
        lt: (k: string, v: unknown) => ((filters[`lt:${k}`] = v), chain),
        gt: (k: string, v: unknown) => ((filters[`gt:${k}`] = v), chain),
        in: (k: string, v: unknown) => ((filters[`in:${k}`] = v), chain),
        like: () => chain,
        delete: () => ((op = "delete"), chain),
        or: () => chain,
        order: (_k: string, o?: { ascending?: boolean }) => ((filters.ascending = o?.ascending !== false), chain),
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
const world = (over: Partial<World> = {}): World => ({ queries: [], rpcs: [], switchOn: true, ...over });
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

Deno.test("credit_sweep: with reconcile_matcher_v1 off, missing or unreadable it reads nothing else and writes nothing", async () => {
  for (const [on, error] of [[false, "matcher_switch_off"], [undefined, "matcher_switch_off"], ["fail", "matcher_switch_unreadable"]] as const) {
    const w = world({ lines: { c1: [unallocated()] }, notes: { c1: note() }, switchOn: on as any });
    const out = await creditSweep(fake(w), { after: "c9" });
    assertEquals([out.swept, out.switch, out.error, out.next, out.done], [0, "off", error, "c9", false]);
    assertEquals(w.queries.map((q) => q.table), ["feature_flags"]);
    assertEquals([w.rpcs.length, (w.upserts ?? []).length], [0, 0]);
  }
});

Deno.test("a credit with a line on an installer account (301 or 306) is labour: never raised", async () => {
  for (const code of ["301", "306"]) {
    const xero = world({ lines: { c1: [unallocated()] }, notes: { c1: { ...note(), line_items: [{ Description: "Returned", AccountCode: code }] } } });
    const a = await creditSweep(fake(xero));
    assertEquals([applies(xero).length, a.skipped], [0, { labour_credit: 1 }], `Xero line ${code}`);
    const ours = world({ lines: { c1: [unallocated({ account_code: code })] }, notes: { c1: note() } });
    const b = await creditSweep(fake(ours));
    assertEquals([applies(ours).length, b.skipped], [0, { labour_credit: 1 }], `cost line ${code}`);
  }
  const supplies = world({ lines: { c1: [unallocated({ account_code: "300" })] }, notes: { c1: { ...note(), line_items: [{ AccountCode: "300" }] } } });
  await creditSweep(fake(supplies));
  assertEquals(applies(supplies).length, 1, "a supplies account is not labour");
});

const throwingClient = () =>
  new Proxy({}, {
    get() {
      throw new Error("touched the database with the switch off");
    },
  });
const credits = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, [unallocated()]]));
const notesFor = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, note(null)]));
const creditApplies = (w: World) => applies(w).filter((a) => a.args.p_item_kind === "credit").map((a) => a.args.p_subject_id);

Deno.test("sync step, switch off: no bill or credit read or write at all", async () => {
  const out = await syncMatchStep(throwingClient(), { on: false, changed: ["xero_bill:a"] });
  assertEquals([out.switch, out.run, out.credits.switch, out.credits.run], ["off", 0, "off", 0]);
});

Deno.test("sync step: credits run after the bills, in what is left of the same 50", async () => {
  const bills = Array.from({ length: 48 }, (_, i) => `xero_bill:b${String(i).padStart(2, "0")}`);
  const w = world({ lines: credits(5), notes: notesFor(5) });
  const out = await syncMatchStep(fake(w), { on: true, changed: bills });
  assertEquals([out.run, out.credits.taken, out.credits.run], [48, 2, 2]);
  assertEquals(creditApplies(w), ["xero_credit_note:c0", "xero_credit_note:c1"], "oldest id first, after every bill");
  const lastBillRead = w.queries.findLastIndex((q) => q.filters.document_kind === "xero_bill");
  const firstCreditRead = w.queries.findIndex((q) => q.filters.document_kind === "xero_credit_note");
  assert(lastBillRead > 0 && firstCreditRead > lastBillRead, "every bill is read before the first credit");
  assertEquals(w.state?.[CREDIT_BACKLOG_STATE_KEY], { note: "c1" });

  // The next run starts after c1 and reaches the end: the position goes back to the start.
  const w2 = world({ lines: credits(5), notes: notesFor(5), state: { ...w.state } });
  const next = await syncMatchStep(fake(w2), { on: true, changed: [] });
  assertEquals(creditApplies(w2), ["xero_credit_note:c2", "xero_credit_note:c3", "xero_credit_note:c4"]);
  assertEquals([next.credits.run, w2.state?.[CREDIT_BACKLOG_STATE_KEY]], [3, { note: null }]);

  // 50 bills fill the run: no credit is read.
  const full = world({ lines: credits(2), notes: notesFor(2) });
  const f = await syncMatchStep(fake(full), { on: true, changed: Array.from({ length: 50 }, (_, i) => `xero_bill:x${i}`) });
  assertEquals([f.run, f.credits.taken, creditApplies(full).length], [50, 0, 0]);
  assert(!full.queries.some((q) => q.filters.document_kind === "xero_credit_note"));
});

Deno.test("sync step: one budget; the bills spend it, no credit runs, and the position stays", async () => {
  let t = 0;
  const w = world({ lines: credits(3), notes: notesFor(3), state: { [CREDIT_BACKLOG_STATE_KEY]: { note: "c0" } } });
  const out = await syncMatchStep(fake(w), { on: true, changed: ["xero_bill:a", "xero_bill:b"], budgetMs: 25, now: () => (t += 10) });
  assertEquals(out.credits.run, 0);
  assertEquals(creditApplies(w).length, 0);
  assertEquals(w.state?.[CREDIT_BACKLOG_STATE_KEY], { note: "c0" });
});

Deno.test("sync credits: an open item or a skipped credit is passed; a credit the budget does not reach is where the next run starts", async () => {
  let t = 0;
  // Each clock read costs 10 ms: two credits run.
  const w = world({ lines: credits(4), notes: notesFor(4), openItems: ["xero_credit_note:c0"] });
  const out = await syncCreditRun(fake(w), { on: true, room: 50, deadline: 35, now: () => (t += 10) });
  assertEquals([out.taken, out.run], [3, 2]);
  assertEquals(creditApplies(w), ["xero_credit_note:c1", "xero_credit_note:c2"]);
  assertEquals(w.state?.[CREDIT_BACKLOG_STATE_KEY], { note: "c2" });
});

Deno.test("sync credits: a failed read takes nothing and keeps the position", async () => {
  for (const fail of ["reconcile_items", "xero_sync_state", "job_cost_lines"]) {
    const w = world({ lines: credits(2), notes: notesFor(2), state: { [CREDIT_BACKLOG_STATE_KEY]: { note: "a" } }, fail });
    const out = await syncCreditRun(fake(w), { on: true, room: 50, deadline: Date.now() + 60_000 });
    assertEquals([out.run, applies(w).length, out.errors.length], [0, 0, 1], fail);
    assertEquals(w.state?.[CREDIT_BACKLOG_STATE_KEY], { note: "a" }, fail);
    assertEquals((w.upserts ?? []).length, 0, fail);
  }
});

Deno.test("(2) people accounts: a credit with a line on 475 is labour, never raised; the set is one database row each", async () => {
  const xero = world({ lines: { c1: [unallocated()] }, notes: { c1: { ...note(), line_items: [{ Description: "Returned", AccountCode: "475" }] } } });
  assertEquals([applies(xero).length, (await creditSweep(fake(xero))).skipped], [0, { labour_credit: 1 }]);
  const ours = world({ lines: { c1: [unallocated({ account_code: "475" })] }, notes: { c1: note() } });
  assertEquals([applies(ours).length, (await creditSweep(fake(ours))).skipped], [0, { labour_credit: 1 }]);
  // 475 taken out of the set: the same credit is raised, with no code change.
  const out = world({ lines: { c1: [unallocated({ account_code: "475" })] }, notes: { c1: note() }, people: ["301", "306"] });
  await creditSweep(fake(out));
  assertEquals(applies(out).length, 1);
});

Deno.test("people accounts: an unreadable or empty set raises nothing in the sweep", async () => {
  const cases: Array<[Partial<World>, string]> = [
    [{ fail: "people_account_codes" }, "people_accounts_unreadable"],
    [{ people: [] }, "people_accounts_empty"],
  ];
  for (const [over, code] of cases) {
    const w = world({ lines: { c1: [unallocated()] }, notes: { c1: note() }, ...over });
    const out = await creditSweep(fake(w));
    assertEquals([out.error, w.rpcs.length, (w.upserts ?? []).length], [code, 0, 0], code);
  }
});
