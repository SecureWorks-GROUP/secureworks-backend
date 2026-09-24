-- Quote v2, stage 2: quote records. PROGRAM BRANCH ONLY (program/quote-v2).
-- Never applied to production until the owner carries the program over.
--
-- A quote is a record first. A revision holds a frozen scope, lines priced
-- from true cost plus a markup layer (or a stated sell with who stated it),
-- the parties who pay, and per-party totals computed ONCE at freeze that must
-- sum to the job total to the cent. Each party reaches the quote through its
-- own link, and the link can only ever show and accept that party's own
-- current revision. Owner, 24 Sep 2026: "I just want the tools to capture the
-- accurate pricing of the costs to us. And we can add the markup of what we
-- want."
--
-- New tables and functions only. The legacy send-quote paths, job_documents,
-- job_contacts and quote_revisions are not touched. Nothing here sends,
-- emails, or writes jobs, GHL or Xero; rendering and sending are stage 3.
--
-- Also folds in two stage 1 leftovers:
-- * PB-9: a cut plan is costed from the per-length rate of every stock length
--   bought (price_book_current_length_costs), never one headline $/LM.
-- * PB-10: approving a price book proposal locks the SUBJECT (item and
--   supplier, family, allowance band), not the proposal, so two proposals for
--   one subject cannot both be approved against the same old row.
--
-- Contract: docs/quote-v2/quote-records-v1.md.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ── PB-10: approval serialises on the subject ───────────────────────────
CREATE OR REPLACE FUNCTION public.price_book_subject_lock_key(
  p_target text,
  p_subject jsonb
)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT 'price_book_subject:' || p_target || ':' || CASE p_target
    WHEN 'cost' THEN coalesce(p_subject->>'item_key', '') || '|' || coalesce(p_subject->>'supplier', '')
    WHEN 'stock_lengths' THEN coalesce(p_subject->>'item_key', '') || '|' || coalesce(p_subject->>'supplier', '')
    WHEN 'cut_rule' THEN coalesce(p_subject->>'item_key', '')
    WHEN 'markup_rule' THEN coalesce(p_subject->>'family', '')
    WHEN 'allowance' THEN coalesce(p_subject->>'family', '') || '|'
      || coalesce(p_subject->>'allowance_key', '') || '|' || coalesce(p_subject->>'basis', '') || '|'
      || coalesce(p_subject->>'girth_min_mm', '') || '|' || coalesce(p_subject->>'girth_max_mm', '')
    ELSE '' END
$$;

CREATE OR REPLACE FUNCTION public.price_book_decide_proposal(
  p_proposal_id uuid,
  p_decision text,
  p_decided_by text,
  p_note text DEFAULT NULL
)
RETURNS TABLE (proposal_id uuid, decision text, applied_row_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  p public.price_book_proposals%ROWTYPE;
  v jsonb;
  s jsonb;
  fam text;
  sup text;
  new_id uuid;
BEGIN
  IF p_decision NOT IN ('approved', 'rejected', 'withdrawn') THEN
    RAISE EXCEPTION 'price_book_decision_unknown: %', p_decision;
  END IF;
  IF btrim(coalesce(p_decided_by, '')) = '' THEN
    RAISE EXCEPTION 'price_book_decider_missing';
  END IF;

  -- Proposals are immutable, so the subject can be read before locking.
  SELECT * INTO p FROM public.price_book_proposals WHERE id = p_proposal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'price_book_proposal_missing: %', p_proposal_id;
  END IF;
  -- PB-10: one lock per SUBJECT. Every decision on any proposal for this
  -- item/supplier (or family, or allowance band) waits here, so the stale
  -- check below always sees a competing approval that committed first.
  PERFORM pg_advisory_xact_lock(hashtext(public.price_book_subject_lock_key(p.target, p.subject)));
  IF EXISTS (SELECT 1 FROM public.price_book_proposal_decisions d WHERE d.proposal_id = p.id) THEN
    RAISE EXCEPTION 'price_book_proposal_already_decided: %', p.id;
  END IF;

  s := p.subject;
  v := p.new_value;
  IF p.target IN ('cost', 'stock_lengths', 'cut_rule') THEN
    SELECT i.family INTO fam FROM public.price_book_items i WHERE i.item_key = s->>'item_key';
    IF fam IS NULL THEN
      RAISE EXCEPTION 'price_book_item_missing: %', s->>'item_key';
    END IF;
  ELSE
    fam := s->>'family';
  END IF;
  sup := s->>'supplier';

  IF p_decision = 'withdrawn' THEN
    IF p_decided_by <> p.proposed_by THEN
      RAISE EXCEPTION 'price_book_withdraw_not_proposer';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM (
        SELECT DISTINCT ON (a.scope_kind, a.scope_value, a.approver) a.*
        FROM public.price_book_approvers a
        ORDER BY a.scope_kind, a.scope_value, a.approver, a.recorded_at DESC, a.id
      ) cur
      WHERE cur.active AND cur.approver = p_decided_by
        AND (cur.scope_kind = 'any'
          OR (cur.scope_kind = 'family' AND cur.scope_value = fam)
          OR (cur.scope_kind = 'supplier' AND cur.scope_value = sup)
          OR (cur.scope_kind = 'target' AND cur.scope_value = p.target))
    ) THEN
      RAISE EXCEPTION 'price_book_approver_not_authorised: % for % %', p_decided_by, p.target, fam;
    END IF;
  END IF;

  IF p_decision = 'approved' THEN
    IF public.price_book_subject_current_row(p.target, s) IS DISTINCT FROM p.old_row_id THEN
      RAISE EXCEPTION 'price_book_proposal_stale: the current row changed since this was proposed';
    END IF;
    IF p.target = 'cost' THEN
      INSERT INTO public.price_book_costs (item_key, supplier, supplier_code, cost_ex_gst,
        per_length_mm, as_at, evidence_kind, evidence_ref, evidence_note, provisional,
        blessed_by, blessed_at, recorded_by, proposal_id)
      VALUES (s->>'item_key', sup, v->>'supplier_code', (v->>'cost_ex_gst')::numeric,
        (v->>'per_length_mm')::integer,
        (v->>'as_at')::date, v->>'evidence_kind', coalesce(v->>'evidence_ref', p.evidence_ref),
        v->>'evidence_note', false, p_decided_by, now(), p_decided_by, p.id)
      RETURNING id INTO new_id;
    ELSIF p.target = 'stock_lengths' THEN
      INSERT INTO public.price_book_stock_lengths (item_key, supplier, lengths_mm, as_at,
        evidence_kind, evidence_ref, evidence_note, provisional, blessed_by, blessed_at,
        recorded_by, proposal_id)
      VALUES (s->>'item_key', sup,
        ARRAY(SELECT (x)::integer FROM jsonb_array_elements_text(v->'lengths_mm') AS x),
        (v->>'as_at')::date, v->>'evidence_kind', coalesce(v->>'evidence_ref', p.evidence_ref),
        v->>'evidence_note', false, p_decided_by, now(), p_decided_by, p.id)
      RETURNING id INTO new_id;
    ELSIF p.target = 'cut_rule' THEN
      INSERT INTO public.price_book_cut_rules (item_key, rule, kerf_mm, as_at, evidence_kind,
        evidence_ref, evidence_note, provisional, blessed_by, blessed_at, recorded_by, proposal_id)
      VALUES (s->>'item_key', v->>'rule', coalesce((v->>'kerf_mm')::numeric, 3),
        (v->>'as_at')::date, v->>'evidence_kind', coalesce(v->>'evidence_ref', p.evidence_ref),
        v->>'evidence_note', false, p_decided_by, now(), p_decided_by, p.id)
      RETURNING id INTO new_id;
    ELSIF p.target = 'markup_rule' THEN
      INSERT INTO public.price_book_markup_rules (family, value, as_at,
        evidence_kind, evidence_ref, evidence_note, provisional, blessed_by, blessed_at,
        recorded_by, proposal_id)
      VALUES (fam, (v->>'value')::numeric,
        (v->>'as_at')::date, v->>'evidence_kind', coalesce(v->>'evidence_ref', p.evidence_ref),
        v->>'evidence_note', false, p_decided_by, now(), p_decided_by, p.id)
      RETURNING id INTO new_id;
    ELSE
      INSERT INTO public.price_book_allowances (family, allowance_key, description, basis,
        girth_min_mm, girth_max_mm, cost_ex_gst, as_at, evidence_kind, evidence_ref,
        evidence_note, provisional, blessed_by, blessed_at, recorded_by, proposal_id)
      VALUES (fam, s->>'allowance_key', v->>'description', s->>'basis',
        (s->>'girth_min_mm')::integer, (s->>'girth_max_mm')::integer,
        (v->>'cost_ex_gst')::numeric, (v->>'as_at')::date, v->>'evidence_kind',
        coalesce(v->>'evidence_ref', p.evidence_ref), v->>'evidence_note', false,
        p_decided_by, now(), p_decided_by, p.id)
      RETURNING id INTO new_id;
    END IF;
  END IF;

  INSERT INTO public.price_book_proposal_decisions
    (proposal_id, decision, decided_by, note, applied_row_id)
  VALUES (p.id, p_decision, p_decided_by, p_note, new_id);

  RETURN QUERY SELECT p.id, p_decision, new_id;
END $$;

