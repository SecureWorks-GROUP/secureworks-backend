// Xero write-path rate-limit contract (xeroPost).
//
// Why this exists: xeroGet has always retried a 429, xeroPost never did. On the
// sealed SES mint that asymmetry is not "one slow card" — createInvoice runs as
// executeSesExternalEffect's dispatch, so a thrown 429 is caught and recorded as
// effect state `unknown`. claim_ses_external_effect_v1 returns claim_mode
// 'reconcile' for every non-confirmed state, and the reconcile finds no invoice
// (the 429 meant Xero never processed the create), so the card cannot mint again
// on that invoice obligation revision at all. A rate limit is a batch-scale-only
// failure, which is exactly why one-card-at-a-time proving never surfaced it.
//
// The retry is gated on the Idempotency-Key because that is what lets Xero
// collapse a repeat into the same record. The un-keyed writes are the ones that
// must never repeat — POST /Invoices/{id}/Email sends a real client email on
// every success — so an un-keyed 429 must still throw on the first response.
//
// Self-contained: globalThis.fetch is stubbed. No network, no Xero, no Supabase.

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _xeroPostForTest } from "./index.ts";

interface Attempt {
  url: string;
  idempotencyKey: string | null;
}

/**
 * Stub fetch that answers 429 for the first `rateLimited` attempts and then the
 * given terminal response. `Retry-After: 0` keeps the real sleep at zero rather
 * than mocking timers, so the production backoff code path is the one exercised.
 */
function stubFetch(
  rateLimited: number,
  terminal: () => Response,
  attempts: Attempt[],
  retryAfter = "0",
): typeof globalThis.fetch {
  let seen = 0;
  return ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit);
    attempts.push({
      url: String(input),
      idempotencyKey: headers.get("Idempotency-Key"),
    });
    seen += 1;
    if (seen <= rateLimited) {
      return Promise.resolve(
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": retryAfter },
        }),
      );
    }
    return Promise.resolve(terminal());
  }) as typeof globalThis.fetch;
}

/**
 * Records the delays the real backoff asks for and fires them immediately, so a
 * bounded-sleep contract can be asserted without spending the wall time. The
 * production code path is still the one running.
 */
