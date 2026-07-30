-- Work-order labour lines on trade_invoice_lines (WO labour fan-out).
--
-- The trade app's Pay tab Work Order mode sends structured labour lines
-- (wo_labour_lines: [{trade_name, hours, rate, amount}]) plus wo_allocated and
-- wo_labour_deduction on every work-order extra item. Until now
-- generate_trade_invoice dropped those fields — the only record was the prose
-- description ("WO $559.5 − labour [Tendo 11.5h×$25=$287.5]=net $272"), so the
-- named labourers' pay never got created and the office hand-keyed it (with
-- transcription errors in production).
--
-- These columns LAND the structured facts on the WO holder's line so:
--   • the fan-out (generate_trade_invoice) that auto-creates each named
--     labourer's pending payout invoice reads clean data, and
--   • reconciliation can query declared labour per job without parsing prose
--     (the follow-on flagged in the original Q17 build evidence).
--
--   • wo_allocated        — the work-order $ the holder keyed. NULL on
--                           non-work-order lines.
--   • wo_labour_deduction — Σ labour deducted from the holder's net.
--   • wo_labour_lines     — cleaned jsonb array
--                           [{trade_name, hours, rate, amount}, ...].
--
-- Additive and idempotent; all columns nullable so existing rows and in-flight
-- inserts stay well-defined. Apply BEFORE deploying the matching ops-api.

ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS wo_allocated numeric,
  ADD COLUMN IF NOT EXISTS wo_labour_deduction numeric,
  ADD COLUMN IF NOT EXISTS wo_labour_lines jsonb;

COMMENT ON COLUMN public.trade_invoice_lines.wo_allocated IS
  'WO mode: work-order $ allocated to the holder. NULL on non-work-order lines.';
COMMENT ON COLUMN public.trade_invoice_lines.wo_labour_deduction IS
  'WO mode: total labour $ deducted from the holder''s net (Σ wo_labour_lines amounts).';
COMMENT ON COLUMN public.trade_invoice_lines.wo_labour_lines IS
  'WO mode: cleaned labour lines [{trade_name, hours, rate, amount}] the holder declared; the fan-out pays each named crew member from these.';
