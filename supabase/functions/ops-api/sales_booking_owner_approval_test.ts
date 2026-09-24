// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  appointmentFromCalendarApproval,
  approvalGateRefusal,
  bookingContentHash,
  bookingHash,
} from "../_shared/booking_approval_gate.ts";
import {
  type BookingApprovalRecord,
  type BookingApprovalStore,
  type BookingObject,
  salesBookingApprovalWriteRoute,
} from "./sales_booking_confirmation.ts";
import {
  applyOwnerBooking,
  type OwnerApprovalDeps,
  OwnerApprovalRefusal,
  ownerBookableDates,
  STRATCO_BOOKING_RULEBOOK,
  systemOfferCensus,
} from "./sales_booking_owner_approval.ts";
import {
  salesBookingRead,
  type SalesBookingReadResponse,
} from "./sales_booking_read.ts";
import {
  SALES_BOOKING_SEND_LINE,
  salesBookingSendAction,
} from "./sales_booking_execute.ts";

// Wed 23 Sep 2026, 10:00 Perth. Friday is 25 Sep.
const NOW = new Date("2026-09-23T02:00:00Z");
const CONTACT = "n9rqiejpF3Sp8OG8MyRN";
const CASE = "opp:michael-opp";
const auth = {
  mode: "jwt" as const,
  email: "marnin@secureworkswa.com.au",
  userId: "706c5258-70dd-483a-b36c-af6864b24498",
};
const envGet = () => undefined;
const FRI = {
  window_start_iso: "2026-09-25T09:00:00+08:00",
  window_end_iso: "2026-09-25T10:30:00+08:00",
  end_iso: "2026-09-25T11:30:00+08:00",
};
const TEXT =
  "Hi Michael, Marnin from SecureWorks here. Friday between 9:00 and 10:30 suit for a look at the fence? Edited by hand.";

async function workspace(
  cases: Array<Record<string, unknown>> = [{}],
  resource = "marnin",
): Promise<SalesBookingReadResponse> {
  const read = await salesBookingRead({
    readOpportunities: () =>
      Promise.resolve({
        opportunities: [],
        stages: {},
        exhausted: true,
        total: 0,
        pages_scanned: 1,
        reason: null,
      }),
    readDiary: () =>
      Promise.resolve({
        read_ok: false,
        reason: "test",
        entries: [],
        malformed_dropped: 0,
        calendar_email: null,
        ghl_user_id: null,
        mapped_by: null,
        scoper_user_id: auth.userId,
      }),
    readThread: () => {
      throw new Error("no thread call expected");
    },
    now: () => NOW,
  }, { resource, week_start: "2026-09-21" });
  read.cases = cases.map((extra) => ({
    id: CASE,
    opportunity_id: "michael-opp",
    contact_id: CONTACT,
    resource_id: resource,
    ...extra,
  })) as SalesBookingReadResponse["cases"];
  return read;
}

const michael = () => ({
  id: CONTACT,
  locationId: "loc",
  firstName: "Michael",
  lastName: "Sample",
  phone: "0412 345 678",
  address1: "12 Fictional Way",
});

function memoryStore(rows: BookingApprovalRecord[] = []): BookingApprovalStore {
  return {
    find: (hashes) =>
      Promise.resolve(rows.filter((r) => hashes.includes(r.binding_hash))),
    insert(record) {
      const existing = rows.find((r) => r.binding_hash === record.binding_hash);
      if (existing) return Promise.resolve(existing);
      rows.push(structuredClone(record));
      return Promise.resolve(record);
    },
  };
}

const calendarDirectory = () => ({
  calendars: [{
    id: "dEQKVKHthsjSYaen1fiE",
    is_active: true,
    assigned_user_ids: ["3S20LGVTjsVYy9vTJ9wM"],
    assignments_returned: true,
  }, {
    id: "other-cal",
    is_active: true,
    assigned_user_ids: ["someone-else"],
    assignments_returned: true,
  }],
  users: [{ id: "3S20LGVTjsVYy9vTJ9wM", email: "marnin@secureworkswa.com.au" }],
});

type Overrides = Partial<OwnerApprovalDeps> & {
  cases?: Array<Record<string, unknown>>;
  resource?: string;
  contact?: BookingObject;
  suburb?: string;
  jobSite?: BookingObject | null;
  ghlEvents?: BookingObject[];
  outlookEvents?: BookingObject[];
  executions?: BookingObject[];
  approvals?: BookingObject[];
  thread?: BookingObject[];
  rows?: BookingApprovalRecord[];
  clock?: () => Date;
};

function deps(o: Overrides = {}) {
  const calls: string[] = [];
  const rows = o.rows ?? [];
  const d: OwnerApprovalDeps = {
    store: memoryStore(rows),
    readWorkspace: () => workspace(o.cases, o.resource),
    readLead: () =>
      Promise.resolve({
        contact: o.contact ?? michael(),
        suburb: o.suburb ?? "Canning Vale",
        job_site: o.jobSite ?? null,
      }),
    readThread: () => Promise.resolve(o.thread ?? []),
    readGhlDirectory: () => Promise.resolve(calendarDirectory()),
    readGhlEvents: (selector) => {
      calls.push(`ghl:${JSON.stringify(selector)}`);
      return Promise.resolve(o.ghlEvents ?? []);
    },
    readGhlBlockedSlots: () => Promise.resolve([]),
    readOutlook: () => {
      calls.push("outlook");
      return Promise.resolve({
        ok: true as const,
        mailbox: "marnin@secureworkswa.com.au",
        events: (o.outlookEvents ?? []) as never,
      });
    },
    readSystemOfferRecords: () =>
      Promise.resolve({
        executions: o.executions ?? [],
        approvals: o.approvals ?? [],
      }),
    envGet,
    now: o.clock ?? (() => NOW),
    ...o,
  };
  return { deps: d, calls, rows };
}

function input(step: "calendar" | "message", extra: BookingObject = {}) {
  return {
    step,
    case_id: CASE,
    contact_id: CONTACT,
    week_start: "2026-09-21",
    ...(step === "message" ? { text: TEXT } : { visit: FRI }),
    ...extra,
  };
}

