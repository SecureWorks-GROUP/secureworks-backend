// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { canonicalSesJson } from "./ses_docket_envelope.ts";
import {
  SES_FAMILY_MATRIX,
  SES_FAMILY_MATRIX_EXECUTABLE_POLICY,
  type SesFamilyMatrixRow,
} from "./ses_family_matrix.ts";
import {
  SES_PACK_PREPARATION_EXECUTABLE_POLICY,
  SES_WORKFLOW_PRICING_EXECUTABLE_POLICY,
  sesWorkflowPackProfile,
  sesWorkflowPackProfileForSwmsRequirement,
} from "./ses_prepare_docket_revision.ts";
import { SES_PORTAL_REQUIRED_ROLES } from "./ses_stage_engine_v2.ts";
import { SES_WORKFLOW_SEND_EXECUTION_POLICY } from "./ses_release_route_shape.ts";
import {
  SES_STAGE_EXECUTABLE_POLICY,
  sesDeliverableAuthorityRequiresPersistedCase,
  sesWorkflowExecutableFamilyPolicy,
} from "./ses_workflow_executable_policy.ts";
import {
  assertSesWorkflowExecutablePolicyConsistency,
  exportSesContractSnapshot,
  hashSesWorkflowContractSemanticContent,
  prepareSesWorkflowBackendPolicyContract,
  prepareSesWorkflowReleaseContract,
  resolveSesWorkflowStageContractCoordinate,
  SES_WORKFLOW_CONTRACT_CANONICAL_HASH,
  SES_WORKFLOW_EXECUTABLE_OPERAND_IDS,
  SES_WORKFLOW_PUBLIC_FAMILIES,
  type SesWorkflowContractManifest,
  validateSesWorkflowContractManifest,
} from "./ses_workflow_registry.ts";
import {
  computeSesWorkflowExecutableSourceClosure,
  SES_WORKFLOW_EXECUTABLE_ENTRY_POINTS,
  type SesWorkflowExecutableSourceClosure,
  sesWorkflowSourceClosureModuleName,
  type SesWorkflowSourceReader,
} from "./ses_workflow_source_closure.ts";
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
const OPS_API_TEST_ROOT = new URL("./", import.meta.url);
const sourceTextDecoder = new TextDecoder();
const sourceTextEncoder = new TextEncoder();

function cloneManifest(
  manifest: SesWorkflowContractManifest,
): SesWorkflowContractManifest {
  return structuredClone(manifest);
}

function jsonLeafPaths(value: unknown, path: string[] = []): string[][] {
  if (value === null || typeof value !== "object") return [path];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      jsonLeafPaths(item, [...path, String(index)])
    );
  }
  return Object.keys(value as Record<string, unknown>).sort().flatMap((key) =>
    jsonLeafPaths((value as Record<string, unknown>)[key], [...path, key])
  );
}

function mutateJsonLeaf(root: unknown, path: readonly string[]): void {
  let owner = root as Record<string, unknown> | unknown[];
  for (const segment of path.slice(0, -1)) {
    owner = (owner as Record<string, unknown>)[segment] as
      | Record<string, unknown>
      | unknown[];
  }
  const leaf = path.at(-1);
  assert(leaf !== undefined);
  const current = (owner as Record<string, unknown>)[leaf];
  (owner as Record<string, unknown>)[leaf] = typeof current === "boolean"
    ? !current
    : typeof current === "number"
    ? current + 1
    : `${String(current)}__mutated`;
}

function overlaySourceReader(
  overlays: Readonly<Record<string, string>>,
): SesWorkflowSourceReader {
  return async (url) => {
    const moduleName = sesWorkflowSourceClosureModuleName(
      url,
      OPS_API_TEST_ROOT,
    );
    const overlay = moduleName ? overlays[moduleName] : undefined;
    return overlay === undefined
      ? await Deno.readFile(url)
      : sourceTextEncoder.encode(overlay);
  };
}

async function sourceText(name: string): Promise<string> {
  return sourceTextDecoder.decode(
    await Deno.readFile(new URL(name, OPS_API_TEST_ROOT)),
  );
}

