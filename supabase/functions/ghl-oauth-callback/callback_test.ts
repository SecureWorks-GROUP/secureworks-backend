// GHL Marketplace app install callback, driven through the real handler with
// a stubbed fetch and an in-memory receipt sink. No network, no credentials.
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CallbackDeps,
  GHL_TOKEN_URL,
  handleGhlOAuthCallback,
  type InstallReceipt,
} from "./handler.ts";

const LOCATION = "13yKADzN94BRxX4hByYX";
const COMPANY = "cmpTEST123";
const CODE = "auth-code-SECRET-abc123";
const CLIENT_ID = "client-id-TEST-9f8e";
const CLIENT_SECRET = "client-secret-SHOULD-NEVER-LEAK-77";
const ACCESS_TOKEN = "access-token-SHOULD-NEVER-LEAK-11";
const REFRESH_TOKEN = "refresh-token-SHOULD-NEVER-LEAK-22";
const SUPABASE_URL = "https://example.supabase.co";
const SECRETS = [CODE, CLIENT_SECRET, ACCESS_TOKEN, REFRESH_TOKEN];

const ENV: Record<string, string> = {
  GHL_APP_CLIENT_ID: CLIENT_ID,
  GHL_APP_CLIENT_SECRET: CLIENT_SECRET,
  GHL_LOCATION_ID: LOCATION,
  SUPABASE_URL,
};

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function harness(opts: {
  env?: Record<string, string | undefined>;
  respond?: () => Promise<Response> | Response;
}) {
  const env = { ...ENV, ...(opts.env ?? {}) };
  const calls: FetchCall[] = [];
  const receipts: InstallReceipt[] = [];
  const deps: CallbackDeps = {
    env: (name) => env[name],
    fetch: (input, init) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(
        opts.respond ? opts.respond() : tokenResponse(LOCATION),
      );
    },
    writeReceipt: (r) => {
      receipts.push(r);
      return Promise.resolve();
    },
  };
  return { deps, calls, receipts };
}

