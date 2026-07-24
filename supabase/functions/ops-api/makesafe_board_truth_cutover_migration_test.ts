// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260724005540_makesafe_board_truth_cutover.sql",
    import.meta.url,
  ),
);
const rollback = await Deno.readTextFile(
  new URL(
    "../../rollbacks/20260724005540_makesafe_board_truth_cutover_down.sql",
    import.meta.url,
  ),
);

Deno.test("board cutover migration is an append-only display ledger with attribution", () => {
  assertStringIncludes(migration, "makesafe_board_status_applications");
  assertStringIncludes(migration, "UNIQUE (run_key, job_id)");
  assertStringIncludes(migration, "before_status");
  assertStringIncludes(migration, "after_status");
  assertStringIncludes(migration, "computed_reasons");
  assertStringIncludes(migration, "computed_missing");
  assertStringIncludes(migration, "evidence_ref");
  assertStringIncludes(migration, "applied_by");
  assertStringIncludes(migration, "applied_at");
  assertStringIncludes(
    migration,
    "trg_makesafe_board_status_applications_insert_guard",
  );
  assertStringIncludes(migration, "terminal make-safe jobs are read-only");
  assertStringIncludes(migration, "BEFORE UPDATE OR DELETE");
  assertStringIncludes(migration, "is append-only");
});

Deno.test("guarded apply excludes terminal cards and is service-role only", () => {
  const functionStart = migration.indexOf(
    "FUNCTION public.apply_makesafe_board_status",
  );
  const privilegeStart = migration.indexOf(
    "REVOKE ALL ON FUNCTION public.apply_makesafe_board_status",
    functionStart,
  );
  const rpc = migration.slice(functionStart, privilegeStart);

  for (
    const terminal of [
      "'archived'",
      "'complete'",
      "'completed'",
      "'closed'",
      "'cancelled'",
      "'canceled'",
      "'lost'",
      "'deleted'",
    ]
  ) {
    assertStringIncludes(rpc, terminal);
  }
  assertStringIncludes(
    rpc,
    "i.source_status IN ('new', 'allocated', 'trade_report_in', 'report_ready')",
  );
  assertStringIncludes(
    rpc,
    "i.before_status IN ('new', 'allocated', 'trade_report_in', 'report_ready')",
  );
  assertStringIncludes(
    rpc,
    "COALESCE(latest.after_status, i.source_status) = i.before_status",
  );
  assertStringIncludes(migration, "SECURITY INVOKER");
  assertStringIncludes(
    migration,
    "GRANT EXECUTE ON FUNCTION public.apply_makesafe_board_status(text, text, text, jsonb)\n  TO service_role",
  );
  assert(
    !rpc.match(/UPDATE\s+public\.(jobs|makesafe_job_details|job_assignments)/i),
  );
  assert(!rpc.match(/\bDELETE\b|\bTRUNCATE\b/i));
});

Deno.test("current display view is security-invoker and rollback removes only cutover surfaces", () => {
  assertStringIncludes(migration, "WITH (security_invoker = true)");
  assertStringIncludes(
    migration,
    "REVOKE ALL ON public.makesafe_board_status_current FROM PUBLIC, anon, authenticated",
  );
  assertStringIncludes(
    rollback,
    "DROP VIEW IF EXISTS public.makesafe_board_status_current",
  );
  assertStringIncludes(
    rollback,
    "DROP FUNCTION IF EXISTS public.guard_makesafe_board_status_application_insert",
  );
  assertStringIncludes(
    rollback,
    "DROP TABLE IF EXISTS public.makesafe_board_status_applications",
  );
  assert(!rollback.match(/UPDATE\s|DELETE\s+FROM|TRUNCATE\s/i));
});
