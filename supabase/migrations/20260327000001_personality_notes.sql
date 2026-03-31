-- ════════════════════════════════════════════════════════════
-- Add personality_note to payment_chase_logs method constraint
--
-- Allows storing relationship intel notes against contacts,
-- separate from chase activity logs.
-- ════════════════════════════════════════════════════════════

-- Drop and recreate the CHECK constraint to include personality_note
ALTER TABLE payment_chase_logs DROP CONSTRAINT IF EXISTS payment_chase_logs_method_check;
ALTER TABLE payment_chase_logs ADD CONSTRAINT payment_chase_logs_method_check
  CHECK (method IN ('call','sms','auto_sms','email','note','status_change','personality_note'));
