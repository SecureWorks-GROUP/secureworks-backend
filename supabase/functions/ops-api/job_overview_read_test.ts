// Job overview v1 (the job page Overview's one read, and the staff ask to
// write or rewrite the saved job story).
// - GET job_overview: story card, AI notes, conversation, files and the saved
//   story, each part on its own; nothing written; no network; a failed part is
//   null with a code, never empty; no call transcript words anywhere.
// - POST request_job_story: the verified caller asks, never a body field.
// - Both are staff-only through the existing front door.
// Fake client only; made-up ids, names and words.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  callWords,
  invoiceTotals,
  isMissingFunction,
  JOB_OVERVIEW_VERSION,
  jobOverviewAction,
  noteGroup,
  noteOwner,
  OVERVIEW_MESSAGE_LIMIT,
  overviewInvoice,
  overviewMessages,
  perthDay,
  perthStamp,
  plainText,
  requestJobStoryAction,
} from "./job_overview_read.ts";
import { StoryReadError } from "./job_story_read.ts";
import {
  _authorizeOpsApiAction,
  _opsApiActionNeedsStaffRole,
  AGENT_READ_ALLOWED_ACTIONS,
} from "./index.ts";

const JOB = "a0000000-0000-4000-8000-0000000000b1";
const GEN = "9a000000-0000-4000-8000-0000000000b2";
const CALL_ROW = "b0000000-0000-4000-8000-0000000000c1";
const TRANSCRIPT_ROW = "b0000000-0000-4000-8000-0000000000c2";
const LEGACY_CALL_ROW = "b0000000-0000-4000-8000-0000000000c3";
const SMS_ROW = "b0000000-0000-4000-8000-0000000000c4";
const QUOTE_DOC = "d0000000-0000-4000-8000-0000000000d1";
const OLD_QUOTE_DOC = "d0000000-0000-4000-8000-0000000000d2";
const TRANSCRIPT_WORDS = "TRANSCRIPT WORDS NEVER SHOWN";
const DASH = "\u2014";

const STORY = {
  version: "job-story-v1",
  job: { id: JOB, job_number: "SWF-T0101", status: "accepted" },
  now: {
    line: "Accepted since Thu 8 Oct: our move.",
    phase: "accepted",
    whose_move: "us",
  },
  loops: [{
    key: "ledger:deposit_link",
    status: "open",
    owner: "us",
    what: "Send the deposit link",
    why: `"${TRANSCRIPT_WORDS}"`,
  }],
  last_exchange: {
    customer_said: {
      at: "2026-10-09T01:25:00Z",
      table: "business_events",
      id: TRANSCRIPT_ROW,
      event_type: "call.transcript_completed",
      text: `Call (speakers not labelled): ${TRANSCRIPT_WORDS}`,
    },
    we_told_customer: {
      at: "2026-10-09T01:22:00Z",
      table: "business_events",
      id: SMS_ROW,
      event_type: "client.sms_out",
      text: "Bank details sent",
    },
    internal: null,
  },
  money: { job_value: { amount: 7065.85 } },
  meta: {
    ledger: { status: "live", generation_id: GEN },
    built_at: "2026-10-09T02:00:00Z",
  },
};

const LEDGER = {
  status: "live",
  generation: {
    id: GEN,
    evidence_until: "2026-10-09T01:30:00Z",
    reader: "luna-ledger:v1",
  },
  unread_rows: 0,
  items: [
    {
      item_key: "deposit_link",
      item_type: "request",
      status: "open",
      from_role: "customer",
      from_name: "Pat Example",
      to_role: "us",
      to_name: null,
      what: `Send the deposit link ${DASH} today`,
      blocks: "deposit",
      opened_at: "2026-10-08T06:00:00Z",
      cites_ok: true,
      opened_by: [{
        table: "business_events",
        id: TRANSCRIPT_ROW,
        excerpt: TRANSCRIPT_WORDS,
      }],
    },
    {
      item_key: "tenants_away",
      item_type: "constraint",
      status: "open",
      from_role: "customer",
      from_name: "Pat Example",
      what: "The tenants are away until 20 Oct",
      blocks: null,
      opened_at: "2026-10-01T03:00:00Z",
      cites_ok: true,
      opened_by: [{
        table: "business_events",
        id: SMS_ROW,
        excerpt: "They are away \u2013 back on the 20th",
      }],
    },
    {
      item_key: "neighbour_pays",
      item_type: "commitment",
      status: "open",
      from_role: "third_party",
      from_name: "Sam Neighbour",
      to_role: "us",
      what: "The neighbour will pay half",
      blocks: null,
      opened_at: "2026-10-08T07:00:00Z",
      cites_ok: true,
      opened_by: [{
        table: "inbox_events",
        id: "e0000000-0000-4000-8000-0000000000e1",
        excerpt: "I will pay my half",
      }],
    },
    {
      item_key: "old_claim",
      item_type: "claim",
      status: "superseded",
      from_role: "customer",
      what: "No acceptance yet",
      opened_at: "2026-09-30T03:00:00Z",
      closed_at: "2026-10-08T06:01:00Z",
      cites_ok: true,
      opened_by: [],
    },
  ],
};

