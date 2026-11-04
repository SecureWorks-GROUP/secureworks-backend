// The capture census (finish line row C7): read-only counts and ids of what
// the monitored Outlook mailboxes and the GHL location hold, so a measurement
// can check every email, text and call has its own captured row. JWT
// verification stays on (the default deploy); handler.ts checks the caller
// again. Writes nothing anywhere.
import { createServiceRoleClient } from "../_shared/service_role_client.ts";
import { handleCensus, serverCredentialCheck } from "./handler.ts";
import { liveCensusReads } from "./reads.ts";

const env = (name: string) => Deno.env.get(name);

Deno.serve((req) => {
  const supabase = createServiceRoleClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  return handleCensus(req, {
    isServer: serverCredentialCheck(env),
    async userProfile(jwt) {
      const { data: { user }, error } = await supabase.auth.getUser(jwt);
      if (error || !user) return null;
      const { data: profile } = await supabase.from("users")
        .select("role, org_id").eq("id", user.id).single();
      if (!profile) return null;
      return {
        role: String(profile.role ?? ""),
        orgId: String(profile.org_id ?? ""),
      };
    },
    reads: () =>
      liveCensusReads({ env, fetch, supabase, now: () => Date.now() }),
  });
});
