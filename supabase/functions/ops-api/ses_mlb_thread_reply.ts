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
//      No guess, no partial match, no outranking of real case_sources rows.
// internet_message_id alone is insufficient across the group-sync path
// (see makesafe_intake_dedup.ts). A missing thread_id is a hard refuse for
// report/photo — never a quiet new thread.
//
// AJS/AJBR is untouched (report_invoice + photo, ses@).

import { isSesPhysicalShapedFamily } from "./ses_family_matrix.ts";

/** M365 group that hosts the make-safe work-order intake conversations. */
export const SES_INTAKE_GROUP_MAIL = "ses@secureworkswa.com.au";

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

/**
 * Job-bound draft→emails recovery. Every candidate must prove:
 *   - draft status is approved
 *   - draft.approved_job_id equals the job being prepared (exact)
 *   - emails.post_id equals draft.graph_message_id (exact join)
 *   - email.thread_id is non-empty
 * Anything weaker returns null — a guessed thread is worse than no fallback.
 */
export function pickIntakeThreadFromApprovedDraft(
  jobId: string,
  candidates: ApprovedDraftThreadCandidate[] | null | undefined,
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
      email_conversation_id:
        String(row.email_conversation_id || "").trim() || null,
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

  // Newest approved draft first; tie-break on email received_at then post id.
  proven.sort((a, b) => {
    const aa = a.approved_at || "";
    const ba = b.approved_at || "";
    if (aa && ba && aa !== ba) return ba.localeCompare(aa);
    if (aa && !ba) return -1;
    if (!aa && ba) return 1;
    const ar = a.email_received_at || "";
    const br = b.email_received_at || "";
    if (ar && br && ar !== br) return br.localeCompare(ar);
    return String(a.email_post_id || "").localeCompare(
      String(b.email_post_id || ""),
    );
  });

  const chosen = proven[0]!;
  return {
    thread_id: chosen.email_thread_id!,
    post_id: chosen.email_post_id,
    conversation_id: chosen.email_conversation_id,
    case_id: null,
    recovery_source: "approved_draft_emails",
  };
}

/**
 * Full coordinate resolution for prepare/assembler.
 *
 * - case_sources with any row → case_sources only (may return null).
 * - case_sources empty → optional approved-draft emails recovery.
 * Never stamps ready without a real thread_id; never outranks real sources.
 */
export function resolveIntakeThreadCoordinates(args: {
  caseSources: IntakeThreadSourceRow[] | null | undefined;
  preferredCaseId?: string | null;
  jobId: string;
  approvedDraftCandidates?: ApprovedDraftThreadCandidate[] | null;
}): IntakeThreadCoordinates | null {
  const sources = args.caseSources || [];
  if (sources.length > 0) {
    return pickIntakeThreadCoordinates(sources, args.preferredCaseId);
  }
  return pickIntakeThreadFromApprovedDraft(
    args.jobId,
    args.approvedDraftCandidates,
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
  };
}

/**
 * Stamp reply coordinates onto a release route. When the shape requires a
 * thread reply and coordinates are missing, ready becomes false.
 */
export function applyMlbThreadReplyToRoute<
  T extends {
    route_kind: string;
    ready: boolean;
    reply_to_thread_id?: string | null;
    reply_to_graph_message_id?: string | null;
    requires_thread_reply?: boolean;
  },
>(
  route: T,
  shape: { builder_key?: unknown; family?: unknown },
  thread: IntakeThreadCoordinates | null,
): T {
  const requires = mlbRouteRequiresIntakeThreadReply(route.route_kind, shape);
  if (!requires) {
    return {
      ...route,
      requires_thread_reply: false,
    };
  }
  const threadId = thread?.thread_id || "";
  const postId = thread?.post_id || "";
  return {
    ...route,
    requires_thread_reply: true,
    reply_to_thread_id: threadId || null,
    // post_id is the group-conversation post id (audit anchor). Group reply
    // uses thread_id; createReply on admin@ with this id is not the path.
    reply_to_graph_message_id: postId || null,
    ready: route.ready && !!threadId,
  };
}
