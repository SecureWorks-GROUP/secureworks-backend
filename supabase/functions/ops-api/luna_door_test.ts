// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  authorizeLunaDoor,
  LUNA_DOOR_MAX_BODY_BYTES,
  LUNA_DOOR_OP_ARGS,
  LUNA_DOOR_OPS,
  lunaDoorActorOk,
  lunaDoorCredentialOk,
  LunaDoorDb,
  LunaDoorError,
  LunaDoorResult,
  runLunaDoor,
  supabaseLunaDoorDb,
} from "./luna_door.ts";

const JOB = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const LEASE = "33333333-3333-4333-8333-333333333333";
const PASS = "44444444-4444-4444-8444-444444444444";
const EV1 = "55555555-5555-4555-8555-555555555555";
const DATE = "2026-09-24";
const NOW = new Date("2026-09-24T03:00:00.000Z");

type Call = { kind: string; args: unknown[] };

function fakeDb(overrides: Partial<{
  rpc: (name: string, args: Record<string, unknown>) => LunaDoorResult;
  held: LunaDoorResult;
  recent: LunaDoorResult;
}> = {}) {
  const calls: Call[] = [];
  const ok = (data: unknown): LunaDoorResult => ({ data, error: null });
  const db: LunaDoorDb = {
    rpc: (name, args) => {
      calls.push({ kind: "rpc", args: [name, args] });
      if (overrides.rpc) return Promise.resolve(overrides.rpc(name, args));
      if (name === "renew_context_pass") return Promise.resolve(ok(true));
      if (name === "context_cadence_policy") {
        return Promise.resolve(
          ok({ tick_max_jobs: 10, tick_max_seconds: 300 }),
        );
      }
      return Promise.resolve(ok({ from: name }));
    },
    featureFlag: (flag) => {
      calls.push({ kind: "featureFlag", args: [flag] });
      return Promise.resolve(ok({ enabled: true }));
    },
    jobRow: (jobId) => {
      calls.push({ kind: "jobRow", args: [jobId] });
      return Promise.resolve(ok({ id: jobId }));
    },
    currentFactsPage: (jobId, offset) => {
      calls.push({ kind: "currentFactsPage", args: [jobId, offset] });
      return Promise.resolve(ok([]));
    },
    heldExtractionRun: (...a) => {
      calls.push({ kind: "heldExtractionRun", args: a });
      return Promise.resolve(overrides.held ?? ok({ id: RUN }));
    },
    recentExtractionClaims: (...a) => {
      calls.push({ kind: "recentExtractionClaims", args: a });
      return Promise.resolve(overrides.recent ?? ok([]));
    },
  };
  return { db, calls };
}

async function refused(
  body: unknown,
  code: string,
  db = fakeDb(),
): Promise<Call[]> {
  const err = await assertRejects(
    () => runLunaDoor(db.db, body, NOW),
    LunaDoorError,
  );
  assertEquals(err.code, code);
  return db.calls;
}

// ── Each op is exactly one fixed call with the worker's own shape ──────────

