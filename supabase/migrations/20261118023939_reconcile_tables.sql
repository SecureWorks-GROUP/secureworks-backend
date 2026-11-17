-- P2-03.1 only. The shared list and immutable decision history.
-- No caller, business-table trigger, schedule, switch change or historical write.
-- Item/decision production and archive policy belong to the following slices;
-- this slice seeds a finite catalogue only and installs no timer over the log.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.reconcile_item_kinds (
 kind text PRIMARY KEY,
 tab text NOT NULL CHECK (tab IN ('bills','card_bank','receipts','messages','pay','other','weekly')),
 words text NOT NULL,
 card text NOT NULL CHECK (card IN ('cost','message','pay_claim','pay_line','weekly','generic'))
);
INSERT INTO public.reconcile_item_kinds(kind,tab,words,card) VALUES
 ('bill','bills','Bill','cost'),
 ('credit','bills','Credit','cost'),
 ('receipt','receipts','Receipt','cost'),
 ('card_line','card_bank','Card line','cost'),
 ('bank_line','card_bank','Bank line','cost'),
 ('message','messages','Message','message'),
 ('weekly_check','weekly','Weekly check','weekly'),
 ('pay_claim_stopped','pay','Pay claim stopped','pay_claim'),
 ('group_claim_no_agreement','pay','Group claim not agreed','pay_claim'),
 ('invoice_no_work_order','pay','Invoice with no work order','pay_claim'),
 ('pay_line_held','pay','Pay line held','pay_line'),
 ('invoice_no_job','other','Customer invoice on no job','generic'),
 ('credit_note_unmatched','bills','Credit not against a bill','generic'),
 ('credit_note_proposed','bills','Credit read from its document','generic'),
 ('bill_reference_from_pdf','bills','Reference found in a bill''s PDF','generic'),
 ('draft_incomplete','other','Draft missing something','generic'),
 ('message_no_job','messages','Message on no job','generic'),
 ('open_item_check','other','Open item to check','generic'),
 ('agent_money_proposal','other','Money step proposed by an agent','generic'),
 ('ai_job_failed','other','An AI job failed','generic')
ON CONFLICT(kind) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.reconcile_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL,
 kind text NOT NULL REFERENCES public.reconcile_item_kinds(kind),
 subject_table text NOT NULL, subject_id text NOT NULL,
 job_ids uuid[] NOT NULL DEFAULT '{}', reason text NOT NULL,
 amount_ex numeric(12,2), document_date date,
 summary jsonb NOT NULL DEFAULT '{}', suggestion jsonb,
 evidence jsonb NOT NULL DEFAULT '{}', evidence_hash text NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','decided','withdrawn')),
 raised_by text NOT NULL, raised_at timestamptz NOT NULL DEFAULT now(),
 snooze_until timestamptz, closed_at timestamptz, decision_id bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS reconcile_items_one_open
 ON public.reconcile_items(kind,subject_table,subject_id) WHERE status='open';
CREATE INDEX IF NOT EXISTS reconcile_items_list_idx
 ON public.reconcile_items(status,kind,amount_ex DESC NULLS LAST,raised_at);
CREATE INDEX IF NOT EXISTS reconcile_items_jobs_idx ON public.reconcile_items USING gin(job_ids);
-- The unique index starts with kind. This read spans kinds of one subject.
CREATE INDEX IF NOT EXISTS reconcile_items_open_subject_idx
 ON public.reconcile_items(subject_table,subject_id) WHERE status='open';
COMMENT ON TABLE public.reconcile_items IS
 'Only reconcile_item_raise inserts items. Shared list; decision/withdraw functions change their state. Writers are delivered separately.';

CREATE TABLE IF NOT EXISTS public.reconcile_decisions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, org_id uuid NOT NULL,
 item_id uuid, subject_kind text NOT NULL, subject_id text NOT NULL,
 action text NOT NULL CHECK (action IN ('place','split','overhead','division_stock','duplicate','not_duplicate','leave','resolve','message','undo')),
 accepted_suggestion boolean NOT NULL DEFAULT false, parts jsonb, clue_ids bigint[],
 before jsonb NOT NULL DEFAULT '{}', shown_hash text, context_decision_id bigint, note text,
 "by" text NOT NULL CONSTRAINT reconcile_decisions_by_check
  CHECK ("by" ~ '^(person:[0-9a-f-]{36}|matcher:v[0-9]+|source:[a-z_]+|legacy:[a-z_]+)$'),
 decided_at timestamptz NOT NULL DEFAULT now(), supersedes bigint REFERENCES public.reconcile_decisions(id),
 CONSTRAINT reconcile_decisions_person_only CHECK (
  action NOT IN ('overhead','division_stock','duplicate','not_duplicate')
  OR "by" LIKE 'person:%' OR "by" LIKE 'legacy:%')
);
CREATE INDEX IF NOT EXISTS reconcile_decisions_subject_idx
 ON public.reconcile_decisions(subject_kind,subject_id,decided_at DESC,id DESC);
