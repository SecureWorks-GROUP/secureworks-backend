import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);

function withoutSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, "");
}

function lineNumberAt(sql: string, index: number): number {
  return sql.slice(0, index).split("\n").length;
}

Deno.test("migrations use the production pg_trgm schema", async () => {
  const violations: string[] = [];

  for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;

    const sql = withoutSqlComments(
      await Deno.readTextFile(new URL(entry.name, MIGRATIONS_DIR)),
    );

    for (
      const match of sql.matchAll(
        /\bcreate\s+extension\b[^;]*\bpg_trgm\b[^;]*;/gi,
      )
    ) {
      if (!/\b(?:with\s+)?schema\s+"?public"?(?:\s|;)/i.test(match[0])) {
        violations.push(
          `${entry.name}:${
            lineNumberAt(sql, match.index)
          } must install pg_trgm in schema public`,
        );
      }
    }

    for (const match of sql.matchAll(/"?gin_trgm_ops"?/gi)) {
      const qualifier = sql.slice(Math.max(0, match.index - 40), match.index);
      if (!/"?public"?\s*\.\s*$/i.test(qualifier)) {
        violations.push(
          `${entry.name}:${
            lineNumberAt(sql, match.index)
          } must use public.gin_trgm_ops`,
        );
      }
    }
  }

  assertEquals(
    violations,
    [],
    "Production project kevgrhcjxspbxgovpmfl installs pg_trgm in schema public",
  );
});
