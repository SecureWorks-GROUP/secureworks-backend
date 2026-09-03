// deno-lint-ignore-file no-import-prefix no-explicit-any

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildAccpayLineItems,
  buildSupplierBillWhere,
  createSupplierBill,
  createSupplierCreditNote,
  getSupplierBill,
  listSupplierBills,
  mapSupplierBillStatusFilter,
  SupplierBillError,
  updateSupplierBill,
} from "./xero_accpay_books.ts";

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
      reference: "SW-INV",
    }).includes('Reference!=null AND Reference.Contains("SW-INV")'),
    true,
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
