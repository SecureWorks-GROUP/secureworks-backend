// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type MakesafeJobIdentityRecoveryDependencies,
  MakesafeJobIdentityRecoveryError,
  type MakesafeJobIdentityRecoverySnapshot,
  runMakesafeJobIdentityRecoverExact,
} from "./makesafe_job_identity_recover_exact.ts";

const SOURCE_INSTRUCTION_KEY =
  "fingerprint:content-a/deliverable:makesafe/cycle:1";
const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const ACTIONS = await Deno.readTextFile(
  new URL("../../../scripts/_ops-api-required-actions.txt", import.meta.url),
);
const REQUIREMENTS = await Deno.readTextFile(
  new URL(
    "../../../scripts/edge-function-schema-requirements.txt",
    import.meta.url,
  ),
);
const CAS_SQL = await Deno.readTextFile(
  new URL(
    "../../migrations/20260803090000_makesafe_job_identity_recovery_exact.sql",
    import.meta.url,
  ),
);

function snapshot(input: {
  jobNumber?: string;
  workOrder?: string | null;
  purchaseOrder?: string | null;
  state?: string;
  metadata?: Record<string, unknown>;
  detailExternalRef?: string | null;
} = {}): MakesafeJobIdentityRecoverySnapshot {
  const jobNumber = input.jobNumber || "SWMS-900001";
  const workOrder = input.workOrder === undefined
    ? "MLB-90001"
    : input.workOrder;
  const purchaseOrder = input.purchaseOrder === undefined
    ? "PO-70001"
    : input.purchaseOrder;
  return {
    job: {
      id: "job-a",
      jobNumber,
      type: "makesafe",
      metadata: structuredClone(
        input.metadata || {
          external_ref: workOrder,
          builder_claim_ref: workOrder,
          builder_work_order_number: workOrder,
          preserved_marker: "keep",
        },
      ),
    },
    detail: {
      externalRef: input.detailExternalRef === undefined
        ? workOrder
        : input.detailExternalRef,
      requestingCompanySlug: "mlb",
    },
    intakeCases: [{
      id: "case-a",
      state: input.state || "confirmed_live_job",
      jobId: "job-a",
      targetJobId: null,
      instructionKey: SOURCE_INSTRUCTION_KEY,
      externalRefCanonical: workOrder,
      builderWorkOrderCanonical: workOrder,
      builderPurchaseOrderCanonical: purchaseOrder,
      workOrderPurchaseOrderIdentityKey: workOrder && purchaseOrder
        ? `wo:${workOrder}/po:${purchaseOrder}`
        : null,
    }],
  };
}

function dependencies(initial: MakesafeJobIdentityRecoverySnapshot): {
  deps: MakesafeJobIdentityRecoveryDependencies;
  current: MakesafeJobIdentityRecoverySnapshot;
  corrections: any[];
} {
  const current = structuredClone(initial);
  const corrections: any[] = [];
  return {
    current,
    corrections,
    deps: {
      loadSnapshot: () => Promise.resolve(structuredClone(current)),
      applyCorrection: (correction) => {
        corrections.push(structuredClone(correction));
        current.job!.metadata = structuredClone(correction.metadata);
        current.detail!.externalRef = correction.externalRef;
        return Promise.resolve();
      },
    },
  };
}

async function dryRun(
  deps: MakesafeJobIdentityRecoveryDependencies,
  jobNumber = "SWMS-900001",
) {
  return await runMakesafeJobIdentityRecoverExact(
    { job_number: jobNumber },
    deps,
  );
}

