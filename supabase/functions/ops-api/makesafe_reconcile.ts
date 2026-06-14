// deno-lint-ignore-file no-explicit-any
// (supabase-js v2 client + Postgres rows are untyped here, matching the ops-api
//  convention — index.ts is fully lint-excluded for the same reason. The `any`
//  casts are confined to the DB-bound action wrappers; the pure reconciliation
//  logic above them is fully typed.)
// ════════════════════════════════════════════════════════════
// MAKE-SAFE EMAIL RECONCILIATION — D1-D4 completeness guarantee
// Mission: makesafe-live-truth-2026-06-14 (Phase 2)
// ════════════════════════════════════════════════════════════
//
// The sync engine (monitor-ses-makesafes) can fail silently. Reconciliation is
// what makes those failures self-detecting. Per MISSION.md:
//
//   D1 — Reconcile diff. Match pipeline_items refs vs board known_refs.
//        Match on source_email_id first, then NORMALISED external_ref as a
//        CANDIDATE ONLY (requires corroborating sender domain and/or date
//        proximity; ambiguous matches -> needs_review, NEVER auto-linked).
//        ALERT both directions: email-with-no-job = dropped intake;
//        job-with-no-email = suspect. D1 ALONE IS INSUFFICIENT — it can only
//        match refs already ingested; it cannot see emails never ingested.
//
//   D2 — MANDATORY bounded full-post inventory. Enumerate ALL group posts via
//        @odata.nextLink exhaustion (reuses the Phase-1 collectPosts traversal)
//        and ALERT on any post id absent from the `emails` table. D1 + D2
//        TOGETHER close the completeness gap.
//
//   D3 — Daily catch-up reconcile (wider window) — same D1 logic, wider lookback.
//
//   D4 — Synthetic canary. Check that a known/expected recent make-safe marker
//        is present in the store within SLA; alert if not. The synthetic message
//        is SEEDED as a gated/manual step (NOT sent live from here) — see
//        seedCanaryExpectation below.
//
// Alerts route through the EXISTING business_events / Telegram path (injected
// `logBusinessEvent` + `notifyTelegram`); no new alerting system is invented.
// Unresolved D1/D2 drift is the "verified" gate signal: summarizeDrift() returns
// `verified: false` while any unexplained drop / missing post / unresolved
// attachment remains, which the board + skills surface as DEGRADED.
//
// This module is import-only pure logic + DB-bound action wrappers. The pure
// functions (normaliseReconRef / reconcileD1 / reconcileD2Inventory /
// summarizeDrift) are exported for the Deno test suite; nothing here calls the
// network at module load.

// SINGLE SOURCE OF TRUTH for ref prefixes + normalisation, shared with the monitor
// (monitor-ses-makesafes/index.ts). The recon side used to hard-code MLB|AJBR|MS
// in normaliseReconRef, so a company-supplied prefix (e.g. "KBA") ingested fine
// but D1 could NEVER match it on the board side (silent reconciliation failure).
// D1 now LOADS the same prefix set the monitor uses (loadRefPrefixes) and
// normalises BOTH the email side and the board side with it via the shared
// normaliseRef. No local prefix copy survives in this file.
import {
  loadRefPrefixes,
  normaliseRef as sharedNormaliseRef,
  REF_PREFIX_FLOOR,
} from "../_shared/makesafe_refs.ts";

// ── Types ───────────────────────────────────────────────────────────────────

// A board-side ref record (from makesafe_audit known_refs[]).
export interface KnownRef {
  external_ref: string | null;
  source_email_id: string | null;
  job_number: string | null;
  substatus: string | null;
}

// A sync-side pipeline item (from pipeline_items / emails join).
export interface PipelineRef {
  ref: string | null;
  // The originating email's identity, for source_email_id corroboration.
  source_email_id?: string | null;
  // Sender domain + received date of the originating email, for D1 corroboration.
  sender_domain?: string | null;
  received_at?: string | null;
  // Whether this pipeline item currently maps to a job (target_job non-null).
  has_target_job?: boolean;
  attachment_count?: number;
}

// Severity ladder per MISSION.md: INFO (normal drift) < WARN (gap, resolving) <
// ERROR (unresolved after retry window).
export type Severity = "INFO" | "WARN" | "ERROR";

export interface ReconAlert {
  // direction tells the operator which side the drift is on.
  //   email_no_job  — a synced make-safe email whose ref has no board job (dropped intake)
  //   job_no_email  — a board job whose ref has no synced email (suspect; manual send / never ingested)
  //   missing_post  — (D2) a group post id absent from the emails table
  //   ambiguous     — a normalised candidate match with no corroboration (needs_review)
  //   canary_missing — (D4) expected canary marker not in store within SLA
  direction:
    | "email_no_job"
    | "job_no_email"
    | "missing_post"
    | "ambiguous"
    | "canary_missing";
  severity: Severity;
  ref: string | null;
  detail: string;
  // Evidence fields (non-PII): post id, job number, etc.
  post_id?: string | null;
  job_number?: string | null;
  source_email_id?: string | null;
}

export interface ReconD1Result {
  alerts: ReconAlert[];
  // Refs that matched cleanly (source_email_id OR corroborated ref candidate).
  matched: Array<{ ref: string; method: string; job_number: string | null }>;
  // Candidate matches that were ambiguous -> needs_review (NEVER auto-linked).
  needs_review: Array<{ ref: string; reason: string }>;
  counts: {
    matched: number;
    email_no_job: number;
    job_no_email: number;
    ambiguous: number;
  };
}

export interface ReconD2Result {
  alerts: ReconAlert[];
  // post ids seen in the live group traversal.
  posts_seen: number;
  // post ids already present in the emails table.
  posts_in_store: number;
  // post ids seen live but absent from the store (the gap D1 can't catch).
  missing_post_ids: string[];
  page_counts?: { conversations: number; threads: number; posts: number };
}

// ── D1/D3 ref normalisation ───────────────────────────────────────────────────
// Per MISSION.md: "AJBR 67200" == "AJBR-67200" == "67200" for refs >= 5 chars.
// Returns the canonical form used as the candidate match key.
//
// PARITY FIX (finding 1): this DELEGATES to the SHARED normaliseRef — the exact
// same implementation the monitor uses on the email side — so the email side and
// the board side can never recognise a different set of prefixes. The optional
// `prefixes` argument is the data-driven set loaded once per run (floor UNION
// validated company prefixes); when omitted it falls back to the static floor, so
// the pure unit tests still see MLB/AJBR/MS without wiring a company set.
export function normaliseReconRef(
  raw: string | null | undefined,
  prefixes: readonly string[] = REF_PREFIX_FLOOR,
): string | null {
  return sharedNormaliseRef(raw, prefixes);
}

// The "bare numeric core" of a normalised ref, used so that "AJBR-67200" and a
// bare "67200" are recognised as the SAME underlying job (>= 5 chars), but only
// ever as a CANDIDATE requiring corroboration — never an auto-link.
function refNumericCore(norm: string | null): string | null {
  if (!norm) return null;
  const m = norm.match(/(\d{5,})$/);
  return m ? m[1] : null;
}

// ── Corroboration ─────────────────────────────────────────────────────────────
// A normalised-ref candidate is only accepted as a clean match when corroborated
// by sender domain AND/OR date proximity. Without corroboration it is ambiguous
// and routed to needs_review. Exact-form matches (same normalised string) are a
// stronger candidate than numeric-core-only matches but STILL require either
// source_email_id identity (handled in D1) or corroboration to auto-accept the
// numeric-core case.
export interface CorroborationCtx {
  // Domains we already trust as make-safe senders (from makesafe_companies). A
  // candidate whose email sender domain is in this set is corroborated.
  trustedSenderDomains?: Set<string>;
  // Max day gap between email received_at and "now"/job date to count date
  // proximity as corroboration. Default 14 days.
  maxDayGap?: number;
  nowIso?: string;
  // PARITY FIX (finding 1): the data-driven ref-prefix set (floor UNION validated
  // company prefixes), loaded once per run by the D1 action and threaded in so
  // BOTH the email side and the board side normalise with the SAME prefixes. When
  // omitted, the static floor (MLB/AJBR/MS) is used (pure-unit-test default).
  refPrefixes?: readonly string[];
}

