-- Quote v2, stage 1: the price book. PROGRAM BRANCH ONLY (program/quote-v2).
-- Never applied to production until the owner carries the program over.
--
-- One home for what materials COST US, with full history. Sell price is not
-- stored here as a primary value: markup is a separate layer (family default,
-- adjustable per quote line with who set it). Owner, 24 Sep 2026: "I just
-- want the tools to capture the accurate pricing of the costs to us. And we
-- can add the markup of what we want."
--
-- Rules the schema enforces:
-- * Append-only. Every change is a new dated row; UPDATE, DELETE and
--   TRUNCATE are refused on every price book table.
-- * A cost is never zero. An item with no cost row reads as `unpriced`, so a
--   $0 sentinel can never quote silently.
-- * Every row names its evidence (invoice, supplier quote or estimate, price
--   list, owner stated, tool constant) and an as-at date.
-- * A row is PROVISIONAL until blessed; blessed rows carry who and when.
--   Blessing happens only by approving a proposed change, and the approver is
--   whoever `price_book_approvers` lists for that scope (left empty on
--   purpose: who approves is an open owner call).
-- * Private: RLS on, no anon or authenticated access. Tools and the terminal
--   read through the `price-book` edge function.
--
-- Contract: docs/quote-v2/price-book-v1.md.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ── Helpers ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.price_book_is_slug(p text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p IS NOT NULL AND length(p) <= 120 AND p ~ '^[a-z0-9]+([._-][a-z0-9]+)*$'
$$;

CREATE OR REPLACE FUNCTION public.price_book_lengths_ok(p integer[])
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p IS NOT NULL
     AND cardinality(p) > 0
     AND array_position(p, NULL) IS NULL
     AND 0 < ALL (p)
     AND p = ARRAY(SELECT DISTINCT x FROM unnest(p) AS x ORDER BY x)
$$;

-- Evidence strength, strongest first. Used only to order PROVISIONAL rows:
-- a blessed row always beats every provisional row.
CREATE OR REPLACE FUNCTION public.price_book_evidence_rank(p text)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p
    WHEN 'invoice' THEN 1
    WHEN 'purchase_order' THEN 1
    WHEN 'supplier_quote' THEN 2
    WHEN 'supplier_estimate' THEN 2
    WHEN 'price_list' THEN 3
    WHEN 'owner_stated' THEN 4
    WHEN 'tool_constant' THEN 5
    ELSE 9 END
$$;

CREATE OR REPLACE FUNCTION public.price_book_refuse_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'price_book_append_only: % on % is refused; add a new dated row',
    TG_OP, TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;

-- ── Items: what a thing is ──────────────────────────────────────────────
CREATE TABLE public.price_book_items (
  item_key text PRIMARY KEY CHECK (public.price_book_is_slug(item_key)),
  family text NOT NULL CHECK (family IN ('fencing', 'patio', 'stratco', 'misc')),
  category text NOT NULL CHECK (public.price_book_is_slug(category)),
  description text NOT NULL CHECK (btrim(description) <> ''),
  unit text NOT NULL CHECK (unit IN (
    'lm', 'm2', 'each', 'bag', 'box', 'pack', 'kit', 'sheet', 'length',
    'delivery', 'job', 'hour', 'day')),
  note text,
  created_by text NOT NULL CHECK (btrim(created_by) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  import_fingerprint text UNIQUE
);
COMMENT ON TABLE public.price_book_items IS
  'Quote v2 price book item identity. Immutable: a changed description or unit is a new item_key.';

-- ── Proposals and decisions (declared first: applied rows point here) ────
CREATE TABLE public.price_book_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target text NOT NULL CHECK (target IN (
    'cost', 'stock_lengths', 'cut_rule', 'markup_rule', 'allowance')),
  subject jsonb NOT NULL CHECK (jsonb_typeof(subject) = 'object'),
  old_row_id uuid,
  old_value jsonb,
  new_value jsonb NOT NULL CHECK (jsonb_typeof(new_value) = 'object'),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  evidence_ref text NOT NULL CHECK (btrim(evidence_ref) <> ''),
  proposed_by text NOT NULL CHECK (btrim(proposed_by) <> ''),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((old_row_id IS NULL) = (old_value IS NULL))
);
COMMENT ON TABLE public.price_book_proposals IS
  'Proposed price book change: old vs new, who proposed. Decided in price_book_proposal_decisions.';

-- ── Shared evidence and blessing columns (written out per table) ────────
-- as_at date, evidence_kind, evidence_ref, evidence_note, provisional,
-- blessed_by, blessed_at, recorded_by, recorded_at, proposal_id,
-- import_fingerprint.

CREATE TABLE public.price_book_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_key text NOT NULL REFERENCES public.price_book_items(item_key),
  supplier text NOT NULL CHECK (btrim(supplier) <> ''),
  supplier_code text,
  cost_ex_gst numeric(12,4) NOT NULL CHECK (cost_ex_gst > 0),
  -- Set when the price was for one stock length (a 6.5 m length costs less
  -- per metre than a 3.5 m one). cost_ex_gst is still per the item unit.
  per_length_mm integer CHECK (per_length_mm IS NULL OR per_length_mm > 0),
  as_at date NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind IN (
    'invoice', 'purchase_order', 'supplier_quote', 'supplier_estimate',
    'price_list', 'owner_stated', 'tool_constant')),
  evidence_ref text NOT NULL CHECK (btrim(evidence_ref) <> ''),
  evidence_note text,
  provisional boolean NOT NULL DEFAULT true,
  blessed_by text,
  blessed_at timestamptz,
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  proposal_id uuid REFERENCES public.price_book_proposals(id),
  import_fingerprint text UNIQUE,
  CHECK ((provisional AND blessed_by IS NULL AND blessed_at IS NULL)
      OR (NOT provisional AND btrim(coalesce(blessed_by, '')) <> '' AND blessed_at IS NOT NULL))
);
COMMENT ON TABLE public.price_book_costs IS
  'Cost to us, ex GST, per the item unit. One row per observation; the current row is chosen by price_book_current_costs.';
