-- (Job Profit, finish-line row A6, 3 Nov 2026) Rule 1 of 3: where Bookkeeping's ledger splits a bill across
-- jobs, Job Profit follows the split lines, not a whole-bill AI placement.
--
-- Found by verify/scripts/a6_live_costs.py (context-system, 3 Nov 11:50Z): Ampelite bill W207077 (879.14 ex GST,
-- one Xero line) is one card charge for two Ampelite invoices; Bookkeeping's ledger splits the line 581.75 to
-- SWP-261180 and 297.39 to SWP-261043, but Job Profit carried all 879.14 on SWP-261180 from an agent_ai fact.
-- Two causes, both fixed here:
--   a. The evidence store holds one job per Xero line, so the loader never loaded a split line (94 lines in the
--      current ledger files: 92 are crew super withheld from pay, 2 are supplier lines: W207077 and Energy Wise
--      INV-9419). New: bookkeeping_line_evidence_parts (one row per part), v_bookkeeping_line_parts_current (the
--      newest current revision's parts, used only when complete, adding up to the line, and not superseded by a
--      newer whole-line row) and bookkeeping_evidence_add_parts (the loader's write; the revision must be the
--      released file by sha256, loading or current, so the current files' split lines can be backfilled).
--   b. An AI whole-bill fact stood aside only when the ledger placed the bill elsewhere and NOT on the fact's own
--      job. Now it stands aside whenever the ledger places any of the bill's lines (or line parts) on another
--      job. Only AI facts: a person's manual_queue or manual_split still outranks the ledger, as before.
-- v_job_cost_events: a split part is its own bill line (source_id <bill>:<n>:part<k>) on the part's job at the
-- part's amount, placed by bookkeeping_evidence, wherever the ledger's line evidence would be used (no office
-- whole-bill job, or a do-not-schedule holder) and only while the parts add up to the Xero line as we hold it.
-- Parts of super withheld from pay are never cost (rule 2). Every other line keeps its source_id.
--
-- Guard: v_job_cost_events must be the definition this was written against (md5 33d1c54d5a288fe496b5b863a1ec1d4c,
-- pg_get_viewdef(..., true)); after the change it must be 32c422a8d90aecf6924fc0a84d4569fe. Re-running it is a no-op (also
-- once a later migration of this set, 20261104070000 to 20261104072000, has changed the view).
-- Rollback: supabase/rollbacks/20261104070000_job_cost_follows_ledger_split_lines_down.sql (embeds the exact earlier definition).
-- Rehearsed 3 Nov 2026 on production on A4 V8's definition, rolled back (CIO helper, Claude): this file alone moves no job (the split
-- lines are not loaded yet). With the current ledger files' 458 split parts loaded through bookkeeping_evidence_
-- add_parts (the released files' sha256; 94 lines, 4 job parts not withheld super): 4 jobs, +240.00 total cost:
-- SWP-261180 1,272.68 to 975.29 and SWP-261043 2,872.31 to 3,169.70 (Ampelite W207077 581.75 / 297.39);
-- SWP-26595 19,651.01 to 19,771.01 and SWP-26100 1,662.41 to 1,782.41 (Energy Wise INV-9419, 120.00 each; the
-- Job Profit total rises 240.00, so no job it shows carried that line). Margins shown 354 to 354.

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.bookkeeping_line_evidence_parts (
  revision text NOT NULL REFERENCES public.bookkeeping_evidence_revisions(revision) ON DELETE CASCADE,
  xero_invoice_id text NOT NULL,
  xero_line_item_id text NOT NULL,
  part smallint NOT NULL,
  parts smallint NOT NULL,
  line_ex numeric NOT NULL,
  amount_ex_gst numeric NOT NULL,
  allocation text NOT NULL CHECK (allocation = ANY (ARRAY['job'::text, 'overhead'::text, 'not_job_cost'::text, 'unresolved'::text])),
  job_number text,
  job_id uuid,
  evidenced boolean NOT NULL,
  basis text,
  outcome text,
  document_ref text,
  super_withheld boolean NOT NULL DEFAULT false,
  fact jsonb,
  PRIMARY KEY (revision, xero_invoice_id, xero_line_item_id, part),
  CHECK (parts >= 2 AND part >= 1 AND part <= parts)
);
CREATE INDEX IF NOT EXISTS bookkeeping_line_evidence_parts_line_idx ON public.bookkeeping_line_evidence_parts (xero_invoice_id, xero_line_item_id);
ALTER TABLE public.bookkeeping_line_evidence_parts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bookkeeping_line_evidence_parts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bookkeeping_line_evidence_parts TO service_role;
COMMENT ON TABLE public.bookkeeping_line_evidence_parts IS
  'One Xero line Bookkeeping''s ledger splits across several jobs: one row per part (split_part of split_parts). The whole-line store bookkeeping_line_evidence holds one job per line.';

CREATE OR REPLACE VIEW public.v_bookkeeping_line_parts_current AS
WITH cur AS (
  SELECT p.revision, p.xero_invoice_id, p.xero_line_item_id, p.part, p.parts, p.line_ex, p.amount_ex_gst,
         p.allocation, p.job_number, p.job_id, p.evidenced, p.basis, p.outcome, p.document_ref, p.super_withheld,
         r.stream, r.emitted_at, r.sha256 AS revision_sha256,
         rank() OVER (PARTITION BY p.xero_invoice_id, p.xero_line_item_id ORDER BY r.emitted_at DESC, p.revision DESC) AS newest
    FROM bookkeeping_line_evidence_parts p
    JOIN bookkeeping_evidence_revisions r ON r.revision = p.revision
   WHERE r.status = 'current'
), pick AS (
  SELECT c.*,
         count(*) OVER (PARTITION BY c.xero_invoice_id, c.xero_line_item_id) AS parts_here,
         sum(c.amount_ex_gst) OVER (PARTITION BY c.xero_invoice_id, c.xero_line_item_id) AS parts_ex
    FROM cur c
   WHERE c.newest = 1
)
SELECT k.xero_invoice_id, k.xero_line_item_id, k.part, k.parts, k.line_ex, k.amount_ex_gst, k.allocation,
       k.job_number, k.job_id, k.evidenced, k.basis, k.outcome, k.document_ref, k.super_withheld,
       k.revision, k.stream, k.emitted_at, k.revision_sha256
  FROM pick k
 WHERE k.parts_here = k.parts
   AND abs(k.parts_ex - k.line_ex) <= 0.005
   AND NOT EXISTS (SELECT 1 FROM v_bookkeeping_line_evidence_current e
                    WHERE e.xero_invoice_id = k.xero_invoice_id AND e.xero_line_item_id = k.xero_line_item_id
                      AND (e.emitted_at > k.emitted_at OR (e.emitted_at = k.emitted_at AND e.revision > k.revision)));
REVOKE ALL ON public.v_bookkeeping_line_parts_current FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_bookkeeping_line_parts_current TO service_role;

CREATE OR REPLACE FUNCTION public.bookkeeping_evidence_add_parts(p_revision text, p_sha256 text, p_parts jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- One Xero line Bookkeeping's ledger splits across several jobs: one row per part. The revision must be the
-- released file (same sha256), still loading or already current (a backfill of the same file's split lines).
DECLARE r public.bookkeeping_evidence_revisions; n integer;
BEGIN
  SELECT * INTO r FROM public.bookkeeping_evidence_revisions WHERE revision = p_revision FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'evidence_revision_unknown: %', p_revision; END IF;
  IF r.sha256 IS DISTINCT FROM p_sha256 THEN RAISE EXCEPTION 'evidence_revision_sha_mismatch: %', p_revision; END IF;
  IF r.status NOT IN ('loading', 'current') THEN RAISE EXCEPTION 'evidence_revision_not_open: % is %', p_revision, r.status; END IF;
  IF jsonb_typeof(p_parts) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'evidence_parts_not_array'; END IF;
  INSERT INTO public.bookkeeping_line_evidence_parts
    (revision, xero_invoice_id, xero_line_item_id, part, parts, line_ex, amount_ex_gst, allocation, job_number, job_id,
     evidenced, basis, outcome, document_ref, super_withheld, fact)
  SELECT p_revision, f.e ->> 'b', f.e ->> 'l', (f.e ->> 'p')::smallint, (f.e ->> 'n')::smallint, (f.e ->> 's')::numeric,
         (f.e ->> 'a')::numeric, c.allocation, c.job_number, c.job_id, c.evidenced, c.basis, c.outcome, c.document_ref,
         coalesce((f.e ->> 'w')::boolean, false), f.e
  FROM jsonb_array_elements(p_parts) AS f(e)
  CROSS JOIN LATERAL public.bookkeeping_evidence_classify(f.e) c
  WHERE f.e ->> 'b' IS NOT NULL AND f.e ->> 'l' IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $function$;
REVOKE ALL ON FUNCTION public.bookkeeping_evidence_add_parts(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bookkeeping_evidence_add_parts(text, text, jsonb) TO service_role;

DO $mig$
DECLARE
  v_def text;
  o1 text := $o1$          WHERE e.allocation = 'job'::text AND e.evidenced AND e.job_id IS NOT NULL
        ), ledger_cn AS ($o1$;
  n1 text := $n1$          WHERE e.allocation = 'job'::text AND e.evidenced AND e.job_id IS NOT NULL
        ), bill_part AS (
         SELECT p.xero_invoice_id,
            p.xero_line_item_id,
            p.part,
            p.line_ex,
            p.job_id,
            p.amount_ex_gst
           FROM v_bookkeeping_line_parts_current p
          WHERE p.allocation = 'job'::text AND p.evidenced AND p.job_id IS NOT NULL AND NOT p.super_withheld
        ), ledger_cn AS ($n1$;
  o2 text := $o2$            bl.n,
            bl.line,
$o2$;
  n2 text := $n2$            bl.n,
            bl.part,
            bl.line,
$n2$;
  o3 text := $o3$                        CASE
                            WHEN (x.job_id IS NULL OR hj.id IS NOT NULL) AND ev.job_id IS NOT NULL AND (NOT job_cost_installer_bill(x.line_items) OR NOT (EXISTS ( SELECT 1
                               FROM trade t_ev
                              WHERE t_ev.job_id = ev.job_id AND t_ev.is_actual AND lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || lower(t_ev.party)) || '%'::text)))) THEN ev.job_id
                            WHEN tj.job_id IS NOT NULL THEN tj.job_id
                            ELSE x.job_id
                        END AS job_id,$o3$;
  n3 text := $n3$                        CASE
                            WHEN sp.xero_invoice_id IS NOT NULL THEN
                            CASE
                                WHEN NOT job_cost_installer_bill(x.line_items) OR NOT (EXISTS ( SELECT 1
                                   FROM trade t_sp
                                  WHERE t_sp.job_id = sp.job_id AND t_sp.is_actual AND lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || lower(t_sp.party)) || '%'::text))) THEN sp.job_id
                                ELSE NULL::uuid
                            END
                            WHEN (x.job_id IS NULL OR hj.id IS NOT NULL) AND ev.job_id IS NOT NULL AND (NOT job_cost_installer_bill(x.line_items) OR NOT (EXISTS ( SELECT 1
                               FROM trade t_ev
                              WHERE t_ev.job_id = ev.job_id AND t_ev.is_actual AND lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || lower(t_ev.party)) || '%'::text)))) THEN ev.job_id
                            WHEN tj.job_id IS NOT NULL THEN tj.job_id
                            ELSE x.job_id
                        END AS job_id,$n3$;
  o4 text := $o4$                        CASE
                            WHEN (x.job_id IS NULL OR hj.id IS NOT NULL) AND ev.job_id IS NOT NULL AND (NOT job_cost_installer_bill(x.line_items) OR NOT (EXISTS ( SELECT 1
                               FROM trade t_ev
                              WHERE t_ev.job_id = ev.job_id AND t_ev.is_actual AND lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || lower(t_ev.party)) || '%'::text)))) THEN 'bookkeeping_evidence'::text
                            WHEN tj.job_id IS NOT NULL THEN 'bill_line_job_number'::text
                            ELSE 'xero_invoices.job_id'::text
                        END AS placed_by,$o4$;
  n4 text := $n4$                        CASE
                            WHEN sp.xero_invoice_id IS NOT NULL THEN 'bookkeeping_evidence'::text
                            WHEN (x.job_id IS NULL OR hj.id IS NOT NULL) AND ev.job_id IS NOT NULL AND (NOT job_cost_installer_bill(x.line_items) OR NOT (EXISTS ( SELECT 1
                               FROM trade t_ev
                              WHERE t_ev.job_id = ev.job_id AND t_ev.is_actual AND lower(COALESCE(x.contact_name, ''::text)) ~~ (('%'::text || lower(t_ev.party)) || '%'::text)))) THEN 'bookkeeping_evidence'::text
                            WHEN tj.job_id IS NOT NULL THEN 'bill_line_job_number'::text
                            ELSE 'xero_invoices.job_id'::text
                        END AS placed_by,$n4$;
  o5 text := $o5$                    li.n,
                    li.value AS line,
