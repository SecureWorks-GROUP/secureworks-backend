/**
 * Pre-send Graph mail volume guard for SES photo (and any multi-attachment)
 * routes.
 *
 * Purpose: refuse BEFORE the first Microsoft Graph call when a pack cannot fit
 * the documented Graph / Exchange ceilings. Never cull, downscale, re-encode or
 * silently drop photos — a pack that will not fit is a named blocker for a
 * human decision (splitting across multiple emails is a recommendation only).
 *
 * Sources (Microsoft Learn, retrieved 2026-08-05):
 * - Per-attachment direct POST (user message / group post): under 3 MB
 *   https://learn.microsoft.com/en-us/graph/api/resources/attachment
 *   https://learn.microsoft.com/en-us/graph/api/post-post-attachments
 * - Per-attachment upload session (user message/event only): 3–150 MB
 *   https://learn.microsoft.com/en-us/graph/outlook-large-attachments
 *   https://learn.microsoft.com/en-us/graph/api/attachment-createuploadsession
 * - Exchange Online default message size: 35 MB (tenant-customisable up to 150 MB)
 *   noted on createUploadSession docs
 * - Group conversation thread reply has NO createUploadSession path; attachments
 *   are inlined as contentBytes on POST /groups/{id}/threads/{id}/reply and
 *   each file is limited to under 3 MB.
 *
 * Message-total basis (Captain ruling 2026-08-05): BOTH transports compare the
 * BASE64-ENCODED total to the message ceiling, because mail attachments are
 * transported base64-encoded and Exchange enforces its message-size limit on
 * the MIME-encoded message. Comparing raw bytes on the user-mailbox path
 * under-refused — the measured heaviest SES card (51 photos / 33.5 MB raw,
 * ~44.7 MB encoded) read as FITS and would have died at Exchange, which is
 * worse than no guard.
 *
 * Residual unknown without a live send: the tenant's actual customised message
 * size limit, and the exact MIME envelope/header overhead on top of the encoded
 * attachment bytes. The guard uses documented defaults and names them; it does
 * not invent a higher limit.
 */

import type { SesBlocker } from "./ses_docket_envelope.ts";
import { mlbRouteRequiresIntakeThreadReply } from "./ses_mlb_thread_reply.ts";
import { type SesRefusal, sesRefusal } from "./ses_reporting_refusals.ts";

/** 3 MiB — Graph direct fileAttachment POST (message, event, group post). */
export const GRAPH_ATTACHMENT_DIRECT_POST_MAX_BYTES = 3 * 1024 * 1024;

/**
 * 150 MiB — Graph createUploadSession max per file on user messages/events.
 * Group posts cannot use this path.
 */
export const GRAPH_ATTACHMENT_UPLOAD_SESSION_MAX_BYTES = 150 * 1024 * 1024;

/**
 * 35 MiB — Exchange Online default maximum message size (body + attachments).
 * Tenant admins may raise this up to 150 MB; until measured, use the default.
 */
export const GRAPH_DEFAULT_MESSAGE_SIZE_LIMIT_BYTES = 35 * 1024 * 1024;

/** Named docket / release blocker — operator-readable, no silent trim. */
export const PHOTO_MAIL_VOLUME_EXCEEDS_GRAPH_LIMIT =
  "photo_mail_volume_exceeds_graph_limit" as const;

export type SesMailTransportKind =
  | "user_mailbox"
  | "group_thread_reply";

export interface SesMailAttachmentSize {
  name?: string;
  size_bytes: number;
}

export interface SesPhotoMailVolumeOk {
  ok: true;
  transport: SesMailTransportKind;
  attachment_count: number;
  total_raw_bytes: number;
  total_base64_bytes: number;
  message_size_limit_bytes: number;
  per_attachment_limit_bytes: number;
  /** Estimated Graph round-trips for the attachment upload phase alone. */
  estimated_attachment_graph_calls: number;
  sources: string[];
}

export interface SesPhotoMailVolumeBlocked {
  ok: false;
  transport: SesMailTransportKind;
  code: typeof PHOTO_MAIL_VOLUME_EXCEEDS_GRAPH_LIMIT;
  reason: string;
  recovery_action: string;
  attachment_count: number;
  total_raw_bytes: number;
  total_base64_bytes: number;
  message_size_limit_bytes: number;
  per_attachment_limit_bytes: number;
  exceeded:
    | "message_total"
    | "per_attachment"
    | "group_post_no_upload_session";
  offending_attachments: Array<{ name: string; size_bytes: number }>;
  estimated_attachment_graph_calls: number;
  sources: string[];
  /** Recommendation only — not implemented. */
  recommendation: string;
}

