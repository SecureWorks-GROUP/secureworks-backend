// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260728060000_makesafe_board_reconcile_truth_u2.sql",
    import.meta.url,
  ),
);
const rollback = await Deno.readTextFile(
  new URL(
    "../../rollbacks/20260728060000_makesafe_board_reconcile_truth_u2_down.sql",
    import.meta.url,
  ),
);
const seedScopeMigration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260729000000_makesafe_state_seed_scope_accounting.sql",
    import.meta.url,
  ),
);
const seedScopeRollback = await Deno.readTextFile(
  new URL(
    "../../rollbacks/20260729000000_makesafe_state_seed_scope_accounting_down.sql",
    import.meta.url,
  ),
);
const decimalFactMigration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260729030000_makesafe_decimal_fact_canonicalization.sql",
    import.meta.url,
  ),
);
const decimalBoundaryContract = await Deno.readTextFile(
  new URL(
    "../../tests/makesafe_decimal_fact_boundary_contract.sql",
    import.meta.url,
  ),
);
const previewMigration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260731085928_board_v2_seed_preview.sql",
    import.meta.url,
  ),
);
const indexSource = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);
const compareSource = await Deno.readTextFile(
  new URL("./makesafe_state_compare.ts", import.meta.url),
);

Deno.test("truth migration ships dark and never mutates operational status", () => {
  assertStringIncludes(migration, "SCHEMA/RPC ONLY");
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.seed_makesafe_state_authority_v1",
  );
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.apply_makesafe_board_reconciliation",
  );
  assertEquals(
    /(?:SELECT|PERFORM)\s+public\.seed_makesafe_state_authority_v1\s*\(/i
      .test(migration),
    false,
  );
  assertEquals(/UPDATE\s+public\.jobs\b/i.test(migration), false);
  assertEquals(
    /UPDATE\s+public\.makesafe_job_details[\s\S]{0,200}\bsubstatus\s*=/i
      .test(migration),
    false,
  );
  assertEquals(
    /UPDATE\s+public\.makesafe_state_projection_config/i.test(migration),
    false,
  );
});

Deno.test("seed versions every v2 fact source and preserves ambiguous cycles", () => {
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.stamp_makesafe_intake_case_identity_v1",
  );
  assertStringIncludes(
    migration,
    "CREATE TRIGGER trg_makesafe_intake_cases_stamp_state_v2",
  );
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.refresh_makesafe_case_lineage_identity_v1",
  );
  for (
    const table of [
      "makesafe_attendance_cycles",
      "job_assignments",
      "job_service_reports",
      "job_documents",
      "job_media",
      "makesafe_report_packs",
    ]
  ) {
    assertStringIncludes(
      migration,
      `'trg_' || relation_name || '_fact_identity_v1'`,
    );
    assertStringIncludes(migration, `'${table}'`);
    assertStringIncludes(
      rollback,
      `DROP TRIGGER IF EXISTS trg_${table}_fact_identity_v1`,
    );
  }
  assertStringIncludes(migration, "HAVING count(*) = 1");
  assertStringIncludes(migration, "multiple_effective_authorities");
  assertStringIncludes(migration, "family_unclassified");
  assertStringIncludes(migration, "facts_seeded_or_bound");
});

Deno.test("atomic reconciliation accepts only a complete two-way partition", () => {
  assertStringIncludes(
    migration,
    "trustworthy_count + captain_marked_count = requested_count",
  );
  assertStringIncludes(
    migration,
    "neither_count integer NOT NULL CHECK (neither_count = 0)",
  );
  assertStringIncludes(
    migration,
    "reconciliation must partition every current make-safe exactly once",
  );
  assertStringIncludes(
    migration,
    "INSERT INTO public.makesafe_board_status_applications",
  );
  assertStringIncludes(
    migration,
    "INSERT INTO public.makesafe_board_attention_marks",
  );
  assertStringIncludes(migration, "evidence_ref");
  assertStringIncludes(migration, "computed_reasons");
});