$o5$;
  n5 text := $n5$                    li.n,
                    sp.part,
                    li.value AS line,
$n5$;
  o6 text := $o6$                        CASE
                            WHEN li.value ? '_header_ex'::text THEN job_profit_num(li.value -> '_header_ex'::text)$o6$;
  n6 text := $n6$                        CASE
                            WHEN sp.xero_invoice_id IS NOT NULL THEN sp.amount_ex_gst
                            WHEN li.value ? '_header_ex'::text THEN job_profit_num(li.value -> '_header_ex'::text)$n6$;
  o7 text := $o7$                     LEFT JOIN bill_ev ev ON ev.xero_invoice_id = x.xero_invoice_id AND ev.xero_line_item_id = (li.value ->> 'LineItemID'::text)
$o7$;
  n7 text := $n7$                     LEFT JOIN bill_ev ev ON ev.xero_invoice_id = x.xero_invoice_id AND ev.xero_line_item_id = (li.value ->> 'LineItemID'::text)
                     LEFT JOIN bill_part sp ON sp.xero_invoice_id = x.xero_invoice_id AND sp.xero_line_item_id = (li.value ->> 'LineItemID'::text) AND (x.job_id IS NULL OR hj.id IS NOT NULL) AND abs(sp.line_ex -
                        CASE
                            WHEN (x.raw_json ->> 'LineAmountTypes'::text) = 'Inclusive'::text THEN COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric) - COALESCE(job_profit_num(li.value -> 'TaxAmount'::text), 0::numeric)
                            ELSE COALESCE(job_profit_num(li.value -> 'LineAmount'::text), 0::numeric)
                        END) <= 0.005
