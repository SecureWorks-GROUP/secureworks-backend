-- P1-05.6 prerequisite only, authorized for the work-order gap read.
-- Nullable, no defaults, no triggers, no switch or change to existing pay.
ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS hold_reason text,
  ADD COLUMN IF NOT EXISTS held_at timestamptz;
