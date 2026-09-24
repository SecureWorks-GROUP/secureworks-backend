// Test support for the legacy call pairing (slice T1): a stand-in for the two
// PostgREST reads pairLegacyCall makes on business_events, answering with the
// filters it sends (event type, contact, the quoted time window, the claimed
// legacy id). Nothing in a deployed function imports this file.

export interface StoredEvent {
  id?: string;
  event_type: string;
  contact_id?: string | null;
  event_at?: string | null;
  occurred_at?: string | null;
  provider_message_id?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface LegacyCallClientOptions {
  /** Answer every read with this PostgREST error. */
  error?: { code: string; message: string };
  /** Throw from the read instead of answering. */
  throws?: boolean;
}

export interface LegacyCallQuery {
  filters: Array<[string, unknown]>;
  or: string | null;
}

function inWindow(value: string | null | undefined, from: number, to: number) {
  if (!value) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && at >= from && at <= to;
}

/** A client whose business_events reads filter `events` the way PostgREST would for these queries. */
export function legacyCallClient(
  events: StoredEvent[],
  opts: LegacyCallClientOptions = {},
) {
  const queries: LegacyCallQuery[] = [];
  const client = {
    from(table: string) {
      if (table !== "business_events") {
        throw new Error(`unexpected table ${table}`);
      }
      const q: LegacyCallQuery = { filters: [], or: null };
      queries.push(q);
      let limit = Infinity;
      const run = () => {
        if (opts.throws) throw new Error("network down");
        if (opts.error) return { data: null, error: opts.error };
        let rows = events.filter((e) =>
          q.filters.every(([k, v]) => {
            if (k === "payload->>legacy_event_id") {
              return e.payload?.legacy_event_id === v;
            }
            return (e as unknown as Record<string, unknown>)[k] === v;
          })
        );
        if (q.or) {
          const times = [...q.or.matchAll(/"([^"]+)"/g)].map((m) =>
            Date.parse(m[1])
          );
          const [from, to] = times;
          rows = rows.filter((e) =>
            e.event_at
              ? inWindow(e.event_at, from, to)
              : inWindow(e.occurred_at, from, to)
          );
        }
        return { data: rows.slice(0, limit), error: null };
      };
      // deno-lint-ignore no-explicit-any
      const builder: any = {
        select: () => builder,
        eq: (k: string, v: unknown) => (q.filters.push([k, v]), builder),
        or: (expr: string) => ((q.or = expr), builder),
        limit: (n: number) => ((limit = n), builder),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          try {
            return Promise.resolve(run()).then(res, rej);
          } catch (e) {
            return Promise.reject(e).then(res, rej);
          }
        },
      };
      return builder;
    },
  };
  return { client, queries };
}
