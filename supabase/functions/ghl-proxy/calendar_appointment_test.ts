// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AppointmentDeps,
  type AppointmentInput,
  type AppointmentLedger,
  type AppointmentRequest,
  createCalendarAppointmentAction,
} from "./calendar_appointment.ts";
import {
  bookingContentHash,
  bookingHash,
  type ExecutableApprovalRecord,
} from "../_shared/booking_approval_gate.ts";
import {
  canCreateCalendarAppointment,
  rejectSharedKeyForBrowserAction,
} from "./hardening_helpers.ts";

const NOW = Date.parse("2026-09-22T00:00:00+08:00");
type Row = Record<string, unknown>;
const CAPTAIN = "marnin@secureworkswa.com.au";

/** Live captain approvals by binding hash, shared by every fixture. */
const APPROVALS = new Map<string, ExecutableApprovalRecord>();
/** The captain's approval of exactly these appointment fields. The returned
 * input carries the approval's binding hash as its idempotency key, the way
 * the ops-api executor calls the writer. */
async function approved(
  fields: Omit<AppointmentInput, "idempotencyKey">,
  overrides: Partial<ExecutableApprovalRecord> = {},
): Promise<AppointmentInput> {
  const snapshot: Row = {
    schema: "scope-booking-approval.v1",
    step: "calendar",
    case_id: "opp:sample",
    contact_id: fields.contactId,
    resource: "marnin",
    scoper_user_id: "scoper",
    week_start: "2026-09-21",
    id: "opp:sample",
    profile: "fencing-stratco-marnin",
    pack_revision: "a".repeat(64),
    content_hash: null,
    content: {
      provider: "ghl",
      calendar_id: fields.calendarId,
      assigned_user_id: fields.assignedUserId,
      start_iso: fields.startTime,
      end_iso: fields.endTime,
      window_start_iso: fields.startTime,
      window_end_iso: fields.startTime,
      title: fields.title,
      address: fields.address,
    },
  };
  snapshot.content_hash = await bookingContentHash(snapshot);
  const key = await bookingHash(snapshot);
  APPROVALS.set(key, {
    binding_hash: key,
    step: "calendar",
    state: "approved",
    snapshot,
    approved_by_email: CAPTAIN,
    approved_at: new Date(NOW - 60_000).toISOString(),
    expires_at: new Date(NOW + 14 * 60_000).toISOString(),
    ...overrides,
  });
  return { ...fields, idempotencyKey: key };
}
const BASE = {
  calendarId: "cal1",
  assignedUserId: "user1",
  contactId: "contact1",
  startTime: "2026-09-23T10:00:00+08:00",
  endTime: "2026-09-23T11:00:00+08:00",
  title: "Site visit",
  address: "1 Test Street, Perth",
};
const INPUT: AppointmentInput = await approved(BASE);
const INPUT_CAL2: AppointmentInput = await approved({
  ...BASE,
  calendarId: "cal2",
});