export type SesPhotoMailVolumeVerdict =
  | SesPhotoMailVolumeOk
  | SesPhotoMailVolumeBlocked;

const SOURCES = {
  attachment_resource:
    "https://learn.microsoft.com/en-us/graph/api/resources/attachment",
  group_post_attachments:
    "https://learn.microsoft.com/en-us/graph/api/post-post-attachments",
  large_attachments:
    "https://learn.microsoft.com/en-us/graph/outlook-large-attachments",
  create_upload_session:
    "https://learn.microsoft.com/en-us/graph/api/attachment-createuploadsession",
} as const;

/** Base64 contentBytes length for a raw byte count (RFC 4648, padded). */
export function base64EncodedLength(rawBytes: number): number {
  if (!Number.isFinite(rawBytes) || rawBytes <= 0) return 0;
  return Math.ceil(rawBytes / 3) * 4;
}

export function formatByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Resolve transport for a sealed release route.
 * MLB physical report/photo reply on the ses@ group intake thread;
 * AJS photo (and all non-thread routes) use the admin@ user mailbox draft path.
 */
export function resolveSesMailTransport(
  route: {
    reply_to_thread_id?: unknown;
    intake_thread_id?: unknown;
    requires_thread_reply?: unknown;
  },
): SesMailTransportKind {
  const threadId = String(
    route.reply_to_thread_id || route.intake_thread_id || "",
  ).trim();
  if (threadId || route.requires_thread_reply === true) {
    return "group_thread_reply";
  }
  return "user_mailbox";
}

/**
 * Prepare-time transport from family matrix builder/family (before a release
 * route exists). Delegates to the execute-path authority
 * (`mlbRouteRequiresIntakeThreadReply`) so prepare and SEND IT can never
 * resolve different per-file ceilings for the same card.
 */
export function resolveSesMailTransportForPrepare(args: {
  builder_key: string;
  family: string;
  route_kind: "photo" | "report" | "invoice" | "report_invoice";
}): SesMailTransportKind {
  if (
    mlbRouteRequiresIntakeThreadReply(args.route_kind, {
      builder_key: args.builder_key,
      family: args.family,
    })
  ) {
    return "group_thread_reply";
  }
  return "user_mailbox";
}

function perAttachmentLimit(transport: SesMailTransportKind): number {
  return transport === "group_thread_reply"
    ? GRAPH_ATTACHMENT_DIRECT_POST_MAX_BYTES
    : GRAPH_ATTACHMENT_UPLOAD_SESSION_MAX_BYTES;
}

/**
 * Direct fileAttachment POST (group post) is documented as "under 3 MB", so an
 * exactly-3-MiB file is refused by Graph; createUploadSession's 150 MB is an
 * inclusive maximum.
 */
function attachmentExceedsLimit(
  sizeBytes: number,
  transport: SesMailTransportKind,
  limit: number,
): boolean {
  return transport === "group_thread_reply"
    ? sizeBytes >= limit
    : sizeBytes > limit;
}

/**
 * Estimate attachment-phase Graph calls on the user-mailbox path:
 * each file under 3 MB → 1 POST; each larger file → 1 createUploadSession
 * plus ceil(size / chunk) PUT ranges (chunk = 10 * 320 KiB in index.ts).
 * Group-thread path is one reply POST (attachments inlined), so 1.
 */
export function estimateAttachmentGraphCalls(
  transport: SesMailTransportKind,
  sizes: readonly number[],
): number {
  if (transport === "group_thread_reply") {
    return sizes.length > 0 ? 1 : 0;
  }
  const chunk = 10 * 320 * 1024;
  let calls = 0;
  for (const size of sizes) {
    if (size < GRAPH_ATTACHMENT_DIRECT_POST_MAX_BYTES) {
      calls += 1;
    } else {
      calls += 1 + Math.max(1, Math.ceil(size / chunk));
    }
  }
  return calls;
}

function sanitizeAttachments(
  attachments: readonly SesMailAttachmentSize[],
): Array<{ name: string; size_bytes: number }> {
  return attachments.map((row, index) => {
    const size = Number(row.size_bytes);
    return {
      name: String(row.name || `attachment-${index + 1}`),
      size_bytes: Number.isFinite(size) && size > 0 ? Math.floor(size) : 0,
    };
  });
}

/**
 * Pure guard: given attachment raw sizes and transport, decide if Graph can
 * accept the pack as a single message/post. Never mutates the pack.
 */
