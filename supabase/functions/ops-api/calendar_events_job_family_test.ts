import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// Source contract for 20260916000000_calendar_events_job_family.sql.
//
// A full supabase/tests/migration-contracts fixture is deliberately not
// registered for this migration. calendar_events already carries live-only
// schema drift ahead of this repo's migrations (label, visible_to_trades,
// recurrence_group_id, is_ghost — see AGENTS.md's calendar_events drift
// note) and no registered case creates job_assignments with those columns
// or a xero_projects table, so replaying this view's exact CREATE against
// the contract harness's cumulative fixture stack would mean inventing
// ~25 unrelated columns purely for this additive, read-only projection
// change. Instead this test proves, from the checked-in SQL text, that the
// migration (a) is additive/idempotent, (b) adds exactly the documented
// job_family projection, (c) never selects the metadata blob wholesale,
// and (d) preserves every live-drift column and filter verbatim rather
// than silently dropping them. The live view shape itself was confirmed
// via a read-only `pg_get_viewdef('calendar_events'::regclass, true)`
// against production (project kevgrhcjxspbxgovpmfl) on 2026-09-16.

const MIGRATION_PATH = new URL(
  "../../migrations/20260916000000_calendar_events_job_family.sql",
  import.meta.url,
);

async function readMigration(): Promise<string> {
  return await Deno.readTextFile(MIGRATION_PATH);
}

Deno.test("calendar_events job_family migration is additive and idempotent", async () => {
  const sql = await readMigration();
  assertStringIncludes(sql, "CREATE OR REPLACE VIEW calendar_events AS");
  // Never DROP + CREATE: that would leak a window where the view does not
  // exist and would require re-granting any dependent privileges.
  assertEquals(/DROP\s+VIEW/i.test(sql), false);
});

Deno.test("calendar_events job_family projects a narrow COALESCE, never the metadata blob", async () => {
  const sql = await readMigration();
  assertStringIncludes(
    sql,
    "COALESCE(j.metadata->>'ses_family', j.metadata->>'makesafe_job_family') AS job_family",
  );
  // Follow the AGENTS.md "Never Select scope_json In A List/Feed Query" rule:
  // no bare `j.metadata` (or `metadata,` / `metadata\n`) selected wholesale.
  const bareMetadataSelect = /(^|[\s,])j\.metadata(\s*,|\s*\n|\s+AS)/im;
  assertEquals(
    bareMetadataSelect.test(sql),
    false,
    "migration must project metadata keys only, never the whole blob",
  );
});

Deno.test("calendar_events job_family preserves every live-drift column and filter", async () => {
  const sql = await readMigration();
  // Columns/behaviour confirmed live via pg_get_viewdef on 2026-09-16 that are
  // NOT declared by any migration in this repo (AGENTS.md calendar_events
  // drift note). A maintainer basing a rewrite off the migration file alone
  // would silently drop these.
  for (const column of [
    "ja.label",
    "ja.visible_to_trades",
    "ja.recurrence_group_id",
  ]) {
    assertStringIncludes(sql, column);
  }
  assertStringIncludes(sql, "COALESCE(j.type, ja.job_type) AS job_type");
  assertStringIncludes(sql, "COALESCE(j.org_id, ja.org_id) AS org_id");
  assertStringIncludes(sql, "LEFT JOIN jobs j ON j.id = ja.job_id");
  assertStringIncludes(sql, "WHERE ja.is_ghost = false");
});
