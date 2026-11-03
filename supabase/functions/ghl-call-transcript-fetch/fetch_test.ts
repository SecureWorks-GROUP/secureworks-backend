// Slice T2: the fetcher's behaviour on the recorded named rows
// (transcript_fixtures.ts), over an in-memory stand-in for the database and
// GHL. The database's own rules (backoff, terminal outcomes, selection) are
// proved by the migration contract; here the stand-in records what the
// fetcher asked it to do.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type BackfillDeps, type CaptureOutcome, type DueCall, type FetchPolicy, type FetchRecord, processCall, type ProviderRead } from "./fetch.ts";
import {
  flattenTranscript,
  normaliseSentences,
} from "../_shared/ghl/call_transcript.ts";
import { buildGhlMessageRow } from "../_shared/evidence/ghl_message.ts";
import { LOCATION_ID, messageAnswer, N1, N2, N4, N4_CONVERSATION_PAGE, NODUR, ONECH, VMG } from "./transcript_fixtures.ts";
import { N1_CALL_ITEM } from "../_shared/evidence/ghl_message_fixtures.ts";

const POLICY: FetchPolicy = {
  run_source: "ghl_call_transcript",
  backfill_run_source: "ghl_call_transcript_backfill",
  batch_limit: 40,
  min_call_seconds: 5,
  agreement_minutes: 5,
};

type Item = Record<string, unknown>;

/** What the stand-in database remembers of a fetch record. */
interface FetchState {
  outcome: string;
  next_at: string;
  attempts: number;
  seen_sentences: number | null;
  seen_digest: string | null;
  seen_at: string | null;
}

interface World {
  now: number;
  flag: boolean;
  lane: boolean;
  items: Map<string, Item>;
  transcripts: Map<string, ProviderRead>;
  reads: string[];
  captured: Record<string, unknown>[];
  captureAnswer?: (row: Record<string, unknown>) => CaptureOutcome;
  fetches: FetchRecord[];
  runs: Record<string, unknown>[];
  due: DueCall[];
  latest: { id: string; status: string; started_at: string } | null;
  existing: Map<string, string>;
  outcomes: Map<string, FetchState>;
  /** context_transcript_due_calls in history mode. */
  history: DueCall[];
}

function world(partial: Partial<World> = {}): World {
  return {
    now: Date.parse("2026-09-24T05:00:00Z"),
    flag: true,
    lane: true,
    items: new Map(),
    transcripts: new Map(),
    reads: [],
    captured: [],
    fetches: [],
    runs: [],
    due: [],
    latest: null,
    existing: new Map(),
    outcomes: new Map(),
    history: [],
    ...partial,
  };
}

function withCall(w: World, item: Item, transcript: ProviderRead): World {
  w.items.set(String(item.id), item);
  w.transcripts.set(String(item.id), transcript);
  return w;
}