export function evaluateSesPhotoMailVolume(
  attachments: readonly SesMailAttachmentSize[],
  transport: SesMailTransportKind,
  options: {
    message_size_limit_bytes?: number;
  } = {},
): SesPhotoMailVolumeVerdict {
  const rows = sanitizeAttachments(attachments);
  const sizes = rows.map((row) => row.size_bytes);
  const totalRaw = sizes.reduce((sum, n) => sum + n, 0);
  const totalBase64 = sizes.reduce(
    (sum, n) => sum + base64EncodedLength(n),
    0,
  );
  const messageLimit = options.message_size_limit_bytes ??
    GRAPH_DEFAULT_MESSAGE_SIZE_LIMIT_BYTES;
  const perFileLimit = perAttachmentLimit(transport);
  const estimatedCalls = estimateAttachmentGraphCalls(transport, sizes);
  const sources = transport === "group_thread_reply"
    ? [SOURCES.attachment_resource, SOURCES.group_post_attachments]
    : [
      SOURCES.attachment_resource,
      SOURCES.large_attachments,
      SOURCES.create_upload_session,
    ];

  const oversizeFiles = rows.filter((row) =>
    attachmentExceedsLimit(row.size_bytes, transport, perFileLimit)
  );
  if (oversizeFiles.length > 0) {
    const biggest = oversizeFiles.slice().sort((a, b) =>
      b.size_bytes - a.size_bytes
    )[0];
    const exceeded = transport === "group_thread_reply"
      ? "group_post_no_upload_session" as const
      : "per_attachment" as const;
    const reason = transport === "group_thread_reply"
      ? `Photo pack cannot send as a group-thread reply: attachment '${biggest.name}' is ${
        formatByteCount(biggest.size_bytes)
      } but Microsoft Graph limits each group-post attachment to under ${
        formatByteCount(perFileLimit)
      } (no createUploadSession on group posts). Pack has ${rows.length} attachment(s), total raw ${
        formatByteCount(totalRaw)
      }. Photos are not culled.`
      : `Photo pack cannot send: attachment '${biggest.name}' is ${
        formatByteCount(biggest.size_bytes)
      } which exceeds the Graph per-attachment maximum of ${
        formatByteCount(perFileLimit)
      } (createUploadSession). Pack has ${rows.length} attachment(s), total raw ${
        formatByteCount(totalRaw)
      }. Photos are not culled.`;
    return {
      ok: false,
      transport,
      code: PHOTO_MAIL_VOLUME_EXCEEDS_GRAPH_LIMIT,
      reason,
      recovery_action:
        "Do not resend and do not drop photos. A Captain decision is required — typically split the complete ordered photo set across multiple emails, or use an out-of-band share that preserves every original file. No automatic cull is allowed.",
      attachment_count: rows.length,
      total_raw_bytes: totalRaw,
      total_base64_bytes: totalBase64,
      message_size_limit_bytes: messageLimit,
      per_attachment_limit_bytes: perFileLimit,
      exceeded,
      offending_attachments: oversizeFiles,
      estimated_attachment_graph_calls: estimatedCalls,
      sources,
      recommendation:
        "If splitting is approved, plan multiple photo emails that together carry every original file in order; each email must independently pass this guard.",
    };
  }

  // Mail attachments are transported base64-encoded and Exchange enforces its
  // message-size limit on the MIME-encoded message, so BOTH transports compare
  // the encoded total: group-thread replies inline every attachment as base64
  // contentBytes on one POST, and a user-mailbox message is likewise assembled
  // and delivered MIME-encoded regardless of how the bytes were uploaded.
  const totalForMessageLimit = totalBase64;

  if (totalForMessageLimit > messageLimit) {
    const reason = transport === "group_thread_reply"
      ? `Photo pack cannot send as a group-thread reply: ${rows.length} attachment(s) total ${
        formatByteCount(totalRaw)
      } raw (~${
        formatByteCount(totalBase64)
      } as base64 contentBytes) which exceeds the documented Exchange Online default message size of ${
        formatByteCount(messageLimit)
      }. Photos are not culled.`
      : `Photo pack cannot send: ${rows.length} attachment(s) total ${
        formatByteCount(totalRaw)
      } raw (~${
        formatByteCount(totalBase64)
      } base64-encoded on the wire) which exceeds the documented Exchange Online default message size of ${
        formatByteCount(messageLimit)
      }. Photos are not culled.`;
    return {
      ok: false,
      transport,
      code: PHOTO_MAIL_VOLUME_EXCEEDS_GRAPH_LIMIT,
      reason,
      recovery_action:
        "Do not resend and do not drop photos. A Captain decision is required — typically split the complete ordered photo set across multiple emails so each message stays under the Graph/Exchange ceiling while every original file is still delivered. No automatic cull is allowed.",
      attachment_count: rows.length,
      total_raw_bytes: totalRaw,
      total_base64_bytes: totalBase64,
      message_size_limit_bytes: messageLimit,
      per_attachment_limit_bytes: perFileLimit,
      exceeded: "message_total",
      offending_attachments: rows,
      estimated_attachment_graph_calls: estimatedCalls,
      sources,
      recommendation:
        "If splitting is approved, plan multiple photo emails that together carry every original file in order; each email must independently pass this guard. Do not implement multi-email split without a Captain ruling.",
    };
  }

  return {
    ok: true,
    transport,
    attachment_count: rows.length,
    total_raw_bytes: totalRaw,
    total_base64_bytes: totalBase64,
    message_size_limit_bytes: messageLimit,
    per_attachment_limit_bytes: perFileLimit,
    estimated_attachment_graph_calls: estimatedCalls,
    sources,
  };
}

