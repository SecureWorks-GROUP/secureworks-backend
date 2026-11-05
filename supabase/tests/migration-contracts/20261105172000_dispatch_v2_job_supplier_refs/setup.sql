-- Prerequisites for 20261105172000_dispatch_v2_job_supplier_refs: dispatch_v2_supplier_order_refs as it stands
-- before this migration (production: 20261023230000_dispatch_v2_replies_tables.sql; order_id NOT NULL, one key on
-- order_id and ref). 20261104010000_dispatch_order_bill_links registers the same narrow stand-in first; this keeps
-- to it.
CREATE TABLE IF NOT EXISTS public.dispatch_v2_supplier_order_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  order_id uuid NOT NULL,
  job_id uuid NOT NULL,
  supplier_key text NULL,
  supplier_name text NULL,
  ref text NOT NULL,
  linked_via text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_v2_supplier_order_refs_unique UNIQUE (order_id, ref)
);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'dispatch_v2_supplier_order_refs' AND column_name = 'order_id'
                  AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'Tweak 2 supplier refs prerequisites: order_id should start NOT NULL';
  END IF;
END $$;
