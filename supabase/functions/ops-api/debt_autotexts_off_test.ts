/**
 * The captain's "all off" ruling for our automated money messages
 * (debt book DECISIONS.md, Q6, 30 Sep 2026). Xero's own reminder emails stay on.
 *
 * What these prove, through the real ops-api request handler, with every
 * database, Xero and GHL call answered by a fetch spy (nothing leaves the
 * process):
 *  - trigger_chase_workflow / stop_chase_workflow refuse by name and never
 *    reach GHL (the chase-overdue tag workflow is off);
 *  - handle_payment_event keeps its internal bookkeeping but sends no
 *    thank-you text and touches no GHL workflow;
 *  - send_acceptance_invoice still emails the branded Pay Now invoice when the
 *    invoice is AUTHORISED, never texts, and still sends nothing at all for a
 *    DRAFT invoice.
 * The daily-digest half is in daily-digest/deposit_autotexts_off_test.ts.
 */
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AUTOMATED_MONEY_MESSAGES_OFF_CODE,
  chaseWorkflowRefusal,
  RETIRED_CHASE_WORKFLOW_ACTIONS,
} from "./debt_autotexts_off.ts";

const SERVICE_KEY = "test-service-role-key";
const ENV_NAMES = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "XERO_CLIENT_ID",
  "SW_API_KEY",
  "MAKESAFE_ROUTINE_KEY",
  "OPS_AGENT_SERVER_KEY",
];
const BASE_ENV = {
  // A closed local port: anything the fetch spy does not answer fails loudly.
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  // The shared Xero cooldown keys on the app id; any non-empty value works.
  XERO_CLIENT_ID: "test-xero-client",
};

// index.ts reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY into module
// constants, so they are set before the dynamic import and restored after.
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
    async () => (await import("./index.ts"))._opsApiRequestHandlerForTest,
  );
  return handlerPromise;
}

