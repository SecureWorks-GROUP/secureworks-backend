// deno-lint-ignore-file no-import-prefix no-explicit-any
// getJobConversation (index.ts): every cached GoHighLevel message carries the contact
// whose thread it is, and extra_contact_ids (the Debt Workshop's neighbour payer) reads
// that payer's own thread, but ONLY when the contact is on this job's job_contacts rows.
// Synthetic data only.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _getJobConversationForTest } from "./index.ts";

const JOB = "a0000000-0000-4000-8000-0000000000f1";
const PRIMARY = "ghlprimary0000000001";
const NEIGHBOUR = "ghlneighbour00000001";
const STRANGER = "ghlstranger000000001";

const thread = (contact: string, n: number) =>
  Array.from({ length: n }, (_, k) => ({
    id: `${contact}-${k}`,
    type: "TYPE_SMS",
    direction: "inbound",
    timestamp: `2026-10-0${k + 1}T01:00:00.000Z`,
    body: `${contact} text ${k}`,
  }));

/** Read-only fake that honours eq / in filters (others pass through). */
function filteringClient(tables: Record<string, any[]>) {
  const reads: Array<{ table: string; filters: string[] }> = [];
  return {
    reads,
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      const seen: string[] = [];
      let single = false;
      const q: any = {};
      for (
        const m of [
          "select",
          "neq",
          "is",
          "gt",
          "gte",
          "lt",
          "lte",
          "ilike",
          "or",
          "not",
          "order",
          "contains",
          "range",
          "limit",
        ]
      ) q[m] = () => q;
      q.eq = (col: string, v: unknown) => {
        seen.push(`eq:${col}`);
        filters.push((r) => r[col] === v);
        return q;
      };
      q.in = (col: string, vs: unknown[]) => {
        seen.push(`in:${col}`);
        filters.push((r) => vs.includes(r[col]));
        return q;
      };
      q.maybeSingle = () => {
        single = true;
        return q;
      };
      q.single = q.maybeSingle;
      q.then = (resolve: any, reject: any) => {
        reads.push({ table, filters: seen });
        const rows = (tables[table] ?? []).filter((r) =>
          filters.every((f) => f(r))
        );
        return Promise.resolve({
          data: single ? rows[0] ?? null : rows,
          error: null,
        }).then(resolve, reject);
      };
      return q;
    },
  };
}

function tables() {
  return {
    jobs: [{ id: JOB, job_number: "SWF-90007", ghl_contact_id: PRIMARY }],
    job_contacts: [
      { job_id: JOB, ghl_contact_id: PRIMARY, status: "active" },
      { job_id: JOB, ghl_contact_id: NEIGHBOUR, status: "active" },
    ],
    ghl_conversation_cache: [
      { contact_id: PRIMARY, job_id: JOB, messages: thread(PRIMARY, 3) },
      { contact_id: NEIGHBOUR, job_id: null, messages: thread(NEIGHBOUR, 2) },
      { contact_id: STRANGER, job_id: null, messages: thread(STRANGER, 2) },
    ],
  };
}

Deno.test("conversation: cached messages carry their thread's contact; a neighbour's thread is read when asked", async () => {
  const client = filteringClient(tables());
  const plain: any = await _getJobConversationForTest(client, {
    job_id: JOB,
    limit: 50,
  });
  const cached = plain.messages.filter((m: any) =>
    m.source_system === "ghl_cache"
  );
  assertEquals(cached.length, 3);
  assert(cached.every((m: any) => m.contact_id === PRIMARY));

  const withNeighbour: any = await _getJobConversationForTest(
    filteringClient(tables()),
    { job_id: JOB, limit: 50, extra_contact_ids: [NEIGHBOUR] },
  );
  const ids = withNeighbour.messages.filter((m: any) =>
    m.source_system === "ghl_cache"
  ).map((m: any) => m.contact_id);
  assertEquals(ids.filter((c: string) => c === NEIGHBOUR).length, 2);
  assertEquals(ids.filter((c: string) => c === PRIMARY).length, 3);
});

Deno.test("conversation: a contact that is not a payer on this job is never read onto it", async () => {
  const client = filteringClient(tables());
  const res: any = await _getJobConversationForTest(client, {
    job_id: JOB,
    limit: 50,
    extra_contact_ids: [STRANGER, "bad id!"],
  });
  assert(
    !res.messages.some((m: any) => m.contact_id === STRANGER),
    "a stranger's thread leaked onto the job",
  );
  // The stranger's cache row was never read.
  assertEquals(
    client.reads.filter((r) =>
      r.table === "ghl_conversation_cache" &&
      r.filters.includes("in:contact_id")
    ).length,
    0,
  );
});
