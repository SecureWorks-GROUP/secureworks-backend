-- One job's pasted key is not the Vault key (for example Vault was rotated but
-- the job was not). Rewriting it would change which key it sends, so the
-- migration must refuse and leave every job as it was. This database is
-- discarded after the proof, so the stand-ins may persist here.
\ir fixture.sql

UPDATE cron.job
   SET command = replace(command, public.sw_service_key(), 'eyJvdGhlcg.bm90LXZhdWx0.Zml4dHVyZQ')
 WHERE jobname = 'xero-suppliers-sync';
