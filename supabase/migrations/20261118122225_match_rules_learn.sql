-- P2-02.12. The director installs the decision trigger separately.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- One current answer per bill. Replacing or undoing it removes its old entry.
-- The immutable decision already holds the action and parts. Never copy its note,
-- amounts or before-image into the supplier history or a proposal response.
CREATE TABLE IF NOT EXISTS public.match_rule_answers (
  org_id uuid NOT NULL, subject_id text NOT NULL, party_id text NOT NULL,
  decision_id bigint NOT NULL UNIQUE, decided_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, subject_id)
);
CREATE INDEX IF NOT EXISTS match_rule_answers_recent
  ON public.match_rule_answers (org_id, party_id, decided_at DESC, decision_id DESC);
-- Frozen support: later bills never silently replace what the reviewer was shown.
CREATE TABLE IF NOT EXISTS public.match_rule_support (
  rule_id bigint PRIMARY KEY REFERENCES public.match_rules(id),
  org_id uuid NOT NULL, party_name text, decision_ids bigint[] NOT NULL
    CHECK (cardinality(decision_ids) = 3)
);
-- Install resumes at this cursor after each bounded batch, including after removal.
CREATE TABLE IF NOT EXISTS public.match_rule_install_state (
  singleton boolean PRIMARY KEY CHECK (singleton), through_id bigint NOT NULL
);
-- Faults store only the log coordinate. A later insert retries at most two
-- older entries, deleting each successful replay in the same transaction.
CREATE TABLE IF NOT EXISTS public.match_rule_retries (
  org_id uuid NOT NULL, decision_id bigint NOT NULL, PRIMARY KEY(org_id,decision_id)
);
ALTER TABLE public.match_rule_retries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_rule_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_rule_support ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_rule_install_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.match_rule_answers, public.match_rule_support, public.match_rule_install_state, public.match_rule_retries
  FROM PUBLIC, anon, authenticated, service_role;

-- All functions below are new. Refuse a different pre-image on re-apply.
DO $guard$
/* block */ BEGIN
  IF EXISTS (SELECT FROM pg_proc p JOIN (VALUES
      ('match_rule_index_answer','cc6719f3fd35a939d6e1d594353d60ab'),
      ('match_rule_on_decision','8f277a08c7fb2f6f54da13eb3adac43c'),
      ('match_rule_install','aa26f12aeb296abc403ab60050a769ce'),
      ('match_rule_remove','96bf1c34f2262509894cc790289f5cb4'),
      ('match_rule_confirm','9824019a1f1dee21926f4783e2355dfc'),
      ('match_rules_proposed','1843960124f089e7909aa07fc6cc6b31')
    ) expected(name,hash) ON expected.name=p.proname
    WHERE p.pronamespace='public'::regnamespace AND md5(p.prosrc)<>expected.hash) THEN
    RAISE EXCEPTION 'match_rule_function_drift';
  END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.match_rule_index_answer(d public.reconcile_decisions, learn boolean)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  supplier text;
  supplier_name text;
  recent_ids bigint[];
  proposal_kind text;
  target_division text;
  new_rule bigint;
