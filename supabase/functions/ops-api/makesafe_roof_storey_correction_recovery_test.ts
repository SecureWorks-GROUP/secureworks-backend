// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  collectStoreyValues,
  MakesafeRoofStoreyCorrectionRecoveryError,
  ROOF_STOREY_CORRECTION_BUILDER_REFERENCE,
  ROOF_STOREY_CORRECTION_EVIDENCE_REFERENCE,
  ROOF_STOREY_CORRECTION_JOB_NUMBER,
  ROOF_STOREY_CORRECTION_REASON_CODE,
  type RoofStoreyCorrectionInput,
  type RoofStoreyCorrectionSnapshot,
  runRoofStoreyCorrectionRecovery,
} from "./makesafe_roof_storey_correction_recovery.ts";
import { SES_PRICING_CANON_VERSION } from "./makesafe_invoice_obligation.ts";

const JOB_ID = "00000000-0000-4000-8000-000000261114";
const CYCLE_ID = "00000000-0000-4000-8000-000000000002";
const DOCKET_ID = "00000000-0000-4000-8000-000000000003";
const OBLIGATION_ID = "00000000-0000-4000-8000-000000000004";
const OBLIGATION_PARENT_ID = "00000000-0000-4000-8000-000000000009";

function protectedCounts(): Record<string, number> {
  return {
    assignments: 0,
    board_status_applications: 0,
    communications: 0,
    docket_revisions: 1,
    external_effects: 0,
    hugo_notifications: 0,
    arrival_notifications: 0,
    arrival_notifications_global: 12,
    invoice_approvals: 0,
    invoice_obligations: 1,
    invoice_obligation_cycles: 1,
    invoice_obligation_revisions: 1,
    job_documents: 1,
    job_events: 0,
    job_media: 0,
    outbound_messages: 0,
    outbound_messages_global: 34,
    portal_captures: 1,
    release_memberships: 0,
    report_packs: 0,
    review_events: 1,
    roof_report_drafts: 0,
    service_reports: 0,
    xero_invoices: 0,
    xero_invoices_global: 56,
    canonical_unlinked_xero_invoices: 0,
    reference_xero_invoice_candidates: 0,
  };
}

