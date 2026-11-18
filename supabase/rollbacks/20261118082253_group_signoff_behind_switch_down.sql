-- P1-13.2 rollback: each caller reads group_client_signoff_counts again, so a
-- group freeze, share line and release need the customer sign-off whatever
-- the switch says (main before P1-13.2). No sign-off row or switch is touched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $restore$
DECLARE
  r record;
  body text;
  actual text;
  hits integer;
  before_text constant text := 'public.group_client_signoff_gate_passes(';
  after_text constant text := 'public.group_client_signoff_counts(';
/* block */ BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.group_work_order_write_split(uuid,boolean)',
      '49c6e1a2f1c06a608f650734295da85b', '963a2d18e131a325c8cea253199790af'),
    ('public.trade_invoice_lines_group_share_snapshot()',
      'ed7d8968a07b481d2f05721b08985edc', 'f0c984a6c097ed91de42ede666d82dfc'),
    ('public.group_work_order_release_state(uuid)',
      'e3439e346dd94d76fee489af7a9d755c', 'e5b5b924cb4684195eac129ba4a73de9')
  ) v(fn, pre_md5, post_md5) LOOP
    SELECT md5(p.prosrc) INTO actual FROM pg_proc p WHERE p.oid = r.fn::regprocedure;
    IF actual = r.pre_md5 THEN CONTINUE; END IF;
    IF actual IS DISTINCT FROM r.post_md5 THEN
      RAISE EXCEPTION 'p1_13_2_rollback_preimage_mismatch: % (%)', r.fn, actual;
    END IF;
    body := pg_get_functiondef(r.fn::regprocedure);
    hits := (length(body) - length(replace(body, before_text, ''))) / length(before_text);
    IF hits <> 1 THEN
      RAISE EXCEPTION 'p1_13_2_rollback_call_count: % found %', r.fn, hits;
    END IF;
    EXECUTE replace(body, before_text, after_text);
  END LOOP;
END $restore$;
DROP FUNCTION IF EXISTS public.group_client_signoff_gate_passes(uuid);
