-- Rollback of 20261013143700_trade_recurring_deductions.
--
-- Takes back the surface, never the record: the stamping persist wrapper goes.
-- The rule table, the four columns on trade_invoices, their check and the
-- once-per-week index STAY, because what an invoice carried is recorded
-- nowhere else and a rollback must not change what a saved invoice pays.
-- Nothing applies a new deduction once the matching ops-api is rolled back;
-- to stop the deduction without a rollback, set active = false on its rows.
--
-- Roll the matching ops-api back first: it calls
-- persist_weekly_trade_invoice_v3. persist_weekly_trade_invoice_v1 and v2 are
-- untouched by the forward migration and stay as they are.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DROP FUNCTION IF EXISTS public.persist_weekly_trade_invoice_v3(jsonb, jsonb, uuid);
