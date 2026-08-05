// MLB physical release shape + intake-thread reply plumbing.
//
// Captain ruling (Maylands / forward): three emails, two destinations —
//   1. Billing → makesafes@ (or south-west mailbox): report + AUTHORISED invoice + SWMS
//   2. Report-only → reply on the mailer / work-order intake thread
//   3. Photos-only → reply on the same thread
//
// Identifier: intake `thread_id` (Graph conversationThreadId).
//
// Authority order for the coordinate:
//   1. makesafe_intake_case_sources for the job's cases — always wins when any
//      source row exists (even if those rows lack thread_id → refuse).
//   2. Only when case_sources is EMPTY: recover from the job's approved
//      makesafe_intake_draft via emails(post_id = graph_message_id).thread_id.
//      Provenance is job-bound: draft.status=approved AND
//      draft.approved_job_id === job.id AND the email join is exact.
//      Selection is corroboration, never recency (Captain 2026-08-05, option C):
//      one proven thread_id wins; several are narrowed by the primary intake
//      case story's sourcePostId; anything still ambiguous REFUSES.
//      No guess, no partial match, no outranking of real case_sources rows.
// internet_message_id alone is insufficient across the group-sync path
// (see makesafe_intake_dedup.ts).
//
// TEMPORARY CAPTAIN EXCEPTION (2026-08-05, Maylands ships tonight):
// Microsoft marks conversationThread:reply as Application: "Not supported".
// App-only Graph therefore 403s on group-thread reply (Maylands report route).
// While MLB_PHYSICAL_ORDINARY_MAIL_SEND_FALLBACK_V1 is true, report/photo use
// ordinary admin@ Mail.Send (Munster path) instead of group-thread reply.
// That is an explicitly-authorised stopgap, NOT the locked design default.
// Restore: flip the flag false after a supported auth model can prove
// group-thread reply (delegated Group.ReadWrite.All or equivalent).
//
// AJS/AJBR is untouched (report_invoice + photo, ses@).

import { isSesPhysicalShapedFamily } from "./ses_family_matrix.ts";

/** M365 group that hosts the make-safe work-order intake conversations. */
export const SES_INTAKE_GROUP_MAIL = "ses@secureworkswa.com.au";

/**
 * TEMPORARY CAPTAIN EXCEPTION (2026-08-05).
 *
 * When true, MLB physical report/photo routes ride ordinary admin@ Mail.Send
 * (draft → send → Sent Items proof by x-secureworks-ses-operation) instead of
 * POST /groups/.../threads/.../reply, which Microsoft does not support under
 * application permissions.
 *
 * Visible on purpose: this is not a silent default. Set false to restore the
 * locked intake-thread reply shape once a supported Graph auth path exists.
 */
export const MLB_PHYSICAL_ORDINARY_MAIL_SEND_FALLBACK_V1 = true;

/** Honest transport stamp written onto release routes under the exception. */
export const MLB_ORDINARY_MAIL_SEND_TRANSPORT =
  "ordinary_mail_send_captain_exception_v1";

export function mlbPhysicalUsesOrdinaryMailSendFallback(): boolean {
  return MLB_PHYSICAL_ORDINARY_MAIL_SEND_FALLBACK_V1 === true;
}

/**
 * Exception-only additions to the route_send external-effect payload.
 *
 * Returns `{}` for every route the exception does not govern (AJS/AJBR, the
 * MLB invoice billing pack, and the locked group-thread shape). That emptiness
 * is load-bearing: the effect payload is canonicalised into `payload_hash`,
 * canonical JSON serialises explicit nulls, and `claim_ses_external_effect_v1`
 * raises on content drift for an existing operation_key BEFORE it can report a
 * confirmed effect or reconcile an unknown one. Stamping `mlb_transport: null`
 * on an AJS route would therefore make a re-run of `execute` refuse a release
 * that already sent.
 */
export function mlbOrdinaryMailSendEffectPayloadFields(
  route: {
    mlb_transport?: string | null;
    in_reply_to_internet_message_id?: string | null;
    intended_intake_thread_id?: string | null;
  } | null | undefined,
): Record<string, string | null> {
  const transport = String(route?.mlb_transport || "").trim();
  if (transport !== MLB_ORDINARY_MAIL_SEND_TRANSPORT) return {};
  return {
    in_reply_to_internet_message_id:
      String(route?.in_reply_to_internet_message_id || "").trim() || null,
    mlb_transport: MLB_ORDINARY_MAIL_SEND_TRANSPORT,
    intended_intake_thread_id:
      String(route?.intended_intake_thread_id || "").trim() || null,
  };
}

