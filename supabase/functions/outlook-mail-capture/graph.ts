// Microsoft Graph reads for the email reader (slice EM2). Read only: every
// call here is a GET (plus the token POST). Nothing here sends, replies,
// moves, deletes or marks mail read; graph_test.ts pins that every request is
// a GET to graph.microsoft.com.
//
// Every read asks for immutable ids and plain-text bodies. Errors are thrown
// as GraphReadError with a code (graph_<http status>, graph_unreachable,
// graph_bad_json); never the response text, which can carry mail content.
//
// Group post attachments (6 Oct 2026): Microsoft refuses a post's own
// attachments address (/posts/{id}/attachments, and its /$value) to an
// app-only login, so no group mailbox file was ever saved. A post's
// attachments are read with the post itself, $expand=attachments, the route
// monitor-ses-makesafes reads ses@ through; each file's bytes come back in
// that one read (contentBytes). A file Microsoft sends without its bytes
// cannot be fetched any other way with this login (attachment_no_content).

import type {
  OutlookAttachmentMeta,
  OutlookMailItem,
} from "../_shared/evidence/outlook_mail.ts";

export const GRAPH = "https://graph.microsoft.com/v1.0";
const PREFER = 'outlook.body-content-type="text", IdType="ImmutableId"';
/** MAPI PR_INTERNET_MESSAGE_ID, so a group post and a member's copy share one key. */
const INTERNET_ID_PROP = "String 0x1035";

export class GraphReadError extends Error {
  constructor(readonly code: string, readonly status: number | null) {
    super(code);
  }
}

export interface GraphDeps {
  fetch: typeof fetch;
  token(): Promise<string>;
}

export interface FolderIds {
  junk: string | null;
  drafts: string | null;
  outbox: string | null;
  sent: string | null;
  deleted: string | null;
}

export interface MessagePage {
  items: Array<
    OutlookMailItem & {
      parentFolderId?: string | null;
      isDraft?: boolean;
      /** False when uniqueBody and headers still need messageDetail. */
      detailRead?: boolean;
    }
  >;
  next: string | null;
}

/** The body, refused with tooLargeCode once it passes maxBytes (declared or read). */
async function readCapped(
  resp: Response,
  maxBytes: number,
  tooLargeCode: string,
): Promise<Uint8Array> {
  const declared = Number(resp.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await resp.body?.cancel().catch(() => {});
    throw new GraphReadError(tooLargeCode, resp.status);
  }
  if (!resp.body) return new Uint8Array(0);
  const reader = resp.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      throw new GraphReadError("graph_unreachable", resp.status);
    }
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new GraphReadError(tooLargeCode, resp.status);
    }
    parts.push(chunk.value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

async function getJson(
  deps: GraphDeps,
  url: string,
  cap?: { maxBytes: number; code: string },
): Promise<Record<string, unknown>> {
  if (!url.startsWith(GRAPH + "/")) {
    throw new GraphReadError("graph_bad_url", null);
  }
  let resp: Response;
  try {
    resp = await deps.fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${await deps.token()}`,
        Prefer: PREFER,
      },
    });
  } catch {
    throw new GraphReadError("graph_unreachable", null);
  }
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {});
    throw new GraphReadError(`graph_${resp.status}`, resp.status);
  }
  if (cap) {
    const raw = await readCapped(resp, cap.maxBytes, cap.code);
    try {
      return JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new GraphReadError("graph_bad_json", resp.status);
    }
  }
  try {
    return await resp.json();
  } catch {
    throw new GraphReadError("graph_bad_json", resp.status);
  }
}

async function getBytes(
  deps: GraphDeps,
  url: string,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!url.startsWith(GRAPH + "/")) {
    throw new GraphReadError("graph_bad_url", null);
  }
  let resp: Response;
  try {
    resp = await deps.fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${await deps.token()}` },
    });
  } catch {
    throw new GraphReadError("graph_unreachable", null);
  }
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {});
    throw new GraphReadError(`graph_${resp.status}`, resp.status);
  }
  const declared = Number(resp.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await resp.body?.cancel().catch(() => {});
    throw new GraphReadError("attachment_too_large", resp.status);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new GraphReadError("attachment_too_large", resp.status);
  }
  return bytes;
}

function addr(v: unknown): string | null {
  const a = (v as { emailAddress?: { address?: unknown } } | null)?.emailAddress
    ?.address;
  return typeof a === "string" ? a : null;
}

function addrList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(addr).filter((a): a is string => !!a) : [];
}

function headerMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(v)) return out;
  for (const h of v as Array<{ name?: unknown; value?: unknown }>) {
    if (typeof h?.name === "string" && typeof h?.value === "string") {
      out[h.name.toLowerCase()] = h.value;
    }
  }
  return out;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

const enc = encodeURIComponent;

export async function folderIds(
  deps: GraphDeps,
  mailbox: string,
): Promise<FolderIds> {
  const one = async (wellKnown: string): Promise<string | null> => {
    try {
      const f = await getJson(
        deps,
        `${GRAPH}/users/${enc(mailbox)}/mailFolders/${wellKnown}?$select=id`,
      );
      return str(f.id);
    } catch (e) {
      // A mailbox without that folder (404) reads as none; any other failure stops the source.
      if (e instanceof GraphReadError && e.status === 404) return null;
      throw e;
    }
  };
  return {
    junk: await one("junkemail"),
    drafts: await one("drafts"),
    outbox: await one("outbox"),
    sent: await one("sentitems"),
    deleted: await one("deleteditems"),
  };
}

const MESSAGE_SELECT = [
  "id",
  "internetMessageId",
  "conversationId",
  "parentFolderId",
  "subject",
  "from",
  "sender",
  "toRecipients",
  "ccRecipients",
  "receivedDateTime",
  "sentDateTime",
  "hasAttachments",
  "isDraft",
];
/** Read with every message (full) or, when Graph refuses those on a list call, one GET per message. */
const DETAIL_FIELDS = ["uniqueBody", "internetMessageHeaders"];

/** One page of a mailbox's messages (every folder), oldest first, in [fromIso, toIso). */
export async function listMessages(
  deps: GraphDeps,
  mailbox: string,
  args: {
    fromIso: string;
    toIso?: string | null;
    top: number;
    next?: string | null;
    /** Leave uniqueBody and headers to messageDetail. */
    lean?: boolean;
  },
): Promise<MessagePage> {
  const select =
    (args.lean ? MESSAGE_SELECT : [...MESSAGE_SELECT, ...DETAIL_FIELDS]).join(
      ",",
    );
  const url = args.next ??
    `${GRAPH}/users/${enc(mailbox)}/messages?$filter=${
      enc(
        `receivedDateTime ge ${args.fromIso}` +
          (args.toIso ? ` and receivedDateTime lt ${args.toIso}` : ""),
      )
    }&$orderby=${
      enc("receivedDateTime asc")
    }&$top=${args.top}&$select=${select}`;
  const page = await getJson(deps, url);
  const values = Array.isArray(page.value) ? page.value : [];
  return {
    items: values.map((m: Record<string, unknown>) => ({
      graphId: String(m.id ?? ""),
      internetMessageId: str(m.internetMessageId),
      conversationId: str(m.conversationId),
      parentFolderId: str(m.parentFolderId),
      isDraft: m.isDraft === true,
      subject: str(m.subject),
      from: addr(m.from) ?? addr(m.sender),
      to: addrList(m.toRecipients),
      cc: addrList(m.ccRecipients),
      receivedAt: str(m.receivedDateTime),
      sentAt: str(m.sentDateTime),
      bodyText: str((m.uniqueBody as { content?: unknown } | null)?.content),
      bodyIsHtml:
        (m.uniqueBody as { contentType?: unknown } | null)?.contentType ===
          "html",
      headers: headerMap(m.internetMessageHeaders),
      detailRead: !args.lean,
      folderKind: "other",
      hasAttachments: m.hasAttachments === true,
    })),
    next: str(page["@odata.nextLink"]),
  };
}

/** The new words and headers of one message, when the list call did not carry them. */
export async function messageDetail(
  deps: GraphDeps,
  mailbox: string,
  graphId: string,
): Promise<
  { text: string | null; isHtml: boolean; headers: Record<string, string> }
> {
  const m = await getJson(
    deps,
    `${GRAPH}/users/${enc(mailbox)}/messages/${enc(graphId)}?$select=${
      DETAIL_FIELDS.join(",")
    }`,
  );
  const b = m.uniqueBody as { content?: unknown; contentType?: unknown } | null;
  return {
    text: str(b?.content),
    isHtml: b?.contentType === "html",
    headers: headerMap(m.internetMessageHeaders),
  };
}

