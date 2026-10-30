-- Supplier credit notes, copied from Xero (TP-07 slice 1), 30 Oct 2026.
-- Plan: 08-path-to-trusted-profit, ticket TP-07 ("xero-sync copies supplier
-- credit notes (ACCPAYCREDIT) and their allocations; each is placed on the job
-- of the bill it reverses, or by the same clues").
--
-- This slice changes no money figure anywhere. Job Profit, the job story's
-- money book and the TP-01 tie-out read nothing added here; netting credits
-- into a job's cost is slice 2 (for the CFO review).
--
-- What Job Profit already does, and why that matters here: since CFO-20
-- (20261020181800) v_job_cost_events takes credit off a live bill's cost from
-- the bill's own copy, raw_json CreditNotes[].AppliedAmount (else
-- AmountCredited less prepayments and overpayments), in proportion on every
-- line or allocation row of the bill (supplier_credit rows). That is the same
-- allocation seen from the bill's side. So a credit note allocated to a placed
-- bill already lowers that job's cost wherever CFO-20 is live; what was never
-- in our copy is the credit note itself: one not allocated to any bill, a
-- voided one, its own status, number, dates and allocation list. Slice 2 must
-- use one of the two sides for a given allocation, never both: the placement
-- view carries bill_side_applied for exactly that check.
--
-- 1. xero_supplier_credit_notes: one row per ACCPAYCREDIT credit note, as Xero
--    returned it for that CreditNoteID (number, contact, date, status, totals,
--    remaining credit, Xero's UpdatedDateUTC and the whole record). An amount
--    Xero did not send is null, never 0. allocations_returned says whether the
--    record carried an Allocations list at all.
-- 2. xero_supplier_credit_note_allocations: one row per entry of that list
--    (allocation id when Xero gives one, the bill's InvoiceID and number, the
--    amount and date, IsDeleted).
-- 3. xero_supplier_credit_note_copy(org, note, allocations): the only writer.
--    One transaction: upserts the note and, when the list was returned,
--    replaces that note's allocations with it. A record older than the stored
--    one (UpdatedDateUTC) changes nothing, also when two copies of one note
--    race: the upsert's own WHERE decides, against the committed copy. Never invents a status or amount,
--    and never touches a note Xero did not return.
-- 4. v_supplier_credit_placement: read only. Each live allocation lands on the
--    job or jobs of the bill it reverses, by the bill's own placement in Job
--    Profit (v_job_cost_events' supplier rows for that bill: its Xero job, or
--    its allocation rows when it is split or moved), at CFO-20's rule
--    (bill part ex GST x allocation / bill total). Everything else stays
--    unplaced with a reason: credit left on the note (unallocated, its amount
--    shown, never $0), a note that is not live (voided, deleted, draft,
--    submitted, or no status: never placed), a deleted allocation, an
--    allocation with no amount, a bill not in our copy, not live, not placed
--    or with no total, and a note whose list Xero did not return.
-- 5. feature_flags.xero_supplier_credit_notes_v1, seeded off: xero-sync reads
--    Xero's credit notes only while it is on.
--
-- Tables RLS on with no policy, revoked from anon and authenticated; view and
-- function service role only. No expression index (index upkeep runs as the
-- writing role).
--
-- Columns checked against this repository's migrations and code, not the live
-- schema: feature_flags (flag_name, enabled, description) has no producer in
-- this repository; xero_sync_state, xero_invoices and v_job_cost_events as in
-- 20260910100000, 20250301000003 and 20261028173000. The version was checked
-- against this branch and the open branches' migrations, not the live ledger.
--
-- Order: roll this migration back before any down that drops
-- v_job_cost_events (20261009130000's): the placement view depends on it.
-- Rollback: supabase/rollbacks/20261030010000_xero_supplier_credit_notes_down.sql

-- ─────────────────────────────────────────────────────────────
-- 0. Guard: read what is there before creating anything. Reports every
--    problem at once.
-- ─────────────────────────────────────────────────────────────
DO $guard$
DECLARE
  problems text[] := '{}';
  t text;
  c text;
BEGIN
  IF to_regclass('public.v_job_cost_events') IS NULL THEN
    problems := problems || 'public.v_job_cost_events is missing'::text;
  ELSE
    FOREACH c IN ARRAY ARRAY['job_id', 'party_kind', 'amount_ex', 'source', 'document_id', 'is_actual', 'match_method'] LOOP
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'v_job_cost_events' AND column_name = c) THEN
        problems := problems || ('public.v_job_cost_events has no column ' || c);
      END IF;
    END LOOP;
  END IF;
  FOREACH c IN ARRAY ARRAY['org_id', 'xero_invoice_id', 'invoice_number', 'invoice_type', 'status', 'total', 'raw_json'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'xero_invoices' AND column_name = c) THEN
      problems := problems || ('public.xero_invoices has no column ' || c);
    END IF;
  END LOOP;
  IF to_regclass('public.organisations') IS NULL THEN
    problems := problems || 'public.organisations is missing'::text;
  END IF;
  IF to_regprocedure('public.job_profit_num(jsonb)') IS NULL THEN
    problems := problems || 'public.job_profit_num(jsonb) is missing'::text;
  END IF;
  -- A table of the same name that this migration did not make.
  FOREACH t IN ARRAY ARRAY['xero_supplier_credit_notes', 'xero_supplier_credit_note_allocations'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL
       AND COALESCE(obj_description(to_regclass('public.' || t), 'pg_class'), '') NOT LIKE 'Supplier credit notes (20261030010000%' THEN
      problems := problems || ('public.' || t || ' exists and is not this migration''s');
    END IF;
  END LOOP;
  IF to_regclass('public.v_supplier_credit_placement') IS NOT NULL
     AND COALESCE(obj_description(to_regclass('public.v_supplier_credit_placement'), 'pg_class'), '') NOT LIKE 'Supplier credit notes (20261030010000%' THEN
    problems := problems || 'public.v_supplier_credit_placement exists and is not this migration''s'::text;
  END IF;
  IF to_regprocedure('public.xero_supplier_credit_note_copy(uuid,jsonb,jsonb)') IS NOT NULL
     AND COALESCE(obj_description(to_regprocedure('public.xero_supplier_credit_note_copy(uuid,jsonb,jsonb)'), 'pg_proc'), '') NOT LIKE 'Supplier credit notes (20261030010000%' THEN
    problems := problems || 'public.xero_supplier_credit_note_copy exists and is not this migration''s'::text;
  END IF;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'xero_supplier_credit_notes_preimage_mismatch: %', array_to_string(problems, '; ');
  END IF;
END
$guard$;

-- ─────────────────────────────────────────────────────────────
-- 1. The credit notes
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.xero_supplier_credit_notes (
  org_id uuid NOT NULL REFERENCES public.organisations(id),
  xero_credit_note_id text NOT NULL CHECK (btrim(xero_credit_note_id) <> ''),
  credit_note_type text NOT NULL CHECK (credit_note_type = 'ACCPAYCREDIT'),
  credit_note_number text,
  xero_contact_id text,
  contact_name text,
  reference text,
  credit_note_date date,
  status text,
  line_amount_types text,
  currency_code text,
  sub_total numeric(14,2),
  total_tax numeric(14,2),
  total numeric(14,2),
  remaining_credit numeric(14,2),
  fully_paid_on date,
  allocations_returned boolean NOT NULL,
  xero_updated_at timestamptz,
  raw_json jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, xero_credit_note_id)
);
ALTER TABLE public.xero_supplier_credit_notes ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS xero_supplier_credit_notes_contact_idx
  ON public.xero_supplier_credit_notes (org_id, xero_contact_id);
COMMENT ON TABLE public.xero_supplier_credit_notes IS
  'Supplier credit notes (20261030010000, TP-07 slice 1): our copy of Xero''s ACCPAYCREDIT credit notes, one row per CreditNoteID, exactly as Xero returned that record (status, totals and remaining credit are Xero''s; one Xero did not send is null, never 0). allocations_returned: the record carried an Allocations list. Written only by xero_supplier_credit_note_copy (xero-sync, behind feature_flags.xero_supplier_credit_notes_v1). Read by nothing that counts money yet. Service role only.';

-- ─────────────────────────────────────────────────────────────
-- 2. Their allocations
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.xero_supplier_credit_note_allocations (
  org_id uuid NOT NULL,
  xero_credit_note_id text NOT NULL,
  n integer NOT NULL CHECK (n > 0),
  allocation_id text,
  xero_invoice_id text,
  invoice_number text,
  amount numeric(14,2),
  allocation_date date,
  is_deleted boolean NOT NULL,
  raw_json jsonb NOT NULL,
  PRIMARY KEY (org_id, xero_credit_note_id, n),
  FOREIGN KEY (org_id, xero_credit_note_id)
    REFERENCES public.xero_supplier_credit_notes (org_id, xero_credit_note_id) ON DELETE CASCADE
);
ALTER TABLE public.xero_supplier_credit_note_allocations ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS xero_supplier_credit_note_allocations_bill_idx
  ON public.xero_supplier_credit_note_allocations (org_id, xero_invoice_id);
COMMENT ON TABLE public.xero_supplier_credit_note_allocations IS
  'Supplier credit notes (20261030010000, TP-07 slice 1): each entry of a credit note''s Allocations list as Xero last returned it (n is its place in the list): the bill''s InvoiceID and number, the amount (as Xero allocates it, against the bill''s total) and date, IsDeleted. Replaced whole on each copy of its note that carried the list. Service role only.';

REVOKE ALL ON public.xero_supplier_credit_notes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.xero_supplier_credit_note_allocations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.xero_supplier_credit_notes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.xero_supplier_credit_note_allocations TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 3. The one writer
-- ─────────────────────────────────────────────────────────────
-- p_note: the note's columns as xero-sync read them from Xero's record
-- (supplier_credit_notes.ts); p_allocations: the Allocations list as rows, or
-- null when the record carried none (the stored rows are then left as they
-- are, and the view reads the note as allocations_not_read). Returns written,
-- or stale when the stored record is newer.
CREATE OR REPLACE FUNCTION public.xero_supplier_credit_note_copy(p_org_id uuid, p_note jsonb, p_allocations jsonb)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id text := NULLIF(btrim(COALESCE(p_note ->> 'xero_credit_note_id', '')), '');
  v_updated timestamptz := (p_note ->> 'xero_updated_at')::timestamptz;
  v_rows integer;
BEGIN
  IF p_org_id IS NULL OR v_id IS NULL THEN
    RAISE EXCEPTION 'supplier_credit_note_refused: an org and a CreditNoteID are required';
  END IF;
  IF p_note ->> 'credit_note_type' IS DISTINCT FROM 'ACCPAYCREDIT' THEN
    RAISE EXCEPTION 'supplier_credit_note_refused: % is %, not ACCPAYCREDIT', v_id, COALESCE(p_note ->> 'credit_note_type', 'no type');
  END IF;
  IF jsonb_typeof(p_note -> 'raw_json') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'supplier_credit_note_refused: % has no Xero record', v_id;
  END IF;
  IF p_allocations IS NOT NULL AND jsonb_typeof(p_allocations) <> 'array' THEN
    RAISE EXCEPTION 'supplier_credit_note_refused: % allocations are not a list', v_id;
  END IF;

  -- Freshness is decided by the write itself, never by an earlier read: a
  -- read cannot lock a note that is not there yet, so two first copies of one
  -- note could both pass it, and the older could then overwrite the newer.
  -- INSERT ... ON CONFLICT waits for a concurrent copy of the same note to
  -- commit and then judges the WHERE against that copy, so an older record
  -- updates nothing, whichever copy came first. The row lock the update takes
  -- is held to commit, so the allocation list below is replaced by one copy
  -- at a time, and only by a copy that wrote the note.
  INSERT INTO public.xero_supplier_credit_notes AS t (
    org_id, xero_credit_note_id, credit_note_type, credit_note_number, xero_contact_id, contact_name, reference,
    credit_note_date, status, line_amount_types, currency_code, sub_total, total_tax, total, remaining_credit,
    fully_paid_on, allocations_returned, xero_updated_at, raw_json, synced_at)
  VALUES (
    p_org_id, v_id, 'ACCPAYCREDIT', p_note ->> 'credit_note_number', p_note ->> 'xero_contact_id', p_note ->> 'contact_name',
    p_note ->> 'reference', (p_note ->> 'credit_note_date')::date, p_note ->> 'status', p_note ->> 'line_amount_types',
    p_note ->> 'currency_code', (p_note ->> 'sub_total')::numeric, (p_note ->> 'total_tax')::numeric,
    (p_note ->> 'total')::numeric, (p_note ->> 'remaining_credit')::numeric, (p_note ->> 'fully_paid_on')::date,
    p_allocations IS NOT NULL, v_updated, p_note -> 'raw_json', now())
  ON CONFLICT (org_id, xero_credit_note_id) DO UPDATE SET
    credit_note_number = EXCLUDED.credit_note_number,
    xero_contact_id = EXCLUDED.xero_contact_id,
    contact_name = EXCLUDED.contact_name,
    reference = EXCLUDED.reference,
    credit_note_date = EXCLUDED.credit_note_date,
    status = EXCLUDED.status,
    line_amount_types = EXCLUDED.line_amount_types,
    currency_code = EXCLUDED.currency_code,
    sub_total = EXCLUDED.sub_total,
    total_tax = EXCLUDED.total_tax,
    total = EXCLUDED.total,
    remaining_credit = EXCLUDED.remaining_credit,
    fully_paid_on = EXCLUDED.fully_paid_on,
    allocations_returned = EXCLUDED.allocations_returned,
    xero_updated_at = EXCLUDED.xero_updated_at,
    raw_json = EXCLUDED.raw_json,
    synced_at = EXCLUDED.synced_at
  WHERE t.xero_updated_at IS NULL OR EXCLUDED.xero_updated_at IS NULL
     OR EXCLUDED.xero_updated_at >= t.xero_updated_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN 'stale';
  END IF;

  IF p_allocations IS NOT NULL THEN
    DELETE FROM public.xero_supplier_credit_note_allocations a
     WHERE a.org_id = p_org_id AND a.xero_credit_note_id = v_id;
    INSERT INTO public.xero_supplier_credit_note_allocations (
      org_id, xero_credit_note_id, n, allocation_id, xero_invoice_id, invoice_number, amount, allocation_date, is_deleted, raw_json)
    SELECT p_org_id, v_id, e.n::int,
           NULLIF(btrim(COALESCE(e.value ->> 'allocation_id', '')), ''),
           NULLIF(btrim(COALESCE(e.value ->> 'xero_invoice_id', '')), ''),
           e.value ->> 'invoice_number',
           (e.value ->> 'amount')::numeric,
           (e.value ->> 'allocation_date')::date,
           COALESCE((e.value ->> 'is_deleted')::boolean, false),
           COALESCE(e.value -> 'raw_json', '{}'::jsonb)
      FROM jsonb_array_elements(p_allocations) WITH ORDINALITY e(value, n);
  END IF;
  RETURN 'written';
END;
$$;
COMMENT ON FUNCTION public.xero_supplier_credit_note_copy(uuid, jsonb, jsonb) IS
  'Supplier credit notes (20261030010000, TP-07 slice 1): the only writer of the credit note copy. One transaction: upserts the note Xero returned for that CreditNoteID and, when its record carried the Allocations list (allocations not null), replaces that note''s allocation rows with it. A record older than the stored one (Xero UpdatedDateUTC) changes neither the note nor its allocations (stale), including when two copies of one note race (the upsert itself judges freshness against the committed copy). Refuses a note with no id, not ACCPAYCREDIT, or with no Xero record. Never writes a status or amount Xero did not send, and never touches another note. Service role only.';
REVOKE ALL ON FUNCTION public.xero_supplier_credit_note_copy(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.xero_supplier_credit_note_copy(uuid, jsonb, jsonb) TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 4. Where each allocation lands (read only)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_supplier_credit_placement
WITH (security_invoker = true) AS
WITH note AS (
  SELECT n.*, COALESCE(n.status IN ('AUTHORISED', 'PAID'), false) AS live
  FROM public.xero_supplier_credit_notes n
),
alloc AS (
  SELECT
    n.org_id, n.xero_credit_note_id, n.credit_note_number, n.xero_contact_id, n.contact_name,
    n.credit_note_date, n.status AS credit_note_status, n.live,
    a.n, a.allocation_id, a.xero_invoice_id, a.invoice_number, a.amount, a.allocation_date, a.is_deleted,
    x.invoice_type AS bill_type, x.status AS bill_status, x.total AS bill_total,
    -- The same allocation seen from the bill's own copy, which CFO-20 counts.
    (SELECT sum(public.job_profit_num(c.value -> 'AppliedAmount'))
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(x.raw_json -> 'CreditNotes') = 'array' THEN x.raw_json -> 'CreditNotes' ELSE '[]'::jsonb END) c
      WHERE COALESCE(c.value ->> 'CreditNoteID', c.value ->> 'ID') = a.xero_credit_note_id) AS bill_side_applied,
    x.xero_invoice_id IS NOT NULL AS bill_in_copy
  FROM note n
  JOIN public.xero_supplier_credit_note_allocations a
    ON a.org_id = n.org_id AND a.xero_credit_note_id = n.xero_credit_note_id
  LEFT JOIN public.xero_invoices x
    ON x.org_id = a.org_id AND x.xero_invoice_id = a.xero_invoice_id AND x.invoice_type = 'ACCPAY'
  WHERE n.allocations_returned
),
-- The bill's placement in Job Profit: its supplier rows (never its credit
-- rows), summed per job. Ex GST, as v_job_cost_events carries them.
bill_part AS (
  SELECT e.document_id AS xero_invoice_id, e.job_id, sum(e.amount_ex) AS part_ex, bool_and(e.is_actual) AS part_is_actual
  FROM public.v_job_cost_events e
  WHERE e.party_kind = 'supplier'
    AND e.match_method IS DISTINCT FROM 'xero_amount_credited'
    AND e.source IN ('supplier_bill', 'materials_fact', 'installer_bill_unconfirmed', 'installer_bill_not_job_related')
    AND e.job_id IS NOT NULL
    AND e.document_id IN (SELECT a.xero_invoice_id FROM public.xero_supplier_credit_note_allocations a)
  GROUP BY e.document_id, e.job_id
),
judged AS (
  SELECT a.*,
    CASE
      WHEN NOT a.live THEN 'credit_note_not_live'
      WHEN a.is_deleted THEN 'allocation_deleted'
      WHEN a.amount IS NULL THEN 'amount_unknown'
      WHEN NOT a.bill_in_copy THEN 'bill_not_in_copy'
      WHEN a.bill_status IS NULL OR a.bill_status NOT IN ('AUTHORISED', 'PAID') THEN 'bill_not_live'
      WHEN a.bill_total IS NULL OR a.bill_total <= 0 THEN 'bill_total_unknown'
      WHEN NOT EXISTS (SELECT 1 FROM bill_part p WHERE p.xero_invoice_id = a.xero_invoice_id) THEN 'bill_not_placed'
      ELSE 'placed'
    END AS state
  FROM alloc a
)
-- Placed: one row per job the bill sits on, at CFO-20's rule.
SELECT j.org_id, j.xero_credit_note_id, j.credit_note_number, j.xero_contact_id, j.contact_name, j.credit_note_date,
       j.credit_note_status, j.n AS allocation_n, j.allocation_id, j.xero_invoice_id, j.invoice_number, j.bill_status,
       j.allocation_date, j.amount AS amount, 'placed'::text AS state,
       p.job_id, p.part_ex AS bill_part_ex, round(p.part_ex * j.amount / j.bill_total, 2) AS credit_ex,
       p.part_is_actual, j.bill_side_applied
  FROM judged j
  JOIN bill_part p ON p.xero_invoice_id = j.xero_invoice_id
 WHERE j.state = 'placed'
