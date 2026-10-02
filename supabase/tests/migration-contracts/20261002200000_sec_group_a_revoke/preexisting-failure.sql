-- An already-closed Group A function reopened to the public key before the
-- apply (as _sw_service_key once was): the post-check must fail the whole
-- migration rather than leave it open.
GRANT EXECUTE ON FUNCTION public._sw_service_key() TO anon;
