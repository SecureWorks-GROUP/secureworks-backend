-- Canonical mail-occurrence producer + tenant-fenced work-link correction/reader.
-- Does not replace monitor-inbox Graph capture; that path must call this RPC.

CREATE TABLE IF NOT EXISTS public.context_mail_logical_sources (
  logical_id text PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES public.business_events(id),
  org_id uuid NOT NULL,
  internet_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.context_mail_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  logical_id text NOT NULL REFERENCES public.context_mail_logical_sources(logical_id),
  org_id uuid NOT NULL,
  mailbox text NOT NULL,
  folder text NOT NULL,
  graph_id text NOT NULL,
  identity text NOT NULL UNIQUE,
  event_id uuid NOT NULL REFERENCES public.business_events(id),
  captured_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.context_mail_logical_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.context_mail_occurrences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.context_mail_logical_sources, public.context_mail_occurrences FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.context_mail_logical_sources, public.context_mail_occurrences TO service_role;

CREATE OR REPLACE FUNCTION public.context_mail_identity(p_folder text, p_mailbox text, p_graph_id text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT 'graph-' || lower(coalesce(p_folder,'inbox')) || ':' || lower(coalesce(p_mailbox,'')) || ':' || coalesce(p_graph_id,'');
$$;

CREATE OR REPLACE FUNCTION public.message_work_target_in_org(p_org_id uuid, p_kind text, p_target_id text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_org_id IS NULL OR p_kind IS NULL OR nullif(p_target_id,'') IS NULL THEN RETURN false; END IF;
  IF p_kind='job' THEN
    RETURN EXISTS (SELECT 1 FROM public.jobs j WHERE j.org_id=p_org_id AND j.id::text=p_target_id);
  ELSIF p_kind='po' THEN
    RETURN EXISTS (SELECT 1 FROM public.purchase_orders po WHERE po.org_id=p_org_id AND po.id::text=p_target_id);
  ELSIF p_kind='invoice' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.xero_invoices x
       WHERE x.org_id=p_org_id AND (x.xero_invoice_id=p_target_id OR x.id::text=p_target_id)
    );
  END IF;
  RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.message_event_in_org(p_org_id uuid, p_event_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.business_events e
     WHERE e.id=p_event_id
       AND (
         e.payload->>'org_id' = p_org_id::text
         OR EXISTS (SELECT 1 FROM public.jobs j WHERE j.org_id=p_org_id AND j.id::text=e.job_id)
         OR EXISTS (SELECT 1 FROM public.context_mail_occurrences o WHERE o.event_id=e.id AND o.org_id=p_org_id)
       )
  );
END $$;

CREATE OR REPLACE FUNCTION public.correct_message_work_link(
  p_event_id uuid, p_org_id uuid, p_op text, p_kind text, p_target_id text, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE invalidated int:=0;
BEGIN
  IF p_op NOT IN ('link','unlink') OR p_kind NOT IN ('job','po','invoice')
     OR p_event_id IS NULL OR p_org_id IS NULL OR nullif(btrim(p_actor),'') IS NULL
  THEN RAISE EXCEPTION 'message_link_invalid'; END IF;
  IF NOT public.message_event_in_org(p_org_id, p_event_id)
  THEN RAISE EXCEPTION 'message_link_org_mismatch'; END IF;
  IF NOT public.message_work_target_in_org(p_org_id, p_kind, p_target_id)
  THEN RAISE EXCEPTION 'message_link_target_mismatch'; END IF;
  IF p_op='unlink' THEN
    UPDATE public.message_work_links SET lifecycle='retracted'
     WHERE event_id=p_event_id AND kind=p_kind AND target_id=p_target_id AND org_id=p_org_id AND lifecycle='current';
    IF NOT FOUND THEN RAISE EXCEPTION 'message_link_missing'; END IF;
    IF p_kind='job' THEN
      UPDATE public.job_context jc
         SET lifecycle='retracted', lifecycle_reason='message_link_correction', updated_at=now()
        FROM public.jobs j
       WHERE jc.job_id=j.id AND j.org_id=p_org_id AND j.id::text=p_target_id
         AND jc.lifecycle='current' AND p_event_id=ANY(jc.source_event_ids);
      GET DIAGNOSTICS invalidated = ROW_COUNT;
    END IF;
  ELSE
    INSERT INTO public.message_work_links(event_id,org_id,kind,target_id,certainty,lifecycle)
     VALUES(p_event_id,p_org_id,p_kind,p_target_id,'explicit','current')
     ON CONFLICT (event_id,kind,target_id) DO UPDATE SET lifecycle='current', certainty='explicit', org_id=EXCLUDED.org_id;
  END IF;
  INSERT INTO public.message_work_link_audit(event_id,org_id,op,kind,target_id,actor,detail)
   VALUES(p_event_id,p_org_id,p_op,p_kind,p_target_id,p_actor,jsonb_build_object('invalidated_facts',invalidated));
  RETURN jsonb_build_object('ok',true,'invalidated_facts',invalidated,'op',p_op,'actor',p_actor);
END $$;

CREATE OR REPLACE FUNCTION public.read_message_work_links(p_org_id uuid, p_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE ev jsonb; links jsonb; occ jsonb;
BEGIN
  IF p_org_id IS NULL OR p_event_id IS NULL THEN RAISE EXCEPTION 'message_link_invalid'; END IF;
  IF NOT public.message_event_in_org(p_org_id, p_event_id)
  THEN RAISE EXCEPTION 'message_link_org_mismatch'; END IF;
  SELECT to_jsonb(e) INTO ev FROM public.business_events e WHERE e.id=p_event_id;
  SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.kind, l.target_id),'[]'::jsonb)
    INTO links FROM public.message_work_links l
   WHERE l.event_id=p_event_id AND l.org_id=p_org_id AND l.lifecycle='current';
  SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.captured_at),'[]'::jsonb)
    INTO occ FROM public.context_mail_occurrences o
   WHERE o.event_id=p_event_id AND o.org_id=p_org_id;
  RETURN jsonb_build_object('event',ev,'links',links,'occurrences',occ,'org_id',p_org_id);
