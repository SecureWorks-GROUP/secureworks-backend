// send-quote SEND-AUTH test suite (TRD6-R6-001 office/admin send lock).
//
// Imports the real decideSendQuoteAuth / tenant helpers so the handler and
// this suite cannot drift. /send, /send-runs, and /send-invoice require
// admin, owner, or ops_manager (OPS_API_STAFF_OPERATOR_ROLES). Trade JWTs
// are 403. API-key and service-role stay office. JWT send-invoice derives
// recipient and payment from the authorized job/invoice, never the body.
//
// Run from the worktree root:
//   deno test --allow-net --allow-env --allow-read supabase/functions/send-quote/auth_test.ts

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  decideSendQuoteAuth,
  isSendQuoteStaffOperatorRole,
  jobOrgIdFromQuoteSendDocument,
  QUOTE_SEND_OFFICE_PATHS,
  quoteSendTenantAccess,
  resolveSendInvoiceDelivery,
  SEND_QUOTE_STAFF_OPERATOR_ROLES,
} from "./quote_send_auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
};

const ENV = {
  SW_API_KEY: "master-sw-key-123",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-456",
};

const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "11111111-1111-1111-1111-111111111111";

const VALID_JWT = "valid.user.jwt";
const EXPIRED_JWT = "expired.user.jwt";
const THROW_JWT = "throw.user.jwt";

function decideSendAuth(
  req: Request,
  sb: any,
  env: Record<string, string | undefined>,
  path: string | undefined,
) {
  return decideSendQuoteAuth({
    req,
    sb,
    path,
    corsHeaders,
    swApiKey: env["SW_API_KEY"],
    serviceRoleKey: env["SUPABASE_SERVICE_ROLE_KEY"],
  });
}

function makeAuthSb(opts?: {
  role?: string | null;
  orgId?: string | null;
  profileError?: { message: string } | null;
}) {
  const role = opts && "role" in opts ? opts.role : "estimator";
  const orgId = opts && "orgId" in opts ? opts.orgId : DEFAULT_ORG;
  const profileError = opts?.profileError ?? null;
  return {
    auth: {
      getUser: (token: string) => {
        if (token === THROW_JWT) {
          throw new Error("network unreachable (simulated)");
        }
        if (token === VALID_JWT) {
          return Promise.resolve({
            data: {
              user: {
                id: "user-uuid-777",
                email: "operator@secureworksgroup.app",
              },
            },
            error: null,
          });
        }
        return Promise.resolve({
          data: { user: null },
          error: { message: "invalid JWT" },
        });
      },
    },
    from: (_table: string) => ({
      select: (_c: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: () => {
            if (profileError) {
              return Promise.resolve({ data: null, error: profileError });
            }
            if (role == null && orgId == null) {
              return Promise.resolve({ data: null, error: null });
            }
            return Promise.resolve({
              data: { role, org_id: orgId },
              error: null,
            });
          },
        }),
      }),
    }),
  };
}

function req(headers: Record<string, string>, path = "send") {
  return new Request(`https://x.test/functions/v1/send-quote/${path}`, {
    method: "POST",
    headers,
  });
}

function captureAuthLog() {
  const captured: any[] = [];
  const original = console.log;
  console.log = (...args: any[]) => {
    if (args[0] === "[send-quote] auth") {
      try {
        captured.push(JSON.parse(args[1]));
      } catch { /* ignore */ }
    }
  };
  return {
    captured,
    restore: () => {
      console.log = original;
    },
  };
}

Deno.test("staff operator roles match the ops-api office set", () => {
  assertEquals(
    [...QUOTE_SEND_OFFICE_PATHS].sort(),
    ["send", "send-invoice", "send-runs"],
  );
  assertEquals(
    [...SEND_QUOTE_STAFF_OPERATOR_ROLES].sort(),
    ["admin", "ops_manager", "owner"],
  );
  for (const role of ["admin", "owner", "ops_manager", "ADMIN", "Owner"]) {
    assertEquals(isSendQuoteStaffOperatorRole(role), true, role);
  }
  for (const role of [
    "estimator",
    "lead_installer",
    "trade",
    "allocated",
    "makesafe_open",
    "unknown",
    "",
    null,
  ]) {
    assertEquals(isSendQuoteStaffOperatorRole(role), false, String(role));
  }
});

Deno.test("A1 — valid x-api-key header → allow, mode=api_key (unchanged path)", async () => {
  const d = await decideSendAuth(
    req({ "x-api-key": ENV.SW_API_KEY }),
    makeAuthSb(),
    ENV,
    "send",
  );
  assertEquals(d.kind, "allow");
  assert(d.kind === "allow");
  assertEquals(d.mode, "api_key");
  assertEquals(d.user, null);
});