CREATE INDEX price_book_costs_item_idx ON public.price_book_costs (item_key, as_at DESC);

CREATE TABLE public.price_book_stock_lengths (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_key text NOT NULL REFERENCES public.price_book_items(item_key),
  supplier text NOT NULL CHECK (btrim(supplier) <> ''),
  lengths_mm integer[] NOT NULL CHECK (public.price_book_lengths_ok(lengths_mm)),
  as_at date NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind IN (
    'invoice', 'purchase_order', 'supplier_quote', 'supplier_estimate',
    'price_list', 'owner_stated', 'tool_constant')),
  evidence_ref text NOT NULL CHECK (btrim(evidence_ref) <> ''),
  evidence_note text,
  provisional boolean NOT NULL DEFAULT true,
  blessed_by text,
  blessed_at timestamptz,
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  proposal_id uuid REFERENCES public.price_book_proposals(id),
  import_fingerprint text UNIQUE,
  CHECK ((provisional AND blessed_by IS NULL AND blessed_at IS NULL)
      OR (NOT provisional AND btrim(coalesce(blessed_by, '')) <> '' AND blessed_at IS NOT NULL))
);
COMMENT ON TABLE public.price_book_stock_lengths IS
  'Lengths (mm) a supplier sells an item in, ascending. Input to the shared cut-to-order function.';
CREATE INDEX price_book_stock_lengths_item_idx ON public.price_book_stock_lengths (item_key, supplier, as_at DESC);

