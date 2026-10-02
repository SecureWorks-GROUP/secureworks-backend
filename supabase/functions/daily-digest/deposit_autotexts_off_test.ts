/**
 * The daily-digest half of the captain's "all off" ruling for our automated
 * money messages (debt book DECISIONS.md, Q6, 30 Sep 2026; the ops-api half and
 * the full list are in ops-api/debt_autotexts_off.ts).
 *
 * Drives the real daily-digest request handler with every database and
 * function call answered by a fetch spy, and proves:
 *  - stale_followup sends no day-3 deposit reminder, while its stale-quote
 *    follow-up and the day-7 ops annotation are unchanged;
 *  - the main digest run sends no Pay Now deposit chaser, and still leaves the
 *    unpaid-deposit annotation for ops.
 */
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SERVICE_KEY = "test-service-role-key";
const ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SW_API_KEY",
  "OPS_AGENT_SERVER_KEY",
  "ANTHROPIC_API_KEY",
];
const BASE_ENV = {
  // A closed local port: anything the fetch spy does not answer fails loudly.
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
};

// index.ts reads its env into module constants, so they are set before the
// dynamic import and restored after.
async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
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

let handlerPromise: Promise<(req: Request) => Promise<Response>> | null = null;
function handler() {
  handlerPromise ??= withEnv(
    BASE_ENV,
    async () => (await import("./index.ts"))._dailyDigestRequestHandlerForTest,
  );
  return handlerPromise;
}

