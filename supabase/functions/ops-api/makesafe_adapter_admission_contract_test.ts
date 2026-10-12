// deno-lint-ignore-file no-import-prefix
//
// Every adapter the deterministic intake registers in code must be admitted by
// the database's adapter list.
//
// Why this exists: PR #1004 registered the `ambrose` adapter and shipped its
// company row, but the CHECK on makesafe_intake_cases still listed the older
// adapters only. Every Ambrose case was refused on insert and fell back to a
// stripped exception, so no Ambrose job or review draft could exist. Nothing
// failed in CI, because nothing compared the two lists.
//
// What is compared: the adapter ids of the real exported registry, against the
// newest definition of makesafe_intake_cases_deterministic_shapes_check in the
// migration files, the one adapter list in the database. The list is parsed out
// of the SQL as a list, not searched for as text: a mention in a comment does
// not count, and a definition that drops an adapter is seen. PostgreSQL itself
// proves the newest constraint behaves as listed, in
// supabase/tests/migration-contracts/20261012043000_makesafe_intake_cases_admit_ambrose_adapter/.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DETERMINISTIC_ADAPTER_REGISTRY } from "./makesafe_deterministic_intake.ts";

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);
const CASE_ADAPTER_CONSTRAINT =
  "makesafe_intake_cases_deterministic_shapes_check";

interface MigrationFile {
  name: string;
  sql: string;
}

interface AdapterIdList {
  migration: string;
  ids: string[];
}

/** Removes `--` and block comments, leaving quoted text untouched. */
function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (sql[i] === "'") {
      const end = closingQuote(sql, i);
      out += sql.slice(i, end + 1);
      i = end + 1;
    } else if (two === "--") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end;
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

/** Index of the quote closing the string literal that opens at `start`. */
function closingQuote(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === "'") {
      if (sql[i + 1] === "'") i += 2;
      else return i;
    } else {
      i++;
    }
  }
  return sql.length - 1;
}

/** The text between the parenthesis at `open` and its match. */
function balanced(sql: string, open: number): string {
  let depth = 0;
  let i = open;
  while (i < sql.length) {
    if (sql[i] === "'") {
      i = closingQuote(sql, i) + 1;
      continue;
    }
    if (sql[i] === "(") depth++;
    if (sql[i] === ")") {
      depth--;
      if (depth === 0) return sql.slice(open + 1, i);
    }
    i++;
  }
  return sql.slice(open + 1);
}

function stringLiterals(sql: string): string[] {
  const values: string[] = [];
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      const end = closingQuote(sql, i);
      values.push(sql.slice(i + 1, end).replaceAll("''", "'"));
      i = end + 1;
    } else {
      i++;
    }
  }
  return values;
}

/**
 * The adapter ids admitted by the newest definition of `constraint` across the
 * migrations, read in filename order. Null when no migration defines it.
 */
export function newestAdapterIdList(
  migrations: readonly MigrationFile[],
  constraint: string,
): AdapterIdList | null {
  const definition = new RegExp(
    `\\bCONSTRAINT\\s+${constraint}\\s+CHECK\\s*\\(`,
    "gi",
  );
  let newest: AdapterIdList | null = null;
  const ordered = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
  for (const migration of ordered) {
    const sql = stripSqlComments(migration.sql);
    for (const match of sql.matchAll(definition)) {
      const check = balanced(sql, match.index! + match[0].length - 1);
      const list = /\badapter_id\s+IN\s*\(/i.exec(check);
      newest = {
        migration: migration.name,
        ids: list
          ? stringLiterals(
            balanced(check, list.index + list[0].length - 1),
          ).sort()
          : [],
      };
    }
  }
  return newest;
}

function missingFrom(list: AdapterIdList, registered: readonly string[]) {
  return registered.filter((id) => !list.ids.includes(id)).sort();
}

async function readMigrations(): Promise<MigrationFile[]> {
  const files: MigrationFile[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    files.push({
      name: entry.name,
      sql: await Deno.readTextFile(new URL(entry.name, MIGRATIONS_DIR)),
    });
  }
  return files;
}

const REGISTERED = DETERMINISTIC_ADAPTER_REGISTRY.map((adapter) => adapter.id);

Deno.test("every adapter registered in code is admitted by the database adapter list", async () => {
  const list = newestAdapterIdList(
    await readMigrations(),
    CASE_ADAPTER_CONSTRAINT,
  );
  // The case table's list must be found, or this test proves nothing.
  assert(list, `no definition found for ${CASE_ADAPTER_CONSTRAINT}`);
  assertEquals(
    { migration: list.migration, missing: missingFrom(list, REGISTERED) },
    { migration: list.migration, missing: [] },
    "an adapter registered in DETERMINISTIC_ADAPTER_REGISTRY is missing from the database adapter list; add a migration that admits it in the same PR",
  );
});

Deno.test("REGRESSION: before the admitting migration, ambrose was registered in code and refused by the database", async () => {
  const before = (await readMigrations()).filter((migration) =>
    migration.name <
      "20261012043000_makesafe_intake_cases_admit_ambrose_adapter.sql"
  );
  const list = newestAdapterIdList(before, CASE_ADAPTER_CONSTRAINT);
  assert(list, "the case adapter list existed before the admitting migration");
  assertEquals(missingFrom(list, REGISTERED), ["ambrose"]);
});

Deno.test("the adapter list is read as a list: the newest definition wins, and comments and other constraints count for nothing", () => {
  const list = newestAdapterIdList([
    {
      name: "20260201000000_second.sql",
      sql: `
        -- CONSTRAINT cases_shape CHECK (adapter_id IN ('commented_out'))
        ALTER TABLE public.cases DROP CONSTRAINT IF EXISTS cases_shape;
        ALTER TABLE public.cases
          ADD CONSTRAINT cases_shape CHECK (
            (adapter_id IS NULL OR adapter_id IN ('three', 'one'))
            AND note <> 'it''s (quoted'
          );
        ALTER TABLE public.other
          ADD CONSTRAINT other_shape CHECK (adapter_id IN ('one', 'four'));
      `,
    },
    {
      name: "20260101000000_first.sql",
      sql: `
        ALTER TABLE public.cases
          ADD CONSTRAINT cases_shape CHECK (
            (adapter_id IS NULL OR adapter_id IN ('one', 'two'))
            AND jsonb_typeof(story) = 'array'
          );
      `,
    },
  ], "cases_shape");
  assertEquals(list, {
    migration: "20260201000000_second.sql",
    ids: ["one", "three"],
  });
  // 'two' was dropped by the newer definition, so it is reported missing.
  assertEquals(missingFrom(list!, ["one", "two", "three"]), ["two"]);
  assertEquals(newestAdapterIdList([], "cases_shape"), null);
});
