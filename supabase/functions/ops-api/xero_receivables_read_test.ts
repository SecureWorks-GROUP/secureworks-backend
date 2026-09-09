// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createXeroReadGet,
  getXeroReceivable,
  listXeroReceivables,
  listXeroSettlementRecords,
  readXeroOrganisation,
  readXeroSettlementRecord,
  readXeroTrackingCategories,
  XeroReceivablesReadError,
} from "./xero_receivables_read.ts";
import {
  createXeroCooldownFetch,
  XeroCooldownError,
  type XeroCooldownStore,
} from "../_shared/xero_cooldown.ts";

const TENANT = "10000000-0000-4000-8000-000000000001";
const ID = "20000000-0000-4000-8000-000000000002";
const ID2 = "20000000-0000-4000-8000-000000000003";
const CONTACT = "30000000-0000-4000-8000-000000000003";
const NOW = "2026-09-09T08:00:00.000Z";
const EMPTY_RESPONSE_METADATA = {
  shared_cooldown: null,
  request_id: null,
  quota: {
    minute_remaining: null,
    day_remaining: null,
    app_minute_remaining: null,
    limit_problem: null,
  },
};

Deno.test("new read adapter preserves an early shared-guard refusal and sends no provider call", async () => {
  let providerCalls = 0;
  const store: XeroCooldownStore = {
    read: () => Promise.reject(new Error("Fixture store unavailable")),
    compareAndSwap: () => Promise.resolve(false),
  };
  const read = createXeroReadGet({
    fetchFn: createXeroCooldownFetch({
      store,
      orgId: "fixture-org",
      appKey: "fixture-app",
      fetchFn: () => {
        providerCalls++;
        return Promise.resolve(Response.json({}));
      },
    }),
  });
  const error = await assertRejects(
    () => read("/Organisation", "fixture-token", TENANT),
    XeroCooldownError,
  );
  assertEquals(error.code, "XERO_GUARD_UNAVAILABLE");
  assertEquals(error.details.provider_call_made, false);
  assertEquals(providerCalls, 0);
});

Deno.test("bounded provider GET returns 429 immediately with retry and quota metadata, no retries", async () => {
  let calls = 0;
  const read = createXeroReadGet({
    now: () => new Date(NOW),
    fetchFn: (_url, init) => {
      calls++;
      assertEquals(init?.method, "GET");
      assertEquals(init?.redirect, "error");
      assertEquals(init?.signal instanceof AbortSignal, true);
      return Promise.resolve(
        new Response("provider-private-error-body", {
          status: 429,
          headers: {
            "Retry-After": "19079",
            "X-MinLimit-Remaining": "60",
            "X-DayLimit-Remaining": "0",
            "Xero-Correlation-Id": ID,
          },
        }),
      );
    },
  });
  const started = performance.now();
  const error = await assertRejects(
    () => read("/Organisation", "fixture-token", TENANT),
    XeroReceivablesReadError,
  );
  assertEquals(error.status, 429);
  assertEquals(error.code, "XERO_RATE_LIMITED");
  assertEquals(error.details.retry_after_seconds, 19079);
  assertEquals(error.details.retry_at, "2026-09-09T13:17:59.000Z");
  assertEquals(error.details.request_id, ID);
  assertEquals(error.details.quota, {
    minute_remaining: "60",
    day_remaining: "0",
    app_minute_remaining: null,
    limit_problem: null,
  });
  assertEquals(calls, 1);
  assertEquals(performance.now() - started < 1000, true);
  assertEquals(
    JSON.stringify(error).includes("provider-private-error-body"),
    false,
  );
  assertEquals(JSON.stringify(error).includes("fixture-token"), false);
});

