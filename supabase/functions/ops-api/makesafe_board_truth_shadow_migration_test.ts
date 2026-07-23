// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260723000001_makesafe_board_truth_shadow.sql",
    import.meta.url,
  ),
);
const rollback = await Deno.readTextFile(
  new URL(
    "../../rollbacks/20260723000001_makesafe_board_truth_shadow_down.sql",
    import.meta.url,
  ),
);

Deno.test("board-truth migration is additive shadow schema with no declared-field rewrite", () => {
  for (
    const column of [
      "computed_status",
      "computed_status_reasons",
      "computed_status_missing",
      "computed_status_at",
    ]
  ) assertStringIncludes(migration, column);
  assertStringIncludes(migration, "makesafe_status_disagreements");
  assertStringIncludes(migration, "refresh_makesafe_status_shadow");
  assert(
    !migration.match(
      /UPDATE\s+public\.makesafe_job_details\s+SET\s+substatus/i,
    ),
  );
  assert(
    !migration.match(/DELETE\s+FROM|TRUNCATE\s|DROP\s+TABLE\s+public\.jobs/i),
  );
});

Deno.test("hold vocabulary is reporting-skill codes plus captain-approved board superset", () => {
  for (
    const code of [
      "login-failure",
      "network-failure",
      "missing-email",
      "missing-attachment",
      "wrong-job",
      "wrong-reference",
      "conflicting-identity",
      "changed-portal-content",
      "expired-link",
      "inaccessible-link",
      "capture-failure",
      "recovery-not-run",
      "ambiguous-evidence",
      "awaiting_client_callback",
      "access_blocked",
      "duplicate_suspected",
      "manual_review",
    ]
  ) assertStringIncludes(migration, `'${code}'`);
  for (
    const attribution of [
      "held_by",
      "created_at",
      "lifted_at",
      "lifted_by",
      "note",
    ]
  ) {
    assertStringIncludes(migration, attribution);
  }
  assertStringIncludes(migration, "WHERE lifted_at IS NULL");
});

Deno.test("shadow refresh RPC can update only computed columns on existing details", () => {
  const rpcStart = migration.indexOf(
    "FUNCTION public.refresh_makesafe_status_shadow",
  );
  const viewStart = migration.indexOf("CREATE OR REPLACE VIEW", rpcStart);
  const rpc = migration.slice(rpcStart, viewStart);
  assertStringIncludes(rpc, "UPDATE public.makesafe_job_details d");
  for (
    const column of [
      "computed_status =",
      "computed_status_reasons =",
      "computed_status_missing =",
      "computed_status_at =",
    ]
  ) assertStringIncludes(rpc, column);
  assert(!rpc.includes("substatus ="));
  assert(!rpc.match(/\bINSERT\b/i));
});

Deno.test("cheap cron refreshes shadow and invokes the alarm-only canary behind the existing gate", () => {
  assertStringIncludes(migration, "trigger_makesafe_status_shadow_refresh");
  assertStringIncludes(migration, "trigger_makesafe_status_canary");
  assertStringIncludes(migration, "IF NOT public.makesafe_cron_enabled()");
  assertStringIncludes(migration, "action=makesafe_status_shadow_refresh");
  assertStringIncludes(migration, "action=makesafe_status_canary");
  assertStringIncludes(migration, "'makesafe-status-shadow-refresh'");
  assertStringIncludes(migration, "'makesafe-status-canary'");
});

Deno.test("rollback reverses only M1 additive surfaces", () => {
  assertStringIncludes(
    rollback,
    "cron.unschedule('makesafe-status-shadow-refresh')",
  );
  assertStringIncludes(rollback, "cron.unschedule('makesafe-status-canary')");
  assertStringIncludes(
    rollback,
    "DROP VIEW IF EXISTS public.makesafe_status_disagreements",
  );
  assertStringIncludes(
    rollback,
    "DROP TABLE IF EXISTS public.makesafe_status_holds",
  );
  assertStringIncludes(rollback, "DROP COLUMN IF EXISTS computed_status");
  assert(!rollback.match(/UPDATE\s|DELETE\s+FROM|TRUNCATE\s/i));
});
