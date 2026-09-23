// Money slice MN1: the one provider-invoice path (money.md §6 step 2, review
// M1). Every Xero read that lands an invoice on our copy uses the same row
// builders and runs the same effects: reference link, deposit stamp, and the
// paid-job automation.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyProviderInvoice,
  applyProviderInvoiceEffects,
  buildInvoiceRecord,
  buildVerifiedInvoicePatch,
} from "./xero_invoice_record.ts";
import {
  reconcileStaleXeroInvoices,
  reconcileXeroInvoice,
} from "./xero_invoice_reconciliation.ts";
import { fakeDb } from "./money_test_db.ts";
import { M17, M5, M6, ORG, xeroInvoice } from "./money_named_rows.ts";

const NOW = new Date("2026-09-24T02:00:00.000Z");

function deps(completed: string[] = []) {
  return {
    orgId: ORG,
    now: () => NOW,
    completeInvoicedJob: (jobId: string) => {
      completed.push(jobId);
      return Promise.resolve();
    },
  };
}

Deno.test("list-read row: the pre-MN1 loop record, plus xero_verified_at", () => {
  const inv = xeroInvoice({
    InvoiceID: M6.id,
    InvoiceNumber: M6.number,
    Status: "AUTHORISED",
    Reference: M6.reference_after,
    Contact: { ContactID: "c-m6", Name: "Customer M6" },
    SubTotal: 818.18,
    TotalTax: 81.82,
    Total: 900,
    AmountDue: 900,
    AmountPaid: 0,
    DateString: "2026-09-01T00:00:00",
    DueDateString: "2026-09-15T00:00:00",
    UpdatedDateUTC: "/Date(1790121600000+0000)/",
  });
  const row = buildInvoiceRecord(inv, ORG, NOW);
  assertEquals(Object.keys(row).sort(), [
    "amount_due",
    "amount_paid",
    "contact_name",
    "currency_code",
    "due_date",
    "fully_paid_on",
    "invoice_date",
    "invoice_number",
    "invoice_type",
    "line_items",
    "org_id",
    "raw_json",
    "reference",
    "status",
    "sub_total",
    "synced_at",
    "total",
    "total_tax",
    "updated_at",
    "xero_contact_id",
    "xero_invoice_id",
    "xero_verified_at",
  ]);
  assertEquals(row.reference, M6.reference_after);
  assertEquals(row.xero_contact_id, "c-m6");
  assertEquals(row.updated_at, "2026-09-23T00:00:00.000Z");
  assertEquals(row.xero_verified_at, NOW.toISOString());
  assertEquals(row.synced_at, NOW.toISOString());
});

Deno.test("M5, M6 on the verify path: a single-record read now carries payer and reference", () => {
  const patch = buildVerifiedInvoicePatch({
    InvoiceID: M5.id,
    Type: "ACCREC",
    Status: "AUTHORISED",
    AmountDue: 1200,
    AmountPaid: 0,
    Contact: { ContactID: M5.contact_after, Name: "Customer M5 (now)" },
    Reference: M6.reference_after,
  }, NOW);
  assertEquals(patch.xero_contact_id, M5.contact_after);
  assertEquals(patch.contact_name, "Customer M5 (now)");
  assertEquals(patch.reference, M6.reference_after);
  assertEquals(patch.xero_verified_at, NOW.toISOString());
  // An explicit empty reference clears it; an absent one leaves it alone, as
  // an absent contact, due date or line list does.
  assertEquals(
    buildVerifiedInvoicePatch({ Status: "PAID", Reference: "" }, NOW).reference,
    null,
  );
  const sparse = buildVerifiedInvoicePatch({ Status: "PAID" }, NOW);
  for (const k of ["reference", "xero_contact_id", "contact_name", "due_date", "line_items", "updated_at"]) {
    assert(!(k in sparse), `${k} must not be erased by an omission`);
  }
});

Deno.test("M5 on the verify path: reconcileXeroInvoice writes the live payer onto our copy", async () => {
  const db = fakeDb({
    tables: {
      xero_invoices: [{
        org_id: ORG,
        xero_invoice_id: M5.id,
        status: "AUTHORISED",
        amount_due: 1200,
        xero_contact_id: M5.contact_before,
      }],
    },
  });
  await reconcileXeroInvoice(db.client, ORG, M5.id, () =>
    Promise.resolve({
      Invoices: [{
        InvoiceID: M5.id,
        Type: "ACCREC",
        Status: "AUTHORISED",
        AmountDue: 1200,
        AmountPaid: 0,
        Contact: { ContactID: M5.contact_after, Name: "Customer M5 (now)" },
      }],
    }), NOW);
  const row = db.table("xero_invoices")[0];
  assertEquals(row.xero_contact_id, M5.contact_after);
  assertEquals(row.xero_verified_at, NOW.toISOString());
});