Deno.test("provider retry HTTP date and missing/malformed retry headers remain honest", async () => {
  for (
    const [retry, seconds] of [
      ["Wed, 09 Sep 2026 08:05:00 GMT", 300],
      ["invalid", null],
      ["9999999999999999999999999", null],
      [null, null],
    ] as const
  ) {
    const read = createXeroReadGet({
      now: () => new Date(NOW),
      fetchFn: () =>
        Promise.resolve(
          new Response(null, {
            status: 429,
            headers: retry ? { "Retry-After": retry } : {},
          }),
        ),
    });
    const error = await assertRejects(
      () => read("/Invoices", "fixture-token", TENANT),
      XeroReceivablesReadError,
    );
    assertEquals(error.details.retry_after_seconds, seconds);
    assertEquals(
      error.details.retry_at,
      seconds === 300 ? "2026-09-09T08:05:00.000Z" : null,
    );
  }
});

Deno.test("provider error bodies and network error text never escape through read errors", async () => {
  for (const status of [400, 401, 403, 404, 500]) {
    const read = createXeroReadGet({
      fetchFn: () =>
        Promise.resolve(
          new Response("private account or credential details", { status }),
        ),
    });
    const error = await assertRejects(
      () => read("/Organisation", "fixture-token", TENANT),
      XeroReceivablesReadError,
    );
    assertEquals(error.status, status === 404 ? 404 : 502);
    assertEquals(error.details.provider_status, status);
    assertEquals(error.message.includes("private"), false);
  }
  const read = createXeroReadGet({
    fetchFn: () => Promise.reject(new Error("fixture-secret")),
  });
  const error = await assertRejects(
    () => read("/Organisation", "fixture-token", TENANT),
    XeroReceivablesReadError,
  );
  assertEquals(error.code, "XERO_READ_UNAVAILABLE");
  assertEquals(error.message.includes("fixture-secret"), false);
});

Deno.test("provider GET uses configured tenant and exact query while preserving raw successful JSON", async () => {
  const payload = { Invoices: [invoice()] };
  const read = createXeroReadGet({
    fetchFn: (input, init) => {
      const url = new URL(String(input));
      assertEquals(url.origin, "https://api.xero.com");
      assertEquals(url.pathname, "/api.xro/2.0/Invoices");
      assertEquals(url.searchParams.get("pageSize"), "100");
      const headers = new Headers(init?.headers);
      assertEquals(headers.get("Xero-tenant-id"), TENANT);
      assertEquals(headers.get("Authorization"), "Bearer fixture-token");
      return Promise.resolve(Response.json(payload));
    },
  });
  assertEquals(
    (await read("/Invoices", "fixture-token", TENANT, { pageSize: "100" }))
      .data,
    payload,
  );
  const invalid = createXeroReadGet({
    fetchFn: () => Promise.resolve(new Response("not-json")),
  });
  const error = await assertRejects(
    () => invalid("/Organisation", "fixture-token", TENANT),
    XeroReceivablesReadError,
  );
  assertEquals(error.code, "XERO_RESPONSE_INVALID");
});

Deno.test("successful provider request ID and quotas reach provenance without altering invoice data", async () => {
  const raw = invoice();
  const payload = { Invoices: [raw], Id: ID2, DateTimeUTC: "provider-time" };
  const f = fixture(payload);
  const result = await listXeroReceivables(noDatabase, {}, {
    ...f.deps,
    xeroGet: createXeroReadGet({
      fetchFn: () =>
        Promise.resolve(Response.json(payload, {
          headers: {
            "Xero-Correlation-Id": "provider-request-id",
            "X-MinLimit-Remaining": "59",
            "X-DayLimit-Remaining": "2999",
            "X-AppMinLimit-Remaining": "9999",
            "Authorization": "provider-private-header",
          },
        })),
    }),
  });
  assertEquals(result.invoices, [raw]);
  assertEquals(result.provenance.request_id, "provider-request-id");
  assertEquals(result.provenance.quota, {
    minute_remaining: "59",
    day_remaining: "2999",
    app_minute_remaining: "9999",
    limit_problem: null,
  });
  assertEquals(result.provenance.provider_response_id, ID2);
  assertEquals(
    JSON.stringify(result).includes("provider-private-header"),
    false,
  );
});

