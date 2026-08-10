-- Rollback twin of 20260808010000_ses_echo_code_approval.sql.
-- Retires the echo-code approval door: both SECURITY DEFINER functions, the
-- service-role policy and the attempt-limit table itself.
--
-- Dropping the table destroys the single-use and lockout state, so every
-- pending request becomes unverifiable and every live cooling window is
-- cleared. Run this only with the echo-code call sites already withdrawn
-- (`issue_ses_channel_approval` / `submit_ses_channel_approval`), never while
-- the door is live: an approval door with no attempt ledger would be a door
-- with unlimited guessing.

DROP FUNCTION IF EXISTS public.consume_ses_channel_approval_code(uuid, text, text, text, text, timestamptz, integer, interval);
DROP FUNCTION IF EXISTS public.issue_ses_channel_approval_request(uuid, uuid, text, text, uuid, text, text, timestamptz, timestamptz);

DROP POLICY IF EXISTS ses_channel_approval_attempts_service_role_only
  ON public.ses_channel_approval_attempts;

DROP INDEX IF EXISTS public.ses_channel_approval_request_lookup;
DROP INDEX IF EXISTS public.ses_channel_approval_lockout_identity;

DROP TABLE IF EXISTS public.ses_channel_approval_attempts;
