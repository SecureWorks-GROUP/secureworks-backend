-- ============================================================
-- Fencing Scope Tool Defaults + Schema Enhancement
-- ============================================================
-- Adds columns to support fencing's richer data model (scope_tool,
-- material_code, notes, default_price). Seeds 42 fencing pricing rows
-- from the locked fence-designer master prompt.

-- Add columns to support fencing's richer data model
ALTER TABLE scope_tool_defaults
  ADD COLUMN IF NOT EXISTS scope_tool text DEFAULT 'patio-tool',
  ADD COLUMN IF NOT EXISTS material_code text,
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS default_price numeric(10,2);

-- Backfill: copy default_cost_rate into default_price for existing patio rows
UPDATE scope_tool_defaults SET default_price = default_cost_rate WHERE default_price IS NULL;

-- Backfill scope_tool for existing patio rows
UPDATE scope_tool_defaults SET scope_tool = 'patio-tool' WHERE scope_tool IS NULL;

-- Update unique constraint to include scope_tool (patio + fencing can share category names)
ALTER TABLE scope_tool_defaults DROP CONSTRAINT IF EXISTS scope_tool_defaults_org_id_category_item_key_key;
ALTER TABLE scope_tool_defaults ADD CONSTRAINT scope_tool_defaults_org_scope_cat_key
  UNIQUE (org_id, scope_tool, category, item_key);

-- Index for scope_tool queries
CREATE INDEX IF NOT EXISTS idx_scope_defaults_scope_tool ON scope_tool_defaults(scope_tool);

-- ── Fencing Defaults (42 rows) ──────────────────────────────

INSERT INTO scope_tool_defaults (scope_tool, category, item_key, item_description, material_code, unit, default_price, default_cost_rate, notes) VALUES
-- Base fencing supply & install
('fence-designer', 'fencing_install', 'cb-1800-sell', 'Colorbond 1800mm S&I sell rate', 'CB-1800-SELL', 'm', 120.00, 120.00, 'Sell price. Cost $95/m. 20.8% margin'),
('fence-designer', 'fencing_install', 'cb-1800-cost', 'Colorbond 1800mm S&I cost rate', 'CB-1800-COST', 'm', 95.00, 95.00, 'Cost price'),
('fence-designer', 'fencing_install', 'cb-2100-sell', 'Colorbond 2100mm S&I sell rate', 'CB-2100-SELL', 'm', 128.00, 128.00, 'Sell price. Cost $100/m. 21.9% margin'),
('fence-designer', 'fencing_install', 'cb-2100-cost', 'Colorbond 2100mm S&I cost rate', 'CB-2100-COST', 'm', 100.00, 100.00, 'Cost price'),

-- Extensions and plinths
('fence-designer', 'fencing_extensions', 'solid-fill-150-sell', 'Solid fill 150mm extension sell', 'SOLID-FILL-150-SELL', 'm', 110.00, 110.00, 'Sell price. Cost $73/m. 33.6% margin'),
('fence-designer', 'fencing_extensions', 'solid-fill-150-cost', 'Solid fill 150mm extension cost', 'SOLID-FILL-150-COST', 'm', 73.00, 73.00, 'Cost price'),
('fence-designer', 'fencing_extensions', 'plinth-sell', 'Plinth supply & install sell', 'PLINTH-SELL', 'ea', 80.00, 80.00, 'Sell price. Cost $55/ea. 31.3% margin'),
('fence-designer', 'fencing_extensions', 'plinth-cost', 'Plinth supply & install cost', 'PLINTH-COST', 'ea', 55.00, 55.00, 'Cost price'),

