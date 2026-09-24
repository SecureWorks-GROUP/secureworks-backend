-- Quote v2, stage 3: server-side build and a stamped send. PROGRAM BRANCH
-- ONLY (program/quote-v2). Never applied to production until the owner
-- carries the program over.
--
-- * quote_v2_build_draft: a tool's or the terminal's scope becomes a draft
--   revision, the scoper's line markups (with who set them), and optionally
--   the freeze, in ONE transaction.
-- * quote_v2_party_document: what one party's quote document shows (the
--   party view plus the issue date), for the server renderer.
-- * A send is a preview the owner stamps: exact recipients, amounts, the
--   message and hashes of the rendered documents. The owner's approval must
--   echo the preview hash. Executing an approved preview issues each party a
--   fresh link and writes every message to the outbox ONCE: a retry returns
--   the same send and never writes, links or delivers twice.
-- * The outbox is capture-only by default: a captured message is never
--   delivered by anything. Live delivery exists only for previews prepared
--   with adapter 'live', which the edge function allows only in a staging
--   environment with its staging-only flag set.
--
-- New tables and functions only; the legacy send-quote paths are untouched.
-- Contract: docs/quote-v2/server-build-and-send-v1.md.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ── Build a draft in one transaction ────────────────────────────────────
-- p_markups: [{"line_key", "multiplier", "reason"?}], set by p_actor.
-- p_valid_until: freeze at once when given; null leaves a draft.
CREATE OR REPLACE FUNCTION public.quote_v2_build_draft(
  p_job_id uuid,
  p_payload jsonb,
  p_markups jsonb,
  p_actor text,
  p_valid_until date DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  rev uuid;
  mk jsonb;
  overrides jsonb := '[]'::jsonb;
  frozen jsonb;
BEGIN
  IF p_markups IS NOT NULL AND jsonb_typeof(p_markups) <> 'array' THEN
    RAISE EXCEPTION 'quote_markups_invalid: markups must be a list';
  END IF;
  rev := public.quote_v2_create_draft(p_job_id, p_payload, p_actor);
  FOR mk IN SELECT * FROM jsonb_array_elements(coalesce(p_markups, '[]'::jsonb)) LOOP
    IF jsonb_typeof(mk->'multiplier') <> 'number' THEN
      RAISE EXCEPTION 'quote_markups_invalid: % needs a numeric multiplier', mk->>'line_key';
    END IF;
    overrides := overrides || jsonb_build_object(
      'line_key', mk->>'line_key',
      'override_id', public.quote_v2_set_line_markup(
        rev, mk->>'line_key', (mk->>'multiplier')::numeric, p_actor, mk->>'reason'));
  END LOOP;
  IF p_valid_until IS NOT NULL THEN
    frozen := public.quote_v2_freeze_revision(rev, p_actor, p_valid_until);
  END IF;
  RETURN jsonb_build_object(
    'revision_id', rev,
    'revision_number', (SELECT r.revision_number FROM public.quote_v2_revisions r WHERE r.id = rev),
    'markup_overrides', overrides,
    'frozen', frozen IS NOT NULL,
    'freeze', frozen);
END $$;

-- ── What one party's quote document shows ──────────────────────────────
-- The party view (never a cost, markup, source, token or contact), plus the
-- day it was issued. Live link state (expired, accepted) is left to the page.
CREATE OR REPLACE FUNCTION public.quote_v2_party_document(p_revision_id uuid, p_party_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (public.quote_v2_party_view(p_revision_id, p_party_id) - ARRAY['expired', 'accepted_at'])
    || jsonb_build_object('issued_on', (r.frozen_at AT TIME ZONE 'Australia/Perth')::date)
  FROM public.quote_v2_revisions r
  WHERE r.id = p_revision_id AND r.status = 'frozen'
    AND public.quote_v2_party_view(p_revision_id, p_party_id) IS NOT NULL
$$;

-- A party link opened for the branded page: the same answer as
-- quote_v2_open_party_link, with the issue date on the quote.
CREATE OR REPLACE FUNCTION public.quote_v2_open_party_document(p_token text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN o->'quote' IS NULL OR jsonb_typeof(o->'quote') <> 'object' THEN o
    ELSE jsonb_set(o, '{quote,issued_on}', to_jsonb(
      (SELECT (r.frozen_at AT TIME ZONE 'Australia/Perth')::date
       FROM public.quote_v2_revisions r WHERE r.id = (o->'quote'->>'revision_id')::uuid)))
    END
  FROM public.quote_v2_open_party_link(p_token) o
$$;

-- ── Send records ────────────────────────────────────────────────────────
CREATE TABLE public.quote_v2_send_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES public.quote_v2_revisions(id),
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  adapter text NOT NULL CHECK (adapter IN ('capture', 'live')),
  -- Exactly what the owner is shown and stamps. preview_hash is the sha256
  -- of preview::text (jsonb text is canonical: keys sorted).
  preview jsonb NOT NULL CHECK (jsonb_typeof(preview) = 'object'),
  preview_hash text NOT NULL UNIQUE CHECK (preview_hash ~ '^[0-9a-f]{64}$'),
  prepared_by text NOT NULL CHECK (btrim(prepared_by) <> ''),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CHECK (preview_hash = encode(sha256(convert_to(preview::text, 'UTF8')), 'hex')),
  CHECK (expires_at > prepared_at),
  CHECK (preview->>'preview_id' = id::text)
);
COMMENT ON TABLE public.quote_v2_send_previews IS
  'Quote v2 send preview: exact recipients, amounts, message and document hashes for one frozen revision. Immutable.';

CREATE TABLE public.quote_v2_send_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preview_id uuid NOT NULL UNIQUE REFERENCES public.quote_v2_send_previews(id),
  preview_hash text NOT NULL,
  approved_by text NOT NULL CHECK (btrim(approved_by) <> ''),
  approved_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.quote_v2_send_approvals IS
  'The owner''s stamp on one exact send preview (the echoed hash). Immutable.';

CREATE TABLE public.quote_v2_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preview_id uuid NOT NULL UNIQUE REFERENCES public.quote_v2_send_previews(id),
  approval_id uuid NOT NULL REFERENCES public.quote_v2_send_approvals(id),
  revision_id uuid NOT NULL REFERENCES public.quote_v2_revisions(id),
  adapter text NOT NULL CHECK (adapter IN ('capture', 'live')),
  sent_by text NOT NULL CHECK (btrim(sent_by) <> ''),
  sent_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.quote_v2_sends IS
  'One executed send per approved preview. A retry returns this row; nothing is written or sent twice.';

-- Every message a send produced. adapter 'capture' rows are the would-be
-- email or SMS and are never delivered. The body carries the party's link, so
-- this table is as private as sent mail: service role only.
CREATE TABLE public.quote_v2_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id uuid NOT NULL REFERENCES public.quote_v2_sends(id),
  party_id uuid NOT NULL REFERENCES public.quote_v2_parties(id),
  link_id uuid NOT NULL REFERENCES public.quote_v2_party_links(id),
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  to_address text NOT NULL CHECK (btrim(to_address) <> ''),
  to_name text,
  subject text,
  body_text text NOT NULL CHECK (btrim(body_text) <> ''),
  body_html text,
  adapter text NOT NULL CHECK (adapter IN ('capture', 'live')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (send_id, party_id, channel, to_address),
  CHECK (channel <> 'email' OR (btrim(coalesce(subject, '')) <> '' AND body_html IS NOT NULL)),
  CHECK (channel <> 'sms' OR (subject IS NULL AND body_html IS NULL))
);
COMMENT ON TABLE public.quote_v2_outbox IS
  'Quote v2 outbox. Capture rows are never delivered; live rows are delivered once by the staging adapter.';

-- Delivery of live rows only. A row is 'claimed' ONCE, before any provider
-- call, then settled ONCE as delivered, failed or unknown. A second or
-- concurrent send finds the claim and delivers nothing; a claim that never
-- settled reads as unknown. Nothing is retried automatically: a person
-- reconciles an unknown or failed message.
CREATE TABLE public.quote_v2_outbox_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES public.quote_v2_outbox(id),
  outcome text NOT NULL CHECK (outcome IN ('claimed', 'delivered', 'failed', 'unknown')),
  provider_message_id text,
  detail text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX quote_v2_outbox_deliveries_claim_once
  ON public.quote_v2_outbox_deliveries (outbox_id) WHERE outcome = 'claimed';
CREATE UNIQUE INDEX quote_v2_outbox_deliveries_settle_once
  ON public.quote_v2_outbox_deliveries (outbox_id) WHERE outcome <> 'claimed';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'quote_v2_send_previews', 'quote_v2_send_approvals', 'quote_v2_sends',
    'quote_v2_outbox', 'quote_v2_outbox_deliveries']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.price_book_refuse_mutation()',
      t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.price_book_refuse_mutation()',
      t || '_no_truncate', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO service_role', t);
  END LOOP;
END $$;

-- ── Prepare a send preview ──────────────────────────────────────────────
-- p_send:
-- {
--   "adapter": "capture" | "live",
--   "link_base_url": "https://.../functions/v1/quote-v2",
--   "parties": [{"party_id",
--     "recipients": [{"channel": "email"|"sms", "to", "name"?}],
--     "messages": {"email": {"subject", "text", "html"}, "sms": {"text"}},
--     "documents": {"html_sha256", "pdf_sha256"}}]
-- }
-- Every message body carries {{quote_link}}, replaced by the party's fresh
-- link at send. Amounts, names and the revision come from the database.
CREATE OR REPLACE FUNCTION public.quote_v2_prepare_send(
  p_revision_id uuid,
  p_send jsonb,
  p_prepared_by text,
  p_ttl_minutes integer DEFAULT 60
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r public.quote_v2_revisions%ROWTYPE;
  job public.jobs%ROWTYPE;
  rp record;
  sp jsonb;
  rc jsonb;
  parties jsonb := '[]'::jsonb;
  preview jsonb;
  h text;
  pid uuid;
  prepared timestamptz := now();
  channels text[];
BEGIN
  IF btrim(coalesce(p_prepared_by, '')) = '' THEN
    RAISE EXCEPTION 'quote_actor_missing';
  END IF;
  IF p_send IS NULL OR jsonb_typeof(p_send) <> 'object' THEN
    RAISE EXCEPTION 'quote_send_invalid: send must be an object';
  END IF;
  IF p_send->>'adapter' IS NULL OR p_send->>'adapter' NOT IN ('capture', 'live') THEN
    RAISE EXCEPTION 'quote_send_adapter_unknown: %', p_send->>'adapter';
  END IF;
  IF coalesce(p_send->>'link_base_url', '') !~ '^https?://[^?#[:space:]]+$' THEN
    RAISE EXCEPTION 'quote_send_invalid: link_base_url must be a plain http(s) address';
  END IF;
  IF p_ttl_minutes IS NULL OR p_ttl_minutes NOT BETWEEN 5 AND 1440 THEN
    RAISE EXCEPTION 'quote_send_invalid: ttl must be 5 to 1440 minutes';
  END IF;
  SELECT * INTO r FROM public.quote_v2_revisions WHERE id = p_revision_id;
  IF NOT FOUND OR r.status <> 'frozen' THEN
    RAISE EXCEPTION 'quote_revision_not_frozen';
  END IF;
  IF public.quote_v2_current_revision(r.job_id) IS DISTINCT FROM r.id THEN
    RAISE EXCEPTION 'quote_revision_not_current: revision % has been replaced', r.revision_number;
  END IF;
  IF r.valid_until < public.quote_v2_perth_today() THEN
    RAISE EXCEPTION 'quote_expired: this revision was valid until %', r.valid_until;
  END IF;
  SELECT * INTO job FROM public.jobs WHERE id = r.job_id;
  IF jsonb_typeof(p_send->'parties') <> 'array' THEN
    RAISE EXCEPTION 'quote_send_invalid: parties must be a list';
  END IF;
  -- Every party named must be on this revision, once.
  FOR sp IN SELECT * FROM jsonb_array_elements(p_send->'parties') LOOP
    IF NOT EXISTS (SELECT 1 FROM public.quote_v2_revision_parties x
                   WHERE x.revision_id = r.id AND x.party_id::text = sp->>'party_id') THEN
      RAISE EXCEPTION 'quote_send_party_not_on_revision: %', sp->>'party_id';
    END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(p_send->'parties') e
        WHERE e->>'party_id' = sp->>'party_id') > 1 THEN
      RAISE EXCEPTION 'quote_send_invalid: party % listed twice', sp->>'party_id';
    END IF;
  END LOOP;

  FOR rp IN
    SELECT x.party_id, x.role, x.display_name, x.ordinal, x.ghl_contact_id,
      t.share_ex_gst, t.share_gst, t.share_inc_gst
    FROM public.quote_v2_revision_parties x
    JOIN public.quote_v2_party_totals t ON t.revision_id = x.revision_id AND t.party_id = x.party_id
    WHERE x.revision_id = r.id ORDER BY x.ordinal
  LOOP
    SELECT e INTO sp FROM jsonb_array_elements(p_send->'parties') e
    WHERE e->>'party_id' = rp.party_id::text;
    IF rp.share_inc_gst = 0 THEN
      IF sp IS NOT NULL THEN
        RAISE EXCEPTION 'quote_party_nothing_to_accept: % pays nothing on this revision and is sent nothing', rp.display_name;
      END IF;
      CONTINUE;
    END IF;
    IF sp IS NULL OR jsonb_typeof(sp->'recipients') <> 'array' OR jsonb_array_length(sp->'recipients') = 0 THEN
      RAISE EXCEPTION 'quote_send_recipient_missing: % has a share and no recipient', rp.display_name;
    END IF;
    channels := ARRAY[]::text[];
    FOR rc IN SELECT * FROM jsonb_array_elements(sp->'recipients') LOOP
      IF rc->>'channel' = 'email' THEN
        IF coalesce(rc->>'to', '') !~ '^[^@[:space:]<>,;]+@[^@[:space:]<>,;]+\.[A-Za-z]{2,}$' THEN
          RAISE EXCEPTION 'quote_send_recipient_invalid: % is not an email address', rc->>'to';
        END IF;
      ELSIF rc->>'channel' = 'sms' THEN
        IF coalesce(rc->>'to', '') !~ '^\+614[0-9]{8}$' THEN
          RAISE EXCEPTION 'quote_send_recipient_invalid: % is not an Australian mobile in +614 form', rc->>'to';
        END IF;
      ELSE
        RAISE EXCEPTION 'quote_send_recipient_invalid: channel % is not email or sms', rc->>'channel';
      END IF;
      channels := channels || (rc->>'channel');
    END LOOP;
    IF (SELECT count(*) FROM jsonb_array_elements(sp->'recipients') a
        JOIN jsonb_array_elements(sp->'recipients') b ON a->>'channel' = b->>'channel'
          AND lower(a->>'to') = lower(b->>'to')) <> jsonb_array_length(sp->'recipients') THEN
      RAISE EXCEPTION 'quote_send_invalid: a recipient is listed twice for %', rp.display_name;
    END IF;
    IF 'email' = ANY(channels) AND (
         btrim(coalesce(sp->'messages'->'email'->>'subject', '')) = ''
         OR position('{{quote_link}}' IN coalesce(sp->'messages'->'email'->>'text', '')) = 0
         OR position('{{quote_link}}' IN coalesce(sp->'messages'->'email'->>'html', '')) = 0) THEN
      RAISE EXCEPTION 'quote_send_message_invalid: the email to % needs a subject and the {{quote_link}} in text and html', rp.display_name;
    END IF;
    IF 'sms' = ANY(channels)
       AND position('{{quote_link}}' IN coalesce(sp->'messages'->'sms'->>'text', '')) = 0 THEN
      RAISE EXCEPTION 'quote_send_message_invalid: the SMS to % needs the {{quote_link}}', rp.display_name;
    END IF;
    IF coalesce(sp->'documents'->>'html_sha256', '') !~ '^[0-9a-f]{64}$'
       OR coalesce(sp->'documents'->>'pdf_sha256', '') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'quote_send_invalid: the rendered documents for % are not hashed', rp.display_name;
    END IF;
    parties := parties || jsonb_build_object(
      'party_id', rp.party_id,
      'role', rp.role,
      'display_name', rp.display_name,
      'share', jsonb_build_object('ex_gst', rp.share_ex_gst, 'gst', rp.share_gst, 'inc_gst', rp.share_inc_gst),
      -- An SMS is delivered through the party's GHL contact, so the stamp
      -- names that contact beside the number.
      'recipients', (SELECT jsonb_agg(jsonb_build_object(
          'channel', e->>'channel', 'to', e->>'to', 'name', nullif(btrim(e->>'name'), ''),
          'ghl_contact_id', CASE WHEN e->>'channel' = 'sms' THEN rp.ghl_contact_id END)
          ORDER BY i) FROM jsonb_array_elements(sp->'recipients') WITH ORDINALITY AS a(e, i)),
      'link', jsonb_build_object('issued', 'on_send',
        'address', (p_send->>'link_base_url') || '?t=<new link for ' || rp.display_name || '>'),
      'messages', jsonb_strip_nulls(jsonb_build_object(
        'email', CASE WHEN 'email' = ANY(channels) THEN jsonb_build_object(
          'subject', sp->'messages'->'email'->>'subject',
          'text', sp->'messages'->'email'->>'text',
          'html', sp->'messages'->'email'->>'html') END,
        'sms', CASE WHEN 'sms' = ANY(channels) THEN jsonb_build_object(
          'text', sp->'messages'->'sms'->>'text') END)),
      'documents', jsonb_build_object(
        'html_sha256', sp->'documents'->>'html_sha256',
        'pdf_sha256', sp->'documents'->>'pdf_sha256'));
  END LOOP;
  IF jsonb_array_length(parties) = 0 THEN
    RAISE EXCEPTION 'quote_send_recipient_missing: nobody to send to';
  END IF;

  pid := gen_random_uuid();
  preview := jsonb_build_object(
    'schema', 'quote_v2_send_preview/v1',
    'preview_id', pid,
    'adapter', p_send->>'adapter',
    'delivery', CASE p_send->>'adapter'
      WHEN 'capture' THEN 'captured to the outbox only; nothing is delivered'
      ELSE 'delivered by email and SMS (staging only)' END,
    'job_id', r.job_id,
    'job_number', job.job_number,
    'site_suburb', job.site_suburb,
    'revision_id', r.id,
    'revision_number', r.revision_number,
    'content_hash', r.content_hash,
    'valid_until', r.valid_until,
    'job_total', jsonb_build_object('ex_gst', r.job_total_ex_gst, 'gst', r.job_gst, 'inc_gst', r.job_total_inc_gst),
    'link_base_url', p_send->>'link_base_url',
    'parties', parties,
    'prepared_by', p_prepared_by,
    'prepared_at', prepared,
    'expires_at', prepared + make_interval(mins => p_ttl_minutes));
  h := encode(sha256(convert_to(preview::text, 'UTF8')), 'hex');
  INSERT INTO public.quote_v2_send_previews
    (id, revision_id, job_id, adapter, preview, preview_hash, prepared_by, prepared_at, expires_at)
  VALUES (pid, r.id, r.job_id, p_send->>'adapter', preview, h, p_prepared_by, prepared,
    prepared + make_interval(mins => p_ttl_minutes));
  RETURN jsonb_build_object('preview_id', pid, 'preview_hash', h, 'preview', preview);
END $$;

-- The revision a preview named must still be exactly the current quote.
CREATE OR REPLACE FUNCTION public.quote_v2_send_preview_still_current(p public.quote_v2_send_previews)
RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT public.quote_v2_current_revision(p.job_id) = p.revision_id
    AND (SELECT r.content_hash FROM public.quote_v2_revisions r WHERE r.id = p.revision_id)
        = p.preview->>'content_hash'
$$;

-- ── The owner's stamp ───────────────────────────────────────────────────
-- Who may stamp is decided by the edge function (a verified owner session);
-- here the echoed hash must be the preview's, unexpired and still current.
CREATE OR REPLACE FUNCTION public.quote_v2_approve_send(
  p_preview_id uuid,
  p_preview_hash text,
  p_approved_by text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  p public.quote_v2_send_previews%ROWTYPE;
  a public.quote_v2_send_approvals%ROWTYPE;
BEGIN
  IF btrim(coalesce(p_approved_by, '')) = '' THEN
    RAISE EXCEPTION 'quote_actor_missing';
  END IF;
  SELECT * INTO p FROM public.quote_v2_send_previews WHERE id = p_preview_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote_send_preview_missing: %', p_preview_id;
  END IF;
  IF p_preview_hash IS DISTINCT FROM p.preview_hash THEN
    RAISE EXCEPTION 'quote_send_hash_mismatch: the stamp does not echo this preview';
  END IF;
  SELECT * INTO a FROM public.quote_v2_send_approvals WHERE preview_id = p.id;
  IF FOUND THEN
    RETURN jsonb_build_object('approval_id', a.id, 'approved_by', a.approved_by,
      'approved_at', a.approved_at, 'already_approved', true);
  END IF;
  IF p.expires_at <= now() THEN
    RAISE EXCEPTION 'quote_send_preview_expired: prepare the send again';
  END IF;
  IF NOT public.quote_v2_send_preview_still_current(p) THEN
    RAISE EXCEPTION 'quote_send_revision_changed: the quote changed after this preview';
  END IF;
  INSERT INTO public.quote_v2_send_approvals (preview_id, preview_hash, approved_by)
  VALUES (p.id, p.preview_hash, p_approved_by)
  RETURNING * INTO a;
  RETURN jsonb_build_object('approval_id', a.id, 'approved_by', a.approved_by,
    'approved_at', a.approved_at, 'already_approved', false);
END $$;

-- ── Execute an approved send, once ─────────────────────────────────────
-- p_live_allowed: whether the caller's environment may deliver live. A
-- 'live' preview is refused when it may not; a 'capture' preview is always
-- captured, whatever the environment.
CREATE OR REPLACE FUNCTION public.quote_v2_execute_send(
  p_preview_id uuid,
  p_preview_hash text,
  p_sent_by text,
  p_live_allowed boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  p public.quote_v2_send_previews%ROWTYPE;
  a public.quote_v2_send_approvals%ROWTYPE;
  s public.quote_v2_sends%ROWTYPE;
  pty jsonb;
  rc jsonb;
  link jsonb;
  url text;
  msg jsonb;
BEGIN
  IF btrim(coalesce(p_sent_by, '')) = '' THEN
    RAISE EXCEPTION 'quote_actor_missing';
  END IF;
  SELECT * INTO p FROM public.quote_v2_send_previews WHERE id = p_preview_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote_send_preview_missing: %', p_preview_id;
  END IF;
  IF p_preview_hash IS DISTINCT FROM p.preview_hash THEN
    RAISE EXCEPTION 'quote_send_hash_mismatch: the send does not echo this preview';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('quote_v2_job:' || p.job_id::text));
  SELECT * INTO s FROM public.quote_v2_sends WHERE preview_id = p.id;
  IF FOUND THEN
    RETURN public.quote_v2_send_result(s.id, true);
  END IF;
  SELECT * INTO a FROM public.quote_v2_send_approvals WHERE preview_id = p.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote_send_not_approved: the owner has not stamped this preview';
  END IF;
  IF p.expires_at <= now() THEN
    RAISE EXCEPTION 'quote_send_preview_expired: prepare the send again';
  END IF;
  IF p.adapter = 'live' AND NOT coalesce(p_live_allowed, false) THEN
    RAISE EXCEPTION 'quote_send_live_disabled: live delivery is not enabled here';
  END IF;
  IF NOT public.quote_v2_send_preview_still_current(p) THEN
    RAISE EXCEPTION 'quote_send_revision_changed: the quote changed after this preview';
  END IF;
  INSERT INTO public.quote_v2_sends (preview_id, approval_id, revision_id, adapter, sent_by)
  VALUES (p.id, a.id, p.revision_id, p.adapter, p_sent_by)
  RETURNING * INTO s;
  FOR pty IN SELECT * FROM jsonb_array_elements(p.preview->'parties') LOOP
    link := public.quote_v2_issue_party_link(p.revision_id, (pty->>'party_id')::uuid, p_sent_by);
    url := (p.preview->>'link_base_url') || '?t=' || (link->>'token');
    FOR rc IN SELECT * FROM jsonb_array_elements(pty->'recipients') LOOP
      msg := pty->'messages'->(rc->>'channel');
      INSERT INTO public.quote_v2_outbox
        (send_id, party_id, link_id, channel, to_address, to_name, subject, body_text, body_html, adapter)
      VALUES (s.id, (pty->>'party_id')::uuid, (link->>'link_id')::uuid, rc->>'channel', rc->>'to',
        rc->>'name', msg->>'subject', replace(msg->>'text', '{{quote_link}}', url),
        replace(msg->>'html', '{{quote_link}}', url), p.adapter);
    END LOOP;
  END LOOP;
  RETURN public.quote_v2_send_result(s.id, false);
END $$;

-- What a send did, without message bodies or links.
CREATE OR REPLACE FUNCTION public.quote_v2_send_result(p_send_id uuid, p_replay boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'send_id', s.id, 'preview_id', s.preview_id, 'revision_id', s.revision_id,
    'adapter', s.adapter, 'sent_by', s.sent_by, 'sent_at', s.sent_at, 'replay', p_replay,
    'messages', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'outbox_id', o.id, 'party_id', o.party_id, 'link_id', o.link_id,
        'channel', o.channel, 'to', o.to_address, 'adapter', o.adapter,
        'delivery', CASE WHEN o.adapter = 'capture' THEN 'captured'
          ELSE coalesce(
            (SELECT d.outcome FROM public.quote_v2_outbox_deliveries d
             WHERE d.outbox_id = o.id AND d.outcome <> 'claimed'),
            (SELECT 'unknown' FROM public.quote_v2_outbox_deliveries d
             WHERE d.outbox_id = o.id AND d.outcome = 'claimed'),
            'pending') END)
        ORDER BY o.created_at, o.channel, o.to_address)
      FROM public.quote_v2_outbox o WHERE o.send_id = s.id), '[]'::jsonb))
  FROM public.quote_v2_sends s WHERE s.id = p_send_id
