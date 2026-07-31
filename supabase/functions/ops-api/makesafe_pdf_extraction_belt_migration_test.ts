import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const migration = await Deno.readTextFile(
  new URL("../../migrations/20260731000001_makesafe_pdf_extraction_belt.sql", import.meta.url),
);

Deno.test("PDF belt migration creates a durable bounded queue and retention-safe extraction columns", () => {
  for (const column of [
    "pdf_extraction_status",
    "pdf_extraction_text",
    "pdf_extraction_char_count",
    "pdf_extraction_page_count",
    "pdf_extraction_extractor",
    "pdf_extraction_truncated",
    "pdf_extraction_reason",
    "pdf_extraction_attempts",
    "pdf_extraction_started_at",
    "pdf_extraction_completed_at",
    "pdf_extraction_next_attempt_at",
  ]) assertStringIncludes(migration, column);
  assertStringIncludes(migration, "FOR UPDATE OF a SKIP LOCKED");
  assertStringIncludes(migration, "pdf_extraction_text = NULL");
  assertStringIncludes(migration, "makesafe-pdf-extraction-drain");
  assertStringIncludes(migration, "* * * * *");
});

Deno.test("PDF belt migration keeps the standing scanner bounded rather than raising its cap", () => {
  assert(!migration.includes("MAX_PDF_EXTRACTIONS_PER_RUN"));
  assert(!migration.includes("received_at >= now() - interval '5 minutes'"));
  assertStringIncludes(migration, "one document per invocation");
  assertStringIncludes(migration, "ceil(N) minutes");
});
