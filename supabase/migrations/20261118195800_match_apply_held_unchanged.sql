-- P2-02.8 (director 02:45, design read 03:26). Three parts.
--
-- 1. A held bill writes no clue rows while its clues are unchanged. With reconcile_matcher_v1 on,
-- match_apply marks the bill's clues not current and inserts the fresh ones BEFORE it reads the
-- stop, so a bill held by a person (a line a person decided, or an undo receipt) got a new clue set
-- on every pass. Now, with the switch on, a held bill whose fresh clues are the same as its current
-- ones (the same semantic key, reconcile_match_clue_key, in the same order) returns the stop and
-- writes nothing. A held bill whose clues CHANGED is still rewritten once and the stop is read again
-- after, so an undo receipt still lets go when the undone evidence is gone. Unchanged: the
-- switch-off shadow path, match_apply_stop, and every bill that is not held.
--
-- 2. match_slow_bills: a bill the runner's time cut while it started with most of the run's
-- budget is counted here; at two such cuts it is parked (reason parked_slow_bill) and the runner
-- passes it over until the sync reports its lines changed. A clean run clears the count. Written
-- only by the xero-sync matcher runner (service role).
--
-- 3. match_bill_read: the runner's per-bill reads, as fixed named reads in one function with
-- SET statement_timeout = '5s'. PostgREST hoists a function's statement_timeout onto the request,
-- so a slow read ends in the database at 5 s instead of running on after the runner stops waiting.
-- The reads are the ones the runner made through PostgREST on main, with the same filters,
-- limits and columns; the jobs and orders reads now carry an order so a limit picks the same rows.
--
-- PLACEHOLDER version: the keeper stamps the real one when the PR is marked ready.
--
-- One new table (no data written, no trigger), three functions; no index, schedule or switch.
-- Indexes: match_clues_current_subject_idx and the match_clue_types primary key (part 1), the
-- match_slow_bills primary key (part 2), and for part 3 the indexes the same reads use on main.
-- match_apply is patched in place from its live body, keeping its grants and settings, and refused
-- unless the live body is main's (20261118195300's) or this one's.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE h text;
/* main's bodies, or this migration's own on a re-apply */ BEGIN
  SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid = to_regprocedure('public.match_clues_unchanged(text,text,jsonb,text)');
  IF h IS NOT NULL AND h <> 'f228062ecc1a3a69e266533282028e5e' THEN RAISE EXCEPTION 'match_apply_held_unchanged: match_clues_unchanged body changed'; END IF;
  SELECT md5(prosrc) INTO h FROM pg_proc WHERE oid = to_regprocedure('public.match_bill_read(text,jsonb)');
  IF h IS NOT NULL AND h <> '5107006995e323d24746b965cf6614c0' THEN RAISE EXCEPTION 'match_apply_held_unchanged: match_bill_read body changed'; END IF;
  IF to_regclass('public.match_slow_bills') IS NOT NULL AND (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum)
       FROM pg_attribute WHERE attrelid = to_regclass('public.match_slow_bills') AND attnum > 0 AND NOT attisdropped)
     IS DISTINCT FROM 'subject_kind:text,subject_id:text,cuts:integer,reason:text,last_cut_at:timestamp with time zone,parked_at:timestamp with time zone' THEN
    RAISE EXCEPTION 'match_apply_held_unchanged: match_slow_bills shape changed';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)'))
     IS DISTINCT FROM 'b011ec334de5208fffc613e5f6fe7fc9'
     AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)'))
     IS DISTINCT FROM 'a63d82c7f7a24ea5a99c0933bec7352a' THEN
    RAISE EXCEPTION 'match_apply_held_unchanged: match_apply body changed';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.match_apply_stop(text)'))
     IS DISTINCT FROM 'b7ae6f0f0fbcdc47137b28f9022796d8'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.reconcile_match_clue_key(public.match_clues)'))
     IS DISTINCT FROM '02f37748d5e85a1d5aad7d71c13ca5a7' THEN
    RAISE EXCEPTION 'match_apply_held_unchanged: stop or clue key body changed';
  END IF;
END $guard$;

-- True when the fresh clues match the current run-written clues one for one, in order, by the same
-- semantic key undo uses. Type and root are read as match_apply would store them; an unknown type
-- or a bad value never matches, so the rewrite path refuses it as before.
CREATE OR REPLACE FUNCTION public.match_clues_unchanged(p_subject_kind text, p_subject_id text,
  p_clues jsonb, p_rule_version text)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $fn$
  SELECT (SELECT coalesce(array_agg(public.reconcile_match_clue_key(k) ORDER BY k.id), '{}')
            FROM public.match_clues k WHERE k.current AND k.kept_from IS NULL
             AND k.subject_kind = p_subject_kind AND k.subject_id = p_subject_id)
       = (SELECT coalesce(array_agg(md5(jsonb_build_array(c.v->>'clue_code', t.family, c.v->>'root',
            c.v->>'outcome', (c.v->>'job_id')::uuid, c.v->>'division', (c.v->>'names_one')::boolean,
            c.v->>'seen_where', c.v->>'seen_value', coalesce(c.v->'detail', '{}'), p_rule_version,
            NULL::text)::text) ORDER BY c.n), '{}')
            FROM jsonb_array_elements(p_clues) WITH ORDINALITY c(v, n)
            LEFT JOIN public.match_clue_types t ON t.code = c.v->>'clue_code')