export async function resolveGroupId(
  deps: GraphDeps,
  mail: string,
): Promise<string | null> {
  const r = await getJson(
    deps,
    `${GRAPH}/groups?$filter=${
      enc(`mail eq '${mail.replace(/'/g, "''")}'`)
    }&$select=id`,
  );
  const v = Array.isArray(r.value) ? r.value : [];
  return v.length === 1 ? str((v[0] as { id?: unknown }).id) : null;
}

export interface GroupConversation {
  id: string;
  lastDeliveredDateTime: string | null;
}

export async function listGroupConversations(
  deps: GraphDeps,
  groupId: string,
  next?: string | null,
): Promise<{ items: GroupConversation[]; next: string | null }> {
  const r = await getJson(
    deps,
    next ??
      `${GRAPH}/groups/${
        enc(groupId)
      }/conversations?$select=id,lastDeliveredDateTime&$orderby=${
        enc("lastDeliveredDateTime desc")
      }&$top=25`,
  );
  const v = Array.isArray(r.value) ? r.value : [];
  return {
    items: v.map((c: Record<string, unknown>) => ({
      id: String(c.id ?? ""),
      lastDeliveredDateTime: str(c.lastDeliveredDateTime),
    })).filter((c) => c.id),
    next: str(r["@odata.nextLink"]),
  };
}

export async function listGroupThreads(
  deps: GraphDeps,
  groupId: string,
  conversationId: string,
): Promise<Array<{ id: string; topic: string | null }>> {
  const out: Array<{ id: string; topic: string | null }> = [];
  let url: string | null = `${GRAPH}/groups/${enc(groupId)}/conversations/${
    enc(conversationId)
  }/threads?$select=id,topic`;
  for (let page = 0; url && page < 10; page++) {
    const r = await getJson(deps, url);
    for (const t of Array.isArray(r.value) ? r.value : []) {
      const id = str((t as { id?: unknown }).id);
      if (id) out.push({ id, topic: str((t as { topic?: unknown }).topic) });
    }
    url = str(r["@odata.nextLink"]);
  }
  return out;
}

export async function listGroupPosts(
  deps: GraphDeps,
  groupId: string,
  threadId: string,
  topic: string | null,
): Promise<OutlookMailItem[]> {
  const out: OutlookMailItem[] = [];
  let url: string | null = `${GRAPH}/groups/${enc(groupId)}/threads/${
    enc(threadId)
  }/posts?$select=id,from,sender,receivedDateTime,body,hasAttachments,conversationId,conversationThreadId&$expand=${
    enc(`singleValueExtendedProperties($filter=id eq '${INTERNET_ID_PROP}')`)
  }`;
  for (let page = 0; url && page < 10; page++) {
    const r = await getJson(deps, url);
    for (
      const p of (Array.isArray(r.value) ? r.value : []) as Record<
        string,
        unknown
      >[]
    ) {
      const props = Array.isArray(p.singleValueExtendedProperties)
        ? p.singleValueExtendedProperties as Array<
          { id?: unknown; value?: unknown }
        >
        : [];
      const internet = props.find((x) =>
        typeof x.id === "string" &&
        x.id.toLowerCase() === INTERNET_ID_PROP.toLowerCase()
      );
      const body = p.body as
        | { content?: unknown; contentType?: unknown }
        | null;
      out.push({
        graphId: String(p.id ?? ""),
        internetMessageId: str(internet?.value),
        conversationId: str(p.conversationId),
        subject: topic,
        from: addr(p.from) ?? addr(p.sender),
        to: [],
        cc: [],
        receivedAt: str(p.receivedDateTime),
        sentAt: str(p.receivedDateTime),
        bodyText: str(body?.content),
        bodyIsHtml: body?.contentType === "html",
        headers: {},
        folderKind: "group",
        hasAttachments: p.hasAttachments === true,
      });
    }
    url = str(r["@odata.nextLink"]);
  }
  return out.filter((p) => p.graphId);
}

/** Where an item's attachments live: a user message or a group post. */
export type AttachmentHome =
  | { kind: "message"; mailbox: string; messageId: string }
  | { kind: "post"; groupId: string; threadId: string; postId: string };

/**
 * An attachment as listed. For a group post the file's bytes come with the
 * listing (base64 in content), or content is null when Microsoft left them out.
 */
export type ListedAttachment = OutlookAttachmentMeta & {
  content?: string | null;
};

/**
 * The most one group post read (the post with every attachment's bytes) may
 * hold: the base64 of the 30 MB the reader stores per email. A bigger post is
 * refused (attachment_post_too_large) before it is all held in memory, so one
 * large post can never take the worker down.
 */
export const POST_READ_MAX_BYTES = 40 * 1024 * 1024;

function attachmentMeta(a: Record<string, unknown>): ListedAttachment {
  const t = String(a["@odata.type"] ?? "").toLowerCase();
  return {
    id: String(a.id ?? ""),
    name: str(a.name),
    contentType: str(a.contentType),
    size: typeof a.size === "number" ? a.size : null,
    isInline: a.isInline === true,
    kind: t.endsWith("itemattachment")
      ? "item"
      : t.endsWith("referenceattachment")
      ? "reference"
      : "file",
  };
}

/**
 * Attachment names, types and sizes. A user message's list carries no bytes
 * (attachmentBytes fetches each file); a group post is read once with its
 * attachments expanded, bytes included, because its attachments address is
 * refused to this login.
 */
export async function listAttachments(
  deps: GraphDeps,
  home: AttachmentHome,
): Promise<ListedAttachment[]> {
  if (home.kind === "post") {
    const p = await getJson(
      deps,
      `${GRAPH}/groups/${enc(home.groupId)}/threads/${
        enc(home.threadId)
      }/posts/${enc(home.postId)}?$expand=attachments`,
      { maxBytes: POST_READ_MAX_BYTES, code: "attachment_post_too_large" },
    );
    return (Array.isArray(p.attachments) ? p.attachments : []).map(
      (a: Record<string, unknown>) => ({
        ...attachmentMeta(a),
        content: typeof a.contentBytes === "string" && a.contentBytes !== ""
          ? a.contentBytes
          : null,
      }),
    ).filter((a: ListedAttachment) => a.id);
  }
  const r = await getJson(
    deps,
    `${GRAPH}/users/${enc(home.mailbox)}/messages/${
      enc(home.messageId)
    }/attachments?$select=id,name,contentType,size,isInline`,
  );
  return (Array.isArray(r.value) ? r.value : []).map(attachmentMeta).filter((
    a: ListedAttachment,
  ) => a.id);
}

/** Base64 to bytes, refused past maxBytes before decoding. */
function decodeContent(content: string, maxBytes: number): Uint8Array {
  const clean = content.replace(/\s+/g, "");
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  if (Math.floor(clean.length / 4) * 3 - pad > maxBytes) {
    throw new GraphReadError("attachment_too_large", null);
  }
  let bin: string;
  try {
    bin = atob(clean);
  } catch {
    throw new GraphReadError("attachment_bad_content", null);
  }
  if (bin.length > maxBytes) {
    throw new GraphReadError("attachment_too_large", null);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * One file attachment's raw bytes, refused past maxBytes. A user message's
 * file is fetched (its /$value); a group post's came with the listing, and one
 * Microsoft sent without bytes is refused (attachment_no_content).
 */
export async function attachmentBytes(
  deps: GraphDeps,
  home: AttachmentHome,
  attachment: ListedAttachment,
  maxBytes: number,
): Promise<Uint8Array> {
  if (home.kind === "post") {
    if (!attachment.content) {
      throw new GraphReadError("attachment_no_content", null);
    }
    return decodeContent(attachment.content, maxBytes);
  }
  return await getBytes(
    deps,
    `${GRAPH}/users/${enc(home.mailbox)}/messages/${
      enc(home.messageId)
    }/attachments/${enc(attachment.id)}/$value`,
    maxBytes,
  );
}

/** App-only token (client credentials), cached for the worker's life. */
export function graphTokenSource(
  env: (name: string) => string | undefined,
  fetchFn: typeof fetch,
): () => Promise<string> {
  let cached: { token: string; expires: number } | null = null;
  return async () => {
    if (cached && cached.expires > Date.now() + 300_000) return cached.token;
    const tenant = env("MICROSOFT_TENANT_ID");
    const client = env("MICROSOFT_CLIENT_ID");
    const secret = env("MICROSOFT_CLIENT_SECRET");
    if (!tenant || !client || !secret) {
      throw new GraphReadError("graph_credentials_missing", null);
    }
    let resp: Response;
    try {
      resp = await fetchFn(
        `https://login.microsoftonline.com/${enc(tenant)}/oauth2/v2.0/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: client,
            client_secret: secret,
            scope: "https://graph.microsoft.com/.default",
          }),
        },
      );
    } catch {
      throw new GraphReadError("graph_token_unreachable", null);
    }
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      throw new GraphReadError(`graph_token_${resp.status}`, resp.status);
    }
    const data = await resp.json();
    cached = {
      token: String(data.access_token),
      expires: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    };
    return cached.token;
  };
}