$n7$;
  o8 text := $o8$                          WHERE f.xero_invoice_id = x.xero_invoice_id AND (f.job_id IS DISTINCT FROM x.job_id OR f.automation_source = 'manual_split'::text) AND NOT ((COALESCE(f.automation_source, ''::text) <> ALL (ARRAY['manual_queue'::text, 'manual_split'::text])) AND (EXISTS ( SELECT 1
                                   FROM v_bookkeeping_line_evidence_current e
                                  WHERE e.xero_invoice_id = f.xero_invoice_id AND e.evidenced AND e.job_id IS NOT NULL AND e.job_id <> f.job_id)) AND NOT (EXISTS ( SELECT 1
                                   FROM v_bookkeeping_line_evidence_current e2
                                  WHERE e2.xero_invoice_id = f.xero_invoice_id AND e2.evidenced AND e2.job_id = f.job_id))))) AND NOT (EXISTS ( SELECT 1$o8$;
  n8 text := $n8$                          WHERE f.xero_invoice_id = x.xero_invoice_id AND (f.job_id IS DISTINCT FROM x.job_id OR f.automation_source = 'manual_split'::text) AND NOT ((COALESCE(f.automation_source, ''::text) <> ALL (ARRAY['manual_queue'::text, 'manual_split'::text])) AND ((EXISTS ( SELECT 1
                                   FROM v_bookkeeping_line_evidence_current e
                                  WHERE e.xero_invoice_id = f.xero_invoice_id AND e.evidenced AND e.job_id IS NOT NULL AND e.job_id <> f.job_id)) OR (EXISTS ( SELECT 1
                                   FROM bill_part p2
                                  WHERE p2.xero_invoice_id = f.xero_invoice_id AND p2.job_id <> f.job_id)))))) AND NOT (EXISTS ( SELECT 1$n8$;
  o9 text := $o9$                  WHERE b.xero_invoice_id = f.xero_invoice_id AND (b.job_id = f.job_id OR b.placed_by <> 'xero_invoices.job_id'::text AND f.job_id = x.job_id))) AND NOT ((COALESCE(f.automation_source, ''::text) <> ALL (ARRAY['manual_queue'::text, 'manual_split'::text])) AND (EXISTS ( SELECT 1
                   FROM v_bookkeeping_line_evidence_current e
                  WHERE e.xero_invoice_id = f.xero_invoice_id AND e.evidenced AND e.job_id IS NOT NULL AND e.job_id <> f.job_id)) AND NOT (EXISTS ( SELECT 1
                   FROM v_bookkeeping_line_evidence_current e2
                  WHERE e2.xero_invoice_id = f.xero_invoice_id AND e2.evidenced AND e2.job_id = f.job_id)))$o9$;
  n9 text := $n9$                  WHERE b.xero_invoice_id = f.xero_invoice_id AND (b.job_id = f.job_id OR b.placed_by <> 'xero_invoices.job_id'::text AND f.job_id = x.job_id))) AND NOT ((COALESCE(f.automation_source, ''::text) <> ALL (ARRAY['manual_queue'::text, 'manual_split'::text])) AND ((EXISTS ( SELECT 1
                   FROM v_bookkeeping_line_evidence_current e
                  WHERE e.xero_invoice_id = f.xero_invoice_id AND e.evidenced AND e.job_id IS NOT NULL AND e.job_id <> f.job_id)) OR (EXISTS ( SELECT 1
                   FROM bill_part p2
                  WHERE p2.xero_invoice_id = f.xero_invoice_id AND p2.job_id <> f.job_id))))$n9$;
  o10 text := $o10$            (b.xero_invoice_id || ':'::text) || b.n AS source_id,