function snapshot(): RoofStoreyCorrectionSnapshot {
  return {
    job: {
      id: JOB_ID,
      jobNumber: ROOF_STOREY_CORRECTION_JOB_NUMBER,
      type: "makesafe",
      status: "accepted",
      suburb: "White Gum Valley",
      updatedAt: "2026-08-03T16:00:00Z",
      metadata: {
        makesafe_job_family: "roof_report",
        storeys: "double",
      },
      scopeJson: {},
    },
    detail: {
      jobId: JOB_ID,
      builderReference: ROOF_STOREY_CORRECTION_BUILDER_REFERENCE,
      reportType: "roof_report",
      cycleNumber: 2,
      attendanceCycleId: CYCLE_ID,
      cycleAttribution: "bound",
      scopeJson: {},
    },
    cycles: [{ id: CYCLE_ID, jobId: JOB_ID, cycleNumber: 2 }],
    intakeCases: [{
      id: "00000000-0000-4000-8000-000000000005",
      state: "confirmed_live_job",
      jobId: JOB_ID,
      targetJobId: null,
      builderReference: ROOF_STOREY_CORRECTION_BUILDER_REFERENCE,
      rawIdentityJson: {},
    }],
    portalCaptures: [{
      id: "00000000-0000-4000-8000-000000000006",
      jobId: JOB_ID,
      attendanceCycleId: CYCLE_ID,
      role: "roof_report",
      status: "verified",
      captureResult: "done",
      makesafeFactVersion: 1,
      makesafeContentHash:
        "sha256:257d7a9813822a73d79589b596c00cff0eadc42532ee7ab430913daf41331993",
      sourceContentHash:
        "sha256:38957022c6e4e017bfff44a7d04d195c5a10338d338aa7b13a52d5d400c21d32",
      screenshotContentHash:
        "sha256:38957022c6e4e017bfff44a7d04d195c5a10338d338aa7b13a52d5d400c21d32",
      screenshotMediaType: "image/png",
      screenshotSizeBytes: 1024,
      captureProducer: "capture_portal_evidence.py/v1",
      builderReference: ROOF_STOREY_CORRECTION_BUILDER_REFERENCE,
      evidenceRefCount: 2,
      evidenceRefsFingerprint:
        "sha256:29bf046d1801b9554bfba17103536591abe40b024db533a31dcde5ff22e1bce2",
    }],
    reports: [],
    documents: [{
      type: "work_order",
      attendanceCycleId: CYCLE_ID,
      cycleAttribution: "bound",
      makesafeFactVersion: 1,
      makesafeContentHash: "sha256:document",
      contentPointer: "sealed-document-pointer",
      metadata: {},
      dataSnapshotJson: {},
    }],
    roofDraft: null,
    pricingInputStoreys: "double",
    docketRevisions: [{
      id: DOCKET_ID,
      committedAt: "2026-08-03T17:00:00Z",
      state: "ready",
      stage: "pre_xero",
      preXeroDocsReady: true,
      storeys: "double",
      subtotalExGst: 350,
      totalIncGst: 385,
      localInvoiceProposal: {
        storeys: "double",
        subtotal_ex_gst: 350,
        total_inc_gst: 385,
      },
    }],
    currentDocketId: DOCKET_ID,
    obligationRevisions: [{
      id: OBLIGATION_ID,
      obligationId: OBLIGATION_PARENT_ID,
      docketRevisionIds: [DOCKET_ID],
      attendanceCycleIds: [CYCLE_ID],
      lineAttendanceCycleIds: [[CYCLE_ID]],
      state: "proposed",
      pricingDisposition: "priced_from_canon",
      proposal: {
        schema: "secureworks.makesafe.invoice-proposal/v1",
        pricing_disposition: "priced_from_canon",
        pricing_canon_version: SES_PRICING_CANON_VERSION,
        reference: ROOF_STOREY_CORRECTION_BUILDER_REFERENCE,
        currency: "AUD",
        lines: [{
          quantity: 1,
          unit_price: 350,
          evidence: {
            docket_revision_id: DOCKET_ID,
            attendance_cycle_ids: [CYCLE_ID],
          },
        }],
        totals: { ex: 350, inc: 385 },
      },
      proposalSchema: "secureworks.makesafe.invoice-proposal/v1",
      proposalPricingDisposition: "priced_from_canon",
      pricingCanonVersion: SES_PRICING_CANON_VERSION,
      reference: ROOF_STOREY_CORRECTION_BUILDER_REFERENCE,
      currency: "AUD",
      lineQuantities: [1],
      unitPrices: [350],
      totalEx: 350,
      totalInc: 385,
    }],
    invoiceObligations: [{ id: OBLIGATION_PARENT_ID, status: "open" }],
    obligationCycles: [{
      obligationRevisionId: OBLIGATION_ID,
      obligationId: OBLIGATION_PARENT_ID,
      attendanceCycleId: CYCLE_ID,
      active: true,
      commerciallyClosed: false,
    }],
    currentObligationIds: [OBLIGATION_ID],
    xeroReferenceCandidatesFingerprint: "sha256:no-reference-candidates",
    protectedCounts: protectedCounts(),
  };
}

function input(
  overrides: Partial<RoofStoreyCorrectionInput> = {},
): RoofStoreyCorrectionInput {
  return {
    job_number: ROOF_STOREY_CORRECTION_JOB_NUMBER,
    builder_reference: ROOF_STOREY_CORRECTION_BUILDER_REFERENCE,
    expected_storeys: "double",
    corrected_storeys: "single",
    evidence_reference: ROOF_STOREY_CORRECTION_EVIDENCE_REFERENCE,
    reason_code: ROOF_STOREY_CORRECTION_REASON_CODE,
    dry_run: true,
    plan_token: null,
    ...overrides,
  };
}

function harness(initial = snapshot()) {
  const state = structuredClone(initial);
  const writes: string[] = [];
  return {
    writes,
    current: () => structuredClone(state),
    deps: {
      loadSnapshot: async () => structuredClone(state),
      compareAndSetStoreys: async ({
        jobId,
        expectedJobNumber,
        expectedUpdatedAt,
        expectedMetadata,
        replacementMetadata,
      }: {
        jobId: string;
        expectedJobNumber: string;
        expectedUpdatedAt: string;
        expectedMetadata: Record<string, unknown>;
        replacementMetadata: Record<string, unknown>;
      }) => {
        if (
          state.job?.id !== jobId ||
          state.job.jobNumber !== expectedJobNumber ||
          state.job.updatedAt !== expectedUpdatedAt ||
          JSON.stringify(state.job.metadata) !==
            JSON.stringify(expectedMetadata) ||
          state.job.metadata.storeys !== "double"
        ) return false;
        writes.push("jobs.metadata.storeys:double->single");
        state.job.metadata = structuredClone(replacementMetadata);
        state.job.updatedAt = "2026-08-04T01:00:00Z";
        state.pricingInputStoreys = "single";
        return true;
      },
    },
  };
}

