// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { canonicalSesJson } from "./ses_docket_envelope.ts";
import { SES_PORTAL_REQUIRED_ROLES } from "./ses_stage_engine_v2.ts";
import {
  exportSesContractSnapshot,
  hashSesWorkflowContractSemanticContent,
  prepareSesWorkflowBackendPolicyContract,
  prepareSesWorkflowReleaseContract,
  SES_WORKFLOW_CONTRACT_CANONICAL_HASH,
  SES_WORKFLOW_PUBLIC_FAMILIES,
  type SesWorkflowContractManifest,
  validateSesWorkflowContractManifest,
} from "./ses_workflow_registry.ts";
import {
  approveSesInvoiceRevisionAction,
  buildSesReleaseRevisionPlanForDockets,
  SesActionError,
} from "./ses_reporting_actions.ts";

const MLB_PHYSICAL = {
  builder_key: "MLB" as const,
  runtime_family_id: "physical_makesafe" as const,
  site_suburb: "Perth",
};

function cloneManifest(
  manifest: SesWorkflowContractManifest,
): SesWorkflowContractManifest {
  return structuredClone(manifest);
}

Deno.test("SES workflow registry exports exactly six families and every effective matrix variant", async () => {
  const manifest = await exportSesContractSnapshot();
  const validation = await validateSesWorkflowContractManifest(manifest);
  assertEquals(validation, { valid: true, errors: [] });
  assertEquals(
    manifest.profiles.family.map((profile) => profile.family_id).sort(),
    [...SES_WORKFLOW_PUBLIC_FAMILIES].sort(),
  );
  assertEquals(manifest.variants.length, 32);
  assert(
    manifest.variants.some((variant) =>
      variant.family_id === "roof" && variant.delivery_variant === "portal"
    ),
  );
  assert(
    manifest.variants.some((variant) =>
      variant.family_id === "roof" &&
      variant.delivery_variant === "own_document"
    ),
  );

  const profileIds = new Set([
    ...manifest.profiles.family,
    ...manifest.profiles.artifact,
    ...manifest.profiles.stage,
    ...manifest.profiles.pack,
    ...manifest.profiles.pricing,
    ...manifest.profiles.send,
  ].map((profile) => profile.profile_id));
  for (const variant of manifest.variants) {
    for (
      const profileId of [
        variant.family_profile_id,
        variant.artifact_profile_id,
        variant.stage_profile_id,
        variant.pack_profile_id,
        variant.pricing_profile_id,
        variant.expected_send_profile_id,
      ]
    ) {
      assert(profileIds.has(profileId), `${variant.variant_id}: ${profileId}`);
    }
    assertEquals(variant.contract_hash, manifest.canonical_contract_hash);
    assertEquals(variant.live_release_enabled, false);
    assertEquals(variant.seal_state, "unsealed");
    assert(variant.unsealed_reason_code);
    assertEquals(variant.send_recipe_id, null);
    assert(
      manifest.profiles.send.some((profile) =>
        profile.profile_id === variant.expected_send_profile_id
      ),
    );
    assertEquals(variant.release_prerequisites, {
      release_contract_enabled: false,
      wiki_backend_hash_agreed: false,
      atomic_release_lease_satisfied: false,
    });
  }
});

Deno.test("SES workflow contract hash is deterministic, semantic, and pinned", async () => {
  const first = await exportSesContractSnapshot();
  const second = await exportSesContractSnapshot();
  assertEquals(canonicalSesJson(first), canonicalSesJson(second));
  assertEquals(
    first.canonical_contract_hash,
    SES_WORKFLOW_CONTRACT_CANONICAL_HASH,
  );
  assertEquals(
    await hashSesWorkflowContractSemanticContent(first),
    SES_WORKFLOW_CONTRACT_CANONICAL_HASH,
  );

  const changed = cloneManifest(first);
  changed.profiles.artifact[0].included_artifacts = [
    ...changed.profiles.artifact[0].included_artifacts,
    "quote",
  ];
  assertNotEquals(
    await hashSesWorkflowContractSemanticContent(changed),
    SES_WORKFLOW_CONTRACT_CANONICAL_HASH,
  );

  const pricingChanged = cloneManifest(first);
  pricingChanged.profiles.pricing[0].executable_semantics = {
    ...pricingChanged.profiles.pricing[0].executable_semantics,
    hostile_price_change: 1,
  };
  assertNotEquals(
    await hashSesWorkflowContractSemanticContent(pricingChanged),
    SES_WORKFLOW_CONTRACT_CANONICAL_HASH,
  );

  const sendProgramChanged = cloneManifest(first);
  const sendProfile = sendProgramChanged.profiles.send.find((profile) =>
    profile.profile_id === "send.mlb.physical.v1"
  );
  assert(sendProfile);
  const executionPolicy = sendProfile.executable_semantics
    .execution_policy as Record<string, unknown>;
  const artifactRoles = executionPolicy.artifact_roles as Record<
    string,
    unknown
  >;
  sendProfile.executable_semantics = {
    ...sendProfile.executable_semantics,
    execution_policy: {
      ...executionPolicy,
      artifact_roles: {
        ...artifactRoles,
        approved_invoice_support: ["supporting_report_pdf"],
      },
    },
  };
  assertNotEquals(
    await hashSesWorkflowContractSemanticContent(sendProgramChanged),
    SES_WORKFLOW_CONTRACT_CANONICAL_HASH,
  );
});

