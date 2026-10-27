-- Dispatch v2, slice 8: supplier replies and suggested moves. Four tables.
--
-- The app already reads admin@ (and the other monitored mailboxes) every five
-- minutes: the outlook-mail-capture reader saves each email as one
-- business_events row. Nothing about that changes. A separate scan (ops-api
-- `dispatch_v2_replies_scan`, scheduled by
-- 20261023230100_dispatch_v2_replies_schedule.sql) reads the new inbound rows,
-- keeps ONLY the ones from a supplier, and records here which Dispatch order
-- each belongs to. Mail that is not from a supplier is never written here.
--
--   dispatch_v2_supplier_emails       one row per supplier email: how it was
--                                     matched (the rung), its job and order, or
--                                     that it waits in the Unmatched tray
--   dispatch_v2_supplier_order_refs   the supplier's own order / invoice
--                                     numbers linked to one of our orders, so
--                                     a later email quoting one matches by
--                                     itself
--   dispatch_v2_delivery_suggestions  "Stratco: delivery Tue 3 Nov", Accept or
--                                     Dismiss; Accept sets the order's
--                                     confirmed delivery date and NEVER the
--                                     job status
--   dispatch_v2_reply_scan_state      the scan's cursor (one row)
--
-- order_id is the Dispatch v2 order (one per supplier box). That table is
-- built by the supplier-order-emails slice, so order_id has no foreign key
-- here yet; ops-api reaches it only through
-- supabase/functions/ops-api/dispatch_v2_replies_sources.ts.
--
-- Rules: supabase/functions/ops-api/dispatch_v2_replies_rules.ts. Reads and
-- writes: dispatch_v2_replies.ts and dispatch_v2_replies_store.ts. Only
-- ops-api writes these tables. Row security on with no policy, revoked from the
-- browser roles, as job_dispatch_state is.
--
-- No job, job status, supplier (suppliers.email is never written), Xero, GHL,
-- business_events or send is touched by this migration.
--
-- Rollback: supabase/rollbacks/20261023230000_dispatch_v2_replies_tables_down.sql.

