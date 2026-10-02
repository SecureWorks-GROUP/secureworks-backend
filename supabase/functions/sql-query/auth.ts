// Caller check for sql-query. Only the service-role key may run a query.
//
// SW_API_KEY is no longer accepted: that value ships in public page code, and
// sql-query runs any SELECT as the service role across every table, so
// accepting it let anyone holding the page code read the whole database.

/** Constant-time string comparison (length is not secret). */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * True only when the x-api-key header equals the service-role key. An unset
 * service key refuses everyone, so an empty header can never match an empty
 * secret.
 */
export function isServiceKeyCaller(req: Request, serviceKey: string): boolean {
  if (!serviceKey) return false;
  const apiKey = req.headers.get("x-api-key") || "";
  if (!apiKey) return false;
  return timingSafeEqual(apiKey, serviceKey);
}

/** The 401 response for a refused caller, or null when the caller may proceed. */
export function refuseUnlessServiceKey(
  req: Request,
  serviceKey: string,
): Response | null {
  if (isServiceKeyCaller(req, serviceKey)) return null;
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
  });
}
