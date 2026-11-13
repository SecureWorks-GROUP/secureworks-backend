/**
 * Ruling 17 step 2: the commission rate doors, one job's commission record
 * and the cap's pure rule (job_commission.ts). The database half (the record
 * written from each stored budget, the cap on every invoice write) is proved
 * by the migration contract 20261113230000_job_commissions. Every id below is
 * made up.
 */
// deno-lint-ignore-file no-explicit-any no-import-prefix
import "./trade_app_visibility_rules_test_env.ts";
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  commissionCapCodeFromDbError,
  commissionCapRefusal,
  jobCommissionAction,
  type JobCommissionRecord,
  readJobCommissionRecords,
} from "./job_commission.ts";
import { _opsApiRequestHandlerForTest } from "./index.ts";

const ME = "6c0a0a52-0000-4000-8000-00000000a001";
const OTHER = "6c0a0a52-0000-4000-8000-00000000a002";
const JOB = "6c0a0a52-0000-4000-8000-00000000b001";
const JOB2 = "6c0a0a52-0000-4000-8000-00000000b002";
const ORG = "00000000-0000-0000-0000-000000000001";

const rec = (over: Partial<JobCommissionRecord> = {}): JobCommissionRecord => ({
  job_id: JOB,
  commission_id: "c1",
  budget_id: "b1",
  version: 1,
  state: "named",
  salesperson_user_id: ME,
  rule_id: "fence_gross_profit_rate",
  percent: 15,
  expected_amount_ex_gst: 100,
  claimed_ex_gst: 0,
  remaining_ex_gst: 100,
  ...over,
});

// ── The cap (pure) ──────────────────────────────────────────────────────────

Deno.test("cap: the named salesperson up to the amount; to the cent, counted claims included", () => {
  const records = new Map([[JOB, rec({ claimed_ex_gst: 60.01 })]]);
  assertEquals(commissionCapRefusal({ tradeId: ME, lines: [{ jobId: JOB, ref: "J1", amountEx: 39.99 }], records }), null);
  const over = commissionCapRefusal({ tradeId: ME, lines: [{ jobId: JOB, ref: "J1", amountEx: 40 }], records });
  assertEquals([over?.code, over?.jobs], ["commission_over_amount", ["J1"]]);
  // Lines on one job add up.
  const two = commissionCapRefusal({
    tradeId: ME,
    lines: [{ jobId: JOB, ref: "J1", amountEx: 20 }, { jobId: JOB, ref: "J1", amountEx: 20 }],
    records,
  });
  assertEquals(two?.code, "commission_over_amount");
});

Deno.test("cap: wrong person first, then no amount, then over; a job with no record is not checked", () => {
  const records = new Map([
    [JOB, rec({ salesperson_user_id: OTHER })],
    [JOB2, rec({ job_id: JOB2, state: "no_amount", expected_amount_ex_gst: null, remaining_ex_gst: null })],
  ]);
  const both = commissionCapRefusal({
    tradeId: ME,
    lines: [{ jobId: JOB, ref: "J1", amountEx: 1 }, { jobId: JOB2, ref: "J2", amountEx: 1 }],
    records,
  });
  assertEquals([both?.code, both?.jobs], ["commission_not_salesperson", ["J1"]]);
  const unknown = commissionCapRefusal({ tradeId: ME, lines: [{ jobId: JOB2, ref: "J2", amountEx: 1 }], records });
  assertEquals(unknown?.code, "commission_amount_unknown");
  assertEquals(
    commissionCapRefusal({ tradeId: ME, lines: [{ jobId: "no-record", ref: "J9", amountEx: 1e6 }], records }),
    null,
  );
  // A record naming nobody refuses everyone.
  const nobody = new Map([[JOB, rec({ state: "no_salesperson", salesperson_user_id: null, expected_amount_ex_gst: null })]]);
  assertEquals(commissionCapRefusal({ tradeId: ME, lines: [{ jobId: JOB, ref: "J1", amountEx: 1 }], records: nobody })?.code, "commission_not_salesperson");
  // A loss: amount 0, any commission is over.
  const loss = new Map([[JOB, rec({ expected_amount_ex_gst: 0, remaining_ex_gst: 0 })]]);
  assertEquals(commissionCapRefusal({ tradeId: ME, lines: [{ jobId: JOB, ref: "J1", amountEx: 0.01 }], records: loss })?.code, "commission_over_amount");
});

Deno.test("cap: refusal words carry job numbers, never money", () => {
  const records = new Map([[JOB, rec({ expected_amount_ex_gst: 123.45, claimed_ex_gst: 100 })]]);
  const r = commissionCapRefusal({ tradeId: ME, lines: [{ jobId: JOB, ref: "ZZF-1", amountEx: 50 }], records })!;
  assert(r.message.includes("ZZF-1"));
  for (const money of ["123", "100", "50", "$"]) assert(!r.message.includes(money), money);
});

