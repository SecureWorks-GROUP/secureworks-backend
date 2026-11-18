-- Deliberately remove the equal-model refusal to prove contract.sql catches it.
CREATE OR REPLACE FUNCTION public.context_ledger_word_closes_mark(
  p_job_id uuid,
  p_item_keys text[],
  p_reader text,
  p_reader_model text,
  p_checker_model text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $broken$
BEGIN
  RETURN 0;
END $broken$;
