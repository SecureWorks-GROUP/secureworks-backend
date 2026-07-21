// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260720000002_makesafe_deterministic_intake_cutover.sql",
    import.meta.url,
  ),
);
const controlsMigration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260721000001_makesafe_intake_production_controls.sql",
    import.meta.url,
  ),
);
const fullOpenMigration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260721000002_makesafe_intake_full_open.sql",
    import.meta.url,
  ),
);
const rollback = await Deno.readTextFile(
  new URL(
    "../../rollbacks/20260720000002_makesafe_deterministic_intake_mode_rollback.sql",
    import.meta.url,
  ),
);
const runtime = await Deno.readTextFile(
  new URL("./makesafe_deterministic_intake_runtime.ts", import.meta.url),
);
const core = await Deno.readTextFile(
  new URL("./makesafe_deterministic_intake.ts", import.meta.url),
);
const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const terminalHook = await Deno.readTextFile(
  new URL("../../../docs/makesafe-intake-terminal-hook.md", import.meta.url),
);

Deno.test("cutover migration defaults to legacy and exposes one deterministic switch", () => {
  assertStringIncludes(
    migration,
    "intake_mode text NOT NULL DEFAULT 'legacy'",
  );
  assertStringIncludes(
    migration,
    "CHECK (intake_mode IN ('legacy', 'deterministic'))",
  );
  assertStringIncludes(migration, "makesafe_deterministic_intake_preflight");
  assertStringIncludes(
    rollback,
    "SET intake_mode = 'legacy'",
  );
  assert(!rollback.match(/DROP\s|DELETE\s|TRUNCATE\s/i));
});

Deno.test("case persistence carries story, manifest evidence, recovery and side-effect identity", () => {
  for (
    const column of [
      "story_json",
      "evidence_map",
      "recovery_cursor",
      "source_fingerprint",
      "adapter_version",
      "manifest_version",
      "deterministic_key",
    ]
  ) assertStringIncludes(migration, column);
  assertStringIncludes(migration, "makesafe_intake_artifacts");
  for (
    const kind of [
      "'pdf'",
      "'screenshot'",
      "'draft'",
      "'job'",
      "'invoice'",
      "'outbound_message'",
      "'approval'",
    ]
  ) assertStringIncludes(migration, kind);
});

Deno.test("deterministic runtime projections are narrow, paged and attachment reads are batched", () => {
  assertStringIncludes(runtime, ".range(from, to)");
  assertStringIncludes(runtime, "for (const ids of chunk(postIds))");
  assert(!runtime.includes('.select("*")'));
  assert(!runtime.includes("select('*')"));
  assert(!runtime.includes("scope_json"));
  assert(!runtime.includes("pricing_json"));
  assertStringIncludes(
    runtime,
    '.select("id,email_id,name,content_type,storage_path,status,size_bytes")',
  );
});

Deno.test("deterministic normal path has no model import or silent fallback", () => {
  const forbidden = [
    "Anthropic",
    "@anthropic-ai",
    "claude-",
    "messages.create",
  ];
  for (const token of forbidden) {
    assert(!core.includes(token), `core must not contain ${token}`);
    assert(!runtime.includes(token), `runtime must not contain ${token}`);
  }
  assertStringIncludes(index, "if (rollout.mode === 'deterministic')");
  assertStringIncludes(index, "approveDraft: approveIntakeDraft");
  assertStringIncludes(index, "suppress_manager_notification");
  assertStringIncludes(index, "approvedWorkOrderIdentity");
  assertStringIncludes(index, "existingWorkOrderIdentity");
  assertStringIncludes(runtime, "ai_calls: 0");
});