const STORY_TEXT = {
  version: "job-story-text-v1",
  job_id: JOB,
  status: "fresh",
  card_hash: "0123456789abcdef0123456789abcdef",
  text: {
    id: "f0000000-0000-4000-8000-0000000000f1",
    sections: { headline: "Waiting on the deposit." },
  },
  writer: { on: true, open_request: null, last_failure: null },
};

/** The conversation as getJobConversation returns it: newest first. */
function conversation(): any[] {
  const bev = (id: string, extra: any) => ({
    id: `bev:${id}`,
    job_id: JOB,
    source_system: "business_events",
    source_ref: id,
    customer_party: null,
    sender_role: "customer",
    recipient_role: "staff",
    counterpart_role: "customer",
    ...extra,
  });
  return [
    bev(TRANSCRIPT_ROW, {
      channel: "call",
      direction: "inbound",
      occurred_at: "2026-10-09T01:40:00Z",
      body: TRANSCRIPT_WORDS,
      provider_message_id: "ghltx:call-1",
      call_transcript: true,
    }),
    bev(LEGACY_CALL_ROW, {
      channel: "call",
      direction: "inbound",
      occurred_at: "2026-10-09T01:37:30Z",
      body: "Call completed",
      provider_message_id: null,
    }),
    bev(CALL_ROW, {
      channel: "call",
      direction: "inbound",
      occurred_at: "2026-10-09T01:35:00Z",
      body:
        "[Call, inbound. Provider status: completed. Duration: 125 seconds.]",
      provider_message_id: "ghl:call-1",
    }),
    bev(SMS_ROW, {
      channel: "sms",
      direction: "inbound",
      occurred_at: "2026-10-09T01:25:00Z",
      body: `Will do ${DASH} thanks`,
    }),
    bev("b0000000-0000-4000-8000-0000000000c5", {
      channel: "sms",
      direction: "outbound",
      occurred_at: "2026-10-09T01:22:00Z",
      body: "Bank details: see our invoice",
      sender_role: "staff",
      recipient_role: "customer",
    }),
    bev("b0000000-0000-4000-8000-0000000000c6", {
      channel: "sms",
      direction: "inbound",
      occurred_at: "2026-09-20T01:00:00Z",
      body: "",
    }),
    bev("b0000000-0000-4000-8000-0000000000c7", {
      channel: "sms",
      direction: "inbound",
      occurred_at: "2026-09-21T01:00:00Z",
      body: "[No text. No attachments.]",
    }),
    bev("b0000000-0000-4000-8000-0000000000c8", {
      channel: "sms",
      direction: "inbound",
      occurred_at: "2026-09-22T01:00:00Z",
      body: "[No text. 1 attachment: jpeg.]",
    }),
    {
      id: "note:n1",
      job_id: JOB,
      channel: "note",
      direction: "internal",
      occurred_at: "2026-09-23T01:00:00Z",
      body: "Check the gate width",
      source_system: "job_events",
      source_ref: "n1",
      internal: true,
    },
    bev("b0000000-0000-4000-8000-0000000000c9", {
      channel: "email",
      direction: "inbound",
      occurred_at: "2026-09-24T01:00:00Z",
      body: "Please see the attached plan.",
      subject: "Fence plan",
      customer_party: false,
      audience: "other_party",
      sender_role: "supplier",
      counterpart_role: "supplier",
    }),
  ];
}

