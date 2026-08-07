// deno-lint-ignore-file no-explicit-any no-import-prefix
//
// `report_sent_at` is derived from a recorded send, never asserted.
//
// Two halves, and the second is the one that is easy to get wrong. The first
// proves the generic door REFUSES the field (including `null`, the shape the
// applied 5-card correction used). The second proves the derived producer is
// additive: it may only ever fill an ABSENT stamp from a real proof, so a card
// that genuinely had its report sent keeps the stamp it already carries, and a
// card with no proof can never acquire one.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bodyAssertsReportSentAt,
  earliestReleaseProvenAt,
  REPORT_SENT_AT_ASSERTION_REFUSAL,
  stampMakesafeReportSentFromRouteProofs,
} from "./makesafe_report_sent_stamp.ts";
import { _updateMakesafeDetails } from "./index.ts";

const JOB = "22222222-2222-2222-2222-222222222222";
const OTHER_JOB = "33333333-3333-3333-3333-333333333333";
const PROVEN = "2026-08-07T04:15:00.000Z";

interface Store {
  [table: string]: any[];
}

class FakeQuery {
  private filters: Array<(row: any) => boolean> = [];
  constructor(
    private store: Store,
    private table: string,
    private op: "select" | "update" | "insert",
    private payload: any = null,
    private failTables: Set<string> = new Set(),
  ) {}
  eq(col: string, val: any) {
    this.filters.push((r) => String(r?.[col] ?? "") === String(val));
    return this;
  }
  /** The compare-and-set filter: `report_sent_at IS NULL`. */
  is(col: string, val: any) {
    if (val === null) {
      this.filters.push((r) => r?.[col] === null || r?.[col] === undefined);
    } else {
      this.filters.push((r) => r?.[col] === val);
    }
    return this;
  }
  select(_cols?: string) {
    return this;
  }
  single() {
    const r = this.settle();
    if (r.error) return Promise.resolve(r);
    const first = (r.data || [])[0];
    if (!first) {
      return Promise.resolve({
        data: null,
        error: { message: "no rows", code: "PGRST116" },
      });
    }
    return Promise.resolve({ data: first, error: null });
  }
  private rows() {
    return (this.store[this.table] || []).filter((r) =>
      this.filters.every((f) => f(r))
    );
  }
  private settle() {
    if (this.failTables.has(this.table)) {
      return { data: null, error: { message: `${this.table} unreadable` } };
    }
    if (this.op === "update") {
      const matched = this.rows();
      for (const row of matched) Object.assign(row, this.payload);
      return { data: matched, error: null };
    }
    if (this.op === "insert") {
      (this.store[this.table] ||= []).push(this.payload);
      return { data: [this.payload], error: null };
    }
    return { data: this.rows(), error: null };
  }
  then(res: any, rej?: any) {
    return Promise.resolve(this.settle()).then(res, rej);
  }
  catch(fn: any) {
    return Promise.resolve(this.settle()).catch(fn);
  }
}

function fakeClient(store: Store, failTables: string[] = []) {
  const fail = new Set(failTables);
  return {
    from(table: string) {
      return {
        select: (cols?: string) =>
          new FakeQuery(store, table, "select", null, fail).select(cols),
        update: (payload: any) =>
          new FakeQuery(store, table, "update", payload, fail),
        insert: (payload: any) =>
          new FakeQuery(store, table, "insert", payload, fail),
      };
    },
  };
}

function detailStore(reportSentAt: string | null = null): Store {
  return {
    makesafe_job_details: [
      {
        job_id: JOB,
        report_sent_at: reportSentAt,
        substatus: "admin_to_send_report",
        invoice_notes: null,
      },
    ],
    job_events: [],
  };
}

// ── The door ────────────────────────────────────────────────────────────────

Deno.test("update_makesafe_details refuses a report_sent_at assertion", async () => {
  const store = detailStore(null);
  await assertRejects(
    () =>
      _updateMakesafeDetails(fakeClient(store) as any, {
        job_id: JOB,
        report_sent_at: "2026-08-07T00:00:00.000Z",
      }),
    Error,
    "derived from a recorded send",
  );
  assertEquals(
    store.makesafe_job_details[0].report_sent_at,
    null,
    "a refused request must write nothing",
  );
});

Deno.test("update_makesafe_details refuses a report_sent_at CLEAR too", async () => {
  // `{ report_sent_at: null }` is the exact shape the applied 5-card correction
  // used. Clearing is a correction and needs the guarded action's proof that the
  // card was never sent; a bare null through here could erase a real send.
  const store = detailStore("2026-06-30T00:12:51.200Z");
  await assertRejects(
    () =>
      _updateMakesafeDetails(fakeClient(store) as any, {
        job_id: JOB,
        report_sent_at: null,
      }),
    Error,
    "correct_makesafe_false_send_stamp",
  );
  assertEquals(
    store.makesafe_job_details[0].report_sent_at,
    "2026-06-30T00:12:51.200Z",
    "a refused clear must leave the stamp exactly as it was",
  );
});

Deno.test("update_makesafe_details still writes its other fields", async () => {
  // The refusal must be surgical: closing one field cannot break the editor.
  const store = detailStore(null);
  const result: any = await _updateMakesafeDetails(fakeClient(store) as any, {
    job_id: JOB,
    invoice_notes: "builder chased 2026-08-07",
  });
  assert(result.ok);
  assertEquals(
    store.makesafe_job_details[0].invoice_notes,
    "builder chased 2026-08-07",
  );
});

