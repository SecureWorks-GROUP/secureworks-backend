// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260803070000_makesafe_roof_initial_cycle_binding.sql",
    import.meta.url,
  ),
);
const rollback = await Deno.readTextFile(
  new URL(
    "../../rollbacks/20260803070000_makesafe_roof_initial_cycle_binding_down.sql",
    import.meta.url,
  ),
);
const manifest = await Deno.readTextFile(
  new URL(
    "../../../scripts/edge-function-schema-requirements.txt",
    import.meta.url,
  ),
);
const indexSource = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);

Deno.test("roof initial cycle migration binds the immutable cycle and detail pointer transactionally", () => {
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.bind_makesafe_roof_initial_cycle_v1",
  );
  assertStringIncludes(migration, "FOR UPDATE");
  assertStringIncludes(
    migration,
    "INSERT INTO public.makesafe_attendance_cycles",
  );
  assertStringIncludes(
    migration,
    "UPDATE public.makesafe_job_details detail",
  );
  assertStringIncludes(
    migration,
    "v_updated_count <> 1",
  );
  assert(
    !migration.match(/DELETE\s+FROM\s+public\.makesafe_attendance_cycles/i),
  );
});

Deno.test("roof initial cycle migration keeps recovery exact, zero-evidence guarded, and service-role-only", () => {
  for (
    const required of [
      "p_expected_case_id",
      "p_expected_cycle_count",
      "p_expected_existing_cycle_id",
      "canonical intake authority drifted",
      "operational evidence drifted",
      "public.makesafe_roof_report_drafts",
      "public.makesafe_docket_revisions",
      "type = 'roof_report'",
      "FROM PUBLIC, anon, authenticated",
      "TO service_role",
    ]
  ) {
    assertStringIncludes(migration, required);
  }
  assert(!migration.match(/INSERT\s+INTO\s+public\.job_assignments/i));
  assert(!migration.match(/\b(send|notify|invoice)\b/i));
});

Deno.test("ops-api calls the schema-gated atomic function and rollback removes only that function", () => {
  assertStringIncludes(
    indexSource,
    "client.rpc('bind_makesafe_roof_initial_cycle_v1'",
  );
  assertStringIncludes(
    manifest,
    "20260803070000_makesafe_roof_initial_cycle_binding.sql|function|bind_makesafe_roof_initial_cycle_v1",
  );
  assertStringIncludes(
    rollback,
    "DROP FUNCTION IF EXISTS public.bind_makesafe_roof_initial_cycle_v1",
  );
  assert(!rollback.match(/\b(DELETE|TRUNCATE)\b/i));
});