COMMENT ON TABLE public.reconcile_decisions IS
 'Append-only decision history. Undo adds a new row; earlier decisions are never rewritten. No scheduled writer is installed here.';
CREATE OR REPLACE FUNCTION public.reconcile_decisions_append_only() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $fn$
/* block */ BEGIN
 RAISE EXCEPTION 'reconcile_decisions_append_only';
END $fn$;
DROP TRIGGER IF EXISTS reconcile_decisions_append_only ON public.reconcile_decisions;
CREATE TRIGGER reconcile_decisions_append_only BEFORE UPDATE OR DELETE ON public.reconcile_decisions
 FOR EACH ROW EXECUTE FUNCTION public.reconcile_decisions_append_only();

DO $fk$
/* block */ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.job_cost_lines'::regclass
  AND conname='job_cost_lines_decision_fk') THEN
  ALTER TABLE public.job_cost_lines ADD CONSTRAINT job_cost_lines_decision_fk
   FOREIGN KEY(decision_id) REFERENCES public.reconcile_decisions(id);
 END IF;
END $fk$;

ALTER TABLE public.reconcile_item_kinds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconcile_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconcile_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reconcile_item_kinds,public.reconcile_items,public.reconcile_decisions
 FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.reconcile_item_kinds,public.reconcile_items TO service_role;
GRANT SELECT,INSERT ON public.reconcile_decisions TO service_role;
REVOKE ALL ON SEQUENCE public.reconcile_decisions_id_seq FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE,SELECT ON SEQUENCE public.reconcile_decisions_id_seq TO service_role;
REVOKE ALL ON FUNCTION public.reconcile_decisions_append_only() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_decisions_append_only() TO service_role;
DROP POLICY IF EXISTS reconcile_item_kinds_service ON public.reconcile_item_kinds;
CREATE POLICY reconcile_item_kinds_service ON public.reconcile_item_kinds TO service_role USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS reconcile_items_service ON public.reconcile_items;
CREATE POLICY reconcile_items_service ON public.reconcile_items TO service_role USING(true) WITH CHECK(true);
DROP POLICY IF EXISTS reconcile_decisions_service ON public.reconcile_decisions;
CREATE POLICY reconcile_decisions_service ON public.reconcile_decisions TO service_role USING(true) WITH CHECK(true);

-- Preserve every other arm and column of the current main view. Its parent
-- v_job_cost_events still chooses legacy until BOTH switch and cutover are ready.
-- Cost line PK/needs-person index selects lines; open_subject_idx bounds the
-- correlated item lookup. Multiple item kinds may agree, never multiply costs.
-- Missing/invalid or conflicting job suggestions yield no asserted allocation.
DO $view$
DECLARE d text;
/* block */ BEGIN
 d:=pg_get_viewdef('public.v_job_cost_events_lines'::regclass,true);
 IF md5(d)='d8ccd9fe8847bbcb735baa871f08fd70' THEN
  d:=replace(d,$old$JOIN ( SELECT NULL::text AS document_id,
            NULL::uuid AS job_id
          WHERE false) s ON s.document_id = l.document_id$old$,$new$JOIN LATERAL (
       SELECT (array_agg(DISTINCT (ri.suggestion ->> 'job_id')::uuid))[1] AS job_id
       FROM public.reconcile_items ri
       WHERE ri.status = 'open' AND ri.subject_table = 'cost_document'
         AND ri.subject_id = l.document_kind || ':' || l.document_id
         AND ri.org_id = l.org_id
         AND (ri.suggestion ->> 'job_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       HAVING count(DISTINCT (ri.suggestion ->> 'job_id')::uuid) = 1
     ) s ON true$new$);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events_lines AS '||d;
 ELSIF md5(d)<>'c98dd14a51e982b78493c3385b25c9d9' THEN
  RAISE EXCEPTION 'P2-03.1: cost line reader pre-image differs';
 END IF;
END $view$;