const TABLES = (): Record<string, any[]> => ({
  jobs: [{
    id: JOB,
    job_number: "SWF-T0101",
    type: "fencing",
    status: "accepted",
    client_name: "Pat Example",
    client_phone: "0400 000 000",
    client_email: "pat@example.test",
    site_address: "1 Example Street",
    site_suburb: "Testvale",
    ghl_contact_id: "ctT",
    ghl_opportunity_id: "opT",
    deposit_amount: 1000,
    created_at: "2026-09-01T01:00:00Z",
    pricing_json: {
      totalIncGST: 7065.85,
      job_description: `23m fence ${DASH} 1800mm ${DASH} Testvale`,
    },
    scope_json: { job: {} },
  }],
  business_events: [
    {
      id: CALL_ROW,
      job_id: JOB,
      event_type: "client.call_logged",
      provider_message_id: "ghl:call-1",
      seconds: 125,
      call_status: "completed",
      ghl_call_id: null,
      legacy_event_id: LEGACY_CALL_ROW,
    },
    {
      id: TRANSCRIPT_ROW,
      job_id: JOB,
      event_type: "call.transcript_completed",
      provider_message_id: "ghltx:call-1",
      seconds: 125,
      call_status: null,
      ghl_call_id: "call-1",
      legacy_event_id: null,
    },
    {
      id: LEGACY_CALL_ROW,
      job_id: JOB,
      event_type: "client.call_complete",
      provider_message_id: null,
      seconds: null,
    },
    { id: SMS_ROW, job_id: JOB, event_type: "client.reply" },
    {
      id: "b0000000-0000-4000-8000-0000000000a1",
      job_id: JOB,
      event_type: "document.text_extracted",
      source_kind: "email_attachment",
      file_name: "fence-plan.pdf",
      label: "Fence plan",
      content_type: "application/pdf",
      page_count: "2",
      sha256: "aa11",
      occurred_at: "2026-09-24T01:01:00Z",
      event_at: "2026-09-24T01:00:00Z",
    },
    // the same attachment read twice: shown once
    {
      id: "b0000000-0000-4000-8000-0000000000a2",
      job_id: JOB,
      event_type: "document.text_extracted",
      source_kind: "email_attachment",
      file_name: "fence-plan.pdf",
      label: "Fence plan",
      content_type: "application/pdf",
      page_count: "2",
      sha256: "aa11",
      occurred_at: "2026-09-25T01:01:00Z",
      event_at: "2026-09-24T01:00:00Z",
    },
    // our own quote PDF read as text: not an attachment
    {
      id: "b0000000-0000-4000-8000-0000000000a3",
      job_id: JOB,
      event_type: "document.text_extracted",
      source_kind: "job_document",
      file_name: "quote.pdf",
      occurred_at: "2026-09-26T01:01:00Z",
    },
    {
      id: "b0000000-0000-4000-8000-0000000000a4",
      job_id: JOB,
      event_type: "document.uploaded",
      uploaded_file_name: "council-letter.pdf",
      uploaded_type: "council",
      occurred_at: "2026-09-27T01:00:00Z",
    },
  ],
  xero_invoices: [
    {
      id: "x1",
      job_id: JOB,
      invoice_number: "INV-T1",
      reference: "SWF-T0101 DEP",
      invoice_type: "ACCREC",
      status: "DRAFT",
      total: 3571.43,
      amount_due: 3571.43,
      amount_paid: 0,
      invoice_date: "2026-10-08",
      due_date: "2026-10-15",
    },
    {
      id: "x2",
      job_id: JOB,
      invoice_number: "INV-T2",
      reference: "SWF-T0101",
      invoice_type: "ACCREC",
      status: "AUTHORISED",
      total: 1000,
      amount_due: 400,
      amount_paid: 600,
      invoice_date: "2026-10-01",
      due_date: "2026-10-08",
    },
    {
      id: "x3",
      job_id: JOB,
      invoice_number: "INV-T3",
      reference: "SWF-T0101",
      invoice_type: "ACCREC",
      status: "DELETED",
      total: 500,
      amount_due: 0,
      amount_paid: 500,
      invoice_date: "2026-09-01",
      fully_paid_on: "2026-09-02",
    },
    {
      id: "x4",
      job_id: JOB,
      invoice_number: "BILL-T4",
      reference: "SWF-T0101",
      invoice_type: "ACCPAY",
      status: "PAID",
      total: 900,
      amount_due: 0,
      amount_paid: 900,
    },
  ],
  job_media: [{ job_id: JOB, type: "photo" }, { job_id: JOB, type: "photo" }, {
    job_id: JOB,
    type: "photo",
  }, { job_id: JOB, type: "video" }],
  job_events: [
    { job_id: JOB, event_type: "quote_viewed", document_id: QUOTE_DOC },
    { job_id: JOB, event_type: "quote_viewed", document_id: QUOTE_DOC },
    { job_id: JOB, event_type: "quote_viewed", document_id: OLD_QUOTE_DOC },
    { job_id: JOB, event_type: "scope_saved", document_id: null },
  ],
  job_documents: [
    {
      id: QUOTE_DOC,
      job_id: JOB,
      type: "quote",
      version: 3,
      quote_number: "Q-T1",
      run_label: null,
      job_contact_id: null,
      sent_at: "2026-10-07T01:00:00Z",
      viewed_at: "2026-10-07T02:00:00Z",
      accepted_at: "2026-10-08T06:01:00Z",
      declined_at: null,
      superseded_at: null,
      quote_revision_id: null,
      created_at: "2026-10-07T00:00:00Z",
    },
    {
      id: OLD_QUOTE_DOC,
      job_id: JOB,
      type: "quote",
      version: 2,
      quote_number: "Q-T1",
      run_label: null,
      job_contact_id: null,
      sent_at: "2026-10-01T01:00:00Z",
      viewed_at: "2026-10-01T02:00:00Z",
      accepted_at: null,
      declined_at: null,
      superseded_at: "2026-10-07T00:30:00Z",
      quote_revision_id: null,
      created_at: "2026-10-01T00:00:00Z",
    },
  ],
  run_acceptances: [],
  quote_revisions: [],
  job_contacts: [],
});

const QUOTE_VALUES = [
  {
    document_id: QUOTE_DOC,
    job_contact_id: null,
    party_is_owner: null,
    run_label: null,
    value_inc_gst: 7065.85,
    value_source: "quote_sent_log",
    whole_quote_total_inc: null,
    whole_quote_source: null,
  },
  {
    document_id: OLD_QUOTE_DOC,
    job_contact_id: null,
    party_is_owner: null,
    run_label: null,
    value_inc_gst: null,
    value_source: "not_recorded",
    whole_quote_total_inc: null,
    whole_quote_source: null,
  },
];

function matches(row: any, f: { op: string; col: string; val: any }): boolean {
  const v = row?.[f.col];
  switch (f.op) {
    case "eq":
      return v === f.val;
    case "in":
      return Array.isArray(f.val) && f.val.includes(v);
    case "not_null":
      return v !== null && v !== undefined;
    case "is_null":
      return v === null || v === undefined;
    case "ilike":
      return String(v ?? "").toLowerCase() ===
        String(f.val).replace(/\\(.)/g, "$1").toLowerCase();
    default:
      return true;
  }
}