const held = { job_id: JOB, run_id: RUN, lease_token: LEASE };
const RPC_CASES: [
  string,
  Record<string, unknown>,
  string,
  Record<string, unknown>,
][] = [
  ["lane_enabled", { lane: "extraction" }, "automation_lane_enabled", {
    lane: "extraction",
  }],
  ["claim_pass", { run_date: DATE }, "claim_context_pass", {
    p_run_date: DATE,
  }],
  ["cadence_policy", {}, "context_cadence_policy", {}],
  ["renew_pass", { run_date: DATE, lease_token: PASS }, "renew_context_pass", {
    p_run_date: DATE,
    p_lease_token: PASS,
  }],
  ["extraction_candidates", { limit: 400 }, "context_extraction_candidates", {
    p_limit: 400,
  }],
  ["extraction_candidates", {}, "context_extraction_candidates", {
    p_limit: 400,
  }],
  ["revision_rpc_probe", {}, "persist_luna_context_revision", {
    p_run_id: null,
    p_lease_token: null,
    p_job_id: null,
    p_events: null,
    p_new: null,
    p_supersedes: null,
    p_retracts: null,
    p_extractor_version: null,
    p_tokens_in: null,
  }],
  [
    "renew_extraction_run",
    { run_id: RUN, lease_token: LEASE },
    "renew_context_extraction_run",
    { p_run_id: RUN, p_lease_token: LEASE },
  ],
  [
    "reserve_model_call",
    { run_id: RUN, lease_token: LEASE },
    "reserve_context_model_call",
    { p_phase: "extraction", p_run_id: RUN, p_lease_token: LEASE },
  ],
  [
    "persist_revision",
    {
      run_id: RUN,
      lease_token: LEASE,
      job_id: JOB,
      events: [{ id: EV1 }],
      new: [{ kind: "note", text: "t" }],
      supersedes: [],
      retracts: [],
      tokens_in: 12,
    },
    "persist_luna_context_revision",
    {
      p_run_id: RUN,
      p_lease_token: LEASE,
      p_job_id: JOB,
      p_events: [{ id: EV1 }],
      p_new: [{ kind: "note", text: "t" }],
      p_supersedes: [],
      p_retracts: [],
      p_extractor_version: "luna_v2",
      p_tokens_in: 12,
    },
  ],
  [
    "finish_extraction_run",
    {
      run_id: RUN,
      lease_token: LEASE,
      status: "done",
      event_ids: [EV1],
      tokens_in: 0,
      facts_new: 0,
      facts_superseded: 0,
      facts_retracted: 0,
      error: null,
      retry_at: null,
    },
    "finish_context_extraction_run",
    {
      p_run_id: RUN,
      p_lease_token: LEASE,
      p_status: "done",
      p_event_ids: [EV1],
      p_tokens_in: 0,
      p_facts_new: 0,
      p_facts_superseded: 0,
      p_facts_retracted: 0,
      p_error: null,
      p_retry_at: null,
    },
  ],
  [
    "finish_pass",
    {
      run_date: DATE,
      lease_token: PASS,
      status: "failed",
      retry_at: NOW.toISOString(),
      error: "pending_work",
    },
    "finish_context_pass",
    {
      p_run_date: DATE,
      p_lease_token: PASS,
      p_status: "failed",
      p_retry_at: NOW.toISOString(),
      p_error: "pending_work",
    },
  ],
];

for (const [op, args, rpc, rpcArgs] of RPC_CASES) {
  Deno.test(`luna_door ${op} -> rpc ${rpc} with the worker's own arguments`, async () => {
    const { db, calls } = fakeDb({
      rpc: (name) => ({ data: { from: name }, error: null }),
    });
    const result = await runLunaDoor(db, { op, args }, NOW);
    assertEquals(calls, [{ kind: "rpc", args: [rpc, rpcArgs] }]);
    assertEquals(result, { op: op as any, data: { from: rpc }, error: null });
  });
}

Deno.test("luna_door job-scoped reads run only behind the held-run guard, then one fixed call", async () => {
  const cases: [string, Record<string, unknown>, Call][] = [
    ["extraction_events", { ...held, limit: 25 }, {
      kind: "rpc",
      args: ["context_extraction_events", { p_job_id: JOB, p_limit: 25 }],
    }],
    ["extraction_event_flags", { ...held, event_ids: [EV1] }, {
      kind: "rpc",
      args: ["context_extraction_event_flags", {
        p_job_id: JOB,
        p_event_ids: [EV1],
      }],
    }],
    ["job_row", { ...held }, { kind: "jobRow", args: [JOB] }],
    ["current_facts_page", { ...held, offset: 400 }, {
      kind: "currentFactsPage",
      args: [JOB, 400],
    }],
  ];
  for (const [op, args, call] of cases) {
    const { db, calls } = fakeDb();
    await runLunaDoor(db, { op, args }, NOW);
    assertEquals(calls, [
      { kind: "heldExtractionRun", args: [RUN, LEASE, JOB, NOW.toISOString()] },
      call,
    ], op);
  }
});

Deno.test("luna_door feature_flag reads only the three worker flags", async () => {
  for (
    const flag of [
      "context_job_brief_v1",
      "context_job_brief_single_call_v1",
      "context_luna_fallback_claude_v1",
    ]
  ) {
    const { db, calls } = fakeDb();
    const result = await runLunaDoor(
      db,
      { op: "feature_flag", args: { flag } },
      NOW,
    );
    assertEquals(calls, [{ kind: "featureFlag", args: [flag] }]);
    assertEquals(result.data, { enabled: true });
  }
  assertEquals(
    await refused({
      op: "feature_flag",
      args: { flag: "ghl_message_capture_v2" },
    }, "luna_door_args_invalid"),
    [],
  );
});

