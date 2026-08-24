// Sealed SES release Graph mail gateway helpers.
// Exact-once route_send proof lives here: create draft → checkpoint → send →
// prove in Sent Items by the SES operation token carried on the non-visible
// internet message header `x-secureworks-ses-operation`.
//
// The builder-facing subject, body and Xero reference must never carry the
// bracketed SES token. A legacy subject-token match remains only so already
// stamped in-flight messages stay reconcilable across the deploy cutover.
//
// Do not route sealed SES releases through send-outlook-email; that function
// refuses sealed jobs by design. This path is the controlled release transport.

import {
  assertSesPhotoMailVolumeFits,
  resolveSesMailTransport,
} from "./ses_photo_mail_volume_guard.ts";
import { SesExternalOutcomeUnknownError } from "./ses_external_effects.ts";
import { assertSesSampleSendAllowed } from "./ses_sample_destination.ts";

export interface SesRouteSendResult {
  message_id: string;
  internet_message_id?: string;
  state: "sent";
  operation_token: string;
}

export interface SesMailGateway {
  createDraftAndSend(
    route: Record<string, any>,
    context: { external_token: string; operation_key: string },
  ): Promise<SesRouteSendResult>;
  reconcileSent(
    externalToken: string,
    route?: Record<string, any>,
  ): Promise<SesRouteSendResult[]>;
}

export const SES_RELEASE_MAILBOX = "admin@secureworkswa.com.au";
export const SES_RELEASE_CC = "ses@secureworkswa.com.au";
export const AJS_WORK_ORDERS_MAILBOX = "workorders@ajs.build";
/**
 * AJS permanent builder CC constants (Captain 2026-08-06). The Captain's
 * 2026-08-24 ruling moved AJBR completion docs to finance-only and cleared every
 * photo CC; route-scoped composition now lives in sesReleaseRouteCc(). Domain is
 * always `ajs.build` — never copy a live value that may be misspelled.
 */
export const AJS_VANESSA_CC = "vanessa@ajs.build";
export const AJS_MANDI_CC = "mandi@ajs.build";
/**
 * MLB's Prime (primeeco.tech) work-order mailer (Captain 2026-08-06).
 *
 * Destination for the MLB physical report and photo routes. It is a SEALED
 * constant on purpose: `makesafe_companies.report_recipient` for MLB is the
 * billing mailbox `makesafes@mlbuilders.com.au`, which is why inheriting it sent
 * all three MLB emails to the same place, and `sender_patterns` is an INBOUND
 * trust list that must never auto-select a destination (see ses_mailer_ops_send).
 */
export const MLB_PRIME_MAILER = "mlb.mailer@primeeco.tech";
/** M365 group that hosts make-safe work-order intake threads (monitor-ses). */
export const SES_INTAKE_GROUP_MAIL = "ses@secureworkswa.com.au";

/** Non-visible carrier for crash-safe Sent Items / Drafts reconciliation. */
export const SES_OPERATION_HEADER = "x-secureworks-ses-operation";
/** Exact non-visible operation coordinate on an M365 group-thread post. */
export const SES_OPERATION_EXTENSION_NAME = "com.secureworks.sesOperation";
export const SES_OPERATION_EXTENSION_ID =
  `Microsoft.OutlookServices.OpenTypeExtension.${SES_OPERATION_EXTENSION_NAME}`;

