// MakeSafe admin@ Sent-Items MIRROR (W3-A hybrid loop, backend half).
//
// The ses@ inbound group mirror (monitor-ses-makesafes) is the make-safe email
// store's only historical writer. Backend SEND-attribution needs the OTHER side of
// the conversation — our outbound pack sends — which live in the admin@ mailbox's
// Sent Items folder. This module mirrors that folder into the SAME `emails` store,
// tagged folder='sentitems', so the cheap pass (makesafe_story) can attribute a
// send to a card without a live mailbox search.
//
// Design mirrors the existing sync's shape: per-mailbox watermark in
// mail_sync_cursors (overlapping lower bound, never a strict >), idempotent upsert
// on emails.post_id (the Graph message id), an append-only email_events_raw audit
// row per newly-seen message, and a 90-day bounded backfill on the first run.
//
// PURE mappers + window logic below are unit-tested; the DB action takes an
// INJECTED `fetchSentMessages` (the Graph traversal) so tests stub the network.
// The action NEVER sends, advances a substatus, or touches invoices — it only
// mirrors mail into the store (read-of-Graph, write-to-emails).

// deno-lint-ignore-file no-explicit-any

import { ADMIN_SENT_MAILBOX, SENT_FOLDER } from "./makesafe_story.ts";

export { ADMIN_SENT_MAILBOX, SENT_FOLDER };

// 90-day bounded backfill on first run (no cursor). Also the hard floor for every
// incremental window, so a corrupt/way-back cursor can never widen the scan.
export const SENT_BACKFILL_DAYS = 90;

// Default overlap window (seconds) applied to the cursor as an overlapping lower
// bound, so a message whose received time is at/just-before the last max is never
// dropped. Matches the sync engine's 900s default.
export const SENT_OVERLAP_SECONDS = 900;

const DAY_MS = 86_400_000;

// A Graph mailbox message (the subset the Sent-Items read $selects). Shape-tolerant
// to Graph's `from`/`toRecipients` envelopes.
export interface GraphSentMessage {
  id: string;
  internetMessageId?: string | null;
  conversationId?: string | null;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  hasAttachments?: boolean | null;
  from?: { emailAddress?: { address?: string | null; name?: string | null } } | null;
  sender?: { emailAddress?: { address?: string | null; name?: string | null } } | null;
  toRecipients?: Array<{ emailAddress?: { address?: string | null } }> | null;
  ccRecipients?: Array<{ emailAddress?: { address?: string | null } }> | null;
  body?: { contentType?: string | null; content?: string | null } | null;
}

// ── the incremental / backfill window ─────────────────────────────────────────
// First run (no cursor): reach back the bounded backfill (90 days). Subsequent
// runs: the cursor minus the overlap, but never earlier than the 90-day floor. The
// lower bound is always >= (now - backfillDays), so a corrupt cursor cannot widen
// the scan past the retention floor.
export function computeSentWindow(
  lastCompletedMax: string | null | undefined,
  nowIso: string,
  opts: { backfillDays?: number; overlapSeconds?: number } = {},
): { sinceIso: string; initialBackfill: boolean } {
  const backfillDays = opts.backfillDays ?? SENT_BACKFILL_DAYS;
  const overlapSeconds = opts.overlapSeconds ?? SENT_OVERLAP_SECONDS;
  const nowMs = Date.parse(nowIso);
  const floorMs = nowMs - backfillDays * DAY_MS;
  const lastMs = lastCompletedMax ? Date.parse(lastCompletedMax) : NaN;
  const initialBackfill = Number.isNaN(lastMs);
  const baseMs = initialBackfill ? floorMs : lastMs - overlapSeconds * 1000;
  const sinceMs = Math.max(baseMs, floorMs);
  return { sinceIso: new Date(sinceMs).toISOString(), initialBackfill };
}

// ── message -> emails row ─────────────────────────────────────────────────────
function addressOf(
  holder: { emailAddress?: { address?: string | null; name?: string | null } } | null | undefined,
): { address: string | null; name: string | null } {
  const ea = holder?.emailAddress;
  return { address: ea?.address ?? null, name: ea?.name ?? null };
}

