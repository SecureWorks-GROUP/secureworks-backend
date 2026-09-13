import { assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DISPATCH_REFRESH_OUTPUT,
  assertDispatchRefreshOutput,
  dispatchRefreshResult,
  pendingRefreshDoor,
  salesPerformanceUnpublished,
  stripLeaseToken,
} from "../../supabase/functions/ops-api/dispatch_refresh_driver.ts";
import { handleDispatch } from "../../supabase/functions/ops-api/dispatch_workbench.ts";

const org = "00000000-0000-4000-8000-000000000001";

Deno.test("hash-only Refresh output is refused", () => {
  let threw = false;
  try {
    assertDispatchRefreshOutput({
      ok: "true",
      declared_output: DISPATCH_REFRESH_OUTPUT,
      work: { jobs_read: 1, hash_only: true, source_cutoff: "2026-09-13T00:00:00Z" },
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("declared Dispatch Refresh output requires actual jobs read", () => {
  const result = dispatchRefreshResult(3, "2026-09-13T03:10:38Z", {
    calendar_read: true,
    observed_source_revision: "src-1",
  });
  assertEquals(result.declared_output, DISPATCH_REFRESH_OUTPUT);
  assertEquals(result.work.jobs_read, 3);
  assertEquals(result.ok, "true");
});

Deno.test("sales_performance_read is unpublished empty, not zero", async () => {
  const body = await handleDispatch(
    { from() { throw new Error("no table read"); } },
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

Deno.test("JWT-shaped claim/finish are refused", async () => {
  await assertRejects(
    () =>
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
    stripLeaseToken({ id: "run-1", lease_token: "secret" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  assertEquals(stripLeaseToken({ id: "run-1", status: "queued" }).status, "queued");
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
