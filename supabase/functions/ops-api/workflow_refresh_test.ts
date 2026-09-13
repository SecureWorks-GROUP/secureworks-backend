import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertWorkflowRefreshBoundary,
  consumeWorkflowRefresh,
  finishWorkflowRefresh,
  refreshActorFromAuth,
  startAndConsumeDispatchRefresh,
  startWorkflowRefresh,
} from "./workflow_refresh.ts";

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
  });
  assertEquals(out.status, "queued");
  assertEquals((calls[0] as { name: string }).name, "start_workflow_refresh");
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
    { id: "user-1", orgId: "00000000-0000-0000-0000-000000000001" },
    "spoofed",
    "00000000-0000-0000-0000-000000000001",
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

Deno.test("dispatch start then consume is the owner path", async () => {
  const calls: string[] = [];
  const client = {
    rpc: async (name: string) => {
      calls.push(name);
      if (name === "start_workflow_refresh") {
        return { data: { outcome: "started", id: "run-1", status: "queued" }, error: null };
      }
      if (name === "consume_dispatch_refresh") {
        return { data: { ok: true, status: "completed", owner: "dispatch" }, error: null };
      }
      if (name === "workflow_refresh_readback") {
        return {
          data: { id: "run-1", status: "completed", result: { owner: "dispatch", step: "source_read" } },
          error: null,
        };
      }
      return { data: null, error: { message: name } };
    },
  };
  const out = await startAndConsumeDispatchRefresh(client, {
    workflow: "dispatch",
    scope: { job_id: "aaaaaaaa-0000-4000-8000-000000000001", org_id: "00000000-0000-0000-0000-000000000001" },
    actor: "ui",
  });
  assertEquals(calls, [
    "start_workflow_refresh",
    "consume_dispatch_refresh",
    "workflow_refresh_readback",
  ]);
  assertEquals(out.consume.status, "completed");
  assertEquals(out.readback.status, "completed");
});

Deno.test("consume owner is dispatch", async () => {
  const calls: unknown[] = [];
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return { data: { outcome: "idle", owner: "dispatch" }, error: null };
    },
  };
  const out = await consumeWorkflowRefresh(client, { owner: "dispatch" });
  assertEquals(out.outcome, "idle");
  assertEquals((calls[0] as { name: string }).name, "consume_workflow_refresh");
});
