// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyBookingApprovals,
  applyBookingConfirmationModels,
  BOOKING_APPROVAL_TTL_MS,
  type BookingApprovalRecord,
  bookingApprovalSnapshot,
  type BookingApprovalStore,
  bookingContentHash,
  bookingHash,
  type BookingObject,
  salesBookingApprovalWriteAction,
  selectBookingModels,
} from "./sales_booking_confirmation.ts";
import {
  salesBookingRead,
  type SalesBookingReadResponse,
} from "./sales_booking_read.ts";
import {
  applySalesBookingPackOverlay,
  salesBookingPackPublishAction,
} from "./sales_booking_pack.ts";

const NOW = new Date("2026-09-22T00:00:00Z");
const auth = {
  mode: "jwt" as const,
  email: "marnin@secureworkswa.com.au",
  userId: "706c5258-70dd-483a-b36c-af6864b24498",
};
const envGet = () => undefined;
const row = {
  id: "opp:sample",
  opportunity_id: "sample",
  contact_id: "contact-1",
  resource_id: "marnin",
};
const model = (): BookingObject => ({
  schema: "scope-booking-lead.v1",
  id: "opp:sample",
  contact_id: "contact-1",
  profile: "fencing-stratco-marnin",
  pack_revision: "a".repeat(64),
  expires_at: "2026-09-22T09:00:00+08:00",
  proposal: {
    window: {
      start: "2026-09-25T09:00:00+08:00",
      end: "2026-09-25T10:30:00+08:00",
    },
    requires_scoper_confirmation: true,
  },
  evidence_quotes: [{ message_id: "source-1", quote: "Friday is good" }],
  validation: {
    ok: true,
    checked_at: NOW.toISOString(),
    requires_fresh_read: true,
    reasons: [],
    checks: ["calendar", "protected_band", "hours", "travel", "daily_capacity"]
      .map((label) => ({ label, passed: true })),
  },
  calendar_write: {
    state: "awaiting_approval",
    approval: null,
    receipt: null,
    preview: {
      provider: "ghl",
      calendar_id: "owner-calendar",
      assigned_user_id: "owner-user",
      start: "2026-09-25T09:00:00+08:00",
      end: "2026-09-25T11:30:00+08:00",
      title: "Scope visit: Sample",
      site_address: "Fictional site",
      content_hash: null,
    },
  },
  message: {
    state: "awaiting_approval",
    approval: null,
    receipt: null,
    template_text: "Hi Sample, Friday 09:00 to 10:30.\nSecureWorks Group ",
    ai_proposed_text: null,
    routing: {
      from_number: "+61400000001",
      to_number: "+61400000002",
      message_sha256: null,
    },
  },
});
function bundle(m = model()) {
  const file = "b".repeat(64) + ".json";
  return {
    index: {
      schema: "scope-booking-lead.v1",
      leads: [{ id: m.id, contact_id: m.contact_id, file }],
    },
    files: { [file]: m, stale: { contact_id: "other" } },
  };
}
async function fixture() {
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
  }, { resource: "marnin", week_start: "2026-09-21" });
  read.cases = [row as SalesBookingReadResponse["cases"][number]];
  const response = applyBookingConfirmationModels(read, bundle());
  const m = response.cases[0].booking_read_model!;
  m.calendar_write.preview.content_hash = await bookingContentHash(
    bookingApprovalSnapshot(response, response.cases[0], "calendar"),
  );
  m.message.routing.message_sha256 = await bookingContentHash(
    bookingApprovalSnapshot(response, response.cases[0], "message"),
  );
  // Synthetic approval fixture; projection tests below exercise published evidence.
  response.booking_flow = {
    ...response.booking_flow,
    calendar_read: { state: "read", provider: "ghl" },
    commitments: [],
  };
  return response;
}
function memoryStore() {
  const records = new Map<string, BookingApprovalRecord>();
  const store: BookingApprovalStore = {
    find: (hashes) =>
      Promise.resolve(
        hashes.flatMap((hash) => records.has(hash) ? [records.get(hash)!] : []),
      ),
    insert: (record) => {
      if (!records.has(record.binding_hash)) {
        records.set(record.binding_hash, structuredClone(record));
      }
      return Promise.resolve(records.get(record.binding_hash)!);
    },
  };
  return { store, records };
}
function request(
  response: SalesBookingReadResponse,
  store: BookingApprovalStore,
  step: "calendar" | "message" = "calendar",
) {
  return {
    store,
    auth,
    method: "POST",
    body: {
      snapshot: bookingApprovalSnapshot(response, response.cases[0], step),
      decision: "approved",
      reason: null,
    } as BookingObject,
    readWorkspace: () => Promise.resolve(response),
    now: () => NOW,
    envGet,
  };
}

