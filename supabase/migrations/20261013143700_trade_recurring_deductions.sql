-- Trade recurring deductions (owner, 13 Oct 2026).
--
-- A weekly amount comes off one trade's weekly invoice: the trade hires a ute
-- from us, so each invoice week the hire is taken off what we pay him. The
-- first row is "Ute hire" for one trade: $100 for the invoice week starting
-- Monday 12 Oct 2026, $200 for every invoice week from Monday 19 Oct 2026.
--
--   1. Table trade_recurring_deductions: the rule, as data. Trade, label,
--      amount, first invoice week, optional last invoice week, on or off.
--      The office ends a deduction by editing its row, and changes the amount
--      by ending the row and adding the next, never by a deploy.
--   2. trade_invoices gains four columns: which rule the invoice carries
--      (id, label, amount) and, when a rule matched but was not taken, the
--      plain reason (note). All four are NULL on every existing row and stay
--      NULL: no backfill, no invoice saved before this is changed.
--   3. The deduction is NOT an invoice line and is NOT inside gross earned.
--      It comes off the amount payable after super and GST, so the trade is
--      paid exactly the amount less, whatever the tax treatment of his other
--      lines. A CHECK keeps it at or under that payable (never a negative
--      invoice).
--   4. Once per invoice week: a partial unique index lets at most one live
--      invoice per trade and week_start carry a deduction. A draft, a failed
--      and an ops-reject invoice are released and are not in it.
--   5. persist_weekly_trade_invoice_v3 wraps v2 (unchanged) and stamps the
--      four columns on the invoice it inserted, in the same transaction.
--      ops-api calls v3; v1 and v2 keep every guard they have.
--
-- Rule owner: supabase/functions/ops-api/trade_invoice_recurring_deduction.ts.
-- Contract: docs/trade-recurring-deductions-2026-10-13.md.
-- Safe to apply twice.

-- ── 1. The rule, as data ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trade_recurring_deductions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id),
  label text NOT NULL,
  amount numeric(12,2) NOT NULL,
  first_week_start date NOT NULL,
  last_week_start date,
  active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trade_recurring_deductions_label_check
    CHECK (btrim(label) <> ''),
  CONSTRAINT trade_recurring_deductions_amount_check
    CHECK (amount > 0),
  -- An invoice week starts on a Monday (ISO day 1), as trade_invoices.week_start does.
  CONSTRAINT trade_recurring_deductions_first_week_monday_check
    CHECK (EXTRACT(ISODOW FROM first_week_start) = 1),
  CONSTRAINT trade_recurring_deductions_last_week_check
    CHECK (
      last_week_start IS NULL
      OR (
        EXTRACT(ISODOW FROM last_week_start) = 1
        AND last_week_start >= first_week_start
      )
    )
);

COMMENT ON TABLE public.trade_recurring_deductions IS
  'A weekly amount taken off one trade''s weekly invoice (first row: Ute hire). One row is one amount over a run of invoice weeks. Two active rows of a trade must never cover the same week: for such a week nothing is taken and the invoice is marked for the office. Change the amount by ending the current row with last_week_start and adding a row from the next week. Switch a deduction off with active = false, or end it with last_week_start. Read only by ops-api (trade_invoice_recurring_deduction.ts).';
COMMENT ON COLUMN public.trade_recurring_deductions.user_id IS
  'The trade whose weekly invoice carries the deduction.';
COMMENT ON COLUMN public.trade_recurring_deductions.label IS
  'The words the trade and the office see on the invoice, for example Ute hire.';
COMMENT ON COLUMN public.trade_recurring_deductions.amount IS
  'Dollars taken off the amount payable for one invoice week, after super and GST.';
COMMENT ON COLUMN public.trade_recurring_deductions.first_week_start IS
  'The Monday of the first invoice week this row applies to.';
COMMENT ON COLUMN public.trade_recurring_deductions.last_week_start IS
  'The Monday of the last invoice week this row applies to. NULL means until switched off.';