CREATE TABLE public.price_book_cut_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_key text NOT NULL REFERENCES public.price_book_items(item_key),
  rule text NOT NULL CHECK (rule IN ('one_per_stick', 'nest', 'cut_to_size')),
  kerf_mm numeric(6,2) NOT NULL DEFAULT 3 CHECK (kerf_mm >= 0),
  as_at date NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind IN (
    'invoice', 'purchase_order', 'supplier_quote', 'supplier_estimate',
    'price_list', 'owner_stated', 'tool_constant')),
  evidence_ref text NOT NULL CHECK (btrim(evidence_ref) <> ''),
  evidence_note text,
  provisional boolean NOT NULL DEFAULT true,
  blessed_by text,
  blessed_at timestamptz,
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  proposal_id uuid REFERENCES public.price_book_proposals(id),
  import_fingerprint text UNIQUE,
  CHECK ((provisional AND blessed_by IS NULL AND blessed_at IS NULL)
      OR (NOT provisional AND btrim(coalesce(blessed_by, '')) <> '' AND blessed_at IS NOT NULL))
);
COMMENT ON TABLE public.price_book_cut_rules IS
  'How an item is cut: one piece per stick, several nested per stick with a saw kerf, or cut to size by the supplier.';
CREATE INDEX price_book_cut_rules_item_idx ON public.price_book_cut_rules (item_key, as_at DESC);

-- Markup is the sell layer on top of cost. category NULL is the family
-- default. value NULL means "not set yet" and is only allowed provisional.
CREATE TABLE public.price_book_markup_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family text NOT NULL CHECK (family IN ('fencing', 'patio', 'stratco', 'misc')),
  category text CHECK (category IS NULL OR public.price_book_is_slug(category)),
  rule_kind text NOT NULL CHECK (rule_kind IN ('markup_multiplier', 'margin')),
  value numeric(8,4),
  as_at date NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind IN (
    'invoice', 'purchase_order', 'supplier_quote', 'supplier_estimate',
    'price_list', 'owner_stated', 'tool_constant')),
  evidence_ref text NOT NULL CHECK (btrim(evidence_ref) <> ''),
  evidence_note text,
  provisional boolean NOT NULL DEFAULT true,
  blessed_by text,
  blessed_at timestamptz,
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  proposal_id uuid REFERENCES public.price_book_proposals(id),
  import_fingerprint text UNIQUE,
  CHECK ((provisional AND blessed_by IS NULL AND blessed_at IS NULL)
      OR (NOT provisional AND btrim(coalesce(blessed_by, '')) <> '' AND blessed_at IS NOT NULL)),
  CHECK (value IS NOT NULL OR provisional),
  CHECK (value IS NULL
      OR (rule_kind = 'markup_multiplier' AND value >= 1)
      OR (rule_kind = 'margin' AND value >= 0 AND value < 1))
);
COMMENT ON TABLE public.price_book_markup_rules IS
  'Default markup per family (category NULL) or family+category. Scopers override per quote line in quote_line_markup_overrides.';

-- Job-family allowances: things priced per job geometry, not per item.
CREATE TABLE public.price_book_allowances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family text NOT NULL CHECK (family IN ('fencing', 'patio', 'stratco', 'misc')),
  allowance_key text NOT NULL CHECK (public.price_book_is_slug(allowance_key)),
  description text NOT NULL CHECK (btrim(description) <> ''),
  basis text NOT NULL CHECK (basis IN (
    'per_lm', 'per_lm_by_girth_band', 'per_m2', 'per_m2_of_girth', 'per_job', 'per_post')),
  girth_min_mm integer,
  girth_max_mm integer,
  cost_ex_gst numeric(12,4) NOT NULL CHECK (cost_ex_gst > 0),
  as_at date NOT NULL,
  evidence_kind text NOT NULL CHECK (evidence_kind IN (
    'invoice', 'purchase_order', 'supplier_quote', 'supplier_estimate',
    'price_list', 'owner_stated', 'tool_constant')),
  evidence_ref text NOT NULL CHECK (btrim(evidence_ref) <> ''),
  evidence_note text,
  provisional boolean NOT NULL DEFAULT true,
  blessed_by text,
  blessed_at timestamptz,
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  proposal_id uuid REFERENCES public.price_book_proposals(id),
  import_fingerprint text UNIQUE,
  CHECK ((provisional AND blessed_by IS NULL AND blessed_at IS NULL)
      OR (NOT provisional AND btrim(coalesce(blessed_by, '')) <> '' AND blessed_at IS NOT NULL)),
  CHECK ((basis = 'per_lm_by_girth_band') = (girth_min_mm IS NOT NULL AND girth_max_mm IS NOT NULL)),
  CHECK (basis = 'per_lm_by_girth_band' OR (girth_min_mm IS NULL AND girth_max_mm IS NULL)),
  CHECK (girth_min_mm IS NULL OR (girth_min_mm >= 0 AND girth_max_mm >= girth_min_mm))
);
COMMENT ON TABLE public.price_book_allowances IS
  'Cost allowances per job family: flashings by girth band per metre, fixings per m2, sundries per job.';