function fakeClient(opts: {
  tables?: Record<string, any[]>;
  rpc?: Record<string, any>;
  rpcErrors?: Record<string, any>;
  failTables?: Set<string>;
} = {}) {
  const tables: Record<string, any[]> = opts.tables ?? TABLES();
  const reads: string[] = [];
  const rpcs: { fn: string; args: any }[] = [];
  const writes: string[] = [];
  return {
    reads,
    rpcs,
    writes,
    rpc(fn: string, args: any) {
      rpcs.push({ fn, args });
      if (opts.rpcErrors?.[fn]) {
        return Promise.resolve({ data: null, error: opts.rpcErrors[fn] });
      }
      const data = opts.rpc?.[fn];
      return Promise.resolve({
        data: typeof data === "function" ? data(args) : data ?? null,
        error: null,
      });
    },
    from(table: string) {
      reads.push(table);
      const filters: { op: string; col: string; val: any }[] = [];
      let lim: number | null = null;
      let order: { col: string; asc: boolean } | null = null;
      const q: any = {};
      for (const m of ["insert", "update", "upsert", "delete"]) {
        q[m] = () => {
          writes.push(`${m}:${table}`);
          throw new Error(`write attempted: ${m} ${table}`);
        };
      }
      q.select = () => q;
      q.eq = (
        col: string,
        val: any,
      ) => (filters.push({ op: "eq", col, val }), q);
      q.in = (
        col: string,
        val: any[],
      ) => (filters.push({ op: "in", col, val }), q);
      q.not = (col: string, op: string, val: any) => (
        filters.push(
          op === "is" && val === null
            ? { op: "not_null", col, val }
            : { op: "skip", col, val },
        ), q
      );
      q.is = (
        col: string,
        val: any,
      ) => (filters.push(
        val === null ? { op: "is_null", col, val } : { op: "skip", col, val },
      ),
        q);
      q.ilike = (
        col: string,
        val: string,
      ) => (filters.push({ op: "ilike", col, val }), q);
      q.or = () => q;
      q.gt = () => q;
      q.lte = () => q;
      q.order = (
        col: string,
        o?: { ascending?: boolean },
      ) => ((order = { col, asc: o?.ascending !== false }), q);
      q.limit = (n: number) => ((lim = n), q);
      const result = () => {
        if (opts.failTables?.has(table)) {
          return {
            data: null,
            error: { message: `${table} unavailable`, code: "57014" },
          };
        }
        let rows = (tables[table] ?? []).filter((r: any) =>
          filters.every((f) => matches(r, f))
        );
        if (order) {
          const { col, asc } = order;
          rows = [...rows].sort((a, b) =>
            (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : 1) *
            (asc ? 1 : -1)
          );
        }
        return { data: lim == null ? rows : rows.slice(0, lim), error: null };
      };
      q.maybeSingle = () =>
        Promise.resolve({ ...result(), data: result().data?.[0] ?? null });
      q.then = (res: any, rej: any) => Promise.resolve(result()).then(res, rej);
      return q;
    },
  };
}

function noNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("the job overview door must not call the network");
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}

function fullClient(extra: Partial<Parameters<typeof fakeClient>[0]> = {}) {
  return fakeClient({
    rpc: {
      context_job_story: STORY,
      context_job_story_ledger: LEDGER,
      context_job_story_text_get: STORY_TEXT,
      job_quote_values: QUOTE_VALUES,
      ...(extra.rpc ?? {}),
    },
    ...extra,
  });
}

const deps = (calls: any[] = []) => ({
  getJobConversation: (_client: any, body: any) => {
    calls.push(body);
    return Promise.resolve({ messages: conversation(), summary: {} });
  },
  now: () => new Date("2026-10-09T03:00:00Z"),
});

Deno.test("GET job_overview: every part, read only, no network, the card passed once to the saved-story read", async () => {
  const client = fullClient();
  const convo: any[] = [];
  const o: any = await noNetwork(() =>
    jobOverviewAction(client, new URLSearchParams(`jobId=${JOB}`), deps(convo))
  );
  assertEquals(client.writes, []);
  assertEquals(o.version, JOB_OVERVIEW_VERSION);
  assertEquals(o.generated_at, "2026-10-09T03:00:00.000Z");
  assertEquals(
    client.rpcs.filter((r) => r.fn === "context_job_story").length,
    1,
    "the card is built once",
  );
  assertEquals(client.rpcs.find((r) => r.fn === "context_job_story")!.args, {
    p_job_id: JOB,
  });
  assertEquals(
    client.rpcs.find((r) => r.fn === "context_job_story_ledger")!.args,
    {
      p_job_id: JOB,
      p_generation_id: null,
      p_as_of: "2026-10-09T03:00:00.000Z",
    },
  );
  const textCall = client.rpcs.find((r) =>
    r.fn === "context_job_story_text_get"
  )!;
  assertEquals(textCall.args.p_job_id, JOB);
  assertEquals(
    textCall.args.p_card,
    STORY,
    "the saved story is compared with the card as read, words and all",
  );
  assertEquals(convo, [{ job_id: JOB, limit: 150 }]);
  assertEquals(o.story_text, STORY_TEXT);
  assertEquals(o.job.current_price_inc_gst, 7065.85);
  assertEquals(o.job.job_description, "23m fence, 1800mm, Testvale");
  assertEquals(o.files.scope, { exists: true });
  assertEquals(o.files.media, { photos: 3, videos: 1, total: 4 });
  assertEquals(o.files.media_count, 3);
  for (const [name, s] of Object.entries(o.sources) as [string, any][]) {
    assertEquals(s.ok, true, `${name} ${JSON.stringify(s)}`);
  }
});

