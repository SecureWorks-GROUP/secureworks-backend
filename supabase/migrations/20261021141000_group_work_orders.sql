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
--
-- Freeze is an explicit step (freeze_group_work_order_split) after every
-- participant and every installer currently assigned to the job has
-- assignment-dated hours, and a drawn client sign-off (not an office
-- waiver, not revoked, strictly newer than every remaining hour row and
-- the group's hours_changed_at) exists on job_client_signoffs.
-- hours_changed_at moves on an hour insert, a real hour change, an hour
-- delete, and a participant removal. Saving the same hours again does
-- not move it and does not move that row's updated_at. A share read
-- and project_group_work_order_split never set split_frozen_at and never
-- persist share rows. The share-line trigger freezes in the SAME
-- transaction as a non-draft line insert, so a failed insert rolls the
-- marker back. A draft save stores the line, does not freeze, and does
-- not hold the share, so a later save or submit can replace it. Office
-- unfreeze is refused while a submit or Xero push is in flight (the
-- weekly invoice lock is group_split_busy, not a live invoice; status
-- pending_acknowledgment or later, or any Xero id, is
-- group_split_has_live_invoice). Before that it removes only the share
-- line and recalculates that invoice, including a weekly work order's
-- header totals. A recurring deduction that no longer fits the reduced
-- payable is cleared in that same update so the invoice cannot go
-- negative; one that still fits is left as it was. Nothing is recomputed
-- until the next explicit freeze. Voiding stays permanent.
-- Owner to confirm the freeze, unfreeze and sign-off defaults.

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

ALTER TABLE public.group_work_orders
  ADD COLUMN IF NOT EXISTS split_frozen_at timestamptz;
COMMENT ON COLUMN public.group_work_orders.split_frozen_at IS
  'Set in the same transaction as the share snapshot, under a row lock on this group. Null means the split is still open. Every share line reads that one snapshot.';

ALTER TABLE public.group_work_orders
  ADD COLUMN IF NOT EXISTS hours_changed_at timestamptz;
COMMENT ON COLUMN public.group_work_orders.hours_changed_at IS
  'clock_timestamp() when hours are inserted, really changed, or deleted, or a participant is removed. A counting sign-off is strictly newer than this and every remaining hour row. An identical re-save does not move it.';

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
-- A crew drawing is a PNG or JPEG data URL. SVG and anything else are
-- refused here; the same rule is applied before a signature is placed in HTML.

CREATE OR REPLACE FUNCTION public.group_work_order_signature_ok(p_value text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payload text;
  v_bytes bytea;
BEGIN
  IF p_value IS NULL THEN
    RETURN true;
  END IF;
  IF p_value !~ '^data:image/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$' THEN
    RETURN false;
  END IF;
  v_payload := substring(p_value FROM 'base64,(.+)$');
  BEGIN
    v_bytes := decode(v_payload, 'base64');
  EXCEPTION WHEN OTHERS THEN
    RETURN false;
  END;
  IF octet_length(v_bytes) < 3 OR octet_length(v_bytes) > 150000 THEN
    RETURN false;
  END IF;
  IF p_value LIKE 'data:image/png;%' THEN
    RETURN octet_length(v_bytes) >= 4
      AND get_byte(v_bytes, 0) = 137
      AND get_byte(v_bytes, 1) = 80
      AND get_byte(v_bytes, 2) = 78
      AND get_byte(v_bytes, 3) = 71;
  END IF;
  RETURN get_byte(v_bytes, 0) = 255
    AND get_byte(v_bytes, 1) = 216
    AND get_byte(v_bytes, 2) = 255;
END;
$$;

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
    CHECK (signer_kind = 'crew'),
  CONSTRAINT group_work_order_signatures_via_check
    CHECK (signed_via IN ('on_site', 'share_link')),
  CONSTRAINT group_work_order_signatures_name_check
    CHECK (char_length(btrim(signer_name)) BETWEEN 1 AND 120),
  CONSTRAINT group_work_order_signatures_png_check
    CHECK (public.group_work_order_signature_ok(signature_png))
);

COMMENT ON TABLE public.group_work_order_signatures IS
  'Crew signature images only. A client drawing is a job_media row of phase signature pointed at by job_client_signoffs. Browser roles cannot read this table.';

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
  updated_at timestamptz NOT NULL DEFAULT now(),
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
  'Client ratings for the office. Installers and other trades cannot read this table. The client is told that when they submit. A second post does not change the first ratings.';

ALTER TABLE public.group_work_order_feedback
  DROP CONSTRAINT IF EXISTS group_work_order_feedback_comment_len_check;
ALTER TABLE public.group_work_order_feedback
  ADD CONSTRAINT group_work_order_feedback_comment_len_check CHECK (
    (sales_process_comment IS NULL OR char_length(sales_process_comment) <= 2000)
    AND (communication_comment IS NULL OR char_length(communication_comment) <= 2000)
    AND (cleanliness_comment IS NULL OR char_length(cleanliness_comment) <= 2000)
    AND (punctuality_comment IS NULL OR char_length(punctuality_comment) <= 2000)
    AND (crew_comment IS NULL OR char_length(crew_comment) <= 2000)
    AND (free_text IS NULL OR char_length(free_text) <= 4000)
  );

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
  'The Google review link is config. review_prompt_min_rating is kept so older readers still see a number; the prompt threshold is client_signoff_settings.min_happy_rating. Owner to confirm.';

-- ── 8. invoice line pointer ─────────────────────────────────────────────────

ALTER TABLE public.trade_invoice_lines
  ADD COLUMN IF NOT EXISTS group_share_id uuid;
CREATE INDEX IF NOT EXISTS idx_trade_invoice_lines_group_share
  ON public.trade_invoice_lines (group_share_id) WHERE group_share_id IS NOT NULL;
COMMENT ON COLUMN public.trade_invoice_lines.group_share_id IS
  'The signer''s group_work_order_shares row. Not a foreign key. A share line leaves source_work_order_id null; this is not a full work-order claim.';

-- ── 9. flags, off ───────────────────────────────────────────────────────────
-- group_work_order_v1 gates every group action (create, join, hours, my
-- share, sign-off, the public page, freeze and unfreeze). Missing or
-- unreadable is off. While it is off, trade invoicing does not read the
-- group tables. The database trigger below still refuses a second payment
-- if a group row already exists.

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT
  'group_work_order_v1',
  false,
  'Group work-order hours, client sign-off and share invoices. Off until the owner turns it on. The invoice-line trigger still refuses a normal pay claim on a job that already has a group.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags
  WHERE flag_name = 'group_work_order_v1'
);

