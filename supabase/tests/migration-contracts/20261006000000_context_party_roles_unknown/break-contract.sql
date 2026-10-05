-- Ship v2 with the GHL-contact path unwired: a contact's leads and the
-- phones and emails it is known by are never read. The contract must catch it.
CREATE OR REPLACE FUNCTION public.context_party_contact_roles(p_contact text) RETURNS TABLE(r_role text,r_basis text)
LANGUAGE sql STABLE AS $$ SELECT NULL::text,NULL::text WHERE false $$;
