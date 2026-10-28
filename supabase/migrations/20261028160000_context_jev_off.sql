-- Jev switched off (Jan, 28 Oct 2026).
--
-- The owner's word. Jan, 28 Oct 2026 (project thread "Build tiered notes reader and catch-up"):
-- "so then lets get rid of jev. thats fine." Measured that morning: at the ledger update gate Jev
-- agreed with the full reader on 68% of 1,626 compared readings since 7 Oct, and said "nothing
-- changed" on 382 of the 1,307 readings where something did (29%, against a 2% bar), so tier 1
-- (20261028010000) never skipped a reading. The catch-up backlog was already cleared without it.
--
-- What it does: every Jev switch in feature_flags is set off. The context worker (secureworks-jarvis,
-- docs/jev.md) reads context_jev_shadow_v1 at most once a minute; with it off nothing is built or
-- sent to TypeSafe at any decision point (placement, ledger update gate, reply owed and the five watch
-- points), and tier 1 skips nothing. The rows stay, so turning Jev back on is one update per flag.
-- The Jev log (context_jev_decisions) is kept as it is. The live reserve is not touched: catch-up
-- reads keep running at 100 / 100 (20261028010000).
--
-- Rollback: supabase/rollbacks/20261028160000_context_jev_off_down.sql (shadow and tier 1 back on).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
 IF to_regclass('public.feature_flags') IS NULL THEN
  RAISE EXCEPTION 'context_jev_off_preimage_mismatch: public.feature_flags is missing';
 END IF;
END $guard$;

UPDATE public.feature_flags
SET enabled = false, updated_at = now()
WHERE (flag_name = 'context_jev_shadow_v1'
    OR flag_name = 'context_jev_gate_decides_v1'
    OR flag_name LIKE 'context\_jev\_point\_%')
  AND enabled IS DISTINCT FROM false;