function dateProximityOk(receivedAt: string | null | undefined, ctx: CorroborationCtx): boolean {
  if (!receivedAt) return false;
  const t = Date.parse(receivedAt);
  if (Number.isNaN(t)) return false;
  const now = ctx.nowIso ? Date.parse(ctx.nowIso) : Date.now();
  if (Number.isNaN(now)) return false;
  const gapDays = Math.abs(now - t) / 86_400_000;
  return gapDays <= (ctx.maxDayGap ?? 14);
}

function senderCorroborated(domain: string | null | undefined, ctx: CorroborationCtx): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return !!ctx.trustedSenderDomains && ctx.trustedSenderDomains.has(d);
}

// ── D1 — reconcile diff (PURE) ────────────────────────────────────────────────
// Inputs:
//   pipelineRefs — sync side (one per pipeline_items ref, with email evidence)
//   knownRefs    — board side (makesafe_audit known_refs[])
//   ctx          — corroboration context (trusted domains, date window)
//
// Output: both-direction alerts, clean matches, ambiguous needs_review.
//
// Matching precedence (highest trust first):
//   1. source_email_id identity — a pipeline item whose source_email_id equals a
//      known_ref.source_email_id is the SAME email; clean match, no normalisation.
//   2. exact normalised ref — same normaliseReconRef string on both sides. This
//      is a clean match (the ref strings are identical, e.g. both "AJBR-67200").
//   3. numeric-core candidate — bare 67200 vs AJBR-67200. CANDIDATE ONLY; accepted
//      as a clean match ONLY with corroboration (sender domain and/or date
//      proximity). Otherwise -> needs_review (NEVER auto-linked).
export function reconcileD1(
  pipelineRefs: PipelineRef[],
  knownRefs: KnownRef[],
  ctx: CorroborationCtx = {},
): ReconD1Result {
  const alerts: ReconAlert[] = [];
  const matched: ReconD1Result["matched"] = [];
  const needsReview: ReconD1Result["needs_review"] = [];

  // PARITY FIX (finding 1): normalise with the data-driven prefix set threaded
  // through ctx. The SAME set normalises the board side AND the email side below.
  const prefixes = ctx.refPrefixes ?? REF_PREFIX_FLOOR;
  const normRef = (r: string | null | undefined) => normaliseReconRef(r, prefixes);

  // Index the board side.
  const boardByEmailId = new Map<string, KnownRef>();
  const boardByExactRef = new Map<string, KnownRef[]>();
  const boardByNumericCore = new Map<string, KnownRef[]>();
  for (const k of knownRefs) {
    if (k.source_email_id) boardByEmailId.set(k.source_email_id, k);
    const norm = normRef(k.external_ref);
    if (norm) {
      (boardByExactRef.get(norm) ?? boardByExactRef.set(norm, []).get(norm)!).push(k);
      const core = refNumericCore(norm);
      if (core) {
        (boardByNumericCore.get(core) ?? boardByNumericCore.set(core, []).get(core)!).push(k);
      }
    }
  }

  // Track which board refs got matched so we can find job_no_email gaps.
  const matchedBoardKeys = new Set<KnownRef>();

  // ── Direction A: every synced pipeline ref must map to a board job. ──
  for (const p of pipelineRefs) {
    const norm = normRef(p.ref);

    // 1) source_email_id identity.
    if (p.source_email_id && boardByEmailId.has(p.source_email_id)) {
      const k = boardByEmailId.get(p.source_email_id)!;
      matchedBoardKeys.add(k);
      matched.push({ ref: norm ?? p.ref ?? "", method: "source_email_id", job_number: k.job_number });
      continue;
    }

    // 2) exact normalised ref (same string). Clean match — UNLESS the board has
    // multiple DISTINCT jobs sharing this exact ref. M3: auto-picking the first
    // job would silently link two real jobs that happen to share an external_ref.
    // Multiple exact candidates with distinct job numbers => ambiguous /
    // needs_review, NEVER auto-pick.
    if (norm && boardByExactRef.has(norm)) {
      const candidates = boardByExactRef.get(norm)!;
      const distinctJobs = new Set(
        candidates.map((c) => c.job_number).filter((j): j is string => !!j),
      );
      if (distinctJobs.size > 1) {
        needsReview.push({ ref: norm, reason: "exact_ref_ambiguous_multiple_jobs" });
        alerts.push({
          direction: "ambiguous",
          severity: "WARN",
          ref: norm,
          detail:
            `Exact ref '${norm}' maps to ${distinctJobs.size} distinct board jobs ` +
            `(${Array.from(distinctJobs).join(", ")}); not auto-linked. Manual review required.`,
          source_email_id: p.source_email_id ?? null,
        });
        // Mark ALL the sharing candidates as "seen" so they do not ALSO fire a
        // job_no_email gap in direction B (the email IS present; the ambiguity is
        // the issue, not absence).
        for (const c of candidates) matchedBoardKeys.add(c);
        continue;
      }
      // A job (job_number present) is the preferred target; a draft (job_number
      // null) still counts as known but is weaker.
      const job = candidates.find((c) => c.job_number) ?? candidates[0];
      matchedBoardKeys.add(job);
      matched.push({ ref: norm, method: "exact_ref", job_number: job.job_number });
      continue;
    }

    // 3) numeric-core candidate — CANDIDATE ONLY. Requires corroboration.
    const core = refNumericCore(norm);
    if (core && boardByNumericCore.has(core)) {
      const candidates = boardByNumericCore.get(core)!;
      const corroborated =
        senderCorroborated(p.sender_domain, ctx) || dateProximityOk(p.received_at, ctx);
      // Ambiguity: more than one distinct board ref shares the numeric core.
      const distinct = new Set(candidates.map((c) => normRef(c.external_ref)));
      if (corroborated && distinct.size === 1) {
        const job = candidates.find((c) => c.job_number) ?? candidates[0];
        matchedBoardKeys.add(job);
        matched.push({ ref: norm ?? core, method: "numeric_core_corroborated", job_number: job.job_number });
      } else {
        // No corroboration OR ambiguous -> needs_review. NEVER auto-link.
        const reason = !corroborated
          ? "numeric_core_uncorroborated"
          : "numeric_core_ambiguous";
        needsReview.push({ ref: norm ?? core, reason });
        alerts.push({
          direction: "ambiguous",
          severity: "WARN",
          ref: norm ?? core,
          detail: `Normalised candidate match (${reason}); not auto-linked. Manual review required.`,
          source_email_id: p.source_email_id ?? null,
        });
      }
      continue;
    }

    // No match in any tier -> email with no job = DROPPED INTAKE alert.
    alerts.push({
      direction: "email_no_job",
      severity: "ERROR",
      ref: norm ?? p.ref ?? null,
      detail: "Synced make-safe email has no matching board job (dropped intake).",
      source_email_id: p.source_email_id ?? null,
    });
  }

  // ── Direction B: every board job ref must have a synced email. ──
  // Build the sync-side ref/email-id indexes once.
  const syncEmailIds = new Set<string>();
  const syncExactRefs = new Set<string>();
  const syncNumericCores = new Set<string>();
  for (const p of pipelineRefs) {
    if (p.source_email_id) syncEmailIds.add(p.source_email_id);
    const norm = normRef(p.ref);
    if (norm) {
      syncExactRefs.add(norm);
      const core = refNumericCore(norm);
      if (core) syncNumericCores.add(core);
    }
  }
  for (const k of knownRefs) {
    if (matchedBoardKeys.has(k)) continue;
    // A draft (no job_number) with no ref is not actionable as a "job_no_email".
    const norm = normRef(k.external_ref);
    const hasSyncSide =
      (k.source_email_id && syncEmailIds.has(k.source_email_id)) ||
      (norm && syncExactRefs.has(norm)) ||
      (refNumericCore(norm) && syncNumericCores.has(refNumericCore(norm)!));
    if (hasSyncSide) continue;
    // Only alert on actual JOBS (job_number present). Drafts that never made it to
    // a job are an intake-queue concern, not a sync drop.
    if (!k.job_number) continue;
    alerts.push({
      direction: "job_no_email",
      severity: "WARN",
      ref: norm ?? k.external_ref ?? null,
      detail: "Board job has no synced make-safe email (suspect: manual send or never ingested).",
      job_number: k.job_number,
      source_email_id: k.source_email_id ?? null,
    });
  }

  return {
    alerts,
    matched,
    needs_review: needsReview,
    counts: {
      matched: matched.length,
      email_no_job: alerts.filter((a) => a.direction === "email_no_job").length,
      job_no_email: alerts.filter((a) => a.direction === "job_no_email").length,
      ambiguous: alerts.filter((a) => a.direction === "ambiguous").length,
    },
  };
}

