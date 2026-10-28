// deno-lint-ignore-file no-explicit-any no-import-prefix
// The ops-api customer texts that post to ghl-proxy send_sms with a GHL contact
// id must carry ops-api's service login, and a refused send must say why.
// ghl-proxy refuses every request with no login (401 missing_auth); these
// texts sent none, so the calendar reschedule text, the trade app's
// job-complete text, the payment link, the booking-confirmation text and
// council texts all failed silently. The fake below refuses a request with no
// login exactly as ghl-proxy does, so a caller that drops it fails here.
// Every send goes to a stubbed globalThis.fetch: nothing reaches a live channel.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ghlProxySendSmsFailureReason,
  postGhlProxySendSms,
} from "./ghl_proxy_send_sms.ts";
import { _confirmAssignmentForTest, _sendCouncilSMSForTest } from "./index.ts";

const SERVICE_BEARER = `Bearer ${
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
}`;

type Call = { url: string; init?: any };
type Answer = { status: number; body: any } | Error;

function hasServiceLogin(init?: any, bearer = SERVICE_BEARER): boolean {
  const raw = init?.headers?.Authorization ?? init?.headers?.authorization;
  return typeof raw === "string" && raw === bearer;
}

function fakeGhlProxy(answer: Answer, bearer = SERVICE_BEARER) {
  const calls: Call[] = [];
  const fetchFn = ((input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (url.includes("ghl-proxy") && !hasServiceLogin(init, bearer)) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: "Authentication required",
            code: "missing_auth",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return { calls, fetchFn };
}

function withGlobalFetch(fetchFn: typeof fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchFn;
  return () => {
    globalThis.fetch = original;
  };
}

const smsCalls = (calls: Call[]) =>
  calls.filter((c) => c.url.includes("ghl-proxy?action=send_sms"));

const SENT: Answer = { status: 200, body: { success: true, messageId: "m1" } };
const GHL_REFUSED: Answer = {
  status: 200,
  body: { success: false, error: "GHL API error" },
};

// ── The shared request ─────────────────────────────────────────────────────

Deno.test("postGhlProxySendSms sends the service-role bearer and the payload", async () => {
  const { calls, fetchFn } = fakeGhlProxy(SENT, "Bearer svc-key");
  const res = await postGhlProxySendSms({
    supabaseUrl: "https://example.supabase.co",
    serviceKey: "svc-key",
    payload: { contactId: "ghl-1", message: "hi" },
    fetchFn,
  });
  assertEquals(res.sent, true);
  assertEquals(res.reason, null);
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    "https://example.supabase.co/functions/v1/ghl-proxy?action=send_sms",
  );
  assertEquals(calls[0].init.method, "POST");
  assertEquals(calls[0].init.headers.Authorization, "Bearer svc-key");
  assertEquals(JSON.parse(calls[0].init.body), {
    contactId: "ghl-1",
    message: "hi",
  });
});

Deno.test("postGhlProxySendSms: a refused login is not sent and names the refusal", async () => {
  const { fetchFn } = fakeGhlProxy(SENT, "Bearer the-real-key");
  const res = await postGhlProxySendSms({
    supabaseUrl: "https://example.supabase.co",
    serviceKey: "wrong-key",
    payload: { contactId: "ghl-1", message: "hi" },
    fetchFn,
  });
  assertEquals(res.sent, false);
  assertEquals(res.status, 401);
  assertEquals(res.reason, "Authentication required (HTTP 401)");
});

Deno.test("postGhlProxySendSms: an in-band GHL failure (HTTP 200 success:false) is not sent", async () => {
  const { fetchFn } = fakeGhlProxy(GHL_REFUSED, "Bearer k");
  const res = await postGhlProxySendSms({
    supabaseUrl: "https://x",
    serviceKey: "k",
    payload: { contactId: "c", message: "m" },
    fetchFn,
  });
  assertEquals(res.sent, false);
  assertEquals(res.reason, "GHL API error");
});

Deno.test("ghlProxySendSmsFailureReason falls back to the HTTP status", () => {
  assertEquals(ghlProxySendSmsFailureReason(502, null), "HTTP 502");
  assertEquals(
    ghlProxySendSmsFailureReason(409, { code: "contact_job_mismatch" }),
    "contact_job_mismatch (HTTP 409)",
  );
  assertEquals(
    ghlProxySendSmsFailureReason(200, {}),
    "Text not accepted by GHL",
  );
});

// ── Booking confirmation (confirm_assignment / bulk_confirm) ───────────────

function confirmClient() {
  const updates: Array<{ table: string; row: any }> = [];
  function builder(table: string) {
    let op = "select";
    const b: any = {
      select: () => b,
      insert: () => {
        op = "insert";
        return b;
      },
      update: (row: any) => {
        op = "update";
        updates.push({ table, row });
        return b;
      },
      upsert: () => b,
      eq: () => b,
      in: () => b,
      single: () =>
        Promise.resolve({
          data: table === "job_assignments" && op === "update"
            ? {
              id: "a-1",
              job_id: "job-1",
              scheduled_date: "2026-11-07",
              assignment_type: "install",
              crew_name: "Hugo",
              jobs: {
                id: "job-1",
                client_name: "Jane Citizen",
                client_phone: "+61400000000",
                ghl_contact_id: "ghl-abc",
                job_number: "SWF-100",
                site_address: "12 Example St, Padbury",
              },
            }
            : null,
          error: null,
        }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (res: any, rej: any) =>
        Promise.resolve({ data: null, error: null }).then(res, rej),
    };
    return b;
  }
  return {
    updates,
    client: {
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ data: null, error: null }),
    },
  };
}

