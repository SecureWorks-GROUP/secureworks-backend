// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  genericInvoiceIdempotencyKey,
  rejectedInvoiceEmailStatus,
} from "./invoice_create_contract.ts";

const savedServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const savedSupabaseUrl = Deno.env.get("SUPABASE_URL");
const savedXeroClientId = Deno.env.get("XERO_CLIENT_ID");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fixture-service-key");
Deno.env.set("SUPABASE_URL", "https://fixture.supabase.test");
Deno.env.set("XERO_CLIENT_ID", "fixture-client-id");
const {
  _createInvoiceForTest: createInvoice,
  _createMakesafeDraftInvoiceForTest: createMakesafeDraftInvoice,
  _makesafeDraftIdempotencyKey,
  _updateJobStatus: updateJobStatus,
  _xeroPostForTest: xeroPost,
} = await import("./index.ts");
if (savedServiceKey === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", savedServiceKey);
if (savedSupabaseUrl === undefined) Deno.env.delete("SUPABASE_URL");
else Deno.env.set("SUPABASE_URL", savedSupabaseUrl);
if (savedXeroClientId === undefined) Deno.env.delete("XERO_CLIENT_ID");
else Deno.env.set("XERO_CLIENT_ID", savedXeroClientId);

const JOB_ID = "10000000-0000-4000-8000-000000000001";
function fixtureClient() {
  const events: any[] = [];
  const job = {
    id: JOB_ID,
    type: "fencing",
    status: "quoted",
    job_number: "SWF-TEST-1",
    client_name: "Fixture Client",
    site_address: "Fixture site",
    site_suburb: "Fixture",
    pricing_json: {},
    payment_terms: null,
    metadata: {},
    ghl_opportunity_id: "fixture-opportunity",
  };
  const client = {
    from(table: string) {
      let updated = {};
      let selectedId: string | null = null;
      const single = () =>
        table === "jobs" ? { ...job, ...updated } : table === "xero_tokens"
          ? {
            access_token: "fixture-token",
            tenant_id: "fixture-tenant",
            expires_at: "2099-01-01T00:00:00Z",
          }
          : table === "job_contacts" && selectedId
          ? {
            id: selectedId,
            client_name: "Fixture Billing Contact",
            xero_contact_id: "fixture-contact",
          }
          : null;
      const response = () => ({
        data: table === "jobs"
          ? [job]
          : table === "xero_tokens"
          ? single()
          : [],
        error: null,
      });
      const b: any = {
        select: () => b,
        eq: (field: string, value: string) => {
          if (field === "id") selectedId = value;
          return b;
        },
        in: () => b,
        is: () => b,
        not: () => b,
        or: () => b,
        order: () => b,
        limit: () => b,
        range: () => b,
        update: (value: any) => {
          updated = value;
          return b;
        },
        insert: (value: any) => {
          if (table === "job_events") events.push(value);
          return b;
        },
        upsert: () => b,
        maybeSingle: () => Promise.resolve({ data: single(), error: null }),
        single: () => Promise.resolve({ data: single(), error: null }),
        then: (resolve: any, reject: any) =>
          Promise.resolve(response()).then(resolve, reject),
      };
      return b;
    },
  };
  return { client, events };
}
const invoiceBody = () => ({
  job_id: JOB_ID,
  contact_name: "Fixture Client",
  xero_contact_id: "fixture-contact",
  reference: "FIXTURE-REF",
  due_date: "2026-10-01",
  run_label: "final",
  line_items: [{ description: "Fixture work", quantity: 1, unit_price: 100 }],
  send_email: false,
});

async function atTime<T>(timestamp: string, fn: () => Promise<T>) {
  const OriginalDate = globalThis.Date;
  const now = OriginalDate.parse(timestamp);
  class FixedDate extends OriginalDate {
    constructor(value?: string | number) {
      super(value === undefined ? now : value);
    }
    static override now() {
      return now;
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = OriginalDate;
  }
}

function providerFixture(
  email:
    | "accepted"
    | "failed"
    | "unknown"
    | "partial"
    | "blocked"
    | "guard_unavailable" = "accepted",
) {
  const original = globalThis.fetch;
  const creates: { key: string | null; body: any }[] = [];
  let emails = 0;
  globalThis.fetch = (input, init) => {
    const url = String(input);
    if (url.startsWith("https://fixture.supabase.test/rest/v1/org_config")) {
      if (creates.length > 0 && email === "guard_unavailable") {
        return Promise.resolve(
          Response.json({ message: "fixture unavailable" }, { status: 503 }),
        );
      }
      if (creates.length > 0 && email === "blocked") {
        return Promise.resolve(Response.json([{
          config_value: {
            version: 1,
            revision: "fixture-revision",
            blocked_until: "2099-01-01T00:00:00.000Z",
            observation: {
              provider_status: 429,
              request_id: "fixture-request",
            },
            probe: null,
          },
        }]));
      }
      return Promise.resolve(Response.json([]));
    }
    if (url.includes("/TrackingCategories")) {
      return Promise.resolve(Response.json({ TrackingCategories: [] }));
    }
    if (url.endsWith("/Invoices") && init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      creates.push({
        key: new Headers(init.headers).get("Idempotency-Key"),
        body,
      });
      return Promise.resolve(
        Response.json({
          Invoices: [{
            ...body.Invoices[0],
            InvoiceID: "fixture-invoice",
            InvoiceNumber: "INV-FIXTURE",
            SubTotal: 100,
            TotalTax: 10,
            Total: 110,
          }],
        }),
      );
    }
    if (url.endsWith("/Email")) {
      emails++;
      if (email === "unknown") {
        return Promise.reject(
          new DOMException("response timed out", "TimeoutError"),
        );
      }
      if (email === "partial") {
        return Promise.resolve(new Response('{"partial":'));
      }
      if (email === "failed") {
        return Promise.resolve(
          Response.json({ error: "rejected" }, { status: 400 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  return {
    creates,
    emailCalls: () => emails,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

Deno.test("generic invoice retry keeps one payload key across a minute boundary", async () => {
  const provider = providerFixture();
  try {
    await atTime(
      "2026-09-09T04:00:59Z",
      () => createInvoice(fixtureClient().client, invoiceBody()),
    );
    await atTime(
      "2026-09-09T04:01:01Z",
      () => createInvoice(fixtureClient().client, invoiceBody()),
    );
    assertEquals(provider.creates.length, 2);
    assertEquals(provider.creates[0].body, provider.creates[1].body);
    assertEquals(provider.creates[0].key, provider.creates[1].key);
    assertMatch(provider.creates[0].key!, /^inv-[a-f0-9]{32}$/);
  } finally {
    provider.restore();
  }
});

Deno.test("public invoice key overrides are ignored while internal makesafe key is preserved", async () => {
  const provider = providerFixture();
  try {
    await createInvoice(fixtureClient().client, invoiceBody());
    await createInvoice(fixtureClient().client, {
      ...invoiceBody(),
      idempotency_key: "caller-key",
      makesafe_idempotency_key: "caller-collision",
    });
    assertEquals(provider.creates[0].key, provider.creates[1].key);
    const result = await createInvoice(fixtureClient().client, {
      ...invoiceBody(),
      send_email: true,
    }, {
      makesafeIdempotencyKey: "fixture-server-key",
      captainLock: { decision_key: "fixture-lock" },
    });
    assertEquals(provider.creates[2].key, "fixture-server-key");
    assertEquals(provider.creates[2].body.Invoices[0].Status, "DRAFT");
    assertEquals(provider.emailCalls(), 0);
    assertEquals(result.email_status, "not_requested");
    assertEquals(result.emailed, false);
  } finally {
    provider.restore();
  }
});

Deno.test("material invoice changes get a different payload key", async () => {
  const provider = providerFixture();
  try {
    await createInvoice(fixtureClient().client, invoiceBody());
    await createInvoice(fixtureClient().client, {
      ...invoiceBody(),
      line_items: [{
        description: "Fixture work",
        quantity: 1,
        unit_price: 200,
      }],
    });
    assertNotEquals(provider.creates[0].key, provider.creates[1].key);
  } finally {
    provider.restore();
  }
});

for (const email of ["accepted", "failed", "unknown", "partial"] as const) {
  Deno.test(`invoice email ${email} is truthful in result and event without retrying`, async () => {
    const provider = providerFixture(email);
    const { client, events } = fixtureClient();
    try {
      const result = await createInvoice(client, {
        ...invoiceBody(),
        send_email: true,
      });
      assertEquals(result.success, true);
      assertEquals(provider.emailCalls(), 1);
      const expected = email === "partial" ? "unknown" : email;
      assertEquals(result.email_status, expected);
      assertEquals(
        result.emailed,
        expected === "unknown" ? null : expected === "accepted",
      );
      const event = events.find((row) => row.event_type === "invoice_created");
      assertEquals(event.detail_json.email_status, expected);
      assertEquals(event.detail_json.emailed, result.emailed);
    } finally {
      provider.restore();
    }
  });
}

Deno.test("an invoice create 204 cannot fabricate a created invoice", async () => {
  await assertRejects(() =>
    xeroPost(
      "/Invoices",
      "fixture-token",
      "fixture-tenant",
      { Invoices: [] },
      "PUT",
      "fixture-key",
      () => Promise.resolve(new Response(null, { status: 204 })),
    )
  );
});

Deno.test("two resolved job billing contacts sharing a Xero contact get different keys", async () => {
  const provider = providerFixture();
  try {
    await createInvoice(fixtureClient().client, {
      ...invoiceBody(),
      job_contact_id: "fixture-billing-one",
    });
    await createInvoice(fixtureClient().client, {
      ...invoiceBody(),
      job_contact_id: "fixture-billing-two",
    });
    assertEquals(provider.creates[0].body, provider.creates[1].body);
    assertNotEquals(provider.creates[0].key, provider.creates[1].key);
  } finally {
    provider.restore();
  }
});

for (const refusal of ["blocked", "guard_unavailable"] as const) {
  Deno.test(`invoice email ${refusal} retains created identity and structured refusal without a send`, async () => {
    const provider = providerFixture(refusal);
    const { client, events } = fixtureClient();
    try {
      const result: any = await createInvoice(client, {
        ...invoiceBody(),
        send_email: true,
      });
      assertEquals(result.success, true);
      assertEquals(result.xero_invoice_id, "fixture-invoice");
      assertEquals(result.email_status, "failed");
      assertEquals(result.emailed, false);
      assertEquals(result.email_error.provider_call_made, false);
      assertEquals(result.email_error.xero_invoice_id, result.xero_invoice_id);
      assertEquals(result.email_error.invoice_number, "INV-FIXTURE");
      assertEquals(
        result.email_error.code,
        refusal === "blocked"
          ? "XERO_COOLDOWN_ACTIVE"
          : "XERO_GUARD_UNAVAILABLE",
      );
      if (refusal === "blocked") {
        assertEquals(result.email_error.retry_at, "2099-01-01T00:00:00.000Z");
      }
      assertEquals(provider.emailCalls(), 0);
      assertEquals(provider.creates.length, 1);
      assertEquals(
        events.find((event) => event.event_type === "invoice_created")
          .detail_json.email_error,
        result.email_error,
      );
    } finally {
      provider.restore();
    }
  });
}

Deno.test("invoice keys isolate tenant, org, job, contact, run and reference", async () => {
  const scope = {
    orgId: "org-one",
    tenantId: "tenant-one",
    jobId: "job-one",
    contactId: "contact-one",
    jobContactId: "billing-contact-one",
    runLabel: "final",
    reference: "ref-one",
    invoice: { Invoices: [{ Total: 110, Reference: "ref-one" }] },
  };
  const key = await genericInvoiceIdempotencyKey(scope);
  for (
    const field of [
      "orgId",
      "tenantId",
      "jobId",
      "contactId",
      "jobContactId",
      "runLabel",
      "reference",
    ] as const
  ) {
    assertNotEquals(
      await genericInvoiceIdempotencyKey({ ...scope, [field]: "other" }),
      key,
      field,
    );
  }
  assertEquals(
    await genericInvoiceIdempotencyKey({
      ...scope,
      invoice: { Invoices: [{ Reference: "ref-one", Total: 110 }] },
    }),
    key,
  );
});

Deno.test("email transport and server uncertainty stay unknown while explicit rejection is failed", () => {
  for (
    const error of [
      new Error("network lost"),
      new SyntaxError("partial JSON"),
      new Error("Xero API /Invoices/fixture/Email failed (408): timeout"),
      new Error("Xero API /Invoices/fixture/Email failed (503): unavailable"),
    ]
  ) {
    assertEquals(rejectedInvoiceEmailStatus(error), "unknown");
  }
  assertEquals(rejectedInvoiceEmailStatus({ status: 429 }), "failed");
  assertEquals(
    rejectedInvoiceEmailStatus(
      new Error("Xero validation error: not authorised"),
    ),
    "failed",
  );
});

Deno.test("makesafe draft caller passes its stable server key outside the untrusted body", async () => {
  const calls: any[] = [];
  const result = await createMakesafeDraftInvoice(fixtureClient().client, {
    ...invoiceBody(),
    makesafe_idempotency_key: "caller-collision",
    send_email: true,
    xero_status: "AUTHORISED",
  }, {
    assertPortalVerified: () => Promise.resolve(),
    fetchAllAccrecInvoices: () => Promise.resolve([]),
    createInvoiceFn: (_client, body, internal) => {
      calls.push({ body, internal });
      return Promise.resolve({
        success: true,
        xero_invoice_id: "fixture-invoice",
        invoice_number: "INV-FIXTURE",
        total: 110,
      });
    },
  });
  assertEquals(result.success, true);
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].internal.makesafeIdempotencyKey,
    _makesafeDraftIdempotencyKey(JOB_ID, "FIXTURE-REF"),
  );
  assertEquals(calls[0].body.makesafe_idempotency_key, undefined);
  assertEquals(calls[0].body.send_email, false);
  assertEquals(calls[0].body.xero_status, "DRAFT");
});

Deno.test("SES invoice retains its obligation key, DRAFT status and no-email guard", async () => {
  const provider = providerFixture();
  try {
    const result = await createInvoice(fixtureClient().client, {
      ...invoiceBody(),
      send_email: true,
      xero_status: "AUTHORISED",
    }, {
      ses: {
        obligationRevisionId: "fixture-obligation",
        externalToken: "fixture-external",
        operationKey: "fixture-operation",
      },
    });
    assertEquals(
      provider.creates[0].key,
      "ses-invoice-create-fixture-obligation",
    );
    assertEquals(provider.creates[0].body.Invoices[0].Status, "DRAFT");
    assertEquals(provider.emailCalls(), 0);
    assertEquals(result.email_status, "not_requested");
    assertEquals(result.emailed, false);
  } finally {
    provider.restore();
  }
});

Deno.test("job status GHL push authenticates and makes HTTP 401 observable without failing the status update", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs: string[] = [];
  const requests: RequestInit[] = [];
  const { client, events } = fixtureClient();
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  globalThis.fetch = (input, init) => {
    if (String(input).includes("ghl-proxy?action=move_stage")) {
      requests.push(init || {});
      return Promise.resolve(
        Response.json({ error: "Unauthorized" }, { status: 401 }),
      );
    }
    return Promise.resolve(Response.json({}));
  };
  try {
    const result = await updateJobStatus(client, {
      job_id: JOB_ID,
      status: "processing",
    });
    assertEquals(result.success, true);
    assertEquals(result.new_status, "processing");
    assertEquals(requests.length, 1);
    assertEquals(
      new Headers(requests[0].headers).get("Authorization"),
      "Bearer fixture-service-key",
    );
    assertEquals(
      events.some((row) => row.event_type === "ghl_stage_synced"),
      false,
    );
    assertMatch(logs.join("\n"), /GHL stage sync failed.*HTTP 401/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});
