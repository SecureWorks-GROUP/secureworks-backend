-- Automatic repair intake: the one switch, seeded OFF.
--
-- Owner's word, 13 Oct 2026: a repair work order MLB or Ambrose emails in
-- becomes a job in the insurance repair pipeline without a person approving
-- it. The rules live in supabase/functions/ops-api/repair_intake_auto.ts.
-- This migration adds only their switch.
--
-- While `repair_intake_auto_v1` is off, missing or unreadable, intake behaves
-- exactly as before: every repair draft waits for a person (the 2026-08-28
-- supervised ruling), a work order for a claim that already has a repair job
-- opens its own draft, and a collection order with no original job is an
-- exception. Turning it off again returns to that. Turn it on only on the
-- owner's word.
--
-- Nothing else is written: no draft, case or job is created, approved or
-- changed here. A draft that was already waiting when the flag is switched on
-- still waits for a person (it carries no automatic-intake stamp).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT
  'repair_intake_auto_v1',
  false,
  'Automatic repair intake: when on, the make-safe intake scan (1) approves a clean, builder-declared repair work order from MLB or Ambrose into one repair job, (2) records a work order on the open repair job its claim already has instead of opening a second job or draft, and (3) opens a review draft for a collection or reattendance order that has no original job but carries a first-issue purchase order. Off, missing or unreadable: every repair draft waits for a person, as before. Turn on only on the owner''s word.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags
  WHERE flag_name = 'repair_intake_auto_v1'
);
