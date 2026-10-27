// GHL message reconciler (context slice C1d; design sms.md §7 step 9).
// Called every 15 minutes by pg_cron (trigger_ghl_message_reconcile) with the
// service key. JWT verification stays on (the default deploy): only the service
// role is accepted, checked again in handler.ts. The run is reconcile.ts.
import { createServiceRoleClient } from "../_shared/service_role_client.ts";
import { handleReconcile } from "./handler.ts";

Deno.serve((req) =>
  handleReconcile(req, {
    env: (name) => Deno.env.get(name),
    createSupabase: () =>
      createServiceRoleClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      ),
    // EdgeRuntime is a Supabase-injected global. waitUntil(promise) keeps the
    // worker alive until the run settles after the 202 is returned.
    waitUntil: (p) => {
      // deno-lint-ignore no-explicit-any
      (globalThis as any).EdgeRuntime?.waitUntil?.(p);
    },
  })
);
