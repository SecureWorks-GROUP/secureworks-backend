-- Minimal table prerequisites only; no function stand-ins.
DO $setup$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $setup$;
CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY, org_id uuid, name text, role text);
CREATE TABLE IF NOT EXISTS public.trade_pay_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pay_run_approver_user_ids uuid[] NOT NULL DEFAULT '{}'
);
INSERT INTO public.trade_pay_settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING;
CREATE TABLE IF NOT EXISTS public.work_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
