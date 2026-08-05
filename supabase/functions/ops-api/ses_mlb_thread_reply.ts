// MLB physical release shape + intake-thread reply plumbing.
//
// Captain ruling (Maylands / forward): three emails, two destinations —
//   1. Billing → makesafes@ (or south-west mailbox): report + AUTHORISED invoice + SWMS
//   2. Report-only → reply on the mailer / work-order intake thread
//   3. Photos-only → reply on the same thread
//
// Identifier: intake `thread_id` (Graph conversationThreadId). Every
// makesafe_intake_case_sources row carries one. internet_message_id alone is
// insufficient across the group-sync path (see makesafe_intake_dedup.ts).
// A missing thread_id is a hard refuse for report/photo — never a quiet new thread.
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

export interface IntakeThreadCoordinates {
  /** Graph Groups conversationThreadId — required for group-thread reply. */
  thread_id: string;
  /** Group post id when known (audit / optional createReply anchor). */
  post_id: string | null;
  conversation_id: string | null;
  case_id: string | null;
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
  };
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
