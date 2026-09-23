// GHL webhook entry point. The handler lives in handler.ts so tests can
// drive it without a server. Message posts are answered there and never
// written; form and stage-change paths are unchanged.
// Deploy: supabase functions deploy ghl-webhook --no-verify-jwt
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.99.3'
import { handleGhlWebhook } from './handler.ts'

serve((req) =>
  handleGhlWebhook(req, {
    env: (name) => Deno.env.get(name),
    createSupabase: () =>
      createClient(
        Deno.env.get('SUPABASE_URL') || '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
      ),
  })
)
