-- Deliberately grant anon a read of the account rules: the contract must fail.
GRANT SELECT ON TABLE public.xero_account_rules TO anon;
