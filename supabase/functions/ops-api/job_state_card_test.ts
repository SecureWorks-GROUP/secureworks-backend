// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
//
// Job state card (state-card-v1, 4 Oct 2026): every job read returns an honest
// state, built with no model call from what the dossier already reads, and a
// visible not-known list.
//
// Pins:
//   Empty live job   no linked messages, no brief, no visit outcome: the
//                    record state still shows, and not_known names "No
//                    messages are linked...", "No brief yet", "No visit
//                    outcome recorded" and the customer's unplaced messages.
//   Facts and brief  a current stored brief is reported present with its
//                    written time and current/stale, the facts count leaves
//                    the brief out, and the brief fact's value.text in the
//                    dossier is readable text, never the stored JSON (kept on
//                    value.raw_text).
//   Open invoice     open (AUTHORISED with money due) invoices are counted
//                    with the amount due; drafts, paid, voided and bills are
//                    not money due.
//   Failures         a source the dossier could not read is named in
//                    not_known, never reported as "none".
//   Dossier          `state` is top level with the shared contract keys,
//                    sections_version is 4, the stale transcripts warning is
//                    gone, and the read stays read only.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildJobStateCard,
  JOB_STATE_CARD_VERSION,
  type JobStateCardInput,
  money,
  perthDate,
  perthDateTime,
} from "./job_state_card.ts";
import type { JobFreshness } from "./job_freshness.ts";
import { _assembleJobDossierForTest } from "./index.ts";

const NOW = "2026-10-04T14:00:00.000Z"; // 4 Oct 2026 22:00 Perth
const ORG = "00000000-0000-0000-0000-000000000001";

function freshness(over: Partial<JobFreshness> = {}): JobFreshness {
  return {
    last_run_finished_at: null,
    unread_count: 0,
    oldest_unread_landed_at: null,
    next_due_at: null,
    runs_today: 0,
    blocked_reason: null,
    unplaced_for_contact: { count: 0, newest_at: null },
    contact_missing: false,
    line: "No facts read yet; 0 newer items not yet read",
    ...over,
  };
}

function storedBrief(over: { status?: string; truncated?: boolean } = {}) {
  return JSON.stringify({
    schema_version: 8,
    header: {
      written_at: "2026-10-04T02:23:18.184Z",
      written_by: { model: "m", prompt_sha: "p", commit: "c" },
      evidence: {
        events_read: 4,
        records_read: 17,
        newest_event_at: "2026-10-04T02:01:59.648Z",
        truncated: over.truncated ?? false,
        through_sequence: "46300",
        through_recorded_at: "2026-10-04T02:03:03.818Z",
        coverage: null,
      },
      contact_id: "c-1",
      job: {
        job_number: "SWF-1",
        type: "fencing",
        status: over.status ?? "quoted",
        suburb: "Somewhere",
      },
      carried_from_previous: false,
      validator_repairs: 0,
      calls: [],
      insufficient: [],
    },
    sources: [],
    lines: [
      {
        section: "where_it_stands",
        text: "Q-0822 version 1 was sent and viewed on 1 October.",
        mark: "record",
        cites: [1],
      },
      {
        section: "owed_next",
        text: "We owe the customer an answer on the gate width.",
        mark: "inferred",
        rests_on: [0],
      },
      {
        section: "not_known",
        text: "No visit outcome is recorded.",
        mark: "gap",
      },
    ],
  });
}

function briefRow(text = storedBrief()) {
  return {
    id: "brief-1",
    job_id: "job-1",
    kind: "job_brief",
    value: { text, confidence: 0.9, source_refs: [] },
    created_at: "2026-10-04T02:23:18.476Z",
    updated_at: "2026-10-04T02:23:18.476Z",
    _context_store: "job_context",
  };
}

function baseInput(over: Partial<JobStateCardInput> = {}): JobStateCardInput {
  return {
    now: NOW,
    job: {
      status: "quoted",
      created_at: "2026-09-20T01:00:00.000Z",
      quoted_at: "2026-10-01T04:00:00.000Z",
      updated_at: "2026-10-02T04:00:00.000Z",
      ghl_contact_id: "c-1",
    },
    quotes: quotes([]),
    quotesOk: true,
    invoices: { ok: true, rows: [] },
    assignments: { ok: true, rows: [] },
    conversation: { ok: true, rows: [] },
    facts: { ok: true, rows: [] },
    briefs: { ok: true, rows: [] },
    visitOutcomes: { ok: true, rows: [] },
    freshness: freshness(),
    ...over,
  };
}

