-- Thin rebuild guard (12 Oct 2026): a whole re-read that would replace a job's live notes with far
-- fewer of them is held for one more read instead of going live.
--
-- Why. The reader v3 trial (12 Oct 2026) read SWP-26354 three times from the same input and got 6, 16
-- and 33 notes, against 37 live. Each of those passes every check the store makes: a reading is
-- judged on how many of its own items were refused, never on how much it kept. So a 6-note read
-- would have replaced the 37-note live set and gone live. The v3 switch re-reads every live job this
-- way (532 live readings; the judge's reader_changed rebuild), so the guard lands first.
--
-- The owner's go (Marnin, 12 Oct 2026, recommendation 4 of the trial report: "a rebuild with far
-- fewer notes than the live set it replaces is kept as shadow for a second read"): "yes to all 10".
--
-- What it does:
--  1. context_ledger_thin_rebuild_policy(): the three numbers, changed only by migration:
--     min_live_items 10 (a live reading with fewer notes is never guarded), min_share 0.5 (a rebuild
--     keeping fewer than half the live reading's notes is thin; exactly half is not), max_holds 1
--     (thin readings held against one live reading before the next thin one settles it; 0 holds
--     none, so every thin reading is confirmed at once and the guard only records).
--  2. context_ledger_finish, on a build only, after the carry-forward and before the run closes:
--     a. Weighed only when the job has a live reading and this build passes its own checks. Both are
--        counted in items (notes), this build's after the live reading's person-locked items are
--        carried into it, as it would go live.
--     b. Thin and fewer than max_holds held against this live reading: held. It stays a shadow with
--        checks.passed false and checks.thin_rebuild (state held, reason thin_rebuild, items,
--        live_items, live_generation_id, the three numbers, held_before, at). store.pass keeps the
--        answer its own checks gave. The live reading stays live. The run is done with error
--        checks_failed, the store's existing word for a build that did not pass.
--     c. That is what makes the job due again, by the store's existing rules and no new one: the
--        one verdict (context_ledger_checks_pass reads checks.passed) keeps the go-live sweep from
--        promoting it (skipped checks_failed) and keeps it from answering the live reading's rebuild
--        in the judge, so the rebuild is still due; the run's checks_failed earns the backoff
--        (context_ledger_failures: 2 hours after the first), so it is read again later, in the
--        backfill hours like any rebuild.
--     d. Thin again with max_holds already held against the same live reading: settled. The fuller
--        of this reading and the fullest held one goes live, a tie to the newer. This one fuller or
--        equal: state confirmed, checks.passed true, promoted as any passing build (rule:auto). The
--        held one fuller: it is confirmed (checks.passed true, confirmed_by, confirmed_items,
--        confirmed_at) and promoted (rule:thin_rebuild), this one stays a shadow with state
--        passed_over and checks.passed false, and the run is clean. A reading promoted from the hold
--        has not read what landed since its claim; the judge asks for its update at once, as for any
--        live reading with newer evidence. Outside live mode nothing is promoted and the newer
--        reading is the one confirmed (the sweep takes only a job's newest shadow).
--     e. A second read that is not thin is promoted as any passing build; the held one stays a
--        shadow, older than the live reading, which the sweep never takes.
--     f. finish's answer gains thin_rebuild (the block stored), passed as stored, and
--        promoted_generation_id when the held reading went live, only when the guard weighed in.
--        Every other answer is as it was.
--
-- Why two thin reads settle it. A fresh read is often legitimately much shorter than a live set
-- that grew over many updates: SWF-261469 holds 95 live notes and every fresh read in the trial, v2
-- or v3, gave 36 to 44. Held for ever, that job would keep stale notes, because the judge asks for
-- the rebuild before any update. Two reads that both come back thin say the short count is the
-- reading, not a slip, and the fuller of the two is kept.
--
-- What it costs. A job whose first re-read is thin is read twice. 145 of the 532 live readings have
-- at least 10 notes and can be held (median 4 notes, largest 95); the rest are never guarded. A held
-- read counts in the scorecard's failed reads today (it reads the run's checks_failed) and as one
-- check-failed build toward the three that need a person.
--
-- Read only on production (12 Oct 2026, about 11:15 Perth): context_ledger_finish is the
-- 20261007160000 body (md5 110174bcd355a82568fd7bc572d414f6); ledger mode live, reader
-- luna-ledger:v2; 532 live readings, all by luna-ledger:v2; no stored reading carries
-- checks.thin_rebuild; context_ledger_thin_rebuild_policy does not exist.
--
-- Replaced body (guarded on its live production md5): context_ledger_finish, the 20261007160000
--   body word for word with the guard added (each addition marked "thin rebuild") and its comment
--   (the store's and the pass rule's names first). Added: context_ledger_thin_rebuild_policy.
-- Not changed: the update path of finish and its verdict line; context_ledger_checks_pass, the
--   judge, the due list, the failures, the claim, promote, the go-live sweep, the carry-forward, the
--   story and the reader. No row, run, flag or setting is written; nothing is promoted, demoted or
--   deleted by this migration.
-- Rollback: supabase/rollbacks/20261012110000_context_ledger_thin_rebuild_down.sql (the
--   20261007160000 body and comment word for word; the policy dropped; no row touched: a reading
--   held meanwhile stays a failed shadow and its job is re-read by the rules as they were).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Pre-image guard. Reports every mismatch at once.
DO $guard$
DECLARE problems text[] := '{}'; live text; f text; t text; x record;
BEGIN
 -- The one replaced body: the 20261007160000 body production runs, or this migration's (re-apply).
 SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.context_ledger_finish(uuid,uuid,uuid,text,jsonb)');
 IF live IS NULL OR NOT live = ANY(ARRAY['110174bcd355a82568fd7bc572d414f6', '1695e52f99f56534a24166f6662ced35']) THEN
  problems := problems || format('public.context_ledger_finish(uuid,uuid,uuid,text,jsonb) md5 %s', coalesce(live, '<missing>'));
 END IF;
 -- Read, never replaced: the body calls these.
 FOREACH f IN ARRAY ARRAY['public.context_ledger_checks_pass(jsonb)', 'public.context_ledger_current_generation(uuid)',
  'public.context_ledger_carry_forward(uuid,uuid)', 'public.context_ledger_promote(uuid,text)'] LOOP
  IF to_regprocedure(f) IS NULL THEN problems := problems || format('%s missing', f); END IF;
 END LOOP;
 -- The columns the guard reads and writes.
 FOREACH t IN ARRAY ARRAY['context_ledger_generations.status', 'context_ledger_generations.job_id', 'context_ledger_generations.checks',
   'context_ledger_generations.created_at', 'context_ledger_generations.updated_at', 'context_ledger_items.generation_id',
   'context_ledger_settings.mode'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass('public.' || split_part(t, '.', 1))
    AND a.attname = split_part(t, '.', 2) AND NOT a.attisdropped) THEN
   problems := problems || format('public.%s missing', t);
  END IF;
 END LOOP;
 -- New object: absent, or this migration's (comment marker).
 FOR x IN SELECT p.oid::regprocedure::text AS sig, coalesce(obj_description(p.oid, 'pg_proc'), '') AS c
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'context_ledger_thin_rebuild_policy' LOOP
  IF x.c NOT LIKE 'Thin rebuild guard (20261012110000)%' THEN
   problems := problems || format('%s exists and is not this migration''s', x.sig);
  END IF;
 END LOOP;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_ledger_thin_rebuild_preimage_mismatch: %; read the live definitions before replacing them',
   array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. The numbers, changed only by migration. A definer with the store's fixed path like every store
-- function that is not a per-row helper (finish reads it once per build).
CREATE OR REPLACE FUNCTION public.context_ledger_thin_rebuild_policy()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT jsonb_build_object(
  'min_live_items', 10,  -- a live reading with fewer notes than this is never guarded
  'min_share', 0.5,      -- a rebuild keeping fewer than this share of the live reading's notes is thin
  'max_holds', 1)        -- thin readings held against one live reading before the next thin one settles it
$$;
COMMENT ON FUNCTION public.context_ledger_thin_rebuild_policy() IS
 'Thin rebuild guard (20261012110000): the numbers context_ledger_finish reads when a build would replace a live reading, changed only by migration. min_live_items 10: a live reading with fewer notes (items) is never guarded. min_share 0.5: a build keeping fewer than this share of the live reading''s notes is thin (exactly the share is not). max_holds 1: thin readings held against one live reading before the next thin one settles it by the fuller of the two; 0 holds none (every thin reading is confirmed at once, and only recorded). Service role only.';

-- 2. finish: the 20261007160000 body production runs, word for word except the guard (each addition
-- marked "thin rebuild"): four more variables, the block after the carry-forward, the built run's
-- error line, the held reading's promotion and the answer's extra keys.
CREATE OR REPLACE FUNCTION public.context_ledger_finish(p_run_id uuid, p_lease_token uuid, p_generation_id uuid, p_outcome text, p_meta jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.context_extraction_runs; g public.context_ledger_generations; m jsonb := coalesce(p_meta, '{}'::jsonb);
 v_until timestamptz; v_rows integer; v_chunks integer; v_calls integer; v_tokens integer; v_failure text; v_model text; v_sha text;
 v_acc integer; v_ref integer; v_items integer; v_rate numeric; v_pass boolean; v_store jsonb; v_promoted boolean := false;
 v_carried integer := 0; v_live uuid; v_mode text; v_build boolean; v_checks jsonb; v_proposed integer; v_local integer;
 v_den integer; v_all_rate numeric; v_released boolean; v_code text; v_locked integer;
 -- (thin rebuild, 20261012110000)
 v_pol jsonb; v_live_items integer; v_new_items integer; v_holds integer; v_held uuid; v_held_items integer; v_thin jsonb;
 v_swap uuid;
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
 -- The verdict, at most half refused (owner ruling 9 Oct 2026): a refusal only
 -- drops that item, and every item kept passed its own checks, so a reading is
 -- hidden only when more than half of what was proposed, or more than half of
 -- what the store saw, was refused (20261007160000).
 v_pass := (v_local + v_ref) <= 0.5 * v_den AND v_ref <= 0.5 * (v_acc + v_ref);
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
 -- (thin rebuild, 20261012110000) A whole reading that would replace the live one and keeps far
 -- fewer notes than it is not put live on its own word: the same evidence has given 6, 16 and 33
 -- notes on three reads. Weighed only here (a build; an update adds to the reading it updates),
 -- only against a live reading, only when this reading passes its own checks, and counted after
 -- the carry-forward, as it would go live. Thin: the live reading has at least min_live_items notes
 -- and this one fewer than min_share of them (context_ledger_thin_rebuild_policy). A thin reading
 -- is held: it stays a shadow with checks.passed false (the one promotion verdict, so the go-live
 -- sweep and the judge leave it; store.pass keeps its own checks' answer) and its run ends
 -- checks_failed, so the job backs off and is read again. Once max_holds thin readings are held
 -- against the same live reading, the next thin one settles it: the fuller of it and the fullest
 -- held one goes live (a tie to the newer; outside live mode the newer, the only one the sweep
 -- takes). Nothing is deleted: the live reading is retired as on any promotion, and a reading
 -- passed over stays a shadow.
 IF v_live IS NOT NULL AND v_pass THEN
  v_pol := public.context_ledger_thin_rebuild_policy();
  SELECT st.mode INTO v_mode FROM public.context_ledger_settings st WHERE st.id;
  SELECT count(*) INTO v_live_items FROM public.context_ledger_items i WHERE i.generation_id = v_live;
  SELECT count(*) INTO v_new_items FROM public.context_ledger_items i WHERE i.generation_id = g.id;
  IF v_live_items >= (v_pol ->> 'min_live_items')::integer
   AND v_new_items < (v_pol ->> 'min_share')::numeric * v_live_items THEN
   -- the thin readings already held against this live reading, and the fullest of them
   SELECT count(*) INTO v_holds FROM public.context_ledger_generations h
   WHERE h.job_id = g.job_id AND h.status = 'shadow' AND h.id <> g.id AND h.checks #>> '{thin_rebuild,state}' = 'held'
    AND h.checks #>> '{thin_rebuild,live_generation_id}' = v_live::text;
   SELECT h.id, n.items INTO v_held, v_held_items FROM public.context_ledger_generations h
   CROSS JOIN LATERAL (SELECT count(*)::integer AS items FROM public.context_ledger_items i WHERE i.generation_id = h.id) n
   WHERE h.job_id = g.job_id AND h.status = 'shadow' AND h.id <> g.id AND h.checks #>> '{thin_rebuild,state}' = 'held'
    AND h.checks #>> '{thin_rebuild,live_generation_id}' = v_live::text
   ORDER BY n.items DESC, h.created_at DESC, h.id DESC LIMIT 1;
   v_thin := jsonb_build_object('items', v_new_items, 'live_items', v_live_items, 'live_generation_id', v_live,
    'min_share', v_pol -> 'min_share', 'min_live_items', v_pol -> 'min_live_items', 'max_holds', v_pol -> 'max_holds',
    'held_before', v_holds, 'at', now());
   IF v_holds < (v_pol ->> 'max_holds')::integer THEN
    v_thin := v_thin || jsonb_build_object('state', 'held', 'reason', 'thin_rebuild');
   ELSIF v_held IS NULL OR v_new_items >= v_held_items OR v_mode IS DISTINCT FROM 'live' THEN
    v_thin := v_thin || jsonb_build_object('state', 'confirmed', 'reason', 'thin_rebuild_confirmed')
     || CASE WHEN v_held IS NULL THEN '{}'::jsonb
         ELSE jsonb_build_object('held_generation_id', v_held, 'held_items', v_held_items) END;
   ELSE
    v_swap := v_held;
    v_thin := v_thin || jsonb_build_object('state', 'passed_over', 'reason', 'thin_rebuild_fuller_held',
     'held_generation_id', v_held, 'held_items', v_held_items);
   END IF;
   UPDATE public.context_ledger_generations SET updated_at = now(),
    checks = checks || jsonb_build_object('passed', v_thin ->> 'state' = 'confirmed', 'thin_rebuild', v_thin)
   WHERE id = g.id RETURNING checks INTO v_checks;
   IF v_swap IS NOT NULL THEN
    UPDATE public.context_ledger_generations SET updated_at = now(),
     checks = checks || jsonb_build_object('passed', true, 'thin_rebuild', (checks -> 'thin_rebuild')
      || jsonb_build_object('state', 'confirmed', 'reason', 'thin_rebuild_confirmed', 'confirmed_by', g.id,
       'confirmed_items', v_new_items, 'confirmed_at', now()))
    WHERE id = v_swap;
   END IF;
  END IF;
 END IF;
 -- A build that fails its checks counts toward the job's backoff; (thin rebuild, 20261012110000)
 -- so does a thin one that is held.
 UPDATE public.context_extraction_runs SET status = 'done', finished_at = now(), events_in = v_rows, tokens_in = v_tokens,
  facts_new = v_acc, error = CASE WHEN v_pass AND coalesce(v_thin ->> 'state', '') <> 'held' THEN NULL ELSE 'checks_failed' END,
  lease_expires_at = NULL WHERE id = r.id;
 SELECT st.mode INTO v_mode FROM public.context_ledger_settings st WHERE st.id;
 IF v_mode = 'live' AND public.context_ledger_checks_pass(v_checks) THEN
  PERFORM public.context_ledger_promote(g.id, 'rule:auto');
  v_promoted := true;
 END IF;
 -- (thin rebuild, 20261012110000) the fuller held reading goes live in this one's place
 IF v_swap IS NOT NULL THEN PERFORM public.context_ledger_promote(v_swap, 'rule:thin_rebuild'); END IF;
 RETURN jsonb_build_object('outcome', 'built', 'generation_status', CASE WHEN v_promoted THEN 'live' ELSE 'shadow' END,
  'promoted', v_promoted, 'carried', v_carried, 'passed', v_pass, 'checks', v_store, 'evidence_until', v_until)
  -- (thin rebuild, 20261012110000) only when the guard weighed in: the verdict as stored, and why
  || CASE WHEN v_thin IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('passed', public.context_ledger_checks_pass(v_checks), 'thin_rebuild', v_thin)
       || CASE WHEN v_swap IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('promoted_generation_id', v_swap) END END;
END $$;
COMMENT ON FUNCTION public.context_ledger_finish(uuid, uuid, uuid, text, jsonb) IS
 'Context ledger store (20261006013000), ledger pass rule (20261007160000): closes a ledger run. (Thin rebuild guard, 20261012110000) A build that would replace a live reading, passes its own checks and, counted after the carry-forward, keeps fewer than min_share of the live reading''s notes while the live one has at least min_live_items (context_ledger_thin_rebuild_policy: half and 10) is held, not promoted: it stays a shadow with checks.passed false (store.pass keeps its own checks'' answer) and checks.thin_rebuild (state held, reason thin_rebuild, both counts, the live generation), the live reading stays live, and its run is done with error checks_failed, so the job backs off and is read again. Once max_holds (1) thin readings are held against the same live reading the next thin one settles it: the fuller of it and the fullest held one goes live (a tie to the newer; state confirmed on the one that goes live, passed_over on the other, which stays a shadow; outside live mode the newer one is confirmed and waits for the sweep). A build that is not thin, a first reading (no live one) and every update are as before. Nothing is deleted. The answer carries thin_rebuild and the stored verdict as passed only when the guard weighed in. evidence_until is capped at the claim''s instant (the run''s started_at) and returned. The verdict, at most half refused (owner ruling 9 Oct 2026), counts both sides'' refusals: (p_meta.checks.refused_local + store refusals) / greatest(p_meta.checks.proposed, store accepted + refused, 1) at most 50%, the store''s own refusals at most 50% of what it saw, and for a build at least one item unless there was no evidence (a refused item is dropped on its own; a reading is hidden only when more than half was refused); it is stored as checks.passed (a build: its verdict; an update: the build''s and this update''s), and a run whose verdict fails is done with error checks_failed (it counts toward the backoff). The failed shadow readings by luna-ledger:v2 stored under the earlier 20% rule were judged again by this one once (checks.repassed_by), apart from those the owner''s direct re-judge of 9 Oct 2026 had already passed. built: the run''s building generation becomes shadow with the reader''s meta (model, prompt_sha256, evidence_until, evidence_rows, chunks, calls, checks), the live generation''s person-locked items are carried forward, and with mode live and checks.passed it is promoted. updated: the current generation''s evidence_until moves forward (never back), and a shadow is promoted on its first update with checks.passed once mode is live. failed: a building generation fails with the reason; a live or shadow one is untouched. A stop (p_meta.failure ledger_budget, model_cap, ledger_off, lane_off, paused, rate_limited, auth_required or worker_stopping) is released, not failed: error and failure released:<code>, never counted toward the backoff. A repeated finish of a closed run reports and changes nothing. Service role only.';

-- 3. Access: service role only (CREATE OR REPLACE keeps finish's grants; said again).
REVOKE ALL ON FUNCTION public.context_ledger_finish(uuid, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_finish(uuid, uuid, uuid, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.context_ledger_thin_rebuild_policy() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_thin_rebuild_policy() TO service_role;
