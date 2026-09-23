// deno-lint-ignore-file no-import-prefix
// Keep direct URL dependencies consistent with the edge runtime and lockfile.
import {
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient as lockedCreateClient } from "https://esm.sh/@supabase/supabase-js@2";

// Keep the runtime-loaded entrypoint's bare Supabase import in the static
// dependency graph so Deno uses the repository's existing lockfile resolution.
void lockedCreateClient;

type FakeConnection = {
  request: Request;
  localAddr: Deno.NetAddr;
  remoteAddr: Deno.NetAddr;
  respond: (response: Response) => void;
};

function fakeServerHarness() {
  const queued: FakeConnection[] = [];
  const waiters: Array<(connection: FakeConnection) => void> = [];
  let listenCalls = 0;

  const listener = {
    addr: { transport: "tcp", hostname: "127.0.0.1", port: 8123 },
    accept(): Promise<FakeConnection> {
      const connection = queued.shift();
      if (connection) return Promise.resolve(connection);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {},
  };

  return {
    listener,
    get listenCalls() {
      return listenCalls;
    },
    listen() {
      listenCalls += 1;
      return listener;
    },
    serveHttp(connection: FakeConnection) {
      let served = false;
      return {
        nextRequest() {
          if (served) return Promise.resolve(null);
          served = true;
          return Promise.resolve({
            request: connection.request,
            respondWith: connection.respond,
          });
        },
        close() {},
      };
    },
    request(request: Request): Promise<Response> {
      return new Promise((resolve) => {
        const connection: FakeConnection = {
          request,
          localAddr: {
            transport: "tcp",
            hostname: "127.0.0.1",
            port: 8123,
          },
          remoteAddr: {
            transport: "tcp",
            hostname: "127.0.0.1",
            port: 8124,
          },
          respond: resolve,
        };
        const waiter = waiters.shift();
        if (waiter) waiter(connection);
        else queued.push(connection);
      });
    },
  };
}

const TEST_ENV = {
  GHL_API_TOKEN: "ghl-proxy-send-sms-test-token",
  GHL_LOCATION_ID: "ghl-proxy-send-sms-test-location",
  SUPABASE_URL: "https://supabase-send-sms.test.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "supabase-send-sms-test-service-key",
  SW_API_KEY: "ghl-proxy-send-sms-test-api-key",
};

const ENV_TO_CLEAR = [
  ...Object.keys(TEST_ENV),
  "SUPABASE_ACCESS_TOKEN",
  "GHL_TEST_PIPELINE_ID",
  "GHL_TEST_LOCATION_ID",
  "SUPABASE_TEST_ORG_ID",
  "OPS_AGENT_SERVER_KEY",
  "MAKESAFE_ROUTINE_KEY",
  "GHL_PROXY_REQUIRE_USER_JWT_FOR_BROWSER_ACTIONS",
];

Deno.test("send_sms returns its sent message id when evidence capture succeeds or fails", async () => {
  // The handler reads these at module load. These are deliberately fake values;
  // this test replaces fetch before dispatch so neither provider can be reached.
  for (const name of ENV_TO_CLEAR) Deno.env.delete(name);
  for (const [name, value] of Object.entries(TEST_ENV)) {
    Deno.env.set(name, value);
  }

  const harness = fakeServerHarness();
  const originalListen = Object.getOwnPropertyDescriptor(Deno, "listen");
  const originalServeHttp = Object.getOwnPropertyDescriptor(Deno, "serveHttp");
  const originalFetch = globalThis.fetch;
  const sentMessages: Array<Record<string, unknown>> = [];
  const captureWrites: Array<{ mode: "success" | "failure"; row: unknown }> =
    [];
  let captureMode: "success" | "failure" = "success";

  Object.defineProperty(Deno, "listen", {
    configurable: true,
    enumerable: originalListen?.enumerable ?? true,
    writable: true,
    value: () => harness.listen(),
  });
  Object.defineProperty(Deno, "serveHttp", {
    configurable: true,
    enumerable: originalServeHttp?.enumerable ?? true,
    writable: true,
    value: (connection: FakeConnection) => harness.serveHttp(connection),
  });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.hostname === "services.leadconnectorhq.com") {
      assertEquals(url.pathname, "/conversations/messages");
      assertStrictEquals(request.method, "POST");
      const body = await request.json() as Record<string, unknown>;
      sentMessages.push(body);
      return Response.json({ messageId: `ghl-message-${sentMessages.length}` });
    }

    if (url.origin === TEST_ENV.SUPABASE_URL) {
      if (url.pathname === "/rest/v1/business_events") {
        assertStrictEquals(request.method, "GET");
        return Response.json([]);
      }

      if (url.pathname === "/rest/v1/rpc/capture_business_event") {
        assertStrictEquals(request.method, "POST");
        const body = await request.json() as { p_row?: unknown };
        captureWrites.push({ mode: captureMode, row: body.p_row });
        if (captureMode === "failure") {
          return Response.json({
            code: "XX000",
            details: null,
            hint: null,
            message: "fixture capture_business_event failure",
          }, { status: 500 });
        }
        return Response.json({
          outcome: "inserted",
          id: "event-test-id",
          job_id: null,
          attribution_status: "direct",
        });
      }

      if (url.pathname === "/rest/v1/jarvis_event_log") {
        assertStrictEquals(request.method, "POST");
        return new Response(null, { status: 201 });
      }
    }

    throw new Error(
      `Unexpected fetch in send_sms contract test: ${request.method} ${url.origin}${url.pathname}`,
    );
  };

  try {
    // Keep this runtime integration check independent of unrelated type errors
    // elsewhere in the large edge-function entrypoint.
    const entrypoint = "./index" + ".ts";
    await import(entrypoint);
    assertStrictEquals(
      harness.listenCalls,
      1,
      "the deployed serve handler was not captured",
    );

    for (const mode of ["success", "failure"] as const) {
      captureMode = mode;
      const response = await harness.request(
        new Request(
          "http://ghl-proxy.test.invalid/?action=send_sms",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": TEST_ENV.SW_API_KEY,
            },
            body: JSON.stringify({
              contactId: "test-contact-id",
              message: `Booking confirmation ${mode}`,
            }),
          },
        ),
      );
      const body = await response.json() as Record<string, unknown>;

      assertStrictEquals(response.status, 200);
      assertEquals([body.success, body.messageId], [
        true,
        `ghl-message-${sentMessages.length}`,
      ]);
      assertEquals(sentMessages.length, captureWrites.length);
      assertEquals(captureWrites.at(-1)?.mode, mode);
    }

    assertEquals(sentMessages.map((message) => message.message), [
      "Booking confirmation success",
      "Booking confirmation failure",
    ]);
    assertEquals(
      captureWrites.length,
      2,
      "each send should attempt evidence capture once",
    );
    assertEquals(
      sentMessages.length,
      2,
      "capture failure must not cause a repeated GHL send",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalListen) Object.defineProperty(Deno, "listen", originalListen);
    if (originalServeHttp) {
      Object.defineProperty(Deno, "serveHttp", originalServeHttp);
    }
    for (const name of ENV_TO_CLEAR) Deno.env.delete(name);
  }
});