// ── D2 — full-post inventory diff (PURE) ──────────────────────────────────────
// D1 alone is insufficient: it can only match refs already ingested. D2 takes the
// COMPLETE set of post ids seen in a live group traversal and the set of post ids
// present in the emails table, and alerts on any live post id absent from the
// store — i.e. an email that was never ingested at all. This is the gap-closer.
export function reconcileD2Inventory(
  livePostIds: string[],
  storedPostIds: string[],
  pageCounts?: { conversations: number; threads: number; posts: number },
): ReconD2Result {
  const stored = new Set(storedPostIds);
  const seen = new Set(livePostIds);
  const missing: string[] = [];
  for (const id of seen) {
    if (!stored.has(id)) missing.push(id);
  }
  const alerts: ReconAlert[] = missing.map((id) => ({
    direction: "missing_post",
    severity: "ERROR",
    ref: null,
    detail:
      "Group post present in live traversal but absent from the emails store " +
      "(watermark window missed it). D2 full-inventory gap.",
    post_id: id,
  }));
  return {
    alerts,
    posts_seen: seen.size,
    posts_in_store: stored.size,
    missing_post_ids: missing,
    page_counts: pageCounts,
  };
}

// ── Verified-gate signal ──────────────────────────────────────────────────────
// Unresolved D1/D2 drift BLOCKS the "verified" gate. The board + skills show
// DEGRADED until resolved. This combines: D1 dropped-intake (ERROR), D2 missing
// posts (ERROR), and any unresolved attachments (DEGRADED from sync_state).
export interface DriftSummary {
  verified: boolean;
  mode: "OK" | "DEGRADED" | "ERROR";
  email_no_job: number;
  job_no_email: number;
  ambiguous: number;
  missing_posts: number;
  unresolved_attachments: number;
  reason: string;
}

export function summarizeDrift(
  d1: ReconD1Result | null,
  d2: ReconD2Result | null,
  unresolvedAttachments = 0,
): DriftSummary {
  const emailNoJob = d1?.counts.email_no_job ?? 0;
  const jobNoEmail = d1?.counts.job_no_email ?? 0;
  const ambiguous = d1?.counts.ambiguous ?? 0;
  const missingPosts = d2?.missing_post_ids.length ?? 0;

  // ERROR: a hard completeness failure (dropped intake or a post never ingested).
  const hardFail = emailNoJob > 0 || missingPosts > 0;
  // DEGRADED: softer drift still in the retry window (suspect jobs, ambiguous
  // candidates, unresolved attachments).
  const soft = jobNoEmail > 0 || ambiguous > 0 || unresolvedAttachments > 0;

  let mode: DriftSummary["mode"];
  let reason: string;
  if (hardFail) {
    mode = "ERROR";
    reason = `unresolved drift: email_no_job=${emailNoJob}, missing_posts=${missingPosts}`;
  } else if (soft) {
    mode = "DEGRADED";
    reason = `drift in retry window: job_no_email=${jobNoEmail}, ambiguous=${ambiguous}, pending_attachments=${unresolvedAttachments}`;
  } else {
    mode = "OK";
    reason = "no unexplained drift";
  }
  return {
    verified: mode === "OK",
    mode,
    email_no_job: emailNoJob,
    job_no_email: jobNoEmail,
    ambiguous,
    missing_posts: missingPosts,
    unresolved_attachments: unresolvedAttachments,
    reason,
  };
}

// ── B2/B3 — combined verified gate across SEPARATE D1 + D2 runs (PURE) ────────
// D1 and D2 run on different cron schedules. The combined "verified" signal the
// board/skills read must require BOTH d1 clean AND d2 clean. A D1 run must not be
// able to set recon_verified=true while a previously-detected D2 drop is still
// unresolved (and vice-versa). This pure function combines the freshly-computed
// side with the OTHER side's last persisted signal, then applies the B3 coverage
// bound: verified can only be claimed WITHIN [floor, ceiling]; if the inventory
// floor has never been established (no full historical backfill yet), coverage is
// NOT complete and verified must be false.
export interface PersistedReconSignals {
  // The OTHER check's last persisted verified flag (null = never run).
  otherVerified: boolean | null;
  // D2 missing-post count last seen (drives the hard-fail even on a D1 run).
  d2MissingPosts: number | null;
  // B3 coverage bounds (null = not yet inventoried at that edge).
  inventoryFloor: string | null;
  inventoryCeiling: string | null;
  // B3 — current attachment backlog for this mailbox (pending/failed/needs_review).
  // A non-zero backlog forces DEGRADED on EITHER run (D1 or D2), so a clean D1+D2
  // drift can NEVER read verified while attachments are unresolved. This is folded
  // in here (not only in summarizeDrift) because the D2 path historically passed 0
  // to summarizeDrift and would otherwise verify despite a real backlog.
  unresolvedAttachments?: number | null;
  // FINDING 3 — the attachment-count query FAILED, so the backlog is UNKNOWN. An
  // unknown backlog must NOT be treated as 0 (that silently clears the backlog and
  // lets verified pass). When true, the gate is forced DEGRADED and blocked with a
  // distinct reason. Applies to BOTH the D1 and D2 paths.
  attachmentsUnknown?: boolean | null;
  // B3 — coverage freshness inputs. recon_verified may only be claimed when the
  // inventoried CEILING actually covers UP TO NOW. Without these, a stale ceiling
  // (e.g. D2 stopped running) could leave recon_verified=true over an un-inventoried
  // recent window. Defaults to wall-clock now if omitted.
  nowIso?: string | null;
  // RETAINED for back-compat (callers still pass it) but NO LONGER the staleness
  // bound — see ceilingSkewSeconds. coverageWindowDays describes the lookback the
  // sweep covered; it does NOT relax the freshness requirement (finding 2).
  coverageWindowDays?: number | null;
  // FINDING 2 — full-coverage freshness bound. recon_inventory_ceiling must reach
  // UP TO NOW (now - ceilingSkewSeconds), NOT merely within the lookback window. A
  // days-old ceiling must NOT verify. The skew is a small bounded allowance for the
  // gap between the sweep finishing and this gate running (e.g. the sweep interval).
  // Defaults to a single bounded sweep interval (1 hour) so a routine sweep just
  // finished still verifies, but a ceiling hours/days stale does not.
  ceilingSkewSeconds?: number | null;
  // B3 — the earliest claim this run asserts verified for (the window FLOOR being
  // verified). The inventory floor must be <= this, else the claimed window reaches
  // before inventoried history. Optional; when omitted the floor-non-null check
  // alone applies (back-compat).
  earliestClaimedIso?: string | null;
}

export interface CombinedGate {
  recon_verified: boolean;
  recon_mode: "OK" | "DEGRADED" | "ERROR";
  recon_reason: string;
}

// FINDING 2 — ceiling-freshness skew bounds. The skew is a small allowance for the
// gap between the D2 sweep finishing and this gate running; it is NOT a tunable that
// can be widened to relax the freshness requirement. DEFAULT = one sweep interval
// (1h); MAX = the same 1h hard ceiling, so a caller/corrupt-value cannot pass a
// days-long skew and resurrect a stale-ceiling verify.
export const DEFAULT_CEILING_SKEW_SECONDS = 3600; // 1h
export const MAX_CEILING_SKEW_SECONDS = 3600; // 1h hard cap

