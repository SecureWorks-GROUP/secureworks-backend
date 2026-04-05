-- ════════════════════════════════════════════════════════════
-- SQL wrapper for send-outlook-email edge function
--
-- Enables Cowork to send Outlook emails with attachments + CC
-- via execute_sql. Uses pg_net to call the edge function.
--
-- Usage:
--   SELECT send_outlook_email('client@email.com', 'Subject', '<p>Body</p>');
--   SELECT send_outlook_email('client@email.com', 'Quote', '<p>Attached</p>',
--     'marnin@secureworkswa.com.au', 'jan@secureworkswa.com.au',
--     'https://storage-url/quote.pdf', 'Quote-SWP-26023.pdf');
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION send_outlook_email(
  p_to text,
  p_subject text,
  p_html_body text,
  p_from text DEFAULT 'marnin@secureworkswa.com.au',
  p_cc text DEFAULT NULL,
  p_attachment_url text DEFAULT NULL,
  p_attachment_name text DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
  v_queue_id uuid;
  v_body jsonb;
BEGIN
  -- Audit trail
  INSERT INTO outbound_message_queue (channel, recipient_id, recipient_type, message_content, metadata, status)
  VALUES ('outlook_email', p_to, 'email_address', p_subject || ': ' || LEFT(p_html_body, 200),
    jsonb_build_object(
      'from', p_from,
      'cc', p_cc,
      'subject', p_subject,
      'attachment_url', p_attachment_url,
      'attachment_name', p_attachment_name,
      'source', 'cowork_sql'
    ),
    'processing')
  RETURNING id INTO v_queue_id;

  -- Build request body
  v_body := jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'subject', p_subject,
    'htmlBody', p_html_body
  );

  IF p_cc IS NOT NULL THEN
    v_body := v_body || jsonb_build_object('cc', p_cc);
  END IF;

  IF p_attachment_url IS NOT NULL AND p_attachment_name IS NOT NULL THEN
    v_body := v_body || jsonb_build_object('attachments', jsonb_build_array(
      jsonb_build_object('url', p_attachment_url, 'name', p_attachment_name)
    ));
  END IF;

  -- Fire via pg_net (async)
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/send-outlook-email',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || _sw_service_key(),
      'Content-Type', 'application/json'
    ),
    body := v_body
  );

  -- Mark dispatched
  UPDATE outbound_message_queue SET status = 'sent', sent_at = now() WHERE id = v_queue_id;

  RETURN v_queue_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION send_outlook_email IS 'Send Outlook email with optional CC and attachment. Usage: SELECT send_outlook_email(to, subject, htmlBody, from, cc, attachment_url, attachment_name);';
