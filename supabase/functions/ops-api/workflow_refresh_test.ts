import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { startWorkflowRefresh } from "./workflow_refresh.ts";

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