Deno.test("provider fetch has a twelve-second deadline and surfaces timeout without retry", async () => {
  const original = AbortSignal.timeout;
  let observedTimeout = 0;
  let calls = 0;
  // Advance only the injected request deadline; no real timer or provider call.
  AbortSignal.timeout = (milliseconds: number) => {
    observedTimeout = milliseconds;
    return AbortSignal.abort(
      new DOMException("Fixture timeout", "TimeoutError"),
    );
  };
  try {
    const read = createXeroReadGet({
      fetchFn: (_url, init) => {
        calls++;
        return Promise.reject(init?.signal?.reason);
      },
    });
    const error = await assertRejects(
      () => read("/Organisation", "fixture-token", TENANT),
      XeroReceivablesReadError,
    );
    assertEquals(observedTimeout, 12000);
    assertEquals(error.status, 504);
    assertEquals(error.code, "XERO_READ_TIMEOUT");
    assertEquals(calls, 1);
  } finally {
    AbortSignal.timeout = original;
  }
});

// Any accidental cache/database access fails, including reads that could hide
// a cache mutation behind a query builder. Token refresh is independently owned.
const noDatabase = new Proxy({}, {
  get() {
    throw new Error("The read module must not access business/cache tables");
  },
});

function fixture(result: unknown, tenantId = TENANT) {
  const calls: Array<
    { path: string; params?: Record<string, string>; tenant: string }
  > = [];
  let tokenReads = 0;
  return {
    calls,
    tokenReads: () => tokenReads,
    deps: {
      getToken: (client: unknown) => {
        assertStrictEquals(client, noDatabase);
        tokenReads++;
        return Promise.resolve({ accessToken: "fixture-only-token", tenantId });
      },
      xeroGet: (
        path: string,
        accessToken: string,
        tenant: string,
        params?: Record<string, string>,
      ) => {
        assertEquals(accessToken, "fixture-only-token");
        calls.push({ path, params, tenant });
        return Promise.resolve({
          data: result,
          metadata: EMPTY_RESPONSE_METADATA,
        });
      },
      now: () => new Date(NOW),
    },
  };
}

function invoice(extra: Record<string, unknown> = {}) {
  return {
    InvoiceID: ID,
    Type: "ACCREC",
    Status: "AUTHORISED",
    InvoiceNumber: "INV-FIXTURE",
    Contact: {
      ContactID: CONTACT,
      Name: "Fixture legal debtor",
      ContactPersons: [],
    },
    CurrencyCode: "AUD",
    Date: "/Date(1788134400000+0000)/",
    DueDateString: "2026-09-15T00:00:00",
    UpdatedDateUTCString: "2026-09-09T07:59:00",
    AmountDue: 55,
    AmountPaid: 40,
    AmountCredited: 5,
    Total: 100,
    Payments: [{ PaymentID: ID2, Amount: 40, Date: "2026-09-08" }],
    CreditNotes: [{ CreditNoteID: ID2, AppliedAmount: 5 }],
    Overpayments: [{ OverpaymentID: ID2 }],
    Prepayments: [{ PrepaymentID: ID2 }],
    LineItems: [{
      Description: "Fixture",
      Tracking: [{ Name: "Division", Option: "Roofing" }],
    }],
    ProviderFutureField: { retain: true },
    ...extra,
  };
}

Deno.test("organisation read preserves legal identity and provenance without database access", async () => {
  const organisations = [{
    OrganisationID: TENANT,
    Name: "Fixture Pty Ltd",
    LegalName: "Fixture Pty Ltd",
    BaseCurrency: "AUD",
    TaxNumber: "FIXTURE",
  }];
  const f = fixture({
    Organisations: organisations,
    Id: ID,
    DateTimeUTC: "provider-time",
  });
  const result = await readXeroOrganisation(noDatabase, {
    action: "read_xero_organisation",
  }, f.deps);
  assertStrictEquals(result.organisations, organisations);
  assertEquals(result.provenance, {
    source: "xero",
    tenant_id: TENANT,
    retrieved_at: NOW,
    method: "GET",
    path: "/Organisation",
    query: {},
    ...EMPTY_RESPONSE_METADATA,
    provider_response_id: ID,
    provider_date_time_utc: "provider-time",
    cache_used: false,
  });
  assertEquals(f.calls, [{
    path: "/Organisation",
    tenant: TENANT,
    params: undefined,
  }]);
  assertEquals(f.tokenReads(), 1);
  assertEquals(JSON.stringify(result).includes("fixture-only-token"), false);
});