Deno.test("booking confirmation: the client text carries the service login and is recorded as notified", async () => {
  const { calls, fetchFn } = fakeGhlProxy(SENT);
  const restore = withGlobalFetch(fetchFn);
  try {
    const { client, updates } = confirmClient();
    const res: any = await _confirmAssignmentForTest(client, {
      assignment_id: "a-1",
      notify_client: true,
    });
    assertEquals(res.client_notified, true);
    assertEquals(res.client_notify_error, undefined);
    const sms = smsCalls(calls);
    assertEquals(sms.length, 1);
    assertEquals(sms[0].init.headers.Authorization, SERVICE_BEARER);
    assertEquals(JSON.parse(sms[0].init.body).contactId, "ghl-abc");
    assert(
      updates.some((u) =>
        u.table === "job_assignments" && "client_notified_at" in u.row
      ),
    );
  } finally {
    restore();
  }
});

Deno.test("booking confirmation: a refused text still confirms and returns the reason", async () => {
  const { fetchFn } = fakeGhlProxy(GHL_REFUSED);
  const restore = withGlobalFetch(fetchFn);
  try {
    const { client, updates } = confirmClient();
    const res: any = await _confirmAssignmentForTest(client, {
      assignment_id: "a-1",
      notify_client: true,
    });
    assertEquals(res.success, true);
    assertEquals(res.client_notified, false);
    assertEquals(res.client_notify_error, "GHL API error");
    assert(!updates.some((u) => "client_notified_at" in u.row));
  } finally {
    restore();
  }
});

Deno.test("booking confirmation: no text is sent unless notify_client is asked", async () => {
  const { calls, fetchFn } = fakeGhlProxy(SENT);
  const restore = withGlobalFetch(fetchFn);
  try {
    const { client } = confirmClient();
    const res: any = await _confirmAssignmentForTest(client, {
      assignment_id: "a-1",
    });
    assertEquals(res.client_notified, false);
    assertEquals(smsCalls(calls).length, 0);
  } finally {
    restore();
  }
});

// ── Council text (send_council_sms) ────────────────────────────────────────

