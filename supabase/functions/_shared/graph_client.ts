// ════════════════════════════════════════════════════════════
// GRAPH CLIENT — Microsoft Graph app-only (client_credentials) token
// ════════════════════════════════════════════════════════════
//
// Extracted verbatim (in behaviour) from monitor-inbox/index.ts so that all
// Graph-polling edge functions share one token fetch + one in-memory cache.
//
// Auth flow: OAuth2 client_credentials (app-only). Requires the three Microsoft
// app registration env vars below. Scope is the fixed app-only .default scope.
//
// Dependency-free: uses only the Deno-global fetch + URLSearchParams. No imports.
//
// Cache discipline: module-level singleton. A token is reused while it has more
// than EXPIRY_BUFFER_MS of life left, so concurrent callers in the same isolate
// never trigger a redundant token request and never hand out a token that is
// about to expire mid-request. Each edge-function isolate keeps its own cache;
// that is intentional and matches monitor-inbox.

// Reuse the token while at least this much lifetime remains (5 min buffer).
const EXPIRY_BUFFER_MS = 300_000;

// Module-level in-memory cache. One per isolate (same as monitor-inbox).
let _cachedToken: { token: string; expires: number } | null = null;

/**
 * Fetch (and cache) a Microsoft Graph app-only access token.
 *
 * Reads MICROSOFT_TENANT_ID / MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET
 * from the environment. Throws if any are missing or if the token endpoint
 * returns a non-2xx response (caller decides how to degrade — the make-safe
 * sync degrades to DEGRADED, it does not corrupt).
 */
export async function getGraphToken(): Promise<string> {
  if (_cachedToken && _cachedToken.expires > Date.now() + EXPIRY_BUFFER_MS) {
    return _cachedToken.token;
  }

  const tenantId = Deno.env.get("MICROSOFT_TENANT_ID");
  const clientId = Deno.env.get("MICROSOFT_CLIENT_ID");
  const clientSecret = Deno.env.get("MICROSOFT_CLIENT_SECRET");

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET must be set",
    );
  }

  const resp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
    },
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Graph token request failed: ${resp.status} ${err}`);
  }

  const data = await resp.json();
  _cachedToken = {
    token: data.access_token,
    expires: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

/** Test-only: clear the module cache so a unit test can force a refetch. */
export function _resetGraphTokenCache(): void {
  _cachedToken = null;
}