Deno.test("tracking categories include archived options and retain provider fields", async () => {
  const categories = [{
    TrackingCategoryID: ID,
    Status: "ARCHIVED",
    Options: [{ TrackingOptionID: ID2, IsArchived: true }],
  }];
  const f = fixture({ TrackingCategories: categories });
  const result = await readXeroTrackingCategories(noDatabase, {}, f.deps);
  assertStrictEquals(result.tracking_categories, categories);
  assertEquals(f.calls[0], {
    path: "/TrackingCategories",
    tenant: TENANT,
    params: { includeArchived: "true" },
  });
});

Deno.test("point invoice read preserves all allocation, currency, dates and tracking data", async () => {
  const raw = invoice();
  const before = structuredClone(raw);
  const f = fixture({ Invoices: [raw] });
  const result = await getXeroReceivable(noDatabase, {
    xero_invoice_id: ID.toUpperCase(),
  }, f.deps);
  assertStrictEquals(result.invoice, raw);
  assertEquals(result.invoice, before);
  assertEquals(f.calls, [{
    path: `/Invoices/${ID}`,
    tenant: TENANT,
    params: undefined,
  }]);
  assertEquals(result.provenance.tenant_id, TENANT);
});

Deno.test("default list asks for one full provider page of positive AUTHORISED ACCREC", async () => {
  const raw = invoice();
  const f = fixture({ Invoices: [raw] });
  const result = await listXeroReceivables(noDatabase, {}, f.deps);
  assertEquals(f.calls[0].params, {
    where: 'Type=="ACCREC" AND Status=="AUTHORISED" AND AmountDue>0',
    page: "1",
    pageSize: "100",
    order: "InvoiceID ASC",
  });
  assertStrictEquals(result.invoices[0], raw);
  assertEquals(result.filters, {
    type: "ACCREC",
    status: "OUTSTANDING",
    contact_id: null,
  });
  assertEquals(result.pagination.has_more, false);
  assertEquals(result.pagination.next_page, null);
  assertEquals(result.pagination.end_of_results_observed, true);
  assertEquals(result.pagination.traversal_complete, false);
});

Deno.test("list status ALL and contact filter are explicit and page strings are validated", async () => {
  const f = fixture({ Invoices: [invoice({ Status: "PAID", AmountDue: 0 })] });
  const result = await listXeroReceivables(
    noDatabase,
    new URLSearchParams({
      status: "all",
      contact_id: CONTACT,
      page: "3",
      page_size: "1",
    }),
    f.deps,
  );
  assertEquals(f.calls[0].params, {
    where: 'Type=="ACCREC"',
    ContactIDs: CONTACT,
    page: "3",
    pageSize: "1",
    order: "InvoiceID ASC",
  });
  assertEquals(result.pagination.has_more, true);
  assertEquals(result.pagination.next_page, 4);
  assertEquals(result.pagination.end_of_results_observed, false);
});

Deno.test("exact status listing can include paid and voided history without inventing debt", async () => {
  for (
    const status of [
      "DRAFT",
      "SUBMITTED",
      "AUTHORISED",
      "PAID",
      "VOIDED",
      "DELETED",
    ]
  ) {
    const f = fixture({
      Invoices: [invoice({ Status: status, AmountDue: 0 })],
    });
    await listXeroReceivables(noDatabase, { status }, f.deps);
    assertEquals(
      f.calls[0].params?.where,
      `Type=="ACCREC" AND Status=="${status}"`,
    );
  }
});

