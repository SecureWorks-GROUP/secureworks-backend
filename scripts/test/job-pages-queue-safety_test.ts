// Narrow artifact gates. PostgreSQL behavior/concurrency is proved by the registered SQL case in CI.
import { assert, assertEquals } from "jsr:@std/assert@1";

const root = new URL("../../", import.meta.url);
const version = "20261117172102_job_pages_queue_safety";
const migration = Deno.readTextFileSync(new URL(`supabase/migrations/${version}.sql`, root));
const caseDir = new URL(`supabase/tests/migration-contracts/${version}/`, root);

Deno.test("job pages safety: migration leaves activation and transaction ownership to the caller", () => {
  assert(!/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\b/im.test(migration));
  assert(!/\bCREATE\s+(?:CONSTRAINT\s+)?TRIGGER\b/i.test(migration));
  assert(!/\bcron\.(?:schedule|unschedule)\s*\(/i.test(migration));
  assert(!/\b(?:job_pages_install|job_change_mark_triggers_install)\s*\(/i.test(migration));
  const schedule = Deno.readTextFileSync(new URL("supabase/migrations/20261117171305_job_pages_schedule.sql", root));
  assertEquals([...schedule.matchAll(/CREATE OR REPLACE FUNCTION public\.job_pages_remove\(/g)].length, 1);
});

Deno.test("job pages safety: append writer has no shared row or parent-lock dependency", () => {
  const writer = migration.split("CREATE OR REPLACE FUNCTION public.job_mark_changed(")[1].split("END $fn$;")[0];
  assert(writer.includes("INSERT INTO public.job_change_mark_events(job_id,source)"));
  assert(!/\b(?:UPDATE|DELETE|ON CONFLICT|FOR UPDATE|FOR KEY SHARE|pg_advisory|pg_try_advisory)\b/i.test(writer));
  const heap = migration.split("CREATE TABLE IF NOT EXISTS public.job_change_mark_events (")[1].split(");")[0];
  assert(!/\b(?:PRIMARY KEY|UNIQUE|REFERENCES)\b/i.test(heap));
  assert(migration.includes("+coalesce(e.n,0) AS mark_version"));
});

Deno.test("job pages safety: the registered behavioral proof and rollback artifacts are complete", () => {
  for (const name of ["setup.sql", "contract.sql", "concurrency-contract.sql", "break-contract.sql", "break-contract.expected", "rollback-contract.sql"]) {
    const sql = Deno.readTextFileSync(new URL(name, caseDir));
    assert(sql.trim().length > 0, name);
    for (const match of sql.matchAll(/^\\ir (.+)$/gm)) {
      assert(Deno.statSync(new URL(match[1], caseDir)).isFile, match[1]);
    }
  }
  assert(Deno.statSync(new URL(`supabase/rollbacks/${version}_down.sql`, root)).isFile);
  const contract = Deno.readTextFileSync(new URL("contract.sql", caseDir));
  const concurrency = Deno.readTextFileSync(new URL("concurrency-contract.sql", caseDir));
  for (const reason of ["failed head did not yield", "second job did not get its page", "timeout head did not yield", "nightly did not re-mark"]) assert(contract.includes(reason));
  for (const reason of ["opposite-order writer lost a mark", "lower sequence committed late was lost", "failure consumed a concurrent mark"]) assert(concurrency.includes(reason));
});

Deno.test("job pages safety: failure acknowledges the captured coordinate and catches cancellation", () => {
  const failure = migration.split("EXCEPTION WHEN OTHERS OR query_canceled THEN")[1];
  assert(failure);
  assert(failure.includes("VALUES(p_job_id,v_version,v_covers,v_covers)"));
  assert(!/SELECT\s+mark_version/i.test(failure));
  assert(migration.includes("ON CONFLICT (job_id) DO UPDATE SET status='failed'"));
});
