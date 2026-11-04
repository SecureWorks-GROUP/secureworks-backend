// The capture census (finish line row C7, 3 Nov 2026): what the source systems
// hold, counted at the source, so a measurement can check that every email in
// every monitored mailbox, every GHL text and every GHL call has its own row in
// business_events. It answers ids, times, folders and types only: never a
// subject, address, body or file. It writes nothing anywhere: every Graph and
// GHL call is a GET (census_test.ts pins that), and the database is only read.
//
// Lanes (one small, bounded answer per call; the caller loops until complete):
//   email_messages            a user mailbox, every folder, by receivedDateTime
//                             in [from, to), the same listing the email reader
//                             uses (/users/{m}/messages, immutable ids), with
//                             each message's folder named
//   email_group_conversations a group mailbox's conversations, newest first,
//                             last delivered at or after from
//   email_group_posts         the posts of up to 25 of those conversations,
//                             received in [from, to)
//   email_explain             up to 25 messages or posts read whole inside the
//                             function and passed through the reader's own row
//                             builder, answering only the builder's verdict
//                             (row, or the skip rule that drops it)
//   ghl_conversations         the GHL location's conversations, newest first by
//                             last message, at or after from
//   ghl_messages              the messages of up to 25 of those conversations,
//                             added in [from, to): id, type, direction, time
//
// Each answer carries complete true only when nothing in its scope was left
// unread; a cut answer names what is left (next, or pending conversations).
// Pure orchestration over injected reads. No model call.

import {
  buildOutlookMailRow,
  emailProviderKey,
  type OutlookMailItem,
  type OutlookSource,
} from "../_shared/evidence/outlook_mail.ts";

export const POLICY = {
  /** Each call stops reading after this and answers what it has (worker wall clock is 150 s). */
  budgetMs: 50_000,
  /** The widest window one call may ask for. */
  maxWindowMs: 10 * 86_400_000,
  /** How far back a window may start. */
  maxAgeMs: 40 * 86_400_000,
  mailPageSize: 500,
  ghlConversationPage: 100,
  ghlMessagePage: 100,
  maxBatch: 25,
  /** Pages per GHL conversation before it is reported as not finished. */
  maxMessagePagesPerConversation: 40,
} as const;

export type Lane =
  | "email_messages"
  | "email_group_conversations"
  | "email_group_posts"
  | "email_explain"
  | "ghl_conversations"
  | "ghl_messages";

export const LANES: readonly Lane[] = [
  "email_messages",
  "email_group_conversations",
  "email_group_posts",
  "email_explain",
  "ghl_conversations",
  "ghl_messages",
];

export type FolderName =
  | "inbox"
  | "sent"
  | "deleted"
  | "archive"
  | "other"
  | "junk"
  | "drafts"
  | "outbox"
  | "group";

/** Folders the email reader never saves from (capture.ts skipFolders, and any draft). */
export const FOLDERS_NOT_READ: ReadonlySet<FolderName> = new Set([
  "junk",
  "drafts",
  "outbox",
]);

export interface FolderIds {
  inbox: string | null;
  sent: string | null;
  deleted: string | null;
  archive: string | null;
  junk: string | null;
  drafts: string | null;
  outbox: string | null;
}

export interface RawMail {
  id: string;
  internetMessageId: string | null;
  parentFolderId: string | null;
  receivedDateTime: string | null;
  isDraft: boolean;
}

export interface RawPost {
  id: string;
  internetMessageId: string | null;
  receivedDateTime: string | null;
}

export interface RawGhlConversation {
  id: string;
  contactId: string | null;
  lastMessageMs: number | null;
}

export interface RawGhlMessage {
  id: string | null;
  conversationId: string | null;
  contactId: string | null;
  messageType: string | null;
  direction: string | null;
  dateAdded: string | null;
  status: string | null;
}

export interface SourceRow {
  email: string;
  source_key: string;
  kind: string;
  scope_label: string;
  owner_privacy: boolean;
}

export interface ExplainContext {
  supplierDomains: ReadonlySet<string>;
  builderSenders: ReadonlySet<string>;
  jobClientEmails: ReadonlySet<string>;
  prefixes: readonly string[];
}