Deno.test("assessment contract is the assessment triad plus invoice, never a physical report pointer", async () => {
  const manifest = await exportSesContractSnapshot();
  const artifact = manifest.profiles.artifact.find((profile) =>
    profile.profile_id === "artifacts.assessment.v1"
  );
  const stage = manifest.profiles.stage.find((profile) =>
    profile.profile_id === "stage.assessment.v1"
  );
  assert(artifact);
  assert(stage);
  assertEquals(
    [...artifact.hard_required_artifacts].sort(),
    ["assessment_report", "photos", "quote", "invoice"].sort(),
  );
  assertEquals(
    [...stage.required_portal_roles].sort(),
    [...(SES_PORTAL_REQUIRED_ROLES.assessment_quote || [])].sort(),
  );
  assertEquals(artifact.included_artifacts.includes("physical_report"), false);
  assertEquals(artifact.forbidden_artifacts.includes("physical_report"), true);
});

Deno.test("all physical families/builders hard-require generated SWMS; roof and assessment include it until the accuracy gate", async () => {
  const manifest = await exportSesContractSnapshot();
  const physicalFamilies = new Set([
    "physical_makesafe",
    "temporary_fence",
    "repair",
    "restoration",
  ]);
  for (const variant of manifest.variants) {
    const artifact = manifest.profiles.artifact.find((profile) =>
      profile.profile_id === variant.artifact_profile_id
    );
    assert(artifact, variant.variant_id);
    assertEquals(artifact.swms_generation, "generated_scope_correct");
    assert(artifact.included_artifacts.includes("scope_correct_swms"));
    if (physicalFamilies.has(variant.family_id)) {
      assertEquals(artifact.swms_requirement, "hard_required");
      assert(artifact.hard_required_artifacts.includes("scope_correct_swms"));
    } else {
      assertEquals(
        artifact.swms_requirement,
        "include_not_required_until_accuracy_gate",
      );
      assertEquals(
        artifact.hard_required_artifacts.includes("scope_correct_swms"),
        false,
      );
    }
  }
});

Deno.test("sealed-or-refuse rejects each missing profile and divergent hashes before approval/effects", async () => {
  const base = await exportSesContractSnapshot();
  const profileCollections = [
    "family",
    "artifact",
    "stage",
    "pack",
    "pricing",
    "send",
  ] as const;
  const variant = base.variants.find((candidate) =>
    candidate.variant_id === "physical_makesafe.standard.mlb.perth"
  );
  assert(variant);
  const referencedIds = {
    family: variant.family_profile_id,
    artifact: variant.artifact_profile_id,
    stage: variant.stage_profile_id,
    pack: variant.pack_profile_id,
    pricing: variant.pricing_profile_id,
    send: variant.expected_send_profile_id,
  };

  for (const collection of profileCollections) {
    const incomplete = cloneManifest(base);
    incomplete.profiles[collection] = incomplete.profiles[collection].filter(
      (profile) => profile.profile_id !== referencedIds[collection],
    ) as never;
    const result = await prepareSesWorkflowReleaseContract(
      MLB_PHYSICAL,
      incomplete,
    );
    assertEquals(result.ok, false, collection);
    if (result.ok) throw new Error("expected refusal");
    assertEquals(result.code, "family_contract_incomplete", collection);
    assertEquals(result.phase, "before_approval_or_effects");
    assertEquals(result.approval_allowed, false);
    assertEquals(result.external_effects_allowed, false);
  }

  const divergent = cloneManifest(base);
  const divergentStage = divergent.profiles.stage.find((profile) =>
    profile.profile_id === variant.stage_profile_id
  );
  assert(divergentStage);
  divergentStage.contract_hash = `sha256:${"0".repeat(64)}`;
  const result = await prepareSesWorkflowReleaseContract(
    MLB_PHYSICAL,
    divergent,
  );
  assertEquals(result.ok, false);
  if (result.ok) throw new Error("expected refusal");
  assertEquals(result.code, "family_contract_divergent");
  assertEquals(result.approval_allowed, false);
  assertEquals(result.external_effects_allowed, false);
});