async function canonicalHashWithSourceClosure(
  manifest: SesWorkflowContractManifest,
  sourceClosure: SesWorkflowExecutableSourceClosure,
) {
  const mutated = cloneManifest(manifest);
  (mutated.executable_policy as Record<string, unknown>)[
    "source.transitive_module_closure"
  ] = sourceClosure;
  return await hashSesWorkflowContractSemanticContent(mutated);
}

interface DenoInfoResolution {
  specifier: string;
}

interface DenoInfoModule {
  specifier: string;
  dependencies?: Array<{
    code?: DenoInfoResolution;
    type?: DenoInfoResolution;
  }>;
}

async function denoInfoExecutableSourceClosure(): Promise<string[]> {
  const modules = new Map<string, DenoInfoModule>();
  for (const entryPoint of SES_WORKFLOW_EXECUTABLE_ENTRY_POINTS) {
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "info",
        "--json",
        new URL(entryPoint.module, OPS_API_TEST_ROOT).href,
      ],
      stdout: "piped",
      stderr: "piped",
      env: { NO_COLOR: "1" },
    }).output();
    assert(
      output.success,
      sourceTextDecoder.decode(output.stderr),
    );
    const graph = JSON.parse(sourceTextDecoder.decode(output.stdout)) as {
      version: number;
      roots: string[];
      modules: DenoInfoModule[];
    };
    assertEquals(graph.version, 1, "unexpected deno info graph schema");
    assert(Array.isArray(graph.roots));
    assert(Array.isArray(graph.modules));
    for (const module of graph.modules) modules.set(module.specifier, module);
  }

  const closure = new Set<string>();
  const pending = SES_WORKFLOW_EXECUTABLE_ENTRY_POINTS.map((entryPoint) =>
    new URL(entryPoint.module, OPS_API_TEST_ROOT).href
  );
  while (pending.length) {
    const specifier = pending.pop() as string;
    const moduleName = sesWorkflowSourceClosureModuleName(
      new URL(specifier),
      OPS_API_TEST_ROOT,
    );
    if (!moduleName || closure.has(moduleName)) continue;
    closure.add(moduleName);
    const module = modules.get(specifier);
    assert(module, `Deno graph omitted ${specifier}`);
    for (const dependency of module.dependencies ?? []) {
      for (const resolution of [dependency.code, dependency.type]) {
        if (resolution?.specifier) pending.push(resolution.specifier);
      }
    }
  }
  return [...closure].sort();
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

Deno.test("mutating the executable assessment SWMS operand changes the canonical contract hash", async () => {
  const base = await exportSesContractSnapshot();
  const runtimeProfile = sesWorkflowPackProfile("assessment_quote");
  const mutatedProfile = sesWorkflowPackProfileForSwmsRequirement(
    "assessment_quote",
    "hard_required",
  );
  assert(runtimeProfile);
  assertEquals(
    runtimeProfile.swms_requirement,
    "include_not_required_until_accuracy_gate",
  );
  assertEquals(mutatedProfile.swms_requirement, "hard_required");
  assertEquals(
    mutatedProfile.hard_required_artifacts.includes("scope_correct_swms"),
    true,
  );

  const mutated = cloneManifest(base);
  const assessment = mutated.profiles.artifact.find((profile) =>
    profile.profile_id === mutatedProfile.artifact_profile_id
  );
  assert(assessment);
  assessment.included_artifacts = [...mutatedProfile.included_artifacts];
  assessment.hard_required_artifacts = [
    ...mutatedProfile.hard_required_artifacts,
  ];
  assessment.forbidden_artifacts = [...mutatedProfile.forbidden_artifacts];
  assessment.swms_generation = mutatedProfile.swms_generation;
  assessment.swms_requirement = mutatedProfile.swms_requirement;
  assessment.source_rule_ids = [...mutatedProfile.source_rule_ids];
  assertNotEquals(
    await hashSesWorkflowContractSemanticContent(mutated),
    SES_WORKFLOW_CONTRACT_CANONICAL_HASH,
  );
});