/** Docket prepare blocker (SesBlocker shape). */
export function sesPhotoMailVolumeBlocker(
  verdict: SesPhotoMailVolumeBlocked,
): SesBlocker {
  return {
    state: "blocked",
    reason: verdict.reason,
    reason_code: PHOTO_MAIL_VOLUME_EXCEEDS_GRAPH_LIMIT,
    searches_attempted: [
      "graph-documented-attachment-limits",
      "graph-documented-message-size-limit",
      verdict.transport,
    ],
    rejected_candidates: verdict.offending_attachments.map(
      (row) => `${row.name}:${row.size_bytes}`,
    ),
    recovery_action: verdict.recovery_action,
    facts: {
      code: verdict.code,
      transport: verdict.transport,
      attachment_count: verdict.attachment_count,
      total_raw_bytes: verdict.total_raw_bytes,
      total_base64_bytes: verdict.total_base64_bytes,
      message_size_limit_bytes: verdict.message_size_limit_bytes,
      per_attachment_limit_bytes: verdict.per_attachment_limit_bytes,
      exceeded: verdict.exceeded,
      estimated_attachment_graph_calls:
        verdict.estimated_attachment_graph_calls,
      recommendation: verdict.recommendation,
      sources: verdict.sources,
      // Explicit: guard never shortens the pack.
      photo_cull: false,
      downscale: false,
      reencode: false,
    },
  };
}

/** Release / execute refusal (SesRefusal shape). */
export function sesPhotoMailVolumeRefusal(
  verdict: SesPhotoMailVolumeBlocked,
): SesRefusal {
  return sesRefusal(
    PHOTO_MAIL_VOLUME_EXCEEDS_GRAPH_LIMIT,
    verdict.recovery_action,
    {
      fact: verdict.reason,
      evidence: {
        transport: verdict.transport,
        attachment_count: verdict.attachment_count,
        total_raw_bytes: verdict.total_raw_bytes,
        total_base64_bytes: verdict.total_base64_bytes,
        message_size_limit_bytes: verdict.message_size_limit_bytes,
        per_attachment_limit_bytes: verdict.per_attachment_limit_bytes,
        exceeded: verdict.exceeded,
        offending_attachments: verdict.offending_attachments,
        estimated_attachment_graph_calls:
          verdict.estimated_attachment_graph_calls,
        recommendation: verdict.recommendation,
        sources: verdict.sources,
        photo_cull: false,
      },
    },
  );
}

/**
 * Assert at the mail gateway boundary. Throws Error with the named code and
 * size facts so no Graph call starts. Call after attachments are loaded.
 */
export function assertSesPhotoMailVolumeFits(
  attachments: readonly { name: string; bytes: Uint8Array }[],
  transport: SesMailTransportKind,
): SesPhotoMailVolumeOk {
  const verdict = evaluateSesPhotoMailVolume(
    attachments.map((row) => ({
      name: row.name,
      size_bytes: row.bytes.byteLength,
    })),
    transport,
  );
  if (!verdict.ok) {
    throw new Error(
      `${verdict.code}: ${verdict.reason} ` +
        `[total_raw_bytes=${verdict.total_raw_bytes}; ` +
        `total_base64_bytes=${verdict.total_base64_bytes}; ` +
        `message_size_limit_bytes=${verdict.message_size_limit_bytes}; ` +
        `per_attachment_limit_bytes=${verdict.per_attachment_limit_bytes}; ` +
        `transport=${verdict.transport}]`,
    );
  }
  return verdict;
}
