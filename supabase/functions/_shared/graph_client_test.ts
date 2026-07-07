// Graph token resilience (intake item 12, 2026-07-07 incident: "Lifetime validation
// failed, the token is expired"). Reproduces the failure mode with a stubbed Graph 401
// and proves: proactive skew-adjusted expiry, forceRefresh, and graphFetch's
// force-refresh-once-on-401 retry.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resetGraphTokenCache,
  getGraphToken,
  graphFetch,
  isGraphTokenExpiredResponse,
} from "./graph_client.ts";

// ── env + fetch stubs ──────────────────────────────────────────────
const realFetch = globalThis.fetch;
const realEnvGet = Deno.env.get;

function stubEnv(): void {
  (Deno.env as any).get = (k: string) =>
    ({
      MICROSOFT_TENANT_ID: "tenant",
      MICROSOFT_CLIENT_ID: "client",
      MICROSOFT_CLIENT_SECRET: "secret",
    } as Record<string, string>)[k];
}
function restore(): void {
  globalThis.fetch = realFetch;
  (Deno.env as any).get = realEnvGet;
  _resetGraphTokenCache();
}

function tokenResponse(token: string, expiresIn: number): Response {
  return new Response(
    JSON.stringify({ access_token: token, expires_in: expiresIn }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const TOKEN_URL = "login.microsoftonline.com";
const isTokenUrl = (u: string) => u.includes(TOKEN_URL);

// ── isGraphTokenExpiredResponse ────────────────────────────────────
Deno.test("isGraphTokenExpiredResponse: the live 2026-07-07 body is recognised", () => {
  assert(isGraphTokenExpiredResponse(
    401,
    "Lifetime validation failed, the token is expired.",
  ));
  assert(isGraphTokenExpiredResponse(401, "InvalidAuthenticationToken"));
  // Empty 401 body still triggers a (cheap, idempotent) refresh.
  assert(isGraphTokenExpiredResponse(401, ""));
  assert(isGraphTokenExpiredResponse(401, null));
});

Deno.test("isGraphTokenExpiredResponse: non-401 and unrelated 401 are NOT expiry", () => {
  assertEquals(isGraphTokenExpiredResponse(429, "throttled"), false);
  assertEquals(isGraphTokenExpiredResponse(500, "boom"), false);
  assertEquals(
    isGraphTokenExpiredResponse(401, "insufficient scope for this request"),
    false,
  );
});

// ── getGraphToken caching + forceRefresh ───────────────────────────
Deno.test("getGraphToken: caches within lifetime, forceRefresh re-acquires", async () => {
  stubEnv();
  let mints = 0;
  globalThis.fetch = ((u: string) => {
    if (isTokenUrl(u)) {
      mints++;
      return Promise.resolve(tokenResponse(`tok-${mints}`, 3600));
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  try {
    const a = await getGraphToken();
    const b = await getGraphToken(); // cached — no new mint
    assertEquals(a, "tok-1");
    assertEquals(b, "tok-1");
    assertEquals(mints, 1);

    const c = await getGraphToken({ forceRefresh: true }); // bypass cache
    assertEquals(c, "tok-2");
    assertEquals(mints, 2);
  } finally {
    restore();
  }
});

Deno.test("getGraphToken: a token whose skew-adjusted life is exhausted is re-minted", async () => {
  stubEnv();
  let mints = 0;
  globalThis.fetch = ((u: string) => {
    if (isTokenUrl(u)) {
      mints++;
      // expires_in far below EXPIRY_BUFFER_MS + CLOCK_SKEW_MS (=360s) → usable
      // window is 0, so the next call cannot reuse it.
      return Promise.resolve(tokenResponse(`tok-${mints}`, 60));
    }
    throw new Error(`unexpected fetch ${u}`);
  }) as typeof fetch;
  try {
    const a = await getGraphToken();
    const b = await getGraphToken(); // skew margin already consumed → re-mint
    assertEquals(a, "tok-1");
    assertEquals(b, "tok-2");
    assertEquals(mints, 2);
  } finally {
    restore();
  }
});

// ── graphFetch: the reactive 401 recovery (the incident fix) ───────
Deno.test("graphFetch: 401 expired-token → force-refresh once → retry succeeds", async () => {
  stubEnv();
  const calls: Array<{ url: string; auth: string | null }> = [];
  let refreshed = 0;
  globalThis.fetch = ((u: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>)?.Authorization ??
      null;
    calls.push({ url: u, auth });
    // First request with the stale token → the live expired-token 401.
    if (auth === "Bearer stale") {
      return Promise.resolve(
        new Response("Lifetime validation failed, the token is expired.", {
          status: 401,
        }),
      );
    }
    // After refresh the retry carries the fresh token → 200.
    if (auth === "Bearer fresh") {
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    throw new Error(`unexpected auth ${auth}`);
  }) as typeof fetch;
  try {
    const resp = await graphFetch(
      "https://graph.microsoft.com/v1.0/me",
      "stale",
      {
        refresh: () => {
          refreshed++;
          return Promise.resolve("fresh");
        },
      },
    );
    assertEquals(resp.status, 200);
    assertEquals(refreshed, 1);
    // Exactly two requests: the failed one, then the retried one.
    assertEquals(calls.length, 2);
    assertEquals(calls[0].auth, "Bearer stale");
    assertEquals(calls[1].auth, "Bearer fresh");
  } finally {
    restore();
  }
});

Deno.test("graphFetch: a revoked app (401 twice) surfaces the retried 401, no spin", async () => {
  stubEnv();
  let requests = 0;
  globalThis.fetch = (() => {
    requests++;
    return Promise.resolve(
      new Response("Lifetime validation failed, the token is expired.", {
        status: 401,
      }),
    );
  }) as typeof fetch;
  try {
    const resp = await graphFetch("https://graph.microsoft.com/v1.0/me", "t", {
      refresh: () => Promise.resolve("t2"),
    });
    assertEquals(resp.status, 401); // still 401, but only ONE retry
    assertEquals(requests, 2);
  } finally {
    restore();
  }
});

Deno.test("graphFetch: an unrelated 401 is returned as-is (no refresh, no retry)", async () => {
  stubEnv();
  let requests = 0;
  let refreshed = 0;
  globalThis.fetch = (() => {
    requests++;
    return Promise.resolve(
      new Response("insufficient scope for this request", { status: 401 }),
    );
  }) as typeof fetch;
  try {
    const resp = await graphFetch("https://graph.microsoft.com/v1.0/me", "t", {
      refresh: () => {
        refreshed++;
        return Promise.resolve("t2");
      },
    });
    assertEquals(resp.status, 401);
    assertEquals(requests, 1); // no retry
    assertEquals(refreshed, 0); // refresh never called
    // Body still readable by the caller (we only peeked a clone).
    assertEquals(await resp.text(), "insufficient scope for this request");
  } finally {
    restore();
  }
});

Deno.test("graphFetch: happy path is a single fetch, unchanged (no refresh needed)", async () => {
  stubEnv();
  let requests = 0;
  globalThis.fetch = ((_u: string, init?: RequestInit) => {
    requests++;
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    assertEquals(auth, "Bearer good");
    return Promise.resolve(new Response('{"value":[]}', { status: 200 }));
  }) as typeof fetch;
  try {
    const resp = await graphFetch(
      "https://graph.microsoft.com/v1.0/groups",
      "good",
      {
        refresh: () => Promise.reject(new Error("refresh must not be called")),
      },
    );
    assertEquals(resp.status, 200);
    assertEquals(requests, 1);
  } finally {
    restore();
  }
});
