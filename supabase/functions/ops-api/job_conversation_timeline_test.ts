// deno-lint-ignore-file no-explicit-any no-import-prefix
//
// Job read fix (5 Oct 2026, gap plan row 9 agent use): the conversation, the
// dossier's events and the state card's newest contact read messages by when
// they happened, with their true channel, who they went between, and the
// emails our system sent the customer.
//
// The fixtures copy the shapes of the agent test set's ten jobs
// (data/cio-ctx-agent-testset, 5 Oct 2026), with synthetic words and
// addresses:
//   SWP-26183  a history load stamped months of old messages "5 Oct", and the
//              newest customer word was a 21 Sep call with a transcript, behind
//              a run of supplier emails and staff notes.
//   SWF-261387 an inbound text (client.reply) read as an email.
//   SWMS-261050 only staff and crew texts: no contact with the customer.
//   SWP-26991  an engineer's email stored as client.email_in, and the client
//              update our system emailed on 10 Sep.
//   SWF-261209 our own invoice emails read back as inbound mail.
//   SWP-26320  crew "new job assigned" texts newer than nothing else.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _assembleJobDossierForTest,
  _getJobConversationForTest,
} from "./index.ts";
import { countsAsCustomerContact } from "./job_conversation_timeline.ts";
import { buildJobStateCard } from "./job_state_card.ts";

type Tables = Record<string, any[]>;
const WRITE_METHODS = ["insert", "update", "upsert", "delete"];

/**
 * Read-only fake that honours the filters this read uses: eq, is null,
 * not is null, gt, in, the message-row or() filter, order (several keys) and
 * limit. Records every query so a test can see what was asked.
 */
function fakeClient(tables: Tables) {
  const queries: { table: string; ops: string[] }[] = [];
  return {
    queries,
    rpc(fn: string) {
      if (fn === "context_job_card_decisions") {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({
        data: null,
        error: { code: "57014", message: "not in fake" },
      });
    },
    from(table: string) {
      const ops: string[] = [];
      queries.push({ table, ops });
      const filters: Array<(r: any) => boolean> = [];
      const orders: Array<{ col: string; asc: boolean }> = [];
      let limit: number | null = null;
      let single = false;
      const q: any = {};
      for (const m of WRITE_METHODS) {
        q[m] = () => {
          throw new Error(`write attempted: ${m} ${table}`);
        };
      }
      q.select = () => q;
      q.eq = (c: string, v: any) => {
        ops.push(`eq:${c}`);
        filters.push((r) => r[c] === v);
        return q;
      };
      q.neq = (c: string, v: any) => {
        filters.push((r) => r[c] !== v);
        return q;
      };
      q.ilike = (c: string, v: any) => {
        filters.push((r) =>
          String(r[c] ?? "").toLowerCase() === String(v).toLowerCase()
        );
        return q;
      };
      q.is = (c: string, v: any) => {
        ops.push(`is:${c}`);
        filters.push((r) => (r[c] ?? null) === v);
        return q;
      };
      q.not = (c: string, op: string, v: any) => {
        ops.push(`not:${c}`);
        if (op === "is") filters.push((r) => (r[c] ?? null) !== v);
        return q;
      };
      q.gt = (c: string, v: any) => {
        filters.push((r) => r[c] !== null && r[c] !== undefined && r[c] > v);
        return q;
      };
      q.in = (c: string, vs: any[]) => {
        filters.push((r) => vs.includes(r[c]));
        return q;
      };
      q.or = (expr: string) => {
        ops.push("or");
        const m = /^channel\.in\.\(([^)]*)\),event_type\.in\.\(([^)]*)\)$/
          .exec(expr);
        if (m) {
          const channels = m[1].split(",");
          const types = m[2].split(",").map((t) => t.replace(/"/g, ""));
          filters.push((r) =>
            channels.includes(r.channel) || types.includes(r.event_type)
          );
        }
        return q;
      };
      for (const m of ["gte", "lt", "lte", "contains", "range"]) {
        q[m] = () => q;
      }
      q.order = (col: string, o?: { ascending?: boolean }) => {
        ops.push(`order:${col}`);
        orders.push({ col, asc: o?.ascending !== false });
        return q;
      };
      q.limit = (n: number) => {
        limit = n;
        return q;
      };
      q.maybeSingle = () => {
        single = true;
        return q;
      };
      q.single = q.maybeSingle;
      q.then = (resolve: any, reject: any) => {
        let rows = (tables[table] ?? []).filter((r) =>
          filters.every((f) => f(r))
        );
        rows = [...rows].sort((a, b) => {
          for (const o of orders) {
            const av = a[o.col] ?? "";
            const bv = b[o.col] ?? "";
            if (av < bv) return o.asc ? -1 : 1;
            if (av > bv) return o.asc ? 1 : -1;
          }
          return 0;
        });
        if (limit !== null) rows = rows.slice(0, limit);
        return Promise.resolve({
          data: single ? rows[0] ?? null : rows,
          error: null,
        }).then(resolve, reject);
      };
      return q;
    },
  };
}

const CLIENT_MAIL = "client@example.test";
const LOAD = "2026-10-04T22:39:27.830Z"; // the GHL history load

function job(
  id: string,
  jobNumber: string,
  over: Record<string, unknown> = {},
) {
  return {
    id,
    job_number: jobNumber,
    type: "patio",
    status: "in_progress",
    client_name: "Row label only",
    client_email: CLIENT_MAIL,
    ghl_contact_id: `contact-${jobNumber}`,
    org_id: "00000000-0000-0000-0000-000000000001",
    created_at: "2026-05-01T01:00:00.000Z",
    scope_json: null,
    pricing_json: null,
    scope_version: null,
    scope_updated_at: null,
    ...over,
  };
}

function bev(
  id: string,
  jobId: string,
  over: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id,
    job_id: jobId,
    source: "fixture",
    event_at: null,
    occurred_at: null,
    channel: null,
    direction: null,
    payload: {},
    audience: null,
    recipient_role: null,
    ...over,
  };
}

