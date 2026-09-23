// GHL Webhook Receiver entry point. The handler lives in handler.ts so tests
// can drive it without a server; auth and receipts live in receiver_auth.ts.
// Deploy: supabase functions deploy ghl-webhook-receiver --no-verify-jwt
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.3";
import { handleGhlWebhook } from "./handler.ts";

serve((req) =>
  handleGhlWebhook(req, {
    env: (name) => Deno.env.get(name),
    createSupabase: () =>
      createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      ),
    // EdgeRuntime is a Supabase-injected global. waitUntil(promise) keeps the
    // worker alive until the promise settles after the 200 is returned.
    waitUntil: (p) => {
      // deno-lint-ignore no-explicit-any
      (globalThis as any).EdgeRuntime?.waitUntil?.(p);
    },
  })
);
