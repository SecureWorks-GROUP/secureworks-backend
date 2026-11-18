// Static guard for the two switch precondition scripts (Follow-up 56): they
// read only, call no application function, and list every check they promise.
// The behavioural proof is switch-preconditions_test.sh (local Postgres only).
// Run: deno test --allow-read scripts/proof/switch_preconditions_test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const dir = new URL(".", import.meta.url);
const scripts = {
  "cap-switch-preconditions.sql": [
    "C01", "C02", "C03", "C04", "C05", "C06", "C07", "C08", "C09", "C10",
    "C11", "C12", "C13", "C14", "F01", "F02", "N01", "N02", "N03",
  ],
  "pay-run-switch-preconditions.sql": [
    "P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08", "P09", "P15",
    "F01", "N01", "N02", "N03", "N04", "N05", "N06",
  ],
};

/** SQL with comments, string literals and psql meta lines removed. */
function codeOnly(sql: string): string {
  return sql
    .split("\n").filter((line) => !line.trimStart().startsWith("\\")).join("\n")
    // One pass, so a literal holding "--" is not read as a comment.
    .replace(/'(?:[^']|'')*'|--[^\n]*/g, (m) => m.startsWith("'") ? "''" : "");
}

for (const [file, ids] of Object.entries(scripts)) {
  const sql = await Deno.readTextFile(new URL(file, dir));
  const code = codeOnly(sql);

  Deno.test(`${file}: one read-only transaction, rolled back`, () => {
    const statements = code.split(";").map((s) => s.trim()).filter(Boolean);
    assertEquals(statements[0], "START TRANSACTION READ ONLY");
    assertEquals(statements.at(-1), "ROLLBACK");
  });

  Deno.test(`${file}: no write, schema change or session change`, () => {
    const banned =
      /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|SET|LOCK|VACUUM|ANALYZE|REFRESH|NOTIFY|COMMIT)\b/i;
    const hit = code.match(banned);
    assert(hit === null, `found ${hit?.[0]}`);
  });

  Deno.test(`${file}: calls no application function`, () => {
    const calls = [...code.matchAll(/\bpublic\.([a-z_0-9]+)\s*\(/gi)]
      .map((m) => m[1]);
    assertEquals(calls, []);
    const named =
      /\b(install|remove|approve|set|persist|decide|reconcile|reject|raise|record|claim)_[a-z_0-9]*\s*\(/i;
    const hit = code.match(named);
    assert(hit === null, `found ${hit?.[0]}`);
  });

  Deno.test(`${file}: prints every promised check and one overall row`, () => {
    for (const id of ids) assert(sql.includes(`'${id} `), `missing ${id}`);
    assert(sql.includes("'overall'"));
  });

  Deno.test(`${file}: takes only the ZZTEST job number`, () => {
    const vars = new Set([...sql.matchAll(/:'([a-z_]+)'/g)].map((m) => m[1]));
    assertEquals([...vars], ["job_number"]);
    assert(sql.includes("LIKE 'ZZTEST%'"));
  });
}
