// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260728500000_makesafe_portal_capture_bridge_u4.sql",
    import.meta.url,
  ),
);
const schemaManifest = await Deno.readTextFile(
  new URL(
    "../../../scripts/edge-function-schema-requirements.txt",
    import.meta.url,
  ),
);

Deno.test("U4 portal capture bridge is append-only, exact-cycle and service-role-only", () => {
  for (
    const required of [
      "capture_result",
      "source_url",
      "source_content_hash",
      "builder_reference",
      "captured_at",
      "captured_by",
      "capture_producer",
      "capture_idempotency_key",
      "screenshot_object_key",
      "screenshot_content_hash",
      "makesafe_portal_capture_bridge_shape",
      "uq_makesafe_portal_capture_idempotency",
      "commit_makesafe_portal_capture_v1",
      "SECURITY INVOKER",
      "v_current_cycle_id IS DISTINCT FROM v_cycle_id",
      "capture_portal_evidence.py/v1",
      "REVOKE ALL ON FUNCTION public.commit_makesafe_portal_capture_v1(jsonb)",
      "FROM PUBLIC, anon, authenticated",
      "TO service_role",
    ]
  ) {
    assertStringIncludes(migration, required);
  }
  assert(
    !migration.match(
      /\b(UPDATE|DELETE|TRUNCATE)\s+public\.(jobs|makesafe_job_details)\b/i,
    ),
    "capture bridge must not mutate card or board state",
  );
});

Deno.test("ops-api deploy gate declares the capture bridge schema", () => {
  for (
    const marker of [
      "column|makesafe_portal_capture_revisions.capture_result",
      "column|makesafe_portal_capture_revisions.source_url",
      "column|makesafe_portal_capture_revisions.captured_by",
      "constraint|makesafe_portal_capture_bridge_shape",
      "index|uq_makesafe_portal_capture_idempotency",
    ]
  ) {
    assertStringIncludes(
      schemaManifest,
      `ops-api|supabase/migrations/20260728500000_makesafe_portal_capture_bridge_u4.sql|${marker}`,
    );
  }
});