// ── ordering ─────────────────────────────────────────────────────────────────

Deno.test("timeline: history loaded on 5 Oct sorts by when it happened, not by load time (SWP-26183 shape)", async () => {
  const J = "a0000000-0000-4000-8000-000000026183";
  const history = Array.from(
    { length: 30 },
    (_, i) =>
      bev(`hist-${String(i).padStart(2, "0")}`, J, {
        event_type: i % 2 ? "client.sms_out" : "client.reply",
        channel: "sms",
        direction: i % 2 ? "outbound" : "inbound",
        event_at: `2026-0${5 + (i % 4)}-1${i % 10}T01:00:00.000Z`,
        occurred_at: LOAD, // stamped by the load
        payload: { body: `old history ${i}` },
      }),
  );
  const latest = bev("latest", J, {
    event_type: "client.reply",
    channel: "sms",
    direction: "inbound",
    event_at: "2026-10-02T03:00:00.000Z",
    occurred_at: "2026-10-02T03:00:01.000Z",
    payload: { body: "the real latest word" },
  });
  // An older writer row with no event_at: its source time is occurred_at.
  const unstamped = bev("unstamped", J, {
    event_type: "client.sms_out",
    channel: "sms",
    direction: "outbound",
    occurred_at: "2026-09-30T01:00:00.000Z",
    payload: { body: "older writer, no event_at" },
  });
  const client = fakeClient({
    jobs: [job(J, "SWP-26183")],
    business_events: [...history, latest, unstamped],
  });
  const { messages }: any = await _getJobConversationForTest(client, {
    job_id: J,
    limit: 20,
  });
  assertEquals(messages.length, 20);
  assertEquals(messages[0].source_ref, "latest");
  assertEquals(messages[0].occurred_at, "2026-10-02T03:00:00.000Z");
  assertEquals(messages[1].source_ref, "unstamped");
  // A history row shows when it happened, and when it was loaded.
  const old = messages.find((m: any) => m.source_ref === "hist-07");
  assert(old, "the newest history rows still fill the remaining slots");
  assertEquals(old.loaded_at, LOAD);
  assert(old.occurred_at < "2026-10-01");
  // No message claims to have happened on the load day.
  assert(
    messages.every((m: any) => !String(m.occurred_at).startsWith("2026-10-04")),
  );
});

