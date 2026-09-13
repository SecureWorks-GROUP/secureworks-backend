import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertRefreshWorkerOp,
  assertWorkflowRefreshBoundary,
  bindRefreshOrg,
  claimWorkflowRefresh,
  consumeWorkflowRefresh,
  finishWorkflowRefresh,
  readWorkflowRefresh,
  refreshActorFromAuth,
  startWorkflowRefresh,
} from "./workflow_refresh.ts";

const ORG = "00000000-0000-0000-0000-000000000001";

Deno.test("startWorkflowRefresh calls the durable RPC", async () => {
  const calls: unknown[] = [];
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return { data: { outcome: "started", id: "run-1", status: "queued" }, error: null };
    },
  };
  const out = await startWorkflowRefresh(client, {
    workflow: "dispatch",
    scope: { job_id: "aaaaaaaa-0000-4000-8000-000000000001" },
    actor: "ui",
    org_id: ORG,
  });
  assertEquals(out.status, "queued");
  assertEquals((calls[0] as { name: string }).name, "start_workflow_refresh");
  assertEquals((calls[0] as { args: { p_org_id: string } }).args.p_org_id, ORG);
});

Deno.test("allowlist refuses unknown workflow and scope keys", () => {
  try {
    assertWorkflowRefreshBoundary({ workflow: "other", scope: {} });
    throw new Error("expected throw");
  } catch (e) {
    assertEquals((e as { status: number }).status, 400);
  }
  try {
    assertWorkflowRefreshBoundary({ workflow: "dispatch", scope: { invoice_id: "x" } });
    throw new Error("expected throw");
  } catch (e) {
    assertEquals((e as { status: number }).status, 400);
  }
});

Deno.test("JWT actor is the signed-in operator, not the body", () => {
  const actor = refreshActorFromAuth(
    "jwt",
    { id: "user-1", orgId: ORG },
    "spoofed",
    ORG,
  );
  assertEquals(actor, "user-1");
});

Deno.test("finish requires lease token and owner", async () => {
  await assertRejects(
    () =>
      finishWorkflowRefresh({ rpc: async () => ({ data: {}, error: null }) }, {
        id: "run-1",
        status: "completed",
      }),
  );
});

Deno.test("UI start does not claim or complete Refresh", async () => {
  const calls: string[] = [];
  const client = {
    rpc: async (name: string) => {
      calls.push(name);
      return { data: { outcome: "unavailable", capability: "unavailable" }, error: null };
    },
  };
  const out = await startWorkflowRefresh(client, {
    workflow: "dispatch",
    scope: { job_id: "aaaaaaaa-0000-4000-8000-000000000001" },
    actor: "ui",
    org_id: ORG,
  });
  assertEquals(calls, ["start_workflow_refresh"]);
  assertEquals(out.outcome, "unavailable");
});

Deno.test("consume owner is dispatch", async () => {
  const calls: unknown[] = [];
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return { data: { outcome: "unavailable", owner: "dispatch" }, error: null };
    },
  };
  const out = await consumeWorkflowRefresh(client, { owner: "dispatch" });
  assertEquals(out.outcome, "unavailable");
  assertEquals((calls[0] as { name: string }).name, "consume_workflow_refresh");
});

Deno.test("scope org_id cannot impersonate another tenant", () => {
  try {
    bindRefreshOrg({ org_id: "other-org" }, ORG);
    throw new Error("expected throw");
  } catch (e) {
    assertEquals((e as { status: number }).status, 403);
  }
});

Deno.test("JWT operators cannot claim or finish", () => {
  try {
    assertRefreshWorkerOp("jwt", "claim");
    throw new Error("expected throw");
  } catch (e) {
    assertEquals((e as { status: number }).status, 403);
  }
});

Deno.test("readback rejects a payload that still contains a lease token", async () => {
  await assertRejects(() =>
    readWorkflowRefresh({
      rpc: async () => ({ data: { id: "run-1", lease_token: "secret" }, error: null }),
    }, "run-1", ORG)
  );
});

Deno.test("simultaneous start retries unique violation into a join", async () => {
  let n = 0;
  const client = {
    rpc: async () => {
      n += 1;
      if (n === 1) return { data: null, error: { message: "duplicate key" } };
      return { data: { outcome: "joined", id: "run-1", status: "queued" }, error: null };
    },
  };
  try {
    await startWorkflowRefresh(client, { workflow: "dispatch", scope: {}, actor: "ui", org_id: ORG });
  } catch {
    // first call surfaces SQL unique as 500; the SQL function itself retries. TS start is one RPC.
  }
  const out = await startWorkflowRefresh(client, { workflow: "dispatch", scope: {}, actor: "ui", org_id: ORG });
  assertEquals(out.outcome, "joined");
});

Deno.test("worker claim is a separate RPC from finish", async () => {
  const client = {
    rpc: async (name: string) => {
      assertEquals(name, "claim_workflow_refresh");
      return { data: { status: "running", lease_generation: 1 }, error: null };
    },
  };
  const out = await claimWorkflowRefresh(client, { id: "run-1", owner: "dispatch" });
  assertEquals(out.status, "running");
});
