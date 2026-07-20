-- ════════════════════════════════════════════════════════════
-- Retire the removed messaging integration (forward-only).
--
-- Historical migrations stay exactly as they were applied. Everything
-- the retired integration left behind is dropped here instead.
-- ════════════════════════════════════════════════════════════

-- 1. Stop schedules whose handlers were removed with the retired messaging integration.
SELECT cron.unschedule(jobname)
FROM cron.job
WHERE jobname IN (
  'intraday-nudge-check',
  'eod-followup-5pm',
  'eod-escalation-7pm',
  'shaun-morning-brief'
);

-- 2. Columns the retired integration read or wrote on users and inbox_events
--    are left in place as inert historical data. No code reads them any more,
--    and dropping them would destroy the staff mapping irreversibly.

-- 3. Drop the action permissions seeded for the removed send action.
DELETE FROM action_permissions WHERE action_type = 'send_telegram';

-- 4. Re-home conversation channel defaults now the transport is gone.
ALTER TABLE conversation_sessions ALTER COLUMN channel SET DEFAULT 'dashboard';
ALTER TABLE conversation_history ALTER COLUMN channel SET DEFAULT 'dashboard';