Deno.test("finalize rejects detail cycle-binding drift", () => {
  assertStringIncludes(
    compareSource,
    "job_id,substatus,cycle_number,attendance_cycle_id,cycle_attribution",
  );
  assertStringIncludes(compareSource, "jobDetail?.attendance_cycle_id");
  assertStringIncludes(
    compareSource,
    'jobDetail.cycle_attribution !== "bound"',
  );
  assertStringIncludes(
    migration,
    "d.attendance_cycle_id IS NOT DISTINCT FROM NULLIF(v_token->>'attendance_cycle_id', '')::uuid",
  );
  assertStringIncludes(
    migration,
    "d.cycle_attribution IS NOT DISTINCT FROM v_token->>'cycle_attribution'",
  );
  assertStringIncludes(migration, "detail_cycle_binding");
});

Deno.test("nullable row cardinality uses valid PL/pgSQL CASE expressions", () => {
  assertEquals(
    migration.match(
      /<> \(CASE WHEN v_token IS NULL THEN 0 ELSE 1 END\)/g,
    )?.length,
    2,
  );
  assertEquals(
    migration.includes(
      "<> CASE WHEN v_token IS NULL THEN 0 ELSE 1 END",
    ),
    false,
  );
});

Deno.test("edge acceptance is the live U4 canary plus zero v2 input errors", () => {
  assertStringIncludes(indexSource, "case 'makesafe_state_seed'");
  assertStringIncludes(
    indexSource,
    "'seed_makesafe_state_authority_scoped_v2'",
  );
  assertStringIncludes(indexSource, "job_number: 'SWMS-26980'");
  assertStringIncludes(indexSource, ".startsWith('spine_missing_')");
  assertStringIncludes(
    indexSource,
    "comparison.projection_health.projection_input_error_job_count",
  );
  assert(
    indexSource.includes(
      "const acceptancePassed = inputErrors === 0 && spineBlockers.length === 0",
    ),
  );
});

Deno.test("seed preview is service-role-only, read-only, and exact-card complete", () => {
  assertStringIncludes(
    previewMigration,
    "CREATE OR REPLACE FUNCTION public.preview_makesafe_state_authority_v2",
  );
  assertStringIncludes(previewMigration, "STABLE");
  assertStringIncludes(previewMigration, "SECURITY INVOKER");
  assertStringIncludes(
    previewMigration,
    "REVOKE ALL ON FUNCTION public.preview_makesafe_state_authority_v2(uuid[])",
  );
  assertStringIncludes(
    previewMigration,
    "GRANT EXECUTE ON FUNCTION public.preview_makesafe_state_authority_v2(uuid[])",
  );
  const previewBody = previewMigration.match(
    /CREATE OR REPLACE FUNCTION public\.preview_makesafe_state_authority_v2[\s\S]+?AS \$\$([\s\S]+?)\$\$;/,
  )?.[1] || "";
  assert(previewBody.length > 0);
  assertEquals(
    /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i.test(previewBody),
    false,
  );
  assertStringIncludes(previewBody, "count(c.case_id) AS case_count");
  assertStringIncludes(previewBody, "count(DISTINCT id)");
  assertStringIncludes(previewBody, "v_matched <> v_requested");
});

Deno.test("seed repair fixes the case selector and canonical restoration boundary", () => {
  assertStringIncludes(previewMigration, "count(c.id) AS case_count");
  assertStringIncludes(previewMigration, "count(c.case_id) AS case_count");
  assertStringIncludes(
    previewMigration,
    "seed_makesafe_state_authority_v1 no longer matches the reviewed repair anchors",
  );
  assertStringIncludes(
    previewMigration,
    "j.metadata->>'insurance_job_type' = 'restoration'",
  );
  assertStringIncludes(
    seedScopeMigration,
    "public.stamp_makesafe_fact_identity_v1()",
  );
});

Deno.test("seed and reconcile dry-runs use prospective projection inputs", () => {
  assertStringIncludes(
    indexSource,
    "attachMakesafeStateV2SeedPreviewComparison",
  );
  assertStringIncludes(indexSource, "projection_basis");
  assertStringIncludes(indexSource, "projection_input_error_residual_count");
  assertStringIncludes(indexSource, "prospective: true");
});

