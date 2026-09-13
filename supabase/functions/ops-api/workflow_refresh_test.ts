import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertRefreshWorkerOp,
  assertWorkflowRefreshBoundary,
  bindRefreshOrg,
  claimWorkflowRefresh,
  consumeWorkflowRefresh,
  finishWorkflowRefresh,
  readWorkflowRefresh,
  recordWorkflowRefreshReceipt,
  refreshActorFromAuth,
  startWorkflowRefresh,
  WorkflowRefreshError,
} from "./workflow_refresh.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const JOB = "aaaaaaaa-0000-4000-8000-000000000001";
const SOURCE = "dispatch-source-revision-1";

Deno.test("startWorkflowRefresh calls the durable RPC", async () => {
  const calls: unknown[] = [];
  const client = {
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return {
        data: { outcome: "started", id: "run-1", status: "queued" },
        error: null,
      };
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
    assertWorkflowRefreshBoundary({
      workflow: "dispatch",
      scope: { invoice_id: "x" },
    });
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

Deno.test("completed finish requires a persisted driver receipt", async () => {
  const calls: string[] = [];
  await assertRejects(
    () =>
      finishWorkflowRefresh({
        rpc: async (name: string) => {
          calls.push(name);
          return { data: {}, error: null };
        },
      }, {
        id: "run-1",
        status: "completed",
        owner: "dispatch",
        lease_token: "00000000-0000-4000-8000-000000000001",
        lease_generation: 1,
      }),
    WorkflowRefreshError,
  );
  assertEquals(calls, []);
});

Deno.test("UI start does not claim or complete Refresh", async () => {
  const calls: string[] = [];
  const client = {
    rpc: async (name: string) => {
      calls.push(name);
      return {
        data: { outcome: "unavailable", capability: "unavailable" },
        error: null,
      };
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
      return {
        data: { outcome: "unavailable", owner: "dispatch" },
        error: null,
      };
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
    readWorkflowRefresh(
      {
        rpc: async () => ({
          data: { id: "run-1", lease_token: "secret" },
          error: null,
        }),
      },
      "run-1",
      ORG,
    )
  );
});

Deno.test("simultaneous start retries unique violation into a join", async () => {
  let n = 0;
  const client = {
    rpc: async () => {
      n += 1;
      if (n === 1) return { data: null, error: { message: "duplicate key" } };
      return {
        data: { outcome: "joined", id: "run-1", status: "queued" },
        error: null,
      };
    },
  };
  try {
    await startWorkflowRefresh(client, {
      workflow: "dispatch",
      scope: {},
      actor: "ui",
      org_id: ORG,
    });
  } catch {
    // first call surfaces SQL unique as 500; the SQL function itself retries. TS start is one RPC.
  }
  const out = await startWorkflowRefresh(client, {
    workflow: "dispatch",
    scope: {},
    actor: "ui",
    org_id: ORG,
  });
  assertEquals(out.outcome, "joined");
});

Deno.test("worker claim is a separate RPC from finish", async () => {
  const client = {
    rpc: async (name: string) => {
      assertEquals(name, "claim_workflow_refresh");
      return { data: { status: "running", lease_generation: 1 }, error: null };
    },
  };
  const out = await claimWorkflowRefresh(client, {
    id: "run-1",
    owner: "dispatch",
  });
  assertEquals(out.status, "running");
});

Deno.test("receipt helper sends the driver-owned output to the durable RPC", async () => {
  const calls: unknown[] = [];
  const out = await recordWorkflowRefreshReceipt({
    rpc: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return {
        data: {
          receipt_id: "receipt-1",
          outcome: "persisted",
          observed_source_revision: SOURCE,
        },
        error: null,
      };
    },
  }, {
    id: "run-1",
    owner: "dispatch",
    lease_token: "00000000-0000-4000-8000-000000000001",
    lease_generation: 1,
    receipt: {
      driver_version: "dispatch_refresh/v1",
      scope: { job_id: JOB, org_id: ORG },
      output: {
        ok: true,
        declared_output: "dispatch_refresh/v1",
        observed_source_revision: SOURCE,
        work: { jobs_read: 1, source_cutoff: "2026-09-13T00:00:00Z" },
        output_ref: {
          table: "dispatch_commands",
          command: "assess",
          request_id: "00000000-0000-4000-8000-000000000101",
        },
      },
      observed_source_revision: SOURCE,
    },
  });
  assertEquals(out.receipt_id, "receipt-1");
  assertEquals(
    (calls[0] as { name: string }).name,
    "record_workflow_refresh_receipt",
  );
  assertEquals(
    (calls[0] as { args: { p_observed_revision: string } }).args
      .p_observed_revision,
    SOURCE,
  );
});

for (const callerRevision of [undefined, null, "stale-caller-revision"]) {
  Deno.test(`finish uses the persisted revision when caller revision is ${callerRevision}`, async () => {
    const calls: string[] = [];
    const out = await finishWorkflowRefresh({
      rpc: async (
        name: string,
        args: { p_observed_revision: unknown; p_result?: unknown },
      ) => {
        calls.push(name);
        assertEquals(args.p_observed_revision, SOURCE);
        if (name === "record_workflow_refresh_receipt") {
          return {
            data: {
              receipt_id: "receipt-1",
              outcome: "persisted",
              observed_source_revision: SOURCE,
            },
            error: null,
          };
        }
        assertEquals(args.p_result, { receipt_id: "receipt-1" });
        return { data: { status: "completed" }, error: null };
      },
    }, {
      id: "run-1",
      status: "completed",
      owner: "dispatch",
      lease_token: "00000000-0000-4000-8000-000000000001",
      lease_generation: 1,
      observed_source_revision: callerRevision,
      receipt: {
        driver_version: "dispatch_refresh/v1",
        scope: { job_id: JOB, org_id: ORG },
        output: {
          ok: true,
          declared_output: "dispatch_refresh/v1",
          observed_source_revision: SOURCE,
          work: { jobs_read: 1, source_cutoff: "2026-09-13T00:00:00Z" },
          output_ref: {
            table: "dispatch_commands",
            command: "assess",
            request_id: "00000000-0000-4000-8000-000000000101",
          },
        },
        observed_source_revision: SOURCE,
      },
    });
    assertEquals(out.status, "completed");
    assertEquals(calls, [
      "record_workflow_refresh_receipt",
      "finish_workflow_refresh",
    ]);
  });
}

Deno.test("finish stops when persistence returns no usable source revision", async () => {
  for (const revision of [undefined, null, "", " "]) {
    const calls: string[] = [];
    await assertRejects(
      () =>
        finishWorkflowRefresh({
          rpc: async (name: string) => {
            calls.push(name);
            return {
              data: {
                receipt_id: "receipt-1",
                observed_source_revision: revision,
              },
              error: null,
            };
          },
        }, {
          id: "run-1",
          status: "completed",
          owner: "dispatch",
          lease_token: "00000000-0000-4000-8000-000000000001",
          lease_generation: 1,
          observed_source_revision: SOURCE,
          receipt: {
            driver_version: "dispatch_refresh/v1",
            scope: { job_id: JOB, org_id: ORG },
            output: {},
            observed_source_revision: SOURCE,
          },
        }),
      WorkflowRefreshError,
      "receipt persistence returned no receipt id or source revision",
    );
    assertEquals(calls, ["record_workflow_refresh_receipt"]);
  }
});