// ── who to whom ──────────────────────────────────────────────────────────────

Deno.test("timeline: staff and crew texts stay on the job as internal communication, never customer contact (SWMS-261050 shape)", async () => {
  const J = "a0000000-0000-4000-8000-000000261050";
  const client = fakeClient({
    jobs: [job(J, "SWMS-261050", { type: "makesafe", client_email: null })],
    business_events: [
      bev("docs", J, {
        event_type: "client.sms_out",
        channel: "sms",
        direction: "outbound",
        recipient_role: "staff",
        event_at: "2026-09-29T08:26:00Z",
        occurred_at: "2026-09-29T08:26:01Z",
        payload: { body: "Docs Ready: staff alert" },
      }),
      bev("crew", J, {
        event_type: "client.sms_out",
        channel: "sms",
        direction: "outbound",
        recipient_role: "crew",
        audience: "internal",
        event_at: "2026-07-23T02:38:00Z",
        occurred_at: "2026-07-23T02:38:01Z",
        payload: { body: "New make-safe: crew alert" },
      }),
    ],
  });
  const { messages }: any = await _getJobConversationForTest(client, {
    job_id: J,
    limit: 20,
  });
  assertEquals(messages.length, 2);
  assertEquals(messages[0].who, "us to staff (internal)");
  assertEquals(messages[1].who, "us to crew (internal)");
  assert(messages.every((m: any) => !countsAsCustomerContact(m)));

  const d: any = await _assembleJobDossierForTest(client, { job_id: J });
  assert(
    d.state.lines.includes(
      "No contact with the customer seen for this job (only internal or other-party messages).",
    ),
    d.state.lines.join("\n"),
  );
  assert(
    !d.state.lines.some((l: string) => l.startsWith("Last told the customer")),
  );
  assertEquals(d.state.customer_contact, { newest: null, last_told: null });
  // Still shown as internal job communication.
  assertEquals(d.conversation.length, 2);
});

Deno.test("timeline: an engineer's email filed as client mail is not the customer; the client update we emailed is (SWP-26991 shape)", async () => {
  const J = "a0000000-0000-4000-8000-000000026991";
  const client = fakeClient({
    jobs: [job(J, "SWP-26991", { status: "approvals" })],
    business_events: [
      bev("eng", J, {
        event_type: "client.email_in",
        channel: "email",
        direction: "inbound",
        event_at: "2026-09-29T02:00:00Z",
        occurred_at: "2026-09-29T02:00:05Z",
        payload: {
          from: "Engineer <eng@engineers.example>",
          to: ["patios@secureworkswa.com.au"],
          subject: "Revised drawings",
          body: "Proceeding on the revised drawings",
        },
      }),
      bev("staff-cc", J, {
        event_type: "client.email_out",
        channel: "email",
        direction: "outbound",
        event_at: "2026-09-16T02:00:00Z",
        occurred_at: "2026-09-16T02:00:05Z",
        payload: {
          from: "shaun@secureworkswa.com.au",
          to: ["supplier@metal.example"],
          subject: "Order",
          body: "order please",
        },
      }),
    ],
    email_events: [{
      id: "ee-1",
      job_id: J,
      email_type: "client_email",
      recipient: `Client <${CLIENT_MAIL}>`,
      sender: "orders@secureworksgroup.app",
      subject: "9 Example Place: patio drawings update",
      status: "accepted",
      sent_at: "2026-09-10T13:56:41.660Z",
      created_at: "2026-09-10T13:56:40.000Z",
    }, {
      id: "ee-failed",
      job_id: J,
      email_type: "notification",
      recipient: CLIENT_MAIL,
      subject: "never went",
      status: "failed",
      sent_at: "2026-09-12T00:00:00Z",
    }],
  });
  const { messages }: any = await _getJobConversationForTest(client, {
    job_id: J,
    limit: 20,
  });
  const eng = messages.find((m: any) => m.source_ref === "eng");
  assertEquals(eng.customer_party, false);
  assertEquals(eng.who, "someone other than the customer to us");
  const sent = messages.find((m: any) => m.source_system === "email_events");
  assertEquals(sent.source_ref, "ee-1");
  assertEquals(sent.channel, "email");
  assertEquals(sent.direction, "outbound");
  assertEquals(sent.who, "us to the customer");
  assert(!messages.some((m: any) => m.source_ref === "ee-failed"));

  const d: any = await _assembleJobDossierForTest(client, { job_id: J });
  assert(
    d.state.lines.includes(
      "Newest contact with the customer: email from us on 10 Sep 2026, sent by our system.",
    ),
    d.state.lines.join("\n"),
  );
  const told = d.state.lines.find((l: string) =>
    l.startsWith("Last told the customer")
  );
  assertStringIncludes(
    told,
    "email on 10 Sep 2026 21:56 Perth, sent by our system",
  );
  assertStringIncludes(told, "patio drawings update");
  assertEquals(d.state.customer_contact.last_told.source_ref, "ee-1");
  assertEquals(
    d.state.customer_contact.last_told.source_system,
    "email_events",
  );
});