Deno.test("read: absent producer fields are null with reasons; diary success cannot invent ledger completeness", async () => {
  const f = await fixture();
  const result = applyBookingConfirmationModels(f, null);
  assertEquals(result.booking_flow?.approval_write, "separate-v1");
  assertEquals(result.booking_flow?.calendar_read.state, "could_not_read");
  assertEquals(result.booking_flow?.commitments, null);
  assertEquals(result.resource.id, "marnin");
  const m = result.cases[0].booking_read_model!;
  for (
    const key of ["proposal", "pack_revision", "evidence_quotes", "expires_at"]
  ) assertEquals(m[key], null);
  assertEquals(m.message.template_text, null);
  assertEquals(m.message.ai_proposed_text, null);
  assertEquals(m.validation.checks, null);
  assert(m.unavailable_fields.evidence_quotes);
  const { store, records } = memoryStore();
  const held = applyBookingConfirmationModels(
    f,
    bundle(f.cases[0].booking_read_model),
  );
  await assertRejects(
    () => salesBookingApprovalWriteAction(request(held, store)),
    Error,
    "current_person_availability_unavailable",
  );
  assertEquals(records.size, 0);
});

Deno.test("manifest: selected files only, duplicate contact/mixed revision/cross-case refuse", async () => {
  assertEquals(selectBookingModels(bundle()).length, 1);
  const b = bundle();
  b.index.leads.push({ ...b.index.leads[0] });
  assertThrows(() => selectBookingModels(b), Error, "ambiguous");
  const f = await fixture();
  const m = model();
  m.contact_id = "someone-else";
  assertEquals(
    applyBookingConfirmationModels(f, bundle(m)).cases[0].booking_read_model
      ?.proposal,
    null,
  );
  f.cases.push({ ...f.cases[0], id: "opp:other", opportunity_id: "other" });
  assertEquals(
    applyBookingConfirmationModels(f, bundle()).cases.every((c) =>
      c.booking_read_model?.proposal === null
    ),
    true,
  );
});

Deno.test("independent approvals: actor, exact snapshot, 15 minute expiry, no cross-channel authority, retry immutable", async () => {
  const f = await fixture(), { store, records } = memoryStore();
  const req = request(f, store);
  req.body.approved_by_user_id = "spoof";
  const first = await salesBookingApprovalWriteAction(req);
  assertEquals(first.approval.approved_by_user_id, auth.userId);
  assertEquals(first.approval.expires_at, "2026-09-22T00:15:00.000Z");
  assertEquals(
    (await salesBookingApprovalWriteAction(req)).approval,
    first.approval,
  );
  const read = await applyBookingApprovals(f, store, NOW);
  assertEquals(
    read.cases[0].booking_read_model?.calendar_write.state,
    "approved",
  );
  assertEquals(
    read.cases[0].booking_read_model?.message.state,
    "awaiting_approval",
  );
  const second = await salesBookingApprovalWriteAction(
    request(f, store, "message"),
  );
  assert(second.approval.binding_hash !== first.approval.binding_hash);
  assertEquals(records.size, 2);
  assertEquals(
    second.approval.snapshot.content.text,
    f.cases[0].booking_read_model?.message.template_text,
  );
  const expired = await applyBookingApprovals(
    f,
    store,
    new Date("2026-09-22T00:15:00Z"),
  );
  assertEquals(
    expired.cases[0].booking_read_model?.calendar_write.state,
    "awaiting_approval",
  );
});

