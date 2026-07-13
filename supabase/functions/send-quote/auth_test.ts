// send-quote SEND-AUTH test suite (H2 hotfix: user JWTs accepted alongside shared key).
//
// LOCAL-ONLY, same convention as index_test.ts: the auth decision lives inline in
// the serve() HTTP handler in index.ts (importing index.ts would boot the prod
// server via serve(...) at module load). We therefore copy the decision block
// verbatim below into `decideSendAuth`, preserving every branch, header name,
// comparison, status code and error string from index.ts:614-681. Any drift is
// caught at PR review via grep diff.
//
// Run from the worktree root:
//   deno test --allow-net --allow-env supabase/functions/send-quote/auth_test.ts

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
};

type AuthDecision =
  | {
    kind: "allow";
    mode: "api_key" | "jwt";
    user: { id: string; email: string; role: string } | null;
  }
  | { kind: "reject"; response: Response };

// ── EXACT COPY of the send-auth block from index.ts:614-681 ───────────────────
// `env` stands in for Deno.env.get(...) and `sb` for the service-role client.
async function decideSendAuth(
  req: Request,
  sb: any,
  env: Record<string, string | undefined>,
  path: string | undefined,
): Promise<AuthDecision> {
  let sendAuthMode: "api_key" | "jwt" = "api_key";
  let sendAuthUser: { id: string; email: string; role: string } | null = null;
  if (path === "send" || path === "send-invoice" || path === "send-runs") {
    const validKey = env["SW_API_KEY"];
    const serviceKey = env["SUPABASE_SERVICE_ROLE_KEY"];
    const xApiKey = req.headers.get("x-api-key");
    const authHeader = req.headers.get("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (xApiKey && (xApiKey === validKey || xApiKey === serviceKey)) {
      sendAuthMode = "api_key"; // server-to-server via x-api-key header (unchanged)
    } else if (
      bearerToken && (bearerToken === validKey || bearerToken === serviceKey)
    ) {
      sendAuthMode = "api_key"; // server-to-server via Authorization header (unchanged)
    } else if (bearerToken) {
      // Verify as a Supabase user JWT (browser request from a scoping tool).
      try {
        const { data: { user }, error } = await sb.auth.getUser(bearerToken);
        if (error || !user) {
          return {
            kind: "reject",
            response: new Response(
              JSON.stringify({
                error: "Session expired — please log in again",
              }),
              {
                status: 401,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              },
            ),
          };
        }
        const { data: profile } = await sb.from("users")
          .select("role")
          .eq("id", user.id)
          .maybeSingle();
        sendAuthMode = "jwt";
        sendAuthUser = {
          id: user.id,
          email: user.email || "",
          role: profile?.role || "unknown",
        };
      } catch (_e) {
        return {
          kind: "reject",
          response: new Response(
            JSON.stringify({ error: "Authentication failed" }),
            {
              status: 401,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          ),
        };
      }
    } else {
      return {
        kind: "reject",
        response: new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }),
      };
    }

    // Attribution ledger: who sent what, under which auth mode.
    console.log(
      "[send-quote] auth",
      JSON.stringify({
        path,
        authMode: sendAuthMode,
        userId: sendAuthUser?.id ?? null,
        userEmail: sendAuthUser?.email ?? null,
        userRole: sendAuthUser?.role ?? null,
      }),
    );
  }
  return { kind: "allow", mode: sendAuthMode, user: sendAuthUser };
}
// ── END EXACT COPY ──

const ENV = {
  SW_API_KEY: "master-sw-key-123",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-456",
};

// Mock service-role client. getUser validates the bearer against a fixture
// "signing key": only VALID_JWT resolves to a user; EXPIRED_JWT returns an error
// (mirrors Supabase returning {error} for a forged/expired token); THROW_JWT makes
// getUser throw (network/transport failure).
const VALID_JWT = "valid.user.jwt";
const EXPIRED_JWT = "expired.user.jwt";
const THROW_JWT = "throw.user.jwt";

