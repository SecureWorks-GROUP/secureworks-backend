SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
SELECT public.match_rule_remove();
DROP FUNCTION public.match_rule_install(), public.match_rule_remove(),
  public.match_rule_on_decision(), public.match_rules_proposed(),
  public.match_rule_confirm(bigint,boolean,uuid),
  public.match_rule_index_answer(public.reconcile_decisions,boolean);
-- Keep staff decisions, their supporting ids and the resume cursor.
-- Empty installations leave no data to retain.
DO $down$
/* block */ BEGIN
  IF NOT EXISTS (SELECT FROM public.match_rule_support LIMIT 1)
     AND NOT EXISTS (SELECT FROM public.match_rule_answers LIMIT 1)
     AND NOT EXISTS (SELECT FROM public.match_rule_retries LIMIT 1) THEN
    DROP TABLE public.match_rule_retries, public.match_rule_support, public.match_rule_answers, public.match_rule_install_state;
  END IF;
END $down$;
