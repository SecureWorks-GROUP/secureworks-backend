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

Deno.test("PDF belt serializes claim allocation before locking any SHA carrier", () => {
  const claimStart = migration.indexOf(
    "CREATE OR REPLACE FUNCTION public.claim_makesafe_pdf_extraction",
  );
  const claimEnd = migration.indexOf(
    "REVOKE ALL ON FUNCTION public.claim_makesafe_pdf_extraction",
  );
  const claim = migration.slice(claimStart, claimEnd);
  const advisoryLock = claim.indexOf(
    "pg_advisory_xact_lock",
  );
  const terminalReuse = claim.indexOf("WITH reusable AS");
  const rowClaim = claim.indexOf("FOR UPDATE OF a SKIP LOCKED");

  assert(claimStart >= 0 && claimEnd > claimStart);
  assert(advisoryLock >= 0);
  assert(advisoryLock < terminalReuse);
  assert(advisoryLock < rowClaim);
  assertStringIncludes(
    claim,
    "hashtextextended('makesafe_pdf_extraction_claim', 0)",
  );
  assertStringIncludes(
    claim,
    "AND NULLIF(active.sha256, '') = NULLIF(a.sha256, '')",
  );
  assertStringIncludes(
    claim,
    "active.pdf_extraction_status = 'processing'",
  );
  assertStringIncludes(
    claim,
    "active.pdf_extraction_started_at >= now() - interval '2 minutes'",
  );
});
