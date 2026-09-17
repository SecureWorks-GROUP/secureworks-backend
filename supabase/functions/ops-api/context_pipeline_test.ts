import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ContextPipelineError,
  contextPipelineStatus,
} from "./context_pipeline.ts";

Deno.test("contextPipelineStatus returns the RPC payload", async () => {
  const payload = {
    run_date: "2026-09-17",
    runs_used: 65,
    model_calls_used: 396,
  };
  const data = await contextPipelineStatus({
    rpc: async () => ({ data: payload, error: null }),
  });
  assertEquals(data, payload);
});

Deno.test("contextPipelineStatus refuses an unreadable status as 503", async () => {
  const error = await assertRejects(
    () =>
      contextPipelineStatus({
        rpc: async () => ({ data: null, error: { message: "rpc failed" } }),
      }),
    ContextPipelineError,
    "Context pipeline status could not be read.",
  );
  assertEquals(error.code, "context_status_unavailable");
  assertEquals(error.status, 503);
});

Deno.test("contextPipelineStatus refuses an empty payload as 503", async () => {
  const error = await assertRejects(
    () =>
      contextPipelineStatus({
        rpc: async () => ({ data: null, error: null }),
      }),
    ContextPipelineError,
  );
  assertEquals(error.code, "context_status_unavailable");
  assertEquals(error.status, 503);
});