Deno.test("luna_door passes a database error through as supabase-js's own { data, error }", async () => {
  const { db } = fakeDb({
    rpc: () => ({
      data: null,
      error: { message: "luna_job_revision_invalid", code: "P0001" },
    }),
  });
  const result = await runLunaDoor(db, { op: "revision_rpc_probe" }, NOW);
  assertEquals(result, {
    op: "revision_rpc_probe",
    data: null,
    error: { message: "luna_job_revision_invalid", code: "P0001" },
  });
});

// ── Refusals ───────────────────────────────────────────────────────────────

Deno.test("luna_door refuses an unknown op and never touches the database", async () => {
  for (
    const op of [
      "select",
      "rerun_context_attribution",
      "attribute_context_event_with_luna",
      "persist_luna_context_revision",
      "sql",
      "",
      7,
      null,
    ]
  ) {
    assertEquals(
      await refused({ op, args: {} }, "luna_door_op_unknown"),
      [],
      String(op),
    );
  }
  assertEquals(await refused(null, "luna_door_args_invalid"), []);
  assertEquals(await refused([], "luna_door_args_invalid"), []);
});

Deno.test("luna_door refuses table, column, filter and rpc injection", async () => {
  const attempts: unknown[] = [
    { op: "job_row", args: { ...held, table: "users" } },
    { op: "job_row", args: { ...held, select: "*" } },
    {
      op: "current_facts_page",
      args: { ...held, offset: 0, filter: "job_id.neq.x" },
    },
    { op: "lane_enabled", args: { lane: "extraction", rpc: "exec_sql" } },
    { op: "lane_enabled", args: { lane: "attribution" } },
    { op: "lane_enabled", args: { lane: "capture" } },
    {
      op: "reserve_model_call",
      args: { run_id: RUN, lease_token: LEASE, phase: "attribution" },
    },
    {
      op: "reserve_model_call",
      args: { run_id: RUN, lease_token: LEASE, p_phase: "bucket" },
    },
    {
      op: "claim_extraction_run",
      args: {
        job_id: JOB,
        run_date: DATE,
        pass_lease_token: PASS,
        p_phase: "attribution",
      },
    },
    {
      op: "persist_revision",
      args: {
        run_id: RUN,
        lease_token: LEASE,
        job_id: JOB,
        events: [{ id: EV1 }],
        new: [],
        supersedes: [],
        retracts: [],
        tokens_in: 0,
        extractor_version: "luna_v3",
      },
    },
    { op: "job_row", args: { ...held, job_id: "x' OR 1=1 --" } },
    { op: "job_row", args: { ...held, job_id: `${JOB},id.neq.null` } },
    { op: "claim_pass", args: { run_date: "2026-09-24' OR 1=1" } },
    { op: "claim_pass", args: { run_date: "2026-02-30" } },
    { op: "current_facts_page", args: { ...held, offset: 150 } },
    { op: "current_facts_page", args: { ...held, offset: 10_000 } },
    { op: "extraction_candidates", args: { limit: 401 } },
    { op: "extraction_events", args: { ...held, limit: 26 } },
    {
      op: "extraction_event_flags",
      args: { ...held, event_ids: ["not-a-uuid"] },
    },
    {
      op: "finish_extraction_run",
      args: {
        run_id: RUN,
        lease_token: LEASE,
        status: "skipped",
        event_ids: [],
        tokens_in: 0,
        facts_new: 0,
        facts_superseded: 0,
        facts_retracted: 0,
      },
    },
    {
      op: "finish_extraction_run",
      args: {
        run_id: RUN,
        lease_token: LEASE,
        status: "failed",
        event_ids: [EV1],
        tokens_in: 0,
        facts_new: 0,
        facts_superseded: 0,
        facts_retracted: 0,
      },
    },
    {
      op: "finish_extraction_run",
      args: {
        run_id: RUN,
        lease_token: LEASE,
        status: "failed",
        event_ids: [],
        tokens_in: 0,
        facts_new: 0,
        facts_superseded: 0,
        facts_retracted: 0,
        error: "bad code; drop table",
      },
    },
    {
      op: "finish_pass",
      args: {
        run_date: DATE,
        lease_token: PASS,
        status: "done",
        retry_at: "tomorrow",
      },
    },
    {
      op: "persist_revision",
      args: {
        run_id: RUN,
        lease_token: LEASE,
        job_id: JOB,
        events: [],
        new: [],
        supersedes: [],
        retracts: [],
        tokens_in: 0,
      },
    },
    {
      op: "persist_revision",
      args: {
        run_id: RUN,
        lease_token: LEASE,
        job_id: JOB,
        events: Array(26).fill({ id: EV1 }),
        new: [],
        supersedes: [],
        retracts: [],
        tokens_in: 0,
      },
    },
    {
      op: "persist_revision",
      args: {
        run_id: RUN,
        lease_token: LEASE,
        job_id: JOB,
        events: ["raw"],
        new: [],
        supersedes: [],
        retracts: [],
        tokens_in: 0,
      },
    },
    { op: "lane_enabled", args: { lane: "extraction" }, table: "jobs" },
    { op: "lane_enabled", args: "lane=extraction" },
  ];
  for (const body of attempts) {
    assertEquals(
      await refused(body, "luna_door_args_invalid"),
      [],
      JSON.stringify(body),
    );
  }
});

