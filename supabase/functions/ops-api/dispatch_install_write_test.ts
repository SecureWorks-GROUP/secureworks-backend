// deno-lint-ignore-file no-explicit-any
// Behaviour of set_dispatch_install_confirmed against an in-memory store.
// No network, no live database. The mark's clock is the writer's own
// new Date(), so a test compares the answer with the stored row.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type DispatchInstallActor,
  setDispatchInstallConfirmed,
} from "./dispatch_install_write.ts";
import { DispatchStageWriteError } from "./dispatch_stage_write.ts";
import { makeDispatchMemory } from "./dispatch_memory_client.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000099";
const JOB = "a1000000-0000-4000-8000-000000000010";
const USER = "d1000000-0000-4000-8000-000000000010";
const BOOKING = "a2000000-0000-4000-8000-000000000010";
const DAY = "2026-10-20";
const TODAY = "2026-10-18";
const MARKED_AT = "2026-10-18T05:00:00.000Z";

function job(over: Record<string, unknown> = {}) {
  return {
    id: JOB,
    org_id: ORG,
    job_number: "SWF-900001",
    type: "fencing",
    status: "scheduled",
    site_address: "1 Example St",
    site_suburb: "Exampleton",
    metadata: null,
    council_required: false,
    ...over,
  };
}

function booking(over: Record<string, unknown> = {}) {
  return {
    id: BOOKING,
    job_id: JOB,
    user_id: USER,
    scheduled_date: DAY,
    scheduled_end: null,
    assignment_type: "install",
    status: null,
    is_ghost: false,
    role: "lead_installer",
    is_lead: true,
    confirmation_status: "confirmed",
    ...over,
  };
}

function world(over: {
  job?: Record<string, unknown>;
  bookings?: Array<Record<string, unknown>>;
  state?: Record<string, unknown> | null;
} = {}) {
  return makeDispatchMemory({
    jobs: [job(over.job)],
    users: [{
      id: USER,
      org_id: ORG,
      name: "Office Person",
      email: "office@example.test",
    }],
    job_assignments: over.bookings ?? [booking()],
    job_dispatch_state: over.state ? [over.state] : [],
    job_events: [],
  });
}

const jwt: DispatchInstallActor = {
  mode: "jwt",
  userId: USER,
  email: "office@example.test",
};

function press(
  memory: ReturnType<typeof world>,
  body: Record<string, unknown>,
  actor: DispatchInstallActor = jwt,
) {
  return setDispatchInstallConfirmed(memory, {
    job_id: JOB,
    confirmed: true,
    expected_install_day: DAY,
    expected_confirmed_at: null,
    ...body,
  }, actor, ORG, TODAY);
}

async function refused(run: () => Promise<unknown>): Promise<DispatchStageWriteError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DispatchStageWriteError) return error;
    throw error;
  }
  throw new Error("the write was accepted");
}

