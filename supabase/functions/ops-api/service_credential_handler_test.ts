/**
 * Legacy service-role key retirement, runbook Step 4 C
 * (docs/evidence/legacy-service-role-key-removal-2026-09-30.md).
 *
 * Through the real ops-api request handler: the injected legacy key keeps
 * working while Supabase still accepts it, stops working the moment Supabase
 * refuses it (legacy keys switched off), and a new sb_secret_ key works in the
 * `apikey` header. `book_scope` is a retired action, so an authorised caller
 * gets 400 Unknown action and an unauthorised one 401, and nothing else runs.
 */
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _setDefaultLegacyKeyProbeForTest,
  type LegacyKeyVerdict,
} from "../_shared/service_credential.ts";

const LEGACY = "test-legacy-service-role-key";
const SECRET = "sb_secret_fx_ops_api";
const ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEYS",
  "SW_API_KEY",
  "MAKESAFE_ROUTINE_KEY",
  "OPS_AGENT_SERVER_KEY",
];
const ENV: Record<string, string> = {
  // A closed local port: any real database call would fail loudly.
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: LEGACY,
  SUPABASE_SECRET_KEYS: JSON.stringify({ edge: SECRET }),
};

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map(ENV_NAMES.map((n) => [n, Deno.env.get(n)]));
  for (const name of ENV_NAMES) {
    if (ENV[name] === undefined) Deno.env.delete(name);
    else Deno.env.set(name, ENV[name]);
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

let handlerPromise: Promise<(req: Request) => Promise<Response>> | null = null;
function handler() {
  handlerPromise ??= withEnv(async () =>
    (await import("./index.ts"))._opsApiRequestHandlerForTest
  );
  return handlerPromise;
}

async function call(
  headers: Record<string, string>,
  verdict: LegacyKeyVerdict,
) {
  const probed: string[] = [];
  _setDefaultLegacyKeyProbeForTest((token) => {
    probed.push(token);
    return Promise.resolve(verdict);
  });
  try {
    const h = await handler();
    const res = await withEnv(() =>
      h(
        new Request("https://example.invalid/ops-api?action=book_scope", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: "{}",
        }),
      )
    );
    await res.body?.cancel();
    return { status: res.status, probed };
  } finally {
    _setDefaultLegacyKeyProbeForTest(null);
  }
}

Deno.test("legacy key still works while Supabase accepts it", async () => {
  const r = await call({ authorization: `Bearer ${LEGACY}` }, "accepted");
  assertEquals(r.status, 400);
  assertEquals(r.probed, [LEGACY]);
});

Deno.test("legacy key is refused once Supabase switches legacy keys off", async () => {
  for (
    const headers of [
      { authorization: `Bearer ${LEGACY}` },
      { "x-api-key": LEGACY },
      { apikey: LEGACY },
    ]
  ) {
    assertEquals((await call(headers, "rejected")).status, 401);
  }
});

Deno.test("a new secret key in the apikey header is a server caller", async () => {
  const r = await call({ apikey: SECRET }, "rejected");
  assertEquals(r.status, 400);
  assertEquals(r.probed, []);
});

Deno.test("an unlisted secret key and no credentials are refused", async () => {
  assertEquals(
    (await call({ apikey: "sb_secret_not_ours" }, "accepted")).status,
    401,
  );
  assertEquals((await call({}, "accepted")).status, 401);
});
