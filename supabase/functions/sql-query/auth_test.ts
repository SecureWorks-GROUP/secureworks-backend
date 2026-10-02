// sql-query accepts only the service-role key. SW_API_KEY is public in page
// code, so it must be refused, as must a request with no key at all.
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isServiceKeyCaller,
  refuseUnlessServiceKey,
  timingSafeEqual,
} from "./auth.ts";

// Placeholders only; no real key value appears in this file.
const SERVICE_KEY = "test-service-role-key-placeholder";
const SW_API_KEY = "test-sw-api-key-placeholder";

function post(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/functions/v1/sql-query", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ sql: "select 1" }),
  });
}

async function assertUnauthorized(res: Response | null) {
  assert(res, "expected a refusal response");
  assertEquals(res.status, 401);
  assertEquals(await res.json(), { error: "Unauthorized" });
}

Deno.test("SW_API_KEY is refused", async () => {
  const req = post({ "x-api-key": SW_API_KEY });
  assertFalse(isServiceKeyCaller(req, SERVICE_KEY));
  await assertUnauthorized(refuseUnlessServiceKey(req, SERVICE_KEY));
});

Deno.test("no key is refused", async () => {
  const req = post();
  assertFalse(isServiceKeyCaller(req, SERVICE_KEY));
  await assertUnauthorized(refuseUnlessServiceKey(req, SERVICE_KEY));
});

Deno.test("empty key is refused", async () => {
  await assertUnauthorized(
    refuseUnlessServiceKey(post({ "x-api-key": "" }), SERVICE_KEY),
  );
});

Deno.test("service key is accepted", () => {
  const req = post({ "x-api-key": SERVICE_KEY });
  assert(isServiceKeyCaller(req, SERVICE_KEY));
  assertEquals(refuseUnlessServiceKey(req, SERVICE_KEY), null);
});

Deno.test("a near-miss of the service key is refused", async () => {
  await assertUnauthorized(
    refuseUnlessServiceKey(
      post({ "x-api-key": SERVICE_KEY + "x" }),
      SERVICE_KEY,
    ),
  );
  await assertUnauthorized(
    refuseUnlessServiceKey(
      post({ "x-api-key": SERVICE_KEY.slice(0, -1) }),
      SERVICE_KEY,
    ),
  );
});

Deno.test("an unset service key refuses every caller, including an empty key", async () => {
  await assertUnauthorized(refuseUnlessServiceKey(post(), ""));
  await assertUnauthorized(
    refuseUnlessServiceKey(post({ "x-api-key": "" }), ""),
  );
  await assertUnauthorized(
    refuseUnlessServiceKey(post({ "x-api-key": SW_API_KEY }), ""),
  );
});

Deno.test("an Authorization bearer alone does not pass", async () => {
  await assertUnauthorized(
    refuseUnlessServiceKey(
      post({ Authorization: `Bearer ${SERVICE_KEY}` }),
      SERVICE_KEY,
    ),
  );
});

Deno.test("timingSafeEqual compares whole strings", () => {
  assert(timingSafeEqual("abc", "abc"));
  assertFalse(timingSafeEqual("abc", "abd"));
  assertFalse(timingSafeEqual("abc", "abcd"));
  assertFalse(timingSafeEqual("", "a"));
});

// Wiring pins: the handler reads no SW_API_KEY, runs the guard before any
// other work (including OPTIONS and body parsing), and keeps the deploy marker
// that holds verify_jwt off as it is live.
const INDEX_SOURCE = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);

Deno.test("index.ts no longer reads or compares SW_API_KEY", () => {
  assertFalse(INDEX_SOURCE.includes("SW_API_KEY"));
  assertFalse(INDEX_SOURCE.includes("x-api-key"));
});

Deno.test("index.ts runs the service-key guard first in the handler", () => {
  const handlerStart = INDEX_SOURCE.indexOf("serve(async (req: Request) => {");
  assert(handlerStart >= 0, "handler not found");
  const guard = INDEX_SOURCE.indexOf(
    "refuseUnlessServiceKey(req, SUPABASE_SERVICE_KEY)",
    handlerStart,
  );
  const options = INDEX_SOURCE.indexOf(
    "req.method === 'OPTIONS'",
    handlerStart,
  );
  const body = INDEX_SOURCE.indexOf("req.json()", handlerStart);
  assert(guard > handlerStart, "guard not found in handler");
  assert(
    guard < options && guard < body,
    "guard must run before any other work",
  );
});

Deno.test("index.ts keeps the --no-verify-jwt deploy marker in its first 30 lines", () => {
  const head = INDEX_SOURCE.split("\n").slice(0, 30).join("\n");
  assert(head.includes("--no-verify-jwt"));
});
