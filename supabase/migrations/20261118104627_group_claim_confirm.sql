-- P1-13.6. These service-only functions use the existing group and claim switches.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE FUNCTION public.group_claim_member(p_group_id uuid, p_actor uuid)
RETURNS public.group_work_orders LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $fn$ DECLARE g public.group_work_orders; BEGIN
  IF (SELECT count(*) FROM public.feature_flags WHERE enabled AND flag_name IN
      ('group_work_order_v1','group_claim_flow_v1')) <> 2 THEN
    RAISE EXCEPTION 'group_claim_disabled';
  END IF;
  SELECT * INTO g FROM public.group_work_orders WHERE id=p_group_id;
  IF NOT EXISTS (SELECT 1 FROM public.group_work_order_participants p JOIN public.users u ON u.id=p.user_id
    WHERE p.group_id=p_group_id AND p.user_id=p_actor AND u.org_id=g.org_id) THEN
    RAISE EXCEPTION 'group_claim_not_member';
  END IF;
  PERFORM public.group_work_order_lock_job(g.job_id);
  SELECT * INTO STRICT g FROM public.group_work_orders WHERE id=p_group_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.group_work_order_participants p JOIN public.users u ON u.id=p.user_id
    WHERE p.group_id=g.id AND p.user_id=p_actor AND u.org_id=g.org_id) THEN
    RAISE EXCEPTION 'group_claim_not_member';
  END IF;
  IF g.status='void' THEN RAISE EXCEPTION 'group_work_order_void'; END IF;
  RETURN g;
END; $fn$;

-- Only this person's bookings on this job, plus their ten most recent clocked days.
CREATE FUNCTION public.group_claim_clock(p_group_id uuid, p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $fn$ DECLARE g public.group_work_orders; bookings jsonb; history jsonb; BEGIN
  g := public.group_claim_member(p_group_id,p_actor);
  SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.scheduled_date,b.id),'[]') INTO bookings FROM (
    SELECT a.id,a.scheduled_date,a.clocked_on_at,a.clocked_off_at,a.hours_worked,a.break_minutes,
      CASE WHEN t.assignment_id IS NOT NULL THEN jsonb_build_object('user_id',t.user_id,'work_date',t.work_date,
        'start_time',t.start_time,'finish_time',t.finish_time,'hours',t.hours,'break_minutes',t.break_minutes) END AS logged
    FROM public.job_assignments a LEFT JOIN public.job_assignment_logged_times t
      ON t.assignment_id=a.id AND t.job_id=g.job_id AND t.user_id=p_actor
    WHERE a.job_id=g.job_id AND a.user_id=p_actor AND a.is_ghost=false
      AND lower(coalesce(a.role,''))<>'observer' AND lower(coalesce(a.status,''))<>'cancelled'
      AND a.scheduled_date <= (now() AT TIME ZONE 'Australia/Perth')::date
  ) b;
  SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.scheduled_date DESC,h.id DESC),'[]') INTO history FROM (
    SELECT a.id,a.scheduled_date,a.clocked_on_at,a.clocked_off_at,a.hours_worked,a.break_minutes
    FROM public.job_assignments a WHERE a.user_id=p_actor AND a.clocked_on_at IS NOT NULL AND a.clocked_off_at IS NOT NULL
      AND a.scheduled_date <= (now() AT TIME ZONE 'Australia/Perth')::date
    ORDER BY a.scheduled_date DESC,a.id DESC LIMIT 10
  ) h;
  RETURN jsonb_build_object('bookings',bookings,'history',history);
END; $fn$;

-- The split reader also serves older groups where sign-off is still outstanding.
CREATE FUNCTION public.group_claim_current_hash(p_group_id uuid)
RETURNS text LANGUAGE plpgsql SET search_path=public,pg_temp
AS $fn$ BEGIN
  RETURN public.group_claim_split_hash(p_group_id);
EXCEPTION WHEN check_violation THEN
  IF SQLERRM='group_client_signoff_required' THEN RETURN NULL; END IF;
  RAISE;
END; $fn$;