Deno.test("luna_door refuses a job-scoped read when the caller does not hold that job's run", async () => {
  for (
    const result of [{ data: null, error: null }, {
      data: { id: "someone-else" },
      error: null,
    }]
  ) {
    const db = fakeDb({ held: result });
    const calls = await refused(
      { op: "extraction_events", args: { ...held } },
      "luna_door_run_not_held",
      db,
    );
    assertEquals(calls.map((c) => c.kind), ["heldExtractionRun"]);
  }
  const db = fakeDb({
    held: { data: null, error: { message: "x", code: null } },
  });
  const calls = await refused(
    { op: "job_row", args: { ...held } },
    "luna_door_guard_unreadable",
    db,
  );
  assertEquals(calls.map((c) => c.kind), ["heldExtractionRun"]);
});

Deno.test("luna_door claim_extraction_run renews the pass, applies the tick bound, then claims extraction only", async () => {
  const args = { job_id: JOB, run_date: DATE, pass_lease_token: PASS };
  const { db, calls } = fakeDb();
  await runLunaDoor(db, { op: "claim_extraction_run", args }, NOW);
  assertEquals(calls, [
    {
      kind: "rpc",
      args: ["renew_context_pass", { p_run_date: DATE, p_lease_token: PASS }],
    },
    { kind: "rpc", args: ["context_cadence_policy", {}] },
    {
      kind: "recentExtractionClaims",
      args: [DATE, NOW.toISOString(), "2026-09-24T02:55:00.000Z", 10],
    },
    {
      kind: "rpc",
      args: ["claim_context_extraction_run", {
        p_job_id: JOB,
        p_run_date: DATE,
        p_phase: "extraction",
      }],
    },
  ]);
});

Deno.test("luna_door refuses a claim without the pass, and past tick_max_jobs in the window", async () => {
  const args = { job_id: JOB, run_date: DATE, pass_lease_token: PASS };
  const lost = fakeDb({
    rpc: (name) =>
      name === "renew_context_pass"
        ? { data: false, error: null }
        : { data: null, error: null },
  });
  let calls = await refused(
    { op: "claim_extraction_run", args },
    "luna_door_pass_lease_lost",
    lost,
  );
  assertEquals(calls.length, 1);

  const full = fakeDb({
    recent: { data: Array(10).fill({ id: RUN }), error: null },
  });
  calls = await refused(
    { op: "claim_extraction_run", args },
    "luna_door_tick_max_jobs",
    full,
  );
  assert(!calls.some((c) => c.args[0] === "claim_context_extraction_run"));

  const nine = fakeDb({
    recent: { data: Array(9).fill({ id: RUN }), error: null },
  });
  await runLunaDoor(nine.db, { op: "claim_extraction_run", args }, NOW);
  assertEquals(nine.calls.at(-1)?.args[0], "claim_context_extraction_run");

  const badPolicy = fakeDb({
    rpc: (name) =>
      name === "renew_context_pass"
        ? { data: true, error: null }
        : { data: {}, error: null },
  });
  calls = await refused(
    { op: "claim_extraction_run", args },
    "luna_door_guard_unreadable",
    badPolicy,
  );
  assert(!calls.some((c) => c.args[0] === "claim_context_extraction_run"));
});

