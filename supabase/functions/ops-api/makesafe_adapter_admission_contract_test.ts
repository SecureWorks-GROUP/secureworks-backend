// deno-lint-ignore-file no-import-prefix
//
// Every adapter the deterministic intake registers in code must be admitted by
// every database list of adapter ids.
//
// Why this exists: PR #1004 registered the `ambrose` adapter and shipped its
// company row, but the CHECK on makesafe_intake_cases still listed the older
// adapters only. Every Ambrose case was refused on insert and fell back to a
// stripped exception, so no Ambrose job or review draft could exist. Nothing
// failed in CI, because nothing compared the two lists.
//
// What is compared: the adapter ids of the real exported registry, against a
// model of the migrations. The model replays the migration files in order and
// keeps, for each constraint or function that lists adapter ids, its newest
// definition (a later DROP with no re-add removes it). The lists are parsed
// out of the SQL as lists, not searched for as text: a mention in a comment
// does not count, and a list that drops an adapter is seen. PostgreSQL itself
// proves the newest constraint behaves as listed, in
// supabase/tests/migration-contracts/20261012043000_makesafe_intake_cases_admit_ambrose_adapter/.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DETERMINISTIC_ADAPTER_REGISTRY } from "./makesafe_deterministic_intake.ts";

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);
const CASE_ADAPTER_CONSTRAINT =
  "constraint makesafe_intake_cases_deterministic_shapes_check";

interface MigrationFile {
  name: string;
  sql: string;
}

