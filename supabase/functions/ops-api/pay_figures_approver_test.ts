/**
 * Named pay figures are approver-only (director ruling 18 Nov 2026, 08:14 (4)).
 *
 * Through the real ops-api request handler, with every database call answered
 * by a fetch spy (nothing leaves the process), for each of the six actions:
 *  - an office user who is not a pay run approver gets 403 and no pay, rate,
 *    invoice, job or labour row is read;
 *  - the server key gets 403 with nothing read;
 *  - a failed, missing or empty approver list refuses (403), never passes;
 *  - an approver gets past the check to the action's own reads.
 * trade_labour_budget (Trade App) is also refused for an ordinary trade.
 * Roles only, made-up ids; no names, rates or amounts.
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  PAY_FIGURES_APPROVER_ACTIONS,
  payFiguresApproverRefusal,
} from "./pay_figures_approver.ts";

const SERVICE_KEY = "test-service-role-key";
const ORG = "00000000-0000-0000-0000-000000000001";
const JOB = "7d4f0a52-0000-4000-8000-0000000000b1";
const PEOPLE: Record<string, { id: string; role: string }> = {
  "approver-jwt": { id: "7d4f0a52-0000-4000-8000-0000000000a1", role: "owner" },
  "office-jwt": { id: "7d4f0a52-0000-4000-8000-0000000000a2", role: "admin" },
  "trade-jwt": { id: "7d4f0a52-0000-4000-8000-0000000000a3", role: "trade" },
};
const APPROVER_ID = PEOPLE["approver-jwt"].id;

const ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SW_API_KEY",
  "AGENT_BEARER_TOKEN",
  "MAKESAFE_ROUTINE_KEY",
  "OPS_AGENT_SERVER_KEY",
];
const BASE_ENV: Record<string, string | undefined> = {
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
};

async function withEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = new Map(ENV_NAMES.map((n) => [n, Deno.env.get(n)]));
  for (const name of ENV_NAMES) {
    const value = BASE_ENV[name];
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

let handlerPromise: Promise<(req: Request) => Promise<Response>> | null = null;
function handler() {
  handlerPromise ??= withEnv(async () =>
    (await import("./index.ts"))._opsApiRequestHandlerForTest
  );
  return handlerPromise;
}

type Settings = "approver" | "error" | "missing" | "empty" | "throws";

const ACTIONS: Array<{ action: string; query: Record<string, string> }> = [
  { action: "trade_pay_run_check", query: {} },
  { action: "list_trade_invoices", query: {} },
  { action: "labour_reconciliation", query: { job_id: JOB } },
  { action: "list_trade_invoice_lines", query: { job_id: JOB } },
  { action: "list_new_trade_invoices", query: {} },
  { action: "trade_labour_budget", query: { jobId: JOB, job_id: JOB } },
];

// What the gate itself may touch: the caller's profile and the approver list.
const GATE_TABLES = new Set(["users", "trade_pay_settings"]);

async function call(
  action: string,
  query: Record<string, string>,
  token: string,
  settings: Settings = "approver",
): Promise<{ status: number; body: any; paths: string[] }> {
  const handle = await handler();
  const paths: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const path = url.pathname;
    if (path.startsWith("/auth/v1/user")) {
      const bearer = (headers.get("authorization") || "").replace(
        /^Bearer\s+/i,
        "",
      );
      const person = PEOPLE[bearer];
      if (!person) {
        return Promise.resolve(
          Response.json({ message: "bad jwt" }, { status: 401 }),
        );
      }
      return Promise.resolve(
        Response.json({ id: person.id, email: "", aud: "authenticated" }),
      );
    }
    paths.push(path);
    const objectWanted = (headers.get("accept") || "").includes(
      "vnd.pgrst.object",
    );
    const one = (row: any) =>
      Promise.resolve(Response.json(objectWanted ? row : [row]));
    if (path.endsWith("/rest/v1/users")) {
      const id = (url.searchParams.get("id") || "").replace(/^eq\./, "");
      const person = Object.values(PEOPLE).find((p) => p.id === id);
      return one({
        id,
        org_id: ORG,
        role: person?.role ?? "trade",
        managed_verticals: [],
        trade_sees_all_jobs: false,
      });
    }
    if (path.endsWith("/rest/v1/trade_pay_settings")) {
      if (settings === "throws") {
        return Promise.reject(new TypeError("network down"));
      }
      if (settings === "error") {
        return Promise.resolve(
          Response.json({ message: "boom" }, { status: 500 }),
        );
      }
      if (settings === "missing") {
        return Promise.resolve(
          objectWanted
            ? Response.json({
              code: "PGRST116",
              details: "The result contains 0 rows",
              hint: null,
              message: "JSON object requested, multiple (or no) rows returned",
            }, { status: 406 })
            : Response.json([]),
        );
      }
      return one({
        pay_run_approver_user_ids: settings === "empty" ? [] : [APPROVER_ID],
      });
    }
    return Promise.resolve(Response.json([]));
  }) as typeof fetch;
  try {
    const url = new URL("https://example.invalid/ops-api");
    url.searchParams.set("action", action);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await withEnv(() =>
      handle(
        new Request(url, {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
        }),
      )
    );
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch { /* not json */ }
    return { status: res.status, body, paths };
  } finally {
    globalThis.fetch = original;
  }
}