function deps(w: World): BackfillDeps {
  let runSeq = 0;
  let rowSeq = 0;
  return {
    now: () => w.now,
    locationId: LOCATION_ID,
    flagOn: () => Promise.resolve(w.flag),
    laneOn: () => Promise.resolve(w.lane),
    policy: () => Promise.resolve(POLICY),
    latestRun: () => Promise.resolve(w.latest),
    recordRun: (run) => {
      w.runs.push(run);
      return Promise.resolve(String(run.run_id ?? `run-${++runSeq}`));
    },
    dueCalls: () => Promise.resolve(w.due),
    readCallMessage: (id) => {
      w.reads.push(`message:${id}`);
      const item = w.items.get(id);
      return Promise.resolve(
        item
          ? { ok: true, body: messageAnswer(item) }
          : { ok: false, status: 404, code: "http_404" },
      );
    },
    readTranscription: (id) => {
      w.reads.push(`transcription:${id}`);
      return Promise.resolve(
        w.transcripts.get(id) ?? { ok: false, status: 404, code: "http_404" },
      );
    },
    capture: (row) => {
      w.captured.push(row);
      if (w.captureAnswer) return Promise.resolve(w.captureAnswer(row));
      const key = String(row.provider_message_id);
      const id = w.existing.get(key);
      if (id) return Promise.resolve({ outcome: "duplicate", id });
      const newId = `row-${++rowSeq}`;
      w.existing.set(key, newId);
      return Promise.resolve({ outcome: "inserted", id: newId });
    },
    recordFetch: (record) => {
      w.fetches.push(record);
      const prior = w.outcomes.get(record.call_message_id);
      w.outcomes.set(record.call_message_id, {
        outcome: ["saved", "not_expected"].includes(record.result)
          ? record.result
          : "pending",
        next_at: new Date(
          w.now + (record.result === "awaiting_agreement" ? 5 : 2) * 60_000,
        ).toISOString(),
        attempts: (prior?.attempts ?? 0) +
          (record.result === "awaiting_agreement" ? 0 : 1),
        seen_sentences: record.sentences ?? prior?.seen_sentences ?? null,
        seen_digest: record.digest ?? prior?.seen_digest ?? null,
        seen_at: record.digest
          ? new Date(w.now).toISOString()
          : prior?.seen_at ?? null,
      });
      return Promise.resolve({ outcome: record.result });
    },
    historyCalls: (limit) => Promise.resolve(w.history.slice(0, limit)),
    historyPending: () => {
      const waiting = w.history
        .map((c) => w.outcomes.get(c.call_message_id))
        .filter((o) => o?.outcome === "pending")
        .map((o) => o!.next_at)
        .sort();
      return Promise.resolve({
        pending: waiting.length,
        next_due_at: waiting[0] ?? null,
      });
    },
  };
}

/** The stored call row for a recorded list item, as the selection returns it. */
function due(item: Item, extra: Partial<DueCall> = {}): DueCall {
  const built = buildGhlMessageRow(item, {
    source: "ghl-message-reconcile",
    captureMode: "live",
  });
  if (built.kind !== "row") throw new Error("not a call row");
  const r = built.row;
  const p = r.payload as Record<string, unknown>;
  return {
    call_event_id: `call-${item.id}`,
    call_message_id: String(item.id),
    event_type: String(r.event_type),
    event_at: String(r.event_at),
    contact_id: String(r.contact_id),
    conversation_key: r.conversation_key as string,
    direction: r.direction as string,
    call_status: p.call_status as string,
    duration_seconds: p.duration_seconds as number | null,
    call_sid: p.call_sid as string,
    line: p.line as string,
    from_line: p.from_line as string,
    by_user: p.by_user as string,
    capture_mode: "live",
    transcript_event_id: null,
    attempts: 0,
    seen_sentences: null,
    seen_digest: null,
    seen_at: null,
    ...extra,
  };
}

const agreed = new Map<
  string,
  Pick<DueCall, "seen_sentences" | "seen_digest" | "seen_at">
>();
for (const fixture of [N1, N2, N4, NODUR, VMG, ONECH]) {
  const flat = await flattenTranscript(normaliseSentences(fixture.sentences));
  agreed.set(fixture.item.id, {
    seen_sentences: flat.sentenceCount,
    seen_digest: flat.digest,
    seen_at: new Date(Date.parse(fixture.item.dateAdded) + 5 * 60_000)
      .toISOString(),
  });
}
function agreedDue(item: Item): DueCall {
  return due(item, agreed.get(String(item.id)));
}

const ok = (body: unknown): ProviderRead => ({ ok: true, body });
const hours = (h: number) => h * 3_600_000;