Deno.test("refusal is one channel, needs a reason, and cannot be overwritten by approval", async () => {
  const f = await fixture(),
    { store } = memoryStore(),
    req = request(f, store, "message");
  req.body.decision = "refused";
  await assertRejects(
    () => salesBookingApprovalWriteAction(req),
    Error,
    "refusal_reason_required",
  );
  req.body.reason = "Wrong wording";
  await salesBookingApprovalWriteAction(req);
  const read = await applyBookingApprovals(f, store, NOW);
  assertEquals(read.cases[0].booking_read_model?.message.state, "refused");
  assertEquals(
    read.cases[0].booking_read_model?.calendar_write.state,
    "awaiting_approval",
  );
  await assertRejects(
    () => salesBookingApprovalWriteAction(request(f, store, "message")),
    Error,
    "already_recorded",
  );
});

Deno.test("tampering: route, exact whitespace, destination, revision, step, identity all require new approval", async () => {
  for (
    const mutate of [
      (s: BookingObject) => s.content.text += " ",
      (s: BookingObject) => s.content.sender = "+61400000009",
      (s: BookingObject) => s.content.recipient = "+61400000009",
      (s: BookingObject) => s.pack_revision = "c".repeat(64),
      (s: BookingObject) => s.step = "calendar",
      (s: BookingObject) => s.contact_id = "other",
    ]
  ) {
    const f = await fixture(),
      { store, records } = memoryStore(),
      req = request(f, store, "message");
    mutate(req.body.snapshot);
    await assertRejects(() => salesBookingApprovalWriteAction(req));
    assertEquals(records.size, 0);
  }
  const f = await fixture(), { store } = memoryStore(), req = request(f, store);
  req.body.snapshot.content.calendar_id = "other";
  await assertRejects(
    () => salesBookingApprovalWriteAction(req),
    Error,
    "snapshot_changed",
  );
  // Changing authoritative bytes while keeping the old hash is also refused.
  f.cases[0].booking_read_model!.calendar_write.preview.title = "Changed";
  await assertRejects(
    () => salesBookingApprovalWriteAction(request(f, store)),
    Error,
    "content_hash_mismatch",
  );
});

Deno.test("auth: only allow-listed signed actor, POST; unavailable/expired/stale validation never writes", async () => {
  const f = await fixture(), { store, records } = memoryStore();
  for (
    const actor of [{ ...auth, mode: "api_key" as const }, {
      ...auth,
      email: "other@example.test",
    }, { ...auth, userId: "" }]
  ) {
    await assertRejects(
      () =>
        salesBookingApprovalWriteAction({ ...request(f, store), auth: actor }),
      Error,
    );
  }
  await assertRejects(
    () =>
      salesBookingApprovalWriteAction({ ...request(f, store), method: "GET" }),
    Error,
    "requires POST",
  );
  f.cases[0].booking_read_model!.expires_at = NOW.toISOString();
  await assertRejects(
    () => salesBookingApprovalWriteAction(request(f, store)),
    Error,
    "proposal_expired",
  );
  assertEquals(records.size, 0);
});

Deno.test("canonical comparison ignores key order; retries cannot renew expiry or cross receipt state", async () => {
  const f = await fixture(), { store } = memoryStore(), req = request(f, store);
  req.body.snapshot = Object.fromEntries(
    Object.entries(req.body.snapshot).reverse(),
  );
  await salesBookingApprovalWriteAction(req);
  const m = f.cases[0].booking_read_model!;
  m.validation.checked_at = "2026-09-22T00:16:00Z";
  await assertRejects(
    () =>
      salesBookingApprovalWriteAction({
        ...req,
        now: () => new Date(m.validation.checked_at),
      }),
    Error,
    "approval_expired_requires_new_proposal",
  );
  m.calendar_write.state = "unknown";
  assertEquals(
    (await applyBookingApprovals(f, store, NOW)).cases[0].booking_read_model
      ?.calendar_write.state,
    "unknown",
  );
  await assertRejects(
    () => salesBookingApprovalWriteAction(req),
    Error,
    "requires_reconciliation",
  );
});