Deno.test("mutating the executable deliverable-authority operand changes the canonical contract hash", async () => {
  const base = await exportSesContractSnapshot();
  const runtimePolicy = sesWorkflowExecutableFamilyPolicy("repair")
    .deliverable_authority;
  const mutatedPolicy = "legacy_instruction_or_case" as const;
  assertEquals(runtimePolicy, "persisted_effective_case_required");
  assertEquals(
    sesDeliverableAuthorityRequiresPersistedCase(runtimePolicy),
    true,
  );
  assertEquals(
    sesDeliverableAuthorityRequiresPersistedCase(mutatedPolicy),
    false,
  );

  const mutated = cloneManifest(base);
  const repair = mutated.profiles.family.find((profile) =>
    profile.family_id === "repair"
  );
  assert(repair);
  repair.deliverable_authority_policy = mutatedPolicy;
  repair.active_deliverable_required =
    sesDeliverableAuthorityRequiresPersistedCase(mutatedPolicy);
  for (
    const variant of mutated.variants.filter((candidate) =>
      candidate.runtime_family_id === "repair"
    )
  ) {
    variant.executable_family_policy.deliverable_authority = mutatedPolicy;
  }
  assertNotEquals(
    await hashSesWorkflowContractSemanticContent(mutated),
    base.canonical_contract_hash,
  );
});

Deno.test("every stage executable-policy operand is fingerprinted and fails closed when mutated", async () => {
  const base = await exportSesContractSnapshot();
  assertEquals(
    base.profiles.stage.length > 0,
    true,
  );
  for (const profile of base.profiles.stage) {
    assertEquals(
      canonicalSesJson(profile.executable_stage_policy),
      canonicalSesJson(SES_STAGE_EXECUTABLE_POLICY),
      profile.profile_id,
    );
  }

  const leafPaths = jsonLeafPaths(SES_STAGE_EXECUTABLE_POLICY);
  assert(leafPaths.length > 0);
  assert(
    leafPaths.some((path) => path.join(".") === "issued_invoice_statuses.0"),
  );
  for (const path of leafPaths) {
    const mutated = cloneManifest(base);
    mutateJsonLeaf(
      mutated.profiles.stage[0].executable_stage_policy,
      path,
    );
    assertNotEquals(
      await hashSesWorkflowContractSemanticContent(mutated),
      base.canonical_contract_hash,
      path.join("."),
    );
    const validation = await validateSesWorkflowContractManifest(mutated);
    assertEquals(validation.valid, false, path.join("."));
  }
});

Deno.test("adding DRAFT to the issued-invoice operand moves the hash and fails closed", async () => {
  const base = await exportSesContractSnapshot();
  const mutated = cloneManifest(base);
  const globalStagePolicy = mutated
    .executable_policy["stage.global_policy"] as {
      issued_invoice_statuses: string[];
    };
  globalStagePolicy.issued_invoice_statuses.push("DRAFT");
  for (const profile of mutated.profiles.stage) {
    (profile.executable_stage_policy as unknown as {
      issued_invoice_statuses: string[];
    }).issued_invoice_statuses.push("DRAFT");
  }

  assertNotEquals(
    await hashSesWorkflowContractSemanticContent(mutated),
    base.canonical_contract_hash,
  );
  const validation = await validateSesWorkflowContractManifest(mutated);
  assertEquals(validation.valid, false);
  assert(
    validation.errors.some((error) =>
      error.code === "canonical_contract_hash_mismatch" ||
      error.code === "runtime_registry_mismatch"
    ),
  );
});

