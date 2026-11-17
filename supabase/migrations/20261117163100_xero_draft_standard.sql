-- Xero draft standard, part 1 (ticket P3-01.1): the stored division options and the account rules.
--
-- xero_tracking_options holds Xero's list of division ('Business Unit') options, filled once a day
-- by the xero-sync profit and loss read (P3-01.3), so no draft writer asks Xero for the list live.
-- Nothing fills it by hand.
--
-- xero_account_rules says which account code each kind of draft line uses, so no code is typed
-- into a function. It is seeded with exactly the codes the functions use today, so this file
-- changes no draft: trade invoice lines 306 (super: the TRADE_SUPER_XERO_ACCOUNT_CODE setting when
-- it is set), expense receipts 400, supplier bills and credits 306. A row with confirmed_at null
-- is not yet confirmed by the bookkeeper. Nothing reads either table until the draft writers move
-- onto them behind the switch below (P3-01.6 to .8).
--
-- Switch xero_draft_standard_v1 is created off. Turning it on is the owner's word.
--
-- Both tables are service role only: row level security on with no policy, and every grant to
-- PUBLIC, anon and authenticated revoked (Supabase grants new public tables to them by default).
--
-- Safe to apply twice. Undo: supabase/rollbacks/20261117163100_xero_draft_standard_down.sql.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.xero_tracking_options (
  org_id uuid NOT NULL,
  category_id text NOT NULL,
  category_name text NOT NULL,
  option_id text NOT NULL,
  option_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, option_id)
);

COMMENT ON TABLE public.xero_tracking_options IS
  '20261117163100 (P3-01.1): Xero''s division (Business Unit) options, copied daily by xero-sync. Never filled by hand.';

CREATE TABLE IF NOT EXISTS public.xero_account_rules (
  org_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('trade_invoice', 'expense_receipt', 'supplier_bill', 'supplier_credit')),
  line_kind text NOT NULL CHECK (line_kind IN ('labour', 'travel', 'materials', 'commission', 'super', 'deduction',
                                               'receipt_job', 'receipt_stock', 'default')),
  account_code text NOT NULL,
  tax_type text NULL,
  note text,
  confirmed_by text NULL,
  confirmed_at timestamptz NULL,
  PRIMARY KEY (org_id, source_kind, line_kind)
);

COMMENT ON TABLE public.xero_account_rules IS
  '20261117163100 (P3-01.1): the account code each kind of draft line uses. confirmed_at null means not yet confirmed by the bookkeeper.';

ALTER TABLE public.xero_tracking_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.xero_account_rules ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.xero_tracking_options FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.xero_account_rules FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.xero_tracking_options TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.xero_account_rules TO service_role;

-- Today's codes, unconfirmed. ON CONFLICT DO NOTHING: a re-apply never overwrites a code the
-- bookkeeper has since changed or confirmed.
INSERT INTO public.xero_account_rules (org_id, source_kind, line_kind, account_code, tax_type, note)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'trade_invoice', 'labour', '306', NULL, NULL),
  ('00000000-0000-0000-0000-000000000001', 'trade_invoice', 'travel', '306', NULL, NULL),
  ('00000000-0000-0000-0000-000000000001', 'trade_invoice', 'materials', '306', NULL, NULL),
  ('00000000-0000-0000-0000-000000000001', 'trade_invoice', 'commission', '306', NULL, NULL),
  ('00000000-0000-0000-0000-000000000001', 'trade_invoice', 'deduction', '306', NULL, NULL),
  ('00000000-0000-0000-0000-000000000001', 'trade_invoice', 'super', '306', NULL,
   'the function uses the TRADE_SUPER_XERO_ACCOUNT_CODE setting when it is set'),
  ('00000000-0000-0000-0000-000000000001', 'expense_receipt', 'receipt_job', '400', NULL, NULL),
  ('00000000-0000-0000-0000-000000000001', 'expense_receipt', 'receipt_stock', '400', NULL, NULL),
  ('00000000-0000-0000-0000-000000000001', 'supplier_bill', 'default', '306', NULL, NULL),
  ('00000000-0000-0000-0000-000000000001', 'supplier_credit', 'default', '306', NULL, NULL)
ON CONFLICT (org_id, source_kind, line_kind) DO NOTHING;

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT 'xero_draft_standard_v1', false,
       'Drafts sent to Xero take their account from xero_account_rules and their division from the stored option list'
WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'xero_draft_standard_v1');