Deno.test("no call transcript words anywhere in the answer", async () => {
  const o: any = await jobOverviewAction(
    fullClient(),
    new URLSearchParams(`jobId=${JOB}`),
    deps(),
  );
  const text = JSON.stringify(o);
  assertEquals(
    text.includes(TRANSCRIPT_WORDS),
    false,
    "transcript words reached the overview",
  );
  // the card's own transcript fields are taken out, the rest kept
  assertEquals(o.story.loops[0].why, null);
  assertEquals(o.story.loops[0].what, "Send the deposit link");
  assertEquals(o.story.last_exchange.customer_said.text, null);
  assertEquals(
    o.story.last_exchange.customer_said.text_withheld,
    "call_transcript",
  );
  assertEquals(
    o.story.last_exchange.we_told_customer.text,
    "Bank details sent",
  );
  // the card as read still went to the saved-story check (its digest never reads why or the words)
  assertEquals(STORY.loops[0].why.includes(TRANSCRIPT_WORDS), true);
});

Deno.test("calls merge into one row with their length and no words; empty texts are dropped; dashes become commas", async () => {
  const o: any = await jobOverviewAction(
    fullClient(),
    new URLSearchParams(`jobId=${JOB}`),
    deps(),
  );
  const m = o.messages;
  const calls = m.filter((x: any) => x.kind === "call");
  assertEquals(calls.length, 1, JSON.stringify(calls));
  assertEquals(calls[0].call_seconds, 125);
  assertEquals(calls[0].call_status, "completed");
  assertEquals(calls[0].has_transcript, true);
  assertEquals(calls[0].text, "Call, 2 min 5 s");
  assertEquals(
    calls[0].at,
    "2026-10-09T01:35:00Z",
    "the call row decides the time",
  );
  assertEquals(calls[0].id, `bev:${CALL_ROW}`);
  assertEquals(calls[0].who, "Pat Example");
  // oldest first; the empty and wordless texts are gone; the attachment-only text says so
  assertEquals(m.map((x: any) => x.at), [...m.map((x: any) => x.at)].sort());
  assertEquals(
    m.some((x: any) => x.id === "bev:b0000000-0000-4000-8000-0000000000c6"),
    false,
  );
  assertEquals(
    m.some((x: any) => x.id === "bev:b0000000-0000-4000-8000-0000000000c7"),
    false,
  );
  const photo = m.find((x: any) =>
    x.id === "bev:b0000000-0000-4000-8000-0000000000c8"
  );
  assertEquals([photo.text, photo.attachments_only], [
    "1 attachment: jpeg",
    true,
  ]);
  const reply = m.find((x: any) => x.id === `bev:${SMS_ROW}`);
  assertEquals(
    [reply.text, reply.kind, reply.side, reply.who, reply.at_perth],
    ["Will do, thanks", "text", "them", "Pat Example", "Fri 9 Oct, 9:25am"],
  );
  const ours = m.find((x: any) =>
    x.id === "bev:b0000000-0000-4000-8000-0000000000c5"
  );
  assertEquals([ours.side, ours.who, ours.party], ["us", "Us", "us"]);
  const note = m.find((x: any) => x.id === "note:n1");
  assertEquals([note.kind, note.side, note.who], [
    "note",
    "internal",
    "Us (note)",
  ]);
  const supplier = m.find((x: any) => x.kind === "email");
  assertEquals([supplier.subject, supplier.who, supplier.party], [
    "Fence plan",
    "Supplier",
    "other",
  ]);
  assertEquals(
    m.some((x: any) =>
      x.id === `bev:${LEGACY_CALL_ROW}` || x.id === `bev:${TRANSCRIPT_ROW}`
    ),
    false,
  );
});

Deno.test("the newest 80 messages, oldest first, at most 400 characters each", () => {
  const many = Array.from({ length: 120 }, (_, i) => ({
    id: `bev:m${String(i).padStart(3, "0")}`,
    channel: "sms",
    direction: "inbound",
    occurred_at: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
    body: "x".repeat(500),
    source_system: "business_events",
    source_ref: `m${i}`,
  }));
  const out = overviewMessages(many, new Map(), null);
  assertEquals(out.length, OVERVIEW_MESSAGE_LIMIT);
  assertEquals(out[0].id, "bev:m040");
  assertEquals(out[out.length - 1].id, "bev:m119");
  assert(out.every((x: any) => x.text.length <= 400));
  assertEquals(out[0].who, "Customer");
});

