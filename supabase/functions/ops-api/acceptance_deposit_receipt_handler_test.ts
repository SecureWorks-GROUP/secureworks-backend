// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
// The actual acceptance invoice function with captured persistence/provider transports.
// Existing create/status behavior is observed, never dispatched to a live service.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
const ORG = "00000000-0000-0000-0000-000000000001";
const id = (n: number) => `88000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const JOB = id(1), DOC = id(2), REV = id(3), PAYER = id(4), INVOICE = id(5);
const amount = Math.round(Math.PI * 100) / 100;
const savedEnv = new Map(
  ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "XERO_CLIENT_ID"].map((
    k,
  ) => [k, Deno.env.get(k)]),
);
Deno.env.set("SUPABASE_URL", "https://receipt.fixture.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service");
Deno.env.set("XERO_CLIENT_ID", "synthetic-client");
const runtime = await import("./index.ts");
for (const [k, v] of savedEnv) {
  if (v === undefined) Deno.env.delete(k);
  else Deno.env.set(k, v);
}
function harness(
  options: {
    oldProvider?: boolean;
    preReadFails?: boolean;
    readMismatch?: boolean;
    staleAcceptance?: boolean;
    putTimeout?: boolean;
    docSent?: string;
  } = {},
) {
  const raw = {
    pricing_complete: true,
    totalIncGST: amount * 2,
    deposit: { percent: 50, total_deposit_inc_gst: amount },
    payment_schedule: {
      version: 1,
      payments: [
        {
          id: "deposit",
          label: "Deposit",
          printed_terms: "On acceptance",
          amount_inc_gst: amount,
        },
        {
          id: "later",
          label: "Later",
          printed_terms: "Later",
          amount_inc_gst: amount,
        },
      ],
    },
  };
  const tables: Record<string, any[]> = {
    jobs: [{
      id: JOB,
      org_id: ORG,
      type: "patio",
      status: "accepted",
      job_number: "SWP-FIXTURE",
      client_name: "Synthetic",
      client_email: "",
      client_phone: "",
      site_address: "Synthetic site",
      site_suburb: "Synthetic suburb",
      xero_contact_id: PAYER,
      pricing_json: { totalIncGST: amount * 200 },
      metadata: {},
    }],
    job_contacts: [],
    makesafe_job_details: [],
    scope_revisions: [],
    job_documents: [{
      id: DOC,
      job_id: JOB,
      type: "quote",
      quote_revision_id: REV,
      accepted_at: options.staleAcceptance ? "2026-11-01T00:00:00Z" : "2026-11-04T00:00:00Z",
      sent_at: options.docSent ?? "2026-11-03T00:00:00Z",
      superseded_at: null,
      job_contact_id: null,
      run_label: null,
    }],
    quote_revisions: [{
      id: REV,
      job_id: JOB,
      job_document_id: DOC,
      sent_at: "2026-11-03T00:00:00Z",
      pricing_snapshot_json: { raw },
    }],
    quote_invoice_billing_bindings: [{
      quote_revision_id: REV,
      org_id: ORG,
      job_id: JOB,
      xero_contact_id: PAYER,
      state: "eligible",
    }],
    quote_invoice_deposit_receipts: [],
    xero_invoices: [],
    job_events: [],
    business_events: [],
    xero_tokens: [{
      org_id: ORG,
      access_token: "synthetic-token",
      tenant_id: "synthetic-tenant",
      expires_at: "2099-01-01T00:00:00Z",
    }],
  };
  const client: any = {
    rpc: async () => ({ data: {}, error: null }),
    from(table: string) {
      tables[table] ??= [];
      const filters: ((r: any) => boolean)[] = [];
      let op = "select", payload: any;
      const q: any = {
        or() {
          return q;
        },
        select() {
          return q;
        },
        order() {
          return q;
        },
        limit() {
          return q;
        },
        eq(k: string, v: any) {
          filters.push((r) => r[k] === v);
          return q;
        },
        in(k: string, values: any[]) {
          filters.push((r) => values.includes(r[k]));
          return q;
        },
        is(k: string, v: any) {
          filters.push((r) => (r[k] ?? null) === v);
          return q;
        },
        not(k: string, operator: string, v: any) {
          if (operator === "is") filters.push((r) => r[k] != v);
          else if (operator === "in") {
            filters.push((r) => !["VOIDED", "DELETED"].includes(r[k]));
          }
          return q;
        },
        ilike(k: string) {
          filters.push((r) => String(r[k] || "").includes("DEP"));
          return q;
        },
        insert(v: any) {
          op = "insert";
          payload = v;
          return q;
        },
        upsert(v: any) {
          op = "upsert";
          payload = v;
          return q;
        },
        update(v: any) {
          op = "update";
          payload = v;
          return q;
        },
        execute(single: boolean) {
          const matches = tables[table].filter((r) => filters.every((f) => f(r)));
          if (op === "update") {
            matches.forEach((r) => Object.assign(r, payload));
          }
          if (op === "insert" || op === "upsert") {
            for (const row of Array.isArray(payload) ? payload : [payload]) {
              const same = op === "upsert"
                ? tables[table].find((r) => r.xero_invoice_id && r.xero_invoice_id === row.xero_invoice_id)
                : null;
              if (same) Object.assign(same, row);
              else tables[table].push(structuredClone(row));
            }
          }
          return { data: single ? matches[0] ?? null : matches, error: null };
        },
        async single() {
          return q.execute(true);
        },
        async maybeSingle() {
          return q.execute(true);
        },
        then(resolve: (r: any) => any) {
          return Promise.resolve(q.execute(false)).then(resolve);
        },
      };
      return q;
    },
  };
  let provider: any = options.oldProvider
    ? {
      InvoiceID: INVOICE,
      Type: "ACCREC",
      Status: "AUTHORISED",
      Contact: { ContactID: PAYER },
      CurrencyCode: "AUD",
      Total: amount,
      Reference: "SWP-FIXTURE-DEP50",
    }
    : null;
  const calls: { method: string; path: string }[] = [];
  const fetch = async (input: Request | URL | string, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input)),
      method = init?.method || "GET";
    calls.push({ method, path: url.pathname });
    if (
      url.origin === "https://receipt.fixture.invalid" &&
      url.pathname === "/rest/v1/org_config"
    ) return Response.json(null);
    if (url.origin !== "https://api.xero.com") {
      throw Error("No other provider or send is permitted");
    }
    if (url.pathname.endsWith("/TrackingCategories")) {
      return Response.json({ TrackingCategories: [] });
    }
    if (url.pathname.endsWith("/Invoices") && method === "GET") {
      if (options.preReadFails) {
        return Response.json({ error: "unknown" }, { status: 500 });
      }
      const invoices = provider ? [provider] : [];
      return Response.json({
        Invoices: invoices,
        pagination: {
          page: 1,
          pageSize: 100,
          pageCount: invoices.length ? 1 : 0,
          itemCount: invoices.length,
        },
      });
    }
    if (url.pathname.endsWith("/Invoices") && method === "PUT") {
      const body = JSON.parse(String(init?.body));
      assertEquals(body.Invoices[0].Status, "AUTHORISED");
      assertEquals(body.Invoices[0].LineAmountTypes, "Inclusive");
      if (!provider) {
        provider = {
          ...body.Invoices[0],
          InvoiceID: INVOICE,
          InvoiceNumber: "INV-SYNTHETIC",
          Total: amount,
          CurrencyCode: "AUD",
          AmountDue: amount,
          AmountPaid: 0,
        };
      }
      if (options.putTimeout) throw Error("Provider accepted but create response is unknown");
      return Response.json({ Invoices: [provider] });
    }
    if (url.pathname.endsWith(`/Invoices/${INVOICE}/OnlineInvoice`)) {
      return Response.json({
        OnlineInvoices: [{
          OnlineInvoiceUrl: "https://invoice.example.invalid",
        }],
      });
    }
    if (url.pathname.endsWith(`/Invoices/${INVOICE}`)) {
      return Response.json({
        Invoices: [{
          ...provider,
          ...(options.readMismatch ? { Total: amount + 1 } : {}),
        }],
      });
    }
    throw Error(
      "Unexpected provider method/path " + method + " " + url.pathname,
    );
  };
  return { client, tables, fetch, calls };
}
Deno.test("actual acceptance deposit captures exact metadata only; legacy reuse and uncertainty remain unbound without changing the existing effect", async (t) => {
  for (
    const [name, options, expected] of [
      ["fresh exact dispatch", {}, "captured"],
      ["legacy returned id already exists without receipt", {
        oldProvider: true,
      }, "held"],
      ["provider pre-read unavailable", { preReadFails: true }, "held"],
      ["gross read-back mismatch", { readMismatch: true }, "held"],
      ["old acceptance cannot bind a newer same-document release", {
        staleAcceptance: true,
      }, "held"],
      ["future document send cannot borrow old acceptance", { docSent: "2026-11-05T00:00:00Z" }, "held"],
      ["malformed document send cannot bind", { docSent: "malformed" }, "held"],
    ] as const
  ) {
    await t.step(name, async () => {
      const h = harness(options),
        before = globalThis.fetch,
        beforeLog = console.log;
      globalThis.fetch = h.fetch;
      console.log = () => {};
      try {
        const result = await runtime._sendAcceptanceInvoiceForTest(h.client, {
          job_id: JOB,
          job_document_id: DOC,
          notify_client: false,
        });
        assertEquals(result.success, true);
        assertEquals(result.deposit_receipt.state, expected);
        assertEquals(
          h.calls.filter((r) => r.method === "PUT" && r.path.endsWith("/Invoices")).length,
          1,
        );
        assertEquals(
          h.calls.filter((r) => /Email|Contacts/.test(r.path)).length,
          0,
        );
        assertEquals(
          h.tables.quote_invoice_deposit_receipts.length,
          expected === "captured" ? 1 : 0,
        );
        assertEquals(result.branded_email_sent, false);
        assert(
          h.tables.jobs[0].pricing_json.totalIncGST !== amount * 2,
          "mutable pricing must remain distinct from frozen receipt authority",
        );
      } finally {
        globalThis.fetch = before;
        console.log = beforeLog;
      }
    });
  }
});

Deno.test("actual acceptance create timeout never fabricates a deposit receipt or retries its PUT", async () => {
  const h = harness({ putTimeout: true }), before = globalThis.fetch, beforeLog = console.log;
  globalThis.fetch = h.fetch;
  console.log = () => {};
  try {
    await assertRejects(() =>
      runtime._sendAcceptanceInvoiceForTest(h.client, { job_id: JOB, job_document_id: DOC, notify_client: false })
    );
    assertEquals(h.calls.filter((r) => r.method === "PUT" && r.path.endsWith("/Invoices")).length, 1);
    assertEquals(h.tables.quote_invoice_deposit_receipts.length, 0);
    assertEquals(h.calls.filter((r) => /Email|Contacts/.test(r.path)).length, 0);
  } finally {
    globalThis.fetch = before;
    console.log = beforeLog;
  }
});
