// deno-lint-ignore-file no-explicit-any
import {
  automatedMail,
  type Mail,
  MAIL_BUCKET,
  mailIdentity,
  previewText,
  storeBytes,
  type StoredFile,
  type Stream,
} from "./mail_capture.ts";
const ORG = "00000000-0000-0000-0000-000000000001";
type GraphGet = (url: string) => Promise<Record<string, any>>;
async function attachmentFiles(
  get: GraphGet,
  message: Mail,
  stream: Stream,
  resourceUrl: string,
): Promise<Record<string, any>[]> {
  if (!message.hasAttachments) return [];
  let page: Record<string, any>,
    next: string | undefined,
    items: Record<string, any>[] = [];
  if (stream.kind === "group") {
    // Existing SES app-only reader's supported post expansion path; list-attachments has no app permission.
    page = await get(`${resourceUrl}?$expand=attachments`);
    if (!Array.isArray(page.attachments)) {
      throw new Error("group_attachments_unavailable");
    }
    items = page.attachments;
    next = page["attachments@odata.nextLink"];
  } else {
    page = await get(`${resourceUrl}/attachments`);
    if (!Array.isArray(page.value)) {
      throw new Error("attachments_missing_collection");
    }
    items = page.value;
    next = page["@odata.nextLink"];
  }
  const visited = new Set<string>();
  while (next) {
    if (visited.has(next)) throw new Error("attachment_continuation_cycle");
    visited.add(next);
    page = await get(next);
    if (!Array.isArray(page.value)) {
      throw new Error("attachments_missing_collection");
    }
    items.push(...page.value);
    next = page["@odata.nextLink"];
  }
  return items;
}
/** Any storage/evidence/observation error propagates: the provider page is replayed. */
export async function persistMail(
  sb: any,
  get: GraphGet,
  input: Mail,
  stream: Stream,
  resourceUrl: string,
): Promise<void> {
  let message = input;
  if (
    !message.body ||
    !(message.receivedDateTime || message.sentDateTime ||
      message.createdDateTime)
  ) {
    message = {
      ...message,
      ...await get(
        stream.kind === "user"
          ? `${resourceUrl}?$select=id,internetMessageId,conversationId,from,sender,toRecipients,subject,body,receivedDateTime,sentDateTime,hasAttachments,isRead,bodyPreview,internetMessageHeaders`
          : resourceUrl,
      ),
    };
  }
  const providerAt = stream.folder === "sentitems"
    ? message.sentDateTime || message.receivedDateTime
    : message.receivedDateTime || message.createdDateTime;
  if (!providerAt || Number.isNaN(Date.parse(providerAt))) {
    throw new Error("provider_message_time_missing");
  }
  if (!message.body || typeof message.body.content !== "string") {
    throw new Error("provider_message_body_missing");
  }
  const full = message.body.content,
    preview = previewText(
      full,
      message.body.contentType?.toLowerCase() === "html",
    );
  const from = message.from?.emailAddress?.address ||
    message.sender?.emailAddress?.address || "";
  const outbound = stream.folder === "sentitems" ||
    (stream.kind === "group" &&
      from.toLowerCase().endsWith("@secureworkswa.com.au"));
  const direction = outbound ? "outbound" : "inbound",
    identity = mailIdentity(message, stream);
  const storage = {
    upload: async (path: string, bytes: Uint8Array, contentType: string) => {
      const { error } = await sb.storage.from(MAIL_BUCKET).upload(path, bytes, {
        contentType,
        upsert: false,
      });
      // Hash paths are immutable: an existing identical object is success, never overwrite.
      if (
        error && String(error.statusCode) !== "409" &&
        error.error !== "Duplicate"
      ) throw new Error("mail_private_storage_failed");
    },
  };
  const { data: bucket, error: bucketError } = await sb.storage.getBucket(
    MAIL_BUCKET,
  );
  if (bucketError || !bucket || bucket.public !== false) {
    throw new Error("mail_private_bucket_unavailable");
  }
  const body = await storeBytes(
    storage,
    new TextEncoder().encode(full),
    "body",
    message.body.contentType?.toLowerCase() === "html"
      ? "text/html"
      : "text/plain",
  );
  const attachments: StoredFile[] = [];
  for (const file of await attachmentFiles(get, message, stream, resourceUrl)) {
    let bytes: Uint8Array,
      contentType = file.contentType || "application/octet-stream";
    if (typeof file.contentBytes === "string") {
      bytes = Uint8Array.from(atob(file.contentBytes), (c) => c.charCodeAt(0));
    } else if (file["@odata.type"] === "#microsoft.graph.itemAttachment") {
      const expanded = await get(
        `${resourceUrl}/attachments/${
          encodeURIComponent(file.id)
        }?$expand=microsoft.graph.itemAttachment/item`,
      );
      if (!expanded.item) throw new Error("item_attachment_content_missing");
      bytes = new TextEncoder().encode(JSON.stringify(expanded));
      contentType = "application/json";
    } else if (file["@odata.type"] === "#microsoft.graph.referenceAttachment") {
      // A cloud attachment is a reference, not downloadable file bytes. Preserve its complete provider envelope.
      bytes = new TextEncoder().encode(JSON.stringify(file));
      contentType = "application/json";
    } else throw new Error("attachment_content_missing");
    attachments.push(
      await storeBytes(storage, bytes, file.name || "attachment", contentType),
    );
  }
  const automated = automatedMail(message);
  const recipients = (message.toRecipients || []).map((r) =>
    r.emailAddress?.address
  ).filter(Boolean);
  // Let B2 resolve direct references/thread/contact. Never infer a job from a subject's first name.
  const row = {
    event_type: outbound ? "client.email_out" : "client.email_in",
    source: "monitor_inbox",
    entity_type: "email",
    entity_id: message.id,
    job_id: null,
    contact_id: null,
    channel: "email",
    direction,
    occurred_at: new Date().toISOString(),
    event_at: new Date(providerAt).toISOString(),
    provider_message_id: identity,
    thread_key: message.conversationId
      ? `graph:${message.conversationId}`
      : null,
    source_table: "graph_mail",
    source_id: `${stream.kind}:${stream.mailbox}:${message.id}`,
    body_preview: preview,
    body_pointer: body.pointer,
    body_hash: body.hash,
    privacy_classification: "restricted_pii",
    retention_class: "7y_audit",
    payload: {
      body: `${message.subject || ""}\n${preview}`,
      subject: message.subject || "",
      email: outbound ? (recipients.length === 1 ? recipients[0] : null) : from,
      from,
      to: recipients,
      mailbox: stream.mailbox,
      line: stream.mailbox.startsWith("patios@")
        ? "patio"
        : stream.mailbox.startsWith("fencing@")
        ? "fencing"
        : null,
      automated,
      attachments,
      provider_identity_kind: message.internetMessageId
        ? "internet_message_id"
        : "graph_item_fallback",
    },
    metadata: { capture_version: "mail_v2", provider_resource: resourceUrl },
  };
  let { data: event, error } = await sb.from("business_events").insert(row)
    .select("id,job_id,contact_id").single();
  if (error?.code === "23505") {
    const existing = await sb.from("business_events").select(
      "id,job_id,contact_id",
    ).eq("provider_message_id", identity).single();
    event = existing.data;
    error = existing.error;
  }
  if (error || !event?.id) throw new Error("mail_evidence_write_failed");
  const { error: observationError } = await sb.from("context_mail_observations")
    .upsert({
      event_id: event.id,
      stream_key: stream.key,
      provider_item_id: message.id,
      direction,
    }, { onConflict: "stream_key,provider_item_id", ignoreDuplicates: true });
  if (observationError) throw new Error("mail_observation_write_failed");
  // Preserve the existing ops inbox surface. SES operational intake stays on its separate reader.
  if (!outbound) {
    const { error: inboxError } = await sb.from("inbox_events").upsert({
      org_id: ORG,
      graph_message_id: `${stream.kind}:${stream.mailbox}:${message.id}`,
      mailbox: stream.mailbox,
      from_email: from,
      from_name: message.from?.emailAddress?.name || "",
      to_email: recipients.join(", "),
      subject: message.subject || "(no subject)",
      body_preview: preview,
      received_at: new Date(providerAt).toISOString(),
      classification: automated ? "newsletter" : "client_reply",
      priority: automated ? "low" : "normal",
      action_needed: null,
      job_id: event.job_id,
      ghl_contact_id: event.contact_id,
      metadata: {
        business_event_id: event.id,
        body_pointer: body.pointer,
        body_hash: body.hash,
        attachments,
        capture_version: "mail_v2",
        compatibility: { status: "pending" },
        legacy_classifier_eligible: stream.kind === "user" &&
          message.isRead === false &&
          Date.parse(providerAt) >= Date.now() - 15 * 60_000 &&
          ["marnin", "jan", "nithin", "shaun", "admin", "patios", "fencing"]
            .some(
              (name) => stream.mailbox === `${name}@secureworkswa.com.au`,
            ),
        legacy_body_preview: (message.bodyPreview || "").slice(0, 500),
        legacy_graph_message_id: message.id,
      },
    }, { onConflict: "graph_message_id", ignoreDuplicates: true });
    if (inboxError) throw new Error("mail_inbox_bridge_failed");
  }
}