function quotes(current: any[]): any {
  return {
    status: "viewed",
    outstanding: [],
    whole_quote_total: null,
    headline: null,
    current,
    bound_revision: null,
    run_acceptances: [],
    history: [],
    history_total: 0,
    unsent_documents: 0,
    note: null,
    read: { values: "ok", recipients: "ok" },
  };
}

// ── pure card ────────────────────────────────────────────────────────────────

Deno.test("state card: Perth dates and money read plainly", () => {
  assertEquals(perthDate("2026-10-04T17:00:00.000Z"), "5 Oct 2026");
  assertEquals(perthDate("2026-10-07"), "7 Oct 2026");
  assertEquals(
    perthDateTime("2026-10-04T02:23:18.184Z"),
    "4 Oct 2026 10:23 Perth",
  );
  assertEquals(perthDate(null), null);
  assertEquals(money(1234.5), "$1,234.50");
  assertEquals(money(0), "$0.00");
});

Deno.test("state card: an empty live job shows its record state and says what is not known", () => {
  const card = buildJobStateCard(baseInput({
    quotes: quotes([]),
    freshness: freshness({
      unplaced_for_contact: { count: 3, newest_at: null },
    }),
  }));
  assertEquals(card.version, JOB_STATE_CARD_VERSION);
  assertEquals(card.version, "state-card-v1");
  assertEquals(card.lines, [
    "Stage: quoted, since 1 Oct 2026.",
    "No sent quote on record in our systems.",
    "No bookings on record.",
    "No invoices on record.",
    "No texts, calls or emails seen for this job.",
    "No facts on file yet.",
    "Linked messages: 0 shown, 0 not yet read, never read.",
  ]);
  assertEquals(card.not_known, [
    "No brief yet.",
    "No messages are linked to this job, so nothing has been read from texts, calls or emails.",
    "No visit outcome recorded.",
    "3 messages from this customer are not placed on any job.",
  ]);
  assertEquals(card.brief, {
    present: false,
    written_at: null,
    stale: false,
    stale_reason: null,
    fact_id: null,
    text: null,
  });
  for (const line of [...card.lines, ...card.not_known]) {
    assert(!line.includes("—"), `no em dash: ${line}`);
  }
});

Deno.test("state card: no CRM contact is named, and one unplaced message reads singular", () => {
  const none = buildJobStateCard(baseInput({
    job: {
      status: "draft",
      created_at: "2026-09-20T01:00:00.000Z",
      ghl_contact_id: null,
    },
    freshness: freshness({ contact_missing: true }),
  }));
  assert(none.not_known.includes("No CRM contact on this job."));
  assertEquals(none.lines[0], "Stage: draft, since 20 Sep 2026.");
  const one = buildJobStateCard(baseInput({
    freshness: freshness({
      unplaced_for_contact: { count: 1, newest_at: null },
    }),
  }));
  assert(
    one.not_known.includes(
      "1 message from this customer is not placed on any job.",
    ),
  );
});

Deno.test("state card: facts and a current brief are reported, the brief is readable text", () => {
  const card = buildJobStateCard(baseInput({
    facts: {
      ok: true,
      rows: [briefRow(), { id: "f1", kind: "note" }, {
        id: "f2",
        kind: "scope_spec",
      }],
    },
    briefs: { ok: true, rows: [briefRow()] },
    conversation: {
      ok: true,
      rows: [
        {
          channel: "sms",
          direction: "inbound",
          occurred_at: "2026-10-04T02:01:59.648Z",
          source_system: "business_events",
        },
        {
          channel: "note",
          direction: "internal",
          occurred_at: "2026-10-04T05:00:00.000Z",
          source_system: "job_events",
        },
      ],
    },
    freshness: freshness({
      last_run_finished_at: "2026-10-04T02:23:18.000Z",
      unplaced_for_contact: { count: 0, newest_at: null },
    }),
  }));
  assert(card.lines.includes("Facts on file: 2."));
  assert(
    card.lines.includes("Brief: written 4 Oct 2026 10:23 Perth, current."),
  );
  assert(
    card.lines.includes(
      "Newest contact: text from the customer on 4 Oct 2026.",
    ),
  );
  assert(
    card.lines.includes(
      "Linked messages: 1 shown, 0 not yet read, last read 4 Oct 2026 10:23 Perth.",
    ),
  );
  assertEquals(card.not_known, ["No visit outcome recorded."]);
  assertEquals(card.brief.present, true);
  assertEquals(card.brief.written_at, "2026-10-04T02:23:18.184Z");
  assertEquals(card.brief.stale, false);
  assertEquals(card.brief.fact_id, "brief-1");
  const text = card.brief.text as string;
  assert(
    text.startsWith("Job brief written 4 Oct 2026 10:23 Perth; current.\n"),
  );
  assertStringIncludes(
    text,
    "Where it stands:\n- Q-0822 version 1 was sent and viewed on 1 October. (from our records)",
  );
  assertStringIncludes(
    text,
    "Owed next:\n- We owe the customer an answer on the gate width. (inferred)",
  );
  assertStringIncludes(text, "Not known:\n- No visit outcome is recorded.");
  assert(!text.includes("schema_version"));
  assert(!text.includes("{"));
});

