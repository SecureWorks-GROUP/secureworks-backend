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

// ── Code-level watched-sender FLOOR (item 11) ─────────────────────────────────
// Builder work orders normally arrive from a company's DB-configured
// sender_patterns. Some builders ALSO dispatch work orders through Prime's
// notification channel (noreply@notifications.primeeco.tech), which is not tied
// to any single company's patterns — so its WOs (and their PDF attachments) were
// never watched: such a WO missed the email_attachments intake table entirely and
// later 500'd sw_attach_email_attachment_to_job. This floor is merged with the DB
// patterns by BOTH the ses monitor (attachment sync) and the ops-api intake
// scanner, so a first-class watched sender can never be reintroduced as a silent
// gap. The direct builder domains below close the same gap for human-sent
// messages: production exclusions from June-July 2026 contained unreviewed mail
// from every one of these domains. The make-safe WO gate still guards draft
// creation; deterministic intake accounts non-work and ambiguous messages.
export const WATCHED_SENDER_FLOOR: readonly string[] = [
  "notifications.primeeco.tech", // Prime Notification Centre (noreply@…)
  "mlbuilders.com.au", // ML Builders direct/human mail
  "ajs.build", // AJ Building & Restoration direct/human mail
  "builderwest.com.au", // Builderwest direct/human mail
  "westernbuild.com.au", // Western Building direct/human mail
];

// True when the sender matches any code-level watched-sender floor pattern (same
// anchored domain/full-address semantics as a DB sender_pattern).
export function senderMatchesWatchedFloor(
  fromEmail: string | null | undefined,
  floor: readonly string[] = WATCHED_SENDER_FLOOR,
): boolean {
  return floor.some((p) => senderMatchesPattern(fromEmail, p));
}
