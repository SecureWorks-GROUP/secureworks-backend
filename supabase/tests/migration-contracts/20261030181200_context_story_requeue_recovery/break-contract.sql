SELECT md5(prosrc)='143a88acac3b0fd0e894f127eebed188' AS has_ledger_edit_refresh FROM pg_proc WHERE oid='public.context_job_story_enqueue_changed(integer)'::regprocedure \gset
\if :has_ledger_edit_refresh
\ir ../../../rollbacks/20261030184000_context_ledger_edit_story_refresh_down.sql
\endif
\ir ../../../rollbacks/20261030181200_context_story_requeue_recovery_down.sql