Deno.test("exact identity recovery defaults to a source-only dry run", async () => {
  const db = dependencies(snapshot());
  const result: any = await dryRun(db.deps);

  assertEquals(result.ok, true);
  assertEquals(result.dry_run, true);
  assertEquals(result.writes_applied, 0);
  assertEquals(result.plan.disposition, "recover");
  assertEquals(result.plan.source_authority, {
    case_state: "confirmed_live_job",
    instruction_key_present: true,
    builder_work_order_number: "MLB-90001",
    builder_po_number: "PO-70001",
    builder_instruction_key: "MLB:PO-70001",
  });
  assert(/^sha256:[0-9a-f]{64}$/.test(result.plan_hash));
  assertEquals(db.corrections.length, 0);

  const publicJson = JSON.stringify(result);
  assertEquals(publicJson.includes("job-a"), false);
  assertEquals(publicJson.includes("case-a"), false);
  assertEquals(publicJson.includes(SOURCE_INSTRUCTION_KEY), false);
});

Deno.test("exact identity recovery applies one hashed plan and verifies read-back", async () => {
  const db = dependencies(snapshot());
  const preview: any = await dryRun(db.deps);
  const applied: any = await runMakesafeJobIdentityRecoverExact({
    job_number: "SWMS-900001",
    dry_run: false,
    expected_plan_hash: preview.plan_hash,
    run_key: "po-grain-900001-v1",
  }, db.deps);

  assertEquals(applied.ok, true);
  assertEquals(applied.read_back_verified, true);
  assertEquals(applied.writes_applied, 1);
  assertEquals(applied.plan.disposition, "already_current");
  assertEquals(db.corrections.length, 1);
  assertEquals(db.corrections[0].externalRef, "MLB-90001");
  assertEquals(db.corrections[0].correctedInstructionKey, "MLB:PO-70001");
  assertEquals(
    db.corrections[0].reason,
    "historical_source_identity_recovery:po-grain-900001-v1",
  );
  assertEquals(db.corrections[0].metadata.preserved_marker, "keep");
  assertEquals(db.corrections[0].metadata.builder_claim_ref, "MLB-90001");
  assertEquals(
    db.corrections[0].metadata.builder_work_order_number,
    "MLB-90001",
  );
  assertEquals(db.corrections[0].metadata.builder_po_number, "PO-70001");

  const secondPreview: any = await dryRun(db.deps);
  assertEquals(secondPreview.plan.disposition, "already_current");
  const secondApply: any = await runMakesafeJobIdentityRecoverExact({
    job_number: "SWMS-900001",
    dry_run: false,
    expected_plan_hash: secondPreview.plan_hash,
    run_key: "po-grain-900001-v2",
  }, db.deps);
  assertEquals(secondApply.writes_applied, 0);
  assertEquals(secondApply.read_back_verified, true);
  assertEquals(db.corrections.length, 1);
});

Deno.test("legacy composite WO storage is already current when typed WO and PO agree", async () => {
  const input = snapshot({
    metadata: {
      external_ref: "MLB-90001",
      builder_claim_ref: "MLB-90001",
      builder_work_order_number: "MLB-90001PO-70001",
      builder_po_number: "PO-70001",
    },
  });
  const result: any = await dryRun(dependencies(input).deps);
  assertEquals(result.plan.disposition, "already_current");
  assertEquals(
    result.plan.current_typed_identity.builder_work_order_number,
    "MLB-90001",
  );
  assertEquals(result.writes_applied, 0);
});

Deno.test("one WO group retains three distinct PO-grain identities", async () => {
  const mappings = [
    ["SWMS-261019", "PO-56395"],
    ["SWMS-261020", "PO-56397"],
    ["SWMS-261021", "PO-56459"],
  ] as const;
  const keys: string[] = [];
  for (const [jobNumber, purchaseOrder] of mappings) {
    const db = dependencies(snapshot({
      jobNumber,
      workOrder: "MLB-27037",
      purchaseOrder,
    }));
    const result: any = await dryRun(db.deps, jobNumber);
    assertEquals(
      result.plan.source_authority.builder_work_order_number,
      "MLB-27037",
    );
    keys.push(result.plan.source_authority.builder_instruction_key);
  }
  assertEquals(keys, [
    "MLB:PO-56395",
    "MLB:PO-56397",
    "MLB:PO-56459",
  ]);
});

