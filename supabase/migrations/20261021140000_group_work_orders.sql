-- Group work orders and client job sign-off.
--
-- One group per (job, job work order). The pot is the sealed
-- work_orders.agreed_labour_ex on that job work order (owner, confirmed).
-- It is not stored on the group row. A trade reads it only through ops-api,
-- and only after they have joined the group and submitted their own hours,
-- as pot_total beside their own share. That is a deliberate narrow exception
-- to "trades cannot read agreed_labour_ex": PostgREST still hides kind = 'job'
-- work orders, and a non-participant has no share row to read.
--
-- Share rows are the caller's own. source_work_order_id on a share invoice
-- line stays null: the parent job work order is not a crew-pay claim.
-- Client sign-off is the invoice gate. Crew signatures are not.
-- The client-link sender flag ships off. This migration sends nothing.
--
-- Apply before the matching ops-api. trade_invoice_lines.group_share_id is
-- not a foreign key, for the same embed reason as job_work_order_id.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- ── 1. group ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.group_work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  work_order_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open',
  share_token text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  client_signed_at timestamptz,
  voided_at timestamptz,
  void_reason text,
  CONSTRAINT group_work_orders_status_check
    CHECK (status IN ('open', 'client_signed', 'void')),
  CONSTRAINT uq_group_work_orders_job_work_order UNIQUE (job_id, work_order_id),
  CONSTRAINT uq_group_work_orders_share_token UNIQUE (share_token)
);

COMMENT ON TABLE public.group_work_orders IS
  'One group split for a job''s sealed job work order. No dollar column: the pot is work_orders.agreed_labour_ex, read by ops-api.';
COMMENT ON COLUMN public.group_work_orders.work_order_id IS
  'jobs.work_order_id / work_orders.kind = job. Not a foreign key, so PostgREST embeds of work_orders stay unambiguous.';
COMMENT ON COLUMN public.group_work_orders.share_token IS
  'Unguessable secret for the public client sign-off page. Knowing it is the client''s credential.';

-- ── 2. participants ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.group_work_order_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.group_work_orders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  crew_signed_at timestamptz,
  signature_name text,
  CONSTRAINT uq_group_work_order_participants UNIQUE (group_id, user_id)
);

COMMENT ON TABLE public.group_work_order_participants IS
  'Crew on a group. Names and whether they signed are visible to other participants. Hours and pay are not.';

-- ── 3. signatures (service role only) ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.group_work_order_signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.group_work_orders(id) ON DELETE CASCADE,
  signer_kind text NOT NULL,
  user_id uuid,
  signer_name text NOT NULL,
  signature_png text,
  signed_via text NOT NULL,
  captured_by_user_id uuid,
  signed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_work_order_signatures_kind_check
    CHECK (signer_kind IN ('crew', 'client')),
  CONSTRAINT group_work_order_signatures_via_check
    CHECK (signed_via IN ('on_site', 'share_link')),
  CONSTRAINT group_work_order_signatures_name_check
    CHECK (char_length(btrim(signer_name)) > 0),
  CONSTRAINT group_work_order_signatures_png_check
    CHECK (signature_png IS NULL OR char_length(signature_png) <= 200000)
);

COMMENT ON TABLE public.group_work_order_signatures IS
  'Client and crew signature images. Browser roles cannot read them; ops-api returns signed/not signed to a trade and the image to the office.';

-- ── 4. hours (own row) ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.group_work_order_time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.group_work_orders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  work_date date NOT NULL,
  start_time text NOT NULL,
  finish_time text NOT NULL,
  break_minutes integer NOT NULL DEFAULT 0,
  hours numeric(8,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_group_work_order_time_entries UNIQUE (group_id, user_id, work_date),
  CONSTRAINT group_work_order_time_entries_break_check
    CHECK (break_minutes >= 0),
  CONSTRAINT group_work_order_time_entries_hours_check
    CHECK (hours > 0)
);

COMMENT ON TABLE public.group_work_order_time_entries IS
  'Each crew member''s own start, finish and break on this group. Points use these hours. Clock rows are not copied here. A participant cannot read another participant''s row.';

