// ════════════════════════════════════════════════════════════
// MAKE-SAFE INTAKE CROSS-PATH DEDUP
// Mission: fix/makesafe-intake-bugs (BUG 1 — duplicate intake drafts)
// ════════════════════════════════════════════════════════════
//
// THE BUG THIS FIXES
// ------------------
// scanSesMakesafes (ops-api index.ts) deduped a candidate email against existing
// drafts ONLY by graph_message_id (== emails.post_id in the new group-sync path)
// and against existing JOBS by external_ref. After Wave 1 redirected the intake
// scan from the OLD Graph USER-mailbox path to the live GROUP-sync projection, the
// graph_message_id for the SAME underlying work-order email CHANGED (a group post
// id is a different identifier than the user-mailbox message id). So an email that
// already had a draft from the OLD path was NOT recognised by the new scan, and a
// SECOND draft was created.
//
// Live proof (2026-06-16): AJS "Make Safe - BICTON - Job No 67998" (AJBR 67998)
// existed TWICE in makesafe_intake_drafts:
//   - Row A graph_message_id ...AAITobseAAA=  internet_message_id <…outlook.com>
//   - Row B graph_message_id ...AAITobsyAAA=  internet_message_id NULL
// Same external_ref, same requesting_company, same received_at, same attachment.
// Different graph_message_id -> the old graph_message_id dedup missed it, and the
// jobs-only external_ref check never looked at existing DRAFTS.
//
// WHY internet_message_id ALONE IS NOT ENOUGH
// -------------------------------------------
// Group posts (microsoft.graph.post) do NOT expose internetMessageId, so the
// group-sync path stores internet_message_id = NULL (confirmed: monitor-ses
// persists null; scanSesMakesafes maps it to null). The old path DID carry one.
// So internet_message_id matches only OLD<->OLD, never OLD<->NEW. We use it when
// present (a cheap exact match) but the WORKHORSE cross-path key is the normalised
// (external_ref + requesting_company) pair, which is stable across both paths.
//
// DESIGN
// ------
// buildIntakeDedupIndex(existingDrafts) -> a DedupIndex built ONCE per scan from
// all drafts in a live state (draft | needs_review | approved) plus, optionally,
// existing jobs' external refs. isDuplicateIntake(candidate, index) returns the
// reason a candidate is a duplicate (or null when it is genuinely new). A draft is
// created ONLY when isDuplicateIntake returns null. Skipping is keyed, in priority
// order, on:
//   1. graph_message_id            (exact, within-path — original behaviour)
//   2. internet_message_id         (exact, old<->old)
//   3. external_ref + company      (normalised — the cross-path workhorse)
//   4. external_ref (job exists)   (a live job already covers this ref)
//
// SAFETY
//   - Pure, no I/O. The caller supplies the already-fetched rows.
//   - A candidate with NO usable key (no ids, no external_ref) is treated as NOT a
//     duplicate (we never silently drop a genuinely-unkeyable new email); the
//     downstream isGenuineNewWorkOrder gate still applies.
//   - Normalisation is conservative: upper-cased, internal whitespace collapsed,
//     non-alphanumerics stripped, so "AJBR 67998", "AJBR-67998" and "ajbr67998"
//     collapse to the same key but two genuinely different refs never collide.

/** A draft/job row as seen by the dedup index (only the keying fields matter). */
export interface IntakeDedupRow {
  graph_message_id?: string | null;
  internet_message_id?: string | null;
  external_ref?: string | null;
  requesting_company_slug?: string | null;
  requesting_company_name?: string | null;
  status?: string | null;
}

/** A candidate email being considered for a new draft. */
export interface IntakeDedupCandidate {
  graph_message_id?: string | null;
  internet_message_id?: string | null;
  external_ref?: string | null;
  requesting_company_slug?: string | null;
  requesting_company_name?: string | null;
}

export interface DedupIndex {
  graphIds: Set<string>;
  internetIds: Set<string>;
  /** normalised `${ref}|${company}` for existing drafts */
  refCompany: Set<string>;
  /** normalised ref for existing JOBS (a live job already covers this ref) */
  jobRefs: Set<string>;
}

// Draft states that mean "a draft already exists, do not make another". rejected /
// superseded are NOT included: a rejected email may legitimately be re-drafted.
export const LIVE_DRAFT_STATES: readonly string[] = [
  "draft",
  "needs_review",
  "approved",
] as const;

/**
 * Normalise an external ref for cross-path comparison: upper-case, strip every
 * non-alphanumeric char (spaces, dashes, slashes). "AJBR 67998" -> "AJBR67998".
 * Returns "" for empty/nullish input.
 */
