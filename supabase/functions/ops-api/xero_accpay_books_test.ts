// deno-lint-ignore-file no-import-prefix no-explicit-any

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildAccpayLineItems,
  clampBillPageSize,
  buildSupplierBillWhere,
  createSupplierBill,
  createSupplierCreditNote,
  getSupplierBill,
  getXeroInvoice,
  listSupplierBills,
  mapSupplierBillStatusFilter,
  SupplierBillError,
  updateSupplierBill,
} from "./xero_accpay_books.ts";
import { XeroPdfAttachError } from "./xero_attachment.ts";

const PDF_B64 = btoa("%PDF-1.4\n");

function makeClient() {
  return {
    from() {
      return {
        upsert: async () => ({ error: null }),
      };
    },
  };
}

Deno.test("status filter maps Books wording onto Xero ACCPAY statuses", () => {
  assertEquals(mapSupplierBillStatusFilter("draft"), "DRAFT");
  assertEquals(mapSupplierBillStatusFilter("awaiting payment"), "AUTHORISED");
  assertEquals(mapSupplierBillStatusFilter("awaiting_payment"), "AUTHORISED");
  assertEquals(mapSupplierBillStatusFilter("paid"), "PAID");
});

Deno.test("supplier bill where-clause is ACCPAY-only and null-guards optional fields", () => {
  assertEquals(
    buildSupplierBillWhere({ status: "DRAFT", contactName: "Israel" }),
    'Type=="ACCPAY" AND Status=="DRAFT" AND Contact.Name!=null AND Contact.Name.Contains("Israel")',
  );
  assertEquals(
    buildSupplierBillWhere({
      status: "AUTHORISED",
      invoiceRef: "SW-INV",
    }).includes(
      '(InvoiceNumber=="SW-INV" OR (Reference!=null AND Reference.Contains("SW-INV")))',
    ),
    true,
  );
  assertEquals(
    buildSupplierBillWhere({ invoiceRef: "INV-81742" }),
    'Type=="ACCPAY" AND (InvoiceNumber=="INV-81742" OR (Reference!=null AND Reference.Contains("INV-81742")))',
  );
});

Deno.test("ACCPAY line builder keeps tracking, account, and tax on each line", () => {
  const lines = buildAccpayLineItems([
    {
      description: "Labour SWF-261132",
      quantity: 1,
      unit_price: 803.20,
      account_code: "306",
      tax_type: "NONE",
      tracking: [{ Name: "Business Unit", Option: "SW - FENCING" }],
    },
    {
      description: "Super withheld",
      quantity: 1,
      unit_amount: -96.38,
      account_code: "306",
      tax_type: "NONE",
    },
  ]);
  assertEquals(lines[0].AccountCode, "306");
  assertEquals(lines[0].Tracking[0].Option, "SW - FENCING");
  assertEquals(lines[1].UnitAmount, -96.38);
});

Deno.test("get_supplier_bill reads the live Xero ACCPAY and refuses a sales invoice", async () => {
  const xeroGet = async (path: string) => {
    if (path.includes("accrec-1")) {
      return {
        Invoices: [{ InvoiceID: "accrec-1", Type: "ACCREC", Status: "DRAFT" }],
      };
    }
    return {
      Invoices: [{
        InvoiceID: "bill-1",
        Type: "ACCPAY",
        Status: "DRAFT",
        InvoiceNumber: "BILL-1",
        Contact: { ContactID: "c1", Name: "Israel" },
        HasAttachments: false,
        LineItems: [],
      }],
    };
  };
  const got = await getSupplierBill(
    makeClient(),
    { xero_invoice_id: "bill-1" },
    {
      getToken: async () => ({ accessToken: "t", tenantId: "n" }),
      xeroGet: xeroGet as any,
    },
  );
  assertEquals(got.bill.contact_name, "Israel");
  assertEquals(got.bill.status, "DRAFT");

  await assertRejects(
    () =>
      getSupplierBill(
        makeClient(),
        { xero_invoice_id: "accrec-1" },
        {
          getToken: async () => ({ accessToken: "t", tenantId: "n" }),
          xeroGet: xeroGet as any,
        },
      ),
    SupplierBillError,
    "not a supplier bill",
  );
});

Deno.test("get_supplier_bill accepts each ID alias from query params and records", async () => {
  const billId = "aaaaaaaa-1111-4111-8111-111111111111";
  for (const alias of ["xero_invoice_id", "xero_bill_id", "xero_id"]) {
    for (
      const params of [
        { [alias]: ` ${billId} ` },
        new URLSearchParams({ [alias]: ` ${billId} ` }),
      ]
    ) {
      const paths: string[] = [];
      const got = await getSupplierBill(makeClient(), params, {
        getToken: () => Promise.resolve({ accessToken: "fixture", tenantId: "fixture" }),
        xeroGet: (path) => {
          paths.push(path);
          return Promise.resolve({ Invoices: [{ InvoiceID: billId, Type: "ACCPAY" }] });
        },
      });
      assertEquals(paths, [`/Invoices/${billId}`]);
      assertEquals(got.bill.xero_invoice_id, billId);
    }
  }
});

Deno.test("get_supplier_bill accepts matching aliases and ignores blank aliases", async () => {
  const billId = "aaaaaaaa-1111-4111-8111-111111111111";
  for (
    const params of [
      {
        xero_invoice_id: billId,
        xero_bill_id: billId.toUpperCase(),
        xero_id: ` ${billId} `,
      },
      { xero_invoice_id: " ", xero_bill_id: billId, xero_id: "" },
    ]
  ) {
    const paths: string[] = [];
    await getSupplierBill(makeClient(), params, {
      getToken: () => Promise.resolve({ accessToken: "fixture", tenantId: "fixture" }),
      xeroGet: (path) => {
        paths.push(path);
        return Promise.resolve({ Invoices: [{ InvoiceID: billId, Type: "ACCPAY" }] });
      },
    });
    assertEquals(paths, [`/Invoices/${billId}`]);
  }
});

