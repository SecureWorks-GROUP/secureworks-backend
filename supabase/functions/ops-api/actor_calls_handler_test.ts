/**
 * F-ACT (INTEGRATION X31), through the real ops-api request handler:
 *  - a server-key call with no x-sw-actor (today's MCP and sw-axi doors) is
 *    served exactly as before, logged actor_missing and counted once;
 *  - the same call with the header F-ACT-RT sends is logged with that actor
 *    and writes nothing;
 *  - a malformed header is logged actor_missing, its value never logged, and
 *    counted;
 *  - a call the front door refuses (a signed-in trade on a staff action, the
 *    shared browser key) gets exactly the refusal it got before, and one line
 *    with the verified or claimed actor and the refusal code;
 *  - the count is the only extra request, is handed to EdgeRuntime.waitUntil,
 *    and a failed count does not change the response;
 *  - with no EdgeRuntime (every other handler test) nothing extra is called.
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SERVICE_KEY = "test-service-role-key";
const SHARED_KEY = "test-shared-browser-key";
const USER_JWT = "test-signed-in-trade-jwt";
const TRADE_ID = "7d4f0a52-0000-4000-8000-00000000f4c7";
const ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SW_API_KEY",
  "AGENT_BEARER_TOKEN",
  "MAKESAFE_ROUTINE_KEY",
  "OPS_AGENT_SERVER_KEY",
];
const BASE_ENV: Record<string, string | undefined> = {
  // A closed local port: a real database call would fail loudly.
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  SW_API_KEY: SHARED_KEY,
};

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

type Seen = {
  fetches: { url: string; method: string; body: unknown }[];
  logs: string[];
  warns: string[];
  waited: Promise<unknown>[];
};

type FetchRequest = Seen["fetches"][number];
type RunOptions = {
  edgeRuntime: boolean;
  countStatus?: number;
  method?: string;
  body?: unknown;
  respond?: (request: FetchRequest) => Response | null;
};

const COUNT_URL = "http://127.0.0.1:9/rest/v1/rpc/record_ops_api_actor_missing";

// The provider side of the signed-in trade: Supabase Auth knows the token, and
// the users profile says the role is trade. Everything else 404s.
function provider(url: string, countStatus: number): Response {
  if (url === COUNT_URL) {
    return countStatus === 404
      ? new Response('{"code":"PGRST202"}', { status: 404 })
      : new Response(null, { status: 204 });
  }
  if (url.startsWith("http://127.0.0.1:9/auth/v1/user")) {
    return Response.json({ id: TRADE_ID, email: "", aud: "authenticated" });
  }
  if (url.startsWith("http://127.0.0.1:9/rest/v1/users?")) {
    return Response.json({
      org_id: "00000000-0000-0000-0000-000000000001",
      role: "trade",
      managed_verticals: [],
    });
  }
  return new Response("{}", { status: 404 });
}

async function run(
  action: string,
  headers: Record<string, string>,
  opts: RunOptions,
): Promise<{ res: Response; body: unknown; seen: Seen }> {
  const handle = await handler();
  const seen: Seen = { fetches: [], logs: [], warns: [], waited: [] };
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const g = globalThis as any;
  const hadRuntime = "EdgeRuntime" in g;
  const originalRuntime = g.EdgeRuntime;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const raw = init?.body;
    seen.fetches.push({
      url,
      method: String(init?.method ?? "GET"),
      body: typeof raw === "string" && raw ? JSON.parse(raw) : raw ?? null,
    });
    const response = opts.respond?.(seen.fetches[seen.fetches.length - 1]);
    if (response) return Promise.resolve(response);
    return Promise.resolve(provider(url, opts.countStatus ?? 204));
  }) as typeof fetch;
  console.log = (...a: unknown[]) => seen.logs.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => seen.warns.push(a.map(String).join(" "));
  if (opts.edgeRuntime) {
    g.EdgeRuntime = { waitUntil: (p: Promise<unknown>) => seen.waited.push(p) };
  } else {
    delete g.EdgeRuntime;
  }
  try {
    const method = opts.method ?? "GET";
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      init.headers = { ...headers, "content-type": "application/json" };
      init.body = JSON.stringify(opts.body);
    }
    const res = await withEnv(() =>
      handle(
        new Request(`https://example.invalid/ops-api?action=${action}`, init),
      )
    );
    const body = await res.json();
    await Promise.all(seen.waited);
    return { res, body, seen };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    if (hadRuntime) g.EdgeRuntime = originalRuntime;
    else delete g.EdgeRuntime;
  }
}

const SERVICE = { authorization: `Bearer ${SERVICE_KEY}` };

function actorLines(seen: Seen) {
  return seen.logs.filter((l) =>
    l.startsWith("[ops-api] action=") || l.startsWith("[ops-api] denied ")
  );
}

function countCalls(seen: Seen) {
  return seen.fetches.filter((f) => f.url === COUNT_URL);
}

Deno.test("server-key call with no actor: served as before, logged actor_missing, counted once", async () => {
  const baseline = await run("ops_api_version", SERVICE, {
    edgeRuntime: false,
  });
  const { res, body, seen } = await run("ops_api_version", SERVICE, {
    edgeRuntime: true,
  });
  assertEquals(res.status, 200);
  assertEquals(body, baseline.body);
  assertEquals(actorLines(seen), [
    "[ops-api] action=ops_api_version method=GET actor=actor_missing actor_source=none",
  ]);
  assertEquals(seen.waited.length, 1);
  assertEquals(seen.fetches.length, 1);
  assertEquals(countCalls(seen).length, 1);
  assertEquals(countCalls(seen)[0].method, "POST");
  assertEquals(seen.warns, []);
});

Deno.test("the header F-ACT-RT sends is logged and writes nothing", async () => {
  const { res, seen } = await run(
    "ops_api_version",
    { ...SERVICE, "x-sw-actor": "workflow:census" },
    { edgeRuntime: true },
  );
  assertEquals(res.status, 200);
  assertEquals(actorLines(seen), [
    "[ops-api] action=ops_api_version method=GET actor=workflow:census actor_source=header",
  ]);
  assertEquals(seen.fetches, []);
  assertEquals(seen.waited, []);
});

Deno.test("a malformed header: logged actor_missing, value never logged, counted", async () => {
  const { res, seen } = await run(
    "ops_api_version",
    { ...SERVICE, "x-sw-actor": "evil value; drop" },
    { edgeRuntime: true },
  );
  assertEquals(res.status, 200);
  assertEquals(actorLines(seen), [
    "[ops-api] action=ops_api_version method=GET actor=actor_missing actor_source=header_invalid",
  ]);
  assertEquals(seen.logs.some((l) => l.includes("evil")), false);
  assertEquals(countCalls(seen).length, 1);
});

Deno.test("a signed-in trade refused a staff action: same refusal, one line with the verified user and the code", async () => {
  const headers = {
    authorization: `Bearer ${USER_JWT}`,
    "x-sw-actor": "workflow:spoof",
  };
  const baseline = await run("pipeline", headers, { edgeRuntime: false });
  const { res, body, seen } = await run("pipeline", headers, {
    edgeRuntime: true,
  });
  assertEquals(res.status, 403);
  assertEquals(baseline.res.status, 403);
  assertEquals(body, baseline.body);
  assertEquals((body as any).code, "operator_access_required");
  assertEquals(actorLines(seen), [
    `[ops-api] denied action=pipeline method=GET actor=user:${TRADE_ID} actor_source=jwt status=403 code=operator_access_required`,
  ]);
  // A JWT call is never counted: its user is verified.
  assertEquals(countCalls(seen), []);
});

Deno.test("the shared browser key refused: same 401, the claimed actor logged, missing counted", async () => {
  const claimed = await run(
    "makesafe_board",
    { "x-api-key": SHARED_KEY, "x-sw-actor": "marnin" },
    { edgeRuntime: true },
  );
  assertEquals(claimed.res.status, 401);
  assertEquals(claimed.body, {
    error: "A signed-in Supabase user session is required.",
    code: "user_jwt_required",
  });
  assertEquals(actorLines(claimed.seen), [
    "[ops-api] denied action=makesafe_board method=GET actor=marnin actor_source=header status=401 code=user_jwt_required",
  ]);
  assertEquals(countCalls(claimed.seen), []);

  const missing = await run("makesafe_board", { "x-api-key": SHARED_KEY }, {
    edgeRuntime: true,
  });
  assertEquals(missing.res.status, 401);
  assertEquals(missing.body, claimed.body);
  assertEquals(actorLines(missing.seen), [
    "[ops-api] denied action=makesafe_board method=GET actor=actor_missing actor_source=none status=401 code=user_jwt_required",
  ]);
  assertEquals(countCalls(missing.seen).length, 1);
});

Deno.test("a failed count does not change the response", async () => {
  const baseline = await run("ops_api_version", SERVICE, {
    edgeRuntime: false,
  });
  const { res, body, seen } = await run("ops_api_version", SERVICE, {
    edgeRuntime: true,
    countStatus: 404,
  });
  assertEquals(res.status, 200);
  assertEquals(body, baseline.body);
  assertEquals(seen.warns, [
    '{"event":"ops_api_actor_count_failed","code":"PGRST202"}',
  ]);
});

Deno.test("no EdgeRuntime: the handler makes no extra request", async () => {
  const { res, seen } = await run("ops_api_version", SERVICE, {
    edgeRuntime: false,
  });
  assertEquals(res.status, 200);
  assertEquals(seen.fetches, []);
  assertEquals(actorLines(seen).length, 1);
});

Deno.test("sales booking receipt stores the resolved actor or actor_missing", async () => {
  const saved: unknown[] = [];
  const respond = (request: FetchRequest) => {
    if (!new URL(request.url).pathname.endsWith("/sales_booking_packs")) {
      return null;
    }
    saved.push(request.body);
    return Response.json({
      id: "00000000-0000-4000-8000-000000000101",
      as_of: "2026-09-24T01:00:00.000Z",
    });
  };
  const body = {
    resource: "marnin",
    week_start: "2026-09-21",
    as_of: "2026-09-24T01:00:00.000Z",
    proposals: {},
    coverage: {},
    drafts: {},
  };
  const withActor = await run("sales_booking_pack_publish", {
    ...SERVICE,
    "x-sw-actor": "marnin",
  }, { edgeRuntime: false, method: "POST", body, respond });
  const withoutActor = await run("sales_booking_pack_publish", SERVICE, {
    edgeRuntime: false,
    method: "POST",
    body,
    respond,
  });

  assertEquals(withActor.res.status, 200);
  assertEquals(withoutActor.res.status, 200);
  assertEquals((saved[0] as any).published_by, "marnin");
  assertEquals((saved[1] as any).published_by, "actor_missing");
});

Deno.test("gap-fill receipt ignores a spoofed body actor", async () => {
  const caseRow: Record<string, unknown> = {
    id: "00000000-0000-4000-8000-000000000201",
    instruction_key: "MLB:PO-12345",
    state: "exception",
    reason_code: "missing_client_name",
    missing_fields: ["client_name"],
    conflicting_fields: {},
    blocked_reasons: [],
    job_id: null,
    is_authoritative: true,
    normaliser_version: "fixture-v1",
    company_id: null,
    company_slug_raw: "mlb",
    external_ref_canonical: null,
    builder_wo_canonical: null,
    builder_po_canonical: "PO-12345",
    deliverable_ref_canonical: null,
    client_name: null,
    client_phone: null,
    client_email: null,
    site_address: null,
    site_suburb: null,
    evidence_map: {},
    received_at: "2026-09-24T01:00:00.000Z",
    last_decision_provenance: "deterministic",
    last_decision_reason: "prior reason",
  };
  let persisted: Record<string, unknown> | null = null;
  const respond = (request: FetchRequest) => {
    const table = new URL(request.url).pathname.split("/").pop();
    if (table === "makesafe_intake_cases" && request.method === "GET") {
      return Response.json(caseRow);
    }
    if (table === "makesafe_intake_case_sources") return Response.json([]);
    if (table === "makesafe_intake_cases" && request.method === "PATCH") {
      persisted = request.body as Record<string, unknown>;
      Object.assign(caseRow, persisted);
      return Response.json({
        id: caseRow.id,
        instruction_key: caseRow.instruction_key,
        state: caseRow.state,
      });
    }
    return null;
  };
  const { res } = await run("makesafe_gap_fill_apply", {
    ...SERVICE,
    "x-sw-actor": "marnin",
  }, {
    edgeRuntime: false,
    method: "POST",
    body: {
      case_id: caseRow.id,
      instruction_key: caseRow.instruction_key,
      fills: { client_name: "Jane Smith" },
      evidence_note: "name on work order",
      actor: "someone-else",
    },
    respond,
  });

  assertEquals(res.status, 200);
  assertEquals((persisted as any)?.last_decision_actor, "marnin");
  assertEquals((persisted as any)?.last_decision_actor === "someone-else", false);
});
