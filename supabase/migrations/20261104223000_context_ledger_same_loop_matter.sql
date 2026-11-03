-- (finish line C4, blind notes round 2 of 3 Nov 2026) One loop across types on the very same matter.
--
-- The notes reader's duplicate rule (context_ledger_same_loop, 20261104050000) takes one loop written twice only within
-- one type, or an ask and the matching promise. Round 2's graders found two pairs it refused that are one loop by the
-- owner's decision of 3 Nov 2026 ("same matter, same owing side; never across payers or jobs"): a customer's claim and
-- ask about one invoice, and a customer's ask and hold for one install day, each between the same two sides. The reader's
-- own guard is widened the same way behind its switch (secureworks-jarvis #298, context_ledger_c4_rest_v1, off); this is
-- the store's half, so the store takes what the reader's guard takes.
--
-- Change: context_ledger_same_loop also takes two notes of the loop types commitment, request, claim, constraint and
-- dependency (never an issue, whose complaint proof would fall away, and never an agreement) when both name the same
-- about_key, not null. Every other condition is unchanged: the same owing side and the same other side, both known, and
-- for money the same about. context_ledger_write is not changed (it already calls this function).
-- No row is written or changed. The reader sends such a pair only with its switch on.
-- Guard: the live function must be the 20261104050000 definition (md5 d105e91c2c30b2141d424bb53f7d6106, read on
-- production 3 Nov 2026 19:59Z) or already this one (its comment starts with "(20261104223000)").
-- Rollback: supabase/rollbacks/20261104223000_context_ledger_same_loop_matter_down.sql.
SET LOCAL lock_timeout = '5s';

DO $guard$ BEGIN
  IF md5(pg_get_functiondef('public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)'::regprocedure)) <> 'd105e91c2c30b2141d424bb53f7d6106'
     AND coalesce(obj_description('public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)'::regprocedure, 'pg_proc'), '') NOT LIKE '(20261104223000)%' THEN
    RAISE EXCEPTION 'context_ledger_same_loop is not the definition this migration was written against (md5 %)',
      md5(pg_get_functiondef('public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)'::regprocedure));
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.context_ledger_same_loop(a public.context_ledger_items, b public.context_ledger_items)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT coalesce(
  a.item_type IN ('commitment','request','claim','issue','constraint','dependency')
  AND b.item_type IN ('commitment','request','claim','issue','constraint','dependency')
  AND (a.item_type = b.item_type OR (a.item_type IN ('commitment','request') AND b.item_type IN ('commitment','request'))
       OR (a.about_key IS NOT NULL AND a.about_key = b.about_key
           AND a.item_type IN ('commitment','request','claim','constraint','dependency')
           AND b.item_type IN ('commitment','request','claim','constraint','dependency')))
  AND CASE WHEN a.item_type = 'commitment' THEN a.from_role ELSE a.to_role END NOT IN ('unknown')
  AND CASE WHEN a.item_type = 'commitment' THEN a.to_role ELSE a.from_role END NOT IN ('unknown')
  AND CASE WHEN a.item_type = 'commitment' THEN a.from_role ELSE a.to_role END = CASE WHEN b.item_type = 'commitment' THEN b.from_role ELSE b.to_role END
  AND CASE WHEN a.item_type = 'commitment' THEN a.to_role ELSE a.from_role END = CASE WHEN b.item_type = 'commitment' THEN b.to_role ELSE b.from_role END
  AND (NOT (coalesce(a.closes_on, '') = 'payment' OR coalesce(b.closes_on, '') = 'payment'
            OR coalesce(a.about_key, '') ~ '^(invoice|payment):' OR coalesce(b.about_key, '') ~ '^(invoice|payment):')
       OR a.about_key = b.about_key), false)
$$;
COMMENT ON FUNCTION public.context_ledger_same_loop(public.context_ledger_items, public.context_ledger_items) IS
 '(20261104223000) Whether two ledger notes may be one loop written twice: both loops, the same type, or an ask and the matching promise, or (20261104223000) two of commitment, request, claim, constraint and dependency on the very same about_key (never an issue or an agreement); the same owing side (a commitment''s from_role, any other loop''s to_role) and the same other side, both known; and for money (closes_on payment, or about invoice: or payment:) the same about_key. The owner''s decision of 3 Nov 2026: same matter, same owing side, never across payers or jobs (the caller holds both to one generation). Before 20261104223000: the same type or an ask and the matching promise only. Service role only.';
REVOKE ALL ON FUNCTION public.context_ledger_same_loop(public.context_ledger_items, public.context_ledger_items) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_same_loop(public.context_ledger_items, public.context_ledger_items) TO service_role;
