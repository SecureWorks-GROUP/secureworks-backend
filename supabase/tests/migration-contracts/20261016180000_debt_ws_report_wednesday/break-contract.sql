-- Deliberately open the refresh trigger to a browser role: the contract must fail.
GRANT EXECUTE ON FUNCTION public.trigger_debt_ws_report_refresh() TO anon;
