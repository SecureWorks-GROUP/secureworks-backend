// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createXeroSyncTransport,
  XeroSyncProviderError,
} from "./xero_transport.ts";
import { reconcileXeroInvoice } from "./xero_invoice_reconciliation.ts";
import {
  createXeroCooldownFetch,
  XeroCooldownError,
  type XeroCooldownState,
  type XeroCooldownStore,
} from "../_shared/xero_cooldown.ts";
import { _createXeroQuoteForTest } from "../send-quote/index.ts";
import { xeroQuoteFailureWarning } from "../send-quote/xero_quote_outcome.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const TENANT = "20000000-0000-4000-8000-000000000002";
const INVOICE = "30000000-0000-4000-8000-000000000003";

function fixtureStore(): XeroCooldownStore {
  let state: XeroCooldownState | null = null;
  return {
    read: () => Promise.resolve(structuredClone(state)),
    compareAndSwap: (_scope, expected, next) => {
      if ((state?.revision ?? null) !== expected) return Promise.resolve(false);
      state = structuredClone(next);
      return Promise.resolve(true);
    },
  };
}

function quoteClient() {
  return {
    from: (table: string) => {
      assertEquals(table, "xero_tokens");
      const query = {
        select: (_fields: string) => query,
        eq: (_field: string, _value: string) => query,
        single: () =>
          Promise.resolve({
            data: {
              access_token: "fixture-only",
              tenant_id: TENANT,
              expires_at: new Date(Date.now() + 600_000).toISOString(),
            },
          }),
      };
      return query;
    },
  };
}
const JOB = {
  id: "fixture-job",
  job_number: "SWP-25001",
  type: "patio",
  xero_contact_id: "fixture-contact",
  pricing_json: { totalIncGST: 110 },
};

Deno.test("ops-style reads, sync Accounting/Projects, sync writes and quote PUT share one hold across instances", async () => {
  const store = fixtureStore();
  let calls = 0;
  const options = {
    store,
    orgId: ORG,
    appKey: "fixture-app",
    fetchFn: (() => {
      calls++;
      return Promise.resolve(
        new Response(null, {
          status: 429,
          headers: {
            "Retry-After": "19079",
            "X-MinLimit-Remaining": "60",
            "Xero-Correlation-Id": "fixture-request",
          },
        }),
      );
    }) as typeof fetch,
  };
  await createXeroCooldownFetch({ ...options, timeoutMs: 12_000 })(
    "https://api.xero.com/api.xro/2.0/Organisation",
    { headers: { "Xero-tenant-id": TENANT } },
  );
  const sync = createXeroSyncTransport(
    createXeroCooldownFetch({ ...options, timeoutMs: 30_000 }),
  );
  for (
    const request of [
      () => sync.get("/Invoices", "fixture-only", TENANT),
      () => sync.getProjects("/projects", "fixture-only", TENANT),
      () => sync.post("/Contacts", "fixture-only", TENANT, { Contacts: [] }),
      () =>
        _createXeroQuoteForTest(
          quoteClient(),
          JOB,
          { quote_number: "Q1" },
          createXeroCooldownFetch({ ...options, timeoutMs: 90_000 }),
        ),
    ]
  ) {
    const error = await assertRejects(request, XeroCooldownError);
    assertEquals(error.code, "XERO_COOLDOWN_ACTIVE");
    assertEquals(error.details.provider_call_made, false);
    assertEquals(
      (error.details.last_rate_limit as Record<string, unknown>).request_id,
      "fixture-request",
    );
    assertEquals(
      (error.details.last_rate_limit as Record<string, unknown>).provider_api,
      "accounting",
    );
  }
  assertEquals(calls, 1);
});

Deno.test("sync unkeyed writes never retry and keyed writes preserve caller payload and key", async () => {
  const calls: RequestInit[] = [];
  const sync = createXeroSyncTransport((_input, init) => {
    calls.push(init!);
    return Promise.resolve(
      new Response(null, { status: 429, headers: { "Retry-After": "0" } }),
    );
  });
  const keyed = {
    Contacts: [{ Name: "Fixture" }],
    _idempotencyKey: "stable-fixture",
  };
  for (const body of [{ Contacts: [] }, keyed]) {
    await assertRejects(
      () => sync.post("/Contacts", "fixture-only", TENANT, body),
      XeroCooldownError,
    );
  }
  assertEquals(calls.length, 2);
  assertEquals(new Headers(calls[0].headers).has("Idempotency-Key"), false);
  assertEquals(
    new Headers(calls[1].headers).get("Idempotency-Key"),
    "stable-fixture",
  );
  assertEquals(JSON.parse(String(calls[1].body)), {
    Contacts: [{ Name: "Fixture" }],
  });
  assertEquals(keyed._idempotencyKey, "stable-fixture");
});

