import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ApiError,
  approveExpense,
  submitExpense,
  updateExpense,
} from "./index.ts";
import { ExpenseCaptureError } from "./expense_capture_v2.ts";
import {
  assertUnbookedApprovalConfirmed,
  expenseJobIdOf,
  expenseUnbookedJobMark,
} from "./expense_own_job.ts";

const expenseId = "ZZTEST-receipt";
const ownJob = "ZZTEST-own-job";
const otherJob = "ZZTEST-other-job";
const tradeId = "ZZTEST-trade";
const trade = {
  mode: "jwt",
  user: { id: tradeId, email: "zztest@example.invalid", role: "trade" },
} as const;
const manager = {
  mode: "jwt",
  user: { id: tradeId, email: "zztest@example.invalid", role: "lead_installer" },
} as const;
const office = {
  mode: "jwt",
  user: { id: "ZZTEST-office", email: "zztest@example.invalid", role: "ops_manager" },
} as const;
const serverKey = { mode: "api_key" } as const;

type Booking = {
  job_id: string;
  user_id: string;
  role?: string | null;
  status?: string | null;
  is_ghost?: boolean;
};

function store(opts: {
  bookings?: Booking[];
  row?: Record<string, unknown>;
  switchOn?: boolean;
} = {}) {
  const bookings = opts.bookings ?? [
    { job_id: ownJob, user_id: tradeId, role: "lead_installer", status: "scheduled" },
  ];
  let row: Record<string, unknown> = {
    id: expenseId,
    submitted_by: tradeId,
    status: "pending",
    updated_at: "initial",
    job_id: null,
    stock_division: null,
    payment_method: "company_card",
    xero_bill_id: null,
    unbooked_job_id: null,
    ...opts.row,
  };
  const state = {
    failBookings: "" as "" | "error" | "throw" | "shape",
    failApprove: false,
    // Mark the row between approve's read and its write.
    markBeforeApprove: "" as string,
    bookingReads: 0,
    inserts: 0,
    writes: 0,
  };
  const client = {
    from(table: string) {
      let changes: Record<string, unknown> | undefined;
      const matches: [string, unknown][] = [];
      let orFilter = "";
      const q: any = {
        select() {
          return q;
        },
        eq(key: string, value: unknown) {
          matches.push([key, value]);
          return q;
        },
        is(key: string, value: null) {
          matches.push([key, value]);
          return q;
        },
        or(filter: string) {
          orFilter = filter;
          return q;
        },
        ilike() {
          return q;
        },
        limit() {
          return q;
        },
        insert(value: Record<string, unknown>) {
          if (table === "expense_receipts") {
            state.inserts++;
            row = { ...value, id: expenseId, updated_at: "initial" };
          }
          return q;
        },
        update(value: Record<string, unknown>) {
          changes = value;
          return q;
        },
        single() {
          return q.maybeSingle();
        },
        maybeSingle() {
          if (table === "feature_flags") {
            return { data: { enabled: Boolean(opts.switchOn) } };
          }
          if (table === "expense_receipts") {
            if (changes && "approved_at" in changes) {
              if (state.failApprove) return { data: null, error: { code: "57014" } };
              if (state.markBeforeApprove) {
                row.unbooked_job_id = state.markBeforeApprove;
                state.markBeforeApprove = "";
              }
            }
            if (!matches.every(([k, v]) => (row[k] ?? null) === v)) {
              return { data: null };
            }
            if (changes) {
              state.writes++;
              Object.assign(row, changes);
            }
            return { data: { ...row } };
          }
          return { data: null };
        },
        then(resolve: (value: unknown) => void, reject: (e: unknown) => void) {
          if (table === "job_assignments") {
            state.bookingReads++;
            if (state.failBookings === "throw") return reject(new Error("down"));
            if (state.failBookings === "error") {
              return resolve({ data: null, error: { code: "57014" } });
            }
            if (state.failBookings === "shape") {
              return resolve({ data: null, error: null });
            }
            const want = Object.fromEntries(matches);
            const data = bookings.filter((b) =>
              b.job_id === want.job_id && b.user_id === want.user_id &&
              (b.is_ghost ?? false) === want.is_ghost &&
              (orFilter !== "status.is.null,status.neq.cancelled" ||
                b.status == null || b.status !== "cancelled")
            );
            return resolve({ data, error: null });
          }
          if (table === "expense_receipts") return resolve(q.maybeSingle());
          return resolve({ data: [], error: null });
        },
      };
      return q;
    },
  };
  return { client, state, read: () => ({ ...row }) };
}

const submitBody = (job_id: unknown) => ({
  job_id,
  no_receipt_reason: "unavailable",
  payment_method: "company_card",
});

// ---- marked: saved on the picked job, carrying the mark ----

