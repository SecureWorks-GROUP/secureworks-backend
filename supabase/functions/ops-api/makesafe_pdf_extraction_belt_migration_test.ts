// deno-lint-ignore-file no-import-prefix

import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260731000001_makesafe_pdf_extraction_belt.sql",
    import.meta.url,
  ),
);
const closureMigration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260731000002_makesafe_intake_settlement_closure.sql",
    import.meta.url,
  ),
);
const drainAuthMigration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260731081410_fix_makesafe_pdf_drain_auth_and_response_check.sql",
    import.meta.url,
  ),
);

Deno.test("PDF belt migration creates a durable bounded queue and retention-safe extraction columns", () => {
  for (
    const column of [
      "pdf_extraction_status",
      "pdf_extraction_text",
      "pdf_extraction_char_count",
      "pdf_extraction_page_count",
      "pdf_extraction_extractor",
      "pdf_extraction_truncated",
      "pdf_extraction_reason",
      "pdf_extraction_attempts",
      "pdf_extraction_claim_token",
      "pdf_extraction_started_at",
      "pdf_extraction_completed_at",
      "pdf_extraction_next_attempt_at",
      "pdf_handoff_status",
      "pdf_handoff_reason",
      "pdf_handoff_attempts",
      "pdf_handoff_next_attempt_at",
    ]
  ) assertStringIncludes(migration, column);
  assertStringIncludes(migration, "FOR UPDATE OF a SKIP LOCKED");
  assertStringIncludes(migration, "trg_enqueue_makesafe_pdf_extraction");
  assertStringIncludes(migration, "NEW.status = 'uploaded'");
  assertStringIncludes(migration, "interval '2 minutes'");
  assertStringIncludes(migration, "gen_random_uuid()");
  assertStringIncludes(migration, "NULLIF(a.sha256, '') = selected_sha");
  assertStringIncludes(migration, "WITH reusable AS");
  assertStringIncludes(
    migration,
    "source.pdf_extraction_status IN ('extracted', 'quarantined')",
  );
  assertStringIncludes(
    migration,
    "pdf_extraction_text = reusable.pdf_extraction_text",
  );
  assertStringIncludes(
    migration,
    "NOT LIKE 'retry_exhausted:download_failed:%'",
  );
  assertStringIncludes(migration, "a.pdf_extraction_attempts < 3");
  assertStringIncludes(
    migration,
    "AND a.pdf_extraction_attempts = 0 THEN 0",
  );
  assertStringIncludes(
    migration,
    "makesafe_pdf_extraction_backlog_estimate",
  );
  assertStringIncludes(migration, "pdf_extraction_text = NULL");
  assertStringIncludes(migration, "makesafe-pdf-extraction-drain");
  assertStringIncludes(migration, "* * * * *");
});

Deno.test("PDF belt migration keeps the standing scanner bounded rather than raising its cap", () => {
  assert(!migration.includes("MAX_PDF_EXTRACTIONS_PER_RUN"));
  assert(!migration.includes("received_at >= now() - interval '5 minutes'"));
  assertStringIncludes(migration, "one document per invocation");
  assertStringIncludes(migration, "one document per minute");
});

Deno.test("PDF drain cron uses the ops-api key contract and fails loudly on asynchronous HTTP errors", () => {
  assertStringIncludes(drainAuthMigration, "'x-api-key', public._sw_api_key()");
  assert(!drainAuthMigration.includes("'Authorization', 'Bearer '"));
  assertStringIncludes(
    drainAuthMigration,
    "makesafe_pdf_extraction_drain_requests",
  );
  assertStringIncludes(drainAuthMigration, "LEFT JOIN net._http_response");
  assertStringIncludes(drainAuthMigration, "latest.status_code <> 200");
  assertStringIncludes(drainAuthMigration, "RAISE EXCEPTION");
  assertStringIncludes(
    drainAuthMigration,
    "makesafe-pdf-extraction-drain-response-check",
  );
});

Deno.test("PDF belt owns claim, completion, retry budget, and ETA on one SHA coordinate", () => {
  const claimStart = closureMigration.indexOf(
    "CREATE OR REPLACE FUNCTION public.claim_makesafe_pdf_extraction",
  );
  const claimEnd = closureMigration.indexOf(
    "REVOKE ALL ON FUNCTION public.claim_makesafe_pdf_extraction",
  );
  const claim = closureMigration.slice(claimStart, claimEnd);
  const completeStart = closureMigration.indexOf(
    "CREATE OR REPLACE FUNCTION public.complete_makesafe_pdf_extraction",
  );
  const completeEnd = closureMigration.indexOf(
    "REVOKE ALL ON FUNCTION public.complete_makesafe_pdf_extraction",
  );
  const complete = closureMigration.slice(completeStart, completeEnd);

  assert(claimStart >= 0 && claimEnd > claimStart);
  assert(completeStart >= 0 && completeEnd > completeStart);
  assertStringIncludes(
    claim,
    "hashtextextended('makesafe_pdf_extraction_coordinate', 0)",
  );
  assertStringIncludes(
    complete,
    "hashtextextended('makesafe_pdf_extraction_coordinate', 0)",
  );
  assertStringIncludes(claim, "FOR UPDATE OF c SKIP LOCKED");
  assertStringIncludes(claim, "attempts = attempts + 1");
  assertStringIncludes(
    claim,
    "candidate.id = ANY(c.attempted_attachment_ids)",
  );
  assertStringIncludes(
    claim,
    "array_append(attempted_attachment_ids, selected_id)",
  );
  const reconciliation = claim.indexOf("WITH old_worker_completion AS");
  const selection = claim.indexOf(
    "SELECT c.coordinate, a.id, 'extract'",
  );
  assert(reconciliation >= 0 && selection > reconciliation);
  assertStringIncludes(complete, "c.claim_token = p_claim_token");
  assertStringIncludes(
    complete,
    "WHEN p_outcome = 'failed' AND c.attempts >= 3 THEN 'quarantined'",
  );
  assertStringIncludes(
    closureMigration,
    "FROM public.makesafe_pdf_extraction_coordinates c",
  );
  assertStringIncludes(
    closureMigration,
    "MAX(a.pdf_extraction_attempts) OVER",
  );
  assertStringIncludes(
    closureMigration,
    "WHEN status = 'extracted' AND extracted_text IS NULL THEN 'pending'",
  );
  assertStringIncludes(
    closureMigration,
    "WHEN NULLIF(OLD.sha256, '') IS NULL",
  );
  assertStringIncludes(
    closureMigration,
    "RETURNS TABLE (\n  id uuid,\n  email_id text",
  );
  assertStringIncludes(
    closureMigration,
    "c.status = 'processing' OR c.attempts < 3",
  );
});