-- ── 9b. sender flag, off ────────────────────────────────────────────────────

INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT
  'group_work_order_client_link_send_v1',
  false,
  'When on, a later change may text the client their group sign-off link. This build has no sender: preview returns the draft and send is refused even if the flag is on. Off, missing or unreadable: nothing is sent.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags
  WHERE flag_name = 'group_work_order_client_link_send_v1'
);

-- Completion-pack client email. Off until the owner accepts the exact
-- text. While off, the pack is still generated and nothing is emailed.
INSERT INTO public.feature_flags (flag_name, enabled, description)
SELECT
  'completion_pack_client_email_v1',
  false,
  'When on, the completion pack may email the client. Off, missing or unreadable: the pack is stored and no email is sent. The email text still needs the owner''s okay before this is turned on.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.feature_flags
  WHERE flag_name = 'completion_pack_client_email_v1'
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

-- ── 11. client sign-off reuse and the audit row ─────────────────────────────
-- Client drawings live on job_client_signoffs (PR #1110), not in
-- group_work_order_signatures. share_link is the public client page.
-- on_site is a participant's phone. revoked is a newer row that stops
-- counting. office_waiver still counts for the ordinary invoice gate, not
-- for a group freeze. Owner to confirm.

ALTER TABLE public.job_client_signoffs DROP CONSTRAINT IF EXISTS job_client_signoffs_method_check;
ALTER TABLE public.job_client_signoffs ADD CONSTRAINT job_client_signoffs_method_check
  CHECK (method IN ('on_site', 'office_waiver', 'share_link', 'revoked'));

ALTER TABLE public.job_client_signoffs
  ADD COLUMN IF NOT EXISTS captured_device text;

ALTER TABLE public.job_client_signoffs DROP CONSTRAINT IF EXISTS job_client_signoffs_device_check;
ALTER TABLE public.job_client_signoffs ADD CONSTRAINT job_client_signoffs_device_check
  CHECK (captured_device IS NULL OR char_length(captured_device) <= 200);

ALTER TABLE public.job_client_signoffs DROP CONSTRAINT IF EXISTS job_client_signoffs_share_link_check;
ALTER TABLE public.job_client_signoffs ADD CONSTRAINT job_client_signoffs_share_link_check
  CHECK (
    method <> 'share_link'
    OR (
      signature_media_id IS NOT NULL
      AND char_length(btrim(COALESCE(signed_name, ''))) BETWEEN 1 AND 120
    )
  );

ALTER TABLE public.job_client_signoffs DROP CONSTRAINT IF EXISTS job_client_signoffs_revoked_check;
ALTER TABLE public.job_client_signoffs ADD CONSTRAINT job_client_signoffs_revoked_check
  CHECK (method <> 'revoked' OR signature_media_id IS NULL);

COMMENT ON COLUMN public.job_client_signoffs.captured_device IS
  'Phone or browser label supplied with a group sign-off. Null on older rows.';

CREATE TABLE IF NOT EXISTS public.group_work_order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.group_work_orders(id) ON DELETE CASCADE,
  job_id uuid NOT NULL,
  action text NOT NULL,
  actor_user_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT group_work_order_events_action_check CHECK (action IN (
    'freeze', 'unfreeze', 'revoke_signoff', 'void_group', 'rekey',
    'remove_participant'
  ))
);

COMMENT ON TABLE public.group_work_order_events IS
  'Append-only office audit for a group split. Trades cannot read it.';

CREATE OR REPLACE FUNCTION public.group_work_order_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'group_work_order_events is append-only' USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_group_work_order_events_append_only ON public.group_work_order_events;
CREATE TRIGGER trg_group_work_order_events_append_only
  BEFORE UPDATE OR DELETE ON public.group_work_order_events
  FOR EACH ROW EXECUTE FUNCTION public.group_work_order_events_append_only();

ALTER TABLE public.group_work_order_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.group_work_order_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.group_work_order_events TO service_role;
REVOKE ALL ON FUNCTION public.group_work_order_events_append_only() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_work_order_events_append_only() TO service_role;

-- ── 12. one split, written only by an explicit freeze ───────────────────────
--
-- group_work_order_write_split locks the group. If the marker is already
-- set it returns those rows. Otherwise it checks every participant, the
-- rate and the client sign-off, then either returns the figures (p_freeze
-- false: nothing is stored) or writes them and sets the marker. Preview
-- never sets split_frozen_at. A failed check writes nothing.

CREATE OR REPLACE FUNCTION public.group_work_order_assignment_covers(
  p_job uuid,
  p_user uuid,
  p_day date
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.job_assignments a
    WHERE a.job_id = p_job
      AND a.user_id = p_user
      AND a.scheduled_date = p_day
      AND COALESCE(to_jsonb(a)->>'status', '') IS DISTINCT FROM 'cancelled'
      AND COALESCE(to_jsonb(a)->>'role', '') IS DISTINCT FROM 'observer'
      AND COALESCE(to_jsonb(a)->>'is_ghost', 'false') IS DISTINCT FROM 'true'
  );
$$;