export function combineVerifiedGate(
  thisSide: DriftSummary,
  persisted: PersistedReconSignals,
): CombinedGate {
  const reasons: string[] = [];

  // This-side hard/soft failures already encoded in thisSide.mode.
  let mode: CombinedGate["recon_mode"] = thisSide.mode;
  if (thisSide.mode !== "OK") reasons.push(`this:${thisSide.reason}`);

  // B2: a previously-detected D2 drop (missing posts) is a HARD fail even on a D1
  // run — D1 must NOT clear it. Fold the persisted D2 missing-post count in.
  if ((persisted.d2MissingPosts ?? 0) > 0) {
    mode = "ERROR";
    reasons.push(`persisted_d2_missing_posts=${persisted.d2MissingPosts}`);
  }

  // B2: the other side must have run AND been clean. If it never ran, or it is not
  // verified, we cannot claim a clean combined gate.
  if (persisted.otherVerified === null) {
    if (mode === "OK") mode = "DEGRADED";
    reasons.push("other_check_never_ran");
  } else if (persisted.otherVerified === false) {
    // Unresolved drift on the other side. Do not downgrade an ERROR; otherwise
    // at least DEGRADED.
    if (mode === "OK") mode = "DEGRADED";
    reasons.push("other_check_unresolved");
  }

  // B3: coverage bound (FLOOR). recon_verified may only claim coverage WITHIN the
  // inventoried bounds. If the floor was never established (no full historical
  // backfill), coverage is incomplete -> not verified.
  if (!persisted.inventoryFloor) {
    if (mode === "OK") mode = "DEGRADED";
    reasons.push("inventory_floor_unestablished_coverage_incomplete");
  }

  // B3: coverage bound (CEILING present). recon_inventory_ceiling is COMPUTED by
  // the D2 sweep but was never ENFORCED before — recon_verified could be set with a
  // null ceiling. A null ceiling means no inventory sweep has ever recorded an
  // upper coverage edge, so the recent window is un-inventoried -> not verified.
  if (!persisted.inventoryCeiling) {
    if (mode === "OK") mode = "DEGRADED";
    reasons.push("inventory_ceiling_unestablished_coverage_incomplete");
  } else {
    // FINDING 2 — CEILING must cover UP TO NOW, not merely within the lookback
    // window. The ceiling must be no older than (now - ceilingSkewSeconds), where
    // the skew is a small bounded allowance (default one sweep interval = 1h). A
    // days-old ceiling (D2 stopped running) leaves a recent un-inventoried tail and
    // must NOT verify. (Previously the bound was (now - coverageWindowDays), so a
    // ceiling up to ~window days stale wrongly passed.)
    const nowMs = persisted.nowIso ? Date.parse(persisted.nowIso) : Date.now();
    // FINDING 2 (skew clamp) — the skew is a SMALL bounded allowance only. A caller
    // (or a corrupt/poisoned persisted value) supplying an absurd skew (e.g. days)
    // would widen the freshness window so far that a days-stale ceiling would verify
    // again — the exact failure this check exists to prevent. Clamp the skew to a
    // sane maximum (<= 1h = MAX_CEILING_SKEW_SECONDS) and floor it at 0 (a negative
    // skew must not push minFreshMs into the future and reject a fresh ceiling).
    const rawSkew = persisted.ceilingSkewSeconds ?? DEFAULT_CEILING_SKEW_SECONDS;
    const skewSeconds = Number.isFinite(rawSkew)
      ? Math.min(Math.max(rawSkew as number, 0), MAX_CEILING_SKEW_SECONDS)
      : DEFAULT_CEILING_SKEW_SECONDS;
    const ceilMs = Date.parse(persisted.inventoryCeiling);
    const minFreshMs = nowMs - skewSeconds * 1000;
    // FINDING 2 (future ceiling) — a ceiling AHEAD of now (clock skew on the writer,
    // a corrupt timestamp, or a manually-poisoned row) is not real coverage and must
    // NOT verify. Allow only the same small skew forward as backward; anything beyond
    // now + clampedSkew is rejected as a future/clock-skewed ceiling -> DEGRADED.
    const maxFutureMs = nowMs + skewSeconds * 1000;
    if (Number.isNaN(ceilMs)) {
      if (mode === "OK") mode = "DEGRADED";
      reasons.push("inventory_ceiling_unparseable");
    } else if (ceilMs > maxFutureMs) {
      if (mode === "OK") mode = "DEGRADED";
      reasons.push("inventory_ceiling_in_future_clock_skew");
    } else if (ceilMs < minFreshMs) {
      if (mode === "OK") mode = "DEGRADED";
      reasons.push("inventory_ceiling_stale_does_not_cover_window");
    }
  }

  // B3: coverage bound (FLOOR covers earliest claim). If this run asserts verified
  // for a window reaching back to earliestClaimedIso, the inventory floor must be
  // at or before it; otherwise the claimed window reaches before inventoried history.
  if (persisted.inventoryFloor && persisted.earliestClaimedIso) {
    const floorMs = Date.parse(persisted.inventoryFloor);
    const earliestMs = Date.parse(persisted.earliestClaimedIso);
    if (Number.isNaN(floorMs) || (!Number.isNaN(earliestMs) && floorMs > earliestMs)) {
      if (mode === "OK") mode = "DEGRADED";
      reasons.push("inventory_floor_after_earliest_claimed_window");
    }
  }

  // FINDING 3: the attachment-count query FAILED -> backlog UNKNOWN. Block verified
  // with a distinct reason; never let an unknown backlog read as clean.
  if (persisted.attachmentsUnknown) {
    if (mode === "OK") mode = "DEGRADED";
    reasons.push("attachment_backlog_unknown_count_query_failed");
  }

  // B3 / attachment-gate: a non-zero attachment backlog forces DEGRADED on EITHER
  // run, so a clean D1+D2 drift can never read verified while attachments are
  // pending/failed/needs_review. (Folded in here, not only in summarizeDrift, so
  // the D2 path — which passed 0 to summarizeDrift — is also blocked.)
  if ((persisted.unresolvedAttachments ?? 0) > 0) {
    if (mode === "OK") mode = "DEGRADED";
    reasons.push(`unresolved_attachments=${persisted.unresolvedAttachments}`);
  }

  return {
    recon_verified: mode === "OK",
    recon_mode: mode,
    recon_reason: reasons.length ? reasons.join("; ") : "no unexplained drift; both checks clean within coverage bounds",
  };
}

// ── D4 — synthetic canary check (PURE) ────────────────────────────────────────
// The canary's synthetic make-safe email is SEEDED out-of-band (gated/manual —
// see seedCanaryExpectation docstring). This pure check answers: given the
// expected canary marker + its expected-by time, and the set of stored canary
// markers (with their attachment + threaded-reply state), is it present within
// SLA and complete (PDF attachment + threaded-reply observed)?
export interface CanaryExpectation {
  marker: string;            // unique subject/body marker seeded out-of-band
  seeded_at: string;         // when the synthetic email was seeded
  sla_minutes: number;       // alert if not in store within this many minutes
  require_pdf: boolean;      // canary must carry a PDF attachment
  require_threaded_reply: boolean; // canary must include a threaded-reply post
}

export interface CanaryObservation {
  marker: string;
  observed_at: string | null;     // when it landed in the store (null = absent)
  has_pdf_attachment: boolean;
  has_threaded_reply: boolean;
}

export function checkCanary(
  exp: CanaryExpectation,
  obs: CanaryObservation | null,
  nowIso?: string,
): { ok: boolean; alert: ReconAlert | null } {
  const now = nowIso ? Date.parse(nowIso) : Date.now();
  const seeded = Date.parse(exp.seeded_at);
  const ageMin = (now - seeded) / 60_000;

  // Not observed at all.
  if (!obs || !obs.observed_at) {
    // Only alert once the SLA has elapsed; before that, it's still in flight.
    if (ageMin >= exp.sla_minutes) {
      return {
        ok: false,
        alert: {
          direction: "canary_missing",
          severity: "ERROR",
          ref: exp.marker,
          detail: `Canary '${exp.marker}' not in store after ${Math.round(ageMin)} min (SLA ${exp.sla_minutes} min).`,
        },
      };
    }
    return { ok: false, alert: null }; // still within SLA; no alert yet
  }

  // Observed — verify completeness (PDF + threaded reply, per MISSION.md D4).
  const missing: string[] = [];
  if (exp.require_pdf && !obs.has_pdf_attachment) missing.push("pdf_attachment");
  if (exp.require_threaded_reply && !obs.has_threaded_reply) missing.push("threaded_reply");
  if (missing.length > 0) {
    return {
      ok: false,
      alert: {
        direction: "canary_missing",
        severity: "WARN",
        ref: exp.marker,
        detail: `Canary '${exp.marker}' landed but incomplete: missing ${missing.join(", ")}.`,
      },
    };
  }
  return { ok: true, alert: null };
}

