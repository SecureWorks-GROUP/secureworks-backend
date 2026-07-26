import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20260726000001_makesafe_company_parsing_rules_slug_correction.sql",
  import.meta.url,
);

Deno.test("parsing-rule correction targets every drift-confirmed live slug", async () => {
  const sql = await Deno.readTextFile(MIGRATION);

  assertStringIncludes(sql, "slug IN ('aj', 'ajs', 'ajbr')");
  assertStringIncludes(sql, "slug IN ('bw', 'builderwest')");
  assertStringIncludes(sql, "slug IN ('wb', 'western-building')");
  assertStringIncludes(sql, "Job\\s*No");
});

Deno.test("parsing-rule correction rejects an active company with neither fields nor a reviewed exception", async () => {
  const sql = await Deno.readTextFile(MIGRATION);

  assertStringIncludes(sql, "parsing_rules->>'intentionally_no_fields'");
  assertStringIncludes(sql, "parsing_rules->>'no_fields_reason'");
  assertStringIncludes(
    sql,
    "Active make-safe company parsing-rule coverage missing",
  );
  assertStringIncludes(
    sql,
    "makesafe_companies_active_parsing_rules_covered",
  );
  assertStringIncludes(sql, "VALIDATE CONSTRAINT");
  assert(
    /RAISE EXCEPTION[\s\S]+array_to_string\(uncovered_slugs/.test(sql),
    "migration must fail closed and identify every uncovered live slug",
  );
});