function call(
  d: OwnerApprovalDeps,
  body: BookingObject,
  a: BookingObject = auth,
): Promise<BookingObject> {
  const { store, readWorkspace, envGet: env, now, ...owner } = d;
  return salesBookingApprovalWriteRoute({
    store,
    auth: a as never,
    body,
    method: "POST",
    readWorkspace,
    envGet: env,
    now,
    owner,
  });
}

/** Preview then approve: the two presses the screen makes. */
async function approve(
  d: OwnerApprovalDeps,
  owner: BookingObject,
  extra: BookingObject = {},
): Promise<BookingObject> {
  const preview = await call(d, { owner_input: owner, dry_run: true });
  assert("dry_run" in preview && preview.dry_run === true);
  return await call(d, {
    owner_input: { ...owner, prepared_at: preview.snapshot.prepared_at },
    decision: "approved",
    content_hash: preview.content_hash,
    ...extra,
  });
}

async function refusal(p: Promise<unknown>, reason: string) {
  const error = await assertRejects(() => p, OwnerApprovalRefusal);
  assertEquals((error as OwnerApprovalRefusal).message, reason);
  return error as OwnerApprovalRefusal;
}

Deno.test("owner message: an edited text is approved, bound to text, contact, 776 and the current phone", async () => {
  const { deps: d, rows } = deps();
  const result = await approve(d, input("message"));
  assert("approval" in result);
  const record = result.approval;
  const snap = record.snapshot;
  assertEquals(snap.source, "owner");
  assertEquals(snap.contact_id, CONTACT);
  assertEquals(snap.content, {
    text: TEXT,
    sender: "+61489267776",
    recipient: "+61412345678",
    variant: "owner",
    offer: null,
  });
  assertEquals(snap.content_hash, await bookingContentHash(snap));
  assertEquals(record.binding_hash, await bookingHash(snap));
  assertEquals(result.approval_id, record.binding_hash);
  assertEquals(record.approved_by_email, "marnin@secureworkswa.com.au");
  assertEquals(
    Date.parse(record.expires_at) - Date.parse(record.approved_at),
    15 * 60_000,
  );
  assertEquals(rows.length, 1);
  assertEquals(result.checks.hand_sent_texts, "not_machine_checked");
  // The executor accepts it exactly like an engine approval.
  assertEquals(
    await approvalGateRefusal(record, "message", NOW, [
      "marnin@secureworkswa.com.au",
    ]),
    null,
  );
  // A retry converges on the same row.
  const again = await call(d, {
    owner_input: { ...input("message"), prepared_at: snap.prepared_at },
    decision: "approved",
    content_hash: snap.content_hash,
  });
  assert("approval" in again);
  assertEquals(again.approval.binding_hash, record.binding_hash);
  assertEquals(rows.length, 1);
});

Deno.test("owner message: the executor dry-runs the owner's exact text from 776", async () => {
  const { deps: d } = deps();
  const result = await approve(d, input("message"));
  assert("approval" in result);
  const record = result.approval;
  const sent = await salesBookingSendAction({
    auth: auth as never,
    body: { approval_id: record.binding_hash },
    method: "POST",
    deps: {
      findApproval: () => Promise.resolve(record),
      appointmentLedger: () => Promise.resolve(null),
      readThread: () => Promise.resolve([]),
      readOutlook: () => Promise.reject(new Error("unused")),
      readContactPhone: () => Promise.resolve("0412 345 678"),
      readOutlookLead: () => Promise.reject(new Error("unused")),
      mirrorToOutlook: () => Promise.reject(new Error("unused")),
      callAppointmentWriter: () => Promise.reject(new Error("unused")),
      callSendSms: () => Promise.reject(new Error("must not send")),
      executions: {
        get: () => Promise.resolve(null),
        claim: () => Promise.reject(new Error("must not claim")),
        settle: () => Promise.reject(new Error("must not settle")),
      },
      envGet,
      now: () => new Date(NOW.getTime() + 60_000),
    },
  });
  assertEquals(sent.status, "dry_run");
  assert(sent.status === "dry_run");
  assertEquals(sent.would_send?.body, {
    contactId: CONTACT,
    message: TEXT,
    fromNumber: "+61489267776",
  });
});

Deno.test("owner message refusals: each rule is named and nothing is written", async () => {
  const cases: Array<[string, Overrides, BookingObject, BookingObject?]> = [
    ["owner_message_text_required", {}, { text: "   " }],
    ["owner_message_text_required", {}, { text: "x".repeat(1601) }],
    ["owner_message_text_has_dash", {}, { text: "Friday — 9:00" }],
    ["contact_phone_missing", { contact: { ...michael(), phone: "" } }, {}],
    ["text_already_in_thread", {
      thread: [{ id: "m1", direction: "outbound", body: TEXT }],
    }, {}],
    ["thread_unreadable", {
      readThread: () => Promise.reject(new Error("down")),
    }, {}],
    ["booking_step_requires_reconciliation", {
      executions: [{
        binding_hash: "a".repeat(64),
        step: "message",
        contact_id: CONTACT,
        state: "unknown",
        claimed_at: NOW.toISOString(),
      }],
    }, {}],
    ["system_offers_unreadable", {
      readSystemOfferRecords: () => Promise.reject(new Error("down")),
    }, {}],
    ["booking_case_identity_ambiguous", { cases: [{}, { id: "opp:two" }] }, {}],
    ["booking_case_identity_ambiguous", {}, { case_id: "opp:someone-else" }],
    ["contact_unreadable", {
      readLead: () => Promise.reject(new Error("down")),
    }, {}],
    ["stratco_profile_required", { resource: "nithin" }, {}],
  ];
  for (const [reason, over, extra] of cases) {
    const { deps: d, rows } = deps(over);
    await refusal(
      call(d, { owner_input: input("message", extra), dry_run: true }),
      reason,
    );
    assertEquals(rows.length, 0, reason);
  }
});

