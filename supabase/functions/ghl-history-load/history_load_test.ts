// Behaviour tests for the one-off GHL history load (context slice M4), on the
// design's named rows (sms.md section 10) as recorded fixtures: R6 (history
// that exists only in the cache), R5 (a message already saved), R7 (internal
// comments), R1 to R4 (a two-job contact: customer, staff, workflow), R12 (a
// thread quiet since 10 Jun that the 15-minute reconciler never reads), plus
// the run's own rules: dry run by default, the live-texts gate, resume after a
// page or time budget, a stopping provider failure, and the day's job count
// saved before any work. The GHL side is a fake location that answers like the
// provider reads; the database side is an in-memory run store, ledger, due
// list and key set with capture_ghl_history_event's outcomes. Where each
// history row lands is the database ladder's decision, proven in the SQL
// contract (supabase/tests/migration-contracts/20260925031500_*).
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ACTIVITY_ITEM } from "../_shared/evidence/ghl_message_fixtures.ts";
import {
  DRY_RUN_SOURCE,
  type DueContact,
  type DueList,
  EVENT_SOURCE,
  type HistoryCaptureOutcome,
  type HistoryDeps,
  parseRequest,
  POLICY,
  RUN_SOURCE,
  runGhlHistoryLoad,
} from "./history_load.ts";
import {
  GAUCI_CALL,
  GAUCI_CONTACT,
  GAUCI_CONVERSATION,
  GAUCI_MESSAGES,
  R12_CONTACT,
  R12_CONVERSATION,
  R12_ITEM,
  R1_ITEM,
  R5_LIST_ITEM,
  SHERIDAN_CONTACT,
  SHERIDAN_CONVERSATION,
  SHERIDAN_MESSAGES,
} from "./m4_fixtures.ts";

const T0 = Date.parse("2026-09-24T02:00:00.000Z");

type Msg = Record<string, unknown> & { id: string; dateAdded?: string };

class FakeGhl {
  conversations = new Map<string, { contactId: string; messages: Msg[] }>();
  calls: string[] = [];
  failConversationsFor = new Map<string, unknown>();
  failMessagesFor = new Map<string, unknown>();
  add(contactId: string, id: string, messages: Msg[]) {
    this.conversations.set(id, { contactId, messages });
  }
  listConversations({ contactId }: { contactId: string }) {
    this.calls.push(`conversations:${contactId}`);
    const fail = this.failConversationsFor.get(contactId);
    if (fail) throw fail;
    const rows = [...this.conversations.entries()]
      .filter(([, c]) => c.contactId === contactId)
      .map(([id]) => ({ id, contactId }));
    return { conversations: rows, hasMore: false, nextStartAfterDate: null };
  }
  listMessages({ conversationId, limit, lastMessageId }: {
    contactId: string;
    conversationId: string;
    limit: number;
    lastMessageId?: string;
  }) {
    this.calls.push(`messages:${conversationId}:${lastMessageId ?? "top"}`);
    const fail = this.failMessagesFor.get(conversationId);
    if (fail) throw fail;
    const sorted = [...this.conversations.get(conversationId)!.messages].sort(
      (a, b) =>
        Date.parse(String(b.dateAdded)) - Date.parse(String(a.dateAdded)),
    );
    const start = lastMessageId
      ? sorted.findIndex((m) => m.id === lastMessageId) + 1
      : 0;
    const page = sorted.slice(start, start + limit);
    const more = start + limit < sorted.length;
    return {
      messages: page,
      hasMore: more,
      nextLastMessageId: more ? page.at(-1)!.id : null,
    };
  }
}

interface Run {
  id: string;
  source: string;
  status: string;
  updated_at: string;
  counts: Record<string, number>;
  error_code?: string | null;
  cursor?: unknown;
}

