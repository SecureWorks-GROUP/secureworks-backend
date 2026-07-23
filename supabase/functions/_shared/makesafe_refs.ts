// ════════════════════════════════════════════════════════════
// MAKE-SAFE REF PREFIXES + NORMALISATION — SINGLE SOURCE OF TRUTH
// Mission: makesafe-live-truth-2026-06-14
// ════════════════════════════════════════════════════════════
//
// This module is the ONE canonical implementation of make-safe reference handling
// (prefix floor, prefix validation, prefix loading, subject/body ref extraction,
// and ref normalisation). BOTH the monitor (monitor-ses-makesafes/index.ts, the
// EMAIL side) AND the reconciler (ops-api/makesafe_reconcile.ts, the BOARD side)
// import from here. There is deliberately NO local copy in either of those files.
//
// WHY THIS EXISTS (the parity bug it kills): previously the monitor side was
// data-driven (it unioned the static floor with each active company's
// parsing_rules.ref_prefixes) while the recon side hard-coded MLB|AJBR|MS. A
// company-supplied prefix (e.g. "KBA") therefore ingested fine but D1 could NEVER
// match it on the board side, so a real intake silently failed reconciliation.
// One module, imported by both, makes that drift IMPOSSIBLE: D1 now loads the same
// prefix set the monitor uses, and normalises BOTH the email side and the board
// side with it.
//
// Dependency-free except for the injected supabase client in loadRefPrefixes
// (typed loosely as `unknown`-ish to avoid a hard supabase-js import here; the
// callers already hold a client). All matching/normalisation is pure.

// ── The static floor ─────────────────────────────────────────────────────────
// The known historical make-safe ref families that MUST always be recognised even
// if a company row is missing/misconfigured. Add NEW families to a company's
// makesafe_companies.parsing_rules.ref_prefixes, NOT here.
//   MLB   — MLB-#####
//   AJBR  — AJBR-##### / AJBR #####
//   MS    — MS191190 (compact, no separator: a REAL historically-dropped WO; the
//           bare-numeric fallback cannot catch it because the digits are glued to
//           the "S", giving no \b before the digit run).
export const REF_PREFIX_FLOOR = ["MLB", "AJBR", "MS"] as const;

// ── Regex escape (defence-in-depth for buildSubjectRef) ───────────────────────
// validateRefPrefix already rejects regex metacharacters, but every prefix that
// reaches a RegExp is ALSO escaped so a future loosening of validation can never
// turn a data-driven prefix into a live regex injection / catastrophic pattern.
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Prefix validation (finding 4) ─────────────────────────────────────────────
// A company-supplied prefix is only accepted when it is a short ALPHANUMERIC token
// of length >= 2. This rejects:
//   - empty / whitespace-only values            ("" , "  ")
//   - single-char values                        ("X")  — would over-match wildly
//   - regex metacharacters / punctuation        ("*", "A.B", "A|B", "A-")
//   - over-long tokens (cap at 12; refs are short builder codes)
// Floor prefixes still apply regardless; only the company-supplied set is filtered.
const MIN_PREFIX_LEN = 2;
const MAX_PREFIX_LEN = 12;
const PREFIX_SHAPE = /^[A-Z0-9]+$/; // alphanumeric only (validated upper-cased)

export function validateRefPrefix(p: unknown): boolean {
  if (typeof p !== "string") return false;
  const v = p.trim().toUpperCase();
  if (v.length < MIN_PREFIX_LEN || v.length > MAX_PREFIX_LEN) return false;
  return PREFIX_SHAPE.test(v);
}

