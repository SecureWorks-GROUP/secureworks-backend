/**
 * luna_door through the real ops-api request handler (docs/context/luna-door.md):
 *  - OPS_AGENT_SERVER_KEY + a `luna-local:` actor reaches exactly one
 *    PostgREST call, with the worker's own rpc name and arguments, and gets
 *    back supabase-js's `{ data, error }` for that call, the actor on the log;
 *  - a missing key, the browser-distributed SW_API_KEY, the service-role key,
 *    a signed-in staff session, a wrong or missing actor, GET, an unknown op
 *    and an injected table are refused before any database call.
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const SERVICE_KEY = "test-service-role-key";
const SHARED_KEY = "test-shared-browser-key";
const AGENT_KEY = "test-agent-server-key";
const USER_JWT = "test-signed-in-admin-jwt";
const ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SW_API_KEY",
  "AGENT_BEARER_TOKEN",
  "MAKESAFE_ROUTINE_KEY",
  "OPS_AGENT_SERVER_KEY",
];
const BASE_ENV: Record<string, string | undefined> = {
  // A closed local port: an unexpected real database call fails loudly.
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  SW_API_KEY: SHARED_KEY,
  OPS_AGENT_SERVER_KEY: AGENT_KEY,
};
const RPC = "http://127.0.0.1:9/rest/v1/rpc/";

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map(ENV_NAMES.map((n) => [n, Deno.env.get(n)]));
  for (const name of ENV_NAMES) {
    const value = BASE_ENV[name];
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

let handlerPromise: Promise<(req: Request) => Promise<Response>> | null = null;
function handler() {
  handlerPromise ??= withEnv(async () =>
    (await import("./index.ts"))._opsApiRequestHandlerForTest
  );
  return handlerPromise;
}

type Fetched = { url: string; method: string; body: unknown; headers: Headers };

async function call(
  headers: Record<string, string>,
  opts: {
    method?: string;
    body?: unknown;
    respond?: (f: Fetched) => Response | null;
  } = {},
) {
  const handle = await handler();
  const fetches: Fetched[] = [];
  const logs: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const g = globalThis as any;
  const hadRuntime = "EdgeRuntime" in g;
  const originalRuntime = g.EdgeRuntime;
  delete g.EdgeRuntime;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const raw = init?.body;
    const f: Fetched = {
      url,
      method: String(init?.method ?? "GET"),
      body: typeof raw === "string" && raw ? JSON.parse(raw) : raw ?? null,
      headers: new Headers(init?.headers),
    };
    fetches.push(f);
    const r = opts.respond?.(f);
    if (r) return Promise.resolve(r);
    if (url.startsWith("http://127.0.0.1:9/auth/v1/user")) {
      return Promise.resolve(
        Response.json({ id: "admin-user", email: "", aud: "authenticated" }),
      );
    }
    if (url.startsWith("http://127.0.0.1:9/rest/v1/users?")) {
      return Promise.resolve(
        Response.json({
          org_id: "00000000-0000-0000-0000-000000000001",
          role: "admin",
          managed_verticals: [],
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  try {
    const method = opts.method ?? "POST";
    const init: RequestInit = {
      method,
      headers: { ...headers, "content-type": "application/json" },
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const res = await withEnv(() =>
      handle(
        new Request("https://example.invalid/ops-api?action=luna_door", init),
      )
    );
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch { /* not JSON */ }
    return { res, body: body as any, fetches, logs };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (hadRuntime) g.EdgeRuntime = originalRuntime;
  }
}

const AGENT = {
  authorization: `Bearer ${AGENT_KEY}`,
  "x-sw-actor": "luna-local:claude",
};
const dbFetches = (fetches: Fetched[]) =>
  fetches.filter((f) => f.url.startsWith("http://127.0.0.1:9/rest/v1/"));

Deno.test("luna_door serves an allow-listed op as one service-role rpc and returns its { data, error }", async () => {
  const { res, body, fetches, logs } = await call(AGENT, {
    body: { op: "lane_enabled", args: { lane: "extraction" } },
    respond: (f) =>
      f.url === `${RPC}automation_lane_enabled` ? Response.json(true) : null,
  });
  assertEquals(res.status, 200);
  assertEquals(body, { op: "lane_enabled", data: true, error: null });
  const db = dbFetches(fetches);
  assertEquals(db.length, 1);
  assertEquals(db[0].url, `${RPC}automation_lane_enabled`);
  assertEquals(db[0].method, "POST");
  assertEquals(db[0].body, { lane: "extraction" });
  // Server-side under the service role, never the caller's key.
  assertEquals(db[0].headers.get("apikey"), SERVICE_KEY);
  assert(!JSON.stringify(body).includes(SERVICE_KEY));
  assert(
    logs.some((l) =>
      l.includes("action=luna_door") && l.includes("actor=luna-local:claude") &&
      l.includes("actor_source=header")
    ),
  );
});

