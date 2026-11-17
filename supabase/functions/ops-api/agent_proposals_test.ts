// deno-lint-ignore-file no-explicit-any
import { strict as assert } from "node:assert";
import { agentProposalAction } from "./agent_proposals.ts";
import { paramsSha256 } from "./money_actions.ts";
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

const user = { id: "00000000-0000-4000-8000-000000000415", role: "admin" };
async function fixture() {
  const params = { job_number: "ZZTEST-415", invoice_number: "INV-9002", amount: 100 };
  return store([{ id: "proposal-1", status: "pending", action: "reconcile_payment", kind: "xero_payment", http_method: "POST", params, params_sha256: await paramsSha256("reconcile_payment", params), expires_at: "2099-01-01" }]);
}
function input(overrides: any = {}) {
  return { action: "carry_out_agent_proposal", method: "POST", body: { proposal_id: "proposal-1" }, query: new URLSearchParams(), authMode: "jwt", user, staff: true, url: "https://ops.invalid/ops-api?action=carry_out_agent_proposal", headers: new Headers({ Authorization: "Bearer test-person", apikey: "test-public" }), ...overrides };
}
Deno.test("T52: a person's press forwards exact identity and stored parameters only once", async () => {
  const s = await fixture(); let calls = 0;
  const fetcher = (async (url: any, init: any) => {
    calls++;
    assert.equal(String(url), "https://ops.invalid/ops-api?action=reconcile_payment");
    assert.equal(init.headers.get("Authorization"), "Bearer test-person");
    assert.equal(init.headers.get("apikey"), "test-public");
    assert.equal(init.headers.get("x-sw-proposal-id"), "proposal-1");
    assert.deepEqual(JSON.parse(init.body), s.rows[0].params);
    return Response.json({ ok: true });
  }) as typeof fetch;
  assert.equal((await agentProposalAction(s.client, input(), fetcher)).status, 200);
  assert.equal(s.rows[0].status, "carried_out"); assert.equal(s.rows[0].decided_by, user.id);
  assert.equal((await agentProposalAction(s.client, input(), fetcher)).status, 409);
  assert.equal(calls, 1);
});
Deno.test("T53: ops manager cannot press a Xero payment", async () => {
  const s = await fixture();
  assert.equal((await agentProposalAction(s.client, input({ user: { ...user, role: "ops_manager" } }))).status, 403);
  assert.equal(s.rows[0].status, "pending");
});
Deno.test("T54: an expired proposal cannot execute", async () => {
  const s = await fixture(); s.rows[0].expires_at = new Date(Date.now() - 8 * 86400000).toISOString();
  assert.equal((await agentProposalAction(s.client, input())).status, 410);
  assert.equal(s.rows[0].status, "expired");
});
Deno.test("server caller cannot carry out a proposal", async () => {
  const s = await fixture();
  assert.equal((await agentProposalAction(s.client, input({ authMode: "api_key", user: null }))).status, 401);
  assert.equal(s.rows[0].status, "pending");
});
Deno.test("refused self-call is failed, never retried, and reports no change", async () => {
  const s = await fixture(); let calls = 0;
  const fetcher = (async () => { calls++; return new Response("refused", { status: 400 }); }) as typeof fetch;
  const result = await agentProposalAction(s.client, input(), fetcher);
  assert.equal(s.rows[0].status, "failed"); assert.match(s.rows[0].error, /400.*refused/);
  assert.equal(result.body.changed, false);
  assert.match(result.body.message, /Nothing was changed/);
  assert.equal((await agentProposalAction(s.client, input(), fetcher)).status, 409);
  assert.equal(calls, 1);
});
Deno.test("list never exposes stored parameters", async () => {
  const s = await fixture();
  const result = await agentProposalAction(s.client, input({ action: "list_agent_proposals", method: "GET" }));
  assert.equal(result.status, 200); assert.equal(result.body.proposals.length, 1);
  assert.equal("params" in result.body.proposals[0], false);
});
Deno.test("decline validates reason and decides only pending rows", async () => {
  const s = await fixture();
  assert.equal((await agentProposalAction(s.client, input({ action: "decline_agent_proposal", body: { proposal_id: "proposal-1", reason: "no" } }))).status, 400);
  assert.equal((await agentProposalAction(s.client, input({ action: "decline_agent_proposal", body: { proposal_id: "proposal-1", reason: "not needed" } }))).status, 200);
  assert.equal(s.rows[0].status, "declined"); assert.equal(s.rows[0].decided_by, user.id);
  assert.equal((await agentProposalAction(s.client, input())).status, 409);
});
Deno.test("changed parameters fail before any self-call", async () => {
  const s = await fixture(); s.rows[0].params.amount++;
  assert.equal((await agentProposalAction(s.client, input())).status, 409);
  assert.equal(s.rows[0].error, "params_changed");
});
Deno.test("concurrent presses claim one execution", async () => {
  const s = await fixture(); let calls = 0;
  const fetcher = (async () => { calls++; return Response.json({ ok: true }); }) as typeof fetch;
  const results = await Promise.all([agentProposalAction(s.client, input(), fetcher), agentProposalAction(s.client, input(), fetcher)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); assert.equal(calls, 1);
});
