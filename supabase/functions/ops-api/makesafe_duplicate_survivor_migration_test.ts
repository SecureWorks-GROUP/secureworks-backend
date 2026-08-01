// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260801045000_makesafe_duplicate_survivor_archive.sql",
    import.meta.url,
  ),
);
const rollback = await Deno.readTextFile(
  new URL(
    "../../rollbacks/20260801045000_makesafe_duplicate_survivor_archive_down.sql",
    import.meta.url,
  ),
);

Deno.test("duplicate archive reuses the existing ledger with additive nullable columns", () => {
  // A second board-status engine is forbidden; this must extend the one ledger.
  assert(!migration.includes("CREATE TABLE"));
  assertStringIncludes(
    migration,
    "ALTER TABLE public.makesafe_board_status_applications",
  );
  assertStringIncludes(
    migration,
    "ADD COLUMN IF NOT EXISTS duplicate_of_job_id uuid",
  );
  assertStringIncludes(
    migration,
    "ADD COLUMN IF NOT EXISTS duplicate_of_job_number text",
  );
  assertStringIncludes(
    migration,
    "ADD COLUMN IF NOT EXISTS duplicate_rule text",
  );
  assertStringIncludes(
    migration,
    "ADD COLUMN IF NOT EXISTS duplicate_evidence jsonb",
  );
});

Deno.test("a pointer row must archive, must be complete, and must not self-point", () => {
  const constraint = migration.slice(
    migration.indexOf(
      "makesafe_board_status_applications_duplicate_pointer_check",
    ),
  );
  assertStringIncludes(constraint, "duplicate_of_job_id <> job_id");
  assertStringIncludes(constraint, "after_status = 'archive'");
  assertStringIncludes(
    constraint,
    "duplicate_rule IN ('builder_po', 'activity_evidence')",
  );
  // All-or-nothing so a half-written pointer cannot exist.
  assertStringIncludes(constraint, "duplicate_of_job_id IS NULL");
  assertStringIncludes(constraint, "duplicate_of_job_id IS NOT NULL");
});

Deno.test("guarded duplicate apply refuses terminal, stale, chained and dead-survivor rows", () => {
  const fn = migration.slice(
    migration.indexOf(
      "FUNCTION public.apply_makesafe_duplicate_survivor_archive",
    ),
  );
  // Both sides must be live make-safe cards.
  assertStringIncludes(fn, "JOIN public.jobs loser");
  assertStringIncludes(fn, "JOIN public.jobs survivor");
  assertStringIncludes(fn, "lower(COALESCE(loser.status, '')) NOT IN");
  assertStringIncludes(fn, "lower(COALESCE(survivor.status, '')) NOT IN");
  // Stale-plan guard, identical in spirit to the base cutover RPC.
  assertStringIncludes(
    fn,
    "COALESCE(latest.after_status, i.source_status) = i.before_status",
  );
  // No pointer chains: a survivor may not itself be an archived duplicate.
  assertStringIncludes(fn, "NOT EXISTS");
  assertStringIncludes(fn, "s.duplicate_of_job_id IS NOT NULL");
  // Reviewed list, never a bulk sweep.
  assertStringIncludes(fn, "between 1 and 50 duplicate archives");
  assertStringIncludes(fn, "i.after_status = 'archive'");
});

Deno.test("duplicate apply is service-role only and writes no operational row", () => {
  assertStringIncludes(
    migration,
    "REVOKE ALL ON FUNCTION public.apply_makesafe_duplicate_survivor_archive(text, text, text, jsonb)\n  FROM PUBLIC, anon, authenticated",
  );
  assertStringIncludes(
    migration,
    "GRANT EXECUTE ON FUNCTION public.apply_makesafe_duplicate_survivor_archive(text, text, text, jsonb)\n  TO service_role",
  );
  // The only INSERT target is the display ledger.
  const inserts = migration.match(/INSERT INTO public\.(\w+)/g) || [];
  assert(inserts.length > 0);
  for (const statement of inserts) {
    assert(
      statement.endsWith("makesafe_board_status_applications"),
      `unexpected insert target: ${statement}`,
    );
  }
  for (
    const forbidden of [
      "UPDATE public.jobs",
      "UPDATE public.makesafe_job_details",
      "UPDATE public.job_assignments",
      "DELETE FROM public.jobs",
      "INSERT INTO public.communications",
    ]
  ) {
    assert(!migration.includes(forbidden), `${forbidden} must not appear`);
  }
});

Deno.test("rollback removes the pointer surface but preserves the base ledger", () => {
  assertStringIncludes(
    rollback,
    "DROP FUNCTION IF EXISTS public.apply_makesafe_duplicate_survivor_archive",
  );
  assertStringIncludes(rollback, "DROP COLUMN IF EXISTS duplicate_of_job_id");
  // The base cutover ledger and its RPC predate this migration and must survive.
  assert(
    !rollback.includes(
      "DROP TABLE IF EXISTS public.makesafe_board_status_applications",
    ),
  );
  assert(
    !rollback.includes(
      "DROP FUNCTION IF EXISTS public.apply_makesafe_board_status",
    ),
  );
  // The view must be restored to its pre-migration column list.
  assertStringIncludes(
    rollback,
    "CREATE VIEW public.makesafe_board_status_current",
  );
});
