// G1 (2026-08-03, MLB-26267): 'roof_report' in job_documents_type_check.
//
// ops-api attachMakesafeDocument has always allowed type 'roof_report' and
// carries an explicit comment that it is DELIBERATELY exempt from the
// report-type gate -- generating our own letterhead report is the whole
// point of the roof-report flow -- but the Postgres CHECK constraint
// job_documents_type_check never gained the value, so every own-letterhead
// roof report attach 500'd at insert time.
//
// These tests pin, without a database:
//   1. The EFFECTIVE constraint (last ADD CONSTRAINT
//      job_documents_type_check wins across all migrations in version order,
//      exactly what Postgres ends up holding): it is the 2026-08-03 rebuild,
//      it contains 'roof_report', and it never narrows the verified live
//      production set.
//   2. The migration itself: drop + re-add, zero rows written.
//   3. The rollback twin: restores the verified live definition
//      byte-for-byte (no 'roof_report').
//   4. ops-api / constraint agreement: every type the attachMakesafeDocument
//      allow-list admits is admitted by the effective constraint, and the
//      deliberate roof_report exemption comment is still standing.
//
// Run: deno test --allow-env --allow-read supabase/functions/ops-api/job_documents_roof_report_constraint_test.ts

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);
const MIGRATION_NAME = "20260803060000_job_documents_roof_report_type.sql";

async function migrationsInVersionOrder(): Promise<
  Array<{ name: string; sql: string }>
> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (entry.isFile && entry.name.endsWith(".sql")) names.push(entry.name);
  }
  names.sort();
  const out: Array<{ name: string; sql: string }> = [];
  for (const name of names) {
    out.push({
      name,
      sql: await Deno.readTextFile(new URL(name, MIGRATIONS_DIR)),
    });
  }
  return out;
}

const MIGRATIONS = await migrationsInVersionOrder();
const MIGRATION = MIGRATIONS.find((m) => m.name === MIGRATION_NAME);
const ROLLBACK = await Deno.readTextFile(
  new URL(
    `../../rollbacks/20260803060000_job_documents_roof_report_type_down.sql`,
    import.meta.url,
  ),
);

// The 19 values verified live on production 2026-08-03
// (pg_get_constraintdef on job_documents_type_check). The rebuild must
// preserve every one of them -- it widens production, never narrows it.
const VERIFIED_LIVE_VALUES = [
  "quote",
  "material_order",
  "work_order",
  "sheets_order",
  "variation",
  "approval",
  "site_photo",
  "general",
  "supplier_quote",
  "supplier_work_order",
  "supplier_invoice",
  "council_plans",
  "engineering",
  "client_reference",
  "asbestos",
  "other",
  "invoice",
  "makesafe_report",
  "swms",
];

// Byte-identical to the verified live definition (pg_get_constraintdef,
// 2026-08-03). The rollback twin must restore exactly this.
const VERIFIED_LIVE_DEFINITION =
  "CHECK ((type = ANY (ARRAY['quote','material_order','work_order','sheets_order','variation','approval','site_photo','general','supplier_quote','supplier_work_order','supplier_invoice','council_plans','engineering','client_reference','asbestos','other','invoice','makesafe_report','swms'])))";

/** The constraint Postgres ends up with: the last ADD CONSTRAINT wins. */
function effectiveConstraint(): { migration: string; body: string } {
  let found: { migration: string; body: string } | null = null;
  for (const migration of MIGRATIONS) {
    const marker = "ADD CONSTRAINT job_documents_type_check";
    let from = migration.sql.indexOf(marker);
    while (from !== -1) {
      const end = migration.sql.indexOf(";", from);
      assert(
        end !== -1,
        `unterminated constraint in ${migration.name}`,
      );
      found = {
        migration: migration.name,
        body: migration.sql.slice(from, end + 1),
      };
      from = migration.sql.indexOf(marker, end);
    }
  }
  assert(found, "no definition found for job_documents_type_check");
  return found;
}

