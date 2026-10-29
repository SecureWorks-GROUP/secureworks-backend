-- Down for 20261029120000_xero_tieout_monthly.sql.
-- The tie-out is one read-only function; it wrote nothing, so dropping it is
-- the whole undo. The ops-api action xero_tieout answers 503 until it returns.

DROP FUNCTION IF EXISTS public.xero_tieout_monthly(date, integer);
