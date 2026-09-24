// GHL call transcript fetcher (context slice T2; design transcripts.md §2).
// Called every 5 minutes by pg_cron (trigger_ghl_call_transcript_fetch, only
// while feature flag ghl_call_transcript_fetch_v1 is on) with the service key,
// and by hand for the history load. JWT verification stays on (the default
// deploy): only the service role is accepted, checked again in handler.ts.
// The run is fetch.ts.
// deno-lint-ignore no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.3";
import { handleFetch } from "./handler.ts";

Deno.serve((req) =>
  handleFetch(req, {
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
