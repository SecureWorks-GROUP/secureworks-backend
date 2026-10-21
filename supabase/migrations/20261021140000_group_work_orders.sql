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
-- The first time a share is priced for an invoice, group_work_order_write_split
-- locks the group row and writes one snapshot. A second caller waits, then
-- reads that snapshot and does not write its own. split_frozen_at is the
-- marker. A share line is refused unless that marker is set and the line
-- amount is the snapshot's share_ex. A person who arrives after the marker
-- is refused. The office unfreeze clears the marker and recomputes in the
-- same locked transaction, and only while no share sits on a live invoice.

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

-- ── 11. one frozen snapshot ─────────────────────────────────────────────────
--
-- group_work_order_write_split is the only writer of share rows that invoice
-- lines may follow. It locks the group, and if split_frozen_at is already
-- set it returns those rows and writes nothing. Otherwise it computes the
-- pot here (the same floor-and-remainder rule as allocatePotCents) and
-- upserts the snapshot. p_freeze sets the marker after the rows are written.
-- Preview passes false and leaves the marker null.
--
-- Points are rate cents times hour hundredths, summed per person. Rates are
-- numeric(8,2), so times 100 is an integer. Postgres round() on those
-- positives matches the TypeScript Math.round used by entryPointsMicro.
-- Leftover cents go to the largest remainder, and an equal remainder goes
-- to the smaller user id (COLLATE "C").

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
  v_org uuid;
  v_work_order uuid;
  v_pot numeric;
  v_pot_cents bigint;
  v_total bigint;
  v_count int;
  v_sum_floor bigint;
  v_leftover bigint;
  v_shares jsonb;
BEGIN
  SELECT g.split_frozen_at, g.org_id, g.work_order_id
    INTO v_frozen, v_org, v_work_order
  FROM public.group_work_orders g
  WHERE g.id = p_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group_work_order_not_found' USING ERRCODE = 'P0002';
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
         sum(
           (round(r.hourly_rate * 100))::bigint
           * (round(e.hours * 100))::bigint
         )
  FROM public.group_work_order_time_entries e
  JOIN LATERAL (
    SELECT tr.hourly_rate
    FROM public.trade_rates tr
    WHERE tr.user_id = e.user_id
      AND tr.org_id = v_org
      AND tr.effective_from <= e.work_date
      AND (tr.effective_to IS NULL OR tr.effective_to >= e.work_date)
      AND tr.hourly_rate > 0
    ORDER BY tr.effective_from DESC
    LIMIT 1
  ) r ON true
  WHERE e.group_id = p_group_id
    AND e.hours > 0
  GROUP BY e.user_id
  HAVING sum(
    (round(r.hourly_rate * 100))::bigint
    * (round(e.hours * 100))::bigint
  ) > 0;

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

  -- Lets the share guard allow this rewrite. The marker is still null here,
  -- and unfreeze clears it before calling this function. The guard is what
  -- stops any other writer once the marker is set.
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

  IF p_freeze THEN
    UPDATE public.group_work_orders
    SET split_frozen_at = now(), updated_at = now()
    WHERE id = p_group_id;
  END IF;

  -- The bypass is only for the writes above. Leaving it set would let the
  -- caller rewrite the snapshot later in the same transaction.
  PERFORM set_config('group_wo.rewriting', 'off', true);

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
  RETURN jsonb_build_object('frozen', p_freeze, 'shares', v_shares);
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

-- Live means the invoice is not a draft, a void, a rejection, or a failed
-- attempt. ops-reject is this database's rejected status. failed is the
-- invoice fence's released status. void and rejected are named so a later
-- status of either name does not pin the split.
CREATE OR REPLACE FUNCTION public.unfreeze_group_work_order_split(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM 1
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
      AND i.status NOT IN ('draft', 'void', 'rejected', 'failed', 'ops-reject')
  ) THEN
    RAISE EXCEPTION 'group_split_has_live_invoice' USING ERRCODE = '23514';
  END IF;

  UPDATE public.group_work_orders
  SET split_frozen_at = NULL, updated_at = now()
  WHERE id = p_group_id;

  RETURN public.group_work_order_write_split(p_group_id, false);
END;
$$;

COMMENT ON FUNCTION public.group_work_order_write_split(uuid, boolean) IS
  'Locks the group and writes one share snapshot, or returns the frozen snapshot. Service role only.';
COMMENT ON FUNCTION public.freeze_group_work_order_split(uuid) IS
  'The invoice path. Freezes the split on the first call and returns that snapshot on every later call.';
COMMENT ON FUNCTION public.project_group_work_order_split(uuid) IS
  'Preview. Recomputes only while the split is unfrozen, and does not set the marker.';
COMMENT ON FUNCTION public.unfreeze_group_work_order_split(uuid) IS
  'Office. Refuses while a share is on a live invoice, then clears the marker and recomputes under the same lock.';

REVOKE ALL ON FUNCTION public.group_work_order_write_split(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_group_work_order_split(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.freeze_group_work_order_split(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unfreeze_group_work_order_split(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.group_work_order_write_split(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_group_work_order_split(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.freeze_group_work_order_split(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.unfreeze_group_work_order_split(uuid) TO service_role;

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

-- Every other invoice line returns immediately. A share line must name a
-- frozen snapshot row and match its share_ex.
CREATE OR REPLACE FUNCTION public.trade_invoice_lines_group_share_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_share_ex numeric;
  v_group uuid;
  v_frozen timestamptz;
BEGIN
  IF NEW.group_share_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT s.share_ex, s.group_id INTO v_share_ex, v_group
  FROM public.group_work_order_shares s
  WHERE s.id = NEW.group_share_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'group_share_not_in_split' USING ERRCODE = '23514';
  END IF;
  SELECT g.split_frozen_at INTO v_frozen
  FROM public.group_work_orders g
  WHERE g.id = v_group;
  IF v_frozen IS NULL THEN
    RAISE EXCEPTION 'group_split_not_frozen' USING ERRCODE = '23514';
  END IF;
  IF NEW.line_total_ex IS NULL OR abs(NEW.line_total_ex - v_share_ex) > 0.01 THEN
    RAISE EXCEPTION 'group_share_amount_mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trade_invoice_lines_group_share_snapshot
  ON public.trade_invoice_lines;
CREATE TRIGGER trg_trade_invoice_lines_group_share_snapshot
  BEFORE INSERT OR UPDATE ON public.trade_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.trade_invoice_lines_group_share_snapshot();

REVOKE ALL ON FUNCTION public.group_work_order_refuse_late_joiner() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.group_work_order_shares_frozen_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trade_invoice_lines_group_share_snapshot() FROM PUBLIC, anon, authenticated;
-- ops-api writes as service_role. A trigger runs as that role, so the
-- function has to be executable by it or every invoice line insert fails.
GRANT EXECUTE ON FUNCTION public.group_work_order_refuse_late_joiner() TO service_role;
GRANT EXECUTE ON FUNCTION public.group_work_order_shares_frozen_guard() TO service_role;
GRANT EXECUTE ON FUNCTION public.trade_invoice_lines_group_share_snapshot() TO service_role;
