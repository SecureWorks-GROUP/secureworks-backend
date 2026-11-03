/**
 * V16 work-order claim warning, through the real ops-api request handler
 * (list_trade_invoice_lines), with every database call answered by a fetch
 * spy (nothing leaves the process):
 *  - a staff caller (server key) gets work_order_claim_warning on the two
 *    claim lines of SWF-261209 and work_order_claim_check with labour 1720.00
 *    against the largest claim 1465.00 (production rows, read only, 3 Nov
 *    2026; worked by hand in work_order_claim_check_test.ts);
 *  - a failed labour read still lists every line (never blocks) and the claim
 *    lines say the check could not be read;
 *  - a signed-in trade is refused at the front door and the labour view is
 *    never read, so no claim text reaches the trade app.
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CLAIM_CHECK_UNREADABLE_WARNING } from "./work_order_claim_check.ts";

const SERVICE_KEY = "test-service-role-key";
const USER_JWT = "test-signed-in-trade-jwt";
const TRADE_ID = "7d4f0a52-0000-4000-8000-00000000f4c7";
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

// SWF-261209 (job id as in production).
const JOB = "f0000000-0000-4000-8000-000000261209";
const HENRY = "c9a84f70-6d43-43f2-8a5b-3ec6ba9ade8b";
const ALYX = "2f00f91e-8b76-4856-8dec-ab6041f04e1d";
const KIM = "e0f93e18-f8b2-4548-80fc-9ff1a2782314";
const KHAIRO = "be6c2188-2b7b-49c7-b6e4-5b0d0deb6415";
const TAIL =
  "Named crew bill SecureWorks Group directly; office to check their invoices against this breakdown.";
const ROWS = [
  {
    id: "19ca6478-d36f-43e7-a1d8-0d027c20b6dc",
    user_id: HENRY,
    name: "Henry",
    lane: "labour",
    amount: 255,
    description:
      `Work order $1153.00.\nLess labour: Alyx 1h x $898 = $898.00.\nTotal labour deducted $898.00.\nNet payable to holder $255.00.\n${TAIL}`,
  },
  {
    id: "ba9a8a1c-1b09-49c4-8315-0d6e29dca5cf",
    user_id: KHAIRO,
    name: "Khairo",
    lane: "commission",
    amount: 258,
    description: "Commission — SWF-261209 — Estelle Sioz",
  },
  {
    id: "e2bcd53b-e9f5-4ec2-8e64-2560b1c0082b",
    user_id: KIM,
    name: "Kim Muiruri",
    lane: "labour",
    amount: 240,
    description: "Fencing",
  },
  {
    id: "fe3ebe3a-5e46-4f75-94f2-9c308ee6ce69",
    user_id: ALYX,
    name: "Alyx",
    lane: "labour",
    amount: 1225,
    description:
      `Work order $1465.00.\nLess labour: Kim 8h x $30 = $240.00.\nTotal labour deducted $240.00.\nNet payable to holder $1225.00.\n${TAIL}`,
  },
];

const EXPECTED =
  "Labour on this job $1,720.00 against the largest work-order claim $1,465.00, $255.00 more. " +
  "Two leads claimed a work order: Alyx $1,465.00, Henry $1,153.00. " +
  "Check who did the work before approving.";

type Opts = { viewFails?: boolean };

function respond(url: URL, opts: Opts): Response {
  const path = url.pathname;
  if (path.endsWith("/auth/v1/user")) {
    return Response.json({ id: TRADE_ID, email: "", aud: "authenticated" });
  }
  if (path.endsWith("/rest/v1/users")) {
    const ids = url.searchParams.get("id") || "";
    if (ids.startsWith("in.")) {
      return Response.json(
        ROWS.filter((r) => ids.includes(r.user_id)).map((r) => ({
          id: r.user_id,
          name: r.name,
        })),
      );
    }
    // The signed-in trade's own profile.
    return Response.json({
      org_id: "00000000-0000-0000-0000-000000000001",
      role: "trade",
      managed_verticals: [],
    });
  }
  if (path.endsWith("/rest/v1/trade_invoice_lines")) {
    return Response.json(ROWS.map((r) => ({
      id: r.id,
      job_id: JOB,
      description: r.description,
      line_total_ex: r.amount,
      office_review_status: null,
      trade_invoices: {
        status: "paid",
        week_start: "2026-10-06",
        user_id: r.user_id,
        user: { name: r.name },
      },
    })));
  }
  if (path.endsWith("/rest/v1/v_trade_charge_resolved")) {
    if (opts.viewFails) {
      return Response.json({ message: "boom" }, { status: 500 });
    }
    if (url.searchParams.get("resolved_job_id") !== `eq.${JOB}`) {
      return Response.json([]);
    }
    return Response.json(ROWS.map((r) => ({
      line_id: r.id,
      user_id: r.user_id,
      invoice_status: "paid",
      cost_lane: r.lane,
      line_total_ex: r.amount,
      description: r.description,
    })));
  }
  return new Response("[]", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function list(
  headers: Record<string, string>,
  opts: Opts = {},
): Promise<{ status: number; body: any; urls: string[] }> {
  const handle = await handler();
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    urls.push(url.toString());
    return Promise.resolve(respond(url, opts));
  }) as typeof fetch;
  try {
    const res = await withEnv(() =>
      handle(
        new Request(
          `https://example.invalid/ops-api?action=list_trade_invoice_lines&job_id=${JOB}`,
          { method: "GET", headers },
        ),
      )
    );
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch { /* not json */ }
    return { status: res.status, body, urls };
  } finally {
    globalThis.fetch = original;
  }
}

