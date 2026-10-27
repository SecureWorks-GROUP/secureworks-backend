// Service-role Supabase client for edge functions that never hold a user session.
//
// supabase-js 2.99.3 defaults autoRefreshToken to true. GoTrue's
// _handleVisibilityChange treats a runtime with no document as non-browser and
// then calls startAutoRefresh, which setIntervals. Deno has no document, so a
// service-role client starts that interval unless autoRefreshToken is false.
// persistSession: false alone does not stop it. Nothing here refreshes a user
// token: the key is the service role, and callers authorize the request by
// comparing that key (or a service_role JWT claim) before any database call.

// deno-lint-ignore no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.3";

export function createServiceRoleClient(url: string, serviceRoleKey: string) {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