export interface IntakeThreadSourceRow {
  case_id?: string | null;
  post_id?: string | null;
  thread_id?: string | null;
  conversation_id?: string | null;
  received_at?: string | null;
}

/**
 * Candidate for the empty-case_sources draft→emails recovery path.
 * Callers load approved drafts for the job and join emails on graph_message_id.
 */
export interface ApprovedDraftThreadCandidate {
  draft_id?: string | null;
  status?: string | null;
  approved_job_id?: string | null;
  graph_message_id?: string | null;
  approved_at?: string | null;
  email_post_id?: string | null;
  email_thread_id?: string | null;
  email_conversation_id?: string | null;
  email_received_at?: string | null;
}

export interface IntakeThreadCoordinates {
  /** Graph Groups conversationThreadId — required for group-thread reply. */
  thread_id: string;
  /** Group post id when known (audit / optional createReply anchor). */
  post_id: string | null;
  conversation_id: string | null;
  case_id: string | null;
  /**
   * RFC Internet Message-ID of the intake message when known. Used only as a
   * best-effort In-Reply-To / References header on the ordinary Mail.Send
   * fallback — never as group-thread authority, and never required to send.
   */
  internet_message_id?: string | null;
  /**
   * Where the coordinate came from. `case_sources` is authoritative;
   * `approved_draft_emails` only applies when case_sources had zero rows.
   */
  recovery_source?: "case_sources" | "approved_draft_emails";
}

export function isMlbBuilderKey(builderKey: unknown): boolean {
  return String(builderKey || "").trim().toUpperCase() === "MLB";
}

/**
 * MLB physical release cards (make-safe / temp fence / repair / restoration).
 * Report-only roof/assessment packs keep the legacy non-threaded shape.
 */
export function isMlbPhysicalReleaseShape(args: {
  builder_key?: unknown;
  family?: unknown;
}): boolean {
  if (!isMlbBuilderKey(args.builder_key)) return false;
  const family = String(args.family || "").trim();
  if (isSesPhysicalShapedFamily(family)) return true;
  // temporary_fencing is physical-release but not in SES_PHYSICAL_SHAPED_FAMILIES
  // (that set is for the AJS picket carve-out / labour-materials pack only).
  return family === "temporary_fencing";
}

/**
 * Prefer the primary case's earliest source that carries a non-empty thread_id.
 * Falls back to any source with a thread_id. Empty set → null (caller refuses).
 * Does NOT consult drafts — use resolveIntakeThreadCoordinates for that.
 */
export function pickIntakeThreadCoordinates(
  sources: IntakeThreadSourceRow[] | null | undefined,
  preferredCaseId?: string | null,
): IntakeThreadCoordinates | null {
  const rows = (sources || [])
    .map((row) => ({
      case_id: String(row.case_id || "").trim() || null,
      post_id: String(row.post_id || "").trim() || null,
      thread_id: String(row.thread_id || "").trim() || null,
      conversation_id: String(row.conversation_id || "").trim() || null,
      received_at: String(row.received_at || "").trim() || null,
    }))
    .filter((row) => !!row.thread_id);

  if (rows.length === 0) return null;

  const preferred = String(preferredCaseId || "").trim();
  const scoped = preferred
    ? rows.filter((row) => row.case_id === preferred)
    : rows;
  const pool = scoped.length > 0 ? scoped : rows;

  pool.sort((a, b) => {
    const at = a.received_at || "";
    const bt = b.received_at || "";
    if (at && bt && at !== bt) return at.localeCompare(bt);
    if (at && !bt) return -1;
    if (!at && bt) return 1;
    return String(a.post_id || "").localeCompare(String(b.post_id || ""));
  });

  const chosen = pool[0]!;
  return {
    thread_id: chosen.thread_id!,
    post_id: chosen.post_id,
    conversation_id: chosen.conversation_id,
    case_id: chosen.case_id,
    recovery_source: "case_sources",
  };
}

function storySourcePostIdSet(
  value: string | readonly string[] | null | undefined,
): Set<string> {
  const raw = typeof value === "string" ? [value] : (value || []);
  return new Set(
    raw.map((item) => String(item || "").trim()).filter(Boolean),
  );
}

