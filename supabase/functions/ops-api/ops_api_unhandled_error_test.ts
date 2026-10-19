/**
 * Raw text that must not be echoed (containment redaction, round two).
 *
 *  - The general Ops catch: an error that is not an ApiError answers
 *    "Internal error" with the error's class only, and logs the same; its
 *    message (which can carry store, provider or request text) is neither
 *    returned nor logged.
 *  - A draft pack that fails stores the error's class only, never its message.
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SERVICE_KEY = "test-service-role-key";
const SENTINEL = "SENTINEL raw provider text jane@example.com 0412 999 888";
const ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SW_API_KEY",
  "AGENT_BEARER_TOKEN",
  "MAKESAFE_ROUTINE_KEY",
  "OPS_AGENT_SERVER_KEY",
];

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map(ENV_NAMES.map((n) => [n, Deno.env.get(n)]));
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

const BASE_ENV = {
  // A closed local port: any real database call would fail loudly.
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  AGENT_BEARER_TOKEN: "agent-fixture",
};

let modulePromise: Promise<any> | null = null;
function opsApi() {
  modulePromise ??= withEnv(BASE_ENV, async () => await import("./index.ts"));
  return modulePromise;
}

function assertNoSentinel(value: unknown, label: string) {
  const text = JSON.stringify(value ?? null);
  assert(!text.includes("SENTINEL"), `${label} echoed raw text: ${text}`);
}

Deno.test("raw provider text: an error that is not an ApiError is neither returned nor logged", async () => {
  const { _opsApiRequestHandlerForTest: handle } = await opsApi();
  const logged: unknown[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, fetch: globalThis.fetch };
  console.log = console.error = console.warn = (...line: unknown[]) => { logged.push(line); };
  // The booking agent call is not wrapped: a transport failure reaches the
  // general catch as a plain Error carrying the sentinel.
  globalThis.fetch = (() => Promise.reject(new Error(SENTINEL))) as typeof fetch;
  let res: Response;
  try {
    res = await withEnv(BASE_ENV, () =>
      handle(new Request("https://example.invalid/ops-api?action=approve_booking_proposal", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({ proposal_id: "p-1" }),
      }))
    );
  } finally {
    Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn });
    globalThis.fetch = saved.fetch;
  }
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "Internal error");
  assertEquals(body.error_name, "Error");
  assertNoSentinel(body, "reply");
  assertNoSentinel(logged, "log lines");
  const lines = JSON.stringify(logged);
  assert(lines.includes("ops_api_unhandled_error"), lines);
  assert(lines.includes("approve_booking_proposal"), lines);
});

Deno.test("raw provider text: a failed draft pack stores the error's class only", async () => {
  const { _markDraftPackFailedForTest: markDraftPackFailed, ApiError } = await opsApi();
  for (const err of [
    new Error(SENTINEL),
    new ApiError(`claude draft refused: ${SENTINEL}`, 502),
    Object.assign(new Error(SENTINEL), { name: "PostgrestError", code: SENTINEL, status: 503 }),
    SENTINEL,
  ]) {
    const patches: Record<string, unknown>[] = [];
    const builder: any = {
      update: (patch: Record<string, unknown>) => { patches.push(patch); return builder; },
      eq: () => builder,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    await markDraftPackFailed({ from: () => builder }, "job-1", "main", err);
    assertEquals(patches.length, 1);
    assertEquals(patches[0].status, "failed");
    assertEquals(patches[0].failed_step, "draft_pack");
    assert(String(patches[0].error_detail).startsWith("draft pack failed: "), String(patches[0].error_detail));
    assertNoSentinel(patches, "draft pack row");
  }
});
