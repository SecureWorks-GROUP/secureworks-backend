// deno-lint-ignore-file no-import-prefix no-explicit-any
// Trade "Request Variation" (trade-app-audit-20260923 B5). The office still
// approves every variation, so a trade may only RECORD a request:
//   - the front door admits a trade JWT to create_variation (it was a 403);
//   - only on a job the caller's OWN user holds a live assignment on;
//   - the actor is the verified session user, never body.user_id;
//   - always pending_approval, even at a cost the staff path auto-approves;
//   - nothing is sent, and the customer-acceptance share_token is withheld.
// Staff behaviour is unchanged: the same small cost still auto-approves.
//
// Every case drives createVariationForCaller, the function the create_variation
// dispatch case calls, so a helper that is correct but unwired cannot pass.

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _authorizeOpsApiAction,
  ApiError,
  createVariationForCaller,
  type TradeAuthContext,
} from "./index.ts";

const ORG = "org-1";
const JOB = "job-1";
const TRADE = "trade-user-1";
const OTHER_TRADE = "trade-user-2";

type Tables = Record<string, any[]>;

function makeClient(tables: Tables) {
  const inserts: Array<{ table: string; row: any }> = [];
  const rpcs: string[] = [];

  function orPredicate(expr: string): (r: any) => boolean {
    const parts = expr.split(",").map((p) => {
      const [col, op, ...rest] = p.split(".");
      const raw = rest.join(".");
      const val = raw === "null" ? null : raw;
      return (r: any) => {
        if (op === "is") return (r[col] ?? null) === val;
        if (op === "neq") return r[col] !== val;
        if (op === "eq") return r[col] === val;
        throw new Error(`unsupported or op ${op}`);
      };
    });
    return (r) => parts.some((p) => p(r));
  }

  function builder(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let limitN: number | null = null;
    let countHead = false;
    let inserted: any = null;
    const rows = () => {
      let out = (tables[table] || []).filter((r) => preds.every((p) => p(r)));
      if (limitN != null) out = out.slice(0, limitN);
      return out;
    };
    const b: any = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.head) countHead = true;
        return b;
      },
      insert(row: any) {
        const stored = {
          id: `${table}-${inserts.length + 1}`,
          share_token: table === "job_variations" ? "tok-secret" : undefined,
          ...row,
        };
        inserts.push({ table, row: stored });
        (tables[table] ||= []).push(stored);
        inserted = stored;
        return b;
      },
      update() {
        throw new Error(`unexpected update on ${table}`);
      },
      delete() {
        throw new Error(`unexpected delete on ${table}`);
      },
      eq(col: string, val: any) {
        preds.push((r) => r[col] === val);
        return b;
      },
      neq(col: string, val: any) {
        preds.push((r) => r[col] !== val);
        return b;
      },
      or(expr: string) {
        preds.push(orPredicate(expr));
        return b;
      },
      limit(n: number) {
        limitN = n;
        return b;
      },
      maybeSingle() {
        if (inserted) return Promise.resolve({ data: inserted, error: null });
        return Promise.resolve({ data: rows()[0] ?? null, error: null });
      },
      single() {
        if (inserted) return Promise.resolve({ data: inserted, error: null });
        const r = rows()[0];
        return Promise.resolve(
          r
            ? { data: r, error: null }
            : { data: null, error: { code: "PGRST116" } },
        );
      },
      then(resolve: any, reject: any) {
        const result = countHead
          ? { count: rows().length, data: null, error: null }
          : { data: inserted ?? rows(), error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    inserts,
    rpcs,
    from: (table: string) => builder(table),
    rpc: (name: string) => {
      rpcs.push(name);
      return Promise.resolve({ data: null, error: null });
    },
  };
}

function baseTables(assignments: any[]): Tables {
  return {
    jobs: [{
      id: JOB,
      org_id: ORG,
      type: "fencing",
      client_name: "Client A",
      job_number: "SWF-1",
      created_by: "office-1",
      status: "scheduled",
      metadata: {},
    }],
    job_assignments: assignments,
    job_variations: [],
    job_events: [],
    ai_alerts: [],
  };
}

function trade(id = TRADE, role = "lead_installer"): TradeAuthContext {
  return {
    id,
    email: `${id}@example.invalid`,
    orgId: ORG,
    role,
    managedVerticals: [],
    seeEverything: false,
  };
}

const liveAssignment = {
  id: "a-1",
  job_id: JOB,
  user_id: TRADE,
  status: "scheduled",
  is_ghost: false,
};

function variationRows(client: ReturnType<typeof makeClient>) {
  return client.inserts.filter((i) => i.table === "job_variations").map((i) =>
    i.row
  );
}

// Tables a request must never touch: customer sends, price, invoices.
const FORBIDDEN_TABLES = [
  "xero_invoices",
  "invoices",
  "job_documents",
  "trade_invoices",
  "purchase_orders",
];

