// deno-lint-ignore-file no-import-prefix

import {
  assert,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migrationUrl = new URL(
  "../../migrations/20260720000001_makesafe_intake_cases.sql",
  import.meta.url,
);
const rollbackUrl = new URL(
  "../../rollbacks/20260720000001_makesafe_intake_cases_down.sql",
  import.meta.url,
);
const migration = await Deno.readTextFile(migrationUrl);
const rollback = await Deno.readTextFile(rollbackUrl);

Deno.test("migration keeps raw and canonical identity in separate columns", () => {
  for (
    const column of [
      "raw_builder_name",
      "canonical_builder_slug",
      "raw_external_ref",
      "canonical_external_ref",
      "raw_po_number",
      "canonical_po_number",
      "raw_deliverable_ref",
      "canonical_deliverable_ref",
    ]
  ) {
    assert(migration.includes(column), `missing identity column ${column}`);
  }
  assert(
    migration.includes("raw identity values cannot be replaced or cleared"),
  );
  assert(migration.includes("identity provenance is append-only"));
  assert(migration.includes("makesafe_intake_identity_provenance_valid"));
});

Deno.test("migration encodes source replay uniqueness without PO uniqueness", () => {
  assertMatch(
    migration,
    /UNIQUE \(org_id, source_system, source_mailbox, source_instruction_key\)/,
  );
  assert(!/UNIQUE\s*\([^)]*canonical_po_number/.test(migration));
  assert(migration.includes("idx_makesafe_intake_cases_canonical_identity"));
});

Deno.test("migration encodes all states, reasons and provenance", () => {
  assert(migration.includes("accounted_non_wo_reason IS NOT NULL"));
  assert(migration.includes("state transitions require a new decision reason"));
  for (
    const value of [
      "confirmed_live_job",
      "blocked_live_job",
      "exception",
      "accounted_non_wo",
      "cancellation",
      "duplicate",
      "revision",
      "unknown_builder",
      "non_makesafe",
      "ambiguous_scope",
      "below_identity_floor",
      "adapter_parse_failure",
      "conflicting_fields",
      "deterministic",
      "ai",
      "human",
    ]
  ) {
    assert(migration.includes(`'${value}'`), `missing contract value ${value}`);
  }
});

Deno.test("migration has tenant-scoped FKs and same-org job/draft checks", () => {
  assert(migration.includes("FOREIGN KEY (org_id, case_id)"));
  assert(migration.includes("j.org_id = NEW.org_id"));
  assert(migration.includes("d.org_id = NEW.org_id"));
  assert(
    migration.includes(
      "result_job_id must reference a make-safe job in the same org",
    ),
  );
});

Deno.test("migration prevents lineage ambiguity, self-links and practical cycles", () => {
  for (
    const proof of [
      "makesafe_intake_case_lineage_no_self_check",
      "uq_makesafe_intake_case_lineage_duplicate_parent",
      "makesafe_intake_case_lineage_sibling_order_check",
      "pg_advisory_xact_lock",
      "lineage edge would create a cycle",
    ]
  ) {
    assert(migration.includes(proof), `missing lineage proof ${proof}`);
  }
});

Deno.test("transition, source, attachment and lineage evidence is append-only", () => {
  for (
    const trigger of [
      "trg_makesafe_intake_case_transitions_append_only",
      "trg_makesafe_intake_case_sources_append_only",
      "trg_makesafe_intake_case_attachments_append_only",
      "trg_makesafe_intake_case_lineage_append_only",
    ]
  ) {
    assert(
      migration.includes(trigger),
      `missing append-only trigger ${trigger}`,
    );
  }
  assert(migration.includes("is append-only; % is not allowed"));
});

Deno.test("new tables are RLS protected and service-role owned", () => {
  assert(migration.includes("ENABLE ROW LEVEL SECURITY"));
  assert(
    migration.includes("REVOKE ALL ON public.%I FROM anon, authenticated"),
  );
  assert(migration.includes("FOR ALL TO service_role"));
});

Deno.test("rollback is explicit and leaves existing runtime tables untouched", () => {
  for (
    const table of [
      "makesafe_intake_case_lineage",
      "makesafe_intake_case_attachments",
      "makesafe_intake_case_sources",
      "makesafe_intake_case_transitions",
      "makesafe_intake_cases",
    ]
  ) {
    assert(rollback.includes(`DROP TABLE IF EXISTS public.${table}`));
  }
  assert(!rollback.includes("DROP TABLE IF EXISTS public.jobs"));
  assert(
    !rollback.includes("DROP TABLE IF EXISTS public.makesafe_intake_drafts"),
  );
  assert(!rollback.includes("DROP TABLE IF EXISTS public.emails"));
  assert(
    rollback.includes(
      "DROP FUNCTION IF EXISTS public.makesafe_intake_identity_provenance_valid(jsonb)",
    ),
  );
});