Deno.test("exact identity recovery accepts one blocked target-bound live case", async () => {
  const input = snapshot({ state: "blocked_live_job" });
  input.intakeCases[0].jobId = null;
  input.intakeCases[0].targetJobId = "job-a";
  const result: any = await dryRun(dependencies(input).deps);
  assertEquals(result.ok, true);
  assertEquals(result.plan.source_authority.case_state, "blocked_live_job");
});

Deno.test("exact identity recovery refuses ambiguous live authority", async () => {
  const input = snapshot();
  input.intakeCases.push({
    ...structuredClone(input.intakeCases[0]),
    id: "case-b",
    instructionKey: "fingerprint:content-b/deliverable:makesafe/cycle:1",
  });
  const result: any = await dryRun(dependencies(input).deps);
  assertEquals(result.ok, false);
  assertEquals(result.plan.disposition, "refused");
  assertEquals(result.plan.reason_code, "canonical_live_case_ambiguous");
});

Deno.test("exact identity recovery refuses missing and junk source authority", async () => {
  const fixtures: Array<{
    mutate: (value: MakesafeJobIdentityRecoverySnapshot) => void;
    reason: string;
  }> = [
    {
      mutate: (value) => {
        value.intakeCases[0].builderWorkOrderCanonical = "UNKNOWN";
      },
      reason: "canonical_builder_work_order_missing_or_junk",
    },
    {
      mutate: (value) => {
        value.intakeCases[0].builderPurchaseOrderCanonical = "PO-BOX";
      },
      reason: "canonical_builder_po_missing_or_junk",
    },
    {
      mutate: (value) => {
        value.intakeCases[0].builderPurchaseOrderCanonical = "SENT";
      },
      reason: "canonical_builder_po_missing_or_junk",
    },
    {
      mutate: (value) => {
        value.intakeCases[0].instructionKey = null;
      },
      reason: "canonical_instruction_key_missing_or_junk",
    },
  ];
  for (const fixture of fixtures) {
    const input = snapshot();
    fixture.mutate(input);
    const result: any = await dryRun(dependencies(input).deps);
    assertEquals(result.plan.reason_code, fixture.reason);
    assertEquals(result.writes_applied, 0);
  }
});

Deno.test("exact identity recovery refuses a canonical WO-PO key mismatch", async () => {
  const input = snapshot();
  input.intakeCases[0].workOrderPurchaseOrderIdentityKey =
    "wo:MLB-90001/po:PO-70009";
  const result: any = await dryRun(dependencies(input).deps);
  assertEquals(
    result.plan.reason_code,
    "canonical_wo_po_identity_key_conflict",
  );
});

Deno.test("exact identity recovery never overwrites a good conflicting PO key", async () => {
  const db = dependencies(snapshot({
    metadata: {
      external_ref: "MLB-90009",
      builder_claim_ref: "MLB-90009",
      builder_work_order_number: "MLB-90009",
      builder_po_number: "PO-70009",
    },
    detailExternalRef: "MLB-90009PO-70009",
  }));
  const result: any = await dryRun(db.deps);
  assertEquals(result.ok, false);
  assertEquals(
    result.plan.reason_code,
    "good_builder_instruction_key_conflict",
  );
  assertEquals(result.plan.current_typed_identity.builder_instruction_keys, [
    "MLB:PO-70009",
  ]);
  assertEquals(db.corrections.length, 0);

  const poOnly = snapshot({
    metadata: { builder_po_number: "PO-70009" },
    detailExternalRef: null,
  });
  poOnly.detail!.requestingCompanySlug = null;
  const poOnlyResult: any = await dryRun(dependencies(poOnly).deps);
  assertEquals(
    poOnlyResult.plan.reason_code,
    "good_builder_instruction_key_conflict",
  );
});