// ── the newest customer word behind internal and supplier traffic ────────────

Deno.test("dossier: the last thing we told the customer is found behind supplier mail and notes, and calls are messages (SWP-26183 shape)", async () => {
  const J = "a0000000-0000-4000-8000-000000026184";
  const supplier = Array.from(
    { length: 25 },
    (_, i) =>
      bev(`sup-${String(i).padStart(2, "0")}`, J, {
        event_type: "client.email_in",
        channel: "email",
        direction: "inbound",
        event_at: `2026-09-${String(24 + (i % 5)).padStart(2, "0")}T0${
          i % 10
        }:00:00Z`,
        occurred_at: LOAD,
        payload: {
          from: "Sales <sales@supplier.example>",
          to: ["shaun@secureworkswa.com.au"],
          subject: "Order",
          body: `supplier mail ${i}`,
        },
      }),
  );
  const rows = [
    ...supplier,
    bev("call", J, {
      event_type: "client.call_logged",
      channel: "call",
      direction: "outbound",
      event_at: "2026-09-21T04:00:00Z",
      occurred_at: LOAD,
      body_preview: "[Call, outbound. Provider status: completed.]",
    }),
    bev("transcript", J, {
      event_type: "call.transcript_completed",
      channel: "call",
      direction: "outbound",
      event_at: "2026-09-21T04:00:30Z",
      occurred_at: LOAD,
      payload: {
        transcript:
          "Gutters are late; sheeting, gutters and flashings Thursday.",
      },
    }),
    bev("text", J, {
      event_type: "client.sms_out",
      channel: "sms",
      direction: "outbound",
      event_at: "2026-09-10T01:00:00Z",
      occurred_at: LOAD,
      payload: { body: "There about 10 instead of 7" },
    }),
  ];
  const client = fakeClient({
    jobs: [job(J, "SWP-26184")],
    business_events: rows,
  });
  const d: any = await _assembleJobDossierForTest(client, { job_id: J });
  // The returned conversation stays bounded by the mode.
  assertEquals(d.bounds.conversationLimit, 20);
  assertEquals(d.conversation.length, 20);
  assert(!d.conversation.some((m: any) => m.source_ref === "transcript"));
  // The state card still finds the call.
  assert(
    d.state.lines.includes(
      "Newest contact with the customer: call from us on 21 Sep 2026.",
    ),
    d.state.lines.join("\n"),
  );
  assert(
    d.state.lines.includes(
      'Last told the customer: call (transcript) on 21 Sep 2026 12:00 Perth: "Gutters are late; sheeting, gutters and flashings Thursday.".',
    ),
    d.state.lines.join("\n"),
  );
  // The card names the record and carries its words for the agent to cite.
  assertEquals(d.state.customer_contact.last_told.source_ref, "transcript");
  assertStringIncludes(
    d.state.customer_contact.last_told.body,
    "flashings Thursday",
  );
  assertEquals(d.state.customer_contact.newest.source_ref, "transcript");
  // Events are newest by when they happened, with load time kept.
  assertEquals(d.events[0].occurred_at.slice(0, 10), "2026-09-28");
  assertEquals(d.events[0].loaded_at, LOAD);
});