Deno.test("owner approval write: captain JWT only, echoed preview hash, prepared_at and a refusal reason", async () => {
  const { deps: d, rows } = deps();
  const preview = await call(d, {
    owner_input: input("message"),
    dry_run: true,
  });
  assert("dry_run" in preview);
  const good = {
    owner_input: {
      ...input("message"),
      prepared_at: preview.snapshot.prepared_at,
    },
    decision: "approved",
    content_hash: preview.content_hash,
  };
  // A desk API key may preview, never decide.
  await call(d, { owner_input: input("message"), dry_run: true }, {
    mode: "api_key",
  });
  await assertRejects(() => call(d, good, { mode: "api_key" }));
  await assertRejects(() =>
    call(d, good, { ...auth, email: "someone@secureworkswa.com.au" })
  );
  await refusal(
    call(d, good, { ...auth, userId: null }),
    "approval_actor_required",
  );
  await refusal(
    call(d, { ...good, owner_input: input("message") }),
    "owner_prepared_at_required",
  );
  await refusal(
    call(d, { ...good, content_hash: undefined }),
    "owner_content_hash_required",
  );
  await refusal(
    call(d, { ...good, decision: "refused", reason: " " }),
    "refusal_reason_required",
  );
  // The phone moved between the preview and the press.
  const moved = deps({ contact: { ...michael(), phone: "0499 999 999" } });
  const changed = await refusal(
    call(moved.deps, good),
    "owner_snapshot_changed",
  );
  assertEquals(changed.detail?.snapshot.content.recipient, "+61499999999");
  // A preview older than 15 minutes needs a new one.
  const late = deps({ clock: () => new Date(NOW.getTime() + 16 * 60_000) });
  await refusal(call(late.deps, good), "owner_preview_expired");
  assertEquals(rows.length, 0);
  await assertRejects(
    () =>
      call(d, { owner_input: input("message"), snapshot: {}, dry_run: true }),
    Error,
    "owner_input_and_snapshot_are_exclusive",
  );
});

Deno.test("owner calendar: Friday 09:00 passes every rule, GHL, Outlook and offers, and the executor accepts it", async () => {
  const { deps: d, calls, rows } = deps({
    ghlEvents: [{
      id: "ev-1",
      startTime: "2026-09-25T13:00:00+08:00",
      endTime: "2026-09-25T14:00:00+08:00",
      assignedUserId: "3S20LGVTjsVYy9vTJ9wM",
      contactId: "someone-else",
      address: "12 Fictional Way, Canning Vale",
    }],
  });
  const result = await approve(d, input("calendar"));
  assert("approval" in result);
  const snap = result.approval.snapshot;
  assertEquals(snap.content, {
    provider: "ghl",
    calendar_id: "dEQKVKHthsjSYaen1fiE",
    assigned_user_id: "3S20LGVTjsVYy9vTJ9wM",
    start_iso: "2026-09-25T09:00:00+08:00",
    end_iso: "2026-09-25T11:30:00+08:00",
    window_start_iso: "2026-09-25T09:00:00+08:00",
    window_end_iso: "2026-09-25T10:30:00+08:00",
    title: "Scope visit: Michael Sample",
    address: "12 Fictional Way, Canning Vale",
  });
  assertEquals(snap.pack_revision, null);
  assertEquals(rows.length, 1);
  assertEquals(result.checks.ghl.events_that_day, 1);
  assertEquals(result.checks.day_count_with_this_visit, 2);
  assertEquals(result.checks.occupied, {
    start_iso: "2026-09-25T09:00:00+08:00",
    end_iso: "2026-09-25T11:30:00+08:00",
    on_site_minutes: 30,
    travel: "computed_per_neighbour",
    travel_model: "straight-line-v3",
    travel_buffer_minutes: 30,
  });
  // Diary by user, then only the calendar the owner is on.
  assertEquals([...new Set(calls.filter((c) => c.startsWith("ghl:")))], [
    'ghl:{"userId":"3S20LGVTjsVYy9vTJ9wM"}',
    `ghl:${JSON.stringify({
      calendarId: "dEQKVKHthsjSYaen1fiE",
      userId: "3S20LGVTjsVYy9vTJ9wM",
    })}`,
  ]);
  assert(calls.includes("outlook"));
  assertEquals(
    await approvalGateRefusal(result.approval, "calendar", NOW, [
      "marnin@secureworkswa.com.au",
    ]),
    null,
  );
  assertEquals(appointmentFromCalendarApproval(snap), {
    calendarId: "dEQKVKHthsjSYaen1fiE",
    assignedUserId: "3S20LGVTjsVYy9vTJ9wM",
    contactId: CONTACT,
    startTime: "2026-09-25T09:00:00+08:00",
    endTime: "2026-09-25T11:30:00+08:00",
    title: "Scope visit: Michael Sample",
    address: "12 Fictional Way, Canning Vale",
  });
});

Deno.test("owner calendar: the gap a GHL booking needs is travel from where it is", async () => {
  // The visit (Canning Vale) arrives from 09:00. A booking ending 08:30 in
  // Canning Vale needs 5 minutes; the same booking in Two Rocks needs far more.
  const near = deps({
    ghlEvents: [{
      id: "ev-near",
      startTime: "2026-09-25T08:00:00+08:00",
      endTime: "2026-09-25T08:30:00+08:00",
      assignedUserId: "3S20LGVTjsVYy9vTJ9wM",
      contactId: "someone-else",
      address: "12 Fictional Way, Canning Vale",
    }],
  });
  assert(
    "dry_run" in
      await call(near.deps, { owner_input: input("calendar"), dry_run: true }),
  );
  const far = deps({
    ghlEvents: [{
      id: "ev-far",
      startTime: "2026-09-25T08:00:00+08:00",
      endTime: "2026-09-25T08:30:00+08:00",
      assignedUserId: "3S20LGVTjsVYy9vTJ9wM",
      contactId: "someone-else",
      address: "1 Other St, Two Rocks WA 6037",
    }],
  });
  const error = await refusal(
    call(far.deps, { owner_input: input("calendar"), dry_run: true }),
    "ghl_calendar_clash",
  );
  assert(error.detail?.events[0].travel_minutes > 30);
});

