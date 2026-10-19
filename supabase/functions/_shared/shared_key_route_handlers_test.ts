// deno test --no-check --allow-env --allow-read supabase/functions/_shared/shared_key_route_handlers_test.ts
//
// SW_SHARED_KEY_CONTAINMENT on the real handlers of ops-ai, agent-runner,
// completion-pack and send-po-email. With the switch on, the shared key (in
// x-api-key or as a Bearer) is refused with 401 before any side effect: fetch
// is stubbed to count calls, so a refusal that let the request through to the
// database, the user check or a model call would show up as a call. With the
// switch off the same request gets past auth, which proves the switch is what
// refused it. All keys below are made-up test values.
// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const SHARED = "test-shared-browser-key-not-real";
const SECRET = "sb_secret_test_service_key_not_real";

Deno.env.set("SUPABASE_URL", "https://stub-supabase.invalid");
Deno.env.set("SW_API_KEY", SHARED);
Deno.env.set("SUPABASE_SECRET_KEYS", JSON.stringify({ default: SECRET }));
Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
Deno.env.delete("ANTHROPIC_API_KEY");

const { handleOpsAiRequest } = await import("../ops-ai/index.ts");
const { handleAgentRunnerRequest } = await import("../agent-runner/index.ts");
const { handleCompletionPackRequest } = await import("../completion-pack/index.ts");
const { handleSendPoEmailRequest } = await import("../send-po-email/index.ts");

type Handler = (req: Request) => Promise<Response>;
const ROUTES: Array<{ fn: string; handler: Handler; method: string }> = [
  { fn: "ops-ai", handler: handleOpsAiRequest, method: "POST" },
  { fn: "agent-runner", handler: handleAgentRunnerRequest, method: "POST" },
  { fn: "completion-pack", handler: handleCompletionPackRequest, method: "POST" },
  // GET reaches send-po-email's 405 just after auth, with no side effect.
  { fn: "send-po-email", handler: handleSendPoEmailRequest, method: "GET" },
];

async function call(handler: Handler, method: string, headers: Record<string, string>, containment: string | null) {
  if (containment === null) Deno.env.delete("SW_SHARED_KEY_CONTAINMENT");
  else Deno.env.set("SW_SHARED_KEY_CONTAINMENT", containment);
  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    fetches++;
    return Promise.reject(new Error("no network in this test"));
  }) as typeof fetch;
  const log = console.log, error = console.error, warn = console.warn;
  console.log = console.error = console.warn = () => {};
  try {
    const init: RequestInit = { method, headers: { "content-type": "application/json", ...headers } };
    if (method === "POST") init.body = "{}";
    const resp = await handler(new Request(`https://stub.invalid/functions/v1/x`, init));
    await resp.body?.cancel();
    return { status: resp.status, fetches };
  } finally {
    globalThis.fetch = original;
    console.log = log;
    console.error = error;
    console.warn = warn;
    Deno.env.delete("SW_SHARED_KEY_CONTAINMENT");
  }
}

for (const { fn, handler, method } of ROUTES) {
  Deno.test(`${fn} handler: shared key refused with 401 before any side effect while containment is on`, async () => {
    for (const headers of [{ "x-api-key": SHARED }, { authorization: `Bearer ${SHARED}` }]) {
      const on = await call(handler, method, headers, "on");
      assertEquals(on.status, 401, JSON.stringify(Object.keys(headers)));
      assertEquals(on.fetches, 0, "no database, user check or model call before the refusal");
      // A mistyped switch value fails closed too.
      assertEquals((await call(handler, method, headers, "onn")).status, 401);
    }
  });

  Deno.test(`${fn} handler: the same shared key gets past auth while containment is off`, async () => {
    const off = await call(handler, method, { "x-api-key": SHARED }, null);
    assertNotEquals(off.status, 401);
  });

  Deno.test(`${fn} handler: a service credential gets past auth with containment on`, async () => {
    const svc = await call(handler, method, { authorization: `Bearer ${SECRET}`, apikey: SECRET }, "on");
    assertNotEquals(svc.status, 401);
  });

  Deno.test(`${fn} handler: no credential is refused`, async () => {
    const none = await call(handler, method, {}, null);
    assertEquals(none.status, 401);
    assert(none.fetches === 0);
  });
}