-- Gates
('fence-designer', 'fencing_gates', 'ped-gate-standalone-sell', 'Pedestrian gate standalone sell', 'PED-GATE-STANDALONE-SELL', 'ea', 1175.00, 1175.00, 'Sell price. Cost $835/ea. 28.9% margin'),
('fence-designer', 'fencing_gates', 'ped-gate-standalone-cost', 'Pedestrian gate standalone cost', 'PED-GATE-STANDALONE-COST', 'ea', 835.00, 835.00, 'Cost price'),
('fence-designer', 'fencing_gates', 'ped-gate-bundled-sell', 'Pedestrian gate bundled sell', 'PED-GATE-BUNDLED-SELL', 'ea', 1100.00, 1100.00, 'Sell price. Cost $835/ea. 24.1% margin'),
('fence-designer', 'fencing_gates', 'ped-gate-bundled-cost', 'Pedestrian gate bundled cost', 'PED-GATE-BUNDLED-COST', 'ea', 835.00, 835.00, 'Cost price'),
('fence-designer', 'fencing_gates', 'dbl-swing-gate-sell', 'Double swing gate sell', 'DBL-SWING-GATE-SELL', 'ea', 2400.00, 2400.00, 'Sell price. Cost $1830/ea. 23.8% margin'),
('fence-designer', 'fencing_gates', 'dbl-swing-gate-cost', 'Double swing gate cost', 'DBL-SWING-GATE-COST', 'ea', 1830.00, 1830.00, 'Cost price'),

-- Removal & disposal
('fence-designer', 'fencing_removal', 'remove-hardie-sell', 'Remove Hardie/Super6 sell', 'REMOVE-HARDIE-SELL', 'sheet', 30.00, 30.00, 'Sell price. Cost $15/sheet. 50% margin'),
('fence-designer', 'fencing_removal', 'remove-hardie-cost', 'Remove Hardie/Super6 cost', 'REMOVE-HARDIE-COST', 'sheet', 15.00, 15.00, 'Cost price'),
('fence-designer', 'fencing_removal', 'remove-timber-sell', 'Remove timber lap sell', 'REMOVE-TIMBER-SELL', 'm', 45.00, 45.00, 'Sell price. Cost $22.50/m. 50% margin'),
('fence-designer', 'fencing_removal', 'remove-timber-cost', 'Remove timber lap cost', 'REMOVE-TIMBER-COST', 'm', 22.50, 22.50, 'Cost price'),
('fence-designer', 'fencing_removal', 'remove-asbestos-sell', 'Remove asbestos sell', 'REMOVE-ASBESTOS-SELL', 'sheet', 90.00, 90.00, 'Sell price per sheet. Cost $60/sheet. Plus $300 removal fee'),
('fence-designer', 'fencing_removal', 'remove-asbestos-cost', 'Remove asbestos cost', 'REMOVE-ASBESTOS-COST', 'sheet', 60.00, 60.00, 'Cost price per sheet. Plus $300 removal fee'),

-- Additional services
('fence-designer', 'fencing_services', 'delivery-sell', 'Delivery sell', 'DELIVERY-SELL', 'job', 250.00, 250.00, 'Sell price. Cost $200. 20% margin'),
('fence-designer', 'fencing_services', 'delivery-cost', 'Delivery cost', 'DELIVERY-COST', 'job', 200.00, 200.00, 'Cost price'),
('fence-designer', 'fencing_services', 'veg-clear-sell', 'Vegetation/site clear sell', 'VEG-CLEAR-SELL', 'job', 150.00, 150.00, 'Sell price. Cost $100. 33.3% margin'),
('fence-designer', 'fencing_services', 'veg-clear-cost', 'Vegetation/site clear cost', 'VEG-CLEAR-COST', 'job', 100.00, 100.00, 'Cost price'),
('fence-designer', 'fencing_services', 'addl-labour-sell', 'Additional labour sell', 'ADDL-LABOUR-SELL', 'hr', 85.00, 85.00, 'Sell price. Cost $45/hr. 47% margin'),
('fence-designer', 'fencing_services', 'addl-labour-cost', 'Additional labour cost', 'ADDL-LABOUR-COST', 'hr', 45.00, 45.00, 'Cost price'),

