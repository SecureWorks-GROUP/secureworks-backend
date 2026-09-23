// deno-lint-ignore-file no-explicit-any
//
// Context slice R0 (23 Sep 2026): the job conversation's inbox block stops
// showing the old monitor-inbox matcher's guess wherever the ladder has decided.
//
// monitor-inbox writes every email twice: an `inbox_events` row carrying the
// old matcher's guessed `job_id`, and (for client and supplier mail) a
// `business_events` copy whose job the attribution ladder decides. Before R0 the
// job read showed the inbox row on the guessed job, so an email appeared twice
// on one job, or on a job the ladder never chose. From R0:
//
//   copy placed on a job   -> the inbox row is not shown; the evidence block
//                             shows the email once, on the ladder's job;
//   copy unplaced (no job) -> depends on P4's flag `context_unlinked_rules_v1`:
//       off, missing or unreadable: the ladder has not yet run the identity,
//         address and thread rules that could place it, so the unplaced copy
//         is not a decision. The inbox row stays, labelled as the old
//         matcher's guess that the ladder has not placed (a customer email
//         such as adminbucket N1 stays visible on its job);
//       on: the ladder's answer is final and the inbox row is not shown
//         (adminbucket Review M5);
//   no copy                -> the inbox row stays, labelled as placed by the old
//                             matcher, until email slice EM-R2 removes the block.
//
// Decision: captain via Firstmate, 23 Sep 2026 (option C of the R0 decision).
//
// An inbox row and its event copy are joined by any one of three keys, all
// written by monitor-inbox (`monitor-inbox/index.ts`, business_event insert):
//   1. source pointer:  business_events.source_table = 'inbox_events' and
//                       source_id = inbox row id (every copy in production on
//                       23 Sep 2026: 3,280 of 3,280; idx_events_source_pointer);
//   2. provider key:    business_events.provider_message_id = 'graph:' ||
//                       inbox_events.graph_message_id (unique index);
//   3. payload pointer: business_events.payload->>'inbox_events_id' = inbox row
//                       id, the only key on monitor-inbox's legacy fallback
//                       insert, read together with the copy's occurred_at, which
//                       the writer sets from the same received time (equal on
//                       3,280 of 3,280), so the read stays on the occurred_at
//                       index.
// Every candidate the database returns is re-checked here against the key it
// claims, so a lookup can only ever hide an inbox row whose copy really exists.
//
// A failed lookup (PostgREST returns errors, it does not throw) hides only rows
// another lookup proved copied: every other inbox row is kept and marked
// `event_copy: 'unknown'`, so a read fault can never delete a customer email
// that exists nowhere else, and the reader can see the check did not complete.

/** Label for an inbox row with no evidence copy (adminbucket Review M5). */
export const LEGACY_INBOX_LABEL = "inbox copy, placed by the old matcher";

/** Label for an inbox row whose evidence copy the ladder has not placed. */
export const UNPLACED_INBOX_LABEL =
  "inbox copy, the old matcher's guess; the ladder has not placed it";

/** P4's flag (placement track). Missing or unreadable reads as off. */
export const UNLINKED_RULES_FLAG = "context_unlinked_rules_v1";

/** PostgREST GET URL budget: same chunk the rest of ops-api uses for id lists. */
const CHUNK = 25;

export type InboxCopyRow = {
  id: string;
  graph_message_id?: string | null;
  received_at?: string | null;
};

export type InboxCopyCheck = {
  /** false when any lookup errored; `copies` is then incomplete. */
  ok: boolean;
  /** inbox row id -> the job its business_events copy sits on (null: none). */
  copies: Map<string, string | null>;
  errors: string[];
};

export type EventCopyState = "none" | "unplaced" | "unknown";

function chunks<T>(values: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += CHUNK) {
    out.push(values.slice(i, i + CHUNK));
  }
  return out;
}

/** Same instant, whatever text form each side's timestamp was returned in. */
function sameInstant(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && ta === tb;
}

/**
 * Which of these inbox rows already have an evidence copy in business_events,
 * and on which job each copy sits. Read-only: keyed SELECTs, no writes.
 */