Deno.test("get_supplier_bill rejects conflicting aliases before credentials, provider or cache calls", async () => {
  const aliases = ["xero_invoice_id", "xero_bill_id", "xero_id"];
  const calls: string[] = [];
  const client = {
    from() {
      calls.push("cache");
      throw new Error("Unexpected cache access");
    },
  };
  const deps = {
    getToken: () => {
      calls.push("credentials");
      return Promise.resolve({ accessToken: "fixture", tenantId: "fixture" });
    },
    xeroGet: () => {
      calls.push("provider");
      return Promise.resolve({ Invoices: [{ InvoiceID: "bill-a", Type: "ACCPAY" }] });
    },
  };
  for (let first = 0; first < aliases.length; first++) {
    for (let second = first + 1; second < aliases.length; second++) {
      const values = {
        [aliases[first]]: "bill-a",
        [aliases[second]]: "bill-b",
      };
      for (const params of [values, new URLSearchParams(values)]) {
        const error = await assertRejects(
          () => getSupplierBill(client, params, deps),
          SupplierBillError,
          "Conflicting supplier bill IDs",
        );
        assertEquals(error.status, 400);
        assertEquals(error.code, "SUPPLIER_BILL_ID_CONFLICT");
        assertEquals(calls, []);
      }
    }
  }
});

Deno.test("get_xero_invoice is a read-only point-get that returns ACCPAY or ACCREC type", async () => {
  const calls: string[] = [];
  const xeroGet = async (path: string) => {
    calls.push(path);
    if (path.includes("accrec-1")) {
      return {
        Invoices: [{
          InvoiceID: "accrec-1",
          Type: "ACCREC",
          Status: "DRAFT",
          InvoiceNumber: "INV-9",
          LineItems: [{ Description: "Job SWF-1", Quantity: 1, UnitAmount: 100 }],
        }],
      };
    }
    return {
      Invoices: [{
        InvoiceID: "bill-1",
        Type: "ACCPAY",
        Status: "DRAFT",
        InvoiceNumber: "BILL-1",
        LineItems: [{ Description: "Labour", Quantity: 1, UnitAmount: 50 }],
      }],
    };
  };
  const deps = {
    getToken: async () => ({ accessToken: "t", tenantId: "n" }),
    xeroGet: xeroGet as any,
  };

  const sale = await getXeroInvoice(
    makeClient(),
    {},
    deps,
    { invoice_id: "accrec-1" },
  );
  assertEquals(sale.invoice.type, "ACCREC");
  assertEquals(sale.invoice.status, "DRAFT");
  assertEquals(sale.invoice.line_items[0].description, "Job SWF-1");
  assertEquals(calls.every((path) => path.startsWith("/Invoices/")), true);

  const bill = await getXeroInvoice(
    makeClient(),
    { xero_invoice_id: "bill-1" },
    deps,
  );
  assertEquals(bill.invoice.type, "ACCPAY");
  assertEquals(bill.invoice.status, "DRAFT");
  assertEquals(bill.invoice.line_items.length, 1);
});

Deno.test("list_supplier_bills searches invoice_ref against Reference OR InvoiceNumber", async () => {
  let where = "";
  await listSupplierBills(
    makeClient(),
    { invoice_ref: "INV-81742", status: "draft" },
    {
      getToken: async () => ({ accessToken: "t", tenantId: "n" }),
      xeroGet: (async (_path: string, _a: string, _t: string, params?: Record<string, string>) => {
        where = params?.where || "";
        return { Invoices: [] };
      }) as any,
    },
  );
  assertEquals(
    where.includes(
      '(InvoiceNumber=="INV-81742" OR (Reference!=null AND Reference.Contains("INV-81742")))',
    ),
    true,
  );

  await listSupplierBills(
    makeClient(),
    { invoice_ref: "SW-INV-I-260828-001" },
    {
      getToken: async () => ({ accessToken: "t", tenantId: "n" }),
      xeroGet: (async (_path: string, _a: string, _t: string, params?: Record<string, string>) => {
        where = params?.where || "";
        return { Invoices: [] };
      }) as any,
    },
  );
  assertEquals(
    where.includes('InvoiceNumber=="SW-INV-I-260828-001"'),
    true,
  );
  assertEquals(
    where.includes('Reference.Contains("SW-INV-I-260828-001")'),
    true,
  );
  assertEquals(where.includes(" OR "), true);
});

Deno.test("list_supplier_bills searches Xero by contact and draft status", async () => {
  let where = "";
  const listed = await listSupplierBills(
    makeClient(),
    { contact: "Israel", status: "draft" },
    {
      getToken: async () => ({ accessToken: "t", tenantId: "n" }),
      xeroGet: (async (_path: string, _a: string, _t: string, params?: Record<string, string>) => {
        where = params?.where || "";
        return {
          Invoices: [{
            InvoiceID: "bill-1",
            Type: "ACCPAY",
            Status: "DRAFT",
            Contact: { Name: "Israel" },
            LineItems: [],
          }],
        };
      }) as any,
    },
  );
  assertEquals(listed.count, 1);
  assertEquals(where.includes('Type=="ACCPAY"'), true);
  assertEquals(where.includes('Status=="DRAFT"'), true);
  assertEquals(where.includes("Israel"), true);
});

