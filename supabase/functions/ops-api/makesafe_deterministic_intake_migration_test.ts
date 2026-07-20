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
  assertStringIncludes(index, "if (intakeMode === 'deterministic')");
  assertStringIncludes(index, "approveDraft: approveIntakeDraft");
  assertStringIncludes(index, "suppress_manager_notification");
  assertStringIncludes(index, "approvedWorkOrderIdentity");
  assertStringIncludes(index, "existingWorkOrderIdentity");
  assertStringIncludes(runtime, "ai_calls: 0");
});

Deno.test("dry-run replay returns aggregate-only output and takes no write branch", () => {
  assertStringIncludes(runtime, "if (dryRun) return report;");
  assertStringIncludes(runtime, "by_builder_and_outcome");
  assert(!runtime.match(/console\.(?:log|error|warn)\s*\(/));
});
