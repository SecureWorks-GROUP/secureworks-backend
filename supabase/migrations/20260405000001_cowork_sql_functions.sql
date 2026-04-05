-- ════════════════════════════════════════════════════════════
-- Cowork SQL Functions — pg_net wrappers for edge functions
--
-- Enables the Cowork Claude session to send SMS, email, and
-- trigger digests via execute_sql when MCP plugin DNS is blocked.
--
-- Pattern: INSERT audit row → fire pg_net → mark sent
-- pg_net is async (fire-and-forget), so status = 'sent' means
-- "request dispatched" not "delivery confirmed".
-- ════════════════════════════════════════════════════════════

-- Service role key (same as all cron jobs — safe in postgres-only context)
-- Using a helper function to avoid repeating the key in every function
CREATE OR REPLACE FUNCTION _sw_service_key() RETURNS text AS $$
BEGIN
  RETURN 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldmdyaGNqeHNwYnhnb3ZwbWZsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MjM1NDEwNSwiZXhwIjoyMDg3OTMwMTA1fQ.rBAokSo0wBnIO7ZOnGmCGtWzvdKcumyLR2OD9-hG47U';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ════════════════════════════════════════
-- 1. SEND SMS via GHL
-- ════════════════════════════════════════
CREATE OR REPLACE FUNCTION send_ghl_sms(
  p_contact_id text,
  p_message text,
  p_job_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_queue_id uuid;
BEGIN
  -- Audit trail
  INSERT INTO outbound_message_queue (channel, recipient_id, recipient_type, message_content, metadata, status)
  VALUES ('sms', p_contact_id, 'ghl_contact', p_message,
    jsonb_build_object('job_id', p_job_id, 'source', 'cowork_sql'),
    'processing')
  RETURNING id INTO v_queue_id;

  -- Fire via pg_net (async)
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ghl-proxy?action=send_sms',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || _sw_service_key(),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'contactId', p_contact_id,
      'message', p_message,
      'jobId', p_job_id
    )
  );

  -- Mark dispatched
  UPDATE outbound_message_queue
  SET status = 'sent', sent_at = now()
  WHERE id = v_queue_id;

  RETURN v_queue_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION send_ghl_sms IS 'Send SMS via GHL. Usage: SELECT send_ghl_sms(''contactId'', ''message'', ''jobId''::uuid);';

-- ════════════════════════════════════════
-- 2. SEND EMAIL via GHL
-- ════════════════════════════════════════
CREATE OR REPLACE FUNCTION send_ghl_email(
  p_contact_id text,
  p_subject text,
  p_html_body text,
  p_job_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_queue_id uuid;
BEGIN
  -- Audit trail
  INSERT INTO outbound_message_queue (channel, recipient_id, recipient_type, message_content, metadata, status)
  VALUES ('email', p_contact_id, 'ghl_contact', p_subject || ': ' || p_html_body,
    jsonb_build_object('job_id', p_job_id, 'subject', p_subject, 'source', 'cowork_sql'),
    'processing')
  RETURNING id INTO v_queue_id;

  -- Fire via pg_net (async)
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ghl-proxy?action=send_email',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || _sw_service_key(),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'contactId', p_contact_id,
      'subject', p_subject,
      'htmlBody', p_html_body
    )
  );

  -- Mark dispatched
  UPDATE outbound_message_queue
  SET status = 'sent', sent_at = now()
  WHERE id = v_queue_id;

  RETURN v_queue_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION send_ghl_email IS 'Send email via GHL. Usage: SELECT send_ghl_email(''contactId'', ''Subject'', ''<p>HTML body</p>'', ''jobId''::uuid);';

-- ════════════════════════════════════════
-- 3. TRIGGER DAILY DIGEST
-- ════════════════════════════════════════
CREATE OR REPLACE FUNCTION trigger_daily_digest() RETURNS void AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/daily-digest',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || _sw_service_key(),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION trigger_daily_digest IS 'Fire daily digest + Telegram morning brief. Usage: SELECT trigger_daily_digest();';

-- ════════════════════════════════════════
-- 4. QUEUE PROCESSOR (pg_cron, every 1 min)
-- Picks up messages left in 'queued' status
-- and dispatches them via the appropriate function.
-- ════════════════════════════════════════
CREATE OR REPLACE FUNCTION process_outbound_queue() RETURNS integer AS $$
DECLARE
  v_row RECORD;
  v_count integer := 0;
BEGIN
  FOR v_row IN
    SELECT id, channel, recipient_id, message_content, metadata
    FROM outbound_message_queue
    WHERE status = 'queued'
    AND (scheduled_for IS NULL OR scheduled_for <= now())
    AND attempt_count < max_attempts
    ORDER BY
      CASE priority_level WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      created_at ASC
    LIMIT 5
  LOOP
    -- Mark as processing
    UPDATE outbound_message_queue
    SET status = 'processing', attempt_count = attempt_count + 1, last_attempt_at = now()
    WHERE id = v_row.id;

    -- Dispatch based on channel
    IF v_row.channel = 'sms' THEN
      PERFORM net.http_post(
        url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ghl-proxy?action=send_sms',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || _sw_service_key(),
          'Content-Type', 'application/json'
        ),
        body := jsonb_build_object(
          'contactId', v_row.recipient_id,
          'message', v_row.message_content,
          'jobId', v_row.metadata->>'job_id'
        )
      );
    ELSIF v_row.channel = 'email' THEN
      PERFORM net.http_post(
        url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ghl-proxy?action=send_email',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || _sw_service_key(),
          'Content-Type', 'application/json'
        ),
        body := jsonb_build_object(
          'contactId', v_row.recipient_id,
          'subject', v_row.metadata->>'subject',
          'htmlBody', v_row.message_content
        )
      );
    END IF;

    -- Mark sent
    UPDATE outbound_message_queue
    SET status = 'sent', sent_at = now()
    WHERE id = v_row.id;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Schedule the queue processor every minute
SELECT cron.schedule('process-outbound-queue', '* * * * *',
  $$SELECT process_outbound_queue();$$
);