Deno.test("A2 — Bearer master SW_API_KEY → allow, mode=api_key (unchanged path)", async () => {
  const d = await decideSendAuth(
    req({ authorization: `Bearer ${ENV.SW_API_KEY}` }),
    makeAuthSb(),
    ENV,
    "send",
  );
  assert(d.kind === "allow");
  assertEquals(d.mode, "api_key");
});

Deno.test("A3 — Bearer service-role key → allow, mode=api_key (unchanged path)", async () => {
  const d = await decideSendAuth(
    req({ authorization: `Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}` }),
    makeAuthSb(),
    ENV,
    "send-invoice",
  );
  assert(d.kind === "allow");
  assertEquals(d.mode, "api_key");
});

Deno.test("A4 — estimator JWT on /send is 403, not send authority", async () => {
  const cap = captureAuthLog();
  try {
    const d = await decideSendAuth(
      req({ authorization: `Bearer ${VALID_JWT}` }),
      makeAuthSb({ role: "estimator" }),
      ENV,
      "send",
    );
    assert(d.kind === "reject");
    assertEquals(d.response.status, 403);
    const body = await d.response.json();
    assertEquals(body.error, "Quote send requires an office operator session");
    assertEquals(body.code, "operator_access_required");
    assertEquals(cap.captured.length, 1);
    assertEquals(cap.captured[0].refused, true);
    assertEquals(cap.captured[0].userRole, "estimator");
  } finally {
    cap.restore();
  }
});

Deno.test("A4-office — admin / owner / ops_manager JWT may send", async () => {
  for (const role of ["admin", "owner", "ops_manager"]) {
    for (const path of ["send", "send-invoice", "send-runs"]) {
      const cap = captureAuthLog();
      try {
        const d = await decideSendAuth(
          req({ authorization: `Bearer ${VALID_JWT}` }, path),
          makeAuthSb({ role, orgId: DEFAULT_ORG }),
          ENV,
          path,
        );
        assert(d.kind === "allow", `${role} ${path}`);
        assertEquals(d.mode, "jwt");
        assertEquals(d.user, {
          id: "user-uuid-777",
          email: "operator@secureworksgroup.app",
          role,
          orgId: DEFAULT_ORG,
        });
        assertEquals(cap.captured[0].authMode, "jwt");
        assertEquals(cap.captured[0].userRole, role);
        assertEquals(cap.captured[0].refused, false);
      } finally {
        cap.restore();
      }
    }
  }
});

Deno.test("A4b — missing users-row profile on /send is 403, not unknown send", async () => {
  const d = await decideSendAuth(
    req({ authorization: `Bearer ${VALID_JWT}` }),
    makeAuthSb({ role: null, orgId: null }),
    ENV,
    "send",
  );
  assert(d.kind === "reject");
  assertEquals(d.response.status, 403);
  assertEquals((await d.response.json()).code, "operator_access_required");
});

Deno.test("A4c — trade / allocated / makesafe_open / lead_installer JWTs cannot send", async () => {
  for (const role of ["trade", "allocated", "makesafe_open", "lead_installer"]) {
    const send = await decideSendAuth(
      req({ authorization: `Bearer ${VALID_JWT}` }),
      makeAuthSb({ role }),
      ENV,
      "send",
    );
    assert(send.kind === "reject", role);
    assertEquals(send.response.status, 403);
    const runs = await decideSendAuth(
      req({ authorization: `Bearer ${VALID_JWT}` }, "send-runs"),
      makeAuthSb({ role }),
      ENV,
      "send-runs",
    );
    assert(runs.kind === "reject", `${role} send-runs`);
    assertEquals(runs.response.status, 403);
    const invoice = await decideSendAuth(
      req({ authorization: `Bearer ${VALID_JWT}` }, "send-invoice"),
      makeAuthSb({ role }),
      ENV,
      "send-invoice",
    );
    assert(invoice.kind === "reject", `${role} send-invoice`);
    assertEquals(invoice.response.status, 403);
  }
});