// Join every to/cc recipient address into the `to_recipients` text column (the
// Sent mirror populates this — unlike the group mirror, which leaves it null — so
// the send-attribution classifier can test for an external recipient).
export function recipientsString(msg: GraphSentMessage): string | null {
  const out: string[] = [];
  for (const list of [msg.toRecipients, msg.ccRecipients]) {
    for (const r of list ?? []) {
      const a = r?.emailAddress?.address;
      if (a) out.push(String(a));
    }
  }
  const seen = new Set<string>();
  const deduped = out.filter((a) => {
    const k = a.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return deduped.length ? deduped.join(", ") : null;
}

// Map a Graph Sent message to an `emails` upsert row (folder-tagged). received_at
// prefers sentDateTime (when it left our mailbox) and falls back to receivedDateTime.
export function mapSentMessageToEmailRow(
  msg: GraphSentMessage,
  nowIso: string,
): Record<string, any> {
  const from = addressOf(msg.from ?? msg.sender);
  const receivedAt = msg.sentDateTime || msg.receivedDateTime || null;
  return {
    post_id: msg.id,
    mailbox: ADMIN_SENT_MAILBOX,
    folder: SENT_FOLDER,
    internet_message_id: msg.internetMessageId || null,
    conversation_id: msg.conversationId || null,
    thread_id: null,
    from_email: from.address,
    from_name: from.name,
    to_recipients: recipientsString(msg),
    subject: msg.subject ?? null,
    body_preview: msg.bodyPreview ?? null,
    body_content: msg.body?.content ?? null,
    body_content_type: msg.body?.contentType ?? null,
    received_at: receivedAt,
    has_attachments: !!msg.hasAttachments,
    content_sha256: null,
    updated_at: nowIso,
  };
}

// The freshest received_at across a batch (drives the cursor advance).
export function maxReceivedAt(msgs: GraphSentMessage[]): string | null {
  let max: string | null = null;
  for (const m of msgs) {
    const r = m.sentDateTime || m.receivedDateTime || null;
    if (r && (max === null || r > max)) max = r;
  }
  return max;
}

export interface SentMirrorDeps {
  // The Graph traversal, injected so tests stub the network: fetch every Sent-Items
  // message with received/sent time >= sinceIso (paginated, bounded by the caller).
  fetchSentMessages: (sinceIso: string) => Promise<GraphSentMessage[]>;
  nowIso?: string;
  backfillDays?: number;
  overlapSeconds?: number;
}

export interface SentMirrorResult {
  mailbox: string;
  folder: string;
  since: string;
  initial_backfill: boolean;
  fetched: number;
  upserted: number;
  new_events: number;
  cursor_advanced_to: string | null;
}

// ── DB action: mirror the admin@ Sent-Items folder into `emails` ──────────────
// Idempotent: the emails upsert conflict-targets post_id, and an email_events_raw
// 'created' audit row is inserted ONLY for messages not already in the store. The
// watermark advances to the freshest received message so the next run is
// incremental. FAIL-CLOSED reads: a DB error throws (the caller returns 500) rather
// than persist a half-mirrored state or a wrongly-advanced cursor.
export async function makesafeSentMirror(
  client: any,
  deps: SentMirrorDeps,
): Promise<SentMirrorResult> {
  const nowIso = deps.nowIso ?? new Date().toISOString();

  // Read the per-mailbox watermark (reuses the sync engine's cursor table).
  const { data: cursorRow, error: cursorErr } = await client.from("mail_sync_cursors")
    .select("last_completed_max, overlap_seconds")
    .eq("mailbox", ADMIN_SENT_MAILBOX)
    .maybeSingle();
  if (cursorErr) throw new Error(`mail_sync_cursors read failed: ${cursorErr.message}`);
  const overlapSeconds = deps.overlapSeconds ??
    (cursorRow?.overlap_seconds ?? SENT_OVERLAP_SECONDS);

  const { sinceIso, initialBackfill } = computeSentWindow(
    cursorRow?.last_completed_max ?? null,
    nowIso,
    { backfillDays: deps.backfillDays, overlapSeconds },
  );

  const messages = await deps.fetchSentMessages(sinceIso);

  let upserted = 0;
  let newEvents = 0;
  if (messages.length) {
    const ids = messages.map((m) => m.id).filter(Boolean);
    // Which of these are already in the store (so the audit event is written ONCE
    // per message, never re-appended on a re-mirror of the same window).
    const { data: existing, error: existErr } = await client.from("emails")
      .select("post_id")
      .in("post_id", ids);
    if (existErr) throw new Error(`emails (existing post_ids) read failed: ${existErr.message}`);
    const existingIds = new Set((existing || []).map((e: any) => e.post_id));

    const rows = messages.map((m) => mapSentMessageToEmailRow(m, nowIso));
    const { error: upsertErr } = await client.from("emails")
      .upsert(rows, { onConflict: "post_id" });
    if (upsertErr) throw new Error(`emails upsert (sent mirror) failed: ${upsertErr.message}`);
    upserted = rows.length;

    const newRows = messages.filter((m) => m.id && !existingIds.has(m.id));
    if (newRows.length) {
      const events = newRows.map((m) => ({
        mailbox: ADMIN_SENT_MAILBOX,
        post_id: m.id,
        change_type: "created",
        received_at: m.sentDateTime || m.receivedDateTime || null,
        conversation_id: m.conversationId || null,
        page_meta: { source: "admin_sent_mirror", folder: SENT_FOLDER },
      }));
      const { error: evErr } = await client.from("email_events_raw").insert(events);
      if (evErr) throw new Error(`email_events_raw insert (sent mirror) failed: ${evErr.message}`);
      newEvents = events.length;
    }
  }

  // Advance the watermark to the freshest message seen (overlap keeps the next run
  // from dropping a boundary message). Unlike the ses@ initial backfill — which
  // deliberately does NOT advance so a full catch-up re-runs — the Sent mirror's
  // first run IS the bounded 90-day backfill, so advancing is correct.
  const maxReceived = maxReceivedAt(messages);
  if (maxReceived) {
    const { error: curErr } = await client.from("mail_sync_cursors").upsert({
      mailbox: ADMIN_SENT_MAILBOX,
      last_completed_max: maxReceived,
      overlap_seconds: overlapSeconds,
      updated_at: nowIso,
    }, { onConflict: "mailbox" });
    if (curErr) throw new Error(`mail_sync_cursors upsert (sent mirror) failed: ${curErr.message}`);
  }

  return {
    mailbox: ADMIN_SENT_MAILBOX,
    folder: SENT_FOLDER,
    since: sinceIso,
    initial_backfill: initialBackfill,
    fetched: messages.length,
    upserted,
    new_events: newEvents,
    cursor_advanced_to: maxReceived,
  };
}

// ── real Graph traversal (used by the ops-api wiring; NOT unit-tested) ────────
// Paginated GET of the admin@ Sent-Items folder, received/sent >= sinceIso. Reuses
// the shared graphFetch (app-only token + 401 refresh); bounded page budget so a
// runaway nextLink chain can never loop forever.
export interface GraphSentFetchDeps {
  getGraphToken: (opts?: { forceRefresh?: boolean }) => Promise<string>;
  graphFetch: (
    url: string,
    token: string,
    opts?: { init?: RequestInit; refresh?: () => Promise<string> },
  ) => Promise<Response>;
  mailbox?: string;
  maxPages?: number;
}

export async function fetchAdminSentMessages(
  sinceIso: string,
  deps: GraphSentFetchDeps,
): Promise<GraphSentMessage[]> {
  const GRAPH = "https://graph.microsoft.com/v1.0";
  const mailbox = deps.mailbox ?? ADMIN_SENT_MAILBOX;
  const maxPages = deps.maxPages ?? 100;
  const token = await deps.getGraphToken();
  const refresh = () => deps.getGraphToken({ forceRefresh: true });

  const select =
    "id,internetMessageId,conversationId,receivedDateTime,sentDateTime,from,sender," +
    "toRecipients,ccRecipients,subject,bodyPreview,hasAttachments,body";
  const filter = encodeURIComponent(`receivedDateTime ge ${sinceIso}`);
  let url: string | null =
    `${GRAPH}/users/${encodeURIComponent(mailbox)}/mailFolders/sentItems/messages` +
    `?$filter=${filter}&$top=50&$select=${select}&$orderby=receivedDateTime desc`;

  const out: GraphSentMessage[] = [];
  for (let page = 0; page < maxPages && url; page++) {
    const res = await deps.graphFetch(url, token, { refresh });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`admin@ sentItems fetch failed: ${res.status} ${bodyText.slice(0, 200)}`);
    }
    const data = await res.json();
    for (const m of (data?.value ?? []) as GraphSentMessage[]) {
      if (m?.id) out.push(m);
    }
    url = (data?.["@odata.nextLink"] as string | undefined) ?? null;
  }
  return out;
}
