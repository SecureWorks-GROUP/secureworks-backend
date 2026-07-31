-- Work-order labour lines on trade_invoice_lines.
--
-- The trade app's Pay tab Work Order mode sends structured labour lines
-- (wo_labour_lines: [{trade_name, hours, rate, amount}]) plus wo_allocated and
-- wo_labour_deduction on every work-order extra item. Until now
-- generate_trade_invoice dropped those fields — the only record was the prose
-- description ("WO $559.5 − labour [Tendo 11.5h×$25=$287.5]=net $272").
--
-- These columns LAND the structured facts on the WO holder's line so the
-- human-readable holder-invoice breakdown and future reconciliation can query
-- declared labour per job without parsing prose.
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
  'WO mode: cleaned labour lines [{trade_name, hours, rate, amount}] the holder declared; named crew bill SecureWorks Group directly and the office reconciles these facts.';
