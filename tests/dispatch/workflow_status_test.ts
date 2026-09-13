import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleDispatch } from "../../supabase/functions/ops-api/dispatch_workbench.ts";
import { openDispatchPg } from "./pg_client.ts";

const org = "00000000-0000-4000-8000-000000000001";

Deno.test("dispatch_workflow reports the disabled worker and does not expose tokens", async () => {
  const pg = await openDispatchPg();
  try {
    const status = await handleDispatch(
      pg.client,
      org,
      "workflow-status",
      "dispatch_workflow",
      "GET",
      new URLSearchParams(),
      {},
    );
    assertEquals(status.workflow, "dispatch");
    assertEquals(status.live_actions_enabled, false);
    assertEquals(status.worker.intended_enabled, false);
    assertEquals(status.worker.observed_enabled, false);
    assertEquals(status.worker.schedule_installed, false);
    assertEquals(status.worker.mismatch, false);
    assertEquals(JSON.stringify(status).includes("DISPATCH_WORKER_TOKEN"), false);
    assertEquals(JSON.stringify(status).includes("Bearer"), false);
  } finally {
    await pg.close();
  }
});
