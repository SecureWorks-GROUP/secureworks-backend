-- (finish line C4, 3 Nov 2026) The ledger store takes a retired note that names the earlier note it was a copy of.
--
-- The notes reader's closing pass (secureworks-jarvis #294, switch context_ledger_closing_dedupe_v1, off) may find two open
-- notes that are one loop written twice: an ask and our matching promise, or one ask written twice. The owner's decision
-- of 3 Nov 2026: the reader may mark the second copy as replaced by the first (same matter, same owing side; keep the
-- earlier one, the later one closes as replaced citing the earlier note; never across different payers or jobs). The
-- store could not take that: a transition is only {item_key, to_status, evidence, reason} (any other key is
-- invalid_shape), and a superseded move needs an item of the generation whose supersedes_key names the note
-- (superseded_without_replacement). On the 20 dev jobs of the blind notes check, 11 of 19 such copies pass the guards.
--
-- Change (context_ledger_write, five exact edits of the live definition; everything else byte for byte):
--  - a transition may carry replaced_by (the item_key of the earlier note), on a superseded move only, a string of 1 to
--    200; anything else with it is invalid_shape, with its own detail;
--  - such a move is taken when the named note is of the same generation (replaced_by_unknown), is not the note itself
--    (replaced_by_itself), both are open and the named one is not person-locked (replaced_by_not_open), the named one
--    opened no later (replaced_by_later) and the two are one loop (context_ledger_same_loop, new: the same type, or an ask
--    and the matching promise; the same owing side and other side, both known; for money, a payment or an invoice, the
--    same about) (replaced_by_other_loop). It needs no evidence and no replacing item; the note closes as of its own
--    opening, or its latest evidence row when given, and its transition records replaced_by_key;
--  - every other move is unchanged: a superseded move without replaced_by still needs its replacing item.
-- context_ledger_transitions gains replaced_by_key (null unless the move named a note; a check keeps it to superseded).
-- No row is written or changed by this migration. The reader's switch stays off: nothing sends replaced_by until it is on.
-- Guard: the live function must be the definition this was written against (md5 bfe7aa27..., the 20261007150000 body).
-- Rollback: supabase/rollbacks/20261104050000_context_ledger_replaced_by_down.sql (refuses once a move has named a note).
SET LOCAL lock_timeout = '5s';