CREATE TABLE IF NOT EXISTS public.dispatch_v2_supplier_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  -- The captured email (business_events.id). One row per email.
  business_event_id uuid NOT NULL,
  sequence_number bigint NOT NULL,
  provider_message_id text NULL,
  conversation_id text NULL,
  received_at timestamptz NULL,
  from_email text NOT NULL,
  subject text NOT NULL DEFAULT '',
  -- The first words of the email, for the tray. The full words stay on the
  -- business_events row and are read from there.
  snippet text NOT NULL DEFAULT '',
  supplier_key text NULL,
  supplier_name text NULL,
  sender_via text NULL,
  -- From an address (or domain) on the approved supplier order email list.
  order_desk boolean NOT NULL DEFAULT false,
  job_numbers text[] NOT NULL DEFAULT '{}',
  supplier_refs text[] NOT NULL DEFAULT '{}',
  delivery_date date NULL,
  delivery_read jsonb NULL,
  state text NOT NULL,
  rung text NULL,
  match_reason text NULL,
  job_id uuid NULL REFERENCES public.jobs(id) ON DELETE SET NULL,
  order_id uuid NULL,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  rejected_order_ids uuid[] NOT NULL DEFAULT '{}',
  -- The last press a person made on this email.
  decision text NULL,
  decided_at timestamptz NULL,
  decided_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  decided_by_email text NULL,
  matched_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_v2_supplier_emails_event_unique UNIQUE (business_event_id),
  CONSTRAINT dispatch_v2_supplier_emails_state_valid CHECK (
    state IN ('matched', 'needs_confirmation', 'unmatched', 'hidden')
  ),
  CONSTRAINT dispatch_v2_supplier_emails_rung_valid CHECK (
    rung IS NULL OR rung IN ('thread', 'job_number', 'supplier_ref', 'best_guess', 'manual')
  ),
  CONSTRAINT dispatch_v2_supplier_emails_decision_valid CHECK (
    decision IS NULL OR decision IN ('assigned', 'confirmed', 'rejected', 'hidden')
  ),
  -- A matched email always has its job and how it was found.
  CONSTRAINT dispatch_v2_supplier_emails_matched_shape CHECK (
    state <> 'matched' OR (job_id IS NOT NULL AND rung IS NOT NULL)
  ),
  -- A best guess always names the order it guesses.
  CONSTRAINT dispatch_v2_supplier_emails_guess_shape CHECK (
    state <> 'needs_confirmation' OR (job_id IS NOT NULL AND order_id IS NOT NULL AND rung = 'best_guess')
  ),
  -- The tray holds no job.
  CONSTRAINT dispatch_v2_supplier_emails_tray_shape CHECK (
    state NOT IN ('unmatched', 'hidden') OR (job_id IS NULL AND order_id IS NULL)
  ),
  CONSTRAINT dispatch_v2_supplier_emails_decided_named CHECK (
    (decision IS NULL) = (decided_at IS NULL) AND (decision IS NULL OR decided_by_email IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS dispatch_v2_supplier_emails_job_idx
  ON public.dispatch_v2_supplier_emails (job_id, received_at DESC) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dispatch_v2_supplier_emails_tray_idx
  ON public.dispatch_v2_supplier_emails (state, received_at DESC)
  WHERE state IN ('unmatched', 'needs_confirmation');

COMMENT ON TABLE public.dispatch_v2_supplier_emails IS
  'Dispatch v2 slice 8: one row per captured SUPPLIER email (business_events), with the rung that matched it to a Dispatch order (thread, job_number, supplier_ref, best_guess, manual) or state unmatched for the Unmatched supplier emails tray. Written only by ops-api (dispatch_v2_replies.ts). Never written for non-supplier mail.';
COMMENT ON COLUMN public.dispatch_v2_supplier_emails.order_id IS
  'The Dispatch v2 order (one per supplier box). No foreign key until the supplier-order-emails slice lands its table; see ops-api dispatch_v2_replies_sources.ts.';

CREATE TABLE IF NOT EXISTS public.dispatch_v2_supplier_order_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  order_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  supplier_key text NULL,
  supplier_name text NULL,
  -- Upper case, no spaces: 238780, PSI-225053, Q12345.
  ref text NOT NULL,
  source_email_id uuid NULL REFERENCES public.dispatch_v2_supplier_emails(id) ON DELETE SET NULL,
  -- certain_match: quoted in an email matched by thread or job number.
  -- confirmed_guess: a person confirmed a best guess. assigned: a person picked
  -- the job for an unmatched email.
  linked_via text NOT NULL,
  linked_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  linked_by_email text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_v2_supplier_order_refs_unique UNIQUE (order_id, ref),
  CONSTRAINT dispatch_v2_supplier_order_refs_ref_shape CHECK (
    ref = upper(ref) AND ref !~ '\s' AND char_length(ref) BETWEEN 3 AND 24
  ),
  CONSTRAINT dispatch_v2_supplier_order_refs_via_valid CHECK (
    linked_via IN ('certain_match', 'confirmed_guess', 'assigned')
  )
);

CREATE INDEX IF NOT EXISTS dispatch_v2_supplier_order_refs_ref_idx
  ON public.dispatch_v2_supplier_order_refs (ref);

COMMENT ON TABLE public.dispatch_v2_supplier_order_refs IS
  'Dispatch v2 slice 8: a supplier''s own order, invoice or quote number linked to one of our Dispatch orders, so a later email quoting it matches by itself (rung supplier_ref). Written only by ops-api.';

CREATE TABLE IF NOT EXISTS public.dispatch_v2_delivery_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  -- Null when the email matched the job but not one order; Accept then needs
  -- the order picked on the screen.
  order_id uuid NULL,
  email_id uuid NOT NULL REFERENCES public.dispatch_v2_supplier_emails(id) ON DELETE CASCADE,
  supplier_key text NULL,
  supplier_name text NULL,
  delivery_date date NOT NULL,
  -- "Stratco: delivery Tue 3 Nov". No em dash, no emoji.
  label text NOT NULL,
  -- The supplier's words the date was read from.
  quote text NULL,
  -- weekday_mismatch, day_word_only, other_dates.
  flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'open',
  accepted_order_id uuid NULL,
  acted_at timestamptz NULL,
  acted_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  acted_by_email text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_v2_delivery_suggestions_email_unique UNIQUE (email_id),
  CONSTRAINT dispatch_v2_delivery_suggestions_state_valid CHECK (
    state IN ('open', 'accepted', 'dismissed', 'superseded')
  ),
  -- Accept and Dismiss always name the person who pressed.
  CONSTRAINT dispatch_v2_delivery_suggestions_acted_named CHECK (
    state NOT IN ('accepted', 'dismissed') OR (acted_at IS NOT NULL AND acted_by_email IS NOT NULL)
  ),
  CONSTRAINT dispatch_v2_delivery_suggestions_accepted_order CHECK (
    state <> 'accepted' OR accepted_order_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS dispatch_v2_delivery_suggestions_job_idx
  ON public.dispatch_v2_delivery_suggestions (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS dispatch_v2_delivery_suggestions_open_order_idx
  ON public.dispatch_v2_delivery_suggestions (order_id) WHERE state = 'open';

COMMENT ON TABLE public.dispatch_v2_delivery_suggestions IS
  'Dispatch v2 slice 8: a delivery date read from a matched supplier email, shown on the job with Accept / Dismiss. Accept sets the order''s confirmed delivery date (through the order adapter) and never the job status; the screen may then offer a stage move through update_job_status with its own confirm. Written only by ops-api.';

CREATE TABLE IF NOT EXISTS public.dispatch_v2_reply_scan_state (
  id text PRIMARY KEY DEFAULT 'default',
  -- The last business_events.sequence_number the scan finished.
  cursor_sequence bigint NULL,
  last_scan_at timestamptz NULL,
  -- Counts and codes only, never email words.
  last_result jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_v2_reply_scan_state_one_row CHECK (id = 'default')
);

COMMENT ON TABLE public.dispatch_v2_reply_scan_state IS
  'Dispatch v2 slice 8: where the supplier reply scan is up to in business_events (sequence_number), and the counts of its last run. One row.';

ALTER TABLE public.dispatch_v2_supplier_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_v2_supplier_order_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_v2_delivery_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_v2_reply_scan_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.dispatch_v2_supplier_emails FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.dispatch_v2_supplier_order_refs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.dispatch_v2_delivery_suggestions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.dispatch_v2_reply_scan_state FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dispatch_v2_supplier_emails TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dispatch_v2_supplier_order_refs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dispatch_v2_delivery_suggestions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dispatch_v2_reply_scan_state TO service_role;
