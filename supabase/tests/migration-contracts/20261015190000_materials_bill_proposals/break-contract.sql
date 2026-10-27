-- Deliberately remove the promised access control: the contract must fail.
ALTER TABLE public.materials_bill_proposals DISABLE ROW LEVEL SECURITY;