-- ── PB-9: the current rate for every stock length ───────────────────────
-- One row per (item, per_length_mm) from the headline supplier (the supplier
-- price_book_current_costs chose), blessed first, then strongest evidence,
-- then newest. per_length_mm NULL is a generic $/LM rate with no stated
-- length. `whole_length_ex_gst` is what one stock length of that size costs.
CREATE OR REPLACE FUNCTION public.price_book_current_length_costs(
  p_item_keys text[] DEFAULT NULL
)
RETURNS TABLE (
  item_key text,
  per_length_mm integer,
  cost_ex_gst numeric,
  whole_length_ex_gst numeric,
  cost_row_id uuid,
  supplier text,
  as_at date,
  status text
)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH head AS (
    SELECT h.item_key, h.supplier
    FROM public.price_book_current_costs(p_item_keys) h
    WHERE h.status <> 'unpriced'
  ),
  cur AS (
    SELECT DISTINCT ON (c.item_key, c.per_length_mm) c.*
    FROM public.price_book_costs c
    JOIN head ON head.item_key = c.item_key AND head.supplier = c.supplier
    ORDER BY c.item_key, c.per_length_mm, c.provisional,
      CASE WHEN c.provisional THEN public.price_book_evidence_rank(c.evidence_kind) ELSE 0 END,
      c.as_at DESC, c.recorded_at DESC, c.id
  )
  SELECT cur.item_key, cur.per_length_mm, cur.cost_ex_gst,
    CASE WHEN cur.per_length_mm IS NULL THEN NULL
         ELSE round(cur.cost_ex_gst * cur.per_length_mm / 1000.0, 2) END,
    cur.id, cur.supplier, cur.as_at,
    CASE WHEN cur.provisional THEN 'provisional' ELSE 'blessed' END
  FROM cur
  ORDER BY cur.item_key, cur.per_length_mm NULLS LAST
$$;

-- ── Records ─────────────────────────────────────────────────────────────
-- A party is a person on a job, with a stable id that never changes meaning
-- (never a position letter). Immutable.
CREATE TABLE public.quote_v2_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  role text NOT NULL CHECK (role IN ('client', 'neighbour')),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, job_id)
);
COMMENT ON TABLE public.quote_v2_parties IS
  'Quote v2 party: a stable person on a job (client or neighbour). Never keyed by position.';

CREATE TABLE public.quote_v2_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id),
  revision_number integer NOT NULL CHECK (revision_number > 0),
  family text NOT NULL CHECK (family IN ('fencing', 'patio', 'stratco', 'misc')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'frozen')),
  -- Customer-facing scope only: title, summary, inclusions, exclusions, notes.
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object'),
  valid_until date,
  job_total_ex_gst numeric(12,2),
  job_gst numeric(12,2),
  job_total_inc_gst numeric(12,2),
  content_hash text,
  prepared_by text NOT NULL CHECK (btrim(prepared_by) <> ''),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  frozen_by text,
  frozen_at timestamptz,
  UNIQUE (job_id, revision_number),
  CHECK (
    (status = 'draft' AND valid_until IS NULL AND job_total_ex_gst IS NULL AND job_gst IS NULL
      AND job_total_inc_gst IS NULL AND content_hash IS NULL AND frozen_by IS NULL AND frozen_at IS NULL)
    OR
    (status = 'frozen' AND valid_until IS NOT NULL AND job_total_ex_gst > 0 AND job_gst IS NOT NULL
      AND job_total_inc_gst = job_total_ex_gst + job_gst AND content_hash ~ '^sha256:[0-9a-f]{64}$'
      AND btrim(coalesce(frozen_by, '')) <> '' AND frozen_at IS NOT NULL)
  )
);
COMMENT ON TABLE public.quote_v2_revisions IS
  'Quote v2 revision. Draft until quote_v2_freeze_revision; frozen revisions never change. The job''s current revision is its highest-numbered frozen one.';
CREATE INDEX quote_v2_revisions_job_idx ON public.quote_v2_revisions (job_id, revision_number DESC);

CREATE TABLE public.quote_v2_revision_parties (
  revision_id uuid NOT NULL REFERENCES public.quote_v2_revisions(id),
  party_id uuid NOT NULL REFERENCES public.quote_v2_parties(id),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  role text NOT NULL CHECK (role IN ('client', 'neighbour')),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  -- The party's GHL contact when the revision was prepared (null: none yet).
  ghl_contact_id text CHECK (ghl_contact_id IS NULL OR btrim(ghl_contact_id) <> ''),
  share_rule text NOT NULL CHECK (share_rule IN ('sole', 'equal', 'agreed_percent', 'lines_only')),
  -- Default share of every line without its own split, in basis points.
  share_bp integer NOT NULL CHECK (share_bp BETWEEN 0 AND 10000),
  PRIMARY KEY (revision_id, party_id),
  UNIQUE (revision_id, ordinal)
);

CREATE TABLE public.quote_v2_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES public.quote_v2_revisions(id),
  line_key text NOT NULL CHECK (btrim(line_key) <> '' AND length(line_key) <= 120),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  description text NOT NULL CHECK (btrim(description) <> ''),
  category text,
  qty numeric(12,3) NOT NULL CHECK (qty > 0),
  unit text NOT NULL CHECK (unit ~ '^[a-z0-9]{1,16}$'),
  -- Cost to us, per unit, ex GST.
  cost_source text NOT NULL CHECK (cost_source IN ('price_book', 'stated', 'tool', 'none')),
  item_key text REFERENCES public.price_book_items(item_key),
  cost_row_id uuid REFERENCES public.price_book_costs(id),
  stock_length_mm integer CHECK (stock_length_mm IS NULL OR stock_length_mm > 0),
  cost_rate_basis text CHECK (cost_rate_basis IN ('item_unit', 'length_rate', 'per_lm_rate')),
  cost_supplier text,
  cost_as_at date,
  cost_status text CHECK (cost_status IN ('blessed', 'provisional')),
  unit_cost_ex_gst numeric(12,4) CHECK (unit_cost_ex_gst IS NULL OR unit_cost_ex_gst > 0),
  cost_stated_by text,
  cost_evidence text,
  -- Sell.
  sell_basis text NOT NULL CHECK (sell_basis IN ('cost_markup', 'stated', 'adjustment')),
  markup_family text CHECK (markup_family IN ('fencing', 'patio', 'stratco', 'misc')),
  markup_multiplier numeric(8,4) CHECK (markup_multiplier IS NULL OR markup_multiplier >= 1),
  markup_source text CHECK (markup_source IN ('family_default', 'line_override')),
  markup_rule_row_id uuid REFERENCES public.price_book_markup_rules(id),
  markup_rule_status text CHECK (markup_rule_status IN ('blessed', 'provisional')),
  markup_override_id uuid REFERENCES public.quote_line_markup_overrides(id),
  markup_set_by text,
  markup_set_at timestamptz,
  sell_stated_kind text CHECK (sell_stated_kind = 'owner'),
  sell_stated_by text,
  sell_stated_at timestamptz,
  unit_sell_ex_gst numeric(12,4),
  line_cost_ex_gst numeric(12,2),
  line_sell_ex_gst numeric(12,2),
  duplicate_ack text,
  note text,
  UNIQUE (revision_id, line_key),
  UNIQUE (revision_id, ordinal),
  CHECK (cost_source <> 'price_book' OR (item_key IS NOT NULL AND cost_row_id IS NOT NULL
    AND unit_cost_ex_gst IS NOT NULL AND cost_as_at IS NOT NULL AND cost_status IS NOT NULL
    AND cost_rate_basis IS NOT NULL AND cost_supplier IS NOT NULL)),
  CHECK (cost_source = 'price_book' OR (cost_row_id IS NULL AND cost_rate_basis IS NULL)),
  CHECK (cost_source <> 'stated' OR (unit_cost_ex_gst IS NOT NULL
    AND btrim(coalesce(cost_stated_by, '')) <> '' AND btrim(coalesce(cost_evidence, '')) <> '')),
  CHECK (cost_source <> 'tool' OR (unit_cost_ex_gst IS NOT NULL AND btrim(coalesce(cost_evidence, '')) <> '')),
  CHECK (cost_source <> 'none' OR (unit_cost_ex_gst IS NULL AND item_key IS NULL)),
  CHECK (coalesce(cost_rate_basis IN ('length_rate', 'per_lm_rate'), false) = (stock_length_mm IS NOT NULL)),
  CHECK (sell_basis <> 'cost_markup' OR (cost_source <> 'none' AND markup_family IS NOT NULL
    AND sell_stated_kind IS NULL)),
  CHECK (sell_basis <> 'cost_markup' OR (
    (markup_multiplier IS NULL) = (line_sell_ex_gst IS NULL)
    AND (markup_multiplier IS NULL) = (markup_source IS NULL)
    AND (markup_multiplier IS NULL) = (unit_sell_ex_gst IS NULL))),
  CHECK (markup_source IS DISTINCT FROM 'family_default' OR markup_rule_row_id IS NOT NULL),
  CHECK (markup_source IS DISTINCT FROM 'line_override' OR (markup_override_id IS NOT NULL
    AND markup_set_by IS NOT NULL AND markup_set_at IS NOT NULL)),
  CHECK (sell_basis = 'cost_markup' OR (markup_multiplier IS NULL AND markup_source IS NULL)),
  CHECK (sell_basis <> 'stated' OR (unit_sell_ex_gst > 0 AND sell_stated_kind IS NOT NULL)),
  CHECK (cost_source <> 'none' OR sell_stated_kind = 'owner'),
  CHECK (sell_stated_kind IS DISTINCT FROM 'owner' OR (btrim(coalesce(sell_stated_by, '')) <> ''
    AND sell_stated_at IS NOT NULL)),
  CHECK (sell_basis <> 'adjustment' OR (cost_source = 'none' AND qty = 1 AND unit_sell_ex_gst <> 0
    AND sell_stated_kind = 'owner' AND btrim(coalesce(note, '')) <> ''))
);
COMMENT ON TABLE public.quote_v2_lines IS
  'Quote v2 line: cost to us with its source, then sell as cost x markup (family default or a scoper''s line override, with who) or a stated sell (owner with time). A tool supplies cost and quantity, never a sell.';