$fn$;
REVOKE ALL ON FUNCTION public.match_clues_unchanged(text,text,jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_clues_unchanged(text,text,jsonb,text) TO service_role;

DO $matcher$
DECLARE sig regprocedure := 'public.match_apply(text,text,uuid,text,jsonb,jsonb,jsonb,jsonb,text)'::regprocedure;
  h text; def text;
/* patch the checked live body in place, keeping its grants and settings */ BEGIN
  SELECT md5(prosrc), pg_get_functiondef(oid) INTO STRICT h, def FROM pg_proc WHERE oid = sig;
  IF h = 'b011ec334de5208fffc613e5f6fe7fc9' THEN
    def := replace(def,
$old$  UPDATE public.match_clues k SET current = false WHERE k.current AND k.kept_from IS NULL
$old$,
$new$  -- A held bill whose clues are the ones already current writes nothing (P2-02.8).
  IF enabled_now THEN
    stop_reason := public.match_apply_stop(p_subject_id);
    IF stop_reason IS NOT NULL AND public.match_clues_unchanged(p_subject_kind,p_subject_id,p_clues,p_rule_version) THEN
      RETURN jsonb_build_object('applied',stop_reason);
    END IF;
  END IF;
  UPDATE public.match_clues k SET current = false WHERE k.current AND k.kept_from IS NULL
$new$);
    EXECUTE def;
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = sig) <> 'a63d82c7f7a24ea5a99c0933bec7352a' THEN
    RAISE EXCEPTION 'match_apply_held_unchanged: match_apply patch did not apply';
  END IF;
END $matcher$;

-- 2. Slow bills.
CREATE TABLE IF NOT EXISTS public.match_slow_bills (
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  cuts integer NOT NULL CHECK (cuts BETWEEN 1 AND 2),
  reason text NOT NULL CHECK (reason IN ('slow_bill_cut', 'parked_slow_bill')),
  last_cut_at timestamptz NOT NULL DEFAULT now(),
  parked_at timestamptz,
  PRIMARY KEY (subject_kind, subject_id),
  CHECK ((cuts = 2) = (reason = 'parked_slow_bill') AND (parked_at IS NOT NULL) = (reason = 'parked_slow_bill'))
);
COMMENT ON TABLE public.match_slow_bills IS
  'P2-02.8: bills the matcher runner cut for time while they started with most of the run''s budget. Two cuts park a bill (parked_slow_bill) until the sync reports its lines changed. Written by the xero-sync runner only.';
ALTER TABLE public.match_slow_bills ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.match_slow_bills FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.match_slow_bills TO service_role;