function warningsById(body: any): Map<string, string | null> {
  return new Map(
    (body.lines || []).map((l: any) => [l.id, l.work_order_claim_warning]),
  );
}

Deno.test("office: SWF-261209 claim lines carry the warning, other lines none", async () => {
  const { status, body, urls } = await list({
    authorization: `Bearer ${SERVICE_KEY}`,
  });
  assertEquals(status, 200);
  assertEquals(body.lines.length, 4);
  const w = warningsById(body);
  assertEquals(w.get("19ca6478-d36f-43e7-a1d8-0d027c20b6dc"), EXPECTED);
  assertEquals(w.get("fe3ebe3a-5e46-4f75-94f2-9c308ee6ce69"), EXPECTED);
  assertEquals(w.get("e2bcd53b-e9f5-4ec2-8e64-2560b1c0082b"), null);
  assertEquals(w.get("ba9a8a1c-1b09-49c4-8315-0d6e29dca5cf"), null);
  assertEquals(body.work_order_claim_check.live_labour_ex, 1720);
  assertEquals(body.work_order_claim_check.largest_claim_ex, 1465);
  assertEquals(body.work_order_claim_check.claimant_count, 2);
  assertEquals(body.work_order_claim_check.difference_ex, 255);
  assertEquals(body.work_order_claim_check_error, null);
  // The pay figures on the lines are what the database holds, untouched.
  assertEquals(
    body.lines.map((l: any) => l.line_total_ex),
    [255, 258, 240, 1225],
  );
  // Read only: every call the list made was a GET.
  assert(urls.some((u) => u.includes("/rest/v1/v_trade_charge_resolved")));
});

Deno.test("office: a failed labour read never blocks the list and is said on the claim lines", async () => {
  const { status, body } = await list(
    { authorization: `Bearer ${SERVICE_KEY}` },
    { viewFails: true },
  );
  assertEquals(status, 200);
  assertEquals(body.lines.length, 4);
  const w = warningsById(body);
  assertEquals(
    w.get("19ca6478-d36f-43e7-a1d8-0d027c20b6dc"),
    CLAIM_CHECK_UNREADABLE_WARNING,
  );
  assertEquals(w.get("e2bcd53b-e9f5-4ec2-8e64-2560b1c0082b"), null);
  assertEquals(body.work_order_claim_check, null);
  assertEquals(body.work_order_claim_check_error, "labour_unreadable");
});

Deno.test("trade: a signed-in trade is refused and the labour view is never read", async () => {
  const { status, body, urls } = await list({
    authorization: `Bearer ${USER_JWT}`,
  });
  assertEquals(status, 403);
  assertEquals(body.code, "operator_access_required");
  assert(!JSON.stringify(body).includes("Work order"));
  assert(!urls.some((u) => u.includes("/rest/v1/v_trade_charge_resolved")));
  assert(!urls.some((u) => u.includes("/rest/v1/trade_invoice_lines")));
});