-- Who may approve a proposal. Deliberately seeded EMPTY: the approver is an
-- open owner call. Latest row per (scope_kind, scope_value, approver) wins;
-- deactivating is a new row with active = false.
CREATE TABLE public.price_book_approvers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_kind text NOT NULL CHECK (scope_kind IN ('any', 'family', 'supplier', 'target')),
  scope_value text,
  approver text NOT NULL CHECK (btrim(approver) <> ''),
  active boolean NOT NULL,
  note text,
  recorded_by text NOT NULL CHECK (btrim(recorded_by) <> ''),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope_kind = 'any') = (scope_value IS NULL))
);

CREATE TABLE public.price_book_proposal_decisions (
  proposal_id uuid PRIMARY KEY REFERENCES public.price_book_proposals(id),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'withdrawn')),
  decided_by text NOT NULL CHECK (btrim(decided_by) <> ''),
  decided_at timestamptz NOT NULL DEFAULT now(),
  note text,
  applied_row_id uuid,
  CHECK ((decision = 'approved') = (applied_row_id IS NOT NULL))
);

-- Per-quote-line markup chosen by the scoper, with who set it. The quote
-- revision and line tables arrive in a later stage; until then the line is
-- identified by (quote_revision_id, line_key) with no foreign key. Latest
-- set_at per line wins. Below cost is refused.
CREATE TABLE public.quote_line_markup_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_revision_id uuid NOT NULL,
  line_key text NOT NULL CHECK (btrim(line_key) <> ''),
  family text NOT NULL CHECK (family IN ('fencing', 'patio', 'stratco', 'misc')),
  category text CHECK (category IS NULL OR public.price_book_is_slug(category)),
  markup_multiplier numeric(8,4) NOT NULL CHECK (markup_multiplier >= 1),
  default_multiplier_at_set numeric(8,4),
  reason text,
  set_by text NOT NULL CHECK (btrim(set_by) <> ''),
  set_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quote_line_markup_overrides_line_idx
  ON public.quote_line_markup_overrides (quote_revision_id, line_key, set_at DESC);

-- ── Append-only everywhere ──────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'price_book_items', 'price_book_costs', 'price_book_stock_lengths',
    'price_book_cut_rules', 'price_book_markup_rules', 'price_book_allowances',
    'price_book_approvers', 'price_book_proposals', 'price_book_proposal_decisions',
    'quote_line_markup_overrides']
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

GRANT INSERT ON public.price_book_costs, public.price_book_proposals TO service_role;

CREATE OR REPLACE FUNCTION public.price_book_guard_cost_blessing()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user = 'service_role' AND NEW.provisional IS NOT TRUE THEN
    RAISE EXCEPTION 'price_book_blessing_requires_proposal' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER price_book_costs_guard_blessing
  BEFORE INSERT ON public.price_book_costs
  FOR EACH ROW EXECUTE FUNCTION public.price_book_guard_cost_blessing();

