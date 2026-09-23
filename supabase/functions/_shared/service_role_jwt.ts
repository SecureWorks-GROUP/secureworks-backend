// Service-role caller check for edge functions deployed with JWT verification
// on. By the time a Bearer token reaches function code the platform has already
// verified its signature, so authorising on the decoded `role` claim is enough.
//
// Why the claim and not only an exact match: pg_cron triggers call with
// `Bearer <sw_service_key()>`, a signature-valid legacy service-role JWT that
// need not byte-equal the function's injected SUPABASE_SERVICE_ROLE_KEY, so an
// exact-string check alone silently 401s the cron.

// Decode (NOT verify) a JWT's payload and return its `role` claim, or null on
// any failure. Signature verification is the gateway's job (verify_jwt on).
export function decodeJwtRole(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // base64url -> base64, pad, decode, JSON.parse.
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const payload = JSON.parse(atob(b64));
    return typeof payload?.role === "string" ? payload.role : null;
  } catch (_) {
    return null;
  }
}

/** True only for a JWT whose payload role claim is exactly "service_role". */
export function isServiceRoleJwt(token: string): boolean {
  return decodeJwtRole(token) === "service_role";
}