Deno.test("legacy stamp never grants separate approval; manifest publish survives round trip", async () => {
  const f = await fixture();
  const read = applySalesBookingPackOverlay(f, {
    pack: null,
    pack_error: null,
    stamp_error: null,
    stamp: {
      id: "legacy",
      as_of: NOW.toISOString(),
      payload: { approved: [row.id], rejected: [] },
    },
  });
  assertEquals(read.cases[0].booking_read_model?.calendar_write.approval, null);
  assertEquals(read.cases[0].booking_read_model?.message.approval, null);
  let written: BookingObject = {};
  const client = {
    from: () => ({
      upsert: (data: BookingObject) => {
        written = data;
        return {
          select: () => ({
            single: () =>
              Promise.resolve({
                data: { id: "pack-id", as_of: NOW.toISOString() },
                error: null,
              }),
          }),
        };
      },
    }),
  };
  await salesBookingPackPublishAction(client, { mode: "api_key" }, {
    resource: "marnin",
    week_start: "2026-09-21",
    as_of: NOW.toISOString(),
    booking_read_models: bundle(),
  });
  assertEquals(
    selectBookingModels(written.payload.booking_read_models)[0].id,
    row.id,
  );
  assertEquals(
    await bookingHash({ a: 1, b: 2 }),
    await bookingHash({ b: 2, a: 1 }),
  );
});

Deno.test("failed, missing, stale checks and malformed/conflicting ledger each refuse without persisting", async () => {
  const mutations: Array<(f: SalesBookingReadResponse) => void> = [
    (f) => f.cases[0].booking_read_model!.validation.checks[0].passed = false,
    (f) => f.cases[0].booking_read_model!.validation.checks.pop(),
    (f) =>
      f.cases[0].booking_read_model!.validation.checked_at =
        "2026-09-21T23:58:00Z",
    (f) => f.cases[0].booking_read_model!.evidence_quotes = null,
    (f) => f.booking_flow!.commitments = [{ id: "broken" }],
    (f) =>
      f.booking_flow!.commitments = [{
        id: "another-offer",
        contact_id: "other",
        state: "offered",
        start_iso: "2026-09-25T09:00:00+08:00",
        end_iso: "2026-09-25T12:00:00+08:00",
      }],
    (f) => f.coverage.full_population = false,
  ];
  for (const mutate of mutations) {
    const f = await fixture(), { store, records } = memoryStore();
    mutate(f);
    await assertRejects(() =>
      salesBookingApprovalWriteAction(request(f, store))
    );
    assertEquals(records.size, 0);
  }
});

Deno.test("approval read failure is explicit, while content changes hide old approvals", async () => {
  const f = await fixture(), { store } = memoryStore();
  await salesBookingApprovalWriteAction(request(f, store));
  const failedStore: BookingApprovalStore = {
    ...store,
    find: () => Promise.reject(new Error("offline")),
  };
  const failed = await applyBookingApprovals(f, failedStore, NOW);
  assertEquals(failed.booking_flow?.approval_write, null);
  assertEquals(
    failed.booking_flow?.approval_read_error,
    "booking_approvals_unreadable",
  );
  assertEquals(
    failed.cases[0].booking_read_model?.calendar_write.state,
    "awaiting_approval",
  );
  f.cases[0].booking_read_model!.pack_revision = "d".repeat(64);
  const read = await applyBookingApprovals(f, store, NOW);
  assertEquals(
    read.cases[0].booking_read_model?.calendar_write.state,
    "awaiting_approval",
  );
});

Deno.test("malformed producer arrays refuse; expired producer approvals cannot remain approved", async () => {
  const malformed = model();
  malformed.evidence_quotes = "invented";
  assertThrows(
    () => selectBookingModels(bundle(malformed)),
    Error,
    "fields_malformed",
  );
  const f = await fixture(), { store } = memoryStore();
  const m = f.cases[0].booking_read_model!;
  m.calendar_write.state = "approved";
  m.calendar_write.approval = {
    ui_snapshot: bookingApprovalSnapshot(f, f.cases[0], "calendar"),
    expires_at: NOW.toISOString(),
    original_binding: "retained",
  };
  const read = await applyBookingApprovals(f, store, NOW);
  assertEquals(
    read.cases[0].booking_read_model?.calendar_write.state,
    "awaiting_approval",
  );
  assertEquals(
    read.cases[0].booking_read_model?.calendar_write.approval.original_binding,
    "retained",
  );
});

