// deno-lint-ignore-file no-explicit-any no-import-prefix
//
// Context slice R0 (23 Sep 2026): the job conversation's inbox block shows only
// legacy inbox rows with no business_events copy, and evidence rows carry how
// the ladder placed them (adminbucket.md Review M5 and M6, INTEGRATION X29).
//
// Named rows, recorded from production on 23 Sep 2026 (read-only; inbox and
// event ids, job numbers, received times and placement as recorded; bodies
// synthetic; no customer names):
//   - email E2, SWP-261379: ea6f3271, daaad96e, 4d5bad61 are inbox-only (no
//     event copy). They still show, labelled.
//   - adminbucket N1, SWP-261379: inbox aa6745bb (18 Sep 06:46:52Z). The old
//     matcher put it on SWP-261379 by the client's email; its event copy
//     5165975f is `client.email_in`, `admin_bucket`, step 6, no job. (The email
//     note lists aa6745bb as inbox-only; production shows the copy.) R0: the
//     inbox copy is not shown; the evidence row is where the ladder left it.
//   - adminbucket N8, SWP-26183: inbox a7e0d2ba (11 Aug), the supplier email
//     naming SWP-26183 and SWP-26941. Production shows NO event copy (the
//     design note expected one), so it stays on SWP-26183, labelled as the old
//     matcher's placement, and never appears on SWP-26941.
//   - same-job copy: an email whose inbox row and event copy sit on one job
//     shows once, from the evidence row.
//
// Pins:
//   1. Same job: one message, from business_events, with attribution_status /
//      attribution_step / placement_rule.
//   2. E2: the three inbox-only rows still show, labelled, event_copy "none".
//   3. N1: the inbox copy is not shown when its event copy is in the bucket.
//   4. N8: an inbox-only row stays on its guessed job, labelled; not on the
//      second job it names.
//   5. Each of the three writer keys (source pointer, provider key, payload
//      pointer at the same instant) alone proves a copy; a payload pointer at
//      a different instant does not.
//   6. A database answer that does not really reference the inbox row never
//      hides it (the check re-verifies every candidate).
//   7. A failed lookup hides nothing it could not prove: rows stay, marked
//      event_copy "unknown".
//   8. Every copy lookup is keyed (indexed in production: source pointer
//      `idx_events_source_pointer`, provider key unique index, occurred_at).
//   9. The dossier conversation carries the same answer; the merge stays
//      read-only (the fake client exposes no write methods).

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _assembleJobDossierForTest,
  _getJobConversationForTest,
} from "./index.ts";
import {
  LEGACY_INBOX_LABEL,
  legacyInboxRowsToShow,
  readInboxEventCopies,
} from "./job_conversation_inbox_copy.ts";

// ── Recorded fixtures ─────────────────────────────────────────────────────

const SWP_26183 = "0f3c2a10-0000-4000-8000-000000026183";
const SWP_26941 = "0f3c2a10-0000-4000-8000-000000026941";
const SWP_261379 = "ff81f7ca-688d-4dfa-ac2c-29d9f2de4af3";
const SAME_JOB = "0f3c2a10-0000-4000-8000-00000000same";

const E2_INBOX = [
  {
    id: "ea6f3271-354c-49c9-b102-c85f91c97ed0",
    at: "2026-09-07T00:34:42+00:00",
  },
  {
    id: "daaad96e-08cb-4743-9cd9-cd4bb749135c",
    at: "2026-09-10T11:16:16+00:00",
  },
  {
    id: "4d5bad61-e8d3-43f2-8f2c-3c8010d49f8d",
    at: "2026-09-14T02:40:27+00:00",
  },
];
const E2_IDS = E2_INBOX.map((r) => r.id);

const N1_INBOX = "aa6745bb-9d42-4a46-b00a-d52db660cb03";
const N1_EVENT = "5165975f-9886-4970-aa9e-518ee9143ad9";
const N1_GRAPH = "AAMkfixture-nithin-ABLTy7PQAAAA==";
const N1_AT = "2026-09-18T06:46:52+00:00";

const N8_INBOX = "a7e0d2ba-7a78-45cb-b8f3-e733d4f42eba";
const N8_AT = "2026-08-11T03:37:58+00:00";

const SAME_INBOX = "5a3e0000-0000-4000-8000-0000000inbox";
const SAME_EVENT = "5a3e0000-0000-4000-8000-0000000event";
const SAME_AT = "2026-09-20T02:00:00+00:00";