function fixture() {
  const records = new Map<
    string,
    AppointmentRequest & {
      input: AppointmentInput;
      token: string;
      leased: boolean;
    }
  >();
  const events = new Map<string, Row[]>();
  const posts: Row[] = [], gets: string[] = [];
  let writes = 0;
  let failComplete = false;
  const ledger: AppointmentLedger = {
    get(_loc, key) {
      return Promise.resolve(records.get(key) ?? null);
    },
    reserve({ input, fingerprint, token }) {
      writes++;
      const old = records.get(input.idempotencyKey);
      if (old && old.fingerprint !== fingerprint) {
        return Promise.resolve({ decision: "conflict" });
      }
      if (old?.state === "sending" || old?.state === "complete") {
        return Promise.resolve({ decision: "existing", request: old });
      }
      if (old?.leased) return Promise.resolve({ decision: "busy" });
      if (
        [...records.values()].some((row) =>
          row.input.idempotencyKey !== input.idempotencyKey &&
          row.input.assignedUserId === input.assignedUserId &&
          (row.leased || row.state !== "reserved") &&
          Date.parse(row.input.startTime) < Date.parse(input.endTime) &&
          Date.parse(row.input.endTime) > Date.parse(input.startTime)
        )
      ) return Promise.resolve({ decision: "overlap" });
      records.set(input.idempotencyKey, {
        input,
        fingerprint,
        token,
        leased: true,
        state: "reserved",
        result: null,
      });
      return Promise.resolve({ decision: "acquired" });
    },
    markSending(_loc, key, token) {
      writes++;
      const row = records.get(key)!;
      if (row.token !== token || row.state !== "reserved" || !row.leased) {
        return Promise.resolve(false);
      }
      row.state = "sending";
      return Promise.resolve(true);
    },
    release(_loc, key, token) {
      writes++;
      const row = records.get(key)!;
      if (row.token === token && row.state === "reserved") row.leased = false;
      return Promise.resolve();
    },
    complete(_loc, key, _fingerprint, result) {
      writes++;
      if (failComplete) {
        failComplete = false;
        throw new Error("db unavailable private detail");
      }
      Object.assign(records.get(key)!, { state: "complete", result });
      return Promise.resolve();
    },
  };
  const deps: AppointmentDeps = {
    locationId: "loc1",
    enabled: true,
    ledger,
    approvals: {
      find: (key) => Promise.resolve(APPROVALS.get(key) ?? null),
    },
    captainEmails: [CAPTAIN],
    now: () => NOW,
    ghlGet(path) {
      gets.push(path);
      if (path === "/contacts/contact1") {
        return Promise.resolve({
          contact: { id: "contact1", locationId: "loc1" },
        });
      }
      if (path.startsWith("/users/")) {
        return Promise.resolve({ users: [{ id: "user1" }] });
      }
      if (path.startsWith("/calendars/?")) {
        return Promise.resolve({
          calendars: ["cal1", "cal2"].map((id) => ({
            id,
            isActive: true,
            teamMembers: [{ userId: "user1" }],
          })),
        });
      }
      if (path.startsWith("/calendars/events?")) {
        const params = new URL(`https://fake.invalid${path}`).searchParams;
        return Promise.resolve({
          events: events.get(params.get("calendarId") || "user") ?? [],
        });
      }
      throw new Error("unexpected fake path");
    },
    ghlPost(_path, body) {
      posts.push(body);
      const event = { ...body, id: "appt1" };
      events.set("cal1", [event]);
      return Promise.resolve(event);
    },
  };
  return {
    deps,
    records,
    events,
    posts,
    gets,
    writes: () => writes,
    failComplete: () => {
      failComplete = true;
    },
    call: (body: unknown = INPUT, method = "POST") =>
      createCalendarAppointmentAction({ method, body, deps }),
  };
}
function busyEvent(extra: Row = {}): Row {
  return {
    id: "other",
    assignedUserId: "user1",
    startTime: INPUT.startTime,
    endTime: INPUT.endTime,
    appointmentStatus: "confirmed",
    ...extra,
  };
}