Deno.test("full page requires continuation and an empty next page observes the end", async () => {
  const pages = fixture({ Invoices: [invoice(), invoice({ InvoiceID: ID2 })] });
  const result = await listXeroReceivables(
    noDatabase,
    { page_size: 2 },
    pages.deps,
  );
  assertEquals(result.pagination.has_more, true);
  assertEquals(result.pagination.next_page, 2);
  const empty = fixture({ Invoices: [] });
  const end = await listXeroReceivables(
    noDatabase,
    { page: 2, page_size: 2 },
    empty.deps,
  );
  assertEquals(end.pagination.has_more, false);
  assertEquals(end.pagination.count, 0);
  assertEquals(end.pagination.traversal_complete, false);
});

Deno.test("traversal cap remains incomplete even when no next page can be offered", async () => {
  const f = fixture({ Invoices: [invoice()] });
  const result = await listXeroReceivables(noDatabase, {
    page: 1_000_000,
    page_size: 1,
  }, f.deps);
  assertEquals(result.pagination.has_more, true);
  assertEquals(result.pagination.next_page, null);
  assertEquals(result.pagination.traversal_limit_reached, true);
  assertEquals(result.pagination.end_of_results_observed, false);
});

Deno.test("bad filters, UUIDs, duplicate and unknown parameters fail before credential lookup", async () => {
  const invalid = [
    { status: 'AUTHORISED" OR Type=="ACCPAY' },
    { status: ["ALL"] },
    { status: "" },
    { page: 0 },
    { page: -1 },
    { page: 1.5 },
    { page: true },
    { page: "1e2" },
    { page: "01" },
    { page: "" },
    { page: 1_000_001 },
    { page_size: 101 },
    { page_size: 0 },
    { page_size: "2.0" },
    { contact_id: "not-a-uuid" },
    { contact_id: `${CONTACT} OR true` },
    { tenant_id: TENANT },
    { where: "true" },
    new URLSearchParams("page=1&page=2"),
  ];
  for (const params of invalid) {
    const f = fixture({ Invoices: [] });
    await assertRejects(
      () => listXeroReceivables(noDatabase, params, f.deps),
      XeroReceivablesReadError,
    );
    assertEquals(f.tokenReads(), 0);
    assertEquals(f.calls, []);
  }
  const f = fixture({ Invoices: [] });
  for (const xero_invoice_id of [undefined, "../Contacts", ID + "/Email", 1]) {
    await assertRejects(
      () => getXeroReceivable(noDatabase, { xero_invoice_id }, f.deps),
      XeroReceivablesReadError,
    );
  }
  assertEquals(f.tokenReads(), 0);
});

Deno.test("invalid server tenant fails closed before provider lookup", async () => {
  const f = fixture({ Organisations: [] }, "invalid-tenant");
  const error = await assertRejects(
    () => readXeroOrganisation(noDatabase, {}, f.deps),
    XeroReceivablesReadError,
  );
  assertEquals(error.code, "XERO_TENANT_INVALID");
  assertEquals(f.calls, []);
});

Deno.test("point read refuses supplier invoice, missing record and mismatched identity", async () => {
  for (
    const [response, expected] of [
      [{ Invoices: [invoice({ Type: "ACCPAY" })] }, "NOT_ACCREC"],
      [{ Invoices: [] }, "XERO_RECORD_NOT_FOUND"],
      [{ Invoices: [invoice({ InvoiceID: ID2 })] }, "XERO_RECORD_MISMATCH"],
      [{ Invoices: [invoice(), invoice()] }, "XERO_RECORD_MISMATCH"],
      [{ ErrorNumber: 10 }, "XERO_RESPONSE_INVALID"],
    ] as const
  ) {
    const f = fixture(response);
    const error = await assertRejects(
      () => getXeroReceivable(noDatabase, { xero_invoice_id: ID }, f.deps),
      XeroReceivablesReadError,
    );
    assertEquals(error.code, expected);
  }
});

