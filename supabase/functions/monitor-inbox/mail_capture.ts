// Capture is deterministic. Provider reads and persistence are injected for replay tests.
import { computeHash } from "../_shared/evidence/storage.ts";
export const GRAPH = "https://graph.microsoft.com/v1.0";
export const MAIL_BUCKET = "context-mail-evidence";
export interface Address {
  emailAddress?: { address?: string; name?: string };
}
export interface Mail {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  conversationThreadId?: string;
  subject?: string;
  body?: { content?: string; contentType?: string };
  bodyPreview?: string;
  from?: Address;
  sender?: Address;
  toRecipients?: Address[];
  ccRecipients?: Address[];
  receivedDateTime?: string;
  sentDateTime?: string;
  createdDateTime?: string;
  hasAttachments?: boolean;
  internetMessageHeaders?: { name: string; value: string }[];
  "@removed"?: unknown;
}
export interface Task {
  url: string;
  kind: "threads" | "posts";
  topic?: string;
  threadId?: string;
  recipients?: Address[];
}
export interface Cursor {
  next?: string;
  delta?: string;
  tasks?: Task[];
  groupId?: string;
  cycleStarted?: string;
  highWater?: string;
  resetCount?: number;
}
export interface Stream {
  key: string;
  mailbox: string;
  kind: "user" | "group";
  folder: "inbox" | "sentitems" | "conversations";
  captureFrom: string;
}
export interface CaptureDependencies {
  get: (url: string) => Promise<Record<string, unknown>>;
  persist: (
    message: Mail,
    stream: Stream,
    resourceUrl: string,
  ) => Promise<void>;
  checkpoint: (state: Cursor, complete: boolean) => Promise<void>;
  now: () => string;
}
export class GraphFailure extends Error {
  constructor(readonly status: number) {
    super(`graph_http_${status}`);
  }
}
export function graphUrl(url: string): string {
  const parsed = new URL(url);
  if (
    parsed.origin !== "https://graph.microsoft.com" ||
    !parsed.pathname.startsWith("/v1.0/")
  ) throw new Error("untrusted_graph_continuation");
  return parsed.href;
}
export function previewText(raw: string, html = false): string {
  let text = raw;
  if (html) {
    text = text.replace(/<blockquote\b[\s\S]*$/i, "").replace(
      /<(?:div|hr)\b[^>]*(?:divRplyFwdMsg|appendonsend)[\s\S]*$/i,
      "",
    )
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(
        /<\/(?:p|div|li|tr)>|<br\s*\/?>/gi,
        "\n",
      ).replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
  }
  text = text.replace(/\r\n?/g, "\n").split(
    /\n(?:On .+wrote:|From:\s|_{5,}|-{2,}\s*Original Message|--\s*$|Sent from my |(?:Kind regards|Best regards|Regards|Cheers),?\s*$)/im,
  )[0].trim();
  // Four KB means UTF-8 bytes, not UTF-16 code units.
  return new TextDecoder().decode(new TextEncoder().encode(text).slice(0, 4096))
    .replace(/\uFFFD$/, "");
}
export function automatedMail(message: Mail): boolean {
  const headers = new Map(
    (message.internetMessageHeaders || []).map(
      (h) => [h.name.toLowerCase(), h.value.toLowerCase()],
    ),
  );
  const from = (message.from?.emailAddress?.address || "").toLowerCase();
  const subject = message.subject || "";
  return (headers.has("auto-submitted") &&
    headers.get("auto-submitted") !== "no") ||
    headers.has("list-unsubscribe") ||
    headers.get("x-secureworks-automation") === "true" ||
    /^(bulk|list|junk)$/.test(headers.get("precedence") || "") ||
    /^(?:no-?reply|donotreply|mailer-daemon|postmaster)[@+]/.test(from) ||
    /^(?:automatic reply|out of (?:the )?office|delivery (?:status|failure)|undeliverable|read receipt|payment receipt|receipt for|notification:|newsletter)\b/i
      .test(subject);
}
export function mailIdentity(message: Mail, stream: Stream): string {
  return message.internetMessageId?.trim()
    ? `email:${message.internetMessageId.trim()}`
    : `graph-${stream.kind}:${stream.mailbox}:${message.id}`;
}
// Do not use a received-date $filter: Graph limits filtered delta rounds to 5,000.
// Scan metadata without a filter; hydrate/capture only dates on/after captureFrom.
export function initialDelta(stream: Stream): string {
  const query = new URLSearchParams({
    "$select":
      "id,internetMessageId,conversationId,from,sender,toRecipients,subject,receivedDateTime,sentDateTime,hasAttachments",
    "$orderby": "receivedDateTime desc",
  });
  return `${GRAPH}/users/${
    encodeURIComponent(stream.mailbox)
  }/mailFolders/${stream.folder}/messages/delta?${query}`;
}
function collection(page: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(page.value)) throw new Error("graph_missing_collection");
  return page.value as Record<string, unknown>[];
}
/** Commit a provider continuation only after every message and attachment in that page is durable. */
export async function captureUser(
  stream: Stream,
  original: Cursor,
  deps: CaptureDependencies,
  maxPages = 4,
) {
  let state = structuredClone(original), pages = 0, messages = 0;
  let url = state.next || state.delta || initialDelta(stream);
  while (pages < maxPages) {
    let page: Record<string, unknown>;
    try {
      page = await deps.get(graphUrl(url));
    } catch (error) {
      if (
        error instanceof GraphFailure && error.status === 410 &&
        (state.next || state.delta)
      ) {
        state = { resetCount: (state.resetCount || 0) + 1 };
        await deps.checkpoint(state, false); // Replay from original capture boundary; duplicate writes converge.
      }
      throw error;
    }
    for (const entry of collection(page)) {
      const message = entry as unknown as Mail;
      if (!message.id) throw new Error("graph_missing_message_id");
      if (message["@removed"]) continue; // Append-only evidence is retained after provider deletion/move.
      const eventAt = stream.folder === "sentitems"
        ? message.sentDateTime || message.receivedDateTime
        : message.receivedDateTime;
      if (eventAt && eventAt < stream.captureFrom) continue;
      await deps.persist(
        message,
        stream,
        `${GRAPH}/users/${encodeURIComponent(stream.mailbox)}/messages/${
          encodeURIComponent(message.id)
        }`,
      );
      messages++;
    }
    const next = typeof page["@odata.nextLink"] === "string"
      ? graphUrl(page["@odata.nextLink"])
      : undefined;
    const delta = typeof page["@odata.deltaLink"] === "string"
      ? graphUrl(page["@odata.deltaLink"])
      : undefined;
    if (!next && !delta) throw new Error("graph_missing_delta_continuation");
    if (next === url) throw new Error("graph_continuation_cycle");
    state = { ...state, next, delta: next ? state.delta : delta };
    await deps.checkpoint(state, !next);
    pages++;
    if (!next) return { pages, messages, complete: true };
    url = next;
  }
  return { pages, messages, complete: false };
}
/** Groups have no folder delta API. Durable work queue follows all thread/post pages. */
export async function captureGroup(
  stream: Stream,
  original: Cursor,
  deps: CaptureDependencies,
  maxPages = 4,
) {
  const state = structuredClone(original);
  let pages = 0, messages = 0;
  if (!state.groupId) {
    const lookup = `${GRAPH}/groups?$filter=${
      encodeURIComponent(`mail eq '${stream.mailbox.replaceAll("'", "''")}'`)
    }&$select=id,mail`;
    const matches = collection(await deps.get(lookup));
    if (matches.length !== 1 || !matches[0].id) {
      throw new Error("group_not_provisioned_or_ambiguous");
    }
    state.groupId = String(matches[0].id);
  }
  if (!state.tasks?.length) {
    state.cycleStarted = deps.now();
    state.tasks = [{
      url: `${GRAPH}/groups/${
        encodeURIComponent(state.groupId)
      }/threads?$select=id,topic,lastDeliveredDateTime,toRecipients`,
      kind: "threads",
    }];
  }
  while (state.tasks.length && pages < maxPages) {
    const task = state.tasks[0];
    let page: Record<string, unknown>;
    try {
      page = await deps.get(graphUrl(task.url));
    } catch (error) {
      if (error instanceof GraphFailure && error.status === 410) {
        state.tasks = [];
        state.resetCount = (state.resetCount || 0) + 1;
        await deps.checkpoint(state, false);
      }
      throw error;
    }
    const follow: Task[] = [];
    for (const entry of collection(page)) {
      if (!entry.id) throw new Error("graph_missing_group_item_id");
      if (task.kind === "threads") {
        // Fetch all thread pages; only old unchanged threads can skip posts.
        const lower = state.highWater || stream.captureFrom;
        const overlap = new Date(Date.parse(lower) - 24 * 60 * 60 * 1000)
          .toISOString();
        if (
          typeof entry.lastDeliveredDateTime === "string" &&
          entry.lastDeliveredDateTime < overlap
        ) continue;
        follow.push({
          kind: "posts",
          threadId: String(entry.id),
          topic: String(entry.topic || ""),
          recipients: entry.toRecipients as Address[] | undefined,
          url: `${GRAPH}/groups/${encodeURIComponent(state.groupId)}/threads/${
            encodeURIComponent(String(entry.id))
          }/posts?$select=id,body,from,sender,receivedDateTime,createdDateTime,hasAttachments,conversationId,conversationThreadId`,
        });
      } else {
        const message = {
          ...entry,
          subject: task.topic,
          toRecipients: task.recipients,
          conversationThreadId: task.threadId,
        } as unknown as Mail;
        const eventAt = message.receivedDateTime || message.createdDateTime;
        if (eventAt && eventAt < stream.captureFrom) continue;
        await deps.persist(
          message,
          stream,
          `${GRAPH}/groups/${encodeURIComponent(state.groupId)}/threads/${
            encodeURIComponent(task.threadId!)
          }/posts/${encodeURIComponent(message.id)}`,
        );
        messages++;
      }
    }
    if (typeof page["@odata.nextLink"] === "string") {
      if (page["@odata.nextLink"] === task.url) {
        throw new Error("graph_continuation_cycle");
      }
      follow.push({ ...task, url: graphUrl(page["@odata.nextLink"]) });
    }
    // Depth-first keeps the durable queue bounded by one Graph thread page + nesting.
    state.tasks = [...follow, ...state.tasks.slice(1)];
    const complete = state.tasks.length === 0;
    if (complete) state.highWater = state.cycleStarted;
    await deps.checkpoint(state, complete);
    pages++;
  }
  return {
    pages,
    messages,
    complete: !state.tasks.length,
    limitation: "group_posts_have_no_delta_or_internet_message_id",
  };
}
export interface StoredFile {
  pointer: string;
  hash: string;
  bytes: number;
  name: string;
  content_type: string;
}
export async function storeBytes(
  storage: {
    upload: (
      path: string,
      bytes: Uint8Array,
      contentType: string,
    ) => Promise<void>;
  },
  bytes: Uint8Array,
  name: string,
  contentType: string,
): Promise<StoredFile> {
  const hash = await computeHash(bytes), path = `sha256/${hash}`;
  await storage.upload(path, bytes, contentType);
  return {
    pointer: `${MAIL_BUCKET}://${path}`,
    hash,
    bytes: bytes.length,
    name,
    content_type: contentType,
  };
}