export interface CensusReads {
  now(): number;
  /** Monitored mailboxes (enabled and active), as the email reader selects them. */
  sources(): Promise<SourceRow[]>;
  folderIds(mailbox: string): Promise<FolderIds>;
  listMail(
    mailbox: string,
    args: { fromIso: string; toIso: string; top: number; next: string | null },
  ): Promise<{ items: RawMail[]; next: string | null }>;
  resolveGroupId(mail: string): Promise<string | null>;
  listGroupConversations(
    groupId: string,
    next: string | null,
  ): Promise<{
    items: { id: string; lastDeliveredDateTime: string | null }[];
    next: string | null;
  }>;
  listGroupThreads(
    groupId: string,
    conversationId: string,
    next: string | null,
  ): Promise<{ items: { id: string }[]; next: string | null }>;
  listGroupPosts(
    groupId: string,
    threadId: string,
    next: string | null,
  ): Promise<{ items: RawPost[]; next: string | null }>;
  /** A whole message or post, as the reader's row builder needs it (read inside the function only). */
  mailItem(mailbox: string, id: string): Promise<OutlookMailItem>;
  postItem(
    groupId: string,
    threadId: string,
    postId: string,
  ): Promise<OutlookMailItem>;
  explainContext(): Promise<ExplainContext>;
  ghlConversations(
    args: { limit: number; startAfterMs: number | null },
  ): Promise<RawGhlConversation[]>;
  ghlMessages(
    conversationId: string,
    args: { limit: number; lastMessageId: string | null },
  ): Promise<
    {
      items: RawGhlMessage[];
      nextPage: boolean | null;
      lastMessageId: string | null;
    }
  >;
}

export interface CensusRequest {
  lane: Lane;
  mailbox?: string | null;
  from?: string | null;
  to?: string | null;
  next?: string | null;
  conversations?: string[] | null;
  items?: { mailbox: string; id: string; thread_id?: string | null }[] | null;
}

export class CensusRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** A short code for any thrown error; never its message (which may carry provider text). */
export function errorCode(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(c)
    ? c
    : "read_failed";
}

function ms(v: string | null | undefined): number | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

const iso = (t: number) => new Date(t).toISOString();

/** The window [from, to) of a request, refused when malformed, inverted, too wide, too old or in the future. */
export function censusWindow(
  req: CensusRequest,
  now: number,
): { fromMs: number; toMs: number } {
  const fromMs = ms(req.from ?? null);
  const toMs = ms(req.to ?? null);
  if (fromMs === null || toMs === null || fromMs >= toMs) {
    throw new CensusRefusal("window_invalid");
  }
  if (toMs - fromMs > POLICY.maxWindowMs) {
    throw new CensusRefusal("window_too_wide");
  }
  if (fromMs < now - POLICY.maxAgeMs) throw new CensusRefusal("window_too_old");
  if (toMs > now + 60_000) throw new CensusRefusal("window_in_future");
  return { fromMs, toMs };
}

/** The key the reader saves an email under: email:<internet id>, else graph:<mailbox>:<graph id>. */
export function readerKey(
  mailbox: string,
  graphId: string,
  internetMessageId: string | null,
): string {
  return emailProviderKey(internetMessageId) ??
    `graph:${mailbox.trim().toLowerCase()}:${graphId}`;
}

/** Which folder a message sits in, by the mailbox's well-known folder ids. */
export function folderOf(m: RawMail, f: FolderIds): FolderName {
  if (m.isDraft) return "drafts";
  const p = m.parentFolderId;
  if (!p) return "other";
  for (
    const name of [
      "junk",
      "drafts",
      "outbox",
      "sent",
      "deleted",
      "inbox",
      "archive",
    ] as const
  ) {
    if (f[name] && f[name] === p) return name;
  }
  return "other";
}

/** GHL's message type as the row builder reads it: upper case, no TYPE_ prefix, letters and digits only. */
export function ghlKind(raw: string | null | undefined): string {
  return String(raw ?? "").toUpperCase().replace(/^TYPE_/, "").replace(
    /[^A-Z0-9]/g,
    "",
  );
}

async function selectedSource(
  reads: CensusReads,
  mailbox: string | null | undefined,
  kind: "user" | "group",
): Promise<SourceRow> {
  const want = String(mailbox ?? "").trim().toLowerCase();
  if (!want) throw new CensusRefusal("mailbox_required");
  const s = (await reads.sources()).find((r) =>
    r.email.trim().toLowerCase() === want
  );
  // Only a mailbox the email reader monitors may be counted.
  if (!s) throw new CensusRefusal("mailbox_not_monitored");
  if (s.kind !== kind) throw new CensusRefusal(`mailbox_not_${kind}`);
  return s;
}