/** Maverick / admin@ HTML signature (matches send-outlook-email admin branch). */
export const SES_ADMIN_HTML_SIGNATURE = `
<div style="margin-top:28px;padding-top:20px;border-top:2px solid #F15A29;font-family:Helvetica,Arial,sans-serif;max-width:400px">
  <p style="margin:0 0 2px;font-size:14px;font-weight:bold;color:#293C46">Maverick</p>
  <p style="margin:0 0 10px;font-size:12px;color:#4C6A7C">Operations Assist</p>
  <p style="margin:0 0 10px;font-size:10px;color:#293C46;letter-spacing:1.5px;font-weight:600">EXCELLENCE &nbsp;|&nbsp; INTEGRITY &nbsp;|&nbsp; SERVICE</p>
  <p style="margin:0;font-size:12px;color:#4C6A7C;line-height:20px">
    <b style="color:#293C46">E:</b> <a href="mailto:ses@secureworkswa.com.au" style="color:#F15A29;text-decoration:none">ses@secureworkswa.com.au</a><br/>
    <b style="color:#293C46">W:</b> <a href="https://secureworksgroup.com.au" style="color:#4C6A7C;text-decoration:none">secureworksgroup.com.au</a>
  </p>
</div>`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builder-facing subject: never inject the SES operation token.
 * Also strips a residual `[SES-…]` / bare token so a caller cannot re-introduce it.
 */