Deno.test("list-read apply keeps the job link, and links a new invoice by its whole-token reference", async () => {
  const db = fakeDb({
    tables: {
      xero_invoices: [{
        org_id: ORG,
        xero_invoice_id: M6.id,
        job_id: M6.job_id,
        job_contact_id: "party-1",
        status: "AUTHORISED",
      }],
      jobs: [{ id: "job-261500", org_id: ORG, job_number: "SWF-261500", type: "fencing" }],
    },
  });
  // M6's new reference names no job number: the stored link stays.
  const kept = await applyProviderInvoice(
    db.client,
    xeroInvoice({ InvoiceID: M6.id, Status: "AUTHORISED", Reference: M6.reference_after, Total: 900, AmountDue: 900 }),
    NOW,
    deps(),
  );
  assertEquals(kept.written, true);
  const m6 = db.table("xero_invoices").find((r) => r.xero_invoice_id === M6.id)!;
  assertEquals([m6.job_id, m6.job_contact_id, m6.reference], [M6.job_id, "party-1", M6.reference_after]);
  // A new invoice naming SWF-261500 is linked; SWF-2615001 would not be.
  const linked = await applyProviderInvoice(
    db.client,
    xeroInvoice({ InvoiceID: "new-1", Status: "AUTHORISED", Reference: "SWF-261500 balance", Total: 1, AmountDue: 1 }),
    NOW,
    deps(),
  );
  assertEquals(linked.linked_job_id, "job-261500");
  const notLinked = await applyProviderInvoice(
    db.client,
    xeroInvoice({ InvoiceID: "new-2", Status: "AUTHORISED", Reference: "SWF-2615001", Total: 1, AmountDue: 1 }),
    NOW,
    deps(),
  );
  assertEquals(notLinked.linked_job_id, null);
  assertEquals(db.table("xero_invoices").find((r) => r.xero_invoice_id === "new-2")!.job_id, undefined);
});

Deno.test("a sealed SES invoice is never linked by reference or completed by the paid automation", async () => {
  const db = fakeDb({
    tables: {
      xero_invoices: [{
        org_id: ORG,
        xero_invoice_id: "ses-1",
        invoice_type: "ACCREC",
        job_id: "job-ses",
        ses_external_token: "tok",
        status: "AUTHORISED",
      }],
      jobs: [{ id: "job-ses", org_id: ORG, job_number: "SWMS-261100", status: "invoiced" }],
    },
  });
  const completed: string[] = [];
  const r = await applyProviderInvoice(
    db.client,
    xeroInvoice({ InvoiceID: "ses-1", Status: "PAID", Reference: "SWMS-261100", Total: 5, AmountDue: 0, AmountPaid: 5 }),
    NOW,
    deps(completed),
  );
  assertEquals(r.ses_refusals.length, 2);
  assertEquals(completed, []);
});

Deno.test("M17 on the verify path: the hourly verify now runs the paid automation, not only the deposit stamp", async () => {
  // Before MN1 the verify's hook ran the deposit stamp alone, so a job whose
  // last invoice closed there never completed. The hook is now the shared
  // effects function.
  const db = fakeDb({
    tables: {
      xero_invoices: [{
        org_id: ORG,
        xero_invoice_id: M17.id,
        invoice_type: "ACCREC",
        job_id: M17.job_id,
        status: "AUTHORISED",
        amount_due: 1650,
        synced_at: "2026-09-24T00:00:00.000Z",
      }],
      jobs: [{
        id: M17.job_id,
        org_id: ORG,
        job_number: "SWF-269017",
        status: "invoiced",
        deposit_at: null,
        deposit_invoice_id: M17.id,
      }],
      xero_sync_state: [{ key: "draft_reconcile_last_run_at", cursor_at: NOW.toISOString() }],
    },
  });
  const completed: string[] = [];
  const summary = await reconcileStaleXeroInvoices(
    db.client,
    ORG,
    () =>
      Promise.resolve({
        Invoices: [xeroInvoice({
          InvoiceID: M17.id,
          Status: "PAID",
          Total: 1650,
          AmountDue: 0,
          AmountPaid: 1650,
          FullyPaidOnDate: M17.paid_on,
        })],
      }),
    NOW,
    async (_id, payload: any) => {
      await applyProviderInvoiceEffects(db.client, payload.Invoices[0], null, deps(completed));
    },
  );
  assertEquals(summary.reconciled, 1);
  assertEquals(db.table("jobs")[0].deposit_at, "2026-09-23T00:00:00.000Z");
  assertEquals(completed, [M17.job_id]);
  // The same PAID invoice read again by the incremental loop stamps nothing new.
  const again = await applyProviderInvoice(
    db.client,
    xeroInvoice({ InvoiceID: M17.id, Status: "PAID", Total: 1650, AmountDue: 0, AmountPaid: 1650, FullyPaidOnDate: M17.paid_on }),
    NOW,
    deps(completed),
  );
  assertEquals(again.deposit, null);
  assertEquals(
    db.table("business_events").filter((e) => e.event_type === "job.deposit_stamped").length,
    1,
  );
});

Deno.test("with the open-book sweep in apply the hourly open verify is skipped; drafts are not", async () => {
  const db = fakeDb({
    tables: {
      xero_invoices: [
        { org_id: ORG, xero_invoice_id: "open-1", invoice_type: "ACCREC", status: "AUTHORISED", amount_due: 5, synced_at: "2026-09-23T00:00:00.000Z" },
        { org_id: ORG, xero_invoice_id: "draft-1", invoice_type: "ACCREC", status: "DRAFT", amount_due: 5, synced_at: "2026-09-20T00:00:00.000Z" },
      ],
    },
  });
  const read: string[] = [];
  const summary = await reconcileStaleXeroInvoices(
    db.client,
    ORG,
    (id) => {
      read.push(id);
      return Promise.resolve({
        Invoices: [{ InvoiceID: id, Type: "ACCREC", Status: "DELETED", AmountDue: 0, AmountPaid: 0 }],
      });
    },
    NOW,
    undefined,
    { skipOpen: true },
  );
  assertEquals(read, ["draft-1"]);
  assertEquals(summary.open_verify_skipped, true);
});