CREATE FUNCTION public.group_claim_read(p_group_id uuid,p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $fn$ DECLARE g public.group_work_orders; h text; own_share numeric; pot numeric;
  crew jsonb; days jsonb; own_hours numeric; answered text; BEGIN
  g := public.group_claim_member(p_group_id,p_actor);
  h := public.group_claim_current_hash(g.id);
  IF h IS NOT NULL THEN
    SELECT (s->>'pot_ex')::numeric,(s->>'share_ex')::numeric INTO STRICT pot,own_share
      FROM jsonb_array_elements(public.project_group_work_order_split(g.id)->'shares') s WHERE s->>'user_id'=p_actor::text;
  ELSE
    SELECT coalesce(g.approved_budget_ex,wo.agreed_labour_ex+public.work_order_amount_change_total(wo.id))
      - public.group_work_order_hours_paid_total(g.job_id,g.pay_basis) INTO STRICT pot
      FROM public.work_orders wo WHERE wo.id=g.work_order_id AND wo.status='approved' AND wo.sealed_content_hash IS NOT NULL;
  END IF;
  IF pot IS NULL OR pot<=0 THEN RAISE EXCEPTION 'group_pot_missing'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('work_date',e.work_date,'start_time',e.start_time,
    'finish_time',e.finish_time,'break_minutes',e.break_minutes,'hours',e.hours,
    'booking_id',e.suggested->>'booking_id','changed_from_suggestion',e.changed_from_suggestion) ORDER BY e.work_date),'[]'),
    coalesce(sum(e.hours),0) INTO days,own_hours FROM public.group_work_order_time_entries e
    WHERE e.group_id=g.id AND e.user_id=p_actor;
  SELECT jsonb_agg(to_jsonb(c) ORDER BY c.user_id) INTO crew FROM (
    SELECT p.user_id,u.name,p.how,
      EXISTS(SELECT 1 FROM public.group_work_order_time_entries e WHERE e.group_id=g.id AND e.user_id=p.user_id AND e.hours>0) AS hours_confirmed,
      coalesce((SELECT CASE WHEN bool_or(a.decision='dispute') THEN 'disagreed' WHEN bool_or(a.decision='approve') THEN 'agreed' END
        FROM public.group_work_order_approvals a WHERE a.group_id=g.id AND a.user_id=p.user_id AND a.split_hash=h),'waiting') AS answered
      FROM public.group_claim_crew_sources(g.id) p LEFT JOIN public.users u ON u.id=p.user_id
  ) c;
  SELECT m->>'answered' INTO STRICT answered FROM jsonb_array_elements(crew) m WHERE m->>'user_id'=p_actor::text;
  RETURN jsonb_build_object('state',coalesce(g.claim_state,'waiting_hours'),'split_hash',h,'pot_total',pot,
    'deadline_at',g.claim_deadline_at,'i_answered',answered<>'waiting','my_days',days,'my_hours',own_hours,
    'my_share',own_share,'crew',crew,'clock',public.group_claim_clock(g.id,p_actor));
END; $fn$;

-- The transaction locks the same job as crew edits and the split projection.
CREATE FUNCTION public.group_claim_hours(p_group_id uuid,p_actor uuid,p_mode text,p_days jsonb,p_clock jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $fn$ DECLARE g public.group_work_orders; day_row record; affected integer; edits integer:=0;
  complete boolean; next_state text; prior_hash text; BEGIN
  g:=public.group_claim_member(p_group_id,p_actor);
  IF g.claim_state='invoiced' THEN RAISE EXCEPTION 'group_claim_invoiced'; END IF;
  IF g.split_frozen_at IS NOT NULL THEN RAISE EXCEPTION 'group_split_frozen'; END IF;
  IF p_mode NOT IN ('replace','upsert','delete') OR p_mode IS NULL OR jsonb_typeof(p_days) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_days)=0 THEN RAISE EXCEPTION 'group_hours_required'; END IF;
  IF p_mode<>'delete' AND p_clock IS DISTINCT FROM public.group_claim_clock(g.id,p_actor) THEN
    RAISE EXCEPTION 'group_clock_changed';
  END IF;
  IF g.claim_state IN ('with_office','disputed') THEN prior_hash:=public.group_claim_current_hash(g.id); END IF;
  IF p_mode='delete' THEN
    DELETE FROM public.group_work_order_time_entries WHERE group_id=g.id AND user_id=p_actor AND work_date=(p_days->0->>'work_date')::date;
    GET DIAGNOSTICS edits=ROW_COUNT;
  ELSE
    IF p_mode='replace' THEN
      DELETE FROM public.group_work_order_time_entries e WHERE e.group_id=g.id AND e.user_id=p_actor
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_days) d WHERE (d->>'work_date')::date=e.work_date);
      GET DIAGNOSTICS edits=ROW_COUNT;
    END IF;
    FOR day_row IN SELECT * FROM jsonb_to_recordset(p_days) AS d(work_date date,start_time text,finish_time text,
      break_minutes int,hours numeric,suggested jsonb,changed_from_suggestion boolean) LOOP
      IF day_row.suggested->>'source' IS DISTINCT FROM 'none' AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_clock->'bookings') b WHERE b->>'id'=day_row.suggested->>'booking_id'
      ) THEN RAISE EXCEPTION 'group_clock_changed'; END IF;
      INSERT INTO public.group_work_order_time_entries AS e
        (group_id,user_id,work_date,start_time,finish_time,break_minutes,hours,suggested,changed_from_suggestion)
        VALUES(g.id,p_actor,day_row.work_date,day_row.start_time,day_row.finish_time,day_row.break_minutes,
          day_row.hours,day_row.suggested,day_row.changed_from_suggestion)
      ON CONFLICT(group_id,user_id,work_date) DO UPDATE SET start_time=excluded.start_time,finish_time=excluded.finish_time,
        break_minutes=excluded.break_minutes,hours=excluded.hours,suggested=excluded.suggested,changed_from_suggestion=excluded.changed_from_suggestion
        WHERE (e.start_time,e.finish_time,e.break_minutes,e.hours,e.suggested,e.changed_from_suggestion) IS DISTINCT FROM
        (excluded.start_time,excluded.finish_time,excluded.break_minutes,excluded.hours,excluded.suggested,excluded.changed_from_suggestion);
      GET DIAGNOSTICS affected=ROW_COUNT;
      edits:=edits+affected;
    END LOOP;
  END IF;
  IF edits=0 AND (g.claim_started_by IS NOT NULL OR p_mode='delete') THEN RETURN jsonb_build_object('ok',true); END IF;
  SELECT NOT EXISTS(SELECT 1 FROM public.group_work_order_participants p WHERE p.group_id=g.id AND NOT EXISTS(
    SELECT 1 FROM public.group_work_order_time_entries e WHERE e.group_id=g.id AND e.user_id=p.user_id AND e.hours>0)) INTO complete;
  next_state:=CASE WHEN complete THEN 'waiting_approval' ELSE 'waiting_hours' END;
  IF g.claim_state IN ('with_office','disputed') AND prior_hash IS NOT NULL
    AND prior_hash=public.group_claim_current_hash(g.id) THEN
    next_state:=g.claim_state;
  END IF;
  UPDATE public.group_work_orders SET claim_state=next_state,claim_started_by=coalesce(claim_started_by,p_actor),
    claim_deadline_at=CASE WHEN claim_started_by IS NULL OR next_state='waiting_approval' OR next_state IS DISTINCT FROM claim_state
      THEN clock_timestamp()+interval '48 hours' ELSE claim_deadline_at END WHERE id=g.id;
  INSERT INTO public.group_work_order_events(group_id,job_id,actor_user_id,action) VALUES(g.id,g.job_id,p_actor,'confirm_hours');
  RETURN jsonb_build_object('ok',true);