Deno.test("list page size is clamped to one bounded Xero page", () => {
  // Default is 100, the page Xero already returned before this door asked.
  assertEquals(clampBillPageSize(null), 100);
  assertEquals(clampBillPageSize(undefined), 100);
  assertEquals(clampBillPageSize(""), 100);
  assertEquals(clampBillPageSize(0), 100);
  assertEquals(clampBillPageSize(-5), 100);
  assertEquals(clampBillPageSize("25"), 25);
  assertEquals(clampBillPageSize(100), 100);
  assertEquals(clampBillPageSize(1000), 100);
});

Deno.test("list_supplier_bills asks Xero for one bounded page and reports pagination", async () => {
  let params: Record<string, string> = {};
  const listed = await listSupplierBills(
    makeClient(),
    { status: "awaiting_payment", limit: "1000" },
    {
      getToken: async () => ({ accessToken: "t", tenantId: "n" }),
      xeroGet: (async (_p: string, _a: string, _t: string, q?: Record<string, string>) => {
        params = q || {};
        return {
          Invoices: Array.from({ length: 100 }, (_v, i) => ({
            InvoiceID: `bill-${i}`,
            Type: "ACCPAY",
            Status: "AUTHORISED",
            Contact: { Name: "Supplier" },
            LineItems: [],
          })),
        };
      }) as any,
    },
  );
  // limit=1000 must not become an unbounded read.
  assertEquals(params.pageSize, "100");
  assertEquals(params.page, "1");
  assertEquals(listed.count, 100);
  assertEquals(listed.page_size, 100);
  assertEquals(listed.has_more, true);
  assertEquals(listed.next_page, 2);
});

Deno.test("list_supplier_bills rejects a provider page that overruns page_size", async () => {
  // Silently trimming would hide supplier bills from a books read and return a
  // has_more the caller cannot trust. Fail loudly instead.
  let cached = 0;
  const client = {
    from() {
      return {
        upsert: async () => {
          cached += 1;
          return { error: null };
        },
      };
    },
  };
  const err = await assertRejects(
    () =>
      listSupplierBills(
        client,
        { page_size: "5", page: "3" },
        {
          getToken: async () => ({ accessToken: "t", tenantId: "n" }),
          xeroGet: (async () => ({
            Invoices: Array.from({ length: 9 }, (_v, i) => ({
              InvoiceID: `bill-${i}`,
              Type: "ACCPAY",
              Status: "DRAFT",
              Contact: { Name: "Supplier" },
              LineItems: [],
            })),
          })) as any,
        },
      ),
    SupplierBillError,
  );
  assertEquals(err.status, 502);
  assertEquals(err.code, "XERO_RESPONSE_INVALID");
  // The bad page must not reach the cache either.
  assertEquals(cached, 0);
});

Deno.test("list_supplier_bills accepts an exactly full page", async () => {
  const listed = await listSupplierBills(
    makeClient(),
    { page_size: "5", page: "3" },
    {
      getToken: async () => ({ accessToken: "t", tenantId: "n" }),
      xeroGet: (async () => ({
        Invoices: Array.from({ length: 5 }, (_v, i) => ({
          InvoiceID: `bill-${i}`,
          Type: "ACCPAY",
          Status: "DRAFT",
          Contact: { Name: "Supplier" },
          LineItems: [],
        })),
      })) as any,
    },
  );
  assertEquals(listed.count, 5);
  assertEquals(listed.page, 3);
  assertEquals(listed.has_more, true);
  assertEquals(listed.next_page, 4);
});

Deno.test("list_supplier_bills returns a full page without writing the local mirror", async () => {
  const upserts: any[] = [];
  const client = {
    from() {
      return {
        upsert: async (rows: any) => {
          upserts.push(rows);
          return { error: null };
        },
      };
    },
  };
  const listed = await listSupplierBills(
    client,
    { status: "paid" },
    {
      getToken: async () => ({ accessToken: "t", tenantId: "n" }),
      xeroGet: (async () => ({
        Invoices: Array.from({ length: 40 }, (_v, i) => ({
          InvoiceID: `bill-${i}`,
          Type: "ACCPAY",
          Status: "PAID",
          Contact: { Name: "Supplier" },
          LineItems: [],
        })),
      })) as any,
    },
  );
  assertEquals(listed.count, 40);
  assertEquals(upserts.length, 0);
});

Deno.test("list_supplier_bills preserves provider rows without deduping or caching a read", async () => {
  const upserts: any[] = [];
  const client = {
    from() {
      return {
        upsert: async (rows: any) => {
          upserts.push(rows);
          return { error: null };
        },
      };
    },
  };
  const listed = await listSupplierBills(
    client,
    { page_size: "10" },
    {
      getToken: async () => ({ accessToken: "t", tenantId: "n" }),
      xeroGet: (async () => ({
        Invoices: [
          {
            InvoiceID: "dup",
            Type: "ACCPAY",
            Status: "DRAFT",
            Contact: { Name: "A" },
            LineItems: [],
          },
          {
            InvoiceID: "dup",
            Type: "ACCPAY",
            Status: "AUTHORISED",
            Contact: { Name: "A" },
            LineItems: [],
          },
          {
            InvoiceID: "other",
            Type: "ACCPAY",
            Status: "DRAFT",
            Contact: { Name: "B" },
            LineItems: [],
          },
          {
            Type: "ACCPAY",
            Status: "DRAFT",
            Contact: { Name: "No ID" },
            LineItems: [],
          },
        ],
      })) as any,
    },
  );
  assertEquals(listed.count, 4);
  assertEquals(listed.bills.map((bill: any) => bill.xero_invoice_id), [
    "dup",
    "dup",
    "other",
    null,
  ]);
  assertEquals(upserts.length, 0);
});

