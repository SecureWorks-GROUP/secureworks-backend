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

// M1.5 D0/H2: the fingerprint discriminator parses the subject the SAME way the scan
// does (so existing drafts and candidates resolve to the same ref), and normalises the
// body with the SAME function that produces the stored body_preview — so a candidate's
// RAW msg body and an existing draft's already-processed body_preview hash to the same
// input (H2-residual: without this a ref-less cross-scan twin would never match).
import { parseSubjectFields } from "./makesafe_template_parser.ts";
import { stripEmailHtmlForTrade } from "./makesafe_email_links.ts";

// Body length cap used when producing body_preview (slice(0, 2000) in the scan).
const FINGERPRINT_BODY_MAX = 2000;

/** Normalise a body to the SAME representation the scan stores as body_preview, so the
 * raw candidate body and the stored preview reduce to identical hash input. */
function normaliseBodyForFingerprint(body: string | null | undefined): string {
  return stripEmailHtmlForTrade(String(body ?? ""))
    .slice(0, FINGERPRINT_BODY_MAX)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** A draft/job row as seen by the dedup index (only the keying fields matter). */
export interface IntakeDedupRow {
  graph_message_id?: string | null;
  internet_message_id?: string | null;
  external_ref?: string | null;
  builder_work_order_number?: string | null;
  builder_po_number?: string | null;
  requesting_company_slug?: string | null;
  requesting_company_name?: string | null;
  /**
   * Practical MakeSafe job family. When present, same builder ref + company is
   * only a duplicate within the same family. This lets MLB send an assessment /
   * quote and a later temp-fence MakeSafe under the same MLB ref without the
   * second work order being silently dropped.
   */
  makesafe_job_family?: string | null;
  status?: string | null;
  /** ISO timestamp of when the email was received — used by suppressed_rejected date check. */
  received_at?: string | null;
  /** M1.5 D0: sender + subject feed the DUAL-CAPTURE content fingerprint. */
  from_email?: string | null;
  subject?: string | null;
  /** M1.5 H2: body feeds the fingerprint discriminator when no ref is parseable. */
  body_preview?: string | null;
}

/** A candidate email being considered for a new draft. */
export interface IntakeDedupCandidate {
  graph_message_id?: string | null;
  internet_message_id?: string | null;
  external_ref?: string | null;
  builder_work_order_number?: string | null;
  builder_po_number?: string | null;
  requesting_company_slug?: string | null;
  requesting_company_name?: string | null;
  makesafe_job_family?: string | null;
  /** M1.5 D0: sender + subject feed the DUAL-CAPTURE content fingerprint. */
  from_email?: string | null;
  subject?: string | null;
  /** M1.5 H2: body feeds the fingerprint discriminator when no ref is parseable. */
  body?: string | null;
  /**
   * When true, bypasses the suppressed_rejected check so a targeted recapture
   * action can create a fresh draft for a previously-rejected email. It does NOT
   * bypass live-state checks (graph_message_id / refCompany / internet_message_id)
   * — a force_recapture must still not duplicate a LIVE draft.
   */
  force_recapture?: boolean;
  /**
   * ISO timestamp of the candidate email's received date. Used by suppressed_rejected:
   * a candidate NEWER than the latest rejected draft for the same ref+company is a
   * corrected resend and must NOT be suppressed. Candidates with no received_at are
   * fail-open (not suppressed) — a real WO is safer than a missed resend.
   */
  received_at?: string | null;
}

export interface DedupIndex {
  graphIds: Set<string>;
  internetIds: Set<string>;
  /** normalised `${ref}|${company}` for existing drafts */
  refCompany: Set<string>;
  /** normalised `${ref}|${company}|${family}` for existing drafts with a known family */
  refCompanyFamily: Set<string>;
  /** existing draft ref/company/family rows that carry explicit builder WO/PO identity */
  refCompanyFamilyWithWorkOrderIdentity: Set<string>;
  /** existing draft ref/company/family rows that do not carry explicit builder WO/PO identity */
  refCompanyFamilyWithoutWorkOrderIdentity: Set<string>;
  /** existing draft ref/company rows that carry explicit builder WO/PO identity */
  refCompanyWithWorkOrderIdentity: Set<string>;
  /** existing draft ref/company rows that do not carry explicit builder WO/PO identity */
  refCompanyWithoutWorkOrderIdentity: Set<string>;
  /** normalised `${workOrderIdentity}|${company}` for existing drafts */
  workOrderCompany: Set<string>;
  /** normalised `${ref}|${company}` for existing drafts where the family is unknown */
  refCompanyUnknownFamily: Set<string>;
  /** normalised ref for existing JOBS (a live job already covers this ref) */
  jobRefs: Set<string>;
  /** normalised `${ref}|${family}` for existing jobs with a known family */
  jobRefFamily: Set<string>;
  /** normalised refs for existing jobs where the family is unknown */
  jobUnknownFamilyRefs: Set<string>;
  /** normalised `${ref}|${company}` for existing jobs with a known company */
  jobRefCompany: Set<string>;
  /** normalised `${ref}|${company}|${family}` for existing jobs with known company+family */
  jobRefCompanyFamily: Set<string>;
  /** existing job ref/company/family rows that carry explicit builder WO/PO identity */
  jobRefCompanyFamilyWithWorkOrderIdentity: Set<string>;
  /** existing job ref/company/family rows that do not carry explicit builder WO/PO identity */
  jobRefCompanyFamilyWithoutWorkOrderIdentity: Set<string>;
  /** existing job ref/company rows that carry explicit builder WO/PO identity */
  jobRefCompanyWithWorkOrderIdentity: Set<string>;
  /** existing job ref/company rows that do not carry explicit builder WO/PO identity */
  jobRefCompanyWithoutWorkOrderIdentity: Set<string>;
  /** normalised `${workOrderIdentity}|${company}` for existing jobs */
  jobWorkOrderCompany: Set<string>;
  /** normalised `${ref}|${company}` for existing jobs with known company but unknown family */
  jobRefCompanyUnknownFamily: Set<string>;
  /**
   * normalised `${ref}|${company}` -> latest rejected received_at (ISO string).
   * Maps each rejected/superseded ref+company key to the MAX received_at among
   * all rejected/superseded drafts for that key. A normal scan candidate matching
   * this map is returned as 'suppressed_rejected' ONLY when the candidate's
   * received_at is present AND <= the stored timestamp (same or older email).
   * A candidate with a NEWER received_at (corrected resend) or no received_at
   * (fail-open) is NOT suppressed.
   */
  rejectedRefCompany: Map<string, string>;
  /** normalised `${workOrderIdentity}|${company}` -> latest rejected received_at */
  rejectedWorkOrderCompany: Map<string, string>;
  /**
   * M1.5 D0 — DUAL-CAPTURE content fingerprints of existing live drafts.
   * The ses@ email sync writes TWO `emails` rows for the same underlying email: one
   * from the group-post poll (id "AAMk…", internet_message_id null) and one from the
   * mailbox fallback poll (id "mailbox_<hash>"). Their graph_message_ids differ and,
   * pre-M1.5, external_ref was null on both — so neither the graph-id nor the
   * (ref+company) key could collapse them and the scan produced two drafts + two model
   * calls per email. The content fingerprint (sender + normalised subject + received
   * minute) is stable across both capture paths and catches the twin BEFORE the model
   * call. Two genuinely different work orders differ in subject (the ref/address ride
   * in the subject) so they never collide.
   */
  fingerprints: Set<string>;
}

// Draft states that mean "a draft already exists, do not make another". rejected /
// superseded are NOT included: a rejected email may legitimately be re-drafted.
// reopen_candidate IS included: an email that already has a reopen-candidate draft
// must NOT be re-surfaced as a second candidate on the next cron cycle.
export const LIVE_DRAFT_STATES: readonly string[] = [
  "draft",
  "needs_review",
  "approved",
  "reopen_candidate",
] as const;

/**
 * Suppressed draft states: the normal scan will NOT re-create a draft for an
 * email that was previously rejected or superseded. A targeted recapture
 * (force_recapture=true) bypasses this suppression.
 * F1 (re-spam guard): without this, 6+ in-window rejected MLB WOs would be
 * resurrected every 5-min cron run into Marnin's review queue.
 */
export const SUPPRESSED_DRAFT_STATES: readonly string[] = [
  "rejected",
  "superseded",
] as const;

// ── A2 — scan-insert self-heal decision ─────────────────────────────────────────
// The (org_id, graph_message_id) UNIQUE key can be hit on a fresh scan INSERT when a
// NON-LIVE shell (a superseded/rejected row) still occupies the slot for that email
// (exactly the supersede-to-re-extract failure in wave2-reextract-diagnosis.json).
// Deciding what to do on a 23505 collision is a pure function of the occupying row's
// status:
//   * occupying row is a suppressed shell (superseded/rejected) -> 'heal': re-populate
//     that row in place (recovering the WO into its existing slot — immune to the key).
//   * occupying row is LIVE (draft/needs_review/approved/reopen_candidate) -> the app-
//     level dedup should already have caught this; a LIVE collision means dedup failed
//     upstream, so DO NOT clobber a live draft/job — breadcrumb + alarm instead.
export function decideInsertConflictAction(
  occupyingStatus: string | null | undefined,
): "heal" | "live_collision" {
  const s = String(occupyingStatus ?? "").toLowerCase();
  return (LIVE_DRAFT_STATES as readonly string[]).includes(s)
    ? "live_collision"
    : "heal";
}

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

const KNOWN_MAKESAFE_JOB_FAMILIES = new Set([
  "assessment_report_quote",
  "roof_report",
  "temp_fence_makesafe",
  "general_makesafe",
  "repair",
  "restoration",
]);

/** Normalise a MakeSafe job-family token for dedupe keys. */
export function normaliseJobFamily(family: string | null | undefined): string {
  const normalised = String(family ?? "").trim().toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  // The durable family is `assessment_report_quote` / `general_makesafe`, while
  // older detail rows and extraction outputs can still carry their report/type
  // spellings. Dedupe must compare the deliverable, not preserve a historical
  // spelling distinction that can mint an exact twin.
  switch (normalised) {
    case "assessment_report":
    case "assessment_quote":
      return "assessment_report_quote";
    case "physical_makesafe":
    case "makesafe":
      return "general_makesafe";
    case "roof":
      return "roof_report";
    case "temp_fence":
      return "temp_fence_makesafe";
    default:
      // An unrecognised family is not a fourth deliverable. Treat it as unknown
      // so the caller can leave the intake in review rather than minting a card
      // merely because two uncertain labels differ.
      return KNOWN_MAKESAFE_JOB_FAMILIES.has(normalised) ? normalised : "";
  }
}

// djb2 string hash — deterministic, sync, no crypto dependency. Used to fold a
// normalised body into the fingerprint discriminator when no ref is parseable.
function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// B3 (dual-capture close-out) — "Job No <NNNNN>" work-order number lifted from the
// subject. This is the AJS/"Make Safe - <Suburb> - Job No 68592" archetype whose ref
// prefix is NOT in SUBJECT_REF_RE (parseSubjectFields returns null), so pre-B3 its
// dual-capture twin fell all the way to the body-hash discriminator — and the two
// capture paths' bodies do NOT always normalise identically (live: 7 of 116 twin
// windows differ, ALL of them this "Job No" builder), so the twin survived as two
// drafts. The job number is a WO-UNIQUE token shared verbatim by both capture rows,
// so using it as the fingerprint discriminator collapses the twin WITHOUT ever
// merging two genuinely different work orders (different jobs = different numbers).
const SUBJECT_JOB_NUMBER_RE =
  /\bjob\s*(?:no\.?|number|#)\s*[:#-]?\s*(\d{3,7})\b/i;

/** Lift a bare "Job No <digits>" work-order number from a subject; null when absent. */
export function subjectJobNumber(
  subject: string | null | undefined,
): string | null {
  const m = SUBJECT_JOB_NUMBER_RE.exec(String(subject ?? ""));
  return m ? m[1] : null;
}

/**
 * M1.5 D0 — DUAL-CAPTURE content fingerprint. Stable across the group-post and
 * mailbox-fallback capture paths for the SAME email:
 *   normalise(from_email) | normalise(subject) | received-minute | discriminator
 * where the DISCRIMINATOR is the parsed subject/stored ref when present, else a bare
 * "Job No <NNNNN>" work-order number (B3), else a hash of the normalised body. It
 * exists so two GENUINELY DIFFERENT work orders — same sender,
 * same minute, identical generic subject ("Make safe request") — can NEVER collapse
 * (H2): a different job has a different ref, and a ref-less different job has a
 * different body. Returns "" (fail OPEN, not deduped) when sender/subject/received are
 * missing OR when NO discriminator can be built (no ref AND no body) — a possible
 * duplicate review draft is always safer than a silently dropped work order.
 */
export function contentFingerprint(
  fromEmail: string | null | undefined,
  subject: string | null | undefined,
  receivedAt: string | null | undefined,
  externalRef?: string | null,
  body?: string | null,
): string {
  const from = String(fromEmail ?? "").trim().toLowerCase();
  const subj = String(subject ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const recv = String(receivedAt ?? "").slice(0, 16); // YYYY-MM-DDTHH:MM
  if (!from || !subj || recv.length < 16) return "";
  // Prefer the stored/parsed ref (job-unique); the caller passes the SAME subject we
  // parse here, so existing drafts and candidates resolve to the same ref.
  const ref = normaliseRef(externalRef) ||
    normaliseRef(parseSubjectFields(subj).external_ref);
  // B3: a "Job No <NNNNN>" work-order number (AJS archetype) is also a WO-unique
  // discriminator shared verbatim across both capture paths — checked BEFORE the body
  // hash so a "Job No" twin whose bodies diverge across paths still collapses. A
  // different work order carries a different job number, so this never merges two jobs.
  const jobNo = ref ? null : subjectJobNumber(subj);
  let disc = "";
  if (ref) disc = `r:${ref}`;
  else if (jobNo) disc = `j:${jobNo}`;
  else {
    // Normalise the body the SAME way both sides are stored, so a candidate's RAW body
    // and an existing draft's body_preview hash identically (H2-residual).
    const nb = normaliseBodyForFingerprint(body);
    if (nb) disc = `b:${simpleHash(nb)}`;
  }
  if (!disc) return ""; // no ref and no body -> cannot safely dedupe -> fail open
  return `${from}|${subj}|${recv}|${disc}`;
}

/**
 * M1 — the two capture rows can straddle a minute boundary (received ~1s apart across
 * :59 -> :00), so a single-minute bucket would miss the twin. Return the fingerprint at
 * the candidate's minute AND the adjacent minutes (±1) so a boundary straddle still
 * dedupes. The discriminator is unchanged across the three, so widening the TIME window
 * never merges two different jobs (they differ in ref/body, not just minute).
 */
export function contentFingerprintChecks(
  fromEmail: string | null | undefined,
  subject: string | null | undefined,
  receivedAt: string | null | undefined,
  externalRef?: string | null,
  body?: string | null,
): string[] {
  const ms = Date.parse(String(receivedAt ?? ""));
  const bases = Number.isFinite(ms)
    ? [
      new Date(ms - 60_000).toISOString(),
      receivedAt,
      new Date(ms + 60_000).toISOString(),
    ]
    : [receivedAt];
  const out = new Set<string>();
  for (const r of bases) {
    const fp = contentFingerprint(fromEmail, subject, r, externalRef, body);
    if (fp) out.add(fp);
  }
  return [...out];
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

export function refCompanyFamilyKey(
  ref: string | null | undefined,
  slug: string | null | undefined,
  name: string | null | undefined,
  family: string | null | undefined,
): string {
  const rc = refCompanyKey(ref, slug, name);
  if (!rc) return "";
  const f = normaliseJobFamily(family);
  if (!f) return "";
  return `${rc}|${f}`;
}

export function refFamilyKey(
  ref: string | null | undefined,
  family: string | null | undefined,
): string {
  const r = normaliseRef(ref);
  const f = normaliseJobFamily(family);
  if (!r || !f) return "";
  return `${r}|${f}`;
}

/**
 * Normalise builder work-order / PO identity separately from the claim reference.
 * MLB can send multiple work orders under one claim ref, e.g. MLB-25096 with
 * work_order_MLB-25096PO-53582.pdf and later MLB-25096PO-53583.pdf. The claim is
 * not enough to prove duplicate identity once a WO/PO discriminator exists.
 */
export function workOrderIdentityKey(
  builderWorkOrderNumber: string | null | undefined,
  builderPoNumber: string | null | undefined,
): string {
  const wo = normaliseRef(builderWorkOrderNumber);
  const poFromWo = wo.match(/PO(\d{3,})$/)?.[1] || "";
  const po = normaliseRef(builderPoNumber).replace(/^PO/, "") || poFromWo;
  if (!wo || !po) return "";
  return `${wo}|${po}`;
}

export function workOrderCompanyKey(
  builderWorkOrderNumber: string | null | undefined,
  builderPoNumber: string | null | undefined,
  slug: string | null | undefined,
  name: string | null | undefined,
): string {
  const identity = workOrderIdentityKey(
    builderWorkOrderNumber,
    builderPoNumber,
  );
  if (!identity) return "";
  const c = normaliseCompany(slug, name);
  if (!c) return "";
  return `${identity}|${c}`;
}

function hasWorkOrderIdentity(
  row: IntakeDedupRow | IntakeDedupCandidate,
): boolean {
  return !!rowWorkOrderIdentityKey(row);
}

function rowWorkOrderIdentityKey(
  row: IntakeDedupRow | IntakeDedupCandidate,
): string {
  return workOrderIdentityKey(
    row.builder_work_order_number || row.external_ref,
    row.builder_po_number,
  );
}

function rowWorkOrderCompanyKey(
  row: IntakeDedupRow | IntakeDedupCandidate,
): string {
  const identity = rowWorkOrderIdentityKey(row);
  if (!identity) return "";
  const c = normaliseCompany(
    row.requesting_company_slug,
    row.requesting_company_name,
  );
  if (!c) return "";
  return `${identity}|${c}`;
}

function setLatestReceivedAt(
  map: Map<string, string>,
  key: string,
  receivedAt: string | null | undefined,
): void {
  if (!key) return;
  const existing = map.get(key);
  const ts = receivedAt || "";
  if (!existing || ts > existing) {
    map.set(key, ts);
  }
}

/**
 * Reorder a newest-first intake scan window so a bounded processor samples both
 * ends of the candidate window: oldest, newest, second-oldest, second-newest...
 *
 * Why this lives with intake dedup helpers: the scan budget is applied AFTER
 * cheap dedup. If we only process the newest N unprocessed rows, sustained
 * high-volume inbound mail can permanently starve older real work orders still
 * inside the seven-day window. Interleaving makes every run give old backlog a
 * chance without ignoring fresh work.
 */
export function interleaveOldestNewestForFairScan<T>(
  newestFirstItems: T[],
): T[] {
  const items = [...(newestFirstItems || [])];
  const ordered: T[] = [];
  let newest = 0;
  let oldest = items.length - 1;
  while (newest <= oldest) {
    ordered.push(items[oldest]);
    oldest--;
    if (newest <= oldest) {
      ordered.push(items[newest]);
      newest++;
    }
  }
  return ordered;
}

/**
 * Build a dedup index from the existing drafts (in any LIVE state) and, optionally,
 * existing jobs' external refs, and previously-rejected/superseded drafts.
 *
 * @param existingDrafts  rows from makesafe_intake_drafts in LIVE_DRAFT_STATES
 * @param existingJobRefs external_ref values from already-created make-safe jobs
 * @param rejectedDrafts  rows from makesafe_intake_drafts in SUPPRESSED_DRAFT_STATES
 *                        (rejected / superseded). A candidate matching this set
 *                        yields 'suppressed_rejected' unless force_recapture=true.
 */
export function buildIntakeDedupIndex(
  existingDrafts: IntakeDedupRow[],
  existingJobRefs: Array<string | IntakeDedupRow | null | undefined> = [],
  rejectedDrafts: IntakeDedupRow[] = [],
): DedupIndex {
  const graphIds = new Set<string>();
  const internetIds = new Set<string>();
  const refCompany = new Set<string>();
  const refCompanyFamily = new Set<string>();
  const refCompanyFamilyWithWorkOrderIdentity = new Set<string>();
  const refCompanyFamilyWithoutWorkOrderIdentity = new Set<string>();
  const refCompanyWithWorkOrderIdentity = new Set<string>();
  const refCompanyWithoutWorkOrderIdentity = new Set<string>();
  const workOrderCompany = new Set<string>();
  const refCompanyUnknownFamily = new Set<string>();
  const jobRefs = new Set<string>();
  const jobRefFamily = new Set<string>();
  const jobUnknownFamilyRefs = new Set<string>();
  const jobRefCompany = new Set<string>();
  const jobRefCompanyFamily = new Set<string>();
  const jobRefCompanyFamilyWithWorkOrderIdentity = new Set<string>();
  const jobRefCompanyFamilyWithoutWorkOrderIdentity = new Set<string>();
  const jobRefCompanyWithWorkOrderIdentity = new Set<string>();
  const jobRefCompanyWithoutWorkOrderIdentity = new Set<string>();
  const jobWorkOrderCompany = new Set<string>();
  const jobRefCompanyUnknownFamily = new Set<string>();
  const rejectedRefCompany = new Map<string, string>();
  const rejectedWorkOrderCompany = new Map<string, string>();
  const fingerprints = new Set<string>();

  for (const d of existingDrafts || []) {
    if (d.graph_message_id) graphIds.add(d.graph_message_id);
    if (d.internet_message_id) internetIds.add(d.internet_message_id);
    const woCompany = rowWorkOrderCompanyKey(d);
    if (woCompany) workOrderCompany.add(woCompany);
    const fp = contentFingerprint(
      d.from_email,
      d.subject,
      d.received_at,
      d.external_ref,
      d.body_preview,
    );
    if (fp) fingerprints.add(fp);
    const rc = refCompanyKey(
      d.external_ref,
      d.requesting_company_slug,
      d.requesting_company_name,
    );
    if (rc) {
      refCompany.add(rc);
      if (hasWorkOrderIdentity(d)) refCompanyWithWorkOrderIdentity.add(rc);
      else refCompanyWithoutWorkOrderIdentity.add(rc);
      const rcf = refCompanyFamilyKey(
        d.external_ref,
        d.requesting_company_slug,
        d.requesting_company_name,
        d.makesafe_job_family,
      );
      if (rcf) {
        refCompanyFamily.add(rcf);
        if (hasWorkOrderIdentity(d)) {
          refCompanyFamilyWithWorkOrderIdentity.add(rcf);
        } else refCompanyFamilyWithoutWorkOrderIdentity.add(rcf);
      } else refCompanyUnknownFamily.add(rc);
    }
  }
  for (const row of existingJobRefs || []) {
    const rowObj: IntakeDedupRow | null = typeof row === "string"
      ? null
      : row ??
        null;
    const ref = typeof row === "string" ? row : rowObj?.external_ref;
    const family = rowObj?.makesafe_job_family ?? null;
    const nr = normaliseRef(ref);
    if (nr) {
      const rc = rowObj
        ? refCompanyKey(
          rowObj.external_ref,
          rowObj.requesting_company_slug,
          rowObj.requesting_company_name,
        )
        : "";
      const woCompany = rowObj ? rowWorkOrderCompanyKey(rowObj) : "";
      if (woCompany) jobWorkOrderCompany.add(woCompany);
      if (rc) {
        jobRefCompany.add(rc);
        if (rowObj && hasWorkOrderIdentity(rowObj)) {
          jobRefCompanyWithWorkOrderIdentity.add(rc);
        } else jobRefCompanyWithoutWorkOrderIdentity.add(rc);
        const rcf = refCompanyFamilyKey(
          rowObj?.external_ref,
          rowObj?.requesting_company_slug,
          rowObj?.requesting_company_name,
          family,
        );
        if (rcf) {
          jobRefCompanyFamily.add(rcf);
          if (rowObj && hasWorkOrderIdentity(rowObj)) {
            jobRefCompanyFamilyWithWorkOrderIdentity.add(rcf);
          } else jobRefCompanyFamilyWithoutWorkOrderIdentity.add(rcf);
        } else jobRefCompanyUnknownFamily.add(rc);
      } else {
        // Legacy/no-company job rows are intentionally the only rows that fall
        // back to ref-only job suppression. Company-known rows must not collide
        // across builders that happen to share the same external ref.
        jobRefs.add(nr);
        const rf = refFamilyKey(ref, family);
        if (rf) jobRefFamily.add(rf);
        else jobUnknownFamilyRefs.add(nr);
      }
    }
  }
  for (const d of rejectedDrafts || []) {
    const woCompany = rowWorkOrderCompanyKey(d);
    if (woCompany) {
      setLatestReceivedAt(rejectedWorkOrderCompany, woCompany, d.received_at);
    }
    const rc = refCompanyKey(
      d.external_ref,
      d.requesting_company_slug,
      d.requesting_company_name,
    );
    // Only add when BOTH ref AND company are known — same safety invariant as the
    // live-state check (no false suppression of unknown-company candidates).
    if (!rc) continue;
    // Keep the LATEST received_at per key (max). This timestamp is the boundary:
    // candidates with the same or older received_at are the already-rejected email;
    // candidates with a NEWER received_at are corrected resends (must NOT suppress).
    setLatestReceivedAt(rejectedRefCompany, rc, d.received_at);
  }

  return {
    graphIds,
    internetIds,
    refCompany,
    refCompanyFamily,
    refCompanyFamilyWithWorkOrderIdentity,
    refCompanyFamilyWithoutWorkOrderIdentity,
    refCompanyWithWorkOrderIdentity,
    refCompanyWithoutWorkOrderIdentity,
    workOrderCompany,
    refCompanyUnknownFamily,
    jobRefs,
    jobRefFamily,
    jobUnknownFamilyRefs,
    jobRefCompany,
    jobRefCompanyFamily,
    jobRefCompanyFamilyWithWorkOrderIdentity,
    jobRefCompanyFamilyWithoutWorkOrderIdentity,
    jobRefCompanyWithWorkOrderIdentity,
    jobRefCompanyWithoutWorkOrderIdentity,
    jobWorkOrderCompany,
    jobRefCompanyUnknownFamily,
    rejectedRefCompany,
    rejectedWorkOrderCompany,
    fingerprints,
  };
}

/**
 * Returns a non-null REASON string when the candidate is already represented by an
 * existing draft (any live state) or an existing job — i.e. DO NOT create a new
 * draft. Returns null when the candidate is genuinely new.
 *
 * Priority: graph_message_id -> internet_message_id -> (ref + company) -> job ref ->
 *           suppressed_rejected (only when !force_recapture).
 *
 * suppressed_rejected fires AFTER all live-state checks so a force_recapture still
 * cannot duplicate a LIVE draft. It only allows bypassing the rejected/superseded
 * suppression for a targeted recapture.
 */
export function isDuplicateIntake(
  candidate: IntakeDedupCandidate,
  index: DedupIndex,
): string | null {
  // Live-state checks — these fire even for force_recapture (cannot duplicate LIVE).
  if (
    candidate.graph_message_id && index.graphIds.has(candidate.graph_message_id)
  ) {
    return "graph_message_id";
  }
  if (
    candidate.internet_message_id &&
    index.internetIds.has(candidate.internet_message_id)
  ) {
    return "internet_message_id";
  }
  // M1.5 D0 — DUAL-CAPTURE content fingerprint. Catches the group-post / mailbox-
  // fallback twin of the SAME email even when their graph_message_ids differ and the
  // external_ref is null (the pre-M1.5 blind spot that produced two drafts + two model
  // calls per email). A live-state check: fires for force_recapture too (cannot
  // duplicate a LIVE draft).
  {
    const checks = contentFingerprintChecks(
      candidate.from_email,
      candidate.subject,
      candidate.received_at,
      candidate.external_ref,
      candidate.body,
    );
    if (checks.some((fp) => index.fingerprints.has(fp))) {
      return "duplicate_content_fingerprint";
    }
  }
  const rc = refCompanyKey(
    candidate.external_ref,
    candidate.requesting_company_slug,
    candidate.requesting_company_name,
  );
  const family = normaliseJobFamily(candidate.makesafe_job_family);
  const candidateHasWorkOrderIdentity = hasWorkOrderIdentity(candidate);
  const candidateWorkOrderCompany = rowWorkOrderCompanyKey(candidate);
  // A builder WO with no recognised family may be a roof, assessment, or
  // physical make-safe obligation. It is therefore not safe to dedupe or mint
  // it automatically: the scanner turns this marker into a visible review draft.
  if (candidateWorkOrderCompany && !family) {
    return "work_order_family_needs_review";
  }
  if (
    candidateWorkOrderCompany &&
    index.workOrderCompany.has(candidateWorkOrderCompany)
  ) {
    return "builder_work_order_identity";
  }
  // W3-H (Marnin's rule, stated twice 2026-07-08): same builder ref + a NEW PO number = a new,
  // separately invoiceable piece of work — not a duplicate to park in review. The *_needs_review
  // returns below fire for the AMBIGUOUS case: a sibling on the same ref+company carries NO recorded
  // WO/PO identity, so we cannot tell whether this incoming PO is the same work. When the candidate's
  // WO/PO identity is genuinely NEW — carried by no existing draft OR job for this ref+company — the
  // ambiguity is resolved: it is new work. Clear the concern so the normal strict gate decides (it
  // auto-approves as its own card when everything else is clean). The exact-PO-match dedup paths
  // (builder_work_order_identity just above, job_external_ref below) still fire first, so a PO that
  // ALREADY exists never reaches this clear. No PO / unknown company => candidatePoIsNew is false =>
  // needs_review stays (fail closed).
  const candidatePoIsNew = !!candidateWorkOrderCompany &&
    !index.workOrderCompany.has(candidateWorkOrderCompany) &&
    !index.jobWorkOrderCompany.has(candidateWorkOrderCompany);
  if (rc) {
    if (!candidateHasWorkOrderIdentity && index.refCompany.has(rc)) {
      return "external_ref+company";
    }
    if (family) {
      const rcf = refCompanyFamilyKey(
        candidate.external_ref,
        candidate.requesting_company_slug,
        candidate.requesting_company_name,
        family,
      );
      let skipDraftRefFamilyDuplicate = false;
      if (candidateHasWorkOrderIdentity && rcf) {
        if (index.refCompanyFamilyWithoutWorkOrderIdentity.has(rcf)) {
          // New PO under this ref+company+family = new work: skip the duplicate refusal (same as a
          // known-different-WO sibling would). Otherwise the identity is ambiguous -> review.
          if (candidatePoIsNew) skipDraftRefFamilyDuplicate = true;
          else return "work_order_identity_needs_review";
        }
        if (index.refCompanyFamilyWithWorkOrderIdentity.has(rcf)) {
          skipDraftRefFamilyDuplicate = true;
        }
      }
      // Same ref/company/family is a duplicate. A legacy unknown-family draft on
      // the same ref/company is NOT allowed to permanently suppress a new
      // known-family candidate; surface it to review so ops can backfill or split
      // the family explicitly.
      if (
        !skipDraftRefFamilyDuplicate && rcf && index.refCompanyFamily.has(rcf)
      ) {
        return "external_ref+company";
      }
      if (index.refCompanyUnknownFamily.has(rc)) {
        return "unknown_family_needs_review";
      }
    } else if (index.refCompany.has(rc)) {
      let skipDraftRefDuplicate = false;
      if (candidateHasWorkOrderIdentity) {
        if (index.refCompanyWithoutWorkOrderIdentity.has(rc)) {
          // New PO under this ref+company = new work: skip the duplicate refusal. Ambiguous otherwise.
          if (candidatePoIsNew) skipDraftRefDuplicate = true;
          else return "work_order_identity_needs_review";
        }
        if (index.refCompanyWithWorkOrderIdentity.has(rc)) {
          skipDraftRefDuplicate = true;
        }
      }
      if (skipDraftRefDuplicate) {
        // A known, different WO/PO identity under this claim is not a draft
        // duplicate, but later job/suppressed checks still need a chance to run.
      } else {
        return "external_ref+company";
      }
    }
  }
  const nr = normaliseRef(candidate.external_ref);
  if (nr) {
    if (
      candidateWorkOrderCompany &&
      index.jobWorkOrderCompany.has(candidateWorkOrderCompany)
    ) {
      return "job_external_ref";
    }
    if (rc) {
      if (!candidateHasWorkOrderIdentity && index.jobRefCompany.has(rc)) {
        return "job_external_ref";
      }
      if (family) {
        const rcf = refCompanyFamilyKey(
          candidate.external_ref,
          candidate.requesting_company_slug,
          candidate.requesting_company_name,
          family,
        );
        let skipJobRefFamilyDuplicate = false;
        if (candidateHasWorkOrderIdentity && rcf) {
          if (index.jobRefCompanyFamilyWithoutWorkOrderIdentity.has(rcf)) {
            // New PO under this ref+company+family = new work: not a job duplicate. Ambiguous otherwise.
            if (candidatePoIsNew) skipJobRefFamilyDuplicate = true;
            else return "job_work_order_identity_needs_review";
          }
          if (index.jobRefCompanyFamilyWithWorkOrderIdentity.has(rcf)) {
            skipJobRefFamilyDuplicate = true;
          }
        }
        if (
          !skipJobRefFamilyDuplicate && rcf &&
          index.jobRefCompanyFamily.has(rcf)
        ) {
          return "job_external_ref";
        }
        if (index.jobRefCompanyUnknownFamily.has(rc)) {
          return "job_unknown_family_needs_review";
        }
      } else if (index.jobRefCompany.has(rc)) {
        let skipJobRefDuplicate = false;
        if (candidateHasWorkOrderIdentity) {
          if (index.jobRefCompanyWithoutWorkOrderIdentity.has(rc)) {
            // New PO under this ref+company = new work: not a job duplicate. Ambiguous otherwise.
            if (candidatePoIsNew) skipJobRefDuplicate = true;
            else return "job_work_order_identity_needs_review";
          }
          if (index.jobRefCompanyWithWorkOrderIdentity.has(rc)) {
            skipJobRefDuplicate = true;
          }
        }
        if (skipJobRefDuplicate) {
          // Known different WO/PO identity under this claim is not a job duplicate.
        } else {
          return "job_external_ref";
        }
      }
    } else if (family) {
      const rf = refFamilyKey(candidate.external_ref, family);
      if (
        rf && index.jobRefFamily.has(rf)
      ) {
        return "job_external_ref";
      }
      if (index.jobUnknownFamilyRefs.has(nr)) {
        return "job_unknown_family_needs_review";
      }
    } else if (index.jobRefs.has(nr)) {
      return "job_external_ref";
    }
  }

  // Suppressed-rejected guard (F1 + Codex F3): if the candidate's ref+company matches a
  // previously-rejected/superseded draft AND this is NOT a targeted recapture,
  // return 'suppressed_rejected' ONLY when the candidate is the SAME or OLDER email
  // (received_at <= stored latest-rejected received_at). A candidate with a NEWER
  // received_at is a corrected resend and must NOT be suppressed. A candidate with no
  // received_at is fail-open (let it through — prefer a possible duplicate review draft
  // over silently missing a real corrected work order).
  if (!candidate.force_recapture && rc) {
    if (candidateWorkOrderCompany) {
      const rejectedLatestTs = index.rejectedWorkOrderCompany.get(
        candidateWorkOrderCompany,
      );
      if (rejectedLatestTs !== undefined) {
        if (
          candidate.received_at && candidate.received_at <= rejectedLatestTs
        ) {
          return "suppressed_rejected";
        }
      }
      return null;
    }
    const rejectedLatestTs = index.rejectedRefCompany.get(rc);
    if (rejectedLatestTs !== undefined) {
      // Only suppress when:
      //   (a) candidate has a received_at present, AND
      //   (b) it is <= the latest rejected received_at (same or older email)
      // If candidate has no received_at -> fail-open (do NOT suppress).
      if (candidate.received_at && candidate.received_at <= rejectedLatestTs) {
        return "suppressed_rejected";
      }
      // candidate.received_at is absent OR newer than the rejected row -> fall through
      // (will create a fresh draft for the corrected resend)
    }
  }

  return null;
}

/**
 * Mutate the index to register a freshly-created draft so a SECOND candidate in the
 * SAME scan pass (e.g. two copies of the same email within one batch) is also
 * deduped. Call right after a successful insert.
 */
export function registerIntakeDraft(
  candidate: IntakeDedupCandidate,
  index: DedupIndex,
): void {
  if (candidate.graph_message_id) {
    index.graphIds.add(candidate.graph_message_id);
  }
  if (candidate.internet_message_id) {
    index.internetIds.add(candidate.internet_message_id);
  }
  // M1.5 D0: register the fingerprint so the SAME email captured twice within one scan
  // batch (group-post + mailbox-fallback rows) is caught on the second occurrence.
  // Register the exact-minute fingerprint; the CHECK widens to adjacent minutes (M1).
  const fp = contentFingerprint(
    candidate.from_email,
    candidate.subject,
    candidate.received_at,
    candidate.external_ref,
    candidate.body,
  );
  if (fp) index.fingerprints.add(fp);
  const rc = refCompanyKey(
    candidate.external_ref,
    candidate.requesting_company_slug,
    candidate.requesting_company_name,
  );
  const woCompany = rowWorkOrderCompanyKey(candidate);
  const candidateHasWorkOrderIdentity = hasWorkOrderIdentity(candidate);
  if (woCompany) index.workOrderCompany.add(woCompany);
  if (rc) {
    index.refCompany.add(rc);
    if (candidateHasWorkOrderIdentity) {
      index.refCompanyWithWorkOrderIdentity.add(rc);
    } else index.refCompanyWithoutWorkOrderIdentity.add(rc);
  }
  const rcf = refCompanyFamilyKey(
    candidate.external_ref,
    candidate.requesting_company_slug,
    candidate.requesting_company_name,
    candidate.makesafe_job_family,
  );
  if (rcf) {
    index.refCompanyFamily.add(rcf);
    if (candidateHasWorkOrderIdentity) {
      index.refCompanyFamilyWithWorkOrderIdentity.add(rcf);
    } else index.refCompanyFamilyWithoutWorkOrderIdentity.add(rcf);
  } else if (rc) index.refCompanyUnknownFamily.add(rc);
}
