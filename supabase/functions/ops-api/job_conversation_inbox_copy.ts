// deno-lint-ignore-file no-explicit-any
//
// Context slice R0 (23 Sep 2026): the job conversation's inbox block shows only
// legacy inbox rows that have NO evidence copy in business_events.
//
// monitor-inbox writes every email twice: an `inbox_events` row carrying the
// old matcher's guessed `job_id`, and (for client and supplier mail) a
// `business_events` copy whose job the attribution ladder decides. Before R0 the
// job read showed the inbox row on the guessed job, so an email appeared twice
// on the same job, or on a job the ladder never chose (a two-job supplier email
// shown on the first job it named). From R0 an email whose event copy exists is
// shown only from the evidence block, wherever the ladder placed it. Inbox rows
// with no event copy stay, labelled as placed by the old matcher, until email
// slice EM-R2 removes the block.
//
// An inbox row and its event copy are joined by any one of three keys, all
// written by monitor-inbox (`monitor-inbox/index.ts`, business_event insert):
//   1. source pointer:  business_events.source_table = 'inbox_events' and
//                       source_id = inbox row id (the evidence writer path);
//   2. provider key:    business_events.provider_message_id = 'graph:' ||
//                       inbox_events.graph_message_id (the same path);
//   3. payload pointer: business_events.payload->>'inbox_events_id' = inbox row
//                       id (both paths; the only key on the legacy insert),
//                       read together with the copy's occurred_at, which the
//                       writer sets from the same received time, so the read
//                       stays on the occurred_at index.
// Every candidate the database returns is re-checked here against the key it
// claims, so a lookup can only ever hide an inbox row whose copy really exists.
//
// A failed lookup (PostgREST returns errors, it does not throw) hides only rows
// another lookup proved copied: every other inbox row is kept and marked
// `event_copy: 'unknown'`, so a read fault can never delete a customer email
// that exists nowhere else, and the reader can see the check did not complete.

/** Label carried by every inbox-block row (adminbucket Review M5). */
export const LEGACY_INBOX_LABEL = "inbox copy, placed by the old matcher";

/** PostgREST GET URL budget: same chunk the rest of ops-api uses for id lists. */
const CHUNK = 25;

export type InboxCopyRow = {
  id: string;
  graph_message_id?: string | null;
  received_at?: string | null;
};

export type InboxCopyCheck = {
  /** false when any lookup errored; `copied` is then incomplete. */
  ok: boolean;
  /** inbox row ids whose business_events copy exists. */
  copied: Set<string>;
  errors: string[];
};

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
 * Which of these inbox rows already have an evidence copy in business_events.
 * Read-only: three keyed SELECTs per chunk, no writes.
 */
export async function readInboxEventCopies(
  client: any,
  rows: InboxCopyRow[],
): Promise<InboxCopyCheck> {
  const copied = new Set<string>();
  const errors: string[] = [];
  const byId = new Map<string, InboxCopyRow>();
  for (const r of rows) if (r?.id) byId.set(String(r.id), r);
  if (byId.size === 0) return { ok: true, copied, errors };

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
          .select("id, source_table, source_id")
          .eq("source_table", "inbox_events")
          .in("source_id", part),
    );
    for (const b of pointer) {
      const sid = b?.source_id == null ? "" : String(b.source_id);
      if (b?.source_table === "inbox_events" && byId.has(sid)) copied.add(sid);
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
              "id, occurred_at, inbox_events_id:payload->>inbox_events_id",
            )
            .in("occurred_at", times)
            .in("payload->>inbox_events_id", part),
      );
      for (const b of legacy) {
        const iid = b?.inbox_events_id == null ? "" : String(b.inbox_events_id);
        const inbox = byId.get(iid);
        if (inbox && sameInstant(b?.occurred_at, inbox.received_at)) {
          copied.add(iid);
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
          .select("id, provider_message_id")
          .in("provider_message_id", part),
    );
    for (const b of provider) {
      const iid = byGraphKey.get(String(b?.provider_message_id ?? ""));
      if (iid) copied.add(iid);
    }
  }

  return { ok: errors.length === 0, copied, errors };
}

/**
 * The inbox rows the job conversation may show, each with its label. A row
 * whose event copy was found is dropped (the evidence block shows it where the
 * ladder placed it); a row with none stays; when a lookup failed, every row
 * not proven copied stays, marked `unknown`.
 */
export function legacyInboxRowsToShow<T extends InboxCopyRow>(
  rows: T[],
  check: InboxCopyCheck,
): Array<{ row: T; event_copy: "none" | "unknown" }> {
  const out: Array<{ row: T; event_copy: "none" | "unknown" }> = [];
  for (const row of rows) {
    // A copy that was found is proof, even when another lookup failed.
    if (check.copied.has(String(row.id))) continue;
    out.push({ row, event_copy: check.ok ? "none" : "unknown" });
  }
  return out;
}