$$;

-- Live rows never claimed: the only rows a send may still attempt. Bodies are returned only to the delivering edge function, with the GHL
-- contact the stamped preview named for an SMS.
CREATE OR REPLACE FUNCTION public.quote_v2_live_outbox_pending(p_send_id uuid)
RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT to_jsonb(o) || jsonb_build_object('ghl_contact_id', (
      SELECT rc->>'ghl_contact_id'
      FROM public.quote_v2_sends s
      JOIN public.quote_v2_send_previews p ON p.id = s.preview_id,
        jsonb_array_elements(p.preview->'parties') pty,
        jsonb_array_elements(pty->'recipients') rc
      WHERE s.id = o.send_id AND pty->>'party_id' = o.party_id::text
        AND rc->>'channel' = o.channel AND rc->>'to' = o.to_address
      LIMIT 1))
  FROM public.quote_v2_outbox o
  WHERE o.send_id = p_send_id AND o.adapter = 'live'
    AND NOT EXISTS (SELECT 1 FROM public.quote_v2_outbox_deliveries d WHERE d.outbox_id = o.id)
  ORDER BY o.created_at, o.channel, o.to_address
$$;

-- Claim one live row before its provider call. True for exactly one caller,
-- ever; every other (concurrent, retried or replayed) caller gets false and
-- must deliver nothing.
CREATE OR REPLACE FUNCTION public.quote_v2_claim_delivery(p_outbox_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o public.quote_v2_outbox%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.quote_v2_outbox WHERE id = p_outbox_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote_outbox_missing: %', p_outbox_id;
  END IF;
  IF o.adapter = 'capture' THEN
    RAISE EXCEPTION 'quote_outbox_capture_never_delivers: a captured message is never delivered';
  END IF;
  INSERT INTO public.quote_v2_outbox_deliveries (outbox_id, outcome)
  VALUES (o.id, 'claimed')
  ON CONFLICT (outbox_id) WHERE outcome = 'claimed' DO NOTHING;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.quote_v2_record_delivery(
  p_outbox_id uuid,
  p_outcome text,
  p_provider_message_id text DEFAULT NULL,
  p_detail text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o public.quote_v2_outbox%ROWTYPE;
  new_id uuid;
BEGIN
  SELECT * INTO o FROM public.quote_v2_outbox WHERE id = p_outbox_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote_outbox_missing: %', p_outbox_id;
  END IF;
  IF o.adapter = 'capture' THEN
    RAISE EXCEPTION 'quote_outbox_capture_never_delivers: a captured message is never delivered';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('delivered', 'failed', 'unknown') THEN
    RAISE EXCEPTION 'quote_outbox_outcome_unknown: %', p_outcome;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.quote_v2_outbox_deliveries d
                 WHERE d.outbox_id = o.id AND d.outcome = 'claimed') THEN
    RAISE EXCEPTION 'quote_outbox_delivery_unclaimed: a delivery is recorded only after its claim';
  END IF;
  IF EXISTS (SELECT 1 FROM public.quote_v2_outbox_deliveries d
             WHERE d.outbox_id = o.id AND d.outcome <> 'claimed') THEN
    RAISE EXCEPTION 'quote_outbox_delivery_settled: this message already has its outcome';
  END IF;
  INSERT INTO public.quote_v2_outbox_deliveries (outbox_id, outcome, provider_message_id, detail)
  VALUES (o.id, p_outcome, nullif(btrim(p_provider_message_id), ''), left(p_detail, 500))
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

-- A party link minted by hand is only for a party the owner already stamped
-- a send to: the preview hash must be approved, for this revision, and name
-- this party. Otherwise links are minted only by the stamped send.
CREATE OR REPLACE FUNCTION public.quote_v2_issue_approved_party_link(
  p_revision_id uuid,
  p_party_id uuid,
  p_preview_hash text,
  p_issued_by text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.quote_v2_send_previews p
    JOIN public.quote_v2_send_approvals a ON a.preview_id = p.id
    WHERE p.preview_hash = p_preview_hash AND p.revision_id = p_revision_id
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.preview->'parties') pty
                  WHERE pty->>'party_id' = p_party_id::text)) THEN
    RAISE EXCEPTION 'quote_link_not_approved: no stamped send covers this party on this revision';
  END IF;
  RETURN public.quote_v2_issue_party_link(p_revision_id, p_party_id, p_issued_by);