Deno.test("the database's cap codes are read off a failed write", () => {
  assertEquals(commissionCapCodeFromDbError(new Error("Failed to save invoice line items: commission_over_amount")), "commission_over_amount");
  assertEquals(commissionCapCodeFromDbError({ message: "commission_not_salesperson" }), "commission_not_salesperson");
  assertEquals(commissionCapCodeFromDbError({ message: "duplicate key" }), null);
});

// ── Reads ───────────────────────────────────────────────────────────────────

function fake(tables: Record<string, any[] | { error: any }>, rpc?: (name: string, args: any) => any) {
  const calls: any[] = [];
  const client = {
    calls,
    from(table: string) {
      const filters: Array<[string, string, any]> = [];
      const result = () => {
        calls.push({ table, filters: [...filters] });
        const t = tables[table];
        if (t && !Array.isArray(t)) return { data: null, error: t.error };
        const rows = (t ?? []).filter((row) =>
          filters.every(([op, col, val]) => op === "eq" ? String(row[col]) === String(val) : val.map(String).includes(String(row[col])))
        );
        return { data: rows, error: null };
      };
      const b: any = {
        select: () => b,
        order: () => b,
        eq: (c: string, v: any) => (filters.push(["eq", c, v]), b),
        in: (c: string, v: any[]) => (filters.push(["in", c, v]), b),
        maybeSingle: () => {
          const r = result();
          return Promise.resolve(r.error ? r : { data: r.data?.[0] ?? null, error: null });
        },
        then: (ok: any, bad: any) => Promise.resolve(result()).then(ok, bad),
      };
      return b;
    },
    rpc(name: string, args: any) {
      calls.push({ rpc: name, args });
      return Promise.resolve(rpc ? rpc(name, args) : { data: null, error: { message: "no rpc" } });
    },
  };
  return client;
}

Deno.test("records: a failed read throws; before the migration there are none (today's rules)", async () => {
  let threw = false;
  try {
    await readJobCommissionRecords(fake({ v_job_commission: { error: { code: "XX000", message: "boom" } } }), [JOB]);
  } catch {
    threw = true;
  }
  assert(threw);
  const missing = await readJobCommissionRecords(fake({ v_job_commission: { error: { code: "42P01", message: "missing" } } }), [JOB]);
  assertEquals(missing.size, 0);
  const got = await readJobCommissionRecords(fake({ v_job_commission: [{ ...rec(), expected_amount_ex_gst: "100.00", claimed_ex_gst: "12.50" }] }), [JOB, JOB]);
  assertEquals([got.get(JOB)?.expected_amount_ex_gst, got.get(JOB)?.claimed_ex_gst], [100, 12.5]);
});

// ── Doors ───────────────────────────────────────────────────────────────────

const staff = { staff: true, sessionUserId: ME, orgId: ORG };

Deno.test("commission_rates: staff read the current rate per trade; others are refused", async () => {
  const client = fake({ v_commission_rates: [{ trade: "fence", rule_id: "fence_gross_profit_rate", percent: "15.00", basis: "gross_profit" }, { trade: "patio", rule_id: "patio_gross_profit_rate", percent: "8.00", basis: "gross_profit" }] });
  const out = await jobCommissionAction(client, "commission_rates", "GET", {}, staff);
  assertEquals(out.status, 200);
  assertEquals((out.body.rates as any[]).map((r) => [r.trade, r.percent]), [["fence", 15], ["patio", 8]]);
  const refused = await jobCommissionAction(client, "commission_rates", "GET", {}, { staff: false, sessionUserId: null, orgId: ORG });
  assertEquals([refused.status, refused.body.code], [403, "operator_access_required"]);
});

Deno.test("set_commission_rate: only a person's own sign-in reaches the writer, which names them; the database decides who", async () => {
  // The server key (no session) never reaches the writer.
  const keyClient = fake({});
  const key = await jobCommissionAction(keyClient, "set_commission_rate", "POST", { trade: "patio", percent: 9, reason: "r" }, { staff: true, sessionUserId: null, orgId: ORG });
  assertEquals([key.status, key.body.code], [403, "commission_rate_editor_only"]);
  assertEquals(keyClient.calls, []);
  // A signed-in person: the writer gets the session id, never a body field.
  const client = fake({}, () => ({ data: { trade: "patio", percent: 9 }, error: null }));
  const ok = await jobCommissionAction(client, "set_commission_rate", "POST", { trade: "Patio", percent: 9, reason: " owner's call ", actor: OTHER, p_actor: OTHER }, staff);
  assertEquals(ok.status, 200);
  assertEquals(client.calls, [{ rpc: "set_commission_rate", args: { p_trade: "patio", p_percent: 9, p_reason: "owner's call", p_actor: ME } }]);
  // Not on the editor list: the database refuses.
  const notEditor = fake({}, () => ({ data: null, error: { code: "P0001", message: "commission_rate_editor_only" } }));
  const no = await jobCommissionAction(notEditor, "set_commission_rate", "POST", { trade: "fence", percent: 16, reason: "r" }, staff);
  assertEquals([no.status, no.body.code], [403, "commission_rate_editor_only"]);
  // Bad input never reaches the writer.
  for (const [body, code] of [
    [{ trade: "decking", percent: 5, reason: "r" }, "commission_rate_trade_unknown"],
    [{ trade: "fence", percent: 101, reason: "r" }, "commission_rate_percent_invalid"],
    [{ trade: "fence", percent: 8.155, reason: "r" }, "commission_rate_percent_invalid"],
    [{ trade: "fence", percent: 8.15, reason: "" }, "commission_rate_reason_required"],
  ] as const) {
    const c = fake({});
    const r = await jobCommissionAction(c, "set_commission_rate", "POST", body, staff);
    assertEquals([r.status, r.body.code], [400, code], JSON.stringify(body));
    assertEquals(c.calls, []);
  }
  const get = await jobCommissionAction(fake({}), "set_commission_rate", "GET", {}, staff);
  assertEquals(get.status, 405);
});