CREATE OR REPLACE FUNCTION public.group_client_signoff_counts(p_job uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_method text;
  v_happy boolean;
  v_rating smallint;
  v_min smallint;
  v_media uuid;
  v_signed_at timestamptz;
  v_latest_hours timestamptz;
BEGIN
  -- A group needs a drawn signature. This does not call #1110's helper:
  -- a revoked row is not signed here even if that helper still counts it.
  -- An office waiver does not count here (it still counts for the ordinary
  -- client-signoff invoice gate). The drawing has to be strictly newer
  -- than every remaining hour row (later of created_at and updated_at)
  -- and the group's hours_changed_at. max() over both, not GREATEST:
  -- GREATEST of a null hour stamp and a stamp is null. An identical
  -- re-save moves neither stamp. Deleting the last hour row leaves
  -- hours_changed_at, so the old drawing still does not count.
  SELECT s.method, s.happy, s.satisfaction_rating, s.signature_media_id, s.created_at
    INTO v_method, v_happy, v_rating, v_media, v_signed_at
  FROM public.job_client_signoffs s
  WHERE s.job_id = p_job
  ORDER BY s.created_at DESC, s.id::text COLLATE "C" DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_method IN ('revoked', 'office_waiver') THEN
    RETURN false;
  END IF;
  IF v_method NOT IN ('on_site', 'share_link') OR v_media IS NULL THEN
    RETURN false;
  END IF;
  SELECT c.min_happy_rating INTO v_min
  FROM public.client_signoff_settings c
  WHERE c.id = 1;
  IF v_min IS NULL THEN
    v_min := 4;
  END IF;
  IF v_happy IS FALSE THEN
    RETURN false;
  END IF;
  IF v_rating IS NOT NULL AND v_rating < v_min THEN
    RETURN false;
  END IF;
  SELECT max(stamp) INTO v_latest_hours
  FROM (
    SELECT max(GREATEST(e.created_at, COALESCE(e.updated_at, e.created_at))) AS stamp
    FROM public.group_work_order_time_entries e
    JOIN public.group_work_orders g ON g.id = e.group_id
    WHERE g.job_id = p_job
      AND g.status <> 'void'
    UNION ALL
    SELECT max(g.hours_changed_at)
    FROM public.group_work_orders g
    WHERE g.job_id = p_job
      AND g.status <> 'void'
  ) stamps;
  IF v_latest_hours IS NOT NULL AND NOT (v_signed_at > v_latest_hours) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.group_work_order_write_split(
  p_group_id uuid,
  p_freeze boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_frozen timestamptz;
  v_status text;
  v_org uuid;
  v_job uuid;
  v_work_order uuid;
  v_pot numeric;
  v_pot_cents bigint;
  v_total bigint;
  v_count int;
  v_sum_floor bigint;
  v_leftover bigint;
  v_shares jsonb;
  v_needs_hours text;
  v_missing_rate text;
  v_needs_rate text;
BEGIN
  SELECT g.job_id INTO v_job
  FROM public.group_work_orders g
  WHERE g.id = p_group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.group_work_order_lock_job(v_job);
  SELECT g.split_frozen_at, g.status, g.org_id, g.job_id, g.work_order_id
    INTO v_frozen, v_status, v_org, v_job, v_work_order
  FROM public.group_work_orders g
  WHERE g.id = p_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status = 'void' THEN
    RAISE EXCEPTION 'group_work_order_void' USING ERRCODE = '23514';
  END IF;

  IF v_frozen IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', s.id,
      'user_id', s.user_id,
      'hours', s.hours,
      'points', s.points,
      'share_ex', s.share_ex,
      'pot_ex', s.pot_ex
    ) ORDER BY s.user_id::text COLLATE "C"), '[]'::jsonb)
      INTO v_shares
    FROM public.group_work_order_shares s
    WHERE s.group_id = p_group_id;
    RETURN jsonb_build_object('frozen', true, 'shares', v_shares);
  END IF;

  SELECT wo.agreed_labour_ex INTO v_pot
  FROM public.work_orders wo
  WHERE wo.id = v_work_order
    AND wo.kind = 'job'
    AND wo.status = 'approved'
    AND wo.sealed_content_hash IS NOT NULL
    AND wo.agreed_labour_ex > 0;
  IF NOT FOUND OR v_pot IS NULL THEN
    RAISE EXCEPTION 'group_pot_missing' USING ERRCODE = '23514';
  END IF;
  v_pot_cents := round(v_pot * 100)::bigint;

  CREATE TEMP TABLE IF NOT EXISTS group_wo_entries (
    user_id uuid,
    hours numeric,
    rate numeric
  ) ON COMMIT DROP;
  TRUNCATE group_wo_entries;

  INSERT INTO group_wo_entries (user_id, hours, rate)
  SELECT e.user_id, e.hours, r.hourly_rate
  FROM public.group_work_order_time_entries e
  JOIN public.group_work_order_participants p
    ON p.group_id = e.group_id AND p.user_id = e.user_id
  LEFT JOIN LATERAL (
    SELECT tr.hourly_rate
    FROM public.trade_rates tr
    WHERE tr.user_id = e.user_id
      AND tr.org_id = v_org
      AND tr.effective_from <= e.work_date
      AND (tr.effective_to IS NULL OR tr.effective_to >= e.work_date)
    ORDER BY tr.effective_from DESC
    LIMIT 1
  ) r ON true
  WHERE e.group_id = p_group_id
    AND e.hours > 0
    AND public.group_work_order_assignment_covers(v_job, e.user_id, e.work_date);

  -- Every participant, and every installer currently assigned to the job,
  -- needs a counting hour. An assigned person who has not joined is named
  -- the same way. Office removes a participant only before the freeze.
  SELECT string_agg(missing.user_id, ',' ORDER BY missing.user_id COLLATE "C")
    INTO v_needs_hours
  FROM (
    SELECT p.user_id::text AS user_id
    FROM public.group_work_order_participants p
    WHERE p.group_id = p_group_id
      AND NOT EXISTS (
        SELECT 1 FROM group_wo_entries e WHERE e.user_id = p.user_id
      )
    UNION
    SELECT DISTINCT a.user_id::text
    FROM public.job_assignments a
    WHERE a.job_id = v_job
      AND COALESCE(to_jsonb(a)->>'status', '') IS DISTINCT FROM 'cancelled'
      AND COALESCE(to_jsonb(a)->>'role', '') IS DISTINCT FROM 'observer'
      AND COALESCE(to_jsonb(a)->>'is_ghost', 'false') IS DISTINCT FROM 'true'
      AND NOT EXISTS (
        SELECT 1 FROM group_wo_entries e WHERE e.user_id = a.user_id
      )
  ) missing;
  IF v_needs_hours IS NOT NULL THEN
    RAISE EXCEPTION 'group_split_needs_hours: %', v_needs_hours USING ERRCODE = '23514';
  END IF;

  -- A missing rate row is not the same as a zero rate. The person has hours
  -- and no trade_rates row, so the freeze and the projection both refuse
  -- and name them. A rate that rounds to 0 cents stays needs_rate below.
  SELECT string_agg(missing.user_id, ',' ORDER BY missing.user_id COLLATE "C")
    INTO v_missing_rate
  FROM (
    SELECT DISTINCT e.user_id::text AS user_id
    FROM group_wo_entries e
    WHERE e.rate IS NULL
  ) missing;
  IF v_missing_rate IS NOT NULL THEN
    RAISE EXCEPTION 'group_share_rate_missing: %', v_missing_rate USING ERRCODE = '23514';
  END IF;

  SELECT string_agg(missing.user_id, ',' ORDER BY missing.user_id COLLATE "C")
    INTO v_needs_rate
  FROM (
    SELECT DISTINCT e.user_id::text AS user_id
    FROM group_wo_entries e
    WHERE e.rate <= 0 OR round(e.rate * 100) <= 0
  ) missing;
  IF v_needs_rate IS NOT NULL THEN
    RAISE EXCEPTION 'group_participant_needs_rate: %', v_needs_rate USING ERRCODE = '23514';
  END IF;

  IF NOT public.group_client_signoff_counts(v_job) THEN
    RAISE EXCEPTION 'group_client_signoff_required' USING ERRCODE = '23514';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS group_wo_split_points (
    user_id uuid,
    hours numeric,
    points_micro bigint,
    floor_cents bigint,
    remainder bigint,
    share_cents bigint
  ) ON COMMIT DROP;
  TRUNCATE group_wo_split_points;

  INSERT INTO group_wo_split_points (user_id, hours, points_micro)
  SELECT e.user_id,
         sum(e.hours),
         sum((round(e.rate * 100))::bigint * (round(e.hours * 100))::bigint)
  FROM group_wo_entries e
  GROUP BY e.user_id
  HAVING sum((round(e.rate * 100))::bigint * (round(e.hours * 100))::bigint) > 0;

  SELECT COALESCE(sum(points_micro), 0), count(*)
    INTO v_total, v_count
  FROM group_wo_split_points;
  IF v_count = 0 OR v_total <= 0 THEN
    RAISE EXCEPTION 'group_share_hours_missing' USING ERRCODE = '23514';
  END IF;

  UPDATE group_wo_split_points
  SET floor_cents = (v_pot_cents * points_micro) / v_total,
      remainder = (v_pot_cents * points_micro) % v_total;

  SELECT COALESCE(sum(floor_cents), 0) INTO v_sum_floor FROM group_wo_split_points;
  v_leftover := v_pot_cents - v_sum_floor;
  IF v_leftover < 0 OR v_leftover >= v_count THEN
    RAISE EXCEPTION 'group_share_rounding_failed' USING ERRCODE = '23514';
  END IF;

  UPDATE group_wo_split_points p
  SET share_cents = p.floor_cents + CASE WHEN ranked.rn <= v_leftover THEN 1 ELSE 0 END
  FROM (
    SELECT user_id,
           row_number() OVER (
             ORDER BY remainder DESC, user_id::text COLLATE "C" ASC
           ) AS rn
    FROM group_wo_split_points
  ) ranked
  WHERE ranked.user_id = p.user_id;

  IF NOT p_freeze THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', NULL,
      'user_id', p.user_id,
      'hours', round(p.hours, 2),
      'points', round(p.points_micro::numeric / 10000, 4),
      'share_ex', round(p.share_cents::numeric / 100, 2),
      'pot_ex', round(v_pot, 2)
    ) ORDER BY p.user_id::text COLLATE "C"), '[]'::jsonb)
      INTO v_shares
    FROM group_wo_split_points p;
    RETURN jsonb_build_object('frozen', false, 'shares', v_shares);
  END IF;

  PERFORM set_config('group_wo.rewriting', 'on', true);

  DELETE FROM public.group_work_order_shares s
  WHERE s.group_id = p_group_id
    AND NOT EXISTS (
      SELECT 1 FROM group_wo_split_points p WHERE p.user_id = s.user_id
    );

  INSERT INTO public.group_work_order_shares (
    group_id, user_id, hours, points, share_ex, pot_ex, computed_at
  )
  SELECT p_group_id,
         p.user_id,
         round(p.hours, 2),
         round(p.points_micro::numeric / 10000, 4),
         round(p.share_cents::numeric / 100, 2),
         round(v_pot, 2),
         now()
  FROM group_wo_split_points p
  ON CONFLICT (group_id, user_id) DO UPDATE SET
    hours = EXCLUDED.hours,
    points = EXCLUDED.points,
    share_ex = EXCLUDED.share_ex,
    pot_ex = EXCLUDED.pot_ex,
    computed_at = EXCLUDED.computed_at;

  UPDATE public.group_work_orders
  SET split_frozen_at = now(), updated_at = now()
  WHERE id = p_group_id;

  PERFORM set_config('group_wo.rewriting', 'off', true);

  INSERT INTO public.group_work_order_events (group_id, job_id, action, detail)
  VALUES (
    p_group_id, v_job, 'freeze',
    jsonb_build_object('pot_ex', round(v_pot, 2))
  );

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'user_id', s.user_id,
    'hours', s.hours,
    'points', s.points,
    'share_ex', s.share_ex,
    'pot_ex', s.pot_ex
  ) ORDER BY s.user_id::text COLLATE "C"), '[]'::jsonb)
    INTO v_shares
  FROM public.group_work_order_shares s
  WHERE s.group_id = p_group_id;
  RETURN jsonb_build_object('frozen', true, 'shares', v_shares);
