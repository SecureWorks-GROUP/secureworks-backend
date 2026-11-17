BEGIN;
\set record_fixture_seed true
\ir setup.sql
DO $c$
DECLARE v jsonb; n integer;
BEGIN
 -- T8 reports without changing an item or appending a transition.
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000401');
 IF v->>'would_close'<>'1' OR v->>'closed'<>'0' OR v->>'wrote'<>'false'
  OR EXISTS(SELECT 1 FROM public.context_ledger_transitions WHERE job_id='00000000-0000-4000-8000-000000000401') THEN RAISE EXCEPTION 'record close: T8 off'; END IF;
 -- T1 and T2 explicit writes; a repeat cannot duplicate transitions.
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000401',false);
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000401',false);
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000402',false);
 IF NOT EXISTS(SELECT 1 FROM public.context_ledger_items WHERE id='00000000-0000-4000-8000-000000000401' AND status='closed' AND closed_at='2026-11-04T10:00:00+08'
 AND closed_by='[{"table":"job_documents","id":"00000000-0000-4000-8000-000000000401"}]')
 OR NOT EXISTS(SELECT 1 FROM public.context_ledger_items WHERE id='00000000-0000-4000-8000-000000000402' AND status='closed' AND closed_at='2026-11-05T23:59:59+08')
 OR (SELECT count(*) FROM public.context_ledger_transitions WHERE by='rule:record_close_v1')<>2 THEN RAISE EXCEPTION 'record close: T1 T2 proof'; END IF;
 -- T9 reopens only the two still governed by the rule.
 n:=public.context_ledger_record_close_undo('2026-11-01');
 IF n<>2 OR (SELECT count(*) FROM public.context_ledger_transitions WHERE by='rule:record_close_undo')<>2
 OR EXISTS(SELECT 1 FROM public.context_ledger_items WHERE id IN ('00000000-0000-4000-8000-000000000401','00000000-0000-4000-8000-000000000402') AND (status<>'open' OR closed_at IS NOT NULL OR closed_by IS NOT NULL)) THEN RAISE EXCEPTION 'record close: T9 undo'; END IF;
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000403',false);
 IF v->>'closed'<>'1' THEN RAISE EXCEPTION 'record close: T3 bill'; END IF;
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000404',false);
 IF v->>'ambiguous'<>'1' OR jsonb_array_length(v#>'{ambiguous_items,0,candidates}')<>2 OR v->>'closed'<>'0' THEN RAISE EXCEPTION 'record close: T4 ambiguity'; END IF;
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000405',false);
 IF v->>'would_close'<>'0' THEN RAISE EXCEPTION 'record close: T5 older record'; END IF;
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000406',false);
 UPDATE public.context_ledger_items SET status='open',closed_at=NULL,closed_by=NULL,person_locked=true WHERE id='00000000-0000-4000-8000-000000000406';
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000406',false);
 IF v->>'would_close'<>'0' THEN RAISE EXCEPTION 'record close: T6 person lock'; END IF;
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000407',false);
 IF v->>'would_close'<>'0' THEN RAISE EXCEPTION 'record close: T7 cancelled booking'; END IF;
 -- A known unmatched key cannot close just because only one other record exists.
 UPDATE public.context_ledger_items SET about_key='invoice:inv-9999' WHERE id='00000000-0000-4000-8000-000000000410';
 v:=public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000410',false);
 IF v->>'closed'<>'0' THEN RAISE EXCEPTION 'record close: unmatched key'; END IF;
 -- Person-written, held and disputed notes are never rule-owned.
 UPDATE public.context_ledger_items SET written_by='person:fixture' WHERE id='00000000-0000-4000-8000-000000000411';
 UPDATE public.context_ledger_items SET job_not_certain=true WHERE id='00000000-0000-4000-8000-000000000412';
 UPDATE public.context_ledger_items SET status='disputed' WHERE id='00000000-0000-4000-8000-000000000409';
 IF (public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000411',false)->>'closed')<>'0'
 OR (public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000412',false)->>'closed')<>'0'
 OR (public.context_ledger_close_on_records('00000000-0000-4000-8000-000000000409',false)->>'closed')<>'0' THEN RAISE EXCEPTION 'record close: protected notes'; END IF;
END $c$;
SELECT 'PASS: P4-02.2 T1 to T9, idempotent closure, evidence and protected notes' AS result;
ROLLBACK;