Deno.test("seed scope accepts canonical restoration and accounts every skip", () => {
  assertStringIncludes(
    seedScopeMigration,
    "j.type = ''insurance'' AND j.metadata->>''insurance_job_type'' = ''restoration''",
  );
  assertStringIncludes(
    seedScopeMigration,
    "CREATE OR REPLACE FUNCTION public.seed_makesafe_state_authority_scoped_v2",
  );
  assertStringIncludes(seedScopeMigration, "FOR SHARE");
  assertStringIncludes(
    seedScopeMigration,
    "public.stamp_makesafe_fact_identity_v1()",
  );
  assertStringIncludes(
    seedScopeMigration,
    "j.type = ''insurance'' AND j.metadata->>''insurance_job_type'' = ''restoration''",
  );
  assertStringIncludes(
    seedScopeMigration,
    "pg_advisory_xact_lock",
  );
  assert(
    seedScopeMigration.indexOf("pg_advisory_xact_lock") <
      seedScopeMigration.indexOf("SELECT * INTO v_existing"),
  );
  assertStringIncludes(seedScopeMigration, "WHERE found_id IS NULL");
  assertStringIncludes(
    seedScopeMigration,
    "'reason_code', 'not_canonical_makesafe_job'",
  );
  assertStringIncludes(
    seedScopeMigration,
    "seeded_count + skipped_missing_count + skipped_out_of_scope_count",
  );
  assertStringIncludes(
    seedScopeMigration,
    "seed scope did not partition every requested job exactly once",
  );
  assertStringIncludes(
    seedScopeRollback,
    "DROP FUNCTION IF EXISTS public.seed_makesafe_state_authority_scoped_v2",
  );
});

Deno.test("fact identity accepts canonical decimals without widening readiness", () => {
  assertStringIncludes(
    decimalFactMigration,
    "CREATE OR REPLACE FUNCTION public.makesafe_fact_canonical_json_v1",
  );
  assertStringIncludes(
    decimalFactMigration,
    "public.makesafe_fact_canonical_json_v1(p_payload)",
  );
  assertStringIncludes(
    decimalFactMigration,
    "public.validate_makesafe_board_reconciliation_state_tokens(jsonb)",
  );
  assertStringIncludes(
    decimalFactMigration,
    "public.makesafe_canonical_json_v1(v_row.state_facts)",
  );
  assertStringIncludes(
    decimalFactMigration,
    "public.makesafe_reconciliation_state_token_v1(v_row.state_facts)",
  );
  assertStringIncludes(
    decimalFactMigration,
    "v_scaled_decimal_hash IS DISTINCT FROM v_decimal_hash",
  );
  assertStringIncludes(
    decimalFactMigration,
    "sha256:6c330f9e8440d0a13ba3bb465798ffbbefff8061e1dc2db2e38cd3f480e0fac0",
  );
  assertStringIncludes(
    decimalFactMigration,
    "sha256:c49b0fc32037d0f93919bff7aa1aef97225dbb61f78caeee4c5da85498db7a66",
  );
  assertEquals(
    decimalFactMigration.includes(
      "CREATE OR REPLACE FUNCTION public.makesafe_canonical_json_v1",
    ),
    false,
  );
  assertStringIncludes(
    migration,
    "public.makesafe_canonical_json_v1(v_row.state_facts)",
  );
  assertStringIncludes(
    decimalBoundaryContract,
    "public.makesafe_reconciliation_state_token_v1(v_facts)",
  );
  assertStringIncludes(
    decimalBoundaryContract,
    "public.makesafe_canonical_json_v1(v_readiness)",
  );
  assertEquals(
    /UPDATE\s+public\.(jobs|makesafe_job_details)\b/i.test(
      decimalFactMigration,
    ),
    false,
  );
  assertStringIncludes(
    indexSource,
    "'makesafe_reconciliation_state_token_v1'",
  );
  assertEquals(
    indexSource.includes("canonicalJsonAndHash(row.state_facts)"),
    false,
  );
});