function storeRecord(
  snapshot: BookingObject,
  hash: string,
  extras: Partial<BookingApprovalRecord> = {},
): BookingApprovalRecord {
  return {
    binding_hash: hash,
    step: "calendar",
    resource: "marnin",
    week_start: "2026-09-21",
    state: "approved",
    reason: null,
    snapshot,
    approved_by_user_id: auth.userId,
    approved_by_email: auth.email,
    approved_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + BOOKING_APPROVAL_TTL_MS).toISOString(),
    ...extras,
  };
}

Deno.test("approval authority: only a live store row, never publisher fields or pack expiry", async () => {
  const paintPublisherApproved = async () => {
    const f = await fixture();
    const snapshot = bookingApprovalSnapshot(f, f.cases[0], "calendar");
    const m = f.cases[0].booking_read_model!;
    m.calendar_write.state = "approved";
    m.calendar_write.approval = {
      ui_snapshot: snapshot,
      expires_at: m.expires_at,
    };
    m.message.state = "held";
    m.message.approval = {
      ui_snapshot: bookingApprovalSnapshot(f, f.cases[0], "message"),
      expires_at: m.expires_at,
    };
    return { f, snapshot, m };
  };

  const painted = applyBookingConfirmationModels(
    await fixture(),
    bundle({
      ...model(),
      calendar_write: { ...model().calendar_write, state: "approved" },
      message: { ...model().message, state: "refused" },
    }),
  );
  assertEquals(
    painted.cases[0].booking_read_model?.calendar_write.state,
    "awaiting_approval",
  );
  assertEquals(
    painted.cases[0].booking_read_model?.message.state,
    "awaiting_approval",
  );

  {
    const { f } = await paintPublisherApproved();
    const { store } = memoryStore();
    const read = await applyBookingApprovals(f, store, NOW);
    assertEquals(
      read.cases[0].booking_read_model?.calendar_write.state,
      "awaiting_approval",
    );
    assertEquals(
      read.cases[0].booking_read_model?.message.state,
      "awaiting_approval",
    );
    assertEquals(read.booking_flow?.approval_write, "separate-v1");
  }

  {
    const f = await fixture();
    const { store, records } = memoryStore();
    const snapshot = bookingApprovalSnapshot(f, f.cases[0], "calendar");
    const hash = await bookingHash(snapshot);
    records.set(
      hash,
      storeRecord(snapshot, hash, {
        approved_at: new Date(NOW.getTime() - BOOKING_APPROVAL_TTL_MS - 1_000)
          .toISOString(),
        expires_at: f.cases[0].booking_read_model!.expires_at,
      }),
    );
    const read = await applyBookingApprovals(f, store, NOW);
    assertEquals(
      read.cases[0].booking_read_model?.calendar_write.state,
      "awaiting_approval",
    );
    assertEquals(
      read.cases[0].booking_read_model?.message.state,
      "awaiting_approval",
    );
  }

  {
    const f = await fixture();
    const { store, records } = memoryStore();
    const snapshot = bookingApprovalSnapshot(f, f.cases[0], "calendar");
    const other = structuredClone(snapshot);
    other.content.title = "Different visit";
    const hash = await bookingHash(other);
    records.set(hash, storeRecord(other, hash));
    const read = await applyBookingApprovals(f, store, NOW);
    assertEquals(
      read.cases[0].booking_read_model?.calendar_write.state,
      "awaiting_approval",
    );
  }

  {
    const { f } = await paintPublisherApproved();
    const failedStore: BookingApprovalStore = {
      find: () => Promise.reject(new Error("offline")),
      insert: () => Promise.reject(new Error("offline")),
    };
    const failed = await applyBookingApprovals(f, failedStore, NOW);
    assertEquals(
      failed.cases[0].booking_read_model?.calendar_write.state,
      "awaiting_approval",
    );
    assertEquals(
      failed.cases[0].booking_read_model?.message.state,
      "awaiting_approval",
    );
    assertEquals(failed.booking_flow?.approval_write, null);
    assertEquals(
      failed.booking_flow?.approval_read_error,
      "booking_approvals_unreadable",
    );
  }

  const f = await fixture(), { store } = memoryStore();
  await salesBookingApprovalWriteAction(request(f, store));
  const live = await applyBookingApprovals(f, store, NOW);
  assertEquals(
    live.cases[0].booking_read_model?.calendar_write.state,
    "approved",
  );
  assertEquals(
    live.cases[0].booking_read_model?.message.state,
    "awaiting_approval",
  );
});