class FakeDb {
  runs: Run[] = [];
  ledger = new Map<string, Record<string, unknown>>();
  existing = new Map<string, string | null>();
  saved: Record<string, unknown>[] = [];
  status = new Map<string, string>(); // key -> ladder status
  captureFault: HistoryCaptureOutcome | null = null;
  legacyCallFor = new Map<string, string>(); // call key -> legacy call_complete id
  events: string[] = [];
  n = 0;
  recordRun(run: Record<string, unknown>): string {
    if (run.run_id) {
      const r = this.runs.find((x) => x.id === run.run_id)!;
      if (r.status !== "running") throw new Error("capture_run_finished");
      Object.assign(r, {
        ...(run.status ? { status: run.status } : {}),
        ...(run.counts
          ? { counts: structuredClone(run.counts as Record<string, number>) }
          : {}),
        ...("error_code" in run ? { error_code: run.error_code } : {}),
      });
      this.events.push(
        `run:${r.status}:jobs_covered=${r.counts.jobs_covered ?? 0}`,
      );
      return r.id;
    }
    const id = `run-${++this.n}`;
    this.runs.push({
      id,
      source: String(run.source),
      status: String(run.status ?? "running"),
      updated_at: new Date(T0).toISOString(),
      counts: structuredClone(run.counts as Record<string, number>),
      cursor: run.cursor,
    });
    return id;
  }
  capture(row: Record<string, unknown>): HistoryCaptureOutcome {
    if (this.captureFault) return this.captureFault;
    const key = String(row.provider_message_id);
    if (this.existing.has(key)) return { outcome: "duplicate" };
    this.existing.set(key, String(row.event_at));
    this.saved.push(row);
    return {
      outcome: "inserted",
      id: `ev-${key}`,
      attribution_status: this.status.get(key) ?? "single_open",
    };
  }
}

function contact(id: string, jobs = 1, extra: Partial<DueContact> = {}) {
  return {
    contact_id: id,
    job_ids: Array.from({ length: jobs }, (_, i) => `${id}-job-${i}`),
    jobs,
    prior_status: null,
    resume: null,
    attempts: 0,
    ...extra,
  } as DueContact;
}

function dueOf(contacts: DueContact[]): DueList {
  const jobs = contacts.reduce((a, c) => a + c.jobs, 0);
  return {
    daily_job_limit: 100,
    jobs_counted_today: 0,
    daily_remaining: 100,
    contacts,
    jobs_offered: jobs,
    contacts_waiting: 0,
    jobs_waiting: 0,
    daily_limit_reached: false,
  };
}

function harness(opts: {
  due: DueContact[];
  flag?: boolean;
  capture?: boolean;
  attribution?: boolean;
  clock?: () => number;
}) {
  const ghl = new FakeGhl();
  const db = new FakeDb();
  let dueCalls = 0;
  const deps: HistoryDeps = {
    now: opts.clock ?? (() => T0),
    itemFlagOn: () => Promise.resolve(opts.flag ?? true),
    laneOn: (lane) =>
      Promise.resolve(
        lane === "capture" ? opts.capture ?? true : opts.attribution ?? true,
      ),
    latestRun: (source) =>
      Promise.resolve(
        [...db.runs].reverse().find((r) => r.source === source) as
          | { id: string; status: "running"; updated_at: string }
          | undefined ?? null,
      ),
    recordRun: (run) => Promise.resolve(db.recordRun(run)),
    due: () => {
      dueCalls++;
      return Promise.resolve(dueOf(opts.due));
    },
    // reserve_ghl_history_run's contract (proven in the SQL contract and its
    // concurrent case): one live real run, the offered jobs counted on the new
    // run row before any work.
    reserve: (_max, actor) => {
      dueCalls++;
      const live = [...db.runs].reverse().find((r) =>
        r.source === RUN_SOURCE && r.status === "running"
      );
      if (live && T0 - Date.parse(live.updated_at) < POLICY.runningStaleMs) {
        return Promise.resolve({
          outcome: "run_in_progress" as const,
          run_id: live.id,
        });
      }
      if (live) {
        Object.assign(live, { status: "failed", error_code: "run_abandoned" });
      }
      const due = dueOf(opts.due);
      const run_id = db.recordRun({
        source: RUN_SOURCE,
        status: "running",
        cursor: { v: 1, actor },
        counts: { jobs_covered: due.jobs_offered },
      });
      db.events.push(`reserve:jobs_covered=${due.jobs_offered}`);
      return Promise.resolve({ outcome: "reserved" as const, run_id, due });
    },
    recordContact: (row) => {
      db.ledger.set(String(row.contact_id), structuredClone(row));
      db.events.push(`ledger:${row.contact_id}:${row.status}`);
      return Promise.resolve();
    },
    listConversations: (a) => Promise.resolve(ghl.listConversations(a)),
    listMessages: (a) => {
      db.events.push(`read:${a.conversationId}`);
      return Promise.resolve(ghl.listMessages(a));
    },
    existingKeys: (keys) =>
      Promise.resolve(
        new Map(
          keys.filter((k) => db.existing.has(k)).map((
            k,
          ) => [k, db.existing.get(k)!]),
        ),
      ),
    capture: (row) => Promise.resolve(db.capture(row)),
    // ghl_call_pair's contract (tested in ghl_call_pair_test.ts): exactly one
    // legacy row in the window is recorded on the call row.
    pairLegacyCall: (row) => {
      const legacy = db.legacyCallFor.get(String(row.provider_message_id));
      return Promise.resolve(
        legacy
          ? {
            row: {
              ...row,
              payload: {
                ...(row.payload as Record<string, unknown>),
                legacy_event_id: legacy,
              },
            },
            outcome: "paired" as const,
          }
          : { row, outcome: "none" as const },
      );
    },
  };
  return { ghl, db, deps, dueCalls: () => dueCalls };
}

