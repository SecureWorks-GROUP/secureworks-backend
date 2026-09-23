// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SERVICE_KEY = "test-service-role-key";
const BASE_ENV = {
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
};
const ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SW_API_KEY",
  "MAKESAFE_ROUTINE_KEY",
  "OPS_AGENT_SERVER_KEY",
];

async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = new Map(ENV_NAMES.map((name) => [name, Deno.env.get(name)]));
  for (const name of ENV_NAMES) {
    const value = env[name];
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

let handlerPromise: Promise<(request: Request) => Promise<Response>> | null = null;
function handler() {
  handlerPromise ??= withEnv(BASE_ENV, async () =>
    (await import("./index.ts"))._opsApiRequestHandlerForTest
  );
  return handlerPromise;
}

Deno.test("trigger_chase_workflow refuses without GHL tag or custom-field writes", async () => {
  const handle = await handler();
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;

  try {
    const response = await withEnv(BASE_ENV, () => handle(new Request(
      "https://example.invalid/ops-api?action=trigger_chase_workflow",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${SERVICE_KEY}`,
        },
        body: JSON.stringify({
          ghl_contact_id: "contact-1",
          overdue_amount: 275,
          invoice_number: "INV-1001",
          job_number: "SWMS-261001",
          xero_invoice_id: "invoice-1",
          job_id: "job-1",
        }),
      },
    )));

    assertEquals(response.status, 409);
    assertEquals(await response.json(), {
      success: false,
      error: "Chase workflow triggering is disabled. Debtor messages require exact approval.",
      code: "chase_workflow_trigger_disabled",
    });
    assertEquals(calls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