// ════════════════════════════════════════════════════════════
// DB-BOUND ACTIONS (thin wrappers; pure logic above is the testable core)
// ════════════════════════════════════════════════════════════
//
// These accept an injected supabase client + alert sink so they stay unit-able.
// They are wired into ops-api index.ts as actions:
//   makesafe_email_reconcile          -> D1 + D3 + attachment-completeness
//   makesafe_email_reconcile_inventory-> D2 full-post inventory (live traversal)
//   makesafe_email_canary             -> D4 canary check

type SB = any;

export interface AlertSink {
  // Reuse ops-api logBusinessEvent (business_events) + Telegram path. Injected so
  // tests can capture without writing.
  logBusinessEvent: (client: SB, event: any) => Promise<void>;
  // Optional Telegram fan-out for ERROR/WARN. No-op if not supplied.
  notifyTelegram?: (text: string) => Promise<void>;
}

const SES_MAILBOX = "ses@secureworkswa.com.au";

// Emit one business_event per alert + a Telegram summary. business_events is the
// canonical alert channel (Telegram business_events channel per MISSION.md).
async function emitAlerts(
  client: SB,
  sink: AlertSink,
  source: string,
  alerts: ReconAlert[],
): Promise<void> {
  for (const a of alerts) {
    await sink.logBusinessEvent(client, {
      event_type: `makesafe.reconcile.${a.direction}`,
      source: `recon/${source}`,
      entity_type: "makesafe_ref",
      entity_id: a.ref || a.post_id || "unknown",
      payload: {
        severity: a.severity,
        direction: a.direction,
        ref: a.ref,
        post_id: a.post_id ?? null,
        job_number: a.job_number ?? null,
        source_email_id: a.source_email_id ?? null,
        detail: a.detail,
      },
      body_preview: `[${a.severity}] ${a.direction}: ${a.detail}`,
      metadata: { mission: "makesafe-live-truth-2026-06-14", reconciliation: source },
    });
  }
  // One Telegram digest (avoid per-alert spam). ERROR > WARN > nothing for INFO.
  if (sink.notifyTelegram) {
    const errors = alerts.filter((a) => a.severity === "ERROR");
    const warns = alerts.filter((a) => a.severity === "WARN");
    if (errors.length || warns.length) {
      const lines = [
        `Make-safe reconcile (${source}): ${errors.length} ERROR, ${warns.length} WARN`,
        ...errors.slice(0, 10).map((a) => `ERROR ${a.direction} ${a.ref ?? a.post_id ?? ""}`),
        ...warns.slice(0, 5).map((a) => `WARN ${a.direction} ${a.ref ?? ""}`),
      ];
      await sink.notifyTelegram(lines.join("\n"));
    }
  }
}

// Load the trusted make-safe sender domains for D1 corroboration.
// FAIL CLOSED (sweep): this read FEEDS the gate — trusted domains can promote an
// otherwise-ambiguous numeric-core candidate to a clean match (suppressing an
// alert). A failed read silently yielding an EMPTY set would not suppress alerts
// (fewer corroborations = MORE needs_review = more DEGRADED), so the empty-set
// direction is safe; but the call must still THROW on error rather than swallow it,
// so a transient DB failure can never quietly change the matching surface. The
// caller turns the throw into a fail-closed 500.
async function loadTrustedSenderDomains(client: SB): Promise<Set<string>> {
  const domains = new Set<string>();
  const { data, error } = await client.from("makesafe_companies")
    .select("sender_patterns").eq("active", true);
  if (error) throw new Error(`makesafe_companies read failed: ${error.message}`);
  for (const co of (data || []) as Array<{ sender_patterns?: string[] }>) {
    for (const p of (co.sender_patterns || [])) {
      const v = String(p).toLowerCase().trim();
      if (!v) continue;
      // sender_patterns hold either a domain or a full address; reduce to domain.
      const at = v.lastIndexOf("@");
      domains.add(at >= 0 ? v.slice(at + 1) : v);
    }
  }
  return domains;
}

