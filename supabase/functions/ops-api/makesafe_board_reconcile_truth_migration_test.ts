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
  assertStringIncludes(compareSource, 'jobDetail.cycle_attribution !== "bound"');
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

Deno.test("edge acceptance is the live U4 canary plus zero v2 input errors", () => {
  assertStringIncludes(indexSource, "case 'makesafe_state_seed'");
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
