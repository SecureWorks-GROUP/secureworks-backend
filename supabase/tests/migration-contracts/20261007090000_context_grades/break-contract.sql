-- Let an unsafe ledger item pass (the pass rule forgets T8 for ledger items):
-- the contract's pass-rule check must catch it. Everything else is the real
-- rule, and the function keeps its comment, volatility and settings, so the
-- shape checks above it still hold.
CREATE OR REPLACE FUNCTION public.context_grade_passed(p_kind text, p_unit text, p_verdicts jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $fn$
 SELECT CASE WHEN public.context_grade_verdicts_problem(p_kind, p_unit, p_verdicts) IS NOT NULL THEN false
  ELSE coalesce(CASE p_kind
   WHEN 'ledger' THEN p_verdicts ->> 'verbatim' = 'pass' AND p_verdicts ->> 'parties' = 'pass'
    AND p_verdicts ->> 'supported' = 'pass'
   WHEN 'story' THEN p_verdicts ->> 'first_line' = 'pass' AND (p_verdicts ->> 'unsafe')::integer = 0
    AND p_verdicts ->> 'timeline' = 'pass' AND p_verdicts ->> 'record_loops' = 'pass'
    AND p_verdicts ->> 'money' = 'pass' AND p_verdicts ->> 'dates' = 'pass' AND p_verdicts ->> 'honesty' = 'pass'
    AND (p_verdicts #>> '{recall,money,found}')::integer = (p_verdicts #>> '{recall,money,total}')::integer
    AND (p_verdicts #>> '{recall,record,found}')::integer = (p_verdicts #>> '{recall,record,total}')::integer
   WHEN 'agent' THEN (p_verdicts ->> 'unsafe')::integer = 0 AND (p_verdicts ->> 'action_cards')::integer = 0
    AND CASE WHEN p_unit = 'story'
             THEN (p_verdicts #>> '{loops,covered}')::integer = (p_verdicts #>> '{loops,applicable}')::integer
             ELSE p_verdicts ->> 'answer' = 'correct' END
  END, false) END
$fn$;
