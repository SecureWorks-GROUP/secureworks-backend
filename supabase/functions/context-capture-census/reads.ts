// The census's live reads: Microsoft Graph and GHL GETs, and database reads
// over one service-role client. Nothing here writes, sends, moves, deletes or
// marks anything read. Graph reads ask for immutable ids (the email reader's
// ids) and carry the reader's own app-only login; GHL reads carry the
// location's token. Errors are thrown with a code only (graph_<status>,
// ghl_<status>, ..._timeout, ..._unreachable), never the provider's text.

import {
  loadRefPrefixes,
  REF_PREFIX_FLOOR,
  type RefPrefixClient,
} from "../_shared/makesafe_refs.ts";
import type { OutlookMailItem } from "../_shared/evidence/outlook_mail.ts";
import { GRAPH, graphTokenSource } from "../outlook-mail-capture/graph.ts";
import type {
  CensusReads,
  ExplainContext,
  FolderIds,
  RawGhlConversation,
  RawGhlMessage,
  SourceRow,
} from "./census.ts";

export const GHL = "https://services.leadconnectorhq.com";
const PREFER = 'outlook.body-content-type="text", IdType="ImmutableId"';
/** MAPI PR_INTERNET_MESSAGE_ID: a group post's internet id (as the reader reads it). */
const INTERNET_ID_PROP = "String 0x1035";
const GET_TIMEOUT_MS = 20_000;

export class ReadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface LiveDeps {
  env(name: string): string | undefined;
  fetch: typeof fetch;
  // deno-lint-ignore no-explicit-any
  supabase: any;
  now(): number;
}

const enc = encodeURIComponent;

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
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

function textSet(data: unknown): Set<string> {
  return new Set(
    (Array.isArray(data) ? data : []).filter((x): x is string =>
      typeof x === "string" && x !== ""
    ).map((x) => x.toLowerCase()),
  );
}

function internetId(p: Record<string, unknown>): string | null {
  const props = Array.isArray(p.singleValueExtendedProperties)
    ? p.singleValueExtendedProperties as Array<
      { id?: unknown; value?: unknown }
    >
    : [];
  const hit = props.find((x) =>
    typeof x.id === "string" &&
    x.id.toLowerCase() === INTERNET_ID_PROP.toLowerCase()
  );
  return str(hit?.value);
}

/** One GET, JSON back, with a timeout; a refusal or failure is a coded ReadError. */
async function getJson(
  fetchFn: typeof fetch,
  prefix: "graph" | "ghl",
  url: string,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetchFn(url, {
      method: "GET",
      redirect: "error",
      headers,
      signal: AbortSignal.timeout(GET_TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name;
    throw new ReadError(
      name === "TimeoutError" || name === "AbortError"
        ? `${prefix}_timeout`
        : `${prefix}_unreachable`,
    );
  }
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {});
    throw new ReadError(`${prefix}_${resp.status}`);
  }
  try {
    const data = await resp.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("shape");
    }
    return data as Record<string, unknown>;
  } catch {
    throw new ReadError(`${prefix}_bad_json`);
  }
}

