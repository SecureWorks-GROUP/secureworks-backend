// Quote v2 price book read action. PROGRAM BRANCH ONLY: this function is not
// deployed until the owner carries the quote v2 program over. Deploy with JWT
// verification ON (the default). Logic and contract live in handler.ts.
// deno-lint-ignore no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.3";
import { handlePriceBookRequest } from "./handler.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve((req) =>
  handlePriceBookRequest(req, {
    env: (name) => Deno.env.get(name),
    userRole: async (token) => {
      const { data, error } = await sb.auth.getUser(token);
      if (error || !data?.user) return null;
      const { data: profile, error: profileError } = await sb
        .from("users").select("role").eq("id", data.user.id).limit(1);
      if (profileError) return null;
      const role = profile?.[0]?.role;
      return typeof role === "string" ? role : "";
    },
    rpc: async (fn, args) => {
      const { data, error } = await sb.rpc(fn, args);
      return { data, error: error ? { message: error.message } : null };
    },
  })
);
