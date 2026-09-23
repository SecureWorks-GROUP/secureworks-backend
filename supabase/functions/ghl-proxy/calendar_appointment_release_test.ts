// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type LedgerRowView,
  releaseActor,
  releaseCalendarAppointmentAction,
  type ReleaseCaller,
  type ReleaseDecision,
  type ReleaseLedger,
} from "./calendar_appointment_release.ts";

const NOW = Date.parse("2026-09-24T02:00:00Z");
const ORG = "00000000-0000-0000-0000-000000000001";
const CAPTAIN = "marnin@secureworkswa.com.au";
const KEY = "a".repeat(64);
const REASON = "Checked GHL by hand: no appointment exists.";
const CAPTAIN_JWT: ReleaseCaller = {
  mode: "user_jwt",
  email: "Marnin@SecureWorksWA.com.au",
  role: "admin",
  orgId: ORG,
};
const SERVICE: ReleaseCaller = {
  mode: "service_role",
  email: null,
  role: null,
  orgId: null,
};

function stuckRow(extra: Partial<LedgerRowView> = {}): LedgerRowView {
  return {
    state: "sending",
    assigned_user_id: "user1",
    start_time: "2026-10-01T02:00:00Z",
    end_time: "2026-10-01T03:00:00Z",
    lease_until: new Date(NOW - 11 * 60_000).toISOString(),
    created_at: new Date(NOW - 12 * 60_000).toISOString(),
    released_at: null,
    released_by: null,
    release_reason: null,
    ...extra,
  };
}

function fixture(row: LedgerRowView | null = stuckRow()) {
  const releases: Array<Record<string, string>> = [];
  let decision: ReleaseDecision | Error = {
    decision: "released",
    released_at: new Date(NOW).toISOString(),
    released_by: "",
    release_reason: "",
  };
  const ledger: ReleaseLedger = {
    read: () => Promise.resolve(row),
    release(args) {
      releases.push({ ...args });
      if (decision instanceof Error) return Promise.reject(decision);
      if (decision.decision === "released") {
        return Promise.resolve({
          ...decision,
          released_by: args.releasedBy,
          release_reason: args.reason,
        });
      }
      return Promise.resolve(decision);
    },
  };
  return {
    releases,
    setDecision: (d: ReleaseDecision | Error) => {
      decision = d;
    },
    call: (
      body: unknown,
      caller: ReleaseCaller = CAPTAIN_JWT,
      method = "POST",
    ) =>
      releaseCalendarAppointmentAction({
        method,
        body,
        caller,
        now: () => NOW,
        deps: {
          locationId: "loc1",
          configuredOrgId: ORG,
          captainEmails: [CAPTAIN],
          ledger,
        },
      }),
  };
}

Deno.test("only the service role or an allow-listed same-org captain JWT may release", async () => {
  const deps = { captainEmails: [CAPTAIN], configuredOrgId: ORG };
  assertEquals(releaseActor(SERVICE, deps), "service_role");
  assertEquals(releaseActor(CAPTAIN_JWT, deps), CAPTAIN);
  for (
    const caller of [
      { mode: "shared_key", email: CAPTAIN, role: "admin", orgId: ORG },
      {
        mode: "user_jwt",
        email: "ops@secureworkswa.com.au",
        role: "admin",
        orgId: ORG,
      },
      { mode: "user_jwt", email: CAPTAIN, role: "admin", orgId: "other-org" },
      { mode: "user_jwt", email: null, role: "admin", orgId: ORG },
    ] as ReleaseCaller[]
  ) {
    assertEquals(releaseActor(caller, deps), null, JSON.stringify(caller));
    const f = fixture();
    const res = await f.call({
      idempotencyKey: KEY,
      reason: REASON,
      commit: true,
    }, caller);
    assertEquals(res, {
      status: 403,
      body: {
        ok: false,
        code: "forbidden",
        reason: "captain_or_service_role_only",
      },
    });
    assertEquals(f.releases, []);
  }
});

