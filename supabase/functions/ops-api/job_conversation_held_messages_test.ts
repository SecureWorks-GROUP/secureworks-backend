// deno-lint-ignore-file no-import-prefix no-explicit-any
// getJobConversation (index.ts) held_contact_ids, the Debt Workshop's read of the payer's
// messages held on NO job (job_conversation_timeline.ts heldConversationMessages).
//
// Live case (14 Oct 2026): a payment-chase text to the customer on 9 Oct (SWF-261098)
// sat in business_events with job_id null, attribution_status unplaced and that job as
// its ONLY candidate, so the Debt tab's conversation stopped at 1 Oct. A held message is
// read on a candidate job only for a contact the caller names (the payer's), marked
// unplaced: true, and a copy already on the job shows once. Synthetic data only.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _getJobConversationForTest } from "./index.ts";
import { heldConversationMessages } from "./job_conversation_timeline.ts";

const JOB = "a0000000-0000-4000-8000-0000000000a1";
const OTHER_JOB = "a0000000-0000-4000-8000-0000000000a2";
const PAYER = "ghlpayer000000000001";
const NEIGHBOUR = "ghlneighbour00000001";
const STRANGER = "ghlstranger000000001";

/** Read-only fake that honours eq / in / is / not-is / contains (others pass through). */
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
          "gt",
          "gte",
          "lt",
          "lte",
          "ilike",
          "or",
          "order",
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
      q.is = (col: string, v: unknown) => {
        seen.push(`is:${col}`);
        filters.push((r) => v === null ? r[col] == null : r[col] === v);
        return q;
      };
      q.not = (col: string, op: string, v: unknown) => {
        seen.push(`not:${col}`);
        if (op === "is" && v === null) filters.push((r) => r[col] != null);
        return q;
      };
      q.contains = (col: string, vs: unknown[]) => {
        seen.push(`contains:${col}`);
        filters.push((r) =>
          Array.isArray(r[col]) && vs.every((v) => r[col].includes(v))
        );
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

/** A business_events text row; held by default (on no job, this job its one candidate). */
function sms(id: string, at: string, over: Record<string, unknown> = {}) {
  return {
    id,
    event_type: "client.sms_out",
    source: "ghl-message-reconcile",
    channel: "sms",
    direction: "outbound",
    event_at: at,
    occurred_at: at,
    body_preview: `text ${id}`,
    provider_message_id: `ghl:msg-${id}`,
    payload: { body: `text ${id}` },
    contact_id: PAYER,
    entity_type: "contact",
    entity_id: PAYER,
    job_id: null,
    attribution_status: "unplaced",
    candidate_job_ids: [JOB],
    ...over,
  };
}

function tables(events: any[]) {
  return {
    jobs: [{
      id: JOB,
      job_number: "SWF-90011",
      ghl_contact_id: PAYER,
      client_email: null,
    }],
    job_contacts: [],
    ghl_conversation_cache: [],
    inbox_events: [],
    job_events: [],
    email_events: [],
    business_events: events,
  };
}

async function read(events: any[], body: Record<string, unknown>) {
  const client = filteringClient(tables(events));
  const res: any = await _getJobConversationForTest(client, {
    job_id: JOB,
    limit: 50,
    ...body,
  });
  return { res, client };
}

const ids = (res: any) => res.messages.map((m: any) => m.id);

Deno.test("held: the payer's unplaced message with this job as candidate is read, marked unplaced", async () => {
  const placed = sms("p1", "2026-10-01T02:00:00.000Z", {
    job_id: JOB,
    attribution_status: "attributed",
    candidate_job_ids: null,
  });
  const held = sms("h1", "2026-10-09T03:02:52.647Z");
  const { res } = await read([placed, held], { held_contact_ids: [PAYER] });
  assertEquals(ids(res), ["bev:h1", "bev:p1"]);
  const h = res.messages[0];
  assertEquals(h.unplaced, true);
  assertEquals(h.candidate_job_count, 1);
  assertEquals(h.contact_id, PAYER);
  assertEquals(h.body, "text h1");
  assertEquals(h.job_id, JOB);
  // The placed message is not marked.
  assertEquals(res.messages[1].unplaced, undefined);
  // pending_luna is held too.
  const pending = sms("h2", "2026-10-10T01:00:00.000Z", {
    attribution_status: "pending_luna",
  });
  const two = await read([held, pending], { held_contact_ids: [PAYER] });
  assertEquals(ids(two.res), ["bev:h2", "bev:h1"]);
});

Deno.test("held: nothing is read unless a contact is asked for (every other caller unchanged)", async () => {
  const { res, client } = await read([sms("h1", "2026-10-09T03:00:00.000Z")], {});
  assertEquals(res.messages, []);
  assertEquals(
    client.reads.filter((r) =>
      r.table === "business_events" &&
      r.filters.includes("contains:candidate_job_ids")
    ).length,
    0,
  );
  // A malformed contact id reads nothing either.
  const bad = await read([sms("h1", "2026-10-09T03:00:00.000Z")], {
    held_contact_ids: ["bad id!"],
  });
  assertEquals(bad.res.messages, []);
});

Deno.test("held: a message from another contact is not read onto the job", async () => {
  const { res } = await read([
    sms("h1", "2026-10-09T03:00:00.000Z", {
      contact_id: STRANGER,
      entity_id: STRANGER,
    }),
  ], { held_contact_ids: [PAYER] });
  assertEquals(res.messages, []);
});

Deno.test("held: a message whose candidates do not include this job is not read", async () => {
  const { res } = await read([
    sms("h1", "2026-10-09T03:00:00.000Z", { candidate_job_ids: [OTHER_JOB] }),
    // Placed on another job: never read here, whatever its candidates.
    sms("h2", "2026-10-09T04:00:00.000Z", {
      job_id: OTHER_JOB,
      attribution_status: "attributed",
      candidate_job_ids: [JOB, OTHER_JOB],
    }),
  ], { held_contact_ids: [PAYER] });
  assertEquals(res.messages, []);
});

Deno.test("held: a duplicate of a message already on the job shows once, as the placed copy", async () => {
  const placed = sms("p1", "2026-10-09T03:00:00.000Z", {
    job_id: JOB,
    attribution_status: "attributed",
    candidate_job_ids: null,
    provider_message_id: "ghl:same-message",
  });
  const copy = sms("h1", "2026-10-09T03:00:00.000Z", {
    provider_message_id: "ghl:same-message",
  });
  const { res } = await read([placed, copy], { held_contact_ids: [PAYER] });
  assertEquals(ids(res), ["bev:p1"]);
  assertEquals(res.messages[0].unplaced, undefined);
});

Deno.test("held: on a shared fence only the payer's contact counts", async () => {
  // The neighbour owes; the main client's held message stays off the payer's read.
  const fromMain = sms("h1", "2026-10-09T03:00:00.000Z");
  const fromNeighbour = sms("h2", "2026-10-08T03:00:00.000Z", {
    contact_id: NEIGHBOUR,
    entity_id: NEIGHBOUR,
  });
  const { res } = await read([fromMain, fromNeighbour], {
    held_contact_ids: [NEIGHBOUR],
  });
  assertEquals(ids(res), ["bev:h2"]);
  assertEquals(res.messages[0].contact_id, NEIGHBOUR);
  assertEquals(res.messages[0].unplaced, true);
});

Deno.test("held: the limit keeps the newest messages, held ones included", async () => {
  const placed = Array.from({ length: 6 }, (_, k) =>
    sms(`p${k}`, `2026-09-0${k + 1}T01:00:00.000Z`, {
      job_id: JOB,
      attribution_status: "attributed",
      candidate_job_ids: null,
    }));
  const held = sms("h1", "2026-10-09T03:00:00.000Z");
  const { res } = await read([...placed, held], {
    held_contact_ids: [PAYER],
    limit: 3,
  });
  assertEquals(ids(res), ["bev:h1", "bev:p5", "bev:p4"]);
});

Deno.test("heldConversationMessages: rows are checked again, whatever the read returned", () => {
  const customer = new Set<string>();
  const rows = [
    sms("ok", "2026-10-09T03:00:00.000Z"),
    sms("placed", "2026-10-09T03:00:00.000Z", { job_id: OTHER_JOB }),
    sms("not-held", "2026-10-09T03:00:00.000Z", {
      attribution_status: "attributed",
    }),
    sms("stranger", "2026-10-09T03:00:00.000Z", { contact_id: STRANGER }),
    sms("other-job", "2026-10-09T03:00:00.000Z", {
      candidate_job_ids: [OTHER_JOB],
    }),
    sms("retracted", "2026-10-09T03:00:00.000Z", { retracted: "true" }),
    sms("copy", "2026-10-09T03:00:00.000Z", { duplicate_of: "x" }),
    sms("in-cache", "2026-10-09T03:00:00.000Z", {
      provider_message_id: "ghl:cache-1",
    }),
  ];
  const existing = [{ source_system: "ghl_cache", source_ref: "cache-1" }];
  const out = heldConversationMessages(rows, JOB, [PAYER], customer, existing);
  assertEquals(out.map((m) => m.id), ["bev:ok"]);
  assert(out.every((m) => m.unplaced === true));
  assertEquals(heldConversationMessages(rows, JOB, [], customer, []), []);
});