-- An explicit split for one line, overriding the parties' default share
-- (for example a removal the neighbour alone pays for).
CREATE TABLE public.quote_v2_line_splits (
  line_id uuid NOT NULL REFERENCES public.quote_v2_lines(id),
  party_id uuid NOT NULL REFERENCES public.quote_v2_parties(id),
  share_bp integer NOT NULL CHECK (share_bp BETWEEN 0 AND 10000),
  PRIMARY KEY (line_id, party_id)
);

-- Computed once, by quote_v2_freeze_revision only.
CREATE TABLE public.quote_v2_line_allocations (
  line_id uuid NOT NULL REFERENCES public.quote_v2_lines(id),
  party_id uuid NOT NULL REFERENCES public.quote_v2_parties(id),
  amount_ex_gst numeric(12,2) NOT NULL,
  PRIMARY KEY (line_id, party_id)
);

CREATE TABLE public.quote_v2_party_totals (
  revision_id uuid NOT NULL,
  party_id uuid NOT NULL,
  share_ex_gst numeric(12,2) NOT NULL CHECK (share_ex_gst >= 0),
  share_gst numeric(12,2) NOT NULL CHECK (share_gst >= 0),
  share_inc_gst numeric(12,2) NOT NULL,
  PRIMARY KEY (revision_id, party_id),
  FOREIGN KEY (revision_id, party_id) REFERENCES public.quote_v2_revision_parties(revision_id, party_id),
  CHECK (share_inc_gst = share_ex_gst + share_gst)
);

-- A party's link to one revision. Only the sha256 of the token is stored; the
-- token itself is returned once, at issue.
CREATE TABLE public.quote_v2_party_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL,
  party_id uuid NOT NULL,
  token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  issued_by text NOT NULL CHECK (btrim(issued_by) <> ''),
  issued_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (revision_id, party_id) REFERENCES public.quote_v2_revision_parties(revision_id, party_id)
);

CREATE TABLE public.quote_v2_link_revocations (
  link_id uuid PRIMARY KEY REFERENCES public.quote_v2_party_links(id),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  revoked_by text NOT NULL CHECK (btrim(revoked_by) <> ''),
  revoked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.quote_v2_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL,
  party_id uuid NOT NULL,
  link_id uuid NOT NULL REFERENCES public.quote_v2_party_links(id),
  content_hash text NOT NULL,
  accepted_name text,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (revision_id, party_id),
  FOREIGN KEY (revision_id, party_id) REFERENCES public.quote_v2_revision_parties(revision_id, party_id)
);

-- Stage 1 left the markup override unlinked until quote records existed.
ALTER TABLE public.quote_line_markup_overrides
  ADD CONSTRAINT quote_line_markup_overrides_revision_fkey
  FOREIGN KEY (quote_revision_id) REFERENCES public.quote_v2_revisions(id);

-- ── Immutability ────────────────────────────────────────────────────────
-- Drafts are built by quote_v2_create_draft; the only change after that is
-- the freeze, which runs with `quote_v2.freezing` set to the revision id.
-- Frozen rows and every link, acceptance and party row are append-only.
CREATE OR REPLACE FUNCTION public.quote_v2_freezing(p_revision_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('quote_v2.freezing', true), '') = p_revision_id::text
$$;


