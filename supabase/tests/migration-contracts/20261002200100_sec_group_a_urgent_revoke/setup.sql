-- Pre-migration state for 20261002200100_sec_group_a_urgent_revoke.
-- Stand-ins for the two live-only functions, with the signatures, security
-- mode and grants the 2 Oct read-only production check found: SECURITY
-- DEFINER, owned by the migrating role, EXECUTE held by PUBLIC (the
-- CREATE FUNCTION default) plus Supabase's explicit anon, authenticated and
-- service_role grants. Bodies write a marker row instead of reaching the
-- network.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.group_a_contract_calls (
  id bigserial PRIMARY KEY,
  fn text NOT NULL,
  called_as text NOT NULL DEFAULT current_user,
  session_role text NOT NULL DEFAULT session_user
);
REVOKE ALL ON TABLE public.group_a_contract_calls FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.send_outlook_email_b64(
  p_to text, p_subject text, p_html_body text, p_attachment_b64 text,
  p_attachment_name text, p_from text DEFAULT NULL, p_cc text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.group_a_contract_calls (fn) VALUES ('send_outlook_email_b64');
  RETURN gen_random_uuid();
END;
$$;

CREATE OR REPLACE FUNCTION public.deliver_proposed_actions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.group_a_contract_calls (fn) VALUES ('deliver_proposed_actions');
  RETURN 1;
END;
$$;

GRANT EXECUTE ON FUNCTION
  public.send_outlook_email_b64(text,text,text,text,text,text,text),
  public.deliver_proposed_actions()
TO PUBLIC, anon, authenticated, service_role;