Deno.test("a draft is never invoiced and a deleted invoice counts for nothing; a bill is not a customer invoice", async () => {
  const o: any = await jobOverviewAction(
    fullClient(),
    new URLSearchParams(`jobId=${JOB}`),
    deps(),
  );
  const inv = o.files.invoices;
  assertEquals(inv.map((i: any) => i.number).sort(), [
    "INV-T1",
    "INV-T2",
    "INV-T3",
  ]);
  const draft = inv.find((i: any) => i.number === "INV-T1");
  assertEquals([
    draft.draft,
    draft.counts_as_invoiced,
    draft.status_words,
    draft.amount_due,
  ], [true, false, "draft, cannot be paid", 0]);
  const deleted = inv.find((i: any) => i.number === "INV-T3");
  assertEquals([
    deleted.removed,
    deleted.counts_as_invoiced,
    deleted.amount_paid,
    deleted.fully_paid_on,
  ], [true, false, 0, null]);
  assertEquals(o.files.invoice_totals, {
    invoiced: 1000,
    paid: 600,
    owing: 400,
    drafts: 1,
    draft_total: 3571.43,
  });
  // job_detail's client-name fallback is not copied: one read of the rows on this job
  const client = fullClient();
  await jobOverviewAction(client, new URLSearchParams(`jobId=${JOB}`), deps());
  assertEquals(client.reads.filter((t) => t === "xero_invoices").length, 1);
  assertEquals(
    overviewInvoice({ status: "SUBMITTED", total: 10 }).status_words,
    "awaiting approval, cannot be paid",
  );
  assertEquals(invoiceTotals([]), {
    invoiced: 0,
    paid: 0,
    owing: 0,
    drafts: 0,
    draft_total: 0,
  });
});

Deno.test("quotes: the value only from job_quote_values, views counted per document, a replaced quote last", async () => {
  const o: any = await jobOverviewAction(
    fullClient(),
    new URLSearchParams(`jobId=${JOB}`),
    deps(),
  );
  const docs = o.files.quotes.documents;
  assertEquals(
    docs.map((
      d: any,
    ) => [
      d.document_id,
      d.version,
      d.status,
      d.value_inc_gst,
      d.view_count,
      d.current,
    ]),
    [
      [QUOTE_DOC, 3, "accepted", 7065.85, 2, true],
      [OLD_QUOTE_DOC, 2, "replaced", null, 1, false],
    ],
  );
  // the job's live price is labelled apart, never a quote's value
  assertEquals(o.job.current_price_inc_gst, 7065.85);
});

Deno.test("attachments: email attachments once each and uploads; our own documents are not attachments", async () => {
  const o: any = await jobOverviewAction(
    fullClient(),
    new URLSearchParams(`jobId=${JOB}`),
    deps(),
  );
  assertEquals(
    o.files.attachments.map((a: any) => [a.source, a.file_name, a.page_count]),
    [
      ["upload", "council-letter.pdf", null],
      ["email_attachment", "fence-plan.pdf", 2],
    ],
  );
});

Deno.test("AI notes: owner, group, the date they are true at, receipts never from a call transcript", async () => {
  const o: any = await jobOverviewAction(
    fullClient(),
    new URLSearchParams(`jobId=${JOB}`),
    deps(),
  );
  assertEquals(
    [o.notes.status, o.notes.generation_id, o.notes.evidence_until],
    ["live", GEN, "2026-10-09T01:30:00Z"],
  );
  const byId = Object.fromEntries(o.notes.items.map((n: any) => [n.id, n]));
  const deposit = byId.deposit_link;
  assertEquals([deposit.group, deposit.owner, deposit.what, deposit.as_at], [
    "blocking",
    "us",
    "Send the deposit link, today",
    "Thu 8 Oct",
  ]);
  assertEquals(deposit.receipt, {
    table: "business_events",
    id: TRANSCRIPT_ROW,
    excerpt: null,
  });
  const tenants = byId.tenants_away;
  assertEquals([tenants.group, tenants.receipt.excerpt], [
    "good_to_know",
    "They are away, back on the 20th",
  ]);
  const neighbour = byId.neighbour_pays;
  assertEquals([
    neighbour.group,
    neighbour.owner,
    neighbour.owner_name,
    neighbour.receipt.excerpt,
  ], ["waiting", "third_party", "Sam Neighbour", "I will pay my half"]);
  assertEquals([byId.old_claim.shown, byId.old_claim.receipt], [false, null]);
  // the receipts' kinds are read once, by id
  const client = fullClient();
  await jobOverviewAction(client, new URLSearchParams(`jobId=${JOB}`), deps());
  assert(client.reads.includes("business_events"));
});

Deno.test("an unreadable receipt kind shows no words (fail closed)", async () => {
  const tables = TABLES();
  tables.business_events = tables.business_events.filter((r: any) =>
    r.id !== SMS_ROW
  );
  const o: any = await jobOverviewAction(
    fullClient({ tables }),
    new URLSearchParams(`jobId=${JOB}`),
    deps(),
  );
  const tenants = o.notes.items.find((n: any) => n.id === "tenants_away");
  assertEquals(tenants.receipt.excerpt, null);
});

