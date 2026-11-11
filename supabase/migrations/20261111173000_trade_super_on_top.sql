-- Super on top for one trade's own invoices (owner, 11 Nov 2026).
--
-- Everyone keeps the ordinary split: super is 12% of the submitted total,
-- half withheld from the trade, half paid by the company. The owner agreed
-- that a named trade can instead be paid their hourly total in full, with the
-- company paying the whole 12% on top. That is the employer_12_v2 basis the
-- full-employer-super group shares already use (20261030133000).
--
--   1. Table trade_super_bases: the office setting, as dated rows. Trade,
--      basis, from when, until when, who set it and who ended it. Service
--      role only: a trade cannot read or write it, and nothing a trade sends
--      (update_trade_profile, trade_details) reaches it.
--   2. trade_invoices gains super_basis_setting_id: the setting row that
--      priced the invoice. NULL on every existing row and on every invoice of
--      a trade with no setting. It can only be set with the employer basis,
--      and only to a setting row of the invoice's own trade.
--   3. The invoice-line guard still refuses an ordinary line on an
--      employer-super group share invoice. It lets one through only when the
--      invoice carries an office setting (2).
--   4. persist_weekly_trade_invoice_v1 writes the two columns it is given, so
--      the weekly and running-draft path (v3 -> v2 -> v1) can save such an
--      invoice. A basis sent with no setting id is stored as sent, and the
--      line guard (3) then refuses its ordinary lines, so nothing is saved.
--
-- No row is added here and no invoice is changed: with no setting row every
-- money path behaves exactly as before.
--
-- Rule owner: supabase/functions/ops-api/trade_invoice_super_basis.ts.
-- Safe to apply twice.

-- ── 1. The office setting ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trade_super_bases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id),
  super_basis text NOT NULL,
  -- Applies to an invoice whose earnings date (its week end, or its day when
  -- it has no week) falls in effective_from .. effective_to.
  effective_from date NOT NULL,
  effective_to date,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_by text,
  ended_at timestamptz,
  CONSTRAINT trade_super_bases_basis_check
    CHECK (super_basis = 'employer_12_v2'),
  -- Ended before it began (effective_to = effective_from - 1) is how a
  -- setting turned off on the day it was turned on is kept as history.
  CONSTRAINT trade_super_bases_range_check
    CHECK (effective_to IS NULL OR effective_to >= effective_from - 1),
  CONSTRAINT trade_super_bases_created_by_check
    CHECK (btrim(created_by) <> ''),
  CONSTRAINT trade_super_bases_id_user_key UNIQUE (id, user_id)
);

-- One open setting per trade.
CREATE UNIQUE INDEX IF NOT EXISTS trade_super_bases_one_open_per_user
  ON public.trade_super_bases (user_id)
  WHERE effective_to IS NULL;

CREATE INDEX IF NOT EXISTS trade_super_bases_user_from_idx
  ON public.trade_super_bases (user_id, effective_from DESC);

ALTER TABLE public.trade_super_bases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trade_super_bases FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.trade_super_bases TO service_role;

COMMENT ON TABLE public.trade_super_bases IS
  'Office-only setting: this trade''s own invoices are paid in full with the company paying 12% super on top (employer_12_v2). Dated rows; never set by the trade. Rule owner: ops-api/trade_invoice_super_basis.ts.';

-- ── 2. Which setting priced the invoice ────────────────────────────
ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS super_basis_setting_id uuid;

COMMENT ON COLUMN public.trade_invoices.super_basis_setting_id IS
  'The trade_super_bases row that priced this invoice on super on top. NULL for the ordinary split and for group shares.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trade_invoices'::regclass
      AND conname = 'trade_invoices_super_basis_setting_check'
  ) THEN
    ALTER TABLE public.trade_invoices
      ADD CONSTRAINT trade_invoices_super_basis_setting_check
      CHECK (super_basis_setting_id IS NULL OR super_basis IS NOT DISTINCT FROM 'employer_12_v2');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trade_invoices'::regclass
      AND conname = 'trade_invoices_super_basis_setting_fkey'
  ) THEN
    ALTER TABLE public.trade_invoices
      ADD CONSTRAINT trade_invoices_super_basis_setting_fkey
      FOREIGN KEY (super_basis_setting_id, user_id)
      REFERENCES public.trade_super_bases (id, user_id);
  END IF;
END $$;

-- ── 3. The line guard lets an office-set invoice carry ordinary lines ──
DO $$
DECLARE
  body text := pg_get_functiondef('public.trade_invoice_lines_group_share_snapshot()'::regprocedure);
  before_text text := $old$  -- An employer-super invoice carries its group share and nothing else.
  IF NEW.trade_invoice_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.trade_invoices i WHERE i.id = NEW.trade_invoice_id AND i.super_basis IS NOT NULL
  ) THEN$old$;
  after_text text := $new$  -- (20261111173000) An employer-super invoice carries its group share and
  -- nothing else, unless the office set this trade's own invoices to super
  -- on top (trade_super_bases).
  IF NEW.trade_invoice_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.trade_invoices i WHERE i.id = NEW.trade_invoice_id AND i.super_basis IS NOT NULL AND i.super_basis_setting_id IS NULL
  ) THEN$new$;
BEGIN
  IF strpos(body, '(20261111173000)') = 0 THEN
    IF length(body) - length(replace(body, before_text, '')) <> length(before_text) THEN
      RAISE EXCEPTION 'trade_invoice_lines_group_share_snapshot changed; review before applying 20261111173000';
    END IF;
    EXECUTE replace(body, before_text, after_text);
  END IF;
END $$;

-- ── 4. The weekly persist writes the basis it is given ─────────────
DO $$
DECLARE
  body text := pg_get_functiondef('public.persist_weekly_trade_invoice_v1(jsonb, jsonb, uuid)'::regprocedure);
  before_columns text := $old$    invoice_number, submitted_at, status
  ) VALUES ($old$;
  after_columns text := $new$    invoice_number, submitted_at, status,
    super_basis, super_basis_setting_id -- (20261111173000)
  ) VALUES ($new$;
  before_values text := $old$    NULLIF(p_invoice->>'submitted_at', '')::timestamptz,
    v_status
  )
  RETURNING id INTO v_invoice_id;$old$;
  after_values text := $new$    NULLIF(p_invoice->>'submitted_at', '')::timestamptz,
    v_status,
    NULLIF(p_invoice->>'super_basis', ''),
    NULLIF(p_invoice->>'super_basis_setting_id', '')::uuid
  )
  RETURNING id INTO v_invoice_id;$new$;
BEGIN
  IF strpos(body, '(20261111173000)') = 0 THEN
    IF length(body) - length(replace(body, before_columns, '')) <> length(before_columns)
       OR length(body) - length(replace(body, before_values, '')) <> length(before_values) THEN
      RAISE EXCEPTION 'persist_weekly_trade_invoice_v1 changed; review before applying 20261111173000';
    END IF;
    EXECUTE replace(replace(body, before_columns, after_columns), before_values, after_values);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