const real = {
  dryRun: false,
  maxJobs: 20,
  actor: "m4-test",
};
const dry = { ...real, dryRun: true };
const small = { ...POLICY, messagePageLimit: 2 };

Deno.test("R6, R7, R5: a contact's whole history, back to its first message, saved as backfill", async () => {
  const h = harness({ due: [contact(SHERIDAN_CONTACT)] });
  h.ghl.add(SHERIDAN_CONTACT, SHERIDAN_CONVERSATION, SHERIDAN_MESSAGES);
  // R5 was saved by the tool send (C1a); its stored time is right.
  h.db.existing.set(`ghl:${R5_LIST_ITEM.id}`, R5_LIST_ITEM.dateAdded);
  const out = await runGhlHistoryLoad(h.deps, real, small);
  assert(out.outcome === "ran");
  assertEquals(out.status, "succeeded");
  // Three pages of two, newest first, down to the first message.
  assertEquals(h.ghl.calls.filter((c) => c.startsWith("messages:")).length, 3);
  assertEquals(out.counts.inserted, 5); // R6 x3, R7 x2
  assertEquals(out.counts.duplicates, 1); // R5: never a second row
  assertEquals(out.counts.existing_time_differs, 0);
  const keys = h.db.saved.map((r) => r.provider_message_id).sort();
  assertEquals(keys, [
    "ghl:4IupuRIcAf5w6SXa6o9y",
    "ghl:BIuigfV2iHxTTeFN8YG5",
    "ghl:XPtcG3KZv34WWXdIOdKy",
    "ghl:foM3hD1SggjmCoNexihJ",
    "ghl:kRoIUHpu59P3Bpx3FBv5",
  ]);
  for (const row of h.db.saved) {
    assertEquals(row.source, EVENT_SOURCE);
    assertEquals(row.job_id, null); // a history row never asserts a job
    assertEquals(row.match_method, "none");
    assertEquals(row.thread_key, null);
    const meta = row.metadata as Record<string, unknown>;
    assertEquals(meta.capture_mode, "backfill");
    assertEquals(meta.history_run_id, out.run_id);
  }
  const r6 = h.db.saved.find((r) =>
    r.provider_message_id === "ghl:foM3hD1SggjmCoNexihJ"
  )!;
  assertEquals(r6.event_at, "2026-09-04T01:00:00.000Z"); // GHL's time, never ours
  assertEquals(r6.event_type, "client.sms_out");
  assertEquals(
    (r6.payload as Record<string, unknown>).sent_by_kind,
    "staff_app",
  );
  // R7: internal comments are internal, never contact.
  const r7 = h.db.saved.find((r) =>
    r.provider_message_id === "ghl:kRoIUHpu59P3Bpx3FBv5"
  )!;
  assertEquals([r7.event_type, r7.direction], [
    "ghl.internal_comment",
    "internal",
  ]);
  // The ledger says done, with the whole span GHL holds.
  const led = h.db.ledger.get(SHERIDAN_CONTACT)!;
  assertEquals(led.status, "done");
  assertEquals(led.resume, null);
  assertEquals(led.earliest_message_at, "2026-09-04T01:00:00.000Z");
  assertEquals(led.latest_message_at, "2026-09-18T01:10:00.000Z");
  assertEquals(led.run_id, out.run_id);
  assertEquals(led.actor, "m4-test");
  assertEquals(h.db.runs[0].source, RUN_SOURCE);
  assertEquals(h.db.runs[0].status, "succeeded");
});

