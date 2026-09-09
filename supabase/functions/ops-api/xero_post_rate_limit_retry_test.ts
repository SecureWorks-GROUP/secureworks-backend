// deno-lint-ignore-file no-import-prefix
// The real write helper dispatches once. No provider traffic or database writes.
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _xeroPostForTest } from "./index.ts";
import {
  createXeroCooldownFetch,
  XeroCooldownError,
  type XeroCooldownState,
  type XeroCooldownStore,
} from "../_shared/xero_cooldown.ts";

const write = (
  request: typeof fetch,
  key: string | undefined = "stable-operation-key",
) =>
  _xeroPostForTest(
    key ? "/Invoices" : "/Invoices/inv-1/Email",
    "fixture-token",
    "fixture-tenant",
    { Invoices: [] },
    key ? "PUT" : "POST",
    key,
    request,
  );

Deno.test("keyed429 dispatches once with the exact key and returns retry metadata without sleep", async () => {
  for (const retryAfter of ["0", "5", "19079"]) {
    let calls = 0;
    const sleeps: number[] = [];
    const original = globalThis.setTimeout;
    globalThis.setTimeout =
      ((fn: Parameters<typeof setTimeout>[0], ms?: number) => {
        sleeps.push(ms ?? 0);
        return original(fn, 0);
      }) as typeof setTimeout;
    try {
      const error = await assertRejects(() =>
        write((_input, init) => {
          calls++;
          assertEquals(init?.method, "PUT");
          assertEquals(
            new Headers(init?.headers).get("Idempotency-Key"),
            "stable-operation-key",
          );
          return Promise.resolve(
            new Response(null, {
              status: 429,
              headers: {
                "Retry-After": retryAfter,
                "X-MinLimit-Remaining": "60",
                "Xero-Correlation-Id": "fixture-request",
              },
            }),
          );
        }), XeroCooldownError);
      assertEquals(error.details.provider_call_made, true);
      assertEquals(error.details.retry_after_seconds, Number(retryAfter));
      assertEquals(error.details.request_id, "fixture-request");
      assertEquals(calls, 1);
      assertEquals(sleeps, []);
    } finally {
      globalThis.setTimeout = original;
    }
  }
});

Deno.test("actual xeroPost persists hold then refuses the next write before HTTP", async () => {
  let state: XeroCooldownState | null = null;
  const store: XeroCooldownStore = {
    read: () => Promise.resolve(structuredClone(state)),
    compareAndSwap: (_scope, expected, next) => {
      if ((state?.revision ?? null) !== expected) return Promise.resolve(false);
      state = structuredClone(next);
      return Promise.resolve(true);
    },
  };
  let calls = 0;
  const guardedFetch = createXeroCooldownFetch({
    store,
    orgId: "fixture-org",
    appKey: "fixture-app",
    timeoutMs: 90_000,
    fetchFn: (_input, init) => {
      calls++;
      assertEquals(
        new Headers(init?.headers).get("Idempotency-Key"),
        "stable-operation-key",
      );
      return Promise.resolve(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "19079" },
        }),
      );
    },
  });
  const first = await assertRejects(
    () => write(guardedFetch),
    XeroCooldownError,
  );
  assertEquals(first.details.provider_call_made, true);
  const held = await assertRejects(
    () => write(guardedFetch),
    XeroCooldownError,
  );
  assertEquals(held.code, "XERO_COOLDOWN_ACTIVE");
  assertEquals(held.details.provider_call_made, false);
  assertEquals(calls, 1);
});

Deno.test("unkeyed invoice Email429 is never repeated or given an invented key", async () => {
  let calls = 0;
  await assertRejects(
    () =>
      _xeroPostForTest(
        "/Invoices/inv-1/Email",
        "fixture-token",
        "fixture-tenant",
        {},
        "POST",
        undefined,
        (_input, init) => {
          calls++;
          assertEquals(
            new Headers(init?.headers).has("Idempotency-Key"),
            false,
          );
          return Promise.resolve(new Response(null, { status: 429 }));
        },
      ),
    XeroCooldownError,
  );
  assertEquals(calls, 1);
});

Deno.test("validation detail remains visible and non429 errors are never retried", async () => {
  let calls = 0;
  await assertRejects(
    () =>
      write(() => {
        calls++;
        return Promise.resolve(
          Response.json({
            Elements: [{
              ValidationErrors: [{ Message: "Account code200 is invalid" }],
            }],
          }, { status: 400 }),
        );
      }),
    Error,
    "Account code200 is invalid",
  );
  assertEquals(calls, 1);
});

Deno.test("transport timeout remains an unknown write outcome and is not retried", async () => {
  let calls = 0;
  const timeout = new DOMException("Fixture timeout", "TimeoutError");
  const error = await assertRejects(() =>
    write(() => {
      calls++;
      return Promise.reject(timeout);
    })
  );
  assertEquals(error, timeout);
  assertEquals(calls, 1);
});

Deno.test("clean success returns the exact created invoice after one dispatched write", async () => {
  let calls = 0;
  const body = { Invoices: [{ InvoiceID: "fixture-id", Status: "DRAFT" }] };
  const result = await write(() => {
    calls++;
    return Promise.resolve(Response.json(body));
  });
  assertEquals(result, body);
  assertEquals(calls, 1);
});