Deno.test("state card: a brief is stale when newer messages wait, the stage moved, or currency cannot be checked", () => {
  const unread = buildJobStateCard(baseInput({
    briefs: { ok: true, rows: [briefRow()] },
    freshness: freshness({
      unread_count: 2,
      last_run_finished_at: "2026-10-04T02:23:18.000Z",
    }),
  }));
  assertEquals(unread.brief.stale, true);
  assertEquals(
    unread.brief.stale_reason,
    "2 newer messages not yet read into it",
  );
  assertStringIncludes(
    unread.brief.text as string,
    "may be out of date: 2 newer messages not yet read into it",
  );

  const moved = buildJobStateCard(baseInput({
    job: {
      status: "accepted",
      accepted_at: "2026-10-03T00:00:00.000Z",
      ghl_contact_id: "c-1",
    },
    briefs: { ok: true, rows: [briefRow()] },
  }));
  assertEquals(moved.brief.stale, true);
  assertEquals(
    moved.brief.stale_reason,
    "the job stage changed from quoted to accepted since it was written",
  );

  const blind = buildJobStateCard(baseInput({
    briefs: { ok: true, rows: [briefRow(storedBrief({ truncated: true }))] },
    freshness: null,
  }));
  assertEquals(blind.brief.stale, true);
  assertEquals(
    blind.brief.stale_reason,
    "could not check for newer messages; it was written from a thread read that was cut short",
  );
  assert(blind.not_known.includes(
    "Could not check how current the facts are or how many linked messages are unread.",
  ));
  // without freshness the card never claims "no messages are linked"
  assert(!blind.not_known.some((l) => l.startsWith("No messages are linked")));
});

Deno.test("state card: open invoices count only AUTHORISED or SUBMITTED money due", () => {
  const card = buildJobStateCard(baseInput({
    invoices: {
      ok: true,
      rows: [
        {
          invoice_number: "INV-1",
          status: "AUTHORISED",
          invoice_type: "ACCREC",
          amount_due: 1200.5,
        },
        {
          invoice_number: "INV-2",
          status: "SUBMITTED",
          invoice_type: "ACCREC",
          amount_due: 300,
        },
        {
          invoice_number: "INV-3",
          status: "PAID",
          invoice_type: "ACCREC",
          amount_due: 0,
        },
        {
          invoice_number: "INV-4",
          status: "DRAFT",
          invoice_type: "ACCREC",
          amount_due: 500,
        },
        {
          invoice_number: "INV-5",
          status: "VOIDED",
          invoice_type: "ACCREC",
          amount_due: 900,
        },
        {
          invoice_number: "BILL-1",
          status: "AUTHORISED",
          invoice_type: "ACCPAY",
          amount_due: 700,
        },
      ],
    },
  }));
  assert(card.lines.includes(
    "Open invoices: 2, $1,500.50 due (INV-1, INV-2); also 1 draft not yet issued, 1 paid.",
  ));
  const none = buildJobStateCard(baseInput({
    invoices: {
      ok: true,
      rows: [{ invoice_number: "INV-3", status: "PAID", amount_due: 0 }],
    },
  }));
  assert(none.lines.includes("No open invoices (1 paid)."));
});

