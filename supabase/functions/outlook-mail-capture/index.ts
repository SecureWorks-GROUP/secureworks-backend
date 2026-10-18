// Email reader (context slice EM2; design email.md §2). Called by pg_cron
// (EM3, trigger_context_email_poll and trigger_context_email_sweep) with the
// service key, or by an operator with the server key. JWT verification stays
// on (the default deploy); handler.ts checks the caller again. The run is
// capture.ts. Reads mail only: it never sends, replies, moves, deletes or
// marks mail read.
import { createServiceRoleClient } from "../_shared/service_role_client.ts";
import { handleCapture } from "./handler.ts";

Deno.serve((req) =>
  handleCapture(req, {
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