END $$;

-- Staff read of a send preview and what happened to it. Never a token or body.
CREATE OR REPLACE FUNCTION public.quote_v2_send_status(p_preview_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'preview_id', p.id, 'preview_hash', p.preview_hash, 'adapter', p.adapter,
    'prepared_by', p.prepared_by, 'prepared_at', p.prepared_at, 'expires_at', p.expires_at,
    'still_current', public.quote_v2_send_preview_still_current(p),
    'approval', (SELECT jsonb_build_object('approved_by', a.approved_by, 'approved_at', a.approved_at)
      FROM public.quote_v2_send_approvals a WHERE a.preview_id = p.id),
    'send', (SELECT public.quote_v2_send_result(s.id, false)
      FROM public.quote_v2_sends s WHERE s.preview_id = p.id))
  FROM public.quote_v2_send_previews p WHERE p.id = p_preview_id
$$;

-- ── Grants ──────────────────────────────────────────────────────────────
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.quote_v2_build_draft(uuid, jsonb, jsonb, text, date)',
    'public.quote_v2_party_document(uuid, uuid)',
    'public.quote_v2_open_party_document(text)',
    'public.quote_v2_prepare_send(uuid, jsonb, text, integer)',
    'public.quote_v2_send_preview_still_current(public.quote_v2_send_previews)',
    'public.quote_v2_approve_send(uuid, text, text)',
    'public.quote_v2_execute_send(uuid, text, text, boolean)',
    'public.quote_v2_send_result(uuid, boolean)',
    'public.quote_v2_live_outbox_pending(uuid)',
    'public.quote_v2_claim_delivery(uuid)',
    'public.quote_v2_record_delivery(uuid, text, text, text)',
    'public.quote_v2_issue_approved_party_link(uuid, uuid, text, text)',
    'public.quote_v2_send_status(uuid)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