Deno.test("R5 class: a stored copy at the wrong time is counted for the time repair, never rewritten", async () => {
  const h = harness({ due: [contact(SHERIDAN_CONTACT)] });
  h.ghl.add(SHERIDAN_CONTACT, SHERIDAN_CONVERSATION, SHERIDAN_MESSAGES);
  // The cache backfill stamped its sync time as the message time (audit C6).
  h.db.existing.set(`ghl:${R5_LIST_ITEM.id}`, "2026-09-20T00:00:00.000Z");
  const out = await runGhlHistoryLoad(h.deps, real);
  assert(out.outcome === "ran");
  assertEquals(out.counts.existing_time_differs, 1);
  assertEquals(
    h.db.existing.get(`ghl:${R5_LIST_ITEM.id}`),
    "2026-09-20T00:00:00.000Z",
  );
});

Deno.test("R1 to R4 and a call: each placed by the ladder and counted as it lands; the load moves nothing; the call is loaded with its legacy record", async () => {
  const h = harness({ due: [contact(GAUCI_CONTACT, 2)] });
  h.ghl.add(GAUCI_CONTACT, GAUCI_CONVERSATION, [
    ...GAUCI_MESSAGES,
    ACTIVITY_ITEM,
  ]);
  // The ladder's answer for R1 (two live quotes): review. The load only
  // counts it; it writes no placement of its own.
  h.db.status.set(`ghl:${R1_ITEM.id}`, "pending_luna");
  h.db.status.set("ghl:OPzxTmGv37UAMzf1hD3Q", "unplaced");
  // The call's old CallCompleted record (one legacy row around the call).
  h.db.legacyCallFor.set(`ghl:${GAUCI_CALL.id}`, "legacy-call-row-0001");
  const out = await runGhlHistoryLoad(h.deps, real);
  assert(out.outcome === "ran");
  assertEquals(out.counts.inserted, 5);
  assertEquals(out.counts.pending_review, 1);
  assertEquals(out.counts.unplaced, 1);
  assertEquals(out.counts.placed_on_job, 3);
  assertEquals(out.counts.skipped_call, 0);
  assertEquals(out.counts.calls_paired_legacy, 1);
  // Slice T1's builder: the call is one client.call_logged row, as history.
  const call = h.db.saved.find((r) =>
    r.provider_message_id === `ghl:${GAUCI_CALL.id}`
  )!;
  assertEquals(call.event_type, "client.call_logged");
  assertEquals(call.event_at, GAUCI_CALL.dateAdded);
  assertEquals(
    (call.metadata as Record<string, unknown>).capture_mode,
    "backfill",
  );
  assertEquals(
    (call.payload as Record<string, unknown>).legacy_event_id,
    "legacy-call-row-0001",
  );
  assertEquals(out.counts.skipped_activity, 1);
  assertEquals(out.counts.jobs_covered, 2);
  const r4 = h.db.saved.find((r) =>
    r.provider_message_id === "ghl:OPzxTmGv37UAMzf1hD3Q"
  )!;
  assertEquals(
    (r4.payload as Record<string, unknown>).sent_by_kind,
    "workflow",
  );
  const led = h.db.ledger.get(GAUCI_CONTACT)!;
  assertEquals(led.skipped_calls, 0);
  assertEquals(led.status, "done");
});

Deno.test("R12: a thread quiet since 10 Jun is loaded whole (the reconciler's window never reaches it)", async () => {
  const h = harness({ due: [contact(R12_CONTACT)] });
  h.ghl.add(R12_CONTACT, R12_CONVERSATION, [R12_ITEM]);
  const out = await runGhlHistoryLoad(h.deps, real);
  assert(out.outcome === "ran");
  assertEquals(out.counts.inserted, 1);
  assertEquals(h.db.saved[0].event_at, "2026-06-10T03:00:00.000Z");
  const led = h.db.ledger.get(R12_CONTACT)!;
  assertEquals([led.earliest_message_at, led.latest_message_at], [
    "2026-06-10T03:00:00.000Z",
    "2026-06-10T03:00:00.000Z",
  ]);
});

