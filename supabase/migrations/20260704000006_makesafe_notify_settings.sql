-- ════════════════════════════════════════════════════════════
-- MAKE-SAFE — arrival-text + alarm notify config + once-per-WO ledger (A4/A5)
-- Mission: fix/makesafe-reextract-and-notify-2026-07-04 (zero-mistakes wave 2C)
-- ════════════════════════════════════════════════════════════
--
-- The make-safe estate notifies by SMS:
--   * ARRIVAL TEXTS (A5): when a genuine NEW work order first lands, text the owner
--     crew. general / temp-fence / assessment make-safes -> Hugo. roof reports ->
--     Hugo AND Nithin. Fired ONCE per work order (see makesafe_notify_log) — never
--     for re-sends / twins / re-extractions / reopens.
--   * EXTRACTION-HEALTH ALARM (A4): the #273 dead-key / scan-stall / dropped-WO alarm
--     delivers by SMS to alarm_phones.
--
-- Recipients + the kill switch live in this single-row config so the owner can change
-- them without a code change. Phones are E.164. alarm_phones is SEEDED EMPTY on
-- purpose — no owner alarm number is configured yet; until it is seeded the alarm
-- still writes its business_event + log line, it just cannot SMS. from_number is a
-- SecureWorks GHL sending number (Group Ops).
--
-- Both objects are service-role only (same posture as makesafe_cron_settings and the
-- rest of the make-safe estate). Additive + idempotent; a re-apply is a no-op.

-- ── 1. single-row notify settings ──
CREATE TABLE IF NOT EXISTS public.makesafe_notify_settings (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),  -- single-row guard
  -- Master kill switch for the ARRIVAL texts (A5). FALSE = no arrival SMS at all.
  notify_enabled         boolean NOT NULL DEFAULT true,
  -- Kill switch for the EXTRACTION-HEALTH alarm SMS (A4). Business_event still fires.
  alarm_enabled          boolean NOT NULL DEFAULT true,
  -- Arrival recipients (E.164). general / temp_fence / assessment make-safes.
  arrival_general_phones text[] NOT NULL DEFAULT ARRAY['+61400753169']::text[],           -- Hugo
  -- Arrival recipients for ROOF reports (Hugo AND Nithin).
  arrival_roof_phones    text[] NOT NULL DEFAULT ARRAY['+61400753169','+61417795299']::text[],
  -- Extraction-health alarm recipients (E.164). EMPTY until the owner number is known.
  alarm_phones           text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- SecureWorks GHL sending number (Group Ops). Must be one of the known SW numbers.
  from_number            text NOT NULL DEFAULT '+61489267776',
  updated_at             timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.makesafe_notify_settings (id)
VALUES (true)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.makesafe_notify_settings ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.makesafe_notify_settings TO service_role;
DROP POLICY IF EXISTS service_role_all ON public.makesafe_notify_settings;
CREATE POLICY service_role_all ON public.makesafe_notify_settings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.makesafe_notify_settings IS
  'Single-row make-safe SMS notify config. Arrival-text recipients (general vs roof),
   extraction-health alarm recipients, kill switches, and the GHL sending number. Owner
   edits recipients here with no code change. alarm_phones seeded EMPTY until the owner
   alarm number is provided.';

-- ── 2. once-per-work-order arrival ledger ──
-- The dedup guarantee: an arrival text fires at most once per (org_id, dedup_key),
-- where dedup_key is the normalised external_ref when present else the graph_message_id.
-- A twin capture, a re-send, or a re-extraction of the same WO collides on the UNIQUE
-- key and is skipped. Insert-then-catch-23505 is the race-safe fire-once primitive.
CREATE TABLE IF NOT EXISTS public.makesafe_notify_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      uuid NOT NULL,
  dedup_key   text NOT NULL,
  kind        text NOT NULL,               -- 'arrival'
  family      text,                        -- makesafe_job_family at send time
  recipients  text[] NOT NULL DEFAULT ARRAY[]::text[],
  message     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT makesafe_notify_log_org_key UNIQUE (org_id, dedup_key)
);

ALTER TABLE public.makesafe_notify_log ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.makesafe_notify_log TO service_role;
DROP POLICY IF EXISTS service_role_all ON public.makesafe_notify_log;
CREATE POLICY service_role_all ON public.makesafe_notify_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.makesafe_notify_log IS
  'Once-per-work-order arrival-text ledger. UNIQUE(org_id, dedup_key) makes the arrival
   SMS fire exactly once per WO (twins / re-sends / re-extractions collide and skip).';
