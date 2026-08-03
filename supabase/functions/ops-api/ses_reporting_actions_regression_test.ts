// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _parseSesDraftForTest,
  listSesDocsReadyReviewsAction,
  resolveDocketRoutes,
  SesActionError,
} from "./ses_reporting_actions.ts";

Deno.test("blank Cc cannot consume the following Subject header", () => {
  const report = _parseSesDraftForTest(
    "report",
    [
      "To: reports@builder.example",
      "Cc:",
      "Subject: Generic report subject",
      "Attachments: report-hash",
      "",
      "Generic report body.",
    ].join("\n"),
  );
  assertEquals(report?.cc, []);
  assertEquals(report?.subject, "Generic report subject");
  assertEquals(report?.ready, true);

  const invoice = _parseSesDraftForTest(
    "invoice",
    [
      "To: invoices@builder.example",
      "Cc: finance@builder.example",
      "Subject: Generic invoice subject",
      "Attachments: invoice-hash",
      "",
      "Generic invoice body.",
    ].join("\n"),
  );
  assertEquals(invoice?.cc, ["finance@builder.example"]);
  assertEquals(invoice?.subject, "Generic invoice subject");
});

Deno.test("non-email Cc is never exposed as a typed review recipient", () => {
  const route = _parseSesDraftForTest(
    "photo",
    "To: photos@builder.example\nCc: Generic photo subject\nSubject: Generic photo subject\n\nBody",
  );
  assertEquals(route?.cc, []);
  assertEquals(route?.ready, false);
});

function invoiceDocket(
  stage: "pre_xero" | "invoice_bound",
  attachments: string[],
  xero: Record<string, unknown> | null = null,
) {
  return {
    id: "docket-fixture",
    stage,
    local_invoice_proposal: { builder_reference: "REF-TEST-1" },
    xero_binding: xero,
    email_drafts: {
      INVOICE_EMAIL_DRAFT: [
        "To: invoices@builder.example",
        "Cc:",
        "Subject: Privacy-safe invoice fixture",
        `Attachments: ${attachments.join(", ")}`,
        "",
        "Fixture body.",
      ].join("\n"),
    },
  };
}

const ROUTE_ARTIFACTS = [{
  role: "invoice_proposal",
  object_key: "bucket/docket-fixture/ARTIFACTS/invoice_proposal.json",
  media_type: "application/json",
  content_hash: "proposal-hash",
}, {
  role: "supporting_report_pdf",
  object_key: "bucket/docket-fixture/ARTIFACTS/report.pdf",
  media_type: "application/pdf",
  content_hash: "report-hash",
}, {
  role: "swms_artifact",
  object_key: "bucket/docket-fixture/ARTIFACTS/swms.pdf",
  media_type: "application/pdf",
  content_hash: "swms-hash",
}, {
  role: "xero_invoice_pdf",
  object_key: "bucket/docket-fixture/ARTIFACTS/xero-invoice.pdf",
  media_type: "application/pdf",
  content_hash: "xero-hash",
}];

Deno.test("assessment and physical pre-Xero invoice routes hide proposal state and remain non-sendable", () => {
  const assessment = resolveDocketRoutes(
    invoiceDocket("pre_xero", ["ARTIFACTS/invoice_proposal.json"]),
    ROUTE_ARTIFACTS,
    null,
  )[0];
  assertEquals(assessment.attachment_hashes, []);
  assertEquals(assessment.ready, false);

  const physical = resolveDocketRoutes(
    invoiceDocket("pre_xero", [
      "ARTIFACTS/invoice_proposal.json",
      "ARTIFACTS/report.pdf",
      "ARTIFACTS/swms.pdf",
    ]),
    ROUTE_ARTIFACTS,
    null,
  )[0];
  assertEquals(physical.attachment_hashes, ["report-hash", "swms-hash"]);
  assertEquals(physical.ready, false);
});

Deno.test("invoice-bound route requires the authorised Xero PDF and keeps approved support", () => {
  const attachments = [
    "ARTIFACTS/invoice_proposal.json",
    "ARTIFACTS/report.pdf",
    "ARTIFACTS/swms.pdf",
  ];
  const authorised = resolveDocketRoutes(
    invoiceDocket("invoice_bound", attachments, {
      status: "AUTHORISED",
      invoice_number: "INV-TEST-1",
    }),
    ROUTE_ARTIFACTS,
    null,
  )[0];
  assertEquals(authorised.attachment_hashes, [
    "xero-hash",
    "report-hash",
    "swms-hash",
  ]);
  assertEquals(authorised.ready, true);

  const draft = resolveDocketRoutes(
    invoiceDocket("invoice_bound", attachments, {
      status: "DRAFT",
      invoice_number: "INV-TEST-1",
    }),
    ROUTE_ARTIFACTS,
    null,
  )[0];
  assertEquals(draft.ready, false);
});

function listClient(options: { proposalError?: boolean } = {}) {
  const calls: string[] = [];
  const client = {
    from(table: string) {
      calls.push(table);
      if (table === "ses_docket_review_current") {
        const query: any = {
          select: () => query,
          eq: () => query,
          order: () => query,
          limit: () =>
            Promise.resolve({
              data: [{
                org_id: "org-1",
                job_id: "job-1",
                docket_revision_id: "docket-1",
                review_state: "needs_review",
              }],
              error: null,
            }),
        };
        return query;
      }
      if (table === "makesafe_docket_revisions") {
        const query: any = {
          select: () => query,
          in: () =>
            Promise.resolve(
              options.proposalError
                ? { data: null, error: { message: "summary unavailable" } }
                : {
                  data: [{
                    id: "docket-1",
                    local_invoice_proposal: {
                      subtotal_ex_gst: 123,
                      total_inc_gst: 135.3,
                    },
                  }],
                  error: null,
                },
            ),
        };
        return query;
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as any;
  return { client, calls };
}

Deno.test("Docs Ready list hydrates the exact docket proposal shape", async () => {
  const { client, calls } = listClient();
  const result = await listSesDocsReadyReviewsAction(
    client,
    { mode: "api_key", user: null },
  );
  assertEquals(result.dockets[0].local_invoice_proposal, {
    subtotal_ex_gst: 123,
    total_inc_gst: 135.3,
  });
  assertEquals(calls, [
    "ses_docket_review_current",
    "makesafe_docket_revisions",
  ]);
});

Deno.test("Docs Ready list refuses rather than masking proposal hydration failure", async () => {
  const { client } = listClient({ proposalError: true });
  const error = await assertRejects(
    () =>
      listSesDocsReadyReviewsAction(
        client,
        { mode: "api_key", user: null },
      ),
    SesActionError,
  );
  assertEquals(error.status, 503);
});