async function preview(test: ReturnType<typeof harness>) {
  return await runRoofStoreyCorrectionRecovery(input(), test.deps);
}

Deno.test("single-card correction previews the exact locked authority and stale selector follow-up", async () => {
  const test = harness();
  const result = await preview(test) as any;
  assertEquals(result.ok, true);
  assertEquals(result.dry_run, true);
  assertEquals(result.writes_applied, 0);
  assertEquals(/^sha256:[0-9a-f]{64}$/.test(result.plan_token), true);
  assertEquals(result.plan.disposition, "correct_to_single");
  assertEquals(result.plan.reason_code, ROOF_STOREY_CORRECTION_REASON_CODE);
  assertEquals(result.plan.exact_facts.source_storeys, "double");
  assertEquals(result.plan.exact_facts.pricing_input_storeys, "double");
  assertEquals(result.plan.exact_facts.current_docket_price, {
    storeys: "double",
    subtotal_ex_gst: 350,
    total_inc_gst: 385,
  });
  assertEquals(result.plan.selector_follow_up, {
    required: true,
    reason_codes: [
      "persist_single_storey_docket_revision",
      "supersede_double_invoice_obligation_revision",
    ],
  });
  assertEquals(test.writes, []);
});

Deno.test("apply uses the immediately preceding token, changes one source fact, and reads back single", async () => {
  const test = harness();
  const planned = await preview(test) as any;
  const applied = await runRoofStoreyCorrectionRecovery(
    input({
      dry_run: false,
      plan_token: planned.plan_token,
    }),
    test.deps,
  ) as any;

  assertEquals(applied.ok, true);
  assertEquals(applied.writes_applied, 1);
  assertEquals(applied.plan.disposition, "already_corrected");
  assertEquals(applied.plan.exact_facts.source_storeys, "single");
  assertEquals(applied.plan.exact_facts.pricing_input_storeys, "single");
  assertEquals(applied.plan.selector_follow_up.required, true);
  assertEquals(test.writes, ["jobs.metadata.storeys:double->single"]);
  assertEquals(test.current().protectedCounts, protectedCounts());
  assertEquals(applied.external_mutations, {
    assignments: 0,
    board_or_job_state: 0,
    cycle_membership: 0,
    evidence_content: 0,
    invoices: 0,
    notifications: 0,
    outbound_queues: 0,
  });
});

Deno.test("a fresh repeat is idempotent and never writes a second time", async () => {
  const test = harness();
  const firstPlan = await preview(test) as any;
  await runRoofStoreyCorrectionRecovery(
    input({
      dry_run: false,
      plan_token: firstPlan.plan_token,
    }),
    test.deps,
  );
  const repeatPlan = await preview(test) as any;
  const repeat = await runRoofStoreyCorrectionRecovery(
    input({
      dry_run: false,
      plan_token: repeatPlan.plan_token,
    }),
    test.deps,
  ) as any;
  assertEquals(repeat.plan.disposition, "already_corrected");
  assertEquals(repeat.writes_applied, 0);
  assertEquals(test.writes.length, 1);
});