/* block */ BEGIN
  IF d.supersedes IS NOT NULL THEN
    DELETE FROM public.match_rule_answers
      WHERE decision_id = d.supersedes AND org_id = d.org_id AND subject_id = d.subject_id;
  END IF;
  IF d.subject_kind <> 'cost_document' OR NOT starts_with(d.subject_id,'xero_bill:')
     OR d.action = 'undo' OR d."by" NOT LIKE 'person:%' THEN RETURN; END IF;

  -- The decision is inserted BEFORE the cost lines get their decision_id.
  -- Resolve the exact document, including its org, at that point in the write.
  SELECT min(l.party_id), min(nullif(l.party_name,''))
    INTO supplier, supplier_name
    FROM public.job_cost_lines l
    WHERE l.org_id = d.org_id AND l.document_kind = 'xero_bill'
      AND l.document_id = substr(d.subject_id,11) AND l.state IS NOT NULL
    HAVING bool_and(l.kind = 'supplier_bill' AND l.party_kind IS NOT DISTINCT FROM 'supplier'
                    AND nullif(btrim(l.party_id),'') IS NOT NULL)
      AND min(l.party_id) = max(l.party_id);
  IF supplier IS NULL THEN RETURN; END IF;

  -- Serialize two people deciding different bills of one supplier. The lock is
  -- private to learning. No job, money, or decision writer acquires this key.
  PERFORM pg_advisory_xact_lock(hashtextextended('match_rule:' || supplier,0));
  INSERT INTO public.match_rule_answers AS a (org_id, subject_id, party_id, decision_id, decided_at)
    VALUES (d.org_id, d.subject_id, supplier, d.id, d.decided_at)
    ON CONFLICT (org_id,subject_id) DO UPDATE
      SET party_id=excluded.party_id, decision_id=excluded.decision_id, decided_at=excluded.decided_at
      WHERE (a.decided_at,a.decision_id) < (excluded.decided_at,excluded.decision_id);
  IF NOT FOUND OR NOT learn OR d.action NOT IN ('overhead','division_stock','place','split') THEN RETURN; END IF;

  SELECT array_agg(r.id ORDER BY a.decided_at DESC,a.decision_id DESC),
    CASE WHEN count(*)=3 AND bool_and(r.action='overhead') THEN 'supplier_usually_overhead'
         WHEN count(*)=3 AND bool_and(r.action='division_stock')
           AND count(r.parts->0->>'division')=3 AND count(DISTINCT (r.parts->0->>'division'))=1
           AND min(r.parts->0->>'division') IN ('patios','fencing','insurance')
           THEN 'supplier_usually_division_stock' END,
    min(CASE WHEN r.action='division_stock' THEN r.parts->0->>'division' END)
  INTO recent_ids,proposal_kind,target_division
  FROM (SELECT a.decision_id,a.decided_at FROM public.match_rule_answers a
        WHERE a.org_id=d.org_id AND a.party_id=supplier
        ORDER BY a.decided_at DESC,a.decision_id DESC LIMIT 3) a
  CROSS JOIN LATERAL (SELECT r.id,r.action,r.parts FROM public.reconcile_decisions r
                      WHERE r.id=a.decision_id LIMIT 1) r;
  IF recent_ids[1] IS DISTINCT FROM d.id THEN RETURN; END IF;

  IF d.action IN ('place','split') THEN
    UPDATE public.match_rules r SET wrong_count=r.wrong_count+1,
      status=CASE WHEN r.wrong_count+1 >= 2 THEN 'retired' ELSE 'confirmed' END
    FROM public.match_rule_support s
    WHERE r.kind IN ('supplier_usually_overhead','supplier_usually_division_stock')
      AND r.party_id=supplier AND r.status='confirmed' AND s.rule_id=r.id AND s.org_id=d.org_id;
  ELSIF proposal_kind IS NOT NULL THEN
    INSERT INTO public.match_rules(kind,party_id,division)
      VALUES (proposal_kind,supplier,target_division)
      ON CONFLICT (kind,party_id) DO NOTHING RETURNING id INTO new_rule;
    IF new_rule IS NOT NULL THEN
      INSERT INTO public.match_rule_support(rule_id,org_id,party_name,decision_ids)
        VALUES(new_rule,d.org_id,supplier_name,recent_ids);
    END IF;
  END IF;
END $fn$;

CREATE OR REPLACE FUNCTION public.match_rule_on_decision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET lock_timeout='500ms' AS $fn$
DECLARE
  pending_id bigint;
  missed public.reconcile_decisions;
/* block */ BEGIN
  FOR pending_id IN SELECT q.decision_id FROM public.match_rule_retries q
    WHERE q.org_id=NEW.org_id ORDER BY q.decision_id LIMIT 2 FOR UPDATE LOOP
    SELECT * INTO STRICT missed FROM public.reconcile_decisions WHERE id=pending_id AND org_id=NEW.org_id;
    PERFORM public.match_rule_index_answer(missed,true);
    DELETE FROM public.match_rule_retries WHERE org_id=NEW.org_id AND decision_id=pending_id;
  END LOOP;
  IF EXISTS (SELECT FROM public.match_rule_retries WHERE org_id=NEW.org_id LIMIT 1) THEN
    INSERT INTO public.match_rule_retries VALUES(NEW.org_id,NEW.id) ON CONFLICT DO NOTHING;
  ELSE
    PERFORM public.match_rule_index_answer(NEW,true);
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Keep the office decision even if retry storage itself is unavailable.
  /* block */ BEGIN
    INSERT INTO public.match_rule_retries VALUES(NEW.org_id,NEW.id) ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'match_rule_retry_unavailable decision=% code=%', NEW.id, SQLSTATE;
  END;
  RAISE WARNING 'match_rule_read_failed decision=% code=%', NEW.id, SQLSTATE;
  RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.match_rule_install()
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE
  cursor_id bigint;
  d public.reconcile_decisions;
  processed integer := 0;
/* block */ BEGIN
  IF EXISTS (SELECT FROM pg_trigger WHERE tgrelid='public.reconcile_decisions'::regclass
      AND tgname='match_rule_on_decision') THEN RETURN '{"installed":true}'; END IF;
  -- Director only, outside office hours. NOWAIT avoids queueing behind a writer.
  -- Quiesce inserts before reading their ids, including an uncommitted older id.
  LOCK TABLE public.reconcile_decisions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  INSERT INTO public.match_rule_install_state VALUES(true,0) ON CONFLICT DO NOTHING;
  SELECT through_id INTO STRICT cursor_id FROM public.match_rule_install_state WHERE singleton;
  FOR d IN SELECT r.* FROM public.reconcile_decisions r WHERE r.id > cursor_id
           ORDER BY r.id LIMIT 100 LOOP
    PERFORM public.match_rule_index_answer(d,false);
    cursor_id := d.id;
    processed := processed+1;
  END LOOP;
  UPDATE public.match_rule_install_state SET through_id=cursor_id WHERE singleton;
  IF processed < 100 THEN
    CREATE TRIGGER match_rule_on_decision AFTER INSERT ON public.reconcile_decisions
      FOR EACH ROW WHEN (NEW.subject_kind='cost_document' AND starts_with(NEW.subject_id,'xero_bill:')
        AND (NEW."by" LIKE 'person:%' OR NEW.supersedes IS NOT NULL))
      EXECUTE FUNCTION public.match_rule_on_decision();
  END IF;
  RETURN jsonb_build_object('installed',processed<100,'indexed_through',cursor_id);