Deno.test("a failed story read leaves every other part, and the saved story answers unchecked", async () => {
  const client = fullClient({
    rpcErrors: {
      context_job_story: {
        message: "canceling statement due to statement timeout",
        code: "57014",
      },
    },
  });
  const o: any = await jobOverviewAction(
    client,
    new URLSearchParams(`jobId=${JOB}`),
    deps(),
  );
  assertEquals(o.story, null);
  assertEquals(o.sources.story.ok, false);
  assertEquals(o.sources.story.code, "rpc_failed");
  assertEquals(
    client.rpcs.find((r) => r.fn === "context_job_story_text_get")!.args,
    { p_job_id: JOB, p_check: false },
  );
  assert(Array.isArray(o.messages) && o.messages.length > 0);
  assert(o.notes && o.files.invoices && o.files.quotes);
  assertEquals(
    JSON.stringify(o).includes("statement timeout"),
    false,
    "the database's own words stay in the server log",
  );
});

Deno.test("a part that fails is null with a code, never empty; the saved story not installed yet reads not_deployed", async () => {
  const client = fullClient({
    failTables: new Set(["xero_invoices", "job_media"]),
    rpcErrors: {
      context_job_story_text_get: {
        message: "Could not find the function",
        code: "PGRST202",
      },
    },
  });
  const o: any = await jobOverviewAction(
    client,
    new URLSearchParams(`jobId=${JOB}`),
    deps(),
  );
  assertEquals([
    o.files.invoices,
    o.files.invoice_totals,
    o.sources.invoices.ok,
    o.sources.invoices.code,
  ], [null, null, false, "read_failed"]);
  assertEquals([o.files.media, o.files.media_count, o.sources.media.ok], [
    null,
    null,
    false,
  ]);
  assertEquals(o.story_text, null);
  assertEquals(o.sources.story_text, {
    ok: false,
    state: "not_deployed",
    count: 0,
    code: "not_deployed",
  });
  assert(o.story && o.messages);
  assertEquals(isMissingFunction({ code: "42883" }), true);
  assertEquals(isMissingFunction({ code: "57014" }), false);
});

Deno.test("the deploy probe and a bad job are refused before any read", async () => {
  for (const params of ["jobId=__deploy_probe__", "job_id=12", ""]) {
    const client = fullClient();
    const err = await assertRejects(
      () =>
        noNetwork(() =>
          jobOverviewAction(client, new URLSearchParams(params), deps())
        ),
      StoryReadError,
    );
    assertEquals(err.status, 400);
    assertEquals(client.reads, [], params);
    assertEquals(client.rpcs, [], params);
  }
  const missing = await assertRejects(
    () =>
      jobOverviewAction(
        fullClient({ tables: { ...TABLES(), jobs: [] } }),
        new URLSearchParams(`jobId=${JOB}`),
        deps(),
      ),
    StoryReadError,
  );
  assertEquals([missing.code, missing.status], ["job_not_found", 404]);
  const byNumber: any = await jobOverviewAction(
    fullClient(),
    new URLSearchParams("job_number=swf-t0101"),
    deps(),
  );
  assertEquals(byNumber.job.id, JOB);
});

Deno.test("POST request_job_story: the verified caller asks, never a body field; the SQL outcome passes through", async () => {
  const client = fakeClient({
    rpc: {
      context_job_story_request: {
        outcome: "queued",
        request_id: "r1",
        requested_at: "2026-10-09T03:00:00Z",
        reason: "asked",
      },
    },
  });
  const r: any = await noNetwork(() =>
    requestJobStoryAction(client, {
      jobId: JOB,
      p_by: "user:someone-else",
      requested_by: "user:someone-else",
      reason: "job_changed",
    }, "user:verified-1")
  );
  assertEquals(client.rpcs, [{
    fn: "context_job_story_request",
    args: { p_job_id: JOB, p_by: "user:verified-1", p_reason: "asked" },
  }]);
  assertEquals([r.outcome, r.request_id, r.job_id, r.version], [
    "queued",
    "r1",
    JOB,
    "job-story-request-v1",
  ]);
  assertEquals(client.writes, []);
  const off: any = await requestJobStoryAction(
    fakeClient({ rpc: { context_job_story_request: { outcome: "off" } } }),
    { job_id: JOB },
    "user:verified-1",
  );
  assertEquals(off.outcome, "off");
  const bad = fakeClient();
  const err = await assertRejects(
    () =>
      requestJobStoryAction(
        bad,
        { jobId: "__deploy_probe__" },
        "user:verified-1",
      ),
    StoryReadError,
  );
  assertEquals([err.code, err.status, bad.rpcs.length], [
    "invalid_job_id",
    400,
    0,
  ]);
  const notYet = await assertRejects(
    () =>
      requestJobStoryAction(
        fakeClient({
          rpcErrors: {
            context_job_story_request: { code: "PGRST202", message: "x" },
          },
        }),
        { jobId: JOB },
        "u",
      ),
    StoryReadError,
  );
  assertEquals([notYet.code, notYet.status], ["not_deployed", 503]);
  const broken = await assertRejects(
    () =>
      requestJobStoryAction(
        fakeClient({
          rpcErrors: {
            context_job_story_request: { code: "XX000", message: "boom" },
          },
        }),
        { jobId: JOB },
        "u",
      ),
    StoryReadError,
  );
  assertEquals([broken.code, broken.status, broken.message.includes("boom")], [
    "request_failed",
    502,
    false,
  ]);
});

