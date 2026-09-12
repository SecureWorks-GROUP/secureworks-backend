// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const script = "scripts/dispatch/run-dispatch-worker.sh";

async function runWorker(args: string[], env: Record<string, string> = {}) {
  const command = new Deno.Command("bash", {
    args: [script, ...args],
    env: {
      DISPATCH_WORKER_CONFIG:
        `${Deno.cwd()}/scripts/dispatch/worker.disabled.json`,
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  return {
    ...result,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

async function tempConfig(config: Record<string, unknown>) {
  const dir = await Deno.makeTempDir({ dir: Deno.cwd() });
  const path = `${dir}/worker.json`;
  await Deno.writeTextFile(path, JSON.stringify(config));
  return { dir, path };
}

Deno.test("dispatch worker disabled config exits without token or network", async () => {
  const result = await runWorker(["--once"]);
  assertEquals(result.code, 0);
  assertEquals(result.stdout.trim(), "dispatch worker disabled");
  assertEquals(result.stderr, "");
});

Deno.test("dispatch worker once posts trigger then run to configured loopback endpoint", async () => {
  const token = "worker-token-secret";
  const controller = new AbortController();
  const requests: Array<{
    action: string | null;
    body: unknown;
    auth: string | null;
  }> = [];
  let port = 0;
  let ready!: () => void;
  const listening = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: controller.signal,
    onListen(address) {
      port = address.port;
      ready();
    },
  }, async (request) => {
    const url = new URL(request.url);
    requests.push({
      action: url.searchParams.get("action"),
      body: await request.json(),
      auth: request.headers.get("authorization"),
    });
    return Response.json({ ok: true, action: url.searchParams.get("action") });
  });
  await listening;
  const { dir, path } = await tempConfig({
    enabled: true,
    endpoint_url: `http://127.0.0.1:${port}/functions/v1/ops-api`,
    token_env: "DISPATCH_WORKER_TEST_TOKEN",
    interval_seconds: null,
    timeout_seconds: 5,
    trigger_body: {},
    run_body: {},
  });
  try {
    const result = await runWorker(["--config", path, "--once"], {
      DISPATCH_WORKER_TEST_TOKEN: token,
    });
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stderr, "");
    assert(!result.stdout.includes(token));
    const output = JSON.parse(result.stdout);
    assertEquals(output.dispatch_worker, "cycle_complete");
    assertEquals(output.dispatch_trigger, {
      ok: true,
      action: "dispatch_trigger",
    });
    assertEquals(output.dispatch_run, { ok: true, action: "dispatch_run" });
    assertEquals(requests, [
      {
        action: "dispatch_trigger",
        body: {},
        auth: `Bearer ${token}`,
      },
      {
        action: "dispatch_run",
        body: {},
        auth: `Bearer ${token}`,
      },
    ]);
  } finally {
    controller.abort();
    await server.finished;
    await Deno.remove(dir, { recursive: true });
  }
});
