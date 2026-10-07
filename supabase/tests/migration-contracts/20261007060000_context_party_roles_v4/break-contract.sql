-- Ship v4 with its four record readers unwired: no CRM opportunity, no
-- domain in our records, no Xero bill and no call stamp is ever read. The
-- contract must name every rule that stops working (the outbound material
-- order itself is read in the classifier and still names its supplier).
CREATE OR REPLACE FUNCTION public.context_party_crm_roles(p_contact text,p_email_key text,p_phone_key text,p_at timestamptz)
RETURNS TABLE(r_role text,r_basis text) LANGUAGE sql STABLE AS $$ SELECT NULL::text,NULL::text WHERE false $$;
CREATE OR REPLACE FUNCTION public.context_party_domain_roles(p_address text)
RETURNS TABLE(r_role text,r_basis text) LANGUAGE sql STABLE AS $$ SELECT NULL::text,NULL::text WHERE false $$;
CREATE OR REPLACE FUNCTION public.context_party_xero_bill(p_subject text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.context_party_call_roles(e public.business_events) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT NULL::jsonb $$;
