-- Down for 20261106193000_group_on_site_signoff_claim.sql. Deploy the ops-api
-- that writes on-site sign-offs directly before running this. Rows already
-- written keep their capture_request_id; the unique index stays.
DROP FUNCTION IF EXISTS public.record_on_site_client_signoff(uuid, text, uuid, uuid, text, boolean, smallint, text, uuid, text, text, text);
