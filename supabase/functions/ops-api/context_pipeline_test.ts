import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ContextPipelineError,
  contextPipelineStatus,
} from "./context_pipeline.ts";

async function captureConsoleError<T>(fn: () => Promise<T>) {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
}

Deno.test("contextPipelineStatus returns the RPC payload", async () => {
  const payload = {
    run_date: "2026-09-17",
    runs_used: 65,
    model_calls_used: 396,
  };
  const data = await contextPipelineStatus({
    rpc: () => Promise.resolve({ data: payload, error: null }),
  });
  assertEquals(data, payload);
});

Deno.test("contextPipelineStatus names the RPC error code and logs it", async () => {
  const { result: error, lines } = await captureConsoleError(() =>
    assertRejects(
      () =>
        contextPipelineStatus({
          rpc: () =>
            Promise.resolve({
              data: { secret_row: "must not be logged" },
              error: {
                code: "57014",
                message: "canceling statement due to statement timeout",
                hint: null,
                details: "ignored",
              },
            }),
        }),
      ContextPipelineError,
      "Context pipeline status could not be read.",
    )
  );
  assertEquals(error.code, "context_status_unavailable");
  assertEquals(error.status, 503);
  assertEquals(error.reason, "57014");
  assertEquals(lines.length, 1);
  assertEquals(JSON.parse(lines[0]), {
    event: "context_pipeline_status_rpc_failed",
    reason: "57014",
    code: "57014",
    message: "canceling statement due to statement timeout",
    hint: null,
  });
  assertEquals(lines[0].includes("must not be logged"), false);
});

Deno.test("contextPipelineStatus keeps an unsafe or missing code out of the reason", async () => {
  const { result: error } = await captureConsoleError(() =>
    assertRejects(
      () =>
        contextPipelineStatus({
          rpc: () =>
            Promise.resolve({
              data: null,
              error: { code: "", message: "TypeError: fetch failed" },
            }),
        }),
      ContextPipelineError,
    )
  );
  assertEquals(error.reason, "rpc_error_no_code");

  const { result: spaced } = await captureConsoleError(() =>
    assertRejects(
      () =>
        contextPipelineStatus({
          rpc: () =>
            Promise.resolve({
              data: null,
              error: { code: "bad code; drop table", message: "x" },
            }),
        }),
      ContextPipelineError,
    )
  );
  assertEquals(spaced.reason, "rpc_error_no_code");
});

Deno.test("contextPipelineStatus refuses an empty payload as 503", async () => {
  const { result: error, lines } = await captureConsoleError(() =>
    assertRejects(
      () =>
        contextPipelineStatus({
          rpc: () => Promise.resolve({ data: null, error: null }),
        }),
      ContextPipelineError,
    )
  );
  assertEquals(error.code, "context_status_unavailable");
  assertEquals(error.status, 503);
  assertEquals(error.reason, "empty_payload");
  assertEquals(JSON.parse(lines[0]).reason, "empty_payload");
});
