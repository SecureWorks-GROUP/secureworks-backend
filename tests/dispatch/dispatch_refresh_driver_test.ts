import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DISPATCH_REFRESH_OUTPUT,
  operatorRefreshResult,
  pendingRefreshDoor,
  salesPerformanceUnpublished,
} from "../../supabase/functions/ops-api/dispatch_refresh_driver.ts";
import {
  DispatchError,
  handleDispatch,
} from "../../supabase/functions/ops-api/dispatch_workbench.ts";

const org = "00000000-0000-4000-8000-000000000001";

Deno.test("sales_performance_read is unpublished empty, not zero", async () => {
  const body = await handleDispatch(
    {
      from() {
        throw new Error("no table read");
      },
    },
    org,
    "host",
    "sales_performance_read",
    "GET",
    new URLSearchParams(),
    {},
  );
  assertEquals(body.unpublished, true);
  assertEquals(body.rows, []);
  assertEquals(body.week_starts, []);
  assertEquals(body.storage_provenance, null);
  assertEquals(salesPerformanceUnpublished().coverage.complete, false);
});

Deno.test("Workflow Refresh start without shared RPC is pending, not completed", async () => {
  const body = await handleDispatch(
    {},
    org,
    "operator",
    "workflow_refresh",
    "POST",
    new URLSearchParams(),
    { op: "start", workflow: "dispatch", scope: { job_id: org } },
  );
  assertEquals(body.outcome, "unavailable");
  assertEquals(body.capability, "pending");
  assertEquals(body.declared_output, DISPATCH_REFRESH_OUTPUT);
});

Deno.test("Refresh start and readback report missing PostgREST RPCs as unavailable", async () => {
  for (const op of ["start", "readback"]) {
    for (const code of ["PGRST202", "42883"]) {
      const calls: string[] = [];
      const rpc = op === "start"
        ? "start_workflow_refresh"
        : "workflow_refresh_readback";
      const body = await handleDispatch(
        {
          rpc(name: string, args: Record<string, unknown>) {
            calls.push(name);
            assertEquals(args.p_org_id, org);
            return Promise.resolve({
              data: null,
              error: {
                code,
                message: code === "PGRST202"
                  ? `Could not find the public.${rpc} function in the schema cache`
                  : `function public.${rpc} does not exist`,
                details: null,
                hint: null,
              },
            });
          },
        },
        org,
        "operator",
        "dispatch_refresh",
        "POST",
        new URLSearchParams(),
        { op, id: "run-1", scope: { job_id: org } },
      );
      assertEquals(calls, [rpc]);
      assertEquals(body, pendingRefreshDoor());
    }
  }
});

Deno.test("Refresh start and readback preserve non-missing RPC failures", async () => {
  for (const op of ["start", "readback"]) {
    for (
      const error of [
        { code: "42501", message: "permission denied for function" },
        {
          code: "42P01",
          message: "relation required_by_refresh does not exist",
        },
      ]
    ) {
      const failure = await assertRejects(
        async () =>
          handleDispatch(
            {
              rpc() {
                return Promise.resolve({ data: null, error });
              },
            },
            org,
            "operator",
            "dispatch_refresh",
            "POST",
            new URLSearchParams(),
            { op, id: "run-1" },
          ),
        DispatchError,
        error.message,
      );
      assertEquals(failure.status, 500);
    }
  }
});

Deno.test("Refresh start and readback preserve shared run outcomes", async () => {
  for (const op of ["start", "readback"]) {
    for (
      const data of [
        { id: "run-1", outcome: "queued" },
        { outcome: "unavailable", reason: "driver_unregistered" },
      ]
    ) {
      const result = await handleDispatch(
        {
          rpc() {
            return Promise.resolve({ data, error: null });
          },
        },
        org,
        "operator",
        "dispatch_refresh",
        "POST",
        new URLSearchParams(),
        { op, id: "run-1" },
      );
      assertEquals(result, data);
    }
  }
});

Deno.test("workflow environment configuration does not establish observed worker state", async () => {
  const previous = Deno.env.get("DISPATCH_WORKER_ENABLED");
  try {
    for (const configured of [undefined, "false", "true"]) {
      if (configured == null) Deno.env.delete("DISPATCH_WORKER_ENABLED");
      else Deno.env.set("DISPATCH_WORKER_ENABLED", configured);
      const status = await handleDispatch(
        {
          from(table: string) {
            assertEquals(table, "dispatch_release_controls");
            const query = {
              select() {
                return query;
              },
              eq() {
                return query;
              },
              limit() {
                return Promise.resolve({
                  data: [{ communications_enabled: false }],
                  error: null,
                });
              },
            };
            return query;
          },
          rpc(name: string) {
            assertEquals(name, "dispatch_list_tasks");
            return Promise.resolve({
              data: { items: [], source_failures: [] },
              error: null,
            });
          },
        },
        org,
        "operator",
        "dispatch_workflow",
        "GET",
        new URLSearchParams(),
        {},
      );
      assertEquals(status.worker.intended_enabled, false);
      assertEquals(
        status.worker.configured_enabled,
        configured == null ? null : configured === "true",
      );
      assertEquals(
        status.worker.configuration_source,
        "DISPATCH_WORKER_ENABLED",
      );
      assertEquals(status.worker.observed_enabled, null);
      assertEquals(status.worker.mismatch, null);
      assertEquals(status.live_actions_enabled, false);
      assertEquals(status.refresh.worker, "disabled");
    }
  } finally {
    if (previous == null) Deno.env.delete("DISPATCH_WORKER_ENABLED");
    else Deno.env.set("DISPATCH_WORKER_ENABLED", previous);
  }
});

Deno.test("JWT-shaped claim/finish are refused", async () => {
  await assertRejects(
    async () =>
      handleDispatch(
        {},
        org,
        "operator",
        "workflow_refresh",
        "POST",
        new URLSearchParams(),
        { op: "claim", owner: "dispatch" },
      ),
    Error,
    "not claim or finish",
  );
});

Deno.test("readback must not return a lease token", () => {
  let threw = false;
  try {
    operatorRefreshResult({ id: "run-1", lease_token: "secret" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  assertEquals(
    operatorRefreshResult({ id: "run-1", status: "queued" })?.status,
    "queued",
  );
  assertEquals(pendingRefreshDoor().reason, "shared_refresh_rpc_missing");
});

Deno.test("sales_booking_read is not a 4174 preview fallback", () => {
  assertThrows(
    () =>
      handleDispatch(
        {},
        org,
        "operator",
        "sales_booking_read",
        "GET",
        new URLSearchParams(),
        {},
      ),
    Error,
    "4174/4175",
  );
});