function tokenResponse(locationId: string): Response {
  return new Response(
    JSON.stringify({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      token_type: "Bearer",
      expires_in: 86399,
      scope: "conversations.readonly",
      userType: "Location",
      companyId: COMPANY,
      locationId,
      userId: "usr1",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function callbackRequest(query = `?code=${CODE}`): Request {
  return new Request(
    `https://example.supabase.co/functions/v1/ghl-oauth-callback${query}`,
  );
}

/** Runs fn with console output captured, so tests can prove nothing secret is logged. */
async function captureConsole<T>(fn: () => Promise<T>) {
  const lines: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  const sink = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.log = sink;
  console.error = sink;
  console.warn = sink;
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, orig);
  }
}

async function assertNoSecrets(
  res: Response,
  receipts: InstallReceipt[],
  logs: string[],
): Promise<string> {
  const text = await res.text();
  const outputs = [
    text,
    JSON.stringify([...res.headers.entries()]),
    JSON.stringify(receipts),
    logs.join("\n"),
  ];
  for (const out of outputs) {
    for (const secret of SECRETS) {
      assert(!out.includes(secret), `secret leaked into output: ${out}`);
    }
  }
  return text;
}

Deno.test("success: exchanges the code, writes an ids-only receipt, returns the page, leaks no secret", async () => {
  const h = harness({});
  const { result: res, lines } = await captureConsole(() =>
    handleGhlOAuthCallback(callbackRequest(), h.deps)
  );

  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("Content-Type") ?? "", "text/html");
  assertEquals(res.headers.get("Cache-Control"), "no-store");
  const text = await assertNoSecrets(res, h.receipts, lines);
  assertStringIncludes(
    text,
    "SecureWorks Live Feed installed. You can close this page.",
  );

  assertEquals(h.calls.length, 1);
  assertEquals(h.calls[0].url, GHL_TOKEN_URL);
  assertEquals(h.calls[0].init?.method, "POST");
  assertEquals(
    new Headers(h.calls[0].init?.headers).get("Content-Type"),
    "application/x-www-form-urlencoded",
  );
  assertEquals(new Headers(h.calls[0].init?.headers).get("Version"), "v3");
  const form = new URLSearchParams(String(h.calls[0].init?.body));
  assertEquals(Object.fromEntries(form), {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "authorization_code",
    code: CODE,
    user_type: "Location",
    redirect_uri: `${SUPABASE_URL}/functions/v1/ghl-oauth-callback`,
  });

  assertEquals(h.receipts, [{
    org_id: "00000000-0000-0000-0000-000000000001",
    source: "ghl_oauth",
    event_type: "AppInstall",
    status: "processed",
    error_message: null,
    payload: {
      receipt: "ghl_app_install_v1",
      outcome: "installed",
      location_id: LOCATION,
      company_id: COMPANY,
      provider_status: 200,
    },
  }]);
});

Deno.test("failed exchange: provider rejects, returns the error page with a code only", async () => {
  const h = harness({
    respond: () =>
      new Response(
        JSON.stringify({ error: "invalid_grant", echoed: CODE }),
        { status: 400 },
      ),
  });
  const { result: res, lines } = await captureConsole(() =>
    handleGhlOAuthCallback(callbackRequest(), h.deps)
  );

  assertEquals(res.status, 502);
  const text = await assertNoSecrets(res, h.receipts, lines);
  assertStringIncludes(text, "Error code: exchange_rejected");
  assert(!text.includes("invalid_grant"), "provider body must not be returned");
  assertEquals(h.calls.length, 1);
  assertEquals(h.receipts, []);
  assertEquals(lines.length, 1);
});

Deno.test("failed exchange: network error returns the error page", async () => {
  const h = harness({
    respond: () => {
      throw new TypeError(`connect failed for ${CODE}`);
    },
  });
  const { result: res, lines } = await captureConsole(() =>
    handleGhlOAuthCallback(callbackRequest(), h.deps)
  );
  assertEquals(res.status, 502);
  const text = await assertNoSecrets(res, h.receipts, lines);
  assertStringIncludes(text, "Error code: exchange_unreachable");
  assertEquals(h.receipts, []);
  assertEquals(lines.length, 1);
});

for (const body of ["not json", "null", "[]", '"invalid"']) {
  Deno.test(`failed exchange: invalid response ${body} writes no receipt`, async () => {
    const h = harness({
      respond: () => new Response(body, { status: 200 }),
    });
    const { result: res, lines } = await captureConsole(() =>
      handleGhlOAuthCallback(callbackRequest(), h.deps)
    );
    assertEquals(res.status, 502);
    assertStringIncludes(
      await assertNoSecrets(res, h.receipts, lines),
      "exchange_invalid_response",
    );
    assertEquals(h.receipts, []);
    assertEquals(lines.length, 1);
  });
}

for (
  const [name, body] of Object.entries({
    empty: {},
    missing_token: { locationId: LOCATION },
    empty_token: { access_token: "", locationId: LOCATION },
    blank_token: { access_token: "   ", locationId: LOCATION },
    non_string_token: { access_token: 123, locationId: LOCATION },
    missing_location: { access_token: ACCESS_TOKEN },
    invalid_location: { access_token: ACCESS_TOKEN, locationId: "<foreign>" },
    non_string_location: { access_token: ACCESS_TOKEN, locationId: 123 },
  })
) {
  Deno.test(`invalid token response: ${name} writes no receipt`, async () => {
    const h = harness({
      respond: () => Response.json(body),
    });
    const { result: res, lines } = await captureConsole(() =>
      handleGhlOAuthCallback(callbackRequest(), h.deps)
    );
    assertEquals(res.status, 502);
    assertStringIncludes(
      await assertNoSecrets(res, h.receipts, lines),
      "Error code: exchange_invalid_response",
    );
    assertEquals(h.receipts, []);
    assertEquals(lines.length, 1);
    assertStringIncludes(lines[0], "exchange_invalid_response");
  });
}

for (
  const name of [
    "GHL_APP_CLIENT_ID",
    "GHL_APP_CLIENT_SECRET",
    "GHL_LOCATION_ID",
    "SUPABASE_URL",
  ]
) {
  Deno.test(`missing env ${name}: returns the error page without calling fetch`, async () => {
    const h = harness({ env: { [name]: undefined } });
    const { result: res, lines } = await captureConsole(() =>
      handleGhlOAuthCallback(callbackRequest(), h.deps)
    );
    assertEquals(res.status, 500);
    const text = await assertNoSecrets(res, h.receipts, lines);
    assertStringIncludes(text, "Error code: missing_env");
    assertEquals(h.calls.length, 0);
    assertEquals(h.receipts, []);
    assertEquals(lines.length, 1);
  });
}

Deno.test("missing code: returns the error page without calling fetch", async () => {
  const h = harness({});
  const { result: res, lines } = await captureConsole(() =>
    handleGhlOAuthCallback(callbackRequest("?error=access_denied"), h.deps)
  );
  assertEquals(res.status, 400);
  assertStringIncludes(
    await assertNoSecrets(res, h.receipts, lines),
    "Error code: missing_code",
  );
  assertEquals(h.calls.length, 0);
  assertEquals(h.receipts, []);
  assertEquals(lines.length, 1);
});

Deno.test("location mismatch: records location_mismatch and never stores the foreign location id", async () => {
  const foreign = "someOtherLocation99";
  const h = harness({ respond: () => tokenResponse(foreign) });
  const { result: res, lines } = await captureConsole(() =>
    handleGhlOAuthCallback(callbackRequest(), h.deps)
  );
  assertEquals(res.status, 403);
  const text = await assertNoSecrets(res, h.receipts, lines);
  assertStringIncludes(text, "Error code: location_mismatch");
  assertEquals(h.receipts.length, 1);
  assertEquals(h.receipts[0].payload.outcome, "location_mismatch");
  assertEquals(h.receipts[0].payload.location_id, null);
  assert(!JSON.stringify(h.receipts).includes(foreign));
});

Deno.test("non-GET: refused without calling fetch", async () => {
  const h = harness({});
  const { result: res, lines } = await captureConsole(() =>
    handleGhlOAuthCallback(
      new Request(callbackRequest().url, { method: "POST" }),
      h.deps,
    )
  );
  assertEquals(res.status, 405);
  assertStringIncludes(
    await assertNoSecrets(res, h.receipts, lines),
    "Error code: method_not_allowed",
  );
  assertEquals(h.calls.length, 0);
  assertEquals(h.receipts, []);
  assertEquals(lines.length, 1);
});

Deno.test("a receipt write failure never changes the page", async () => {
  const h = harness({});
  h.deps.writeReceipt = () => Promise.reject(new Error("db down"));
  const { result: res } = await captureConsole(() =>
    handleGhlOAuthCallback(callbackRequest(), h.deps)
  );
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "installed");
});
