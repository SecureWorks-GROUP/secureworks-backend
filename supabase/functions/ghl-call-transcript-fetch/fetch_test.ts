// Slice T2: the fetcher's behaviour on the recorded named rows
// (transcript_fixtures.ts), over an in-memory stand-in for the database and
// GHL. The database's own rules (backoff, terminal outcomes, selection) are
// proved by the migration contract; here the stand-in records what the
// fetcher asked it to do.
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type BackfillDeps,
  type CaptureOutcome,
  type DueCall,
  type FetchPolicy,
  type FetchRecord,
  processCall,
  type ProviderRead,
  runBackfill,
  runLiveFetch,
} from "./fetch.ts";
import {
  flattenTranscript,
  normaliseSentences,
} from "../_shared/ghl/call_transcript.ts";
import { buildGhlMessageRow } from "../_shared/evidence/ghl_message.ts";
import {
  LOCATION_ID,
  messageAnswer,
  N1,
  N2,
  N4,
  N4_CONVERSATION_PAGE,
  NOANS,
  NODUR,
  ONECH,
  VMG,
} from "./transcript_fixtures.ts";
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

Deno.test("NOANS: the re-read says no-answer, so terminal not_expected and the transcription is never asked (HTTP 400 there)", async () => {
  const w = withCall(world(), NOANS.item, {
    ok: false,
    status: NOANS.transcriptionStatus,
    code: "http_400",
  });
  // A stale stored status (the webhook fired early) is corrected by the re-read (F16).
  const step = await processCall(
    agreedDue({
      ...NOANS.item,
      to: "+61489267774",
      meta: { call: { status: "completed", duration: 40 } },
    }),
    "live",
    POLICY,
    deps(w),
  );
  assertEquals(step.outcome, "not_expected");
  assertEquals(step.code, "provider_status_no_answer");
  assertEquals(w.reads, ["message:meYkjPC1Se4b7vCLZGaZ"]);
  assertEquals(w.fetches[0].result, "not_expected");
  assertEquals(w.fetches[0].provider_status, "no-answer");
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

// Synthetic N17 stand-in: no recorded N17 case was found.
Deno.test("Synthetic N17 stand-in: nothing yet (empty list or 404) is not_ready; the database owns the backoff and when it ends", async () => {
  for (
    const [answer, code] of [
      [ok([]), "empty"],
      [ok(null), "empty"],
      [{ ok: false, status: 404, code: "http_404" }, "transcript_not_found"],
    ] as [ProviderRead, string][]
  ) {
    const w = withCall(world(), N1.item, answer);
    w.now = Date.parse(N1.item.dateAdded) + hours(1);
    const step = await processCall(due(N1_CALL_ITEM), "live", POLICY, deps(w));
    assertEquals(step.outcome, "not_ready");
    assertEquals(w.fetches[0].result, "not_ready");
    assertEquals(w.fetches[0].code, code);
    assertEquals(w.captured, []);
  }
});

Deno.test("provider failures carry their code; 429 also stops the run (F3, F5)", async () => {
  for (
    const [answer, code, stop] of [
      [{ ok: false, status: 500, code: "http_500" }, "http_500", undefined],
      [{ ok: false, status: 401, code: "http_401" }, "http_401", undefined],
      [
        { ok: false, status: 429, code: "http_429" },
        "http_429",
        "rate_limited",
      ],
      [{ ok: false, status: null, code: "transport" }, "transport", undefined],
      [ok({ data: N1.sentences }), "provider_invalid", undefined],
    ] as [ProviderRead, string, string | undefined][]
  ) {
    const w = withCall(world(), N1.item, answer);
    w.now = Date.parse(N1.item.dateAdded) + hours(1);
    const step = await processCall(due(N1_CALL_ITEM), "live", POLICY, deps(w));
    assertEquals(step.outcome, "error");
    assertEquals(step.code, code);
    assertEquals(step.stop, stop);
    assertEquals(w.fetches[0].result, "error");
    assertEquals(w.fetches[0].code, code);
  }
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

Deno.test("a save refused by the writer (e.g. the 8 s statement timeout) is an error with its code, never a save", async () => {
  const w = withCall(world(), N1.item, ok(N1.sentences));
  w.now = Date.parse(N1.item.dateAdded) + hours(3);
  w.captureAnswer = () => ({ outcome: "error", code: "57014" });
  const step = await processCall(
    agreedDue(N1_CALL_ITEM),
    "live",
    POLICY,
    deps(w),
  );
  assertEquals(step.outcome, "error");
  assertEquals(w.fetches[0].code, "capture_57014");
});

Deno.test("live run: idle with no read and no run row while the flag or the lane is off (F9)", async () => {
  for (
    const [flag, lane, reason] of [[false, true, "fetch_flag_off"], [
      true,
      false,
      "capture_lane_off",
    ]] as const
  ) {
    const w = world({ flag, lane, due: [agreedDue(N1_CALL_ITEM)] });
    const result = await runLiveFetch(deps(w));
    assertEquals(result, { outcome: "idle", reason });
    assertEquals(w.runs, []);
    assertEquals(w.reads, []);
  }
});

Deno.test("live run: a run still going (under 10 min) is not overlapped", async () => {
  const w = world({
    latest: { id: "r0", status: "running", started_at: "2026-09-24T04:57:00Z" },
    due: [agreedDue(N1_CALL_ITEM)],
  });
  const result = await runLiveFetch(deps(w));
  assertEquals(result, { outcome: "run_in_progress", run_id: "r0" });
  assertEquals(w.reads, []);
});

Deno.test("live run: records a run with counts only; a 429 ends it partial; capture off ends it without a fetch record", async () => {
  const w = world();
  withCall(w, N1.item, ok(N1.sentences));
  withCall(w, N4.item, { ok: false, status: 429, code: "http_429" });
  withCall(w, ONECH.item, ok(ONECH.sentences));
  w.now = Date.parse("2026-09-24T05:00:00Z");
  w.due = [
    agreedDue(N1_CALL_ITEM),
    agreedDue({ ...N4.item, to: "+61489267772" }),
    agreedDue(ONECH.item),
  ];
  const result = await runLiveFetch(deps(w));
  assert(result.outcome === "ran");
  assertEquals(result.status, "partial");
  assertEquals(result.error_code, "rate_limited");
  assertEquals(result.counts.saved, 1);
  assertEquals(result.counts.errors, 1);
  assertEquals(result.counts.selected, 2);
  assertEquals(result.counts.attempts, 4);
  assertEquals(w.runs[0], {
    source: "ghl_call_transcript",
    status: "running",
    cursor: { actor: "workflow:ghl-call-transcript-fetch", mode: "live" },
  });
  assertEquals(w.runs[1].status, "partial");
  assertFalse(JSON.stringify(w.runs).includes("Placeholder"));

  const w2 = withCall(world(), N1.item, ok(N1.sentences));
  w2.now = Date.parse("2026-09-24T05:00:00Z");
  w2.due = [agreedDue(N1_CALL_ITEM)];
  w2.captureAnswer = () => ({ outcome: "capture_disabled" });
  const r2 = await runLiveFetch(deps(w2));
  assert(r2.outcome === "ran");
  assertEquals(r2.error_code, "capture_disabled");
  assertEquals(w2.fetches, []);
});

Deno.test("live run: an unreadable due list fails the run with a code", async () => {
  const w = world();
  const d = deps(w);
  d.dueCalls = () =>
    Promise.reject(
      Object.assign(new Error("x"), { code: "due_calls_unreadable" }),
    );
  const result = await runLiveFetch(d);
  assert(result.outcome === "ran");
  assertEquals(result.status, "failed");
  assertEquals(w.runs[1].error_code, "due_calls_unreadable");
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

Deno.test("history dry run with the fetch flag off: lists the calls it would fetch, reads no transcript and writes nothing", async () => {
  const w = history({ flag: false });
  const result = await runBackfill({ dryRun: true, maxCalls: 40 }, deps(w));
  assert(result.outcome === "ran");
  assertEquals(
    result.calls.map((c) => [c.call_message_id, c.outcome, c.job_numbers]),
    [
      ["Ag9DKkqpfsadWkJS8jst", "would_fetch", ["SWF-LIVE-N4"]],
      ["MeVPH47LXDbgcvPUAkjY", "would_fetch", ["SWF-LIVE-N4"]],
    ],
  );
  assertEquals(result.counts.would_fetch, 2);
  assertEquals(w.reads, []);
  assertEquals([w.captured, w.fetches, w.runs], [[], [], []]);
  assertEquals(result.run_id, null);
  assertEquals(result.more, false);
});

Deno.test("history dry run with the flag on: reads GHL and reports each call, writes nothing at all", async () => {
  const w = history();
  const result = await runBackfill({ dryRun: true, maxCalls: 40 }, deps(w));
  assert(result.outcome === "ran");
  // First read of each call: the agreement rule would wait for a second read.
  assertEquals(
    result.calls.map((c) => [c.call_message_id, c.outcome, c.sentences]),
    [
      ["Ag9DKkqpfsadWkJS8jst", "awaiting_agreement", 77],
      ["MeVPH47LXDbgcvPUAkjY", "awaiting_agreement", 90],
    ],
  );
  assertEquals([w.captured, w.fetches, w.runs], [[], [], []]);
  assertFalse(JSON.stringify(result).includes("Placeholder"));
});

Deno.test("history real run is refused while the fetch flag or the capture lane is off", async () => {
  assertEquals(
    await runBackfill(
      { dryRun: false, maxCalls: 40 },
      deps(history({ flag: false })),
    ),
    { outcome: "refused", reason: "fetch_flag_off" },
  );
  assertEquals(
    await runBackfill(
      { dryRun: false, maxCalls: 40 },
      deps(history({ lane: false })),
    ),
    { outcome: "refused", reason: "capture_lane_off" },
  );
});

Deno.test("history real runs: the first read waits, the run 5 min later saves backfill transcripts; no call row is ever written", async () => {
  const w = history();
  const d = deps(w);
  const first = await runBackfill({ dryRun: false, maxCalls: 40 }, d);
  assert(first.outcome === "ran");
  assertEquals(first.counts.awaiting_agreement, 2);
  assertEquals(w.captured, []);
  assertEquals(w.fetches.map((f) => [f.call_message_id, f.mode, f.result]), [
    ["Ag9DKkqpfsadWkJS8jst", "backfill", "awaiting_agreement"],
    ["MeVPH47LXDbgcvPUAkjY", "backfill", "awaiting_agreement"],
  ]);
  // The selection returns them again with the remembered read, 5 min later.
  w.now += 5 * 60_000;
  w.history = w.history.map((c) => ({
    ...c,
    ...w.outcomes.get(c.call_message_id)!,
  }));
  const second = await runBackfill({ dryRun: false, maxCalls: 40 }, d);
  assert(second.outcome === "ran");
  assertEquals(second.counts.saved, 2);
  assertEquals(
    w.captured.map((r) => [r.event_type, r.provider_message_id, r.metadata]),
    [
      ["call.transcript_completed", "ghltx:Ag9DKkqpfsadWkJS8jst", {
        capture_mode: "backfill",
      }],
      ["call.transcript_completed", "ghltx:MeVPH47LXDbgcvPUAkjY", {
        capture_mode: "backfill",
      }],
    ],
  );
  assertEquals(w.runs.map((r) => [r.source, r.status]), [
    ["ghl_call_transcript_backfill", "running"],
    ["ghl_call_transcript_backfill", "succeeded"],
    ["ghl_call_transcript_backfill", "running"],
    ["ghl_call_transcript_backfill", "succeeded"],
  ]);
});

Deno.test("history: a full page says more; the time budget stops early and says more", async () => {
  const w = history();
  const full = await runBackfill({ dryRun: true, maxCalls: 1 }, deps(w));
  assert(full.outcome === "ran");
  assertEquals([full.calls.length, full.more], [1, true]);
  const d = deps(w);
  let reads = 0;
  const readMessage = d.readCallMessage;
  d.readCallMessage = (id) => {
    reads++;
    w.now += 200_000;
    return readMessage(id);
  };
  const late = await runBackfill({ dryRun: true, maxCalls: 40 }, d);
  assert(late.outcome === "ran");
  assertEquals([late.status, late.error_code, late.more, reads], [
    "partial",
    "time_budget",
    true,
    1,
  ]);
});

Deno.test("history: 30 calls under the page size, every first read awaiting agreement, is not finished: more with the pending count and next try", async () => {
  const w = history();
  const call = w.history[0];
  w.history = Array.from({ length: 30 }, (_, i) => {
    const id = `histCall${String(i).padStart(4, "0")}`;
    w.items.set(id, { ...N4.item, id });
    w.transcripts.set(id, ok(N4.sentences));
    return { ...call, call_message_id: id, call_event_id: `call-${id}` };
  });
  const result = await runBackfill({ dryRun: false, maxCalls: 40 }, deps(w));
  assert(result.outcome === "ran");
  assertEquals(result.counts.selected, 30);
  assertEquals(result.counts.awaiting_agreement, 30);
  assertEquals(result.counts.saved, 0);
  assertEquals(
    [result.more, result.pending_history, result.next_due_at],
    [true, 30, new Date(w.now + 5 * 60_000).toISOString()],
  );
  // Once every history call is finished, the run says so.
  w.history = [];
  const done = await runBackfill({ dryRun: false, maxCalls: 40 }, deps(w));
  assert(done.outcome === "ran");
  assertEquals([done.more, done.pending_history, done.next_due_at], [
    false,
    0,
    null,
  ]);
});

Deno.test("a live-captured past call whose history fetch record is pending, finished by the live run, is saved as backfill", async () => {
  const w = history();
  const call = w.history[0];
  assertEquals(call.capture_mode, "backfill");
  const first = await runBackfill(
    { dryRun: false, maxCalls: 1 },
    deps(w),
  );
  assert(first.outcome === "ran");
  assertEquals(first.counts.awaiting_agreement, 1);
  w.now += 5 * 60_000;
  w.due = [{
    ...call,
    capture_mode: "live",
    fetch_mode: "backfill",
    job_numbers: null,
    ...w.outcomes.get(call.call_message_id)!,
  }];
  const live = await runLiveFetch(deps(w));
  assert(live.outcome === "ran");
  assertEquals(live.counts.saved, 1);
  assertEquals(
    w.captured.map((r) => [r.provider_message_id, r.metadata]),
    [["ghltx:" + call.call_message_id, { capture_mode: "backfill" }]],
  );
});

Deno.test("history: an unreadable pending count is not finished", async () => {
  const w = history({ flag: false });
  const d = deps(w);
  d.historyPending = () =>
    Promise.reject(
      Object.assign(new Error("x"), { code: "history_pending_unreadable" }),
    );
  const result = await runBackfill({ dryRun: true, maxCalls: 40 }, d);
  assert(result.outcome === "ran");
  assertEquals(
    [result.status, result.error_code, result.more, result.pending_history],
    ["partial", "history_pending_unreadable", true, null],
  );
});

Deno.test("history: an unreadable selection fails the run with a code", async () => {
  const w = history();
  const d = deps(w);
  d.historyCalls = () =>
    Promise.reject(
      Object.assign(new Error("x"), { code: "history_calls_unreadable" }),
    );
  const result = await runBackfill({ dryRun: false, maxCalls: 40 }, d);
  assert(result.outcome === "ran");
  assertEquals([result.status, result.error_code], [
    "failed",
    "history_calls_unreadable",
  ]);
  assertEquals(w.runs.at(-1)?.error_code, "history_calls_unreadable");
});

Deno.test("unfinished and unknown provider states retry until the call completes", async () => {
  for (
    const status of [
      null,
      "queued",
      "initiated",
      "ringing",
      "in-progress",
      "unknown-state",
    ]
  ) {
    const item = {
      ...N1.item,
      meta: { call: { status, duration: 0 } },
      status,
    };
    const w = withCall(world(), item, ok(N1.sentences));
    const d = deps(w);
    const call = due(N1_CALL_ITEM, { event_type: "client.call_initiated" });
    const first = await processCall(call, "live", POLICY, d);
    assertEquals(first.outcome, "not_ready");
    assertEquals(w.fetches[0].result, "not_ready");
    assertEquals(w.outcomes.get(call.call_message_id)?.outcome, "pending");
    assertEquals(w.reads, ["message:" + N1.item.id]);
    w.now += 5 * 60_000;
    w.items.set(N1.item.id, N1.item);
    assertEquals(
      (await processCall(call, "live", POLICY, d)).outcome,
      "awaiting_agreement",
    );
    w.now += 5 * 60_000;
    const state = w.outcomes.get(call.call_message_id)!;
    assertEquals(
      (await processCall({ ...call, ...state }, "live", POLICY, d)).outcome,
      "saved",
    );
  }
});

Deno.test("finished non-transcribable provider calls remain terminal", async () => {
  for (
    const status of ["no-answer", "busy", "failed", "canceled", "completed"]
  ) {
    const w = withCall(world(), {
      ...N1.item,
      meta: { call: { status, duration: 1 } },
    }, ok(N1.sentences));
    const step = await processCall(due(N1_CALL_ITEM), "live", POLICY, deps(w));
    assertEquals(step.outcome, "not_expected");
    assertEquals(w.fetches[0].result, "not_expected");
    assertEquals(w.reads.length, 1);
  }
});

Deno.test("record failures count as errors and make live and history runs partial", async () => {
  for (const history of [false, true]) {
    const w = withCall(world(), N1.item, ok(N1.sentences));
    w.due = [due(N1_CALL_ITEM)];
    w.history = [due(N1_CALL_ITEM)];
    const d = deps(w);
    d.recordFetch = () => Promise.resolve({ error: "write_unavailable" });
    const result = history
      ? await runBackfill({ dryRun: false, maxCalls: 10 }, d)
      : await runLiveFetch(d);
    assert(result.outcome === "ran");
    assertEquals(result.status, "partial");
    assertEquals(result.error_code, "record_failed");
    assert(result.counts.record_failed > 0);
    assertEquals(result.counts.errors, result.counts.record_failed);
    assertEquals(w.runs.at(-1)?.status, "partial");
    assertEquals(w.runs.at(-1)?.error_code, "record_failed");
  }
});