Deno.test("marked: a trade's receipt on a job they are not booked on saves there, marked", async () => {
  for (const switchOn of [false, true]) {
    const { client, read, state } = store({ switchOn });
    const res = await submitExpense(client, submitBody(otherJob), trade);
    assertEquals([state.inserts, read().job_id, read().unbooked_job_id], [1, otherJob, otherJob]);
    assertEquals((res as Record<string, unknown>).not_booked_on_job, true);
  }
});

Deno.test("marked: moving a receipt onto someone else's job saves and marks it", async () => {
  const { client, read } = store();
  const res = await updateExpense(client, { expense_id: expenseId, job_id: otherJob }, trade);
  assertEquals([res.success, read().job_id, read().unbooked_job_id], [true, otherJob, otherJob]);
  assertEquals((res as Record<string, unknown>).not_booked_on_job, true);
  // The mark is not reported as a field the caller changed.
  assertEquals(res.updated_fields, ["job_id"]);
});

Deno.test("marked: a division manager buying for another crew saves, marked", async () => {
  const { client, read } = store();
  await submitExpense(client, submitBody(otherJob), manager);
  assertEquals(read().unbooked_job_id, otherJob);
});

Deno.test("marked: cancelled, watcher and ghost rows are not a booking", async () => {
  for (
    const b of [
      { status: "cancelled", role: "lead_installer" },
      { status: "scheduled", role: "observer" },
      { status: "scheduled", role: "lead_installer", is_ghost: true },
    ]
  ) {
    const { client, read } = store({
      bookings: [{ job_id: otherJob, user_id: tradeId, ...b }],
    });
    await submitExpense(client, submitBody(otherJob), trade);
    assertEquals(read().unbooked_job_id, otherJob);
  }
});

Deno.test("marked: a failed booking read saves the receipt and marks it, never counted as booked", async () => {
  for (const fail of ["error", "throw", "shape"] as const) {
    const { client, state, read } = store();
    state.failBookings = fail;
    await submitExpense(client, submitBody(ownJob), trade);
    assertEquals([state.inserts, read().job_id, read().unbooked_job_id], [1, ownJob, ownJob]);
  }
});

Deno.test("marked: a JWT caller with no user id is marked", async () => {
  const { client } = store();
  assertEquals(
    await expenseUnbookedJobMark(client, { jobId: ownJob, userId: null, staff: false }),
    ownJob,
  );
});

// ---- unmarked ----

Deno.test("unmarked: a trade on the job saves against it, with main's insert and answer", async () => {
  const { client, read } = store({ row: { unbooked_job_id: undefined } });
  const res = await submitExpense(client, submitBody(ownJob), trade);
  assertEquals(read().job_id, ownJob);
  assertEquals("unbooked_job_id" in read(), false);
  assertEquals("not_booked_on_job" in res, false);
});

Deno.test("unmarked: a null-status booking (legacy row) is a booking", async () => {
  const { client, read } = store({
    bookings: [{ job_id: otherJob, user_id: tradeId, status: null, role: null }],
  });
  await submitExpense(client, submitBody(otherJob), trade);
  assertEquals(read().unbooked_job_id ?? null, null);
});

Deno.test("unmarked: the office and the server key file on any job, no read", async () => {
  for (const caller of [office, serverKey]) {
    const { client, read, state } = store({ bookings: [] });
    await submitExpense(client, submitBody(otherJob), caller);
    assertEquals([read().job_id, read().unbooked_job_id ?? null, state.bookingReads], [otherJob, null, 0]);
  }
});

Deno.test("unmarked: moving onto the trade's own job clears an earlier mark", async () => {
  const { client, read } = store({ row: { job_id: otherJob, unbooked_job_id: otherJob } });
  const res = await updateExpense(client, { expense_id: expenseId, job_id: ownJob, capture_version: 2 }, trade);
  assertEquals([read().job_id, read().unbooked_job_id, res.next_step], [ownJob, null, "saved_against_job"]);
  assertEquals("not_booked_on_job" in res, false);
});

Deno.test("unmarked: the office moving a receipt onto any job clears the mark", async () => {
  const { client, read } = store({ row: { job_id: otherJob, unbooked_job_id: otherJob }, bookings: [] });
  await updateExpense(client, { expense_id: expenseId, job_id: ownJob }, office);
  assertEquals([read().job_id, read().unbooked_job_id], [ownJob, null]);
});

Deno.test("resend: the job already on the receipt keeps its mark as it is, no read", async () => {
  for (const mark of [null, otherJob]) {
    const { client, read, state } = store({ row: { job_id: otherJob, unbooked_job_id: mark } });
    await updateExpense(client, { expense_id: expenseId, job_id: otherJob, vendor_name: "ZZTEST" }, trade);
    assertEquals([read().vendor_name, read().unbooked_job_id, state.bookingReads], ["ZZTEST", mark, 0]);
  }
});

// ---- no job ----

