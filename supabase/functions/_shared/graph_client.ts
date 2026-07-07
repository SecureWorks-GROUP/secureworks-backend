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
//
// ── 2026-07-07 INCIDENT HARDENING (intake item 12) ──
// "Lifetime validation failed, the token is expired" took down every mailbox
// read twice in one day and silently paused intake scanning. Two gaps caused it:
//   1. A caller grabs `const token = await getGraphToken()` once and then loops
//      for many minutes (a backfill traversal draining hundreds of pages). The
//      proactive EXPIRY_BUFFER only fires at ACQUISITION time; a token captured
//      into a local variable and reused for 20+ minutes can still expire mid-scan,
//      and every subsequent request 401s with nothing to recover it.
//   2. No reactive path: a 401/expired-token response was surfaced as a hard
//      throw with no force-refresh + retry.
// Fixes below: (a) getGraphToken({ forceRefresh }) bypasses the cache so a caller
// can re-acquire after a 401; (b) an explicit clock-skew margin folded into the
// stored expiry so a token near its edge is never handed out; (c) graphFetch()
// wraps a request and, on a 401/expired-token response, force-re-acquires ONCE
// and retries the request; (d) isGraphTokenExpiredResponse() classifies the
// failure so scan cycles can log a clear business_event instead of going silent.

// Reuse the token while at least this much lifetime remains (5 min buffer).
const EXPIRY_BUFFER_MS = 300_000;
// Extra allowance for clock drift between this isolate and Azure AD. Folded into
// the stored expiry at acquisition time so `expires` is already skew-adjusted and
// the reuse check below is a plain, honest comparison.
const CLOCK_SKEW_MS = 60_000;

// Module-level in-memory cache. One per isolate (same as monitor-inbox).
let _cachedToken: { token: string; expires: number } | null = null;

/** Options for {@link getGraphToken}. */
export interface GetGraphTokenOptions {
  /**
   * Skip the in-memory cache and mint a fresh token unconditionally. Used by the
   * reactive 401 recovery path (a cached token that Azure now rejects must be
   * replaced, not re-read). Default false.
   */
  forceRefresh?: boolean;
}

/**
 * Fetch (and cache) a Microsoft Graph app-only access token.
 *
 * Reads MICROSOFT_TENANT_ID / MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET
 * from the environment. Throws if any are missing or if the token endpoint
 * returns a non-2xx response (caller decides how to degrade — the make-safe
 * sync degrades to DEGRADED, it does not corrupt).
 *
 * The stored expiry is skew-adjusted (EXPIRY_BUFFER_MS + CLOCK_SKEW_MS is
 * subtracted from the real lifetime), so a token is retired well before Azure
 * would reject it. Pass `{ forceRefresh: true }` to bypass the cache after a
 * 401 rejection.
 */
export async function getGraphToken(
  opts: GetGraphTokenOptions = {},
): Promise<string> {
  if (
    !opts.forceRefresh && _cachedToken &&
    _cachedToken.expires > Date.now()
  ) {
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
  // Retire the token EXPIRY_BUFFER_MS + CLOCK_SKEW_MS before its real expiry so a
  // proactive read never hands out a token that is about to (or already has, under
  // clock drift) expired mid-request.
  const usableMs = Math.max(
    0,
    data.expires_in * 1000 - EXPIRY_BUFFER_MS - CLOCK_SKEW_MS,
  );
  _cachedToken = {
    token: data.access_token,
    expires: Date.now() + usableMs,
  };
  return data.access_token;
}

/**
 * True when a Graph response indicates the bearer token has expired / is invalid
 * (the exact 2026-07-07 failure: 401 + "Lifetime validation failed, the token is
 * expired"). Matching on 401 alone is enough to justify a single force-refresh
 * retry; the body substrings make the classification legible for logging and stop
 * an unrelated 401 (e.g. an insufficient-scope error) from being mislabelled.
 */
export function isGraphTokenExpiredResponse(
  status: number,
  bodyText: string | null | undefined,
): boolean {
  if (status !== 401) return false;
  const b = (bodyText || "").toLowerCase();
  // An empty body on a 401 still gets the retry — an expired app token is by far
  // the most common cause and one extra refresh is cheap and idempotent.
  if (!b) return true;
  return (
    b.includes("lifetime validation failed") ||
    b.includes("token is expired") ||
    b.includes("invalidauthenticationtoken") ||
    b.includes("80049228") || // AAD: token expired
    b.includes("access token has expired") ||
    b.includes("expired")
  );
}

/** Options for {@link graphFetch}. */
export interface GraphFetchOptions {
  /** Extra request init (method, body, non-auth headers). The Authorization
   * header is set by graphFetch and overrides any provided here. */
  init?: RequestInit;
  /**
   * Called to obtain a FRESH token after a 401/expired-token response. Inject
   * `() => getGraphToken({ forceRefresh: true })` in production. Optional so a
   * caller that cannot re-acquire (or a test) simply gets the original response
   * back with no retry.
   */
  refresh?: () => Promise<string>;
}

/**
 * Perform a Graph request with automatic recovery from an expired bearer token.
 *
 * Happy path is byte-for-byte the previous behaviour: ONE `fetch` with
 * `Authorization: Bearer <token>`. If the response is a 401 that
 * {@link isGraphTokenExpiredResponse} recognises AND a `refresh` callback is
 * provided, the token is re-acquired ONCE and the request retried a single time.
 * Only one retry is ever attempted — a genuinely revoked app registration must
 * surface (as the retried 401) rather than spin.
 *
 * Returns the `Response` (the retried one when a retry happened). Never throws on
 * a 401 itself; the caller keeps ownership of non-2xx handling / logging.
 */
export async function graphFetch(
  url: string,
  token: string,
  opts: GraphFetchOptions = {},
): Promise<Response> {
  const build = (t: string): RequestInit => ({
    ...opts.init,
    headers: { ...(opts.init?.headers ?? {}), Authorization: `Bearer ${t}` },
  });

  let resp = await fetch(url, build(token));
  if (resp.status !== 401 || !opts.refresh) return resp;

  // Read the body once to classify; clone so the caller can still read it if we
  // decide NOT to retry (an unrelated 401).
  const peek = await resp.clone().text().catch(() => "");
  if (!isGraphTokenExpiredResponse(resp.status, peek)) return resp;

  const fresh = await opts.refresh();
  resp = await fetch(url, build(fresh));
  return resp;
}

/** Test-only: clear the module cache so a unit test can force a refetch. */
export function _resetGraphTokenCache(): void {
  _cachedToken = null;
}
