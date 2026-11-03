-- Undo 20261104223000_context_ledger_same_loop_matter: context_ledger_same_loop is the 20261104050000 definition again,
-- word for word with its comment (md5 d105e91c2c30b2141d424bb53f7d6106). Moves the wider rule already took stay as they
-- are (a retired copy keeps the note it repeats); the store then refuses new cross-type pairs again (replaced_by_other_loop).
-- Refuses unless the live function is this migration's (its comment starts with "(20261104223000)") or already the old one.
SET LOCAL lock_timeout = '5s';
DO $down$ BEGIN
  IF md5(pg_get_functiondef('public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)'::regprocedure)) = 'd105e91c2c30b2141d424bb53f7d6106' THEN
    RAISE NOTICE 'context_ledger_same_loop is already the old definition';
    RETURN;
  END IF;
  IF coalesce(obj_description('public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)'::regprocedure, 'pg_proc'), '') NOT LIKE '(20261104223000)%' THEN
    RAISE EXCEPTION 'context_ledger_same_loop is not the 20261104223000 definition; roll the later one back first';
  END IF;
END $down$;

CREATE OR REPLACE FUNCTION public.context_ledger_same_loop(a public.context_ledger_items, b public.context_ledger_items)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT coalesce(
  a.item_type IN ('commitment','request','claim','issue','constraint','dependency')
  AND b.item_type IN ('commitment','request','claim','issue','constraint','dependency')
  AND (a.item_type = b.item_type OR (a.item_type IN ('commitment','request') AND b.item_type IN ('commitment','request')))
  AND CASE WHEN a.item_type = 'commitment' THEN a.from_role ELSE a.to_role END NOT IN ('unknown')
  AND CASE WHEN a.item_type = 'commitment' THEN a.to_role ELSE a.from_role END NOT IN ('unknown')
  AND CASE WHEN a.item_type = 'commitment' THEN a.from_role ELSE a.to_role END = CASE WHEN b.item_type = 'commitment' THEN b.from_role ELSE b.to_role END
  AND CASE WHEN a.item_type = 'commitment' THEN a.to_role ELSE a.from_role END = CASE WHEN b.item_type = 'commitment' THEN b.to_role ELSE b.from_role END
  AND (NOT (coalesce(a.closes_on, '') = 'payment' OR coalesce(b.closes_on, '') = 'payment'
            OR coalesce(a.about_key, '') ~ '^(invoice|payment):' OR coalesce(b.about_key, '') ~ '^(invoice|payment):')
       OR a.about_key = b.about_key), false)
$$;
COMMENT ON FUNCTION public.context_ledger_same_loop(public.context_ledger_items, public.context_ledger_items) IS
 '(20261104050000) Whether two ledger notes may be one loop written twice: both loops, the same type or an ask and the matching promise, the same owing side (a commitment''s from_role, any other loop''s to_role) and the same other side, both known, and for money (closes_on payment, or about invoice: or payment:) the same about_key. The owner''s decision of 3 Nov 2026: same matter, same owing side, never across payers or jobs (the caller holds both to one generation). Service role only.';
REVOKE ALL ON FUNCTION public.context_ledger_same_loop(public.context_ledger_items, public.context_ledger_items) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_same_loop(public.context_ledger_items, public.context_ledger_items) TO service_role;
