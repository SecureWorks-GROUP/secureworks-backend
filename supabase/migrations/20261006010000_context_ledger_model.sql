-- The job ledger: the data model only (story slice S0, 6 Oct 2026).
--
-- Why. The owner wants to open any job and understand its whole story: what
-- was promised, asked, claimed, agreed and changed, what is still open and why
-- (done-definition rows 11 and 12, 5 Oct 2026). The fact store cannot hold
-- that: its kinds end on clocks (a request vanishes after 7 days whether or
-- not anyone answered it) and it reads 25 rows at a time. The three
-- independent reviews agreed on a record-built timeline plus a ledger the
-- model writes from the job's whole history, closed only by evidence
-- (data/cio-ctx-story-compare/report.md section 4).
--
-- This migration creates the empty ledger and nothing that writes to it:
--
--   context_ledger_generations  one complete reading of one job's history by
--                               one reader. building -> shadow -> live ->
--                               retired (or failed). At most one live and one
--                               building generation per job. The story shows
--                               only the live one unless asked for another.
--   context_ledger_items        what the reader found: commitments, requests,
--                               claims, issues, constraints, dependencies,
--                               agreements, events no record shows, and phase
--                               notes. Each cites the rows that opened it
--                               (table, id, verbatim excerpt) and, once closed,
--                               the rows that closed it. Nothing here has an
--                               expiry: an item closes only on evidence.
--   context_ledger_transitions  append-only history of every status change,
--                               who made it (model, person or rule) and why.
--   context_ledger_settings     one row: the ledger lane's mode (off, shadow,
--                               live) and its own daily call ceiling inside
--                               the shared 400. Seeded off with 0 calls.
--
-- Writers come later (the store, 20261006013000) and must enforce custody:
-- cited rows on this job, verbatim excerpts, the speaker of customer items is
-- the customer, person-written items are never changed by the model.
-- Unchanged: the fact store, its clocks and every reader of it.
-- Rollback: supabase/rollbacks/20261006010000_context_ledger_model_down.sql
-- (drops the four tables; nothing reads them yet).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 0. Guard: each table is absent or this migration's (re-apply is a no-op).
DO $guard$
DECLARE problems text[] := '{}'; t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['public.context_ledger_generations','public.context_ledger_items',
                          'public.context_ledger_transitions','public.context_ledger_settings'] LOOP
  IF to_regclass(t) IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM pg_description d
     WHERE d.objoid = to_regclass(t) AND d.classoid = 'pg_class'::regclass AND d.objsubid = 0
       AND d.description LIKE 'Context ledger:%') THEN
   problems := problems || format('%s exists and is not this migration''s', t);
  END IF;
 END LOOP;
 IF to_regclass('public.jobs') IS NULL THEN problems := problems || 'public.jobs is missing'::text; END IF;
 IF to_regclass('public.context_extraction_runs') IS NULL THEN
  problems := problems || 'public.context_extraction_runs is missing'::text;
 END IF;
 IF cardinality(problems) > 0 THEN
  RAISE EXCEPTION 'context_ledger_model_preimage_mismatch: %', array_to_string(problems, '; ');
 END IF;
END $guard$;

-- 1. Generations: one reading of one job.
CREATE TABLE IF NOT EXISTS public.context_ledger_generations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('backfill','rebuild')),
 status text NOT NULL DEFAULT 'building' CHECK (status IN ('building','shadow','live','retired','failed')),
 reader text NOT NULL CHECK (length(reader) BETWEEN 1 AND 80),
 model text CHECK (model IS NULL OR length(model) <= 80),
 prompt_sha256 text CHECK (prompt_sha256 IS NULL OR prompt_sha256 ~ '^[0-9a-f]{64}$'),
 run_id uuid REFERENCES public.context_extraction_runs(id),
 evidence_until timestamptz,
 evidence_rows integer NOT NULL DEFAULT 0 CHECK (evidence_rows >= 0),
 chunks integer NOT NULL DEFAULT 0 CHECK (chunks >= 0),
 calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
 checks jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checks) = 'object'),
 failure text CHECK (failure IS NULL OR length(failure) <= 200),
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 promoted_at timestamptz,
 retired_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (status <> 'live' OR promoted_at IS NOT NULL),
 CHECK (status <> 'failed' OR failure IS NOT NULL)
);
COMMENT ON TABLE public.context_ledger_generations IS
 'Context ledger: one complete reading of one job''s history by one reader (20261006010000). building -> shadow -> live -> retired, or failed. At most one live and one building generation per job. evidence_until is the newest evidence (recorded time) the reader saw. Service role only; written only by the ledger store functions.';