Deno.test("owner approval applies the same-suburb travel minimum", async () => {
  const { deps: d, rows } = deps({
    ghlEvents: [{
      id: "ev-same-suburb",
      startTime: "2026-09-25T08:00:00+08:00",
      endTime: "2026-09-25T08:50:00+08:00",
      assignedUserId: "3S20LGVTjsVYy9vTJ9wM",
      contactId: "someone-else",
      address: "1 Other St, Canning Vale",
    }],
  });
  const error = await refusal(
    call(d, { owner_input: input("calendar"), dry_run: true }),
    "ghl_calendar_clash",
  );
  assertEquals(error.detail?.events[0].travel_minutes, 15);
  assertEquals(rows.length, 0);
});

Deno.test("owner approval does not borrow the last suburb for a multi-suburb contact", async () => {
  const { deps: d, rows } = deps({
    cases: [
      { id: CASE, contact_id: CONTACT, suburb: "Canning Vale" },
      {
        id: "neighbor-two-rocks",
        opportunity_id: "opp-two-rocks",
        contact_id: "neighbor",
        suburb: "Two Rocks",
      },
      {
        id: "neighbor-duncraig",
        opportunity_id: "opp-duncraig",
        contact_id: "neighbor",
        suburb: "Duncraig",
      },
    ],
    ghlEvents: [{
      id: "ev-ambiguous-contact",
      startTime: "2026-09-25T12:30:00+08:00",
      endTime: "2026-09-25T13:00:00+08:00",
      assignedUserId: "3S20LGVTjsVYy9vTJ9wM",
      contactId: "neighbor",
    }],
  });
  const error = await refusal(
    call(d, { owner_input: input("calendar"), dry_run: true }),
    "travel_location_unknown",
  );
  assertEquals(error.detail?.source, "ghl");
  assertEquals(rows.length, 0);
});

Deno.test("owner approval refuses an unlocated neighboring GHL event", async () => {
  const { deps: d, rows } = deps({
    ghlEvents: [{
      id: "ev-unknown",
      startTime: "2026-09-25T12:05:00+08:00",
      endTime: "2026-09-25T13:00:00+08:00",
      assignedUserId: "3S20LGVTjsVYy9vTJ9wM",
      contactId: "outside-current-cases",
    }],
  });
  const error = await refusal(
    call(d, { owner_input: input("calendar"), dry_run: true }),
    "travel_location_unknown",
  );
  assertEquals(error.detail?.source, "ghl");
  assertEquals(rows.length, 0);
});

Deno.test("owner calendar: an Outlook event near the visit clashes and nothing is written", async () => {
  const { deps: d, rows } = deps({
    outlookEvents: [{
      id: "o1",
      subject: "Dentist",
      location: "Two Rocks WA 6037",
      start: "2026-09-25T03:45:00Z",
      end: "2026-09-25T04:30:00Z",
      show_as: "busy",
      is_cancelled: false,
    }],
  });
  const error = await refusal(
    call(d, { owner_input: input("calendar"), dry_run: true }),
    "outlook_calendar_clash",
  );
  assertEquals(error.detail?.events[0].subject, "Dentist");
  assertEquals(rows.length, 0);
  // A free or cancelled Outlook event does not clash.
  const free = deps({
    outlookEvents: [{
      id: "o2",
      subject: "Maybe",
      start: "2026-09-25T01:00:00Z",
      end: "2026-09-25T02:00:00Z",
      show_as: "free",
      is_cancelled: false,
    }],
  });
  const ok = await call(free.deps, {
    owner_input: input("calendar"),
    dry_run: true,
  });
  assert("dry_run" in ok);
});

Deno.test("owner calendar rulebook refusals are named", async () => {
  const v = (extra: BookingObject) => ({ visit: { ...FRI, ...extra } });
  const cases: Array<[string, BookingObject]> = [
    ["owner_visit_required", { visit: null }],
    ["owner_visit_times_invalid", v({ window_start_iso: "2026-09-25T09:00" })],
    ["owner_visit_times_invalid", v({ end_iso: "2026-09-25T11:30:00Z" })],
    ["owner_visit_times_invalid", v({ end_iso: "2026-02-30T11:30:00+08:00" })],
    ["owner_visit_not_future", {
      visit: {
        window_start_iso: "2026-09-22T09:00:00+08:00",
        window_end_iso: "2026-09-22T10:30:00+08:00",
        end_iso: "2026-09-22T11:30:00+08:00",
      },
    }],
    ["owner_visit_spans_days", v({ end_iso: "2026-09-26T11:30:00+08:00" })],
    ["owner_visit_day_not_permitted", {
      visit: {
        window_start_iso: "2026-09-24T09:00:00+08:00",
        window_end_iso: "2026-09-24T10:30:00+08:00",
        end_iso: "2026-09-24T11:30:00+08:00",
      },
    }],
    [
      "owner_visit_window_length",
      v({ window_end_iso: "2026-09-25T09:30:00+08:00" }),
    ],
    [
      "owner_visit_window_length",
      v({
        window_end_iso: "2026-09-25T11:00:00+08:00",
        end_iso: "2026-09-25T12:00:00+08:00",
      }),
    ],
    [
      "owner_visit_window_not_inside_visit",
      v({ end_iso: "2026-09-25T10:00:00+08:00" }),
    ],
    ["owner_visit_too_short", v({ end_iso: "2026-09-25T10:45:00+08:00" })],
    ["owner_visit_outside_hours", {
      visit: {
        window_start_iso: "2026-09-25T07:30:00+08:00",
        window_end_iso: "2026-09-25T09:00:00+08:00",
        end_iso: "2026-09-25T10:00:00+08:00",
      },
    }],
    ["owner_visit_outside_hours", {
      visit: {
        window_start_iso: "2026-09-25T14:30:00+08:00",
        window_end_iso: "2026-09-25T16:00:00+08:00",
        end_iso: "2026-09-25T17:00:00+08:00",
      },
    }],
    ["owner_visit_protected_band", {
      visit: {
        window_start_iso: "2026-09-29T10:30:00+08:00",
        window_end_iso: "2026-09-29T11:30:00+08:00",
        end_iso: "2026-09-29T12:40:00+08:00",
      },
    }],
  ];
  for (const [reason, extra] of cases) {
    const { deps: d, rows, calls } = deps();
    await refusal(
      call(d, { owner_input: input("calendar", extra), dry_run: true }),
      reason,
    );
    assertEquals(rows.length, 0, reason);
    assertEquals(calls.length, 0, `${reason} must refuse before any read`);
  }
});