// ── D1 + D3 action: reconcile sync side (pipeline_items + emails) vs board ──
// `windowDays` widens the lookback for D3 (daily catch-up); D1 on-demand uses a
// narrower window. Reads board known_refs by invoking the injected makesafeAudit.
export async function makesafeEmailReconcile(
  client: SB,
  sink: AlertSink,
  opts: {
    windowDays?: number;          // lookback window for pipeline emails
    mode?: "D1" | "D3";           // labels the source; D3 = wider window
    makesafeAudit: (client: SB, params: URLSearchParams) => Promise<any>;
    nowIso?: string;
  },
): Promise<{ d1: ReconD1Result; drift: DriftSummary; gate: CombinedGate; source: string }> {
  const source = opts.mode === "D3" ? "D3" : "D1";
  const windowDays = opts.windowDays ?? (opts.mode === "D3" ? 30 : 7);
  const sinceIso = new Date(
    (opts.nowIso ? Date.parse(opts.nowIso) : Date.now()) - windowDays * 86_400_000,
  ).toISOString();

  // Sync side: pipeline_items joined to their originating emails (sender + date).
  const { data: pi, error: piErr } = await client.from("pipeline_items")
    .select("ref, target_job, source_event_ids")
    .eq("mailbox", SES_MAILBOX);
  if (piErr) throw new Error(`pipeline_items read failed: ${piErr.message}`);

  // Map ref -> originating email evidence via email_events_raw + emails. We read
  // emails within the window for sender_domain + received_at corroboration.
  // FAIL CLOSED (sweep): this read feeds D1 corroboration AND the source_email_id
  // linkage. A swallowed error coerced to an empty list would silently drop every
  // pipeline item's email evidence — turning source_email_id matches into
  // email_no_job ERRORs (over-alert) OR, worse, dropping corroboration so a real
  // match is lost. Either way the gate must NOT run on partial evidence; THROW so
  // the caller fails closed (500) rather than persist a verdict computed on a
  // truncated/empty evidence set.
  const { data: emails, error: emailsErr } = await client.from("emails")
    .select("post_id, from_email, received_at, has_attachments")
    .eq("mailbox", SES_MAILBOX)
    .gte("received_at", sinceIso);
  if (emailsErr) throw new Error(`emails (D1 corroboration) read failed: ${emailsErr.message}`);
  const emailById = new Map<string, { from_email: string | null; received_at: string | null }>();
  for (const e of (emails || []) as Array<any>) {
    emailById.set(e.post_id, { from_email: e.from_email ?? null, received_at: e.received_at ?? null });
  }
  // event id -> post id, so we can recover a pipeline item's source email.
  const eventIds = Array.from(
    new Set((pi || []).flatMap((p: any) => (p.source_event_ids || [])).filter(Boolean)),
  );
  const eventToPost = new Map<string, string>();
  if (eventIds.length) {
    // FAIL CLOSED (sweep): this read resolves pipeline-item -> source email identity,
    // the HIGHEST-trust D1 match tier. A swallowed error -> empty map would strip
    // every source_email_id link, mis-classifying matched emails as dropped intake.
    // THROW on error so the gate never runs on a broken linkage.
    const { data: evs, error: evsErr } = await client.from("email_events_raw")
      .select("id, post_id").in("id", eventIds);
    if (evsErr) throw new Error(`email_events_raw (event->post) read failed: ${evsErr.message}`);
    for (const ev of (evs || []) as Array<any>) eventToPost.set(ev.id, ev.post_id);
  }

  const pipelineRefs: PipelineRef[] = (pi || []).map((p: any) => {
    const firstEventId = (p.source_event_ids || []).find((id: string) => eventToPost.has(id));
    const postId = firstEventId ? eventToPost.get(firstEventId) ?? null : null;
    const email = postId ? emailById.get(postId) : null;
    const fromEmail = email?.from_email ?? null;
    const at = fromEmail ? fromEmail.lastIndexOf("@") : -1;
    return {
      ref: p.ref,
      source_email_id: postId,
      sender_domain: at >= 0 ? fromEmail!.slice(at + 1).toLowerCase() : null,
      received_at: email?.received_at ?? null,
      has_target_job: !!p.target_job,
    };
  });

  // Board side: known_refs[] from makesafe_audit.
  const audit = await opts.makesafeAudit(client, new URLSearchParams());
  const knownRefs: KnownRef[] = (audit?.known_refs || []) as KnownRef[];

  const trustedSenderDomains = await loadTrustedSenderDomains(client);
  // PARITY FIX (finding 1): load the SAME data-driven prefix set the monitor uses
  // (floor UNION validated company prefixes), ONCE per run, and thread it into D1
  // so the board side and the email side normalise with identical prefixes. A
  // company-supplied prefix recognised on ingest is now matchable here.
  const refPrefixes = await loadRefPrefixes(client);
  const d1 = reconcileD1(pipelineRefs, knownRefs, {
    trustedSenderDomains,
    nowIso: opts.nowIso,
    refPrefixes,
  });

  // Attachment completeness (counts unresolved attachments for this mailbox) —
  // part of the D-series reconcile per MISSION.md.
  // FINDING 3 — a count-query ERROR must NOT be coerced to 0 (that would silently
  // clear the backlog and let recon_verified pass). On error the backlog is
  // UNKNOWN: force DEGRADED and block verified via the sentinel below.
  const { count: unresolvedCount, error: attErr } = await client.from("email_attachments")
    .select("id, emails!inner(mailbox)", { count: "exact", head: true })
    .eq("emails.mailbox", SES_MAILBOX)
    .in("status", ["pending", "failed", "needs_review"]);
  const attachmentsUnknown = !!attErr;
  // Treat UNKNOWN as a non-zero backlog so it blocks verified (it cannot be 0).
  const unresolved = attachmentsUnknown ? (unresolvedCount ?? 1) : (unresolvedCount ?? 0);
  if (attachmentsUnknown) {
    console.error(`[recon ${source}] attachment-count query failed: ${attErr!.message}`);
  }

  const drift = summarizeDrift(d1, null, unresolved);
  await emitAlerts(client, sink, source, d1.alerts);

  // B2/B3 — read the LAST persisted D2 signal + coverage bounds so this D1 run
  // does NOT overwrite/clear an unresolved D2 drop and only claims verified
  // within inventoried bounds. The combined gate requires BOTH d1 clean AND d2
  // clean AND coverage established.
  // FAIL CLOSED (sweep): this read feeds the gate the persisted D2 missing-post
  // count and coverage bounds. A swallowed error coerced to null would DROP a
  // real, unresolved persisted D2 drop (d2MissingPosts=null reads as "no drop"),
  // i.e. an error coerced into a passing value on the very signal that is supposed
  // to keep a D1 run from clearing a D2 failure. THROW so the caller fails closed
  // (500) rather than recompute + persist a gate on an unknown prior D2 state.
  const { data: prior, error: priorErr } = await client.from("sync_state")
    .select("recon_d2_verified, recon_d2_missing_posts, recon_inventory_floor, recon_inventory_ceiling")
    .eq("mailbox", SES_MAILBOX)
    .maybeSingle();
  if (priorErr) throw new Error(`sync_state (prior D2 signal) read failed: ${priorErr.message}`);
  const gate = combineVerifiedGate(drift, {
    otherVerified: (prior as any)?.recon_d2_verified ?? null,
    d2MissingPosts: (prior as any)?.recon_d2_missing_posts ?? null,
    inventoryFloor: (prior as any)?.recon_inventory_floor ?? null,
    inventoryCeiling: (prior as any)?.recon_inventory_ceiling ?? null,
    // ATTACHMENT-GATE — fold the live backlog into the combined gate (not only into
    // summarizeDrift) so the gate is consistent across D1 and D2 runs. A non-zero
    // backlog forces DEGRADED and blocks recon_verified.
    unresolvedAttachments: unresolved || 0,
    // FINDING 3 — propagate the count-query failure so an UNKNOWN backlog blocks
    // verified (rather than silently reading as 0).
    attachmentsUnknown,
    // B3 — coverage freshness: the persisted ceiling must still cover this D1/D3
    // window, and the floor must reach back to this window's start, else not verified.
    nowIso: opts.nowIso ?? new Date().toISOString(),
    coverageWindowDays: windowDays,
    earliestClaimedIso: sinceIso,
  });

  // Persist the verified-gate signal onto sync_state so the board/skills can read
  // it without re-running reconcile. We write BOTH this run's D1-specific signal
  // AND the combined gate — but we DO NOT touch any recon_d2_* column (B2: D1
  // never clears D2's unresolved drift).
  // BLOCKER 1 (FAIL CLOSED) — this upsert PERSISTS the (possibly blocking) verdict
  // the board/skills read. If it is unchecked and silently fails, a PRIOR row with
  // recon_verified=true survives even though this run computed a DIFFERENT (possibly
  // blocking) verdict — leaving a misleading verified flag. We MUST surface a write
  // failure and fail the action closed: throw so the caller returns an error/500 and
  // NEVER reports success. A run that cannot persist its verdict must not look as if
  // it confirmed the prior one.
  const nowIso = new Date().toISOString();
  const { error: upsertErr } = await client.from("sync_state").upsert({
    mailbox: SES_MAILBOX,
    recon_d1_verified: drift.verified,
    recon_d1_checked_at: nowIso,
    recon_d1_email_no_job: drift.email_no_job,
    recon_verified: gate.recon_verified,
    recon_mode: gate.recon_mode,
    recon_reason: gate.recon_reason,
    recon_checked_at: nowIso,
  }, { onConflict: "mailbox" });
  if (upsertErr) {
    throw new Error(
      `sync_state upsert (D1 verdict persist) failed: ${upsertErr.message} ` +
        `— failing closed; verdict NOT persisted (recon_verified would be left stale).`,
    );
  }

  return { d1, drift, gate, source };
}