-- ── Current reads ───────────────────────────────────────────────────────
-- Current cost per item: the newest BLESSED row; with none blessed, the
-- strongest-evidence provisional row, newest first. An item with no cost row
-- is returned as `unpriced` with a null cost.
CREATE OR REPLACE FUNCTION public.price_book_current_costs(
  p_item_keys text[] DEFAULT NULL,
  p_family text DEFAULT NULL
)
RETURNS TABLE (
  item_key text,
  family text,
  category text,
  description text,
  unit text,
  status text,
  cost_ex_gst numeric,
  per_length_mm integer,
  supplier text,
  supplier_code text,
  as_at date,
  evidence_kind text,
  evidence_ref text,
  provisional boolean,
  blessed_by text,
  blessed_at timestamptz,
  cost_row_id uuid,
  newer_provisional_row_id uuid,
  stock_lengths_mm integer[],
  stock_supplier text,
  stock_provisional boolean,
  cut_rule text,
  kerf_mm numeric,
  cut_provisional boolean
)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH items AS (
    SELECT i.* FROM public.price_book_items i
    WHERE (p_item_keys IS NULL OR i.item_key = ANY (p_item_keys))
      AND (p_family IS NULL OR i.family = p_family)
  ),
  cost AS (
    -- Same date and evidence: the price for the longest stock length (the
    -- standard buy) is the headline; per-length prices stay in history.
    SELECT DISTINCT ON (c.item_key) c.*
    FROM public.price_book_costs c JOIN items USING (item_key)
    ORDER BY c.item_key, c.provisional,
      CASE WHEN c.provisional THEN public.price_book_evidence_rank(c.evidence_kind) ELSE 0 END,
      c.as_at DESC, c.per_length_mm DESC NULLS LAST, c.recorded_at DESC, c.id
  ),
  newer AS (
    -- A provisional observation newer than the blessed current row: shown so
    -- nobody mistakes a blessed price for the latest evidence.
    SELECT DISTINCT ON (c.item_key) c.item_key, c.id
    FROM public.price_book_costs c JOIN cost cur USING (item_key)
    WHERE NOT cur.provisional AND c.provisional AND c.as_at > cur.as_at
    ORDER BY c.item_key, c.as_at DESC, c.recorded_at DESC, c.id
  ),
  stock AS (
    SELECT DISTINCT ON (s.item_key) s.item_key, s.lengths_mm, s.supplier, s.provisional
    FROM public.price_book_stock_lengths s
    JOIN items USING (item_key)
    LEFT JOIN cost ON cost.item_key = s.item_key
    ORDER BY s.item_key, (s.supplier IS NOT DISTINCT FROM cost.supplier) DESC,
      s.provisional, s.as_at DESC, s.recorded_at DESC, s.id
  ),
  cut AS (
    SELECT DISTINCT ON (r.item_key) r.item_key, r.rule, r.kerf_mm, r.provisional
    FROM public.price_book_cut_rules r JOIN items USING (item_key)
    ORDER BY r.item_key, r.provisional, r.as_at DESC, r.recorded_at DESC, r.id
  )
  SELECT i.item_key, i.family, i.category, i.description, i.unit,
    CASE WHEN cost.id IS NULL THEN 'unpriced'
         WHEN cost.provisional THEN 'provisional' ELSE 'blessed' END,
    cost.cost_ex_gst, cost.per_length_mm, cost.supplier, cost.supplier_code, cost.as_at,
    cost.evidence_kind, cost.evidence_ref, cost.provisional,
    cost.blessed_by, cost.blessed_at, cost.id, newer.id,
    stock.lengths_mm, stock.supplier, stock.provisional,
    cut.rule, cut.kerf_mm, cut.provisional
  FROM items i
  LEFT JOIN cost ON cost.item_key = i.item_key
  LEFT JOIN newer ON newer.item_key = i.item_key
  LEFT JOIN stock ON stock.item_key = i.item_key
  LEFT JOIN cut ON cut.item_key = i.item_key
  ORDER BY i.family, i.category, i.item_key
