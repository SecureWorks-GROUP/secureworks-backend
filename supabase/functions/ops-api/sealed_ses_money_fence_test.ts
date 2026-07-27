// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifySealedSesJob,
  sealedSesMoneyRefusal,
} from "../_shared/sealed_ses_money_fence.ts";
import {
  _assertGhlContactMatchesResolvedJobForTest,
  _assertLegacySesInvoiceActionAllowedForTest,
  _assertLegacySesInvoiceOrJobActionAllowedForTest,
  _assertLegacySesMoneyActionAllowedForJobForTest,
  _createInvoiceForTest,
  _makeSesXeroGatewayForTest,
} from "./index.ts";
import {
  executeSesInvoiceRevisionAction,
  SesActionError,
  type SesXeroGateway,
} from "./ses_reporting_actions.ts";
import { sesSha256 } from "./ses_docket_envelope.ts";

const JOB_ID = "10000000-0000-4000-8000-000000000001";
const OBLIGATION_ID = "20000000-0000-4000-8000-000000000002";
const DOCKET_ID = "30000000-0000-4000-8000-000000000003";
const ORG_ID = "00000000-0000-0000-0000-000000000001";

function fluentResponse(response: { data: any; error: any }) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    not: () => builder,
    or: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => response,
    single: async () => response,
    then: (resolve: any, reject: any) =>
      Promise.resolve(response).then(resolve, reject),
  };
  return builder;
}

function lookupClient(options: {
  job?: Record<string, unknown> | null;
  jobError?: string;
  hasMakesafeDetail?: boolean;
  detailError?: string;
  invoice?: Record<string, unknown> | null;
  invoiceError?: string;
  indexedInvoices?: Record<string, unknown>[];
}) {
  return {
    from(table: string) {
      if (table === "jobs") {
        return fluentResponse({
          data: options.job ?? null,
          error: options.jobError ? { message: options.jobError } : null,
        });
      }
      if (table === "makesafe_job_details") {
        return fluentResponse({
          data: options.hasMakesafeDetail ? { job_id: JOB_ID } : null,
          error: options.detailError ? { message: options.detailError } : null,
        });
      }
      if (table === "xero_invoices") {
        const single = options.invoice ?? null;
        const rows = options.indexedInvoices ?? [];
        const error = options.invoiceError
          ? { message: options.invoiceError }
          : null;
        const builder: any = fluentResponse({ data: rows, error });
        builder.maybeSingle = async () => ({ data: single, error });
        return builder;
      }
      return fluentResponse({ data: null, error: null });
    },
  };
}

Deno.test("sealed SES classifier is exact to the make-safe spine", () => {
  assertEquals(
    classifySealedSesJob({ id: JOB_ID, type: "makesafe" }).sealed,
    true,
  );
  assertEquals(
    classifySealedSesJob({
      id: JOB_ID,
      type: "general",
      job_number: "SWMS-261028",
    }).sealed,
    true,
  );
  assertEquals(
    classifySealedSesJob({
      id: JOB_ID,
      type: "general",
      job_number: "GEN-100",
      ses_money_sealed_at: "2026-07-27T00:00:00.000Z",
      ses_money_seal_source: "makesafe_intake_case",
    }, true).sealed,
    true,
  );
  for (const type of ["fencing", "patio", "general"]) {
    assertEquals(
      classifySealedSesJob({
        id: JOB_ID,
        type,
        job_number: `${type.toUpperCase()}-100`,
      }).sealed,
      false,
      `${type} must remain outside the sealed SES fence`,
    );
  }
});

Deno.test("sealed SES inspection refuses missing or unreadable job identity", async () => {
  for (
    const fixture of [
      lookupClient({ job: null }),
      lookupClient({ jobError: "jobs unavailable" }),
    ]
  ) {
    await assertRejects(
      () =>
        _assertLegacySesMoneyActionAllowedForJobForTest(
          fixture,
          JOB_ID,
          "send_review_request",
        ),
      SesActionError,
      "sealed SES",
    );
  }

  await assertRejects(
    () =>
      _assertLegacySesMoneyActionAllowedForJobForTest(
        lookupClient({
          job: { id: JOB_ID, type: "general", job_number: "GEN-100" },
          detailError: "details unavailable",
        }),
        JOB_ID,
        "send_review_request",
      ),
    SesActionError,
    "sealed SES",
  );
});

