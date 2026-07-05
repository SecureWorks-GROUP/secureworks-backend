-- Make-safe hours-flag facts on trade_invoice_lines (M4 U1).
--
-- Mission profit-trade-invoice-intelligence-2026-07-03 (campaign
-- profitability-job-costing, M4). Wiki issue #112. generate_trade_invoice now
-- resolves an ALLOWED-hours baseline for every make-safe labour line and flags
-- lines that bill over it. These columns LAND the per-line flag facts named in
-- the U4 field contract so the flag is queryable — not just prose in query_note
-- — for the U3 finance email, the U5 job cost report, and M3's money-facts
-- surface. U4 (Deckhand B) builds the canonical resolution view/consumption on
-- top of these columns; U1 is the producer that writes them.
--
--   • flag_type          — the rule that fired ('hours_over_baseline' today;
--                          the rule registry is shaped so later rules add their
--                          own type). NULL on unflagged / non-make-safe lines.
--   • baseline_hours     — the resolved allowed hours for the line. Recorded for
--                          EVERY make-safe line (even within allowance) so the
--                          U5 report can show allowed-vs-charged. NULL elsewhere.
--   • baseline_source    — where the allowance came from: 'ops_set' (work order
--                          estimated_hours), 'report' (trade's own report — not
--                          trusted in v1), or 'rule_default' (2hr minimum).
--   • hours_justification — the trade's plain-text explanation for the variation
--                          (trade-app capture is U2). NULL when not flagged.
--   • flagged_at         — when the line was flagged. NULL when not flagged.
--
-- Builder/client invoice amounts NEVER feed baseline_hours (2026-06-19 ruling).
-- These columns never change $/hours/rates — they annotate only.
--
-- HAND-APPLIED: applied manually by the orchestrator, not by CI auto-migrate,
-- and only after CP2 + Marnin approval. Additive and idempotent (safe to re-run,
-- all columns nullable so existing rows and in-flight inserts stay well-defined).

ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS flag_type text,
  ADD COLUMN IF NOT EXISTS baseline_hours numeric,
  ADD COLUMN IF NOT EXISTS baseline_source text,
  ADD COLUMN IF NOT EXISTS hours_justification text,
  ADD COLUMN IF NOT EXISTS flagged_at timestamptz;

COMMENT ON COLUMN public.trade_invoice_lines.flag_type IS
  'M4: rule that flagged this line (hours_over_baseline). NULL when not flagged.';
COMMENT ON COLUMN public.trade_invoice_lines.baseline_hours IS
  'M4: resolved allowed hours for a make-safe line. Set for every make-safe line (allowed-vs-charged); NULL for non-make-safe lines.';
COMMENT ON COLUMN public.trade_invoice_lines.baseline_source IS
  'M4: source of baseline_hours — ops_set (work_orders.estimated_hours), report (job_service_reports, untrusted in v1), or rule_default (2hr min).';
COMMENT ON COLUMN public.trade_invoice_lines.hours_justification IS
  'M4: trade''s plain-text explanation for an over-allowance make-safe line (trade-app capture, U2). NULL when not flagged.';
COMMENT ON COLUMN public.trade_invoice_lines.flagged_at IS
  'M4: timestamp the line was flagged over its allowance. NULL when not flagged.';

-- Partial index: the M5/M6 + U5 consumers read flagged lines only. Tiny (only
-- flagged rows) and idempotent.
CREATE INDEX IF NOT EXISTS trade_invoice_lines_flag_type_idx
  ON public.trade_invoice_lines (flag_type)
  WHERE flag_type IS NOT NULL;
