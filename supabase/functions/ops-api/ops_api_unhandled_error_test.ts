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

// Caller-input and business-rule messages reach the client exactly as main
// (efb28a57) answers them: status 500 and `{ error: <message> }`, nothing else.
// Each case fails before any database or provider call.
const MAIN_CLIENT_MESSAGES: Array<{ action: string; method: "GET" | "POST"; body?: Record<string, unknown>; error: string }> = [
  { action: "update_job_action", method: "POST", body: {}, error: "action_id required" },
  { action: "dismiss_proposed_action", method: "POST", body: {}, error: "action_id required" },
  { action: "snooze_proposed_action", method: "POST", body: {}, error: "action_id required" },
  { action: "create_job_action", method: "POST", body: {}, error: "title required" },
  { action: "delete_org_event", method: "POST", body: {}, error: "id required" },
  { action: "update_po", method: "POST", body: {}, error: "id required" },
  { action: "add_po_event", method: "POST", body: {}, error: "po_id required" },
  { action: "reject_intake_draft", method: "POST", body: {}, error: "draft_id required" },
  { action: "dismiss_alert", method: "POST", body: {}, error: "alert_id required" },
  { action: "approve_variation", method: "POST", body: {}, error: "variation_id required" },
  { action: "confirm_price", method: "POST", body: {}, error: "ledger_id required" },
  { action: "act_nudge", method: "POST", body: {}, error: "nudge_id required" },
  { action: "list_job_actions", method: "GET", error: "job_id required" },
  { action: "get_email_events", method: "GET", error: "job_id required" },
  { action: "materials_recon_assign", method: "POST", body: {}, error: "queue_id or xero_invoice_id is required" },
  { action: "materials_recon_not_job_related", method: "POST", body: {}, error: "queue_id or xero_invoice_id is required" },
];

Deno.test("client messages: caller-input refusals answer exactly as main does", async () => {
  const { _opsApiRequestHandlerForTest: handle } = await opsApi();
  const saved = { log: console.log, error: console.error, warn: console.warn, fetch: globalThis.fetch };
  console.log = console.error = console.warn = () => {};
  // Any network call would mean the case reached past validation.
  globalThis.fetch = (() => Promise.reject(new Error(SENTINEL))) as typeof fetch;
  try {
    for (const c of MAIN_CLIENT_MESSAGES) {
      const res = await withEnv(BASE_ENV, () =>
        handle(new Request(`https://example.invalid/ops-api?action=${c.action}`, {
          method: c.method,
          headers: { "content-type": "application/json", authorization: `Bearer ${SERVICE_KEY}` },
          body: c.method === "POST" ? JSON.stringify(c.body ?? {}) : undefined,
        }))
      );
      assertEquals(res.status, 500, c.action);
      assertEquals(await res.json(), { error: c.error }, c.action);
    }
  } finally {
    Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn });
    globalThis.fetch = saved.fetch;
  }
});

Deno.test("client messages: no literal plain Error is thrown in any ops-api module", async () => {
  // A literal message is caller-facing: it must be a ClientInputError so the
  // general catch keeps main's wording rather than answering "Internal error".
  // Any quote style, "$" included, across lines; a template literal counts
  // only when it interpolates nothing.
  const literal = /throw new Error\(\s*('[^'\\\n]*'|"[^"\\\n]*"|`[^`\\$]*`)\s*,?\s*\)/g;
  const hits: string[] = [];
  for await (const entry of Deno.readDir(new URL("./", import.meta.url))) {
    // Test files and test helpers (`_test_helpers.ts`, `*_test_fakes.ts`) never serve a request.
    if (!entry.isFile || !entry.name.endsWith(".ts") || entry.name.includes("test")) continue;
    const source = await Deno.readTextFile(new URL(`./${entry.name}`, import.meta.url));
    for (const m of source.matchAll(literal)) hits.push(`${entry.name}: ${m[0]}`);
  }
  assertEquals(hits, []);
});
