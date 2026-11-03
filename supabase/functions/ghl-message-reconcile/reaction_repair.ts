// The reaction repair (C7, 3 Nov 2026): one operator pass that saves the GHL
// text reactions capture skipped before reactions were captured (until then
// the row builder skipped TYPE_SMS_REACTION as unsupported_type). It reads GHL
// itself and saves each missing reaction through the one row builder
// (_shared/evidence/ghl_message.ts) and the one SQL writer
// (public.capture_business_event), exactly as the 15-minute reconciler saves a
// text it missed. It writes reactions only: any other missing item is left to
// the reconciler and the history load.
//
// Which conversations: the ones named (conversations, up to 50: the census
// lists each miss with its conversation), or else every conversation whose
// last message is at or after `since`, newest first, as far as one call's
// time budget reaches; `next` continues the walk. Inside each conversation,
// messages added at or after `since` are read.
//
// Dry run (the default): GHL GETs and one business_events key read per
// conversation, nothing else. No row, no run row, no writer call. It answers
// what a real run would save. A real run saves each missing reaction with
// capture_mode backfill (it is history: it never wakes a read and a placement
// review rests it as unplaced instead of asking the model) and
// metadata.capture_path reaction_repair, so every repaired row can be found.
//
// Answers ids, times, codes and counts only, never words. Pure orchestration
// over injected reads and writes, like reconcile.ts.

import {
  buildGhlMessageRow,
  type GhlMessageItem,
  isReactionItem,
  REACTION_EVENT_TYPE,
} from "../_shared/evidence/ghl_message.ts";
import {
  conversationTime,
  EVENT_SOURCE,
  failureStopsRun,
  providerFailure,
  type ReconcileDeps,
  safeCode,
  stopCode,
} from "./reconcile.ts";

export const REPAIR = {
  /** How far back `since` may reach (the census's own limit). */
  maxAgeMs: 40 * 86_400_000,
  maxConversations: 50,
  listPageLimit: 50,
  messagePageLimit: 50,
  maxMessagePagesPerConversation: 20,
  /** One call stops starting new conversations after this (edge wall clock 150 s). */
  timeBudgetMs: 100_000,
  /** Reactions listed in one answer; the counts always cover all of them. */
  maxListed: 300,
} as const;

export type RepairPolicy = { readonly [K in keyof typeof REPAIR]: number };

/** metadata.capture_path of a repaired row. */
export const REPAIR_CAPTURE_PATH = "reaction_repair";

export type RepairDeps = Pick<
  ReconcileDeps,
  | "now"
  | "itemFlagOn"
  | "captureLaneOn"
  | "listRecentConversations"
  | "listMessages"
  | "existingKeys"
  | "capture"
>;

export interface RepairRequest {
  dryRun: boolean;
  sinceMs: number;
  conversations: { contactId: string; conversationId: string }[] | null;
  /** Sweep continuation: re-list conversations at or before this time. */
  next: number | null;
}

const ID = /^[A-Za-z0-9_-]{6,64}$/;

/** The request, or the code it is refused with. */
export function parseRepairRequest(
  body: Record<string, unknown>,
  nowMs: number,
): { ok: true; request: RepairRequest } | { ok: false; code: string } {
  const since = typeof body.since === "string" ? Date.parse(body.since) : NaN;
  if (!Number.isFinite(since)) return { ok: false, code: "since_required" };
  if (since > nowMs) return { ok: false, code: "since_in_future" };
  if (since < nowMs - REPAIR.maxAgeMs) {
    return { ok: false, code: "since_too_old" };
  }
  let conversations: RepairRequest["conversations"] = null;
  if (body.conversations !== undefined) {
    const list = body.conversations;
    if (
      !Array.isArray(list) || list.length === 0 ||
      list.length > REPAIR.maxConversations
    ) {
      return { ok: false, code: "conversations_invalid" };
    }
    conversations = [];
    const seen = new Set<string>();
    for (const entry of list) {
      const c = entry as Record<string, unknown> | null;
      const contactId = typeof c?.contact_id === "string" ? c.contact_id : "";
      const conversationId = typeof c?.conversation_id === "string"
        ? c.conversation_id
        : "";
      if (!ID.test(contactId) || !ID.test(conversationId)) {
        return { ok: false, code: "conversations_invalid" };
      }
      if (seen.has(conversationId)) continue;
      seen.add(conversationId);
      conversations.push({ contactId, conversationId });
    }
  }
  let next: number | null = null;
  if (body.next !== undefined && body.next !== null) {
    if (conversations) return { ok: false, code: "next_with_conversations" };
    if (typeof body.next !== "string" || !/^\d{1,15}$/.test(body.next)) {
      return { ok: false, code: "next_invalid" };
    }
    next = Number(body.next);
  }
  return {
    ok: true,
    request: {
      dryRun: body.dry_run !== false,
      sinceMs: since,
      conversations,
      next,
    },
  };
}