function seen(value: object, key: string): unknown {
  return Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

Deno.test("install: a signed-in press marks the booked day and leaves the booking lock alone", async () => {
  const memory = world();
  const answer = await press(memory, {});
  assertEquals(answer.success, true);
  assertEquals(answer.audit_logged, true);
  assertEquals(answer.dispatch_todo, false);
  assertEquals(answer.dispatch_install_open, null);
  assertEquals(answer.dispatch_install?.confirmed?.by, "Office Person");
  assertEquals(answer.dispatch_install?.confirmed?.for_day, DAY);
  assertEquals(answer.dispatch_install?.confirmed_current, true);
  assertEquals(answer.dispatch_install?.calendar_confirmed, true);
  const state = memory.rows("job_dispatch_state")[0];
  assertEquals(answer.dispatch_install?.confirmed?.at, state.install_confirmed_at);
  assertEquals(state.install_confirmed_by, USER);
  assertEquals(state.install_confirmed_by_email, "office@example.test");
  assertEquals(state.install_confirmed_for_day, DAY);
  assertEquals(state.stage ?? null, null);
  assertEquals(state.next_step ?? null, null);
  assertEquals(memory.rows("jobs")[0].status, "scheduled");
  assertEquals(memory.rows("job_assignments")[0].confirmation_status, "confirmed");
  const event = memory.rows("job_events")[0];
  assertEquals(event.event_type, "dispatch_install_confirmed");
  assertEquals(event.user_id, USER);
  assertEquals(event.detail_json.for_day, DAY);
  assertEquals(event.detail_json.operator_email, "office@example.test");
  assertEquals(event.detail_json.previous, null);
  assertEquals(event.detail_json.booking_ids, [BOOKING]);
  assertEquals(event.detail_json.calendar_confirmed, true);

  const again = await press(memory, {
    expected_confirmed_at: state.install_confirmed_at,
  });
  assertEquals(seen(again, "unchanged"), true);
  assertEquals(again.audit_logged, false);
  assertEquals(memory.rows("job_events").length, 1);
  assertEquals(
    memory.rows("job_dispatch_state")[0].install_confirmed_at,
    state.install_confirmed_at,
  );
});

Deno.test("install: clearing the mark, and a mark for a different day, are written", async () => {
  const memory = world({
    state: {
      job_id: JOB,
      org_id: ORG,
      stage: "trade_scheduled",
      install_confirmed_at: MARKED_AT,
      install_confirmed_by: USER,
      install_confirmed_by_email: "office@example.test",
      install_confirmed_for_day: "2026-10-19",
    },
  });
  const replaced = await press(memory, { expected_confirmed_at: MARKED_AT });
  assertEquals(replaced.dispatch_install?.confirmed?.for_day, DAY);
  assertEquals(memory.rows("job_dispatch_state")[0].stage, "trade_scheduled");
  assertEquals(memory.rows("job_events")[0].detail_json.previous, {
    at: MARKED_AT,
    by_email: "office@example.test",
    for_day: "2026-10-19",
  });
  const storedAt = memory.rows("job_dispatch_state")[0].install_confirmed_at;

  const cleared = await press(memory, {
    confirmed: false,
    expected_confirmed_at: storedAt,
  });
  assertEquals(cleared.dispatch_todo, true);
  assertEquals(cleared.dispatch_install_open, "not_confirmed");
  assertEquals(cleared.dispatch_install?.confirmed, null);
  const state = memory.rows("job_dispatch_state")[0];
  assertEquals(state.install_confirmed_at, null);
  assertEquals(state.install_confirmed_by, null);
  assertEquals(state.install_confirmed_by_email, null);
  assertEquals(state.install_confirmed_for_day, null);
  assertEquals(state.stage, "trade_scheduled");
  assertEquals(
    memory.rows("job_events")[1].event_type,
    "dispatch_install_confirmed_cleared",
  );
  assertEquals(memory.rows("job_events")[1].detail_json.was_for_day, DAY);
});

Deno.test("install: a moved booking and a stale confirmation are refused before any write", async () => {
  const moved = world();
  const movedError = await refused(() =>
    press(moved, { expected_install_day: "2026-10-21" })
  );
  assertEquals(movedError.status, 409);
  assertEquals(movedError.body.code, "install_changed");
  assertEquals(movedError.body.dispatch_install_open, "not_confirmed");
  assertEquals(moved.rows("job_dispatch_state"), []);
  assertEquals(moved.rows("job_events"), []);

  const stale = world({
    state: {
      job_id: JOB,
      org_id: ORG,
      install_confirmed_at: MARKED_AT,
      install_confirmed_by: USER,
      install_confirmed_by_email: "office@example.test",
      install_confirmed_for_day: DAY,
    },
  });
  const staleError = await refused(() =>
    press(stale, { expected_confirmed_at: null })
  );
  assertEquals(staleError.status, 409);
  assertEquals(staleError.body.code, "confirmation_changed");
  assertEquals(
    stale.rows("job_dispatch_state")[0].install_confirmed_at,
    MARKED_AT,
  );
  assertEquals(stale.rows("job_events"), []);
});

Deno.test("install: a confirmation that changes between the read and the write is refused", async () => {
  const memory = world({
    state: {
      job_id: JOB,
      org_id: ORG,
      install_confirmed_at: MARKED_AT,
      install_confirmed_by: USER,
      install_confirmed_by_email: "office@example.test",
      install_confirmed_for_day: DAY,
    },
  });
  memory.before("update", "job_dispatch_state", () => {
    const row = memory.rows("job_dispatch_state")[0];
    row.install_confirmed_at = "2026-10-18T09:00:00.000Z";
    row.install_confirmed_by_email = "office@example.test";
  });
  const error = await refused(() =>
    press(memory, { confirmed: false, expected_confirmed_at: MARKED_AT })
  );
  assertEquals(error.status, 409);
  assertEquals(error.body.code, "confirmation_changed");
  assertEquals(
    memory.rows("job_dispatch_state")[0].install_confirmed_at,
    "2026-10-18T09:00:00.000Z",
  );
  assertEquals(memory.rows("job_events"), []);
});

Deno.test("install: a row inserted for the same job during the insert is a confirmation change", async () => {
  const memory = world();
  memory.failNext("insert", "job_dispatch_state", {
    code: "23505",
    message: "job_dispatch_state_pkey",
  });
  const error = await refused(() => press(memory, {}));
  assertEquals(error.status, 409);
  assertEquals(error.body.code, "confirmation_changed");
  assertEquals(memory.rows("job_dispatch_state"), []);
  assertEquals(memory.rows("job_events"), []);
});

Deno.test("install: a failed audit insert keeps the mark and says so", async () => {
  const memory = world();
  memory.failNext("insert", "job_events", {
    code: "XX000",
    message: "audit down",
  });
  const answer = await press(memory, {});
  assertEquals(answer.success, true);
  assertEquals(answer.audit_logged, false);
  assertEquals(answer.dispatch_todo, false);
  assertEquals(
    memory.rows("job_dispatch_state")[0].install_confirmed_for_day,
    DAY,
  );
  assertEquals(memory.rows("job_events"), []);
});

Deno.test("install: the ops key names the person by email and stores no user id", async () => {
  const memory = world();
  const answer = await press(memory, {
    operator_email: "Office@Example.Test",
  }, { mode: "api_key", userId: null, email: null });
  assertEquals(answer.dispatch_install?.confirmed?.by, "office@example.test");
  assertEquals(memory.rows("job_dispatch_state")[0].install_confirmed_by, null);
  assertEquals(
    memory.rows("job_dispatch_state")[0].install_confirmed_by_email,
    "office@example.test",
  );
  assertEquals(memory.rows("job_events")[0].user_id, null);
});

Deno.test("install: a session with no email uses the users row", async () => {
  const memory = world();
  const answer = await press(memory, {}, {
    mode: "jwt",
    userId: USER,
    email: null,
  });
  assertEquals(
    memory.rows("job_dispatch_state")[0].install_confirmed_by_email,
    "office@example.test",
  );
  assertEquals(answer.dispatch_install?.confirmed?.by, "Office Person");
});

Deno.test("install: a cancelled booking is not the install day, and a null status is", async () => {
  const cancelled = world({
    bookings: [booking({ status: "cancelled" })],
  });
  const cancelledError = await refused(() => press(cancelled, {}));
  assertEquals(cancelledError.status, 409);
  assertEquals(cancelledError.body.code, "install_changed");
  assertEquals(cancelled.rows("job_dispatch_state"), []);

  const open = world({ bookings: [booking({ status: null })] });
  const answer = await press(open, {});
  assertEquals(answer.dispatch_install?.confirmed?.for_day, DAY);
});

Deno.test("install: an observer booking is not an install", async () => {
  const memory = world({
    bookings: [booking({ role: "observer", is_ghost: true })],
  });
  const error = await refused(() => press(memory, {}));
  assertEquals(error.status, 409);
  assertEquals(error.body.code, "install_changed");
  assertEquals(memory.rows("job_dispatch_state"), []);
  assertEquals(memory.rows("job_assignments")[0].role, "observer");
});

Deno.test("install: make-safe, another organisation, and a bad body are refused", async () => {
  const makesafe = world({
    job: { type: "makesafe", job_number: "SWMS-900001" },
  });
  const makesafeError = await refused(() => press(makesafe, {}));
  assertEquals(makesafeError.status, 409);
  assertEquals(makesafeError.body.code, "not_dispatch_work");
  assertEquals(makesafe.rows("job_dispatch_state"), []);

  const repair = world({
    job: { type: "makesafe", metadata: { ses_family: "repair" } },
  });
  const repaired = await press(repair, {});
  assertEquals(repaired.success, true);

  const elsewhere = world({ job: { org_id: OTHER } });
  const missing = await refused(() => press(elsewhere, {}));
  assertEquals(missing.status, 404);
  assertEquals(elsewhere.rows("job_dispatch_state"), []);

  const memory = world();
  const unnamed = await refused(() =>
    press(memory, {}, { mode: "api_key", userId: null, email: null })
  );
  assertEquals(unnamed.status, 400);
  assertEquals(unnamed.body.code, "operator_required");

  const badDay = await refused(() =>
    setDispatchInstallConfirmed(memory, {
      job_id: JOB,
      confirmed: true,
      expected_confirmed_at: null,
    }, jwt, ORG, TODAY)
  );
  assertEquals(badDay.status, 400);

  const badFlag = await refused(() =>
    press(memory, { confirmed: "yes" })
  );
  assertEquals(badFlag.status, 400);
  assertEquals(memory.rows("job_dispatch_state"), []);
  assertEquals(memory.rows("job_events"), []);
});