/** Executable statements only: `--` comment lines stripped. */
function executable(sql: string): string {
  return sql.split("\n").filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/** The single-quoted type values inside a constraint definition body. */
function constraintValues(body: string): string[] {
  return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const EFFECTIVE = effectiveConstraint();

Deno.test("the effective constraint is the 2026-08-03 rebuild and includes roof_report", () => {
  assertEquals(
    EFFECTIVE.migration,
    MIGRATION_NAME,
    "the last migration defining job_documents_type_check must be the roof_report rebuild",
  );
  assertStringIncludes(EFFECTIVE.body, "'roof_report'");
});

Deno.test("the rebuild never narrows the verified live production set", () => {
  const values = constraintValues(EFFECTIVE.body);
  for (const live of VERIFIED_LIVE_VALUES) {
    assert(
      values.includes(live),
      `effective constraint dropped live value '${live}' -- a rebuild must never narrow production`,
    );
  }
  assertEquals(
    values.length,
    VERIFIED_LIVE_VALUES.length + 1,
    "the rebuild adds exactly one value (roof_report) to the verified live set",
  );
});

Deno.test("the migration drops and re-adds the constraint and writes zero rows", () => {
  assert(MIGRATION, "the roof_report constraint migration is missing");
  const executableSql = executable(MIGRATION.sql);
  assertStringIncludes(
    executableSql,
    "DROP CONSTRAINT IF EXISTS job_documents_type_check",
  );
  assertStringIncludes(
    executableSql,
    "ADD CONSTRAINT job_documents_type_check",
  );
  for (const write of ["INSERT INTO", "UPDATE ", "DELETE FROM", "TRUNCATE"]) {
    assert(
      !executableSql.toUpperCase().includes(write),
      `the migration must write zero rows, found ${write}`,
    );
  }
});

Deno.test("the rollback twin restores the verified live definition byte-for-byte", () => {
  assertStringIncludes(ROLLBACK, VERIFIED_LIVE_DEFINITION);
  const rollbackExecutable = executable(ROLLBACK);
  assert(
    !rollbackExecutable.includes("'roof_report'"),
    "the restored constraint must not carry roof_report",
  );
  const values = constraintValues(rollbackExecutable);
  assertEquals(values.length, VERIFIED_LIVE_VALUES.length);
  for (const live of VERIFIED_LIVE_VALUES) {
    assert(values.includes(live), `rollback dropped live value '${live}'`);
  }
  // The header must warn about the roof_report rows that block the restore.
  assertStringIncludes(ROLLBACK, "type = 'roof_report'");
});

// ── ops-api / constraint agreement ──
//
// attachMakesafeDocument is the attach path the roof-report flow uses. Its
// allow-list is the application-side source of truth for roof_report (the
// deliberate exemption comment); the database constraint must admit every
// value the edge function admits, or the insert 500s -- that is G1.

function attachMakesafeDocumentBody(): string {
  const marker = "async function attachMakesafeDocument(";
  const from = INDEX.indexOf(marker);
  assert(from !== -1, "attachMakesafeDocument not found in index.ts");
  const end = INDEX.indexOf("\nasync function ", from + marker.length);
  assert(end !== -1, "attachMakesafeDocument body not terminated");
  return INDEX.slice(from, end);
}

Deno.test("every attachMakesafeDocument allow-list type is admitted by the effective constraint", () => {
  const body = attachMakesafeDocumentBody();
  const listMatch = body.match(/const allowedTypes = \[([^\]]+)\]/);
  assert(listMatch, "attachMakesafeDocument allowedTypes not found");
  const allowed = [...listMatch[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assertEquals(allowed, [
    "work_order",
    "makesafe_report",
    "roof_report",
    "invoice",
    "swms",
  ]);
  const values = constraintValues(EFFECTIVE.body);
  for (const type of allowed) {
    assert(
      values.includes(type),
      `ops-api admits '${type}' but the effective constraint rejects it`,
    );
  }
});

Deno.test("the deliberate roof_report exemption from the report-type gate is still standing", () => {
  const body = attachMakesafeDocumentBody();
  // The source-of-truth comment: roof_report is deliberately produced for
  // report-type jobs, so it is NOT subject to the report-type gate.
  assertStringIncludes(body, "DELIBERATELY produced for report-type jobs");
  assertStringIncludes(body, "not subject to");
  // The gate itself still fires on makesafe_report only -- roof_report must
  // stay outside it.
  assertStringIncludes(body, "if (type === 'makesafe_report')");
});