Deno.test("both doors are staff-only: not profile-scoped, not agent-read, trades refused", () => {
  for (const action of ["job_overview", "request_job_story"]) {
    const url = new URL(`https://example.invalid/ops-api?action=${action}`);
    assertEquals(_opsApiActionNeedsStaffRole(url), true, action);
    assertEquals(AGENT_READ_ALLOWED_ACTIONS.has(action), false, action);
    const decide = (
      authMode: "api_key" | "jwt",
      role?: string,
      managedVerticals?: string[],
    ) => {
      const d = _authorizeOpsApiAction({
        url,
        authMode,
        authUser: role ? { role, managedVerticals } : null,
        serverSecretPresented: authMode === "api_key",
      });
      return d.ok ? 200 : d.status;
    };
    assertEquals(decide("jwt", "admin"), 200, action);
    assertEquals(decide("jwt", "owner"), 200, action);
    assertEquals(decide("jwt", "ops_manager"), 200, action);
    assertEquals(decide("api_key"), 200, action);
    assertEquals(decide("jwt", "lead_installer", ["fencing"]), 403, action);
    assertEquals(decide("jwt", "trade"), 403, action);
  }
});

Deno.test("the dispatch: job_overview GET only, request_job_story POST only, the asker is the verified actor", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const start = index.indexOf("case 'job_overview':");
  assert(start > 0, "job_overview is not dispatched");
  const block = index.slice(
    start,
    index.indexOf("// ── Same-site links", start),
  );
  assert(block.includes("case 'request_job_story': {"));
  assert(
    block.includes(
      "if (authMode === 'jwt' && authUser?.orgId !== DEFAULT_ORG_ID)",
    ),
  );
  assert(
    block.includes(
      "if (req.method !== 'GET') return json({ error: `${action} requires GET` }, 405)",
    ),
  );
  assert(
    block.includes(
      "return json(await jobOverviewAction(client, url.searchParams, { getJobConversation }))",
    ),
  );
  assert(
    block.includes(
      "if (req.method !== 'POST') return json({ error: `${action} requires POST` }, 405)",
    ),
  );
  assert(
    block.includes(
      "return json(await requestJobStoryAction(client, body, receiptActor(requestActor, authMode)))",
    ),
  );
  assert(
    block.includes(
      "if (error instanceof StoryReadError) return json({ error: error.message, code: error.code }, error.status)",
    ),
  );
});

Deno.test("plain words and Perth time", () => {
  assertEquals(
    plainText(`23m Colorbond ${DASH} 1800mm ${DASH} Testvale`),
    "23m Colorbond, 1800mm, Testvale",
  );
  assertEquals(plainText("5\u201310 days"), "5 to 10 days");
  assertEquals(
    plainText(`${DASH} leading and trailing ${DASH}`),
    "leading and trailing",
  );
  assertEquals(plainText(null), "");
  assertEquals(perthDay("2026-10-08T06:01:00Z"), "Thu 8 Oct");
  assertEquals(perthStamp("2026-10-08T06:01:00Z"), "Thu 8 Oct, 2:01pm");
  assertEquals(perthStamp("2026-10-08T16:05:00Z"), "Fri 9 Oct, 12:05am");
  assertEquals(perthStamp("not a time"), null);
  assertEquals(callWords("inbound", "no-answer", 0), "Missed call");
  assertEquals(callWords("outbound", "busy", null), "Call not answered");
  assertEquals(callWords("inbound", "voicemail", 20), "Voicemail");
  assertEquals(callWords("inbound", "completed", 120), "Call, 2 min");
  assertEquals(callWords("inbound", "completed", 45), "Call, 45 s");
  assertEquals(callWords("inbound", null, null), "Call");
});

Deno.test("note groups and owners follow the story's rule", () => {
  assertEquals(
    noteGroup({ status: "open", blocks: "booking", item_type: "constraint" }),
    "blocking",
  );
  assertEquals(
    noteGroup({ status: "open", blocks: "none", item_type: "request" }),
    "waiting",
  );
  assertEquals(
    noteGroup({ status: "open", item_type: "agreement", modality: "offered" }),
    "waiting",
  );
  assertEquals(
    noteGroup({ status: "open", item_type: "constraint" }),
    "good_to_know",
  );
  assertEquals(
    noteGroup({ status: "closed", blocks: "deposit", item_type: "request" }),
    "good_to_know",
  );
  assertEquals(
    noteOwner({
      item_type: "commitment",
      from_role: "customer",
      from_name: "Pat",
    }),
    { owner: "customer", owner_name: "Pat" },
  );
  assertEquals(
    noteOwner({ item_type: "request", from_role: "customer", to_role: null }),
    { owner: "us", owner_name: null },
  );
  assertEquals(noteOwner({ item_type: "dependency", to_role: "us" }), {
    owner: "third_party",
    owner_name: null,
  });
  assertEquals(
    noteOwner({ item_type: "agreement", from_role: "us", to_role: "customer" }),
    { owner: "customer", owner_name: null },
  );
  assertEquals(noteOwner({ item_type: "issue", from_role: "customer" }), {
    owner: "us",
    owner_name: null,
  });
});
