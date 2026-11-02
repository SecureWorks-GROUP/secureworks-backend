-- Restore old callers/health, retain queued receipts for recovery. No queue deletion.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE x record; actual text;
BEGIN
 FOR x IN SELECT * FROM (VALUES
  ('public.trigger_context_email_poll()',ARRAY['1430e54e4443b839865d3b4874793e15','bf67f0c4e5604233590712b9662dceb8']),
  ('public.trigger_context_email_sweep()',ARRAY['9e375b43beb7dc236b44dd5bd0b131d7','02e0c1fe63c60212865c955dc3997bb9']),
  ('public.context_email_capture_status_at(timestamptz)',ARRAY['ee6f8e5d57e41fe8c2691b59d4b51856','18d69176f3a277af49ebb2cd6e4ae12e'])
 ) t(sig,accepted) LOOP
  SELECT md5(prosrc) INTO actual FROM pg_proc WHERE oid=to_regprocedure(x.sig);
  IF actual IS NULL OR NOT actual=ANY(x.accepted) THEN RAISE EXCEPTION 'email_sweep_preimage_mismatch: % %',x.sig,actual; END IF;
 END LOOP;
END $guard$;
UPDATE public.feature_flags SET enabled=false WHERE flag_name='email_sweep_continuation_v1';
CREATE OR REPLACE FUNCTION public.trigger_context_email_poll() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f jsonb:=public.context_email_reader_flags();
BEGIN
 IF NOT ((f->>'reader')::boolean AND (f->>'schedule')::boolean AND (f->>'program')::boolean) THEN RETURN; END IF;
 PERFORM net.http_post(
  url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/outlook-mail-capture',
  body := jsonb_build_object('mode','poll','actor','cron:outlook-mail-poll'),
  headers := jsonb_build_object('Authorization','Bearer '||public.sw_service_key(),'Content-Type','application/json'),
  timeout_milliseconds := 5000
 );
 BEGIN
  PERFORM public.trigger_context_email_history();
 EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'email_history_tick_failed: %',SQLSTATE;
 END;
END $$;

