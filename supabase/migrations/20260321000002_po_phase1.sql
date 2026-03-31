-- ════════════════════════════════════════════════════════════
-- PO Phase 1: Supplier enrichment, price normalisation columns,
-- confirmed delivery date
-- ════════════════════════════════════════════════════════════

-- ── 1. Enrich suppliers table ──
-- Adds operational fields for PO workflow (categories, lead times, etc.)

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS account_number text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_person text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS categories text[];
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS default_for text[];
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS delivery_lead_days int;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS notes text;

-- Seed known suppliers with categories (only if they don't already exist from Xero sync)
INSERT INTO suppliers (org_id, name, categories, default_for, notes)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Metroll', ARRAY['steel','flashings','guttering','fencing'], ARRAY['patio_steel','fencing_panels'], 'Perth supplier. Panels 2365mm wide.'),
  ('00000000-0000-0000-0000-000000000001', 'CMI', ARRAY['steel','fabrication','flashings'], ARRAY['patio_steel'], 'Fastest turnaround, slightly more expensive.'),
  ('00000000-0000-0000-0000-000000000001', 'Bondor', ARRAY['roofing'], ARRAY['patio_roofing'], 'SolarSpan insulated panels. Canning Vale warehouse.'),
  ('00000000-0000-0000-0000-000000000001', 'Stratco', ARRAY['roofing','steel'], ARRAY['patio_systems'], 'Outback range patio systems.'),
  ('00000000-0000-0000-0000-000000000001', 'JBS Patios', ARRAY['fabrication'], ARRAY['patio_fabrication'], 'Custom trusses, doglegs. Malaga.'),
  ('00000000-0000-0000-0000-000000000001', 'R&R Fencing', ARRAY['fencing'], ARRAY['fencing_panels','fencing_gates'], 'Fencing materials. Panels 2380mm wide.'),
  ('00000000-0000-0000-0000-000000000001', 'Fencing Warehouse', ARRAY['fencing'], ARRAY['fencing_panels'], 'Alternative fencing supplier.')
ON CONFLICT (org_id, xero_contact_id) DO NOTHING;
-- Note: if these suppliers already exist from Xero (with xero_contact_id set),
-- we update their categories instead:
UPDATE suppliers SET
  categories = ARRAY['steel','flashings','guttering','fencing'],
  default_for = ARRAY['patio_steel','fencing_panels'],
  notes = COALESCE(notes, 'Perth supplier. Panels 2365mm wide.')
WHERE name ILIKE '%metroll%' AND org_id = '00000000-0000-0000-0000-000000000001' AND categories IS NULL;

UPDATE suppliers SET
  categories = ARRAY['steel','fabrication','flashings'],
  default_for = ARRAY['patio_steel'],
  notes = COALESCE(notes, 'Fastest turnaround, slightly more expensive.')
WHERE name ILIKE '%CMI%' AND org_id = '00000000-0000-0000-0000-000000000001' AND categories IS NULL;

UPDATE suppliers SET
  categories = ARRAY['roofing'],
  default_for = ARRAY['patio_roofing'],
  notes = COALESCE(notes, 'SolarSpan insulated panels. Canning Vale warehouse.')
WHERE name ILIKE '%bondor%' AND org_id = '00000000-0000-0000-0000-000000000001' AND categories IS NULL;

UPDATE suppliers SET
  categories = ARRAY['roofing','steel'],
  default_for = ARRAY['patio_systems']
WHERE name ILIKE '%stratco%' AND org_id = '00000000-0000-0000-0000-000000000001' AND categories IS NULL;

UPDATE suppliers SET
  categories = ARRAY['fabrication'],
  default_for = ARRAY['patio_fabrication'],
  notes = COALESCE(notes, 'Custom trusses, doglegs. Malaga.')
WHERE name ILIKE '%JBS%' AND org_id = '00000000-0000-0000-0000-000000000001' AND categories IS NULL;

UPDATE suppliers SET
  categories = ARRAY['fencing'],
  default_for = ARRAY['fencing_panels','fencing_gates'],
  notes = COALESCE(notes, 'Fencing materials. Panels 2380mm wide.')
WHERE name ILIKE '%R&R%' AND org_id = '00000000-0000-0000-0000-000000000001' AND categories IS NULL;

UPDATE suppliers SET
  categories = ARRAY['fencing'],
  default_for = ARRAY['fencing_panels']
WHERE name ILIKE '%fencing warehouse%' AND org_id = '00000000-0000-0000-0000-000000000001' AND categories IS NULL;

-- ── 2. Add confirmed_delivery_date to purchase_orders ──
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS confirmed_delivery_date date;
COMMENT ON COLUMN purchase_orders.confirmed_delivery_date IS 'Supplier-confirmed delivery date, extracted by AI from reply emails';

-- ── 3. Add raw price columns to material_price_ledger ──
-- Stores the original supplier price before normalisation to per-unit rates
ALTER TABLE material_price_ledger ADD COLUMN IF NOT EXISTS raw_supplier_price numeric(12,2);
ALTER TABLE material_price_ledger ADD COLUMN IF NOT EXISTS raw_supplier_unit text;
COMMENT ON COLUMN material_price_ledger.raw_supplier_price IS 'Original price as quoted by supplier (before normalisation)';
COMMENT ON COLUMN material_price_ledger.raw_supplier_unit IS 'Original unit as quoted by supplier (e.g. "per 10 panels", "per 4m length")';