Deno.test("the executable operand registry is structurally complete and every owned leaf moves the hash", async () => {
  const base = await exportSesContractSnapshot();
  assertEquals(
    Object.keys(base.executable_policy).sort(),
    [...SES_WORKFLOW_EXECUTABLE_OPERAND_IDS].sort(),
  );
  const owners = {
    "family.selection_policy": SES_FAMILY_MATRIX_EXECUTABLE_POLICY,
    "stage.global_policy": SES_STAGE_EXECUTABLE_POLICY,
    "pack.global_policy": SES_PACK_PREPARATION_EXECUTABLE_POLICY,
    "pricing.global_policy": SES_WORKFLOW_PRICING_EXECUTABLE_POLICY,
    "send.global_policy": SES_WORKFLOW_SEND_EXECUTION_POLICY,
  } as const;

  for (const [operandId, owner] of Object.entries(owners)) {
    assertEquals(
      canonicalSesJson(
        base.executable_policy[operandId as keyof typeof owners],
      ),
      canonicalSesJson(owner),
      operandId,
    );
    for (const path of jsonLeafPaths(owner)) {
      const mutated = cloneManifest(base);
      mutateJsonLeaf(
        mutated.executable_policy[operandId as keyof typeof owners],
        path,
      );
      assertNotEquals(
        await hashSesWorkflowContractSemanticContent(mutated),
        base.canonical_contract_hash,
        `${operandId}.${path.join(".")}`,
      );
    }
  }

  for (const operandId of SES_WORKFLOW_EXECUTABLE_OPERAND_IDS) {
    const mutated = cloneManifest(base);
    const path = jsonLeafPaths(mutated.executable_policy[operandId])[0];
    assert(path, operandId);
    mutateJsonLeaf(mutated.executable_policy[operandId], path);
    const validation = await validateSesWorkflowContractManifest(mutated);
    assertEquals(validation.valid, false, operandId);
    assert(
      validation.errors.some((error) =>
        error.code === "canonical_contract_hash_mismatch" ||
        error.code === "runtime_registry_mismatch"
      ),
      operandId,
    );
  }
});

Deno.test({
  name:
    "the executable source digest input set equals Deno's transitive local module closure",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const sourceClosure = await computeSesWorkflowExecutableSourceClosure();
    const denoClosure = await denoInfoExecutableSourceClosure();
    assertEquals(Object.keys(sourceClosure.modules), denoClosure);
    assertEquals(sourceClosure.module_count, denoClosure.length);
    assert(denoClosure.includes("ses_materials_rate_card.ts"));
    assert(denoClosure.includes("ses_unified_release.ts"));
    assert(denoClosure.includes("ses_workflow_registry.ts"));
    assert(denoClosure.includes("ses_workflow_source_closure.ts"));
  },
});

Deno.test("every named executable entry-point symbol resolves from its declared module", async () => {
  for (const entryPoint of SES_WORKFLOW_EXECUTABLE_ENTRY_POINTS) {
    const module = await import(
      new URL(entryPoint.module, OPS_API_TEST_ROOT).href
    ) as Record<string, unknown>;
    for (const symbol of entryPoint.symbols) {
      assert(
        symbol in module,
        `${entryPoint.surface}:${entryPoint.module} does not export ${symbol}`,
      );
    }
  }
});

Deno.test("ops-api deployment bundles the complete local TypeScript source boundary", async () => {
  const config = await Deno.readTextFile(
    new URL("../../config.toml", import.meta.url),
  );
  assert(
    config.includes('"./functions/ops-api/*.ts"'),
    "functions.ops-api.static_files must bundle every local TS module for runtime source attestation",
  );
});

Deno.test("mutating the pricing recognizer moves the canonical contract hash", async () => {
  const manifest = await exportSesContractSnapshot();
  const baseline = await computeSesWorkflowExecutableSourceClosure();
  const rateCardSource = await sourceText("ses_materials_rate_card.ts");
  const recognizer = "(?:sikaflex|silicone)";
  assert(rateCardSource.includes(recognizer));
  const mutated = await computeSesWorkflowExecutableSourceClosure({
    readSource: overlaySourceReader({
      "ses_materials_rate_card.ts": rateCardSource.replace(
        recognizer,
        "(?:sikaflexx|silicone)",
      ),
    }),
  });

  assertNotEquals(mutated.closure_sha256, baseline.closure_sha256);
  assertNotEquals(
    mutated.modules["ses_materials_rate_card.ts"],
    baseline.modules["ses_materials_rate_card.ts"],
  );
  assertNotEquals(
    await canonicalHashWithSourceClosure(manifest, mutated),
    manifest.canonical_contract_hash,
  );
});

