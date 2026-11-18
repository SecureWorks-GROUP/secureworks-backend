-- P1-13.2: the customer sign-off rule for groups sits behind the switch.
-- Owner decision 17 Nov 2026: sign-off gates nothing for now. While
-- trade_invoice_requires_client_signoff_v1 is off (or its row is missing) a
-- group split freezes, a share line binds and a release proceeds without a
-- customer signature. With the switch on, the rule is main's exactly:
-- group_client_signoff_counts, unchanged (director ruling B, 18 Nov 2026).
-- No table, trigger, schedule or switch is created or changed here.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The gate is new; live has no function of this name. Refuse if one exists
-- that is not this migration's own body.
DO $guard$
DECLARE actual text; /* block */ BEGIN
  IF to_regprocedure('public.group_client_signoff_gate_passes(uuid)') IS NOT NULL THEN
    SELECT md5(p.prosrc) INTO actual FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.group_client_signoff_gate_passes(uuid)');
    IF actual IS DISTINCT FROM '4adae9308dcdc7317757cfb3e7a50a4b' THEN
      RAISE EXCEPTION 'p1_13_2_preimage_mismatch: group_client_signoff_gate_passes(uuid) (%)', actual;
    END IF;
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.group_client_signoff_gate_passes(p_job uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $fn$
/* block */ BEGIN
  -- feature_flags_flag_name_key. A missing row is the switch off.
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags f
                 WHERE f.flag_name = 'trade_invoice_requires_client_signoff_v1' AND f.enabled) THEN
    RETURN true;
  END IF;
  RETURN public.group_client_signoff_counts(p_job);
END $fn$;
REVOKE ALL ON FUNCTION public.group_client_signoff_gate_passes(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_client_signoff_gate_passes(uuid) TO service_role;

-- Every live function whose body calls group_client_signoff_counts( to decide
-- whether a freeze, a share line or a release may proceed, with its expected
-- hit count. Pre-images are main's bodies, which equal the director's
-- live-public-object-md5-18nov.tsv; the post-image is this migration's own
-- result, so a re-apply is a no-op.
DO $patch$
DECLARE
  r record;
  body text;
  actual text;
  hits integer;
  before_text constant text := 'public.group_client_signoff_counts(';
  after_text constant text := 'public.group_client_signoff_gate_passes(';
/* block */ BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.group_work_order_write_split(uuid,boolean)', 1,
      '49c6e1a2f1c06a608f650734295da85b', '963a2d18e131a325c8cea253199790af'),
    ('public.trade_invoice_lines_group_share_snapshot()', 1,
      'ed7d8968a07b481d2f05721b08985edc', 'f0c984a6c097ed91de42ede666d82dfc'),
    ('public.group_work_order_release_state(uuid)', 1,
      'e3439e346dd94d76fee489af7a9d755c', 'e5b5b924cb4684195eac129ba4a73de9')
  ) v(fn, expected_hits, pre_md5, post_md5) LOOP
    SELECT md5(p.prosrc) INTO actual FROM pg_proc p WHERE p.oid = r.fn::regprocedure;
    IF actual = r.post_md5 THEN CONTINUE; END IF;
    IF actual IS DISTINCT FROM r.pre_md5 THEN
      RAISE EXCEPTION 'p1_13_2_preimage_mismatch: % (%)', r.fn, actual;
    END IF;
    body := pg_get_functiondef(r.fn::regprocedure);
    hits := (length(body) - length(replace(body, before_text, ''))) / length(before_text);
    IF hits <> r.expected_hits THEN
      RAISE EXCEPTION 'p1_13_2_call_count: % expected % found %', r.fn, r.expected_hits, hits;
    END IF;
    EXECUTE replace(body, before_text, after_text);
  END LOOP;
END $patch$;