export interface RepairedReaction {
  key: string;
  conversation_id: string | null;
  at: string | null;
  /** exists: already saved; would_write: a dry run would save it; inserted, duplicate, error: a real run. */
  result: "exists" | "would_write" | "inserted" | "duplicate" | "error";
  reacted_to_match: string | null;
  reacted_to_key: string | null;
  code?: string;
}

export type RepairResult =
  | { outcome: "idle"; reason: "item_flag_off" | "capture_lane_off" }
  | {
    outcome: "ran";
    dry_run: boolean;
    since: string;
    complete: boolean;
    next: string | null;
    error_code: string | null;
    counts: Record<string, number>;
    reactions: RepairedReaction[];
  };

const COUNT_KEYS = [
  "conversations_listed",
  "conversations_read",
  "conversations_unreadable",
  "conversations_no_date",
  "message_pages",
  "message_pages_capped",
  "items_seen",
  "reactions_seen",
  "reactions_existing",
  "reactions_to_write",
  "inserted",
  "duplicates",
  "write_errors",
  "skipped_no_id",
  "skipped_no_contact",
  "skipped_no_direction",
  "reacted_to_found",
  "reacted_to_not_found",
  "reactions_not_listed",
] as const;
type CountKey = typeof COUNT_KEYS[number];

function ms(value: unknown): number | null {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : null;
}