// ── Parse a company's parsing_rules.ref_prefixes into validated tokens ─────────
// Tolerant of shape: accepts an array, a single string, or absence. Each token is
// upper-cased + trimmed, then VALIDATED. Invalid tokens are dropped and returned
// separately so the caller can log them (finding 4: log dropped invalid prefixes).
export function extractRefPrefixes(
  parsingRules: unknown,
): { valid: string[]; dropped: string[] } {
  const raw = (parsingRules as { ref_prefixes?: unknown } | null | undefined)
    ?.ref_prefixes;
  const arr = Array.isArray(raw)
    ? raw
    : (typeof raw === "string" ? [raw] : []);
  const valid: string[] = [];
  const dropped: string[] = [];
  for (const item of arr) {
    const token = String(item ?? "").trim().toUpperCase();
    if (validateRefPrefix(token)) {
      valid.push(token);
    } else if (String(item ?? "").trim().length > 0) {
      // Only report non-empty rejects (empty/whitespace are silent no-ops).
      dropped.push(String(item ?? "").trim());
    }
  }
  return { valid, dropped };
}

// ── Load the live prefix set (finding 1) ──────────────────────────────────────
// The canonical prefix set = the static floor UNION every active company's
// VALIDATED parsing_rules.ref_prefixes. Loaded ONCE per run and threaded through
// both extraction (email side) and normalisation (board side) so they cannot
// diverge. On a query error this THROWS — degrade, do not silently fall back to a
// floor-only set (which would silently re-introduce the parity gap for any
// company-supplied prefix). Dropped invalid prefixes are logged (finding 4).
//
// The client is typed loosely so this module stays import-free of supabase-js.
export interface RefPrefixClient {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: unknown) => Promise<{
        data: Array<{ parsing_rules?: unknown }> | null;
        error: { message: string } | null;
      }>;
    };
  };
}

export async function loadRefPrefixes(
  sb: RefPrefixClient,
): Promise<string[]> {
  const prefixSet = new Set<string>(REF_PREFIX_FLOOR.map((p) => p.toUpperCase()));
  const { data, error } = await sb.from("makesafe_companies")
    .select("parsing_rules")
    .eq("active", true);
  if (error) {
    throw new Error(`makesafe_companies ref-prefix query failed: ${error.message}`);
  }
  for (const co of (data || [])) {
    const { valid, dropped } = extractRefPrefixes(co.parsing_rules);
    for (const pre of valid) prefixSet.add(pre);
    if (dropped.length > 0) {
      console.warn(
        `[makesafe_refs] dropped invalid company ref prefixes: ${dropped.join(", ")}`,
      );
    }
  }
  return [...prefixSet];
}

// ── Normalise a prefix set for matching (dedupe, upper, validate, sort) ────────
// Floor prefixes are trusted as-is; any caller-supplied prefix is validated here
// too (defence-in-depth — even if a raw set is threaded in directly). Longest
// first so a prefix that is a substring of another never short-circuits the wrong
// family.
function cleanPrefixes(prefixes: readonly string[]): string[] {
  const floor = new Set(REF_PREFIX_FLOOR.map((p) => p.toUpperCase()));
  const out = new Set<string>();
  for (const p of prefixes) {
    const v = String(p ?? "").trim().toUpperCase();
    if (!v) continue;
    if (floor.has(v) || validateRefPrefix(v)) out.add(v);
  }
  // Floor is always present (in case an empty set was passed).
  for (const f of floor) out.add(f);
  return [...out].sort((a, b) => b.length - a.length);
}

// ── buildSubjectRef (finding 1 + 4) ───────────────────────────────────────────
// Build the subject/body ref matcher from a prefix set. Each prefix matches
// "<PREFIX>[\s-]?<digits>" so dashed ("AJBR-67134"), spaced ("AJBR 67134"), and
// COMPACT ("MS191190") forms are all captured. Every prefix is regex-ESCAPED.
export function buildSubjectRef(prefixes: readonly string[] = REF_PREFIX_FLOOR): RegExp {
  const sorted = cleanPrefixes(prefixes);
  const alt = sorted.map((p) => `${escapeRegExp(p)}[\\s-]?\\d+`).join("|");
  return new RegExp(`\\b(${alt})\\b`, "i");
}

// Bare-numeric fallback. A make-safe subject like "Make Safe 67005" carries no
// prefix; the >=5-digit core IS the ref. Used so EVERY ingested make-safe post
// gets a non-null ref and so the board side can numeric-core match it.
export const BARE_NUMERIC_REF = /\b(\d{5,})\b/;