UNION ALL
-- Every other allocation: no job.
SELECT j.org_id, j.xero_credit_note_id, j.credit_note_number, j.xero_contact_id, j.contact_name, j.credit_note_date,
       j.credit_note_status, j.n, j.allocation_id, j.xero_invoice_id, j.invoice_number, j.bill_status,
       j.allocation_date, j.amount, j.state,
       NULL::uuid, NULL::numeric, NULL::numeric, NULL::boolean, j.bill_side_applied
  FROM judged j
 WHERE j.state <> 'placed'
UNION ALL
-- Credit still on a live note: on no bill and no job, its amount shown
-- (Xero's RemainingCredit), or unknown when Xero did not send it.
SELECT n.org_id, n.xero_credit_note_id, n.credit_note_number, n.xero_contact_id, n.contact_name, n.credit_note_date,
       n.status, NULL::integer, NULL::text, NULL::text, NULL::text, NULL::text,
       NULL::date, n.remaining_credit,
       CASE WHEN n.remaining_credit IS NULL THEN 'remaining_unknown' ELSE 'unallocated' END,
       NULL::uuid, NULL::numeric, NULL::numeric, NULL::boolean, NULL::numeric
  FROM note n
 WHERE n.live AND (n.remaining_credit IS NULL OR n.remaining_credit > 0)
UNION ALL
-- A live note whose record came without its Allocations list.
SELECT n.org_id, n.xero_credit_note_id, n.credit_note_number, n.xero_contact_id, n.contact_name, n.credit_note_date,
       n.status, NULL::integer, NULL::text, NULL::text, NULL::text, NULL::text,
       NULL::date, NULL::numeric, 'allocations_not_read'::text,
       NULL::uuid, NULL::numeric, NULL::numeric, NULL::boolean, NULL::numeric
  FROM note n
 WHERE n.live AND NOT n.allocations_returned;
COMMENT ON VIEW public.v_supplier_credit_placement IS
  'Supplier credit notes (20261030010000, TP-07 slice 1): where each supplier credit note allocation lands. state placed: one row per job the reversed bill sits on in Job Profit (v_job_cost_events'' supplier rows for that bill), credit_ex = bill part ex GST x allocation / bill total (CFO-20''s rule). Every other row has no job: unallocated (credit left on a live note, Xero''s RemainingCredit, never $0), remaining_unknown, allocations_not_read, credit_note_not_live (voided, deleted, draft, submitted or no status: never placed), allocation_deleted, amount_unknown, bill_not_in_copy, bill_not_live, bill_total_unknown, bill_not_placed. bill_side_applied: the same allocation as the bill''s own copy lists it (raw_json CreditNotes), which v_job_cost_events already takes off the job since CFO-20; slice 2 counts one side, never both. Changes no money figure: nothing reads it yet. Read only, service role only.';
REVOKE ALL ON public.v_supplier_credit_placement FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_supplier_credit_placement TO service_role;

-- ─────────────────────────────────────────────────────────────
-- 5. The switch, seeded off
-- ─────────────────────────────────────────────────────────────
DO $flag$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE NOTICE 'feature_flags is missing: xero_supplier_credit_notes_v1 not seeded (xero-sync reads a missing flag as off)';
    RETURN;
  END IF;
  INSERT INTO public.feature_flags (flag_name, enabled, description)
  SELECT 'xero_supplier_credit_notes_v1', false,
    'TP-07 slice 1 (20261030010000): xero-sync reads Xero''s supplier credit notes (ACCPAYCREDIT) and their allocations into xero_supplier_credit_notes only while this is on. Read only against Xero; changes no money figure. Missing or unreadable reads as off.'
  WHERE NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'xero_supplier_credit_notes_v1');
END
$flag$;
