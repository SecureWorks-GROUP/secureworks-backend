-- The registered stack supplies business_events, the ladder, the reason step (20260924183000), users (email, phone) and
-- suppliers (email, phone). Dispatch's approved supplier order addresses (20261023214100, not a registered case) are
-- added here with the live column names and types this migration reads.
CREATE TABLE IF NOT EXISTS public.dispatch_approved_supplier_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  name text NOT NULL,
  used_for text NOT NULL DEFAULT 'any',
  to_emails text[] NOT NULL,
  cc_emails text[] NOT NULL DEFAULT ARRAY[]::text[],
  active boolean NOT NULL DEFAULT true,
  approved_by text NOT NULL DEFAULT 'contract',
  approved_on date NOT NULL DEFAULT DATE '2026-10-23',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
 IF to_regprocedure('public.context_bucket_reason_detail(public.business_events,jsonb)') IS NULL
 OR to_regprocedure('public.attribute_business_event()') IS NULL
 OR to_regclass('public.users') IS NULL OR to_regclass('public.suppliers') IS NULL THEN
  RAISE EXCEPTION 'c2 not-job senders prerequisites missing';
 END IF;
END $$;
