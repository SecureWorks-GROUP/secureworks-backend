-- Deliberately remove the promised access control: the contract must fail.
ALTER TABLE public.payment_chase_logs DISABLE ROW LEVEL SECURITY;