Deno.test("N1 live, 20 min after the call: first read waits for agreement, the read 5 min later saves (review M10)", async () => {
  const w = withCall(world(), N1.item, ok(N1.sentences));
  w.now = Date.parse(N1.item.dateAdded) + 109_000 + 20 * 60_000;
  const first = await processCall(due(N1_CALL_ITEM), "live", POLICY, deps(w));
  assertEquals(first.outcome, "awaiting_agreement");
  assertEquals(w.captured.length, 0);
  const seen = w.fetches[0];
  assertEquals(seen.result, "awaiting_agreement");
  assertEquals(seen.sentences, 50);
  assertEquals(seen.provider_status, "completed");
  assertEquals(seen.provider_duration_seconds, 109);
  assertEquals(w.reads, [
    "message:6kn6WmrtfTMvhEJtmfeJ",
    "transcription:6kn6WmrtfTMvhEJtmfeJ",
  ]);

  // Second read, 5 minutes later, same words: saved.
  const seenAt = new Date(w.now).toISOString();
  w.now += 5 * 60_000;
  const second = await processCall(
    due(N1_CALL_ITEM, {
      seen_sentences: 50,
      seen_digest: seen.digest!,
      seen_at: seenAt,
    }),
    "live",
    POLICY,
    deps(w),
  );
  assertEquals(second.outcome, "saved");
  assertEquals(w.captured.length, 1);
  const row = w.captured[0];
  assertEquals(row.provider_message_id, "ghltx:6kn6WmrtfTMvhEJtmfeJ");
  assertEquals((row.payload as Item).agreement, "reached");
  assertEquals((row.payload as Item).ghl_call_id, "6kn6WmrtfTMvhEJtmfeJ");
  assertEquals((row.payload as Item).from_line, "774");
  assertEquals(row.metadata, { capture_mode: "live" });
  assertEquals(row.event_at, "2026-09-23T07:40:55.171Z");
  assertEquals(w.fetches[1], {
    call_message_id: "6kn6WmrtfTMvhEJtmfeJ",
    call_event_id: "call-6kn6WmrtfTMvhEJtmfeJ",
    mode: "live",
    result: "saved",
    transcript_event_id: "row-1",
    provider_status: "completed",
    provider_duration_seconds: 109,
  });
});

Deno.test("N1: words that changed between the two reads wait again, they are never saved half-done", async () => {
  const w = withCall(world(), N1.item, ok(N1.sentences.slice(0, 40)));
  w.now = Date.parse(N1.item.dateAdded) + 30 * 60_000;
  await processCall(due(N1_CALL_ITEM), "live", POLICY, deps(w));
  const partial = w.fetches[0];
  w.transcripts.set(N1.item.id, ok(N1.sentences));
  w.now += 5 * 60_000;
  const step = await processCall(
    due(N1_CALL_ITEM, {
      seen_sentences: partial.sentences!,
      seen_digest: partial.digest!,
      seen_at: new Date(w.now - 5 * 60_000).toISOString(),
    }),
    "live",
    POLICY,
    deps(w),
  );
  assertEquals(step.outcome, "awaiting_agreement");
  assertEquals(w.captured.length, 0);
  assertEquals(w.fetches[1].sentences, 50);
});

Deno.test("N1 read a day later still requires agreement", async () => {
  const w = withCall(world(), N1.item, ok(N1.sentences));
  w.now = Date.parse(N1.item.dateAdded) + hours(22);
  const step = await processCall(due(N1_CALL_ITEM), "live", POLICY, deps(w));
  assertEquals(step.outcome, "awaiting_agreement");
  assertEquals(w.captured.length, 0);
});

Deno.test("crash replay: a call whose ghltx: row exists is recorded saved with no provider call", async () => {
  const w = world();
  const step = await processCall(
    due(N1_CALL_ITEM, { transcript_event_id: "tx-existing" }),
    "live",
    POLICY,
    deps(w),
  );
  assertEquals(step.outcome, "saved_existing");
  assertEquals(w.reads, []);
  assertEquals(w.captured, []);
  assertEquals(w.fetches[0].result, "saved");
  assertEquals(w.fetches[0].transcript_event_id, "tx-existing");
});

Deno.test("a duplicate save (the other mode got there first) is recorded saved on the existing row", async () => {
  const w = withCall(world(), N1.item, ok(N1.sentences));
  w.now = Date.parse(N1.item.dateAdded) + hours(3);
  w.existing.set("ghltx:6kn6WmrtfTMvhEJtmfeJ", "tx-other");
  const step = await processCall(
    agreedDue(N1_CALL_ITEM),
    "live",
    POLICY,
    deps(w),
  );
  assertEquals(step.outcome, "duplicate_saved");
  assertEquals(w.fetches[0].transcript_event_id, "tx-other");
});

