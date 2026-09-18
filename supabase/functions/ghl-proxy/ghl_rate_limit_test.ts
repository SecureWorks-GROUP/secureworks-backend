// GHL 429 must reach the caller as HTTP 429 with Retry-After when GHL sent one.
// Every other non-ok GHL status keeps throwing the same bare Error `ghl()` always threw.
// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ghlNonOkError,
  ghlRateLimitResponseFields,
  GhlProviderReadError,
  isGhlRateLimitError,
  throwIfGhlResponseNotOk,
} from "./provider_reads.ts";

function headers(init?: Record<string, string>): Headers {
  return new Headers(init);
}

function respondAsProxy(error: GhlProviderReadError): Response {
  const parts = ghlRateLimitResponseFields(error);
  return new Response(JSON.stringify(parts.body), {
    status: parts.status,
    headers: { "Content-Type": "application/json", ...parts.headers },
  });
}

Deno.test("GHL 429 with Retry-After comes out as HTTP 429 carrying that header", async () => {
  const err = assertThrows(
    () =>
      throwIfGhlResponseNotOk(
        { ok: false, status: 429, headers: headers({ "Retry-After": "30" }) },
        '{"message":"rate limited"}',
      ),
    GhlProviderReadError,
  );
  assertEquals(err.status, 429);
  assertEquals(err.providerStatus, 429);
  assertEquals(err.retryAfter, "30");
  assertEquals(isGhlRateLimitError(err), true);

  const response = respondAsProxy(err);
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("Retry-After"), "30");
  const body = await response.json();
  assertEquals(body.retry_after, "30");
  assertEquals(typeof body.error, "string");
});

Deno.test("GHL 429 without Retry-After still comes out as HTTP 429", async () => {
  const err = assertThrows(
    () =>
      throwIfGhlResponseNotOk(
        { ok: false, status: 429, headers: headers() },
        '{"message":"slow down"}',
      ),
    GhlProviderReadError,
  );
  assertEquals(err.status, 429);
  assertEquals(err.retryAfter, undefined);
  assertEquals(isGhlRateLimitError(err), true);

  const response = respondAsProxy(err);
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("Retry-After"), null);
  const body = await response.json();
  assertEquals(body.retry_after, undefined);
});

Deno.test("GHL 404 stays a bare Error with the same message ghl() always threw", () => {
  const err = assertThrows(
    () =>
      throwIfGhlResponseNotOk(
        { ok: false, status: 404, headers: headers({ "Retry-After": "ignored" }) },
        '{"message":"Contact not found"}',
      ),
    Error,
  );
  assertEquals(err instanceof GhlProviderReadError, false);
  assertEquals(isGhlRateLimitError(err), false);
  assertEquals(err.message, 'GHL 404: {"message":"Contact not found"}');
  assertEquals(
    ghlNonOkError(404, '{"message":"Contact not found"}').message,
    'GHL 404: {"message":"Contact not found"}',
  );
});

Deno.test("GHL 500 stays a bare Error with the same message ghl() always threw", () => {
  const err = assertThrows(
    () =>
      throwIfGhlResponseNotOk(
        { ok: false, status: 500, headers: headers() },
        "upstream boom",
      ),
    Error,
  );
  assertEquals(err instanceof GhlProviderReadError, false);
  assertEquals(isGhlRateLimitError(err), false);
  assertEquals(err.message, "GHL 500: upstream boom");
});

Deno.test("an ok GHL response is not thrown", () => {
  throwIfGhlResponseNotOk(
    { ok: true, status: 200, headers: headers() },
    '{"ok":true}',
  );
});