Deno.test("sync Projects preserves its API URL and Accounting conditional headers", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const sync = createXeroSyncTransport((input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return Promise.resolve(Response.json({ Items: [] }));
  });
  await sync.getProjects("/projects", "fixture-only", TENANT, { page: "2" });
  await sync.get("/Invoices", "fixture-only", TENANT, {
    Statuses: "AUTHORISED,PAID",
  }, { "If-Modified-Since": "fixture-date" });
  assertEquals(
    calls[0].url,
    "https://api.xero.com/projects.xro/2.0/projects?page=2",
  );
  assertEquals(calls[1].url.includes("Statuses=AUTHORISED,PAID"), true);
  assertEquals(calls[1].headers.get("If-Modified-Since"), "fixture-date");
});

Deno.test("quote PUT retains its existing idempotency key and returns provider identity", async () => {
  let calls = 0;
  const id = await _createXeroQuoteForTest(quoteClient(), JOB, {
    quote_number: "Q1",
  }, (input, init) => {
    calls++;
    assertEquals(String(input), "https://api.xero.com/api.xro/2.0/Quotes");
    assertEquals(init?.method, "PUT");
    assertEquals(
      new Headers(init?.headers).get("Idempotency-Key"),
      "fixture-job-xero-quote-Q1",
    );
    return Promise.resolve(
      Response.json({ Quotes: [{ QuoteID: "provider-fixture-id" }] }),
    );
  });
  assertEquals(id, "provider-fixture-id");
  assertEquals(calls, 1);
});

Deno.test("quote PUT surfaces explicit rejection and ambiguous responses without retrying the write", async () => {
  const cases: Array<
    { response: () => Response; expected: "failed" | "unknown" }
  > = [
    ...[400, 401, 403, 422].map((status) => ({
      response: () => new Response("fixture raw provider error", { status }),
      expected: "failed" as const,
    })),
    ...[408, 500, 502, 503].map((status) => ({
      response: () => new Response("fixture raw provider error", { status }),
      expected: "unknown" as const,
    })),
    {
      response: () => new Response('{"Quotes":[', { status: 200 }),
      expected: "unknown",
    },
    { response: () => Response.json({ Quotes: [] }), expected: "unknown" },
    { response: () => Response.json({ Quotes: [{}] }), expected: "unknown" },
    {
      response: () =>
        Response.json({ Quotes: { 0: { QuoteID: "fixture" }, length: 1 } }),
      expected: "unknown",
    },
    {
      response: () =>
        Response.json({
          Quotes: [{ QuoteID: "first" }, { QuoteID: "second" }],
        }),
      expected: "unknown",
    },
    {
      response: () =>
        Response.json({ Quotes: [{ HasValidationErrors: true }] }),
      expected: "failed",
    },
    {
      response: () =>
        Response.json({
          Quotes: [{
            ValidationErrors: [{ Message: "fixture raw provider error" }],
          }],
        }),
      expected: "failed",
    },
  ];
  for (const { response, expected } of cases) {
    let calls = 0;
    const error = await assertRejects(() =>
      _createXeroQuoteForTest(
        quoteClient(),
        JOB,
        { quote_number: "Q1" },
        (_input, init) => {
          calls++;
          assertEquals(init?.method, "PUT");
          assertEquals(
            new Headers(init?.headers).get("Idempotency-Key"),
            "fixture-job-xero-quote-Q1",
          );
          const result = response();
          result.headers.set("Xero-Correlation-Id", "fixture-request");
          result.headers.set("X-MinLimit-Remaining", "59");
          return Promise.resolve(result);
        },
      )
    );
    const warning = xeroQuoteFailureWarning(error);
    assertEquals(warning.status, expected);
    assertEquals(warning.provider_call_made, true);
    assertEquals(warning.request_id, "fixture-request");
    assertEquals(
      (warning.quota as Record<string, unknown>).minute_remaining,
      "59",
    );
    assertEquals(
      JSON.stringify(warning).includes("fixture raw provider error"),
      false,
    );
    assertEquals(calls, 1);
  }
});

Deno.test("quote PUT timeout is an unknown outcome with one dispatched attempt", async () => {
  let calls = 0;
  const error = await assertRejects(() =>
    _createXeroQuoteForTest(quoteClient(), JOB, { quote_number: "Q1" }, () => {
      calls++;
      return Promise.reject(
        new DOMException("fixture-only timeout", "TimeoutError"),
      );
    })
  );
  const warning = xeroQuoteFailureWarning(error);
  assertEquals(warning.status, "unknown");
  assertEquals(warning.provider_call_made, true);
  assertEquals(warning.code, "XERO_QUOTE_OUTCOME_UNKNOWN");
  assertEquals(calls, 1);
});