function jobsTable() {
  return [
    { id: SWP_26183, job_number: "SWP-26183", ghl_contact_id: null },
    { id: SWP_26941, job_number: "SWP-26941", ghl_contact_id: null },
    { id: SWP_261379, job_number: "SWP-261379", ghl_contact_id: null },
    { id: SAME_JOB, job_number: "SWP-SAMEJOB", ghl_contact_id: null },
  ];
}

/** SWP-261379: three inbox-only rows (E2) and N1, whose copy is in the bucket. */
function swp261379Tables() {
  return {
    jobs: jobsTable(),
    inbox_events: [
      ...E2_INBOX.map((r, i) => ({
        id: r.id,
        job_id: SWP_261379,
        graph_message_id: `AAMkfixture-e2-${i + 1}`,
        from_email: "client@example.test",
        subject: `Re: SecureWorks Patios (${i + 1})`,
        body_preview: `inbox-only email ${i + 1}`,
        received_at: r.at,
      })),
      {
        id: N1_INBOX,
        job_id: SWP_261379,
        graph_message_id: N1_GRAPH,
        from_email: "client@example.test",
        subject: "Re: SecureWorks Patios",
        body_preview: "asking for a site visit",
        received_at: N1_AT,
      },
    ],
    business_events: [{
      id: N1_EVENT,
      job_id: null,
      event_type: "client.email_in",
      source: "monitor-inbox",
      occurred_at: N1_AT,
      source_table: "inbox_events",
      source_id: N1_INBOX,
      provider_message_id: `graph:${N1_GRAPH}`,
      attribution_status: "admin_bucket",
      attribution_step: 6,
      metadata: { written_as: "service_role" },
      payload: { body: "asking for a site visit", inbox_events_id: N1_INBOX },
    }],
  };
}

/** N8: inbox row on SWP-26183 naming two jobs; no event copy in production. */
function n8Tables() {
  return {
    jobs: jobsTable(),
    inbox_events: [{
      id: N8_INBOX,
      job_id: SWP_26183,
      graph_message_id: "AAMkfixture-n8",
      from_email: "accounts@supplier.example",
      subject: "paid invoice for SWP-26183 and SWP-26941",
      body_preview: "supplier remittance naming two jobs",
      received_at: N8_AT,
    }],
    business_events: [],
  };
}

/** One email whose inbox row and event copy sit on the same job. */
function sameJobTables() {
  return {
    jobs: jobsTable(),
    inbox_events: [{
      id: SAME_INBOX,
      job_id: SAME_JOB,
      graph_message_id: "AAMkfixture-same",
      from_email: "client@example.test",
      subject: "Re: SWP-SAMEJOB",
      body_preview: "customer reply",
      received_at: SAME_AT,
    }],
    business_events: [{
      id: SAME_EVENT,
      job_id: SAME_JOB,
      event_type: "client.email_in",
      source: "monitor-inbox",
      occurred_at: SAME_AT,
      source_table: "inbox_events",
      source_id: SAME_INBOX,
      provider_message_id: "graph:AAMkfixture-same",
      attribution_status: "direct",
      attribution_step: 1,
      metadata: { written_as: "service_role" },
      payload: { body: "customer reply", inbox_events_id: SAME_INBOX },
    }],
  };
}

// ── Read-only fake that honours the filters the reader sends ─────────────

type Tables = Record<string, any[]>;

function columnValue(row: any, column: string): unknown {
  const arrow = column.indexOf("->>");
  if (arrow < 0) return row?.[column];
  const base = row?.[column.slice(0, arrow)];
  const v = base?.[column.slice(arrow + 3)];
  return v == null ? null : String(v);
}

function project(row: any, select: string): any {
  const out: any = {};
  for (const raw of select.split(",").map((s) => s.trim()).filter(Boolean)) {
    const colon = raw.indexOf(":");
    const alias = colon > 0 && !raw.slice(0, colon).includes("-")
      ? raw.slice(0, colon)
      : null;
    const column = alias ? raw.slice(colon + 1) : raw;
    out[alias ?? column] = columnValue(row, column) ?? null;
  }
  return out;
}

