-- Deliberately remove the foreign key: the contract must fail.
ALTER TABLE public.quote_revisions DROP CONSTRAINT quote_revisions_scope_revision_id_fkey;