interface AdapterIdList {
  // "constraint <name>" or "function <name>".
  owner: string;
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

// `adapter_id IN (...)` and `adapter_id = ANY (ARRAY[...])`, the two spellings
// PostgreSQL accepts and prints for the same list.
const ADAPTER_LIST = /\badapter_id\s*(?:IN\s*\(|=\s*ANY\s*\(\s*ARRAY\s*\[)/gi;

/** Same length as `sql`, with the inside of every string literal blanked. */
function maskLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      const end = closingQuote(sql, i);
      out += "'" + " ".repeat(Math.max(0, end - i - 1)) + "'";
      i = end + 1;
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

function adapterIdsIn(sql: string): string[] | null {
  const ids = new Set<string>();
  let found = false;
  // Searched on the masked text so words inside a string literal never match;
  // the ids are then read from the original at the same offsets.
  for (const match of maskLiterals(sql).matchAll(ADAPTER_LIST)) {
    found = true;
    const open = match.index! + match[0].length - 1;
    const close = match[0].endsWith("[") ? "]" : ")";
    const body = close === ")"
      ? balanced(sql, open)
      : sql.slice(open + 1, sql.indexOf("]", open));
    for (const id of stringLiterals(body)) ids.add(id);
  }
  return found ? [...ids].sort() : null;
}

/** Top-level statements; a dollar-quoted body stays inside its statement. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === "'") {
      const end = closingQuote(sql, i);
      current += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64))?.[0];
    if (tag) {
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end < 0 ? sql.length : end + tag.length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (sql[i] === ";") {
      out.push(current);
      current = "";
    } else {
      current += sql[i];
    }
    i++;
  }
  if (current.trim()) out.push(current);
  return out;
}

/**
 * Replays migrations in filename order and returns the adapter-id lists that
 * are in force afterwards.
 */
export function adapterIdListsInForce(
  migrations: readonly MigrationFile[],
): AdapterIdList[] {
  const inForce = new Map<string, AdapterIdList>();
  const ordered = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
  for (const migration of ordered) {
    for (const statement of statements(stripSqlComments(migration.sql))) {
      const fn = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)/i.exec(
        statement,
      );
      if (fn) {
        const owner = `function ${fn[1].replace(/^public\./, "")}`;
        const ids = adapterIdsIn(statement);
        if (ids) inForce.set(owner, { owner, migration: migration.name, ids });
        else inForce.delete(owner);
        continue;
      }
      for (
        const drop of statement.matchAll(
          /\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(\w+)/gi,
        )
      ) {
        inForce.delete(`constraint ${drop[1]}`);
      }
      for (
        const drop of statement.matchAll(
          /\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([\w.]+)/gi,
        )
      ) {
        inForce.delete(`function ${drop[1].replace(/^public\./, "")}`);
      }
      for (
        const check of statement.matchAll(
          /\bCONSTRAINT\s+(\w+)\s+CHECK\s*\(/gi,
        )
      ) {
        const open = check.index! + check[0].length - 1;
        const ids = adapterIdsIn(balanced(statement, open));
        if (!ids) continue;
        const owner = `constraint ${check[1]}`;
        inForce.set(owner, { owner, migration: migration.name, ids });
      }
    }
  }
  return [...inForce.values()].sort((a, b) => a.owner.localeCompare(b.owner));
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

Deno.test("every adapter registered in code is admitted by every database adapter list", async () => {
  const lists = adapterIdListsInForce(await readMigrations());
  // The case table's list must be found, or this test proves nothing.
  assert(
    lists.some((list) => list.owner === CASE_ADAPTER_CONSTRAINT),
    `no adapter list found for ${CASE_ADAPTER_CONSTRAINT}`,
  );
  const gaps = lists
    .map((list) => ({
      owner: list.owner,
      migration: list.migration,
      missing: missingFrom(list, REGISTERED),
    }))
    .filter((gap) => gap.missing.length);
  assertEquals(
    gaps,
    [],
    "an adapter registered in DETERMINISTIC_ADAPTER_REGISTRY is missing from a database adapter list; add a migration that admits it in the same PR",
  );
});

Deno.test("REGRESSION: before the admitting migration, ambrose was registered in code and refused by the database", async () => {
  const before = (await readMigrations()).filter((migration) =>
    migration.name <
      "20261012043000_makesafe_intake_cases_admit_ambrose_adapter.sql"
  );
  const list = adapterIdListsInForce(before).find((item) =>
    item.owner === CASE_ADAPTER_CONSTRAINT
  );
  assert(list, "the case adapter list existed before the admitting migration");
  assertEquals(missingFrom(list, REGISTERED), ["ambrose"]);
});

Deno.test("the adapter list is read as a list: newest definition wins, both spellings parse, comments and drops count for nothing", () => {
  const lists = adapterIdListsInForce([
    {
      name: "20260101000000_first.sql",
      sql: `
        ALTER TABLE public.cases
          ADD CONSTRAINT cases_shape CHECK (
            (adapter_id IS NULL OR adapter_id IN ('one', 'two'))
            AND jsonb_typeof(story) = 'array'
          );
        ALTER TABLE public.other
          ADD CONSTRAINT other_shape CHECK (adapter_id IN ('one'));
      `,
    },
    {
      name: "20260201000000_second.sql",
      sql: `
        -- adapter_id IN ('commented_out') must not count.
        ALTER TABLE public.cases DROP CONSTRAINT IF EXISTS cases_shape;
        ALTER TABLE public.cases
          ADD CONSTRAINT cases_shape CHECK (
            adapter_id = ANY (ARRAY['one'::text, 'three'::text])
            AND note <> 'adapter_id IN (''quoted'')'
          );
        ALTER TABLE public.other DROP CONSTRAINT other_shape;
        CREATE OR REPLACE FUNCTION public.guard() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.adapter_id IN ('one', 'four') THEN RETURN NEW; END IF;
          RAISE EXCEPTION 'no';
        END;
        $$;
      `,
    },
  ]);
  assertEquals(lists, [
    {
      owner: "constraint cases_shape",
      migration: "20260201000000_second.sql",
      ids: ["one", "three"],
    },
    {
      owner: "function guard",
      migration: "20260201000000_second.sql",
      ids: ["four", "one"],
    },
  ]);
  // 'two' was dropped by the newer definition, so it is reported missing.
  assertEquals(missingFrom(lists[0], ["one", "two", "three"]), ["two"]);
});