Deno.test("failed execution channels refuse approval and refusal without a hidden decision row", async () => {
  for (const step of ["calendar", "message"] as const) {
    for (const decision of ["approved", "refused"]) {
      const f = await fixture(), { store, records } = memoryStore();
      f.cases[0]
        .booking_read_model![step === "calendar" ? "calendar_write" : "message"]
        .state = "failed";
      const req = request(f, store, step);
      req.body.decision = decision;
      req.body.reason = decision === "refused"
        ? "Reconcile the failed attempt"
        : null;
      const error = await assertRejects(
        () => salesBookingApprovalWriteAction(req),
        Error,
        "booking_step_requires_reconciliation",
      );
      assertEquals((error as Error & { status: number }).status, 409);
      assertEquals(records.size, 0);
    }
  }
});

Deno.test("published model composes availability, occupied intervals and prior offers with publish freshness", async () => {
  const f = await fixture();
  f.pack.as_of = NOW.toISOString();
  const m = model();
  m.validation.availability = {
    state: "read",
    occupied_intervals: [{
      start: "2026-09-25T12:00:00+08:00",
      end: "2026-09-25T13:00:00+08:00",
    }],
  };
  m.prior_offers = [{
    slot_id: "offer-1",
    contact_id: "other-contact",
    state: "offered",
    start: "2026-09-25T14:00:00+08:00",
    end: "2026-09-25T15:00:00+08:00",
  }];
  const read = applyBookingConfirmationModels(f, bundle(m), NOW);
  assertEquals(read.booking_flow?.calendar_read.state, "read");
  assertEquals(
    read.booking_flow?.calendar_read.occupied_intervals,
    m.validation.availability.occupied_intervals,
  );
  assertEquals(read.booking_flow?.calendar_read.as_of, f.pack.as_of);
  assertEquals(read.booking_flow?.commitments[0].id, "offer-1");
  assertEquals(read.booking_flow?.commitments[0].as_of, f.pack.as_of);
  assertEquals(read.booking_flow?.commitments_read.state, "read");
  const expired = applyBookingConfirmationModels(
    f,
    bundle(m),
    new Date(m.expires_at),
  );
  assertEquals(expired.booking_flow?.calendar_read.state, "stale");
  assertEquals(expired.booking_flow?.commitments_read.state, "stale");
  assertEquals(expired.booking_flow?.commitments[0].stale, true);
  delete m.validation.availability;
  const missing = applyBookingConfirmationModels(f, bundle(m), NOW);
  assertEquals(missing.booking_flow?.calendar_read.state, "could_not_read");
  assertEquals(missing.booking_flow?.calendar_read.occupied_intervals, null);
  delete m.prior_offers;
  assertEquals(
    applyBookingConfirmationModels(f, bundle(m), NOW).booking_flow?.commitments,
    null,
  );
});

Deno.test("availability cannot come from an unrelated contact, wrong profile or malformed census", async () => {
  const f = await fixture();
  f.pack.as_of = NOW.toISOString();
  const m = model();
  m.validation.availability = { state: "read", occupied_intervals: [] };
  m.prior_offers = [];
  const complete = applyBookingConfirmationModels(f, bundle(m), NOW);
  assertEquals(complete.booking_flow?.commitments, []);
  m.contact_id = "other-contact";
  assertEquals(
    applyBookingConfirmationModels(f, bundle(m), NOW).booking_flow
      ?.calendar_read.state,
    "could_not_read",
  );
  m.contact_id = row.contact_id;
  m.profile = "other-profile";
  assertEquals(
    applyBookingConfirmationModels(f, bundle(m), NOW).booking_flow
      ?.calendar_read.state,
    "could_not_read",
  );
  m.profile = "fencing-stratco-marnin";
  m.prior_offers = [{}];
  assertEquals(
    applyBookingConfirmationModels(f, bundle(m), NOW).booking_flow?.commitments,
    null,
  );
  m.validation.availability.occupied_intervals = [{}];
  assertEquals(
    applyBookingConfirmationModels(f, bundle(m), NOW).booking_flow
      ?.calendar_read.state,
    "could_not_read",
  );
});
