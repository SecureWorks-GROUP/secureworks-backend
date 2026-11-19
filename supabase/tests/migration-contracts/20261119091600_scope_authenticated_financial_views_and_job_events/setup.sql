-- Pre-migration state for
-- 20261119091600_scope_authenticated_financial_views_and_job_events: the four
-- financial summary views with Supabase's default grants (every privilege to
-- each API role), one column grant to PUBLIC, and public.job_events with row
-- level security on, the 2025 read and insert rules for PUBLIC and the
-- default grants. A snapshot of their grants, rules and row security, taken
-- just before the migration, lets the rollback contract prove the rollback
-- restores them exactly. public.jobs, public.users, public.xero_invoices,
-- public.job_events, public.job_financials and public.auth_org_id() already
-- exist from earlier registered cases.
DO $roles$
BEGIN
  IF to_regrole('anon') IS NULL THEN CREATE ROLE anon NOLOGIN; END IF;
  IF to_regrole('authenticated') IS NULL THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF to_regrole('service_role') IS NULL THEN CREATE ROLE service_role NOLOGIN; END IF;
END
$roles$;
ALTER ROLE service_role BYPASSRLS;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(coalesce(
    current_setting('request.jwt.claim.sub', true),
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
  ), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.auth_org_id()
RETURNS uuid AS $$
  SELECT org_id FROM public.users WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- The three reporting views as 20250301000003_reporting_schema.sql wrote them.
ALTER TABLE public.xero_invoices ADD COLUMN IF NOT EXISTS total_tax numeric;
DO $views$
BEGIN
  IF to_regclass('public.monthly_revenue') IS NULL THEN
    CREATE VIEW public.monthly_revenue AS
    SELECT org_id, date_trunc('month', invoice_date)::date AS month, count(*) AS invoice_count,
           sum(sub_total) AS revenue, sum(total_tax) AS tax, sum(total) AS revenue_inc_gst,
           sum(amount_paid) AS collected, sum(amount_due) AS outstanding
    FROM public.xero_invoices
    WHERE invoice_type = 'ACCREC' AND status NOT IN ('VOIDED', 'DELETED', 'DRAFT')
    GROUP BY org_id, date_trunc('month', invoice_date);
  END IF;
  IF to_regclass('public.monthly_costs') IS NULL THEN
    CREATE VIEW public.monthly_costs AS
    SELECT org_id, date_trunc('month', invoice_date)::date AS month, count(*) AS bill_count,
           sum(sub_total) AS costs, sum(total) AS costs_inc_gst,
           sum(amount_paid) AS paid, sum(amount_due) AS unpaid
    FROM public.xero_invoices
    WHERE invoice_type = 'ACCPAY' AND status NOT IN ('VOIDED', 'DELETED', 'DRAFT')
    GROUP BY org_id, date_trunc('month', invoice_date);
  END IF;
  IF to_regclass('public.aged_receivables') IS NULL THEN
    CREATE VIEW public.aged_receivables AS
    SELECT org_id, xero_contact_id, contact_name, invoice_number, invoice_date, due_date, amount_due,
           CASE
             WHEN due_date >= CURRENT_DATE THEN 'current'
             WHEN due_date >= CURRENT_DATE - INTERVAL '30 days' THEN '1-30'
             WHEN due_date >= CURRENT_DATE - INTERVAL '60 days' THEN '31-60'
             WHEN due_date >= CURRENT_DATE - INTERVAL '90 days' THEN '61-90'
             ELSE '90+'
           END AS age_bucket
    FROM public.xero_invoices
    WHERE invoice_type = 'ACCREC' AND status IN ('AUTHORISED', 'SUBMITTED') AND amount_due > 0;
  END IF;
END
$views$;
GRANT ALL ON public.job_financials, public.aged_receivables, public.monthly_revenue, public.monthly_costs
  TO anon, authenticated, service_role;
GRANT SELECT (org_id) ON public.monthly_costs TO PUBLIC;

-- The pre-migration shape of job_events: row security on, the 2025 rules
-- for PUBLIC, Supabase's default grants to each API role.
ALTER TABLE public.job_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view job events" ON public.job_events;
DROP POLICY IF EXISTS "Users can create events" ON public.job_events;
CREATE POLICY "Users can view job events" ON public.job_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_events.job_id AND jobs.org_id = auth_org_id()));
CREATE POLICY "Users can create events" ON public.job_events FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM jobs WHERE jobs.id = job_events.job_id AND jobs.org_id = auth_org_id()));
GRANT ALL ON public.job_events TO anon, authenticated, service_role;
-- The rules read jobs and users as the caller (Supabase's default grants).
GRANT SELECT ON public.jobs, public.users TO authenticated;

-- Grants, rules and row security on the five relations just before the
-- migration.
CREATE SCHEMA zfv_before;
CREATE TABLE zfv_before.grants AS
SELECT c.relname::text AS relation, NULL::text AS column_name,
       a.grantee::regrole::text AS grantee, a.privilege_type, a.is_grantable
FROM pg_class c
CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('job_financials', 'aged_receivables', 'monthly_revenue', 'monthly_costs', 'job_events')
UNION ALL
SELECT c.relname::text, at.attname::text, a.grantee::regrole::text, a.privilege_type, a.is_grantable
FROM pg_class c
JOIN pg_attribute at ON at.attrelid = c.oid AND at.attnum > 0 AND NOT at.attisdropped AND at.attacl IS NOT NULL
CROSS JOIN LATERAL aclexplode(at.attacl) a
WHERE c.relnamespace = 'public'::regnamespace
  AND c.relname IN ('job_financials', 'aged_receivables', 'monthly_revenue', 'monthly_costs', 'job_events');
CREATE TABLE zfv_before.policies AS
SELECT polname::text AS name, polcmd::text AS cmd, polpermissive AS permissive,
       polroles::regrole[]::text AS roles,
       pg_get_expr(polqual, polrelid) AS using_expr, pg_get_expr(polwithcheck, polrelid) AS check_expr
FROM pg_policy WHERE polrelid = 'public.job_events'::regclass;
CREATE TABLE zfv_before.row_security AS
SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'public.job_events'::regclass;
