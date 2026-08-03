// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _parseSesDraftForTest,
  listSesDocsReadyReviewsAction,
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