// ── normaliseRef (finding 1) ──────────────────────────────────────────────────
// Normalise a raw matched ref to canonical "<PREFIX>-<digits>" upper form, or a
// bare numeric core, against the active prefix set. The prefix branch is
// data-driven so MS191190 -> "MS-191190" AND a company-supplied "KBA88123" ->
// "KBA-88123". This is THE normaliser used on BOTH sides (email + board).
export function normaliseRef(
  raw: string | null | undefined,
  prefixes: readonly string[] = REF_PREFIX_FLOOR,
): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const sorted = cleanPrefixes(prefixes);
  const alt = sorted.map(escapeRegExp).join("|");
  // Normalise "AJBR 67200" / "AJBR-67200" / "MS191190" -> "<PREFIX>-<digits>".
  const m = s.match(new RegExp(`\\b(${alt})\\s*-?\\s*(\\d+)\\b`, "i"));
  if (m) return `${m[1].toUpperCase()}-${m[2]}`;
  // Bare numeric ref (>= 5 digits so short tokens can't false-match).
  const bare = s.match(/\b(\d{5,})\b/);
  if (bare) return bare[1];
  // Fall back to an upper, whitespace-collapsed token.
  const collapsed = s.replace(/\s+/g, "").toUpperCase();
  return collapsed || null;
}

// ── canonicalExternalObligationRef ───────────────────────────────────────────
// Manual/recovery jobs can store a builder claim and PO in one display token
// (for example MLB-26537PO-56922), while deterministic intake stores the claim as
// MLB-26537. Dedupe boundaries must compare the claim obligation, not the storage
// formatting. Keep this separate from normaliseRef: extraction still needs the
// complete token and legacy intake behaviour must remain unchanged.
export function canonicalExternalObligationRef(
  raw: string | null | undefined,
  prefixes: readonly string[] = REF_PREFIX_FLOOR,
): string | null {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  const alt = cleanPrefixes(prefixes).map(escapeRegExp).join("|");
  // Deliberately no trailing word boundary after the digits. In a composite
  // MLB-26537PO-56922 value, P is also a word character; requiring a boundary
  // would miss the claim that the recovery path embedded in the token.
  const match = value.match(
    new RegExp(`\\b(${alt})\\s*-?\\s*(\\d+)`, "i"),
  );
  if (match) return `${match[1].toUpperCase()}-${match[2]}`;
  return normaliseRef(value, prefixes);
}

// ── extractRef (finding 1) ────────────────────────────────────────────────────
// Extract a make-safe ref from the FULL subject, then the body as a fallback,
// handling prefixed (AJBR-67200 / AJBR 67200 / AJBR67200 / MS191190),
// bare-numeric ("Make Safe 67005"), and space-separated-prefix forms. The prefix
// set is data-driven (defaulting to the static floor). Returns a normalised ref
// or null.
export function extractRef(
  subject: string,
  body: string | null,
  prefixes: readonly string[] = REF_PREFIX_FLOOR,
): string | null {
  const subjectRef = buildSubjectRef(prefixes);
  // 1) Prefixed ref anywhere in the subject (compact / space- / dash-separated).
  const subjPrefixed = subject.match(subjectRef);
  if (subjPrefixed) return normaliseRef(subjPrefixed[0], prefixes);
  // 2) Bare numeric core in the subject (>=5 digits).
  const subjBare = subject.match(BARE_NUMERIC_REF);
  if (subjBare) return normaliseRef(subjBare[1], prefixes);
  // 3) Body fallback (strip tags first), prefixed then bare-numeric.
  if (body) {
    const text = body.replace(/<[^>]+>/g, " ");
    const bodyPrefixed = text.match(subjectRef);
    if (bodyPrefixed) return normaliseRef(bodyPrefixed[0], prefixes);
    const bodyBare = text.match(BARE_NUMERIC_REF);
    if (bodyBare) return normaliseRef(bodyBare[1], prefixes);
  }
  return null;
}
