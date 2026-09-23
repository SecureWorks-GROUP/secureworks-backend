-- One executor ledger for both booking steps (calendar claim + exact-text send).
-- A live GHL write requires the ops-api executor to have claimed this binding
-- hash for this press. A message row is claimed before the provider call and
-- settles once. A calendar row may be re-claimed only while unbooked; booked
-- is permanent. Contract: docs/sales-booking-executor.md.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $$
DECLARE
  pk text[];
  col record;
  expected constant jsonb := jsonb_build_object(
    'binding_hash', jsonb_build_object('data_type','text','is_nullable','NO'),
    'step', jsonb_build_object('data_type','text','is_nullable','NO'),
    'contact_id', jsonb_build_object('data_type','text','is_nullable','NO'),
    'state', jsonb_build_object('data_type','text','is_nullable','NO'),
    'press_token', jsonb_build_object('data_type','uuid','is_nullable','NO'),
    'message_id', jsonb_build_object('data_type','text','is_nullable','YES'),
    'appointment_id', jsonb_build_object('data_type','text','is_nullable','YES'),
    'claimed_by_email', jsonb_build_object('data_type','text','is_nullable','NO'),
    'claimed_at', jsonb_build_object('data_type','timestamp with time zone','is_nullable','NO'),
    'finished_at', jsonb_build_object('data_type','timestamp with time zone','is_nullable','YES')
  );
BEGIN
  IF to_regclass('public.sales_booking_approvals') IS NULL THEN
    RAISE EXCEPTION 'sales_booking_executions: public.sales_booking_approvals is missing';
  END IF;
  SELECT array_agg(a.attname::text ORDER BY x.n) INTO pk
  FROM pg_constraint c
  JOIN unnest(c.conkey) WITH ORDINALITY AS x(attnum, n) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.attnum
  WHERE c.conrelid = 'public.sales_booking_approvals'::regclass AND c.contype = 'p';
  IF pk IS DISTINCT FROM ARRAY['binding_hash'] THEN
    RAISE EXCEPTION 'sales_booking_executions: sales_booking_approvals.binding_hash is not the primary key';
  END IF;
  IF to_regclass('public.sales_booking_executions') IS NULL THEN
    RETURN;
  END IF;
  FOR col IN
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sales_booking_executions'
  LOOP
    IF NOT expected ? col.column_name THEN
      RAISE EXCEPTION 'sales_booking_executions: unexpected column %', col.column_name;
    END IF;
    IF expected->col.column_name->>'data_type' IS DISTINCT FROM col.data_type
       OR expected->col.column_name->>'is_nullable' IS DISTINCT FROM col.is_nullable THEN
      RAISE EXCEPTION 'sales_booking_executions: column % type drift', col.column_name;
    END IF;
  END LOOP;
  FOR col IN SELECT jsonb_object_keys(expected) AS column_name
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sales_booking_executions'
        AND column_name = col.column_name
    ) THEN
      RAISE EXCEPTION 'sales_booking_executions: missing column %', col.column_name;
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.sales_booking_executions (
  binding_hash text PRIMARY KEY
    REFERENCES public.sales_booking_approvals (binding_hash),
  step text NOT NULL CHECK (step IN ('calendar', 'message')),
  contact_id text NOT NULL CHECK (length(contact_id) BETWEEN 1 AND 200),
  state text NOT NULL CHECK (
    (step = 'calendar' AND state IN ('claimed', 'booked')) OR
    (step = 'message' AND state IN ('sending', 'sent', 'unknown'))
  ),
  press_token uuid NOT NULL,
  message_id text,
  appointment_id text,
  claimed_by_email text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((state = 'sent') = (message_id IS NOT NULL AND length(message_id) > 0)),
  CHECK ((state = 'booked') = (appointment_id IS NOT NULL AND length(appointment_id) > 0)),
  CHECK ((state IN ('claimed', 'sending')) = (finished_at IS NULL))
);

CREATE OR REPLACE FUNCTION public.sales_booking_executions_settle_once()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.binding_hash <> OLD.binding_hash OR NEW.contact_id <> OLD.contact_id OR
     NEW.step <> OLD.step THEN
    RAISE EXCEPTION 'sales_booking_executions: a send outcome settles once';
  END IF;
  IF OLD.step = 'calendar' THEN
    IF OLD.state = 'booked' THEN
      RAISE EXCEPTION 'sales_booking_executions: a send outcome settles once';
    END IF;
    IF NEW.state = 'claimed' THEN
      IF OLD.state <> 'claimed' OR NEW.appointment_id IS NOT NULL OR
         NEW.message_id IS DISTINCT FROM OLD.message_id OR
         NEW.finished_at IS NOT NULL OR
         NEW.claimed_by_email <> OLD.claimed_by_email THEN
        RAISE EXCEPTION 'sales_booking_executions: a send outcome settles once';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.state = 'booked' AND OLD.state = 'claimed' THEN
      IF NEW.claimed_by_email <> OLD.claimed_by_email OR
         NEW.claimed_at <> OLD.claimed_at OR
         NEW.press_token <> OLD.press_token THEN
        RAISE EXCEPTION 'sales_booking_executions: a send outcome settles once';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'sales_booking_executions: a send outcome settles once';
  END IF;
  IF OLD.state <> 'sending' OR NEW.state = 'sending' OR
     NEW.claimed_by_email <> OLD.claimed_by_email OR
     NEW.claimed_at <> OLD.claimed_at OR
     NEW.press_token IS DISTINCT FROM OLD.press_token THEN
    RAISE EXCEPTION 'sales_booking_executions: a send outcome settles once';
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'sales_booking_executions'
      AND t.tgname = 'sales_booking_executions_settle_once' AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER sales_booking_executions_settle_once
      BEFORE UPDATE ON public.sales_booking_executions
      FOR EACH ROW EXECUTE FUNCTION public.sales_booking_executions_settle_once();
  END IF;
END $$;

ALTER TABLE public.sales_booking_executions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_booking_executions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.sales_booking_executions TO service_role;
REVOKE ALL ON FUNCTION public.sales_booking_executions_settle_once() FROM PUBLIC;
COMMENT ON TABLE public.sales_booking_executions IS
  'Executor press ledger. Calendar: claimed then booked; re-claim only while unbooked. Message: claimed before send; settles once. Never deleted.';
