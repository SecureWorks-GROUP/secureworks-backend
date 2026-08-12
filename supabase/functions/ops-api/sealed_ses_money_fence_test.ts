// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifySealedSesJob,
  SEALED_SES_MONEY_READ_EXEMPT_ACTIONS,
  type SealedSesMoneyReadCaller,
  sealedSesMoneyReadExemptionApplies,
  sealedSesMoneyReadExemptionWriteVerbViolations,
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
    insert: () => builder,
    update: () => builder,
    upsert: () => builder,
    eq: () => builder,
    in: () => builder,
    is: () => builder,
    not: () => builder,
    or: () => builder,
    order: () => builder,
    limit: () => builder,
    range: () => builder,
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
  xeroToken?: Record<string, unknown>;
}) {
  return {
    from(table: string) {
      if (table === "jobs") {
        // The seal classifier reads one row via maybeSingle; the synthetic
        // live-fire guard reads a LIST via `.in('id', …)` and calls `.filter`
        // on it. Serve each the shape it expects, or a fixture that supplies a
        // job makes the guard throw a TypeError instead of exercising the gate.
        const single = options.job ?? null;
        const error = options.jobError ? { message: options.jobError } : null;
        const builder: any = fluentResponse({
          data: single ? [single] : [],
          error,
        });
        builder.maybeSingle = async () => ({ data: single, error });
        builder.single = async () => ({ data: single, error });
        return builder;
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
      if (table === "xero_tokens") {
        const token = options.xeroToken ?? null;
        return fluentResponse({ data: token, error: null });
      }
      return fluentResponse({ data: null, error: null });
    },
  };
}

Deno.test("SES money-seal classification is inert for every legacy signal", () => {
  const jobs = [
    { id: JOB_ID, type: "makesafe", job_number: "SWMS-261028" },
    { id: JOB_ID, type: "general", job_number: "SWMS-261028" },
    {
      id: JOB_ID,
      type: "general",
      job_number: "GEN-100",
      ses_money_sealed_at: "2026-07-27T00:00:00.000Z",
      ses_money_seal_source: "makesafe_intake_case",
    },
    { id: JOB_ID, type: "fencing", job_number: "SWF-100" },
  ];
  for (const job of jobs) {
    const result = classifySealedSesJob(job, true);
    assertEquals(result.sealed, false);
    assertEquals(result.matched_by, null);
  }
  assertEquals(classifySealedSesJob(null), {
    sealed: false,
    matched_by: null,
    job: null,
  });
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

  const inert = await _assertLegacySesMoneyActionAllowedForJobForTest(
    lookupClient({
      job: { id: JOB_ID, type: "makesafe", job_number: "SWMS-261028" },
      detailError: "details unavailable",
    }),
    JOB_ID,
    "send_review_request",
  );
  assertEquals(inert.sealed, false);
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

Deno.test("ordinary create_invoice mints a DRAFT on an SWMS make-safe job", async () => {
  const client = lookupClient({
    job: {
      id: JOB_ID,
      type: "makesafe",
      job_number: "SWMS-261028",
      client_name: "Probe Builder Pty Ltd",
      client_email: null,
      client_phone: null,
      site_address: "Test site",
      site_suburb: "Perth",
      xero_contact_id: "xero-contact-1",
      pricing_json: {},
      payment_terms: null,
      metadata: {},
    },
    xeroToken: {
      access_token: "xero-access-token",
      tenant_id: "xero-tenant",
      expires_at: "2099-01-01T00:00:00.000Z",
    },
  });
  const originalFetch = globalThis.fetch;
  let invoiceCreates = 0;
  let emailCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const request = init as any;
    if (url.includes("/TrackingCategories")) {
      return Response.json({ TrackingCategories: [] });
    }
    if (url.endsWith("/Invoices") && request?.method === "PUT") {
      invoiceCreates++;
      const payload = JSON.parse(String(request.body || "{}"));
      assertEquals(payload.Invoices?.[0]?.Status, "DRAFT");
      return Response.json({
        Invoices: [{
          InvoiceID: "xero-draft-swms",
          InvoiceNumber: "INV-TEST",
          Status: "DRAFT",
          Reference: "SWMS-261028",
          SubTotal: 300,
          TotalTax: 30,
          Total: 330,
          Contact: { ContactID: "xero-contact-1" },
        }],
      });
    }
    if (url.includes("/Email")) emailCalls++;
    throw new Error(`unexpected provider call: ${url}`);
  }) as typeof fetch;
  try {
    const result = await _createInvoiceForTest(client, {
      job_id: JOB_ID,
      xero_contact_id: "xero-contact-1",
      contact_name: "Probe Builder Pty Ltd",
      reference: "SWMS-261028",
      line_items: [{
        description: "Approved make-safe work",
        quantity: 1,
        unit_price: 300,
      }],
      xero_status: "DRAFT",
      send_email: false,
    });
    assertEquals(result.success, true);
    assertEquals(result.status, "DRAFT");
    assertEquals(result.xero_invoice_id, "xero-draft-swms");
    assertEquals(invoiceCreates, 1);
    assertEquals(emailCalls, 0);
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

Deno.test("legacy auto-seal is inert while SES-bound invoice effects still refuse", async () => {
  const linked = lookupClient({
    invoice: {
      job_id: JOB_ID,
      invoice_type: "ACCREC",
      invoice_obligation_revision_id: null,
      ses_external_token: null,
    },
    job: { id: JOB_ID, type: "makesafe", job_number: "SWMS-261028" },
  });
  const linkedResult = await _assertLegacySesInvoiceActionAllowedForTest(
    linked,
    "xero-linked",
    "update_invoice_job_link",
  );
  assertEquals(linkedResult.job_id, JOB_ID);

  // The invoice carries a job link so the assertion below lands on the SES-bound
  // refusal it is about. Without one, the earlier authoritative-job-link guard
  // (`synthetic_livefire_invoice_unresolved`) refuses first and this sub-case
  // stops exercising the sealed obligation/token branch at all.
  const bound = lookupClient({
    invoice: {
      job_id: JOB_ID,
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

  const targetResult = await _assertLegacySesMoneyActionAllowedForJobForTest(
    lookupClient({
      job: { id: JOB_ID, type: "makesafe", job_number: "SWMS-261028" },
    }),
    JOB_ID,
    "update_invoice_job_link",
  );
  assertEquals(targetResult.sealed, false);
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

// An unlinked ACCREC invoice is refused by the authoritative-job-link guard,
// which runs before the sealed classification and raises the 409
// `synthetic_livefire_invoice_unresolved` ApiError rather than the later
// `invoice_link_required` SesActionError. The property under test is unchanged
// — no legacy effect proceeds without an authoritative job link, and the
// provider is never reached — so this asserts the refusal the code actually
// raises today.
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
        Error,
      ) as Error & { status?: number };
      assertEquals(error.status, 409);
      assertStringIncludes(
        error.message,
        "synthetic_livefire_invoice_unresolved",
      );
      assertStringIncludes(error.message, action);
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
    // Either refusal class is acceptable here — the mirror error raises a
    // SesActionError, the unreadable job authority raises the synthetic
    // live-fire guard's ApiError — but both must fail closed with a 503 before
    // any provider effect.
    const error = await assertRejects(
      () =>
        _assertLegacySesInvoiceActionAllowedForTest(
          client,
          "xero-lookup-error",
          "approve_invoice",
        ),
      Error,
    ) as Error & { status?: number };
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

Deno.test("contact-only chase remains allowed while supplied identity wins", async () => {
  const contactOnly = await _assertLegacySesInvoiceOrJobActionAllowedForTest(
    lookupClient({}),
    {},
    "stop_chase_workflow",
  );
  assertEquals(contactOnly, { xero_invoice_id: null, job_id: null });

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

Deno.test("explicit SES binding refusal names the approved release path", () => {
  const refusal = sealedSesMoneyRefusal("create_invoice");
  assertEquals(refusal.code, "sealed_ses_release_required");
  assertStringIncludes(refusal.fact, "explicitly bound");
  assertStringIncludes(refusal.recovery_action, "execute_ses_invoice_revision");
});

// ─────────────────────────────────────────────────────────────────────────────
// Captain's ruling, 2026-08-02: reading an invoice PDF is exempt from the seal
//
// Register rows 12 and 75. Before this ruling the seal refused `get_invoice_pdf`
// on every make-safe card, so View PDF was dead on all 22 invoices swept across
// 62 cards, and 53 active cards sat on the same refused route — including
// invoices SecureWorks Group had already sent to a builder.
//
// These tests prove BOTH halves. The read now works; nothing else moved.
// ─────────────────────────────────────────────────────────────────────────────

const OPS_KEY_CALLER: SealedSesMoneyReadCaller = { mode: "api_key" };
const ADMIN_CALLER: SealedSesMoneyReadCaller = { mode: "jwt", role: "admin" };
const OWNER_CALLER: SealedSesMoneyReadCaller = { mode: "jwt", role: "owner" };

// Every sealed money verb the seal exists to refuse. The read exemption must
// leave all of them refusing, even when handed the MOST privileged caller
// context that exists — this list is what fails if the exemption is ever
// widened from a read into a write.
const SEALED_WRITE_ACTIONS = [
  "create_invoice",
  "create_deposit_invoice",
  "update_invoice",
  "update_invoice_job_link",
  "approve_invoice",
  "approve_and_send_invoice",
  "void_invoice",
  "send_invoice_email",
  "send_payment_link",
  "mark_invoice_paid",
  "reconcile_payment",
  "force_reconcile_invoice",
  "handle_payment_event",
  "send_quote",
  "send_work_order",
  "makesafe_send_pack",
];

function sealedJob() {
  return { id: JOB_ID, type: "makesafe", job_number: "SWMS-261028" };
}

// A make-safe invoice mirror row. `status` is carried so the fixtures can name
// the DRAFT / AUTHORISED / PAID cases the ruling calls out; the gate itself
// never selects it, which is exactly the point — invoice status is not, and
// must not become, a discriminator on the read path.
function sealedInvoice(
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    job_id: JOB_ID,
    invoice_type: "ACCREC",
    invoice_obligation_revision_id: null,
    ses_external_token: null,
    status,
    ...overrides,
  };
}

Deno.test("the read exemption is exactly one action and carries no write verb", () => {
  assertEquals([...SEALED_SES_MONEY_READ_EXEMPT_ACTIONS], ["get_invoice_pdf"]);
  assertEquals(sealedSesMoneyReadExemptionWriteVerbViolations(), []);
});

Deno.test("the read exemption needs both an allow-listed action and an operator caller", () => {
  for (const caller of [OPS_KEY_CALLER, ADMIN_CALLER, OWNER_CALLER]) {
    assertEquals(
      sealedSesMoneyReadExemptionApplies("get_invoice_pdf", caller),
      true,
    );
  }

  // Lock 1: the caller must be an identified operator. A trade or unknown
  // session, the make-safe automation routine, and an absent caller context all
  // keep the sealed refusal they have today.
  for (
    const caller of [
      { mode: "jwt", role: "trade" } as SealedSesMoneyReadCaller,
      { mode: "jwt", role: "manager" } as SealedSesMoneyReadCaller,
      { mode: "jwt", role: "unknown" } as SealedSesMoneyReadCaller,
      { mode: "jwt", role: null } as SealedSesMoneyReadCaller,
      { mode: "routine" } as SealedSesMoneyReadCaller,
      null,
      undefined,
    ]
  ) {
    assertEquals(
      sealedSesMoneyReadExemptionApplies("get_invoice_pdf", caller),
      false,
    );
  }

  // Lock 2: the action must be on the closed allow-list. A privileged operator
  // does NOT unlock a write, and neither does a near-miss action name.
  for (
    const action of [
      ...SEALED_WRITE_ACTIONS,
      "get_invoice_pdf_and_send",
      "get_invoice",
      "",
    ]
  ) {
    for (const caller of [OPS_KEY_CALLER, ADMIN_CALLER, OWNER_CALLER]) {
      assertEquals(
        sealedSesMoneyReadExemptionApplies(action, caller),
        false,
        `${action} must never be read-exempt`,
      );
    }
  }
});

Deno.test("an operator may READ a sealed make-safe invoice PDF at draft, authorised and paid", async () => {
  for (const status of ["DRAFT", "AUTHORISED", "PAID"]) {
    for (const caller of [OPS_KEY_CALLER, ADMIN_CALLER, OWNER_CALLER]) {
      const allowed = await _assertLegacySesInvoiceActionAllowedForTest(
        lookupClient({
          invoice: sealedInvoice(status),
          job: sealedJob(),
        }),
        `xero-${status.toLowerCase()}`,
        "get_invoice_pdf",
        undefined,
        caller,
      );
      assertEquals(allowed.job_id, JOB_ID);
    }
  }
});

Deno.test("get_invoice_pdf works for every legacy seal shape and SES-bound invoices", async () => {
  const sealShapes = [
    { id: JOB_ID, type: "makesafe", job_number: "SWMS-261028" },
    { id: JOB_ID, type: "general", job_number: "SWMS-261124" },
    {
      id: JOB_ID,
      type: "general",
      job_number: "GEN-100",
      ses_money_sealed_at: "2026-07-27T00:00:00.000Z",
      ses_money_seal_source: "job_spine_backfill",
    },
  ];
  for (const job of sealShapes) {
    const allowed = await _assertLegacySesInvoiceActionAllowedForTest(
      lookupClient({ invoice: sealedInvoice("AUTHORISED"), job }),
      "xero-seal-shape",
      "get_invoice_pdf",
      undefined,
      OPS_KEY_CALLER,
    );
    assertEquals(allowed.job_id, JOB_ID);
  }

  // An invoice bound to a sealed SES obligation / external delivery token is
  // the same story: its bytes may be read, and only read.
  const bound = await _assertLegacySesInvoiceActionAllowedForTest(
    lookupClient({
      invoice: sealedInvoice("AUTHORISED", {
        invoice_obligation_revision_id: OBLIGATION_ID,
        ses_external_token: "SES-bound",
      }),
      job: sealedJob(),
    }),
    "xero-ses-bound",
    "get_invoice_pdf",
    undefined,
    ADMIN_CALLER,
  );
  assertEquals(bound.job_id, JOB_ID);

  // The job-level gate is inert too, so the card's own read is not refused one
  // layer down.
  const jobLevel = await _assertLegacySesMoneyActionAllowedForJobForTest(
    lookupClient({ job: sealedJob() }),
    JOB_ID,
    "get_invoice_pdf",
    false,
    OPS_KEY_CALLER,
  );
  assertEquals(jobLevel.sealed, false);
});

Deno.test("the legacy seal no longer restricts invoice PDF reads by caller", async () => {
  for (
    const caller of [
      { mode: "jwt", role: "trade" } as SealedSesMoneyReadCaller,
      { mode: "routine" } as SealedSesMoneyReadCaller,
      null,
    ]
  ) {
    const allowed = await _assertLegacySesInvoiceActionAllowedForTest(
      lookupClient({
        invoice: sealedInvoice("AUTHORISED"),
        job: sealedJob(),
      }),
      "xero-unprivileged",
      "get_invoice_pdf",
      undefined,
      caller,
    );
    assertEquals(allowed.job_id, JOB_ID);
  }
});

// The Captain removed the card classifier, not the explicit SES invoice binding.
// Ordinary SWMS jobs now pass this legacy gate while obligation/token-bound
// invoices retain their release-only refusal for every write action.
Deno.test("ordinary SWMS effects pass while SES-bound writes retain release gates", async () => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (() => {
    providerCalls++;
    return Promise.reject(new Error("provider must not be reached"));
  }) as typeof fetch;
  try {
    for (const action of SEALED_WRITE_ACTIONS) {
      for (const caller of [OPS_KEY_CALLER, ADMIN_CALLER, OWNER_CALLER]) {
        const invoice = await _assertLegacySesInvoiceActionAllowedForTest(
          lookupClient({
            invoice: sealedInvoice("AUTHORISED"),
            job: sealedJob(),
          }),
          `xero-${action}`,
          action,
          undefined,
          caller,
        );
        assertEquals(invoice.job_id, JOB_ID);

        const job = await _assertLegacySesMoneyActionAllowedForJobForTest(
          lookupClient({ job: sealedJob() }),
          JOB_ID,
          action,
          false,
          caller,
        );
        assertEquals(job.sealed, false);
      }
    }

    // An SES-bound invoice keeps its own refusal for every write too.
    for (const action of SEALED_WRITE_ACTIONS) {
      const error = await assertRejects(
        () =>
          _assertLegacySesInvoiceActionAllowedForTest(
            lookupClient({
              invoice: sealedInvoice("AUTHORISED", {
                invoice_obligation_revision_id: OBLIGATION_ID,
                ses_external_token: "SES-bound",
              }),
              job: sealedJob(),
            }),
            `xero-bound-${action}`,
            action,
            undefined,
            OPS_KEY_CALLER,
          ),
        SesActionError,
      ) as SesActionError;
      assertEquals(
        (error.refusal as any).code,
        "sealed_ses_release_required",
      );
    }
    assertEquals(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// The exemption lifts ONE refusal. Every identity and entitlement refusal on
// the read path is unchanged, and each still fires before any provider call.
Deno.test("the invoice PDF read still fails closed on identity it cannot prove", async () => {
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = (() => {
    providerCalls++;
    return Promise.reject(new Error("provider must not be reached"));
  }) as typeof fetch;
  try {
    // Missing from the local Xero mirror -> cannot be classified at all.
    const missing = await assertRejects(
      () =>
        _assertLegacySesInvoiceActionAllowedForTest(
          lookupClient({ invoice: null }),
          "xero-missing",
          "get_invoice_pdf",
          undefined,
          OPS_KEY_CALLER,
        ),
      SesActionError,
    ) as SesActionError;
    assertEquals(missing.status, 503);
    assertEquals(
      (missing.refusal as any).code,
      "sealed_ses_fence_check_failed",
    );

    // No authoritative job link -> the caller's entitlement to these bytes
    // cannot be established.
    const unlinked = await assertRejects(
      () =>
        _assertLegacySesInvoiceActionAllowedForTest(
          lookupClient({ invoice: sealedInvoice("PAID", { job_id: null }) }),
          "xero-unlinked-read",
          "get_invoice_pdf",
          undefined,
          OPS_KEY_CALLER,
        ),
      Error,
    ) as Error & { status?: number };
    assertEquals(unlinked.status, 409);
    assertStringIncludes(
      unlinked.message,
      "synthetic_livefire_invoice_unresolved",
    );

    // Unreadable job classification -> the seal check itself is unavailable, so
    // the read refuses rather than assuming the card is safe to open.
    const unreadable = await assertRejects(
      () =>
        _assertLegacySesMoneyActionAllowedForJobForTest(
          lookupClient({ jobError: "job authority unavailable" }),
          JOB_ID,
          "get_invoice_pdf",
          false,
          OPS_KEY_CALLER,
        ),
      SesActionError,
    ) as SesActionError;
    assertEquals(unreadable.status, 503);
    assertEquals(
      (unreadable.refusal as any).code,
      "sealed_ses_fence_check_failed",
    );

    // A synthetic live-fire job is never readable through the front door.
    const synthetic = await assertRejects(
      () =>
        _assertLegacySesInvoiceActionAllowedForTest(
          lookupClient({
            invoice: sealedInvoice("AUTHORISED"),
            job: {
              ...sealedJob(),
              metadata: {
                synthetic_livefire_marker:
                  "SWG-SES-LIVEFIRE-TEST-ONLY-1A2B3C4D-5E6F-4A8B-9C0D-1E2F3A4B5C6D",
              },
            },
          }),
          "xero-synthetic",
          "get_invoice_pdf",
          undefined,
          OPS_KEY_CALLER,
        ),
      Error,
    ) as Error & { status?: number };
    assertEquals(synthetic.status, 409);
    assertStringIncludes(
      synthetic.message,
      "synthetic_livefire_release_forbidden",
    );

    assertEquals(providerCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("non-SES invoices read exactly as they did before the ruling", async () => {
  // An unsealed job never needed the exemption and must not start depending on
  // it: the read succeeds with no caller context at all.
  const allowed = await _assertLegacySesInvoiceActionAllowedForTest(
    lookupClient({
      invoice: sealedInvoice("AUTHORISED"),
      job: { id: JOB_ID, type: "fencing", job_number: "FEN-100" },
    }),
    "xero-unsealed",
    "get_invoice_pdf",
  );
  assertEquals(allowed.job_id, JOB_ID);
});
