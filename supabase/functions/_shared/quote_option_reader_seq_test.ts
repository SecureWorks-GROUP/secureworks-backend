// deno-lint-ignore-file no-import-prefix
// SQ-23 reader: supersede events ordered by the writer's detail_json.seq
// (proposed in sq23/event-order 1696f83, not yet accepted). The shapes below
// mirror V's PG17 runs against that writer (20261020-V-sq23-seq-check), job
// letters only. Events without a usable seq keep the created_at rule, and a
// tie there stays order unknown.
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
const T0 = "2026-10-20T01:00:00.000Z";
const T1 = "2026-10-20T01:00:01.000Z";
const NOW = "2026-10-20T12:00:00.000Z";

function s(
  job: string,
  by: string,
  at: string,
  seq?: unknown,
): QuoteOptionEvent {
  return {
    job_id: job,
    event_type: "quote_option_superseded",
    created_at: at,
    detail_json: {
      superseded_by_job_id: by,
      quote_option_group_id: G,
      ...(seq === undefined ? {} : { seq }),
    },
  };
}

function u(job: string, at: string, seq?: unknown): QuoteOptionEvent {
  return {
    job_id: job,
    event_type: "quote_option_unsuperseded",
    created_at: at,
    detail_json: {
      quote_option_group_id: G,
      ...(seq === undefined ? {} : { seq }),
    },
  };
}

// V's twostmt run on 1696f83: A back to quoted, B accepted, one transaction.
// C was superseded by A (seq 2), cleared (seq 4) and marked by B (seq 6), the
// last two at one instant.
const members: QuoteOptionMember[] = [
  { id: A, status: "quoted", quote_option_group_id: G, superseded_at: T1 },
  { id: B, status: "accepted", quote_option_group_id: G, superseded_at: null },
  { id: C, status: "quoted", quote_option_group_id: G, superseded_at: T1 },
];
const twoStmt = [s(C, A, T0, 2), u(C, T1, 4), s(C, B, T1, 6)];

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
    const d = decideQuoteOptionGroups(new Map([[G, members]]), events, NOW).get(
      C,
    );
    assertEquals(d?.state, "superseded");
    assertEquals(d?.reason, "one_option_won");
  }
  // The other way round: marked then cleared at one instant reads live.
  const clearedLast = [s(C, A, T0, 2), s(C, B, T1, 4), u(C, T1, 6)];
  assertEquals(openSupersessions(clearedLast, NOW).has(C), false);
  assertEquals(supersessionOrderUnknown(clearedLast, NOW).size, 0);
});

Deno.test("quote options seq: seq outranks created_at across transactions", () => {
  // A transaction that began earlier (older now()) but took the group lock
  // and wrote later carries the higher seq.
  assertEquals(
    openSupersessions([s(C, A, T1, 5), u(C, T0, 7)], NOW).has(C),
    false,
  );
  assertEquals(
    openSupersessions([u(C, T1, 5), s(C, A, T0, 7)], NOW).has(C),
    true,
  );
  // A seq written as a string of digits counts.
  assertEquals(
    openSupersessions([u(C, T1, "5"), s(C, A, T1, "7")], NOW).has(C),
    true,
  );
});

Deno.test("quote options seq: legacy and unusable seq keep the created_at rule, and a tie stays unknown", () => {
  const ties = [
    [u(C, T1), s(C, B, T1)], // legacy: no seq at all
    [u(C, T1, 4), s(C, B, T1)], // mixed
    [u(C, T1, 4), s(C, B, T1, 4)], // repeated seq
    [u(C, T1, "x"), s(C, B, T1, 6)], // not a number
    [u(C, T1, -1), s(C, B, T1, 6)], // negative
    [u(C, T1, 1.5), s(C, B, T1, 6)], // not whole
  ];
  for (const events of ties) {
    assertEquals([...supersessionOrderUnknown(events, NOW)], [C]);
    assertEquals(openSupersessions(events, NOW).has(C), false);
    const d = decideQuoteOptionGroups(new Map([[G, members]]), events, NOW).get(
      C,
    );
    assertEquals(d?.reason, "events_order_unknown");
    assertEquals(d?.state, "live");
  }
  // No tie: created_at still decides when seq is missing on any event.
  assertEquals(openSupersessions([u(C, T0), s(C, B, T1, 6)], NOW).has(C), true);
  assertEquals(
    openSupersessions([s(C, B, T0, 6), u(C, T1)], NOW).has(C),
    false,
  );
});

Deno.test("quote options seq: an event after the reading instant is left out before seq is read", () => {
  const later = "2026-10-21T00:00:00.000Z";
  // The cleared event (highest seq) is after the reading instant: as of NOW
  // the job is still superseded.
  assertEquals(
    openSupersessions([s(C, A, T0, 2), u(C, later, 9)], NOW).has(C),
    true,
  );
  assertEquals(
    openSupersessions([s(C, A, T0, 2), u(C, later, 9)], later).has(C),
    false,
  );
});
