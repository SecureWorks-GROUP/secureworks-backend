// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  approveSesInvoiceVoidRevisionAction,
  executeSesInvoiceVoidRevisionAction,
  prepareSesInvoiceVoidRevisionAction,
  targetSesInvoiceVoidStatus,
} from "./ses_invoice_void.ts";
import { SesActionError } from "./ses_reporting_actions.ts";

const JOB_ID = "10000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-0000-0000-000000000001";

function fluent(response: { data: any; error: any }) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    limit: () => builder,
    maybeSingle: async () => response,
    single: async () => response,
    insert: () => builder,
  };
  return builder;
}

function clientFor(options: {
  invoice: Record<string, unknown> | null;
  job?: Record<string, unknown> | null;
  detail?: boolean;
  invoiceError?: string;
  jobError?: string;
}) {
  return {
    from(table: string) {
      if (table === "xero_invoices") {
        return fluent({
          data: options.invoice,
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
          error: null,
        });
      }
      return fluent({ data: { id: "void-revision" }, error: null });
    },
  };
}

Deno.test("SES void target is server-selected and paid invoices are immutable", () => {
  assertEquals(targetSesInvoiceVoidStatus("DRAFT"), "DELETED");
  assertEquals(targetSesInvoiceVoidStatus("SUBMITTED"), "VOIDED");
  assertEquals(targetSesInvoiceVoidStatus("AUTHORISED"), "VOIDED");
  for (const status of ["PAID", "VOIDED", "DELETED", "", "unknown"]) {
    assertRejects(
      async () => targetSesInvoiceVoidStatus(status),
      SesActionError,
    );
  }
});

Deno.test("SES void prepare refuses unlinked ACCREC before any revision write", async () => {
  const error = await assertRejects(
    () =>
      prepareSesInvoiceVoidRevisionAction(
        clientFor({
          invoice: {
            xero_invoice_id: "xero-unlinked",
            invoice_type: "ACCREC",
            job_id: null,
            status: "AUTHORISED",
          },
        }) as any,
        {
          org_id: ORG_ID,
          xero_invoice_id: "xero-unlinked",
          reason: "Duplicate builder invoice",
          created_by: "captain@example.com",
        },
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(error.status, 409);
  assertEquals((error.refusal as any).code, "invoice_link_required");
});

Deno.test("SES void prepare refuses missing classifier authority", async () => {
  const error = await assertRejects(
    () =>
      prepareSesInvoiceVoidRevisionAction(
        clientFor({
          invoice: {
            xero_invoice_id: "xero-linked",
            invoice_type: "ACCREC",
            job_id: JOB_ID,
            status: "AUTHORISED",
          },
          job: null,
        }) as any,
        {
          org_id: ORG_ID,
          xero_invoice_id: "xero-linked",
          reason: "Duplicate builder invoice",
          created_by: "captain@example.com",
        },
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(error.status, 503);
});

Deno.test("SES void prepare commits through the atomic authority RPC", async () => {
  let rpcName = "";
  let rpcArgs: Record<string, unknown> = {};
  const base = clientFor({
    invoice: {
      xero_invoice_id: "xero-linked",
      invoice_number: "INV-TEST",
      invoice_type: "ACCREC",
      job_id: JOB_ID,
      status: "AUTHORISED",
      invoice_obligation_revision_id: null,
      ses_external_token: "ses-bound",
    },
    job: {
      id: JOB_ID,
      type: "general",
      job_number: "GEN-100",
      ses_money_sealed_at: "2026-07-27T00:00:00.000Z",
      ses_money_seal_source: "makesafe_invoice_obligation",
    },
  });
  const client = {
    ...base,
    rpc(name: string, args: Record<string, unknown>) {
      rpcName = name;
      rpcArgs = args;
      return Promise.resolve({
        data: { id: args.p_id, state: "proposed" },
        error: null,
      });
    },
  };
  const prepared = await prepareSesInvoiceVoidRevisionAction(
    client as any,
    {
      org_id: ORG_ID,
      xero_invoice_id: "xero-linked",
      reason: "Duplicate builder invoice",
      created_by: "captain@example.com",
    },
  );
  assertEquals(rpcName, "commit_ses_invoice_void_revision_v1");
  assertEquals(rpcArgs.p_job_id, JOB_ID);
  assertEquals(rpcArgs.p_target_status, "VOIDED");
  assertEquals(prepared.external_mutations, { xero: 0, email: 0 });
});

Deno.test("SES void approval requires an identified captain", async () => {
  const error = await assertRejects(
    () =>
      approveSesInvoiceVoidRevisionAction(
        clientFor({ invoice: null }) as any,
        { mode: "api_key", user: null },
        { void_revision_id: "void-revision" },
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(error.status, 403);
});

Deno.test("SES void execute refuses classifier errors before Xero", async () => {
  let providerCalls = 0;
  const client = {
    from(table: string) {
      if (table === "makesafe_invoice_void_revisions") {
        return fluent({
          data: {
            id: "void-revision",
            org_id: ORG_ID,
            job_id: JOB_ID,
            xero_invoice_id: "xero-linked",
            observed_status: "AUTHORISED",
            target_status: "VOIDED",
            content_hash:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          error: null,
        });
      }
      if (table === "jobs") {
        return fluent({
          data: null,
          error: { message: "job authority unavailable" },
        });
      }
      return fluent({ data: null, error: null });
    },
    rpc: async () => ({ data: null, error: null }),
  };
  const error = await assertRejects(
    () =>
      executeSesInvoiceVoidRevisionAction(
        client as any,
        {
          org_id: ORG_ID,
          void_revision_id: "void-revision",
          actor: "captain@example.com",
        },
        {
          async voidInvoice() {
            providerCalls++;
            return { xero_invoice_id: "xero-linked", status: "VOIDED" };
          },
          async reconcileVoid() {
            providerCalls++;
            return [];
          },
        },
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(error.status, 503);
  assertEquals(providerCalls, 0);
});
