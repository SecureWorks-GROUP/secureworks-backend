/**
 * Legacy service-role key retirement, runbook Step 4 C
 * (docs/evidence/legacy-service-role-key-removal-2026-09-30.md).
 *
 * Through the real ops-api request handler: the injected legacy key keeps
 * working while Supabase still accepts it, stops working the moment Supabase
 * refuses it (legacy keys switched off), and a new sb_secret_ key works in the
 * `apikey` header. `book_scope` is a retired action, so an authorised caller
 * gets 400 Unknown action and an unauthorised one 401, and nothing else runs.
 *
 * The close-out sweep cron (`trigger_job_closeout_sweep`) posts
 * `Bearer <sw_service_key()>`, a service-role JWT that is not the injected key.
 * Those cases send GET: a server caller gets 405 method_not_allowed from
 * runJobCloseoutAction (proof it was classified server, with nothing run), and
 * anyone else 401 at the front door. The same holds for the other timed jobs
 * in OPS_API_CRON_SERVICE_ROLE_CLAIM_ACTIONS (cases at the end of this file).
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
  { action = "book_scope", method = "POST" } = {},
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
        new Request(`https://example.invalid/ops-api?action=${action}`, {
          method,
          headers: { "content-type": "application/json", ...headers },
          body: method === "POST" ? "{}" : undefined,
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

// An unsigned JWT with the given payload. ops-api runs with --no-verify-jwt, so
// only the helper's gateway probe (stubbed here) decides whether it is genuine.
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(
      /\//g,
      "_",
    );
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
}
const CRON_KEY = jwt({ role: "service_role", iss: "supabase", ref: "vault" });
const SWEEP = { action: "job_closeout_sweep", method: "GET" };

Deno.test("the sweep cron's service-role bearer reaches job_closeout_sweep as the server", async () => {
  const r = await call(
    { authorization: `Bearer ${CRON_KEY}` },
    "accepted",
    SWEEP,
  );
  assertEquals(r.status, 405);
  assertEquals(r.probed, [CRON_KEY]);
});

Deno.test("a service-role claim Supabase does not accept is refused at job_closeout_sweep", async () => {
  for (const verdict of ["rejected", "unknown"] as const) {
    assertEquals(
      (await call({ authorization: `Bearer ${CRON_KEY}` }, verdict, SWEEP))
        .status,
      401,
    );
  }
});

Deno.test("a non-service-role JWT is still refused at job_closeout_sweep", async () => {
  for (const role of ["authenticated", "anon", "service_role "]) {
    const token = jwt({ role });
    const r = await call(
      { authorization: `Bearer ${token}` },
      "accepted",
      SWEEP,
    );
    assertEquals(r.status, 401);
    assertEquals(r.probed, []);
  }
});

Deno.test("the service-role claim is not a server caller on any other action", async () => {
  for (
    const opts of [
      { action: "book_scope", method: "POST" },
      { action: "job_closeout_catch_up", method: "GET" },
      { action: "job_closeout_paid", method: "GET" },
    ]
  ) {
    const r = await call(
      { authorization: `Bearer ${CRON_KEY}` },
      "accepted",
      opts,
    );
    assertEquals(r.status, 401);
    assertEquals(r.probed, []);
  }
});

Deno.test("the injected key still reaches the close-out actions xero-sync calls", async () => {
  for (
    const action of [
      "job_closeout_catch_up",
      "job_closeout_paid",
      "job_closeout_sweep",
    ]
  ) {
    const r = await call({ authorization: `Bearer ${LEGACY}` }, "accepted", {
      action,
      method: "GET",
    });
    assertEquals(r.status, 405);
  }
});

// The other timed jobs that post a service-role JWT that is not the injected
// key, all `sw_service_key()` POSTs: trigger_job_work_order_auto_issue, and
// the make-safe canaries and email reconcile jobs (trigger_makesafe_status_canary
// and trigger_makesafe_reconcile: D1, D2 inventory, D3 as D1 with mode=D3, D4
// canary). Each case compares the cron bearer with the injected key on the same
// request: the same outcome means the cron is classified as the server caller.
// auto_issue is sent as GET so it stops at 405 with nothing run; the make-safe
// actions have no method gate and stop at the closed database port, which is
// never the front door's 401 nor their own admin gate's 403.
const CRON_ACTIONS = [
  { action: "auto_issue_job_work_orders", method: "GET" },
  { action: "makesafe_email_canary", method: "POST" },
  { action: "makesafe_status_canary", method: "POST" },
  { action: "makesafe_email_reconcile", method: "POST" },
  { action: "makesafe_email_reconcile_inventory", method: "POST" },
  { action: "makesafe_email_reconcile&mode=D3", method: "POST" },
];

Deno.test("the timed jobs' service-role bearer reaches each action as the server", async () => {
  for (const opts of CRON_ACTIONS) {
    const server = await call(
      { authorization: `Bearer ${LEGACY}` },
      "accepted",
      opts,
    );
    const cron = await call(
      { authorization: `Bearer ${CRON_KEY}` },
      "accepted",
      opts,
    );
    assertEquals(cron.status, server.status, opts.action);
    assertEquals(cron.probed, [CRON_KEY], opts.action);
    if (opts.action === "auto_issue_job_work_orders") {
      assertEquals(cron.status, 405);
    } else {
      assertEquals(cron.status === 401, false, opts.action);
      assertEquals(cron.status === 403, false, opts.action);
    }
  }
});

Deno.test("a service-role claim Supabase does not accept is refused at the timed jobs", async () => {
  for (const opts of CRON_ACTIONS) {
    for (const verdict of ["rejected", "unknown"] as const) {
      assertEquals(
        (await call({ authorization: `Bearer ${CRON_KEY}` }, verdict, opts))
          .status,
        401,
        `${opts.action} ${verdict}`,
      );
    }
  }
});

Deno.test("a non-service-role JWT is still refused at the timed jobs", async () => {
  for (const opts of CRON_ACTIONS) {
    for (const role of ["authenticated", "anon", "service_role "]) {
      const r = await call(
        { authorization: `Bearer ${jwt({ role })}` },
        "accepted",
        opts,
      );
      assertEquals(r.status, 401, `${opts.action} ${role}`);
      assertEquals(r.probed, [], `${opts.action} ${role}`);
    }
  }
});
