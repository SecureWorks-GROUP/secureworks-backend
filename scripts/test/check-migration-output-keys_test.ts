// INT-18: the migration output-key guard (scripts/check-migration-output-keys.ts).
// The 1138 case is the real one: N1's 20261020155000 adds queue_by_lane to
// context_recon_health, and 1138's 20261021160000 redefines it without.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  functionDefs,
  isForwardMigration,
  jsonKeys,
  lostKeys,
  report,
} from "../check-migration-output-keys.ts";

// Main's definition (20261020140000), trimmed to its output.
const MAIN_HEALTH = `
CREATE OR REPLACE FUNCTION public.context_recon_health(p_since timestamptz DEFAULT now() - interval '1 day')
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'held_total', (SELECT count(*) FROM public.business_events e WHERE e.metadata ? 'recon_held'),
    'held_since', (SELECT count(*) FROM public.business_events e
                   WHERE e.metadata ? 'recon_held' AND (e.metadata -> 'recon_held' ->> 'at')::timestamptz >= p_since),
    'queue_by_cause', coalesce((SELECT jsonb_object_agg(cause, n) FROM
                       (SELECT q.cause, count(*) AS n FROM public.context_recon_queue() q GROUP BY q.cause) c), '{}'::jsonb))
$$;
`;

// N1, 1105/1106: 20261020155000_context_recon_backlog_lane.sql (verbatim body).
const N1_HEALTH = `
-- Counts for the daily health row: held re-placements (all time and since p_since), the queue
-- by cause and the queue by lane.
CREATE OR REPLACE FUNCTION public.context_recon_health(p_since timestamptz DEFAULT now() - interval '1 day')
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'held_total', (SELECT count(*) FROM public.business_events e WHERE e.metadata ? 'recon_held'),
    'held_since', (SELECT count(*) FROM public.business_events e
                   WHERE e.metadata ? 'recon_held' AND (e.metadata -> 'recon_held' ->> 'at')::timestamptz >= p_since),
    'queue_by_cause', coalesce((SELECT jsonb_object_agg(cause, n) FROM
                       (SELECT q.cause, count(*) AS n FROM public.context_recon_queue() q GROUP BY q.cause) c), '{}'::jsonb),
    'queue_by_lane', coalesce((SELECT jsonb_object_agg(lane, n) FROM
                       (SELECT q.lane, count(*) AS n FROM public.context_recon_queue() q GROUP BY q.lane) c), '{}'::jsonb))
$$;
`;

// 1138 at 84eac914: 20261021160000_context_recon_dispute.sql (verbatim body).
const PR1138_HEALTH = `
-- Counts for the daily health row: held re-placements (all time and since p_since), the
-- queue by cause, and how many messages currently carry a dispute marker.
CREATE OR REPLACE FUNCTION public.context_recon_health(p_since timestamptz DEFAULT now() - interval '1 day')
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'held_total', (SELECT count(*) FROM public.business_events e WHERE e.metadata ? 'recon_held'),
    'held_since', (SELECT count(*) FROM public.business_events e
                   WHERE e.metadata ? 'recon_held' AND (e.metadata -> 'recon_held' ->> 'at')::timestamptz >= p_since),
    'queue_by_cause', coalesce((SELECT jsonb_object_agg(cause, n) FROM
                       (SELECT q.cause, count(*) AS n FROM public.context_recon_queue() q GROUP BY q.cause) c), '{}'::jsonb),
    'disputed_open', (SELECT count(*) FROM public.context_recon_disputes d WHERE d.disputed_at IS NOT NULL))
$$;
`;

const MAIN = "20261020140000_context_reconciliation_decisions.sql";
const N1 = "20261020155000_context_recon_backlog_lane.sql";
const PR1138 = "20261021160000_context_recon_dispute.sql";

Deno.test("INT-18: 1138 after N1 fails, naming the lost queue_by_lane key", () => {
  const found = lostKeys(
    new Map([[MAIN, MAIN_HEALTH], [N1, N1_HEALTH], [PR1138, PR1138_HEALTH]]),
    [PR1138],
  );
  assertEquals(found, [{
    name: "public.context_recon_health(timestamptz)",
    file: PR1138,
    previousFile: N1,
    lost: ["queue_by_lane"],
  }]);
  assert(report(found).startsWith("FAIL"));
  assert(report(found).includes("drops queue_by_lane"));
});