/**
 * Job-bound draft→emails recovery. Every candidate must prove:
 *   - draft status is approved
 *   - draft.approved_job_id equals the job being prepared (exact)
 *   - emails.post_id equals draft.graph_message_id (exact join)
 *   - email.thread_id is non-empty
 * Anything weaker returns null — a guessed thread is worse than no fallback.
 *
 * Selection among proven candidates (Captain 2026-08-05, option C):
 *   1. one distinct thread_id → corroborated single answer, use it. Differing
 *      post ids on that one thread are not ambiguity — the Graph group reply
 *      needs only thread_id.
 *   2. several distinct thread_ids → keep only threads carrying a post id from
 *      the primary intake case story (`story_json[].sourcePostId`); one
 *      surviving thread → use it;
 *   3. still zero or several threads → refuse. Recency is not evidence, and a
 *      wrong thread is a silent builder-visible failure.
 * The audit anchors (post_id / conversation_id) are stamped only when the
 * winning thread proves ONE value, or when the story names exactly one of them.
 */
export function pickIntakeThreadFromApprovedDraft(
  jobId: string,
  candidates: ApprovedDraftThreadCandidate[] | null | undefined,
  preferredStorySourcePostId?: string | readonly string[] | null,
): IntakeThreadCoordinates | null {
  const job = String(jobId || "").trim();
  if (!job) return null;

  const proven = (candidates || [])
    .map((row) => ({
      draft_id: String(row.draft_id || "").trim() || null,
      status: String(row.status || "").trim().toLowerCase(),
      approved_job_id: String(row.approved_job_id || "").trim() || null,
      graph_message_id: String(row.graph_message_id || "").trim() || null,
      approved_at: String(row.approved_at || "").trim() || null,
      email_post_id: String(row.email_post_id || "").trim() || null,
      email_thread_id: String(row.email_thread_id || "").trim() || null,
      email_conversation_id: String(row.email_conversation_id || "").trim() ||
        null,
      email_received_at: String(row.email_received_at || "").trim() || null,
    }))
    .filter((row) => {
      if (row.status !== "approved") return false;
      if (!row.approved_job_id || row.approved_job_id !== job) return false;
      if (!row.graph_message_id) return false;
      if (!row.email_post_id || row.email_post_id !== row.graph_message_id) {
        return false;
      }
      if (!row.email_thread_id) return false;
      return true;
    });

  if (proven.length === 0) return null;

  const byThread = new Map<string, typeof proven>();
  for (const row of proven) {
    const bucket = byThread.get(row.email_thread_id!);
    if (bucket) bucket.push(row);
    else byThread.set(row.email_thread_id!, [row]);
  }

  const story = storySourcePostIdSet(preferredStorySourcePostId);
  let threadIds = [...byThread.keys()];
  if (threadIds.length > 1) {
    threadIds = story.size
      ? threadIds.filter((threadId) =>
        (byThread.get(threadId) || []).some((row) =>
          story.has(String(row.email_post_id || ""))
        )
      )
      : [];
  }
  if (threadIds.length !== 1) return null;

  const threadId = threadIds[0]!;
  const rows = byThread.get(threadId) || [];
  const anchor = (
    values: Array<string | null>,
    storyScoped: boolean,
  ): string | null => {
    const distinct = [...new Set(values.filter(Boolean).map(String))];
    if (distinct.length === 1) return distinct[0]!;
    if (!storyScoped || !story.size) return null;
    const named = distinct.filter((value) => story.has(value));
    return named.length === 1 ? named[0]! : null;
  };

  return {
    thread_id: threadId,
    post_id: anchor(rows.map((row) => row.email_post_id), true),
    conversation_id: anchor(
      rows.map((row) => row.email_conversation_id),
      false,
    ),
    case_id: null,
    recovery_source: "approved_draft_emails",
  };
}

/**
 * Full coordinate resolution for prepare/assembler.
 *
 * - case_sources with any row → case_sources only (may return null).
 * - case_sources empty → optional approved-draft emails recovery, disambiguated
 *   by the primary intake case story rather than by recency.
 * Never stamps ready without a real thread_id; never outranks real sources.
 */
export function resolveIntakeThreadCoordinates(args: {
  caseSources: IntakeThreadSourceRow[] | null | undefined;
  preferredCaseId?: string | null;
  jobId: string;
  approvedDraftCandidates?: ApprovedDraftThreadCandidate[] | null;
  preferredStorySourcePostId?: string | readonly string[] | null;
}): IntakeThreadCoordinates | null {
  const sources = args.caseSources || [];
  if (sources.length > 0) {
    return pickIntakeThreadCoordinates(sources, args.preferredCaseId);
  }
  return pickIntakeThreadFromApprovedDraft(
    args.jobId,
    args.approvedDraftCandidates,
    args.preferredStorySourcePostId,
  );
}