Deno.test("state card: crew texts newer than the customer's last word do not become the newest contact (SWP-26320 shape)", () => {
  const card = buildJobStateCard({
    now: "2026-10-05T00:00:00Z",
    job: { status: "scheduled" },
    quotes: null,
    quotesOk: false,
    invoices: { ok: true, rows: [] },
    assignments: { ok: true, rows: [] },
    conversation: {
      ok: true,
      rows: [
        {
          channel: "sms",
          direction: "outbound",
          recipient_role: "crew",
          occurred_at: "2026-10-04T10:00:00Z",
          preview: "New job assigned",
          source_system: "business_events",
        },
        {
          channel: "sms",
          direction: "inbound",
          occurred_at: "2026-10-04T08:23:00Z",
          preview: "no way anyone works here Monday",
          source_system: "business_events",
        },
        {
          channel: "sms",
          direction: "outbound",
          occurred_at: "2026-10-04T08:17:00Z",
          preview: "The team will be there at 7am tomorrow",
          source_system: "business_events",
        },
      ],
    },
    facts: { ok: true, rows: [] },
    briefs: { ok: true, rows: [] },
    visitOutcomes: { ok: true, rows: [] },
    freshness: null,
  });
  assert(
    card.lines.includes(
      "Newest contact with the customer: text from the customer on 4 Oct 2026.",
    ),
    card.lines.join("\n"),
  );
  assert(
    card.lines.includes(
      'Last told the customer: text on 4 Oct 2026 16:17 Perth: "The team will be there at 7am tomorrow".',
    ),
    card.lines.join("\n"),
  );
});

Deno.test("timeline: a GHL message in the CRM cache and as its event row shows once, as the row", async () => {
  const J = "a0000000-0000-4000-8000-000000261387";
  const client = fakeClient({
    jobs: [job(J, "SWF-261387", { status: "quoted" })],
    ghl_conversation_cache: [{
      contact_id: "contact-SWF-261387",
      job_id: J,
      messages: [{
        id: "g1",
        type: "TYPE_SMS",
        direction: "outbound",
        timestamp: "2026-10-02T01:04:00.000Z",
        body: "Thanks mate chat soon",
      }, {
        id: "g2",
        type: "TYPE_SMS",
        direction: "inbound",
        timestamp: "2026-10-01T01:04:00.000Z",
        body: "only in the cache",
      }],
    }],
    business_events: [bev("row-g1", J, {
      event_type: "client.sms_out",
      channel: "sms",
      direction: "outbound",
      provider_message_id: "ghl:g1",
      event_at: "2026-10-02T01:04:00.000Z",
      occurred_at: LOAD,
      payload: { body: "Thanks mate chat soon" },
    })],
  });
  const { messages }: any = await _getJobConversationForTest(client, {
    job_id: J,
    limit: 20,
  });
  assertEquals(messages.length, 2);
  assertEquals(messages[0].source_ref, "row-g1");
  assertEquals(messages[1].source_system, "ghl_cache");
  assertEquals(messages[1].who, "the customer to us");
});

Deno.test("timeline: our own tool's copy of a text, placed on its twin's job, shows once, as the twin (C2)", async () => {
  const J = "a0000000-0000-4000-8000-000000998806";
  const client = fakeClient({
    jobs: [job(J, "SWF-998806", { status: "scheduled" })],
    business_events: [bev("row-twin", J, {
      event_type: "client.sms_out",
      source: "ghl-proxy",
      channel: "sms",
      direction: "outbound",
      event_at: "2026-10-02T01:04:00.000Z",
      occurred_at: "2026-10-02T01:04:00.000Z",
      payload: { body: "Your fence is booked for Thursday 7am." },
    }), bev("row-copy", J, {
      event_type: "client.sms_out",
      source: "mcp_agent",
      occurred_at: "2026-10-02T01:04:01.000Z",
      payload: { message_preview: "Your fence is booked for Thursday 7am." },
      metadata: { placement_copy_of: "row-twin", placement_rule: "twin_copy" },
    })],
  });
  const { messages }: any = await _getJobConversationForTest(client, {
    job_id: J,
    limit: 20,
  });
  assertEquals(messages.map((m: any) => m.source_ref), ["row-twin"]);
});

