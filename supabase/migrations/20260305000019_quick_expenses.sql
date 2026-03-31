-- ════════════════════════════════════════════════════════════
-- Quick Expenses table
--
-- Captures small on-site purchases (under $200) from trade crews
-- via the Trade App receipt flow. Linked to a job for cost tracking.
--
-- Terminal B (ops-api) reads this for Job Detail panel.
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS quick_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES jobs(id) NOT NULL,
  org_id UUID REFERENCES organisations(id) NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  description TEXT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  photo_url TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE quick_expenses ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'quick_expenses' AND policyname = 'Org members can manage quick expenses') THEN
    CREATE POLICY "Org members can manage quick expenses" ON quick_expenses
      FOR ALL USING (org_id IN (SELECT org_id FROM users WHERE id = auth.uid()));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_quick_expenses_job ON quick_expenses(job_id);

COMMENT ON TABLE quick_expenses IS 'Small on-site purchases captured via Trade App. Linked to jobs for cost tracking.';