Deno.test("N2 voicemail with no duration: fetched, saved, low signal", async () => {
  const w = withCall(world(), N2.item, ok(N2.sentences));
  w.now = Date.parse(N2.item.dateAdded) + hours(3);
  const step = await processCall(
    agreedDue({ ...N2.item, to: "+61489267774" }),
    "live",
    POLICY,
    deps(w),
  );
  assertEquals(step.outcome, "saved");
  const p = w.captured[0].payload as Item;
  assertEquals(p.low_signal, true);
  assertEquals(p.word_count, 4);
  assertEquals(w.fetches[0].provider_status, "voicemail");
  assertEquals(w.fetches[0].provider_duration_seconds, null);
});

Deno.test("NODUR: completed with no duration recorded carries a transcript, and is fetched", async () => {
  const w = withCall(world(), NODUR.item, ok(NODUR.sentences));
  w.now = Date.parse(NODUR.item.dateAdded) + hours(5);
  const step = await processCall(
    agreedDue(N4_CONVERSATION_PAGE[1]),
    "live",
    POLICY,
    deps(w),
  );
  assertEquals(step.outcome, "saved");
  assertEquals(step.sentences, 90);
  assertEquals((w.captured[0].payload as Item).direction, "outbound");
});

Deno.test("VMG: a 'completed' call that is a voicemail greeting is saved low signal (F13)", async () => {
  const w = withCall(world(), VMG.item, ok(VMG.sentences));
  w.now = Date.parse(VMG.item.dateAdded) + hours(3);
  await processCall(
    agreedDue({ ...VMG.item, to: "+61489267774" }),
    "live",
    POLICY,
    deps(w),
  );
  const p = w.captured[0].payload as Item;
  assertEquals(p.low_signal, true);
  assertEquals(p.speaker_labels, true);
});

Deno.test("ONECH: both voices on one channel are saved without speaker labels (N6)", async () => {
  const w = withCall(world(), ONECH.item, ok(ONECH.sentences));
  w.now = Date.parse(ONECH.item.dateAdded) + hours(3);
  await processCall(agreedDue(ONECH.item), "live", POLICY, deps(w));
  const p = w.captured[0].payload as Item;
  assertEquals(p.speaker_labels, false);
  assertEquals(p.speaker_roles, "not_given");
});

Deno.test("the re-read must be the same call, location and contact", async () => {
  for (
    const [change, code] of [
      [{ contactId: "someOtherContact1" }, "provider_contact_mismatch"],
      [{ locationId: "otherLocation123" }, "provider_location_mismatch"],
      [{ messageType: "TYPE_SMS" }, "provider_not_a_call"],
    ] as [Item, string][]
  ) {
    const w = withCall(world(), { ...N1.item, ...change }, ok(N1.sentences));
    const step = await processCall(due(N1_CALL_ITEM), "live", POLICY, deps(w));
    assertEquals(step.code, code);
    assertEquals(w.reads.length, 1);
  }
});

/**
 * History mode over the call rows M4 (or live capture) already stored: N4
 * (20 days before "now", a quoted job's contact) and N10-shaped NODUR on the
 * same contact, as context_transcript_due_calls(limit, true) returns them.
 */
function history(partial: Partial<World> = {}): World {
  const w = world({
    now: Date.parse(N4.item.dateAdded) + 20 * 24 * hours(1),
    ...partial,
  });
  withCall(w, N4.item, ok(N4.sentences));
  withCall(w, NODUR.item, ok(NODUR.sentences));
  w.history = [
    due({ ...N4.item, to: "+61489267772" }, {
      capture_mode: "backfill",
      job_numbers: ["SWF-LIVE-N4"],
    }),
    due(N4_CONVERSATION_PAGE[1], {
      capture_mode: "backfill",
      job_numbers: ["SWF-LIVE-N4"],
    }),
  ];
  return w;
}
