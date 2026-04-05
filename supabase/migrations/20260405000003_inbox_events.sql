-- Inbox events table for JARVIS email monitoring
-- Stores processed emails from Microsoft Graph inbox polling

CREATE TABLE IF NOT EXISTS inbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  graph_message_id TEXT UNIQUE NOT NULL,
  mailbox TEXT NOT NULL,                -- which inbox (marnin@, jan@, etc.)
  from_email TEXT,
  from_name TEXT,
  to_email TEXT,
  subject TEXT,
  body_preview TEXT,                    -- first 500 chars
  received_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  classification TEXT DEFAULT 'other',  -- client_reply, supplier_quote, council, invoice, complaint, spam, other
  priority TEXT DEFAULT 'normal',       -- high, normal, low
  action_needed TEXT,                   -- what JARVIS recommends
  job_id UUID REFERENCES jobs(id),
  ghl_contact_id TEXT,
  telegram_notified BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_inbox_events_received ON inbox_events(received_at DESC);
CREATE INDEX idx_inbox_events_classification ON inbox_events(classification);
CREATE INDEX idx_inbox_events_mailbox ON inbox_events(mailbox);
CREATE INDEX idx_inbox_events_graph_id ON inbox_events(graph_message_id);

-- RLS: service role only (edge functions)
ALTER TABLE inbox_events ENABLE ROW LEVEL SECURITY;

-- Grant access to service role
GRANT ALL ON inbox_events TO service_role;