Deno.test("front door admits a trade JWT to create_variation (was a staff-only 403)", () => {
  const decision = _authorizeOpsApiAction({
    url: new URL("https://example.invalid/ops-api?action=create_variation"),
    authMode: "jwt",
    authUser: { role: "lead_installer", managedVerticals: [] },
  });
  assertEquals(decision.ok, true);
});

Deno.test("assigned trade: request is created pending office approval even at a small cost", async () => {
  const client = makeClient(baseTables([liveAssignment]));
  const result: any = await createVariationForCaller(
    client,
    { job_id: JOB, description: "Extra post footing", estimated_cost: 50 },
    "jwt",
    trade(),
  );

  assertEquals(result.success, true);
  assertEquals(result.needs_approval, true);
  assertEquals(result.auto_approved, false);
  assert(
    !("share_token" in result),
    "customer acceptance link must not reach the trade",
  );

  const [row] = variationRows(client);
  assertEquals(row.status, "pending_approval");
  assertEquals(row.needs_approval, true);
  assertEquals(row.amount, 50);
  assertEquals(row.created_by, TRADE);
  assertEquals(row.invoice_method, "with_final");

  const alerts = client.inserts.filter((i) => i.table === "ai_alerts");
  assertEquals(
    alerts.length,
    1,
    "the office is alerted to review every trade request",
  );
  assertEquals(alerts[0].row.alert_type, "variation_approval_needed");

  for (const t of FORBIDDEN_TABLES) {
    assertEquals(
      client.inserts.filter((i) => i.table === t).length,
      0,
      `wrote ${t}`,
    );
  }
});

Deno.test("assigned trade: a zero-cost request still waits for the office", async () => {
  const client = makeClient(baseTables([liveAssignment]));
  await createVariationForCaller(
    client,
    { job_id: JOB, description: "Move gate 1m left" },
    "jwt",
    trade(),
  );
  assertEquals(variationRows(client)[0].status, "pending_approval");
});

Deno.test("assigned trade: body.invoice_method is not taken from the trade", async () => {
  const client = makeClient(baseTables([liveAssignment]));
  await createVariationForCaller(
    client,
    {
      job_id: JOB,
      description: "Extra panel",
      amount: 90,
      invoice_method: "separate_now",
    },
    "jwt",
    trade(),
  );
  assertEquals(variationRows(client)[0].invoice_method, "with_final");
});

Deno.test("unassigned trade is refused with variation_requires_assignment and nothing is written", async () => {
  const client = makeClient(baseTables([
    { ...liveAssignment, user_id: OTHER_TRADE },
  ]));
  const err = await assertRejects(
    () =>
      createVariationForCaller(
        client,
        { job_id: JOB, description: "Extra post", estimated_cost: 50 },
        "jwt",
        trade(),
      ),
    ApiError,
  );
  assertEquals(err.status, 403);
  assertEquals((err.body as any).code, "variation_requires_assignment");
  assertEquals(client.inserts.length, 0);
});

Deno.test("cancelled and ghost assignment rows do not count as assigned crew", async () => {
  for (
    const row of [
      { ...liveAssignment, status: "cancelled" },
      { ...liveAssignment, is_ghost: true, role: "observer" },
    ]
  ) {
    const client = makeClient(baseTables([row]));
    const err = await assertRejects(
      () =>
        createVariationForCaller(
          client,
          { job_id: JOB, description: "Extra post" },
          "jwt",
          trade(),
        ),
      ApiError,
    );
    assertEquals((err.body as any).code, "variation_requires_assignment");
    assertEquals(client.inserts.length, 0);
  }
});

Deno.test("a legacy NULL-status assignment still counts as assigned crew", async () => {
  const client = makeClient(baseTables([{ ...liveAssignment, status: null }]));
  const result: any = await createVariationForCaller(
    client,
    { job_id: JOB, description: "Extra post" },
    "jwt",
    trade(),
  );
  assertEquals(result.success, true);
});

Deno.test("trade passing someone else's user_id: the body identity is ignored", async () => {
  // The caller is NOT assigned; the named user IS. Passing their id must not
  // borrow their assignment.
  const client = makeClient(baseTables([
    { ...liveAssignment, user_id: OTHER_TRADE },
  ]));
  const err = await assertRejects(
    () =>
      createVariationForCaller(
        client,
        {
          job_id: JOB,
          description: "Extra post",
          user_id: OTHER_TRADE,
          userId: OTHER_TRADE,
        },
        "jwt",
        trade(),
      ),
    ApiError,
  );
  assertEquals((err.body as any).code, "variation_requires_assignment");
  assertEquals(client.inserts.length, 0);

  // And when the caller IS assigned, the record is attributed to the caller,
  // not to the body-named user.
  const client2 = makeClient(baseTables([liveAssignment]));
  await createVariationForCaller(
    client2,
    {
      job_id: JOB,
      description: "Extra post",
      user_id: OTHER_TRADE,
      userId: OTHER_TRADE,
    },
    "jwt",
    trade(),
  );
  assertEquals(variationRows(client2)[0].created_by, TRADE);
  const ev = client2.inserts.find((i) => i.table === "job_events")!;
  assertEquals(ev.row.user_id, TRADE);
});

