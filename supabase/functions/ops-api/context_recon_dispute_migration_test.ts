import { assertEquals, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";

const migrationUrl = new URL(
  "../../migrations/20261021160000_context_recon_dispute.sql",
  import.meta.url,
);
const downUrl = new URL(
  "../../rollbacks/20261021160000_context_recon_dispute_down.sql",
  import.meta.url,
);

function withoutSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/--[^\n]*/g, "");
}

Deno.test("CTX-18 dispute marker is a clearable row and does not replace the queue", async () => {
  const raw = await Deno.readTextFile(migrationUrl);
  const sql = withoutSqlComments(raw);
  const down = withoutSqlComments(await Deno.readTextFile(downUrl));

  assertMatch(raw, /20261021160000/);
  assertEquals(/feature_flags/i.test(sql), false);
  assertEquals(
    /^\s*(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im.test(sql),
    false,
  );
  assertEquals(
    /^\s*(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im.test(down),
    false,
  );

  assertMatch(sql, /CREATE TABLE IF NOT EXISTS public\.context_recon_disputes/i);
  assertMatch(sql, /event_id uuid PRIMARY KEY/i);
  assertMatch(sql, /reason text,/);
  assertMatch(sql, /disputed_by text,/);
  assertMatch(sql, /disputed_at timestamptz,/);
  assertEquals(/reason text NOT NULL/i.test(sql), false);
  assertEquals(/disputed_by text NOT NULL/i.test(sql), false);
  assertEquals(/disputed_at timestamptz NOT NULL/i.test(sql), false);

  assertMatch(sql, /CREATE OR REPLACE FUNCTION public\.context_recon_set_dispute/i);
  assertMatch(sql, /CREATE OR REPLACE FUNCTION public\.context_recon_dispute/i);
  assertMatch(sql, /CREATE OR REPLACE FUNCTION public\.context_job_view/i);
  assertMatch(sql, /CREATE OR REPLACE FUNCTION public\.context_recon_health/i);
  assertMatch(sql, /candidate_job_ids @> ARRAY\[p_job\]/);
  assertMatch(sql, /'disputed_open'/);
  assertEquals(
    /create\s+or\s+replace\s+function\s+public\.context_recon_queue\b/i.test(sql),
    false,
  );
  assertEquals(
    /create\s+or\s+replace\s+function\s+public\.context_recon_evidence_keys\b/i.test(sql),
    false,
  );
  assertEquals(/drop\s+function\s+[^;]*context_recon_queue/i.test(sql), false);

  assertMatch(down, /CREATE OR REPLACE FUNCTION public\.context_job_view/i);
  assertMatch(down, /candidate_job_ids @> ARRAY\[p_job\]/);
  assertEquals(/context_recon_disputes/i.test(
    down.slice(down.search(/CREATE OR REPLACE FUNCTION public\.context_job_view/i)),
  ), true); // the drop names the table after the restored view
  const viewBody = down.slice(
    down.search(/CREATE OR REPLACE FUNCTION public\.context_job_view/i),
    down.search(/CREATE OR REPLACE FUNCTION public\.context_recon_health/i),
  );
  assertEquals(/context_recon_disputes/i.test(viewBody), false);
  assertEquals(/disputed_open/i.test(down.slice(
    down.search(/CREATE OR REPLACE FUNCTION public\.context_recon_health/i),
    down.search(/COMMENT ON FUNCTION/i),
  )), false);
  assertMatch(down, /DROP TABLE IF EXISTS public\.context_recon_disputes/i);
  assertEquals(/drop\s+function\s+[^;]*context_recon_queue/i.test(down), false);
});