Deno.test("no job: general business saves unmarked without a booking read", async () => {
  for (const job of [null, undefined, ""]) {
    const { client, read, state } = store({ bookings: [] });
    await submitExpense(client, submitBody(job), trade);
    assertEquals([read().job_id, read().unbooked_job_id ?? null, state.bookingReads], [null, null, 0]);
  }
});

Deno.test("no job: a division's stock saves unmarked; a job id beside it is not written or read", async () => {
  const { client, read, state } = store({ bookings: [] });
  await submitExpense(client, { ...submitBody(otherJob), capture_version: 2, stock_division: "fencing" }, trade);
  assertEquals(
    [read().job_id, read().stock_division, read().unbooked_job_id ?? null, state.bookingReads],
    [null, "fencing", null, 0],
  );
  const moved = store({ bookings: [] });
  await updateExpense(moved.client, {
    expense_id: expenseId,
    job_id: otherJob,
    stock_division: "fencing",
    capture_version: 2,
  }, trade);
  assertEquals(
    [moved.read().job_id, moved.read().unbooked_job_id, moved.state.bookingReads],
    [null, null, 0],
  );
});

Deno.test("no job: clearing the job clears the mark without a read", async () => {
  const { client, read, state } = store({ row: { job_id: otherJob, unbooked_job_id: otherJob }, bookings: [] });
  await updateExpense(client, { expense_id: expenseId, job_id: null, business_category: "vehicle" }, trade);
  assertEquals([read().job_id, read().unbooked_job_id, state.bookingReads], [null, null, 0]);
});

// ---- approval of a marked receipt needs a deliberate confirm ----

Deno.test("approve: a marked receipt is refused without confirm, from any caller, and is unchanged", async () => {
  for (const caller of [office, serverKey]) {
    const { client, read, state } = store({ row: { job_id: otherJob, unbooked_job_id: otherJob } });
    const before = read();
    for (const confirm of [undefined, false, "true", 1]) {
      const err = await assertRejects(
        () => approveExpense(client, { expense_id: expenseId, confirm_unbooked: confirm }, caller),
        ExpenseCaptureError,
      );
      const body = err.body as Record<string, unknown>;
      assertEquals([err.status, body.error], [409, "expense_unbooked_confirm_needed"]);
      assertEquals(body.userMessage, body.message);
    }
    assertEquals([read(), state.writes], [before, 0]);
  }
});

Deno.test("approve: a marked receipt approves with confirm_unbooked true, keeping its mark", async () => {
  const { client, read } = store({ row: { job_id: otherJob, unbooked_job_id: otherJob } });
  const res = await approveExpense(client, { expense_id: expenseId, confirm_unbooked: true }, office);
  assertEquals([res.status, read().status, read().unbooked_job_id], ["approved", "approved", otherJob]);
});

Deno.test("approve: an unmarked receipt approves as on main, no confirm needed", async () => {
  const { client, read } = store({ row: { job_id: ownJob } });
  const res = await approveExpense(client, { expense_id: expenseId }, office);
  assertEquals([res.success, res.status, read().status], [true, "approved", "approved"]);
});

Deno.test("approve: query and reject on a marked receipt need no confirm", async () => {
  for (const intent of ["queried", "rejected"]) {
    const { client, read } = store({ row: { job_id: otherJob, unbooked_job_id: otherJob } });
    await approveExpense(client, { expense_id: expenseId, intent }, office);
    assertEquals(read().status, intent);
  }
});

Deno.test("approve: a receipt marked after the office read it is refused for a reload, never approved unseen", async () => {
  const { client, read, state } = store({ row: { job_id: otherJob } });
  state.markBeforeApprove = otherJob;
  const err = await assertRejects(
    () => approveExpense(client, { expense_id: expenseId }, office),
    ApiError,
  );
  assertEquals(err.status, 409);
  assertEquals(read().status, "pending");
  // Retried after the reload, with the confirm, it approves.
  await approveExpense(client, { expense_id: expenseId, confirm_unbooked: true }, office);
  assertEquals(read().status, "approved");
});

Deno.test("approve: a failed approve write is a 503, never a success", async () => {
  const { client, state } = store({ row: { job_id: ownJob } });
  state.failApprove = true;
  const err = await assertRejects(
    () => approveExpense(client, { expense_id: expenseId }, office),
    ApiError,
  );
  assertEquals(err.status, 503);
});

Deno.test("confirm rule and job id reading", () => {
  assertUnbookedApprovalConfirmed("approved", null, undefined);
  assertUnbookedApprovalConfirmed("queried", otherJob, undefined);
  assertUnbookedApprovalConfirmed("approved", otherJob, true);
  assertEquals(
    [null, undefined, "", ownJob, ` ${ownJob}`].map(expenseJobIdOf),
    [null, null, null, ownJob, ` ${ownJob}`],
  );
});
