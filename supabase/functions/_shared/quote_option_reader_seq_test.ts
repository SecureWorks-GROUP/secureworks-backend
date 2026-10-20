// deno-lint-ignore-file no-import-prefix
// SQ-23 reader against the writer's order contract (sq23/event-order 1696f83
// seq, 9354f29 history guard, 503cd6d at; CIO c5db7b9 conditions C1 and C2;
// none accepted yet). Order by detail_json.seq, cut "as of t" off by
// detail_json.at, and answer unknown for a job when any kept event lacks a
// usable seq or at. The shapes mirror V's PG17 runs against that writer
// (20261020-V-sq23-seq-check), job letters only.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideQuoteOptionGroups,
  openSupersessions,
  type QuoteOptionEvent,
  type QuoteOptionMember,
  supersessionOrderUnknown,
} from "./quote_option_reader.ts";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const G = id(1);
const A = id(1);
const B = id(2);
const C = id(3);
const D = id(4);
const T0 = "2026-10-20T01:00:00.000Z";
const T1 = "2026-10-20T01:00:01.000Z";
const NOW = "2026-10-20T12:00:00.000Z";

// `at` defaults to created_at; pass null to leave it out.
function s(
  job: string,
  by: string,
  createdAt: string,
  seq?: unknown,
  at: unknown = createdAt,
): QuoteOptionEvent {
  return {
    job_id: job,
    event_type: "quote_option_superseded",
    created_at: createdAt,
    detail_json: {
      superseded_by_job_id: by,
      quote_option_group_id: G,
      ...(seq === undefined ? {} : { seq }),
      ...(at === null ? {} : { at }),
    },
  };
}

function u(
  job: string,
  createdAt: string,
  seq?: unknown,
  at: unknown = createdAt,
): QuoteOptionEvent {
  return {
    job_id: job,
    event_type: "quote_option_unsuperseded",
    created_at: createdAt,
    detail_json: {
      quote_option_group_id: G,
      ...(seq === undefined ? {} : { seq }),
      ...(at === null ? {} : { at }),
    },
  };
}

const decide = (events: QuoteOptionEvent[], asOf = NOW) =>
  decideQuoteOptionGroups(new Map([[G, members]]), events, asOf).get(C);

// V's twostmt run on 1696f83: A back to quoted, B accepted, one transaction.
// C was superseded by A (seq 2), cleared (seq 4) and marked by B (seq 6), the
// last two at one created_at.
const members: QuoteOptionMember[] = [
  { id: A, status: "quoted", quote_option_group_id: G, superseded_at: T1 },
  { id: B, status: "accepted", quote_option_group_id: G, superseded_at: null },
  { id: C, status: "quoted", quote_option_group_id: G, superseded_at: T1 },
];
const twoStmt = [
  s(C, A, T0, 2),
  u(C, T1, 4, "2026-10-20T01:00:01.000100+00:00"),
  s(C, B, T1, 6, "2026-10-20T01:00:01.000200+00:00"),
];

Deno.test("quote options seq: a same-instant clear and re-mark is settled by seq, in any read order", () => {
  for (
    const events of [twoStmt, [...twoStmt].reverse(), [
      twoStmt[0],
      twoStmt[2],
      twoStmt[1],
    ]]
  ) {
    assertEquals(supersessionOrderUnknown(events, NOW).size, 0);
    assertEquals(openSupersessions(events, NOW).get(C)?.detail_json?.seq, 6);
    const d = decide(events);
    assertEquals([d?.state, d?.reason], ["superseded", "one_option_won"]);
  }
  // The other way round: marked then cleared at one instant reads live.
  const clearedLast = [s(C, A, T0, 2), s(C, B, T1, 4), u(C, T1, 6)];
  assertEquals(openSupersessions(clearedLast, NOW).has(C), false);
  assertEquals(supersessionOrderUnknown(clearedLast, NOW).size, 0);
});

Deno.test("quote options seq: seq outranks created_at across transactions", () => {
  // A transaction that began earlier (older created_at) but took the group
  // lock and wrote later carries the higher seq and the later at.
  const late = "2026-10-20T01:00:02.000Z";
  assertEquals(
    openSupersessions([s(C, A, T1, 5), u(C, T0, 7, late)], NOW).has(C),
    false,
  );
  assertEquals(
    openSupersessions([u(C, T1, 5), s(C, A, T0, 7, late)], NOW).has(C),
    true,
  );
  // A seq written as a string of digits counts.
  assertEquals(
    openSupersessions([u(C, T1, "5"), s(C, A, T1, "7")], NOW).has(C),
    true,
  );
});