COMMENT ON COLUMN public.trade_recurring_deductions.active IS
  'false switches the row off: no later invoice carries it. Invoices already saved keep what they carried.';

CREATE INDEX IF NOT EXISTS trade_recurring_deductions_user_idx
  ON public.trade_recurring_deductions (user_id, first_week_start);

-- Money rules are the office's, never a browser's.
ALTER TABLE public.trade_recurring_deductions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.trade_recurring_deductions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trade_recurring_deductions TO service_role;

-- ── 2. What an invoice carries ──────────────────────────────────────────────
ALTER TABLE public.trade_invoices
  ADD COLUMN IF NOT EXISTS recurring_deduction_id uuid,
  ADD COLUMN IF NOT EXISTS recurring_deduction_label text,
  ADD COLUMN IF NOT EXISTS recurring_deduction_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS recurring_deduction_note text;

COMMENT ON COLUMN public.trade_invoices.recurring_deduction_id IS
  'The trade_recurring_deductions row this invoice carries. NULL when it carries none.';
COMMENT ON COLUMN public.trade_invoices.recurring_deduction_label IS
  'The deduction''s label as it stood when the invoice was saved (for example Ute hire). NULL as recurring_deduction_id.';
COMMENT ON COLUMN public.trade_invoices.recurring_deduction_amount IS
  'Dollars taken off the amount payable (net_pay + gst) on this invoice. Not part of subtotal_ex, gross_earned, super or GST. NULL as recurring_deduction_id.';
COMMENT ON COLUMN public.trade_invoices.recurring_deduction_note IS
  'When a deduction was due for this trade but was not taken on this invoice (payable below it, already on another invoice, two rows covering the week, a work-order invoice or an invoice with no week), the plain reason for the office. NULL otherwise.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trade_invoices'::regclass
      AND conname = 'trade_invoices_recurring_deduction_fk'
  ) THEN
    ALTER TABLE public.trade_invoices
      ADD CONSTRAINT trade_invoices_recurring_deduction_fk
      FOREIGN KEY (recurring_deduction_id)
      REFERENCES public.trade_recurring_deductions(id) NOT VALID;
  END IF;

  -- All three or none; only on an invoice that has a week; never more than
  -- the amount payable, so a deduction can never make a negative invoice.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.trade_invoices'::regclass
      AND conname = 'trade_invoices_recurring_deduction_check'
  ) THEN
    ALTER TABLE public.trade_invoices
      ADD CONSTRAINT trade_invoices_recurring_deduction_check CHECK (
        (
          recurring_deduction_id IS NULL
          AND recurring_deduction_label IS NULL
          AND recurring_deduction_amount IS NULL
        )
        OR
        (
          recurring_deduction_id IS NOT NULL
          AND btrim(COALESCE(recurring_deduction_label, '')) <> ''
          -- IS NOT NULL is said out loud: a NULL comparison would make the
          -- whole CHECK unknown, and an unknown CHECK passes.
          AND recurring_deduction_amount IS NOT NULL
          AND recurring_deduction_amount > 0
          AND week_start IS NOT NULL
          AND net_pay IS NOT NULL
          AND recurring_deduction_amount <= round(net_pay + COALESCE(gst, 0), 2)
        )
      ) NOT VALID;
  END IF;
END
$$;

-- ── 3. Once per invoice week ────────────────────────────────────────────────
-- ops-api decides before it writes; this is the guard under it. The released
-- statuses are RELEASED_INVOICE_STATUSES in ops-api/index.ts.
CREATE UNIQUE INDEX IF NOT EXISTS trade_invoices_one_recurring_deduction_per_week
  ON public.trade_invoices (user_id, week_start)
  WHERE recurring_deduction_amount IS NOT NULL
    AND status NOT IN ('draft', 'failed', 'ops-reject');

