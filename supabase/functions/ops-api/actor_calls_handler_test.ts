/**
 * F-ACT (INTEGRATION X31), through the real ops-api request handler:
 *  - a server-key call with no x-sw-actor (today's MCP and sw-axi doors) is
 *    served exactly as before, logged actor_missing and counted missing;
 *  - the same call with the header F-ACT-RT sends is logged with that actor
 *    and counted present;
 *  - a malformed header is logged actor_missing and counted invalid_header;
 *  - the count is the only extra request, is handed to EdgeRuntime.waitUntil,
 *    and a failed count does not change the response;
 *  - with no EdgeRuntime (every other handler test) nothing extra is called.
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SERVICE_KEY = "test-service-role-key";
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
  fetches: { url: string; body: unknown }[];
  logs: string[];
  warns: string[];
  waited: Promise<unknown>[];
};

async function run(
  headers: Record<string, string>,
  opts: { edgeRuntime: boolean; countStatus?: number },
): Promise<{ res: Response; seen: Seen }> {
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
      body: typeof raw === "string" ? JSON.parse(raw) : raw ?? null,
    });
    return Promise.resolve(
      opts.countStatus === 404
        ? new Response('{"code":"PGRST202"}', { status: 404 })
        : new Response(null, { status: 204 }),
    );
  }) as typeof fetch;
  console.log = (...a: unknown[]) => seen.logs.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => seen.warns.push(a.map(String).join(" "));
  if (opts.edgeRuntime) {
    g.EdgeRuntime = { waitUntil: (p: Promise<unknown>) => seen.waited.push(p) };
  } else {
    delete g.EdgeRuntime;
  }
  try {
    const res = await withEnv(() =>
      handle(
        new Request("https://example.invalid/ops-api?action=ops_api_version", {
          method: "GET",
          headers: { authorization: `Bearer ${SERVICE_KEY}`, ...headers },
        }),
      )
    );
    await Promise.all(seen.waited);
    return { res, seen };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    if (hadRuntime) g.EdgeRuntime = originalRuntime;
    else delete g.EdgeRuntime;
  }
}

function requestLines(seen: Seen) {
  return seen.logs.filter((l) => l.startsWith("[ops-api] action="));
}

Deno.test("server-key call with no actor: served, logged actor_missing, counted missing", async () => {
  const baseline = await run({}, { edgeRuntime: false });
  const { res, seen } = await run({}, { edgeRuntime: true });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), await baseline.res.json());
  assertEquals(requestLines(seen), [
    "[ops-api] action=ops_api_version method=GET actor=actor_missing actor_source=none",
  ]);
  assertEquals(seen.waited.length, 1);
  assertEquals(seen.fetches, [{
    url: "http://127.0.0.1:9/rest/v1/rpc/record_ops_api_actor_call",
    body: {
      p_caller_class: "api_key",
      p_actor_state: "missing",
      p_action: "ops_api_version",
    },
  }]);
  assertEquals(seen.warns, []);
});

Deno.test("the header F-ACT-RT sends is logged and counted present", async () => {
  const { res, seen } = await run({ "x-sw-actor": "workflow:census" }, {
    edgeRuntime: true,
  });
  assertEquals(res.status, 200);
  assertEquals(requestLines(seen), [
    "[ops-api] action=ops_api_version method=GET actor=workflow:census actor_source=header",
  ]);
  assertEquals((seen.fetches[0].body as any).p_actor_state, "present");
});

Deno.test("a malformed header: logged actor_missing, value never logged, counted invalid_header", async () => {
  const { res, seen } = await run({ "x-sw-actor": "evil value; drop" }, {
    edgeRuntime: true,
  });
  assertEquals(res.status, 200);
  assertEquals(requestLines(seen), [
    "[ops-api] action=ops_api_version method=GET actor=actor_missing actor_source=header_invalid",
  ]);
  assertEquals(seen.logs.some((l) => l.includes("evil")), false);
  assertEquals((seen.fetches[0].body as any).p_actor_state, "invalid_header");
});

Deno.test("a failed count does not change the response", async () => {
  const baseline = await run({}, { edgeRuntime: false });
  const { res, seen } = await run({}, { edgeRuntime: true, countStatus: 404 });
  assertEquals(res.status, 200);
  assertEquals(seen.warns, [
    '{"event":"ops_api_actor_count_failed","code":"PGRST202"}',
  ]);
  assertEquals(await res.json(), await baseline.res.json());
});

Deno.test("no EdgeRuntime: the handler makes no extra request", async () => {
  const { res, seen } = await run({}, { edgeRuntime: false });
  assertEquals(res.status, 200);
  assertEquals(seen.fetches, []);
  assertEquals(requestLines(seen).length, 1);
});