function batch(req: CensusRequest): string[] {
  const list = Array.isArray(req.conversations) ? req.conversations : [];
  const ids = [
    ...new Set(
      list.filter((x): x is string =>
        typeof x === "string" && /^[A-Za-z0-9_=+\/-]{1,512}$/.test(x)
      ),
    ),
  ];
  if (ids.length === 0 || ids.length !== list.length) {
    throw new CensusRefusal("conversations_invalid");
  }
  if (ids.length > POLICY.maxBatch) throw new CensusRefusal("batch_too_large");
  return ids;
}

export async function runCensus(
  reads: CensusReads,
  req: CensusRequest,
): Promise<Record<string, unknown>> {
  const began = reads.now();
  const over = () => reads.now() - began > POLICY.budgetMs;
  if (!LANES.includes(req.lane)) throw new CensusRefusal("lane_invalid");
  if (req.lane === "email_explain") return await explain(reads, req, over);
  const w = censusWindow(req, began);
  const window = { from: iso(w.fromMs), to: iso(w.toMs) };
  let reads_ = 0;
  const inWindow = (t: number | null) =>
    t !== null && t >= w.fromMs && t < w.toMs;

  if (req.lane === "email_messages") {
    const s = await selectedSource(reads, req.mailbox, "user");
    const folders = await reads.folderIds(s.email);
    reads_++;
    const items: Record<string, unknown>[] = [];
    let next: string | null = req.next ?? null;
    let errorCode_: string | null = null;
    let started = false;
    try {
      while (!started || next) {
        if (started && over()) break;
        started = true;
        const page = await reads.listMail(s.email, {
          fromIso: window.from,
          toIso: window.to,
          top: POLICY.mailPageSize,
          next,
        });
        reads_++;
        for (const m of page.items) {
          const at = ms(m.receivedDateTime);
          if (!m.id || !inWindow(at)) continue;
          const folder = folderOf(m, folders);
          items.push({
            id: m.id,
            key: readerKey(s.email, m.id, m.internetMessageId),
            at: m.receivedDateTime,
            folder,
            read_by_capture: !FOLDERS_NOT_READ.has(folder),
          });
        }
        next = page.next;
      }
    } catch (e) {
      errorCode_ = errorCode(e);
    }
    return {
      lane: req.lane,
      mailbox: s.email,
      ...window,
      complete: !errorCode_ && !next,
      next: errorCode_ ? (req.next ?? null) : next,
      error_code: errorCode_,
      reads: reads_,
      items: errorCode_ ? [] : items,
    };
  }

  if (req.lane === "email_group_conversations") {
    const s = await selectedSource(reads, req.mailbox, "group");
    const groupId = await reads.resolveGroupId(s.email);
    reads_++;
    if (!groupId) throw new CensusRefusal("group_not_found");
    const items: Record<string, unknown>[] = [];
    let next: string | null = req.next ?? null;
    let done = false;
    let undated = 0;
    let started = false;
    let errorCode_: string | null = null;
    try {
      while (!done && (!started || next)) {
        if (started && over()) break;
        started = true;
        const page = await reads.listGroupConversations(groupId, next);
        reads_++;
        for (const c of page.items) {
          const t = ms(c.lastDeliveredDateTime);
          if (t === null) {
            // Undated: kept, so its posts are still read.
            undated++;
            items.push({ id: c.id, last_at: null });
            continue;
          }
          if (t < w.fromMs) {
            done = true;
            break;
          }
          items.push({ id: c.id, last_at: c.lastDeliveredDateTime });
        }
        next = page.next;
        if (!next) done = true;
      }
    } catch (e) {
      errorCode_ = errorCode(e);
    }
    return {
      lane: req.lane,
      mailbox: s.email,
      ...window,
      complete: !errorCode_ && done,
      next: errorCode_ ? (req.next ?? null) : (done ? null : next),
      error_code: errorCode_,
      reads: reads_,
      undated,
      items: errorCode_ ? [] : items,
    };
  }

  if (req.lane === "email_group_posts") {
    const s = await selectedSource(reads, req.mailbox, "group");
    const ids = batch(req);
    const groupId = await reads.resolveGroupId(s.email);
    reads_++;
    if (!groupId) throw new CensusRefusal("group_not_found");
    const items: Record<string, unknown>[] = [];
    const done: string[] = [];
    const failed: Record<string, string> = {};
    for (const conv of ids) {
      if (over()) break;
      const mine: Record<string, unknown>[] = [];
      try {
        let tNext: string | null = null;
        let tStarted = false;
        while (!tStarted || tNext) {
          tStarted = true;
          const threads = await reads.listGroupThreads(groupId, conv, tNext);
          reads_++;
          for (const th of threads.items) {
            let pNext: string | null = null;
            let pStarted = false;
            while (!pStarted || pNext) {
              pStarted = true;
              const posts = await reads.listGroupPosts(groupId, th.id, pNext);
              reads_++;
              for (const p of posts.items) {
                const at = ms(p.receivedDateTime);
                if (!p.id || !inWindow(at)) continue;
                mine.push({
                  id: p.id,
                  key: readerKey(s.email, p.id, p.internetMessageId),
                  at: p.receivedDateTime,
                  folder: "group",
                  read_by_capture: true,
                  conversation_id: conv,
                  thread_id: th.id,
                });
              }
              pNext = posts.next;
            }
          }
          tNext = threads.next;
        }
        items.push(...mine);
        done.push(conv);
      } catch (e) {
        failed[conv] = errorCode(e);
      }
    }
    const pending = ids.filter((c) => !done.includes(c));
    return {
      lane: req.lane,
      mailbox: s.email,
      ...window,
      complete: pending.length === 0,
      done,
      pending,
      failed,
      reads: reads_,
      items,
    };
  }

  if (req.lane === "ghl_conversations") {
    const items: Record<string, unknown>[] = [];
    let cursor: number | null = req.next ? Number(req.next) : null;
    if (cursor !== null && !Number.isFinite(cursor)) {
      throw new CensusRefusal("next_invalid");
    }
    let done = false;
    let undated = 0;
    let started = false;
    let errorCode_: string | null = null;
    try {
      while (!done) {
        if (started && over()) break;
        started = true;
        const page = await reads.ghlConversations({
          limit: POLICY.ghlConversationPage,
          startAfterMs: cursor,
        });
        reads_++;
        let oldest: number | null = null;
        for (const c of page) {
          if (c.lastMessageMs === null) {
            undated++;
            items.push({ id: c.id, contact: !!c.contactId, last_at: null });
            continue;
          }
          if (oldest === null || c.lastMessageMs < oldest) {
            oldest = c.lastMessageMs;
          }
          if (c.lastMessageMs < w.fromMs) {
            done = true;
            continue;
          }
          items.push({
            id: c.id,
            contact: !!c.contactId,
            last_at: iso(c.lastMessageMs),
          });
        }
        if (page.length < POLICY.ghlConversationPage || oldest === null) {
          done = true;
        } else if (!done) {
          // Re-list the boundary time (GHL answers strictly older), so a tie
          // across pages is never skipped; the caller drops repeats. A page
          // that is all one time steps past it.
          const nextCursor = oldest + 1;
          cursor = cursor !== null && nextCursor >= cursor
            ? oldest
            : nextCursor;
        }
      }
    } catch (e) {
      errorCode_ = errorCode(e);
    }
    return {
      lane: req.lane,
      ...window,
      complete: !errorCode_ && done,
      next: done && !errorCode_
        ? null
        : (cursor === null ? null : String(cursor)),
      error_code: errorCode_,
      reads: reads_,
      undated,
      items,
    };
  }

  // ghl_messages
  const ids = batch(req);
  const items: Record<string, unknown>[] = [];
  const done: string[] = [];
  const failed: Record<string, string> = {};
  for (const conv of ids) {
    if (over()) break;
    const mine: Record<string, unknown>[] = [];
    try {
      let last: string | null = null;
      let finished = false;
      for (
        let page = 0;
        page < POLICY.maxMessagePagesPerConversation && !finished;
        page++
      ) {
        const got = await reads.ghlMessages(conv, {
          limit: POLICY.ghlMessagePage,
          lastMessageId: last,
        });
        reads_++;
        let oldest: number | null = null;
        for (const m of got.items) {
          const at = ms(m.dateAdded);
          if (at !== null && (oldest === null || at < oldest)) oldest = at;
          if (!inWindow(at)) continue;
          mine.push({
            id: m.id,
            conversation_id: m.conversationId ?? conv,
            contact: !!m.contactId,
            type: m.messageType,
            kind: ghlKind(m.messageType),
            direction: m.direction,
            status: m.status,
            at: m.dateAdded,
          });
        }
        const more = got.nextPage === true ||
          (got.nextPage === null && got.items.length >= POLICY.ghlMessagePage);
        if (
          !more || !got.lastMessageId || got.lastMessageId === last ||
          (oldest !== null && oldest < w.fromMs)
        ) {
          finished = true;
        }
        last = got.lastMessageId;
      }
      if (!finished) {
        failed[conv] = "too_many_pages";
        continue;
      }
      items.push(...mine);
      done.push(conv);
    } catch (e) {
      failed[conv] = errorCode(e);
    }
  }
  const pending = ids.filter((c) => !done.includes(c));
  return {
    lane: req.lane,
    ...window,
    complete: pending.length === 0,
    done,
    pending,
    failed,
    reads: reads_,
    items,
  };
}

