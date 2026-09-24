// One-off GHL history load for live-job contacts (context slice M4; design
// sms.md section 12). Called by hand with the service key; there is no
// schedule. JWT verification stays on (the default deploy): only the service
// role is accepted, checked again in handler.ts. Dry run unless the body says
// "dry_run": false. The run is history_load.ts.
// deno-lint-ignore no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.3";
import { handleHistoryLoad } from "./handler.ts";

Deno.serve((req) =>
  handleHistoryLoad(req, {
    env: (name) => Deno.env.get(name),
    createSupabase: () =>
      createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } },
      ),
    // EdgeRuntime is a Supabase-injected global. waitUntil(promise) keeps the
    // worker alive until the run settles after the 202 is returned.
    waitUntil: (p) => {
      // deno-lint-ignore no-explicit-any
      (globalThis as any).EdgeRuntime?.waitUntil?.(p);
    },
  })
);