Deno.test("provider filter violations and malformed/duplicate pages are errors, never filtered success", async () => {
  const responses = [
    { Invoices: [invoice({ Type: "ACCPAY" })] },
    { Invoices: [invoice({ Status: "VOIDED" })] },
    { Invoices: [invoice({ AmountDue: 0 })] },
    { Invoices: [invoice({ Contact: { ContactID: ID2 } })] },
    { Invoices: [invoice({ InvoiceID: "invalid" })] },
    { Invoices: [invoice(), invoice()] },
    { Invoices: [null] },
    {},
  ];
  for (const response of responses) {
    const f = fixture(response);
    await assertRejects(
      () => listXeroReceivables(noDatabase, { contact_id: CONTACT }, f.deps),
      XeroReceivablesReadError,
    );
  }
  const tooMany = fixture({
    Invoices: [invoice(), invoice({ InvoiceID: ID2 })],
  });
  await assertRejects(
    () => listXeroReceivables(noDatabase, { page_size: 1 }, tooMany.deps),
    XeroReceivablesReadError,
    "exceeded",
  );
});

const settlementCases = [
  {
    kind: "payment",
    collection: "Payments",
    idField: "PaymentID",
    typeField: "PaymentType",
    type: "ACCRECPAYMENT",
    wrong: "ACCPAYPAYMENT",
  },
  {
    kind: "credit_note",
    collection: "CreditNotes",
    idField: "CreditNoteID",
    typeField: "Type",
    type: "ACCRECCREDIT",
    wrong: "ACCPAYCREDIT",
  },
  {
    kind: "overpayment",
    collection: "Overpayments",
    idField: "OverpaymentID",
    typeField: "Type",
    type: "RECEIVE-OVERPAYMENT",
    wrong: "SPEND-OVERPAYMENT",
  },
  {
    kind: "prepayment",
    collection: "Prepayments",
    idField: "PrepaymentID",
    typeField: "Type",
    type: "RECEIVE-PREPAYMENT",
    wrong: "SPEND-PREPAYMENT",
  },
];

for (const c of settlementCases) {
  Deno.test(`${c.kind} detail preserves raw settlement and allocations without writes`, async () => {
    const raw = {
      [c.idField]: ID,
      [c.typeField]: c.type,
      CurrencyCode: "USD",
      CurrencyRate: 0.65,
      Date: "2026-09-08",
      Amount: 5,
      RemainingCredit: 10,
      Allocations: [{ Invoice: { InvoiceID: ID2 }, AppliedAmount: 5 }],
      Payments: [{ PaymentID: ID2 }],
      ProviderFutureField: true,
    };
    const f = fixture({ [c.collection]: [raw] });
    const result = await readXeroSettlementRecord(noDatabase, {
      record_type: c.kind,
      record_id: ID,
    }, f.deps);
    assertStrictEquals(result.record, raw);
    assertEquals(result.record_type, c.kind);
    assertEquals(f.calls, [{
      path: `/${c.collection}/${ID}`,
      params: undefined,
      tenant: TENANT,
    }]);
  });

  Deno.test(`${c.kind} list is one page with receivable-only query and honest continuation`, async () => {
    const raw = { [c.idField]: ID, [c.typeField]: c.type };
    const f = fixture({ [c.collection]: [raw] });
    const result = await listXeroSettlementRecords(noDatabase, {
      record_type: c.kind,
      page: 2,
      page_size: 1,
    }, f.deps);
    assertStrictEquals(result.records[0], raw);
    assertEquals(result.pagination.next_page, 3);
    assertEquals(
      f.calls[0].params?.where.includes(`${c.typeField}=="${c.type}"`),
      true,
    );
    assertEquals(f.calls[0].params?.page, "2");
    assertEquals(f.calls[0].params?.pageSize, "1");
    assertEquals(f.calls[0].tenant, TENANT);
  });

  Deno.test(`${c.kind} cannot return a payable record through point or list reads`, async () => {
    const f = fixture({
      [c.collection]: [{ [c.idField]: ID, [c.typeField]: c.wrong }],
    });
    await assertRejects(
      () =>
        readXeroSettlementRecord(noDatabase, {
          record_type: c.kind,
          record_id: ID,
        }, f.deps),
      XeroReceivablesReadError,
      "not a receivables",
    );
    await assertRejects(
      () =>
        listXeroSettlementRecords(noDatabase, { record_type: c.kind }, f.deps),
      XeroReceivablesReadError,
      "not a receivables",
    );
  });
}