-- ── 5. feedback (office only) ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.group_work_order_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.group_work_orders(id) ON DELETE CASCADE,
  sales_process_rating smallint NOT NULL,
  sales_process_comment text,
  communication_rating smallint NOT NULL,
  communication_comment text,
  cleanliness_rating smallint NOT NULL,
  cleanliness_comment text,
  punctuality_rating smallint NOT NULL,
  punctuality_comment text,
  crew_rating smallint NOT NULL,
  crew_comment text,
  free_text text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  submitted_via text NOT NULL,
  CONSTRAINT uq_group_work_order_feedback_group UNIQUE (group_id),
  CONSTRAINT group_work_order_feedback_via_check
    CHECK (submitted_via IN ('on_site', 'share_link')),
  CONSTRAINT group_work_order_feedback_sales_check
    CHECK (sales_process_rating BETWEEN 1 AND 5),
  CONSTRAINT group_work_order_feedback_communication_check
    CHECK (communication_rating BETWEEN 1 AND 5),
  CONSTRAINT group_work_order_feedback_cleanliness_check
    CHECK (cleanliness_rating BETWEEN 1 AND 5),
  CONSTRAINT group_work_order_feedback_punctuality_check
    CHECK (punctuality_rating BETWEEN 1 AND 5),
  CONSTRAINT group_work_order_feedback_crew_check
    CHECK (crew_rating BETWEEN 1 AND 5)
);

COMMENT ON TABLE public.group_work_order_feedback IS
  'Client ratings for the office. Installers and other trades cannot read this table. The client is told that when they submit.';

-- ── 6. shares (own row; pot_ex is the narrow exception) ─────────────────────

CREATE TABLE IF NOT EXISTS public.group_work_order_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.group_work_orders(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  hours numeric(8,2) NOT NULL,
  points numeric(14,4) NOT NULL,
  share_ex numeric(12,2) NOT NULL,
  pot_ex numeric(12,2) NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_group_work_order_shares UNIQUE (group_id, user_id),
  CONSTRAINT group_work_order_shares_money_check
    CHECK (share_ex >= 0 AND pot_ex >= 0 AND hours >= 0 AND points >= 0)
);

COMMENT ON TABLE public.group_work_order_shares IS
  'One row per participant. A trade may read only their own row (user_id = auth.uid()). pot_ex on that row is the sealed agreed labour, the one place a participating trade can see it. Other participants'' shares, hours and points are not on this row.';
COMMENT ON COLUMN public.group_work_order_shares.pot_ex IS
  'Snapshot of work_orders.agreed_labour_ex when this share was computed. Visible to this participant only. Not a second pot.';

-- ── 7. settings ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.group_work_order_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  google_review_url text NOT NULL,
  review_prompt_min_rating smallint NOT NULL DEFAULT 4,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_work_order_settings_min_check
    CHECK (review_prompt_min_rating BETWEEN 1 AND 5)
);

INSERT INTO public.group_work_order_settings (id, google_review_url, review_prompt_min_rating)
VALUES (
  1,
  -- Seed only, copied from supabase/functions/_shared/google_review_link.ts.
  -- The trade app's g.page TODO URL is not this value. Change the row, not code.
  'https://share.google/AFyfkE7jLfCZcxanV',
  4
)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.group_work_order_settings IS
  'Review link and the rating minimum that asks the client for a Google review. The link is config. Nothing in ops-api hardcodes it into a response.';

-- ── 8. invoice line pointer ─────────────────────────────────────────────────

ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS group_share_id uuid;
CREATE INDEX IF NOT EXISTS idx_trade_invoice_lines_group_share
  ON public.trade_invoice_lines (group_share_id) WHERE group_share_id IS NOT NULL;
COMMENT ON COLUMN public.trade_invoice_lines.group_share_id IS
  'The signer''s group_work_order_shares row. Not a foreign key. A share line leaves source_work_order_id null; this is not a full work-order claim.';