Deno.test("state card: newest sent quote, bookings and visit outcome lines", () => {
  const card = buildJobStateCard(baseInput({
    quotes: quotes([
      {
        document_id: "d1",
        quote_number: "Q-0800",
        version: 1,
        run_label: null,
        sent_at: "2026-09-20T02:00:00.000Z",
        viewed_at: null,
        accepted_at: null,
        declined_at: null,
        superseded_at: null,
        status: "sent",
        value_inc_gst: 4000,
      },
      {
        document_id: "d2",
        quote_number: "Q-0822",
        version: 2,
        run_label: null,
        sent_at: "2026-10-01T02:00:00.000Z",
        viewed_at: "2026-10-01T05:00:00.000Z",
        accepted_at: null,
        declined_at: null,
        superseded_at: null,
        status: "viewed",
        value_inc_gst: 4842.45,
      },
    ]),
    assignments: {
      ok: true,
      rows: [
        {
          scheduled_date: "2026-10-09",
          assignment_type: "install",
          crew_name: "Crew A",
          status: "confirmed",
        },
        {
          scheduled_date: "2026-10-07",
          assignment_type: "install",
          crew_name: "Crew B",
          status: "cancelled",
        },
        { scheduled_date: "2026-10-08", role: "observer", status: "scheduled" },
        {
          scheduled_date: "2026-09-28",
          assignment_type: "scope",
          crew_name: null,
          status: "complete",
        },
      ],
    },
    visitOutcomes: {
      ok: true,
      rows: [
        {
          id: "v1",
          visit_start: "2026-09-28T02:00:00.000Z",
          outcome: "did_not_happen",
          reason: "customer_not_home",
          quote_owed: false,
          supersedes: null,
        },
        {
          id: "v2",
          visit_start: "2026-09-28T02:00:00.000Z",
          outcome: "happened",
          reason: null,
          quote_owed: true,
          supersedes: "v1",
          recorded_at: "2026-09-28T06:00:00.000Z",
        },
      ],
    },
  }));
  assert(card.lines.includes(
    "Newest sent quote: Q-0822 version 2, $4,842.45 inc GST, sent 1 Oct 2026, viewed 1 Oct 2026, not accepted.",
  ));
  assert(
    card.lines.includes("Next booking: 9 Oct 2026 (install with Crew A)."),
  );
  assert(card.lines.includes("Last booking: 28 Sep 2026 (scope)."));
  assert(
    card.lines.includes(
      "Last visit outcome: visit happened on 28 Sep 2026, quote owed.",
    ),
  );
  assert(!card.not_known.includes("No visit outcome recorded."));
});

Deno.test("state card: a failed read is named in not_known, never reported as none", () => {
  const card = buildJobStateCard(baseInput({
    quotes: null,
    quotesOk: false,
    invoices: { ok: false, rows: [] },
    assignments: { ok: false, rows: [] },
    conversation: { ok: false, rows: [] },
    facts: { ok: false, rows: [] },
    briefs: { ok: false, rows: [] },
    visitOutcomes: { ok: false, rows: [] },
  }));
  assertEquals(card.lines, [
    "Stage: quoted, since 1 Oct 2026.",
    "Linked messages: count unknown, 0 not yet read, never read.",
  ]);
  for (
    const what of [
      "quotes",
      "bookings",
      "invoices",
      "messages",
      "the brief",
      "facts",
      "visit outcomes",
    ]
  ) {
    assert(
      card.not_known.includes(
        `Could not read ${what}, so it is left out of this card.`,
      ),
      what,
    );
  }
  assert(!card.not_known.includes("No brief yet."));
  assert(!card.not_known.includes("No visit outcome recorded."));
  assert(!card.not_known.some((l) => l.startsWith("No messages are linked")));
});

// ── through the dossier ──────────────────────────────────────────────────────

type Tables = Record<string, any[]>;
const WRITE_METHODS = ["insert", "update", "upsert", "delete"];