/** True when a route must reply on the intake thread (MLB physical report/photo). */
export function mlbRouteRequiresIntakeThreadReply(
  routeKind: unknown,
  shape: { builder_key?: unknown; family?: unknown },
): boolean {
  if (!isMlbPhysicalReleaseShape(shape)) return false;
  const kind = String(routeKind || "").trim();
  return kind === "report" || kind === "photo";
}

export function routingIntakeThread(
  routing: Record<string, unknown> | null | undefined,
): IntakeThreadCoordinates | null {
  const row = routing && typeof routing === "object" ? routing : {};
  const threadId = String(
    (row as any).intake_thread_id || (row as any).thread_id || "",
  ).trim();
  if (!threadId) return null;
  return {
    thread_id: threadId,
    post_id: String(
      (row as any).intake_post_id || (row as any).post_id || "",
    ).trim() || null,
    conversation_id: String(
      (row as any).intake_conversation_id ||
        (row as any).conversation_id ||
        "",
    ).trim() || null,
    case_id: String((row as any).intake_case_id || "").trim() || null,
    internet_message_id: String(
      (row as any).intake_internet_message_id ||
        (row as any).internet_message_id ||
        "",
    ).trim() || null,
  };
}

/**
 * Stamp reply coordinates onto a release route.
 *
 * Locked shape: MLB physical report/photo require intake-thread reply; missing
 * coordinates make the route not ready.
 *
 * Under MLB_PHYSICAL_ORDINARY_MAIL_SEND_FALLBACK_V1 (Captain exception): the
 * same routes stay ready without a thread id, clear reply_to_thread_id so the
 * gateway never calls app-unsupported group reply, and ride ordinary Mail.Send.
 * Intended thread coordinates remain as audit-only fields for restore.
 *
 * `useOrdinaryMailSendFallback` defaults to the module flag and exists so both
 * branches stay covered: the locked shape must remain verifiable while the
 * exception is live, otherwise flipping the flag back is an unproven change.
 */
export function applyMlbThreadReplyToRoute<
  T extends {
    route_kind: string;
    ready: boolean;
    reply_to_thread_id?: string | null;
    reply_to_graph_message_id?: string | null;
    requires_thread_reply?: boolean;
    in_reply_to_internet_message_id?: string | null;
    intended_intake_thread_id?: string | null;
    intended_intake_post_id?: string | null;
    mlb_transport?: string | null;
  },
>(
  route: T,
  shape: { builder_key?: unknown; family?: unknown },
  thread: IntakeThreadCoordinates | null,
  useOrdinaryMailSendFallback: boolean = mlbPhysicalUsesOrdinaryMailSendFallback(),
): T {
  const requires = mlbRouteRequiresIntakeThreadReply(route.route_kind, shape);
  if (!requires) {
    return {
      ...route,
      requires_thread_reply: false,
      mlb_transport: null,
    };
  }

  const threadId = thread?.thread_id || "";
  const postId = thread?.post_id || "";
  const internetMessageId = String(thread?.internet_message_id || "").trim();

  // Temporary Captain exception — ordinary Mail.Send (not the locked default).
  if (useOrdinaryMailSendFallback) {
    return {
      ...route,
      // Must stay false so the gateway does not POST /groups/.../threads/.../reply.
      requires_thread_reply: false,
      // Must stay null: any non-empty reply_to_thread_id previously forced the
      // group-thread path even without requires_thread_reply.
      reply_to_thread_id: null,
      // Group post ids are not admin@ message ids — never createReply on them.
      reply_to_graph_message_id: null,
      // Best-effort RFC threading only; never block send when absent.
      in_reply_to_internet_message_id: internetMessageId || null,
      intended_intake_thread_id: threadId || null,
      intended_intake_post_id: postId || null,
      mlb_transport: MLB_ORDINARY_MAIL_SEND_TRANSPORT,
      ready: route.ready,
    };
  }

  // Locked intended shape (restore when group-thread reply is app-supported).
  return {
    ...route,
    requires_thread_reply: true,
    reply_to_thread_id: threadId || null,
    // post_id is the group-conversation post id (audit anchor). Group reply
    // uses thread_id; createReply on admin@ with this id is not the path.
    reply_to_graph_message_id: postId || null,
    in_reply_to_internet_message_id: null,
    intended_intake_thread_id: threadId || null,
    intended_intake_post_id: postId || null,
    mlb_transport: "group_thread_reply",
    ready: route.ready && !!threadId,
  };
}