CREATE UNIQUE INDEX IF NOT EXISTS context_ledger_generations_one_live
 ON public.context_ledger_generations (job_id) WHERE status = 'live';
CREATE UNIQUE INDEX IF NOT EXISTS context_ledger_generations_one_building
 ON public.context_ledger_generations (job_id) WHERE status = 'building';
CREATE INDEX IF NOT EXISTS context_ledger_generations_job_created
 ON public.context_ledger_generations (job_id, created_at DESC);

-- 2. Items: what the reader found, each cited.
CREATE TABLE IF NOT EXISTS public.context_ledger_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 generation_id uuid NOT NULL REFERENCES public.context_ledger_generations(id) ON DELETE CASCADE,
 job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
 item_key text NOT NULL CHECK (length(item_key) BETWEEN 1 AND 200),
 item_type text NOT NULL CHECK (item_type IN
  ('commitment','request','claim','issue','constraint','dependency','agreement','event','phase_note')),
 status text NOT NULL CHECK (status IN ('open','closed','declined','superseded','disputed','info')),
 from_role text NOT NULL CHECK (from_role IN
  ('us','crew','customer','supplier','insurer_builder','third_party','unknown')),
 from_name text CHECK (from_name IS NULL OR length(from_name) <= 120),
 to_role text CHECK (to_role IS NULL OR to_role IN
  ('us','crew','customer','supplier','insurer_builder','third_party','unknown')),
 to_name text CHECK (to_name IS NULL OR length(to_name) <= 120),
 what text NOT NULL CHECK (length(what) BETWEEN 1 AND 600),
 about_key text CHECK (about_key IS NULL OR length(about_key) BETWEEN 1 AND 120),
 modality text CHECK (modality IS NULL OR modality IN ('requested','offered','agreed','declined','reported','confirmed')),
 phase text CHECK (phase IS NULL OR phase IN
  ('enquiry','scope','quote','accepted','deposit','approvals','materials','scheduled','install','complete',
   'invoice','payment','rectification','makesafe','other')),
 due_date date,
 due_basis text NOT NULL DEFAULT 'none' CHECK (due_basis IN ('stated','none')),
 opened_at timestamptz NOT NULL,
 opened_by jsonb NOT NULL CHECK (jsonb_typeof(opened_by) = 'array' AND jsonb_array_length(opened_by) BETWEEN 1 AND 25),
 closed_at timestamptz,
 closed_by jsonb CHECK (closed_by IS NULL OR (jsonb_typeof(closed_by) = 'array' AND jsonb_array_length(closed_by) BETWEEN 1 AND 25)),
 closes_on text CHECK (closes_on IS NULL OR closes_on IN
  ('reply','call','quote_sent','invoice_issued','payment','booking_made','visit','work_done','record','person','none')),
 supersedes_key text CHECK (supersedes_key IS NULL OR length(supersedes_key) BETWEEN 1 AND 200),
 blocks text CHECK (blocks IS NULL OR blocks IN
  ('quote','acceptance','deposit','booking','install','completion','payment','none')),
 needs_reply boolean,
 also_concerns text CHECK (also_concerns IS NULL OR length(also_concerns) <= 200),
 written_by text NOT NULL CHECK (written_by ~ '^(model|person|rule):.{1,80}$'),
 person_locked boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (generation_id, item_key),
 CHECK (due_date IS NULL OR due_basis = 'stated'),
 CHECK ((status IN ('closed','declined','superseded')) = (closed_at IS NOT NULL)),
 CHECK (status NOT IN ('closed','declined') OR closed_by IS NOT NULL OR written_by LIKE 'person:%' OR person_locked)
);
COMMENT ON TABLE public.context_ledger_items IS
 'Context ledger: what the reader found on a job (20261006010000): commitments, requests, claims, issues, constraints, dependencies, agreements, events no record shows, phase notes. opened_by and closed_by are arrays of {table,id,excerpt}; the excerpt is verbatim from the cited row. No expiry: an item closes only when evidence closes it. person_locked items are never changed by the model. Service role only; written only by the ledger store functions.';