-- ── 9. sender flag, off ─────────────────────────────────────────────────────

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT
  'group_work_order_client_link_send_v1',
  false,
  'When on, a later change may text the client their group sign-off link. This build has no sender: preview returns the draft and send is refused even if the flag is on. Off, missing or unreadable: nothing is sent.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags
  WHERE flag_name = 'group_work_order_client_link_send_v1'
);

-- ── 10. who can read ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.group_work_order_caller_is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.id = auth.uid()
      AND lower(u.role::text) IN ('admin', 'owner', 'ops_manager')
  );
$$;

CREATE OR REPLACE FUNCTION public.group_work_order_caller_is_participant(p_group uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.group_work_order_participants p
    WHERE p.group_id = p_group
      AND p.user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.group_work_order_caller_is_staff() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.group_work_order_caller_is_participant(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.group_work_order_caller_is_staff() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.group_work_order_caller_is_participant(uuid) TO authenticated, service_role;

ALTER TABLE public.group_work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_work_order_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_work_order_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_work_order_time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_work_order_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_work_order_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_work_order_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS group_work_orders_select ON public.group_work_orders;
CREATE POLICY group_work_orders_select ON public.group_work_orders
  FOR SELECT TO authenticated
  USING (
    public.group_work_order_caller_is_staff()
    OR public.group_work_order_caller_is_participant(id)
  );

DROP POLICY IF EXISTS group_work_order_participants_select ON public.group_work_order_participants;
CREATE POLICY group_work_order_participants_select ON public.group_work_order_participants
  FOR SELECT TO authenticated
  USING (
    public.group_work_order_caller_is_staff()
    OR user_id = auth.uid()
    OR public.group_work_order_caller_is_participant(group_id)
  );

DROP POLICY IF EXISTS group_work_order_time_entries_select ON public.group_work_order_time_entries;
CREATE POLICY group_work_order_time_entries_select ON public.group_work_order_time_entries
  FOR SELECT TO authenticated
  USING (
    public.group_work_order_caller_is_staff()
    OR user_id = auth.uid()
  );

DROP POLICY IF EXISTS group_work_order_shares_select ON public.group_work_order_shares;
CREATE POLICY group_work_order_shares_select ON public.group_work_order_shares
  FOR SELECT TO authenticated
  USING (
    public.group_work_order_caller_is_staff()
    OR user_id = auth.uid()
  );

DROP POLICY IF EXISTS group_work_order_feedback_select ON public.group_work_order_feedback;
CREATE POLICY group_work_order_feedback_select ON public.group_work_order_feedback
  FOR SELECT TO authenticated
  USING (public.group_work_order_caller_is_staff());

DROP POLICY IF EXISTS group_work_order_settings_select ON public.group_work_order_settings;
CREATE POLICY group_work_order_settings_select ON public.group_work_order_settings
  FOR SELECT TO authenticated
  USING (public.group_work_order_caller_is_staff());

-- No SELECT policy on signatures: authenticated reads nothing.

REVOKE ALL ON public.group_work_orders FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.group_work_order_participants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.group_work_order_signatures FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.group_work_order_time_entries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.group_work_order_feedback FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.group_work_order_shares FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.group_work_order_settings FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.group_work_orders TO authenticated;
GRANT SELECT ON public.group_work_order_participants TO authenticated;
GRANT SELECT ON public.group_work_order_time_entries TO authenticated;
GRANT SELECT ON public.group_work_order_feedback TO authenticated;
GRANT SELECT ON public.group_work_order_shares TO authenticated;
GRANT SELECT ON public.group_work_order_settings TO authenticated;

GRANT ALL ON public.group_work_orders TO service_role;
GRANT ALL ON public.group_work_order_participants TO service_role;
GRANT ALL ON public.group_work_order_signatures TO service_role;
GRANT ALL ON public.group_work_order_time_entries TO service_role;
GRANT ALL ON public.group_work_order_feedback TO service_role;
GRANT ALL ON public.group_work_order_shares TO service_role;
GRANT ALL ON public.group_work_order_settings TO service_role;
