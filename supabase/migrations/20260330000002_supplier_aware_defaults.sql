-- ════════════════════════════════════════════════════════════
-- Supplier-Aware Scope Defaults
--
-- Adds supplier linkage to scope_tool_defaults so the scoping
-- tool knows which supplier each item is priced against.
-- Also populates categories on existing Xero-synced suppliers.
-- ════════════════════════════════════════════════════════════

-- 1. Add supplier columns to scope_tool_defaults
ALTER TABLE scope_tool_defaults
  ADD COLUMN IF NOT EXISTS default_supplier_name text,
  ADD COLUMN IF NOT EXISTS default_supplier_id uuid REFERENCES suppliers(id);

-- 2. Update existing Xero-synced suppliers with categories
-- Ampelite (already exists from Xero sync, needs categories)
UPDATE suppliers
SET categories = ARRAY['twinwall', 'polycarbonate'],
    default_for = ARRAY['patio_roofing_twinwall']
WHERE name ILIKE '%AMPELITE%' AND (categories IS NULL OR categories = '{}');

-- B&D Metals (multiple Xero entries — update all)
UPDATE suppliers
SET categories = ARRAY['steel'],
    default_for = ARRAY['patio_steel']
WHERE name ILIKE '%B&D Metals%' AND (categories IS NULL OR categories = '{}');

-- 3. Populate default_supplier_name on scope_tool_defaults
-- Patio roofing → Bondor
UPDATE scope_tool_defaults
SET default_supplier_name = 'Bondor'
WHERE scope_tool = 'patio-tool' AND category = 'roofing'
  AND default_supplier_name IS NULL;

-- Fencing install/extensions/panels/gates → R&R Fencing
UPDATE scope_tool_defaults
SET default_supplier_name = 'R&R Fencing'
WHERE scope_tool = 'fence-designer'
  AND category IN ('fencing_install', 'fencing_extensions', 'fencing_panels', 'fencing_gates')
  AND default_supplier_name IS NULL;

-- Fencing concrete/ground/removal/services/labour/surcharge → NULL (not material suppliers)
-- Left as NULL intentionally — these are labour/service categories

-- 4. Backfill default_supplier_id from supplier name
UPDATE scope_tool_defaults std
SET default_supplier_id = s.id
FROM suppliers s
WHERE std.default_supplier_name = s.name
  AND std.default_supplier_id IS NULL
  AND s.is_active = true;