Deno.test("INT-18: a clean PR passes (1138 on main alone, N1 adding a key)", () => {
  assertEquals(
    lostKeys(new Map([[MAIN, MAIN_HEALTH], [PR1138, PR1138_HEALTH]]), [PR1138]),
    [],
  );
  assertEquals(
    lostKeys(new Map([[MAIN, MAIN_HEALTH], [N1, N1_HEALTH]]), [N1]),
    [],
  );
  assertEquals(report([]).startsWith("OK"), true);
});

Deno.test("INT-18: an intended removal passes only when the migration names it", () => {
  const waived = `-- output-key-guard: drop public.context_recon_health queue_by_lane\n${PR1138_HEALTH}`;
  const files = new Map([[MAIN, MAIN_HEALTH], [N1, N1_HEALTH], [PR1138, waived]]);
  assertEquals(lostKeys(files, [PR1138]), []);
  const wrongKey = `-- output-key-guard: drop public.context_recon_health held_total\n${PR1138_HEALTH}`;
  files.set(PR1138, wrongKey);
  assertEquals(lostKeys(files, [PR1138]).map((f) => f.lost), [["queue_by_lane"]]);
});

Deno.test("INT-18: only changed files are judged; unchanged history is not re-litigated", () => {
  const files = new Map([[MAIN, N1_HEALTH], [N1, MAIN_HEALTH]]);
  assertEquals(lostKeys(files, []), []);
  assertEquals(lostKeys(files, [N1]).length, 1);
});

Deno.test("INT-18: TABLE columns and OUT parameters are output keys", () => {
  const before = `CREATE OR REPLACE FUNCTION public.f(p uuid, OUT a int, OUT b text) AS $$ SELECT 1, 'x' $$ LANGUAGE sql;
CREATE FUNCTION g(p uuid) RETURNS TABLE (reason text, disputed_by text, disputed_at timestamptz) AS $$ SELECT 'a','b',now() $$ LANGUAGE sql;`;
  const after = `CREATE OR REPLACE FUNCTION public.f(p uuid, OUT a int) AS $$ SELECT 1 $$ LANGUAGE sql;
CREATE OR REPLACE FUNCTION public.g(p uuid) RETURNS TABLE (reason text, disputed_at timestamptz) AS $$ SELECT 'a',now() $$ LANGUAGE sql;`;
  const found = lostKeys(new Map([["1_a.sql", before], ["2_b.sql", after]]), ["2_b.sql"]);
  assertEquals(found.map((f) => [f.name, f.lost]), [
    ["public.f(uuid)", ["b"]],
    ["public.g(uuid)", ["disputed_by"]],
  ]);
});

Deno.test("INT-18: overloads, rollbacks, drafts, comments and EXECUTE strings are not misread", () => {
  // Different input types are different functions.
  const one = `CREATE FUNCTION public.h(p int) RETURNS jsonb AS $$ SELECT jsonb_build_object('a', 1) $$ LANGUAGE sql;`;
  const two = `CREATE FUNCTION public.h(p int, q text) RETURNS jsonb AS $$ SELECT jsonb_build_object('b', 1) $$ LANGUAGE sql;`;
  assertEquals(lostKeys(new Map([["1.sql", one], ["2.sql", two]]), ["2.sql"]), []);
  // A key named only in a comment is not a key.
  const commented = `CREATE OR REPLACE FUNCTION public.h(p int) RETURNS jsonb AS $fn$
    -- jsonb_build_object('a', 1) was the old shape
    SELECT jsonb_build_object('c', 1) $fn$ LANGUAGE sql;`;
  assertEquals(functionDefs(commented, "x.sql")[0].keys, new Set(["c"]));
  // A definition built inside EXECUTE is unknown, and is never compared.
  const dynamic = `DO $p$ BEGIN EXECUTE format('CREATE OR REPLACE FUNCTION public.h(p int) RETURNS jsonb AS %L', 'SELECT 1'); END $p$;`;
  assertEquals(functionDefs(dynamic, "d.sql")[0].keys, null);
  assertEquals(lostKeys(new Map([["1.sql", one], ["2.sql", dynamic]]), ["2.sql"]), []);
  // Rollbacks and drafts are not forward migrations.
  assertEquals(isForwardMigration("supabase/migrations/20261021160000_x_down.sql"), false);
  assertEquals(isForwardMigration("supabase/migrations/_drafts/20261021160000_x.sql"), false);
  assertEquals(isForwardMigration("supabase/migrations/20261021160000_x.sql"), true);
});

Deno.test("INT-18: nested and quoted keys are read", () => {
  assertEquals(
    jsonKeys(`jsonb_build_object('a', jsonb_build_object('b', 1, 'it''s', 2), 'c', 'not''a key')`).sort(),
    ["a", "b", "c", "it's"],
  );
});