-- Labour base rate
('fence-designer', 'fencing_labour', 'base-labour', 'Base labour rate for fencing install', 'BASE-LABOUR', 'm', 35.00, 35.00, 'Used in labour component calculation: fence_length x $35/m'),

-- Concrete
('fence-designer', 'fencing_concrete', 'kwikset-std', 'Kwikset concrete per post (600mm hole)', 'KWIKSET-STD', 'bag', 2.00, 2.00, '2 bags per post standard. Apply 1.1 waste factor, round up to even'),
('fence-designer', 'fencing_concrete', 'kwikset-deep', 'Kwikset concrete per post (900mm hole)', 'KWIKSET-DEEP', 'bag', 3.00, 3.00, '3 bags per post deep hole'),
('fence-designer', 'fencing_concrete', 'rock-excavation', 'Rock/limestone excavation surcharge', 'ROCK-EXCAVATION', 'hole', 45.00, 45.00, 'Per hole additional charge'),

-- Ground finish options
('fence-designer', 'fencing_ground', 'mulch-sell', 'Mulch ground finish sell', 'MULCH-SELL', 'm2', 8.00, 8.00, 'Sell price. Cost $5/m2. fence_length x 0.5m strip'),
('fence-designer', 'fencing_ground', 'mulch-cost', 'Mulch ground finish cost', 'MULCH-COST', 'm2', 5.00, 5.00, 'Cost price'),
('fence-designer', 'fencing_ground', 'white-stones-sell', 'White stones 20mm sell', 'WHITE-STONES-SELL', 'm2', 15.00, 15.00, 'Sell price. Cost $10/m2'),
('fence-designer', 'fencing_ground', 'white-stones-cost', 'White stones 20mm cost', 'WHITE-STONES-COST', 'm2', 10.00, 10.00, 'Cost price'),
('fence-designer', 'fencing_ground', 'turf-prep-sell', 'Turf prep sell', 'TURF-PREP-SELL', 'm2', 12.00, 12.00, 'Sell price. Cost $7/m2'),
('fence-designer', 'fencing_ground', 'turf-prep-cost', 'Turf prep cost', 'TURF-PREP-COST', 'm2', 7.00, 7.00, 'Cost price'),

-- Surcharge rates (percentage multipliers)
('fence-designer', 'fencing_surcharge', 'urgent-1-2wk', 'Urgent surcharge (1-2 weeks)', 'URGENT-1-2WK', 'pct', 10.00, 10.00, 'Applied to subtotal before GST'),
('fence-designer', 'fencing_surcharge', 'rush-1wk', 'Rush surcharge (<1 week)', 'RUSH-1WK', 'pct', 20.00, 20.00, 'Applied to subtotal before GST'),
('fence-designer', 'fencing_surcharge', 'emergency-3day', 'Emergency surcharge (<3 days)', 'EMERGENCY-3DAY', 'pct', 30.00, 30.00, 'Applied to subtotal before GST'),
('fence-designer', 'fencing_surcharge', 'access-moderate', 'Moderate access difficulty', 'ACCESS-MODERATE', 'pct', 10.00, 10.00, 'Applied to labour component only'),
('fence-designer', 'fencing_surcharge', 'access-difficult', 'Difficult access', 'ACCESS-DIFFICULT', 'pct', 25.00, 25.00, 'Applied to labour component only'),

-- Panel widths by supplier
('fence-designer', 'fencing_panels', 'metroll-panel-width', 'Metroll panel width', 'METROLL-PANEL-WIDTH', 'mm', 2365.00, 2365.00, 'Default supplier. Never mix suppliers on same job'),
('fence-designer', 'fencing_panels', 'rr-panel-width', 'R&R Fencing panel width', 'RR-PANEL-WIDTH', 'mm', 2380.00, 2380.00, 'Alternative supplier')

ON CONFLICT (org_id, scope_tool, category, item_key) DO NOTHING;
