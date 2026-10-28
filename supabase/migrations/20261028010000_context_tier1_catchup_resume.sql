-- Tiered notes reader, and catch-up reads resumed (Jan, 27 to 28 Oct 2026).
--
-- The owner's word. Jan, 27 Oct 2026: the ChatGPT subscription logins stay and their 1,000 calls a
-- day is a limit to design around; the reader is tiered (rules first, then a cheap first pass, then
-- the full read on the ChatGPT logins only where something changed); catch-up reading resumes now.
-- Jan, 28 Oct 2026 (project chat): "yeah go for it - i just have jev for right now", so the first
-- pass is Jev (TypeSafe, jev-1.13.0), already in shadow at the ledger update gate since 7 Oct.
--
-- What it does.
--  1. feature_flags.context_jev_gate_decides_v1, created ON. The context worker (secureworks-jarvis
--     src/automation/jev-shadow.ts, docs/jev.md "Tier 1") reads it: with it on, and only while
--     context_jev_shadow_v1 is on too and Jev's own record in context_jev_agreement clears the bar
--     (0.90-1.00 band: at least 500 compared answers since 7 Oct, unsafe at most 2% of the readings
--     that changed something, over the lifetime and the last 14 days), an update reading Jev is sure
--     (0.9 or more) changes nothing finishes with no model call. Never a build, never a reading with a
--     reply-owed candidate, and one skip-ready reading in ten is read in full anyway. Until the record
--     clears the bar the flag changes nothing: Jev keeps watching. A worker without that code never
--     reads the flag.
--  2. The live reserve back to its seeded 100 calls a day and 100 before noon
--     (context_cadence_settings, 20261005233000), lowering only: a reserve already at or under 100 is
--     left as it is. Catch-up and backlog reads, the ledger included, get the day's calls above the
--     reserve again (1,000 - 100 = 900; 750 - 100 = 650 before noon). Live reads keep their 100 and
--     at least two reads a job. Nothing else in the cadence, the caps or the catch-up list changes.
--
-- Off switches, at once:
--   update public.feature_flags set enabled = false, updated_at = now() where flag_name = 'context_jev_gate_decides_v1';
--   update public.context_cadence_settings set live_reserve_calls_day = 1000, live_reserve_calls_morning = 750,
--    updated_at = now(), note = '<who and why>' where id;   -- catch-up paused again
-- Rollback: supabase/rollbacks/20261028010000_context_tier1_catchup_resume_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
 IF to_regclass('public.feature_flags') IS NULL THEN
  RAISE EXCEPTION 'context_tier1_catchup_resume_preimage_mismatch: public.feature_flags is missing';
 END IF;
 IF to_regclass('public.context_cadence_settings') IS NULL THEN
  RAISE EXCEPTION 'context_tier1_catchup_resume_preimage_mismatch: public.context_cadence_settings is missing (20261005233000)';
 END IF;
 IF to_regclass('public.context_jev_decisions') IS NULL OR to_regprocedure('public.context_jev_agreement(timestamptz,timestamptz)') IS NULL THEN
  RAISE EXCEPTION 'context_tier1_catchup_resume_preimage_mismatch: the Jev decisions log is missing (20261006080000)';
 END IF;
END $guard$;

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'context_jev_gate_decides_v1', true,
 'Tier 1 of the notes reader (20261028010000, Jan 27-28 Oct 2026): with this and context_jev_shadow_v1 on, and Jev''s gate record in context_jev_agreement over the bar (docs/jev.md "Tier 1" in secureworks-jarvis), an update reading Jev is sure changes nothing is finished with no ChatGPT-login call. Never a build or a reading with a reply-owed candidate; one in ten read anyway. Off: nothing is skipped.'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_jev_gate_decides_v1');

INSERT INTO public.context_cadence_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
UPDATE public.context_cadence_settings
SET live_reserve_calls_day = least(live_reserve_calls_day, 100),
    live_reserve_calls_morning = least(live_reserve_calls_morning, 100),
    updated_at = now(),
    note = 'Catch-up reads resumed on Jan''s word, 27-28 Oct 2026 (20261028010000); was day ' || live_reserve_calls_day
      || ', morning ' || live_reserve_calls_morning || '.'
WHERE id AND (live_reserve_calls_day > 100 OR live_reserve_calls_morning > 100);
