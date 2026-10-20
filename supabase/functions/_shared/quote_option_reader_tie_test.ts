// deno-lint-ignore-file no-import-prefix
// SQ-23 reader: a superseded and an unsuperseded event at one instant have no
// knowable order (CIO finding, 20 Oct 2026). The trigger clears a mark and
// marks the same job again inside one transaction when an accepted option
// goes back to quoted while another option is still won, and both events
// carry that transaction's now(). The reader shows such a job, flagged, and
// never decides it from the tie.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  decideQuoteOptionGroups,
  openSupersessions,
  type QuoteOptionEvent,
  type QuoteOptionMember,
  quoteOptionSummary,
  supersessionOrderUnknown,
} from "./quote_option_reader.ts";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const G = id(1);
const A = id(1); // accepted option, now back to quoted
const B = id(2); // the still-won option
const C = id(3); // the option cleared and marked again
const T0 = "2026-10-19T01:00:00.000Z";
const T1 = "2026-10-19T02:00:00.000Z";
const NOW = "2026-10-19T12:00:00.000Z";

function s(job: string, by: string, at: string): QuoteOptionEvent {
  return {
    job_id: job,
    event_type: "quote_option_superseded",
    created_at: at,
    detail_json: { superseded_by_job_id: by, quote_option_group_id: G },
  };
}

function u(job: string, at: string): QuoteOptionEvent {
  return {
    job_id: job,
    event_type: "quote_option_unsuperseded",
    created_at: at,
    detail_json: { reason: "acceptance_reversed", quote_option_group_id: G },
  };
}

const members: QuoteOptionMember[] = [
  { id: A, status: "quoted", quote_option_group_id: G, superseded_at: null },
  { id: B, status: "accepted", quote_option_group_id: G, superseded_at: T1 },
  { id: C, status: "quoted", quote_option_group_id: G, superseded_at: T1 },
];

// Clear then mark again in one transaction, written in both read orders.
const clearThenMark = [s(C, A, T0), u(C, T1), s(C, B, T1)];
const readOrders = [clearThenMark, [s(C, A, T0), s(C, B, T1), u(C, T1)]];

Deno.test("quote options tie: one instant holding both kinds is order unknown in either read order", () => {
  for (const events of readOrders) {
    assertEquals([...supersessionOrderUnknown(events, NOW)], [C]);
    assertEquals(openSupersessions(events, NOW).has(C), false);
  }
});

Deno.test("quote options tie: the job is shown and flagged, never hidden or read as plainly live", () => {
  for (const events of readOrders) {
    const d = decideQuoteOptionGroups(new Map([[G, members]]), events, NOW)
      .get(C);
    assertEquals(d?.state, "live");
    assertEquals(d?.reason, "events_order_unknown");
  }
});

Deno.test("quote options tie: the summary names the order-unknown job", () => {
  const decisions = decideQuoteOptionGroups(
    new Map([[G, members]]),
    clearThenMark,
    NOW,
  );
  const summary = quoteOptionSummary({
    status: "ok",
    decisions,
    hidden: new Set(),
  }) as { quote_options: { order_unknown_job_ids?: string[] } };
  assertEquals(summary.quote_options.order_unknown_job_ids, [C]);
});

Deno.test("quote options tie: distinct instants still decide, and a tie only at an older instant does not count", () => {
  // Cleared, then marked again a moment later: superseded.
  const later = [s(C, A, T0), u(C, T1), s(C, B, "2026-10-19T02:00:00.001Z")];
  assertEquals(supersessionOrderUnknown(later, NOW).size, 0);
  assertEquals(
    openSupersessions(later, NOW).get(C)?.created_at,
    "2026-10-19T02:00:00.001Z",
  );
  // Marked, then cleared a moment later: live, no flag.
  const cleared = [s(C, A, T0), u(C, T1)];
  assertEquals(supersessionOrderUnknown(cleared, NOW).size, 0);
  assertEquals(openSupersessions(cleared, NOW).has(C), false);
  // A tie at T0, then a lone mark at T1: the newest instant decides.
  const olderTie = [u(C, T0), s(C, A, T0), s(C, B, T1)];
  assertEquals(supersessionOrderUnknown(olderTie, NOW).size, 0);
  assertEquals(openSupersessions(olderTie, NOW).has(C), true);
  // Two marks at one instant are no ambiguity.
  const twoMarks = [s(C, A, T1), s(C, B, T1)];
  assertEquals(supersessionOrderUnknown(twoMarks, NOW).size, 0);
  assertEquals(openSupersessions(twoMarks, NOW).has(C), true);
});

Deno.test("quote options tie: no flag when the job has moved on or the switch read failed", () => {
  const moved = members.map((m) => m.id === C ? { ...m, status: "lost" } : m);
  const d = decideQuoteOptionGroups(new Map([[G, moved]]), clearThenMark, NOW);
  assertEquals(d.has(C), false);
  assertEquals(
    quoteOptionSummary({
      status: "failed",
      decisions: new Map(),
      hidden: new Set(),
    }),
    {
      quote_options: {
        status: "failed",
        superseded_hidden: 0,
        pending_review_job_ids: [],
      },
    },
  );
});