$o10$;
  n10 text := $n10$            ((b.xero_invoice_id || ':'::text) || b.n) || COALESCE(':part'::text || b.part, ''::text) AS source_id,
$n10$;
  o11 text := $o11$             JOIN bill_line b ON ((b.xero_invoice_id || ':'::text) || b.n) = s.source_id
$o11$;
  n11 text := $n11$             JOIN bill_line b ON (((b.xero_invoice_id || ':'::text) || b.n) || COALESCE(':part'::text || b.part, ''::text)) = s.source_id
$n11$;
BEGIN
  v_def := pg_get_viewdef('public.v_job_cost_events'::regclass, true);
  IF md5(v_def) IN ('32c422a8d90aecf6924fc0a84d4569fe', 'cd749fcbe09bedde4a277f6da3ade6fd', '366599ce55b0e0430d45ee9e6e04c315') THEN
    RAISE NOTICE 'v_job_cost_events already has 20261104070000 (or a later change of this set)';
    RETURN;
  END IF;
  IF md5(v_def) <> '33d1c54d5a288fe496b5b863a1ec1d4c' THEN
    RAISE EXCEPTION 'v_job_cost_events is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, o1, ''))) / length(o1) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 1 of 11 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o1, n1);
  IF (length(v_def) - length(replace(v_def, o2, ''))) / length(o2) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 2 of 11 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o2, n2);
  IF (length(v_def) - length(replace(v_def, o3, ''))) / length(o3) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 3 of 11 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o3, n3);
  IF (length(v_def) - length(replace(v_def, o4, ''))) / length(o4) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 4 of 11 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o4, n4);
  IF (length(v_def) - length(replace(v_def, o5, ''))) / length(o5) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 5 of 11 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o5, n5);
  IF (length(v_def) - length(replace(v_def, o6, ''))) / length(o6) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 6 of 11 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o6, n6);
  IF (length(v_def) - length(replace(v_def, o7, ''))) / length(o7) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 7 of 11 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o7, n7);
  IF (length(v_def) - length(replace(v_def, o8, ''))) / length(o8) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 8 of 11 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o8, n8);
  IF (length(v_def) - length(replace(v_def, o9, ''))) / length(o9) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 9 of 11 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o9, n9);
  IF (length(v_def) - length(replace(v_def, o10, ''))) / length(o10) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 10 of 11 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o10, n10);
  IF (length(v_def) - length(replace(v_def, o11, ''))) / length(o11) <> 1 THEN
    RAISE EXCEPTION 'v_job_cost_events: change 11 of 11 does not find its text exactly once';
  END IF;
  v_def := replace(v_def, o11, n11);
  EXECUTE 'CREATE OR REPLACE VIEW public.v_job_cost_events AS ' || v_def;
  IF md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true)) <> '32c422a8d90aecf6924fc0a84d4569fe' THEN
    RAISE EXCEPTION 'v_job_cost_events after the change is not the rehearsed definition (md5 %)', md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true));
  END IF;
END
$mig$;