Deno.test("owner calendar: GHL, own-booking, offers, capacity, unknown target, unreadable sources and contact facts refuse", async () => {
  const at = (h: string, e: string, extra: BookingObject = {}) => ({
    id: `ev-${h}`,
    startTime: `2026-09-25T${h}:00+08:00`,
    endTime: `2026-09-25T${e}:00+08:00`,
    assignedUserId: "3S20LGVTjsVYy9vTJ9wM",
    contactId: "other",
    address: "12 Fictional Way, Canning Vale",
    ...extra,
  });
  const offerExecution = (contact: string) => ({
    binding_hash: "b".repeat(64),
    step: "message",
    contact_id: contact,
    state: "sent",
    claimed_at: NOW.toISOString(),
  });
  const offerApproval = {
    binding_hash: "b".repeat(64),
    step: "message",
    snapshot: {
      content: {
        text: "Friday?",
        offer: {
          window_start_iso: "2026-09-25T10:00:00+08:00",
          window_end_iso: "2026-09-25T11:30:00+08:00",
          end_iso: "2026-09-25T12:30:00+08:00",
        },
      },
    },
  };
  const cases: Array<[string, Overrides]> = [
    ["ghl_calendar_clash", {
      ghlEvents: [at("11:45", "12:30", {
        address: "1 Test St, Duncraig WA 6023",
      })],
    }],
    ["contact_already_booked_that_day", {
      ghlEvents: [at("14:00", "15:00", { contactId: CONTACT })],
    }],
    ["system_offer_clash", {
      executions: [offerExecution("another-lead")],
      approvals: [offerApproval],
    }],
    ["daily_capacity_reached", {
      ghlEvents: ["12:30", "13:00", "13:30", "14:00", "14:30", "15:00"].map((
        h,
      ) => at(h, h.replace(/:(\d)0$/, ":$15"))),
    }],
    ["owner_calendar_unknown", {
      readGhlDirectory: () =>
        Promise.resolve({
          ...calendarDirectory(),
          users: [{ id: "someone-else", email: "marnin@secureworkswa.com.au" }],
        }),
    }],
    ["owner_calendar_unreadable", {
      readGhlDirectory: () => Promise.reject(new Error("down")),
    }],
    ["ghl_calendar_unreadable", {
      readGhlEvents: () => Promise.reject(new Error("incomplete")),
    }],
    ["ghl_calendar_unreadable", {
      ghlEvents: [{ id: "bad", startTime: "soon", endTime: "later" }],
    }],
    ["outlook_unreadable", {
      readOutlook: () => Promise.resolve({ ok: false, reason: "http_503" }),
    }],
    ["contact_name_missing", {
      contact: {
        ...michael(),
        firstName: "",
        lastName: "",
        name: "0412345678",
      },
    }],
    ["contact_street_missing", { contact: { ...michael(), address1: "" } }],
    // Live shape on 23 Sep: Michael's GHL address holds the suburb only.
    ["contact_street_missing", {
      contact: { ...michael(), address1: "Bassendean" },
      suburb: "Bassendean",
    }],
    ["contact_suburb_missing", { suburb: "not given" }],
    ["booking_step_requires_reconciliation", {
      executions: [{
        binding_hash: "c".repeat(64),
        step: "calendar",
        contact_id: CONTACT,
        state: "claimed",
        claimed_at: NOW.toISOString(),
      }],
      approvals: [{
        binding_hash: "c".repeat(64),
        snapshot: {
          content: {
            start_iso: FRI.window_start_iso,
            end_iso: FRI.end_iso,
          },
        },
      }],
    }],
  ];
  for (const [reason, over] of cases) {
    const { deps: d, rows } = deps(over);
    await refusal(
      call(d, { owner_input: input("calendar"), dry_run: true }),
      reason,
    );
    assertEquals(rows.length, 0, reason);
  }
  // The same offered slot made to THIS lead is not a clash, and other
  // assignees or cancelled GHL rows never block.
  const own = deps({
    executions: [offerExecution(CONTACT)],
    approvals: [offerApproval],
    ghlEvents: [
      at("10:00", "11:00", { assignedUserId: "someone-else" }),
      at("10:15", "11:00", { appointmentStatus: "cancelled" }),
    ],
  });
  const ok = await call(own.deps, {
    owner_input: input("calendar"),
    dry_run: true,
  });
  assert("dry_run" in ok);
});

Deno.test("an owner text can carry the slot it offers, which then blocks other leads", async () => {
  const { deps: d } = deps();
  const result = await approve(d, input("message", { offer: FRI }));
  assert("approval" in result);
  assertEquals(result.approval.snapshot.content.offer, {
    window_start_iso: FRI.window_start_iso,
    window_end_iso: FRI.window_end_iso,
    end_iso: FRI.end_iso,
  });
  const census = systemOfferCensus(
    [{
      binding_hash: result.approval.binding_hash,
      step: "message",
      contact_id: CONTACT,
      state: "sent",
      claimed_at: NOW.toISOString(),
    }, {
      binding_hash: "e".repeat(64),
      step: "message",
      contact_id: "engine-lead",
      state: "sent",
      claimed_at: NOW.toISOString(),
    }],
    [result.approval, {
      binding_hash: "e".repeat(64),
      snapshot: { content: {} },
    }],
    NOW,
  );
  assertEquals(census.offers.map((o) => [o.contact_id, o.start_iso]), [
    [CONTACT, FRI.window_start_iso],
  ]);
  // An engine text names no slot in its record: reported, never guessed.
  assertEquals(census.unverified_texts.map((t) => t.contact_id), [
    "engine-lead",
  ]);
  // Once that lead is booked, the booking holds the time, not the offer.
  const booked = systemOfferCensus(
    [
      {
        binding_hash: result.approval.binding_hash,
        step: "message",
        contact_id: CONTACT,
        state: "sent",
      },
      {
        binding_hash: "f".repeat(64),
        step: "calendar",
        contact_id: CONTACT,
        state: "booked",
        appointment_id: "appt-1",
      },
    ],
    [result.approval],
    NOW,
  );
  assertEquals(booked.offers, []);
  assertEquals(booked.booked, { [CONTACT]: ["appt-1"] });
  // A text offering a slot that breaks the rulebook is refused.
  await refusal(
    call(d, {
      owner_input: input("message", {
        offer: { ...FRI, end_iso: "2026-09-25T10:45:00+08:00" },
      }),
      dry_run: true,
    }),
    "owner_visit_too_short",
  );
});

