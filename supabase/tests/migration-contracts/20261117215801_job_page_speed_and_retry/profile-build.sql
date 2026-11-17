-- Run in a fresh session per sample against the seeded LOCAL copy only.
\set ON_ERROR_STOP on
SELECT coalesce(inet_server_addr() <<= '127.0.0.0/8'::inet,false)
 AND :'disposable_ack'='I-confirm-this-is-disposable-local-postgres' AS local_disposable \gset
\if :local_disposable
\else
 \echo 'Refused: disposable localhost PostgreSQL acknowledgement required'
 \quit 2
\endif
SET TimeZone='UTC';
SET statement_timeout='90s';
SET track_functions='all';
LOAD 'auto_explain';
SET auto_explain.log_min_duration='50ms';
SET auto_explain.log_analyze=on;
SET auto_explain.log_timing=off;
SET auto_explain.log_buffers=on;
SET auto_explain.log_nested_statements=on;
EXPLAIN (ANALYZE,BUFFERS,SETTINGS) SELECT public.job_page_refresh(md5('ZZTEST-page-1')::uuid);
SELECT status,error,build_ms FROM public.job_pages WHERE job_id=md5('ZZTEST-page-1')::uuid;