-- The revision row: created as a draft; the freeze flips it to frozen, then
-- writes its content hash once (frozen -> frozen, hash only, while the same
-- revision's hashing flag is set). Nothing else ever changes it.
CREATE OR REPLACE FUNCTION public.quote_v2_guard_revision()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'quote_v2_frozen_immutable: a revision is created as a draft' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'frozen'
     AND public.quote_v2_freezing(OLD.id)
     AND NEW.id = OLD.id AND NEW.job_id = OLD.job_id AND NEW.revision_number = OLD.revision_number
     AND NEW.family = OLD.family AND NEW.scope = OLD.scope AND NEW.prepared_by = OLD.prepared_by THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'frozen' AND NEW.status = 'frozen'
     AND OLD.content_hash = 'sha256:' || repeat('0', 64)
     AND coalesce(current_setting('quote_v2.hashing', true), '') = OLD.id::text
     AND (to_jsonb(NEW) - 'content_hash') = (to_jsonb(OLD) - 'content_hash') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'quote_v2_frozen_immutable: % on quote_v2_revisions is refused', TG_OP USING ERRCODE = 'P0001';
END $$;

-- Rows owned by a revision: insert only into a draft; update only during that
-- revision's freeze; never delete.
CREATE OR REPLACE FUNCTION public.quote_v2_guard_revision_child()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  rid uuid;
  st text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quote_v2_frozen_immutable: DELETE on % is refused', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  IF TG_TABLE_NAME IN ('quote_v2_line_splits', 'quote_v2_line_allocations') THEN
    SELECT l.revision_id INTO rid FROM public.quote_v2_lines l WHERE l.id = NEW.line_id;
  ELSIF TG_TABLE_NAME = 'quote_line_markup_overrides' THEN
    rid := NEW.quote_revision_id;
  ELSE
    rid := NEW.revision_id;
  END IF;
  SELECT r.status INTO st FROM public.quote_v2_revisions r WHERE r.id = rid;
  IF st IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'quote_v2_frozen_immutable: % on % of a frozen revision is refused', TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_TABLE_NAME IN ('quote_v2_line_allocations', 'quote_v2_party_totals')
     OR TG_OP = 'UPDATE' THEN
    IF NOT public.quote_v2_freezing(rid) THEN
      RAISE EXCEPTION 'quote_v2_frozen_immutable: % on % happens only at freeze', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME <> 'quote_v2_lines' THEN
      RAISE EXCEPTION 'quote_v2_frozen_immutable: UPDATE on % is refused', TG_TABLE_NAME USING ERRCODE = 'P0001';
    END IF;
    -- The freeze fills in markup and sell; a line's inputs never change.
    IF (to_jsonb(NEW) - ARRAY['markup_multiplier', 'markup_source', 'markup_rule_row_id',
          'markup_rule_status', 'markup_override_id', 'markup_set_by', 'markup_set_at',
          'unit_sell_ex_gst', 'line_cost_ex_gst', 'line_sell_ex_gst'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['markup_multiplier', 'markup_source', 'markup_rule_row_id',
          'markup_rule_status', 'markup_override_id', 'markup_set_by', 'markup_set_at',
          'unit_sell_ex_gst', 'line_cost_ex_gst', 'line_sell_ex_gst']) THEN
      RAISE EXCEPTION 'quote_v2_frozen_immutable: the freeze prices a line, it never changes its inputs'
        USING ERRCODE = 'P0001';
    END IF;
    IF OLD.sell_basis <> 'cost_markup' AND NEW.unit_sell_ex_gst IS DISTINCT FROM OLD.unit_sell_ex_gst THEN
      RAISE EXCEPTION 'quote_v2_frozen_immutable: a stated sell is never re-priced' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'quote_v2_revision_parties', 'quote_v2_lines', 'quote_v2_line_splits',
    'quote_v2_line_allocations', 'quote_v2_party_totals']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.quote_v2_guard_revision_child()',
      t || '_frozen_guard', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY[
    'quote_v2_parties', 'quote_v2_party_links', 'quote_v2_link_revocations', 'quote_v2_acceptances']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.price_book_refuse_mutation()',
      t || '_append_only', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY[
    'quote_v2_parties', 'quote_v2_revisions', 'quote_v2_revision_parties', 'quote_v2_lines',
    'quote_v2_line_splits', 'quote_v2_line_allocations', 'quote_v2_party_totals',
    'quote_v2_party_links', 'quote_v2_link_revocations', 'quote_v2_acceptances']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.price_book_refuse_mutation()',
      t || '_no_truncate', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO service_role', t);
  END LOOP;
END $$;

CREATE TRIGGER quote_v2_revisions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.quote_v2_revisions
  FOR EACH ROW EXECUTE FUNCTION public.quote_v2_guard_revision();
CREATE TRIGGER quote_line_markup_overrides_draft_only
  BEFORE INSERT ON public.quote_line_markup_overrides
  FOR EACH ROW EXECUTE FUNCTION public.quote_v2_guard_revision_child();

-- ── Money helpers ───────────────────────────────────────────────────────
-- Split a whole number of cents across weights by largest remainder. The
-- parts always sum to the total exactly. Ties go to the earlier weight
-- (parties are passed in their ordinal order, client first).
CREATE OR REPLACE FUNCTION public.quote_v2_split_cents(p_total bigint, p_weights bigint[])
RETURNS bigint[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  n integer := coalesce(cardinality(p_weights), 0);
  wsum numeric := 0;
  sgn integer := CASE WHEN p_total < 0 THEN -1 ELSE 1 END;
  tot numeric := abs(p_total);
  base bigint[] := '{}';
  rem numeric[] := '{}';
  used boolean[] := '{}';
  left_over bigint;
  i integer;
  best integer;
BEGIN
  IF n = 0 THEN
    RAISE EXCEPTION 'quote_split_no_weights';
  END IF;
  FOR i IN 1..n LOOP
    IF p_weights[i] IS NULL OR p_weights[i] < 0 THEN
      RAISE EXCEPTION 'quote_split_weight_invalid';
    END IF;
    wsum := wsum + p_weights[i];
  END LOOP;
  IF wsum = 0 THEN
    IF tot = 0 THEN
      RETURN array_fill(0::bigint, ARRAY[n]);
    END IF;
    RAISE EXCEPTION 'quote_split_zero_weight: % cents have nobody to pay them', p_total;
  END IF;
  left_over := tot;
  FOR i IN 1..n LOOP
    base[i] := floor(tot * p_weights[i] / wsum);
    rem[i] := tot * p_weights[i] - base[i] * wsum;
    used[i] := false;
    left_over := left_over - base[i];
  END LOOP;
  WHILE left_over > 0 LOOP
    best := NULL;
    FOR i IN 1..n LOOP
      IF NOT used[i] AND p_weights[i] > 0 AND (best IS NULL OR rem[i] > rem[best]) THEN
        best := i;
      END IF;
    END LOOP;
    IF best IS NULL THEN
      RAISE EXCEPTION 'quote_split_internal';
    END IF;
    base[best] := base[best] + 1;
    used[best] := true;
    left_over := left_over - 1;
  END LOOP;
  FOR i IN 1..n LOOP
    base[i] := base[i] * sgn;
  END LOOP;
  RETURN base;
END $$;

-- How a price book item costs on a quote line. With a stock length, the line
-- buys whole lengths: the exact length's rate when the supplier priced that
-- length, else the supplier's generic $/LM rate, else nothing (unpriced).
CREATE OR REPLACE FUNCTION public.quote_v2_price_book_line_cost(
  p_item_key text,
  p_stock_length_mm integer
)
RETURNS TABLE (
  cost_row_id uuid,
  unit text,
  unit_cost_ex_gst numeric,
  rate_basis text,
  supplier text,
  as_at date,
  status text
)
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  item_unit text;
BEGIN
  SELECT i.unit INTO item_unit FROM public.price_book_items i WHERE i.item_key = p_item_key;
  IF item_unit IS NULL THEN
    RAISE EXCEPTION 'quote_line_item_unknown: %', p_item_key;
  END IF;
  IF p_stock_length_mm IS NULL THEN
    RETURN QUERY
      SELECT c.cost_row_id, c.unit, c.cost_ex_gst, 'item_unit'::text, c.supplier, c.as_at, c.status
      FROM public.price_book_current_costs(ARRAY[p_item_key]) c
      WHERE c.status <> 'unpriced';
    RETURN;
  END IF;
  IF item_unit <> 'lm' THEN
    RAISE EXCEPTION 'quote_line_stock_length_needs_lm_item: % is priced per %', p_item_key, item_unit;
  END IF;
  RETURN QUERY
    SELECT l.cost_row_id, 'length'::text,
      round(l.cost_ex_gst * p_stock_length_mm / 1000.0, 2),
      CASE WHEN l.per_length_mm IS NULL THEN 'per_lm_rate' ELSE 'length_rate' END,
      l.supplier, l.as_at, l.status
    FROM public.price_book_current_length_costs(ARRAY[p_item_key]) l
    WHERE l.per_length_mm = p_stock_length_mm OR l.per_length_mm IS NULL
    ORDER BY l.per_length_mm NULLS LAST
    LIMIT 1;
END $$;

-- ── Build a draft ───────────────────────────────────────────────────────
-- p_payload:
-- {
--   "family": "fencing|patio|stratco|misc",
--   "scope": {"title","summary","inclusions":[..],"exclusions":[..],"notes"},
--   "parties": [{"ref","party_id"?|"role"+"display_name","ghl_contact_id"?,
--                "share_rule","share_bp"}],
--   "lines": [{"line_key","description","category"?,"qty","unit"?,
--     "cost": {"source":"price_book","item_key","stock_length_mm"?}
--           | {"source":"stated","unit_cost_ex_gst","stated_by","evidence"}
--           | {"source":"tool","unit_cost_ex_gst","evidence"}
--           | {"source":"none"},
--     "sell": {"basis":"cost_markup","family"?}
--           | {"basis":"stated","kind":"owner","unit_sell_ex_gst","stated_by","stated_at"}
--           | {"basis":"adjustment","amount_ex_gst","stated_by","stated_at"},
--     "splits": [{"party_ref","share_bp"}]?, "duplicate_ack"?, "note"?}]
-- }
CREATE OR REPLACE FUNCTION public.quote_v2_create_draft(
  p_job_id uuid,
  p_payload jsonb,
  p_prepared_by text
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  rev_id uuid;
  rev_no integer;
  fam text;
  scope jsonb;
  pty jsonb;
  ln jsonb;
  sp jsonb;
  refs jsonb := '{}'::jsonb;
  pid uuid;
  ord integer := 0;
  cost jsonb;
  sell jsonb;
  pb_row uuid;
  pb_unit text;
  pb_cost numeric;
  pb_basis text;
  pb_supplier text;
  pb_as_at date;
  pb_status text;
  line_id uuid;
  k text;
  v_unit text;
  v_qty numeric;
BEGIN
  IF btrim(coalesce(p_prepared_by, '')) = '' THEN
    RAISE EXCEPTION 'quote_actor_missing';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'quote_payload_invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = p_job_id) THEN
    RAISE EXCEPTION 'quote_job_missing: %', p_job_id;
  END IF;
  fam := p_payload->>'family';
  IF fam IS NULL OR fam NOT IN ('fencing', 'patio', 'stratco', 'misc') THEN
    RAISE EXCEPTION 'quote_family_unknown: %', fam;
  END IF;
  scope := coalesce(p_payload->'scope', '{}'::jsonb);
  IF jsonb_typeof(scope) <> 'object' THEN
    RAISE EXCEPTION 'quote_scope_invalid';
  END IF;
  FOR k IN SELECT jsonb_object_keys(scope) LOOP
    IF k NOT IN ('title', 'summary', 'inclusions', 'exclusions', 'notes') THEN
      RAISE EXCEPTION 'quote_scope_key_unknown: % (scope is customer-facing: title, summary, inclusions, exclusions, notes)', k;
    END IF;
    IF k IN ('inclusions', 'exclusions') THEN
      IF jsonb_typeof(scope->k) <> 'array'
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(scope->k) e WHERE jsonb_typeof(e) <> 'string') THEN
        RAISE EXCEPTION 'quote_scope_invalid: % must be a list of text', k;
      END IF;
    ELSIF jsonb_typeof(scope->k) <> 'string' THEN
      RAISE EXCEPTION 'quote_scope_invalid: % must be text', k;
    END IF;
  END LOOP;
  IF (CASE WHEN jsonb_typeof(p_payload->'parties') = 'array' THEN jsonb_array_length(p_payload->'parties') = 0 ELSE true END) THEN
    RAISE EXCEPTION 'quote_parties_missing';
  END IF;
  IF (CASE WHEN jsonb_typeof(p_payload->'lines') = 'array' THEN jsonb_array_length(p_payload->'lines') = 0 ELSE true END) THEN
    RAISE EXCEPTION 'quote_revision_no_lines';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('quote_v2_job:' || p_job_id::text));
  SELECT coalesce(max(r.revision_number), 0) + 1 INTO rev_no
  FROM public.quote_v2_revisions r WHERE r.job_id = p_job_id;
  INSERT INTO public.quote_v2_revisions (job_id, revision_number, family, scope, prepared_by)
  VALUES (p_job_id, rev_no, fam, scope, p_prepared_by)
  RETURNING id INTO rev_id;

  FOR pty IN SELECT * FROM jsonb_array_elements(p_payload->'parties') LOOP
    ord := ord + 1;
    IF btrim(coalesce(pty->>'ref', '')) = '' OR refs ? (pty->>'ref') THEN
      RAISE EXCEPTION 'quote_party_ref_invalid: every party needs a unique ref';
    END IF;
    IF pty ? 'party_id' THEN
      pid := (pty->>'party_id')::uuid;
      IF NOT EXISTS (SELECT 1 FROM public.quote_v2_parties p WHERE p.id = pid AND p.job_id = p_job_id) THEN
        RAISE EXCEPTION 'quote_party_not_on_job: %', pid;
      END IF;
    ELSE
      INSERT INTO public.quote_v2_parties (job_id, role, display_name, created_by)
      VALUES (p_job_id, pty->>'role', pty->>'display_name', p_prepared_by)
      RETURNING id INTO pid;
    END IF;
    INSERT INTO public.quote_v2_revision_parties
      (revision_id, party_id, ordinal, role, display_name, ghl_contact_id, share_rule, share_bp)
    SELECT rev_id, p.id, ord, p.role, p.display_name, nullif(btrim(pty->>'ghl_contact_id'), ''),
      pty->>'share_rule', (pty->>'share_bp')::integer
    FROM public.quote_v2_parties p WHERE p.id = pid;
    refs := refs || jsonb_build_object(pty->>'ref', pid);
  END LOOP;

  ord := 0;
  FOR ln IN SELECT * FROM jsonb_array_elements(p_payload->'lines') LOOP
    ord := ord + 1;
    cost := coalesce(ln->'cost', '{"source":"none"}'::jsonb);
    sell := ln->'sell';
    IF sell IS NULL OR jsonb_typeof(sell) <> 'object' THEN
      RAISE EXCEPTION 'quote_line_sell_missing: %', ln->>'line_key';
    END IF;
    v_unit := ln->>'unit';
    v_qty := (ln->>'qty')::numeric;
    pb_row := NULL; pb_unit := NULL; pb_cost := NULL; pb_basis := NULL;
    pb_supplier := NULL; pb_as_at := NULL; pb_status := NULL;

    IF cost->>'source' = 'price_book' THEN
      SELECT c.cost_row_id, c.unit, c.unit_cost_ex_gst, c.rate_basis, c.supplier, c.as_at, c.status
      INTO pb_row, pb_unit, pb_cost, pb_basis, pb_supplier, pb_as_at, pb_status
      FROM public.quote_v2_price_book_line_cost(
        cost->>'item_key', (cost->>'stock_length_mm')::integer) c;
      IF pb_row IS NULL THEN
        RAISE EXCEPTION 'quote_line_unpriced: % (%) has no current cost for that length', ln->>'line_key', cost->>'item_key';
      END IF;
      IF v_unit IS NOT NULL AND v_unit <> pb_unit THEN
        RAISE EXCEPTION 'quote_line_unit_mismatch: % is priced per %, not %', ln->>'line_key', pb_unit, v_unit;
      END IF;
      v_unit := pb_unit;
    ELSIF cost->>'source' NOT IN ('stated', 'tool', 'none') OR cost->>'source' IS NULL THEN
      RAISE EXCEPTION 'quote_line_cost_source_unknown: %', cost->>'source';
    END IF;
    IF sell->>'basis' = 'adjustment' THEN
      v_unit := coalesce(v_unit, 'item');
      v_qty := coalesce(v_qty, 1);
    ELSIF sell->>'basis' NOT IN ('cost_markup', 'stated') OR sell->>'basis' IS NULL THEN
      RAISE EXCEPTION 'quote_line_sell_basis_unknown: %', sell->>'basis';
    END IF;
    IF sell->>'basis' = 'stated' AND sell->>'kind' IS DISTINCT FROM 'owner' THEN
      RAISE EXCEPTION 'quote_line_sell_kind_unknown: % (only the owner states a sell; a tool supplies cost)', ln->>'line_key';
    END IF;

    INSERT INTO public.quote_v2_lines (
      revision_id, line_key, ordinal, description, category, qty, unit,
      cost_source, item_key, cost_row_id, stock_length_mm, cost_rate_basis, cost_supplier,
      cost_as_at, cost_status, unit_cost_ex_gst, cost_stated_by, cost_evidence,
      sell_basis, markup_family, sell_stated_kind, sell_stated_by, sell_stated_at,
      unit_sell_ex_gst, duplicate_ack, note)
    VALUES (
      rev_id, ln->>'line_key', ord, ln->>'description', ln->>'category', v_qty, v_unit,
      cost->>'source',
      CASE WHEN cost->>'source' = 'price_book' THEN cost->>'item_key' END,
      pb_row,
      CASE WHEN pb_basis IN ('length_rate', 'per_lm_rate') THEN (cost->>'stock_length_mm')::integer END,
      pb_basis, pb_supplier, pb_as_at, pb_status,
      CASE WHEN cost->>'source' = 'price_book' THEN pb_cost
           WHEN cost->>'source' IN ('stated', 'tool') THEN (cost->>'unit_cost_ex_gst')::numeric END,
      CASE WHEN cost->>'source' = 'stated' THEN cost->>'stated_by' END,
      CASE WHEN cost->>'source' IN ('stated', 'tool') THEN cost->>'evidence' END,
      sell->>'basis',
      CASE WHEN sell->>'basis' = 'cost_markup' THEN coalesce(sell->>'family', fam) END,
      CASE WHEN sell->>'basis' = 'adjustment' THEN 'owner'
           WHEN sell->>'basis' = 'stated' THEN sell->>'kind' END,
      CASE WHEN sell->>'basis' IN ('stated', 'adjustment') THEN sell->>'stated_by' END,
      CASE WHEN sell->>'basis' IN ('stated', 'adjustment') THEN (sell->>'stated_at')::timestamptz END,
      CASE WHEN sell->>'basis' = 'stated' THEN (sell->>'unit_sell_ex_gst')::numeric
           WHEN sell->>'basis' = 'adjustment' THEN (sell->>'amount_ex_gst')::numeric END,
      nullif(btrim(ln->>'duplicate_ack'), ''),
      nullif(btrim(ln->>'note'), ''))
    RETURNING id INTO line_id;

    IF ln ? 'splits' THEN
      IF (CASE WHEN jsonb_typeof(ln->'splits') = 'array' THEN jsonb_array_length(ln->'splits') = 0 ELSE true END) THEN
        RAISE EXCEPTION 'quote_line_split_invalid: %', ln->>'line_key';
      END IF;
      FOR sp IN SELECT * FROM jsonb_array_elements(ln->'splits') LOOP
        IF NOT refs ? (sp->>'party_ref') THEN
          RAISE EXCEPTION 'quote_line_split_party_unknown: % on %', sp->>'party_ref', ln->>'line_key';
        END IF;
        INSERT INTO public.quote_v2_line_splits (line_id, party_id, share_bp)
        VALUES (line_id, (refs->>(sp->>'party_ref'))::uuid, (sp->>'share_bp')::integer);
      END LOOP;
    END IF;
  END LOOP;
  RETURN rev_id;
END $$;

-- A scoper's markup for one draft line, with who set it. The family default
-- at the time is recorded beside it.
CREATE OR REPLACE FUNCTION public.quote_v2_set_line_markup(
  p_revision_id uuid,
  p_line_key text,
  p_multiplier numeric,
  p_set_by text,
  p_reason text DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  l public.quote_v2_lines%ROWTYPE;
  new_id uuid;
BEGIN
  IF btrim(coalesce(p_set_by, '')) = '' THEN
    RAISE EXCEPTION 'quote_actor_missing';
  END IF;
  SELECT * INTO l FROM public.quote_v2_lines WHERE revision_id = p_revision_id AND line_key = p_line_key;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote_line_missing: %', p_line_key;
  END IF;
  IF l.sell_basis <> 'cost_markup' THEN
    RAISE EXCEPTION 'quote_line_not_marked_up: % is a stated sell', p_line_key;
  END IF;
  IF p_multiplier IS NULL OR p_multiplier < 1 THEN
    RAISE EXCEPTION 'quote_markup_below_cost: a markup under 1.0 sells under cost';
  END IF;
  INSERT INTO public.quote_line_markup_overrides
    (quote_revision_id, line_key, family, markup_multiplier, default_multiplier_at_set, reason, set_by)
  VALUES (p_revision_id, p_line_key, l.markup_family, p_multiplier,
    (SELECT m.value FROM public.price_book_current_markup(l.markup_family) m),
    nullif(btrim(p_reason), ''), p_set_by)
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

CREATE OR REPLACE FUNCTION public.quote_v2_norm_description(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(lower(translate(btrim(p), '×', 'x')), '\s+', ' ', 'g')
$$;

-- The job's current revision: its highest-numbered frozen revision.
CREATE OR REPLACE FUNCTION public.quote_v2_current_revision(p_job_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT r.id FROM public.quote_v2_revisions r
  WHERE r.job_id = p_job_id AND r.status = 'frozen'
  ORDER BY r.revision_number DESC LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.quote_v2_perth_today()
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'Australia/Perth')::date
$$;

-- The canonical content a party is shown and accepts; its hash is the
-- revision's content_hash. jsonb keys are stored sorted, so ::text is stable.
CREATE OR REPLACE FUNCTION public.quote_v2_revision_content(p_revision_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'revision_id', r.id,
    'job_id', r.job_id,
    'revision_number', r.revision_number,
    'family', r.family,
    'scope', r.scope,
    'valid_until', r.valid_until,
    'job_total_ex_gst', r.job_total_ex_gst,
    'job_gst', r.job_gst,
    'job_total_inc_gst', r.job_total_inc_gst,
    'parties', (SELECT jsonb_agg(jsonb_build_object(
        'party_id', rp.party_id, 'role', rp.role, 'display_name', rp.display_name,
        'share_rule', rp.share_rule, 'share_bp', rp.share_bp,
        'share_ex_gst', t.share_ex_gst, 'share_gst', t.share_gst, 'share_inc_gst', t.share_inc_gst)
        ORDER BY rp.ordinal)
      FROM public.quote_v2_revision_parties rp
      LEFT JOIN public.quote_v2_party_totals t
        ON t.revision_id = rp.revision_id AND t.party_id = rp.party_id
      WHERE rp.revision_id = r.id),
    'lines', (SELECT jsonb_agg(jsonb_build_object(
        'line_key', l.line_key, 'description', l.description, 'qty', l.qty, 'unit', l.unit,
        'unit_sell_ex_gst', l.unit_sell_ex_gst, 'line_sell_ex_gst', l.line_sell_ex_gst,
        'allocations', (SELECT jsonb_object_agg(a.party_id::text, a.amount_ex_gst)
          FROM public.quote_v2_line_allocations a WHERE a.line_id = l.id))
        ORDER BY l.ordinal)
      FROM public.quote_v2_lines l WHERE l.revision_id = r.id))
  FROM public.quote_v2_revisions r WHERE r.id = p_revision_id
$$;

-- ── Freeze: price every line, split it, total it, once ─────────────────
CREATE OR REPLACE FUNCTION public.quote_v2_freeze_revision(
  p_revision_id uuid,
  p_frozen_by text,
  p_valid_until date
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r public.quote_v2_revisions%ROWTYPE;
  l public.quote_v2_lines%ROWTYPE;
  cur_row uuid;
  ov public.quote_line_markup_overrides%ROWTYPE;
  mk_value numeric;
  mk_status text;
  mk_row uuid;
  mk_by text;
  mk_at timestamptz;
  m_source text;
  m_rule uuid;
  m_status text;
  m_override uuid;
  m_by text;
  m_at timestamptz;
  party_ids uuid[];
  party_bp bigint[];
  n_parties integer;
  n_clients integer;
  weights bigint[];
  alloc bigint[];
  party_ex bigint[];
  party_gst bigint[];
  line_cents bigint;
  job_ex bigint := 0;
  gst bigint;
  v_mult numeric;
  v_unit_sell numeric;
  v_line_sell numeric;
  v_split_sum bigint;
  dup text;
  i integer;
  h text;
BEGIN
  IF btrim(coalesce(p_frozen_by, '')) = '' THEN
    RAISE EXCEPTION 'quote_actor_missing';
  END IF;
  SELECT * INTO r FROM public.quote_v2_revisions WHERE id = p_revision_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote_revision_missing: %', p_revision_id;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('quote_v2_job:' || r.job_id::text));
  SELECT * INTO r FROM public.quote_v2_revisions WHERE id = p_revision_id;
  IF r.status <> 'draft' THEN
    RAISE EXCEPTION 'quote_revision_not_draft: revision % is already frozen', r.revision_number;
  END IF;
  IF EXISTS (SELECT 1 FROM public.quote_v2_revisions x
             WHERE x.job_id = r.job_id AND x.status = 'frozen' AND x.revision_number > r.revision_number) THEN
    RAISE EXCEPTION 'quote_revision_superseded: a later revision is already frozen';
  END IF;
  IF p_valid_until IS NULL OR p_valid_until < public.quote_v2_perth_today() THEN
    RAISE EXCEPTION 'quote_valid_until_invalid: valid until must be today or later';
  END IF;
  PERFORM set_config('quote_v2.freezing', r.id::text, true);

  SELECT array_agg(rp.party_id ORDER BY rp.ordinal), array_agg(rp.share_bp::bigint ORDER BY rp.ordinal),
    count(*), count(*) FILTER (WHERE rp.role = 'client')
  INTO party_ids, party_bp, n_parties, n_clients
  FROM public.quote_v2_revision_parties rp WHERE rp.revision_id = r.id;
  IF coalesce(n_parties, 0) = 0 THEN
    RAISE EXCEPTION 'quote_parties_missing';
  END IF;
  IF n_clients <> 1 THEN
    RAISE EXCEPTION 'quote_client_count: a revision needs exactly one client party, found %', n_clients;
  END IF;
  IF (SELECT sum(x) FROM unnest(party_bp) x) <> 10000 THEN
    RAISE EXCEPTION 'quote_party_shares_not_whole: default shares sum to % basis points, not 10000',
      (SELECT sum(x) FROM unnest(party_bp) x);
  END IF;

  -- Price every line.
  FOR l IN SELECT * FROM public.quote_v2_lines WHERE revision_id = r.id ORDER BY ordinal LOOP
    IF l.cost_source = 'price_book' THEN
      cur_row := NULL;
      SELECT c.cost_row_id INTO cur_row
      FROM public.quote_v2_price_book_line_cost(l.item_key, l.stock_length_mm) c;
      IF cur_row IS DISTINCT FROM l.cost_row_id THEN
        RAISE EXCEPTION 'quote_cost_stale: % was priced from a cost the price book has since replaced; prepare a new draft', l.line_key;
      END IF;
    END IF;
    m_source := NULL; m_rule := NULL; m_status := NULL; m_override := NULL;
    m_by := NULL; m_at := NULL; v_mult := NULL;
    IF l.sell_basis = 'cost_markup' THEN
      SELECT * INTO ov FROM public.quote_line_markup_overrides o
      WHERE o.quote_revision_id = r.id AND o.line_key = l.line_key
      ORDER BY o.set_at DESC, o.id LIMIT 1;
      IF FOUND THEN
        IF ov.family <> l.markup_family THEN
          RAISE EXCEPTION 'quote_markup_family_mismatch: %', l.line_key;
        END IF;
        v_mult := ov.markup_multiplier;
        m_source := 'line_override';
        m_override := ov.id;
        m_by := ov.set_by;
        m_at := ov.set_at;
      ELSE
        mk_value := NULL;
        SELECT m.value, m.status, m.rule_row_id, m.blessed_by, m.blessed_at
        INTO mk_value, mk_status, mk_row, mk_by, mk_at
        FROM public.price_book_current_markup(l.markup_family) m;
        IF mk_value IS NULL THEN
          RAISE EXCEPTION 'quote_markup_unset: % has no % family markup and no line markup', l.line_key, l.markup_family;
        END IF;
        v_mult := mk_value;
        m_source := 'family_default';
        m_rule := mk_row;
        m_status := mk_status;
        m_by := mk_by;
        m_at := mk_at;
      END IF;
      v_unit_sell := round(l.unit_cost_ex_gst * v_mult, 4);
    ELSE
      v_unit_sell := l.unit_sell_ex_gst;
    END IF;
    v_line_sell := round(l.qty * v_unit_sell, 2);
    IF v_line_sell = 0 THEN
      RAISE EXCEPTION 'quote_line_zero: % sells for $0.00', l.line_key;
    END IF;
    UPDATE public.quote_v2_lines SET
      markup_multiplier = v_mult,
      markup_source = m_source,
      markup_rule_row_id = m_rule,
      markup_rule_status = m_status,
      markup_override_id = m_override,
      markup_set_by = m_by,
      markup_set_at = m_at,
      unit_sell_ex_gst = v_unit_sell,
      line_sell_ex_gst = v_line_sell,
      line_cost_ex_gst = CASE WHEN l.unit_cost_ex_gst IS NULL THEN NULL
                              ELSE round(l.qty * l.unit_cost_ex_gst, 2) END
    WHERE id = l.id;
    job_ex := job_ex + (v_line_sell * 100)::bigint;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.quote_v2_lines WHERE revision_id = r.id) THEN
    RAISE EXCEPTION 'quote_revision_no_lines';
  END IF;

  -- The same thing twice (same description and unit cost, whatever the unit
  -- label) is refused unless the later copy says why: SWP-26051 counted one
  -- gutter beam twice, once as a stock line and once as a manual extra.
  SELECT string_agg(DISTINCT x.line_key, ', ') INTO dup
  FROM public.quote_v2_lines x
  JOIN public.quote_v2_lines y
    ON y.revision_id = x.revision_id AND y.ordinal < x.ordinal
   AND public.quote_v2_norm_description(y.description) = public.quote_v2_norm_description(x.description)
   AND y.unit_cost_ex_gst IS NOT DISTINCT FROM x.unit_cost_ex_gst
  WHERE x.revision_id = r.id AND x.duplicate_ack IS NULL;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'quote_line_duplicate: % repeats an earlier line; remove it or say why with duplicate_ack', dup;
  END IF;

  IF job_ex <= 0 THEN
    RAISE EXCEPTION 'quote_total_not_positive';
  END IF;
  gst := round(job_ex / 10.0);

  -- Split every line across the parties, to the cent.
  party_ex := array_fill(0::bigint, ARRAY[n_parties]);
  FOR l IN SELECT * FROM public.quote_v2_lines WHERE revision_id = r.id ORDER BY ordinal LOOP
    IF EXISTS (SELECT 1 FROM public.quote_v2_line_splits s WHERE s.line_id = l.id) THEN
      IF EXISTS (SELECT 1 FROM public.quote_v2_line_splits s
                 WHERE s.line_id = l.id AND NOT (s.party_id = ANY (party_ids))) THEN
        RAISE EXCEPTION 'quote_line_split_party_unknown: % splits to a party not on this revision', l.line_key;
      END IF;
      SELECT array_agg(coalesce(s.share_bp, 0)::bigint ORDER BY p.ord), sum(coalesce(s.share_bp, 0))
      INTO weights, v_split_sum
      FROM unnest(party_ids) WITH ORDINALITY AS p(pid, ord)
      LEFT JOIN public.quote_v2_line_splits s ON s.line_id = l.id AND s.party_id = p.pid;
      IF v_split_sum <> 10000 THEN
        RAISE EXCEPTION 'quote_line_split_not_whole: % splits % basis points, not 10000', l.line_key, v_split_sum;
      END IF;
    ELSE
      weights := party_bp;
    END IF;
    line_cents := (l.line_sell_ex_gst * 100)::bigint;
    alloc := public.quote_v2_split_cents(line_cents, weights);
    FOR i IN 1..n_parties LOOP
      INSERT INTO public.quote_v2_line_allocations (line_id, party_id, amount_ex_gst)
      VALUES (l.id, party_ids[i], alloc[i] / 100.0);
      party_ex[i] := party_ex[i] + alloc[i];
    END LOOP;
  END LOOP;

  FOR i IN 1..n_parties LOOP
    IF party_ex[i] < 0 THEN
      RAISE EXCEPTION 'quote_party_share_negative: a party''s share would be below zero';
    END IF;
  END LOOP;
  party_gst := public.quote_v2_split_cents(gst, party_ex);
  FOR i IN 1..n_parties LOOP
    INSERT INTO public.quote_v2_party_totals (revision_id, party_id, share_ex_gst, share_gst, share_inc_gst)
    VALUES (r.id, party_ids[i], party_ex[i] / 100.0, party_gst[i] / 100.0,
      (party_ex[i] + party_gst[i]) / 100.0);
  END LOOP;

  -- The rule, checked from what was stored: every party's share adds up to
  -- the job, ex GST, GST and inc GST, to the cent.
  IF (SELECT sum(t.share_ex_gst) FROM public.quote_v2_party_totals t WHERE t.revision_id = r.id) <> job_ex / 100.0
     OR (SELECT sum(t.share_gst) FROM public.quote_v2_party_totals t WHERE t.revision_id = r.id) <> gst / 100.0
     OR (SELECT sum(t.share_inc_gst) FROM public.quote_v2_party_totals t WHERE t.revision_id = r.id) <> (job_ex + gst) / 100.0
     OR EXISTS (SELECT 1 FROM public.quote_v2_lines x
                WHERE x.revision_id = r.id
                  AND x.line_sell_ex_gst <> (SELECT sum(a.amount_ex_gst) FROM public.quote_v2_line_allocations a WHERE a.line_id = x.id)) THEN
    RAISE EXCEPTION 'quote_party_totals_do_not_sum: party shares do not add up to the job total';
  END IF;

  UPDATE public.quote_v2_revisions SET
    status = 'frozen', valid_until = p_valid_until,
    job_total_ex_gst = job_ex / 100.0, job_gst = gst / 100.0,
    job_total_inc_gst = (job_ex + gst) / 100.0,
    content_hash = 'sha256:' || repeat('0', 64),
    frozen_by = p_frozen_by, frozen_at = now()
  WHERE id = r.id;
  h := 'sha256:' || encode(sha256(convert_to(public.quote_v2_revision_content(r.id)::text, 'UTF8')), 'hex');
  -- The hash covers the frozen totals, so it is written in the same freeze.
  PERFORM set_config('quote_v2.hashing', r.id::text, true);
  UPDATE public.quote_v2_revisions SET content_hash = h WHERE id = r.id;
  PERFORM set_config('quote_v2.freezing', '', true);
  PERFORM set_config('quote_v2.hashing', '', true);

  RETURN jsonb_build_object(
    'revision_id', r.id, 'revision_number', r.revision_number, 'content_hash', h,
    'job_total_ex_gst', (job_ex / 100.0)::numeric(12,2), 'job_gst', (gst / 100.0)::numeric(12,2),
    'job_total_inc_gst', ((job_ex + gst) / 100.0)::numeric(12,2),
    'parties', (SELECT jsonb_agg(jsonb_build_object('party_id', t.party_id,
        'share_ex_gst', t.share_ex_gst, 'share_gst', t.share_gst, 'share_inc_gst', t.share_inc_gst)
        ORDER BY rp.ordinal)
      FROM public.quote_v2_party_totals t
      JOIN public.quote_v2_revision_parties rp USING (revision_id, party_id)
      WHERE t.revision_id = r.id));
END $$;


-- ── Party links ─────────────────────────────────────────────────────────
-- Issue a link for one party on the job's CURRENT revision. Returns the
-- token once; only its sha256 is stored. Issuing sends nothing.
CREATE OR REPLACE FUNCTION public.quote_v2_issue_party_link(
  p_revision_id uuid,
  p_party_id uuid,
  p_issued_by text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r public.quote_v2_revisions%ROWTYPE;
  t public.quote_v2_party_totals%ROWTYPE;
  token text;
  link_id uuid;
BEGIN
  IF btrim(coalesce(p_issued_by, '')) = '' THEN
    RAISE EXCEPTION 'quote_actor_missing';
  END IF;
  SELECT * INTO r FROM public.quote_v2_revisions WHERE id = p_revision_id;
  IF NOT FOUND OR r.status <> 'frozen' THEN
    RAISE EXCEPTION 'quote_revision_not_frozen';
  END IF;
  IF public.quote_v2_current_revision(r.job_id) IS DISTINCT FROM r.id THEN
    RAISE EXCEPTION 'quote_revision_not_current: revision % has been replaced', r.revision_number;
  END IF;
  SELECT * INTO t FROM public.quote_v2_party_totals WHERE revision_id = r.id AND party_id = p_party_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote_party_not_on_revision';
  END IF;
  IF t.share_inc_gst = 0 THEN
    RAISE EXCEPTION 'quote_party_nothing_to_accept: this party pays nothing on this revision';
  END IF;
  token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO public.quote_v2_party_links (revision_id, party_id, token_sha256, issued_by)
  VALUES (r.id, p_party_id, encode(sha256(convert_to(token, 'UTF8')), 'hex'), p_issued_by)
  RETURNING id INTO link_id;
  RETURN jsonb_build_object('link_id', link_id, 'token', token,
    'revision_id', r.id, 'party_id', p_party_id);
END $$;

-- Revocation is per party per quote: revoking any one link revokes every link
-- that party holds for the job (older forwarding links included), so a link
-- that reached the wrong person cannot be reopened through an earlier one.
CREATE OR REPLACE FUNCTION public.quote_v2_revoke_party_link(
  p_link_id uuid,
  p_revoked_by text,
  p_reason text
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  pid uuid;
  n integer;
BEGIN
  SELECT k.party_id INTO pid FROM public.quote_v2_party_links k WHERE k.id = p_link_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote_link_missing: %', p_link_id;
  END IF;
  INSERT INTO public.quote_v2_link_revocations (link_id, reason, revoked_by)
  SELECT k.id, p_reason, p_revoked_by FROM public.quote_v2_party_links k
  WHERE k.party_id = pid
  ON CONFLICT (link_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- What ONE party may see of one revision. Never costs, markups, sources,
-- tokens, contact details, or another party's amounts; other parties appear
-- by first name with their share of the job.
CREATE OR REPLACE FUNCTION public.quote_v2_party_view(p_revision_id uuid, p_party_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'revision_id', r.id,
    'revision_number', r.revision_number,
    'content_hash', r.content_hash,
    'job_number', j.job_number,
    'site_suburb', j.site_suburb,
    'family', r.family,
    'scope', r.scope,
    'valid_until', r.valid_until,
    'expired', r.valid_until < public.quote_v2_perth_today(),
    'job_total', jsonb_build_object('ex_gst', r.job_total_ex_gst, 'gst', r.job_gst, 'inc_gst', r.job_total_inc_gst),
    'party', jsonb_build_object(
      'party_id', me.party_id,
      'first_name', split_part(btrim(me.display_name), ' ', 1),
      'role', me.role,
      'share', jsonb_build_object('ex_gst', mt.share_ex_gst, 'gst', mt.share_gst, 'inc_gst', mt.share_inc_gst),
      'share_of_job_percent', round(mt.share_ex_gst * 100 / r.job_total_ex_gst, 1)),
    'lines', (SELECT jsonb_agg(jsonb_build_object(
        'description', l.description, 'qty', l.qty, 'unit', l.unit,
        'line_total_ex_gst', l.line_sell_ex_gst, 'your_share_ex_gst', a.amount_ex_gst)
        ORDER BY l.ordinal)
      FROM public.quote_v2_lines l
      JOIN public.quote_v2_line_allocations a ON a.line_id = l.id AND a.party_id = me.party_id
      WHERE l.revision_id = r.id),
    'other_parties', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'first_name', split_part(btrim(o.display_name), ' ', 1),
        'role', o.role,
        'share_of_job_percent', round(ot.share_ex_gst * 100 / r.job_total_ex_gst, 1))
        ORDER BY o.ordinal)
      FROM public.quote_v2_revision_parties o
      JOIN public.quote_v2_party_totals ot ON ot.revision_id = o.revision_id AND ot.party_id = o.party_id
      WHERE o.revision_id = r.id AND o.party_id <> me.party_id), '[]'::jsonb),
    'accepted_at', (SELECT a.accepted_at FROM public.quote_v2_acceptances a
      WHERE a.revision_id = r.id AND a.party_id = me.party_id))
  FROM public.quote_v2_revisions r
  JOIN public.jobs j ON j.id = r.job_id
  JOIN public.quote_v2_revision_parties me ON me.revision_id = r.id AND me.party_id = p_party_id
  JOIN public.quote_v2_party_totals mt ON mt.revision_id = r.id AND mt.party_id = p_party_id
  WHERE r.id = p_revision_id AND r.status = 'frozen'
$$;

-- Resolve a party link to that party's CURRENT revision. A link to a
-- replaced revision forwards to the same party's current one; it never
-- reaches another party's quote.
CREATE OR REPLACE FUNCTION public.quote_v2_link_target(p_token text)
RETURNS TABLE (
  state text,
  link_id uuid,
  party_id uuid,
  link_revision_id uuid,
  link_revision_number integer,
  current_revision_id uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  lk public.quote_v2_party_links%ROWTYPE;
  job uuid;
  lrev integer;
  cur uuid;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'unknown'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer, NULL::uuid;
    RETURN;
  END IF;
  SELECT * INTO lk FROM public.quote_v2_party_links
  WHERE token_sha256 = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'unknown'::text, NULL::uuid, NULL::uuid, NULL::uuid, NULL::integer, NULL::uuid;
    RETURN;
  END IF;
  SELECT r.job_id, r.revision_number INTO job, lrev FROM public.quote_v2_revisions r WHERE r.id = lk.revision_id;
  IF EXISTS (SELECT 1 FROM public.quote_v2_link_revocations v WHERE v.link_id = lk.id) THEN
    RETURN QUERY SELECT 'revoked'::text, lk.id, NULL::uuid, NULL::uuid, NULL::integer, NULL::uuid;
    RETURN;
  END IF;
  cur := public.quote_v2_current_revision(job);
  IF cur = lk.revision_id THEN
    RETURN QUERY SELECT 'current'::text, lk.id, lk.party_id, lk.revision_id, lrev, cur;
  ELSIF EXISTS (SELECT 1 FROM public.quote_v2_party_totals t
                WHERE t.revision_id = cur AND t.party_id = lk.party_id AND t.share_inc_gst > 0) THEN
    RETURN QUERY SELECT 'forwarded'::text, lk.id, lk.party_id, lk.revision_id, lrev, cur;
  ELSE
    RETURN QUERY SELECT 'no_current_quote'::text, lk.id, lk.party_id, lk.revision_id, lrev, NULL::uuid;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.quote_v2_open_party_link(p_token text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'state', t.state,
    'link_revision_number', CASE WHEN t.state IN ('current', 'forwarded', 'no_current_quote')
                                 THEN t.link_revision_number END,
    'quote', CASE WHEN t.state IN ('current', 'forwarded')
                  THEN public.quote_v2_party_view(t.current_revision_id, t.party_id) END)
  FROM public.quote_v2_link_target(p_token) t
$$;

-- Which parties must accept the current revision (every party with a
-- non-zero share), who has, and whether the job is fully accepted.
CREATE OR REPLACE FUNCTION public.quote_v2_job_acceptance(p_job_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH cur AS (SELECT public.quote_v2_current_revision(p_job_id) AS id),
  need AS (
    SELECT t.party_id, rp.ordinal, a.accepted_at
    FROM cur
    JOIN public.quote_v2_party_totals t ON t.revision_id = cur.id AND t.share_inc_gst > 0
    JOIN public.quote_v2_revision_parties rp ON rp.revision_id = t.revision_id AND rp.party_id = t.party_id
    LEFT JOIN public.quote_v2_acceptances a ON a.revision_id = t.revision_id AND a.party_id = t.party_id
  )
  SELECT jsonb_build_object(
    'job_id', p_job_id,
    'current_revision_id', (SELECT id FROM cur),
    'parties', coalesce((SELECT jsonb_agg(jsonb_build_object('party_id', party_id, 'accepted_at', accepted_at)
      ORDER BY ordinal) FROM need), '[]'::jsonb),
    'fully_accepted', (SELECT id FROM cur) IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM need WHERE accepted_at IS NULL))
$$;

-- Accept: one party, the current revision, exactly what they were shown.
CREATE OR REPLACE FUNCTION public.quote_v2_accept(
  p_token text,
  p_revision_id uuid,
  p_content_hash text,
  p_accepted_name text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t record;
  r public.quote_v2_revisions%ROWTYPE;
  prior public.quote_v2_acceptances%ROWTYPE;
  job uuid;
BEGIN
  SELECT * INTO t FROM public.quote_v2_link_target(p_token);
  IF t.state IN ('unknown', 'revoked') THEN
    RAISE EXCEPTION 'quote_link_invalid';
  END IF;
  SELECT rv.job_id INTO job FROM public.quote_v2_revisions rv WHERE rv.id = t.link_revision_id;
  PERFORM pg_advisory_xact_lock(hashtext('quote_v2_job:' || job::text));
  -- Re-resolve under the job lock: a freeze may have replaced the revision.
  SELECT * INTO t FROM public.quote_v2_link_target(p_token);
  IF t.state = 'no_current_quote' THEN
    RAISE EXCEPTION 'quote_party_nothing_to_accept: there is no current quote for this party';
  END IF;
  IF p_revision_id IS DISTINCT FROM t.current_revision_id THEN
    RAISE EXCEPTION 'quote_revision_not_current: this quote was updated; open the link again';
  END IF;
  SELECT * INTO r FROM public.quote_v2_revisions WHERE id = t.current_revision_id;
  IF p_content_hash IS DISTINCT FROM r.content_hash THEN
    RAISE EXCEPTION 'quote_content_changed: what was accepted is not this revision';
  END IF;
  IF r.valid_until < public.quote_v2_perth_today() THEN
    RAISE EXCEPTION 'quote_expired: this quote was valid until %', r.valid_until;
  END IF;
  SELECT * INTO prior FROM public.quote_v2_acceptances a
  WHERE a.revision_id = r.id AND a.party_id = t.party_id;
  IF FOUND THEN
    RETURN jsonb_build_object('state', 'already_accepted', 'accepted_at', prior.accepted_at,
      'job_fully_accepted', public.quote_v2_job_acceptance(r.job_id)->'fully_accepted');
  END IF;
  INSERT INTO public.quote_v2_acceptances (revision_id, party_id, link_id, content_hash, accepted_name)
  VALUES (r.id, t.party_id, t.link_id, r.content_hash, nullif(btrim(left(p_accepted_name, 200)), ''))
  RETURNING * INTO prior;
  RETURN jsonb_build_object('state', 'accepted', 'accepted_at', prior.accepted_at,
    'job_fully_accepted', public.quote_v2_job_acceptance(r.job_id)->'fully_accepted');
END $$;

-- ── Staff read ──────────────────────────────────────────────────────────
-- Where a line's price came from, in words, for the owner's preview.
CREATE OR REPLACE FUNCTION public.quote_v2_line_price_source(l public.quote_v2_lines)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE l.sell_basis
    WHEN 'cost_markup' THEN
      'cost ' || CASE l.cost_source
        WHEN 'price_book' THEN 'from price book ' || l.item_key
          || coalesce(' ' || l.stock_length_mm || ' mm length', '')
          || ', ' || l.cost_supplier || ' as at ' || l.cost_as_at
          || ' (' || l.cost_status || CASE l.cost_rate_basis WHEN 'per_lm_rate' THEN ', generic $/LM rate' ELSE '' END || ')'
        WHEN 'stated' THEN 'stated by ' || l.cost_stated_by || ' (' || l.cost_evidence || ')'
        WHEN 'tool' THEN 'from tool (' || l.cost_evidence || ')'
        ELSE 'unknown' END
      || coalesce(' x ' || CASE WHEN scale(trim_scale(l.markup_multiplier)) <= 2 THEN to_char(l.markup_multiplier, 'FM9990.00') ELSE trim_scale(l.markup_multiplier)::text END || CASE l.markup_source
        WHEN 'line_override' THEN ' set by ' || l.markup_set_by || ' at ' || l.markup_set_at
        ELSE ' ' || l.markup_family || ' default (' || coalesce(l.markup_rule_status, '') || ')' END,
        ' x ' || l.markup_family || ' markup (not yet frozen)')
    WHEN 'stated' THEN 'sell stated by ' || l.sell_stated_by || ' at ' || l.sell_stated_at
      || CASE WHEN l.cost_source = 'none' THEN ', no cost recorded' ELSE '' END
    ELSE 'adjustment by ' || l.sell_stated_by || ': ' || l.note END
$$;

-- Everything about one revision for staff: costs, markups, sources, parties
-- with their GHL contact, per-party totals and acceptances. Never a token.
CREATE OR REPLACE FUNCTION public.quote_v2_staff_revision(p_revision_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'revision', to_jsonb(r),
    'is_current', public.quote_v2_current_revision(r.job_id) = r.id,
    'parties', (SELECT jsonb_agg(to_jsonb(rp) || jsonb_build_object(
        'share_ex_gst', t.share_ex_gst, 'share_gst', t.share_gst, 'share_inc_gst', t.share_inc_gst,
        'accepted_at', a.accepted_at, 'accepted_name', a.accepted_name)
        ORDER BY rp.ordinal)
      FROM public.quote_v2_revision_parties rp
      LEFT JOIN public.quote_v2_party_totals t ON t.revision_id = rp.revision_id AND t.party_id = rp.party_id
      LEFT JOIN public.quote_v2_acceptances a ON a.revision_id = rp.revision_id AND a.party_id = rp.party_id
      WHERE rp.revision_id = r.id),
    'lines', (SELECT jsonb_agg(to_jsonb(l) || jsonb_build_object(
        'price_source', public.quote_v2_line_price_source(l),
        'splits', (SELECT jsonb_object_agg(sp.party_id::text, sp.share_bp)
          FROM public.quote_v2_line_splits sp WHERE sp.line_id = l.id),
        'allocations', (SELECT jsonb_object_agg(al.party_id::text, al.amount_ex_gst)
          FROM public.quote_v2_line_allocations al WHERE al.line_id = l.id))
        ORDER BY l.ordinal)
      FROM public.quote_v2_lines l WHERE l.revision_id = r.id),
    'links', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'link_id', k.id, 'party_id', k.party_id, 'issued_by', k.issued_by, 'issued_at', k.issued_at,
        'revoked_at', v.revoked_at) ORDER BY k.issued_at)
      FROM public.quote_v2_party_links k
      LEFT JOIN public.quote_v2_link_revocations v ON v.link_id = k.id
      WHERE k.revision_id = r.id), '[]'::jsonb))
  FROM public.quote_v2_revisions r WHERE r.id = p_revision_id