Deno.test("quote PUT rate limiting persists a shared hold and returns a failed step without a retry", async () => {
  const store = fixtureStore();
  let calls = 0;
  const guarded = createXeroCooldownFetch({
    store,
    orgId: ORG,
    appKey: "fixture-app",
    timeoutMs: 90_000,
    fetchFn: ((_input, init) => {
      calls++;
      assertEquals(
        new Headers(init?.headers).get("Idempotency-Key"),
        "fixture-job-xero-quote-Q1",
      );
      return Promise.resolve(
        new Response(null, {
          status: 429,
          headers: { "Retry-After": "19079" },
        }),
      );
    }) as typeof fetch,
  });
  for (const made of [true, false]) {
    const error = await assertRejects(() =>
      _createXeroQuoteForTest(
        quoteClient(),
        JOB,
        { quote_number: "Q1" },
        guarded,
      )
    );
    const warning = xeroQuoteFailureWarning(error);
    assertEquals(warning.status, "failed");
    assertEquals(warning.provider_call_made, made);
    assertEquals(typeof warning.retry_at, "string");
  }
  assertEquals(calls, 1);
});

Deno.test("429,401,404,500 and timeout preserve cached invoice status, balances and freshness", async () => {
  for (const status of [429, 401, 404, 500, "timeout"]) {
    const original = {
      status: "AUTHORISED",
      amount_due: 100,
      amount_paid: 0,
      synced_at: "old",
    };
    const cache = { ...original };
    let writes = 0;
    const client = {
      from: () => ({
        update: (patch: Record<string, unknown>) => {
          writes++;
          Object.assign(cache, patch);
          const query = {
            eq: () => query,
            then: (resolve: (value: { error: null }) => void) =>
              resolve({ error: null }),
          };
          return query;
        },
      }),
    };
    const transport = createXeroSyncTransport(() => {
      if (status === "timeout") {
        return Promise.reject(
          new DOMException("Fixture timeout", "TimeoutError"),
        );
      }
      return Promise.resolve(
        new Response(null, {
          status: Number(status),
          headers: { "Retry-After": "19079" },
        }),
      );
    });
    const error = await assertRejects(() =>
      reconcileXeroInvoice(
        client,
        ORG,
        INVOICE,
        () => transport.get(`/Invoices/${INVOICE}`, "fixture-only", TENANT),
      )
    );
    if (status === 429) assertEquals(error instanceof XeroCooldownError, true);
    if (status === 401) {
      assertEquals(error instanceof XeroSyncProviderError, true);
    }
    assertEquals(cache, original);
    assertEquals(writes, 0);
  }
});

Deno.test("only identified provider invoice status and numeric balances can change reconciliation cache", async () => {
  const patches: Record<string, unknown>[] = [];
  const client = {
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        patches.push(patch);
        const query = {
          eq: () => query,
          then: (resolve: (value: { error: null }) => void) =>
            resolve({ error: null }),
        };
        return query;
      },
    }),
  };
  for (
    const data of [
      { Invoices: [] },
      {
        Invoices: [{
          InvoiceID: "other",
          Type: "ACCREC",
          Status: "DELETED",
          AmountDue: 0,
          AmountPaid: 0,
        }],
      },
      {
        Invoices: [{
          InvoiceID: INVOICE,
          Type: "ACCPAY",
          Status: "DELETED",
          AmountDue: 0,
          AmountPaid: 0,
        }],
      },
      { Invoices: [{ InvoiceID: INVOICE, Type: "ACCREC", Status: "DELETED" }] },
    ]
  ) {
    await assertRejects(() =>
      reconcileXeroInvoice(client, ORG, INVOICE, () => Promise.resolve(data))
    );
  }
  assertEquals(patches.length, 0);
  const changed = await reconcileXeroInvoice(
    client,
    ORG,
    INVOICE,
    () =>
      Promise.resolve({
        Invoices: [{
          InvoiceID: INVOICE,
          Type: "ACCREC",
          Status: "DELETED",
          AmountDue: 0,
          AmountPaid: 10,
        }],
      }),
  );
  assertEquals(changed, true);
  assertEquals(patches[0].status, "DELETED");
  assertEquals(patches[0].amount_due, 0);
  assertEquals(patches[0].amount_paid, 10);
});