/** One repair call. Never throws on a provider or writer refusal: it stops and answers the code. */
export async function runGhlReactionRepair(
  deps: RepairDeps,
  req: RepairRequest,
  policy: RepairPolicy = REPAIR,
): Promise<RepairResult> {
  if (!(await deps.itemFlagOn())) {
    return { outcome: "idle", reason: "item_flag_off" };
  }
  if (!(await deps.captureLaneOn())) {
    return { outcome: "idle", reason: "capture_lane_off" };
  }
  const started = deps.now();
  const over = () => deps.now() - started > policy.timeBudgetMs;
  const counts = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as Record<
    CountKey,
    number
  >;
  const reactions: RepairedReaction[] = [];
  let stop: string | null = null;
  let incomplete = false;

  const listed = (r: RepairedReaction) => {
    if (reactions.length < policy.maxListed) reactions.push(r);
    else counts.reactions_not_listed++;
  };

  /** Read one conversation back to `since` and save (or list) its missing reactions. */
  const repairConversation = async (
    contactId: string,
    conversationId: string,
  ): Promise<void> => {
    const items: Record<string, unknown>[] = [];
    let lastMessageId: string | undefined;
    for (let page = 0;; page++) {
      if (page >= policy.maxMessagePagesPerConversation) {
        counts.message_pages_capped++;
        incomplete = true;
        break;
      }
      let read;
      try {
        read = await deps.listMessages({
          contactId,
          conversationId,
          limit: policy.messagePageLimit,
          lastMessageId,
        });
      } catch (error) {
        const f = providerFailure(error);
        if (failureStopsRun(f)) {
          stop = stopCode(f);
          return;
        }
        counts.conversations_unreadable++;
        incomplete = true;
        return;
      }
      counts.message_pages++;
      items.push(...read.messages);
      const oldest = read.messages.reduce<number | null>((min, m) => {
        const t = ms(m.dateAdded);
        return t === null ? min : min === null ? t : Math.min(min, t);
      }, null);
      const more = read.messages.length > 0 && read.hasMore !== false &&
        !(oldest !== null && oldest < req.sinceMs);
      if (!more) break;
      if (!read.nextLastMessageId) {
        // GHL said there is more but gave no cursor: what is left is unread.
        counts.message_pages_capped++;
        incomplete = true;
        break;
      }
      lastMessageId = read.nextLastMessageId;
    }
    counts.conversations_read++;
    counts.items_seen += items.length;

    const rows: { row: Record<string, unknown>; at: string | null }[] = [];
    for (const item of items) {
      if (!isReactionItem(item as GhlMessageItem)) continue;
      const at = ms(item.dateAdded);
      if (at !== null && at < req.sinceMs) continue;
      counts.reactions_seen++;
      const built = buildGhlMessageRow(item as GhlMessageItem, {
        source: EVENT_SOURCE,
        captureMode: "backfill",
        inHand: items as GhlMessageItem[],
      });
      if (built.kind === "skip") {
        const key = `skipped_${built.reason}` as CountKey;
        if (key in counts) counts[key]++;
        continue;
      }
      if (built.row.event_type !== REACTION_EVENT_TYPE) continue;
      built.row.metadata = {
        ...(built.row.metadata as Record<string, unknown>),
        capture_path: REPAIR_CAPTURE_PATH,
      };
      const reaction = (built.row.payload as Record<string, unknown>)
        .reaction as Record<string, unknown>;
      if (reaction.reacted_to_match === "quoted_text") {
        counts.reacted_to_found++;
      } else counts.reacted_to_not_found++;
      rows.push({ row: built.row, at: (built.row.event_at as string) ?? null });
    }
    if (!rows.length) return;

    let existing = new Set<string>();
    try {
      existing = await deps.existingKeys(
        rows.map((r) => String(r.row.provider_message_id)),
      );
    } catch {
      if (req.dryRun) {
        // A dry run that cannot tell saved from missing answers nothing for this conversation.
        counts.conversations_unreadable++;
        incomplete = true;
        return;
      }
      // The writer is idempotent: a real run still saves each row once.
    }
    for (const { row, at } of rows) {
      const key = String(row.provider_message_id);
      const reaction = (row.payload as Record<string, unknown>)
        .reaction as Record<string, unknown>;
      const base = {
        key,
        conversation_id: (row.conversation_key as string | null) ?? null,
        at,
        reacted_to_match: (reaction.reacted_to_match as string) ?? null,
        reacted_to_key: (reaction.reacted_to_key as string | null) ?? null,
      };
      if (existing.has(key)) {
        counts.reactions_existing++;
        listed({ ...base, result: "exists" });
        continue;
      }
      if (req.dryRun) {
        counts.reactions_to_write++;
        listed({ ...base, result: "would_write" });
        continue;
      }
      const out = await deps.capture(row);
      if (out.outcome === "inserted") {
        counts.inserted++;
        listed({ ...base, result: "inserted" });
      } else if (out.outcome === "duplicate") {
        counts.duplicates++;
        listed({ ...base, result: "duplicate" });
      } else if (out.outcome === "capture_disabled") {
        stop = "capture_disabled";
        return;
      } else {
        counts.write_errors++;
        incomplete = true;
        listed({
          ...base,
          result: "error",
          code: safeCode(out.code, "unknown"),
        });
      }
    }
  };

  let next: number | null = null;
  if (req.conversations) {
    for (const c of req.conversations) {
      if (stop) break;
      if (over()) {
        incomplete = true;
        stop ??= "time_budget";
        break;
      }
      await repairConversation(c.contactId, c.conversationId);
    }
  } else {
    // Newest first from the cursor, down to `since`. GHL lists strictly older
    // than startAfterDate, so the boundary time is re-listed (cursor = time +
    // 1) and conversations already read in this call are skipped.
    let cursor: number | null = req.next;
    const seen = new Set<string>();
    let done = false;
    sweep: while (!done) {
      if (over()) {
        next = cursor;
        incomplete = true;
        break;
      }
      let page;
      try {
        page = await deps.listRecentConversations({
          limit: policy.listPageLimit,
          startAfterDate: cursor === null ? undefined : String(cursor),
        });
      } catch (error) {
        stop = stopCode(providerFailure(error));
        next = cursor;
        break;
      }
      let oldest: number | null = null;
      let fresh = 0;
      for (const conv of page.conversations) {
        const last = conversationTime(conv);
        if (last !== null) {
          oldest = oldest === null ? last : Math.min(oldest, last);
        }
        const id = typeof conv.id === "string" ? conv.id : null;
        const contactId = typeof conv.contactId === "string"
          ? conv.contactId
          : null;
        if (!id || !contactId || seen.has(id)) continue;
        if (last !== null && last < req.sinceMs) {
          // Newest first: every conversation after this one is older still.
          done = true;
          break;
        }
        if (over()) {
          // Resume here: re-list everything at or before this conversation's time.
          next = last === null ? cursor : last + 1;
          incomplete = true;
          break sweep;
        }
        seen.add(id);
        fresh++;
        counts.conversations_listed++;
        if (last === null) counts.conversations_no_date++;
        await repairConversation(contactId, id);
        if (stop) {
          next = last === null ? cursor : last + 1;
          break sweep;
        }
      }
      if (
        done || page.hasMore === false ||
        page.conversations.length < policy.listPageLimit || oldest === null
      ) {
        done = true;
        break;
      }
      // Re-list the boundary time; a page of repeats only steps past it.
      const step = fresh === 0 ? oldest : oldest + 1;
      if (step === cursor) {
        // The list did not move (the provider ignored the cursor): stop, never loop.
        stop = "list_cursor_stuck";
        next = cursor;
        break;
      }
      cursor = step;
    }
    if (done) next = null;
  }

  return {
    outcome: "ran",
    dry_run: req.dryRun,
    since: new Date(req.sinceMs).toISOString(),
    complete: !stop && !incomplete && next === null,
    next: next === null ? null : String(next),
    error_code: stop,
    counts,
    reactions,
  };
}