Deno.test("preview is the default and writes nothing", async () => {
  const f = fixture();
  const res = await f.call({ idempotencyKey: KEY, reason: REASON });
  assertEquals(res.status, 200);
  assertEquals(res.body.dryRun, true);
  assertEquals(res.body.wouldRelease, true);
  assertEquals(res.body.releasedBy, CAPTAIN);
  assertEquals(f.releases, []);

  const recent = fixture(
    stuckRow({ lease_until: new Date(NOW - 60_000).toISOString() }),
  );
  const early = await recent.call({ idempotencyKey: KEY, reason: REASON });
  assertEquals([early.body.wouldRelease, early.body.blocker], [
    false,
    "too_recent",
  ]);
  const done = fixture(stuckRow({ state: "complete" }));
  const complete = await done.call({ idempotencyKey: KEY, reason: REASON });
  assertEquals([complete.body.wouldRelease, complete.body.blocker], [
    false,
    "not_sending",
  ]);
  const missing = fixture(null);
  assertEquals(
    (await missing.call({ idempotencyKey: KEY, reason: REASON })).status,
    404,
  );
});

Deno.test("commit releases with the caller as actor and the trimmed reason", async () => {
  const f = fixture();
  const res = await f.call(
    { idempotencyKey: KEY, reason: `  ${REASON}  `, commit: true },
    SERVICE,
  );
  assertEquals(res.status, 200);
  assertEquals(res.body.released, true);
  assertEquals(res.body.releasedBy, "service_role");
  assertEquals(res.body.releaseReason, REASON);
  assertEquals(f.releases, [{
    locationId: "loc1",
    key: KEY,
    reason: REASON,
    releasedBy: "service_role",
  }]);
});

Deno.test("commit maps every ledger answer; a ledger fault is not a release", async () => {
  const cases: Array<[ReleaseDecision | Error, number, string]> = [
    [{ decision: "not_found" }, 404, "not_found"],
    [{ decision: "not_sending", state: "complete" }, 409, "not_sending"],
    [
      { decision: "too_recent", lease_until: "2026-09-24T01:55:00Z" },
      409,
      "too_recent",
    ],
    [new Error("db down private detail"), 503, "ledger_error"],
  ];
  for (const [decision, status, code] of cases) {
    const f = fixture();
    f.setDecision(decision);
    const res = await f.call({
      idempotencyKey: KEY,
      reason: REASON,
      commit: true,
    });
    assertEquals([res.status, res.body.ok, res.body.code], [
      status,
      false,
      code,
    ]);
  }
  const again = fixture();
  again.setDecision({
    decision: "already_released",
    released_at: "2026-09-24T01:00:00Z",
    released_by: CAPTAIN,
    release_reason: REASON,
  });
  const res = await again.call({
    idempotencyKey: KEY,
    reason: "A different reason here.",
    commit: true,
  });
  assertEquals(res.status, 200);
  assertEquals([
    res.body.released,
    res.body.alreadyReleased,
    res.body.releaseReason,
  ], [false, true, REASON]);
});

Deno.test("bad requests refuse before any ledger call", async () => {
  for (
    const body of [
      null,
      [],
      { idempotencyKey: KEY },
      { idempotencyKey: KEY, reason: "too short" },
      { idempotencyKey: KEY, reason: "x".repeat(501) },
      { idempotencyKey: ` ${KEY}`, reason: REASON },
      { idempotencyKey: "", reason: REASON },
      { idempotencyKey: KEY, reason: REASON, commit: "yes" },
      { idempotencyKey: KEY, reason: REASON, delete: true },
    ]
  ) {
    const f = fixture();
    const res = await f.call(body);
    assertEquals(res, {
      status: 400,
      body: { ok: false, code: "invalid_request" },
    }, JSON.stringify(body));
    assertEquals(f.releases, []);
  }
  const f = fixture();
  assertEquals(
    (await f.call({ idempotencyKey: KEY, reason: REASON }, CAPTAIN_JWT, "GET"))
      .status,
    405,
  );
});