Deno.test("appointment happy path verifies ids, reads separate calendars, suppresses notifications and enforces provider limits", async () => {
  const f = fixture();
  const result = await f.call();
  assertEquals(result, {
    status: 200,
    body: {
      ok: true,
      appointmentId: "appt1",
      calendarId: "cal1",
      startTime: INPUT.startTime,
      endTime: INPUT.endTime,
      reused: false,
    },
  });
  assertEquals(f.posts.length, 1);
  assertEquals(f.posts[0].toNotify, false);
  assertEquals(f.posts[0].ignoreDateRange, false);
  assertEquals(f.posts[0].ignoreFreeSlotValidation, false);
  assertEquals(f.posts[0].locationId, "loc1");
  assertEquals(f.posts[0].idempotencyKey, undefined);
  assertStringIncludes(String(f.posts[0].title), "Site visit [SW booking:");
  assertEquals(
    f.gets.filter((path) => path.startsWith("/calendars/events?")).length,
    3,
  );
  assertEquals(f.gets.some((path) => path.includes("calendarId=cal2")), true);
  assertEquals(f.records.get(INPUT.idempotencyKey)?.state, "complete");
});
Deno.test("same key retry returns first appointment even after its start and makes no provider calls", async () => {
  const f = fixture();
  await f.call();
  const reads = f.gets.length;
  f.deps.now = () => Date.parse("2027-01-01T00:00:00Z");
  const retry = await f.call();
  assertEquals(retry.body.appointmentId, "appt1");
  assertEquals(retry.body.reused, true);
  assertEquals(f.posts.length, 1);
  assertEquals(f.gets.length, reads);
  const conflict = await f.call({ ...INPUT, title: "Different visit" });
  assertEquals(conflict.body.reason, "idempotency_key_reused");
});
Deno.test("overlap on a different calendar refuses the same person and issues no POST", async () => {
  const f = fixture();
  f.events.set("cal2", [busyEvent()]);
  assertEquals((await f.call()).body.code, "overlap");
  assertEquals(f.posts, []);
  // Definite pre-write refusal releases the reservation, so the same key resumes.
  f.events.clear();
  assertEquals((await f.call()).body.ok, true);
});
Deno.test("adjacent, cancelled and other-assignee events do not overlap", async () => {
  const f = fixture();
  f.events.set("cal2", [
    busyEvent({
      endTime: INPUT.startTime,
      startTime: "2026-09-23T09:00:00+08:00",
    }),
    busyEvent({ appointmentStatus: "cancelled" }),
    busyEvent({ assignedUserId: "user2" }),
  ]);
  assertEquals((await f.call()).body.ok, true);
});
Deno.test("failed, incomplete and malformed calendar reads all refuse without leaking provider text", async () => {
  for (
    const response of [
      null,
      {},
      { events: null },
      { events: [null] },
      { events: [], hasMore: true },
      { events: [{ id: "no-times" }] },
      { events: [busyEvent({ assignedUserId: {} })] },
    ]
  ) {
    const f = fixture(), get = f.deps.ghlGet;
    f.deps.ghlGet = (path) => {
      if (!path.startsWith("/calendars/events?")) return get(path);
      if (response === null) throw new Error("GHL 503: customer secret");
      return Promise.resolve(response);
    };
    const result = await f.call();
    assertEquals(result.body, { ok: false, code: "read_failed" });
    assertEquals(f.posts.length, 0);
  }
});
Deno.test("flag off returns exact would-write payload, performs no ledger IO or provider POST", async () => {
  const f = fixture();
  f.deps.enabled = false;
  f.deps.ledger.get = () => {
    throw new Error("dry run must not touch ledger");
  };
  const result = await f.call();
  assertEquals(result.body.code, "flag_off");
  assertEquals(result.body.dryRun, true);
  assertEquals(f.posts, []);
  assertEquals(f.writes(), 0);
  const preview = result.body.wouldWrite as { body: Row };
  f.deps.ledger.get = () => Promise.resolve(null);
  f.deps.enabled = true;
  await f.call();
  assertEquals(preview.body, f.posts[0]);
});
Deno.test("past, reversed, offset-free and impossible windows refuse before provider reads", async () => {
  for (
    const window of [
      { startTime: "2020-01-01T10:00:00+08:00" },
      { endTime: INPUT.startTime },
      { startTime: "2026-09-23T10:00:00" },
      { startTime: "2026-02-30T10:00:00+08:00" },
      { startTime: "2026-09-23T24:00:00Z" },
    ]
  ) {
    const f = fixture();
    assertEquals(
      (await f.call({ ...INPUT, ...window })).body.code,
      "invalid_window",
    );
    assertEquals(f.gets.length, 0);
    assertEquals(f.writes(), 0);
  }
});
Deno.test("unknown and wrong-location contacts refuse; failed contact reads stay unread", async () => {
  for (const mode of ["404", "wrong-location", "wrong-id", "unread"]) {
    const f = fixture();
    f.deps.ghlGet = () => {
      if (mode === "404") throw new Error("GHL 404: private detail");
      if (mode === "unread") throw new Error("GHL 500: private detail");
      return Promise.resolve({
        contact: {
          id: mode === "wrong-id" ? "other" : "contact1",
          locationId: mode === "wrong-location" ? "other" : "loc1",
        },
      });
    };
    assertEquals(
      (await f.call()).body.code,
      mode === "unread" ? "read_failed" : "contact_not_found",
    );
    assertEquals(f.posts.length, 0);
    assertEquals(f.writes(), 0);
  }
});
Deno.test("lost POST response recovers exact stamped appointment without another POST", async () => {
  const f = fixture(), post = f.deps.ghlPost;
  f.deps.ghlPost = async (path, body) => {
    await post(path, body);
    throw new Error("timeout");
  };
  assertEquals((await f.call()).body.code, "provider_error");
  assertEquals(f.records.get(INPUT.idempotencyKey)?.state, "sending");
  assertEquals((await f.call()).body.appointmentId, "appt1");
  assertEquals(f.posts.length, 1);
});
Deno.test("failed ledger completion resumes from provider result without repeating POST", async () => {
  const f = fixture();
  f.failComplete();
  assertEquals((await f.call()).body.code, "provider_error");
  assertEquals((await f.call()).body.appointmentId, "appt1");
  assertEquals(f.posts.length, 1);
});
Deno.test("uncertain POST never retries create from an empty read or a fuzzy matching appointment", async () => {
  const f = fixture();
  let attempts = 0;
  f.deps.ghlPost = () => {
    attempts++;
    throw new Error("GHL 502: private upstream text");
  };
  assertEquals((await f.call()).body.code, "provider_error");
  assertEquals((await f.call()).body.reason, "outcome_unknown");
  f.events.set("cal1", [busyEvent({ ...INPUT, title: INPUT.title })]);
  assertEquals((await f.call()).body.reason, "outcome_unknown");
  assertEquals(attempts, 1);
  assertEquals(
    (await f.call(INPUT_CAL2))
      .body.code,
    "overlap",
  );
});
Deno.test("parallel requests for different calendars of the same person only POST once", async () => {
  const f = fixture();
  const results = await Promise.all([
    f.call(),
    f.call(INPUT_CAL2),
  ]);
  assertEquals(results.filter((r) => r.body.ok).length, 1);
  assertEquals(results.filter((r) => r.body.code === "overlap").length, 1);
  assertEquals(f.posts.length, 1);
});
Deno.test("same-key concurrency and expired lease cannot issue a second POST", async () => {
  const f = fixture();
  const results = await Promise.all([f.call(), f.call()]);
  for (const result of results) {
    if (result.body.ok) assertEquals(result.body.appointmentId, "appt1");
    else assertEquals(result.body.reason, "request_in_progress");
  }
  assertEquals(f.posts.length, 1);
  const expired = fixture();
  expired.deps.ledger.markSending = () => Promise.resolve(false);
  assertEquals((await expired.call()).body.reason, "reservation_lost");
  assertEquals(expired.posts.length, 0);
});
Deno.test("no request can override notification, location, or method controls", async () => {
  for (
    const extra of [
      { toNotify: true },
      { ignoreFreeSlotValidation: true },
      { locationId: "other" },
      { contactId: "" },
      { idempotencyKey: "" },
      { title: "" },
    ]
  ) {
    const f = fixture();
    assertEquals(
      (await f.call({ ...INPUT, ...extra })).body.code,
      "invalid_request",
    );
    assertEquals(f.gets.length, 0);
  }
  const f = fixture();
  assertEquals((await f.call(INPUT, "GET")).status, 405);
});
Deno.test("appointment auth accepts service role and same-org staff, refuses browser shared key and unrelated users", () => {
  assertEquals(
    canCreateCalendarAppointment("service_role", null, null, "org1"),
    true,
  );
  assertEquals(
    canCreateCalendarAppointment("user_jwt", "sales", "org1", "org1"),
    true,
  );
  assertEquals(
    canCreateCalendarAppointment("user_jwt", "admin", "org2", "org1"),
    false,
  );
  assertEquals(
    canCreateCalendarAppointment("user_jwt", "trade", "org1", "org1"),
    false,
  );
  assertEquals(
    canCreateCalendarAppointment("shared_key", "admin", "org1", "org1"),
    false,
  );
  assertEquals(
    rejectSharedKeyForBrowserAction(
      "create_calendar_appointment",
      "POST",
      "shared_key",
      true,
    )?.ok,
    false,
  );
});

