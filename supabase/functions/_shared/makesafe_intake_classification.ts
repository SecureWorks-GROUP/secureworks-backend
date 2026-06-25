// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE CLASSIFICATION HELPERS — SHARED
// Mission: makesafe-intake-reliability-hardening-2026-06-24
// ════════════════════════════════════════════════════════════
//
// Shared sender/domain matching for both monitor-ses-makesafes (email ingest)
// and ops-api scan_ses_makesafes (intake draft creation). Keeping this here
// prevents the two paths from drifting on which builder senders are trusted.

export interface SenderPatternCompany {
  slug: string;
  name: string;
  pattern: string;
}

// Extract the sender domain (lowercased) from an email address. Used for
// anchored/boundary matching instead of fromEmail.includes(pattern), which
// over-matches (e.g. pattern "mlb.com" hits "notmlb.com.evil.test").
export function parseSenderDomain(
  email: string | null | undefined,
): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

// A pattern matches when it equals the sender domain OR is a dot-anchored suffix
// of it (so "mlb.com.au" matches "noreply.mlb.com.au" but NOT
// "evilmlb.com.au"). Full-address patterns match the whole email address.
export function senderMatchesPattern(
  fromEmail: string | null | undefined,
  pattern: string | null | undefined,
): boolean {
  const email = String(fromEmail || "").trim().toLowerCase();
  const p = String(pattern || "").trim().toLowerCase();
  if (!email || !p) return false;
  if (p.includes("@")) return email === p;
  const domain = parseSenderDomain(email);
  if (!domain) return false;
  return domain === p || domain.endsWith(`.${p}`);
}

export function findMatchingSenderCompany<T extends SenderPatternCompany>(
  fromEmail: string | null | undefined,
  patterns: readonly T[],
): T | null {
  for (const p of patterns || []) {
    if (senderMatchesPattern(fromEmail, p.pattern)) return p;
  }
  return null;
}