Deno.test("job_commission (the AI command): one job's record, claimed and left, inside the caller's company", async () => {
  const client = fake({
    jobs: [{ id: JOB, org_id: ORG }],
    v_job_commission: [{ ...rec(), claimed_ex_gst: "40.00", remaining_ex_gst: "60.00" }],
    users: [{ id: ME, name: "ZZTEST Seller" }],
  });
  const out = await jobCommissionAction(client, "job_commission", "GET", { job_id: JOB }, staff);
  assertEquals(out.status, 200);
  const c = out.body.commission as any;
  assertEquals([c.expected_amount_ex_gst, c.claimed_ex_gst, c.remaining_ex_gst, c.salesperson.name], [100, 40, 60, "ZZTEST Seller"]);
  const none = await jobCommissionAction(fake({ jobs: [{ id: JOB2, org_id: ORG }] }), "job_commission", "GET", { job_id: JOB2 }, staff);
  assertEquals([none.status, none.body.state, none.body.commission], [200, "no_record", null]);
  const foreign = await jobCommissionAction(fake({ jobs: [] }), "job_commission", "GET", { job_id: JOB }, staff);
  assertEquals(foreign.status, 404);
  const unreadable = await jobCommissionAction(fake({ jobs: [{ id: JOB, org_id: ORG }], v_job_commission: { error: { code: "XX000" } } }), "job_commission", "GET", { job_id: JOB }, staff);
  assertEquals(unreadable.status, 503);
});

// ── Through the real handler: who reaches the doors ─────────────────────────

async function call(action: string, init: { method: string; headers: Record<string, string>; body?: unknown }, role: string | null) {
  const rpcs: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, opts?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith("/auth/v1/user")) {
      return Promise.resolve(Response.json({ id: ME, email: "", aud: "authenticated" }));
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      rpcs.push(url.pathname.slice("/rest/v1/rpc/".length) + " " + String(opts?.body ?? ""));
      return Promise.resolve(Response.json({ trade: "patio" }));
    }
    if (url.pathname === "/rest/v1/users") {
      const accept = new Headers(opts?.headers).get("accept") || "";
      const row = { id: ME, org_id: ORG, role, name: "ZZTEST", managed_verticals: [] };
      return Promise.resolve(Response.json(accept.includes("vnd.pgrst.object") ? row : [row]));
    }
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", action);
    const res = await _opsApiRequestHandlerForTest(new Request(url, {
      method: init.method,
      headers: { "content-type": "application/json", ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }));
    return { status: res.status, body: await res.json().catch(() => null), rpcs };
  } finally {
    globalThis.fetch = original;
  }
}

const handlerTest = (name: string, fn: () => Promise<void>) =>
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });

handlerTest("handler: the server key cannot change a rate; a staff sign-in reaches the writer under its own id; a trade cannot read rates", async () => {
  const key = await call("set_commission_rate", { method: "POST", headers: { authorization: "Bearer test-service-role-key" }, body: { trade: "patio", percent: 9, reason: "r" } }, null);
  assertEquals([key.status, key.body?.code], [403, "commission_rate_editor_only"]);
  assertEquals(key.rpcs, []);
  const owner = await call("set_commission_rate", { method: "POST", headers: { authorization: "Bearer staff-jwt" }, body: { trade: "patio", percent: 9, reason: "r", p_actor: OTHER } }, "owner");
  assertEquals(owner.status, 200, JSON.stringify(owner.body));
  assertEquals(owner.rpcs.length, 1);
  assert(owner.rpcs[0].includes(`"p_actor":"${ME}"`), owner.rpcs[0]);
  const trade = await call("commission_rates", { method: "GET", headers: { authorization: "Bearer trade-jwt" } }, "lead_installer");
  assertEquals(trade.status, 403, JSON.stringify(trade.body));
});