function serviceRequest(action: string | null): Request {
  const query = action ? `?action=${action}` : "";
  return new Request(`https://example.invalid/daily-digest${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: "{}",
  });
}

type FetchCall = { url: URL; method: string; body: any };
type Rows = (url: URL) => unknown[] | null;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// PostgREST reads are answered by `rows` (null means "no rows"); every write
// succeeds; every function call succeeds, so a live send path would run to
// completion and show up in the call log.
async function withFetchSpy<T>(
  rows: Rows,
  fn: (calls: FetchCall[]) => Promise<T>,
): Promise<T> {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ??
      (input instanceof Request ? input.method : "GET")).toUpperCase();
    const accept = new Headers(init?.headers).get("accept") ?? "";
    let body: any = init?.body ?? null;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch { /* keep raw */ }
    }
    calls.push({ url, method, body });
    const one = accept.includes("vnd.pgrst.object");
    if (url.pathname.includes("/rest/v1/")) {
      if (method !== "GET" && method !== "HEAD") {
        return Promise.resolve(json(one ? null : [], 201));
      }
      const found = rows(url) ?? [];
      return Promise.resolve(json(one ? (found[0] ?? null) : found));
    }
    return Promise.resolve(json({ success: true, content: [] }));
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const table = (url: URL) => url.pathname.split("/rest/v1/")[1];
const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString();

function opsApiCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => c.url.pathname.endsWith("/functions/v1/ops-api"));
}
function annotationInserts(calls: FetchCall[], type: string): any[] {
  return calls
    .filter((c) => c.method === "POST" && table(c.url) === "ai_annotations")
    .flatMap((c) => Array.isArray(c.body) ? c.body : [c.body])
    .filter((row) => row?.annotation_type === type);
}

const QUOTED_JOB = "11111111-0000-4000-8000-000000000001";
const DAY4_DEPOSIT_JOB = "22222222-0000-4000-8000-000000000002";
const DAY8_DEPOSIT_JOB = "33333333-0000-4000-8000-000000000003";

Deno.test("stale_followup sends no deposit reminder and keeps its other follow-ups", async () => {
  const handle = await handler();
  const rows: Rows = (url) => {
    if (table(url) === "jobs" && url.searchParams.get("status") === "eq.quoted") {
      return [{
        id: QUOTED_JOB,
        job_number: "SWP-25001",
        client_name: "Quinn Quoted",
        type: "patio",
        pricing_json: { total: 9000 },
        quoted_at: daysAgo(4),
      }];
    }
    if (table(url) === "jobs" && url.searchParams.get("status") === "eq.accepted") {
      return [
        {
          id: DAY4_DEPOSIT_JOB,
          job_number: "SWP-25002",
          client_name: "Dana Deposit",
          type: "patio",
          accepted_at: daysAgo(4),
        },
        {
          id: DAY8_DEPOSIT_JOB,
          job_number: "SWP-25003",
          client_name: "Eli Eight",
          type: "fencing",
          accepted_at: daysAgo(8),
        },
      ];
    }
    // Every accepted job has an unpaid AUTHORISED deposit invoice.
    if (table(url) === "xero_invoices") return [{ status: "AUTHORISED" }];
    return null;
  };

  await withEnv(
    BASE_ENV,
    () =>
      withFetchSpy(rows, async (calls) => {
        const res = await handle(serviceRequest("stale_followup"));
        const body = await res.json();
        assertEquals(res.status, 200, JSON.stringify(body));
        assertEquals(body.unpaid_deposits, 2);

        const sends = opsApiCalls(calls);
        // No deposit reminder, for either accepted job.
        assertEquals(
          sends.filter((c) => c.body?.comms_trigger === "deposit_paid"),
          [],
        );
        assertEquals(
          sends.filter((c) =>
            c.body?.job_id === DAY4_DEPOSIT_JOB ||
            c.body?.job_id === DAY8_DEPOSIT_JOB
          ),
          [],
        );
        // Outside the ruling and untouched: the day-3 stale-quote text.
        const quoteSends = sends.filter((c) => c.body?.job_id === QUOTED_JOB);
        assertEquals(quoteSends.length, 1);
        assertEquals(quoteSends[0].body.comms_trigger, "quote_sent");
        assertEquals(quoteSends[0].body.channel, "sms");
        // The day-7+ red "call immediately" annotation for ops still fires.
        const urgent = annotationInserts(calls, "unpaid_deposit_urgent");
        assertEquals(urgent.map((a) => a.job_id), [DAY8_DEPOSIT_JOB]);
      }),
  );
});

const DIGEST_DEPOSIT_JOB = "44444444-0000-4000-8000-000000000004";

Deno.test("the daily digest sends no Pay Now deposit chaser and keeps the ops annotation", async () => {
  const handle = await handler();
  const rows: Rows = (url) => {
    // Section 4b's query: AUTHORISED deposit invoices with money still due.
    if (
      table(url) === "xero_invoices" &&
      url.searchParams.get("reference") === "ilike.%DEP%"
    ) {
      return [{
        id: "row-1",
        xero_invoice_id: "xero-deposit-9d",
        invoice_number: "INV-1500",
        job_id: DIGEST_DEPOSIT_JOB,
        reference: "SWP-25004-DEP50",
        total: 4200,
        amount_due: 4200,
        amount_paid: 0,
        invoice_date: daysAgo(9).slice(0, 10),
        status: "AUTHORISED",
      }];
    }
    if (
      table(url) === "jobs" &&
      url.searchParams.get("id") === `eq.${DIGEST_DEPOSIT_JOB}`
    ) {
      return [{
        id: DIGEST_DEPOSIT_JOB,
        client_name: "Dee Posit",
        client_phone: "+61400000001",
        ghl_contact_id: "ghl-contact-9",
        job_number: "SWP-25004",
      }];
    }
    return null;
  };

  await withEnv(
    BASE_ENV,
    () =>
      withFetchSpy(rows, async (calls) => {
        const res = await handle(serviceRequest(null));
        await res.body?.cancel();

        // No Pay Now link text, and nothing else sent to the client.
        assertEquals(
          calls.filter((c) =>
            c.url.searchParams.get("action") === "send_payment_link"
          ),
          [],
        );
        assertEquals(
          calls.filter((c) =>
            c.url.pathname.includes("/functions/v1/ghl-proxy") ||
            c.url.pathname.endsWith("/functions/v1/ops-api")
          ),
          [],
        );

        // The deposit is still visible to ops, and says the reminder is off.
        const annotations = annotationInserts(calls, "unpaid_deposit");
        assertEquals(annotations.length, 1, JSON.stringify(annotations));
        const [annotation] = annotations;
        assertEquals(annotation.entity_id, DIGEST_DEPOSIT_JOB);
        assertEquals(annotation.structured_data.auto_reminder, "off");
        assertEquals(annotation.structured_data.sms_reminder_sent, false);
        assert(!/reminder sent/i.test(annotation.title), annotation.title);
      }),
  );
});

// Runbook Step 4 (legacy service-role key removal) found the house-plans
// reminders naming an undeclared SERVICE_ROLE_KEY. That threw before any send,
// so no house-plans reminder has ever reached a client. Removing the undeclared
// name must not quietly switch those client messages on; turning them on is a
// separate decision.
const PLANS_DAY5_JOB = "55555555-0000-4000-8000-000000000005";
const PLANS_DAY8_JOB = "66666666-0000-4000-8000-000000000006";

Deno.test("stale_followup sends no house-plans reminder to clients", async () => {
  const handle = await handler();
  const plansRow = (id: string, days: number, client_email: string | null) => ({
    id: `cs-${id}`,
    job_id: id,
    created_at: daysAgo(days),
    steps: [{ status: "pending" }],
    jobs: {
      job_number: "SWP-26000",
      client_name: "Pat Plans",
      client_phone: "+61400000002",
      client_email,
      site_address: "1 Test St",
      type: "patio",
    },
  });
  const rows: Rows = (url) => {
    if (table(url) === "council_submissions") {
      return [
        plansRow(PLANS_DAY5_JOB, 5, null),
        plansRow(PLANS_DAY8_JOB, 8, "pat@example.invalid"),
      ];
    }
    return null;
  };

  await withEnv(
    BASE_ENV,
    () =>
      withFetchSpy(rows, async (calls) => {
        const res = await handle(serviceRequest("stale_followup"));
        const body = await res.json();
        assertEquals(res.status, 200, JSON.stringify(body));
        assertEquals(body.plans_followups, 0);
        assertEquals(
          opsApiCalls(calls).filter((c) =>
            String(c.body?.comms_trigger || "").startsWith("plans_reminder")
          ),
          [],
        );
      }),
  );
});
