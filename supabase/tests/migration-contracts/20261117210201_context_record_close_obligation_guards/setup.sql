\ir ../20261117195201_context_ledger_record_candidates/setup.sql
CREATE TABLE IF NOT EXISTS public.users(id uuid PRIMARY KEY,org_id uuid NOT NULL,name text NOT NULL,role text);