-- 3. The runner's per-bill reads. Each returns a json array of rows with the columns the runner
-- selected through PostgREST; an unknown read name raises. Never a whole-table read.
CREATE OR REPLACE FUNCTION public.match_bill_read(p_read text, p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = '' SET statement_timeout = '5s' AS $fn$
DECLARE out jsonb;
BEGIN
  CASE p_read
  WHEN 'cost_lines' THEN -- job_cost_lines_document_idx
    SELECT jsonb_agg(to_jsonb(r) ORDER BY r.line_no) INTO out FROM (
      SELECT l.line_key, l.line_no, l.kind, l.description, l.account_code, l.xero_tracking_option, l.amount_ex,
             l.state, l.document_number, l.document_date, l.party_id, l.party_name
        FROM public.job_cost_lines l
       WHERE l.document_kind = 'xero_bill' AND l.document_id = p_args->>'document_id') r;
  WHEN 'trade_user' THEN
    SELECT jsonb_agg(to_jsonb(r)) INTO out FROM (
      SELECT u.id, u.xero_contact_id FROM public.users u WHERE u.xero_contact_id = p_args->>'party_id' LIMIT 2) r;
  WHEN 'bill' THEN -- xero_invoices primary key
    SELECT jsonb_agg(to_jsonb(r)) INTO out FROM (
      SELECT i.xero_invoice_id, i.invoice_number, i.reference, i.xero_contact_id, i.contact_name, i.invoice_date, i.sub_total,
             i.line_items
        FROM public.xero_invoices i WHERE i.xero_invoice_id = p_args->>'document_id') r;
  WHEN 'jobs_by_number' THEN -- job numbers ending in the digits named on the bill
    SELECT jsonb_agg(to_jsonb(r) ORDER BY r.job_number, r.id) INTO out FROM (
      SELECT j.id, j.job_number, j.status, j.created_at, j.site_address, j.site_suburb,
             j.metadata->>'do_not_schedule' AS holding
        FROM public.jobs j
       WHERE j.job_number ILIKE ANY (SELECT '%' || d FROM jsonb_array_elements_text(p_args->'digits') d WHERE d ~ '^[0-9]+$')
       ORDER BY j.job_number, j.id LIMIT 50) r;
  WHEN 'order_jobs' THEN -- jobs primary key
    SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) INTO out FROM (
      SELECT j.id, j.job_number, j.status, j.created_at, j.site_address, j.site_suburb,
             j.metadata->>'do_not_schedule' AS holding
        FROM public.jobs j
       WHERE j.id IN (SELECT x::uuid FROM jsonb_array_elements_text(p_args->'job_ids') x)) r;
  WHEN 'orders' THEN -- orders from this supplier sent within the window
    SELECT jsonb_agg(to_jsonb(r) ORDER BY r.sent_on, r.order_kind, r.order_id) INTO out FROM (
      SELECT o.order_kind, o.order_id, o.order_number, o.job_id, o.job_live, o.party_id, o.party_name_key,
             o.sent_on, o.cost_ex, o.from_sealed_scope, o.matched
        FROM public.v_job_orders o
       WHERE o.sent_on >= (p_args->>'from')::date AND o.sent_on <= (p_args->>'to')::date
         AND CASE WHEN p_args ? 'party_id' THEN o.party_id = p_args->>'party_id'
                  ELSE o.party_name_key = p_args->>'party_name_key' END
       ORDER BY o.sent_on, o.order_kind, o.order_id LIMIT 200) r;
  WHEN 'evidence' THEN
    SELECT jsonb_agg(to_jsonb(r)) INTO out
      FROM public.context_job_evidence_for_bills(ARRAY[p_args->>'document_id']) r;
  WHEN 'other_documents' THEN -- other documents of the same supplier with the same number
    SELECT jsonb_agg(to_jsonb(r)) INTO out FROM (
      SELECT l.document_id, l.document_number, l.document_date, l.document_status, l.party_id, l.party_name,
             l.amount_ex, l.state
        FROM public.job_cost_lines l
       WHERE l.document_kind = 'xero_bill' AND l.document_number = p_args->>'document_number'
         AND l.document_id <> p_args->>'document_id'
         AND (NOT p_args ? 'party_id' OR l.party_id = p_args->>'party_id')
       LIMIT 200) r;
  WHEN 'kept_clues' THEN -- match_clues_current_subject_idx
    SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) INTO out FROM (
      SELECT k.id, k.clue_code, k.class, k.family, k.root, k.outcome, k.job_id, k.division, k.names_one,
             k.seen_where, k.seen_value, k.detail
        FROM public.match_clues k
       WHERE k.subject_kind = 'cost_document' AND k.subject_id = p_args->>'subject_id' AND k.current
         AND k.kept_from IS NOT NULL) r;
  WHEN 'rules' THEN
    SELECT jsonb_agg(to_jsonb(r)) INTO out FROM (
      SELECT m.id, m.kind, m.division FROM public.match_rules m
       WHERE m.party_id = p_args->>'party_id' AND m.status = 'confirmed' LIMIT 2) r;
  WHEN 'trade_lines' THEN
    SELECT jsonb_agg(to_jsonb(r)) INTO out FROM (
      SELECT tl.job_id, tl.line_total_ex, tl.work_date, tl.created_at
        FROM public.trade_invoice_lines tl JOIN public.trade_invoices ti ON ti.id = tl.trade_invoice_id
       WHERE tl.job_id = (p_args->>'job_id')::uuid AND ti.user_id = (p_args->>'user_id')::uuid LIMIT 200) r;
  ELSE
    RAISE EXCEPTION 'match_bill_read_unknown: %', p_read;
  END CASE;
  RETURN coalesce(out, '[]'::jsonb);
END $fn$;
REVOKE ALL ON FUNCTION public.match_bill_read(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_bill_read(text,jsonb) TO service_role;

DO $read$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.match_bill_read(text,jsonb)'::regprocedure) <> '5107006995e323d24746b965cf6614c0'
     OR NOT (SELECT proconfig @> ARRAY['statement_timeout=5s'] FROM pg_proc WHERE oid = 'public.match_bill_read(text,jsonb)'::regprocedure) THEN
    RAISE EXCEPTION 'match_apply_held_unchanged: match_bill_read did not install';
  END IF;
END $read$;