Deno.test("read: every lead says whether an engine proposal exists and carries the rulebook and live owner approvals", async () => {
  const { deps: d } = deps();
  const result = await approve(d, input("calendar"));
  assert("approval" in result);
  const read = await workspace([{}, {
    id: "opp:engine",
    opportunity_id: "engine",
    contact_id: "engine-contact",
    booking_read_model: {
      pack_revision: "a".repeat(64),
      proposal: {
        window: {
          start: "2026-09-25T13:00:00+08:00",
          end: "2026-09-25T14:30:00+08:00",
        },
      },
    },
  }]);
  const out = await applyOwnerBooking(
    read,
    () => Promise.resolve([result.approval]),
    new Date(NOW.getTime() + 60_000),
  );
  assertEquals(out.booking_flow?.owner_approval_write, "owner-authored-v1");
  assertEquals(out.booking_flow?.hand_sent_texts, "not_machine_checked");
  // deno-lint-ignore no-explicit-any
  const [owner, engine] = out.cases.map((c) => (c as any).owner_booking);
  assertEquals(owner.engine_proposal, false);
  assertEquals(owner.eligible, true);
  assertEquals(owner.approvals.length, 1);
  assertEquals(owner.approvals[0].approval_id, result.approval.binding_hash);
  assertEquals(owner.rulebook.days, ["Tue", "Fri"]);
  assertEquals(owner.rulebook.bookable_dates.slice(0, 3), [
    "2026-09-25",
    "2026-09-29",
    "2026-10-02",
  ]);
  assertEquals(owner.rulebook.visit_minutes, 30);
  assert(!("on_site_minutes" in owner.rulebook));
  assertEquals(owner.rulebook.travel.version, "straight-line-v3");
  assertEquals(owner.rulebook.calendar.calendar_id, "dEQKVKHthsjSYaen1fiE");
  assertEquals(engine.engine_proposal, true);
  assertEquals(engine.engine_window.start, "2026-09-25T13:00:00+08:00");
  assertEquals(engine.approvals, []);
  // After 15 minutes the approval no longer shows.
  const later = await applyOwnerBooking(
    read,
    () => Promise.resolve([result.approval]),
    new Date(NOW.getTime() + 16 * 60_000),
  );
  // deno-lint-ignore no-explicit-any
  assertEquals((later.cases[0] as any).owner_booking.approvals, []);
  // An unreadable store is never an empty list.
  const broken = await applyOwnerBooking(
    read,
    () => Promise.reject(new Error("down")),
    NOW,
  );
  assertEquals(
    broken.booking_flow?.owner_approval_read_error,
    "owner_approvals_unreadable",
  );
  // deno-lint-ignore no-explicit-any
  assertEquals((broken.cases[0] as any).owner_booking.approvals, null);
  // Patio desk: the owner path is Stratco only.
  const patio = await applyOwnerBooking(
    await workspace([{}], "nithin"),
    () => Promise.resolve([]),
    NOW,
  );
  assertEquals(patio.booking_flow?.owner_approval_write, null);
  // deno-lint-ignore no-explicit-any
  assertEquals((patio.cases[0] as any).owner_booking.eligible, false);
});

Deno.test("bookable dates skip today's passed Friday and non-Stratco days", () => {
  // Friday 25 Sep 16:00 Perth: last arrival (15:30) has passed.
  assertEquals(
    ownerBookableDates(new Date("2026-09-25T08:00:00Z"), 8),
    ["2026-09-29", "2026-10-02"],
  );
  assertEquals(STRATCO_BOOKING_RULEBOOK.sender, "+61489267776");
  assertEquals(STRATCO_BOOKING_RULEBOOK.sender, SALES_BOOKING_SEND_LINE);
});

Deno.test("engine path still works when owner reads are wired, and never touches them", async () => {
  const { deps: d, calls } = deps();
  // No engine model on this case: the engine path refuses exactly as before.
  const { store, readWorkspace, envGet: env, now, ...owner } = d;
  await assertRejects(
    () =>
      salesBookingApprovalWriteRoute({
        store,
        auth,
        body: {
          snapshot: {
            step: "message",
            resource: "marnin",
            profile: "fencing-stratco-marnin",
            week_start: "2026-09-21",
            contact_id: CONTACT,
            case_id: CASE,
          },
          decision: "approved",
        },
        method: "POST",
        readWorkspace,
        envGet: env,
        now,
        owner,
      }),
    Error,
    "booking_case_identity_ambiguous",
  );
  assertEquals(calls, []);
  // Without owner reads wired, an owner body is refused, not guessed.
  await assertRejects(
    () =>
      salesBookingApprovalWriteRoute({
        store,
        auth,
        body: { owner_input: input("message"), dry_run: true },
        method: "POST",
        readWorkspace,
        envGet: env,
        now,
      }),
    Error,
    "owner_approval_unavailable",
  );
});

Deno.test("an owner message offer uses the full lead address for travel", async () => {
  const { deps: d } = deps({
    ghlEvents: [{
      id: "ev-same-address",
      startTime: "2026-09-25T08:00:00+08:00",
      endTime: "2026-09-25T08:50:00+08:00",
      assignedUserId: "3S20LGVTjsVYy9vTJ9wM",
      contactId: "another-lead",
      address: "12 Fictional Way, Canning Vale",
    }],
  });
  const result = await call(d, {
    owner_input: input("message", { offer: FRI }),
    dry_run: true,
  });
  assert("dry_run" in result);
});