Deno.test("luna_door returns the probe's database error the way the worker reads it", async () => {
  const { res, body } = await call(AGENT, {
    body: { op: "revision_rpc_probe" },
    respond: (f) =>
      f.url === `${RPC}persist_luna_context_revision`
        ? Response.json({
          message: "luna_job_revision_invalid",
          code: "P0001",
          details: null,
          hint: null,
        }, { status: 400 })
        : null,
  });
  assertEquals(res.status, 200);
  assertEquals(body, {
    op: "revision_rpc_probe",
    data: null,
    error: { message: "luna_job_revision_invalid", code: "P0001" },
  });
});

Deno.test("luna_door reserve_model_call hands back the rpc's own cap answer", async () => {
  const run = "22222222-2222-4222-8222-222222222222";
  const lease = "33333333-3333-4333-8333-333333333333";
  const { body, fetches } = await call(AGENT, {
    body: {
      op: "reserve_model_call",
      args: { run_id: run, lease_token: lease },
    },
    respond: (f) =>
      f.url === `${RPC}reserve_context_model_call`
        ? Response.json({ outcome: "cap" })
        : null,
  });
  assertEquals(body, {
    op: "reserve_model_call",
    data: { outcome: "cap" },
    error: null,
  });
  assertEquals(dbFetches(fetches).map((f) => f.body), [{
    p_phase: "extraction",
    p_run_id: run,
    p_lease_token: lease,
  }]);
});

const REFUSALS: [
  string,
  Record<string, string>,
  { method?: string; body?: unknown },
  number,
  string | null,
][] = [
  ["missing key", { "x-sw-actor": "luna-local:claude" }, {}, 401, null],
  [
    "SW_API_KEY in x-api-key",
    { "x-api-key": SHARED_KEY, "x-sw-actor": "luna-local:claude" },
    {},
    401,
    "user_jwt_required",
  ],
  [
    "SW_API_KEY as bearer",
    {
      authorization: `Bearer ${SHARED_KEY}`,
      "x-sw-actor": "luna-local:claude",
    },
    {},
    401,
    "user_jwt_required",
  ],
  [
    "service-role key",
    {
      authorization: `Bearer ${SERVICE_KEY}`,
      "x-sw-actor": "luna-local:claude",
    },
    {},
    403,
    "luna_door_credential_refused",
  ],
  [
    "signed-in staff session",
    { authorization: `Bearer ${USER_JWT}`, "x-sw-actor": "luna-local:claude" },
    {},
    403,
    "luna_door_credential_refused",
  ],
  [
    "agent key beside SW_API_KEY",
    { ...AGENT, "x-api-key": SHARED_KEY },
    {},
    403,
    "luna_door_credential_refused",
  ],
  [
    "no actor",
    { authorization: `Bearer ${AGENT_KEY}` },
    {},
    403,
    "luna_door_actor_refused",
  ],
  [
    "wrong actor",
    { authorization: `Bearer ${AGENT_KEY}`, "x-sw-actor": "cio-desk" },
    {},
    403,
    "luna_door_actor_refused",
  ],
  [
    "malformed actor",
    { authorization: `Bearer ${AGENT_KEY}`, "x-sw-actor": "luna-local:a b" },
    {},
    403,
    "luna_door_actor_refused",
  ],
  ["GET", AGENT, { method: "GET" }, 405, "luna_door_method"],
  [
    "unknown op",
    AGENT,
    { body: { op: "rerun_context_attribution", args: {} } },
    400,
    "luna_door_op_unknown",
  ],
  [
    "table injection",
    AGENT,
    { body: { op: "job_row", args: { job_id: "x", table: "users" } } },
    400,
    "luna_door_args_invalid",
  ],
  ["empty body", AGENT, {}, 400, "luna_door_args_invalid"],
];

for (const [name, headers, opts, status, code] of REFUSALS) {
  Deno.test(`luna_door refuses: ${name}, with no database call`, async () => {
    const body = opts.body ??
      (opts.method === "GET"
        ? undefined
        : name === "empty body"
        ? undefined
        : { op: "cadence_policy" });
    const { res, body: out, fetches } = await call(headers, {
      method: opts.method,
      body,
    });
    assertEquals(res.status, status);
    if (code) assertEquals(out.code, code);
    assertEquals(
      dbFetches(fetches).filter((f) => !f.url.includes("/rest/v1/users?")),
      [],
    );
  });
}