Deno.test("completed docket and obligation supersession remains an idempotent single-selector readback", async () => {
  const value = snapshot();
  value.job!.metadata.storeys = "single";
  value.pricingInputStoreys = "single";
  value.obligationRevisions[0].state = "superseded";
  const singleDocketId = "00000000-0000-4000-8000-000000000007";
  const singleObligationId = "00000000-0000-4000-8000-000000000008";
  value.docketRevisions.push({
    id: singleDocketId,
    committedAt: "2026-08-04T01:01:00Z",
    state: "ready",
    stage: "pre_xero",
    preXeroDocsReady: true,
    storeys: "single",
    subtotalExGst: 250,
    totalIncGst: 275,
    localInvoiceProposal: {
      storeys: "single",
      subtotal_ex_gst: 250,
      total_inc_gst: 275,
    },
  });
  value.currentDocketId = singleDocketId;
  value.obligationRevisions.push({
    id: singleObligationId,
    obligationId: OBLIGATION_PARENT_ID,
    docketRevisionIds: [singleDocketId],
    attendanceCycleIds: [CYCLE_ID],
    lineAttendanceCycleIds: [[CYCLE_ID]],
    state: "proposed",
    pricingDisposition: "priced_from_canon",
    proposal: {
      schema: "secureworks.makesafe.invoice-proposal/v1",
      pricing_disposition: "priced_from_canon",
      pricing_canon_version: SES_PRICING_CANON_VERSION,
      reference: ROOF_STOREY_CORRECTION_BUILDER_REFERENCE,
      currency: "AUD",
      lines: [{
        quantity: 1,
        unit_price: 250,
        evidence: {
          docket_revision_id: singleDocketId,
          attendance_cycle_ids: [CYCLE_ID],
        },
      }],
      totals: { ex: 250, inc: 275 },
    },
    proposalSchema: "secureworks.makesafe.invoice-proposal/v1",
    proposalPricingDisposition: "priced_from_canon",
    pricingCanonVersion: SES_PRICING_CANON_VERSION,
    reference: ROOF_STOREY_CORRECTION_BUILDER_REFERENCE,
    currency: "AUD",
    lineQuantities: [1],
    unitPrices: [250],
    totalEx: 250,
    totalInc: 275,
  });
  value.obligationCycles[0].active = false;
  value.obligationCycles.push({
    obligationRevisionId: singleObligationId,
    obligationId: OBLIGATION_PARENT_ID,
    attendanceCycleId: CYCLE_ID,
    active: true,
    commerciallyClosed: false,
  });
  value.currentObligationIds = [singleObligationId];
  value.protectedCounts.docket_revisions = 2;
  value.protectedCounts.invoice_obligation_revisions = 2;
  value.protectedCounts.invoice_obligation_cycles = 2;
  value.protectedCounts.review_events = 2;

  const test = harness(value);
  const planned = await preview(test) as any;
  assertEquals(planned.ok, true);
  assertEquals(planned.plan.disposition, "already_corrected");
  assertEquals(planned.plan.selector_follow_up, {
    required: false,
    reason_codes: [],
  });
  const repeated = await runRoofStoreyCorrectionRecovery(
    input({
      dry_run: false,
      plan_token: planned.plan_token,
    }),
    test.deps,
  ) as any;
  assertEquals(repeated.writes_applied, 0);
  assertEquals(test.writes, []);
});

Deno.test("strict request cannot widen the job, evidence, reason, value, or body shape", async () => {
  const invalid: RoofStoreyCorrectionInput[] = [
    input({ job_number: "SWMS-999999" }),
    input({ builder_reference: "RR-99999" }),
    input({ evidence_reference: "wrong-ref" }),
    input({ reason_code: "generic_patch" }),
    { ...input(), extra: true } as unknown as RoofStoreyCorrectionInput,
  ];
  for (const request of invalid) {
    const test = harness();
    await assertRejects(
      () => runRoofStoreyCorrectionRecovery(request, test.deps),
      MakesafeRoofStoreyCorrectionRecoveryError,
    );
    assertEquals(test.writes, []);
  }
});

Deno.test("locked evidence, immutable cycle, typed source, and protected money guards fail closed", async () => {
  const cases: Array<[
    string,
    (value: RoofStoreyCorrectionSnapshot) => void,
  ]> = [
    ["locked_portal_evidence_drifted", (value) => {
      value.portalCaptures[0].status = "captured";
    }],
    ["locked_portal_evidence_drifted", (value) => {
      value.portalCaptures[0].evidenceRefsFingerprint = "sha256:changed";
    }],
    ["immutable_cycle_membership_drifted", (value) => {
      value.cycles.push({
        id: "00000000-0000-4000-8000-000000000099",
        jobId: JOB_ID,
        cycleNumber: 3,
      });
    }],
    ["typed_storey_sources_inconsistent", (value) => {
      value.job!.scopeJson = { storeys: "single" };
    }],
    ["typed_storey_sources_inconsistent", (value) => {
      value.job!.metadata.nested = { storey: "double" };
    }],
    ["protected_state_drifted", (value) => {
      value.protectedCounts.invoice_approvals = 1;
    }],
    ["invoice_selector_preimage_drifted", (value) => {
      value.docketRevisions[0].preXeroDocsReady = false;
    }],
    ["invoice_obligation_binding_drifted", (value) => {
      value.obligationCycles[0].active = false;
    }],
    ["double_selector_preimage_drifted", (value) => {
      value.obligationRevisions[0].lineQuantities = [2];
    }],
  ];
  for (const [reasonCode, mutate] of cases) {
    const value = snapshot();
    mutate(value);
    const test = harness(value);
    const result = await preview(test) as any;
    assertEquals(result.ok, false, reasonCode);
    assertEquals(result.plan.reason_code, reasonCode);
    assertEquals(test.writes, []);
  }
});

