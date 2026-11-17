-- P2-02.1: matcher evidence storage only. No matching, placement or live action.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.match_clue_types (
  code text PRIMARY KEY,
  class text NOT NULL CHECK (class IN ('key', 'clue', 'narrower', 'ai')),
  family text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('counts', 'suggest_only', 'off')),
  words text NOT NULL,
  right_count int NOT NULL DEFAULT 0,
  wrong_count int NOT NULL DEFAULT 0,
  mode_changed_at timestamptz,
  mode_changed_by text,
  CONSTRAINT match_clue_types_counts_class_check
    CHECK (class IN ('key', 'clue') OR mode <> 'counts')
);

INSERT INTO public.match_clue_types (code, class, family, mode, words) VALUES
  ('job_number', 'key', 'doc_text', 'counts', 'Our job number is written on the document'),
  ('order_number', 'key', 'order', 'counts', 'The document names one of our orders'),
  ('sealed_scope_order', 'key', 'order', 'counts', 'An order from the sealed scope was sent to this supplier and its cost equals this bill'),
  ('trade_app_link', 'key', 'trade_app', 'counts', 'A trade filed this against the job in the Trade App'),
  ('order_amount', 'clue', 'order', 'suggest_only', 'One open order from this supplier is for this amount'),
  ('delivery_address', 'clue', 'address', 'suggest_only', 'The delivery address is this job''s site'),
  ('supplier_mail', 'clue', 'mail', 'suggest_only', 'The supplier''s email with this invoice number is filed on this job'),
  ('booked_trade_day', 'clue', 'roster', 'suggest_only', 'The trade who filed it was booked on this job that day'),
  ('scope_items', 'clue', 'scope', 'suggest_only', 'The items are on this job''s sealed material list'),
  ('learned_rule', 'clue', 'rule', 'suggest_only', 'A rule staff confirmed for this supplier'),
  ('overhead_account', 'clue', 'account', 'suggest_only', 'Every line is on an overhead account'),
  ('group_tag', 'clue', 'tag', 'suggest_only', 'Every line is tagged SW - GROUP'),
  ('ai_read', 'ai', 'ai', 'suggest_only', 'The AI read the document (a suggestion only)'),
  ('division_tag', 'narrower', 'tag', 'off', 'The Xero tag'),
  ('xero_link_legacy', 'narrower', 'legacy', 'off', 'Xero links this to the job'),
  ('supplier_history', 'narrower', 'history', 'off', 'Where this supplier''s bills usually go')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.match_clues (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('cost_document', 'message')),
  subject_id text NOT NULL,
  run_id uuid NOT NULL,
  clue_code text NOT NULL REFERENCES public.match_clue_types(code),
  class text NOT NULL,
  family text NOT NULL,
  root text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('job', 'overhead', 'division_stock')),
  job_id uuid,
  division text,
  names_one boolean NOT NULL,
  seen_where text,
  seen_value text,
  detail jsonb NOT NULL DEFAULT '{}',
  rule_version text NOT NULL,
  kept_from text,
  current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS match_clues_current_subject_idx
  ON public.match_clues (subject_kind, subject_id) WHERE current;
COMMENT ON COLUMN public.match_clues.kept_from IS
  'NULL for matcher-run clues replaced by the next run; a source such as phase3:bill_pdf for handed-in clues kept current across runs.';

CREATE TABLE IF NOT EXISTS public.match_queue (
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  reason text NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_kind, subject_id)
);

CREATE TABLE IF NOT EXISTS public.match_shadow_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_kind text,
  subject_id text,
  run_id uuid,
  result jsonb NOT NULL,
  stops jsonb,
  rule_version text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.match_rules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('supplier_usually_overhead', 'supplier_usually_division_stock')),
  party_id text NOT NULL,
  division text,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'retired')),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by text,
  confirmed_at timestamptz,
  right_count int NOT NULL DEFAULT 0,
  wrong_count int NOT NULL DEFAULT 0,
  UNIQUE (kind, party_id)
);

ALTER TABLE public.match_clue_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_clues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_shadow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS match_clue_types_service_role ON public.match_clue_types;
CREATE POLICY match_clue_types_service_role ON public.match_clue_types
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS match_clues_service_role ON public.match_clues;
CREATE POLICY match_clues_service_role ON public.match_clues
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS match_queue_service_role ON public.match_queue;
CREATE POLICY match_queue_service_role ON public.match_queue
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS match_shadow_runs_service_role ON public.match_shadow_runs;
CREATE POLICY match_shadow_runs_service_role ON public.match_shadow_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS match_rules_service_role ON public.match_rules;
CREATE POLICY match_rules_service_role ON public.match_rules
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.match_clue_types, public.match_clues, public.match_queue,
  public.match_shadow_runs, public.match_rules FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.match_clue_types, public.match_clues, public.match_queue,
  public.match_shadow_runs, public.match_rules TO service_role;
REVOKE ALL ON SEQUENCE public.match_clues_id_seq, public.match_shadow_runs_id_seq,
  public.match_rules_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.match_clues_id_seq, public.match_shadow_runs_id_seq,
  public.match_rules_id_seq TO service_role;

INSERT INTO public.feature_flags (flag_name, enabled, description)
VALUES ('reconcile_matcher_v1', false, 'P2-02.1: reconcile matcher, off until approved.')
ON CONFLICT (flag_name) DO NOTHING;