export function sesOperationSubject(
  subject: string,
  externalToken?: string,
): string {
  let base = String(subject || "").trim();
  const token = String(externalToken || "").trim();
  if (!token) return base;
  base = base
    .replace(new RegExp(`\\s*\\[${escapeRegExp(token)}\\]`, "gi"), "")
    .replace(new RegExp(`\\s*${escapeRegExp(token)}`, "gi"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return base;
}

/** Internet message headers that carry the operation token (Graph create only). */
export function sesOperationInternetMessageHeaders(
  externalToken: string,
): Array<{ name: string; value: string }> {
  const token = String(externalToken || "").trim();
  if (!token) return [];
  return [{ name: SES_OPERATION_HEADER, value: token }];
}

export function subjectHasOperationToken(
  subject: unknown,
  externalToken: string,
): boolean {
  const token = String(externalToken || "").trim();
  if (!token) return false;
  return String(subject || "").includes(token);
}

function headerNameIsOperation(name: unknown): boolean {
  return String(name || "").trim().toLowerCase() === SES_OPERATION_HEADER;
}

export function headersHaveOperationToken(
  headers: unknown,
  externalToken: string,
): boolean {
  const token = String(externalToken || "").trim();
  if (!token || !Array.isArray(headers)) return false;
  return headers.some((header) => {
    if (!header || typeof header !== "object") return false;
    const row = header as { name?: unknown; value?: unknown };
    return headerNameIsOperation(row.name) &&
      String(row.value || "").trim() === token;
  });
}

/**
 * Primary match: non-visible operation header.
 * Legacy match: subject still carrying a pre-cutover stamped token so an
 * in-flight draft/sent row cannot become unprovable across deploy.
 */
export function messageHasOperationToken(
  message: Record<string, unknown> | null | undefined,
  externalToken: string,
): boolean {
  if (!message) return false;
  if (
    headersHaveOperationToken(message.internetMessageHeaders, externalToken)
  ) {
    return true;
  }
  return subjectHasOperationToken(message.subject, externalToken);
}

/** Escape plain route body text into a simple HTML body and append signature. */
export function sesReleaseHtmlBody(body: string): string {
  const escaped = String(body || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((block) => block.replaceAll("\n", "<br/>"))
    .filter((block) => block.trim().length > 0)
    .map((block) =>
      `<p style="margin:0 0 12px;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#293C46">${block}</p>`
    )
    .join("");
  return `${paragraphs || "<p></p>"}${SES_ADMIN_HTML_SIGNATURE}`;
}

/**
 * Client-side match of Graph messages by the SES operation token.
 * Avoids OData `contains(subject,…)` which is unreliable under application
 * permissions and was the load-bearing dead end for post-send proof.
 * Prefers the non-visible header; falls back to legacy subject stamp only.
 */
export function filterMessagesByOperationToken(
  messages: Array<Record<string, unknown>>,
  externalToken: string,
): Array<Record<string, unknown>> {
  return (messages || []).filter((message) =>
    messageHasOperationToken(message, externalToken)
  );
}

export function toSesRouteSendResults(
  messages: Array<Record<string, unknown>>,
  externalToken: string,
): SesRouteSendResult[] {
  return filterMessagesByOperationToken(messages, externalToken).map(
    (message) => ({
      message_id: String(message.id || ""),
      internet_message_id: message.internetMessageId
        ? String(message.internetMessageId)
        : undefined,
      state: "sent" as const,
      operation_token: externalToken,
    }),
  ).filter((row) => row.message_id.length > 0);
}

export type SesGraphJson = (
  url: string,
  init: RequestInit,
  expected: number[],
) => Promise<any>;

export type SesRouteAttachment = {
  name: string;
  contentType: string;
  bytes: Uint8Array;
};

export interface SesGraphMailGatewayDeps {
  mailbox?: string;
  graphJson: SesGraphJson;
  loadAttachments: (hashes: string[]) => Promise<SesRouteAttachment[]>;
  checkpointDraft: (
    operationKey: string,
    draftId: string,
  ) => Promise<void>;
  uploadAttachment: (
    mailbox: string,
    messageId: string,
    attachment: SesRouteAttachment,
  ) => Promise<void>;
  /** How many times to poll Sent Items after send (default 20). */
  sentPollAttempts?: number;
  /** Delay between Sent Items polls in ms (default 500). */
  sentPollDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Resolve the M365 group id that hosts intake threads (default: ses@ group).
   * Overridable for tests.
   */
  resolveIntakeGroupId?: (graphJson: SesGraphJson) => Promise<string>;
}

const MESSAGE_LIST_SELECT =
  "id,internetMessageId,subject,isDraft,sentDateTime,createdDateTime,internetMessageHeaders";

async function listFolderMessages(
  graphJson: SesGraphJson,
  mailbox: string,
  folder: "drafts" | "sentitems",
  top = 40,
): Promise<Array<Record<string, unknown>>> {
  // No OData contains filter — list newest and match the operation token
  // client-side (header primary, legacy subject fallback). That is the proof
  // path that does not dead-end on Graph query support differences across tenants.
  const params = new URLSearchParams({
    "$select": MESSAGE_LIST_SELECT,
    "$orderby": folder === "sentitems"
      ? "sentDateTime desc"
      : "createdDateTime desc",
    "$top": String(top),
  });
  const url = `https://graph.microsoft.com/v1.0/users/${
    encodeURIComponent(mailbox)
  }/mailFolders/${folder}/messages?${params}`;
  const response = await graphJson(url, { method: "GET" }, [200]);
  return Array.isArray(response?.value) ? response.value : [];
}

/**
 * Some Graph tenants omit internetMessageHeaders on folder list even with
 * $select. Hydrate missing headers via single-message GET so header-based
 * proof stays reliable without putting the token back in the subject.
 */
async function hydrateOperationHeaders(
  graphJson: SesGraphJson,
  mailbox: string,
  messages: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const out = messages.map((message) => ({ ...message }));
  await Promise.all(out.map(async (message) => {
    if (Array.isArray(message.internetMessageHeaders)) return;
    const id = String(message.id || "").trim();
    if (!id) return;
    try {
      const full = await graphJson(
        `https://graph.microsoft.com/v1.0/users/${
          encodeURIComponent(mailbox)
        }/messages/${
          encodeURIComponent(id)
        }?$select=id,internetMessageId,subject,internetMessageHeaders,isDraft`,
        { method: "GET" },
        [200],
      );
      if (Array.isArray(full?.internetMessageHeaders)) {
        message.internetMessageHeaders = full.internetMessageHeaders;
      }
      if (full?.internetMessageId && !message.internetMessageId) {
        message.internetMessageId = full.internetMessageId;
      }
    } catch {
      // Leave the list row as-is; legacy subject match may still apply.
    }
  }));
  return out;
}

async function listFolderMessagesForReconcile(
  graphJson: SesGraphJson,
  mailbox: string,
  folder: "drafts" | "sentitems",
  externalToken: string,
): Promise<Array<Record<string, unknown>>> {
  const listed = await listFolderMessages(graphJson, mailbox, folder);
  const direct = filterMessagesByOperationToken(listed, externalToken);
  if (direct.length > 0) return listed;
  // No match yet — hydrate headers for the recent window and re-match.
  return await hydrateOperationHeaders(graphJson, mailbox, listed);
}

/**
 * RFC In-Reply-To / References shape (angle-bracket form).
 *
 * IMPORTANT — not used on Graph draft create. Microsoft Graph only accepts
 * custom internetMessageHeaders with an `x-` prefix on message create; putting
 * `In-Reply-To` / `References` on the draft body 400s and would abort the whole
 * send. Captain 2026-08-05: prefer completing send over perfect WO-thread —
 * so ordinary Mail.Send stamps ONLY `x-secureworks-ses-operation`. Missing
 * Message-ID must never block; a present Message-ID must also never block.
 * This helper remains for pure normalize/tests and any future supported path.
 */
export function sesOptionalThreadingHeaders(
  inReplyToInternetMessageId: unknown,
): Array<{ name: string; value: string }> {
  const mid = String(inReplyToInternetMessageId || "").trim();
  if (!mid) return [];
  const value = mid.startsWith("<") ? mid : `<${mid}>`;
  return [
    { name: "In-Reply-To", value },
    { name: "References", value },
  ];
}

/**
 * Headers that Graph draft create will accept. Operation token only —
 * never In-Reply-To / References (non-x- names reject the create).
 */
export function sesDraftCreateInternetMessageHeaders(
  externalToken: string,
): Array<{ name: string; value: string }> {
  return sesOperationInternetMessageHeaders(externalToken);
}

function draftMessagePayload(
  route: Record<string, any>,
  subject: string,
  html: string,
  externalToken: string,
): Record<string, unknown> {
  // Intentionally ignore route.in_reply_to_internet_message_id here.
  // Threading headers are not attachable on app-only draft create without a
  // 400 risk; send must complete with only the SES operation proof header.
  void route.in_reply_to_internet_message_id;
  void route.threading_internet_message_id;
  const headers = sesDraftCreateInternetMessageHeaders(externalToken);
  return {
    subject,
    body: { contentType: "HTML", content: html },
    toRecipients: (route.recipients || []).map((address: string) => ({
      emailAddress: { address },
    })),
    ccRecipients: (route.cc || []).map((address: string) => ({
      emailAddress: { address },
    })),
    ...(headers.length ? { internetMessageHeaders: headers } : {}),
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked to avoid call-stack limits on large photo sets.
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: unknown): Uint8Array {
  const binary = atob(String(value || "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function attachmentFingerprint(
  attachment: SesRouteAttachment,
): Promise<string> {
  const exactBytes = new Uint8Array(attachment.bytes.byteLength);
  exactBytes.set(attachment.bytes);
  const digest = await crypto.subtle.digest("SHA-256", exactBytes.buffer);
  const hash = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return JSON.stringify([
    String(attachment.name || ""),
    String(attachment.contentType || "application/octet-stream")
      .trim()
      .toLowerCase(),
    attachment.bytes.byteLength,
    hash,
  ]);
}

async function resolveSesIntakeGroupId(
  graphJson: SesGraphJson,
): Promise<string> {
  const filter = encodeURIComponent(`mail eq '${SES_INTAKE_GROUP_MAIL}'`);
  const response = await graphJson(
    `https://graph.microsoft.com/v1.0/groups?$filter=${filter}&$select=id,mail`,
    { method: "GET" },
    [200],
  );
  const groups = Array.isArray(response?.value) ? response.value : [];
  if (groups.length === 0) {
    throw new Error(
      `No M365 group found for intake mail ${SES_INTAKE_GROUP_MAIL}`,
    );
  }
  if (groups.length > 1) {
    throw new Error(
      `Ambiguous group resolution: ${groups.length} groups match ${SES_INTAKE_GROUP_MAIL}`,
    );
  }
  const id = String(groups[0]?.id || "").trim();
  if (!id) {
    throw new Error(
      `Group resolution for ${SES_INTAKE_GROUP_MAIL} returned no id`,
    );
  }
  return id;
}

/**
 * Build the sealed release Graph mail gateway.
 * Creates a draft on admin@, checkpoints the draft id, attaches bytes, sends,
 * then proves the message in Sent Items by the SES operation header.
 *
 * Group-thread reply (locked MLB report/photo intent): only when
 * `requires_thread_reply === true` AND a thread id is present. Microsoft does
 * not support conversationThread:reply under application permissions, so the
 * temporary Captain exception (ordinary Mail.Send for MLB report/photo) must
 * leave `requires_thread_reply` false and must not set reply_to_thread_id.
 * A bare thread id without requires_thread_reply must never force the group path.
 */
export function createSesGraphMailGateway(
  deps: SesGraphMailGatewayDeps,
): SesMailGateway {
  const mailbox = deps.mailbox || SES_RELEASE_MAILBOX;
  const pollAttempts = deps.sentPollAttempts ?? 20;
  const pollDelayMs = deps.sentPollDelayMs ?? 500;
  const sleep = deps.sleep ||
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const resolveGroupId = deps.resolveIntakeGroupId ||
    ((graphJson: SesGraphJson) => resolveSesIntakeGroupId(graphJson));

  const reconcileSentOnly = async (
    externalToken: string,
  ): Promise<SesRouteSendResult[]> => {
    const sent = await listFolderMessagesForReconcile(
      deps.graphJson,
      mailbox,
      "sentitems",
      externalToken,
    );
    return toSesRouteSendResults(sent, externalToken);
  };

  const waitForSent = async (
    externalToken: string,
  ): Promise<SesRouteSendResult[]> => {
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      const sent = await reconcileSentOnly(externalToken);
      if (sent.length) return sent;
      if (attempt + 1 < pollAttempts) await sleep(pollDelayMs);
    }
    return [];
  };

  const findDrafts = async (
    externalToken: string,
  ): Promise<Array<Record<string, unknown>>> => {
    const drafts = await listFolderMessagesForReconcile(
      deps.graphJson,
      mailbox,
      "drafts",
      externalToken,
    );
    return filterMessagesByOperationToken(drafts, externalToken);
  };

  const readDraftAttachments = async (
    draftId: string,
  ): Promise<SesRouteAttachment[]> => {
    const base = `https://graph.microsoft.com/v1.0/users/${
      encodeURIComponent(mailbox)
    }/messages/${encodeURIComponent(draftId)}`;
    const listed: Array<Record<string, unknown>> = [];
    let nextUrl =
      `${base}/attachments?$select=id,name,contentType,size,isInline`;
    const seenPages = new Set<string>();
    for (let page = 0; nextUrl; page++) {
      if (page >= 20 || seenPages.has(nextUrl)) {
        throw new Error(
          "Recovered Graph draft attachment pagination did not terminate; refusing send.",
        );
      }
      seenPages.add(nextUrl);
      const response = await deps.graphJson(
        nextUrl,
        { method: "GET" },
        [200],
      );
      listed.push(
        ...(Array.isArray(response?.value) ? response.value : []),
      );
      nextUrl = String(response?.["@odata.nextLink"] || "").trim();
    }

    const attachments: SesRouteAttachment[] = [];
    for (const row of listed) {
      const id = String(row.id || "").trim();
      if (!id || row.isInline === true) {
        throw new Error(
          "Recovered Graph draft carries an unidentifiable or inline attachment; refusing send.",
        );
      }
      const detail = await deps.graphJson(
        `${base}/attachments/${
          encodeURIComponent(id)
        }?$select=id,name,contentType,size,isInline,contentBytes`,
        { method: "GET" },
        [200],
      );
      if (detail?.isInline === true || !String(detail?.contentBytes || "")) {
        throw new Error(
          `Recovered Graph draft attachment ${id} has no exact file bytes; refusing send.`,
        );
      }
      const bytes = base64ToBytes(detail.contentBytes);
      const declaredSize = Number(detail.size ?? row.size);
      if (Number.isFinite(declaredSize) && declaredSize !== bytes.byteLength) {
        throw new Error(
          `Recovered Graph draft attachment ${id} size differs from its exact bytes; refusing send.`,
        );
      }
      attachments.push({
        name: String(detail.name || row.name || ""),
        contentType: String(
          detail.contentType || row.contentType || "application/octet-stream",
        ),
        bytes,
      });
    }
    return attachments;
  };

  const compareDraftAttachmentManifest = async (
    expected: SesRouteAttachment[],
    actual: SesRouteAttachment[],
  ): Promise<{ missing: SesRouteAttachment[]; unexpected: string[] }> => {
    const remaining = await Promise.all(expected.map(async (attachment) => ({
      attachment,
      fingerprint: await attachmentFingerprint(attachment),
    })));
    const unexpected: string[] = [];
    for (const attachment of actual) {
      const fingerprint = await attachmentFingerprint(attachment);
      const index = remaining.findIndex((item) =>
        item.fingerprint === fingerprint
      );
      if (index < 0) {
        unexpected.push(String(attachment.name || "unnamed attachment"));
      } else {
        remaining.splice(index, 1);
      }
    }
    return {
      missing: remaining.map((item) => item.attachment),
      unexpected,
    };
  };

  const completeRecoveredDraftAttachments = async (
    draftId: string,
    route: Record<string, any>,
  ): Promise<void> => {
    const hashes = [
      ...new Set<string>(
        (Array.isArray(route.attachment_hashes) ? route.attachment_hashes : [])
          .map((hash: unknown) => String(hash || "").trim())
          .filter(Boolean),
      ),
    ];
    const expected = await deps.loadAttachments(hashes);
    if (expected.length !== hashes.length) {
      throw new Error(
        "The frozen route attachment manifest could not be loaded exactly; refusing recovered draft send.",
      );
    }
    const current = await readDraftAttachments(draftId);
    const before = await compareDraftAttachmentManifest(expected, current);
    if (before.unexpected.length > 0) {
      throw new Error(
        `Recovered Graph draft attachment manifest differs from the frozen route (${
          before.unexpected.join(", ")
        }); refusing send.`,
      );
    }
    for (const attachment of before.missing) {
      await deps.uploadAttachment(mailbox, draftId, attachment);
    }
    if (before.missing.length === 0) return;

    const completed = await readDraftAttachments(draftId);
    const after = await compareDraftAttachmentManifest(expected, completed);
    if (after.missing.length > 0 || after.unexpected.length > 0) {
      throw new Error(
        "Recovered Graph draft attachment manifest is still incomplete after deterministic upload; refusing send.",
      );
    }
  };

  const reconcileGroupThread = async (
    externalToken: string,
    threadId: string,
  ): Promise<SesRouteSendResult[]> => {
    const groupId = await resolveGroupId(deps.graphJson);
    const listed = await deps.graphJson(
      `https://graph.microsoft.com/v1.0/groups/${
        encodeURIComponent(groupId)
      }/threads/${
        encodeURIComponent(threadId)
      }/posts?$select=id,createdDateTime&$expand=extensions&$orderby=createdDateTime desc&$top=50`,
      { method: "GET" },
      [200],
    );
    const matches = (Array.isArray(listed?.value) ? listed.value : []).filter(
      (post: any) =>
        (Array.isArray(post?.extensions) ? post.extensions : []).some(
          (extension: any) =>
            String(extension?.id || "") === SES_OPERATION_EXTENSION_ID &&
            String(extension?.externalToken || "") === externalToken,
        ),
    );
    return matches.map((post: any) => ({
      message_id: String(post.id || ""),
      state: "sent" as const,
      operation_token: externalToken,
    })).filter((result: SesRouteSendResult) => !!result.message_id);
  };

  /**
   * Reply on the ses@ group work-order intake thread.
   * Proof: the reply atomically carries an open extension with the exact SES
   * operation token, then reconciliation reads that non-visible coordinate.
   * Builder-facing subject/body never carry the token.
   */
  const sendGroupThreadReply = async (
    context: { external_token: string; operation_key: string },
    threadId: string,
    attachments: SesRouteAttachment[],
    html: string,
  ): Promise<SesRouteSendResult> => {
    const groupId = await resolveGroupId(deps.graphJson);
    const postAttachments = attachments.map((attachment) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: attachment.name,
      contentType: attachment.contentType,
      contentBytes: bytesToBase64(attachment.bytes),
    }));
    // Checkpoint a stable operation key before the fire-and-forget reply so a
    // crash mid-send can still be reconciled by human review of the thread.
    await deps.checkpointDraft(
      context.operation_key,
      `group-thread:${groupId}:${threadId}`,
    );
    await deps.graphJson(
      `https://graph.microsoft.com/v1.0/groups/${
        encodeURIComponent(groupId)
      }/threads/${encodeURIComponent(threadId)}/reply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          post: {
            body: { contentType: "HTML", content: html },
            ...(postAttachments.length ? { attachments: postAttachments } : {}),
            extensions: [{
              "@odata.type": "microsoft.graph.openTypeExtension",
              extensionName: SES_OPERATION_EXTENSION_NAME,
              externalToken: context.external_token,
              operationKey: context.operation_key,
            }],
          },
        }),
      },
      [202],
    );
    // Prove the post landed by the exact non-visible operation token. This is
    // the same reconciliation path a later worker uses after a crash.
    let matchedPostId = "";
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      const matches = await reconcileGroupThread(
        context.external_token,
        threadId,
      );
      if (matches.length > 1) {
        throw new Error(
          `Graph reconciliation found ${matches.length} group posts for exact SES token ${context.external_token}; refusing automatic redispatch`,
        );
      }
      if (matches[0]?.message_id) {
        matchedPostId = matches[0].message_id;
        break;
      }
      if (attempt + 1 < pollAttempts) await sleep(pollDelayMs);
    }
    if (!matchedPostId) {
      throw new Error(
        `Group thread reply accepted but the post is not yet proven on thread ${threadId} for token ${context.external_token}`,
      );
    }
    return {
      message_id: matchedPostId,
      state: "sent",
      operation_token: context.external_token,
    };
  };

  return {
    async createDraftAndSend(route, context) {
      assertSesSampleSendAllowed(route);
      const attachments = await deps.loadAttachments(
        Array.isArray(route.attachment_hashes) ? route.attachment_hashes : [],
      );
      const subject = sesOperationSubject(
        String(route.subject || ""),
        context.external_token,
      );
      const html = sesReleaseHtmlBody(String(route.body || ""));
      // Body must never carry the operation token either.
      if (
        context.external_token &&
        (html.includes(context.external_token) ||
          subject.includes(context.external_token))
      ) {
        throw new Error(
          "SES operation token must not appear in builder-facing subject or body",
        );
      }
      const threadId = String(
        route.reply_to_thread_id || route.intake_thread_id || "",
      ).trim();
      const requiresThread = route.requires_thread_reply === true;
      if (requiresThread && !threadId) {
        throw new Error(
          "Route requires an intake-thread reply but reply_to_thread_id is missing; refusing to open a new thread",
        );
      }
      // Only the locked group-thread shape enters the group post path. Ordinary
      // Mail.Send (including the MLB Captain exception) must not set
      // requires_thread_reply, and keeps the user-mailbox ceilings.
      const usesGroupThreadReply = requiresThread && Boolean(threadId);
      // Loud volume guard BEFORE the first Graph call. Never cull photos.
      const transport = resolveSesMailTransport({
        reply_to_thread_id: usesGroupThreadReply ? threadId : "",
        requires_thread_reply: usesGroupThreadReply,
      });
      assertSesPhotoMailVolumeFits(attachments, transport);
      if (usesGroupThreadReply) {
        // MLB physical report/photo: reply on the ses@ group intake thread.
        return await sendGroupThreadReply(
          context,
          threadId,
          attachments,
          html,
        );
      }

      // Ordinary draft→send path (AJS packs, MLB invoice, MLB report/photo under
      // the temporary ordinary-mail Captain exception). Stamps
      // x-secureworks-ses-operation and proves via admin@ Sent Items.
      // In-Reply-To / References are NOT set on draft create (Graph rejects
      // non-x- custom headers → would 400 and block send). Missing Message-ID
      // never blocks; a present one also never blocks. Captain: complete send.
      // Do NOT createReply with a group post id; only a known user-mailbox
      // Graph message id may use createReply (explicit flag).
      const replyToId = String(
        route.reply_to_user_mailbox_message_id || "",
      ).trim();
      const messageBody = draftMessagePayload(
        route,
        subject,
        html,
        context.external_token,
      );

      let message: any;
      if (replyToId) {
        message = await deps.graphJson(
          `https://graph.microsoft.com/v1.0/users/${
            encodeURIComponent(mailbox)
          }/messages/${encodeURIComponent(replyToId)}/createReply`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: messageBody }),
          },
          [201],
        );
      } else {
        message = await deps.graphJson(
          `https://graph.microsoft.com/v1.0/users/${
            encodeURIComponent(mailbox)
          }/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(messageBody),
          },
          [201],
        );
      }
      if (!message?.id) {
        throw new Error("Microsoft Graph did not return the created draft id");
      }
      await deps.checkpointDraft(context.operation_key, String(message.id));
      for (const attachment of attachments) {
        await deps.uploadAttachment(mailbox, String(message.id), attachment);
      }
      await deps.graphJson(
        `https://graph.microsoft.com/v1.0/users/${
          encodeURIComponent(mailbox)
        }/messages/${encodeURIComponent(String(message.id))}/send`,
        { method: "POST" },
        [202],
      );
      const [sent] = await waitForSent(context.external_token);
      if (!sent) {
        throw new Error(
          `Graph accepted send-by-id but the message is not yet proven in Sent Items for token ${context.external_token}`,
        );
      }
      return sent;
    },

    async reconcileSent(externalToken, route) {
      const threadId = String(route?.reply_to_thread_id || "").trim();
      if (route?.requires_thread_reply === true) {
        if (!threadId) {
          throw new Error(
            "requires_thread_reply is true but no intake thread id is bound; refusing to reconcile or open a new thread",
          );
        }
        const posts = await reconcileGroupThread(externalToken, threadId);
        if (posts.length > 1) {
          throw new Error(
            `Graph reconciliation found ${posts.length} group posts for exact SES token ${externalToken}; refusing automatic redispatch`,
          );
        }
        return posts;
      }
      const existingSent = await reconcileSentOnly(externalToken);
      if (existingSent.length) return existingSent;
      const drafts = await findDrafts(externalToken);
      if (drafts.length > 1) {
        throw new Error(
          `Graph reconciliation found ${drafts.length} drafts for exact SES token ${externalToken}; refusing automatic redispatch`,
        );
      }
      if (drafts.length === 0) return [];
      const draftId = String(drafts[0].id || "");
      if (!draftId) return [];
      await completeRecoveredDraftAttachments(draftId, route || {});
      await deps.graphJson(
        `https://graph.microsoft.com/v1.0/users/${
          encodeURIComponent(mailbox)
        }/messages/${encodeURIComponent(draftId)}/send`,
        { method: "POST" },
        [202],
      );
      const sent = await waitForSent(externalToken);
      if (sent.length === 0) {
        throw new SesExternalOutcomeUnknownError(
          `Graph accepted recovered draft ${draftId} for token ${externalToken}, but Sent Items proof is not visible yet.`,
        );
      }
      return sent;
    },
  };
}