Deno.test("exact identity recovery compares legacy references whole without mining PO text", async () => {
  const conflicting = dependencies(snapshot({
    detailExternalRef: "MLB-90009PO-70009",
  }));
  const refused: any = await dryRun(conflicting.deps);
  assertEquals(
    refused.plan.reason_code,
    "current_builder_group_reference_conflict",
  );
  assertEquals(
    refused.plan.current_typed_identity.builder_instruction_keys,
    [],
  );

  const sameAuthority = dependencies(snapshot({
    detailExternalRef: "MLB-90001PO-70001",
  }));
  const recoverable: any = await dryRun(sameAuthority.deps);
  assertEquals(recoverable.plan.disposition, "recover");
  assertEquals(
    recoverable.plan.source_authority.builder_instruction_key,
    "MLB:PO-70001",
  );
});

Deno.test("exact identity recovery never publishes an unscoped legacy value", async () => {
  const input = snapshot({ detailExternalRef: "UNSCOPED-12345" });
  const result: any = await dryRun(dependencies(input).deps);
  assertEquals(
    result.plan.current_typed_identity.detail_external_ref,
    null,
  );
  assertEquals(
    result.plan.current_typed_identity.has_unpublishable_reference_value,
    true,
  );
  assertEquals(JSON.stringify(result).includes("UNSCOPED-12345"), false);
});

Deno.test("exact identity recovery rejects stale plans before any write", async () => {
  const db = dependencies(snapshot());
  const preview: any = await dryRun(db.deps);
  db.current.detail!.externalRef = "TBD";

  const error = await assertRejects(
    () =>
      runMakesafeJobIdentityRecoverExact({
        job_number: "SWMS-900001",
        dry_run: false,
        expected_plan_hash: preview.plan_hash,
        run_key: "po-grain-stale-v1",
      }, db.deps),
    MakesafeJobIdentityRecoveryError,
  );
  assertEquals(error.status, 409);
  assertStringIncludes(error.message, "plan hash is stale");
  assertEquals(db.corrections.length, 0);
});

Deno.test("exact identity recovery requires one exact card and auditable apply fields", async () => {
  const db = dependencies(snapshot());
  await assertRejects(
    () =>
      runMakesafeJobIdentityRecoverExact({
        job_number: "SWMS-900001",
        unexpected: true,
      } as any, db.deps),
    MakesafeJobIdentityRecoveryError,
    "unsupported fields",
  );
  await assertRejects(
    () =>
      runMakesafeJobIdentityRecoverExact({
        job_number: "SWMS-900001",
        dry_run: false,
        expected_plan_hash: null,
        run_key: null,
      }, db.deps),
    MakesafeJobIdentityRecoveryError,
    "requires the exact dry-run plan hash",
  );
});

Deno.test("exact identity recovery refuses malformed job metadata", async () => {
  const input = snapshot();
  input.job!.metadataValid = false;
  const result: any = await dryRun(dependencies(input).deps);
  assertEquals(result.ok, false);
  assertEquals(result.plan.reason_code, "job_metadata_invalid");
});

Deno.test("exact identity recovery route and compare-and-set RPC ship together", () => {
  assertStringIncludes(INDEX, "case 'makesafe_job_identity_recover_exact'");
  assertStringIncludes(INDEX, "authMode !== 'api_key'");
  assertStringIncludes(INDEX, "req.method !== 'POST'");
  assertStringIncludes(ACTIONS, "\nmakesafe_job_identity_recover_exact\n");
  assertStringIncludes(
    REQUIREMENTS,
    "function|apply_makesafe_job_identity_recovery_exact",
  );
  assertStringIncludes(
    CAS_SQL,
    "CREATE OR REPLACE FUNCTION public.apply_makesafe_job_identity_recovery_exact",
  );
  assertStringIncludes(CAS_SQL, "FOR UPDATE");
  assertStringIncludes(CAS_SQL, "IS DISTINCT FROM p_expected_metadata");
  assertStringIncludes(CAS_SQL, "makesafe_work_order_identity_corrected");
});
