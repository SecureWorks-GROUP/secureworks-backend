-- (Job Profit, call A, 3 Nov 2026) Company super on crew invoices from Xero's own records, per crew member.
-- Marnin, 3 Nov: "for super check xero but yes there was some super paid although its pretty messy"; build the
-- rule from Xero's actual super records per crew and period, apply it where the records show it, list the rest.
-- Read-only research (context-system verify/evidence/20261103-super-records/FINDINGS.md): before each crew
-- member's first super deduction no crew bill carries a super line and Xero's Superannuation expense is exactly
-- 12% of payroll wages (payroll staff only), so NONE was paid for crew. Every crew invoice with no super on it is
-- dated before that person's first invoice that carries super (0 after it, read 3 Nov 03:2xZ). From the first
-- deduction on, the crew bill states super and Job Profit keeps counting the company part the bill states; Xero
-- cannot show whom the pooled Payclear payments covered (listed for Bookkeeping, not changed here).
-- Change: a crew invoice with no super on it, dated (Xero bill date, else week end) before that crew member's
-- none_before date below, counts no company super instead of "employer super unknown". Nothing else changes.
-- Guard: v_job_profit must be the definition this was written against (md5 b6761258...).
-- Rollback: supabase/rollbacks/20261103040000_job_profit_crew_super_from_xero_down.sql.

CREATE TABLE IF NOT EXISTS public.job_cost_crew_super_rulings (
  user_id uuid PRIMARY KEY,
  crew_name text NOT NULL,
  none_before date NOT NULL,
  basis text NOT NULL,
  decided text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.job_cost_crew_super_rulings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_cost_crew_super_rulings FROM anon, authenticated;
COMMENT ON TABLE public.job_cost_crew_super_rulings IS
  'Per crew member: crew invoices with no super on them dated before none_before count no company super (Xero records, call A, 3 Nov 2026).';

INSERT INTO public.job_cost_crew_super_rulings (user_id, crew_name, none_before, basis, decided)
SELECT v.user_id, v.crew_name, v.none_before,
  'No super line on any bill before the first deduction; Xero Superannuation expense = 12% of payroll wages (payroll staff only). FINDINGS.md 20261103-super-records',
  'Marnin 3 Nov 2026 call A (super from Xero records); CIO chat'
FROM (VALUES
('2f00f91e-8b76-4856-8dec-ab6041f04e1d'::uuid, 'Alyx', '2026-08-30'::date),
('d8fd131a-cfca-4fdf-90ae-d79766fed481'::uuid, 'Anthony', '2026-08-28'::date),
('e80ab30b-8b31-4508-a1b6-4f08b6ed0981'::uuid, 'Aydan Belcher', '2026-09-02'::date),
('9a04a58a-65d5-4702-93f6-561fff12bcbb'::uuid, 'Ethan Chahuruva', '2026-11-03'::date),
('b353f39a-b3cc-495d-a016-50ebf4a8497d'::uuid, 'Hugo', '2026-08-30'::date),
('a5ea66d2-ee5f-4537-92ab-f76992df051d'::uuid, 'Isaac', '2026-08-28'::date),
('fee2ceaa-b718-4c64-8ca8-6979914928cf'::uuid, 'Israel', '2026-08-28'::date),
('ee7ef74c-be92-4458-bedb-ca905e9ef45e'::uuid, 'Jack Liddelow', '2026-11-03'::date),
('44c1f557-f7b2-4f99-9b6b-d7a0f904a0f5'::uuid, 'Jean Crous', '2026-10-24'::date),
('be6c2188-2b7b-49c7-b6e4-5b0d0deb6415'::uuid, 'Khairo', '2026-09-03'::date),
('e0f93e18-f8b2-4548-80fc-9ff1a2782314'::uuid, 'Kim Muiruri', '2026-09-06'::date),
('706c5258-70dd-483a-b36c-af6864b24498'::uuid, 'Marnin', '2026-11-03'::date),
('5862cf1d-0a3b-4836-8fd1-d69f95aa2f73'::uuid, 'Nithin', '2026-09-01'::date),
('f9a9e835-98a9-4dc4-a927-5edbb1a81a63'::uuid, 'Ryan', '2026-09-04'::date),
('42b18424-9cc8-4b7d-b249-e36285014a57'::uuid, 'Sonny Longstaff', '2026-08-30'::date),
('31cbb841-2dc9-4306-a84c-813e326b0ea4'::uuid, 'Tendo Lugesera Adrian', '2026-08-30'::date)
) AS v(user_id, crew_name, none_before)
ON CONFLICT (user_id) DO NOTHING;

DO $mig$
DECLARE
  v_def text;
  v_old text := 'WHERE (ti.super_amount IS NULL OR ti.net_pay IS NULL) AND';
  v_new text := 'WHERE (ti.super_amount IS NULL OR ti.net_pay IS NULL) AND NOT (ti.super_amount IS NULL AND (EXISTS ( SELECT 1 FROM job_cost_crew_super_rulings r WHERE r.user_id = ti.user_id AND COALESCE(( SELECT x.invoice_date FROM xero_invoices x WHERE x.xero_invoice_id = ti.xero_bill_id LIMIT 1), ti.week_end) < r.none_before))) AND';
BEGIN
  v_def := pg_get_viewdef('public.v_job_profit'::regclass, true);
  IF md5(v_def) = '7352d50d91e713d1e7d5f8dd07e6667e' THEN
    RAISE NOTICE 'v_job_profit already reads the crew super rulings';
    RETURN;
  END IF;
  IF md5(v_def) <> 'b67612588af46108107af4d29df3d12f' THEN
    RAISE EXCEPTION 'v_job_profit is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'v_job_profit: the super-unknown test is not there exactly once';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_profit AS ' || replace(v_def, v_old, v_new);
  IF md5(pg_get_viewdef('public.v_job_profit'::regclass, true)) <> '7352d50d91e713d1e7d5f8dd07e6667e' THEN
    RAISE EXCEPTION 'v_job_profit after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_profit'::regclass, true));
  END IF;
END
$mig$;