function councilClient() {
  const job = {
    id: "job-1",
    type: "patio",
    job_number: "SWP-100",
    client_name: "Jane Citizen",
    client_phone: "+61400000000",
    ghl_contact_id: "ghl-abc",
    metadata: {},
  };
  const inserts: Array<{ table: string; row: any }> = [];
  function builder(table: string) {
    const b: any = {
      select: () => b,
      insert: (row: any) => {
        inserts.push({ table, row });
        return b;
      },
      eq: () => b,
      in: () => b,
      single: () =>
        Promise.resolve({ data: table === "jobs" ? job : null, error: null }),
      maybeSingle: () =>
        Promise.resolve({ data: table === "jobs" ? job : null, error: null }),
      then: (res: any, rej: any) =>
        Promise.resolve({
          data: table === "jobs" ? [job] : null,
          error: null,
        }).then(res, rej),
    };
    return b;
  }
  return { inserts, client: { from: (t: string) => builder(t) } };
}

Deno.test("council text: carries the service login and records council_sms_sent", async () => {
  const { calls, fetchFn } = fakeGhlProxy(SENT);
  const restore = withGlobalFetch(fetchFn);
  try {
    const { client, inserts } = councilClient();
    const res = await _sendCouncilSMSForTest(client, {
      job_id: "job-1",
      message: "Your council approval has come through.",
    });
    assertEquals(res, { success: true, sms_sent: true });
    const sms = smsCalls(calls);
    assertEquals(sms.length, 1);
    assertEquals(sms[0].init.headers.Authorization, SERVICE_BEARER);
    assertEquals(JSON.parse(sms[0].init.body), {
      contactId: "ghl-abc",
      message: "Your council approval has come through.",
    });
    assert(inserts.some((i) => i.row.event_type === "council_sms_sent"));
  } finally {
    restore();
  }
});

Deno.test("council text: a refused send throws with ghl-proxy's reason and records nothing as sent", async () => {
  const { fetchFn } = fakeGhlProxy(GHL_REFUSED);
  const restore = withGlobalFetch(fetchFn);
  try {
    const { client, inserts } = councilClient();
    await assertRejects(
      () =>
        _sendCouncilSMSForTest(client, { job_id: "job-1", message: "Hello" }),
      Error,
      "SMS send failed: GHL API error",
    );
    assert(!inserts.some((i) => i.row.event_type === "council_sms_sent"));
  } finally {
    restore();
  }
});

// ── Payment link (send_payment_link) ───────────────────────────────────────
// Its live path reads Xero (token store, cooldown client, OnlineInvoice) before
// it texts, which this suite cannot stand up without a live database, so the
// send itself is pinned at source: it posts through the shared request above
// (proved to carry the login) and reports the refusal reason it returns.

Deno.test("payment link: texts through the shared logged-in request and reports why a text failed", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const start = source.indexOf("async function sendPaymentLink(");
  const end = source.indexOf("\n}\n", start);
  assert(start > 0 && end > start);
  const body = source.slice(start, end);
  assertStringIncludes(body, "postGhlProxySendSms({");
  assertStringIncludes(body, "serviceKey: SUPABASE_SERVICE_KEY");
  assertStringIncludes(body, "sms_sent: sms.sent");
  assertStringIncludes(body, "sms_error: sms.reason");
  assertEquals(body.includes("ghl-proxy?action=send_sms"), false);
});

// None of the four texts may post to ghl-proxy send_sms without the login.
Deno.test("the four customer texts no longer post to ghl-proxy send_sms by hand", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  for (
    const fn of [
      "export async function sendClientUpdate(",
      "async function sendPaymentLink(",
      "async function confirmAssignment(",
      "async function sendCouncilSMS(",
    ]
  ) {
    const start = source.indexOf(fn);
    const end = source.indexOf("\n}\n", start);
    assert(start >= 0 && end > start, fn);
    const body = source.slice(start, end);
    assertStringIncludes(body, "postGhlProxySendSms({", fn);
    assertEquals(body.includes("ghl-proxy?action=send_sms"), false, fn);
  }
});