-- 0. Nothing changes unless the live write is the definition this was written against (or already this one).
DO $guard$ BEGIN
  IF md5(pg_get_functiondef('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure)) NOT IN ('bfe7aa27a44451a235af4da10004f61a', 'af7c768f7ef2d3e8b45bb0706a485194') THEN
    RAISE EXCEPTION 'context_ledger_write is not the definition this migration was written against (md5 %)',
      md5(pg_get_functiondef('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure));
  END IF;
END $guard$;

-- 1. The record of which note a retired copy repeats.
ALTER TABLE public.context_ledger_transitions ADD COLUMN IF NOT EXISTS replaced_by_key text;
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.context_ledger_transitions'::regclass
                 AND conname = 'context_ledger_transitions_replaced_by_key_check') THEN
    ALTER TABLE public.context_ledger_transitions ADD CONSTRAINT context_ledger_transitions_replaced_by_key_check
      CHECK (replaced_by_key IS NULL OR (to_status = 'superseded' AND length(replaced_by_key) BETWEEN 1 AND 200));
  END IF;
END $c$;
COMMENT ON COLUMN public.context_ledger_transitions.replaced_by_key IS
 '(20261104050000) On a superseded move that retired a second copy of one loop: the item_key of the earlier note of the same generation it repeats (context_ledger_write, replaced_by). Null on every other move.';

-- 2. One loop: the guard the store holds a named note to (the reader's own sameLoop, secureworks-jarvis luna-ledger-closing.ts).
CREATE OR REPLACE FUNCTION public.context_ledger_same_loop(a public.context_ledger_items, b public.context_ledger_items)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT coalesce(
  a.item_type IN ('commitment','request','claim','issue','constraint','dependency')
  AND b.item_type IN ('commitment','request','claim','issue','constraint','dependency')
  AND (a.item_type = b.item_type OR (a.item_type IN ('commitment','request') AND b.item_type IN ('commitment','request')))
  AND CASE WHEN a.item_type = 'commitment' THEN a.from_role ELSE a.to_role END NOT IN ('unknown')
  AND CASE WHEN a.item_type = 'commitment' THEN a.to_role ELSE a.from_role END NOT IN ('unknown')
  AND CASE WHEN a.item_type = 'commitment' THEN a.from_role ELSE a.to_role END = CASE WHEN b.item_type = 'commitment' THEN b.from_role ELSE b.to_role END
  AND CASE WHEN a.item_type = 'commitment' THEN a.to_role ELSE a.from_role END = CASE WHEN b.item_type = 'commitment' THEN b.to_role ELSE b.from_role END
  AND (NOT (coalesce(a.closes_on, '') = 'payment' OR coalesce(b.closes_on, '') = 'payment'
            OR coalesce(a.about_key, '') ~ '^(invoice|payment):' OR coalesce(b.about_key, '') ~ '^(invoice|payment):')
       OR a.about_key = b.about_key), false)
$$;
COMMENT ON FUNCTION public.context_ledger_same_loop(public.context_ledger_items, public.context_ledger_items) IS
 '(20261104050000) Whether two ledger notes may be one loop written twice: both loops, the same type or an ask and the matching promise, the same owing side (a commitment''s from_role, any other loop''s to_role) and the same other side, both known, and for money (closes_on payment, or about invoice: or payment:) the same about_key. The owner''s decision of 3 Nov 2026: same matter, same owing side, never across payers or jobs (the caller holds both to one generation). Service role only.';
REVOKE ALL ON FUNCTION public.context_ledger_same_loop(public.context_ledger_items, public.context_ledger_items) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.context_ledger_same_loop(public.context_ledger_items, public.context_ledger_items) TO service_role;

-- 3. The write.
DO $mig$
DECLARE
  v_def text;
  v_old0 text := $o$ v_ev jsonb; v_ev_at timestamptz; v_code text; v_detail text; c jsonb; n integer; v_ok boolean;
$o$;
  v_new0 text := $n$ v_ev jsonb; v_ev_at timestamptz; v_code text; v_detail text; c jsonb; n integer; v_ok boolean;
 rb public.context_ledger_items;
$n$;
  v_old1 text := $o$WHERE kk NOT IN ('item_key','to_status','evidence','reason'))$o$;
  v_new1 text := $n$WHERE kk NOT IN ('item_key','to_status','evidence','reason','replaced_by'))$n$;
  v_old2 text := $o$   v_code := 'invalid_shape'; v_detail := 'a transition is {item_key, to_status, evidence, reason}';
  END IF;
$o$;
  v_new2 text := $n$   v_code := 'invalid_shape'; v_detail := 'a transition is {item_key, to_status, evidence, reason}';
  END IF;
  -- (20261104050000) replaced_by: only on a superseded move, the item_key of the earlier note this one repeats.
  IF v_code IS NULL AND tr ? 'replaced_by' AND (jsonb_typeof(tr -> 'replaced_by') IS DISTINCT FROM 'string'
   OR tr ->> 'to_status' <> 'superseded' OR length(tr ->> 'replaced_by') NOT BETWEEN 1 AND 200) THEN
   v_code := 'invalid_shape'; v_detail := 'replaced_by is the item_key of an earlier note, on a superseded move only';
  END IF;
$n$;
  v_old3 text := $o$  IF v_code IS NULL AND tr ->> 'to_status' = 'superseded' THEN
   SELECT min(i.opened_at) INTO v_rep_at FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.supersedes_key = li.item_key;
$o$;
  v_new3 text := $n$  IF v_code IS NULL AND tr ? 'replaced_by' THEN
   -- (20261104050000) a second copy of one loop, retired in favour of the earlier note of this generation that it
   -- repeats (the owner's decision of 3 Nov 2026): both open, the named one not a person's and opened no later, and
   -- one loop (context_ledger_same_loop: one loop family, the same owing side and other side, for money the same
   -- about, so never two payers or two invoices). It closes as of its own opening (or its latest evidence row); it
   -- was never owed apart from the note it repeats. No item replaces it: the move names the note (replaced_by_key).
   SELECT * INTO rb FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.item_key = tr ->> 'replaced_by';
   IF rb.id IS NULL THEN v_code := 'replaced_by_unknown';
   ELSIF rb.id = li.id THEN v_code := 'replaced_by_itself';
   ELSIF li.status <> 'open' OR rb.status <> 'open' OR rb.person_locked THEN v_code := 'replaced_by_not_open';
   ELSIF rb.opened_at > li.opened_at THEN v_code := 'replaced_by_later';
   ELSIF NOT public.context_ledger_same_loop(li, rb) THEN v_code := 'replaced_by_other_loop';
   ELSE v_ev_at := coalesce(v_ev_at, li.opened_at);
   END IF;
   IF v_code IS NOT NULL THEN v_detail := left(tr ->> 'replaced_by', 200); END IF;
  ELSIF v_code IS NULL AND tr ->> 'to_status' = 'superseded' THEN
   SELECT min(i.opened_at) INTO v_rep_at FROM public.context_ledger_items i WHERE i.generation_id = g.id AND i.supersedes_key = li.item_key;
$n$;
  v_old4 text := $o$  INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, by, evidence, reason)
  VALUES (li.id, g.id, g.job_id, li.status, tr ->> 'to_status', v_by, CASE WHEN jsonb_array_length(v_ev) > 0 THEN v_ev END, tr ->> 'reason');
$o$;
  v_new4 text := $n$  INSERT INTO public.context_ledger_transitions (item_id, generation_id, job_id, from_status, to_status, by, evidence, reason, replaced_by_key)
  VALUES (li.id, g.id, g.job_id, li.status, tr ->> 'to_status', v_by, CASE WHEN jsonb_array_length(v_ev) > 0 THEN v_ev END, tr ->> 'reason',
   tr ->> 'replaced_by');
$n$;
BEGIN
  SELECT pg_get_functiondef('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure) INTO v_def;
  IF md5(v_def) = 'af7c768f7ef2d3e8b45bb0706a485194' THEN
    RAISE NOTICE 'context_ledger_write already carries 20261104050000';
    RETURN;
  END IF;
  IF md5(v_def) <> 'bfe7aa27a44451a235af4da10004f61a' THEN
    RAISE EXCEPTION 'context_ledger_write is not the definition this migration was written against (md5 %)', md5(v_def);
  END IF;
  IF (length(v_def) - length(replace(v_def, v_old0, ''))) / length(v_old0) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_write: change 1 does not match exactly once';
  END IF;
  v_def := replace(v_def, v_old0, v_new0);
  IF (length(v_def) - length(replace(v_def, v_old1, ''))) / length(v_old1) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_write: change 2 does not match exactly once';
  END IF;
  v_def := replace(v_def, v_old1, v_new1);
  IF (length(v_def) - length(replace(v_def, v_old2, ''))) / length(v_old2) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_write: change 3 does not match exactly once';
  END IF;
  v_def := replace(v_def, v_old2, v_new2);
  IF (length(v_def) - length(replace(v_def, v_old3, ''))) / length(v_old3) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_write: change 4 does not match exactly once';
  END IF;
  v_def := replace(v_def, v_old3, v_new3);
  IF (length(v_def) - length(replace(v_def, v_old4, ''))) / length(v_old4) <> 1 THEN
    RAISE EXCEPTION 'context_ledger_write: change 5 does not match exactly once';
  END IF;
  v_def := replace(v_def, v_old4, v_new4);
  EXECUTE v_def;
  SELECT pg_get_functiondef('public.context_ledger_write(uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure) INTO v_def;
  IF md5(v_def) <> 'af7c768f7ef2d3e8b45bb0706a485194' THEN
    RAISE EXCEPTION 'context_ledger_write after the change is not the rehearsed definition (md5 %)', md5(v_def);
  END IF;
END
$mig$;

COMMENT ON FUNCTION public.context_ledger_write(uuid, uuid, uuid, jsonb, jsonb, text) IS
 'Context ledger store (20261006013000), ledger reader fixes (20261007150000): (replaced by, 20261104050000) a superseded transition may carry replaced_by, the item_key of the earlier note of the same generation that it is a second copy of (the owner''s decision of 3 Nov 2026). It is taken when both notes are open, the named one is not person-locked and opened no later, and the two are one loop (context_ledger_same_loop: the same type or an ask and the matching promise, the same owing side and other side, both known, and for money the same about, so never two payers, invoices or jobs); else refused replaced_by_unknown, replaced_by_itself, replaced_by_not_open, replaced_by_later or replaced_by_other_loop, and replaced_by on any other move, or not a string of 1 to 200, is invalid_shape. Such a move needs no evidence and no replacing item; the note closes as of its own opening (or its latest evidence row) and the transition records replaced_by_key. Every other move is unchanged. Before 20261104050000: a transition closing a payment item on a PAID invoice closes it at the end of the invoice''s paid Perth day, never after now (context_ledger_paid_close_at), as an item''s closed_by does; items pass the item check''s new elsewhere_unsupported rule. Earlier: writes a reader''s items and transitions into a generation under custody. The run must be a running ledger run holding its lease (else lease_lost), the lane on and the mode not off (else off), the generation this run''s building generation or, for an update run, the job''s current generation (else refused generation_mismatch), the reader the generation''s (reader_mismatch). Every item passes context_ledger_check_item, is not a person-corrected matter (person_locked: the same type and first opening citation as a person-locked item of this generation or the live one), a fresh ref and item_key (duplicate_ref, duplicate_item), resolvable supersedes (supersedes_unresolved, superseded_without_replacement); accepted items are inserted whole with a transition, refused ones reported with a code. Transitions refuse person_locked, unknown_item, no_change, evidence_missing (every status but superseded needs evidence), evidence_older_than_item, and for closed or declined closing_not_issued and closing_is_opening (the item''s closing rules), and any citation refusal. A repeated identical request in the same run returns its first answer (replayed true). written_by model:<reader>. Service role only.';