export async function readInboxEventCopies(
  client: any,
  rows: InboxCopyRow[],
): Promise<InboxCopyCheck> {
  const copies = new Map<string, string | null>();
  const errors: string[] = [];
  const byId = new Map<string, InboxCopyRow>();
  for (const r of rows) if (r?.id) byId.set(String(r.id), r);
  if (byId.size === 0) return { ok: true, copies, errors };

  // A copy placed on a job wins over an unplaced one if two ever exist.
  const record = (inboxId: string, jobId: unknown) => {
    const job = typeof jobId === "string" && jobId ? jobId : null;
    if (!copies.has(inboxId) || (job && !copies.get(inboxId))) {
      copies.set(inboxId, job);
    }
  };

  const ids = [...byId.keys()];
  const byGraphKey = new Map<string, string>();
  for (const r of byId.values()) {
    if (r.graph_message_id) {
      byGraphKey.set(`graph:${r.graph_message_id}`, String(r.id));
    }
  }

  const run = async (label: string, read: () => any) => {
    try {
      const { data, error } = await read();
      if (error) {
        errors.push(`${label}: ${error.message || error.code || "error"}`);
        return [];
      }
      return Array.isArray(data) ? data : [];
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  };

  for (const part of chunks(ids)) {
    // Key 1: source pointer.
    const pointer = await run(
      "source_pointer",
      () =>
        client.from("business_events")
          .select("id, job_id, source_table, source_id")
          .eq("source_table", "inbox_events")
          .in("source_id", part),
    );
    for (const b of pointer) {
      const sid = b?.source_id == null ? "" : String(b.source_id);
      if (b?.source_table === "inbox_events" && byId.has(sid)) {
        record(sid, b?.job_id);
      }
    }

    // Key 3: payload pointer, bounded by the copy's occurred_at.
    const times = [
      ...new Set(
        part.map((id) => byId.get(id)?.received_at).filter(
          (t): t is string => typeof t === "string" && t.length > 0,
        ),
      ),
    ];
    if (times.length > 0) {
      const legacy = await run(
        "payload_pointer",
        () =>
          client.from("business_events")
            .select(
              "id, job_id, occurred_at, inbox_events_id:payload->>inbox_events_id",
            )
            .in("occurred_at", times)
            .in("payload->>inbox_events_id", part),
      );
      for (const b of legacy) {
        const iid = b?.inbox_events_id == null ? "" : String(b.inbox_events_id);
        const inbox = byId.get(iid);
        if (inbox && sameInstant(b?.occurred_at, inbox.received_at)) {
          record(iid, b?.job_id);
        }
      }
    }
  }

  // Key 2: provider key.
  for (const part of chunks([...byGraphKey.keys()])) {
    const provider = await run(
      "provider_key",
      () =>
        client.from("business_events")
          .select("id, job_id, provider_message_id")
          .in("provider_message_id", part),
    );
    for (const b of provider) {
      const iid = byGraphKey.get(String(b?.provider_message_id ?? ""));
      if (iid) record(iid, b?.job_id);
    }
  }

  return { ok: errors.length === 0, copies, errors };
}

/**
 * Whether P4's rules are on. Missing, unreadable or not exactly true reads
 * as off (INTEGRATION: revise2 flags). Read-only.
 */
export async function readUnlinkedRulesOn(client: any): Promise<boolean> {
  try {
    const { data, error } = await client.from("feature_flags")
      .select("enabled, updated_at")
      .eq("flag_name", UNLINKED_RULES_FLAG)
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(1);
    if (error || !Array.isArray(data)) return false;
    return data[0]?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * The inbox rows the job conversation may show, each with its copy state.
 * See the table at the top of this file.
 */
export function legacyInboxRowsToShow<T extends InboxCopyRow>(
  rows: T[],
  check: InboxCopyCheck,
  opts: { unlinkedRulesOn: boolean },
): Array<{ row: T; event_copy: EventCopyState; label: string }> {
  const out: Array<{ row: T; event_copy: EventCopyState; label: string }> = [];
  for (const row of rows) {
    const id = String(row.id);
    // A copy that was found is proof, even when another lookup failed.
    if (check.copies.has(id)) {
      if (check.copies.get(id)) continue; // placed: the evidence block shows it
      if (opts.unlinkedRulesOn) continue; // the ladder's answer is final
      out.push({ row, event_copy: "unplaced", label: UNPLACED_INBOX_LABEL });
      continue;
    }
    out.push({
      row,
      event_copy: check.ok ? "none" : "unknown",
      label: LEGACY_INBOX_LABEL,
    });
  }
  return out;
}