Deno.test("dry run is the default: it reads, builds and counts, and writes no evidence and no ledger row", async () => {
  assertEquals(parseRequest({}, "a").dryRun, true);
  assertEquals(parseRequest({ dry_run: "false" }, "a").dryRun, true);
  assertEquals(parseRequest({ dry_run: false }, "a").dryRun, false);
  assertEquals(parseRequest({ max_jobs: 500 }, "a").maxJobs, 100);
  assertEquals(parseRequest({ max_jobs: 0 }, "a").maxJobs, 1);
  // Even with live texts off: a dry run sizes the load before the go.
  const h = harness({ due: [contact(SHERIDAN_CONTACT)], flag: false });
  h.ghl.add(SHERIDAN_CONTACT, SHERIDAN_CONVERSATION, SHERIDAN_MESSAGES);
  const out = await runGhlHistoryLoad(h.deps, parseRequest({}, "m4-test"));
  assert(out.outcome === "ran");
  assertEquals(out.dry_run, true);
  assertEquals(out.counts.would_insert, 6);
  assertEquals(out.counts.inserted, 0);
  assertEquals(out.counts.jobs_covered, 0); // a dry run never spends the day
  assertEquals(h.db.saved.length, 0);
  assertEquals(h.db.ledger.size, 0);
  assertEquals(h.db.runs[0].source, DRY_RUN_SOURCE);
});

Deno.test("a real run waits for live texts, the capture lane and the attribution lane", async () => {
  for (
    const [opts, reason] of [
      [{ flag: false }, "item_flag_off"],
      [{ capture: false }, "capture_lane_off"],
      [{ attribution: false }, "attribution_lane_off"],
    ] as const
  ) {
    const h = harness({ due: [contact(SHERIDAN_CONTACT)], ...opts });
    const out = await runGhlHistoryLoad(h.deps, real);
    assertEquals(out, { outcome: "idle", reason });
    assertEquals(h.db.runs.length, 0);
    assertEquals(h.dueCalls(), 0);
  }
});

Deno.test("the day's jobs are reserved on the run row before any contact is read", async () => {
  const h = harness({
    due: [contact(GAUCI_CONTACT, 2), contact(R12_CONTACT, 1)],
  });
  h.ghl.add(GAUCI_CONTACT, GAUCI_CONVERSATION, GAUCI_MESSAGES);
  h.ghl.add(R12_CONTACT, R12_CONVERSATION, [R12_ITEM]);
  await runGhlHistoryLoad(h.deps, real);
  const firstRead = h.db.events.findIndex((e) =>
    e.startsWith(`read:${GAUCI_CONVERSATION}`)
  );
  const reserved = h.db.events.indexOf("reserve:jobs_covered=3");
  assert(reserved >= 0 && reserved < firstRead, h.db.events.join(" "));
  // Progress saves never lower what was reserved.
  assert(
    h.db.events.filter((e) => e.startsWith("run:")).every((e) =>
      e.endsWith("jobs_covered=3")
    ),
    h.db.events.join(" "),
  );
  assertEquals(h.db.runs[0].counts.jobs_covered, 3);
});

