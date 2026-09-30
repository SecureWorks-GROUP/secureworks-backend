-- Put back the production hole on one function; the contract must notice.
GRANT EXECUTE ON FUNCTION public.send_ghl_sms(text, text, uuid) TO anon;
