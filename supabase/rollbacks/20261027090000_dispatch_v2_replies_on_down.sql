-- Rollback of 20261027090000_dispatch_v2_replies_on: supplier reply tracking off.
UPDATE public.feature_flags
SET enabled = false,
    description = 'Dispatch v2 slice 8: every five minutes, match captured supplier emails to Dispatch orders and suggest delivery dates (Accept / Dismiss on the job). Reads mail only; sends nothing and never moves a job stage. Off until the captain says make it live.',
    updated_at = now()
WHERE flag_name = 'dispatch_v2_replies_v1';
