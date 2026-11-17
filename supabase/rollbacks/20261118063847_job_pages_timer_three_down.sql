-- FU33 part 2. Keep the installer's command and the installed timer in sync.
-- Change the command in place to retain timer identity, active state and history.
SET LOCAL lock_timeout = '5s';
DO $timer$
DECLARE
 old_command constant text := $cmd$SET LOCAL statement_timeout = '100s'; SELECT public.job_pages_refresh_due(3);$cmd$;
 new_command constant text := $cmd$SET LOCAL statement_timeout = '45s'; SELECT public.job_pages_refresh_due(1);$cmd$;
 installer constant regprocedure := 'public.job_pages_install()'::regprocedure;
 installer_hash text;
 timer_id bigint;
 timer_command text;
/* migration block */ BEGIN
 SELECT md5(prosrc) INTO STRICT installer_hash FROM pg_proc WHERE oid=installer;
 IF installer_hash = 'ec9b76ae475a69db35b1b56cf0d68c4e' THEN
  EXECUTE replace(pg_get_functiondef(installer), old_command, new_command);
 END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=installer) IS DISTINCT FROM 'b393cfc26b34ebb650bd606ac8ca093e' THEN
  RAISE EXCEPTION 'FU33 unexpected job_pages_install definition';
 END IF;

 IF to_regclass('cron.job') IS NULL THEN RETURN; END IF;
 -- A removed installation stays removed. Refuse an ambiguous or hand-edited timer.
 /* lookup */ BEGIN
  SELECT jobid, command INTO STRICT timer_id, timer_command
    FROM cron.job WHERE jobname='job-pages-refresh' AND database=current_database();
 EXCEPTION WHEN no_data_found THEN RETURN;
 END;
 IF timer_command = new_command THEN RETURN; END IF;
 IF timer_command IS DISTINCT FROM old_command THEN
  RAISE EXCEPTION 'FU33 unexpected refresh timer command on job %',timer_id;
 END IF;
 PERFORM cron.alter_job(job_id := timer_id, command := new_command);
END $timer$;
