-- ════════════════════════════════════════════════════════════
-- Fix: Update user roles and expand constraint
--
-- Current: everyone is 'estimator' or 'admin'
-- Fix: proper roles for crew, sales, ops
-- Also adds Henry (fencing lead installer)
-- ════════════════════════════════════════════════════════════

-- Expand role constraint to match ops-ai role types
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'estimator', 'installer', 'ops_manager', 'lead_installer', 'division_ops', 'sales', 'crew'));

-- Isaac — patio lead installer
UPDATE users SET role = 'lead_installer', name = 'Isaac'
WHERE email = 'isaac.b3lch3r@gmail.com';

-- Ryan — patio crew
UPDATE users SET role = 'crew', name = 'Ryan'
WHERE email = 'ryanhumphries2002@gmail.com';

-- Khairo — fencing sales
UPDATE users SET role = 'sales', name = 'Khairo'
WHERE email = 'khairopomare@outlook.com';

-- Nithin — patio sales
UPDATE users SET role = 'sales', name = 'Nithin'
WHERE email = 'nithin@secureworkswa.com.au';

-- Shaun — operations manager
UPDATE users SET role = 'ops_manager'
WHERE email = 'shaun@secureworkswa.com.au';

-- Marnin + Jan stay admin (correct)

-- Add graduated_at column to action_permissions if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'action_permissions' AND column_name = 'graduated_at'
  ) THEN
    ALTER TABLE action_permissions ADD COLUMN graduated_at timestamptz;
    ALTER TABLE action_permissions ADD COLUMN graduated_by text;
    ALTER TABLE action_permissions ADD COLUMN downgrade_count int DEFAULT 0;
  END IF;
END;
$$;

-- Add missing execute-tier actions to action_permissions
INSERT INTO action_permissions (action_type, risk_level, autonomy_level, description, org_id)
VALUES
  ('create_po', 'medium', 'approve', 'Must be human-approved', '00000000-0000-0000-0000-000000000001'),
  ('create_assignment', 'medium', 'approve', 'Must be human-approved', '00000000-0000-0000-0000-000000000001'),
  ('update_job_status', 'medium', 'approve', 'Must be human-approved', '00000000-0000-0000-0000-000000000001'),
  ('complete_and_invoice', 'high', 'approve', 'Must be human-approved', '00000000-0000-0000-0000-000000000001'),
  ('assign_crew', 'medium', 'approve', 'Must be human-approved', '00000000-0000-0000-0000-000000000001'),
  ('send_client_email', 'medium', 'approve', 'Must be human-approved', '00000000-0000-0000-0000-000000000001'),
  ('send_quote', 'medium', 'approve', 'Must be human-approved', '00000000-0000-0000-0000-000000000001'),
  ('push_po_to_xero', 'medium', 'approve', 'Must be human-approved', '00000000-0000-0000-0000-000000000001'),
  ('add_ghl_note', 'low', 'approve', 'Must be human-approved', '00000000-0000-0000-0000-000000000001'),
  ('email_supplier_po', 'medium', 'approve', 'Must be human-approved', '00000000-0000-0000-0000-000000000001'),
  ('send_telegram', 'low', 'approve', 'Must be human-approved', '00000000-0000-0000-0000-000000000001'),
  ('reconcile_payment', 'high', 'approve', 'Must be human-approved', '00000000-0000-0000-0000-000000000001')
ON CONFLICT (action_type) DO NOTHING;
