// Sealed SES release Graph mail gateway helpers.
// Exact-once route_send proof lives here: create draft → checkpoint → send →
// prove in Sent Items by the SES operation token in the subject.
//
// Do not route sealed SES releases through send-outlook-email; that function
// refuses sealed jobs by design. This path is the controlled release transport.

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
  reconcileSent(externalToken: string): Promise<SesRouteSendResult[]>;
}

export const SES_RELEASE_MAILBOX = "admin@secureworkswa.com.au";
export const SES_RELEASE_CC = "ses@secureworkswa.com.au";
export const AJS_WORK_ORDERS_MAILBOX = "workorders@ajs.build";

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

export function sesOperationSubject(
  subject: string,
  externalToken: string,
): string {
  const base = String(subject || "").trim();
  const token = String(externalToken || "").trim();
  if (!token) return base;
  if (base.includes(token)) return base;
  return `${base} [${token}]`;
}

export function subjectHasOperationToken(
  subject: unknown,
  externalToken: string,
): boolean {
  const token = String(externalToken || "").trim();
  if (!token) return false;
  return String(subject || "").includes(token);
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
    .map((block) => `<p style="margin:0 0 12px;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#293C46">${block}</p>`)
    .join("");
  return `${paragraphs || "<p></p>"}${SES_ADMIN_HTML_SIGNATURE}`;
}

/**
 * Client-side match of Graph messages by the SES operation token.
 * Avoids OData `contains(subject,…)` which is unreliable under application
 * permissions and was the load-bearing dead end for post-send proof.
 */
export function filterMessagesByOperationToken(
  messages: Array<Record<string, unknown>>,
  externalToken: string,
): Array<Record<string, unknown>> {
  return (messages || []).filter((message) =>
    subjectHasOperationToken(message?.subject, externalToken)
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
}

async function listFolderMessages(
  graphJson: SesGraphJson,
  mailbox: string,
  folder: "drafts" | "sentitems",
  top = 40,
): Promise<Array<Record<string, unknown>>> {
  // No OData contains filter — list newest and match the operation token
  // client-side. That is the proof path that does not dead-end on Graph query
  // support differences across tenants.
  const params = new URLSearchParams({
    "$select": "id,internetMessageId,subject,isDraft,sentDateTime,createdDateTime",
    "$orderby": folder === "sentitems"
      ? "sentDateTime desc"
      : "createdDateTime desc",
    "$top": String(top),
  });
  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/${folder}/messages?${params}`;
  const response = await graphJson(url, { method: "GET" }, [200]);
  return Array.isArray(response?.value) ? response.value : [];
}

/**
 * Build the sealed release Graph mail gateway.
 * Creates a draft on admin@, checkpoints the draft id, attaches bytes, sends,
 * then proves the message in Sent Items by the SES operation token.
 */
export function createSesGraphMailGateway(
  deps: SesGraphMailGatewayDeps,
): SesMailGateway {
  const mailbox = deps.mailbox || SES_RELEASE_MAILBOX;
  const pollAttempts = deps.sentPollAttempts ?? 20;
  const pollDelayMs = deps.sentPollDelayMs ?? 500;
  const sleep = deps.sleep ||
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const reconcileSentOnly = async (
    externalToken: string,
  ): Promise<SesRouteSendResult[]> => {
    const sent = await listFolderMessages(
      deps.graphJson,
      mailbox,
      "sentitems",
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
    const drafts = await listFolderMessages(
      deps.graphJson,
      mailbox,
      "drafts",
    );
    return filterMessagesByOperationToken(drafts, externalToken);
  };

  return {
    async createDraftAndSend(route, context) {
      const attachments = await deps.loadAttachments(
        Array.isArray(route.attachment_hashes) ? route.attachment_hashes : [],
      );
      const subject = sesOperationSubject(
        String(route.subject || ""),
        context.external_token,
      );
      const html = sesReleaseHtmlBody(String(route.body || ""));
      const replyToId = String(
        route.reply_to_graph_message_id ||
          route.in_reply_to_graph_message_id ||
          "",
      ).trim();

      let message: any;
      if (replyToId) {
        // Reply on the builder work-order thread when the intake graph id is known.
        message = await deps.graphJson(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(replyToId)}/createReply`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: {
                subject,
                body: { contentType: "HTML", content: html },
                toRecipients: (route.recipients || []).map(
                  (address: string) => ({ emailAddress: { address } }),
                ),
                ccRecipients: (route.cc || []).map((address: string) => ({
                  emailAddress: { address },
                })),
              },
            }),
          },
          [201],
        );
      } else {
        message = await deps.graphJson(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              subject,
              body: { contentType: "HTML", content: html },
              toRecipients: (route.recipients || []).map((address: string) => ({
                emailAddress: { address },
              })),
              ccRecipients: (route.cc || []).map((address: string) => ({
                emailAddress: { address },
              })),
            }),
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
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(String(message.id))}/send`,
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

    async reconcileSent(externalToken) {
      const existingSent = await reconcileSentOnly(externalToken);
      if (existingSent.length) return existingSent;
      const drafts = await findDrafts(externalToken);
      if (drafts.length !== 1) return [];
      const draftId = String(drafts[0].id || "");
      if (!draftId) return [];
      await deps.graphJson(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(draftId)}/send`,
        { method: "POST" },
        [202],
      );
      return await waitForSent(externalToken);
    },
  };
}
