import {
  assert,
  assertEquals,
  assertMatch,
  assertNotMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
const root = new URL("../../", import.meta.url);
const sql = Deno.readTextFileSync(
  new URL("migrations/20261117173001_job_cost_lines_followup8.sql", root),
);
function body(name: string): string {
  const start = sql.indexOf(`FUNCTION public.${name}(`);
  assert(start >= 0, `${name} missing`);
  return sql.slice(start, sql.indexOf("$$;", start));
}
Deno.test("shadow costs: migration installs neither business triggers nor schedules", () => {
  const install = body("job_cost_lines_install_trade_triggers");
  assertMatch(install, /cron\.schedule\(/);
  assertEquals(
    (sql.match(/CREATE TRIGGER/g) ?? []).length,
    (install.match(/CREATE TRIGGER/g) ?? []).length,
  );
  assertEquals((sql.match(/cron\.schedule\(/g) ?? []).length, 1);
  assertNotMatch(sql, /^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\b/im);
  assertNotMatch(
    sql,
    /SELECT public\.job_cost_lines_install_trade_triggers\(\)/,
  );
});
Deno.test("shadow costs: no business source row locks or waiting advisory lock", () => {
  assertNotMatch(
    body("job_cost_lines_sync_trade_invoice"),
    /FROM public\.trade_invoices WHERE id=p_trade_invoice_id FOR UPDATE/,
  );
  assertNotMatch(
    body("job_cost_lines_sync_credit_notes"),
    /COLLATE "C" FOR UPDATE/,
  );
  assertNotMatch(
    body("job_cost_lines_upsert_documents"),
    /PERFORM pg_advisory_xact_lock/,
  );
  assertMatch(
    body("job_cost_lines_upsert_documents"),
    /pg_try_advisory_xact_lock/,
  );
  const trade = body("job_cost_lines_sync_trade_invoice");
  assert(trade.indexOf("pg_try_advisory_xact_lock") < trade.indexOf("SELECT * INTO ti"));
});
Deno.test("shadow costs: conservation is forced before guarded success", () => {
  for (const name of ["job_cost_lines_try_trade", "job_cost_lines_retry_one"]) {
    const fn = body(name);
    const sync = fn.indexOf(
      "result := public.job_cost_lines_sync_trade_invoice",
    );
    const checked = fn.indexOf(
      "public.job_cost_line_parts_conserve IMMEDIATE",
      sync,
    );
    const caught = fn.indexOf("EXCEPTION WHEN OTHERS", sync);
    assert(sync > 0 && checked > sync && caught > checked);
  }
  assertMatch(
    body("job_cost_lines_try_trade"),
    /INSERT INTO public\.job_cost_lines_shadow_retries/,
  );
  assertMatch(
    body("job_cost_lines_retry_one"),
    /ORDER BY next_attempt_at,id LIMIT 1/,
  );
  assertMatch(
    body("job_cost_lines_retry_one"),
    /ORDER BY requested_at,id LIMIT 100/,
  );
});