Deno.test("a draft bill write caches Xero fields only, never job or SES columns", async () => {
  const upserts: any[] = [];
  const client = {
    from() {
      return {
        upsert: async (rows: any) => {
          upserts.push(rows);
          return { error: null };
        },
      };
    },
  };
  await createSupplierBill(
    client,
    {
      xero_contact_id: "fixture-contact",
      line_items: [{ description: "Fixture work", unit_amount: 1 }],
    },
    {
      getToken: async () => ({ accessToken: "t", tenantId: "n" }),
      xeroGet: () => Promise.resolve({}),
      xeroPost: (async () => ({
        Invoices: [{
          InvoiceID: "bill-1",
          Type: "ACCPAY",
          Status: "DRAFT",
          Contact: { ContactID: "c1", Name: "Supplier" },
          LineItems: [],
          // A provider payload must never steer the cache row's shape.
          job_id: "should-not-land",
          run_label: "should-not-land",
        }],
      })) as any,
    },
  );
  assertEquals(upserts.length, 1);
  const row = upserts[0];
  for (
    const forbidden of [
      "job_id",
      "invoice_obligation_revision_id",
      "ses_external_token",
      "debt_classification",
      "debt_classification_at",
      "debt_classification_by",
      "quote_document_ids",
      "run_label",
    ]
  ) {
    assertEquals(
      Object.keys(row).includes(forbidden),
      false,
      `cache row must not write ${forbidden}`,
    );
  }
  assertEquals(row.xero_invoice_id, "bill-1");
  assertEquals(row.invoice_type, "ACCPAY");
  // The untouched provider payload is still preserved under raw_json.
  assertEquals(row.raw_json.job_id, "should-not-land");
});

Deno.test("list_supplier_bills reports the last page as complete", async () => {
  const listed = await listSupplierBills(
    makeClient(),
    { page_size: "10" },
    {
      getToken: async () => ({ accessToken: "t", tenantId: "n" }),
      xeroGet: (async () => ({
        Invoices: [{
          InvoiceID: "bill-1",
          Type: "ACCPAY",
          Status: "DRAFT",
          Contact: { Name: "Supplier" },
          LineItems: [],
        }],
      })) as any,
    },
  );
  assertEquals(listed.count, 1);
  assertEquals(listed.has_more, false);
  assertEquals(listed.next_page, null);
});

