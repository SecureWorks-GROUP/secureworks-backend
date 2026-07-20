-- Conversation memory for JARVIS
-- Enables context persistence between messages

-- Session tracking
CREATE TABLE IF NOT EXISTS conversation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'telegram',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  message_count INTEGER DEFAULT 0,
  summary TEXT,
  metadata JSONB DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_conv_sessions_lookup ON conversation_sessions(user_id, channel, last_activity_at DESC);
ALTER TABLE conversation_sessions ENABLE ROW LEVEL SECURITY;
GRANT ALL ON conversation_sessions TO service_role;
CREATE POLICY "service_role_all" ON conversation_sessions FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Message history
CREATE TABLE IF NOT EXISTS conversation_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'telegram',
  session_id UUID NOT NULL REFERENCES conversation_sessions(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls JSONB DEFAULT '[]',
  job_ids TEXT[] DEFAULT '{}',
  contact_ids TEXT[] DEFAULT '{}',
  tokens_used INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conv_history_user ON conversation_history(user_id, channel, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_history_session ON conversation_history(session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_conv_history_jobs ON conversation_history USING GIN(job_ids);
CREATE INDEX IF NOT EXISTS idx_conv_history_cleanup ON conversation_history(created_at);
ALTER TABLE conversation_history ENABLE ROW LEVEL SECURITY;
GRANT ALL ON conversation_history TO service_role;
CREATE POLICY "service_role_all" ON conversation_history FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Auto-cleanup via pg_cron
SELECT cron.schedule('cleanup-conv-history', '0 19 * * *',
  $$DELETE FROM conversation_history WHERE created_at < NOW() - INTERVAL '14 days'$$);
SELECT cron.schedule('cleanup-conv-sessions', '0 19 * * 0',
  $$DELETE FROM conversation_sessions WHERE last_activity_at < NOW() - INTERVAL '90 days'$$);