END $fn$;

CREATE OR REPLACE FUNCTION public.match_rule_remove()
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
/* block */ BEGIN
  IF EXISTS (SELECT FROM pg_trigger WHERE tgrelid='public.reconcile_decisions'::regclass
      AND tgname='match_rule_on_decision') THEN
    LOCK TABLE public.reconcile_decisions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
    DROP TRIGGER match_rule_on_decision ON public.reconcile_decisions;
    UPDATE public.match_rule_install_state SET through_id=coalesce(
      (SELECT id FROM public.reconcile_decisions ORDER BY id DESC LIMIT 1),0) WHERE singleton;
  END IF;
END $fn$;

CREATE OR REPLACE FUNCTION public.match_rule_confirm(p_rule_id bigint,p_confirm boolean,p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  actor_org uuid;
  target_status text := CASE WHEN p_confirm THEN 'confirmed' ELSE 'retired' END;
  rule public.match_rules;
/* block */ BEGIN
  SELECT org_id INTO actor_org FROM public.users WHERE id=p_user_id AND role IN ('admin','owner','ops_manager');
  IF actor_org IS NULL THEN RAISE EXCEPTION 'reconcile_not_staff' USING ERRCODE='42501'; END IF;
  IF p_confirm IS NULL THEN RAISE EXCEPTION 'match_rule_answer_required'; END IF;
  SELECT r.* INTO rule FROM public.match_rules r JOIN public.match_rule_support s ON s.rule_id=r.id
    WHERE r.id=p_rule_id AND s.org_id=actor_org FOR UPDATE OF r;
  IF NOT FOUND THEN RAISE EXCEPTION 'match_rule_unavailable'; END IF;
  IF rule.status='proposed' THEN
    IF p_confirm AND EXISTS (SELECT FROM public.match_rule_retries WHERE org_id=actor_org LIMIT 1) THEN
      RAISE EXCEPTION 'match_rule_history_unavailable';
    END IF;
    IF p_confirm AND (SELECT count(*) FROM public.match_rule_support s
          JOIN public.match_rule_answers a ON a.decision_id=ANY(s.decision_ids)
          JOIN public.reconcile_decisions d ON d.id=a.decision_id
          WHERE s.rule_id=rule.id AND a.org_id=actor_org AND a.party_id=rule.party_id
            AND ((rule.kind='supplier_usually_overhead' AND d.action='overhead' AND rule.division IS NULL)
              OR (rule.kind='supplier_usually_division_stock' AND d.action='division_stock'
                AND d.parts->0->>'division'=rule.division))) <> 3 THEN
      RAISE EXCEPTION 'match_rule_evidence_changed';
    END IF;
    UPDATE public.match_rules SET status=target_status, confirmed_by='person:'||p_user_id,
      confirmed_at=clock_timestamp() WHERE id=p_rule_id;
  ELSIF rule.status<>target_status OR rule.confirmed_by IS DISTINCT FROM 'person:'||p_user_id THEN
    RAISE EXCEPTION 'match_rule_already_decided';
  END IF;
  RETURN jsonb_build_object('rule_id',p_rule_id,'status',target_status);
END $fn$;

CREATE OR REPLACE FUNCTION public.match_rules_proposed()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object('rule_id',r.id,'kind',r.kind,'division',r.division,
    'party_id',r.party_id,'party_name',s.party_name,'decisions',(
      SELECT jsonb_agg(jsonb_build_object('decision_id',d.id,'subject_id',d.subject_id,'action',d.action,
          'division',CASE WHEN d.action='division_stock' THEN d.parts->0->>'division' END)
          ORDER BY d.decided_at DESC,d.id DESC)
      FROM public.reconcile_decisions d WHERE d.id=ANY(s.decision_ids))) ORDER BY r.id),'[]'::jsonb)
  FROM public.match_rules r JOIN public.match_rule_support s ON s.rule_id=r.id WHERE r.status='proposed'
$fn$;

REVOKE ALL ON FUNCTION public.match_rule_index_answer(public.reconcile_decisions,boolean),
  public.match_rule_on_decision(),public.match_rule_install(),public.match_rule_remove(),
  public.match_rule_confirm(bigint,boolean,uuid),public.match_rules_proposed()
  FROM PUBLIC,anon,authenticated,service_role;
-- Only the database owner installs/removes. The trusted service passes the verified staff id.
GRANT EXECUTE ON FUNCTION public.match_rule_confirm(bigint,boolean,uuid),public.match_rules_proposed()
  TO service_role;
