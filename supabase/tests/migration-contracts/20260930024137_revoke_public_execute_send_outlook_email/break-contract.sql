-- Put back the production hole on one overload; the contract must notice.
GRANT EXECUTE ON FUNCTION public.send_outlook_email(text, text, text, text, text, text, text) TO authenticated;