Deno.test("luna_door enforces the 400-a-day cap only through reserve_context_model_call", async () => {
  // The cap lives in the rpc; the door reserves one call per request, always
  // as extraction, and hands back the rpc's own `cap` answer unchanged.
  const { db, calls } = fakeDb({
    rpc: () => ({ data: { outcome: "cap" }, error: null }),
  });
  const result = await runLunaDoor(db, {
    op: "reserve_model_call",
    args: { run_id: RUN, lease_token: LEASE },
  }, NOW);
  assertEquals(result.data, { outcome: "cap" });
  assertEquals(calls, [{
    kind: "rpc",
    args: ["reserve_context_model_call", {
      p_phase: "extraction",
      p_run_id: RUN,
      p_lease_token: LEASE,
    }],
  }]);
  // Nothing else on the door can spend or refund a reservation.
  assert(
    !Object.values(LUNA_DOOR_OP_ARGS).flat().some((k) =>
      /phase|ordinal|reservation/.test(k)
    ),
  );
});

Deno.test("luna_door refuses an oversized body before parsing", async () => {
  const text = "x".repeat(LUNA_DOOR_MAX_BODY_BYTES);
  assertEquals(
    await refused(
      { op: "cadence_policy", args: {}, pad: text },
      "luna_door_body_too_large",
    ),
    [],
  );
});

Deno.test("luna_door op list is the extraction path only", () => {
  assertEquals([...LUNA_DOOR_OPS].sort(), [
    "cadence_policy",
    "claim_extraction_run",
    "claim_pass",
    "current_facts_page",
    "extraction_candidates",
    "extraction_event_flags",
    "extraction_events",
    "feature_flag",
    "finish_extraction_run",
    "finish_pass",
    "job_row",
    "lane_enabled",
    "persist_revision",
    "renew_extraction_run",
    "renew_pass",
    "reserve_model_call",
    "revision_rpc_probe",
  ]);
});

// ── Credential and actor ───────────────────────────────────────────────────

const KEYS = {
  agentServerKey: "agent",
  sharedKey: "shared",
  serviceKey: "service",
  routineKey: "routine",
};

Deno.test("luna_door accepts OPS_AGENT_SERVER_KEY alone and refuses every other key", () => {
  const ok = (
    xApiKey: string | null,
    bearerToken: string | null,
    keys = KEYS,
  ) => lunaDoorCredentialOk({ xApiKey, bearerToken, ...keys });
  assert(ok("agent", null));
  assert(ok(null, "agent"));
  assert(ok("agent", "agent"));
  assert(!ok(null, null), "missing key");
  assert(!ok("shared", null), "SW_API_KEY");
  assert(!ok(null, "shared"), "SW_API_KEY bearer");
  assert(!ok("service", null), "service role");
  assert(!ok("routine", null), "routine");
  assert(!ok(null, "user.jwt.token"), "signed-in user");
  assert(!ok("shared", "agent"), "agent key beside the browser key");
  assert(!ok("agent", "user.jwt.token"), "agent key beside a user session");
  assert(
    !ok("agent", null, { ...KEYS, agentServerKey: "" }),
    "agent key unset",
  );
  assert(
    !ok("shared", null, { ...KEYS, agentServerKey: "shared" }),
    "agent key colliding with SW_API_KEY",
  );
  assert(
    !ok("service", null, { ...KEYS, agentServerKey: "service" }),
    "agent key colliding with service key",
  );
});

Deno.test("luna_door requires a trusted luna-local: actor", () => {
  assert(lunaDoorActorOk({ actor: "luna-local:claude", source: "header" }));
  assert(
    lunaDoorActorOk({ actor: "luna-local:cursor-grok", source: "header" }),
  );
  assert(!lunaDoorActorOk({ actor: "actor_missing", source: "none" }));
  assert(
    !lunaDoorActorOk({ actor: "actor_missing", source: "header_untrusted" }),
  );
  assert(
    !lunaDoorActorOk({ actor: "actor_missing", source: "header_invalid" }),
  );
  assert(!lunaDoorActorOk({ actor: "luna-local:", source: "header" }));
  assert(!lunaDoorActorOk({ actor: "luna-railway:worker", source: "header" }));
  assert(!lunaDoorActorOk({ actor: "user:luna-local:x", source: "jwt" }));
  assert(!lunaDoorActorOk({ actor: "luna-local:claude", source: "jwt" }));
});

