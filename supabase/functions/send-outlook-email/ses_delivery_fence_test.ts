// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assertOutlookSesDeliveryAllowed } from "./index.ts";

const JOB_ID = "10000000-0000-4000-8000-000000000001";

function fluent(response: { data: any; error: any }) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    limit: () => builder,
    maybeSingle: async () => response,
  };
  return builder;
}

function clientFor(options: {
  invoice?: Record<string, unknown> | null;
  invoiceError?: string;
  job?: Record<string, unknown> | null;
  jobError?: string;
  detail?: boolean;
  detailError?: string;
  document?: Record<string, unknown> | null;
  documentError?: string;
  inbox?: Record<string, unknown> | null;
  inboxError?: string;
}) {
  return {
    from(table: string) {
      if (table === "xero_invoices") {
        return fluent({
          data: options.invoice ?? null,
          error: options.invoiceError
            ? { message: options.invoiceError }
            : null,
        });
      }
      if (table === "jobs") {
        return fluent({
          data: options.job ?? null,
          error: options.jobError ? { message: options.jobError } : null,
        });
      }
      if (table === "makesafe_job_details") {
        return fluent({
          data: options.detail ? { job_id: JOB_ID } : null,
          error: options.detailError ? { message: options.detailError } : null,
        });
      }
      if (table === "job_documents") {
        return fluent({
          data: options.document ?? null,
          error: options.documentError
            ? { message: options.documentError }
            : null,
        });
      }
      if (table === "inbox_events") {
        return fluent({
          data: options.inbox ?? null,
          error: options.inboxError ? { message: options.inboxError } : null,
        });
      }
      return fluent({ data: null, error: null });
    },
  };
}

async function refusal(
  client: any,
  body: Record<string, unknown>,
): Promise<any> {
  return await assertRejects(
    () => assertOutlookSesDeliveryAllowed(client, body),
  );
}

Deno.test("Outlook refuses a PDF with no authoritative provenance", async () => {
  for (
    const attachment of [
      {
        name: "invoice.pdf",
        contentType: "application/pdf",
        contentBytes: "JVBERi0=",
      },
      {
        name: "invoice.dat",
        contentType: "application/octet-stream",
        contentBytes: "JVBERi0xLjQ=",
      },
    ]
  ) {
    const error = await refusal(clientFor({}), {
      to: "client@example.com",
      attachments: [attachment],
    });
    assertEquals(error.status, 409);
    assertEquals(error.refusal.code, "pdf_provenance_required");
  }
});

Deno.test("Outlook forward binds opaque attachments to the stored source job", async () => {
  const mismatch = await refusal(
    clientFor({ inbox: { job_id: JOB_ID } }),
    {
      action: "forward",
      message_id: "graph-message-1",
      job_id: "20000000-0000-4000-8000-000000000002",
    },
  );
  assertEquals(mismatch.status, 409);
  assertEquals(mismatch.refusal.code, "pdf_provenance_required");

  const lookupError = await refusal(
    clientFor({ inboxError: "inbox unavailable" }),
    {
      action: "forward",
      message_id: "graph-message-1",
      job_id: JOB_ID,
    },
  );
  assertEquals(lookupError.status, 503);
  assertEquals(
    lookupError.refusal.code,
    "sealed_ses_fence_check_failed",
  );

  await assertOutlookSesDeliveryAllowed(
    clientFor({
      inbox: { job_id: JOB_ID },
      job: { id: JOB_ID, type: "patio", job_number: "SWP-1" },
    }),
    {
      action: "forward",
      message_id: "graph-message-1",
      job_id: JOB_ID,
    },
  );
});

Deno.test("Outlook refuses an unlinked ACCREC before Graph delivery", async () => {
  const error = await refusal(
    clientFor({
      invoice: {
        xero_invoice_id: "xero-unlinked",
        invoice_type: "ACCREC",
        job_id: null,
      },
    }),
    {
      to: "client@example.com",
      xero_invoice_id: "xero-unlinked",
      attachments: [{
        name: "INV-1.pdf",
        contentType: "application/pdf",
        contentBytes: "JVBERi0=",
      }],
    },
  );
  assertEquals(error.status, 409);
  assertEquals(error.refusal.code, "invoice_link_required");
});

Deno.test("Outlook invoice and job classifier read errors fail closed", async () => {
  const invoiceError = await refusal(
    clientFor({
      invoiceError: "mirror unavailable",
    }),
    {
      xero_invoice_id: "xero-1",
    },
  );
  assertEquals(invoiceError.status, 503);
  assertEquals(
    invoiceError.refusal.code,
    "sealed_ses_fence_check_failed",
  );

  const jobError = await refusal(
    clientFor({
      jobError: "jobs unavailable",
    }),
    {
      job_id: JOB_ID,
    },
  );
  assertEquals(jobError.status, 503);
  assertEquals(jobError.refusal.code, "sealed_ses_fence_check_failed");
});

Deno.test("Outlook allows legacy SWMS invoice and document routes", async () => {
  for (
    const body of [
      {
        xero_invoice_id: "xero-sealed",
        attachments: [{
          name: "invoice.pdf",
          contentType: "application/pdf",
          xero_invoice_id: "xero-sealed",
        }],
      },
      {
        job_id: JOB_ID,
        job_document_id: "document-1",
        attachments: [{
          name: "report.pdf",
          contentType: "application/pdf",
          job_document_id: "document-1",
        }],
      },
    ]
  ) {
    await assertOutlookSesDeliveryAllowed(
      clientFor({
        invoice: {
          xero_invoice_id: "xero-sealed",
          invoice_type: "ACCREC",
          job_id: JOB_ID,
        },
        job: {
          id: JOB_ID,
          type: "makesafe",
          job_number: "SWMS-1",
          ses_money_sealed_at: "2026-07-27T00:00:00Z",
        },
        document: { id: "document-1", job_id: JOB_ID },
      }),
      body,
    );
  }
});

Deno.test("Outlook still refuses an explicitly SES-bound invoice route", async () => {
  const error = await refusal(
    clientFor({
      invoice: {
        xero_invoice_id: "xero-ses-bound",
        invoice_type: "ACCREC",
        job_id: JOB_ID,
        invoice_obligation_revision_id:
          "20000000-0000-4000-8000-000000000002",
      },
      job: { id: JOB_ID, type: "makesafe", job_number: "SWMS-1" },
    }),
    {
      xero_invoice_id: "xero-ses-bound",
      attachments: [{
        name: "invoice.pdf",
        contentType: "application/pdf",
        xero_invoice_id: "xero-ses-bound",
      }],
    },
  );
  assertEquals(error.status, 409);
  assertEquals(error.refusal.code, "sealed_ses_release_required");
});

Deno.test("Outlook leaves ordinary non-SES delivery operational", async () => {
  await assertOutlookSesDeliveryAllowed(
    clientFor({
      job: { id: JOB_ID, type: "patio", job_number: "SWP-1" },
      document: { id: "document-1", job_id: JOB_ID },
    }) as any,
    {
      job_id: JOB_ID,
      attachments: [{
        name: "plans.pdf",
        contentType: "application/pdf",
        job_document_id: "document-1",
      }],
    },
  );
});