$$;

-- Current allowance per (family, key, basis, girth band): blessed first,
-- then strongest evidence, then newest.
CREATE OR REPLACE FUNCTION public.price_book_current_allowances(p_family text DEFAULT NULL)
RETURNS TABLE (
  family text,
  allowance_key text,
  description text,
  basis text,
  girth_min_mm integer,
  girth_max_mm integer,
  status text,
  cost_ex_gst numeric,
  as_at date,
  evidence_kind text,
  evidence_ref text,
  evidence_note text,
  blessed_by text,
  allowance_row_id uuid
)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT a.family, a.allowance_key, a.description, a.basis, a.girth_min_mm,
    a.girth_max_mm, CASE WHEN a.provisional THEN 'provisional' ELSE 'blessed' END,
    a.cost_ex_gst, a.as_at, a.evidence_kind, a.evidence_ref, a.evidence_note,
    a.blessed_by, a.id
  FROM (
    SELECT DISTINCT ON (x.family, x.allowance_key, x.basis, x.girth_min_mm, x.girth_max_mm) x.*
    FROM public.price_book_allowances x
    WHERE p_family IS NULL OR x.family = p_family
    ORDER BY x.family, x.allowance_key, x.basis, x.girth_min_mm, x.girth_max_mm,
      x.provisional,
      CASE WHEN x.provisional THEN public.price_book_evidence_rank(x.evidence_kind) ELSE 0 END,
      x.as_at DESC, x.recorded_at DESC, x.id
  ) a
  ORDER BY a.family, a.allowance_key, a.basis, a.girth_min_mm NULLS FIRST
$$;

-- Current markup for a family and optional category: the category rule when
-- one exists, else the family default. Blessed beats provisional, then newest.
CREATE OR REPLACE FUNCTION public.price_book_current_markup(
  p_family text,
  p_category text DEFAULT NULL
)
RETURNS TABLE (
  family text,
  category text,
  rule_kind text,
  value numeric,
  status text,
  provisional boolean,
  blessed_by text,
  blessed_at timestamptz,
  as_at date,
  evidence_ref text,
  evidence_note text,
  rule_row_id uuid
)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT m.family, m.category, m.rule_kind, m.value,
    CASE WHEN m.value IS NULL THEN 'unset'
         WHEN m.provisional THEN 'provisional' ELSE 'blessed' END,
    m.provisional, m.blessed_by, m.blessed_at, m.as_at, m.evidence_ref,
    m.evidence_note, m.id
  FROM public.price_book_markup_rules m
  WHERE m.family = p_family
    AND (m.category IS NULL OR m.category = p_category)
  ORDER BY (m.category IS NOT NULL) DESC, m.provisional, m.as_at DESC,
    m.recorded_at DESC, m.id
  LIMIT 1
$$;

-- The markup a quote line uses: the scoper's latest override for that line,
-- else the current default. Says which one it used.
CREATE OR REPLACE FUNCTION public.price_book_line_markup(
  p_quote_revision_id uuid,
  p_line_key text,
  p_family text,
  p_category text DEFAULT NULL
)
RETURNS TABLE (
  source text,
  markup_multiplier numeric,
  set_by text,
  set_at timestamptz,
  default_status text
)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH o AS (
    SELECT q.markup_multiplier, q.set_by, q.set_at
    FROM public.quote_line_markup_overrides q
    WHERE q.quote_revision_id = p_quote_revision_id AND q.line_key = p_line_key
    ORDER BY q.set_at DESC, q.id
    LIMIT 1
  ),
  d AS (SELECT * FROM public.price_book_current_markup(p_family, p_category))
  SELECT
    CASE WHEN o.markup_multiplier IS NOT NULL THEN 'line_override'
         WHEN d.value IS NOT NULL THEN 'default' ELSE 'unset' END,
    coalesce(o.markup_multiplier,
      CASE WHEN d.rule_kind = 'markup_multiplier' THEN d.value
           WHEN d.rule_kind = 'margin' THEN round(1 / (1 - d.value), 4) END),
    o.set_by, o.set_at, coalesce(d.status, 'unset')
  FROM (SELECT 1) one
  LEFT JOIN o ON true
  LEFT JOIN d ON true
