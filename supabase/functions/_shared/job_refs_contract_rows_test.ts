// deno-lint-ignore-file no-import-prefix
// Slice B0: the SQL helpers' fixture block in the migration contract
// (supabase/tests/migration-contracts/20260924160000_context_unlinked_census/contract.sql)
// must be exactly job_refs_fixtures.ts, so the SQL and TypeScript twins are
// proved on ONE table. Regenerate the block with sqlFixtureBlock() when this
// fails.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { JOB_REF_FIXTURES, type KeyFixture } from "./job_refs_fixtures.ts";

const contract = await Deno.readTextFile(
  new URL(
    "../../tests/migration-contracts/20260924160000_context_unlinked_census/contract.sql",
    import.meta.url,
  ),
);

function q(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

function expected(f: KeyFixture): unknown {
  return f.expected;
}

export function sqlFixtureBlock(): string {
  return JOB_REF_FIXTURES.map((f, i) =>
    ` (${q(f.kind)},${q(f.label)},${q(f.input)},${
      q(JSON.stringify(expected(f)))
    }::jsonb)${i === JOB_REF_FIXTURES.length - 1 ? ";" : ","}`
  ).join("\n");
}

Deno.test("the SQL contract's fixture block is job_refs_fixtures.ts", () => {
  const start = contract.indexOf("-- FIXTURES BEGIN\n");
  const end = contract.indexOf("\n-- FIXTURES END");
  if (start < 0 || end < 0) {
    throw new Error("contract.sql has no FIXTURES block");
  }
  assertEquals(
    contract.slice(start + "-- FIXTURES BEGIN\n".length, end),
    sqlFixtureBlock(),
  );
});

if (import.meta.main) console.log(sqlFixtureBlock());