/**
 * Each listed message or post, read whole inside this function and passed
 * through the email reader's own row builder with the reader's own context.
 * Answers the builder's verdict only: "row" (the reader would save it, under
 * this key) or the skip rule that drops it, and the sender kind. The words,
 * subject and addresses never leave the function.
 */
async function explain(
  reads: CensusReads,
  req: CensusRequest,
  over: () => boolean,
): Promise<Record<string, unknown>> {
  const list = Array.isArray(req.items) ? req.items : [];
  if (list.length === 0) throw new CensusRefusal("items_required");
  if (list.length > POLICY.maxBatch) throw new CensusRefusal("batch_too_large");
  const sources = await reads.sources();
  const byEmail = new Map(
    sources.map((s) => [s.email.trim().toLowerCase(), s]),
  );
  for (const it of list) {
    const s = byEmail.get(String(it?.mailbox ?? "").trim().toLowerCase());
    if (!s) throw new CensusRefusal("mailbox_not_monitored");
    if (typeof it.id !== "string" || !it.id || it.id.length > 512) {
      throw new CensusRefusal("items_invalid");
    }
    if (s.kind === "group" && typeof it.thread_id !== "string") {
      throw new CensusRefusal("thread_id_required");
    }
  }
  const ctx = await reads.explainContext();
  const groupIds = new Map<string, string | null>();
  const answers: Record<string, unknown>[] = [];
  const pending: string[] = [];
  for (const it of list) {
    if (over()) {
      pending.push(it.id);
      continue;
    }
    const s = byEmail.get(it.mailbox.trim().toLowerCase())!;
    const source: OutlookSource = {
      email: s.email,
      sourceKey: s.source_key,
      kind: s.kind === "group" ? "group" : "user",
      scopeLabel: s.scope_label,
      ownerPrivacy: s.owner_privacy === true,
    };
    try {
      let item: OutlookMailItem;
      if (source.kind === "group") {
        if (!groupIds.has(s.email)) {
          groupIds.set(s.email, await reads.resolveGroupId(s.email));
        }
        const g = groupIds.get(s.email);
        if (!g) throw new CensusRefusal("group_not_found");
        item = await reads.postItem(g, String(it.thread_id), it.id);
      } else {
        item = await reads.mailItem(s.email, it.id);
      }
      const built = buildOutlookMailRow(item, source, {
        source: "outlook-mail-capture",
        captureMode: "live",
        supplierDomains: ctx.supplierDomains,
        builderSenders: ctx.builderSenders,
        jobClientEmails: ctx.jobClientEmails,
        builderRefPrefixes: ctx.prefixes,
      });
      answers.push(
        built.kind === "row"
          ? {
            mailbox: s.email,
            id: it.id,
            verdict: "row",
            key: built.row.provider_message_id,
            event_type: built.row.event_type,
            sender_kind: built.senderKind,
          }
          : {
            mailbox: s.email,
            id: it.id,
            verdict: built.reason,
            key: readerKey(s.email, it.id, item.internetMessageId ?? null),
            sender_kind: built.senderKind ?? null,
          },
      );
    } catch (e) {
      answers.push({
        mailbox: s.email,
        id: it.id,
        verdict: "unreadable",
        error_code: errorCode(e),
      });
    }
  }
  return {
    lane: "email_explain",
    complete: pending.length === 0,
    pending,
    items: answers,
  };
}