Deno.test("incomplete contact, directory, roster and assignment evidence refuses without reserving", async () => {
  for (const target of ["contact", "calendars", "users", "assignments"]) {
    const f = fixture(), get = f.deps.ghlGet;
    f.deps.ghlGet = (path) => {
      if (target === "contact" && path.startsWith("/contacts/")) {
        return Promise.resolve({});
      }
      if (target === "calendars" && path.startsWith("/calendars/?")) {
        return Promise.resolve({});
      }
      if (target === "users" && path.startsWith("/users/")) {
        throw new Error("private provider failure");
      }
      if (target === "assignments" && path.startsWith("/calendars/?")) {
        return Promise.resolve({ calendars: [{ id: "cal1", isActive: true }] });
      }
      return get(path);
    };
    assertEquals((await f.call()).body.code, "read_failed");
    assertEquals(f.writes(), 0);
    assertEquals(f.posts.length, 0);
  }
});
Deno.test("unknown-assignee event conservatively blocks and wrong roster/calendar ids refuse", async () => {
  const f = fixture();
  f.events.set("cal2", [busyEvent({ assignedUserId: null })]);
  assertEquals((await f.call()).body.code, "overlap");
  for (
    const fields of [{ assignedUserId: "unknown" }, { calendarId: "unknown" }]
  ) {
    const g = fixture();
    assertEquals(
      (await g.call({ ...INPUT, ...fields })).body.reason,
      "calendar_user_not_available",
    );
    assertEquals(g.writes(), 0);
  }
});
Deno.test("ledger failure before a POST fails closed and a failed recovery read cannot resend", async () => {
  const f = fixture();
  f.deps.ledger.get = () => {
    throw new Error("database private detail");
  };
  assertEquals((await f.call()).body, { ok: false, code: "provider_error" });
  assertEquals(f.posts.length, 0);
  const g = fixture();
  g.failComplete();
  await g.call();
  g.deps.ghlGet = () => {
    throw new Error("GHL 500: private detail");
  };
  assertEquals((await g.call()).body, { ok: false, code: "read_failed" });
  assertEquals(g.posts.length, 1);
});