Deno.test("plan token refuses any drift before the compare-and-set", async () => {
  const test = harness();
  const planned = await preview(test) as any;
  const current = test.current();
  current.portalCaptures[0].screenshotSizeBytes = 2048;
  let loadCount = 0;
  await assertRejects(
    () =>
      runRoofStoreyCorrectionRecovery(
        input({
          dry_run: false,
          plan_token: planned.plan_token,
        }),
        {
          ...test.deps,
          loadSnapshot: async () => {
            loadCount++;
            return loadCount === 1 ? current : test.current();
          },
        },
      ),
    MakesafeRoofStoreyCorrectionRecoveryError,
    "plan token is stale",
  );
  assertEquals(test.writes, []);
});

Deno.test("storey scanner follows the assembler aliases and ignores prose values", () => {
  assertEquals(
    collectStoreyValues({
      numberOfStoreys: "Single",
      nested: { storey_count: "single" },
      note: "double storey words are not a typed fact",
    }),
    ["single"],
  );
});

Deno.test("HTTP result retains only the approved safe facts and never internal identities or hashes", async () => {
  const result = await preview(harness());
  const serialized = JSON.stringify(result);
  for (
    const forbidden of [
      JOB_ID,
      CYCLE_ID,
      DOCKET_ID,
      OBLIGATION_ID,
      "sha256:257d7a9813822a73d79589b596c00cff0eadc42532ee7ab430913daf41331993",
      "sha256:38957022c6e4e017bfff44a7d04d195c5a10338d338aa7b13a52d5d400c21d32",
      "sealed-document-pointer",
    ]
  ) {
    assertEquals(serialized.includes(forbidden), false, forbidden);
  }
  assertStringIncludes(serialized, ROOF_STOREY_CORRECTION_JOB_NUMBER);
  assertStringIncludes(serialized, ROOF_STOREY_CORRECTION_EVIDENCE_REFERENCE);
});

Deno.test("route is privileged POST-only and the adapter owns one exact jobs CAS", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const routeAt = source.indexOf(
    "case 'makesafe_roof_storey_correction_recovery'",
  );
  const route = source.slice(routeAt, routeAt + 900);
  assertStringIncludes(route, "authMode !== 'api_key'");
  assertStringIncludes(route, "req.method !== 'POST'");
  assertStringIncludes(
    route,
    "roofStoreyCorrectionRecoveryAction(client, body)",
  );

  const casAt = source.indexOf("async function compareAndSetRoofStoreys");
  const cas = source.slice(
    casAt,
    source.indexOf("async function roofStoreyCorrectionRecoveryAction", casAt),
  );
  assertStringIncludes(cas, "client.from('jobs').update");
  assertStringIncludes(cas, ".eq('id', input.jobId)");
  assertStringIncludes(cas, ".eq('job_number', input.expectedJobNumber)");
  assertStringIncludes(cas, ".eq('updated_at', input.expectedUpdatedAt)");
  assertStringIncludes(
    cas,
    ".filter('metadata', 'eq', JSON.stringify(input.expectedMetadata))",
  );
  const loaderAt = source.indexOf(
    "async function loadRoofStoreyCorrectionSnapshot",
  );
  const loader = source.slice(loaderAt, casAt);
  assertStringIncludes(
    loader,
    ".select('id,obligation_id,attendance_cycle_ids,state,pricing_disposition,proposal')",
  );
  assertEquals(
    loader.includes(
      ".select('id,docket_revision_id,state,pricing_disposition,proposal')",
    ),
    false,
  );
  assertStringIncludes(loader, ".eq('metadata->>job_id', jobId)");
  assertStringIncludes(loader, "exactCount('makesafe_notify_log'");
  assertEquals(cas.includes(".insert("), false);
  assertEquals(cas.includes(".delete("), false);
});