Deno.test("A4d — send-invoice rejects estimator JWT and accepts office JWT", async () => {
  const estimator = await decideSendAuth(
    req({ authorization: `Bearer ${VALID_JWT}` }, "send-invoice"),
    makeAuthSb({ role: "estimator" }),
    ENV,
    "send-invoice",
  );
  assert(estimator.kind === "reject");
  assertEquals(estimator.response.status, 403);
  assertEquals((await estimator.response.json()).code, "operator_access_required");

  const admin = await decideSendAuth(
    req({ authorization: `Bearer ${VALID_JWT}` }, "send-invoice"),
    makeAuthSb({ role: "admin", orgId: DEFAULT_ORG }),
    ENV,
    "send-invoice",
  );
  assert(admin.kind === "allow");
  assertEquals(admin.mode, "jwt");
  assertEquals(admin.user?.role, "admin");
});

Deno.test("A4e — unreadable users profile on /send is 503, not send authority", async () => {
  const d = await decideSendAuth(
    req({ authorization: `Bearer ${VALID_JWT}` }),
    makeAuthSb({ profileError: { message: "timeout" } }),
    ENV,
    "send",
  );
  assert(d.kind === "reject");
  assertEquals(d.response.status, 503);
  assertEquals((await d.response.json()).code, "operator_profile_unreadable");
});

Deno.test("A5 — expired/forged JWT → 401 'Session expired — please log in again'", async () => {
  const d = await decideSendAuth(
    req({ authorization: `Bearer ${EXPIRED_JWT}` }),
    makeAuthSb(),
    ENV,
    "send",
  );
  assert(d.kind === "reject");
  assertEquals(d.response.status, 401);
  assertEquals(
    (await d.response.json()).error,
    "Session expired — please log in again",
  );
});

Deno.test("A6 — getUser throws (transport failure) → 401 'Authentication failed'", async () => {
  const d = await decideSendAuth(
    req({ authorization: `Bearer ${THROW_JWT}` }),
    makeAuthSb(),
    ENV,
    "send",
  );
  assert(d.kind === "reject");
  assertEquals(d.response.status, 401);
  assertEquals((await d.response.json()).error, "Authentication failed");
});

Deno.test("A7 — no x-api-key and no bearer → 401 'Unauthorized'", async () => {
  const d = await decideSendAuth(req({}), makeAuthSb(), ENV, "send-runs");
  assert(d.kind === "reject");
  assertEquals(d.response.status, 401);
  assertEquals((await d.response.json()).error, "Unauthorized");
});

Deno.test("A8 — wrong x-api-key, no bearer → 401 'Unauthorized'", async () => {
  const d = await decideSendAuth(
    req({ "x-api-key": "not-the-key" }),
    makeAuthSb(),
    ENV,
    "send",
  );
  assert(d.kind === "reject");
  assertEquals(d.response.status, 401);
  assertEquals((await d.response.json()).error, "Unauthorized");
});

Deno.test("A9 — public 'view' path bypasses send-auth entirely (no credentials needed)", async () => {
  const d = await decideSendAuth(req({}, "view"), makeAuthSb(), ENV, "view");
  assert(d.kind === "allow");
});

Deno.test("A10 — send / send-runs / send-invoice reject non-office JWT", async () => {
  for (const p of ["send", "send-invoice", "send-runs"]) {
    const anon = await decideSendAuth(req({}, p), makeAuthSb(), ENV, p);
    assert(anon.kind === "reject", `${p} must reject anon`);
    assertEquals(anon.response.status, 401);
  }
  const estimatorSend = await decideSendAuth(
    req({ authorization: `Bearer ${VALID_JWT}` }),
    makeAuthSb({ role: "estimator" }),
    ENV,
    "send",
  );
  assert(estimatorSend.kind === "reject");
  assertEquals(estimatorSend.response.status, 403);

  const estimatorRuns = await decideSendAuth(
    req({ authorization: `Bearer ${VALID_JWT}` }, "send-runs"),
    makeAuthSb({ role: "estimator" }),
    ENV,
    "send-runs",
  );
  assert(estimatorRuns.kind === "reject");
  assertEquals(estimatorRuns.response.status, 403);

  const invoice = await decideSendAuth(
    req({ authorization: `Bearer ${VALID_JWT}` }, "send-invoice"),
    makeAuthSb({ role: "estimator" }),
    ENV,
    "send-invoice",
  );
  assert(invoice.kind === "reject");
  assertEquals(invoice.response.status, 403);

  const adminRuns = await decideSendAuth(
    req({ authorization: `Bearer ${VALID_JWT}` }, "send-runs"),
    makeAuthSb({ role: "admin", orgId: DEFAULT_ORG }),
    ENV,
    "send-runs",
  );
  assert(adminRuns.kind === "allow");
  assertEquals(adminRuns.mode, "jwt");

  const adminInvoice = await decideSendAuth(
    req({ authorization: `Bearer ${VALID_JWT}` }, "send-invoice"),
    makeAuthSb({ role: "admin", orgId: DEFAULT_ORG }),
    ENV,
    "send-invoice",
  );
  assert(adminInvoice.kind === "allow");
  assertEquals(adminInvoice.mode, "jwt");
});