export function normaliseRef(ref: string | null | undefined): string {
  return String(ref ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Normalise a requesting company to a stable token. Prefers the slug (already a
 * stable lowercase token); falls back to the name lower-cased with non-alphanumerics
 * stripped. "AJ Building & Restoration" -> "ajbuildingrestoration", slug "aj" -> "aj".
 */
export function normaliseCompany(
  slug: string | null | undefined,
  name: string | null | undefined,
): string {
  const s = String(slug ?? "").trim().toLowerCase();
  if (s) return s.replace(/[^a-z0-9]/g, "");
  return String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Build the composite `${ref}|${company}` key. Returns "" (a key that NEVER matches)
 * unless BOTH a non-empty ref AND a non-empty company are present. Requiring the
 * company is deliberate: without it, two unknown-company emails that happen to share a
 * ref ("REF|") would collide across DIFFERENT builders and a genuine new WO from one
 * builder could be dropped against an unrelated draft from another. The cross-path
 * suppression therefore only fires for a ref+KNOWN-company match; an unknown-company
 * candidate still falls through to the graph/internet-id checks and is otherwise let
 * through to review (a possible false draft is safer than a missed work order).
 */
export function refCompanyKey(
  ref: string | null | undefined,
  slug: string | null | undefined,
  name: string | null | undefined,
): string {
  const r = normaliseRef(ref);
  if (!r) return "";
  const c = normaliseCompany(slug, name);
  if (!c) return ""; // no known company -> do not build a collidable key
  return `${r}|${c}`;
}

/**
 * Build a dedup index from the existing drafts (in any LIVE state) and, optionally,
 * existing jobs' external refs. Call ONCE per scan, then test each candidate with
 * isDuplicateIntake.
 *
 * @param existingDrafts rows from makesafe_intake_drafts in LIVE_DRAFT_STATES
 * @param existingJobRefs external_ref values from already-created make-safe jobs
 */
export function buildIntakeDedupIndex(
  existingDrafts: IntakeDedupRow[],
  existingJobRefs: Array<string | null | undefined> = [],
): DedupIndex {
  const graphIds = new Set<string>();
  const internetIds = new Set<string>();
  const refCompany = new Set<string>();
  const jobRefs = new Set<string>();

  for (const d of existingDrafts || []) {
    if (d.graph_message_id) graphIds.add(d.graph_message_id);
    if (d.internet_message_id) internetIds.add(d.internet_message_id);
    const rc = refCompanyKey(d.external_ref, d.requesting_company_slug, d.requesting_company_name);
    if (rc) refCompany.add(rc);
  }
  for (const r of existingJobRefs || []) {
    const nr = normaliseRef(r);
    if (nr) jobRefs.add(nr);
  }

  return { graphIds, internetIds, refCompany, jobRefs };
}

/**
 * Returns a non-null REASON string when the candidate is already represented by an
 * existing draft (any live state) or an existing job — i.e. DO NOT create a new
 * draft. Returns null when the candidate is genuinely new.
 *
 * Priority: graph_message_id -> internet_message_id -> (ref + company) -> job ref.
 */
export function isDuplicateIntake(
  candidate: IntakeDedupCandidate,
  index: DedupIndex,
): string | null {
  if (candidate.graph_message_id && index.graphIds.has(candidate.graph_message_id)) {
    return "graph_message_id";
  }
  if (candidate.internet_message_id && index.internetIds.has(candidate.internet_message_id)) {
    return "internet_message_id";
  }
  const rc = refCompanyKey(
    candidate.external_ref,
    candidate.requesting_company_slug,
    candidate.requesting_company_name,
  );
  if (rc && index.refCompany.has(rc)) {
    return "external_ref+company";
  }
  const nr = normaliseRef(candidate.external_ref);
  if (nr && index.jobRefs.has(nr)) {
    return "job_external_ref";
  }
  return null;
}

/**
 * Mutate the index to register a freshly-created draft so a SECOND candidate in the
 * SAME scan pass (e.g. two copies of the same email within one batch) is also
 * deduped. Call right after a successful insert.
 */
export function registerIntakeDraft(candidate: IntakeDedupCandidate, index: DedupIndex): void {
  if (candidate.graph_message_id) index.graphIds.add(candidate.graph_message_id);
  if (candidate.internet_message_id) index.internetIds.add(candidate.internet_message_id);
  const rc = refCompanyKey(
    candidate.external_ref,
    candidate.requesting_company_slug,
    candidate.requesting_company_name,
  );
  if (rc) index.refCompany.add(rc);
}
