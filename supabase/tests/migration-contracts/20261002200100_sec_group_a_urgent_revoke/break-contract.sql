-- Deliberately reopen one function to the public key; contract.sql must fail.
GRANT EXECUTE ON FUNCTION public.send_outlook_email_b64(text,text,text,text,text,text,text) TO anon;