END; $fn$;

CREATE FUNCTION public.group_claim_decide(p_group_id uuid,p_actor uuid,p_hash text,p_decision text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $fn$ DECLARE g public.group_work_orders; h text; all_approved boolean; BEGIN
  g:=public.group_claim_member(p_group_id,p_actor);
  IF g.claim_state='invoiced' THEN RAISE EXCEPTION 'group_claim_invoiced'; END IF;
  h:=public.group_claim_current_hash(g.id);
  IF h IS NULL OR h IS DISTINCT FROM p_hash THEN RAISE EXCEPTION 'group_split_changed'; END IF;
  IF p_decision NOT IN ('approve','dispute') OR p_decision IS NULL THEN RAISE EXCEPTION 'group_decision_invalid'; END IF;
  IF p_decision='dispute' AND coalesce(length(btrim(p_reason)),0) NOT BETWEEN 3 AND 500 THEN RAISE EXCEPTION 'group_reason_invalid'; END IF;
  INSERT INTO public.group_work_order_approvals(group_id,user_id,split_hash,decision,reason)
    VALUES(g.id,p_actor,h,p_decision,CASE WHEN p_decision='dispute' THEN btrim(p_reason) END) ON CONFLICT DO NOTHING;
  IF FOUND THEN
    IF p_decision='dispute' THEN UPDATE public.group_work_orders SET claim_state='disputed' WHERE id=g.id; END IF;
    INSERT INTO public.group_work_order_events(group_id,job_id,actor_user_id,action,detail)
      VALUES(g.id,g.job_id,p_actor,p_decision||'_split',jsonb_build_object('split_hash',h));
  END IF;
  SELECT NOT EXISTS (SELECT 1 FROM public.group_work_order_participants p WHERE p.group_id=g.id AND
    (NOT EXISTS(SELECT 1 FROM public.group_work_order_approvals a WHERE a.group_id=g.id AND a.user_id=p.user_id AND a.split_hash=h AND a.decision='approve')
      OR EXISTS(SELECT 1 FROM public.group_work_order_approvals a WHERE a.group_id=g.id AND a.user_id=p.user_id AND a.split_hash=h AND a.decision='dispute')))
    INTO all_approved;
  RETURN jsonb_build_object('all_approved',all_approved);
END; $fn$;

REVOKE ALL ON FUNCTION public.group_claim_member(uuid,uuid), public.group_claim_current_hash(uuid),
  public.group_claim_clock(uuid,uuid), public.group_claim_read(uuid,uuid), public.group_claim_hours(uuid,uuid,text,jsonb,jsonb),
  public.group_claim_decide(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.group_claim_clock(uuid,uuid),public.group_claim_read(uuid,uuid),
  public.group_claim_hours(uuid,uuid,text,jsonb,jsonb),public.group_claim_decide(uuid,uuid,text,text,text) TO service_role;