function makeAuthSb() {
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
                email: "estimator@secureworksgroup.app",
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
          maybeSingle: () =>
            Promise.resolve({ data: { role: "estimator" }, error: null }),
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

// Log capture for the attribution-ledger assertion.
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

// ── A1: valid x-api-key → allowed, api_key mode (historical server-to-server, unchanged) ──
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

// ── A2: Authorization: Bearer <master key> → allowed, api_key mode (unchanged) ──
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

// ── A3: Authorization: Bearer <service-role key> → allowed, api_key mode (unchanged) ──
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

// ── A4: THE FIX — logged-in Supabase user JWT bearer → allowed, mode=jwt, user captured ──
Deno.test("A4 — valid user JWT bearer (scoping tool login) → allow, mode=jwt, user+role captured", async () => {
  const cap = captureAuthLog();
  try {
    const d = await decideSendAuth(
      req({ authorization: `Bearer ${VALID_JWT}` }),
      makeAuthSb(),
      ENV,
      "send",
    );
    assert(d.kind === "allow");
    assertEquals(d.mode, "jwt");
    assertEquals(d.user, {
      id: "user-uuid-777",
      email: "estimator@secureworksgroup.app",
      role: "estimator",
    });
    // Attribution ledger records the caller under jwt mode.
    assertEquals(cap.captured.length, 1);
    assertEquals(cap.captured[0].authMode, "jwt");
    assertEquals(cap.captured[0].userId, "user-uuid-777");
    assertEquals(cap.captured[0].userRole, "estimator");
  } finally {
    cap.restore();
  }
});

// ── A4b: any authenticated user is allowed regardless of role (R1: no admin/owner gate) ──
Deno.test("A4b — valid JWT with no users-row profile → allowed, role defaults to 'unknown' (not gated)", async () => {
  const sb = makeAuthSb();
  sb.from = (_t: string) =>
    ({
      select: (_c: string) => ({
        eq: (_col: string, _v: string) => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    }) as any;
  const d = await decideSendAuth(
    req({ authorization: `Bearer ${VALID_JWT}` }),
    sb,
    ENV,
    "send",
  );
  assert(d.kind === "allow");
  assertEquals(d.mode, "jwt");
  assertEquals(d.user?.role, "unknown");
});

// ── A5: expired/forged JWT (getUser returns error) → 401 "Session expired" ──
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

// ── A6: getUser transport failure (throws) → 401 "Authentication failed" ──
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

// ── A7: no credentials at all → 401 "Unauthorized" ──
Deno.test("A7 — no x-api-key and no bearer → 401 'Unauthorized'", async () => {
  const d = await decideSendAuth(req({}), makeAuthSb(), ENV, "send-runs");
  assert(d.kind === "reject");
  assertEquals(d.response.status, 401);
  assertEquals((await d.response.json()).error, "Unauthorized");
});

// ── A8: wrong x-api-key with no bearer → 401 (bad key is not a JWT bearer) ──
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

// ── A9: public path (view) is NOT auth-gated → allowed with default mode, no getUser call ──
Deno.test("A9 — public 'view' path bypasses send-auth entirely (no credentials needed)", async () => {
  const d = await decideSendAuth(req({}, "view"), makeAuthSb(), ENV, "view");
  assert(d.kind === "allow");
});

// ── A10: all three guarded paths enforce auth identically ──
Deno.test("A10 — send / send-invoice / send-runs all reject anon and accept a user JWT", async () => {
  for (const p of ["send", "send-invoice", "send-runs"]) {
    const anon = await decideSendAuth(req({}, p), makeAuthSb(), ENV, p);
    assert(anon.kind === "reject", `${p} must reject anon`);
    assertEquals(anon.response.status, 401);
    const jwt = await decideSendAuth(
      req({ authorization: `Bearer ${VALID_JWT}` }, p),
      makeAuthSb(),
      ENV,
      p,
    );
    assert(jwt.kind === "allow", `${p} must accept a valid user JWT`);
    assertEquals(jwt.mode, "jwt");
  }
});