// ── a person's decisions (CTX-T22) ───────────────────────────────────────────

function withDecisions(tables: Tables, answer: { data: any; error: any }) {
  const base = fakeClient(tables);
  const calls: { fn: string; args: any }[] = [];
  return {
    ...base,
    calls,
    rpc(fn: string, args: any) {
      calls.push({ fn, args });
      return Promise.resolve(answer);
    },
  };
}

// CTX-T24: invoke the actual dossier, not only the shared timeline helper.
Deno.test("dossier follows moved, split and unrelated evidence without changing stored placement", async () => {
  const A = "a0000000-0000-4000-8000-0000000000a4";
  const B = "a0000000-0000-4000-8000-0000000000b4";
  const rows = ["keep", "move", "split", "unrelated"].map((id, i) =>
    bev(id, A, {
      event_type: "supplier.email_in",
      channel: "email",
      direction: "inbound",
      event_at: `2026-10-0${i + 1}T01:00:00Z`,
      occurred_at: "2026-10-21T01:00:00Z",
      payload: {
        subject: id,
        body: `Synthetic supplier message ${id}`,
        from: "supplier@example.test",
      },
    })
  );
  const original = JSON.stringify(rows);
  for (const jobId of [A, B]) {
    const decisions = [
      {
        event_id: "move",
        action: "correct",
        placement: jobId === A ? "off" : "on",
      },
      { event_id: "split", action: "split", placement: "on" },
      ...(jobId === A
        ? [{ event_id: "unrelated", action: "unrelated", placement: "off" }]
        : []),
    ].map((d, i) => ({
      ...d,
      decision_id: i + 1,
      decided_at: "2026-10-22T01:00:00Z",
      decided_by: "staff",
      other_job_numbers: ["SYNTHETIC"],
    }));
    const c = withDecisions({
      jobs: [job(A, "SWP-SYN-A"), job(B, "SWP-SYN-B")],
      business_events: rows,
    }, { data: decisions, error: null });
    const d: any = await _assembleJobDossierForTest(c, { job_id: jobId });
    assertEquals(
      d.events.map((e: any) => e.id),
      jobId === A ? ["split", "keep"] : ["split", "move"],
    );
    assertEquals(
      d.events.find((e: any) => e.id === "split").person_placed.action,
      "split",
    );
    assertEquals(d.events[0].occurred_at, "2026-10-03T01:00:00Z");
    assertEquals(d.events[0].loaded_at, "2026-10-21T01:00:00Z");
    assertEquals(d.diagnostics.sourceStatus.businessEvents.ok, true);
    assertEquals(
      d.conversation.filter((e: any) => e.source_system === "business_events")
        .map((e: any) => e.id).length,
      2,
    );
    assertEquals(JSON.stringify(rows), original);
  }
});

Deno.test("dossier never reports failed placement reads as an empty successful source", async () => {
  const J = "a0000000-0000-4000-8000-0000000000a5";
  for (
    const answer of [{
      data: null,
      error: { message: "placement unavailable" },
    }, { data: null, error: null }]
  ) {
    const c = withDecisions({
      jobs: [job(J, "SWP-SYN-J")],
      business_events: [bev("unverified-old-placement", J, {
        event_type: "client.sms_in",
        channel: "sms",
        event_at: "2026-10-01T01:00:00Z",
        occurred_at: "2026-10-02T01:00:00Z",
        payload: { body: "Synthetic unresolved request" },
      })],
    }, answer);
    const d: any = await _assembleJobDossierForTest(c, { job_id: J });
    assertEquals(d.events, []);
    assertEquals(d.diagnostics.sourceStatus.businessEvents.ok, false);
    assertStringIncludes(
      d.diagnostics.sourceStatus.businessEvents.error,
      "person decisions read failed",
    );
    assertEquals(d.diagnostics.sourceStatus.conversation.ok, false);
    assertEquals(d.conversation, []);
    assertEquals(d.diagnostics.ok, false);
  }
});