Deno.test("owner request shape refusals and a decision already recorded on the same content", async () => {
  const { deps: d, rows } = deps();
  await refusal(
    call(d, { owner_input: { step: "calendar" }, dry_run: true }),
    "invalid_owner_input",
  );
  await refusal(
    call(d, {
      owner_input: input("message", { step: "fence" }),
      dry_run: true,
    }),
    "invalid_owner_input",
  );
  await refusal(
    call(d, {
      owner_input: input("message", { resource: "nithin" }),
      dry_run: true,
    }),
    "stratco_profile_required",
  );
  await refusal(
    call(d, { owner_input: input("message"), dry_run: "yes" }),
    "invalid_dry_run",
  );
  await refusal(
    call(d, {
      owner_input: { ...input("message"), prepared_at: NOW.toISOString() },
      decision: "maybe",
      content_hash: "x",
    }),
    "invalid_independent_approval",
  );
  const { store, readWorkspace, envGet: env, now, ...owner } = d;
  await assertRejects(
    () =>
      salesBookingApprovalWriteRoute({
        store,
        auth,
        body: { owner_input: input("message"), dry_run: true },
        method: "GET",
        readWorkspace,
        envGet: env,
        now,
        owner,
      }),
    Error,
    "sales_booking_approval_write requires POST",
  );
  // Approved, then a refusal of the exact same content: the first stands.
  const approved = await approve(d, input("message"));
  const snap = approved.approval.snapshot;
  await refusal(
    call(d, {
      owner_input: { ...input("message"), prepared_at: snap.prepared_at },
      decision: "refused",
      reason: "changed my mind",
      content_hash: snap.content_hash,
    }),
    "approval_decision_already_recorded",
  );
  assertEquals(rows.length, 1);
  // A stored row for this content that has already lapsed cannot be renewed.
  const lapsed = deps({
    rows: [{ ...approved.approval, expires_at: NOW.toISOString() }],
  });
  await refusal(
    call(lapsed.deps, {
      owner_input: { ...input("message"), prepared_at: snap.prepared_at },
      decision: "approved",
      content_hash: snap.content_hash,
    }),
    "approval_expired_requires_new_proposal",
  );
});

Deno.test("a lead whose GHL contact has no street books against its recorded job site", async () => {
  const { deps: d } = deps({
    contact: { ...michael(), address1: "Bassendean" },
    suburb: "Bassendean",
    jobSite: { address: "7 Example St", suburb: "Bassendean" },
  });
  const preview = await call(d, {
    owner_input: input("calendar"),
    dry_run: true,
  });
  assertEquals(preview.snapshot.content.address, "7 Example St, Bassendean");
  assertEquals(preview.checks.address_street_source, "job_site");
});

Deno.test("owner calendar: Unit, Apt, Shop and comma street prefixes are numbered streets", async () => {
  const streets = [
    ["Unit 5/12 Smith St", "Unit 5/12 Smith St, Canning Vale"],
    ["Apt 3, 20 Smith St", "Apt 3, 20 Smith St, Canning Vale"],
    ["Shop 4/10 Main Rd", "Shop 4/10 Main Rd, Canning Vale"],
    [", 20 Smith St", ", 20 Smith St, Canning Vale"],
  ] as const;
  for (const [address1, expected] of streets) {
    const { deps: d } = deps({ contact: { ...michael(), address1 } });
    const preview = await call(d, {
      owner_input: input("calendar"),
      dry_run: true,
    });
    assertEquals(preview.snapshot.content.address, expected, address1);
    assertEquals(preview.checks.address_street_source, "ghl_contact");
  }
  const fromJob = deps({
    contact: { ...michael(), address1: "Bassendean" },
    suburb: "Bassendean",
    jobSite: { address: "Unit 5/12 Smith St", suburb: "Bassendean" },
  });
  const jobPreview = await call(fromJob.deps, {
    owner_input: input("calendar"),
    dry_run: true,
  });
  assertEquals(
    jobPreview.snapshot.content.address,
    "Unit 5/12 Smith St, Bassendean",
  );
  assertEquals(jobPreview.checks.address_street_source, "job_site");
  const { deps: bare, rows } = deps({
    contact: { ...michael(), address1: "Unit Bassendean" },
    suburb: "Bassendean",
  });
  await refusal(
    call(bare, { owner_input: input("calendar"), dry_run: true }),
    "contact_street_missing",
  );
  assertEquals(rows.length, 0);
});

function otherLead(approvals: BookingApprovalRecord[]) {
  const contactId = "other-lead";
  return deps({
    cases: [{
      id: "opp:other",
      opportunity_id: "other",
      contact_id: contactId,
    }],
    contact: {
      id: contactId,
      locationId: "loc",
      firstName: "Other",
      lastName: "Lead",
      phone: "0413 000 000",
      address1: "3 Other St",
    },
    approvals,
  });
}

