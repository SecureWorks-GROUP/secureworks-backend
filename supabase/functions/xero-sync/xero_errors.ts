// Classify errors thrown by xeroGet / xeroPost (2026-09-10).
// xeroGet throws `Xero API <path> failed (<status>): <body>` on any non-2xx,
// `Xero rate limited ...` on 429, and fetchWithTimeout throws on a timeout.
// Only a genuine 404 means "the invoice is gone in Xero".
export function isXeroNotFound(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? '')
  return /failed \(404\)/.test(msg)
}
