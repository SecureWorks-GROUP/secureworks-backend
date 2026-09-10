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
  assertEquals(clampBillPageSize(null), 50);
  assertEquals(clampBillPageSize(undefined), 50);
  assertEquals(clampBillPageSize(""), 50);
  assertEquals(clampBillPageSize(0), 50);
  assertEquals(clampBillPageSize(-5), 50);
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

Deno.test("list_supplier_bills truncates a provider page that overruns page_size", async () => {
  const listed = await listSupplierBills(
    makeClient(),
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
  );
  assertEquals(listed.count, 5);
  assertEquals(listed.bills.length, 5);
  assertEquals(listed.page, 3);
  assertEquals(listed.has_more, true);
});

Deno.test("list_supplier_bills caches a whole page in one upsert, not one per bill", async () => {
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
  assertEquals(upserts.length, 1);
  assertEquals(Array.isArray(upserts[0]), true);
  assertEquals(upserts[0].length, 40);
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