export function liveCensusReads(deps: LiveDeps): CensusReads {
  const token = graphTokenSource(deps.env, deps.fetch);
  const graph = async (url: string) => {
    if (!url.startsWith(GRAPH + "/")) throw new ReadError("graph_bad_url");
    return await getJson(deps.fetch, "graph", url, {
      Authorization: `Bearer ${await token()}`,
      Prefer: PREFER,
    });
  };
  const ghlToken = deps.env("GHL_API_TOKEN") ?? "";
  const locationId = deps.env("GHL_LOCATION_ID") ?? "";
  const ghl = async (path: string, version = "2021-07-28") => {
    if (!ghlToken || !locationId) throw new ReadError("ghl_not_configured");
    return await getJson(deps.fetch, "ghl", `${GHL}${path}`, {
      Authorization: `Bearer ${ghlToken}`,
      Version: version,
      Accept: "application/json",
    });
  };
  const sb = deps.supabase;

  return {
    now: deps.now,
    async sources() {
      const { data, error } = await sb.from("monitored_mailboxes")
        .select("email,source_key,kind,scope_label,owner_privacy")
        .eq("enabled", true).eq("status", "active").order("source_key");
      if (error) throw new ReadError("sources_unreadable");
      return (data ?? []) as SourceRow[];
    },
    async folderIds(mailbox) {
      const one = async (wellKnown: string): Promise<string | null> => {
        try {
          const f = await graph(
            `${GRAPH}/users/${
              enc(mailbox)
            }/mailFolders/${wellKnown}?$select=id`,
          );
          return str(f.id);
        } catch (e) {
          if (e instanceof ReadError && e.code === "graph_404") return null;
          throw e;
        }
      };
      const out: FolderIds = {
        inbox: await one("inbox"),
        sent: await one("sentitems"),
        deleted: await one("deleteditems"),
        archive: await one("archive"),
        junk: await one("junkemail"),
        drafts: await one("drafts"),
        outbox: await one("outbox"),
      };
      return out;
    },
    async listMail(mailbox, args) {
      const url = args.next ??
        `${GRAPH}/users/${enc(mailbox)}/messages?$filter=${
          enc(
            `receivedDateTime ge ${args.fromIso} and receivedDateTime lt ${args.toIso}`,
          )
        }&$orderby=${enc("receivedDateTime asc")}&$top=${args.top}&$select=${
          enc("id,internetMessageId,parentFolderId,receivedDateTime,isDraft")
        }`;
      const page = await graph(url);
      const values = Array.isArray(page.value) ? page.value : [];
      return {
        items: values.map((m: Record<string, unknown>) => ({
          id: String(m.id ?? ""),
          internetMessageId: str(m.internetMessageId),
          parentFolderId: str(m.parentFolderId),
          receivedDateTime: str(m.receivedDateTime),
          isDraft: m.isDraft === true,
        })),
        next: str(page["@odata.nextLink"]),
      };
    },
    async resolveGroupId(mail) {
      const r = await graph(
        `${GRAPH}/groups?$filter=${
          enc(`mail eq '${mail.replace(/'/g, "''")}'`)
        }&$select=id`,
      );
      const v = Array.isArray(r.value) ? r.value : [];
      return v.length === 1 ? str((v[0] as { id?: unknown }).id) : null;
    },
    async listGroupConversations(groupId, next) {
      const r = await graph(
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
    },
    async listGroupThreads(groupId, conversationId, next) {
      const r = await graph(
        next ??
          `${GRAPH}/groups/${enc(groupId)}/conversations/${
            enc(conversationId)
          }/threads?$select=id`,
      );
      const v = Array.isArray(r.value) ? r.value : [];
      return {
        items: v.map((t: Record<string, unknown>) => ({
          id: String(t.id ?? ""),
        }))
          .filter((t) => t.id),
        next: str(r["@odata.nextLink"]),
      };
    },
    async listGroupPosts(groupId, threadId, next) {
      const r = await graph(
        next ??
          `${GRAPH}/groups/${enc(groupId)}/threads/${
            enc(threadId)
          }/posts?$select=id,receivedDateTime&$expand=${
            enc(
              `singleValueExtendedProperties($filter=id eq '${INTERNET_ID_PROP}')`,
            )
          }`,
      );
      const v = Array.isArray(r.value) ? r.value : [];
      return {
        items: v.map((p: Record<string, unknown>) => ({
          id: String(p.id ?? ""),
          internetMessageId: internetId(p),
          receivedDateTime: str(p.receivedDateTime),
        })).filter((p) => p.id),
        next: str(r["@odata.nextLink"]),
      };
    },
    async mailItem(mailbox, id): Promise<OutlookMailItem> {
      const m = await graph(
        `${GRAPH}/users/${enc(mailbox)}/messages/${enc(id)}?$select=${
          enc(
            "id,internetMessageId,conversationId,subject,from,sender,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,uniqueBody,body,internetMessageHeaders",
          )
        }`,
      );
      const u = m.uniqueBody as
        | { content?: unknown; contentType?: unknown }
        | null;
      const b = m.body as { content?: unknown; contentType?: unknown } | null;
      return {
        graphId: String(m.id ?? id),
        internetMessageId: str(m.internetMessageId),
        conversationId: str(m.conversationId),
        subject: str(m.subject),
        from: addr(m.from) ?? addr(m.sender),
        to: addrList(m.toRecipients),
        cc: addrList(m.ccRecipients),
        receivedAt: str(m.receivedDateTime),
        sentAt: str(m.sentDateTime),
        bodyText: str(u?.content),
        bodyIsHtml: u?.contentType === "html",
        fullBodyText: str(b?.content),
        fullBodyIsHtml: b?.contentType === "html",
        headers: headerMap(m.internetMessageHeaders),
        folderKind: "other",
        hasAttachments: m.hasAttachments === true,
      };
    },
    async postItem(groupId, threadId, postId): Promise<OutlookMailItem> {
      const p = await graph(
        `${GRAPH}/groups/${enc(groupId)}/threads/${enc(threadId)}/posts/${
          enc(postId)
        }?$select=id,from,sender,receivedDateTime,body,hasAttachments,conversationId&$expand=${
          enc(
            `singleValueExtendedProperties($filter=id eq '${INTERNET_ID_PROP}')`,
          )
        }`,
      );
      const b = p.body as { content?: unknown; contentType?: unknown } | null;
      return {
        graphId: String(p.id ?? postId),
        internetMessageId: internetId(p),
        conversationId: str(p.conversationId),
        subject: null,
        from: addr(p.from) ?? addr(p.sender),
        to: [],
        cc: [],
        receivedAt: str(p.receivedDateTime),
        sentAt: str(p.receivedDateTime),
        bodyText: str(b?.content),
        bodyIsHtml: b?.contentType === "html",
        headers: {},
        folderKind: "group",
        hasAttachments: p.hasAttachments === true,
      };
    },
    async explainContext(): Promise<ExplainContext> {
      const sup = await sb.rpc("context_email_supplier_domains");
      if (sup.error) throw new ReadError("suppliers_unreadable");
      const jobs = await sb.rpc("context_email_job_client_emails");
      if (jobs.error) throw new ReadError("job_emails_unreadable");
      const prefixes = await loadRefPrefixes(sb as RefPrefixClient).catch(() =>
        null
      );
      return {
        supplierDomains: textSet(sup.data),
        jobClientEmails: textSet(jobs.data),
        prefixes: prefixes ?? [...REF_PREFIX_FLOOR],
      };
    },
    async ghlConversations(args): Promise<RawGhlConversation[]> {
      const q = new URLSearchParams({
        locationId,
        limit: String(args.limit),
        sort: "desc",
        sortBy: "last_message_date",
      });
      if (args.startAfterMs !== null) {
        q.set("startAfterDate", String(args.startAfterMs));
      }
      const data = await ghl(`/conversations/search?${q}`);
      const rows = Array.isArray(data.conversations)
        ? data.conversations
        : null;
      if (!rows) throw new ReadError("ghl_bad_shape");
      return rows.map((c: Record<string, unknown>) => {
        if (str(c.locationId) && c.locationId !== locationId) {
          throw new ReadError("ghl_location_mismatch");
        }
        const raw = c.lastMessageDate ?? c.last_message_date;
        const n = typeof raw === "number"
          ? raw
          : typeof raw === "string" && /^\d{1,16}$/.test(raw.trim())
          ? Number(raw.trim())
          : typeof raw === "string"
          ? Date.parse(raw)
          : NaN;
        return {
          id: String(c.id ?? ""),
          contactId: str(c.contactId),
          lastMessageMs: Number.isFinite(n) && n > 0 ? Math.trunc(n) : null,
        };
      }).filter((c) => c.id);
    },
    async ghlMessages(conversationId, args) {
      const q = new URLSearchParams({ limit: String(args.limit) });
      if (args.lastMessageId) q.set("lastMessageId", args.lastMessageId);
      const data = await ghl(
        `/conversations/${enc(conversationId)}/messages?${q}`,
      );
      const box = (data.messages && typeof data.messages === "object" &&
          !Array.isArray(data.messages))
        ? data.messages as Record<string, unknown>
        : null;
      const rows = box && Array.isArray(box.messages) ? box.messages : null;
      if (!rows) throw new ReadError("ghl_bad_shape");
      const items: RawGhlMessage[] = rows.map((m: Record<string, unknown>) => {
        if (str(m.locationId) && m.locationId !== locationId) {
          throw new ReadError("ghl_location_mismatch");
        }
        const meta = m.meta as { call?: { status?: unknown } } | null;
        return {
          id: str(m.id),
          conversationId: str(m.conversationId),
          contactId: str(m.contactId),
          messageType: str(m.messageType) ?? str(m.type),
          direction: str(m.direction),
          dateAdded: str(m.dateAdded),
          status: str(meta?.call?.status) ?? str(m.status),
        };
      });
      return {
        items,
        nextPage: typeof box!.nextPage === "boolean" ? box!.nextPage : null,
        lastMessageId: str(box!.lastMessageId),
      };
    },
  };
}
