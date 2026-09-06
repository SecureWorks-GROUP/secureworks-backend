import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { SealedSesMoneyFenceLookupError } from "../_shared/sealed_ses_money_fence.ts";
import {
  authorizeSendInvoiceAccess,
  sendInvoiceGenericNotFound,
  type SendInvoiceAccessDeps,
  type SendInvoiceJobRow,
  type SendInvoiceMirrorRow,
} from "./send_invoice_access.ts";

const ORG_A = "org-a";
const ORG_B = "org-b";
const JOB_A = "job-a";
const JOB_B = "job-b";
const INVOICE = "inv-guess";

function invoiceRow(overrides: Partial<SendInvoiceMirrorRow> = {}): SendInvoiceMirrorRow {
  return {
    invoice_type: "ACCREC",
    job_id: JOB_A,
    invoice_obligation_revision_id: null,
    ses_external_token: null,
    invoice_number: "INV-1",
    total: 110,
    due_date: "2026-09-20",
    ...overrides,
  };
}

function jobRow(overrides: Partial<SendInvoiceJobRow> = {}): SendInvoiceJobRow {
  return {
    job_number: "SWF-1",
    type: "fencing",
    ghl_contact_id: "ghl-1",
    org_id: ORG_A,
    client_email: "pat@example.test",
    client_name: "Pat",
    site_address: "1 Test St",
    site_suburb: "Testville",
    ...overrides,
  };
}

function deps(input: {
  invoice?: { data: SendInvoiceMirrorRow | null; error?: { message?: string } | null };
  job?: { data: SendInvoiceJobRow | null; error?: { message?: string } | null };
  inspect?: SendInvoiceAccessDeps["inspectSealedJob"];
}): SendInvoiceAccessDeps & { inspected: string[] } {
  const inspected: string[] = [];
  return {
    inspected,
    loadInvoice: async () =>
      input.invoice
        ? { data: input.invoice.data, error: input.invoice.error ?? null }
        : { data: invoiceRow(), error: null },
    loadJob: async () =>
      input.job
        ? { data: input.job.data, error: input.job.error ?? null }
        : { data: jobRow(), error: null },
    inspectSealedJob: async (jobId) => {
      inspected.push(jobId);
      if (input.inspect) return await input.inspect(jobId);
      return { sealed: false, matched_by: null, job: { id: jobId } };
    },
  };
}

Deno.test("R13-002 JWT missing invoice is generic 404 and never inspects sealed", async () => {
  const d = deps({ invoice: { data: null } });
  const result = await authorizeSendInvoiceAccess({
    authMode: "jwt",
    callerOrgId: ORG_A,
    bodyJobId: JOB_A,
    xeroInvoiceId: INVOICE,
    deps: d,
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.status, 404);
    assertEquals(result.body, sendInvoiceGenericNotFound());
    assertEquals(result.steps, ["invoice_lookup"]);
    assertEquals(JSON.stringify(result.body).includes(JOB_A), false);
  }
  assertEquals(d.inspected, []);
});

Deno.test("R13-002 JWT invoice read fault is generic 404 without fence detail", async () => {
  const d = deps({ invoice: { data: null, error: { message: "mirror down" } } });
  const result = await authorizeSendInvoiceAccess({
    authMode: "jwt",
    callerOrgId: ORG_A,
    bodyJobId: JOB_A,
    xeroInvoiceId: INVOICE,
    deps: d,
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.status, 404);
    assertEquals(result.body, sendInvoiceGenericNotFound());
    assertEquals(JSON.stringify(result.body).includes("mirror"), false);
  }
  assertEquals(d.inspected, []);
});

Deno.test("R13-002 JWT foreign-org invoice 404s before binding or sealed", async () => {
  const d = deps({
    invoice: { data: invoiceRow({ job_id: JOB_B }) },
    job: { data: jobRow({ org_id: ORG_B }) },
  });
  const result = await authorizeSendInvoiceAccess({
    authMode: "jwt",
    callerOrgId: ORG_A,
    bodyJobId: JOB_B,
    xeroInvoiceId: INVOICE,
    deps: d,
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.status, 404);
    assertEquals(result.body, sendInvoiceGenericNotFound());
    assertEquals(result.steps, ["invoice_lookup", "job_lookup", "tenant"]);
    assertEquals(JSON.stringify(result.body).includes(JOB_B), false);
    assertEquals(JSON.stringify(result.body).includes(ORG_B), false);
  }
  assertEquals(d.inspected, []);
});

Deno.test("R13-002 JWT same-org caller reaches binding then sealed", async () => {
  const d = deps({});
  const result = await authorizeSendInvoiceAccess({
    authMode: "jwt",
    callerOrgId: ORG_A,
    bodyJobId: JOB_A,
    xeroInvoiceId: INVOICE,
    deps: d,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.steps, [
      "invoice_lookup",
      "job_lookup",
      "tenant",
      "binding",
      "sealed",
    ]);
    assertEquals(result.invoice.job_id, JOB_A);
  }
  assertEquals(d.inspected, [JOB_A]);
});

Deno.test("R13-002 JWT same-org binding refusal may be detailed after tenant", async () => {
  const d = deps({
    invoice: { data: invoiceRow({ job_id: JOB_A, ses_external_token: "ses-1" }) },
  });
  const result = await authorizeSendInvoiceAccess({
    authMode: "jwt",
    callerOrgId: ORG_A,
    bodyJobId: JOB_A,
    xeroInvoiceId: INVOICE,
    deps: d,
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.status, 409);
    assertEquals(result.steps.includes("tenant"), true);
    assertEquals(result.steps.includes("binding"), true);
    assertEquals(result.steps.includes("sealed"), false);
    assertNotEquals(result.body.code, "invoice_not_found");
  }
  assertEquals(d.inspected, []);
});

Deno.test("R13-002 API-key missing invoice keeps detailed 503", async () => {
  const d = deps({ invoice: { data: null } });
  const result = await authorizeSendInvoiceAccess({
    authMode: "api_key",
    callerOrgId: null,
    bodyJobId: JOB_A,
    xeroInvoiceId: INVOICE,
    deps: d,
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.status, 503);
    assertEquals(result.body.success, false);
  }
  assertEquals(d.inspected, []);
});

Deno.test("R13-002 sealed inspection is skipped when tenant fails", async () => {
  let inspectCalls = 0;
  const d = deps({
    job: { data: jobRow({ org_id: ORG_B }) },
    inspect: async () => {
      inspectCalls += 1;
      throw new SealedSesMoneyFenceLookupError("should not run");
    },
  });
  const result = await authorizeSendInvoiceAccess({
    authMode: "jwt",
    callerOrgId: ORG_A,
    bodyJobId: JOB_A,
    xeroInvoiceId: INVOICE,
    deps: d,
  });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.status, 404);
    assertEquals(result.body, sendInvoiceGenericNotFound());
  }
  assertEquals(inspectCalls, 0);
});