CREATE OR REPLACE FUNCTION public.trigger_context_email_sweep() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f jsonb:=public.context_email_reader_flags(); k text;
BEGIN
 IF NOT ((f->>'reader')::boolean AND (f->>'schedule')::boolean AND (f->>'program')::boolean) THEN RETURN; END IF;
 FOR k IN SELECT m.source_key FROM public.monitored_mailboxes m
  WHERE m.enabled AND m.status='active' AND m.kind IN ('user','group') ORDER BY m.source_key LOOP
  PERFORM net.http_post(
   url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/outlook-mail-capture',
   body := jsonb_build_object('mode','sweep','source',k,'actor','cron:monitor-inbox-sweep'),
   headers := jsonb_build_object('Authorization','Bearer '||public.sw_service_key(),'Content-Type','application/json'),
   timeout_milliseconds := 5000
  );
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.context_email_capture_status_at(p_now timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
 policy jsonb:=public.context_email_capture_policy();
 now_time timestamptz:=coalesce(p_now,now());
 tz text:=policy->>'timezone';
 failed_n integer:=(policy->>'failed_runs_alarm')::integer;
 backlog_n integer:=(policy->>'backlog_runs_alarm')::integer;
 sweep_grace interval:=make_interval(mins=>(policy->>'sweep_grace_minutes')::integer);
 miss_lookback interval:=make_interval(hours=>(policy->>'sweep_miss_lookback_hours')::integer);
 personal text[]:=ARRAY(SELECT jsonb_array_elements_text(policy->'personal_scope_labels'));
 flag_on boolean; flag_changed timestamptz; flag_state text:='present';
 lane_on boolean; alarms_active boolean;
 sweep_at timestamptz; sweep_due boolean;
 m record; line text; src_alarms jsonb;
 poll_src text; sweep_src text;
 last_runs public.context_capture_runs[]; last_sweep public.context_capture_runs; miss_run public.context_capture_runs;
 swept boolean; since timestamptz; selected boolean; last_seen timestamptz;
 n_failed integer; n_backlog integer; misses bigint;
 first_from timestamptz; kept bigint; listed bigint; oldest timestamptz;
 per_source jsonb:='[]'::jsonb; lines jsonb; alarms jsonb;
BEGIN
 -- Flag: fails closed (no table, no row or an error reads as off).
 BEGIN
  SELECT f.enabled,f.updated_at INTO flag_on,flag_changed FROM public.feature_flags f
  WHERE f.flag_name=policy->>'flag' ORDER BY f.updated_at DESC NULLS LAST LIMIT 1;
  IF flag_on IS NULL THEN flag_state:='missing'; END IF;
 EXCEPTION WHEN OTHERS THEN flag_on:=NULL; flag_changed:=NULL; flag_state:='unreadable';
 END;
 BEGIN lane_on:=public.automation_lane_enabled('capture');
 EXCEPTION WHEN OTHERS THEN lane_on:=NULL;
 END;
 alarms_active:=coalesce(flag_on,false) AND coalesce(lane_on,false);
 -- The most recent 02:00 Perth at or before now.
 sweep_at:=((date_trunc('day',now_time AT TIME ZONE tz)+(policy->>'sweep_local_time')::time) AT TIME ZONE tz);
 IF sweep_at>now_time THEN sweep_at:=((date_trunc('day',now_time AT TIME ZONE tz)-interval '1 day'+(policy->>'sweep_local_time')::time) AT TIME ZONE tz); END IF;
 sweep_due:=now_time>=sweep_at+sweep_grace;

 -- 1. Each source's health, kept inside this function: only the per-line
 -- aggregate below leaves it.
 FOR m IN SELECT * FROM public.monitored_mailboxes LOOP
  line:=CASE WHEN m.scope_label=ANY(personal) THEN 'personal' ELSE m.scope_label END;
  selected:=m.enabled AND m.status='active';
  poll_src:='outlook_'||m.source_key; sweep_src:='outlook_sweep_'||m.source_key;
  SELECT coalesce(array_agg(c ORDER BY c.started_at DESC),'{}') INTO last_runs FROM (
   SELECT * FROM public.context_capture_runs r WHERE r.source=poll_src AND r.status<>'running' ORDER BY r.started_at DESC LIMIT greatest(failed_n,backlog_n)) c;
  SELECT count(*) FILTER (WHERE u.status='failed') INTO n_failed FROM unnest(last_runs[1:failed_n]) u;
  SELECT count(*) FILTER (WHERE (u.cursor->>'backlog')='true') INTO n_backlog FROM unnest(last_runs[1:backlog_n]) u;
  SELECT max(r.finished_at) INTO last_seen FROM public.context_capture_runs r WHERE r.source=poll_src AND r.status='succeeded';
  SELECT * INTO last_sweep FROM public.context_capture_runs r WHERE r.source=sweep_src ORDER BY r.started_at DESC LIMIT 1;
  swept:=EXISTS(SELECT 1 FROM public.context_capture_runs r WHERE r.source=sweep_src AND r.started_at>=sweep_at AND r.status='succeeded');
  -- The latest finished sweep inside the lookback: did it find mail the poll missed?
  SELECT * INTO miss_run FROM public.context_capture_runs r WHERE r.source=sweep_src AND r.status<>'running' AND r.finished_at>=now_time-miss_lookback
  ORDER BY r.started_at DESC LIMIT 1;
  misses:=CASE WHEN jsonb_typeof(miss_run.counts->'sweep_misses')='number' THEN (miss_run.counts->>'sweep_misses')::bigint ELSE 0 END;
  -- Lanes health (20261006050000): mail received before the source's first
  -- successful poll (that poll's window_from) was never the poll's to read;
  -- the first nightly sweep re-reads 48 hours, which can begin before the
  -- reader existed. The sweep lists when each email it saved was received
  -- (cursor.miss_received_at: the newest 100, a null for a time it could not
  -- read). A listed time at or after the first poll, and a null, count. The
  -- misses past the list are older than its oldest time: none counts when
  -- that time is before the first poll, all do otherwise. An unreadable list
  -- leaves every miss counted.
  IF misses>0 THEN
   SELECT r.window_from INTO first_from FROM public.context_capture_runs r
   WHERE r.source=poll_src AND r.status='succeeded' ORDER BY r.finished_at, r.id LIMIT 1;
   IF NOT FOUND THEN
    -- No successful poll yet: nothing the poll could have missed.
    misses:=0;
   ELSIF first_from IS NULL THEN
    -- The first poll recorded no window: nothing to compare, every miss counts.
    NULL;
   ELSIF jsonb_typeof(miss_run.cursor->'miss_received_at')='array' THEN
    BEGIN
     SELECT count(*) FILTER (WHERE t.v IS NULL OR t.v::timestamptz>=first_from), count(*), min(t.v::timestamptz)
     INTO kept, listed, oldest
     FROM jsonb_array_elements_text(miss_run.cursor->'miss_received_at') AS t(v);
     misses:=kept+CASE WHEN oldest<first_from THEN 0 ELSE greatest(misses-listed,0) END;
    EXCEPTION WHEN OTHERS THEN
     NULL;
    END;
   ELSIF miss_run.window_from<first_from THEN
    -- A sweep that kept no list and read back before the first poll: its
    -- misses cannot be told apart from older mail.
    misses:=0;
   END IF;
  END IF;
  -- A sweep is not expected on the night the flag or the source was switched on.
  since:=greatest(flag_changed,m.updated_at);
  src_alarms:='[]'::jsonb;
  IF alarms_active AND selected THEN
   IF cardinality(last_runs)>=failed_n AND n_failed=failed_n THEN
    src_alarms:=src_alarms||jsonb_build_array(jsonb_build_object('key','email_source_error','since',(last_runs[failed_n]).started_at,'error_code',(last_runs[1]).error_code));
   END IF;
   IF cardinality(last_runs)>=backlog_n AND n_backlog=backlog_n THEN
    src_alarms:=src_alarms||jsonb_build_array(jsonb_build_object('key','email_backlog','since',(last_runs[backlog_n]).started_at));
   END IF;
   IF misses>0 THEN
    src_alarms:=src_alarms||jsonb_build_array(jsonb_build_object('key','email_poll_missed','since',miss_run.started_at,'sweep_misses',misses));
   END IF;
   IF sweep_due AND NOT swept AND (since IS NULL OR since<sweep_at) THEN
    src_alarms:=src_alarms||jsonb_build_array(jsonb_build_object('key','sweep_incomplete','since',sweep_at,'last_status',last_sweep.status));
   END IF;
  END IF;
  per_source:=per_source||jsonb_build_array(jsonb_build_object('line',line,'selected',selected,
   'pending_review',m.status='pending_review','last_seen',last_seen,'alarms',src_alarms));
 END LOOP;

 -- 2. One line per shared label, one combined 'personal' line: counts,
 -- health and the oldest last-seen only. Byte-ordered; a line is unique.
 SELECT coalesce(jsonb_agg(l ORDER BY (l->>'line')='personal',l->>'line' COLLATE "C"),'[]'::jsonb) INTO lines FROM (
  SELECT jsonb_build_object('line',s->>'line','personal',(s->>'line')='personal',
   'sources',count(*),
   'selected',count(*) FILTER (WHERE (s->>'selected')::boolean),
   'pending_review',count(*) FILTER (WHERE (s->>'pending_review')::boolean),
   'healthy',count(*) FILTER (WHERE (s->>'selected')::boolean AND jsonb_array_length(s->'alarms')=0),
   'erroring',count(*) FILTER (WHERE (s->>'selected')::boolean AND jsonb_array_length(s->'alarms')>0),
   'never_seen',count(*) FILTER (WHERE (s->>'selected')::boolean AND s->'last_seen'='null'::jsonb),
   'oldest_last_seen_at',min((s->>'last_seen')::timestamptz) FILTER (WHERE (s->>'selected')::boolean)) AS l
  FROM jsonb_array_elements(per_source) s GROUP BY s->>'line') x;

 -- 3. Alarms, one per line and key: how many of the line's sources raise it,
 -- never which one. Byte-ordered; a line and key pair is unique.
 SELECT coalesce(jsonb_agg(a ORDER BY a->>'line' COLLATE "C",a->>'key' COLLATE "C"),'[]'::jsonb) INTO alarms FROM (
  SELECT jsonb_build_object('key',al->>'key','severity','warning','line',s->>'line','sources',count(*),
   'since',min((al->>'since')::timestamptz))
   ||CASE al->>'key'
      WHEN 'email_source_error' THEN jsonb_build_object('error_codes',(SELECT jsonb_agg(DISTINCT c COLLATE "C" ORDER BY c COLLATE "C") FROM unnest(array_agg(al->>'error_code')) c WHERE c IS NOT NULL),
       'what_to_do','Mailboxes on this line failed their last two polls. Check the Microsoft Graph credentials and the app''s permission on them.')
      WHEN 'email_backlog' THEN jsonb_build_object('what_to_do','Mailboxes on this line have had more mail than one poll reads for three polls running. They will catch up; if not, raise the page bound.')
      WHEN 'email_poll_missed' THEN jsonb_build_object('sweep_misses',sum((al->>'sweep_misses')::bigint),
       'what_to_do','The nightly sweep found mail the 5-minute poll missed (now captured). Check the poll run rows for this line.')
      ELSE jsonb_build_object('what_to_do','Mailboxes on this line did not finish their 02:00 sweep. Check the monitor-inbox-sweep cron job and the sweep run rows.')
     END AS a
  FROM jsonb_array_elements(per_source) s, jsonb_array_elements(s->'alarms') al
  GROUP BY s->>'line',al->>'key') x;

 RETURN jsonb_build_object('as_of',now_time,
  'flag',jsonb_build_object('name',policy->>'flag','enabled',coalesce(flag_on,false),'updated_at',flag_changed,'state',flag_state),
  'capture_lane',lane_on,'alarms_active',alarms_active,'last_sweep_due_at',sweep_at,
  'counts',jsonb_build_object('sources',jsonb_array_length(per_source),
    'selected',(SELECT count(*) FROM jsonb_array_elements(per_source) s WHERE (s->>'selected')::boolean),
    'pending_review',(SELECT count(*) FROM jsonb_array_elements(per_source) s WHERE (s->>'pending_review')::boolean)),
  'policy',policy,'lines',lines,'alarms',alarms);
END $$;
