-- Deliberately remove the promised access control: the contract must fail.
ALTER TABLE public.debt_ws_sends DISABLE ROW LEVEL SECURITY;