Deno.test("T1 — JWT office caller may send only a same-org job", () => {
  assertEquals(
    quoteSendTenantAccess("jwt", DEFAULT_ORG, DEFAULT_ORG),
    { ok: true },
  );
});

Deno.test("T2 — JWT office caller cannot send another tenant's job", () => {
  const d = quoteSendTenantAccess("jwt", DEFAULT_ORG, OTHER_ORG);
  assertEquals(d.ok, false);
  if (!d.ok) {
    assertEquals(d.status, 403);
    assertEquals(d.code, "operator_access_required");
  }
});

Deno.test("T3 — missing caller or job org fails closed for JWT", () => {
  for (const [caller, job] of [
    [null, DEFAULT_ORG],
    [DEFAULT_ORG, null],
    ["", DEFAULT_ORG],
    [DEFAULT_ORG, ""],
    [null, null],
  ] as const) {
    const d = quoteSendTenantAccess("jwt", caller, job);
    assertEquals(d.ok, false, `${caller} vs ${job}`);
  }
});

Deno.test("T4 — api_key skips tenant compare (ops dashboard)", () => {
  assertEquals(quoteSendTenantAccess("api_key", null, OTHER_ORG).ok, true);
  assertEquals(quoteSendTenantAccess("api_key", DEFAULT_ORG, OTHER_ORG).ok, true);
});

Deno.test("T5 — nested jobs.org_id is read from the send document join", () => {
  assertEquals(
    jobOrgIdFromQuoteSendDocument({ jobs: { org_id: DEFAULT_ORG } }),
    DEFAULT_ORG,
  );
  assertEquals(
    jobOrgIdFromQuoteSendDocument({ jobs: [{ org_id: DEFAULT_ORG }] }),
    DEFAULT_ORG,
  );
  assertEquals(jobOrgIdFromQuoteSendDocument({ jobs: null }), undefined);
  assertEquals(jobOrgIdFromQuoteSendDocument(null), undefined);
});

Deno.test("I1 — JWT send-invoice ignores body recipient and payment fields", () => {
  const d = resolveSendInvoiceDelivery({
    authMode: "jwt",
    body: {
      client_email: "attacker@evil.test",
      client_name: "Attacker",
      payment_url: "https://evil.test/pay",
      invoice_number: "FAKE-1",
      deposit_amount: 1,
      job_type: "fencing",
      address: "1 Attack St",
      share_token: "stolen-token",
      due_date: "yesterday",
    },
    job: {
      client_email: "pat@example.test",
      client_name: "Pat Client",
      type: "patio",
      site_address: "12 Fence St",
      site_suburb: "Midland",
    },
    invoice: {
      invoice_number: "INV-1001",
      total: 1650,
      due_date: "2026-09-20",
    },
  });
  assertEquals(d.client_email, "pat@example.test");
  assertEquals(d.client_name, "Pat Client");
  assertEquals(d.job_type, "patio");
  assertEquals(d.address, "12 Fence St, Midland");
  assertEquals(d.invoice_number, "INV-1001");
  assertEquals(d.deposit_amount, 1650);
  assertEquals(d.payment_url, "");
  assertEquals(d.share_token, "");
  assertEquals(d.due_date, "2026-09-20");
});

Deno.test("I2 — api_key send-invoice may use office-derived body fields", () => {
  const d = resolveSendInvoiceDelivery({
    authMode: "api_key",
    body: {
      client_email: "override@example.test",
      client_name: "Override",
      payment_url: "https://in.xero.com/pay",
      invoice_number: "INV-9",
      deposit_amount: 500,
      share_token: "tok-1",
    },
    job: {
      client_email: "pat@example.test",
      client_name: "Pat Client",
      type: "fencing",
      site_address: "12 Fence St",
      site_suburb: "Midland",
    },
    invoice: { invoice_number: "INV-1001", total: 1650, due_date: "2026-09-20" },
  });
  assertEquals(d.client_email, "override@example.test");
  assertEquals(d.payment_url, "https://in.xero.com/pay");
  assertEquals(d.deposit_amount, 500);
  assertEquals(d.share_token, "tok-1");
  assertEquals(d.invoice_number, "INV-9");
});