END;
$$;

CREATE OR REPLACE FUNCTION public.project_group_work_order_split(p_group_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.group_work_order_write_split(p_group_id, false);
$$;

CREATE OR REPLACE FUNCTION public.freeze_group_work_order_split(p_group_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.group_work_order_write_split(p_group_id, true);
$$;

-- Remove only the share line and recalculate the invoice. Do not
-- ops-reject the trade's week. Refuses while a weekly submit holds the
-- invoice lock, or the share sits on pending_acknowledgment or later, or
-- any Xero id or push stamp. Draft and queried can still be stripped.
CREATE OR REPLACE FUNCTION public.unfreeze_group_work_order_split(
  p_group_id uuid,
  p_actor uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job uuid;
  v_org uuid;
  v_stripped uuid[];
BEGIN
  -- Weekly persist locks 'weekly-trade-invoice:' || org before any job
  -- lock. Take that lock first and do not wait: a submit already holding
  -- it is busy, try again (group_split_busy). A live invoice is a
  -- different refusal, checked after the lock is held. Then the job
  -- lock, then the row.
  SELECT g.job_id, g.org_id INTO v_job, v_org
  FROM public.group_work_orders g
  WHERE g.id = p_group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended('weekly-trade-invoice:' || v_org::text, 0)
  ) THEN
    RAISE EXCEPTION 'group_split_busy: busy, try again' USING ERRCODE = '23514';
  END IF;
  PERFORM public.group_work_order_lock_job(v_job);
  SELECT g.job_id INTO v_job
  FROM public.group_work_orders g
  WHERE g.id = p_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.group_work_order_shares s
    JOIN public.trade_invoice_lines l ON l.group_share_id = s.id
    JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
    WHERE s.group_id = p_group_id
      AND (
        i.status IN (
          'pending_acknowledgment',
          'acknowledged', 'pending_ops_review', 'approved',
          'pushed_to_xero', 'paid'
        )
        OR NULLIF(btrim(i.xero_bill_id), '') IS NOT NULL
        OR i.xero_pushed_at IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'group_split_has_live_invoice' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT l.trade_invoice_id), ARRAY[]::uuid[])
    INTO v_stripped
  FROM public.group_work_order_shares s
  JOIN public.trade_invoice_lines l ON l.group_share_id = s.id
  WHERE s.group_id = p_group_id;

  DELETE FROM public.trade_invoice_lines l
  USING public.group_work_order_shares s
  WHERE l.group_share_id = s.id
    AND s.group_id = p_group_id;

  -- Same split as trade_invoice_money: super 12% of the remaining line
  -- sum, worker withhold 6%, net is that sum minus the withhold, GST on
  -- the sum when gst_on. A recurring deduction stays off gross. If it is
  -- now more than the reduced payable (net + GST) it is cleared in this
  -- same update, with the office note, unless that payable is 0, in which
  -- case the note is cleared too. A deduction that still fits is left
  -- unchanged. An invoice whose money columns are all null (gst_on null)
  -- is left alone. A weekly work order also rewrites its three headers
  -- from the lines that remain: final-payout deductions are the negative
  -- lines, to_be_paid is the line sum, and the job grand is that sum plus
  -- those deductions. A weekly invoice whose to_be_paid would not stay
  -- positive fails its check and this unfreeze rolls back. Any other
  -- source leaves those three columns as they are (null).
  UPDATE public.trade_invoices i
  SET subtotal_ex = m.line_sum,
      gross_earned = m.line_sum,
      super_rate = 0.12,
      super_amount = round(m.line_sum * 0.12, 2),
      net_pay = m.new_net,
      gst = m.new_gst,
      total_inc = round(m.line_sum + m.new_gst, 2),
      job_grand_total_ex = CASE
        WHEN i.invoice_source = 'weekly_work_order'
          THEN round(m.line_sum + m.final_deductions, 2)
        ELSE i.job_grand_total_ex
      END,
      final_deductions_total_ex = CASE
        WHEN i.invoice_source = 'weekly_work_order' THEN m.final_deductions
        ELSE i.final_deductions_total_ex
      END,
      to_be_paid_ex = CASE
        WHEN i.invoice_source = 'weekly_work_order' THEN m.line_sum
        ELSE i.to_be_paid_ex
      END,
      recurring_deduction_id = CASE
        WHEN i.recurring_deduction_amount IS NOT NULL
         AND i.recurring_deduction_amount > m.payable
        THEN NULL
        ELSE i.recurring_deduction_id
      END,
      recurring_deduction_label = CASE
        WHEN i.recurring_deduction_amount IS NOT NULL
         AND i.recurring_deduction_amount > m.payable
        THEN NULL
        ELSE i.recurring_deduction_label
      END,
      recurring_deduction_amount = CASE
        WHEN i.recurring_deduction_amount IS NOT NULL
         AND i.recurring_deduction_amount > m.payable
        THEN NULL
        ELSE i.recurring_deduction_amount
      END,
      recurring_deduction_note = CASE
        WHEN i.recurring_deduction_amount IS NOT NULL
         AND i.recurring_deduction_amount > m.payable
        THEN CASE
          WHEN m.payable = 0 THEN NULL
          ELSE i.recurring_deduction_label || ' $'
            || to_char(i.recurring_deduction_amount, 'FM999999990.00')
            || ' NOT taken for the week starting '
            || to_char(i.week_start, 'YYYY-MM-DD')
            || ': the amount payable on this invoice ($'
            || to_char(m.payable, 'FM999999990.00')
            || ') is less than the deduction. Nothing was taken off. The office to recover it another way.'
        END
        ELSE i.recurring_deduction_note
      END
  FROM (
    SELECT raw.id,
           raw.line_sum,
           raw.final_deductions,
           round(raw.line_sum - round(raw.line_sum * 0.06, 2), 2) AS new_net,
           CASE WHEN raw.gst_on THEN round(raw.line_sum * 0.10, 2) ELSE 0 END AS new_gst,
           round(
             round(raw.line_sum - round(raw.line_sum * 0.06, 2), 2)
             + CASE WHEN raw.gst_on THEN round(raw.line_sum * 0.10, 2) ELSE 0 END,
             2
           ) AS payable
    FROM (
      SELECT i2.id,
             i2.gst_on,
             COALESCE(round(sum(l.line_total_ex), 2), 0) AS line_sum,
             COALESCE(round(-sum(l.line_total_ex) FILTER (
               WHERE replace(replace(lower(btrim(COALESCE(l.line_type, ''))), '_', ' '), ' ', '')
                 = 'finalpayoutdeduction'
             ), 2), 0) AS final_deductions
      FROM public.trade_invoices i2
      LEFT JOIN public.trade_invoice_lines l ON l.trade_invoice_id = i2.id
      WHERE i2.id = ANY (v_stripped)
        AND i2.gst_on IS NOT NULL
      GROUP BY i2.id
    ) raw
  ) m
  WHERE i.id = m.id;

  UPDATE public.group_work_orders
  SET split_frozen_at = NULL, updated_at = now()
  WHERE id = p_group_id;

  PERFORM set_config('group_wo.rewriting', 'on', true);
  DELETE FROM public.group_work_order_shares s WHERE s.group_id = p_group_id;
  PERFORM set_config('group_wo.rewriting', 'off', true);

  INSERT INTO public.group_work_order_events (group_id, job_id, action, actor_user_id, detail)
  VALUES (
    p_group_id, v_job, 'unfreeze', p_actor,
    jsonb_build_object('stripped_invoice_ids', to_jsonb(v_stripped))
  );

  RETURN jsonb_build_object(
    'frozen', false,
    'shares', '[]'::jsonb,
    'stripped_invoice_ids', to_jsonb(v_stripped)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.void_group_work_order(
  p_group_id uuid,
  p_actor uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job uuid;
  v_status text;
BEGIN
  -- No row lock before unfreeze. unfreeze takes the weekly invoice lock,
  -- then the job lock, then FOR UPDATE: the same order as persist.
  SELECT g.job_id, g.status INTO v_job, v_status
  FROM public.group_work_orders g
  WHERE g.id = p_group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status = 'void' THEN
    RETURN jsonb_build_object('void', true, 'already', true);
  END IF;
  PERFORM public.unfreeze_group_work_order_split(p_group_id, p_actor);
  UPDATE public.group_work_orders
  SET status = 'void',
      voided_at = now(),
      void_reason = left(COALESCE(NULLIF(btrim(p_reason), ''), 'voided'), 500),
      updated_at = now()
  WHERE id = p_group_id;
  INSERT INTO public.group_work_order_events (group_id, job_id, action, actor_user_id, detail)
  VALUES (p_group_id, v_job, 'void_group', p_actor, jsonb_build_object('reason', left(COALESCE(p_reason, ''), 500)));
  RETURN jsonb_build_object('void', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.rekey_group_work_order(
  p_group_id uuid,
  p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job uuid;
  v_frozen timestamptz;
  v_status text;
  v_current uuid;
  v_wo uuid;
BEGIN
  SELECT g.job_id, g.split_frozen_at, g.status, g.work_order_id
    INTO v_job, v_frozen, v_status, v_current
  FROM public.group_work_orders g
  WHERE g.id = p_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status = 'void' THEN
    RAISE EXCEPTION 'group_work_order_void' USING ERRCODE = '23514';
  END IF;
  IF v_frozen IS NOT NULL THEN
    RAISE EXCEPTION 'group_split_frozen' USING ERRCODE = '23514';
  END IF;
  SELECT j.work_order_id INTO v_wo FROM public.jobs j WHERE j.id = v_job;
  IF v_wo IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.work_orders wo
    WHERE wo.id = v_wo
      AND wo.kind = 'job'
      AND wo.status = 'approved'
      AND wo.sealed_content_hash IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'group_pot_missing' USING ERRCODE = '23514';
  END IF;
  UPDATE public.group_work_orders
  SET work_order_id = v_wo, updated_at = now()
  WHERE id = p_group_id;
  INSERT INTO public.group_work_order_events (group_id, job_id, action, actor_user_id, detail)
  VALUES (
    p_group_id, v_job, 'rekey', p_actor,
    jsonb_build_object('from_work_order_id', v_current, 'work_order_id', v_wo)
  );
  RETURN jsonb_build_object('work_order_id', v_wo);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_group_client_signoff(
  p_group_id uuid,
  p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job uuid;
  v_org uuid;
  v_status text;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'group_actor_required' USING ERRCODE = '23514';
  END IF;
  SELECT g.job_id, g.org_id, g.status INTO v_job, v_org, v_status
  FROM public.group_work_orders g
  WHERE g.id = p_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.job_client_signoffs (
    org_id, job_id, method, captured_by, captured_by_actor
  ) VALUES (
    v_org, v_job, 'revoked', p_actor, 'user:' || p_actor::text
  );
  UPDATE public.group_work_orders
  SET client_signed_at = NULL,
      status = CASE WHEN status = 'client_signed' THEN 'open' ELSE status END,
      updated_at = now()
  WHERE id = p_group_id;
  INSERT INTO public.group_work_order_events (group_id, job_id, action, actor_user_id, detail)
  VALUES (p_group_id, v_job, 'revoke_signoff', p_actor, '{}'::jsonb);
  RETURN jsonb_build_object('revoked', true);
END;
$$;

COMMENT ON FUNCTION public.group_work_order_write_split(uuid, boolean) IS
  'Locks the group. p_freeze false returns figures and stores nothing. p_freeze true writes one snapshot after hours, rates and a counting client sign-off. Service role only.';
COMMENT ON FUNCTION public.freeze_group_work_order_split(uuid) IS
  'Explicit freeze. Does not run from a share read. A later failed invoice does not clear a freeze this call already committed.';
COMMENT ON FUNCTION public.project_group_work_order_split(uuid) IS
  'Quote only. Never sets split_frozen_at and never writes share rows.';
COMMENT ON FUNCTION public.unfreeze_group_work_order_split(uuid, uuid) IS
  'Office. A busy weekly lock is group_split_busy. A share invoice acknowledged or later, or with a Xero id or push stamp, is group_split_has_live_invoice. Before that, deletes only the share line, recalculates the invoice, clears a recurring deduction that no longer fits, and clears the snapshot. Does not ops-reject the week and does not recompute.';

REVOKE ALL ON FUNCTION public.group_work_order_assignment_covers(uuid, uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_client_signoff_counts(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_work_order_write_split(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_group_work_order_split(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.freeze_group_work_order_split(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unfreeze_group_work_order_split(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.void_group_work_order(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rekey_group_work_order(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revoke_group_client_signoff(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_work_order_assignment_covers(uuid, uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_client_signoff_counts(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_work_order_write_split(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_group_work_order_split(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.freeze_group_work_order_split(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.unfreeze_group_work_order_split(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.void_group_work_order(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rekey_group_work_order(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.revoke_group_client_signoff(uuid, uuid) TO service_role;

-- ── 13. hours only on an assignment day, and only before the freeze ────────

CREATE OR REPLACE FUNCTION public.group_work_order_time_entries_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job uuid;
  v_frozen timestamptz;
  v_row public.group_work_order_time_entries;
BEGIN
  v_row := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  SELECT g.job_id, g.split_frozen_at INTO v_job, v_frozen
  FROM public.group_work_orders g
  WHERE g.id = v_row.group_id
  FOR UPDATE;
  IF v_frozen IS NOT NULL THEN
    RAISE EXCEPTION 'group_split_frozen' USING ERRCODE = '23514';
  END IF;
  -- Saving the same day again must not move updated_at or hours_changed_at,
  -- so a client drawing newer than the real hours stays valid. A frozen
  -- group still refuses above, including an identical write.
  IF TG_OP = 'UPDATE'
     AND NEW.work_date IS NOT DISTINCT FROM OLD.work_date
     AND NEW.start_time IS NOT DISTINCT FROM OLD.start_time
     AND NEW.finish_time IS NOT DISTINCT FROM OLD.finish_time
     AND NEW.break_minutes IS NOT DISTINCT FROM OLD.break_minutes
     AND NEW.hours IS NOT DISTINCT FROM OLD.hours
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
     AND NEW.group_id IS NOT DISTINCT FROM OLD.group_id
  THEN
    NEW.updated_at := OLD.updated_at;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NOT public.group_work_order_assignment_covers(v_job, NEW.user_id, NEW.work_date) THEN
      RAISE EXCEPTION 'group_hours_not_assigned' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- now() is the transaction start. A sign-off inserted later in the same
  -- transaction uses clock_timestamp(), so a real edit has to move past it.
  UPDATE public.group_work_orders
  SET hours_changed_at = clock_timestamp()
  WHERE id = v_row.group_id;
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := clock_timestamp();
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_group_work_order_time_entries_guard
  ON public.group_work_order_time_entries;
CREATE TRIGGER trg_group_work_order_time_entries_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.group_work_order_time_entries
  FOR EACH ROW EXECUTE FUNCTION public.group_work_order_time_entries_guard();

-- A joiner who commits before the freeze lock is in the snapshot if they
-- have hours. A joiner who waits sees the marker and is refused.
CREATE OR REPLACE FUNCTION public.group_work_order_refuse_late_joiner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_frozen timestamptz;
BEGIN
  SELECT g.split_frozen_at INTO v_frozen
  FROM public.group_work_orders g
  WHERE g.id = NEW.group_id
  FOR UPDATE;
  IF v_frozen IS NOT NULL THEN
    RAISE EXCEPTION 'group_split_frozen' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_group_work_order_refuse_late_joiner
  ON public.group_work_order_participants;
CREATE TRIGGER trg_group_work_order_refuse_late_joiner
  BEFORE INSERT ON public.group_work_order_participants
  FOR EACH ROW EXECUTE FUNCTION public.group_work_order_refuse_late_joiner();

CREATE OR REPLACE FUNCTION public.group_work_order_shares_frozen_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_group uuid;
  v_frozen timestamptz;
BEGIN
  v_group := CASE WHEN TG_OP = 'DELETE' THEN OLD.group_id ELSE NEW.group_id END;
  SELECT g.split_frozen_at INTO v_frozen
  FROM public.group_work_orders g
  WHERE g.id = v_group
  FOR UPDATE;
  IF v_frozen IS NOT NULL
     AND current_setting('group_wo.rewriting', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'group_split_frozen' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_group_work_order_shares_frozen_guard
  ON public.group_work_order_shares;
CREATE TRIGGER trg_group_work_order_shares_frozen_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.group_work_order_shares
  FOR EACH ROW EXECUTE FUNCTION public.group_work_order_shares_frozen_guard();

-- One lock per job, taken before any row lock, so a share and a normal pay
-- line cannot both land. Re-entrant in the same transaction.
CREATE OR REPLACE FUNCTION public.group_work_order_lock_job(p_job uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_job IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(p_job::text)::bigint);
END;
$$;

-- On a group job every invoice line counts as pay except travel, materials,
-- equipment, an adjustment, a final-payout deduction, commission, and the
-- share itself. 'Other' counts: live Other lines are labour. An unknown
-- type counts too, with or without a source work order. Pending Marnin.
-- Membership is this function; the trigger does not keep a second list.
CREATE OR REPLACE FUNCTION public.group_work_order_line_is_normal_pay(
  p_line_type text,
  p_source_work_order_id uuid
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    (p_source_work_order_id IS NULL OR p_source_work_order_id IS NOT NULL)
    AND NOT (
      replace(replace(lower(btrim(COALESCE(p_line_type, ''))), '_', ' '), ' ', '')
      IN (
        'groupshare', 'commission', 'travel', 'materials', 'equipment',
        'adjustment', 'finalpayoutdeduction'
      )
    );
$$;

CREATE OR REPLACE FUNCTION public.group_work_orders_refuse_existing_pay()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM public.group_work_order_lock_job(NEW.job_id);
  IF EXISTS (
    SELECT 1
    FROM public.trade_invoice_lines l
    JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
    WHERE l.job_id = NEW.job_id
      AND i.status IS DISTINCT FROM 'ops-reject'
      AND public.group_work_order_line_is_normal_pay(l.line_type, l.source_work_order_id)
  ) THEN
    RAISE EXCEPTION 'group_open_blocked_by_work_order_claim' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_group_work_orders_refuse_existing_pay ON public.group_work_orders;
CREATE TRIGGER trg_group_work_orders_refuse_existing_pay
  BEFORE INSERT ON public.group_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.group_work_orders_refuse_existing_pay();

CREATE OR REPLACE FUNCTION public.group_work_orders_void_permanent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'void' AND NEW.status IS DISTINCT FROM 'void' THEN
    RAISE EXCEPTION 'group_work_order_void' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_group_work_orders_void_permanent ON public.group_work_orders;
CREATE TRIGGER trg_group_work_orders_void_permanent
  BEFORE UPDATE ON public.group_work_orders
  FOR EACH ROW EXECUTE FUNCTION public.group_work_orders_void_permanent();

-- Office. Deletes this person's hours and participant row. Refused once
-- frozen or void. Does not cancel their job assignment.
CREATE OR REPLACE FUNCTION public.remove_group_work_order_participant(
  p_group_id uuid,
  p_user uuid,
  p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_job uuid;
  v_frozen timestamptz;
  v_status text;
BEGIN
  IF p_actor IS NULL OR p_user IS NULL THEN
    RAISE EXCEPTION 'group_actor_required' USING ERRCODE = '23514';
  END IF;
  SELECT g.job_id INTO v_job
  FROM public.group_work_orders g
  WHERE g.id = p_group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.group_work_order_lock_job(v_job);
  SELECT g.job_id, g.split_frozen_at, g.status
    INTO v_job, v_frozen, v_status
  FROM public.group_work_orders g
  WHERE g.id = p_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_status = 'void' THEN
    RAISE EXCEPTION 'group_work_order_void' USING ERRCODE = '23514';
  END IF;
  IF v_frozen IS NOT NULL THEN
    RAISE EXCEPTION 'group_split_frozen' USING ERRCODE = '23514';
  END IF;
  DELETE FROM public.group_work_order_time_entries
  WHERE group_id = p_group_id AND user_id = p_user;
  DELETE FROM public.group_work_order_participants
  WHERE group_id = p_group_id AND user_id = p_user;
  -- The hour delete already moves the stamp when this person had hours.
  -- A person with none still invalidates a drawing that was signed while
  -- they were on the group.
  UPDATE public.group_work_orders
  SET hours_changed_at = clock_timestamp()
  WHERE id = p_group_id;
  INSERT INTO public.group_work_order_events (group_id, job_id, action, actor_user_id, detail)
  VALUES (
    p_group_id, v_job, 'remove_participant', p_actor,
    jsonb_build_object('user_id', p_user)
  );
  RETURN jsonb_build_object('removed', true, 'user_id', p_user);
END;
$$;

-- A non-draft share line locks the group and, when the marker is still
-- null, freezes in this same statement so a failed insert rolls the marker
-- back. A draft save stores the line, leaves the marker alone, and does
-- not hold the share: a later save or a submit can replace it. A draft
-- does not count as invoiced. A second live non-draft line for the same
-- share is refused, and the invoice owner must be the share owner. A
-- share is also refused when normal pay already exists on the job, and a
-- normal pay line is refused when a group is open. The flag is not read:
-- this holds with the switch off.
-- UPDATE is limited to the share pointer and the amount so a status stamp
-- on the invoice does not re-enter this check.
CREATE OR REPLACE FUNCTION public.trade_invoice_lines_group_share_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_type text;
  v_group uuid;
  v_job uuid;
  v_invoice_user uuid;
  v_invoice_status text;
  v_share_id uuid;
  v_share_user uuid;
  v_share_ex numeric;
  v_frozen timestamptz;
  v_groups int;
BEGIN
  v_type := lower(btrim(COALESCE(NEW.line_type, '')));

  IF v_type = 'group share' OR NEW.group_share_id IS NOT NULL THEN
    IF NEW.job_id IS NULL OR NEW.trade_invoice_id IS NULL THEN
      RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
    END IF;
    PERFORM public.group_work_order_lock_job(NEW.job_id);
    SELECT count(*) INTO v_groups
    FROM public.group_work_orders g
    WHERE g.job_id = NEW.job_id AND g.status <> 'void';
    IF v_groups = 0 THEN
      RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_groups > 1 THEN
      RAISE EXCEPTION 'group_work_order_ambiguous' USING ERRCODE = '23514';
    END IF;
    SELECT g.id, g.job_id, g.split_frozen_at
      INTO v_group, v_job, v_frozen
    FROM public.group_work_orders g
    WHERE g.job_id = NEW.job_id AND g.status <> 'void'
    FOR UPDATE;
    IF EXISTS (
      SELECT 1
      FROM public.trade_invoice_lines l
      JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
      WHERE l.job_id = NEW.job_id
        AND l.id IS DISTINCT FROM NEW.id
        AND i.status IS DISTINCT FROM 'ops-reject'
        AND public.group_work_order_line_is_normal_pay(l.line_type, l.source_work_order_id)
    ) THEN
      RAISE EXCEPTION 'group_share_blocked_by_work_order_claim' USING ERRCODE = '23514';
    END IF;
    SELECT i.user_id, i.status INTO v_invoice_user, v_invoice_status
    FROM public.trade_invoices i
    WHERE i.id = NEW.trade_invoice_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'group_share_owner_mismatch' USING ERRCODE = '23514';
    END IF;
    IF NOT public.group_client_signoff_counts(v_job) THEN
      RAISE EXCEPTION 'group_client_signoff_required' USING ERRCODE = '23514';
    END IF;
    -- A draft does not freeze and does not hold the share. A non-draft
    -- line freezes in this statement when the marker is still null.
    IF v_invoice_status = 'draft' AND v_frozen IS NULL THEN
      NEW.group_share_id := NULL;
      NEW.line_type := 'group share';
      NEW.source_work_order_id := NULL;
      RETURN NEW;
    END IF;
    IF v_invoice_status IS DISTINCT FROM 'draft' AND v_frozen IS NULL THEN
      PERFORM public.group_work_order_write_split(v_group, true);
    END IF;
    SELECT s.id, s.user_id, s.share_ex
      INTO v_share_id, v_share_user, v_share_ex
    FROM public.group_work_order_shares s
    WHERE s.group_id = v_group AND s.user_id = v_invoice_user;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'group_share_not_in_split' USING ERRCODE = '23514';
    END IF;
    IF NEW.group_share_id IS NOT NULL AND NEW.group_share_id IS DISTINCT FROM v_share_id THEN
      RAISE EXCEPTION 'group_share_owner_mismatch' USING ERRCODE = '23514';
    END IF;
    IF v_invoice_user IS DISTINCT FROM v_share_user THEN
      RAISE EXCEPTION 'group_share_owner_mismatch' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.trade_invoice_lines l
      JOIN public.trade_invoices i ON i.id = l.trade_invoice_id
      WHERE l.group_share_id = v_share_id
        AND l.id IS DISTINCT FROM NEW.id
        AND i.status IS DISTINCT FROM 'ops-reject'
        AND i.status IS DISTINCT FROM 'draft'
    ) THEN
      RAISE EXCEPTION 'group_share_already_invoiced' USING ERRCODE = '23514';
    END IF;
    IF NEW.line_total_ex IS DISTINCT FROM v_share_ex THEN
      RAISE EXCEPTION 'group_share_amount_mismatch' USING ERRCODE = '23514';
    END IF;
    NEW.group_share_id := v_share_id;
    NEW.line_type := 'group share';
    NEW.source_work_order_id := NULL;
    RETURN NEW;
  END IF;

  IF NEW.job_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF public.group_work_order_line_is_normal_pay(NEW.line_type, NEW.source_work_order_id) THEN
    PERFORM public.group_work_order_lock_job(NEW.job_id);
    IF EXISTS (
      SELECT 1 FROM public.group_work_orders g
      WHERE g.job_id = NEW.job_id AND g.status <> 'void'
    ) THEN
      RAISE EXCEPTION 'work_order_claim_blocked_by_group_share' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trade_invoice_lines_group_share_snapshot
  ON public.trade_invoice_lines;
CREATE TRIGGER trg_trade_invoice_lines_group_share_snapshot
  BEFORE INSERT OR UPDATE OF group_share_id, line_total_ex
  ON public.trade_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.trade_invoice_lines_group_share_snapshot();

REVOKE ALL ON FUNCTION public.group_work_order_time_entries_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_work_order_refuse_late_joiner() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_work_order_shares_frozen_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trade_invoice_lines_group_share_snapshot() FROM PUBLIC, anon, authenticated;
-- SECURITY DEFINER writers run as the owner, who keeps EXECUTE after a
-- revoke from PUBLIC. The invoice trigger is not security definer: it
-- runs as service_role, which is granted below. anon, authenticated and
-- PUBLIC must not call the job lock directly.
REVOKE ALL ON FUNCTION public.group_work_order_lock_job(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.remove_group_work_order_participant(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_work_order_time_entries_guard() TO service_role;
GRANT EXECUTE ON FUNCTION public.group_work_order_refuse_late_joiner() TO service_role;
GRANT EXECUTE ON FUNCTION public.group_work_order_shares_frozen_guard() TO service_role;
GRANT EXECUTE ON FUNCTION public.trade_invoice_lines_group_share_snapshot() TO service_role;
GRANT EXECUTE ON FUNCTION public.group_work_order_lock_job(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_work_order_line_is_normal_pay(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_work_orders_refuse_existing_pay() TO service_role;
GRANT EXECUTE ON FUNCTION public.group_work_orders_void_permanent() TO service_role;
GRANT EXECUTE ON FUNCTION public.remove_group_work_order_participant(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.group_work_order_signature_ok(text) TO service_role;