function fakeClient(tables: Tables, fresh: JobFreshness | null) {
  const rpcs: string[] = [];
  const writes: string[] = [];
  return {
    rpcs,
    writes,
    async rpc(fn: string) {
      rpcs.push(fn);
      if (fn === "context_job_freshness") {
        return fresh
          ? { data: structuredClone(fresh), error: null }
          : { data: null, error: { code: "57014", message: "timeout" } };
      }
      return { data: [], error: null };
    },
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let single = false;
      const q: any = {};
      for (const m of WRITE_METHODS) {
        q[m] = () => {
          writes.push(`${m}:${table}`);
          throw new Error(`write attempted: ${m} ${table}`);
        };
      }
      q.eq = (c: string, v: any) => {
        filters.push((r) => r[c] === v);
        return q;
      };
      for (
        const m of [
          "select",
          "neq",
          "in",
          "gt",
          "ilike",
          "is",
          "or",
          "not",
          "gte",
          "lt",
          "lte",
          "contains",
          "range",
          "order",
          "limit",
        ]
      ) q[m] = () => q;
      q.maybeSingle = () => {
        single = true;
        return q;
      };
      q.single = q.maybeSingle;
      q.then = (resolve: any, reject: any) => {
        const rows = (tables[table] ?? []).filter((r) =>
          filters.every((f) => f(r))
        );
        return Promise.resolve({
          data: single ? rows[0] ?? null : rows,
          error: null,
        })
          .then(resolve, reject);
      };
      return q;
    },
  };
}

const JOB = "5c000000-0000-4000-8000-000000000001";

function jobTables(over: Record<string, unknown> = {}): Tables {
  return {
    jobs: [{
      id: JOB,
      job_number: "SWF-STATE1",
      type: "fencing",
      status: "quoted",
      client_name: "Row label only",
      client_email: null,
      ghl_contact_id: "contact-1",
      org_id: ORG,
      created_at: "2026-09-20T01:00:00.000Z",
      quoted_at: "2026-10-01T04:00:00.000Z",
      scope_json: null,
      pricing_json: null,
      scope_version: null,
      scope_updated_at: null,
      ...over,
    }],
  };
}

async function noNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("the job read must not call the network");
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

function assertContract(d: any) {
  assertEquals(d.state.version, "state-card-v1");
  assert(
    Array.isArray(d.state.lines) &&
      d.state.lines.every((l: unknown) => typeof l === "string"),
  );
  assert(
    Array.isArray(d.state.not_known) &&
      d.state.not_known.every((l: unknown) => typeof l === "string"),
  );
  assertEquals(typeof d.state.brief.present, "boolean");
  assert(
    d.state.brief.written_at === null ||
      typeof d.state.brief.written_at === "string",
  );
  assertEquals(typeof d.state.brief.stale, "boolean");
  assertEquals(d.sections_version, 4);
  assert(
    !d.diagnostics.warnings.some((w: string) => w.startsWith("transcripts:")),
  );
}

Deno.test("dossier: an empty live job returns its state and an explicit not-known list, read only", async () => {
  const client = fakeClient(
    jobTables(),
    freshness({
      unplaced_for_contact: { count: 2, newest_at: "2026-10-01T00:00:00.000Z" },
    }),
  );
  const d: any = await noNetwork(() =>
    _assembleJobDossierForTest(client, { job_id: JOB })
  );
  assertContract(d);
  assertEquals(d.state.lines[0], "Stage: quoted, since 1 Oct 2026.");
  assert(d.state.lines.includes("No sent quote on record in our systems."));
  assert(d.state.lines.includes("No invoices on record."));
  assertEquals(d.state.not_known, [
    "No brief yet.",
    "No messages are linked to this job, so nothing has been read from texts, calls or emails.",
    "No visit outcome recorded.",
    "2 messages from this customer are not placed on any job.",
  ]);
  assertEquals(d.state.brief.present, false);
  assertEquals(client.writes, []);
  assertEquals([...new Set(client.rpcs)].sort(), [
    "context_job_freshness",
    "job_quote_values",
  ]);
  assertEquals(d.diagnostics.sourceStatus.brief, { ok: true, count: 0 });
  assertEquals(d.diagnostics.sourceStatus.visitOutcomes, {
    ok: true,
    count: 0,
  });
});

