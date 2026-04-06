CREATE TABLE IF NOT EXISTS jarvis_event_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  invoice_id TEXT,
  contact_id TEXT,
  job_id UUID,
  event_type TEXT NOT NULL,
  channel TEXT DEFAULT 'system',
  triggered_by TEXT DEFAULT 'jarvis',
  message_content TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_jarvis_events_contact ON jarvis_event_log(contact_id, created_at DESC);
CREATE INDEX idx_jarvis_events_type ON jarvis_event_log(event_type, created_at DESC);
CREATE INDEX idx_jarvis_events_job ON jarvis_event_log(job_id);
CREATE INDEX idx_jarvis_events_invoice ON jarvis_event_log(invoice_id);

ALTER TABLE jarvis_event_log ENABLE ROW LEVEL SECURITY;
GRANT ALL ON jarvis_event_log TO service_role;
CREATE POLICY "service_role_all" ON jarvis_event_log FOR ALL TO service_role USING (true) WITH CHECK (true);