async function withRecordedSleeps<T>(
  run: () => Promise<T>,
): Promise<{ result: T | null; error: Error | null; delays: number[] }> {
  const delays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number) => {
    delays.push(Number(ms ?? 0));
    return originalSetTimeout(cb, 0);
    // deno-lint-ignore no-explicit-any
  }) as any;
  try {
    return { result: await run(), error: null, delays };
  } catch (err) {
    return { result: null, error: err as Error, delays };
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

function okInvoice(): Response {
  return new Response(
    JSON.stringify({ Invoices: [{ InvoiceID: "inv-1", Status: "DRAFT" }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function withStubbedFetch<T>(
  stub: typeof globalThis.fetch,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("keyed write: a single 429 is retried and the create succeeds", async () => {
  const attempts: Attempt[] = [];
  const result = await withStubbedFetch(
    stubFetch(1, okInvoice, attempts),
    () =>
      _xeroPostForTest(
        "/Invoices",
        "token",
        "tenant",
        { Invoices: [] },
        "PUT",
        "ses-invoice-create-rev-1",
      ),
  );
  assertEquals(attempts.length, 2, "one rate limit then one successful retry");
  assertEquals(
    attempts.map((a) => a.idempotencyKey),
    ["ses-invoice-create-rev-1", "ses-invoice-create-rev-1"],
    "the retry must carry the SAME idempotency key or Xero cannot collapse it",
  );
  assertEquals(result?.Invoices?.[0]?.InvoiceID, "inv-1");
});

Deno.test("keyed write: retries are bounded at 3 and then throw", async () => {
  const attempts: Attempt[] = [];
  await withStubbedFetch(
    stubFetch(99, okInvoice, attempts),
    async () => {
      const error = await assertRejects(
        () =>
          _xeroPostForTest(
            "/Invoices",
            "token",
            "tenant",
            { Invoices: [] },
            "PUT",
            "ses-invoice-create-rev-2",
          ),
        Error,
      );
      assert(
        error.message.includes("rate limited"),
        `expected a rate-limit message, got: ${error.message}`,
      );
    },
  );
  assertEquals(
    attempts.length,
    4,
    "the first attempt plus exactly 3 retries — never an unbounded loop",
  );
});

Deno.test("UN-keyed write: a 429 throws immediately and is never repeated", async () => {
  const attempts: Attempt[] = [];
  await withStubbedFetch(
    stubFetch(1, okInvoice, attempts),
    async () => {
      await assertRejects(
        () =>
          // POST /Invoices/{id}/Email is the real un-keyed caller: retrying it
          // would send the client a second email.
          _xeroPostForTest(
            "/Invoices/inv-1/Email",
            "token",
            "tenant",
            {},
            "POST",
          ),
        Error,
      );
    },
  );
  assertEquals(
    attempts.length,
    1,
    "an un-keyed write must not be repeated on a rate limit",
  );
  assertEquals(attempts[0].idempotencyKey, null);
});

Deno.test("keyed write: a non-429 failure is NOT retried", async () => {
  const attempts: Attempt[] = [];
  await withStubbedFetch(
    stubFetch(
      0,
      () =>
        new Response(
          JSON.stringify({
            Elements: [{
              ValidationErrors: [{ Message: "Account code 200 is invalid" }],
            }],
          }),
          { status: 400 },
        ),
      attempts,
    ),
    async () => {
      const error = await assertRejects(
        () =>
          _xeroPostForTest(
            "/Invoices",
            "token",
            "tenant",
            { Invoices: [] },
            "PUT",
            "ses-invoice-create-rev-3",
          ),
        Error,
      );
      assert(
        error.message.includes("Account code 200 is invalid"),
        `validation detail must survive, got: ${error.message}`,
      );
    },
  );
  assertEquals(
    attempts.length,
    1,
    "a deterministic validation failure is not a rate limit and must not retry",
  );
});

Deno.test("keyed write: a long Retry-After throws at once and never sleeps", async () => {
  const attempts: Attempt[] = [];
  const { error, delays } = await withStubbedFetch(
    stubFetch(99, okInvoice, attempts, "3600"),
    () =>
      withRecordedSleeps(() =>
        _xeroPostForTest(
          "/Invoices",
          "token",
          "tenant",
          { Invoices: [] },
          "PUT",
          "ses-invoice-create-rev-5",
        )
      ),
  );
  assert(error, "a daily/concurrency rate limit must refuse, not wait");
  assert(
    error!.message.includes("rate limited"),
    `expected a rate-limit message, got: ${error!.message}`,
  );
  assertEquals(
    attempts.length,
    1,
    "a Retry-After above the ceiling must throw on the FIRST response",
  );
  assertEquals(
    delays,
    [],
    "sleeping inside the dispatch is what strands the effect — never do it here",
  );
});

Deno.test("keyed write: each sleep is clamped and the chain stays inside the budget", async () => {
  const attempts: Attempt[] = [];
  const { error, delays } = await withStubbedFetch(
    stubFetch(99, okInvoice, attempts, "5"),
    () =>
      withRecordedSleeps(() =>
        _xeroPostForTest(
          "/Invoices",
          "token",
          "tenant",
          { Invoices: [] },
          "PUT",
          "ses-invoice-create-rev-6",
        )
      ),
  );
  assert(error, "an exhausted retry chain still throws");
  assertEquals(attempts.length, 4, "the first attempt plus exactly 3 retries");
  assert(
    delays.every((ms) => ms <= 5_000),
    `every sleep must be clamped to the 5s ceiling, got: ${delays.join(",")}`,
  );
  assert(
    delays.reduce((a, b) => a + b, 0) <= 15_000,
    `cumulative backoff must stay inside the 15s budget, got: ${
      delays.join(",")
    }`,
  );
});

Deno.test("keyed write: a clean success makes exactly one call", async () => {
  const attempts: Attempt[] = [];
  await withStubbedFetch(
    stubFetch(0, okInvoice, attempts),
    () =>
      _xeroPostForTest(
        "/Invoices",
        "token",
        "tenant",
        { Invoices: [] },
        "PUT",
        "ses-invoice-create-rev-4",
      ),
  );
  assertEquals(attempts.length, 1);
});