Deno.test("a long thread stops at the page budget and resumes from its cursor, never re-reading", async () => {
  const h = harness({ due: [contact(SHERIDAN_CONTACT)] });
  h.ghl.add(SHERIDAN_CONTACT, SHERIDAN_CONVERSATION, SHERIDAN_MESSAGES);
  const budget = {
    ...POLICY,
    messagePageLimit: 2,
    maxMessagePagesPerContact: 1,
  };
  const first = await runGhlHistoryLoad(h.deps, real, budget);
  assert(first.outcome === "ran");
  assertEquals(first.status, "partial");
  assertEquals(first.counts.message_pages_capped, 1);
  const led = h.db.ledger.get(SHERIDAN_CONTACT)!;
  assertEquals(led.status, "partial");
  const resume = led.resume as Record<string, unknown>;
  assertEquals(resume.conversation_id, SHERIDAN_CONVERSATION);
  assertEquals(resume.last_message_id, "4IupuRIcAf5w6SXa6o9y"); // second newest
  // The next run is handed the resume point by the due list.
  const next = harness({
    due: [
      contact(SHERIDAN_CONTACT, 1, {
        prior_status: "partial",
        resume,
        attempts: 1,
      }),
    ],
  });
  next.ghl.add(SHERIDAN_CONTACT, SHERIDAN_CONVERSATION, SHERIDAN_MESSAGES);
  for (const [k, v] of h.db.existing) next.db.existing.set(k, v);
  const second = await runGhlHistoryLoad(next.deps, real, {
    ...POLICY,
    messagePageLimit: 2,
  });
  assert(second.outcome === "ran");
  assertEquals(
    next.ghl.calls.filter((c) => c.startsWith("messages:"))[0],
    `messages:${SHERIDAN_CONVERSATION}:4IupuRIcAf5w6SXa6o9y`,
  );
  assertEquals(second.counts.duplicates, 0);
  assertEquals(second.counts.inserted, 4);
  assertEquals(next.db.ledger.get(SHERIDAN_CONTACT)!.status, "done");
});

Deno.test("a GHL rate limit stops the run: the contact keeps its resume point, the rest wait", async () => {
  const h = harness({
    due: [
      contact(R12_CONTACT),
      contact(SHERIDAN_CONTACT),
      contact(GAUCI_CONTACT),
    ],
  });
  h.ghl.add(R12_CONTACT, R12_CONVERSATION, [R12_ITEM]);
  h.ghl.add(SHERIDAN_CONTACT, SHERIDAN_CONVERSATION, SHERIDAN_MESSAGES);
  h.ghl.failMessagesFor.set(SHERIDAN_CONVERSATION, {
    code: "provider_request_failed",
    status: 429,
    providerStatus: 429,
  });
  const out = await runGhlHistoryLoad(h.deps, real);
  assert(out.outcome === "ran");
  assertEquals([out.status, out.error_code], ["failed", "ghl_rate_limited"]);
  assertEquals(h.db.ledger.get(R12_CONTACT)!.status, "done");
  const led = h.db.ledger.get(SHERIDAN_CONTACT)!;
  assertEquals([led.status, led.error_code], ["partial", "ghl_rate_limited"]);
  assertEquals(
    (led.resume as Record<string, unknown>).conversation_id,
    SHERIDAN_CONVERSATION,
  );
  assertEquals(h.db.ledger.has(GAUCI_CONTACT), false);
  assertEquals(out.counts.backlog_contacts, 1);
});

Deno.test("a record-level refusal fails that contact only; the run goes on", async () => {
  const h = harness({ due: [contact(SHERIDAN_CONTACT), contact(R12_CONTACT)] });
  h.ghl.add(R12_CONTACT, R12_CONVERSATION, [R12_ITEM]);
  h.ghl.failConversationsFor.set(SHERIDAN_CONTACT, {
    code: "provider_request_failed",
    status: 502,
    providerStatus: 404,
  });
  const out = await runGhlHistoryLoad(h.deps, real);
  assert(out.outcome === "ran");
  assertEquals(out.status, "partial");
  const led = h.db.ledger.get(SHERIDAN_CONTACT)!;
  assertEquals([led.status, led.error_code], [
    "failed",
    "provider_request_failed",
  ]);
  assertEquals(h.db.ledger.get(R12_CONTACT)!.status, "done");
});

Deno.test("the attribution lane going off mid-run stops the load where it stood", async () => {
  const h = harness({ due: [contact(SHERIDAN_CONTACT), contact(R12_CONTACT)] });
  h.ghl.add(SHERIDAN_CONTACT, SHERIDAN_CONVERSATION, SHERIDAN_MESSAGES);
  h.ghl.add(R12_CONTACT, R12_CONVERSATION, [R12_ITEM]);
  h.db.captureFault = { outcome: "error", code: "attribution_disabled" };
  const out = await runGhlHistoryLoad(h.deps, real);
  assert(out.outcome === "ran");
  assertEquals([out.status, out.error_code], [
    "failed",
    "attribution_disabled",
  ]);
  assertEquals(h.db.ledger.get(SHERIDAN_CONTACT)!.status, "partial");
  assertEquals(h.db.ledger.has(R12_CONTACT), false);
});