Deno.test("trade on another tenant's job is refused as not found", async () => {
  const tables = baseTables([liveAssignment]);
  tables.jobs[0].org_id = "org-other";
  const client = makeClient(tables);
  const err = await assertRejects(
    () =>
      createVariationForCaller(
        client,
        { job_id: JOB, description: "Extra post" },
        "jwt",
        trade(),
      ),
    ApiError,
  );
  assertEquals(err.status, 404);
  assertEquals(client.inserts.length, 0);
});

Deno.test("staff unchanged: a small cost still auto-approves, body user_id is honoured, share_token returned", async () => {
  for (
    const [authMode, user] of [
      ["api_key", null],
      ["jwt", trade("ops-1", "ops_manager")],
      ["jwt", trade("admin-1", "admin")],
    ] as const
  ) {
    // Staff need no assignment on the job.
    const client = makeClient(baseTables([]));
    const result: any = await createVariationForCaller(
      client,
      {
        job_id: JOB,
        description: "Extra post",
        estimated_cost: 50,
        user_id: "office-9",
        invoice_method: "separate_now",
      },
      authMode,
      user,
    );
    assertEquals(result.auto_approved, true);
    assertEquals(result.needs_approval, false);
    assertEquals(result.share_token, "tok-secret");
    const [row] = variationRows(client);
    assertEquals(row.status, "auto_approved");
    assertEquals(row.created_by, "office-9");
    assertEquals(row.invoice_method, "separate_now");
    assertEquals(
      client.inserts.filter((i) => i.table === "ai_alerts").length,
      0,
    );
  }
});

Deno.test("staff unchanged: over $200 still needs approval", async () => {
  const client = makeClient(baseTables([]));
  const result: any = await createVariationForCaller(
    client,
    { job_id: JOB, description: "Extra run", estimated_cost: 450 },
    "api_key",
    null,
  );
  assertEquals(result.needs_approval, true);
  assertEquals(variationRows(client)[0].status, "pending_approval");
});

// createVariationForCaller reads job_id, description, amount and reason by
// name before dispatch. The body each path receives must be the caller's body,
// unchanged: same values, no field added, none dropped, the caller's object
// untouched.
Deno.test("dispatch forwards the body unchanged on the staff path", async () => {
  const body = {
    job_id: JOB,
    description: "Rock under footing",
    amount: 150,
    reason: "rock",
    photo_url: "https://example.invalid/p.jpg",
    invoice_method: "separate_now",
  };
  const sent = structuredClone(body);
  const client = makeClient(baseTables([]));
  await createVariationForCaller(client, body, "api_key", null);
  assertEquals(body, sent);
  const [row] = variationRows(client);
  assertEquals(
    [
      row.job_id,
      row.description,
      row.amount,
      row.reason,
      row.photo_url,
      row.invoice_method,
    ],
    [
      JOB,
      "Rock under footing",
      150,
      "rock",
      "https://example.invalid/p.jpg",
      "separate_now",
    ],
  );
});

Deno.test("dispatch forwards the body unchanged on the trade path", async () => {
  const body = {
    job_id: JOB,
    description: "Extra post",
    amount: 80,
    reason: "soft ground",
  };
  const sent = structuredClone(body);
  const client = makeClient(baseTables([liveAssignment]));
  await createVariationForCaller(client, body, "jwt", trade());
  assertEquals(body, sent);
  const [row] = variationRows(client);
  assertEquals(
    [row.job_id, row.description, row.amount, row.reason],
    [JOB, "Extra post", 80, "soft ground"],
  );
});

Deno.test("dispatch adds no field the caller did not send", async () => {
  const body = { jobId: JOB, description: "No cost given" };
  const client = makeClient(baseTables([]));
  await createVariationForCaller(client, body, "api_key", null);
  assertEquals(Object.keys(body), ["jobId", "description"]);
  const [row] = variationRows(client);
  assertEquals([row.job_id, row.amount, row.reason], [JOB, 0, null]);
});

Deno.test("a trade call with no body is still refused as missing fields", async () => {
  const client = makeClient(baseTables([liveAssignment]));
  const err = await assertRejects(
    () => createVariationForCaller(client, null, "jwt", trade()),
    ApiError,
  );
  assertEquals(err.status, 400);
  assertEquals(client.inserts.length, 0);
});
