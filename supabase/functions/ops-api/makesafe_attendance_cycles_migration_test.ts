// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260727000001_makesafe_attendance_cycles_u2_s1.sql",
    import.meta.url,
  ),
);
const rollback = await Deno.readTextFile(
  new URL(
    "../../rollbacks/20260727000001_makesafe_attendance_cycles_u2_s1_down.sql",
    import.meta.url,
  ),
);

Deno.test("U2-S1 migration creates immutable attendance_cycle_id table", () => {
  assertStringIncludes(migration, "makesafe_attendance_cycles");
  assertStringIncludes(
    migration,
    "CONSTRAINT makesafe_attendance_cycles_job_cycle_unique UNIQUE (job_id, cycle_number)",
  );
  assertStringIncludes(migration, "generate_series");
  assertStringIncludes(
    migration,
    "service_role_all_makesafe_attendance_cycles",
  );
  assertStringIncludes(migration, "makesafe_attendance_cycles_identity_guard");
  assertStringIncludes(
    migration,
    "prevent_makesafe_attendance_cycle_identity_change",
  );
});

Deno.test("U2-S1 migration adds nullable cycle identity without breaking pack send lock", () => {
  assertStringIncludes(migration, "job_service_reports");
  assertStringIncludes(migration, "job_assignments");
  assertStringIncludes(migration, "makesafe_status_holds");
  assertStringIncludes(migration, "attendance_cycle_id");
  assertStringIncludes(migration, "backfill_cycle_scope");
  assertStringIncludes(migration, "makesafe_report_pack_cycles");
  assertStringIncludes(migration, "UNIQUE (pack_id, attendance_cycle_id)");
  // Must NOT alter the send-lock unique on packs
  assert(
    !/ALTER TABLE public\.makesafe_report_packs[\s\S]*DROP CONSTRAINT[\s\S]*job_id.*pack_kind/
      .test(migration),
  );
});

Deno.test("U2-S1 migration reconciles pack review_state / needs_money_review / portal_ready", () => {
  assertStringIncludes(migration, "review_state");
  assertStringIncludes(migration, "needs_money_review");
  assertStringIncludes(migration, "portal_ready");
  assertStringIncludes(migration, "ADD COLUMN IF NOT EXISTS");
});

Deno.test("U2-S1 migration never guesses multi-cycle assignments onto current cycle", () => {
  assertStringIncludes(migration, "reattend_count");
  assertStringIncludes(
    migration,
    "cycle_attribution = 'backfill_cycle_scope'",
  );
  // Only first-attendance assignments get bound
  assertStringIncludes(migration, "COALESCE(d.reattend_count, 0) = 0");
  assertStringIncludes(migration, "r.cycle_number IS NOT NULL");
  assertStringIncludes(migration, "h.cycle_number IS NOT NULL");
  assert(!migration.includes("c.cycle_number = COALESCE(r.cycle_number, 1)"));
  assert(!migration.includes("c.cycle_number = COALESCE(h.cycle_number, 1)"));
});

Deno.test("U2-S1 rollback documents safe reverse without requiring production drop", () => {
  assertStringIncludes(rollback, "makesafe_report_pack_cycles");
  assertStringIncludes(rollback, "makesafe_attendance_cycles");
  assertStringIncludes(rollback, "previous ops-api");
});
