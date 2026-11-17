-- Roll back the work order gate migration first.
DROP FUNCTION IF EXISTS public.trigger_xero_sync_action_gated(text, text, text, interval);
DROP FUNCTION IF EXISTS public.bill_prematch_change_token(uuid);
DROP FUNCTION IF EXISTS public.materials_ingest_change_token(uuid);
DROP FUNCTION IF EXISTS public.materials_ingest_change_parts(uuid);
DROP FUNCTION IF EXISTS public.sweep_gate_confirm(text, text);
DROP FUNCTION IF EXISTS public.sweep_gate_should_post(text, text, interval);
DROP FUNCTION IF EXISTS public.sweep_gate_tables_token(text[]);
DROP TABLE IF EXISTS public.sweep_gate_state;
DELETE FROM public.feature_flags WHERE flag_name = 'sweep_gate_v1';
