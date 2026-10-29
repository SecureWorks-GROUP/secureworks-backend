-- Context: the job card's H7 read (INT-10). 29 Oct 2026.
--
-- For one job, the supplier bills placed on it (its own Xero link, or an
-- allocation row on it), each with where Finance's engine counts its cost,
-- read from CFO's rule (20261029170000) and nothing else: the scoped call
-- cfo_bill_cost_outcomes_scoped(job), which reads only this job's bills and
-- gives exactly cfo_bill_cost_outcomes' rows for them.
-- Context owns the record link and the placement it shows; CFO owns where the
-- cost counts, its confirmation and every amount. So this read carries no
-- amount at all: no total, no part, no overhead, no credit, no count of
-- dollars. A reader that needs a figure links to Money.
--
-- Answer (jsonb):
--   contract_version  the producer's (cfo-bill-cost-outcome-v1). The consumer
--                     (ops-api job_bill_outcomes_read.ts) refuses any other.
--   contract_versions_agree  false if two bills carry different versions
--   shape             context-job-bill-outcomes-v1
--   job_id
--   bills: one per bill, in invoice number then bill id order (C collation):
--     xero_invoice_id, invoice_number, supplier, bill_status, bill_state,
--     held_reason, change_hash (CFO's evidence_hash: a payment never moves it),
--     overhead_part, not_job_related_mark, mirror_bill (CFO's: a trade-app
--     mirror bill, shown only where a person placed it),
--     where_counted  here | elsewhere | here_and_elsewhere | no_job | trade_app |
--                    held | unknown (trade_app: a trade-app mirror bill a person
--                    placed here; its cost counts through the trade app's lines,
--                    never as this bill, and here.reason says
--                    mirror_bill_person_placed)
--     bill_state     CFO's, passed on: unknown, voided, trade_mirror, held,
--                    not_job_related, overhead, not_counted, over_counted (more
--                    counted than the bill: never "in part"), counted_in_full,
--                    counted_in_part
--     here           {xero_linked, placed_by, counts, reason, holding_job}
--     other_jobs     [{job_id, job_number, xero_linked, placed_by, counts,
--                      reason, holding_job}], job number then id order (C)
-- A held bill (F1, JP-21) reads counts 'held' and reason null on every job:
-- where its cost counts is not settled, so the card says nothing about it,
-- never "counts here" and never "counts nowhere". unknown stays unknown.
--
-- Plain SQL, STABLE, SECURITY INVOKER: it reads CFO's rule with the caller's
-- rights, and only the service role may call it (the server-side job overview
-- read). Writes nothing. It is called once per job page, never per row, and
-- carries SET jit = off: the engine view it reads is large to plan, and on a
-- local 2,000-bill estate JIT compiling alone took 4 to 7 s of an 8 s budget
-- for a read that runs in milliseconds without it.
-- Contract: supabase/tests/migration-contracts/20261029170100_context_job_bill_outcomes/.
-- Rollback: supabase/rollbacks/20261029170100_context_job_bill_outcomes_down.sql.

CREATE OR REPLACE FUNCTION public.context_job_bill_outcomes(p_job uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET jit = off
AS $fn$
  WITH o AS (
    -- This job's bills only, from the first read on (never the estate).
    SELECT c.* FROM public.cfo_bill_cost_outcomes_scoped(p_job) c
  ),
  per_bill AS (
    SELECT
      o.xero_invoice_id,
      min(o.contract_version) AS contract_version,
      min(o.invoice_number) AS invoice_number,
      min(o.contact_name) AS supplier,
      min(o.bill_status) AS bill_status,
      min(o.bill_state) AS bill_state,
      min(o.held_reason) AS held_reason,
      min(o.evidence_hash) AS change_hash,
      bool_or(o.overhead_part) AS overhead_part,
      bool_or(o.not_job_related_mark) AS not_job_related_mark,
      bool_or(o.mirror_bill) AS mirror_bill,
      bool_or(o.job_id = p_job AND o.counts = 'counted') AS here_counted,
      bool_or(o.job_id <> p_job AND o.counts = 'counted') AS other_counted,
      bool_or(o.job_id = p_job AND o.counts = 'unknown') AS here_unknown,
      (SELECT jsonb_build_object(
                'xero_linked', h.xero_linked,
                'placed_by', h.placed_by,
                'counts', CASE WHEN h.bill_state = 'held' THEN 'held' ELSE h.counts END,
                'reason', CASE WHEN h.bill_state = 'held' THEN NULL ELSE h.reason END,
                'holding_job', h.holding_job)
         FROM o h WHERE h.xero_invoice_id = o.xero_invoice_id AND h.job_id = p_job) AS here,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'job_id', e.job_id,
                'job_number', e.job_number,
                'xero_linked', e.xero_linked,
                'placed_by', e.placed_by,
                'counts', CASE WHEN e.bill_state = 'held' THEN 'held' ELSE e.counts END,
                'reason', CASE WHEN e.bill_state = 'held' THEN NULL ELSE e.reason END,
                'holding_job', e.holding_job)
                ORDER BY e.job_number COLLATE "C", e.job_id::text COLLATE "C")
         FROM o e WHERE e.xero_invoice_id = o.xero_invoice_id AND e.job_id <> p_job), '[]'::jsonb) AS other_jobs
    FROM o
    GROUP BY o.xero_invoice_id
  )
  SELECT jsonb_build_object(
    'contract_version', COALESCE((SELECT min(b.contract_version) FROM per_bill b), 'cfo-bill-cost-outcome-v1'),
    'contract_versions_agree', (SELECT count(DISTINCT b.contract_version) <= 1 FROM per_bill b),
    'shape', 'context-job-bill-outcomes-v1',
    'job_id', p_job,
    'bills', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'xero_invoice_id', b.xero_invoice_id,
               'invoice_number', b.invoice_number,
               'supplier', b.supplier,
               'bill_status', b.bill_status,
               'bill_state', b.bill_state,
               'held_reason', b.held_reason,
               'change_hash', b.change_hash,
               'overhead_part', b.overhead_part,
               'not_job_related_mark', b.not_job_related_mark,
               'mirror_bill', b.mirror_bill,
               'where_counted', CASE
                  WHEN b.bill_state = 'unknown' OR b.here_unknown OR b.here IS NULL THEN 'unknown'
                  WHEN b.bill_state = 'held' THEN 'held'
                  WHEN b.bill_state = 'trade_mirror' THEN 'trade_app'
                  WHEN b.here_counted AND b.other_counted THEN 'here_and_elsewhere'
                  WHEN b.here_counted THEN 'here'
                  WHEN b.other_counted THEN 'elsewhere'
                  ELSE 'no_job'
                END,
               'here', b.here,
               'other_jobs', b.other_jobs)
             ORDER BY b.invoice_number COLLATE "C", b.xero_invoice_id COLLATE "C")
      FROM per_bill b), '[]'::jsonb)
  )
$fn$;

REVOKE ALL ON FUNCTION public.context_job_bill_outcomes(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_job_bill_outcomes(uuid) TO service_role;
COMMENT ON FUNCTION public.context_job_bill_outcomes(uuid) IS
  'Context H7 read, INT-10 (20261029170100): for one job, the supplier bills on it (its Xero link or an actual allocation row) with where CFO''s rule (cfo_bill_cost_outcomes_scoped(job), exactly cfo_bill_cost_outcomes for those bills) says each bill''s cost counts, and no amount at all. contract_version is the producer''s (cfo-bill-cost-outcome-v1), shape context-job-bill-outcomes-v1. where_counted here, elsewhere, here_and_elsewhere, no_job, trade_app (a trade-app mirror a person placed: counted through the trade lines, never as this bill), held (F1, JP-21: counts held on every job, never shown as settled) or unknown (never 0). bill_state is CFO''s, over_counted included. change_hash is CFO''s evidence_hash: a payment never moves it. Read only, service role only.';