function fakeClient(
  tables: Tables,
  opts: { failTable?: string; failColumn?: string; lieOn?: string } = {},
) {
  const reads: Array<{ table: string; filters: string[] }> = [];
  return {
    reads,
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      const names: string[] = [];
      let select = "*";
      let single = false;
      let limit: number | null = null;
      let fail = false;
      const q: any = {};
      // Filters the conversation never sends (other dossier sections) pass through.
      for (
        const m of [
          "neq",
          "is",
          "gte",
          "lt",
          "lte",
          "or",
          "not",
          "contains",
          "range",
        ]
      ) q[m] = () => q;
      q.select = (s: string) => {
        select = s;
        return q;
      };
      q.eq = (c: string, v: any) => {
        names.push(`eq:${c}`);
        filters.push((r) => columnValue(r, c) === v);
        return q;
      };
      q.in = (c: string, vs: any[]) => {
        names.push(`in:${c}`);
        if (table === opts.failTable && c === opts.failColumn) fail = true;
        if (table === "business_events" && c === opts.lieOn) {
          return q; // a database that ignores this filter
        }
        const set = new Set(vs.map(String));
        filters.push((r) => {
          const v = columnValue(r, c);
          if (c === "occurred_at") {
            return vs.some((t) =>
              Date.parse(String(t)) === Date.parse(String(v))
            );
          }
          return v != null && set.has(String(v));
        });
        return q;
      };
      q.gt = (c: string, v: any) => {
        filters.push((r) => String(columnValue(r, c) ?? "") > String(v));
        return q;
      };
      q.ilike = (c: string, v: any) => {
        filters.push((r) =>
          String(columnValue(r, c) ?? "").toLowerCase() ===
            String(v).toLowerCase()
        );
        return q;
      };
      q.order = () => q;
      q.limit = (n: number) => {
        limit = n;
        return q;
      };
      q.maybeSingle = () => {
        single = true;
        return q;
      };
      q.then = (resolve: any, reject: any) => {
        reads.push({ table, filters: names });
        if (fail) {
          return Promise.resolve({
            data: null,
            error: {
              message: "canceling statement due to statement timeout",
              code: "57014",
            },
          }).then(resolve, reject);
        }
        const matched = (tables[table] ?? []).filter((r) =>
          filters.every((f) => f(r))
        );
        const rows = (limit === null ? matched : matched.slice(0, limit)).map(
          (r) => select === "*" ? r : project(r, select),
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

const conversation = async (client: any, jobId: string) =>
  (await _getJobConversationForTest(client, {
    job_id: jobId,
    limit: 50,
  }) as any)
    .messages as any[];

// ── Pins ──────────────────────────────────────────────────────────────────

const refs = (messages: any[], ...ids: string[]) =>
  messages.filter((m) => ids.includes(m.source_ref));

Deno.test("R0 same job: an email with an event copy shows once, from the evidence row", async () => {
  const messages = await conversation(fakeClient(sameJobTables()), SAME_JOB);
  const email = refs(messages, SAME_EVENT, SAME_INBOX);
  assertEquals(email.length, 1, "the email must appear exactly once");
  assertEquals(email[0].source_system, "business_events");
  assertEquals(email[0].attribution_status, "direct");
  assertEquals(email[0].attribution_step, 1);
  assertEquals(email[0].placement_rule, null); // written from P4 onwards
});

Deno.test("R0 E2: SWP-261379's three inbox-only emails still show, labelled", async () => {
  const messages = await conversation(
    fakeClient(swp261379Tables()),
    SWP_261379,
  );
  const inbox = messages.filter((m) => m.source_system === "inbox");
  assertEquals(inbox.map((m) => m.source_ref).sort(), [...E2_IDS].sort());
  for (const m of inbox) {
    assertEquals(m.label, LEGACY_INBOX_LABEL);
    assertEquals(m.placed_by, "old_inbox_matcher");
    assertEquals(m.event_copy, "none");
    assertEquals(m.channel, "email");
  }
});

Deno.test("R0 N1: an inbox copy whose event copy rests in the bucket is not shown on the guessed job", async () => {
  const messages = await conversation(
    fakeClient(swp261379Tables()),
    SWP_261379,
  );
  assertEquals(refs(messages, N1_INBOX, N1_EVENT).length, 0);
  assertEquals(messages.length, 3); // the E2 rows only
});

Deno.test("R0 N8: an inbox-only row stays on its guessed job, labelled, and never reaches the second job", async () => {
  const on26183 = await conversation(fakeClient(n8Tables()), SWP_26183);
  const n8 = refs(on26183, N8_INBOX);
  assertEquals(n8.length, 1);
  assertEquals(n8[0].label, LEGACY_INBOX_LABEL);
  assertEquals(n8[0].event_copy, "none");
  assertEquals(await conversation(fakeClient(n8Tables()), SWP_26941), []);
});

Deno.test("R0: each writer key alone proves an event copy", async () => {
  const inbox = {
    id: N1_INBOX,
    graph_message_id: N1_GRAPH,
    received_at: N1_AT,
  };
  const base = swp261379Tables().business_events[0];
  const variants: Record<string, any> = {
    source_pointer: {
      ...base,
      provider_message_id: null,
      payload: { body: "x" },
    },
    provider_key: {
      ...base,
      source_table: null,
      source_id: null,
      payload: { body: "x" },
    },
    payload_pointer: {
      ...base,
      source_table: null,
      source_id: null,
      provider_message_id: null,
      occurred_at: "2026-09-18T06:46:52.000Z", // same instant, other text form
    },
  };
  for (const [key, row] of Object.entries(variants)) {
    const check = await readInboxEventCopies(
      fakeClient({ business_events: [row] }),
      [inbox],
    );
    assert(check.ok, key);
    assert(check.copied.has(N1_INBOX), `${key} must prove the copy`);
  }
  const otherInstant = {
    ...variants.payload_pointer,
    occurred_at: "2026-09-18T06:47:00+00:00",
  };
  const check = await readInboxEventCopies(
    fakeClient({ business_events: [otherInstant] }),
    [inbox],
  );
  assertEquals(check.copied.size, 0);
});

Deno.test("R0: a database answer that does not reference the inbox row never hides it", async () => {
  // The fake ignores the payload-pointer id filter, as a mis-shaped query
  // would; an unrelated event at E2 row 1's instant must not hide it.
  const tables = swp261379Tables();
  tables.business_events = [{
    ...tables.business_events[0],
    id: "unrelated-event",
    source_table: "graph_group_post",
    source_id: "some-post",
    provider_message_id: "graph:someone-else",
    occurred_at: E2_INBOX[0].at,
    payload: { body: "other", inbox_events_id: "another-inbox-row" },
  }];
  const client = fakeClient(tables, { lieOn: "payload->>inbox_events_id" });
  const messages = await conversation(client, SWP_261379);
  const inboxRefs = messages.filter((m) => m.source_system === "inbox").map((
    m,
  ) => m.source_ref);
  assert(inboxRefs.includes(E2_IDS[0]));
  assertEquals(inboxRefs.length, 4); // E2 x3 plus N1, whose copy is gone here
});

Deno.test("R0: a failed lookup keeps every row it could not prove copied, marked unknown", async () => {
  const client = fakeClient(swp261379Tables(), {
    failTable: "business_events",
    failColumn: "provider_message_id",
  });
  const messages = await conversation(client, SWP_261379);
  const inbox = messages.filter((m) => m.source_system === "inbox");
  // N1 is still proven copied by its source pointer, so it stays hidden.
  assertEquals(inbox.map((m) => m.source_ref).sort(), [...E2_IDS].sort());
  for (const m of inbox) assertEquals(m.event_copy, "unknown");

  // With every lookup failing, nothing is hidden.
  const pure = legacyInboxRowsToShow([{ id: "x" }, { id: "y" }], {
    ok: false,
    copied: new Set(),
    errors: ["timeout"],
  });
  assertEquals(pure.map((p) => [p.row.id, p.event_copy]), [
    ["x", "unknown"],
    ["y", "unknown"],
  ]);
});

Deno.test("R0: every event-copy lookup is keyed, so it stays on an index", async () => {
  const client = fakeClient(swp261379Tables());
  await conversation(client, SWP_261379);
  const lookups = client.reads.filter((r) =>
    r.table === "business_events" && !r.filters.includes("eq:job_id")
  );
  assertEquals(lookups.length, 3);
  for (const r of lookups) {
    assert(
      r.filters.includes("in:source_id") ||
        r.filters.includes("in:provider_message_id") ||
        r.filters.includes("in:occurred_at"),
      `unkeyed lookup: ${r.filters.join(",")}`,
    );
  }
});

Deno.test("R0: the dossier conversation carries the same answer", async () => {
  const dossier: any = await _assembleJobDossierForTest(
    fakeClient(swp261379Tables()),
    { job_id: SWP_261379 },
  );
  assertEquals(dossier.diagnostics.sourceStatus.conversation.ok, true);
  const ids = dossier.conversation.map((m: any) => m.source_ref);
  assertEquals(ids.includes(N1_INBOX), false);
  for (const id of E2_IDS) assert(ids.includes(id));
  const same: any = await _assembleJobDossierForTest(
    fakeClient(sameJobTables()),
    { job_id: SAME_JOB },
  );
  const email = refs(same.conversation, SAME_EVENT, SAME_INBOX);
  assertEquals(email.length, 1);
  assertEquals(email[0].attribution_status, "direct");
});
