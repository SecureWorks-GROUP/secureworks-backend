/**
 * Old booking machinery, 23 Sep 2026 (booking review Part B, gaps 12 and 15).
 *
 * What these prove, through the real ops-api request handler:
 *  - book_scope, assign_scoper and sales_booking_stamp_write are retired: each
 *    answers HTTP 400 `Unknown action` and writes nothing.
 *  - approve_booking_proposal still reaches the Railway agent.
 *  - The bearer sent to Railway is AGENT_BEARER_TOKEN, else SW_API_KEY, never
 *    the Supabase service-role key: with both unset the call refuses by name
 *    before any network request.
 */
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AGENT_BEARER_UNCONFIGURED,
  resolveSecureworksAgentBearer,
} from "./secureworks_agent_bearer.ts";

const SERVICE_KEY = "test-service-role-key";
const RETIRED = ["book_scope", "assign_scoper", "sales_booking_stamp_write"];
const ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SW_API_KEY",
  "AGENT_BEARER_TOKEN",
  "MAKESAFE_ROUTINE_KEY",
  "OPS_AGENT_SERVER_KEY",
];

// index.ts reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY into module
// constants, so they are set before the dynamic import and restored after.
async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map(ENV_NAMES.map((n) => [n, Deno.env.get(n)]));
  for (const name of ENV_NAMES) {
    const value = env[name];
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

const BASE_ENV = {
  // A closed local port: any real database or agent call would fail loudly.
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
};

let handlerPromise: Promise<(req: Request) => Promise<Response>> | null = null;
function handler() {
  handlerPromise ??= withEnv(
    BASE_ENV,
    async () => (await import("./index.ts"))._opsApiRequestHandlerForTest,
  );
  return handlerPromise;
}

function serviceRequest(action: string, body: unknown = {}): Request {
  return new Request(`https://example.invalid/ops-api?action=${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

type FetchCall = { url: string; authorization: string | null };
async function withFetchSpy<T>(
  respond: (call: FetchCall) => Response,
  fn: (calls: FetchCall[]) => Promise<T>,
): Promise<T> {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const call = { url, authorization: headers.get("authorization") };
    calls.push(call);
    return Promise.resolve(respond(call));
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

for (const action of RETIRED) {
  Deno.test(`${action} is retired: Unknown action, nothing called`, async () => {
    const handle = await handler();
    await withEnv(
      BASE_ENV,
      () =>
        withFetchSpy(
          () => new Response("{}", { status: 500 }),
          async (calls) => {
            const res = await handle(serviceRequest(action, {
              action_id: "p-1",
              scope_window_iso: "2026-10-01T10:00:00+08:00",
              scoper_user_id: "u-1",
              resource: "marnin",
              week_start: "2026-09-21",
              stamp: { approved: [] },
            }));
            assertEquals(res.status, 400);
            assertEquals(await res.json(), { error: "Unknown action" });
            assertEquals(calls, []);
          },
        ),
    );
  });
}

Deno.test("approve_booking_proposal refuses by name without a bearer; never sends the service key", async () => {
  const handle = await handler();
  await withEnv(
    BASE_ENV,
    () =>
      withFetchSpy(() => new Response("{}"), async (calls) => {
        const res = await handle(
          serviceRequest("approve_booking_proposal", { proposal_id: "p-1" }),
        );
        assertEquals(res.status, 500);
        const body = await res.json();
        assertEquals(body.code, AGENT_BEARER_UNCONFIGURED);
        assert(String(body.error).includes("AGENT_BEARER_TOKEN"));
        assertEquals(calls, []);
      }),
  );
});

Deno.test("approve_booking_proposal sends AGENT_BEARER_TOKEN to the agent", async () => {
  const handle = await handler();
  await withEnv(
    { ...BASE_ENV, AGENT_BEARER_TOKEN: "agent-token" },
    () =>
      withFetchSpy(
        () => new Response(JSON.stringify({ ok: true, dry_run: true })),
        async (calls) => {
          const res = await handle(
            serviceRequest("approve_booking_proposal", { proposal_id: "p-1" }),
          );
          assertEquals(res.status, 200);
          const agentCalls = calls.filter((c) =>
            c.url.endsWith("/api/booking-approvals/approve")
          );
          assertEquals(agentCalls.length, 1);
          assertEquals(agentCalls[0].authorization, "Bearer agent-token");
          assert(!calls.some((c) => c.authorization?.includes(SERVICE_KEY)));
        },
      ),
  );
});

Deno.test("agent bearer: token, then SW_API_KEY, never the service-role key", () => {
  const env = (vars: Record<string, string | undefined>) => (name: string) =>
    vars[name];
  assertEquals(
    resolveSecureworksAgentBearer(env({
      AGENT_BEARER_TOKEN: "a",
      SW_API_KEY: "b",
      SUPABASE_SERVICE_ROLE_KEY: "s",
    })),
    { ok: true, bearer: "a", source: "AGENT_BEARER_TOKEN" },
  );
  assertEquals(
    resolveSecureworksAgentBearer(env({
      SW_API_KEY: "b",
      SUPABASE_SERVICE_ROLE_KEY: "s",
    })),
    { ok: true, bearer: "b", source: "SW_API_KEY" },
  );
  for (
    const vars of <Array<Record<string, string>>> [
      { SUPABASE_SERVICE_ROLE_KEY: "s" },
      {
        AGENT_BEARER_TOKEN: "  ",
        SW_API_KEY: "",
        SUPABASE_SERVICE_ROLE_KEY: "s",
      },
      {},
    ]
  ) {
    const resolved = resolveSecureworksAgentBearer(env(vars));
    assertEquals(resolved.ok, false, JSON.stringify(vars));
    if (!resolved.ok) assertEquals(resolved.code, AGENT_BEARER_UNCONFIGURED);
  }
});