$$;

-- ── Proposals: decide and apply ─────────────────────────────────────────
-- The current row a proposal subject points at, for the stale check.
CREATE OR REPLACE FUNCTION public.price_book_subject_current_row(
  p_target text,
  p_subject jsonb
)
RETURNS uuid LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE p_target
    WHEN 'cost' THEN (
      SELECT c.id FROM public.price_book_costs c
      WHERE c.item_key = p_subject->>'item_key' AND c.supplier = p_subject->>'supplier'
      ORDER BY c.provisional,
        CASE WHEN c.provisional THEN public.price_book_evidence_rank(c.evidence_kind) ELSE 0 END,
        c.as_at DESC, c.per_length_mm DESC NULLS LAST, c.recorded_at DESC, c.id LIMIT 1)
    WHEN 'stock_lengths' THEN (
      SELECT s.id FROM public.price_book_stock_lengths s
      WHERE s.item_key = p_subject->>'item_key' AND s.supplier = p_subject->>'supplier'
      ORDER BY s.provisional, s.as_at DESC, s.recorded_at DESC, s.id LIMIT 1)
    WHEN 'cut_rule' THEN (
      SELECT r.id FROM public.price_book_cut_rules r
      WHERE r.item_key = p_subject->>'item_key'
      ORDER BY r.provisional, r.as_at DESC, r.recorded_at DESC, r.id LIMIT 1)
    WHEN 'markup_rule' THEN (
      SELECT m.id FROM public.price_book_markup_rules m
      WHERE m.family = p_subject->>'family'
        AND m.category IS NOT DISTINCT FROM p_subject->>'category'
      ORDER BY m.provisional, m.as_at DESC, m.recorded_at DESC, m.id LIMIT 1)
    WHEN 'allowance' THEN (
      SELECT a.id FROM public.price_book_allowances a
      WHERE a.family = p_subject->>'family'
        AND a.allowance_key = p_subject->>'allowance_key'
        AND a.basis = p_subject->>'basis'
        AND a.girth_min_mm IS NOT DISTINCT FROM (p_subject->>'girth_min_mm')::integer
        AND a.girth_max_mm IS NOT DISTINCT FROM (p_subject->>'girth_max_mm')::integer
      ORDER BY a.provisional,
        CASE WHEN a.provisional THEN public.price_book_evidence_rank(a.evidence_kind) ELSE 0 END,
        a.as_at DESC, a.recorded_at DESC, a.id LIMIT 1)
  END
$$;

-- Record a proposed change. The old row and value are captured here, from the
-- database, so a proposal always shows exactly what it would replace.
CREATE OR REPLACE FUNCTION public.price_book_propose(
  p_target text,
  p_subject jsonb,
  p_new_value jsonb,
  p_reason text,
  p_evidence_ref text,
  p_proposed_by text
)
RETURNS uuid LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  old_id uuid;
  old_val jsonb;
  new_id uuid;
