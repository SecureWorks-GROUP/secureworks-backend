-- Saved job story: switch it on (Marnin, 29 Oct 2026 06:57Z: "storeis yes get it all live"; standing yes
-- to merges and deploys, 30 Oct 00:51Z).
--
-- context_job_story_text_v1 was created off by 20261009100000. With it on, the sweep queues a rewrite when
-- something new happens on a live job, and the Luna context worker (secureworks-jarvis) writes the story
-- with writer luna-story:v4 on the Codex subscription only (no fallback, no pay-per-use API). Each story is
-- one call from its own day cap (reserve_context_model_call phase story); staff can ask for a rewrite from
-- the job page. Money lines come from the database book (20261028190000), never from the model.
--
-- Merged only after the Railway context-luna-worker's newest successful deployment was confirmed built
-- from jarvis d8edd93 or later: the v3 writer never saves money_sig, so the sweep would keep rewriting
-- its stories (AGENTS.md, "The Saved Job Story Is Fresh By Its Digest").
--
-- Off switch, at once: update public.feature_flags set enabled=false where flag_name='context_job_story_text_v1';
-- Rollback: supabase/rollbacks/20261030030000_context_job_story_text_on_down.sql.

DO $on$
DECLARE n integer;
BEGIN
  UPDATE public.feature_flags
     SET enabled = true,
         description = 'Saved job story (20261009100000): while on, the Luna context worker (secureworks-jarvis) writes the short story of each live job (five plain sections from the job card and live AI notes, every amount and date checked against them), rewrites it when something new happens, and staff can ask for a rewrite from the job page. Each story is one model call from the shared day (reserve_context_model_call phase story: at most context_job_story_text_policy() calls_per_day a Perth day, never inside the ledger''s live reserve). Off: nothing is queued, claimed or called, and the job page shows no saved story. Switched on 30 Oct 2026 on Marnin''s word (20261030030000).',
         updated_at = now()
   WHERE flag_name = 'context_job_story_text_v1';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'context_job_story_text_on: expected one context_job_story_text_v1 row, found %', n;
  END IF;
END $on$;
