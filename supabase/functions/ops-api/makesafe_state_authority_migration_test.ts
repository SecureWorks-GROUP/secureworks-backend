// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260728000001_makesafe_state_authority_u2.sql",
    import.meta.url,
  ),
);
const rollback = await Deno.readTextFile(
  new URL(
    "../../rollbacks/20260728000001_makesafe_state_authority_u2_down.sql",
    import.meta.url,
  ),
);
const safeUpdateMigration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260729020000_makesafe_family_pointer_safeupdate_guard.sql",
    import.meta.url,
  ),
);

Deno.test("U2 Phase 1 migration is additive and leaves v1 as authority", () => {
  assertStringIncludes(migration, "default_contract_version");
  assertStringIncludes(
    migration,
    "VALUES (true, 'v1', true, false, '20260728000001')",
  );
  assertStringIncludes(
    migration,
    "authority_flipped boolean NOT NULL DEFAULT false",
  );
  assertStringIncludes(migration, "NOT VALID;");
  assert(
    !migration.match(/ALTER TABLE public\.makesafe_job_details/i),
    "Phase 1 must not enforce the six-value CHECK before legacy rows are converted",
  );
  assertStringIncludes(
    migration,
    "Phase 2 must convert the manifested rows first",
  );
  assert(
    !migration.match(
      /UPDATE\s+public\.(jobs|makesafe_job_details)\s+SET\s+(status|substatus)/i,
    ),
  );
  assert(!migration.match(/\bTRUNCATE\b/i));
});

Deno.test("U2 schema carries immutable revisions, typed decisions, and exact invalidation", () => {
  for (
    const relation of [
      "makesafe_readiness_revisions",
      "makesafe_readiness_current",
      "makesafe_readiness_invalidations",
      "makesafe_revision_approvals",
      "makesafe_cancellation_decisions",
      "makesafe_terminal_proofs",
      "makesafe_family_rule_revisions",
      "makesafe_portal_capture_revisions",
    ]
  ) {
    assertStringIncludes(migration, relation);
  }
  assertStringIncludes(migration, "UNIQUE (job_id, readiness_revision)");
  assertStringIncludes(migration, "generation_after = generation_before + 1");
  assertStringIncludes(migration, "reject_makesafe_state_audit_mutation");
  assertStringIncludes(migration, "BEFORE UPDATE OR DELETE");
  assertStringIncludes(migration, "invalidate_makesafe_readiness");
  assertStringIncludes(migration, "FOR UPDATE");
  assertStringIncludes(migration, "readiness_revision = NULL");
  assertStringIncludes(migration, "ready = false");
  assertStringIncludes(migration, "readiness generation conflict");
  assertStringIncludes(migration, "makesafe_attendance_cycle_set_hash_v1");
  assertStringIncludes(
    migration,
    "sha256:ea837da72d6a80810ebd5116945ea2a47736eaa5354164a12e58585ddda25690",
  );
  assertStringIncludes(
    migration,
    "attendance cycle set hash does not match canonical envelope",
  );
  assertStringIncludes(migration, "SECURITY DEFINER");
  assertStringIncludes(
    migration,
    "REVOKE ALL ON FUNCTION public.invalidate_makesafe_readiness",
  );
});

Deno.test("SQL readiness hash and current views are independently guarded", () => {
  assertStringIncludes(migration, "makesafe_canonical_json_v1");
  assertStringIncludes(migration, "makesafe_readiness_revision_v1");
  assertStringIncludes(
    migration,
    "sha256:feaf1d310fb67221d1844d130e72ac4d2fa91f0b305d72ad548e70f37f3d76c9",
  );
  assertStringIncludes(migration, "SQL golden vector mismatch");
  assertStringIncludes(migration, "WITH (security_invoker = true)");
  assertStringIncludes(
    migration,
    "REVOKE ALL ON public.makesafe_readiness_current_v2",
  );
  assertStringIncludes(
    migration,
    "GRANT EXECUTE ON FUNCTION public.commit_makesafe_readiness",
  );
  assertStringIncludes(
    migration,
    "GRANT EXECUTE ON FUNCTION public.makesafe_readiness_revision_v1",
  );
  assertStringIncludes(migration, "SECURITY INVOKER");
});

Deno.test("cancellation and terminal proof views use the authoritative cycle set", () => {
  const cancellationView = migration.slice(
    migration.indexOf(
      "CREATE OR REPLACE VIEW public.makesafe_cancellation_current_v2",
    ),
    migration.indexOf(
      "CREATE OR REPLACE VIEW public.makesafe_terminal_proofs_current_v2",
    ),
  );
  const terminalView = migration.slice(
    migration.indexOf(
      "CREATE OR REPLACE VIEW public.makesafe_terminal_proofs_current_v2",
    ),
    migration.indexOf(
      "CREATE OR REPLACE VIEW public.makesafe_family_rules_current_v2",
    ),
  );
  assertStringIncludes(cancellationView, "makesafe_attendance_cycles");
  assertStringIncludes(terminalView, "makesafe_attendance_cycles");
  assert(!cancellationView.includes("JOIN public.makesafe_readiness_current"));
  assert(!terminalView.includes("JOIN public.makesafe_readiness_current"));
  assertStringIncludes(terminalView, "makesafe_readiness_revisions");
  assertStringIncludes(
    terminalView,
    "r.attendance_cycle_set_hash = p.attendance_cycle_set_hash",
  );
});

Deno.test("non-production rollback removes Phase-1 surfaces in dependency order", () => {
  assertStringIncludes(
    rollback,
    "DROP VIEW IF EXISTS public.makesafe_readiness_current_v2",
  );
  assertStringIncludes(
    rollback,
    "DROP FUNCTION IF EXISTS public.commit_makesafe_readiness",
  );
  assertStringIncludes(
    rollback,
    "DROP TABLE IF EXISTS public.makesafe_readiness_current",
  );
  assert(!rollback.match(/UPDATE\s|DELETE\s+FROM|TRUNCATE\s/i));
});

Deno.test("family pointer invalidation keeps its whole-board scope explicit", () => {
  assertStringIncludes(
    safeUpdateMigration,
    "CREATE OR REPLACE FUNCTION public.invalidate_makesafe_family_pointer()",
  );
  assertStringIncludes(
    safeUpdateMigration,
    "UPDATE public.makesafe_readiness_current",
  );
  assertStringIncludes(safeUpdateMigration, "PERFORM 1");
  assertStringIncludes(safeUpdateMigration, "WHERE job_id IS NOT NULL;");
  assertStringIncludes(migration, "job_id uuid PRIMARY KEY");
  assert(
    !safeUpdateMigration.match(
      /UPDATE\s+public\.makesafe_readiness_current[\s\S]*?updated_at\s*=\s*transaction_timestamp\(\)\s*;/i,
    ),
    "The production safeupdate guard must never see an unbounded readiness update",
  );
});
