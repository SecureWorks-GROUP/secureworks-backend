-- Synthetic behaviour (finish line C4, blind notes round 2): two notes of different loop types on the very same matter,
-- between the same sides, are one loop; an issue, an agreement, another matter, another side, an unknown side or two
-- invoices never are; every pair the 20261104050000 rule took is still taken.
CREATE FUNCTION pg_temp.sl_assert(ok boolean, msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'same loop matter contract: %', msg; END IF; END $$;
CREATE FUNCTION pg_temp.sl_note(p_type text, p_from text, p_to text, p_about text, p_closes text DEFAULT 'reply') RETURNS public.context_ledger_items
LANGUAGE sql AS $$
 SELECT jsonb_populate_record(NULL::public.context_ledger_items, jsonb_build_object('item_type', p_type, 'status', 'open', 'from_role', p_from,
  'to_role', p_to, 'about_key', p_about, 'closes_on', p_closes, 'item_key', p_type || ':' || coalesce(p_about, 'none') || ':fixture', 'what', 'Fixture note'))
$$;
DO $$ BEGIN
 -- Taken now (round 2's two pairs): a customer's claim and ask about one invoice; a customer's ask and hold for one day.
 PERFORM pg_temp.sl_assert(public.context_ledger_same_loop(pg_temp.sl_note('claim','customer','us','invoice:inv-98061','record'),
  pg_temp.sl_note('request','customer','us','invoice:inv-98061','reply')), 'a claim and an ask on one invoice, same sides');
 PERFORM pg_temp.sl_assert(public.context_ledger_same_loop(pg_temp.sl_note('request','customer','us','booking:2026-11-04','visit'),
  pg_temp.sl_note('constraint','customer','us','booking:2026-11-04','visit')), 'an ask and a hold for one day, same sides');
 PERFORM pg_temp.sl_assert(public.context_ledger_same_loop(pg_temp.sl_note('dependency','us','supplier','materials:panel','record'),
  pg_temp.sl_note('request','us','supplier','materials:panel','reply')), 'a wait and an ask on one order, same sides');
 -- Still taken (the 20261104050000 rule).
 PERFORM pg_temp.sl_assert(public.context_ledger_same_loop(pg_temp.sl_note('request','customer','us','preference:gutter-colour'),
  pg_temp.sl_note('commitment','us','customer','preference:gutter-colour')), 'an ask and our matching promise');
 PERFORM pg_temp.sl_assert(public.context_ledger_same_loop(pg_temp.sl_note('request','customer','us','scope:gate'),
  pg_temp.sl_note('request','customer','us','scope:gate-height')), 'one ask written twice, about worded apart');
 -- Never.
 PERFORM pg_temp.sl_assert(NOT public.context_ledger_same_loop(pg_temp.sl_note('claim','customer','us','scope:gate'),
  pg_temp.sl_note('request','customer','us','scope:gate-height')), 'a claim and an ask on two matters');
 PERFORM pg_temp.sl_assert(NOT public.context_ledger_same_loop(pg_temp.sl_note('issue','customer','us','defect:gate-latch','person'),
  pg_temp.sl_note('request','customer','us','defect:gate-latch')), 'a complaint and an ask');
 PERFORM pg_temp.sl_assert(NOT public.context_ledger_same_loop(pg_temp.sl_note('agreement','customer','us','preference:colour'),
  pg_temp.sl_note('request','customer','us','preference:colour')), 'an agreement');
 PERFORM pg_temp.sl_assert(NOT public.context_ledger_same_loop(pg_temp.sl_note('claim','customer','us','invoice:inv-98061','record'),
  pg_temp.sl_note('request','us','customer','invoice:inv-98061','payment')), 'another owing side on one invoice');
 PERFORM pg_temp.sl_assert(NOT public.context_ledger_same_loop(pg_temp.sl_note('claim','unknown','us','scope:roof'),
  pg_temp.sl_note('request','unknown','us','scope:roof')), 'an unknown side');
 PERFORM pg_temp.sl_assert(NOT public.context_ledger_same_loop(pg_temp.sl_note('claim','customer','us',NULL),
  pg_temp.sl_note('constraint','customer','us',NULL)), 'no matter named');
 PERFORM pg_temp.sl_assert(NOT public.context_ledger_same_loop(pg_temp.sl_note('request','us','customer','invoice:inv-98061','payment'),
  pg_temp.sl_note('request','us','customer','invoice:inv-98062','payment')), 'two invoices');
 -- Its grants and its comment.
 PERFORM pg_temp.sl_assert(has_function_privilege('service_role', 'public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)', 'EXECUTE'), 'service role only');
 PERFORM pg_temp.sl_assert(obj_description('public.context_ledger_same_loop(public.context_ledger_items,public.context_ledger_items)'::regprocedure, 'pg_proc') LIKE '(20261104223000)%', 'the comment names this change');
END $$;