BEGIN
  IF p_target NOT IN ('cost', 'stock_lengths', 'cut_rule', 'markup_rule', 'allowance') THEN
    RAISE EXCEPTION 'price_book_target_unknown: %', p_target;
  END IF;
  old_id := public.price_book_subject_current_row(p_target, p_subject);
  IF old_id IS NOT NULL THEN
    old_val := CASE p_target
      WHEN 'cost' THEN (SELECT to_jsonb(c) FROM public.price_book_costs c WHERE c.id = old_id)
      WHEN 'stock_lengths' THEN (SELECT to_jsonb(s) FROM public.price_book_stock_lengths s WHERE s.id = old_id)
      WHEN 'cut_rule' THEN (SELECT to_jsonb(r) FROM public.price_book_cut_rules r WHERE r.id = old_id)
      WHEN 'markup_rule' THEN (SELECT to_jsonb(m) FROM public.price_book_markup_rules m WHERE m.id = old_id)
      ELSE (SELECT to_jsonb(a) FROM public.price_book_allowances a WHERE a.id = old_id)
    END;
  END IF;
  INSERT INTO public.price_book_proposals
    (target, subject, old_row_id, old_value, new_value, reason, evidence_ref, proposed_by)
  VALUES (p_target, p_subject, old_id, old_val, p_new_value, p_reason, p_evidence_ref, p_proposed_by)
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

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

  PERFORM pg_advisory_xact_lock(hashtext('price_book_proposal:' || p_proposal_id::text));
  SELECT * INTO p FROM public.price_book_proposals WHERE id = p_proposal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'price_book_proposal_missing: %', p_proposal_id;
  END IF;
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
    -- The approver list is the owner's call; with nobody configured for this
    -- scope, nothing can be approved or rejected.
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
      INSERT INTO public.price_book_markup_rules (family, category, rule_kind, value, as_at,
        evidence_kind, evidence_ref, evidence_note, provisional, blessed_by, blessed_at,
        recorded_by, proposal_id)
      VALUES (fam, s->>'category', v->>'rule_kind', (v->>'value')::numeric,
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

REVOKE ALL ON FUNCTION public.price_book_current_costs(text[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.price_book_current_markup(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.price_book_current_allowances(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.price_book_line_markup(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.price_book_subject_current_row(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.price_book_decide_proposal(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.price_book_propose(text, jsonb, jsonb, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.price_book_current_costs(text[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.price_book_current_markup(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.price_book_current_allowances(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.price_book_line_markup(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.price_book_subject_current_row(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.price_book_decide_proposal(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.price_book_propose(text, jsonb, jsonb, text, text, text) TO service_role;

-- ── Family default markups (seed) ───────────────────────────────────────
-- Patio: the tool's 1.35, PROVISIONAL until the patio lead sets it (the
-- unused engine was confirmed at 1.5 on 10 Aug; a real April quote used 1.25).
-- Stratco: 1.4 provisional (hold H4). Fencing and misc: not set. Fencing is
-- priced today by a sell rate per metre, so its markup waits for the owner and
-- the cost book; nothing is back-computed from a sell rate.
INSERT INTO public.price_book_markup_rules
  (family, category, rule_kind, value, as_at, evidence_kind, evidence_ref,
   evidence_note, recorded_by, import_fingerprint)
VALUES
  ('patio', NULL, 'markup_multiplier', 1.35, '2026-06-13', 'tool_constant',
   'patio-tool index.html DEFAULT_SELL_MARKUP @884a208',
   'Default for the patio lead to set. Engine snapshot 2026-08-10 said 1.5; SWP-26051 (April) used 1.25.',
   'quote-v2-migration', 'seed:markup:patio:default'),
  ('stratco', NULL, 'markup_multiplier', 1.40, '2026-09-17', 'owner_stated',
   'Kiko slats quote 2026-09-17 (hold H4)',
   'Provisional until H4 is filed.', 'quote-v2-migration', 'seed:markup:stratco:default'),
  ('fencing', NULL, 'markup_multiplier', NULL, '2026-09-24', 'tool_constant',
   'fence-designer index.html prices by sell rate ($125/m default)',
   'Not set: fencing sells by an agreed rate per metre today. Owner to set markup once costs are reviewed.',
   'quote-v2-migration', 'seed:markup:fencing:default'),
  ('misc', NULL, 'markup_multiplier', NULL, '2026-09-24', 'owner_stated',
   'no misc default recorded',
   'Not set.', 'quote-v2-migration', 'seed:markup:misc:default');