Deno.test("a live unexpired owner offer or visit blocks another lead on that slot", async () => {
  const text = deps();
  await approve(text.deps, input("message", { offer: FRI }));
  const clash = await refusal(
    call(otherLead(text.rows).deps, {
      owner_input: {
        step: "calendar",
        case_id: "opp:other",
        contact_id: "other-lead",
        week_start: "2026-09-21",
        visit: FRI,
      },
      dry_run: true,
    }),
    "system_offer_clash",
  );
  assertEquals(clash.detail?.offers, [{
    contact_id: CONTACT,
    start_iso: FRI.window_start_iso,
    end_iso: FRI.end_iso,
    source: "owner_approval",
  }]);

  const visit = deps();
  await approve(visit.deps, input("calendar"));
  await refusal(
    call(otherLead(visit.rows).deps, {
      owner_input: {
        step: "message",
        case_id: "opp:other",
        contact_id: "other-lead",
        week_start: "2026-09-21",
        text: "Hi Other, Friday 9 to 10:30?",
        offer: FRI,
      },
      dry_run: true,
    }),
    "system_offer_clash",
  );

  const own = deps({ approvals: text.rows });
  const sameSlot = await call(own.deps, {
    owner_input: input("calendar"),
    dry_run: true,
  });
  assert("dry_run" in sameSlot);

  const expired = otherLead([{
    ...text.rows[0],
    expires_at: NOW.toISOString(),
  }]);
  const expiredOk = await call(expired.deps, {
    owner_input: {
      step: "calendar",
      case_id: "opp:other",
      contact_id: "other-lead",
      week_start: "2026-09-21",
      visit: FRI,
    },
    dry_run: true,
  });
  assert("dry_run" in expiredOk);

  const refused = otherLead([{ ...text.rows[0], state: "refused" }]);
  const refusedOk = await call(refused.deps, {
    owner_input: {
      step: "calendar",
      case_id: "opp:other",
      contact_id: "other-lead",
      week_start: "2026-09-21",
      visit: FRI,
    },
    dry_run: true,
  });
  assert("dry_run" in refusedOk);

  const noSlot = otherLead([{
    ...text.rows[0],
    snapshot: {
      ...text.rows[0].snapshot,
      content: { ...text.rows[0].snapshot.content, offer: null },
    },
  }]);
  const noSlotOk = await call(noSlot.deps, {
    owner_input: {
      step: "calendar",
      case_id: "opp:other",
      contact_id: "other-lead",
      week_start: "2026-09-21",
      visit: FRI,
    },
    dry_run: true,
  });
  assert("dry_run" in noSlotOk);
});

Deno.test("owner travel uses adjacent intervals across GHL and Outlook", async () => {
  const at = (time: string) => `2026-09-25T${time}:00+08:00`;
  for (const adjacentSource of ["ghl", "outlook"]) {
    const near = [
      { start: at("08:30"), end: at("08:50"), location: "12 Fictional Way, Canning Vale" },
      { start: at("11:40"), end: at("12:00"), location: "12 Fictional Way, Canning Vale" },
    ];
    const remote = [
      { start: at("07:00"), end: at("08:00"), location: null },
      { start: at("13:00"), end: at("14:00"), location: null },
    ];
    const { deps: d } = deps({
      ghlEvents: (adjacentSource === "ghl" ? near : remote).map((e, i) => ({
        id: `ghl-${i}`, startTime: e.start, endTime: e.end, address: e.location,
      })),
      outlookEvents: (adjacentSource === "outlook" ? near : remote).map((e, i) => ({
        id: `outlook-${i}`, ...e, show_as: "busy", is_cancelled: false,
      })),
    });
    assert("dry_run" in await call(d, {
      owner_input: input("calendar"), dry_run: true,
    }));
  }
});

Deno.test("owner overlap checks retain enclosing intervals before checking travel", async () => {
  const { deps: d, rows } = deps({
    ghlEvents: [{
      id: "enclosing",
      startTime: "2026-09-25T07:00:00+08:00",
      endTime: "2026-09-25T12:00:00+08:00",
    }, {
      id: "earlier-unknown",
      startTime: "2026-09-25T06:00:00+08:00",
      endTime: "2026-09-25T06:30:00+08:00",
    }],
    outlookEvents: [{
      id: "near",
      start: "2026-09-25T08:30:00+08:00",
      end: "2026-09-25T08:50:00+08:00",
      location: "12 Fictional Way, Canning Vale",
      show_as: "busy",
    }],
  });
  const error = await refusal(call(d, {
    owner_input: input("calendar"), dry_run: true,
  }), "ghl_calendar_clash");
  assertEquals(error.detail?.events.length, 1);
  assertEquals(error.detail?.events[0].travel_minutes, 0);
  assertEquals(rows.length, 0);
});

Deno.test("an adjacent open offer supplies travel location after an unknown event", async () => {
  const earlier = deps();
  await approve(earlier.deps, input("message", { offer: FRI }));
  const { deps: d } = deps({
    cases: [
      { id: CASE, contact_id: CONTACT, suburb: "Canning Vale" },
      { id: "opp:other", opportunity_id: "other", contact_id: "other-lead", suburb: "Canning Vale" },
    ],
    contact: { ...michael(), id: "other-lead" },
    approvals: earlier.rows,
    ghlEvents: [{
      id: "unknown-early",
      startTime: "2026-09-25T07:00:00+08:00",
      endTime: "2026-09-25T08:00:00+08:00",
    }],
  });
  assert("dry_run" in await call(d, {
    owner_input: input("calendar", {
      case_id: "opp:other", contact_id: "other-lead",
      visit: {
        window_start_iso: "2026-09-25T14:00:00+08:00",
        window_end_iso: "2026-09-25T15:30:00+08:00",
        end_iso: "2026-09-25T16:00:00+08:00",
      },
    }),
    dry_run: true,
  }));
});

Deno.test("owner visits and offers enforce GHL blocked slots and unreadable input", async () => {
  for (const step of ["calendar", "message"] as const) {
    const request = { owner_input: input(step, step === "message" ? { offer: FRI } : {}), dry_run: true };
    for (const blocked of [
      { startTime: FRI.window_start_iso, endTime: FRI.end_iso },
      { startTime: "2026-09-25T08:00:00+08:00", endTime: "2026-09-25T08:30:00+08:00", address: "Two Rocks" },
    ]) {
      const { deps: d, rows } = deps({
        readGhlBlockedSlots: (userId, start, end) => {
          assertEquals(userId, "3S20LGVTjsVYy9vTJ9wM");
          assertEquals(start, "2026-09-25T00:00:00+08:00");
          assertEquals(end, "2026-09-26T00:00:00+08:00");
          return Promise.resolve([{ id: "block", ...blocked }]);
        },
      });
      await refusal(call(d, request), "ghl_calendar_clash");
      assertEquals(rows.length, 0);
    }
    for (const reader of [
      () => Promise.reject(new Error("unavailable")),
      () => Promise.resolve([{ startTime: "bad", endTime: "bad" }]),
    ]) {
      const { deps: d, rows } = deps({ readGhlBlockedSlots: reader });
      await refusal(call(d, request), "ghl_blocked_slots_unreadable");
      assertEquals(rows.length, 0);
    }
  }
});
