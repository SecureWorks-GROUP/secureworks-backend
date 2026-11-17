-- P2-02.1 undo: remove only the matcher storage and its switch.
SET LOCAL lock_timeout = '5s';
DROP TABLE IF EXISTS public.match_clues;
DROP TABLE IF EXISTS public.match_queue;
DROP TABLE IF EXISTS public.match_shadow_runs;
DROP TABLE IF EXISTS public.match_rules;
DROP TABLE IF EXISTS public.match_clue_types;
DELETE FROM public.feature_flags WHERE flag_name = 'reconcile_matcher_v1';
