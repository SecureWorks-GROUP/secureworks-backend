-- P1-13.5. Dormant functions only; no trigger, schedule or switch activation.
-- Active trade is P1-02.2's definition: an open rate or a live invoice in eight weeks.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
CREATE INDEX IF NOT EXISTS group_claim_people_search_idx
  ON public.users(org_id, name COLLATE "C", id);
-- Reuse idx_trade_inv_user and idx_job_events_job; no big-table index builds.

CREATE OR REPLACE FUNCTION public.group_claim_active_trade(p_org uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.users u WHERE u.id=p_user AND u.org_id=p_org
    AND (
      EXISTS (SELECT 1 FROM public.trade_rates r WHERE r.user_id=u.id AND r.effective_to IS NULL)
      OR EXISTS (SELECT 1 FROM public.trade_invoices i WHERE i.user_id=u.id
        AND i.created_at >= now()-interval '8 weeks' AND i.status NOT IN ('draft','ops-reject'))));
$fn$;

CREATE OR REPLACE FUNCTION public.group_claim_on_job(p_job uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
  -- job_assignments_job_user_date_key. A clock only counts while its booking
  -- is live, so a historical clock adds no authority beyond the live booking.
  SELECT EXISTS (SELECT 1 FROM public.job_assignments a WHERE a.job_id=p_job AND a.user_id=p_user
    AND NOT coalesce(a.is_ghost,false) AND lower(coalesce(a.role,'')) <> 'observer'
    AND lower(coalesce(a.status,'')) <> 'cancelled');
$fn$;

CREATE OR REPLACE FUNCTION public.group_claim_update_crew(
  p_group_id uuid, p_actor uuid, p_action text, p_users uuid[] DEFAULT '{}'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$ DECLARE
  g public.group_work_orders%ROWTYPE;
  actor public.users%ROWTYPE;
  target uuid;
  added uuid[] := '{}';
  candidates uuid[];
  affected integer;
  office boolean;
  member boolean;
  was_waiting boolean; BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name='group_claim_flow_v1' AND enabled)
    OR NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name='group_work_order_v1' AND enabled) THEN
    RAISE EXCEPTION 'group_claim_disabled' USING ERRCODE='23514';
  END IF;
  SELECT * INTO g FROM public.group_work_orders WHERE id=p_group_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE='23514'; END IF;
  PERFORM public.group_work_order_lock_job(g.job_id);
  SELECT * INTO g FROM public.group_work_orders WHERE id=p_group_id FOR UPDATE;
  SELECT * INTO actor FROM public.users WHERE id=p_actor;
  IF NOT FOUND OR actor.org_id IS DISTINCT FROM g.org_id THEN
    RAISE EXCEPTION 'group_actor_required' USING ERRCODE='23514';
  END IF;
  office := coalesce(actor.role IN ('admin','owner','ops_manager'),false);
  SELECT EXISTS (SELECT 1 FROM public.group_work_order_participants WHERE group_id=g.id AND user_id=p_actor) INTO member;
  IF g.status='void' THEN RAISE EXCEPTION 'group_work_order_void' USING ERRCODE='23514'; END IF;
  IF g.split_frozen_at IS NOT NULL THEN
    IF p_action='join' AND member THEN RETURN jsonb_build_object('ok',true,'group_id',g.id); END IF;
    RAISE EXCEPTION 'group_split_frozen' USING ERRCODE='23514';
  END IF;
  IF p_action='leave' THEN
    -- Replaying a completed self-removal is harmless; an office removal stays authoritative.
    IF NOT member AND EXISTS (SELECT 1 FROM public.group_work_order_crew_removals
      WHERE group_id=g.id AND user_id=p_actor AND removed_by=p_actor AND restored_at IS NULL) THEN
      RETURN jsonb_build_object('ok',true,'group_id',g.id);
    END IF;
    IF NOT member THEN RAISE EXCEPTION 'group_not_on_job' USING ERRCODE='23514'; END IF;
    IF EXISTS (SELECT 1 FROM public.group_work_order_time_entries WHERE group_id=g.id AND user_id=p_actor AND hours>0) THEN
      RAISE EXCEPTION 'group_has_hours' USING ERRCODE='23514';
    END IF;
    -- Same removal, standing exclusion and signature invalidation as the office action.
    PERFORM public.remove_group_work_order_participant(g.id,p_actor,p_actor);
    INSERT INTO public.group_work_order_events(group_id,job_id,action,actor_user_id,detail)
      VALUES(g.id,g.job_id,'leave_claim',p_actor,jsonb_build_object('reason','Said they did not work on this job'));
    RETURN jsonb_build_object('ok',true,'group_id',g.id);
  ELSIF p_action='name' THEN
    IF NOT member AND NOT office THEN RAISE EXCEPTION 'group_not_on_job' USING ERRCODE='23514'; END IF;
    IF cardinality(p_users) IS NULL OR cardinality(p_users)=0 THEN
      RAISE EXCEPTION 'group_person_not_a_trade' USING ERRCODE='23514';
    END IF;
    candidates := p_users;
  ELSIF p_action='join' THEN
    IF NOT office AND NOT member AND NOT public.group_claim_on_job(g.job_id,p_actor) THEN
      RAISE EXCEPTION 'group_not_on_job' USING ERRCODE='23514';
    END IF;
    candidates := ARRAY[p_actor];
  ELSIF p_action='sync' THEN
    IF NOT office AND NOT member AND NOT public.group_claim_on_job(g.job_id,p_actor) THEN
      RAISE EXCEPTION 'group_not_on_job' USING ERRCODE='23514';
    END IF;
    -- One job only, never an estate read. Bookings use the existing job/user/date key.
    SELECT array_agg(DISTINCT user_id) INTO candidates FROM (
      SELECT a.user_id FROM public.job_assignments a WHERE a.job_id=g.job_id
        AND NOT coalesce(a.is_ghost,false) AND lower(coalesce(a.role,''))<>'observer'
        AND lower(coalesce(a.status,''))<>'cancelled'
      -- idx_job_events_job bounds clocks; the same live-booking rule gates retries.
      UNION SELECT e.user_id FROM public.job_events e WHERE e.job_id=g.job_id AND e.event_type='clock.clock_on'
        AND public.group_claim_on_job(g.job_id,e.user_id)
      UNION SELECT p_actor
    ) crew;
  ELSE RAISE EXCEPTION 'group_claim_action_invalid' USING ERRCODE='23514'; END IF;
  -- Validate every explicitly named person before any insert.
  IF p_action='name' AND EXISTS (SELECT 1 FROM unnest(candidates) u
      WHERE NOT public.group_claim_active_trade(g.org_id,u)) THEN
    RAISE EXCEPTION 'group_person_not_a_trade' USING ERRCODE='23514';
  END IF;
  FOREACH target IN ARRAY coalesce(candidates,'{}'::uuid[]) LOOP
    IF EXISTS (SELECT 1 FROM public.group_work_order_participants WHERE group_id=g.id AND user_id=target) THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM public.group_work_order_crew_removals WHERE group_id=g.id AND user_id=target AND restored_at IS NULL) THEN
      IF p_action IN ('join','name') THEN RAISE EXCEPTION 'group_member_removed_by_office' USING ERRCODE='23514'; END IF;
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id=target AND u.org_id=g.org_id) THEN
      IF p_action='join' THEN RAISE EXCEPTION 'group_person_not_a_trade' USING ERRCODE='23514'; END IF;
      CONTINUE;
    END IF;
    IF EXISTS (SELECT 1 FROM public.group_work_order_hours_paid(g.job_id) hp WHERE hp.user_id=target) THEN
      IF p_action IN ('join','name') THEN RAISE EXCEPTION 'group_member_paid_by_hours' USING ERRCODE='23514'; END IF;
      CONTINUE;
    END IF;
    INSERT INTO public.group_work_order_participants(group_id,user_id,named_by,named_at)
      VALUES(g.id,target,CASE WHEN p_action='name' THEN p_actor END,CASE WHEN p_action='name' THEN clock_timestamp() END)
      ON CONFLICT(group_id,user_id) DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected>0 THEN added:=array_append(added,target); END IF;
  END LOOP;
  IF cardinality(added)>0 AND p_action='name' THEN
    was_waiting := g.claim_state='waiting_approval';
    UPDATE public.group_work_orders SET claim_state=CASE WHEN was_waiting THEN 'waiting_hours' ELSE claim_state END,
      claim_deadline_at=CASE WHEN was_waiting THEN clock_timestamp()+interval '48 hours' ELSE claim_deadline_at END
      WHERE id=g.id;
    INSERT INTO public.group_work_order_events(group_id,job_id,action,actor_user_id,detail)
      VALUES(g.id,g.job_id,'name_crew',p_actor,jsonb_build_object('user_ids',added));
  END IF;
  RETURN jsonb_build_object('ok',true,'group_id',g.id);