Deno.test("chase delivery binds its GHL contact to the resolved job", async () => {
  for (
    const fixture of [
      {
        client: lookupClient({ job: null }),
        jobId: JOB_ID,
        contactId: "ghl-expected",
        status: 503,
      },
      {
        client: lookupClient({
          job: { id: JOB_ID, ghl_contact_id: "ghl-other" },
        }),
        jobId: JOB_ID,
        contactId: "ghl-decoy",
        status: 409,
      },
      {
        client: lookupClient({
          job: { id: JOB_ID, ghl_contact_id: null },
        }),
        jobId: JOB_ID,
        contactId: "ghl-unlinked",
        status: 409,
      },
      {
        client: lookupClient({}),
        jobId: null,
        contactId: "ghl-unlinked",
        status: 409,
      },
    ]
  ) {
    const error = await assertRejects(
      () =>
        _assertGhlContactMatchesResolvedJobForTest(
          fixture.client,
          fixture.jobId,
          fixture.contactId,
          "send_chase_sms",
        ),
      SesActionError,
    ) as SesActionError;
    assertEquals(error.status, fixture.status);
  }

  await _assertGhlContactMatchesResolvedJobForTest(
    lookupClient({
      job: { id: JOB_ID, ghl_contact_id: "ghl-matched" },
    }),
    JOB_ID,
    "ghl-matched",
    "send_chase_sms",
  );
});

