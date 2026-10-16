// GHL Marketplace app OAuth install callback entry point. The handler lives
// in handler.ts so tests can drive it with a stubbed fetch. Public GET: GHL
// redirects the installer's browser here with no Supabase JWT.
// Deploy: supabase functions deploy ghl-oauth-callback --no-verify-jwt
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.3";
import { FUNCTION_NAME, handleGhlOAuthCallback } from "./handler.ts";

serve((req) =>
  handleGhlOAuthCallback(req, {
    env: (name) => Deno.env.get(name),
    fetch: (input, init) => fetch(input, init),
    writeReceipt: async (receipt) => {
      const url = Deno.env.get("SUPABASE_URL");
      const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!url || !key) {
        console.error(`[${FUNCTION_NAME}] receipt skipped: supabase env unset`);
        return;
      }
      const { error } = await createClient(url, key)
        .from("webhook_log")
        .insert(receipt);
      if (error) {
        const code = typeof error.code === "string" ? error.code : "error";
        console.error(`[${FUNCTION_NAME}] receipt insert failed: code=${code}`);
      }
    },
  })
);