function serviceRequest(action: string, body: unknown): Request {
  return new Request(`https://example.invalid/ops-api?action=${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

type FetchCall = { url: string; method: string; body: unknown };
type Responder = (
  url: URL,
  method: string,
  accept: string,
  body: unknown,
) => Response;
function parseBody(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
async function withFetchSpy<T>(
  respond: Responder,
  fn: (calls: FetchCall[]) => Promise<T>,
): Promise<T> {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ??
      (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const body = parseBody(init?.body);
    calls.push({ url: url.toString(), method, body });
    return Promise.resolve(
      respond(url, method, headers.get("accept") ?? "", body),
    );
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function isGhlCall(call: FetchCall): boolean {
  return call.url.includes("/functions/v1/ghl-proxy") ||
    call.url.includes("leadconnectorhq.com");
}

// ── The refusal itself ───────────────────────────────────────────────────────

Deno.test("the chase-workflow refusal names the ruling and never reads as a login failure", () => {
  assertEquals([...RETIRED_CHASE_WORKFLOW_ACTIONS], [
    "trigger_chase_workflow",
    "stop_chase_workflow",
  ]);
  for (const action of RETIRED_CHASE_WORKFLOW_ACTIONS) {
    const refusal = chaseWorkflowRefusal(action);
    // 401 force-logs-out the Trade App; a refusal is never a login failure.
    assertEquals(refusal.status, 409);
    assertEquals(refusal.body.code, AUTOMATED_MONEY_MESSAGES_OFF_CODE);
    assertEquals(refusal.body.action, action);
    assertStringIncludes(refusal.body.error, "switched off");
  }
});

for (const action of RETIRED_CHASE_WORKFLOW_ACTIONS) {
  Deno.test(`${action} refuses through the handler and never reaches GHL`, async () => {
    const handle = await handler();
    await withEnv(
      BASE_ENV,
      () =>
        withFetchSpy(
          () => new Response("[]", { status: 200 }),
          async (calls) => {
            const res = await handle(serviceRequest(action, {
              ghl_contact_id: "ghl-contact-1",
              overdue_amount: 1234,
              invoice_number: "INV-1",
              job_number: "SWP-1",
            }));
            assertEquals(res.status, 409);
            const body = await res.json();
            assertEquals(body.code, AUTOMATED_MONEY_MESSAGES_OFF_CODE);
            assertEquals(body.action, action);
            assertEquals(calls, []);
          },
        ),
    );
  });
}

// ── handle_payment_event: bookkeeping only ───────────────────────────────────

const JOB_ID = "7a1d6c1e-0000-4000-8000-000000000001";

function paidEventResponder(url: URL, method: string, accept: string) {
  const one = accept.includes("vnd.pgrst.object");
  const row = (value: Record<string, unknown>) =>
    new Response(JSON.stringify(one ? value : [value]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const path = url.pathname;
  if (method === "GET" && path.endsWith("/rest/v1/xero_invoices")) {
    return row({
      job_id: JOB_ID,
      invoice_type: "ACCREC",
      invoice_obligation_revision_id: null,
      ses_external_token: null,
      xero_contact_id: "xero-contact-1",
    });
  }
  if (method === "GET" && path.endsWith("/rest/v1/jobs")) {
    return row({
      id: JOB_ID,
      type: "patio",
      job_number: "SWP-25001",
      metadata: {},
      ses_money_sealed_at: null,
    });
  }
  if (method === "GET" && path.endsWith("/rest/v1/contact_matches")) {
    return row({ ghl_contact_id: "ghl-contact-1", phone: "+61400000000" });
  }
  if (path.includes("/rest/v1/")) {
    return new Response(one ? "null" : "[]", {
      status: method === "POST" ? 201 : 200,
      headers: { "content-type": "application/json" },
    });
  }
  // Any GHL or other outbound call answers success, so a live send path
  // would run to completion and show up in the call log.
  return new Response(JSON.stringify({ success: true, messageId: "m-1" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("handle_payment_event sends no thank-you text and touches no GHL workflow", async () => {
  const handle = await handler();
  await withEnv(
    BASE_ENV,
    () =>
      withFetchSpy(paidEventResponder, async (calls) => {
        const res = await handle(serviceRequest("handle_payment_event", {
          xero_invoice_id: "xero-inv-1",
          xero_contact_id: "xero-contact-1",
          invoice_number: "INV-1001",
          contact_name: "Pat Client",
          amount_paid: 550,
          job_id: JOB_ID,
        }));
        const body = await res.json();
        assertEquals(res.status, 200, JSON.stringify(body));
        assertEquals(calls.filter(isGhlCall), []);
        assert(
          !body.actions.some((a: string) =>
            a.startsWith("thank_you_sms") || a === "chase_stopped"
          ),
          JSON.stringify(body.actions),
        );
        // The internal bookkeeping stays: the payment is written to the chase log.
        assert(body.actions.includes("chase_log_created"));
        assert(
          calls.some((c) =>
            c.method === "POST" && c.url.includes("/rest/v1/payment_chase_logs")
          ),
        );
      }),
  );
});

// ── send_acceptance_invoice: the email stays, the text is gone ───────────────

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PAY_URL = "https://in.xero.com/pay-now-fixture";

// A patio job accepted by a client who has both an email and a GHL contact, so
// a live SMS leg would have somewhere to send. `xeroStatus` is what Xero hands
// back for the new deposit invoice.
function acceptanceResponder(xeroStatus: string): Responder {
  const rows: Record<string, Record<string, unknown>> = {
    jobs: {
      id: JOB_ID,
      type: "patio",
      status: "accepted",
      client_name: "Pat Client",
      client_phone: "+61400000000",
      client_email: "pat@example.invalid",
      job_number: "SWP-25001",
      ghl_contact_id: "ghl-contact-1",
      xero_contact_id: "xero-contact-1",
      pricing_json: { totalIncGST: 10000, deposit: { percent: 20 } },
      site_address: "1 Test St",
      site_suburb: "Perth",
      metadata: {},
      ses_money_sealed_at: null,
    },
    xero_tokens: {
      access_token: "xero-access",
      tenant_id: "tenant-1",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    },
  };
  return (url, method, accept, body) => {
    const one = accept.includes("vnd.pgrst.object");
    const path = url.pathname;
    if (path.includes("/rest/v1/")) {
      const table = path.split("/rest/v1/")[1];
      if (method === "GET" && rows[table]) {
        return json(one ? rows[table] : [rows[table]]);
      }
      // The shared Xero cooldown writes its state and reads it back.
      if (table === "org_config" && method !== "GET") {
        const row = Array.isArray(body) ? body[0] : body as any;
        const echoed = { config_value: row?.config_value };
        return json(one ? echoed : [echoed], method === "POST" ? 201 : 200);
      }
      return json(one ? null : [], method === "POST" ? 201 : 200);
    }
    if (url.hostname === "api.xero.com") {
      if (path.endsWith("/OnlineInvoice")) {
        return json({ OnlineInvoices: [{ OnlineInvoiceUrl: PAY_URL }] });
      }
      if (path.includes("/Invoices")) {
        return json({
          Invoices: method === "GET" ? [] : [{
            InvoiceID: "xero-deposit-1",
            InvoiceNumber: "INV-9001",
            Status: xeroStatus,
            Type: "ACCREC",
            Total: 2000,
            AmountDue: 2000,
            Reference: "SWP-25001-DEP20",
            Contact: { ContactID: "xero-contact-1" },
            LineItems: [],
          }],
        });
      }
      if (path.includes("/Contacts")) {
        return json({ Contacts: [{ ContactID: "xero-contact-1" }] });
      }
      return json({ TrackingCategories: [] });
    }
    // send-quote's branded email, and any GHL call a live SMS leg would make.
    return json({ success: true, messageId: "m-1" });
  };
}

function isBrandedEmailCall(call: FetchCall): boolean {
  return call.url.includes("/functions/v1/send-quote/send-invoice");
}

Deno.test("quote acceptance emails the AUTHORISED Pay Now invoice and sends no text", async () => {
  const handle = await handler();
  await withEnv(
    BASE_ENV,
    () =>
      withFetchSpy(acceptanceResponder("AUTHORISED"), async (calls) => {
        const res = await handle(serviceRequest("send_acceptance_invoice", {
          job_id: JOB_ID,
        }));
        const body = await res.json();
        assertEquals(res.status, 200, JSON.stringify(body));
        assertEquals(body.success, true);
        assertEquals(body.branded_email_sent, true);
        assertEquals(body.sms_sent, false);
        assertEquals(body.payment_url, PAY_URL);
        // The branded email carries the payable link, once.
        const emails = calls.filter(isBrandedEmailCall);
        assertEquals(emails.length, 1);
        assertEquals((emails[0].body as any).payment_url, PAY_URL);
        assertEquals(
          (emails[0].body as any).client_email,
          "pat@example.invalid",
        );
        // No text message leaves this flow.
        assertEquals(calls.filter(isGhlCall), []);
      }),
  );
});

Deno.test("quote acceptance still sends nothing when Xero returns a DRAFT invoice", async () => {
  const handle = await handler();
  await withEnv(
    BASE_ENV,
    () =>
      withFetchSpy(acceptanceResponder("DRAFT"), async (calls) => {
        const res = await handle(serviceRequest("send_acceptance_invoice", {
          job_id: JOB_ID,
        }));
        const body = await res.json();
        assertEquals(res.status, 200, JSON.stringify(body));
        assertEquals(body.success, false);
        assertEquals(body.reason, "invoice_not_authorised");
        assertEquals(calls.filter(isBrandedEmailCall), []);
        assertEquals(calls.filter(isGhlCall), []);
        // The loud failure event for ops is still written.
        assert(
          calls.some((c) =>
            c.method === "POST" && c.url.includes("/rest/v1/job_events") &&
            (c.body as any)?.event_type ===
              "acceptance_invoice_authorise_failed"
          ),
        );
      }),
  );
});
