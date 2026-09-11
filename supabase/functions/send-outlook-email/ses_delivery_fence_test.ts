// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertOutlookSesDeliveryAllowed,
  classifyOutlookRoute,
  handleOutlookRequest,
} from "./index.ts";

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
    clientFor({ inbox: { job_id: JOB_ID, mailbox: "admin@secureworkswa.com.au" } }),
    {
      action: "forward",
      message_id: "graph-message-1",
      mailbox: "admin@secureworkswa.com.au",
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
      inbox: { job_id: JOB_ID, mailbox: "admin@secureworkswa.com.au" },
      job: { id: JOB_ID, type: "patio", job_number: "SWP-1" },
    }),
    {
      action: "forward",
      message_id: "graph-message-1",
      mailbox: "admin@secureworkswa.com.au",
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

// A real user mailbox. patios@ is a Microsoft 365 Group, so production
// refuses it at the route classifier before this fence is ever reached; the
// group refusal is asserted separately below.
const REPLY_MAILBOX = "shaun@secureworkswa.com.au";
const REPLY_GROUP_MAILBOX = "patios@secureworkswa.com.au";
const REPLY_MESSAGE_ID = "graph-message-wayne";
const REPLY_SENDER = "waynesworld05@hotmail.com";

function senderOnlyReply(overrides: Record<string, unknown> = {}) {
  return {
    action: "reply",
    mailbox: REPLY_MAILBOX,
    message_id: REPLY_MESSAGE_ID,
    htmlBody: "<p>Reviewed reply</p>",
    content_reviewed: true,
    expected_to: [REPLY_SENDER],
    expected_cc: [],
    ...overrides,
  };
}

function inboxRow(overrides: Record<string, unknown> = {}) {
  return {
    job_id: null,
    mailbox: REPLY_MAILBOX,
    from_email: REPLY_SENDER,
    ...overrides,
  };
}

Deno.test("a reply to a jobless message is allowed to its stored sender from the receiving mailbox", async () => {
  await assertOutlookSesDeliveryAllowed(
    clientFor({ inbox: inboxRow() }) as any,
    senderOnlyReply(),
  );
  // Case differences in the stored identities do not change the decision.
  await assertOutlookSesDeliveryAllowed(
    clientFor({ inbox: inboxRow({ from_email: "WaynesWorld05@Hotmail.com" }) }) as any,
    senderOnlyReply({ mailbox: "Shaun@SecureWorksWA.com.au" }),
  );
});

Deno.test("a jobless reply cannot be redirected, widened or given attachments", async () => {
  const widenings: Record<string, unknown>[] = [
    { expected_to: ["someone@else.example"] },
    { expected_to: [REPLY_SENDER, "someone@else.example"] },
    { expected_cc: ["someone@else.example"] },
    { reply_all: true },
    { to: "someone@else.example" },
    { to_email: "someone@else.example" },
    { cc: "someone@else.example" },
    { bcc: "someone@else.example" },
    {
      attachments: [{
        name: "quote.pdf",
        contentType: "application/pdf",
        contentBytes: "JVBERi0=",
      }],
    },
  ];
  for (const widening of widenings) {
    const error = await refusal(
      clientFor({ inbox: inboxRow() }),
      senderOnlyReply(widening),
    );
    assertEquals(error.status, 409, JSON.stringify(widening));
    assertEquals(
      error.refusal.code,
      "reply_sender_only_required",
      JSON.stringify(widening),
    );
  }
});

Deno.test("a jobless reply refuses an unusable or group stored sender", async () => {
  for (
    const from_email of [null, "", "not-an-address", REPLY_GROUP_MAILBOX]
  ) {
    const error = await refusal(
      clientFor({ inbox: inboxRow({ from_email }) }),
      senderOnlyReply({ expected_to: [from_email || REPLY_SENDER] }),
    );
    assertEquals(error.status, 409, String(from_email));
    assertEquals(
      error.refusal.code,
      "reply_sender_only_required",
      String(from_email),
    );
  }
});

Deno.test("a reply refuses an unknown source message or a mailbox that did not receive it", async () => {
  const unknown = await refusal(clientFor({ inbox: null }), senderOnlyReply());
  assertEquals(unknown.status, 409);
  assertEquals(unknown.refusal.code, "pdf_provenance_required");

  const wrongMailbox = await refusal(
    clientFor({ inbox: inboxRow({ mailbox: "marnin@secureworkswa.com.au" }) }),
    senderOnlyReply(),
  );
  assertEquals(wrongMailbox.status, 409);
  assertEquals(wrongMailbox.refusal.code, "pdf_provenance_required");
  assertEquals(
    wrongMailbox.refusal.evidence.stored_mailbox,
    "marnin@secureworkswa.com.au",
  );
});

Deno.test("a message that has a stored job still requires that job_id on the reply", async () => {
  const error = await refusal(
    clientFor({ inbox: inboxRow({ job_id: JOB_ID }) }),
    senderOnlyReply(),
  );
  assertEquals(error.status, 409);
  assertEquals(error.refusal.code, "pdf_provenance_required");
  assertEquals(error.refusal.evidence.stored_job_id, JOB_ID);
  assertEquals(error.refusal.evidence.received_job_id, null);
});

Deno.test("the job-anchored reply path still refuses a decoy job and a failed lookup", async () => {
  const decoy = await refusal(
    clientFor({ inbox: inboxRow({ job_id: JOB_ID }) }),
    senderOnlyReply({ job_id: "20000000-0000-4000-8000-000000000009" }),
  );
  assertEquals(decoy.status, 409);
  assertEquals(decoy.refusal.code, "pdf_provenance_required");
  assertEquals(decoy.refusal.evidence.stored_job_id, JOB_ID);

  const lookupFailed = await refusal(
    clientFor({ inboxError: "inbox unavailable" }),
    senderOnlyReply(),
  );
  assertEquals(lookupFailed.status, 503);
  assertEquals(lookupFailed.refusal.code, "sealed_ses_fence_check_failed");
});

Deno.test("a job-anchored reply on the stored mailbox and job remains allowed", async () => {
  await assertOutlookSesDeliveryAllowed(
    clientFor({
      inbox: inboxRow({ job_id: JOB_ID }),
      job: { id: JOB_ID, type: "patio", job_number: "SWP-1" },
    }) as any,
    senderOnlyReply({ job_id: JOB_ID, expected_cc: ["ops@secureworkswa.com.au"] }),
  );
});

Deno.test("a blank job_id refuses instead of selecting the sender-only path", async () => {
  for (const job_id of ["", "   "]) {
    const error = await refusal(
      clientFor({ inbox: inboxRow() }),
      senderOnlyReply({ job_id }),
    );
    assertEquals(error.status, 409, JSON.stringify(job_id));
    assertEquals(
      error.refusal.code,
      "pdf_provenance_required",
      JSON.stringify(job_id),
    );
    assertEquals(
      error.refusal.fact,
      "job_id was supplied but is blank, so no job anchor could be resolved.",
    );
  }
});

Deno.test("a Group mailbox is still refused before the reply fence runs", async () => {
  // The classifier marks a known Group address as a group route...
  assertEquals(
    classifyOutlookRoute({
      action: "reply",
      mailbox: REPLY_GROUP_MAILBOX,
      message_id: REPLY_MESSAGE_ID,
    }),
    {
      kind: "group",
      group: REPLY_GROUP_MAILBOX,
      reason: "known_group_sender_requires_group_action",
    },
  );

  // ...and the request handler turns that into a refusal for every non-forward
  // action, before any Supabase or Graph call. A sender-only reply cannot be
  // used to reach a Microsoft 365 Group.
  const fixture = {
    SW_API_KEY: "public-fixture",
    OPS_AGENT_SERVER_KEY: "ops-fixture",
    SUPABASE_SERVICE_ROLE_KEY: "service-fixture",
  };
  const previous = Object.fromEntries(
    Object.keys(fixture).map((key) => [key, Deno.env.get(key)]),
  );
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    throw new Error("Provider must not be called");
  }) as typeof fetch;
  try {
    for (const [key, value] of Object.entries(fixture)) Deno.env.set(key, value);
    const response = await handleOutlookRequest(
      new Request("https://example.invalid/send-outlook-email", {
        method: "POST",
        headers: { "x-api-key": "ops-fixture" },
        body: JSON.stringify(senderOnlyReply({ mailbox: REPLY_GROUP_MAILBOX })),
      }),
    );
    assertEquals(response.status, 400);
    assertEquals((await response.json()).code, "group_route_required");
    assertEquals(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
    }
  }
});