Deno.test("writer refuses a real write with no live captain approval, before reserving or posting", async () => {
  const cases: Array<[AppointmentInput, string]> = [
    [{ ...INPUT, idempotencyKey: "booking-1" }, "approval_not_found"],
    [{ ...INPUT, idempotencyKey: "f".repeat(64) }, "approval_not_found"],
    [
      await approved({ ...BASE, title: "Expired" }, {
        approved_at: new Date(NOW - 16 * 60_000).toISOString(),
        expires_at: new Date(NOW - 60_000).toISOString(),
      }),
      "approval_expired",
    ],
    [
      await approved({ ...BASE, title: "Not captain" }, {
        approved_by_email: "someone@example.test",
      }),
      "approval_not_by_captain",
    ],
    [
      await approved({ ...BASE, title: "Refused" }, { state: "refused" }),
      "approval_not_approved",
    ],
    // Same approval key, different appointment fields.
    [{ ...INPUT, address: "2 Other Street, Perth" }, "content_hash_mismatch"],
  ];
  const tampered = await approved({ ...BASE, title: "Tampered" });
  const row = APPROVALS.get(tampered.idempotencyKey)!;
  APPROVALS.set(tampered.idempotencyKey, {
    ...row,
    snapshot: {
      ...(row.snapshot as Row),
      content: { ...(row.snapshot as Row).content as Row, title: "Tampered" },
      case_id: "opp:other",
    },
  });
  cases.push([tampered, "content_hash_mismatch"]);
  for (const [input, reason] of cases) {
    const f = fixture();
    const result = await f.call(input);
    assertEquals(result.status, 409);
    assertEquals(result.body, { ok: false, code: "approval_required", reason });
    assertEquals(f.posts.length, 0);
    assertEquals(f.records.size, 0);
  }
  const unreadable = fixture();
  unreadable.deps.approvals.find = () => {
    throw new Error("db down private detail");
  };
  assertEquals(
    (await unreadable.call()).body.reason,
    "approval_unreadable",
  );
  assertEquals(unreadable.posts.length, 0);
});
Deno.test("dryRun:true previews even with writes enabled; no approval is informational only there", async () => {
  const f = fixture();
  const preview = await f.call({ ...INPUT, dryRun: true });
  assertEquals(preview.body.code, "dry_run");
  assertEquals(preview.body.dryRun, true);
  assertEquals(preview.body.approval, { state: "live", reason: null });
  assertEquals(f.posts.length, 0);
  assertEquals(f.writes(), 0);
  const g = fixture();
  g.deps.enabled = false;
  const unapproved = await g.call({ ...INPUT, idempotencyKey: "booking-1" });
  assertEquals(unapproved.body.code, "flag_off");
  assertEquals(unapproved.body.approval, {
    state: "missing",
    reason: "approval_not_found",
  });
  for (const dryRun of [false, "true", 1]) {
    assertEquals(
      (await fixture().call({ ...INPUT, dryRun })).body.code,
      "invalid_request",
    );
  }
});