Deno.test("mutating a transitive module outside the former allowlist moves the canonical contract hash", async () => {
  const manifest = await exportSesContractSnapshot();
  const baseline = await computeSesWorkflowExecutableSourceClosure();
  const guardSource = await sourceText("ses_materials_charge_guard.ts");
  const executableBranch = 'action: "rate_card_proposal"';
  assert(guardSource.includes(executableBranch));
  const mutated = await computeSesWorkflowExecutableSourceClosure({
    readSource: overlaySourceReader({
      "ses_materials_charge_guard.ts": guardSource.replace(
        executableBranch,
        'action: "rate_card_proposal_mutated"',
      ),
    }),
  });

  assertNotEquals(mutated.closure_sha256, baseline.closure_sha256);
  assertNotEquals(
    mutated.modules["ses_materials_charge_guard.ts"],
    baseline.modules["ses_materials_charge_guard.ts"],
  );
  assertNotEquals(
    await canonicalHashWithSourceClosure(manifest, mutated),
    manifest.canonical_contract_hash,
  );
});

Deno.test("a new entry-point import expands the closure and canonical digest input set", async () => {
  const manifest = await exportSesContractSnapshot();
  const baseline = await computeSesWorkflowExecutableSourceClosure();
  const rateCardSource = await sourceText("ses_materials_rate_card.ts");
  const fixtureName = "ses_workflow_source_closure_fixture.ts";
  const expanded = await computeSesWorkflowExecutableSourceClosure({
    readSource: overlaySourceReader({
      "ses_materials_rate_card.ts":
        `import "./${fixtureName}";\n${rateCardSource}`,
      [fixtureName]: "export const syntheticExecutableOperand = true;\n",
    }),
  });

  assertEquals(expanded.module_count, baseline.module_count + 1);
  assertEquals(
    Object.keys(expanded.modules),
    [
      ...Object.keys(baseline.modules),
      fixtureName,
    ].sort(),
  );
  assert(expanded.modules[fixtureName]);
  assertNotEquals(expanded.closure_sha256, baseline.closure_sha256);
  assertNotEquals(
    await canonicalHashWithSourceClosure(manifest, expanded),
    manifest.canonical_contract_hash,
  );
});

Deno.test("audited executable surfaces contain no known shadow operands", async () => {
  const stageSource = await Deno.readTextFile(
    new URL("./ses_stage_engine_v2.ts", import.meta.url),
  );
  const familySource = await Deno.readTextFile(
    new URL("./ses_family_matrix.ts", import.meta.url),
  );
  const prepareSource = await Deno.readTextFile(
    new URL("./ses_prepare_docket_revision.ts", import.meta.url),
  );
  const sendSource = await Deno.readTextFile(
    new URL("./ses_release_route_shape.ts", import.meta.url),
  );

  for (
    const [label, source, forbidden] of [
      [
        "stage",
        stageSource,
        [
          '["complete", "completed", "closed"].includes',
          '["cancelled", "canceled"].includes',
          '["submitted", "approved"].includes',
        ],
      ],
      [
        "family",
        familySource,
        [
          'new Set<SesBuilderKey>(["AJS", "AJBR"])',
          "/\\bMLB[-\\s]?\\d/.test(ref)",
        ],
      ],
      [
        "pricing",
        prepareSource,
        [
          "/\\b(?:temporary|temp)[ -]*fenc(?:e|ing) panels?\\b|\\bfence panels?\\b/i",
          "/\\bcable ties?\\b|\\bclips?\\b|\\bfixings?\\b|\\bsmall consumables?\\b/i",
          'row.invoice_basis === "ajs_labour_materials"',
        ],
      ],
      [
        "send",
        sendSource,
        [
          'status === "DRAFT"',
          'status === "AUTHORISED"',
          "/\\b(?:drafts?|dockets?|packs?|routes?|cycles?|revisions?",
        ],
      ],
    ] as const
  ) {
    for (const fragment of forbidden) {
      assertEquals(source.includes(fragment), false, `${label}: ${fragment}`);
    }
  }
});

