-- Deliberately open the company terms write path to a browser role: the contract must fail.
GRANT EXECUTE ON FUNCTION public.debt_ws_set_company_terms(text, integer, text) TO anon;
