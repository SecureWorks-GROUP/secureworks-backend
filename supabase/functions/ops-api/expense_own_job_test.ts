import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { submitExpense, updateExpense } from "./index.ts";
import { ExpenseCaptureError } from "./expense_capture_v2.ts";
import {
  assertExpenseJobIsCallers,
  expenseJobIdOf,
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
    ...opts.row,
  };
  const state = {
    failBookings: "" as "" | "error" | "throw" | "shape",
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

async function refused(fn: () => Promise<unknown>, status: number, code: string) {
  const err = await assertRejects(fn, ExpenseCaptureError);
  const body = err.body as Record<string, unknown>;
  assertEquals([err.status, body.error], [status, code]);
  // Words for the app: message and userMessage, never only the code.
  assertEquals(body.userMessage, body.message);
  assertEquals(/^[a-z0-9_]+$/.test(String(body.message)), false);
}

const submitBody = (job_id: unknown) => ({
  job_id,
  no_receipt_reason: "unavailable",
  payment_method: "company_card",
});

Deno.test("submit: a trade is refused a job they are not booked on, and nothing is saved", async () => {
  for (const switchOn of [false, true]) {
    const { client, state } = store({ switchOn });
    await refused(
      () => submitExpense(client, submitBody(otherJob), trade),
      403,
      "expense_job_not_yours",
    );
    assertEquals(state.inserts, 0);
  }
});

Deno.test("submit: a trade on the job saves against it", async () => {
  const { client, read } = store();
  await submitExpense(client, submitBody(ownJob), trade);
  assertEquals(read().job_id, ownJob);
});

Deno.test("submit: no job (general business) saves without a booking read", async () => {
  for (const job of [null, undefined, ""]) {
    const { client, read, state } = store({ bookings: [] });
    await submitExpense(client, submitBody(job), trade);
    assertEquals([read().job_id, state.bookingReads], [null, 0]);
  }
});

Deno.test("submit: a division's stock with no job saves without a booking read", async () => {
  const { client, read, state } = store({ bookings: [] });
  await submitExpense(client, {
    ...submitBody(null),
    capture_version: 2,
    stock_division: "fencing",
  }, trade);
  assertEquals([read().job_id, read().stock_division, state.bookingReads], [
    null,
    "fencing",
    0,
  ]);
});

Deno.test("submit: the office and the server key file against any job unchecked", async () => {
  for (const caller of [office, serverKey]) {
    const { client, read, state } = store({ bookings: [] });
    await submitExpense(client, submitBody(otherJob), caller);
    assertEquals([read().job_id, state.bookingReads], [otherJob, 0]);
  }
});

Deno.test("submit: a division manager needs their own booking too, as on the phone", async () => {
  const { client } = store();
  await refused(
    () => submitExpense(client, submitBody(otherJob), manager),
    403,
    "expense_job_not_yours",
  );
  await submitExpense(client, submitBody(ownJob), manager);
});

Deno.test("update: moving a receipt onto someone else's job is refused and the row is unchanged", async () => {
  for (const switchOn of [false, true]) {
    const { client, read, state } = store({ switchOn });
    const before = read();
    await refused(
      () => updateExpense(client, { expense_id: expenseId, job_id: otherJob }, trade),
      403,
      "expense_job_not_yours",
    );
    assertEquals([read(), state.writes], [before, 0]);
  }
});

Deno.test("update: moving a receipt onto the trade's own job saves", async () => {
  const { client, read } = store();
  const res = await updateExpense(client, {
    expense_id: expenseId,
    job_id: ownJob,
    capture_version: 2,
  }, trade);
  assertEquals([res.success, read().job_id, res.next_step], [
    true,
    ownJob,
    "saved_against_job",
  ]);
});

Deno.test("update: clearing the job (general business) saves without a booking read", async () => {
  const { client, read, state } = store({ row: { job_id: ownJob }, bookings: [] });
  await updateExpense(client, {
    expense_id: expenseId,
    job_id: null,
    business_category: "vehicle",
  }, trade);
  assertEquals([read().job_id, state.bookingReads], [null, 0]);
});

Deno.test("update: the job already on the receipt is not re-checked, so a resend still saves", async () => {
  // e.g. the office put it on that job by hand, or the booking ended later.
  const { client, read, state } = store({ row: { job_id: otherJob } });
  await updateExpense(client, {
    expense_id: expenseId,
    job_id: otherJob,
    vendor_name: "ZZTEST",
  }, trade);
  assertEquals([read().vendor_name, state.bookingReads], ["ZZTEST", 0]);
});

Deno.test("update: a job id sent beside a stock pick is not written, so it is not checked", async () => {
  const { client, read, state } = store({ bookings: [] });
  await updateExpense(client, {
    expense_id: expenseId,
    job_id: otherJob,
    stock_division: "fencing",
    capture_version: 2,
  }, trade);
  assertEquals([read().job_id, read().stock_division, state.bookingReads], [
    null,
    "fencing",
    0,
  ]);
});

Deno.test("update: the office may move a trade's receipt onto any job", async () => {
  const { client, read } = store({ bookings: [] });
  await updateExpense(client, { expense_id: expenseId, job_id: otherJob }, office);
  assertEquals(read().job_id, otherJob);
});

Deno.test("cancelled, watcher and ghost rows are not a booking", async () => {
  for (
    const b of [
      { status: "cancelled", role: "lead_installer" },
      { status: "scheduled", role: "observer" },
      { status: "scheduled", role: "lead_installer", is_ghost: true },
    ]
  ) {
    const { client, state } = store({
      bookings: [{ job_id: otherJob, user_id: tradeId, ...b }],
    });
    await refused(
      () => submitExpense(client, submitBody(otherJob), trade),
      403,
      "expense_job_not_yours",
    );
    assertEquals(state.inserts, 0);
  }
  // A null status (legacy row) is still a booking.
  const { client, read } = store({
    bookings: [{ job_id: otherJob, user_id: tradeId, status: null, role: null }],
  });
  await submitExpense(client, submitBody(otherJob), trade);
  assertEquals(read().job_id, otherJob);
});

Deno.test("a failed booking read refuses with 503 and saves nothing; a retry after it clears saves", async () => {
  for (const fail of ["error", "throw", "shape"] as const) {
    const { client, state, read } = store();
    state.failBookings = fail;
    await refused(
      () => submitExpense(client, submitBody(ownJob), trade),
      503,
      "expense_job_unreadable",
    );
    await refused(
      () => updateExpense(client, { expense_id: expenseId, job_id: ownJob }, trade),
      503,
      "expense_job_unreadable",
    );
    assertEquals([state.inserts, state.writes], [0, 0]);
    state.failBookings = "";
    await updateExpense(client, { expense_id: expenseId, job_id: ownJob }, trade);
    assertEquals(read().job_id, ownJob);
  }
});

Deno.test("a JWT caller with no user id is refused a job", async () => {
  const { client } = store();
  await refused(
    () =>
      assertExpenseJobIsCallers(client, { jobId: ownJob, userId: null, staff: false }),
    403,
    "expense_job_not_yours",
  );
});

Deno.test("job id reading", () => {
  assertEquals(
    [null, undefined, "", ownJob, ` ${ownJob}`].map(expenseJobIdOf),
    [null, null, null, ownJob, ` ${ownJob}`],
  );
});