Deno.test("create_supplier_bill always mints DRAFT ACCPAY and can attach a PDF", async () => {
  const posts: any[] = [];
  const fetches: string[] = [];
  const created = await createSupplierBill(
    makeClient(),
    {
      contact_name: "Israel",
      reference: "SW-INV-I-260828-001",
      date: "2026-08-28",
      due_date: "2026-09-11",
      gst_on: false,
      line_items: [{
        description: "Labour",
        quantity: 1,
        unit_price: 100,
        account_code: "306",
        tax_type: "NONE",
      }],
      pdf_base64: PDF_B64,
      pdf_filename: "israel.pdf",
    },
    {
      getToken: async () => ({ accessToken: "t", tenantId: "n" }),
      xeroGet: (async () => ({ Contacts: [] })) as any,
      xeroPost: (async (path: string, _a: string, _t: string, body: any, method?: string) => {
        posts.push({ path, method, body });
        if (path === "/Contacts") {
          return { Contacts: [{ ContactID: "c-israel" }] };
        }
        return {
          Invoices: [{
            InvoiceID: "new-bill",
            InvoiceNumber: "BILL-9",
            Type: "ACCPAY",
            Status: "DRAFT",
            Contact: { ContactID: "c-israel", Name: "Israel" },
            Reference: "SW-INV-I-260828-001",
            LineItems: body.Invoices[0].LineItems,
            Total: 100,
          }],
        };
      }) as any,
      fetchImpl: (async (url: string | URL) => {
        fetches.push(String(url));
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    },
  );
  assertEquals(created.status, "DRAFT");
  assertEquals(created.bill.xero_invoice_id, "new-bill");
  assertEquals(created.pdf.attached, true);
  assertEquals(posts[1].body.Invoices[0].Status, "DRAFT");
  assertEquals(posts[1].body.Invoices[0].Type, "ACCPAY");
  assertEquals(fetches[0].includes("/Invoices/new-bill/Attachments/"), true);
});

Deno.test("create_supplier_bill fails when PDF bytes exist but attach does not land", async () => {
  await assertRejects(
    () =>
      createSupplierBill(
        makeClient(),
        {
          contact_name: "Israel",
          reference: "SW-INV-I-260828-001",
          gst_on: false,
          line_items: [{
            description: "Labour",
            quantity: 1,
            unit_price: 100,
          }],
          pdf_base64: PDF_B64,
        },
        {
          getToken: async () => ({ accessToken: "t", tenantId: "n" }),
          xeroGet: (async () => ({ Contacts: [] })) as any,
          xeroPost: (async (path: string, _a: string, _t: string, body: any) => {
            if (path === "/Contacts") {
              return { Contacts: [{ ContactID: "c-israel" }] };
            }
            return {
              Invoices: [{
                InvoiceID: "new-bill",
                InvoiceNumber: "BILL-9",
                Type: "ACCPAY",
                Status: "DRAFT",
                Contact: { ContactID: "c-israel", Name: "Israel" },
                LineItems: body.Invoices[0].LineItems,
                Total: 100,
              }],
            };
          }) as any,
          fetchImpl: (async () => new Response("busy", { status: 502 })) as typeof fetch,
        },
      ),
    XeroPdfAttachError,
    "Xero attachment failed",
  );
});

Deno.test("create_supplier_bill may return pdf.attached=false only when there were never any bytes", async () => {
  const created = await createSupplierBill(
    makeClient(),
    {
      contact_name: "Israel",
      reference: "SW-INV-I-260828-001",
      gst_on: false,
      line_items: [{ description: "Labour", quantity: 1, unit_price: 100 }],
    },
    {
      getToken: async () => ({ accessToken: "t", tenantId: "n" }),
      xeroGet: (async () => ({ Contacts: [] })) as any,
      xeroPost: (async (path: string, _a: string, _t: string, body: any) => {
        if (path === "/Contacts") {
          return { Contacts: [{ ContactID: "c-israel" }] };
        }
        return {
          Invoices: [{
            InvoiceID: "new-bill",
            InvoiceNumber: "BILL-9",
            Type: "ACCPAY",
            Status: "DRAFT",
            Contact: { ContactID: "c-israel", Name: "Israel" },
            LineItems: body.Invoices[0].LineItems,
            Total: 100,
          }],
        };
      }) as any,
    },
  );
  assertEquals(created.status, "DRAFT");
  assertEquals(created.pdf.attached, false);
});

Deno.test("create_supplier_bill refuses an approve/authorise request", async () => {
  await assertRejects(
    () =>
      createSupplierBill(
        makeClient(),
        {
          status: "AUTHORISED",
          contact_name: "Israel",
          line_items: [{ description: "x", quantity: 1, unit_price: 1 }],
        },
        {
          getToken: async () => ({ accessToken: "t", tenantId: "n" }),
          xeroGet: (async () => ({ Contacts: [] })) as any,
          xeroPost: (async () => ({})) as any,
        },
      ),
    SupplierBillError,
    "must stay DRAFT",
  );
});

Deno.test("update_supplier_bill edits draft lines and refuses a non-draft live bill", async () => {
  await assertRejects(
    () =>
      updateSupplierBill(
        makeClient(),
        {
          xero_invoice_id: "live-authorised",
          line_items: [{ description: "x", quantity: 1, unit_price: 1 }],
        },
        {
          getToken: async () => ({ accessToken: "t", tenantId: "n" }),
          xeroGet: (async () => ({
            Invoices: [{
              InvoiceID: "live-authorised",
              Type: "ACCPAY",
              Status: "AUTHORISED",
            }],
          })) as any,
          xeroPost: (async () => ({})) as any,
        },
      ),
    SupplierBillError,
    "must stay DRAFT",
  );

  const updated = await updateSupplierBill(
    makeClient(),
    {
      xero_invoice_id: "draft-1",
      line_items: [{
        description: "Labour at work amount",
        quantity: 1,
        unit_price: 803.20,
        account_code: "306",
        tax_type: "NONE",
      }, {
        description: "Super withheld",
        quantity: 1,
        unit_price: -96.38,
        account_code: "306",
        tax_type: "NONE",
      }],
    },
    {
      getToken: async () => ({ accessToken: "t", tenantId: "n" }),
      xeroGet: (async () => ({
        Invoices: [{ InvoiceID: "draft-1", Type: "ACCPAY", Status: "DRAFT" }],
      })) as any,
      xeroPost: (async (_p: string, _a: string, _t: string, body: any) => ({
        Invoices: [{
          InvoiceID: "draft-1",
          Type: "ACCPAY",
          Status: "DRAFT",
          LineItems: body.Invoices[0].LineItems,
          Contact: { Name: "Israel" },
        }],
      })) as any,
    },
  );
  assertEquals(updated.status, "DRAFT");
  assertEquals(updated.bill.line_items[1].unit_amount, -96.38);
});

Deno.test("create_supplier_credit_note mints a DRAFT ACCPAYCREDIT only", async () => {
  const created = await createSupplierCreditNote(
    makeClient(),
    {
      xero_contact_id: "c1",
      reference: "CN-1",
      line_items: [{ description: "Credit", quantity: 1, unit_price: 50 }],
    },
    {
      getToken: async () => ({ accessToken: "t", tenantId: "n" }),
      xeroGet: (async () => ({ Contacts: [] })) as any,
      xeroPost: (async (_p: string, _a: string, _t: string, body: any) => {
        assertEquals(body.CreditNotes[0].Type, "ACCPAYCREDIT");
        assertEquals(body.CreditNotes[0].Status, "DRAFT");
        return {
          CreditNotes: [{
            CreditNoteID: "cn-1",
            Type: "ACCPAYCREDIT",
            Status: "DRAFT",
            Contact: { ContactID: "c1", Name: "Israel" },
            LineItems: body.CreditNotes[0].LineItems,
          }],
        };
      }) as any,
    },
  );
  assertEquals(created.status, "DRAFT");
  assertEquals(created.credit_note.xero_credit_note_id, "cn-1");
});

Deno.test("supplier bill detail is read-only even when a mirror writer is available", async () => {
  let mirrorWrites = 0;
  const client = {
    from() {
      return {
        upsert: () => {
          mirrorWrites++;
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  const got = await getSupplierBill(client, { xero_bill_id: "fixture-bill" }, {
    getToken: () => Promise.resolve({ accessToken: "fixture", tenantId: "fixture" }),
    xeroGet: () => Promise.resolve({ Invoices: [{ InvoiceID: "fixture-bill", Type: "ACCPAY", Status: "PAID" }] }),
  });
  assertEquals(got.bill.status, "PAID");
  assertEquals(mirrorWrites, 0);
});

Deno.test("supplier bill list applies exact contact and returns every applied filter", async () => {
  const contactId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  for (const input of [
    { xero_contact_id: ` ${contactId.toUpperCase()} `, contact_name: "Fixture", status: "paid", reference: "fixture-ref", page: "2", page_size: "5" },
    new URLSearchParams({ xero_contact_id: contactId, contact_name: "Fixture", status: "paid", reference: "fixture-ref", page: "2", page_size: "5" }),
  ]) {
    let providerParams: Record<string, string> = {};
    let writes = 0;
    const listed = await listSupplierBills({
      from: () => ({ upsert: () => { writes++; return Promise.resolve({ error: null }); } }),
    }, input, {
      getToken: () => Promise.resolve({ accessToken: "fixture", tenantId: "fixture" }),
      xeroGet: (_path, _token, _tenant, params) => {
        providerParams = params || {};
        return Promise.resolve({ Invoices: [{ InvoiceID: "fixture-bill", Type: "ACCPAY", Contact: { ContactID: contactId.toUpperCase(), Name: "Fixture" } }] });
      },
    });
    assertEquals(providerParams.ContactIDs, contactId);
    assertEquals(providerParams.page, "2");
    assertEquals(providerParams.pageSize, "5");
    assertEquals(providerParams.where.includes('Status=="PAID"'), true);
    assertEquals(providerParams.where.includes('Contact.Name.Contains("Fixture")'), true);
    assertEquals(providerParams.where.includes("fixture-ref"), true);
    assertEquals(listed.filters, { xero_contact_id: contactId, contact_name: "Fixture", invoice_ref: "fixture-ref", status: "PAID" });
    assertEquals(listed.count, 1);
    assertEquals(listed.has_more, false);
    assertEquals(writes, 0);
  }
});

Deno.test("supplier bill list refuses an invalid exact contact before provider or token reads", async () => {
  const calls: string[] = [];
  const err = await assertRejects(() => listSupplierBills({}, { xero_contact_id: "invalid-contact" }, {
    getToken: () => { calls.push("token"); return Promise.resolve({ accessToken: "fixture", tenantId: "fixture" }); },
    xeroGet: () => { calls.push("provider"); return Promise.resolve({ Invoices: [] }); },
  }), SupplierBillError);
  assertEquals(err.status, 400);
  assertEquals(err.code, "CONTACT_ID_INVALID");
  assertEquals(calls, []);
});

Deno.test("supplier bill list refuses a provider that ignores the exact contact filter", async () => {
  for (const contact of [{ ContactID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, {}]) {
    const err = await assertRejects(() => listSupplierBills({}, { xero_contact_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, {
      getToken: () => Promise.resolve({ accessToken: "fixture", tenantId: "fixture" }),
      xeroGet: () => Promise.resolve({ Invoices: [{ InvoiceID: "fixture-bill", Type: "ACCPAY", Contact: contact }] }),
    }), SupplierBillError);
    assertEquals(err.status, 502);
    assertEquals(err.code, "XERO_RESPONSE_INVALID");
  }
});

function supplierDraftFixture(enabled = true) {
  const job = "SWF-260002";
  const org = "00000000-0000-0000-0000-000000000001";
  const option = "SW - FENCING";
  const rules = ["supplier_bill", "supplier_credit"].map((kind) => ({
    source_kind: kind, line_kind: "default", account_code: kind === "supplier_bill" ? "401" : "402",
  }));
  const state = { fail: "", options: [option, "SecureBuild"], rules, existingStatus: "DRAFT" };
  const readTables: string[] = [];
  const jobQueries: string[][] = [];
  const client = {
    from(table: string) {
      if (table === "xero_invoices") return { upsert: async () => ({ error: null }) };
      readTables.push(table);
      const rows = (data: unknown[]) =>
        table === state.fail ? { error: { code: "READ_FAILED" }, data: null } : { error: null, data };
      return {
        select(fields: string) {
          return {
            eq(column: string, value: string) {
              if (table === "feature_flags") {
                assertEquals([fields, column, value], ["enabled", "flag_name", "xero_draft_standard_v1"]);
                return { limit: () => rows([{ enabled }]) };
              }
              assertEquals([column, value], ["org_id", org]);
              if (table === "xero_account_rules") return rows(state.rules);
              if (table === "xero_tracking_options") return {
                eq(key: string, status: string) {
                  assertEquals([key, status], ["status", "ACTIVE"]);
                  return rows(state.options.map((option_name) => ({ option_name })));
                },
              };
              assertEquals([table, fields], ["jobs", "job_number, type"]);
              return {
                in(key: string, numbers: string[]) {
                  assertEquals(key, "job_number");
                  jobQueries.push(numbers);
                  return rows([
                    { job_number: job, type: "fencing" },
                    { job_number: "SWP-ZZTEST", type: "granny_flat" },
                  ].filter((row) => numbers.includes(row.job_number)));
                },
              };
            },
          };
        },
      };
    },
  };
  const writes: { path: string; method?: string; key?: string; payload: any }[] = [];
  const deps = {
    getToken: async () => ({ accessToken: "fixture", tenantId: "fixture" }),
    xeroGet: async () => ({ Invoices: [{ InvoiceID: "draft", Type: "ACCPAY", Status: state.existingStatus }] }),
    xeroPost: async (path: string, _a: string, _t: string, payload: any, method?: string, key?: string) => {
      writes.push({ path, method, key, payload });
      return payload.CreditNotes
        ? { CreditNotes: [{ CreditNoteID: "credit", ...payload.CreditNotes[0] }] }
        : { Invoices: [{ InvoiceID: "draft", ...payload.Invoices[0] }] };
    },
  };
  const body = {
    xero_invoice_id: "draft", xero_contact_id: "supplier", date: "2026-11-01",
    idempotency_key: "fixture", job_number: job, line_items: [{ description: "Materials" }],
  };
  return { job, option, state, client, deps, writes, readTables, jobQueries, body };
}

Deno.test("supplier draft switch off preserves the three serialized Xero requests", async () => {
  const f = supplierDraftFixture(false);
  const bill = await createSupplierBill(f.client, f.body, f.deps);
  const edit = await updateSupplierBill(f.client, f.body, f.deps);
  const credit = await createSupplierCreditNote(f.client, f.body, f.deps);
  for (const result of [bill, edit, credit]) assertEquals("division_missing_lines" in result, false);
  const lines = [{ Description: "Materials", Quantity: 1, UnitAmount: 0, AccountCode: "306", TaxType: "NONE" }];
  const header = { Contact: { ContactID: "supplier" }, Date: "2026-11-01", Status: "DRAFT", LineAmountTypes: "Exclusive", LineItems: lines };
  const expected = [
    { path: "/Invoices", method: "PUT", key: "fixture", payload: { Invoices: [{ Type: "ACCPAY", ...header }] } },
    { path: "/Invoices/draft", method: "POST", payload: { Invoices: [{ InvoiceID: "draft", Type: "ACCPAY", Status: "DRAFT", LineItems: lines, Date: "2026-11-01" }] } },
    { path: "/CreditNotes", method: "PUT", key: "fixture", payload: { CreditNotes: [{ Type: "ACCPAYCREDIT", ...header }] } },
  ];
  assertEquals(JSON.stringify(f.writes), JSON.stringify(expected));
  assertEquals(f.readTables.filter((t) => t !== "feature_flags"), []);
});

Deno.test("supplier drafts apply the correct account rule and checked job division for each action", async () => {
  for (const action of [createSupplierBill, updateSupplierBill, createSupplierCreditNote]) {
    const f = supplierDraftFixture();
    const result = await action(f.client, { ...f.body, line_items: [
      ...f.body.line_items,
      { job_number: "SWP-ZZTEST", description: "[SWP-ZZTEST] Work", account_code: "405" },
      { job_number: "SWF-UNKNOWN", description: "Unresolved" },
      { description: "Other category", tracking: [{ Name: "Region", Option: "Local" }] },
      ...f.body.line_items,
    ] }, f.deps);
    assertEquals(result.division_missing_lines, [3, 4]);
    assertEquals(f.jobQueries, [[f.job, "SWP-ZZTEST", "SWF-UNKNOWN"]]);
    const doc = (f.writes[0].payload.Invoices || f.writes[0].payload.CreditNotes)[0];
    assertEquals(doc.Status, "DRAFT");
    const [first, second, unknown, other] = doc.LineItems;
    assertEquals(first.AccountCode, action === createSupplierCreditNote ? "402" : "401");
    assertEquals(first.Description, "[" + f.job + "] Materials");
    assertEquals(first.Tracking, [{ Name: "Business Unit", Option: f.option }]);
    assertEquals(second.Description, "[SWP-ZZTEST] Work");
    assertEquals(second.AccountCode, "405");
    assertEquals(second.Tracking, [{ Name: "Business Unit", Option: "SecureBuild" }]);
    assertEquals(unknown.Tracking, undefined);
    assertEquals(other.Tracking, [{ Name: "Region", Option: "Local" }]);
  }
});

Deno.test("an untagged office draft is returned with one-based missing line numbers", async () => {
  const f = supplierDraftFixture();
  const result = await createSupplierBill(f.client, { ...f.body, job_number: null }, f.deps);
  assertEquals(result.division_missing_lines, [1]);
  assertEquals(f.writes[0].payload.Invoices[0].LineItems[0].Tracking, undefined);
  assertEquals(f.jobQueries, []);
});

Deno.test("a typed inactive division refuses before dispatch and a corrected retry writes once", async () => {
  const f = supplierDraftFixture();
  const line = { description: "Materials", tracking: [{ name: "Business Unit", option: "SW - OLD" }] };
  const body = { ...f.body, line_items: [line] };
  const err = await assertRejects(() => createSupplierCreditNote(f.client, body, f.deps), SupplierBillError, "SW - OLD");
  assertEquals([err.status, err.code], [422, "TRACKING_OPTION_NOT_ACTIVE"]);
  f.state.options = [];
  const unreadable = await assertRejects(() => createSupplierCreditNote(f.client, body, f.deps), SupplierBillError);
  assertEquals(unreadable.code, "TRACKING_OPTIONS_UNAVAILABLE");
  assertEquals(f.writes, []);
  f.state.options = [f.option];
  line.tracking[0].option = f.option;
  const result = await createSupplierCreditNote(f.client, body, f.deps);
  assertEquals(result.division_missing_lines, []);
  assertEquals(f.writes.length, 1);
  assertEquals(f.writes[0].key, f.body.idempotency_key);
});

Deno.test("missing rule, failed reads and an office-approved bill each refuse before a write", async () => {
  const f = supplierDraftFixture();
  f.state.rules = [];
  const missing = await assertRejects(() => createSupplierBill(f.client, f.body, f.deps), SupplierBillError);
  assertEquals([missing.status, missing.code], [409, "ACCOUNT_RULE_MISSING"]);
  for (const table of ["xero_account_rules", "xero_tracking_options", "jobs"]) {
    f.state.fail = table;
    const err = await assertRejects(() => createSupplierBill(f.client, f.body, f.deps), SupplierBillError);
    assertEquals([err.status, err.code], [503, "DRAFT_STANDARD_UNAVAILABLE"]);
  }
  f.state.fail = "";
  f.state.existingStatus = "AUTHORISED";
  const existing = await assertRejects(() => updateSupplierBill(f.client, {
    ...f.body, line_items: [{ description: "Materials", account_code: "405" }],
  }, f.deps), SupplierBillError);
  assertEquals([existing.status, existing.code], [409, "MUST_STAY_DRAFT"]);
  assertEquals(f.writes, []);
});

Deno.test("an inferred division absent from the active list leaves a gap; an active office tag is kept", async () => {
  const f = supplierDraftFixture();
  f.state.options = ["SW - PATIOS"];
  const result = await updateSupplierBill(f.client, {
    ...f.body,
    line_items: [
      ...f.body.line_items,
      { description: "Office line", tracking: [{ Name: "Business Unit", Option: "SW - PATIOS" }] },
    ],
  }, f.deps);
  assertEquals(result.division_missing_lines, [1]);
  const [missing, supplied] = f.writes[0].payload.Invoices[0].LineItems;
  assertEquals(missing.Tracking, undefined);
  assertEquals(supplied.Tracking, [{ Name: "Business Unit", Option: "SW - PATIOS" }]);
});

const CREDIT_PDF = (() => {
  const encoded = new TextEncoder().encode("%PDF-1.4\nZZTEST\n");
  const bytes = new Uint8Array(encoded.byteLength);
  bytes.set(encoded);
  return bytes;
})();
const CREDIT_PDF_B64 = btoa(String.fromCharCode(...CREDIT_PDF));
const CREDIT_ID = "33333333-3333-4333-8333-333333333333";

function creditClient(flags: Record<string, boolean>, attached = false) {
  const inserts: any[] = [];
  const tables: string[] = [];
  const client = {
    from(table: string) {
      tables.push(table);
      if (table === "feature_flags") {
        return {
          select() {
            return {
              eq(_column: string, name: string) {
                return {
                  limit: () => Promise.resolve({
                    data: [{ enabled: flags[name] === true }],
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }
      if (table === "xero_document_attachments") {
        const node: any = {
          select() { return node; },
          eq() { return node; },
          limit: () => Promise.resolve({ data: attached ? [{ id: "ZZTEST" }] : [], error: null }),
          insert(row: any) {
            inserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
        return node;
      }
      return { upsert: async () => ({ error: null }) };
    },
  };
  return { client, inserts, tables };
}

function creditDeps(fetchImpl?: typeof fetch, downloadStorage?: (bucket: string, path: string) => Promise<Uint8Array>) {
  return {
    getToken: async () => ({ accessToken: "fixture-token", tenantId: "fixture-tenant" }),
    xeroGet: (async () => ({ Contacts: [] })) as any,
    xeroPost: (async (_p: string, _a: string, _t: string, body: any) => ({
      CreditNotes: [{
        CreditNoteID: CREDIT_ID,
        Type: "ACCPAYCREDIT",
        Status: "DRAFT",
        Contact: { ContactID: "c1", Name: "ZZTEST" },
        LineItems: body.CreditNotes[0].LineItems,
      }],
    })) as any,
    fetchImpl,
    downloadStorage,
  };
}

Deno.test("a credit note PDF is not attached while the switch is off", async () => {
  let fetches = 0;
  const { client, inserts } = creditClient({ xero_credit_note_pdf_attach_v1: false });
  const created = await createSupplierCreditNote(client, {
    xero_contact_id: "c1",
    reference: "ZZTEST-CN",
    pdf_base64: CREDIT_PDF_B64,
    line_items: [{ description: "Credit", quantity: 1, unit_price: 50 }],
  }, creditDeps((() => {
    fetches += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch));
  assertEquals(created.status, "DRAFT");
  assertEquals("pdf" in created, false);
  assertEquals(fetches, 0);
  assertEquals(inserts, []);
});

Deno.test("a credit note PDF attaches when the switch is on and a failure leaves the draft", async () => {
  const urls: string[] = [];
  const on = creditClient({ xero_credit_note_pdf_attach_v1: true });
  const created = await createSupplierCreditNote(on.client, {
    xero_contact_id: "c1",
    reference: "ZZTEST-CN",
    pdf_filename: "ZZTEST-credit.pdf",
    pdf_base64: CREDIT_PDF_B64,
    line_items: [{ description: "Credit", quantity: 1, unit_price: 50 }],
  }, creditDeps(((url) => {
    urls.push(String(url));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch));
  assertEquals(created.status, "DRAFT");
  assertEquals(created.credit_note.xero_credit_note_id, CREDIT_ID);
  if (!created.pdf) throw new Error("expected credit note pdf result");
  assertEquals(created.pdf.attached, true);
  assertEquals(urls, [
    `https://api.xero.com/api.xro/2.0/CreditNotes/${CREDIT_ID}/Attachments/ZZTEST-credit.pdf`,
  ]);
  assertEquals(on.inserts[0].status, "attached");

  let fetches = 0;
  const again = creditClient({ xero_credit_note_pdf_attach_v1: true }, true);
  const skipped = await createSupplierCreditNote(again.client, {
    xero_contact_id: "c1",
    pdf_base64: CREDIT_PDF_B64,
    line_items: [{ description: "Credit", quantity: 1, unit_price: 50 }],
  }, creditDeps((() => {
    fetches += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch));
  if (!skipped.pdf) throw new Error("expected skipped credit note pdf");
  assertEquals(skipped.pdf.skipped, "already_attached");
  assertEquals(fetches, 0);

  const failed = creditClient({ xero_credit_note_pdf_attach_v1: true });
  const broken = await createSupplierCreditNote(failed.client, {
    xero_contact_id: "c1",
    storage_path: "ZZTEST/credit.pdf",
    line_items: [{ description: "Credit", quantity: 1, unit_price: 50 }],
  }, creditDeps((( ) => Promise.resolve(new Response("unavailable", { status: 502 }))) as typeof fetch, () => Promise.resolve(CREDIT_PDF)));
  assertEquals(broken.ok, true);
  assertEquals(broken.status, "DRAFT");
  if (!broken.pdf) throw new Error("expected failed credit note pdf");
  assertEquals(broken.pdf.attached, false);
  assertEquals(broken.pdf.error_code, "XERO_FILE_ATTACH_FAILED");
  assertEquals(failed.inserts[0].status, "failed");
});