CREATE INDEX IF NOT EXISTS context_ledger_items_job_status ON public.context_ledger_items (job_id, status);
CREATE INDEX IF NOT EXISTS context_ledger_items_generation ON public.context_ledger_items (generation_id);

-- 3. Transitions: append-only history.
CREATE TABLE IF NOT EXISTS public.context_ledger_transitions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 item_id uuid NOT NULL REFERENCES public.context_ledger_items(id) ON DELETE CASCADE,
 generation_id uuid NOT NULL REFERENCES public.context_ledger_generations(id) ON DELETE CASCADE,
 job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
 from_status text CHECK (from_status IS NULL OR from_status IN ('open','closed','declined','superseded','disputed','info')),
 to_status text NOT NULL CHECK (to_status IN ('open','closed','declined','superseded','disputed','info')),
 at timestamptz NOT NULL DEFAULT now(),
 by text NOT NULL CHECK (by ~ '^(model|person|rule):.{1,80}$'),
 evidence jsonb CHECK (evidence IS NULL OR jsonb_typeof(evidence) = 'array'),
 reason text CHECK (reason IS NULL OR length(reason) <= 600)
);
COMMENT ON TABLE public.context_ledger_transitions IS
 'Context ledger: append-only history of every ledger item status change (20261006010000): from, to, when, by whom (model:<reader>, person:<user id>, rule:<name>), the evidence rows and the reason. Service role only.';
CREATE INDEX IF NOT EXISTS context_ledger_transitions_item ON public.context_ledger_transitions (item_id, at);
CREATE INDEX IF NOT EXISTS context_ledger_transitions_job ON public.context_ledger_transitions (job_id, at);

-- 4. Settings: the lane's switch, off until the owner says otherwise.
CREATE TABLE IF NOT EXISTS public.context_ledger_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK (id),
 mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off','shadow','live')),
 calls_per_day integer NOT NULL DEFAULT 0 CHECK (calls_per_day BETWEEN 0 AND 400),
 max_prompt_bytes integer NOT NULL DEFAULT 110000 CHECK (max_prompt_bytes BETWEEN 20000 AND 131072),
 reader text NOT NULL DEFAULT 'luna-ledger:v1' CHECK (length(reader) BETWEEN 1 AND 80),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by text,
 note text
);
COMMENT ON TABLE public.context_ledger_settings IS
 'Context ledger: the ledger lane''s switch (20261006010000). mode off = no reads; shadow = read jobs into shadow generations nobody is shown; live = promote passing generations and keep them current. calls_per_day is the lane''s own ceiling inside the shared 400 model calls a Perth day; the live reserve still applies. One row; seeded off with 0 calls. Service role only.';
INSERT INTO public.context_ledger_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- 5. Access: service role only, read; writes only through the store functions.
ALTER TABLE public.context_ledger_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_ledger_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_ledger_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_ledger_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.context_ledger_generations, public.context_ledger_items,
 public.context_ledger_transitions, public.context_ledger_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.context_ledger_generations, public.context_ledger_items,
 public.context_ledger_transitions, public.context_ledger_settings FROM service_role;
GRANT SELECT ON TABLE public.context_ledger_generations, public.context_ledger_items,
 public.context_ledger_transitions, public.context_ledger_settings TO service_role;
