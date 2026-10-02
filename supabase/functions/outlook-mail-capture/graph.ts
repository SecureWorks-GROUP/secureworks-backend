// Microsoft Graph reads for the email reader (slice EM2). Read only: every
// call here is a GET (plus the token POST). Nothing here sends, replies,
// moves, deletes or marks mail read; graph_test.ts pins that every request is
// a GET to graph.microsoft.com.
//
// Every read asks for immutable ids and plain-text bodies. Errors are thrown
// as GraphReadError with a code (graph_<http status>, graph_unreachable,
// graph_bad_json); never the response text, which can carry mail content.

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

async function getJson(
  deps: GraphDeps,
  url: string,
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

function attachmentsBase(home: AttachmentHome): string {
  return home.kind === "message"
    ? `${GRAPH}/users/${enc(home.mailbox)}/messages/${
      enc(home.messageId)
    }/attachments`
    : `${GRAPH}/groups/${enc(home.groupId)}/threads/${
      enc(home.threadId)
    }/posts/${enc(home.postId)}/attachments`;
}

/** Attachment names, types and sizes (no bytes). */
export async function listAttachments(
  deps: GraphDeps,
  home: AttachmentHome,
): Promise<OutlookAttachmentMeta[]> {
  const r = await getJson(
    deps,
    `${attachmentsBase(home)}?$select=id,name,contentType,size,isInline`,
  );
  return (Array.isArray(r.value) ? r.value : []).map(
    (a: Record<string, unknown>) => {
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
      } as OutlookAttachmentMeta;
    },
  ).filter((a: OutlookAttachmentMeta) => a.id);
}

/** One file attachment's raw bytes, refused past maxBytes. */
export function attachmentBytes(
  deps: GraphDeps,
  home: AttachmentHome,
  attachmentId: string,
  maxBytes: number,
): Promise<Uint8Array> {
  return getBytes(
    deps,
    `${attachmentsBase(home)}/${enc(attachmentId)}/$value`,
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
