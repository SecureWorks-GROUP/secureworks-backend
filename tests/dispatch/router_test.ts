import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const environment = {
  SUPABASE_URL: "https://dispatch-router.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "router-service-key",
  SW_API_KEY: "router-browser-key",
  DISPATCH_REFRESH_WORKER: "1",
};
const initial = Object.fromEntries(
  Object.keys(environment).map((key) => [key, Deno.env.get(key)]),
);
for (const [key, value] of Object.entries(environment)) {
  Deno.env.set(key, value);
}
const { handleOpsApiRequest } = await import(
  "../../supabase/functions/ops-api/index.ts"
);
for (const [key, value] of Object.entries(initial)) {
  if (value == null) Deno.env.delete(key);
  else Deno.env.set(key, value);
}

const org = "00000000-0000-4000-8000-000000000001";
const foreignOrg = "00000000-0000-4000-8000-000000000002";
const user = "10000000-0000-4000-8000-000000000001";
const job = "20000000-0000-4000-8000-000000000001";
type RpcCall = { name: string; args: Record<string, unknown> };

async function request(
  action: string,
  body?: Record<string, unknown>,
  options: {
    role?: string;
    orgId?: string;
    sharedKeyOnly?: boolean;
    rpc?: (call: RpcCall) => Response;
  } = {},
) {
  const originalFetch = globalThis.fetch;
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, Deno.env.get(key)]),
  );
  const calls: RpcCall[] = [];
  const unexpected: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    Deno.env.set(key, value);
  }
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin === environment.SUPABASE_URL) {
      if (url.pathname === "/auth/v1/user") {
        assertEquals(req.headers.get("authorization"), "Bearer operator-jwt");
        return Response.json({ id: user, email: "operator@example.invalid" });
      }
      if (url.pathname === "/rest/v1/users") {
        assertEquals(url.searchParams.get("id"), `eq.${user}`);
        return Response.json([{
          org_id: options.orgId ?? org,
          role: options.role ?? "ops_manager",
          managed_verticals: [],
        }]);
      }
      if (url.pathname.startsWith("/rest/v1/rpc/")) {
        const call = {
          name: url.pathname.split("/").at(-1)!,
          args: await req.json(),
        };
        calls.push(call);
        if (options.rpc) return options.rpc(call);
      }
    }
    unexpected.push(`${req.method} ${url.origin}${url.pathname}`);
    throw new Error("Unexpected request in Dispatch router test");
  };
  try {
    const headers: Record<string, string> = {
      "x-api-key": environment.SW_API_KEY,
      "content-type": "application/json",
    };
    if (!options.sharedKeyOnly) headers.authorization = "Bearer operator-jwt";
    const response = await handleOpsApiRequest(
      new Request(
        `https://example.invalid/ops-api?action=${action}`,
        {
          method: body ? "POST" : "GET",
          headers,
          body: body ? JSON.stringify(body) : undefined,
        },
      ),
    );
    const result = await response.json();
    assertEquals(unexpected, []);
    return { status: response.status, body: result, calls };
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

Deno.test("ops-api routes office Refresh start and readback with canonical tenant", async () => {
  for (const role of ["admin", "owner", "ops_manager"]) {
    const start = await request("workflow_refresh", {
      op: "start",
      scope: { job_id: job, org_id: foreignOrg },
      actor: "caller-supplied-actor",
    }, {
      role,
      rpc: () => Response.json({ id: "run-1", outcome: "queued" }),
    });
    assertEquals(start.status, 200);
    assertEquals(start.body, { id: "run-1", outcome: "queued" });
    assertEquals(start.calls, [{
      name: "start_workflow_refresh",
      args: {
        p_workflow: "dispatch",
        p_scope: { job_id: job, org_id: org },
        p_actor: user,
        p_org_id: org,
      },
    }]);
    const readback = await request("workflow_refresh", {
      op: "readback",
      id: "run-1",
    }, {
      role,
      rpc: () => Response.json({ id: "run-1", status: "queued" }),
    });
    assertEquals(readback.status, 200);
    assertEquals(readback.body, { id: "run-1", status: "queued" });
    assertEquals(readback.calls, [{
      name: "workflow_refresh_readback",
      args: { p_id: "run-1", p_org_id: org },
    }]);
  }
});

Deno.test("ops-api refuses JWT worker operations and removed run_once without work", async () => {
  for (const action of ["workflow_refresh", "dispatch_refresh"]) {
    for (const op of ["claim", "consume", "finish", "run_once"]) {
      const result = await request(action, {
        op,
        scope: { job_id: job },
        declared_output: "dispatch_refresh/v1",
        work: { jobs_read: 1, calendar_read: true },
      });
      assertEquals(result.status, op === "run_once" ? 400 : 403);
      assertEquals(result.calls, []);
      assertEquals(result.body.outcome, undefined);
    }
  }
});

Deno.test("ops-api shared reads reject non-office, missing tenant and browser key callers", async () => {
  for (
    const action of [
      "workflow_refresh",
      "sales_performance_read",
      "message_work_links",
    ]
  ) {
    const body = action === "workflow_refresh" ? { op: "start" } : undefined;
    for (const options of [{ role: "installer" }, { orgId: "" }]) {
      const result = await request(action, body, options);
      assertEquals(result.status, 403);
      assertEquals(result.calls, []);
    }
    const result = await request(action, body, { sharedKeyOnly: true });
    assertEquals(result.status, 401);
    assertEquals(result.calls, []);
  }
});

Deno.test("ops-api publishes no performance figures before the shared data exists", async () => {
  const result = await request("sales_performance_read");
  assertEquals(result.status, 200);
  assertEquals(result.body.unpublished, true);
  assertEquals(result.body.rows, []);
  assertEquals(result.body.week_starts, []);
  assertEquals(result.body.storage_provenance, null);
  assertEquals(result.body.coverage.complete, false);
  assertEquals(result.calls, []);
});

Deno.test("ops-api Refresh reports unregistered drivers and missing RPC schema as unavailable", async () => {
  for (const op of ["start", "readback"]) {
    for (const code of ["PGRST202", "42883", "unregistered"]) {
      const result = await request("workflow_refresh", { op, id: "run-1" }, {
        rpc: () =>
          code === "unregistered"
            ? Response.json({
              outcome: "unavailable",
              reason: "driver_unregistered",
            })
            : Response.json({
              code,
              message: "Missing function in schema cache",
            }, { status: 404 }),
      });
      assertEquals(result.status, 200);
      assertEquals(result.body.outcome, "unavailable");
      assertEquals(result.calls.length, 1);
    }
  }
});

Deno.test("ops-api mail links remain explicitly pending without the canonical reader", async () => {
  const result = await request("message_work_links");
  assertEquals(result.status, 200);
  assertEquals(result.body.ok, false);
  assertEquals(result.body.capability, "pending");
  assertEquals(result.body.records, []);
  assertEquals(result.body.coverage.complete, false);
  assertEquals(result.calls, []);
});

Deno.test("ops-api never accepts declared output or list reads as verified Refresh completion", async () => {
  for (const op of ["start", "readback"]) {
    for (
      const completion of [{ outcome: "completed" }, { status: "completed" }]
    ) {
      const result = await request("workflow_refresh", { op, id: "run-1" }, {
        rpc: () =>
          Response.json({
            id: "run-1",
            ...completion,
            capability: "registered",
            declared_output: "dispatch_refresh/v1",
            work: {
              jobs_read: 1,
              calendar_read: true,
              source_cutoff: "2026-09-13T00:00:00Z",
            },
          }),
      });
      assertEquals(result.status, 200);
      assertEquals(result.body.outcome, "unavailable");
      assertEquals(result.body.capability, "pending");
      assertEquals(result.body.reason, "dispatch_verified_output_unavailable");
    }
  }
});
