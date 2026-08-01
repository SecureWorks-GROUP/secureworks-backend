// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260801000001_ses_adjudicated_job_recovery.sql",
    import.meta.url,
  ),
);

Deno.test("SES historical recovery migration keeps lineage append-only and service-role-only", () => {
  assertStringIncludes(
    migration,
    "CREATE OR REPLACE FUNCTION public.bind_adjudicated_ses_existing_job",
  );
  assertStringIncludes(migration, "SECURITY DEFINER");
  assertStringIncludes(
    migration,
    "source list must equal the complete persisted case lineage",
  );
  assertStringIncludes(migration, "correction_kind,");
  assertStringIncludes(migration, "'existing_job_binding'");
  assertStringIncludes(
    migration,
    "FROM PUBLIC, anon, authenticated",
  );
  assertStringIncludes(migration, "TO service_role");
  assert(!migration.match(/UPDATE\s+public\.makesafe_intake_cases/i));
  assert(!migration.match(/UPDATE\s+public\.jobs/i));
  assert(!migration.match(/INSERT\s+INTO\s+public\.jobs/i));
});

Deno.test("SES historical recovery migration pins captain provenance and idempotency", () => {
  assertStringIncludes(migration, "uq_jobs_historical_backfill_key");
  assertStringIncludes(migration, "2026-08-01");
  assertStringIncludes(
    migration,
    "data/ses-shadow-adjudicate-v1/report.md#6.1",
  );
  assertStringIncludes(migration, "already_bound");
  assertStringIncludes(
    migration,
    "partial source authority correction set refused",
  );
  assertStringIncludes(migration, "7d1c12cf-bc52-4a7a-8b38-74fc27057fc6");
  assertStringIncludes(migration, "ref:BWCWA-6648");
  assertStringIncludes(
    migration,
    "ses-historical:BWCWA-6648:INV-0754",
  );
  assertStringIncludes(
    migration,
    "mailbox_5a3ee1f82619e6ae5c11614751ef5301abd20ec91842e687e1a6cb72d1906061",
  );
});