Deno.test("the live $1 create_invoice probe shape now gets a typed refusal before mocked Xero", async () => {
  const client = lookupClient({
    job: {
      id: JOB_ID,
      type: "makesafe",
      job_number: "SWMS-261028",
    },
  });
  const originalFetch = globalThis.fetch;
  let xeroCalls = 0;
  globalThis.fetch = (() => {
    xeroCalls++;
    return Promise.reject(new Error("mocked Xero must not be reached"));
  }) as typeof fetch;
  try {
    const error = await assertRejects(
      () =>
        _createInvoiceForTest(client, {
          job_id: JOB_ID,
          contact_name: "Probe Builder Pty Ltd",
          reference: "",
          line_items: [{
            description: "Adversarial probe",
            quantity: 1,
            unit_price: 1,
          }],
          xero_status: "AUTHORISED",
          send_email: true,
        }),
      SesActionError,
    ) as SesActionError;
    assertEquals(error.status, 409);
    assertEquals((error.refusal as any).code, "sealed_ses_release_required");
    assertStringIncludes(error.refusal.fact, "SES make-safe job is sealed");
    assertStringIncludes(
      (error.refusal as any).recovery_action,
      "execute_ses_invoice_revision",
    );
    assertEquals(xeroCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("duplicate resolver blocks the internal create choke before mocked Xero", async () => {
  const client = lookupClient({
    job: {
      id: JOB_ID,
      type: "makesafe",
      job_number: "SWMS-261028",
    },
    indexedInvoices: [{
      id: "mirror-1",
      job_id: JOB_ID,
      xero_invoice_id: "f25ca9dd-5327-42b3-934b-4104c6842e53",
      invoice_number: "INV-1050",
      invoice_type: "ACCREC",
      status: "DRAFT",
      reference: "",
      invoice_obligation_revision_id: null,
    }],
  });
  const originalFetch = globalThis.fetch;
  let xeroCalls = 0;
  globalThis.fetch = (() => {
    xeroCalls++;
    return Promise.reject(new Error("mocked Xero must not be reached"));
  }) as typeof fetch;
  try {
    const error = await assertRejects(
      () =>
        _createInvoiceForTest(client, {
          job_id: JOB_ID,
          contact_name: "Major Loss Builders",
          reference: "",
          line_items: [{
            description: "Approved make-safe work",
            quantity: 1,
            unit_price: 300,
          }],
        }, {
          ses: {
            obligationRevisionId: OBLIGATION_ID,
            externalToken: "SES-test-token",
            operationKey: "ses:test-operation",
          },
        }),
      SesActionError,
    ) as SesActionError;
    assertEquals((error.refusal as any).code, "invoice_duplicate_live");
    assertStringIncludes(
      error.refusal.fact,
      "second invoice cannot be created",
    );
    assertEquals(xeroCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("F8 job-link and legacy invoice effects refuse sealed or SES-bound invoices", async () => {
  const linked = lookupClient({
    invoice: {
      job_id: JOB_ID,
      invoice_type: "ACCREC",
      invoice_obligation_revision_id: null,
      ses_external_token: null,
    },
    job: { id: JOB_ID, type: "makesafe", job_number: "SWMS-261028" },
  });
  const linkedError = await assertRejects(
    () =>
      _assertLegacySesInvoiceActionAllowedForTest(
        linked,
        "xero-linked",
        "update_invoice_job_link",
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(
    (linkedError.refusal as any).code,
    "sealed_ses_release_required",
  );

  const bound = lookupClient({
    invoice: {
      job_id: null,
      invoice_type: "ACCREC",
      invoice_obligation_revision_id: OBLIGATION_ID,
      ses_external_token: "SES-bound",
    },
  });
  const boundError = await assertRejects(
    () =>
      _assertLegacySesInvoiceActionAllowedForTest(
        bound,
        "xero-bound",
        "update_invoice_job_link",
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(
    (boundError.refusal as any).code,
    "sealed_ses_release_required",
  );

  const targetError = await assertRejects(
    () =>
      _assertLegacySesMoneyActionAllowedForJobForTest(
        lookupClient({
          job: { id: JOB_ID, type: "makesafe", job_number: "SWMS-261028" },
        }),
        JOB_ID,
        "update_invoice_job_link",
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(
    (targetError.refusal as any).code,
    "sealed_ses_release_required",
  );
});

Deno.test("invoice action rejects a caller job that differs from mirror linkage", async () => {
  const error = await assertRejects(
    () =>
      _assertLegacySesInvoiceActionAllowedForTest(
        lookupClient({
          invoice: {
            job_id: JOB_ID,
            invoice_type: "ACCREC",
            invoice_obligation_revision_id: null,
            ses_external_token: null,
          },
        }),
        "xero-linked",
        "send_invoice_email",
        "different-job",
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(error.status, 409);
  assertEquals((error.refusal as any).code, "invoice_link_required");
});

Deno.test("legacy invoice effects fail closed when the invoice mirror is missing", async () => {
  const error = await assertRejects(
    () =>
      _assertLegacySesInvoiceActionAllowedForTest(
        lookupClient({ invoice: null }),
        "unknown-xero-invoice",
        "reconcile_payment",
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(error.status, 503);
  assertEquals(
    (error.refusal as any).code,
    "sealed_ses_fence_check_failed",
  );
  assertStringIncludes(error.refusal.fact, "local Xero mirror is missing");
});

Deno.test("every legacy ACCREC effect requires an authoritative invoice job link", async () => {
  const actions = [
    "approve_invoice",
    "send_invoice_email",
    "approve_and_send_invoice",
    "void_invoice",
    "update_invoice",
    "mark_invoice_paid",
    "reconcile_payment",
    "force_reconcile_invoice",
    "handle_payment_event",
    "get_invoice_pdf",
  ];
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (() => {
    providerCalls++;
    return Promise.reject(new Error("provider must not be reached"));
  }) as typeof fetch;
  try {
    for (const action of actions) {
      const error = await assertRejects(
        () =>
          _assertLegacySesInvoiceActionAllowedForTest(
            lookupClient({
              invoice: {
                job_id: null,
                invoice_type: "ACCREC",
                invoice_obligation_revision_id: null,
                ses_external_token: null,
              },
            }),
            `unlinked-${action}`,
            action,
          ),
        SesActionError,
      ) as SesActionError;
      assertEquals(error.status, 409);
      assertEquals((error.refusal as any).code, "invoice_link_required");
    }
    assertEquals(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("invoice and classifier lookup errors refuse before provider effects", async () => {
  for (
    const client of [
      lookupClient({ invoiceError: "invoice mirror unavailable" }),
      lookupClient({
        invoice: {
          job_id: JOB_ID,
          invoice_type: "ACCREC",
          invoice_obligation_revision_id: null,
          ses_external_token: null,
        },
        jobError: "job authority unavailable",
      }),
    ]
  ) {
    const error = await assertRejects(
      () =>
        _assertLegacySesInvoiceActionAllowedForTest(
          client,
          "xero-lookup-error",
          "approve_invoice",
        ),
      SesActionError,
    ) as SesActionError;
    assertEquals(error.status, 503);
  }
});

Deno.test("every wave-2 outbound action refuses missing or unreadable job authority", async () => {
  const directJobActions = [
    "send_review_request",
    "send_council_email",
    "send_council_sms",
    "send_variation",
    "send_quick_quote_email",
    "send_proposed_sms",
    "edit_and_send",
    "send_quote_followup_sms",
    "send_comms_message",
    "send_ops_note_to_trade",
    "send_work_order",
  ];
  for (const action of directJobActions) {
    for (
      const client of [
        lookupClient({ job: null }),
        lookupClient({ jobError: "job authority unavailable" }),
      ]
    ) {
      const error = await assertRejects(
        () =>
          _assertLegacySesMoneyActionAllowedForJobForTest(
            client,
            JOB_ID,
            action,
          ),
        SesActionError,
      ) as SesActionError;
      assertEquals(error.status, 503);
      assertEquals(
        (error.refusal as any).code,
        "sealed_ses_fence_check_failed",
      );
    }
  }

  for (
    const action of [
      "send_chase_sms",
      "trigger_chase_workflow",
      "stop_chase_workflow",
    ]
  ) {
    const error = await assertRejects(
      () =>
        _assertLegacySesInvoiceOrJobActionAllowedForTest(
          lookupClient({ jobError: "job authority unavailable" }),
          { jobId: JOB_ID },
          action,
        ),
      SesActionError,
    ) as SesActionError;
    assertEquals(error.status, 503);
    assertEquals(
      (error.refusal as any).code,
      "sealed_ses_fence_check_failed",
    );
  }
});

Deno.test("optional chase identity is fail-closed and invoice linkage wins", async () => {
  const missing = await assertRejects(
    () =>
      _assertLegacySesInvoiceOrJobActionAllowedForTest(
        lookupClient({}),
        {},
        "stop_chase_workflow",
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(missing.status, 409);
  assertEquals((missing.refusal as any).code, "invoice_link_required");

  const mismatch = await assertRejects(
    () =>
      _assertLegacySesInvoiceOrJobActionAllowedForTest(
        lookupClient({
          invoice: {
            job_id: JOB_ID,
            invoice_type: "ACCREC",
          },
        }),
        {
          xeroInvoiceId: "xero-linked",
          jobId: "90000000-0000-4000-8000-000000000009",
        },
        "send_chase_sms",
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(mismatch.status, 409);
  assertEquals((mismatch.refusal as any).code, "invoice_link_required");

  const lookupFailure = await assertRejects(
    () =>
      _assertLegacySesInvoiceOrJobActionAllowedForTest(
        lookupClient({ invoiceError: "mirror unavailable" }),
        { xeroInvoiceId: "xero-error" },
        "trigger_chase_workflow",
      ),
    SesActionError,
  ) as SesActionError;
  assertEquals(lookupFailure.status, 503);
  assertEquals(
    (lookupFailure.refusal as any).code,
    "sealed_ses_fence_check_failed",
  );
});

Deno.test("non-SES patio, fencing and general jobs remain unfenced", async () => {
  for (const type of ["patio", "fencing", "general"]) {
    const result = await _assertLegacySesMoneyActionAllowedForJobForTest(
      lookupClient({
        job: { id: JOB_ID, type, job_number: `${type}-100` },
      }),
      JOB_ID,
      "create_invoice",
    );
    assertEquals(result.sealed, false);
  }
});

Deno.test("SES Xero gateway supplies the unforgeable internal create context and suppresses email", async () => {
  const calls: any[] = [];
  const gateway = _makeSesXeroGatewayForTest(
    { name: "stub-client" },
    async (client: any, body: any, internal: any) => {
      calls.push({ client, body, internal });
      return {
        success: true,
        xero_invoice_id: "xero-1",
        invoice_number: "INV-2001",
        status: "DRAFT",
        reference: "MLB-261028 | SES-token",
        total: 330,
      };
    },
  );
  const invoice = await gateway.createDraft({
    schema: "secureworks.makesafe.invoice-proposal/v1",
    invoice_obligation_id: "obligation-1",
    invoice_obligation_revision_id: OBLIGATION_ID,
    job_id: JOB_ID,
    attendance_cycle_ids: ["cycle-1"],
    pricing_disposition: "priced_from_canon",
    pricing_canon_version: "test-canon",
    company: "Major Loss Builders",
    reference: "MLB-261028",
    contact_name: "Major Loss Builders",
    currency: "AUD",
    lines: [{
      description: "Make-safe attendance",
      quantity: 1,
      unit_price: 300,
      account_code: "210",
      evidence: {},
    }],
    totals: { ex: 300, inc: 330 },
    guard_result: { hard_failures: [], warnings: [] },
    duplicate_probe: {
      allows_create: true,
      match_tier: null,
      ambiguity: "none",
    },
    xero: null,
  }, {
    external_token: "SES-token",
    operation_key: "ses:invoice_create:test",
  });
  assertEquals(invoice.status, "DRAFT");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].body.xero_status, "DRAFT");
  assertEquals(calls[0].body.send_email, false);
  assertEquals(calls[0].internal.ses.obligationRevisionId, OBLIGATION_ID);
  assertEquals(calls[0].internal.ses.externalToken, "SES-token");
});

function executionClient(fixture: {
  revision: Record<string, any>;
  approval: Record<string, any>;
  docket: Record<string, any>;
  readiness: Record<string, any>;
}) {
  const effects = new Map<string, Record<string, any>>();
  function responseFor(table: string, mode: string) {
    if (mode === "upsert" && table === "xero_invoices") {
      return { data: { id: "mirror-row" }, error: null };
    }
    if (
      mode === "update" && table === "makesafe_invoice_obligation_revisions"
    ) {
      return { data: { id: OBLIGATION_ID }, error: null };
    }
    const data: Record<string, any> = {
      makesafe_invoice_obligation_revisions: fixture.revision,
      makesafe_revision_approvals_current_v2: fixture.approval,
      makesafe_docket_revisions_current: fixture.docket,
      makesafe_readiness_current_v2: fixture.readiness,
    };
    if (
      [
        "makesafe_docket_artifacts",
        "job_assignments",
        "job_service_reports",
        "xero_invoices",
      ].includes(table)
    ) {
      return { data: [], error: null };
    }
    return { data: data[table] ?? null, error: null };
  }
  return {
    from(table: string) {
      let mode = "select";
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        not: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        update: () => {
          mode = "update";
          return builder;
        },
        upsert: () => {
          mode = "upsert";
          return builder;
        },
        maybeSingle: async () => responseFor(table, mode),
        single: async () => responseFor(table, mode),
        then: (resolve: any, reject: any) =>
          Promise.resolve(responseFor(table, mode)).then(resolve, reject),
      };
      return builder;
    },
    async rpc(name: string, args: Record<string, any>) {
      if (name === "begin_ses_invoice_execution_v1") {
        return { data: { reserved: true }, error: null };
      }
      if (name === "claim_ses_external_effect_v1") {
        const effect = { ...args.p_effect, state: "reserved" };
        effects.set(effect.operation_key, effect);
        return {
          data: {
            effect,
            claim_mode: "dispatch",
            duplicate_refused: false,
          },
          error: null,
        };
      }
      if (name === "transition_ses_external_effect_v1") {
        const current = effects.get(args.p_operation_key)!;
        const next = {
          ...current,
          state: args.p_to_state,
          ...(args.p_detail || {}),
        };
        effects.set(args.p_operation_key, next);
        return { data: next, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
    storage: {
      from: () => ({
        upload: async () => ({ data: null, error: null }),
      }),
    },
  };
}

Deno.test("execute_ses_invoice_revision legitimate approved draft path remains operational", async () => {
  const proposal: any = {
    schema: "secureworks.makesafe.invoice-proposal/v1",
    invoice_obligation_id: "obligation-1",
    invoice_obligation_revision_id: OBLIGATION_ID,
    job_id: JOB_ID,
    attendance_cycle_ids: ["cycle-1"],
    pricing_disposition: "priced_from_canon",
    pricing_canon_version: "test-canon",
    company: "Major Loss Builders",
    reference: "MLB-261028",
    contact_name: "Major Loss Builders",
    currency: "AUD",
    lines: [{
      description: "Make-safe attendance",
      quantity: 1,
      unit_price: 300,
      account_code: "210",
      evidence: {},
    }],
    totals: { ex: 300, inc: 330 },
    guard_result: { hard_failures: [], warnings: [] },
    duplicate_probe: {
      allows_create: true,
      match_tier: null,
      ambiguity: "none",
    },
    xero: null,
  };
  const approvalContentHash = await sesSha256({
    action: "invoice",
    docket_revision_id: DOCKET_ID,
    invoice_obligation_revision_id: OBLIGATION_ID,
    readiness_revision: "ready-1",
    dependency_generation: 1,
    includes_authorise: false,
  }, "SecureWorks:ses-approval-content:v1\n");
  const client = executionClient({
    revision: {
      id: OBLIGATION_ID,
      job_id: JOB_ID,
      state: "create_approved",
      pricing_disposition: "priced_from_canon",
      blockers: [],
      proposal,
    },
    approval: {
      readiness_revision: "ready-1",
      dependency_generation: 1,
      docket_revision_id: DOCKET_ID,
      includes_authorise: false,
      approval_content_hash: approvalContentHash,
    },
    docket: {
      id: DOCKET_ID,
      job_id: JOB_ID,
      stage: "sealed",
      invoice_obligation_revision_id: OBLIGATION_ID,
      attendance_cycle_ids: ["cycle-1"],
      envelope: { v2: { classification: {}, items: {} } },
      email_drafts: {},
    },
    readiness: {
      readiness_revision: "ready-1",
      dependency_generation: 1,
    },
  });
  const created = {
    xero_invoice_id: "xero-approved-path",
    invoice_number: "INV-2002",
    status: "DRAFT",
    reference: "MLB-261028 | SES-token",
    total: 330,
  };
  let dispatched = false;
  const gateway: SesXeroGateway = {
    async createDraft() {
      dispatched = true;
      return created;
    },
    async reconcileCreate() {
      return dispatched ? [created] : [];
    },
    async authorise() {
      throw new Error("draft-only approval must not authorise");
    },
    async reconcileAuthorise() {
      return [];
    },
    async fetchAuthorisedPdf() {
      throw new Error("draft-only approval must not fetch an authorised PDF");
    },
  };
  const result = await executeSesInvoiceRevisionAction(
    client as any,
    {
      mode: "jwt",
      user: { id: "captain-1", email: "captain@example.com", role: "owner" },
    },
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      actor: "captain@example.com",
    },
    gateway,
  );
  assertEquals(result.state, "xero_draft_created");
  assertEquals(result.invoice_create_dispatched, true);
  assertEquals(result.send_dispatched, false);
  assertEquals(result.invoice.xero_invoice_id, "xero-approved-path");
});

Deno.test("sealed refusal text is typed and names the approved release path", () => {
  const refusal = sealedSesMoneyRefusal("create_invoice");
  assertEquals(refusal.code, "sealed_ses_release_required");
  assertStringIncludes(refusal.fact, "sealed");
  assertStringIncludes(refusal.recovery_action, "execute_ses_invoice_revision");
});