Deno.test("bodyAssertsReportSentAt keys on PRESENCE, not truthiness", () => {
  assert(bodyAssertsReportSentAt({ report_sent_at: null }));
  assert(bodyAssertsReportSentAt({ report_sent_at: "" }));
  assert(bodyAssertsReportSentAt({ reportSentAt: "2026-08-07T00:00:00Z" }));
  assert(!bodyAssertsReportSentAt({ invoice_notes: "x" }));
  assert(!bodyAssertsReportSentAt(null));
  assert(
    REPORT_SENT_AT_ASSERTION_REFUSAL.includes("correct_makesafe_false_send_stamp"),
    "the refusal must name the path that CAN correct a stamp",
  );
});

// ── The derivation ──────────────────────────────────────────────────────────

Deno.test("earliestReleaseProvenAt takes the earliest leg and ignores junk", () => {
  assertEquals(
    earliestReleaseProvenAt([
      { proven_at: "2026-08-07T04:20:00.000Z" },
      { proven_at: PROVEN },
      { proven_at: "2026-08-07T04:30:00.000Z" },
    ]),
    PROVEN,
  );
  // An unparseable or absent time contributes NOTHING — never a fallback to now,
  // which would be the fabricated reading this module refuses.
  assertEquals(earliestReleaseProvenAt([{ proven_at: "not-a-date" }]), null);
  assertEquals(earliestReleaseProvenAt([{ proven_at: null }]), null);
  assertEquals(earliestReleaseProvenAt([]), null);
});

Deno.test("a confirmed route proof stamps an ABSENT report_sent_at", async () => {
  const store = detailStore(null);
  const outcome = await stampMakesafeReportSentFromRouteProofs(
    fakeClient(store) as any,
    JOB,
    [{ proven_at: PROVEN }],
    { releaseRevisionId: "rev-1", actor: "operator" },
  );
  assertEquals(outcome.outcome, "stamped");
  assertEquals(outcome.report_sent_at, PROVEN);
  assertEquals(store.makesafe_job_details[0].report_sent_at, PROVEN);
  assertEquals(
    store.job_events[0].event_type,
    "makesafe_report_sent_at_derived",
  );
});

Deno.test("an EXISTING stamp is never overwritten", async () => {
  // The invariant that must not break: a card that genuinely had its report sent
  // keeps its own stamp. A later release leg must not move it.
  const original = "2026-06-30T00:12:51.200Z";
  const store = detailStore(original);
  const outcome = await stampMakesafeReportSentFromRouteProofs(
    fakeClient(store) as any,
    JOB,
    [{ proven_at: PROVEN }],
  );
  assertEquals(outcome.outcome, "already_stamped");
  assertEquals(store.makesafe_job_details[0].report_sent_at, original);
  assertEquals(store.job_events.length, 0, "a no-op writes no audit row");
});

Deno.test("no proof means no stamp, and no write", async () => {
  const store = detailStore(null);
  for (
    const proofs of [
      [],
      null,
      [{ proven_at: null }],
      [{ proven_at: "" }],
    ] as any[]
  ) {
    const outcome = await stampMakesafeReportSentFromRouteProofs(
      fakeClient(store) as any,
      JOB,
      proofs,
    );
    assertEquals(outcome.outcome, "no_proof");
  }
  assertEquals(store.makesafe_job_details[0].report_sent_at, null);
  assertEquals(store.job_events.length, 0);
});

Deno.test("a card not on the release is untouched", async () => {
  // The helper writes by explicit job_id only; it never fans out.
  const store = detailStore(null);
  store.makesafe_job_details.push({ job_id: OTHER_JOB, report_sent_at: null });
  await stampMakesafeReportSentFromRouteProofs(
    fakeClient(store) as any,
    JOB,
    [{ proven_at: PROVEN }],
  );
  assertEquals(
    store.makesafe_job_details.find((d) => d.job_id === OTHER_JOB)
      ?.report_sent_at,
    null,
  );
});

Deno.test("a write fault is reported, never thrown", async () => {
  // The send is already irreversible by the time this runs. A stamping fault
  // must not fail the release action, because the operator's only remedy for a
  // failed send action is to send again.
  const store = detailStore(null);
  const outcome = await stampMakesafeReportSentFromRouteProofs(
    fakeClient(store, ["makesafe_job_details"]) as any,
    JOB,
    [{ proven_at: PROVEN }],
  );
  assertEquals(outcome.outcome, "write_failed");
  assert(outcome.detail?.includes("unreadable"));
});

Deno.test("an unwritable audit row does not undo a correct stamp", async () => {
  const store = detailStore(null);
  const outcome = await stampMakesafeReportSentFromRouteProofs(
    fakeClient(store, ["job_events"]) as any,
    JOB,
    [{ proven_at: PROVEN }],
  );
  assertEquals(outcome.outcome, "stamped");
  assertEquals(store.makesafe_job_details[0].report_sent_at, PROVEN);
});

Deno.test("the module exports no way to CLEAR a stamp", async () => {
  // Structural: the only write path here sets a proven timestamp. Clearing is
  // correct_makesafe_false_send_stamp's job, behind its send-truth derivation.
  // `report_sent_at: null` also appears in the OUTCOME objects this module
  // returns, which are reports and not writes — so the assertion is about the
  // update payloads specifically, not about the string anywhere in the file.
  const source = await Deno.readTextFile(
    new URL("./makesafe_report_sent_stamp.ts", import.meta.url),
  );
  const updatePayloads = [...source.matchAll(/\.update\(\{([^}]*)\}/g)]
    .map((m) => m[1]);
  assertEquals(updatePayloads.length, 1, "exactly one write path");
  assert(
    /report_sent_at:\s*provenAt/.test(updatePayloads[0]),
    "the one write must set the PROVEN send time, never a caller value and never null",
  );
});