Deno.test("quote options seq: C1 cuts off by at, not created_at (lock-wait window)", () => {
  // S1-L1: X starts at T0 but waits for the lock; Y starts at T1, takes the
  // lock first and clears C (seq 5, at T1+). X then marks C (seq 7, at T2).
  // created_at puts X's mark first; at puts it after Y's clear.
  const T2 = "2026-10-20T01:00:03.000Z";
  const events = [
    s(C, A, "2026-10-20T00:59:00.000Z", 2),
    u(C, T1, 5, "2026-10-20T01:00:01.500Z"),
    s(C, B, T0, 7, T2),
  ];
  // Between Y's clear and X's mark: X's mark had not happened, so C is live.
  const between = "2026-10-20T01:00:02.000Z";
  assertEquals(openSupersessions(events, between).has(C), false);
  assertEquals(supersessionOrderUnknown(events, between).size, 0);
  // Before Y's clear (and after X's created_at): still superseded by A only.
  const beforeClear = "2026-10-20T01:00:01.200Z";
  assertEquals(
    openSupersessions(events, beforeClear).get(C)?.detail_json?.seq,
    2,
  );
  // After X's mark: superseded by B.
  assertEquals(openSupersessions(events, NOW).get(C)?.detail_json?.seq, 7);
});

Deno.test("quote options seq: C2 mixed or missing stamps are order unknown, tie or not", () => {
  const shapes = [
    [u(C, T1, undefined, null), s(C, B, T1, undefined, null)], // legacy tie
    [u(C, T0, undefined, null), s(C, B, T1, 6)], // legacy beside seq, no tie
    [s(C, B, T0, 6), u(C, T1, undefined, null)], // the other way round
    [u(C, T0, 4), s(C, B, T1)], // seq missing, at present
    [u(C, T0, 4, null), s(C, B, T1, 6)], // at missing, seq present
    [u(C, T0, 4, "not a time"), s(C, B, T1, 6)], // unreadable at
    [u(C, T1, 4), s(C, B, T1, 4)], // repeated seq
    [u(C, T0, "x"), s(C, B, T1, 6)], // not a number
    [u(C, T0, 0), s(C, B, T1, 6)], // not positive
    [u(C, T0, "04"), s(C, B, T1, 6)], // not the writer's digits
    [u(C, T0, -1), s(C, B, T1, 6)], // negative
    [u(C, T0, 1.5), s(C, B, T1, 6)], // not whole
    [s(C, A, T0, 2), u(C, T1, 6, T0), s(C, B, T1, 4, T1)], // at falls as seq rises
  ];
  for (const events of shapes) {
    assertEquals([...supersessionOrderUnknown(events, NOW)], [C]);
    assertEquals(openSupersessions(events, NOW).has(C), false);
    const d = decide(events);
    assertEquals([d?.state, d?.reason], ["live", "events_order_unknown"]);
  }
  // A seq-less event after the reading instant is not kept, so it does not
  // make the earlier stamped history unknown.
  const lateLegacy = [s(C, B, T0, 6), u(C, "2026-10-21T00:00:00.000Z")];
  assertEquals(supersessionOrderUnknown(lateLegacy, NOW).size, 0);
  assertEquals(openSupersessions(lateLegacy, NOW).has(C), true);
});

Deno.test("quote options seq: gaps in seq mean nothing, and seq is never compared across jobs", () => {
  // Rolled-back writes skip seq values; the history guard (9354f29) keeps
  // the kept events in place. The highest kept seq decides.
  assertEquals(
    openSupersessions([s(C, A, T0, 3), u(C, T1, 40)], NOW).has(C),
    false,
  );
  // Job D's higher seqs do not touch job C's order.
  const events = [
    s(C, A, T0, 10),
    u(D, T0, 11),
    s(D, A, T1, 12),
    u(C, T1, 13),
    s(D, B, T1, 20),
  ];
  const open = openSupersessions(events, NOW);
  assertEquals(open.has(C), false);
  assertEquals(open.get(D)?.detail_json?.seq, 20);
  assertEquals(supersessionOrderUnknown(events, NOW).size, 0);
  // An unknown job does not make another job unknown.
  const mixed = [s(C, A, T0, 10), u(D, T0)];
  assertEquals([...supersessionOrderUnknown(mixed, NOW)], [D]);
  assertEquals(openSupersessions(mixed, NOW).has(C), true);
});