Deno.test("registry validation rejects internally inconsistent profile chains", async () => {
  const base = await exportSesContractSnapshot();
  const inconsistent = cloneManifest(base);
  const pack = inconsistent.profiles.pack.find((profile) =>
    profile.profile_id === "pack.physical.v1"
  );
  assert(pack);
  pack.artifact_profile_id = "artifacts.assessment.v1";

  const validation = await validateSesWorkflowContractManifest(inconsistent);
  assertEquals(validation.valid, false);
  assert(
    validation.errors.some((error) =>
      error.code === "variant_profile_invalid" &&
      error.variant_id === "physical_makesafe.standard.mlb.perth"
    ),
  );

  const executableWhileUnsealed = cloneManifest(base);
  const variant = executableWhileUnsealed.variants.find((candidate) =>
    candidate.variant_id === "physical_makesafe.standard.mlb.perth"
  );
  assert(variant);
  variant.send_recipe_id = variant.expected_send_profile_id;
  const executableValidation = await validateSesWorkflowContractManifest(
    executableWhileUnsealed,
  );
  assertEquals(executableValidation.valid, false);
  assert(
    executableValidation.errors.some((error) =>
      error.code === "unsealed_variant_invalid" &&
      error.variant_id === variant.variant_id
    ),
  );
});

Deno.test("every backend-policy-sealed builder and family variant resolves to its exact prepared coordinate", async () => {
  const manifest = await exportSesContractSnapshot();
  for (const variant of manifest.variants) {
    if (variant.backend_policy_seal_state !== "sealed") continue;
    const result = await prepareSesWorkflowBackendPolicyContract({
      builder_key: variant.builder_key,
      runtime_family_id: variant.runtime_family_id,
      own_template_requested: variant.delivery_variant === "own_document",
      site_suburb: variant.region_qualifier === "south_west"
        ? "Bunbury"
        : "Perth",
      deliverable_active: variant.family_id === "repair" ||
          variant.family_id === "restoration"
        ? true
        : undefined,
    }, manifest);
    assertEquals(result.ok, true, variant.variant_id);
    if (!result.ok) throw new Error(result.reason);
    assertEquals(result.variant.variant_id, variant.variant_id);
    assertEquals(result.canonical_contract_hash, variant.contract_hash);
    assertEquals(result.approval_allowed, false);
    assertEquals(result.external_effects_allowed, false);
  }
});

Deno.test("roof and assessment remain typed-unsealed with no executable send recipe", async () => {
  for (
    const input of [
      {
        builder_key: "MLB" as const,
        runtime_family_id: "ordinary_roof_portal" as const,
      },
      {
        builder_key: "MLB" as const,
        runtime_family_id: "own_template_roof" as const,
        own_template_requested: true,
      },
      {
        builder_key: "MLB" as const,
        runtime_family_id: "assessment_quote" as const,
      },
    ]
  ) {
    const result = await prepareSesWorkflowReleaseContract(input);
    assertEquals(result.ok, false);
    if (result.ok) throw new Error("expected refusal");
    assertEquals(result.code, "family_contract_unsealed");
    assertEquals(result.profile_id, "send.report_only.unsettled.v1");
    assertEquals(result.approval_allowed, false);
    assertEquals(result.external_effects_allowed, false);
  }
});

Deno.test("unsupported builder and synthetic variants refuse without effects", async () => {
  const unsupported = await prepareSesWorkflowReleaseContract({
    builder_key: "UNKNOWN",
    runtime_family_id: "physical_makesafe",
  });
  assertEquals(unsupported.ok, false);
  if (unsupported.ok) throw new Error("expected refusal");
  assertEquals(unsupported.code, "unsupported_family_variant");
  assertEquals(unsupported.approval_allowed, false);
  assertEquals(unsupported.external_effects_allowed, false);

  const synthetic = await prepareSesWorkflowReleaseContract({
    builder_key: "SYNTHETIC",
    runtime_family_id: "physical_makesafe",
  });
  assertEquals(synthetic.ok, false);
  if (synthetic.ok) throw new Error("expected refusal");
  assertEquals(synthetic.code, "family_contract_unsealed");
  assertEquals(synthetic.profile_id, "send.synthetic.disabled.v1");
  assertEquals(synthetic.approval_allowed, false);
  assertEquals(synthetic.external_effects_allowed, false);
});

