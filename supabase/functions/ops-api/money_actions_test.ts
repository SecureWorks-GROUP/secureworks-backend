// deno-lint-ignore-file no-explicit-any
import { strict as assert } from "node:assert";
import { moneyActionGate, isMoneyAction, paramsSha256, proposalSummary, readMoneyActionFlags } from "./money_actions.ts";
// In-memory PostgREST stand-in. Nothing connects to a service.
function store(seed: any[] = []) {
  const rows = structuredClone(seed);
  const client: any = {
    from() {
      let filters: any[] = [], values: any, inserting = false, columns = "*", single = false;
      const q: any = {
        select(c = "*") { columns = c; return q; },
        eq(k: string, v: any) { filters.push((r: any) => r[k] === v); return q; },
        order() { return q; }, limit() { return q; },
        maybeSingle() { single = true; return q; }, single() { single = true; return q; },
        insert(v: any) { values = v; inserting = true; return q; },
        update(v: any) { values = v; return q; },
        then(resolve: any) {
          let found = rows.filter(r => filters.every(f => f(r)));
          if (inserting) {
            if (values.status === "pending" && rows.some(r => r.status === "pending" && r.action === values.action && r.params_sha256 === values.params_sha256)) {
              return Promise.resolve({ data: null, error: { code: "23505" } }).then(resolve);
            }
            found = [{ id: `proposal-${rows.length + 1}`, expires_at: "2099-01-01", ...structuredClone(values) }];
            rows.push(...found);
          } else if (values) found.forEach(r => Object.assign(r, values));
          const data = found.map(r => columns === "*" ? structuredClone(r) : Object.fromEntries(columns.split(",").map((k: string) => [k.trim(), r[k.trim()]])));
          return Promise.resolve({ data: single ? data[0] ?? null : data, error: null }).then(resolve);
        },
      };
      return q;
    },
    async rpc(name: string, args: any) {
      if (name === "agent_action_proposals_expire") {
        let n = 0;
        for (const r of rows) if (r.status === "pending" && Date.parse(r.expires_at) <= Date.now()) { r.status = "expired"; n++; }
        return { data: n, error: null };
      }
      const row = rows.find(r => r.id === args.p_id && r.status === "pending" && Date.parse(r.expires_at) > Date.now());
      if (!row) return { data: null, error: null };
      Object.assign(row, { status: "carrying_out", decided_by: args.p_user, decided_at: new Date().toISOString() });
      return { data: structuredClone(row), error: null };
    },
  };
  return { client, rows };
}

function request(overrides: any = {}) {
  return { action: "reconcile_payment", method: "POST", body: { invoice_number: "INV-9002", amount: 100 }, actor: "agent:test", authMode: "api_key", fromPerson: false, ...overrides };
}
async function dispatch(s: any, input: any, flags: any) {
  let calls = 0;
  const reply = await moneyActionGate(s.client, input, flags);
  if (!reply) calls++;
  return { reply, calls };
}
Deno.test("T51/T59: agent payment is held once and never dispatched", async () => {
  const s = store();
  const first = await dispatch(s, request(), { press: true, observe: true });
  const second = await dispatch(s, request(), { press: true, observe: true });
  assert.equal(first.reply?.status, 202);
  assert.equal(first.reply?.body.proposal, true);
  assert.equal(first.reply?.body.changed, false);
  assert.equal(second.reply?.body.proposal_id, first.reply?.body.proposal_id);
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].status, "pending");
  assert.equal(first.calls + second.calls, 0);
});
Deno.test("T55: draft creation remains direct", async () => {
  const s = store();
  const result = await dispatch(s, request({ action: "create_invoice_draft" }), { press: true, observe: true });
  assert.equal(result.calls, 1); assert.equal(s.rows.length, 0);
});
Deno.test("T56: observe records and still dispatches", async () => {
  const s = store();
  const result = await dispatch(s, request(), { press: false, observe: true });
  assert.equal(result.calls, 1); assert.equal(s.rows[0].status, "observed");
});
Deno.test("flags off and a signed-in person stay direct", async () => {
  const s = store();
  assert.equal((await dispatch(s, request(), { press: false, observe: false })).calls, 1);
  assert.equal((await dispatch(s, request({ fromPerson: true, authMode: "jwt" }), { press: true, observe: true })).calls, 1);
  assert.equal(s.rows.length, 0);
});
Deno.test("work-order notes are direct but issued states are gated", () => {
  assert.equal(isMoneyAction("update_work_order", { status: "sent" }), true);
  assert.equal(isMoneyAction("update_work_order", { notes: "x" }), false);
});
Deno.test("parameter identity sorts nested objects and preserves array order", async () => {
  assert.equal(await paramsSha256("x", { a: 1, b: { c: 2, d: 3 } }), await paramsSha256("x", { b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(await paramsSha256("x", [1, 2]), await paramsSha256("x", [2, 1]));
});
Deno.test("payment summary uses only approved fields", () => {
  assert.equal(proposalSummary("reconcile_payment", { invoice_number: "INV-9002", amount: 100, secret: "hidden" }), "Record a payment of $100.00 against invoice INV-9002.");
});
Deno.test("observation failures do not stop the existing handler; pending failures do", async () => {
  const client = { from() { throw Error("unavailable"); } };
  assert.equal(await moneyActionGate(client, request(), { press: false, observe: true }), null);
  await assert.rejects(() => moneyActionGate(client, request(), { press: true, observe: false }));
});
Deno.test("flag read caches for 30 seconds and read errors turn both off", async () => {
  let reads = 0;
  const client = { from() { reads++; return { select() { return { in() { return Promise.resolve({ data: [{ flag_name: "agent_money_press_v1", enabled: true }], error: null }); } }; } }; } };
  assert.equal((await readMoneyActionFlags(client, 1000)).press, true);
  await readMoneyActionFlags(client, 2000);
  assert.equal(reads, 1);
  const broken = { from() { throw Error("unavailable"); } };
  assert.deepEqual(await readMoneyActionFlags(broken, 31001), { press: false, observe: false });
});