Deno.test("one run at a time: a fresh running run stops a second; an abandoned one is closed", async () => {
  const h = harness({ due: [contact(R12_CONTACT)] });
  h.ghl.add(R12_CONTACT, R12_CONVERSATION, [R12_ITEM]);
  h.db.runs.push({
    id: "old",
    source: RUN_SOURCE,
    status: "running",
    updated_at: new Date(T0 - 60_000).toISOString(),
    counts: {},
  });
  assertEquals(await runGhlHistoryLoad(h.deps, real), {
    outcome: "run_in_progress",
    run_id: "old",
  });
  h.db.runs[0].updated_at = new Date(T0 - 11 * 60_000).toISOString();
  const out = await runGhlHistoryLoad(h.deps, real);
  assert(out.outcome === "ran");
  assertEquals([h.db.runs[0].status, h.db.runs[0].error_code], [
    "failed",
    "run_abandoned",
  ]);
  // A dry run does not wait on a real run, and never reserves.
  h.db.runs.push({
    id: "busy",
    source: RUN_SOURCE,
    status: "running",
    updated_at: new Date(T0).toISOString(),
    counts: {},
  });
  assert((await runGhlHistoryLoad(h.deps, dry)).outcome === "ran");
});

Deno.test("a conversation list that cannot be read to its end leaves the contact failed, never done", async () => {
  const h = harness({ due: [contact(SHERIDAN_CONTACT)] });
  h.ghl.add(SHERIDAN_CONTACT, SHERIDAN_CONVERSATION, SHERIDAN_MESSAGES);
  // A full page of conversations with no usable next cursor (the provider
  // read's has_more null with a pagination warning).
  h.deps.listConversations = ({ contactId }) =>
    Promise.resolve({
      conversations: Array.from(
        { length: POLICY.conversationPageLimit },
        (_, i) => ({
          id: `fullPageConv${String(i).padStart(4, "0")}`,
          contactId,
        }),
      ),
      hasMore: null,
      nextStartAfterDate: null,
    });
  const out = await runGhlHistoryLoad(h.deps, real);
  assert(out.outcome === "ran");
  const led = h.db.ledger.get(SHERIDAN_CONTACT)!;
  assertEquals([led.status, led.error_code], [
    "failed",
    "conversation_cursor_missing",
  ]);
  assertEquals(h.db.saved.length, 0);
  // A short page without a cursor is simply the end of the list.
  const short = harness({ due: [contact(SHERIDAN_CONTACT)] });
  short.ghl.add(SHERIDAN_CONTACT, SHERIDAN_CONVERSATION, SHERIDAN_MESSAGES);
  const listConversations = short.deps.listConversations;
  short.deps.listConversations = async (a) => ({
    ...(await listConversations(a)),
    hasMore: null,
    nextStartAfterDate: null,
  });
  await runGhlHistoryLoad(short.deps, real);
  assertEquals(short.db.ledger.get(SHERIDAN_CONTACT)!.status, "done");
});

Deno.test("the time budget leaves the remaining contacts for the next run", async () => {
  let t = T0;
  const h = harness({
    due: [contact(R12_CONTACT), contact(SHERIDAN_CONTACT)],
    clock: () => t,
  });
  h.ghl.add(R12_CONTACT, R12_CONVERSATION, [R12_ITEM]);
  h.ghl.add(SHERIDAN_CONTACT, SHERIDAN_CONVERSATION, SHERIDAN_MESSAGES);
  const listMessages = h.deps.listMessages;
  h.deps.listMessages = async (a) => {
    const r = await listMessages(a);
    t += POLICY.timeBudgetMs; // the first read uses the whole budget
    return r;
  };
  const out = await runGhlHistoryLoad(h.deps, real);
  assert(out.outcome === "ran");
  assertEquals(out.status, "partial");
  assertEquals(out.counts.backlog_contacts, 1);
  assertEquals(h.db.ledger.has(SHERIDAN_CONTACT), false);
  // The reservation stands: the day counts both contacts' jobs, loaded or not.
  assertEquals(out.counts.jobs_covered, 2);
});
