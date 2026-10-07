-- Prerequisites for 20261007060000_context_party_roles_v4. Earlier registered
-- cases create every table the v4 classifier reads: business_events and its
-- party-role trigger (20261005200000), v2's helpers (20261006000000), v3's
-- classifier (20261006034000), sales_booking_packs with kind roster
-- (20260917130000, 20260917200000), xero_invoices, trade_invoices, users,
-- suppliers and makesafe_companies. This adds only the two live columns no
-- earlier fixture declares (users.xero_contact_id, suppliers.xero_contact_id,
-- both text as live) and the live read grants the service role holds on the
-- tables the classifier reads, so the service-role preview proof runs as it
-- does in production. It fails early, and by name, if a prerequisite is
-- missing.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS xero_contact_id text;
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS xero_contact_id text;
DO $$
DECLARE f text;
BEGIN
 FOREACH f IN ARRAY ARRAY['public.context_message_party_roles(public.business_events)','public.context_stamp_party_roles()',
   'public.context_party_key_roles(text,text)','public.context_party_contact_roles(text)','public.context_party_supplier_key(text,text)',
   'public.context_party_user_role(text,text)','public.context_party_builder_address(text)'] LOOP
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'party roles v4 setup: % is missing from the registered stack', f; END IF;
 END LOOP;
 FOREACH f IN ARRAY ARRAY['public.sales_booking_packs','public.xero_invoices','public.trade_invoices','public.users','public.suppliers',
   'public.makesafe_companies','public.contact_matches','public.sales_booking_executions','public.jobs','public.job_contacts'] LOOP
  IF to_regclass(f) IS NULL THEN RAISE EXCEPTION 'party roles v4 setup: table % is missing from the registered stack', f; END IF;
 END LOOP;
END $$;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT ON public.business_events, public.jobs, public.job_contacts, public.users, public.suppliers, public.makesafe_companies,
 public.contact_matches, public.sales_booking_executions, public.sales_booking_packs, public.xero_invoices, public.trade_invoices TO service_role;
