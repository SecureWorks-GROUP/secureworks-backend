// Quote v2 party link page, acceptance, server build, rendering and the
// owner-stamped send. PROGRAM BRANCH ONLY: not deployed until the owner
// carries the quote v2 program over. Sends are captured, never delivered,
// unless a staging-only gate is open (delivery.ts).
// Deploy with --no-verify-jwt: customers open their link with no session.
// Staff actions therefore never trust a JWT claim; handler.ts verifies the
// session itself. Logic and contract live in handler.ts.
// deno-lint-ignore no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.3";
import { handleQuoteV2Request } from "./handler.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve((req) =>
  handleQuoteV2Request(req, {
    env: (name) => Deno.env.get(name),
    userIdentity: async (token) => {
      const { data, error } = await sb.auth.getUser(token);
      if (error || !data?.user) return null;
      const { data: profile, error: profileError } = await sb
        .from("users").select("role").eq("id", data.user.id).limit(1);
      if (profileError) return null;
      const role = profile?.[0]?.role;
      return {
        role: typeof role === "string" ? role : "",
        actor: data.user.email || data.user.id,
        email: data.user.email ?? null,
      };
    },
    fetch: (input, init) => fetch(input, init),
    rpc: async (fn, args) => {
      const { data, error } = await sb.rpc(fn, args);
      return { data, error: error ? { message: error.message } : null };
    },
  })
);