Deno.test("dossier: a job with facts and a brief shows the brief as readable text with its freshness", async () => {
  const t = jobTables();
  const brief = {
    ...briefRow(),
    job_id: JOB,
    lifecycle: "current",
    expires_at: null,
    provenance: { lifecycle: "active", safety: { memory_trusted: true } },
  };
  t.current_job_context_facts = [
    brief,
    {
      id: "fact-1",
      job_id: JOB,
      kind: "client_preference",
      value: { text: "Prefers texts after 4pm." },
      provenance: { lifecycle: "active", safety: { memory_trusted: true } },
      lifecycle: "current",
      expires_at: null,
      created_at: "2026-10-04T02:23:18.476Z",
      updated_at: "2026-10-04T02:23:18.476Z",
      _context_store: "job_context",
    },
  ];
  t.visit_outcomes = [{
    id: "v-1",
    job_id: null,
    contact_id: "contact-1",
    visit_start: "2026-09-28T02:00:00.000Z",
    outcome: "happened",
    reason: null,
    quote_owed: true,
    recorded_at: "2026-09-28T06:00:00.000Z",
    supersedes: null,
  }, {
    id: "v-other",
    job_id: "another-job",
    contact_id: "contact-1",
    visit_start: "2026-09-30T02:00:00.000Z",
    outcome: "did_not_happen",
    reason: "rescheduled",
    quote_owed: false,
    recorded_at: "2026-09-30T06:00:00.000Z",
    supersedes: null,
  }];
  const client = fakeClient(
    t,
    freshness({ last_run_finished_at: "2026-10-04T02:23:20.000Z" }),
  );
  const d: any = await noNetwork(() =>
    _assembleJobDossierForTest(client, { job_id: JOB })
  );
  assertContract(d);
  assertEquals(d.state.brief.present, true);
  assertEquals(d.state.brief.written_at, "2026-10-04T02:23:18.184Z");
  assertEquals(d.state.brief.stale, false);
  assert(
    d.state.lines.includes("Brief: written 4 Oct 2026 10:23 Perth, current."),
  );
  assert(d.state.lines.includes("Facts on file: 1."));
  // the visit outcome on another job of the same customer is not this job's
  assert(
    d.state.lines.includes(
      "Last visit outcome: visit happened on 28 Sep 2026, quote owed.",
    ),
  );
  assertEquals(d.state.not_known, []);

  const fact = d.facts.find((f: any) => f.kind === "job_brief");
  assert(
    fact.value.text.startsWith(
      "Job brief written 4 Oct 2026 10:23 Perth; current.\n",
    ),
  );
  assert(!fact.value.text.includes("schema_version"));
  assertEquals(fact.value.raw_text, storedBrief());
  assertEquals(fact.value.text, d.state.brief.text);
  // other facts are untouched
  assertEquals(
    d.facts.find((f: any) => f.kind === "client_preference").value,
    { text: "Prefers texts after 4pm." },
  );
  assertEquals(client.writes, []);
});

Deno.test("dossier: a job with an open invoice shows the amount due", async () => {
  const t = jobTables({
    status: "accepted",
    accepted_at: "2026-10-02T03:00:00.000Z",
  });
  t.xero_invoices = [
    {
      id: "i1",
      job_id: JOB,
      invoice_number: "INV-2001",
      status: "AUTHORISED",
      invoice_type: "ACCREC",
      total: 2421.23,
      amount_due: 2421.23,
      amount_paid: 0,
      invoice_date: "2026-10-02",
    },
    {
      id: "i2",
      job_id: JOB,
      invoice_number: "INV-1999",
      status: "PAID",
      invoice_type: "ACCREC",
      total: 500,
      amount_due: 0,
      amount_paid: 500,
      invoice_date: "2026-09-25",
    },
  ];
  t.job_assignments = [
    {
      id: "a1",
      job_id: JOB,
      scheduled_date: "2099-01-05",
      assignment_type: "install",
      crew_name: "Crew A",
      status: "confirmed",
    },
  ];
  const client = fakeClient(t, freshness());
  const d: any = await noNetwork(() =>
    _assembleJobDossierForTest(client, { job_id: JOB })
  );
  assertContract(d);
  assertEquals(d.state.lines[0], "Stage: accepted, since 2 Oct 2026.");
  assert(
    d.state.lines.includes(
      "Open invoices: 1, $2,421.23 due (INV-2001); also 1 paid.",
    ),
  );
  assert(
    d.state.lines.includes("Next booking: 5 Jan 2099 (install with Crew A)."),
  );
  assert(d.state.lines.includes("No past booking."));
  assertEquals(client.writes, []);
});

Deno.test("dossier: a failed freshness read never claims no messages are linked", async () => {
  const client = fakeClient(jobTables(), null);
  const d: any = await noNetwork(() =>
    _assembleJobDossierForTest(client, { job_id: JOB })
  );
  assertContract(d);
  assert(d.state.not_known.includes(
    "Could not check how current the facts are or how many linked messages are unread.",
  ));
  assert(
    !d.state.not_known.some((l: string) =>
      l.startsWith("No messages are linked")
    ),
  );
  assertEquals(d.diagnostics.ok, false);
});
