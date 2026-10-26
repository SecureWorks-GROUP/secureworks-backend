-- Dispatch v2 slice 8: switch supplier reply tracking on (Shaun, 27 Oct 2026:
-- "dispatch turn on").
--
-- dispatch_v2_replies_v1 was seeded off by 20261023230100. With it on, the
-- pg_cron job dispatch-v2-replies-scan (every 5 minutes) matches captured
-- supplier emails to Dispatch order emails and suggests delivery dates on the
-- job, with Accept / Dismiss. It reads mail only: it sends nothing and never
-- moves a job stage. Its first run starts from the newest captured mail
-- (cursor = head), so older mail is never read on switch-on.
--
-- Off switch, at once: update public.feature_flags set enabled=false where
-- flag_name='dispatch_v2_replies_v1';
-- Rollback: supabase/rollbacks/20261027090000_dispatch_v2_replies_on_down.sql.

UPDATE public.feature_flags
SET enabled = true,
    description = 'Dispatch v2 slice 8: every five minutes, match captured supplier emails to Dispatch orders and suggest delivery dates (Accept / Dismiss on the job). Reads mail only; sends nothing and never moves a job stage. Switched on 27 Oct 2026 on Shaun''s word (20261027090000).',
    updated_at = now()
WHERE flag_name = 'dispatch_v2_replies_v1';
