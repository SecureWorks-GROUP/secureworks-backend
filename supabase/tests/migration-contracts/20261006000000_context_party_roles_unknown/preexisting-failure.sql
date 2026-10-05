-- The classifier is no longer #962's body (someone changed it since): the
-- guard must refuse rather than replace a body it has not read.
CREATE OR REPLACE FUNCTION public.context_message_party_roles(e public.business_events) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$ BEGIN RETURN NULL; END $$;