Deno.test("dry-run replay and exact dark observe take no write branch", () => {
  assertStringIncludes(runtime, "if (dryRun) return report;");
  assertStringIncludes(runtime, "by_builder_and_outcome");
  assertStringIncludes(runtime, "includeSanitizedCases");
  assertStringIncludes(
    index,
    "case 'makesafe_deterministic_intake_dark_observe'",
  );
  assert(!runtime.match(/console\.(?:log|error|warn)\s*\(/));
});

Deno.test("production controls default to N=1, exact empty allowlists and bounded later caps", () => {
  assertStringIncludes(
    controlsMigration,
    "deterministic_max_cases_per_run smallint NOT NULL DEFAULT 1",
  );
  assertStringIncludes(controlsMigration, "BETWEEN 1 AND 10");
  assertStringIncludes(controlsMigration, "deterministic_source_allowlist");
  assertStringIncludes(
    controlsMigration,
    "deterministic_instruction_allowlist",
  );
  assertStringIncludes(runtime, "loadDeterministicRolloutControls");
  assertStringIncludes(runtime, "requires a non-empty exact DB allowlist");
  assertStringIncludes(index, "requireAllAllowlistMatches: true");
});

Deno.test("full-open is explicit, bounded and distinct from exact-empty fail-closed", () => {
  assertStringIncludes(
    fullOpenMigration,
    "deterministic_selection_mode text NOT NULL DEFAULT 'exact'",
  );
  assertStringIncludes(
    fullOpenMigration,
    "deterministic_selection_mode IN ('exact', 'full_open')",
  );
  assertStringIncludes(
    fullOpenMigration,
    "makesafe_cron_settings_full_open_empty_allowlists_check",
  );
  assertStringIncludes(runtime, 'selectionMode === "full_open"');
  assertStringIncludes(
    runtime,
    "deterministic exact mode requires a non-empty exact DB allowlist",
  );
  assertStringIncludes(
    runtime,
    "deterministic full_open mode requires empty exact allowlists",
  );
  assertStringIncludes(index, "selectionMode: rollout.selectionMode");
});

Deno.test("attachment staging uses a content hash and append-only artifact ledger", () => {
  assertStringIncludes(runtime, "contentSha256");
  assertStringIncludes(runtime, '"makesafe_intake_artifacts"');
  assertStringIncludes(runtime, 'artifact_kind: "pdf"');
  assertStringIncludes(runtime, 'status: "completed"');
});

Deno.test("deterministic runtime has no assignment, work-order, invoice or communication writer", () => {
  for (
    const forbidden of [
      'from("job_assignments")',
      'from("work_orders")',
      'from("xero_invoices")',
      'from("outbound_messages")',
      "send_sms",
      "notifyVerticalManagersSms",
    ]
  ) {
    assert(
      !runtime.includes(forbidden),
      `runtime contains forbidden writer ${forbidden}`,
    );
  }
});

Deno.test("ruling 5 terminal skill hook stays deterministic and non-privileged", () => {
  const routineAllowlist = index.slice(
    index.indexOf("const ROUTINE_ALLOWED_ACTIONS"),
    index.indexOf("if (authMode === 'routine'"),
  );
  assertStringIncludes(
    routineAllowlist,
    "'makesafe_deterministic_intake_dark_observe'",
  );
  assertStringIncludes(terminalHook, "Automatic code");
  assertStringIncludes(terminalHook, "Terminal make-safe skill");
  assertStringIncludes(terminalHook, "Manual operator");
  assertStringIncludes(terminalHook, "paid AI extraction API stays off");
  assertStringIncludes(terminalHook, "may not call\n`approve_intake_draft`");
});

Deno.test("health exposes effective mode and fresh authenticated alarm proof", () => {
  assertStringIncludes(controlsMigration, "alarm_auth_verified_at");
  assertStringIncludes(index, "intake_mode: intakeMode");
  assertStringIncludes(
    index,
    "latestAuthenticatedAt: health?.alarm_auth_action === 'makesafe_email_canary'",
  );
  assertStringIncludes(
    index,
    "intakeMode !== 'unknown' && alarmReadiness.ready",
  );
  assertStringIncludes(index, "recordMakesafeAlarmAuthentication");
});