END $$;

CREATE OR REPLACE FUNCTION public.record_context_mail_occurrence(
  p_org_id uuid, p_mail jsonb, p_links jsonb, p_actor text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  mailbox text; folder text; graph_id text; imid text;
  occ_identity text; logical_key text; existing_occ public.context_mail_occurrences;
  logical public.context_mail_logical_sources; ev_id uuid; created boolean:=false;
  link jsonb; kind text; target text; job_ref text;
BEGIN
  IF p_org_id IS NULL OR jsonb_typeof(p_mail) IS DISTINCT FROM 'object' OR nullif(btrim(p_actor),'') IS NULL
  THEN RAISE EXCEPTION 'context_mail_invalid'; END IF;
  IF p_links IS NOT NULL AND jsonb_typeof(p_links) IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'context_mail_invalid'; END IF;
  mailbox := nullif(p_mail->>'mailbox',''); folder := coalesce(nullif(p_mail->>'folder',''),'inbox');
  graph_id := nullif(p_mail->>'graph_id',''); imid := nullif(p_mail->>'internet_message_id','');
  IF mailbox IS NULL OR graph_id IS NULL THEN RAISE EXCEPTION 'context_mail_invalid'; END IF;
  occ_identity := public.context_mail_identity(folder, mailbox, graph_id);
  logical_key := CASE WHEN imid IS NOT NULL THEN 'imid:'||imid ELSE occ_identity END;
  SELECT * INTO existing_occ FROM public.context_mail_occurrences o WHERE o.identity=occ_identity;
  IF FOUND THEN
    IF existing_occ.org_id IS DISTINCT FROM p_org_id THEN RAISE EXCEPTION 'context_mail_org_mismatch'; END IF;
    ev_id := existing_occ.event_id;
  ELSE
    SELECT * INTO logical FROM public.context_mail_logical_sources s WHERE s.logical_id=logical_key;
    IF FOUND THEN
      IF logical.org_id IS DISTINCT FROM p_org_id THEN RAISE EXCEPTION 'context_mail_org_mismatch'; END IF;
      ev_id := logical.event_id;
    ELSE
      job_ref := NULL;
      IF p_links IS NOT NULL THEN
        FOR link IN SELECT value FROM jsonb_array_elements(p_links) LOOP
          IF link->>'kind'='job' THEN job_ref := link->>'id'; EXIT; END IF;
        END LOOP;
      END IF;
      INSERT INTO public.business_events(
        event_type, source, entity_type, entity_id, job_id, payload, metadata,
        match_status, match_method, event_at, occurred_at, provider_message_id, thread_key
      ) VALUES (
        'client.email_in', 'context_mail_occurrence', 'email', occ_identity, job_ref,
        jsonb_build_object(
          'org_id', p_org_id, 'subject', p_mail->>'subject', 'body', p_mail->>'body',
          'from', p_mail->>'from', 'mailbox', mailbox, 'folder', folder,
          'internet_message_id', imid, 'graph_id', graph_id
        ),
        jsonb_build_object('capture_version','mail_v2','actor',p_actor),
        CASE WHEN job_ref IS NULL THEN 'unresolved' ELSE 'matched' END,
        CASE WHEN job_ref IS NULL THEN 'none' ELSE 'direct_job_id' END,
        coalesce((p_mail->>'occurred_at')::timestamptz, now()),
        coalesce((p_mail->>'occurred_at')::timestamptz, now()),
        occ_identity,
        p_mail->>'thread_key'
      ) RETURNING id INTO ev_id;
      INSERT INTO public.context_mail_logical_sources(logical_id,event_id,org_id,internet_message_id)
       VALUES (logical_key, ev_id, p_org_id, imid);
      created := true;
    END IF;
    INSERT INTO public.context_mail_occurrences(logical_id,org_id,mailbox,folder,graph_id,identity,event_id)
     VALUES (logical_key, p_org_id, mailbox, folder, graph_id, occ_identity, ev_id);
  END IF;
  IF p_links IS NOT NULL THEN
    FOR link IN SELECT value FROM jsonb_array_elements(p_links) LOOP
      kind := link->>'kind'; target := link->>'id';
      IF kind IS NULL OR target IS NULL THEN RAISE EXCEPTION 'context_mail_invalid'; END IF;
      PERFORM public.correct_message_work_link(ev_id, p_org_id, 'link', kind, target, p_actor);
    END LOOP;
  END IF;
  RETURN jsonb_build_object('ok',true,'event_id',ev_id,'identity',occ_identity,'logical_id',logical_key,
    'created',created,'org_id',p_org_id);
END $$;

-- Keep Dispatch producer identity and keep explicit mail-occurrence identity.
CREATE OR REPLACE FUNCTION public.attribute_business_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.event_type='dispatch.plan.changed'
     AND coalesce(NEW.payload->>'contract_version','')='dispatch-context/v1'
     AND coalesce(NEW.match_method,'') IN ('direct_job_id','direct_reference','manual')
     AND NEW.job_id IS NOT NULL THEN
    IF NEW.event_at IS NULL THEN
      RAISE EXCEPTION 'dispatch_event_at_required';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id::text=NEW.job_id::text
        AND j.org_id::text=coalesce(NEW.payload->>'org_id','')
    ) THEN
      NEW.job_id:=NULL;
      NEW.match_status:='unresolved';
      NEW.match_method:='none';
      NEW.match_confidence:=NULL;
      NEW.attribution_status:='admin_bucket';
      NEW.attribution_step:=6;
      NEW.attribution_checked_at:=clock_timestamp();
      NEW.payload:=coalesce(NEW.payload,'{}'::jsonb)||jsonb_build_object('attribution_error','dispatch_job_org_mismatch');
      RETURN NEW;
    END IF;
    NEW.attribution_status:='direct';
    NEW.attribution_step:=1;
    NEW.attribution_confidence:=1;
    NEW.attributed_at:=clock_timestamp();
    NEW.attribution_checked_at:=clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.source='context_mail_occurrence'
     AND coalesce(NEW.match_method,'') IN ('direct_job_id','direct_reference','manual')
     AND NEW.job_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id::text=NEW.job_id::text
        AND j.org_id::text=coalesce(NEW.payload->>'org_id','')
    ) THEN
      NEW.job_id:=NULL;
      NEW.match_status:='unresolved';
      NEW.match_method:='none';
      NEW.attribution_status:='admin_bucket';
      NEW.attribution_step:=6;
      NEW.payload:=coalesce(NEW.payload,'{}'::jsonb)||jsonb_build_object('attribution_error','mail_job_org_mismatch');
      RETURN NEW;
    END IF;
    NEW.attribution_status:='direct';
    NEW.attribution_step:=1;
    NEW.attribution_confidence:=1;
    NEW.attributed_at:=clock_timestamp();
    NEW.attribution_checked_at:=clock_timestamp();
    RETURN NEW;
  END IF;
  NEW:=public.resolve_context_attribution(NEW);
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.context_mail_identity(text,text,text),
 public.message_work_target_in_org(uuid,text,text),
 public.message_event_in_org(uuid,uuid),
 public.correct_message_work_link(uuid,uuid,text,text,text,text),
 public.read_message_work_links(uuid,uuid),
 public.record_context_mail_occurrence(uuid,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_mail_identity(text,text,text),
 public.message_work_target_in_org(uuid,text,text),
 public.message_event_in_org(uuid,uuid),
 public.correct_message_work_link(uuid,uuid,text,text,text,text),
 public.read_message_work_links(uuid,uuid),
 public.record_context_mail_occurrence(uuid,jsonb,jsonb,text) TO service_role;