Deno.test("authorizeLunaDoor refuses key, then actor, then method", () => {
  const credential = { xApiKey: "agent", bearerToken: null, ...KEYS };
  const actor = { actor: "luna-local:claude", source: "header" };
  authorizeLunaDoor({ method: "POST", credential, actor });
  const code = (fn: () => void) =>
    (assertThrows(fn, LunaDoorError) as LunaDoorError).code;
  assertEquals(
    code(() =>
      authorizeLunaDoor({
        method: "POST",
        credential: { ...credential, xApiKey: "shared" },
        actor,
      })
    ),
    "luna_door_credential_refused",
  );
  assertEquals(
    code(() =>
      authorizeLunaDoor({
        method: "POST",
        credential: { ...credential, xApiKey: null },
        actor,
      })
    ),
    "luna_door_credential_refused",
  );
  assertEquals(
    code(() =>
      authorizeLunaDoor({
        method: "POST",
        credential,
        actor: { actor: "claude", source: "header" },
      })
    ),
    "luna_door_actor_refused",
  );
  assertEquals(
    code(() => authorizeLunaDoor({ method: "GET", credential, actor })),
    "luna_door_method",
  );
});

// ── The production binding issues exactly the worker's selects ─────────────

function recordingClient() {
  const chains: unknown[][] = [];
  const client = {
    rpc: (name: string, args: unknown) => {
      chains.push(["rpc", name, args]);
      return Promise.resolve({ data: true, error: null });
    },
    from: (table: string) => {
      const chain: unknown[] = ["from", table];
      chains.push(chain);
      const builder: any = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) =>
              resolve({
                data: [{ id: RUN }],
                error: {
                  message: "boom",
                  code: "42703",
                  details: "secret detail",
                  hint: "h",
                },
              });
          }
          return (...args: unknown[]) => {
            chain.push([prop, ...args]);
            return builder;
          };
        },
      });
      return builder;
    },
  };
  return { client, chains };
}

Deno.test("supabaseLunaDoorDb binds each read to the worker's exact select shape", async () => {
  const { client, chains } = recordingClient();
  const db = supabaseLunaDoorDb(client);
  await db.featureFlag("context_job_brief_v1");
  await db.jobRow(JOB);
  await db.currentFactsPage(JOB, 200);
  await db.heldExtractionRun(RUN, LEASE, JOB, NOW.toISOString());
  await db.recentExtractionClaims(
    DATE,
    NOW.toISOString(),
    "2026-09-24T02:55:00.000Z",
    10,
  );
  assertEquals(chains, [
    ["from", "feature_flags", ["select", "enabled"], [
      "eq",
      "flag_name",
      "context_job_brief_v1",
    ], ["maybeSingle"]],
    [
      "from",
      "jobs",
      ["select", "id,job_number,type,status,site_suburb,ghl_contact_id"],
      ["eq", "id", JOB],
      ["single"],
    ],
    [
      "from",
      "current_job_context_facts",
      ["select", "*"],
      ["eq", "job_id", JOB],
      ["order", "id"],
      ["order", "_context_store"],
      ["range", 200, 399],
    ],
    [
      "from",
      "context_extraction_runs",
      ["select", "id"],
      ["eq", "id", RUN],
      ["eq", "lease_token", LEASE],
      ["eq", "job_id", JOB],
      ["eq", "phase", "extraction"],
      ["eq", "status", "running"],
      ["gt", "lease_expires_at", NOW.toISOString()],
      ["maybeSingle"],
    ],
    [
      "from",
      "context_extraction_runs",
      ["select", "id"],
      ["eq", "run_date", DATE],
      ["eq", "phase", "extraction"],
      [
        "or",
        `and(status.eq.running,lease_expires_at.gt."${NOW.toISOString()}"),finished_at.gt."2026-09-24T02:55:00.000Z"`,
      ],
      ["limit", 10],
    ],
  ]);
});

Deno.test("supabaseLunaDoorDb returns only message and code of an error, and no data beside it", async () => {
  const { client } = recordingClient();
  const result = await supabaseLunaDoorDb(client).jobRow(JOB);
  assertEquals(result, {
    data: null,
    error: { message: "boom", code: "42703" },
  });
});

Deno.test("supabaseLunaDoorDb refuses an rpc name outside the closed list", () => {
  const { client, chains } = recordingClient();
  assertThrows(
    () => supabaseLunaDoorDb(client).rpc("exec_sql" as any, {}),
    LunaDoorError,
  );
  assertEquals(chains, []);
});
