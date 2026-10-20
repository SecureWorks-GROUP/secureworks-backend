-- Deliberately remove the promised access control: the contract must fail.
ALTER TABLE public.xero_mirror_checks DISABLE ROW LEVEL SECURITY;
