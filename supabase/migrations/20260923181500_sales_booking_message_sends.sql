-- One exact-text send per message approval (sales_booking_send executor).
-- The row is claimed BEFORE the provider call, so a double press, a retry or a
-- concurrent press can never send twice: the second insert hits the primary
-- key and reads back the first outcome. `sending` that never finished is an
-- uncertainty fence, never automatically re-sent. Contract:
-- docs/sales-booking-executor.md.
CREATE TABLE public.sales_booking_message_sends (
  binding_hash text PRIMARY KEY
    REFERENCES public.sales_booking_approvals (binding_hash),
  contact_id text NOT NULL CHECK (length(contact_id) BETWEEN 1 AND 200),
  state text NOT NULL CHECK (state IN ('sending', 'sent', 'unknown')),
  message_id text,
  claimed_by_email text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((state = 'sent') = (message_id IS NOT NULL AND length(message_id) > 0)),
  CHECK ((state = 'sending') = (finished_at IS NULL))
);

-- Only a `sending` claim may be finished, exactly once, and the binding and
-- recipient can never move. A settled outcome is permanent.
CREATE FUNCTION public.sales_booking_message_sends_settle_once()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'sending' OR NEW.state = 'sending' OR
     NEW.binding_hash <> OLD.binding_hash OR NEW.contact_id <> OLD.contact_id OR
     NEW.claimed_by_email <> OLD.claimed_by_email OR NEW.claimed_at <> OLD.claimed_at THEN
    RAISE EXCEPTION 'sales_booking_message_sends: a send outcome settles once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_booking_message_sends_settle_once
  BEFORE UPDATE ON public.sales_booking_message_sends
  FOR EACH ROW EXECUTE FUNCTION public.sales_booking_message_sends_settle_once();

ALTER TABLE public.sales_booking_message_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_booking_message_sends FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.sales_booking_message_sends TO service_role;
REVOKE ALL ON FUNCTION public.sales_booking_message_sends_settle_once() FROM PUBLIC;
COMMENT ON TABLE public.sales_booking_message_sends IS 'One exact-text SMS per approved message binding. Claimed before the provider call; settles once; never deleted.';