// ── D2 action: bounded full-post inventory via live group traversal ──
// Reuses the Phase-1 collectPosts (@odata.nextLink exhaustion) + resolveGroupId.
// Injected so tests can stub the traversal. ALERTS on any live post id absent
// from the emails table. This is the MANDATORY gap-closer; D1 alone is
// insufficient (it cannot see emails never ingested).
export async function makesafeEmailReconcileFullInventory(
  client: SB,
  sink: AlertSink,
  deps: {
    getGraphToken: () => Promise<string>;
    resolveGroupId: (token: string) => Promise<string>;
    collectPosts: (
      token: string,
      groupId: string,
      sinceIso: string,
    ) => Promise<{
      posts: Array<{ id: string }>;
      pageCounts: { conversations: number; threads: number; posts: number };
    }>;
    // windowDays: how far back the bounded inventory reaches. Default 30.
    windowDays?: number;
    nowIso?: string;
    // B3 — the FULL historical backfill (gated Phase-1 M7 step) sets historical=true
    // and traverses from epoch. ONLY the historical backfill is allowed to extend
    // the true coverage FLOOR (recon_inventory_floor) to all history. The recurring
    // bounded sweep (default) updates only the ceiling it actually covered; it does
    // NOT claim historical coverage (older missing posts would otherwise evade
    // both checks while recon_verified wrongly read true).
    historical?: boolean;
  },
): Promise<ReconD2Result & { gate: CombinedGate }> {
  const historical = deps.historical === true;
  const windowDays = deps.windowDays ?? 30;
  const nowMs = deps.nowIso ? Date.parse(deps.nowIso) : Date.now();
  // Historical backfill traverses from epoch (the whole group history); the
  // recurring sweep uses a bounded rolling window.
  const sinceIso = historical
    ? new Date(0).toISOString()
    : new Date(nowMs - windowDays * 86_400_000).toISOString();

  const token = await deps.getGraphToken();
  const groupId = await deps.resolveGroupId(token);
  const { posts, pageCounts } = await deps.collectPosts(token, groupId, sinceIso);
  const livePostIds = posts.map((p) => p.id);

  // Stored post ids within the same window (the comparison set).
  const { data: stored, error } = await client.from("emails")
    .select("post_id")
    .eq("mailbox", SES_MAILBOX)
    .gte("received_at", sinceIso);
  if (error) throw new Error(`emails inventory read failed: ${error.message}`);
  const storedIds = (stored || []).map((e: any) => e.post_id);

  // M2 — a post can be legitimately TERMINAL via exclusion: it was classified as
  // non-make-safe and an audit row was written (email_classifier_exclusions and a
  // change_type='excluded' email_events_raw row). Those posts are deliberately NOT
  // in `emails`, so comparing live posts against `emails` ALONE false-alarms them
  // as missing. Fold the terminal exclusion set into the "accounted for" set so an
  // excluded post PASSES instead of raising a missing_post ERROR.
  // FAIL CLOSED (sweep): the exclusion set feeds D2's "accounted for" set, i.e. it
  // directly decides which live posts are MISSING. A swallowed error -> empty set
  // would corrupt that accounting (firing false missing_post ERRORs on legitimately
  // excluded posts). D2's missing count drives the gate, so it must run on the FULL
  // exclusion set or not at all — THROW so the caller fails closed rather than
  // computing/persisting a verdict from an incomplete accounting.
  const { data: excl, error: exclErr } = await client.from("email_classifier_exclusions")
    .select("post_id")
    .eq("mailbox", SES_MAILBOX);
  if (exclErr) throw new Error(`email_classifier_exclusions read failed: ${exclErr.message}`);
  const excludedIds = (excl || []).map((e: any) => e.post_id);

  // Belt-and-braces: also treat any change_type='excluded' event as terminal, in
  // case the dedicated exclusions table is pruned/rebuilt but the append-only
  // email_events_raw audit log still holds the exclusion record.
  // FAIL CLOSED (sweep): same reasoning — feeds the "accounted for" set; THROW on error.
  const { data: exclEvents, error: exclEventsErr } = await client.from("email_events_raw")
    .select("post_id")
    .eq("mailbox", SES_MAILBOX)
    .eq("change_type", "excluded");
  if (exclEventsErr) throw new Error(`email_events_raw (excluded events) read failed: ${exclEventsErr.message}`);
  const exclusionEventIds = (exclEvents || []).map((e: any) => e.post_id);

  const accountedIds = [...storedIds, ...excludedIds, ...exclusionEventIds];
  const d2 = reconcileD2Inventory(livePostIds, accountedIds, pageCounts);

  // B3 — the bound this sweep actually covered.
  const coveredCeiling = new Date(nowMs).toISOString();

  // Persist the D2 scan log (post ids seen, page counts) to email_events_raw as a
  // non-PII inventory record, per MISSION.md ("persist a scan log").
  // BLOCKER 3 (FAIL CLOSED) — the scan log is the EVIDENCE that this D2 inventory
  // actually ran (post ids seen, page counts, covered window). D2 must NOT proceed
  // to persist a verified state without its scan evidence. If the insert fails and
  // is swallowed, sync_state could be updated to recon_verified=true with NO audit
  // record that the sweep happened — an unprovable verdict. Check the error and
  // THROW so the action fails closed BEFORE any sync_state verdict is written.
  const { error: scanLogErr } = await client.from("email_events_raw").insert({
    mailbox: SES_MAILBOX,
    post_id: "_D2_INVENTORY_SCAN",
    change_type: "inventory_scan",
    page_meta: {
      posts_seen: d2.posts_seen,
      posts_in_store: d2.posts_in_store,
      excluded_accounted: excludedIds.length + exclusionEventIds.length,
      missing_count: d2.missing_post_ids.length,
      page_counts: pageCounts,
      window_days: historical ? "ALL" : windowDays,
      historical,
      covered_since: sinceIso,
      covered_until: coveredCeiling,
    },
  });
  if (scanLogErr) {
    throw new Error(
      `email_events_raw D2 scan-log insert failed: ${scanLogErr.message} ` +
        `— failing closed; D2 will NOT persist a verified state without scan evidence.`,
    );
  }

  await emitAlerts(client, sink, "D2", d2.alerts);

  // ATTACHMENT-GATE — the CURRENT unresolved-attachment backlog for this mailbox
  // (pending/failed/needs_review), mailbox-scoped, same query the D1 path uses.
  // Previously the D2 path passed 0 to summarizeDrift, so D2 could report verified
  // while attachments were pending/failed. Now the backlog is folded into BOTH the
  // drift summary AND the combined gate, so any non-zero backlog forces DEGRADED
  // and blocks recon_verified on the D2 run too.
  // FINDING 3 — a count-query ERROR must NOT be coerced to 0 (silent backlog
  // clear). On error the backlog is UNKNOWN: block verified via the sentinel.
  const { count: attCount, error: d2AttErr } = await client.from("email_attachments")
    .select("id, emails!inner(mailbox)", { count: "exact", head: true })
    .eq("emails.mailbox", SES_MAILBOX)
    .in("status", ["pending", "failed", "needs_review"]);
  const d2AttachmentsUnknown = !!d2AttErr;
  const unresolvedAttachments = d2AttachmentsUnknown ? (attCount ?? 1) : (attCount ?? 0);
  if (d2AttachmentsUnknown) {
    console.error(`[recon D2] attachment-count query failed: ${d2AttErr!.message}`);
  }

  // B2/B3 — persist the D2-specific verified signal + coverage bounds, then write
  // the combined gate folding in the LAST persisted D1 signal. D2 must NOT clobber
  // D1's signal (recon_d1_*).
  const d2Drift = summarizeDrift(null, d2, unresolvedAttachments);
  // FAIL CLOSED (sweep): this read feeds the gate the persisted D1 verified signal
  // and the prior coverage bounds (floor/ceiling). A swallowed error coerced to null
  // would (a) drop the persisted D1 signal (otherVerified=null) and (b) lose the
  // prior ceiling/floor — so the persisted upsert below could REGRESS the coverage
  // bounds or recompute the combined gate against unknown prior D1 state. THROW so
  // the caller fails closed rather than persist a verdict built on partial state.
  const { data: prior, error: priorErr } = await client.from("sync_state")
    .select("recon_d1_verified, recon_inventory_floor, recon_inventory_ceiling")
    .eq("mailbox", SES_MAILBOX)
    .maybeSingle();
  if (priorErr) throw new Error(`sync_state (prior D1 signal) read failed: ${priorErr.message}`);

  // The recurring bounded sweep updates only the CEILING it covered; ONLY the
  // historical backfill establishes/extends the true coverage FLOOR (B3).
  const priorFloor = (prior as any)?.recon_inventory_floor ?? null;
  const priorCeiling = (prior as any)?.recon_inventory_ceiling ?? null;
  const newFloor = historical
    ? sinceIso // epoch — coverage now reaches all history
    : priorFloor; // recurring sweep does NOT lower the historical floor
  const newCeiling = priorCeiling && priorCeiling > coveredCeiling
    ? priorCeiling
    : coveredCeiling;

  const gate = combineVerifiedGate(d2Drift, {
    otherVerified: (prior as any)?.recon_d1_verified ?? null,
    d2MissingPosts: d2.missing_post_ids.length, // this run's own count
    inventoryFloor: newFloor,
    inventoryCeiling: newCeiling,
    // B3/attachment-gate: fold the live backlog + coverage freshness in here too so
    // a stale ceiling or a pending backlog blocks verified on the D2 run.
    unresolvedAttachments,
    // FINDING 3 — propagate the count-query failure so an UNKNOWN backlog blocks
    // verified on the D2 run too.
    attachmentsUnknown: d2AttachmentsUnknown,
    nowIso: new Date(nowMs).toISOString(),
    coverageWindowDays: historical ? undefined : windowDays,
    earliestClaimedIso: sinceIso,
  });

  // BLOCKER 1 (FAIL CLOSED) — this upsert PERSISTS the D2 verdict (including the
  // D2 missing-post count that BLOCKS the gate). An unchecked, silently-failed write
  // leaves a stale prior row that could still read recon_verified=true even though
  // this D2 run found missing posts that should have blocked it. Check the error and
  // THROW so the action fails closed: the caller returns an error/500 and does NOT
  // report success, so a run that cannot persist its (possibly blocking) verdict
  // never leaves a misleading verified flag behind.
  const nowIso = new Date().toISOString();
  const { error: upsertErr } = await client.from("sync_state").upsert({
    mailbox: SES_MAILBOX,
    recon_d2_verified: d2Drift.verified,
    recon_d2_checked_at: nowIso,
    recon_d2_missing_posts: d2.missing_post_ids.length,
    recon_inventory_floor: newFloor,
    recon_inventory_ceiling: newCeiling,
    recon_verified: gate.recon_verified,
    recon_mode: gate.recon_mode,
    recon_reason: gate.recon_reason,
    recon_checked_at: nowIso,
  }, { onConflict: "mailbox" });
  if (upsertErr) {
    throw new Error(
      `sync_state upsert (D2 verdict persist) failed: ${upsertErr.message} ` +
        `— failing closed; verdict NOT persisted (recon_verified would be left stale).`,
    );
  }

  return { ...d2, gate };
}