Deno.test("repair and restoration refuse deliverable_not_active and preserve typed family when active", async () => {
  for (const runtimeFamily of ["repair", "restoration"] as const) {
    for (const deliverableActive of [undefined, false]) {
      const refused = await prepareSesWorkflowReleaseContract({
        builder_key: "MLB",
        runtime_family_id: runtimeFamily,
        deliverable_active: deliverableActive,
      });
      assertEquals(refused.ok, false);
      if (refused.ok) throw new Error("expected refusal");
      assertEquals(refused.code, "deliverable_not_active");
      assertEquals(refused.approval_allowed, false);
      assertEquals(refused.external_effects_allowed, false);
    }

    const prepared = await prepareSesWorkflowBackendPolicyContract({
      builder_key: "MLB",
      runtime_family_id: runtimeFamily,
      deliverable_active: true,
    });
    assertEquals(prepared.ok, true);
    if (!prepared.ok) throw new Error(prepared.reason);
    assertEquals(prepared.variant.family_id, runtimeFamily);
    assertEquals(prepared.variant.runtime_family_id, runtimeFamily);
    assertEquals(prepared.variant.pack_profile_id, "pack.physical.v1");
    assertEquals(prepared.approval_allowed, false);
    assertEquals(prepared.external_effects_allowed, false);
  }
});

Deno.test("physical backend policy prepares, while the effective release stays unsealed and effect-free", async () => {
  const policy = await prepareSesWorkflowBackendPolicyContract(MLB_PHYSICAL);
  assertEquals(policy.ok, true);
  if (!policy.ok) throw new Error(policy.reason);
  assertEquals(policy.state, "backend_policy_prepared");
  assertEquals(policy.variant.backend_policy_seal_state, "sealed");
  assertEquals(policy.variant.seal_state, "unsealed");
  assertEquals(policy.variant.live_release_enabled, false);
  assertEquals(policy.profiles.send.live_effects_enabled, false);
  assertEquals(
    policy.profiles.send.atomic_release_gate,
    "required_before_live_release",
  );
  assertEquals(policy.approval_allowed, false);
  assertEquals(policy.external_effects_allowed, false);

  const release = await prepareSesWorkflowReleaseContract(MLB_PHYSICAL);
  assertEquals(release.ok, false);
  if (release.ok) throw new Error("expected release refusal");
  assertEquals(release.code, "family_contract_unsealed");
  assertEquals(release.reason, "release_contract_preflight_only");
  assertEquals(release.approval_allowed, false);
  assertEquals(release.external_effects_allowed, false);
});

Deno.test("release prepare boundary invokes sealed-or-refuse before commit", async () => {
  const manifest = await exportSesContractSnapshot();
  const variant = manifest.variants.find((candidate) =>
    candidate.variant_id === "physical_makesafe.standard.mlb.perth"
  );
  assert(variant);
  const error = await assertRejects(
    () =>
      buildSesReleaseRevisionPlanForDockets({
        org_id: "org-synthetic",
        dockets: [{
          job_id: "job-synthetic",
          clean_input: {
            builder_key: "MLB",
            family: "physical_makesafe",
            routing_rule: "mlb-perth-routing",
            workflow_contract_variant_id: variant.variant_id,
            workflow_contract_hash: manifest.canonical_contract_hash,
            deliverable_active: true,
          },
        } as never],
        routes: [],
        created_by: "synthetic-operator",
      }),
    SesActionError,
  );
  assertEquals(error.status, 409);
  assertEquals(
    (error.refusal as { code?: string }).code,
    "family_contract_unsealed",
  );
});

Deno.test("invoice approval boundary refuses the unsealed contract before a write", async () => {
  const manifest = await exportSesContractSnapshot();
  const variant = manifest.variants.find((candidate) =>
    candidate.variant_id === "physical_makesafe.standard.mlb.perth"
  );
  assert(variant);
  const rpcCalls: string[] = [];
  const error = await assertRejects(
    () =>
      approveSesInvoiceRevisionAction(
        {
          from() {
            throw new Error("no table read expected before contract refusal");
          },
          rpc(name: string) {
            rpcCalls.push(name);
            return Promise.resolve({ data: null, error: null });
          },
        } as never,
        {
          mode: "jwt",
          user: {
            id: "synthetic-user",
            email: "synthetic@example.test",
            role: "admin",
          },
        },
        {
          org_id: "org-synthetic",
          job_id: "job-synthetic",
          includes_authorise: true,
          expected_docket_revision_id: "docket-synthetic",
          expected_invoice_obligation_revision_id: "obligation-synthetic",
          expected_output_content_hash: `sha256:${"a".repeat(64)}`,
        },
        {
          loadDocket: () =>
            Promise.resolve({
              clean_input: {
                builder_key: "MLB",
                family: "physical_makesafe",
                routing_rule: "mlb-perth-routing",
                workflow_contract_variant_id: variant.variant_id,
                workflow_contract_hash: manifest.canonical_contract_hash,
                deliverable_active: true,
              },
            } as never),
        },
      ),
    SesActionError,
  );
  assertEquals(error.status, 409);
  assertEquals(
    (error.refusal as { code?: string }).code,
    "family_contract_unsealed",
  );
  assertEquals(rpcCalls, []);
});