Deno.test("every executable family-matrix row is fingerprinted and portal-role drift fails closed", async () => {
  const base = await exportSesContractSnapshot();
  for (const row of SES_FAMILY_MATRIX) {
    const variant = base.variants.find((candidate) =>
      candidate.runtime_family_id === row.family &&
      candidate.builder_key === row.builder_key &&
      candidate.routing_rule === row.routing_rule
    );
    assert(
      variant,
      `${row.builder_key}/${row.family}/${row.routing_rule}`,
    );
    assertEquals(
      canonicalSesJson(variant.executable_matrix_row),
      canonicalSesJson(row),
    );
    if (row.family === "unknown") throw new Error("unexpected unknown family");
    assertEquals(
      canonicalSesJson(variant.executable_family_policy),
      canonicalSesJson(sesWorkflowExecutableFamilyPolicy(row.family)),
    );
    assertSesWorkflowExecutablePolicyConsistency(row);
  }

  const assessment = SES_FAMILY_MATRIX.find((row) =>
    row.builder_key === "MLB" && row.family === "assessment_quote" &&
    row.routing_rule === "mlb-perth-routing"
  );
  assert(assessment);
  const mutatedRow: SesFamilyMatrixRow = {
    ...assessment,
    required_portal_roles: assessment.required_portal_roles.filter((role) =>
      role !== "scope"
    ),
    named_na_rules: [...assessment.named_na_rules],
  };
  assertThrows(
    () => assertSesWorkflowExecutablePolicyConsistency(mutatedRow),
    Error,
    "portal roles diverge from the executable portal-role owner",
  );

  const mutated = cloneManifest(base);
  const variant = mutated.variants.find((candidate) =>
    candidate.variant_id === "assessment.portal.mlb.perth"
  );
  assert(variant);
  variant.executable_matrix_row.required_portal_roles = variant
    .executable_matrix_row.required_portal_roles.filter((role) =>
      role !== "scope"
    );
  assertNotEquals(
    await hashSesWorkflowContractSemanticContent(mutated),
    base.canonical_contract_hash,
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

Deno.test("persisted workflow coordinates resolve fail-closed for stage placement", async () => {
  const manifest = await exportSesContractSnapshot();
  const variant = manifest.variants.find((candidate) =>
    candidate.builder_key === "MLB" &&
    candidate.runtime_family_id === "physical_makesafe"
  );
  if (!variant) throw new Error("missing MLB physical variant");

  assertEquals(
    resolveSesWorkflowStageContractCoordinate({
      runtime_family_id: variant.runtime_family_id,
      variant_id: variant.variant_id,
      canonical_contract_hash: manifest.canonical_contract_hash,
      stored_seal_state: variant.seal_state,
    }),
    {
      state: "known_unsealed",
      reason_code: variant.unsealed_reason_code,
      variant_id: variant.variant_id,
    },
  );
  assertEquals(
    resolveSesWorkflowStageContractCoordinate({}),
    {
      state: "unsupported",
      reason_code: "family_contract_incomplete",
      variant_id: null,
    },
  );
  assertEquals(
    resolveSesWorkflowStageContractCoordinate({
      runtime_family_id: variant.runtime_family_id,
      variant_id: variant.variant_id,
      canonical_contract_hash: manifest.canonical_contract_hash,
    }).reason_code,
    "family_contract_incomplete",
  );
  assertEquals(
    resolveSesWorkflowStageContractCoordinate({
      runtime_family_id: variant.runtime_family_id,
      variant_id: variant.variant_id,
      canonical_contract_hash: "sha256:divergent",
      stored_seal_state: variant.seal_state,
    }).reason_code,
    "family_contract_divergent",
  );
  assertEquals(
    resolveSesWorkflowStageContractCoordinate({
      runtime_family_id: "assessment_quote",
      variant_id: variant.variant_id,
      canonical_contract_hash: manifest.canonical_contract_hash,
      stored_seal_state: variant.seal_state,
    }).reason_code,
    "unsupported_family_variant",
  );
  assertEquals(
    resolveSesWorkflowStageContractCoordinate({
      runtime_family_id: variant.runtime_family_id,
      variant_id: variant.variant_id,
      canonical_contract_hash: manifest.canonical_contract_hash,
      stored_seal_state: "sealed",
    }).reason_code,
    "family_contract_divergent",
  );
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