END; $fn$;

CREATE OR REPLACE FUNCTION public.group_claim_crew_sources(p_group_id uuid)
RETURNS TABLE(user_id uuid, how text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $fn$
  SELECT p.user_id, CASE
    WHEN EXISTS(SELECT 1 FROM public.job_assignments a WHERE a.job_id=g.job_id AND a.user_id=p.user_id
      AND a.added_by='self' AND lower(coalesce(a.role,''))<>'observer' AND NOT coalesce(a.is_ghost,false) AND lower(coalesce(a.status,''))<>'cancelled') THEN 'added_self'
    WHEN p.named_by IS NOT NULL THEN 'added'
    WHEN EXISTS(SELECT 1 FROM public.job_assignments a WHERE a.job_id=g.job_id AND a.user_id=p.user_id
      AND NOT coalesce(a.is_ghost,false) AND lower(coalesce(a.role,''))<>'observer' AND lower(coalesce(a.status,''))<>'cancelled') THEN 'allocated'
    ELSE 'clocked_on' END
  FROM public.group_work_order_participants p JOIN public.group_work_orders g ON g.id=p.group_id
  WHERE p.group_id=p_group_id;
$fn$;

CREATE OR REPLACE FUNCTION public.group_claim_search_trades(p_actor uuid,p_query text)
RETURNS TABLE(user_id uuid,name text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp
AS $fn$
  SELECT u.id,u.name FROM public.users u
    WHERE u.org_id=(SELECT a.org_id FROM public.users a WHERE a.id=p_actor)
      AND char_length(btrim(p_query))>=2
      AND EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='group_claim_flow_v1' AND enabled)
      AND strpos(lower(u.name),lower(btrim(p_query)))>0
      AND public.group_claim_active_trade(u.org_id,u.id)
    ORDER BY u.name COLLATE "C",u.id LIMIT 10;
$fn$;
REVOKE ALL ON FUNCTION public.group_claim_crew_sources(uuid), public.group_claim_active_trade(uuid,uuid), public.group_claim_on_job(uuid,uuid),
  public.group_claim_update_crew(uuid,uuid,text,uuid[]), public.group_claim_search_trades(uuid,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.group_claim_crew_sources(uuid), public.group_claim_active_trade(uuid,uuid), public.group_claim_on_job(uuid,uuid),
  public.group_claim_update_crew(uuid,uuid,text,uuid[]), public.group_claim_search_trades(uuid,text) TO service_role;
