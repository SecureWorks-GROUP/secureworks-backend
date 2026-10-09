-- Ledger pass floor (9 Oct 2026): a small reading may lose up to 2 items to refusals, and up to 1 to
-- the store, and still pass; the readings the old share hid are judged again.
--
-- Why. The store judges a whole reading when its run finishes (context_ledger_finish). It passed a
-- reading only when the refusals on both sides, the reader's own validator's and the store's, were at
-- most 20% of what was proposed, and the store's own at most 20% of what it saw. Every item the store
-- keeps has already passed its own word-for-word citation check, so a refusal only drops an item; it
-- never lets a wrong one in. On a small job one refusal is already 20% and two are 40%, so a reading of
-- 5 items with 2 refused failed whole: it stayed a hidden shadow, its good items were never shown, the
-- run counted toward the job's backoff and the job was due to be read again from scratch.
--
-- What it does (owner approved, 9 Oct: live with fewer checks):
--  1. context_ledger_finish, its verdict line only:
--     before: v_pass := (v_local + v_ref) <= 0.2 * v_den AND v_ref <= 0.2 * (v_acc + v_ref);
--     after:  v_pass := (v_local + v_ref) <= greatest(2, 0.2 * v_den) AND v_ref <= greatest(1, 0.2 * (v_acc + v_ref));
--     Up to 2 refused items in all, and up to 1 refused by the store, never fail a reading by share;
--     from 10 items proposed (5 the store saw) up, each share is the 20% it was. Every other condition
--     stays: a build that read evidence still needs at least one item, an update is judged by the same
--     line and its verdict still combines with its build's, and the rates the store records
--     (refusal_rate, refused_rate) are unchanged. Its comment says so.
--  2. The readings already stored are judged again by the new line, once. A shadow generation by
--     luna-ledger:v2 whose checks.passed is false passes now when the old line explains every verdict
--     stored on it from the counts finish stored with it (checks.store: proposed, refused_local,
--     items_accepted, items_refused, items, evidence_rows; and after an update checks.last_update's
--     proposed, refused_local, items_accepted, items_refused), and the new line passes it with the item
--     condition still holding. It gets checks.passed true, store.pass true (and last_update.pass true
--     after an update, so its next update combines with a passing build), and the audit keys
--     repassed_by ('migration 20261007160000: pass floor'), repassed_at and repassed_from (the verdicts
--     it had). Its counts and rates stay as stored. A reading whose verdicts the counts do not explain,
--     or whose counts are missing, is left alone, and so is every live, retired, failed or building
--     generation and every other reader's. Nothing is promoted here: a re-judged reading goes live only
--     the way any passing shadow does (context_ledger_promote, promote_shadow once the lane is live, or
--     finish on its next clean update in live mode). The runs keep their recorded error, so a job's
--     backoff clock is as it was.
--
-- Read only on production (9 Oct 2026, about 10:06 Perth; ledger mode shadow, reader luna-ledger:v2,
-- running, so these move until the migration applies, and it judges whatever is a shadow then):
--  - 74 shadow readings by luna-ledger:v2: 28 passed, 46 failed. 19 of the 46 fail only on the 20%
--    share and pass the new line: 18 builds (1 of 2, 1 of 3, 1 of 4, 2 of 3, 2 of 6, 2 of 7 or 2 of 9
--    items refused by the reader's own validator, none by the store) and 1 passing build whose last
--    update had 1 of 3 refused. 16 of the 19 are their job's current reading, 2 are newer than their
--    job's live reading and 1 is older. The other 27 still fail: 7 kept no item though they read
--    evidence, 19 have 3 or more of the reader's own refusals and over 20%, and on 1 the store refused
--    3 of 8.
--  - Every stored verdict on those 46 is exactly the old line's on its stored counts.
--
-- Replaced body (guarded on its live production md5, the 20261006013000 body): context_ledger_finish,
--   its verdict line (with a comment added above it), and its comment (the store's name first).
-- Not changed: every other line of finish; context_ledger_checks_pass (it reads checks.passed), the
--   judge, the backoff, the write, promote and the reader. No run, flag or setting is written.
-- Rollback: supabase/rollbacks/20261007160000_context_ledger_pass_floor_down.sql (the 20261006013000
--   body and comment word for word; each reading this judged again that is still a shadow is judged
--   again by the old line on its stored counts and loses its audit keys; a reading promoted since is
--   left as it is).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[] := '{}'; live text; f text; t text;
BEGIN
 -- The one replaced body: the 20261006013000 body production runs, or this migration's (re-apply).
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)');
 IF live IS NULL OR NOT live = ANY(ARRAY['0c02a410bb32f46315fbf278090ef60e', '24fdd0673f8692c082cf9d19c22ab210']) THEN
  problems := problems || format('public.context_ledger_finish(uuid,uuid,uuid,text,jsonb) md5 %s', coalesce(live, '<missing>'));
 END IF;
 -- Read, never replaced: the body and the re-judge call these.
 FOREACH f IN ARRAY ARRAY['public.context_ledger_checks_pass(jsonb)', 'public.context_ledger_current_generation(uuid)',
  'public.context_ledger_carry_forward(uuid,uuid)', 'public.context_ledger_promote(uuid,text)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 -- The columns the re-judge reads and writes.
 FOREACH t IN ARRAY ARRAY['context_ledger_generations.status', 'context_ledger_generations.reader',
   'context_ledger_generations.checks', 'context_ledger_generations.updated_at'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
    AND a.attname = split_part(t, '.', 2) AND NOT a.attisdropped) THEN
   problems := problems || format('public.%s missing', t);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_ledger_pass_floor_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The verdict: the 20261006013000 body production runs, word for word except its verdict line and
-- the comment added above it.
CREATE OR REPLACE FUNCTION public.context_ledger_finish(p_run_id uuid, p_lease_token uuid, p_generation_id uuid, p_outcome text, p_meta jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.context_extraction_runs; g public.context_ledger_generations; m jsonb := coalesce(p_meta, '{}'::jsonb);
 v_until timestamptz; v_rows integer; v_chunks integer; v_calls integer; v_tokens integer; v_failure text; v_model text; v_sha text;
 v_acc integer; v_ref integer; v_items integer; v_rate numeric; v_pass boolean; v_store jsonb; v_promoted boolean := false;
 v_carried integer := 0; v_live uuid; v_mode text; v_build boolean; v_checks jsonb; v_proposed integer; v_local integer;
 v_den integer; v_all_rate numeric; v_released boolean; v_code text; v_locked integer;
BEGIN
 IF p_run_id IS NULL OR p_lease_token IS NULL OR p_generation_id IS NULL OR p_outcome IS NULL
  OR p_outcome NOT IN ('built', 'updated', 'failed') OR jsonb_typeof(m) <> 'object' THEN
  RAISE EXCEPTION 'context_ledger_finish_invalid';
 END IF;
 SELECT * INTO r FROM public.context_extraction_runs WHERE id = p_run_id FOR UPDATE;
 IF r.id IS NULL OR r.phase <> 'ledger' THEN RAISE EXCEPTION 'context_ledger_finish_invalid'; END IF;
 SELECT * INTO g FROM public.context_ledger_generations WHERE id = p_generation_id FOR UPDATE;
 IF g.id IS NULL OR g.job_id IS DISTINCT FROM r.job_id THEN RETURN jsonb_build_object('outcome', 'refused', 'reason', 'generation_mismatch'); END IF;
 -- A repeated finish after the first one closed the run: report, change nothing.
 IF r.status IN ('done', 'failed') AND r.lease_token = p_lease_token THEN
  RETURN jsonb_build_object('outcome', p_outcome, 'replayed', true, 'run_status', r.status, 'generation_status', g.status,
   'promoted', g.status = 'live');
 END IF;
 IF r.lease_token IS DISTINCT FROM p_lease_token OR r.status <> 'running' OR r.lease_expires_at IS NULL OR r.lease_expires_at <= now() THEN
  RETURN jsonb_build_object('outcome', 'lease_lost');
 END IF;
 v_build := g.status = 'building' AND g.run_id = p_run_id;
 IF NOT (v_build OR (g.id = public.context_ledger_current_generation(r.job_id)
   AND NOT EXISTS (SELECT 1 FROM public.context_ledger_generations b WHERE b.run_id = p_run_id)))
  OR (p_outcome = 'built' AND NOT v_build) OR (p_outcome = 'updated' AND v_build) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'generation_mismatch');
 END IF;
 BEGIN
  v_until := (m ->> 'evidence_until')::timestamptz;
  v_rows := greatest(0, coalesce((m ->> 'evidence_rows')::integer, 0));
  v_chunks := greatest(0, coalesce((m ->> 'chunks')::integer, 0));
  v_calls := greatest(0, coalesce((m ->> 'calls')::integer, 0));
  v_tokens := greatest(0, coalesce((m ->> 'tokens_in')::integer, 0));
  -- The reader's own count of what it proposed and what it refused before the
  -- store saw it: the promotion verdict counts both sides' refusals.
  v_proposed := greatest(0, coalesce((m #>> '{checks,proposed}')::integer, 0));
  v_local := greatest(0, coalesce((m #>> '{checks,refused_local}')::integer, 0));
 EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'invalid_meta', 'detail', left(SQLERRM, 200));
 END;
 v_model := left(nullif(btrim(m ->> 'model'), ''), 80);
 v_sha := CASE WHEN m ->> 'prompt_sha256' ~ '^[0-9a-f]{64}$' THEN m ->> 'prompt_sha256' END;
 v_failure := left(coalesce(nullif(btrim(m ->> 'failure'), ''), 'failed'), 190);
 IF p_outcome <> 'failed' AND (v_until IS NULL OR v_until > now()) THEN
  RETURN jsonb_build_object('outcome', 'refused', 'reason', 'invalid_meta', 'detail', 'evidence_until is required and not in the future');
 END IF;
 -- The reader cannot have read what landed after its claim: cap at the claim's instant.
 v_until := least(v_until, r.started_at);
 IF p_outcome = 'failed' THEN
  -- A stop is not a failure: the worker ran out of budget, was switched off,
  -- paused, rate limited, logged out or stopped. The run and a building
  -- generation are released and never count toward the backoff.
  v_released := v_failure IN ('ledger_budget', 'model_cap', 'ledger_off', 'lane_off', 'paused', 'rate_limited',
   'auth_required', 'worker_stopping');
  v_code := CASE WHEN v_released THEN 'released:' || v_failure ELSE v_failure END;
  IF v_build THEN
   UPDATE public.context_ledger_generations SET status = 'failed', failure = v_code, finished_at = now(), updated_at = now(),
    model = coalesce(v_model, model), chunks = v_chunks, calls = v_calls WHERE id = g.id;
  END IF;
  UPDATE public.context_extraction_runs SET status = 'failed', error = v_code, finished_at = now(), tokens_in = v_tokens,
   lease_expires_at = NULL WHERE id = r.id;
  RETURN jsonb_build_object('outcome', 'failed', 'released', v_released, 'generation_status', CASE WHEN v_build THEN 'failed' ELSE g.status END,
   'promoted', false);
 END IF;
 SELECT coalesce(sum(w.items_accepted), 0), coalesce(sum(w.items_refused), 0),
  coalesce(sum((SELECT count(*) FROM jsonb_array_elements(coalesce(w.result -> 'refused', '[]'::jsonb)) x
                WHERE x ->> 'code' = 'person_locked')), 0)
 INTO v_acc, v_ref, v_locked
 FROM public.context_ledger_writes w WHERE w.run_id = p_run_id AND w.generation_id = g.id;
 -- A matter a person already settled, proposed again, is refused to keep the
 -- person's word; it is not a reading fault, so it never counts against the verdict.
 v_ref := greatest(v_ref - v_locked, 0);
 SELECT count(*) INTO v_items FROM public.context_ledger_items i WHERE i.generation_id = g.id;
 v_rate := CASE WHEN v_acc + v_ref = 0 THEN 0 ELSE trim_scale(round(v_ref::numeric / (v_acc + v_ref), 4)) END;
 -- Refusals on both sides over everything proposed: the reader's local refusals
 -- plus the store's, over the larger of what the reader proposed and what the
 -- store saw.
 v_den := greatest(v_proposed, v_acc + v_ref, 1);
 v_all_rate := trim_scale(round((v_local + v_ref)::numeric / v_den, 4));
 -- (ledger pass floor, 20261007160000) a refusal only drops an item, so a small
 -- reading may lose up to 2 items in all and up to 1 to the store; from 10 items
 -- proposed (5 the store saw) up, each share is the 20% it was.
 v_pass := (v_local + v_ref) <= greatest(2, 0.2 * v_den) AND v_ref <= greatest(1, 0.2 * (v_acc + v_ref));
 IF p_outcome = 'updated' THEN
  IF g.evidence_until IS NOT NULL AND v_until < g.evidence_until THEN
   RETURN jsonb_build_object('outcome', 'refused', 'reason', 'evidence_until_backwards');
  END IF;
  -- The one verdict: the build passed and this update is clean.
  UPDATE public.context_ledger_generations SET evidence_until = v_until, chunks = chunks + v_chunks, calls = calls + v_calls,
   updated_at = now(), checks = checks || jsonb_build_object(
    'passed', coalesce((checks #>> '{store,pass}')::boolean, false) AND v_pass,
    'last_update', jsonb_build_object('run_id', r.id, 'at', now(), 'items_accepted', v_acc, 'items_refused', v_ref,
     'proposed', v_proposed, 'refused_local', v_local, 'refused_rate', v_rate, 'refusal_rate', v_all_rate,
     'refused_person_locked', v_locked, 'evidence_rows', v_rows, 'pass', v_pass, 'reader', m -> 'checks'))
  WHERE id = g.id RETURNING checks INTO v_checks;
  UPDATE public.context_extraction_runs SET status = 'done', finished_at = now(), events_in = v_rows, tokens_in = v_tokens,
   facts_new = v_acc, error = CASE WHEN v_pass THEN NULL ELSE 'checks_failed' END, lease_expires_at = NULL WHERE id = r.id;
  -- A shadow kept current while the lane was in shadow is promoted on its
  -- first update after the lane goes live, if the verdict holds
  -- (context_ledger_checks_pass reads checks.passed).
  SELECT st.mode INTO v_mode FROM public.context_ledger_settings st WHERE st.id;
  IF v_mode = 'live' AND g.status = 'shadow' AND public.context_ledger_checks_pass(v_checks) THEN
   PERFORM public.context_ledger_promote(g.id, 'rule:auto');
   v_promoted := true;
  END IF;
  RETURN jsonb_build_object('outcome', 'updated', 'generation_status', CASE WHEN v_promoted THEN 'live' ELSE g.status END,
   'promoted', v_promoted, 'items_accepted', v_acc, 'items_refused', v_ref, 'passed', (v_checks ->> 'passed')::boolean,
   'evidence_until', v_until);
 END IF;
 -- built: the verdict also needs at least one item unless there was no evidence.
 v_pass := v_pass AND (v_items >= 1 OR v_rows = 0);
 v_store := jsonb_build_object('items', v_items, 'items_accepted', v_acc, 'items_refused', v_ref, 'refused_rate', v_rate,
  'proposed', v_proposed, 'refused_local', v_local, 'refusal_rate', v_all_rate, 'refused_person_locked', v_locked,
  'evidence_rows', v_rows, 'pass', v_pass);
 UPDATE public.context_ledger_generations SET status = 'shadow', model = v_model, prompt_sha256 = v_sha, evidence_until = v_until,
  evidence_rows = v_rows, chunks = v_chunks, calls = v_calls, finished_at = now(), updated_at = now(),
  checks = jsonb_build_object('passed', v_pass, 'store', v_store, 'reader', coalesce(m -> 'checks', 'null'::jsonb))
 WHERE id = g.id RETURNING checks INTO v_checks;
 SELECT id INTO v_live FROM public.context_ledger_generations WHERE job_id = g.job_id AND status = 'live';
 IF v_live IS NOT NULL THEN v_carried := public.context_ledger_carry_forward(v_live, g.id); END IF;
 -- A build that fails its checks counts toward the job's backoff.
 UPDATE public.context_extraction_runs SET status = 'done', finished_at = now(), events_in = v_rows, tokens_in = v_tokens,
  facts_new = v_acc, error = CASE WHEN v_pass THEN NULL ELSE 'checks_failed' END, lease_expires_at = NULL WHERE id = r.id;
 SELECT st.mode INTO v_mode FROM public.context_ledger_settings st WHERE st.id;
 IF v_mode = 'live' AND public.context_ledger_checks_pass(v_checks) THEN
  PERFORM public.context_ledger_promote(g.id, 'rule:auto');
  v_promoted := true;
 END IF;
 RETURN jsonb_build_object('outcome', 'built', 'generation_status', CASE WHEN v_promoted THEN 'live' ELSE 'shadow' END,
  'promoted', v_promoted, 'carried', v_carried, 'passed', v_pass, 'checks', v_store, 'evidence_until', v_until);
END $$;
COMMENT ON FUNCTION public.context_ledger_finish(uuid, uuid, uuid, text, jsonb) IS
 'Context ledger store (20261006013000), ledger pass floor (20261007160000): closes a ledger run. evidence_until is capped at the claim''s instant (the run''s started_at) and returned. The verdict counts both sides'' refusals: p_meta.checks.refused_local + store refusals at most 20% of greatest(p_meta.checks.proposed, store accepted + refused, 1) or 2, whichever is more, the store''s own refusals at most 20% of what it saw or 1, whichever is more (the pass floor, 20261007160000: a refusal only drops an item, so a small reading may lose up to 2 items in all and 1 to the store; from 10 items proposed, and 5 the store saw, up each share is the 20% it was), and for a build at least one item unless there was no evidence; it is stored as checks.passed (a build: its verdict; an update: the build''s and this update''s), and a run whose verdict fails is done with error checks_failed (it counts toward the backoff). The shadow readings by luna-ledger:v2 stored before the floor were judged again by it once (checks.repassed_by). built: the run''s building generation becomes shadow with the reader''s meta (model, prompt_sha256, evidence_until, evidence_rows, chunks, calls, checks), the live generation''s person-locked items are carried forward, and with mode live and checks.passed it is promoted. updated: the current generation''s evidence_until moves forward (never back), and a shadow is promoted on its first update with checks.passed once mode is live. failed: a building generation fails with the reason; a live or shadow one is untouched. A stop (p_meta.failure ledger_budget, model_cap, ledger_off, lane_off, paused, rate_limited, auth_required or worker_stopping) is released, not failed: error and failure released:<code>, never counted toward the backoff. A repeated finish of a closed run reports and changes nothing. Service role only.';

-- 2. The readings already stored, judged again by the new line once. A failed shadow reading by
-- luna-ledger:v2 passes when the old line explains every verdict stored on it (finish wrote them from
-- these counts) and the new line passes it, the item condition still holding. Its counts and rates
-- stay; it carries the audit keys. Nothing else is written: no live, retired, failed or building
-- generation, no other reader's, no run. A reading changed since it was read here is left alone.
DO $rejudge$
DECLARE v_flipped integer; v_updates integer;
BEGIN
 WITH c AS (  -- each failed shadow reading by luna-ledger:v2, with its stored counts (a whole number, else null)
  SELECT g.id, g.checks, (g.checks -> 'last_update') IS NOT NULL AS upd,
   CASE WHEN jsonb_typeof(g.checks -> 'passed') = 'boolean' THEN (g.checks ->> 'passed')::boolean END AS passed,
   CASE WHEN jsonb_typeof(g.checks #> '{store,pass}') = 'boolean' THEN (g.checks #>> '{store,pass}')::boolean END AS build_pass,
   CASE WHEN jsonb_typeof(g.checks #> '{last_update,pass}') = 'boolean' THEN (g.checks #>> '{last_update,pass}')::boolean END AS update_pass,
   CASE WHEN g.checks #>> '{store,proposed}' ~ '^[0-9]{1,9}$' THEN (g.checks #>> '{store,proposed}')::integer END AS p,
   CASE WHEN g.checks #>> '{store,refused_local}' ~ '^[0-9]{1,9}$' THEN (g.checks #>> '{store,refused_local}')::integer END AS l,
   CASE WHEN g.checks #>> '{store,items_accepted}' ~ '^[0-9]{1,9}$' THEN (g.checks #>> '{store,items_accepted}')::integer END AS a,
   CASE WHEN g.checks #>> '{store,items_refused}' ~ '^[0-9]{1,9}$' THEN (g.checks #>> '{store,items_refused}')::integer END AS r,
   CASE WHEN g.checks #>> '{store,items}' ~ '^[0-9]{1,9}$' THEN (g.checks #>> '{store,items}')::integer END AS items,
   CASE WHEN g.checks #>> '{store,evidence_rows}' ~ '^[0-9]{1,9}$' THEN (g.checks #>> '{store,evidence_rows}')::integer END AS ev,
   CASE WHEN g.checks #>> '{last_update,proposed}' ~ '^[0-9]{1,9}$' THEN (g.checks #>> '{last_update,proposed}')::integer END AS up,
   CASE WHEN g.checks #>> '{last_update,refused_local}' ~ '^[0-9]{1,9}$' THEN (g.checks #>> '{last_update,refused_local}')::integer END AS ul,
   CASE WHEN g.checks #>> '{last_update,items_accepted}' ~ '^[0-9]{1,9}$' THEN (g.checks #>> '{last_update,items_accepted}')::integer END AS ua,
   CASE WHEN g.checks #>> '{last_update,items_refused}' ~ '^[0-9]{1,9}$' THEN (g.checks #>> '{last_update,items_refused}')::integer END AS ur
  FROM public.context_ledger_generations g
  WHERE g.status = 'shadow' AND g.reader = 'luna-ledger:v2' AND NOT public.context_ledger_checks_pass(g.checks)
 ), v AS (  -- the verdicts the old line gave and the new line gives on those counts (null when a count is missing)
  SELECT c.*,
   (c.l + c.r) <= 0.2 * greatest(c.p, c.a + c.r, 1) AND c.r <= 0.2 * (c.a + c.r) AND (c.items >= 1 OR c.ev = 0) AS build_old,
   (c.l + c.r) <= greatest(2, 0.2 * greatest(c.p, c.a + c.r, 1)) AND c.r <= greatest(1, 0.2 * (c.a + c.r))
    AND (c.items >= 1 OR c.ev = 0) AS build_new,
   (c.ul + c.ur) <= 0.2 * greatest(c.up, c.ua + c.ur, 1) AND c.ur <= 0.2 * (c.ua + c.ur) AS update_old,
   (c.ul + c.ur) <= greatest(2, 0.2 * greatest(c.up, c.ua + c.ur, 1)) AND c.ur <= greatest(1, 0.2 * (c.ua + c.ur)) AS update_new
  FROM c
 ), u AS (
  UPDATE public.context_ledger_generations g SET updated_at = now(),
   checks = g.checks || jsonb_build_object('passed', true, 'store', (g.checks -> 'store') || '{"pass": true}'::jsonb)
    || CASE WHEN v.upd THEN jsonb_build_object('last_update', (g.checks -> 'last_update') || '{"pass": true}'::jsonb) ELSE '{}'::jsonb END
    || jsonb_build_object('repassed_by', 'migration 20261007160000: pass floor', 'repassed_at', now(),
     'repassed_from', jsonb_build_object('passed', v.passed, 'store_pass', v.build_pass)
      || CASE WHEN v.upd THEN jsonb_build_object('last_update_pass', v.update_pass) ELSE '{}'::jsonb END)
  FROM v
  WHERE g.id = v.id AND g.checks = v.checks   -- unchanged since it was read
   -- the old line explains every stored verdict: the build's, the last update's, and the failure
   AND v.passed IS FALSE
   AND v.build_old IS NOT NULL AND v.build_pass IS NOT DISTINCT FROM v.build_old
   AND (NOT v.upd OR (v.update_old IS NOT NULL AND v.update_pass IS NOT DISTINCT FROM v.update_old))
   AND NOT (v.build_old AND (NOT v.upd OR v.update_old))
   -- and the new line passes it, every other condition still holding
   AND v.build_new AND (NOT v.upd OR v.update_new)
  RETURNING v.upd
 )
 SELECT count(*), count(*) FILTER (WHERE u.upd) INTO v_flipped, v_updates FROM u;
 RAISE NOTICE 'ledger pass floor: % shadow luna-ledger:v2 readings judged again and passed (% of them on their last update)',
  v_flipped, v_updates;
END $rejudge$;

-- 3. Access: service role only (CREATE OR REPLACE keeps the grants; said again).
REVOKE ALL ON FUNCTION public.context_ledger_finish(uuid, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_finish(uuid, uuid, uuid, text, jsonb) TO service_role;