// ── D4 action: canary check ──
// Reads the expected canary marker (seeded out-of-band) + the stored observation,
// and alerts if absent/incomplete within SLA. The synthetic email is NEVER sent
// from here (no live send in this mission). See seedCanaryExpectation.
export async function makesafeEmailCanary(
  client: SB,
  sink: AlertSink,
  opts: { nowIso?: string } = {},
): Promise<{ checked: number; ok: number; alerts: ReconAlert[] }> {
  // Active canary expectations live in a small table (one row per outstanding
  // canary). If the table/rows are absent, this is a clean no-op (no canary in
  // flight).
  // FAIL CLOSED (sweep): D4 is an ALERT path. A swallowed error here coerced to an
  // empty list would silently report "0 canaries in flight" while a real canary is
  // outstanding — suppressing the canary_missing alert this check exists to raise.
  // THROW so the caller surfaces the failure rather than reporting a false all-clear.
  const { data: exps, error: expsErr } = await client.from("makesafe_canary_expectations")
    .select("marker, seeded_at, sla_minutes, require_pdf, require_threaded_reply, resolved")
    .eq("resolved", false);
  if (expsErr) throw new Error(`makesafe_canary_expectations read failed: ${expsErr.message}`);

  const alerts: ReconAlert[] = [];
  let ok = 0;
  for (const e of (exps || []) as Array<any>) {
    // Observation: is a stored email carrying this marker present, and complete?
    // FAIL CLOSED (sweep): a swallowed error -> hit null would mis-read a LANDED
    // canary as absent and (after SLA) fire a false canary_missing — but more to the
    // point, a transient read failure must not silently decide canary presence.
    // THROW so the operator sees the DB failure rather than a fabricated verdict.
    const { data: hit, error: hitErr } = await client.from("emails")
      .select("post_id, received_at, has_attachments, subject, body_preview")
      .eq("mailbox", SES_MAILBOX)
      .or(`subject.ilike.%${e.marker}%,body_preview.ilike.%${e.marker}%`)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (hitErr) throw new Error(`emails (canary hit) read failed: ${hitErr.message}`);

    let obs: CanaryObservation | null = null;
    if (hit?.post_id) {
      // PDF attachment present + uploaded?
      // FAIL CLOSED (sweep): an error coerced to 0 would mark the PDF as ABSENT and
      // mis-classify a complete canary as incomplete (WARN). Surface the error so a
      // count failure is not silently read as "no PDF".
      const { count: pdfCount, error: pdfErr } = await client.from("email_attachments")
        .select("id", { count: "exact", head: true })
        .eq("email_id", hit.post_id)
        .eq("status", "uploaded");
      if (pdfErr) throw new Error(`email_attachments (canary pdf count) failed: ${pdfErr.message}`);
      // Threaded reply: more than one stored post sharing the canary's thread.
      // FAIL CLOSED (sweep): same — an error coerced to 0 would mark the canary as
      // un-threaded. Surface the error rather than fabricate a completeness verdict.
      const { count: threadCount, error: threadErr } = await client.from("emails")
        .select("post_id", { count: "exact", head: true })
        .eq("mailbox", SES_MAILBOX)
        .or(`subject.ilike.%${e.marker}%,body_preview.ilike.%${e.marker}%`);
      if (threadErr) throw new Error(`emails (canary thread count) failed: ${threadErr.message}`);
      obs = {
        marker: e.marker,
        observed_at: hit.received_at,
        has_pdf_attachment: (pdfCount || 0) > 0,
        has_threaded_reply: (threadCount || 0) > 1,
      };
    }

    const { ok: passed, alert } = checkCanary(
      {
        marker: e.marker,
        seeded_at: e.seeded_at,
        sla_minutes: e.sla_minutes ?? 30,
        require_pdf: e.require_pdf ?? true,
        require_threaded_reply: e.require_threaded_reply ?? true,
      },
      obs,
      opts.nowIso,
    );
    if (passed) {
      ok++;
      // N1 — a passing canary is DONE: mark it resolved so the scheduled D4 check
      // stops re-checking it forever. Without this, every passed canary is
      // re-evaluated on every */15 run indefinitely.
      // SURFACE (sweep): a failed resolve is not a verified-gate signal, but a
      // swallowed failure would leave the canary re-firing every run with no trace.
      // Surface it so the operator can fix the write rather than chase phantom
      // re-checks. (Throwing AFTER ok++ is acceptable: the caller fails the action
      // and re-runs; the canary is idempotently re-resolved next pass.)
      const { error: resolveErr } = await client.from("makesafe_canary_expectations").update({
        resolved: true,
        resolved_at: new Date().toISOString(),
      }).eq("marker", e.marker);
      if (resolveErr) throw new Error(`makesafe_canary_expectations resolve update failed: ${resolveErr.message}`);
    }
    if (alert) alerts.push(alert);
  }

  await emitAlerts(client, sink, "D4", alerts);
  return { checked: (exps || []).length, ok, alerts };
}

// ── Canary seeding (GATED / MANUAL — documented, not auto-run) ─────────────────
// The synthetic canary email is NOT sent live by this engine (no live send in
// this mission). The operational procedure (gated on Marnin) is:
//   1. A human (or a gated ops step) sends ONE synthetic make-safe email to
//      ses@ with a UNIQUE marker in the subject (e.g. "CANARY-2026-06-14-abc123"),
//      INCLUDING a small PDF attachment AND a threaded reply, so the canary
//      exercises the full feed -> sync -> project -> attachment chain.
//   2. The SAME marker + an SLA (e.g. 30 min) is recorded as an expectation row
//      via this helper (makesafe_canary_expectations).
//   3. The scheduled D4 check (makesafeEmailCanary) then verifies the marker is
//      in the store, with a PDF attachment and a threaded reply, within SLA;
//      otherwise it raises a canary_missing alert.
// This helper ONLY records the expectation; it never sends mail.
export async function seedCanaryExpectation(
  client: SB,
  exp: { marker: string; sla_minutes?: number; require_pdf?: boolean; require_threaded_reply?: boolean },
): Promise<void> {
  // FAIL CLOSED (sweep): this records the expectation row D4 watches. A swallowed
  // failure means the operator believes a canary is being watched while NO row
  // exists — so a genuinely-missing canary would never raise canary_missing (a
  // silent hole in the alert path). THROW so a failed seed is visible and retried.
  const { error } = await client.from("makesafe_canary_expectations").upsert({
    marker: exp.marker,
    seeded_at: new Date().toISOString(),
    sla_minutes: exp.sla_minutes ?? 30,
    require_pdf: exp.require_pdf ?? true,
    require_threaded_reply: exp.require_threaded_reply ?? true,
    resolved: false,
  }, { onConflict: "marker" });
  if (error) throw new Error(`makesafe_canary_expectations seed upsert failed: ${error.message}`);
}