Deno.test("settlement selector refuses injection, invalid UUID and caller tenant before auth", async () => {
  const f = fixture({});
  for (
    const params of [
      { record_type: "../Invoices", record_id: ID },
      { record_type: "__proto__", record_id: ID },
      { record_type: "payment", record_id: ID + "/History" },
      { record_type: "payment", record_id: ID, tenant_id: TENANT },
    ]
  ) {
    await assertRejects(
      () => readXeroSettlementRecord(noDatabase, params, f.deps),
      XeroReceivablesReadError,
    );
  }
  assertEquals(f.tokenReads(), 0);
});

Deno.test("receivable refunds are preserved but contradictory payable invoice is refused", async () => {
  for (
    const PaymentType of [
      "ARCREDITPAYMENT",
      "AROVERPAYMENTPAYMENT",
      "ARPREPAYMENTPAYMENT",
    ]
  ) {
    const f = fixture({ Payments: [{ PaymentID: ID, PaymentType }] });
    const result = await readXeroSettlementRecord(noDatabase, {
      record_type: "payment",
      record_id: ID,
    }, f.deps);
    assertEquals(result.record.PaymentType, PaymentType);
  }
  const bad = fixture({
    Payments: [{
      PaymentID: ID,
      PaymentType: "ACCRECPAYMENT",
      Invoice: { Type: "ACCPAY" },
    }],
  });
  await assertRejects(
    () =>
      readXeroSettlementRecord(noDatabase, {
        record_type: "payment",
        record_id: ID,
      }, bad.deps),
    XeroReceivablesReadError,
    "not an accounts receivable",
  );
});

Deno.test("settlement list rejects duplicate identities and observes empty end page", async () => {
  const raw = { PaymentID: ID, PaymentType: "ACCRECPAYMENT" };
  const duplicate = fixture({ Payments: [raw, raw] });
  await assertRejects(
    () =>
      listXeroSettlementRecords(
        noDatabase,
        { record_type: "payment" },
        duplicate.deps,
      ),
    XeroReceivablesReadError,
    "duplicate",
  );
  const empty = fixture({ Payments: [] });
  const result = await listXeroSettlementRecords(noDatabase, {
    record_type: "payment",
    page: 4,
  }, empty.deps);
  assertEquals(result.pagination.has_more, false);
  assertEquals(result.pagination.end_of_results_observed, true);
});

Deno.test("credential and provider failures propagate instead of empty successful datasets", async () => {
  const operations = [
    () => readXeroOrganisation(noDatabase, {}, f.deps),
    () => readXeroTrackingCategories(noDatabase, {}, f.deps),
    () => listXeroReceivables(noDatabase, {}, f.deps),
    () => getXeroReceivable(noDatabase, { xero_invoice_id: ID }, f.deps),
    () =>
      listXeroSettlementRecords(noDatabase, { record_type: "payment" }, f.deps),
    () =>
      readXeroSettlementRecord(noDatabase, {
        record_type: "payment",
        record_id: ID,
      }, f.deps),
  ];
  const f = fixture({});
  const failure = new Error("Fixture provider unavailable (429)");
  f.deps.xeroGet = () => Promise.reject(failure);
  for (const operation of operations) {
    assertStrictEquals(await assertRejects(operation), failure);
  }
  f.deps.getToken = () => Promise.reject(failure);
  assertStrictEquals(await assertRejects(operations[0]), failure);
});