function tablesRead(paths: string[]): string[] {
  return paths.map((p) => p.replace(/^\/rest\/v1\//, ""));
}

function assertNothingPastTheGate(action: string, paths: string[]) {
  const past = tablesRead(paths).filter((t) => !GATE_TABLES.has(t));
  assertEquals(past, [], `${action} read past the approver check`);
}

Deno.test("pay figures: the six actions are the approver list", () => {
  assertEquals(
    [...PAY_FIGURES_APPROVER_ACTIONS].sort(),
    ACTIONS.map((a) => a.action).sort(),
  );
});

for (const { action, query } of ACTIONS) {
  Deno.test(`pay figures: ${action} refuses an office user who is not an approver, before any read`, async () => {
    const out = await call(action, query, "office-jwt");
    assertEquals(out.status, 403, JSON.stringify(out.body));
    assertEquals(out.body.code, "pay_figures_not_approver");
    assertEquals(Object.keys(out.body).sort(), ["code", "error"]);
    assertNothingPastTheGate(action, out.paths);
  });

  Deno.test(`pay figures: ${action} refuses the server key with nothing read`, async () => {
    const out = await call(action, query, SERVICE_KEY);
    assertEquals(out.status, 403, JSON.stringify(out.body));
    assertNothingPastTheGate(action, out.paths);
    assert(
      !tablesRead(out.paths).includes("trade_pay_settings"),
      "the server key is refused without reading the approver list",
    );
  });

  for (const settings of ["error", "missing", "empty", "throws"] as const) {
    Deno.test(`pay figures: ${action} refuses when the approver list is ${settings}`, async () => {
      const out = await call(action, query, "approver-jwt", settings);
      assertEquals(out.status, 403, JSON.stringify(out.body));
      assertEquals(out.body.code, "pay_figures_approver_unreadable");
      assertNothingPastTheGate(action, out.paths);
    });
  }

  Deno.test(`pay figures: ${action} lets an approver through to its own reads`, async () => {
    const out = await call(action, query, "approver-jwt");
    assert(
      !String(out.body?.code || "").startsWith("pay_figures_"),
      `${action} refused an approver: ${JSON.stringify(out.body)}`,
    );
    assert(
      tablesRead(out.paths).some((t) => !GATE_TABLES.has(t)),
      `${action} never reached its own reads`,
    );
  });
}

Deno.test("pay figures: trade_labour_budget refuses an ordinary trade before any job or rate read", async () => {
  const out = await call(
    "trade_labour_budget",
    { jobId: JOB, job_id: JOB },
    "trade-jwt",
  );
  assertEquals(out.status, 403, JSON.stringify(out.body));
  assertEquals(out.body.code, "pay_figures_not_approver");
  assertNothingPastTheGate("trade_labour_budget", out.paths);
});

Deno.test("pay figures: keys with no person are refused without a read", async () => {
  for (const authMode of ["api_key", "routine", "agent_read", null]) {
    let read = false;
    const client = {
      from: () => {
        read = true;
        throw new Error("must not read");
      },
    };
    const refusal = await payFiguresApproverRefusal(client, {
      authMode,
      userId: APPROVER_ID,
    });
    assertEquals(refusal?.code, "pay_figures_not_approver", String(authMode));
    assertEquals(refusal?.status, 403);
    assertEquals(read, false);
  }
  const refusal = await payFiguresApproverRefusal({}, {
    authMode: "jwt",
    userId: null,
  });
  assertEquals(refusal?.code, "pay_figures_not_approver");
});