-- ── 4. The dated persist stamps the four columns ────────────────────────────
-- v1 inserts a fixed column list and v2 wraps it. v3 calls v2 and then stamps
-- the invoice it just wrote. One transaction: a failed stamp saves nothing.
CREATE OR REPLACE FUNCTION public.persist_weekly_trade_invoice_v3(
  p_invoice jsonb,
  p_lines jsonb,
  p_requested_prior_draft_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_invoice_id uuid;
BEGIN
  v_invoice_id := public.persist_weekly_trade_invoice_v2(
    p_invoice, p_lines, p_requested_prior_draft_id
  );

  IF NULLIF(p_invoice->>'recurring_deduction_id', '') IS NOT NULL
     OR NULLIF(p_invoice->>'recurring_deduction_note', '') IS NOT NULL THEN
    UPDATE public.trade_invoices
    SET recurring_deduction_id = NULLIF(p_invoice->>'recurring_deduction_id', '')::uuid,
        recurring_deduction_label = NULLIF(p_invoice->>'recurring_deduction_label', ''),
        recurring_deduction_amount = NULLIF(p_invoice->>'recurring_deduction_amount', '')::numeric,
        recurring_deduction_note = NULLIF(p_invoice->>'recurring_deduction_note', '')
    WHERE id = v_invoice_id;
  END IF;

  RETURN v_invoice_id;
END;
$$;

REVOKE ALL ON FUNCTION public.persist_weekly_trade_invoice_v3(jsonb, jsonb, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_weekly_trade_invoice_v3(jsonb, jsonb, uuid)
  TO service_role;

COMMENT ON FUNCTION public.persist_weekly_trade_invoice_v3(jsonb, jsonb, uuid) IS
  'Trade recurring deductions (20261013143700): persist_weekly_trade_invoice_v2 unchanged, then stamps recurring_deduction_id, label, amount and note on the invoice it inserted, in one transaction.';

-- ── 5. The first deduction: Ute hire ────────────────────────────────────────
-- The trade is found by the login email this repository already records for
-- him (20260322000005_fix_user_roles.sql), never by a guessed id. If that
-- email does not name exactly one user, nothing is inserted and the office
-- adds the two rows with his user id.
DO $$
DECLARE
  v_user_ids uuid[];
  v_user_id uuid;
BEGIN
  SELECT array_agg(id) INTO v_user_ids
  FROM public.users
  WHERE lower(email) = 'isaac.b3lch3r@gmail.com';

  IF COALESCE(array_length(v_user_ids, 1), 0) <> 1 THEN
    RAISE NOTICE 'trade_recurring_deductions: Ute hire NOT seeded, % user(s) match the recorded email. Insert the two rows with the trade''s user id.',
      COALESCE(array_length(v_user_ids, 1), 0);
    RETURN;
  END IF;
  v_user_id := v_user_ids[1];

  -- This week only (Monday 12 Oct 2026): $100.
  INSERT INTO public.trade_recurring_deductions
    (user_id, label, amount, first_week_start, last_week_start, note)
  SELECT v_user_id, 'Ute hire', 100, DATE '2026-10-12', DATE '2026-10-12',
         'Owner, 13 Oct 2026: first week of ute hire is $100.'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.trade_recurring_deductions
    WHERE user_id = v_user_id AND label = 'Ute hire'
      AND first_week_start = DATE '2026-10-12'
  );

  -- Every invoice week from Monday 19 Oct 2026, until switched off: $200.
  INSERT INTO public.trade_recurring_deductions
    (user_id, label, amount, first_week_start, last_week_start, note)
  SELECT v_user_id, 'Ute hire', 200, DATE '2026-10-19', NULL,
         'Owner, 13 Oct 2026: ute hire is $200 a week from the week of 19 Oct 2026.'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.trade_recurring_deductions
    WHERE user_id = v_user_id AND label = 'Ute hire'
      AND first_week_start = DATE '2026-10-19'
  );
END
$$;