$$;

-- ── Grants ──────────────────────────────────────────────────────────────
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.price_book_subject_lock_key(text, jsonb)',
    'public.price_book_current_length_costs(text[])',
    'public.quote_v2_freezing(uuid)',
    'public.quote_v2_split_cents(bigint, bigint[])',
    'public.quote_v2_price_book_line_cost(text, integer)',
    'public.quote_v2_create_draft(uuid, jsonb, text)',
    'public.quote_v2_set_line_markup(uuid, text, numeric, text, text)',
    'public.quote_v2_norm_description(text)',
    'public.quote_v2_current_revision(uuid)',
    'public.quote_v2_perth_today()',
    'public.quote_v2_revision_content(uuid)',
    'public.quote_v2_freeze_revision(uuid, text, date)',
    'public.quote_v2_issue_party_link(uuid, uuid, text)',
    'public.quote_v2_revoke_party_link(uuid, text, text)',
    'public.quote_v2_party_view(uuid, uuid)',
    'public.quote_v2_link_target(text)',
    'public.quote_v2_open_party_link(text)',
    'public.quote_v2_job_acceptance(uuid)',
    'public.quote_v2_accept(text, uuid, text, text)',
    'public.quote_v2_line_price_source(public.quote_v2_lines)',
    'public.quote_v2_staff_revision(uuid)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
