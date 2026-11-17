import { assert, assertEquals } from "jsr:@std/assert@1";

const root = new URL("../../", import.meta.url);
const name = "20261117194101_job_mark_trigger_guards";
const migration = Deno.readTextFileSync(new URL(`supabase/migrations/${name}.sql`, root));
const original = Deno.readTextFileSync(new URL("supabase/migrations/20261117171303_job_change_mark_triggers.sql", root));

Deno.test("mark trigger guards: merge replaces definitions without activating anything", () => {
  assert(!/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\b/im.test(migration));
  const outsideBodies = migration.replace(/\$(install|remove)\$[\s\S]*?\$\1\$/g, "''");
  assert(!/\b(?:CREATE|DROP)\s+TRIGGER\b/i.test(outsideBodies));
  assert(!/\bSELECT\b|\bcron\.|\bINSERT\b/i.test(outsideBodies));
  assertEquals([...migration.matchAll(/CREATE OR REPLACE FUNCTION/g)].length, 2);
  assert(!migration.includes("CREATE OR REPLACE FUNCTION public.job_mark_changed_trg"));
});

Deno.test("mark trigger guards: rollback restores the original dormant definitions", () => {
  const down = Deno.readTextFileSync(new URL(`supabase/rollbacks/${name}_down.sql`, root));
  const start = "CREATE OR REPLACE FUNCTION public.job_change_mark_triggers_install()";
  assertEquals(down.slice(down.indexOf(start)), original.slice(original.indexOf(start)));
});

Deno.test("mark trigger guards: real PostgreSQL proof includes every source and the invocation tripwire", () => {
  const contract = Deno.readTextFileSync(new URL(`supabase/tests/migration-contracts/${name}/contract.sql`, root));
  const tables = [...original.matchAll(/CREATE TRIGGER job_mark_changed_(\w+)\n/g)].map((m) => m[1]);
  assertEquals(tables.length, 14);
  for (const table of tables) assert(contract.includes(`-- ${table}: insert, meaningful update, housekeeping, delete.`), table);
  assert(contract.includes("unchanged row entered trigger function"));
  for (const file of ["setup.sql", "break-contract.sql", "break-contract.expected", "rollback-contract.sql"]) {
    assert(Deno.readTextFileSync(new URL(`supabase/tests/migration-contracts/${name}/${file}`, root)).trim());
  }
});
