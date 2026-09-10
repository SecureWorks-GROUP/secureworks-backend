// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sendProposedSms } from "./index.ts";

const ACTION_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
function fixture(overrides: Record<string, unknown> = {}) {
  const action: any = {
    proposal_id: ACTION_ID,
    job_id: JOB_ID,
    status: "pending",
    sent_at: null,
    contact_id: "contact-fixture",
    contact_phone: "+61400000000",
    drafted_message: "Synthetic scope enquiry.",
    action_type: "book_scope",
    action_payload: { loop: "booking_scope" },
    ...overrides,
  };
  const allowedStatuses = new Set([
    "pending",
    "auto_approved",
    "approved",
    "rejected",
    "expired",
    "sent",
  ]);
  const events: any[] = [];
  const calls: any[] = [];
  const failures = {
    claim: false,
    checkpoint: false,
    receipt: false,
    finalize: false,
    fence: false,
  };
  let race: (() => void) | undefined;
  const client = {
    from(table: string) {
      let patch: any, inserted: any, single = false;
      const filters: Array<[string, unknown]> = [];
      const q: any = {
        select() {
          return q;
        },
        eq(key: string, value: unknown) {
          filters.push([key, value]);
          return q;
        },
        is(key: string, value: unknown) {
          filters.push([key, value]);
          return q;
        },
        update(value: any) {
          patch = value;
          return q;
        },
        insert(value: any) {
          inserted = value;
          return q;
        },
        single() {
          single = true;
          return q;
        },
        maybeSingle() {
          single = true;
          return q;
        },
        limit() {
          return q;
        },
        then(resolve: any, reject: any) {
          return Promise.resolve().then(() => {
            if (table === "jobs") {
              return {
                data: failures.fence ? null : { id: JOB_ID, type: "patio" },
                error: failures.fence
                  ? { message: "fixture lookup failed" }
                  : null,
              };
            }
            if (inserted) {
              if (failures.receipt && table === "business_events") {
                return {
                  data: null,
                  error: { message: "fixture receipt failed" },
                };
              }
              events.push({ table, row: structuredClone(inserted) });
              return { data: [{ id: "receipt-fixture" }], error: null };
            }
            if (patch && race) {
              const run = race;
              race = undefined;
              run();
            }
            const match = filters.every(([key, value]) =>
              (key === "action_payload->sms_dispatch->>attempt_id"
                ? action.action_payload.sms_dispatch?.attempt_id
                : key === "action_payload->sms_dispatch"
                ? action.action_payload.sms_dispatch ?? null
                : action[key]) === value
            );
            if (patch?.status && !allowedStatuses.has(patch.status)) {
              return {
                data: null,
                error: {
                  code: "23514",
                  message: "ai_proposed_actions_status_check",
                },
              };
            }
            const failure = patch &&
              (patch.status === "sent"
                ? failures.finalize
                : patch.status === "approved"
                ? failures.claim
                : failures.checkpoint);
            if (failure) {
              return { data: null, error: { message: "fixture write failed" } };
            }
            if (!match) return { data: single ? null : [], error: null };
            if (patch) {
              calls.push({ table, patch: structuredClone(patch) });
              Object.assign(action, structuredClone(patch));
            }
            return {
              data: single
                ? structuredClone(action)
                : [structuredClone(action)],
              error: null,
            };
          }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return {
    action,
    allowedStatuses,
    events,
    calls,
    failures,
    client,
    race(fn: () => void) {
      race = fn;
    },
  };
}

async function run(
  f: ReturnType<typeof fixture>,
  response: () => Response | Promise<Response> = () =>
    Response.json({ success: true, messageId: "message-fixture" }),
  options: {
    env?: Record<string, string>;
    invoke?: (client: any) => Promise<any>;
  } = {},
) {
  const oldFetch = globalThis.fetch;
  const names = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "BOOKING_CANARY_MODE",
    "BOOKING_CANARY_PHONE_ALLOWLIST",
  ];
  const previous = names.map((name) => Deno.env.get(name));
  Deno.env.set("SUPABASE_URL", "https://example.test");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "synthetic-key");
  Deno.env.set("BOOKING_CANARY_MODE", "false");
  for (const [name, value] of Object.entries(options.env ?? {})) {
    Deno.env.set(name, value);
  }
  let fetches = 0;
  globalThis.fetch = async (_input, init) => {
    fetches++;
    const sent = JSON.parse(String(init?.body));
    assertEquals(sent, {
      contactId: "contact-fixture",
      message: "Synthetic scope enquiry.",
      jobId: JOB_ID,
    });
    return await response();
  };
  try {
    const result = await (options.invoke
      ? options.invoke(f.client)
      : sendProposedSms(f.client, { action_id: ACTION_ID }));
    return { result, fetches };
  } finally {
    globalThis.fetch = oldFetch;
    names.forEach((name, i) =>
      previous[i] === undefined
        ? Deno.env.delete(name)
        : Deno.env.set(name, previous[i]!)
    );
  }
}

Deno.test("actual sendProposedSms refuses missing recipient without consuming proposal", async () => {
  const f = fixture({ contact_id: null });
  const { result, fetches } = await run(f);
  assertEquals(result.success, false);
  assertEquals(fetches, 0);
  assertEquals(f.action.status, "pending");
  assertEquals(f.events, []);
});

for (
  const invalid of [{ contact_id: " " }, { drafted_message: null }, {
    drafted_message: " \n ",
  }, { drafted_message: 42 }]
) {
  Deno.test(`actual handler refuses invalid input ${JSON.stringify(invalid)}`, async () => {
    const f = fixture(invalid);
    const { result, fetches } = await run(f);
    assertEquals(result.success, false);
    assertEquals(fetches, 0);
    assertEquals(f.calls, []);
    assertEquals(f.events, []);
  });
}

Deno.test("actual handler checks SES lookup and canary before claims and sends", async () => {
  const f = fixture();
  f.failures.fence = true;
  await assertRejects(() => run(f));
  assertEquals(f.calls, []);
  assertEquals(f.events, []);
  f.failures.fence = false;
  const result = await run(f, undefined, {
    env: {
      BOOKING_CANARY_MODE: "true",
      BOOKING_CANARY_PHONE_ALLOWLIST: "+61499999999",
    },
  });
  assertEquals(result.result.error, "canary_recipient_blocked");
  assertEquals(result.fetches, 0);
  assertEquals(f.calls, []);
});

Deno.test("actual handler binds accepted receipt to action, recipient, body, job and attempt", async () => {
  const f = fixture();
  const { result, fetches } = await run(f);
  assertEquals(fetches, 1);
  assertEquals(result.success, true);
  assertEquals(result.outcome, "provider_accepted");
  assertEquals(result.ghl_message_id, "message-fixture");
  assertEquals(f.action.status, "sent");
  assertEquals(f.events.length, 1);
  const event = f.events[0].row;
  assertEquals(f.events[0].table, "business_events");
  assertEquals(event.event_type, "proposed_action.dispatched");
  assertEquals(event.entity_id, ACTION_ID);
  assertEquals(event.job_id, JOB_ID);
  assertEquals(event.payload.action_id, ACTION_ID);
  assertEquals(event.payload.contact_id, "contact-fixture");
  assertEquals(event.payload.attempt_id, result.attempt_id);
  assertEquals(event.payload.ghl_status, 200);
  assertEquals(event.payload.error, null);
  assertEquals(event.payload.auto_retry, false);
  assertEquals(
    event.payload.body_sha256,
    "ab3c2dbda8b67e01988399acace5b95292a852e62d9647e00249c8bc1b3b0780",
  );
  assertEquals(event.payload.observed_at, f.action.sent_at);
  assert(!("provider_sent_at" in event.payload));
  assert(!("conversation_id" in event.payload));
  assertEquals(f.action.action_payload.loop, "booking_scope");
});

const failures: Array<[string, () => Response | Promise<Response>, string]> = [
  [
    "HTTP 500",
    () =>
      Response.json({ error: "synthetic-private-provider-error" }, {
        status: 500,
      }),
    "unknown",
  ],
  [
    "HTTP 401",
    () =>
      Response.json({ error: "synthetic-private-provider-error" }, {
        status: 401,
      }),
    "unknown",
  ],
  [
    "proxy success false after possible acceptance",
    () =>
      Response.json({
        success: false,
        error: "synthetic-private-provider-error",
      }),
    "unknown",
  ],
  [
    "dedup",
    () => Response.json({ success: false, dedup_blocked: true }),
    "rejected",
  ],
  ["missing id", () => Response.json({ success: true }), "unknown"],
  [
    "numeric id",
    () => Response.json({ success: true, messageId: 42 }),
    "unknown",
  ],
  [
    "object id",
    () =>
      Response.json({
        success: true,
        messageId: { secret: "synthetic-private-provider-error" },
      }),
    "unknown",
  ],
  [
    "blank id",
    () => Response.json({ success: true, messageId: "  " }),
    "unknown",
  ],
  [
    "conflicting ids",
    () => Response.json({ success: true, messageId: "one", id: "two" }),
    "unknown",
  ],
  [
    "contradictory failure",
    () => Response.json({ success: false, messageId: "message-fixture" }),
    "unknown",
  ],
  [
    "contradictory error",
    () =>
      Response.json({
        success: true,
        messageId: "message-fixture",
        error: "synthetic-private-provider-error",
      }),
    "unknown",
  ],
  [
    "malformed JSON",
    () => new Response("synthetic-private-provider-error"),
    "unknown",
  ],
  ["array", () => Response.json([]), "unknown"],
  ["response lost after send", () => {
    throw new Error("synthetic-private-provider-error");
  }, "unknown"],
];
for (const [name, respond, outcome] of failures) {
  Deno.test(`actual handler holds ${name} without false sent proof or automatic replay`, async () => {
    const f = fixture();
    const { result, fetches } = await run(f, respond);
    assertEquals(fetches, 1);
    assertEquals(result.success, false);
    assertEquals(result.outcome, outcome);
    assertEquals(result.auto_retry, false);
    assertEquals(result.requires_reconciliation, true);
    assertEquals(f.action.status, "approved");
    assertEquals(f.action.sent_at, null);
    assertEquals(
      f.events[0].row.event_type,
      outcome === "unknown"
        ? "proposed_action.dispatch_unknown"
        : "proposed_action.dispatch_failed",
    );
    assert(
      !JSON.stringify([result, f.events, f.action]).includes(
        "synthetic-private-provider-error",
      ),
    );
    await assertRejects(() => run(f));
    // Even if an operator resets only the status, the retained attempt fences replay.
    f.action.status = "pending";
    const replay = await run(f);
    assertEquals(replay.fetches, 0);
    assertEquals(replay.result.success, false);
  });
}

Deno.test("concurrent calls claim once and issue exactly one provider request", async () => {
  const f = fixture();
  const { result, fetches } = await run(f, undefined, {
    invoke: (client) =>
      Promise.allSettled([
        sendProposedSms(client, { action_id: ACTION_ID }),
        sendProposedSms(client, { action_id: ACTION_ID }),
      ]),
  });
  assertEquals(fetches, 1);
  assertEquals(f.events.length, 1);
  assertEquals(
    result.filter((r: any) => r.status === "fulfilled" && r.value.success)
      .length,
    1,
  );
});

for (
  const key of ["job_id", "contact_id", "contact_phone", "drafted_message"]
) {
  Deno.test(`claim refuses a concurrent ${key} change after preflight`, async () => {
    const f = fixture();
    f.race(() => f.action[key] = "changed-fixture");
    const { result, fetches } = await run(f);
    assertEquals(result.success, false);
    assertEquals(fetches, 0);
    assertEquals(f.events, []);
  });
}

Deno.test("claim refuses an attempt added after preflight even if status was reset", async () => {
  const f = fixture();
  f.race(() =>
    f.action.action_payload.sms_dispatch = { attempt_id: "other-attempt" }
  );
  const { result, fetches } = await run(f);
  assertEquals(result.success, false);
  assertEquals(fetches, 0);
});

for (const failure of ["claim", "checkpoint", "receipt", "finalize"] as const) {
  Deno.test(`actual handler checks ${failure} write and never reopens accepted dispatch`, async () => {
    const f = fixture();
    f.failures[failure] = true;
    const { result, fetches } = await run(f);
    assertEquals(result.success, false);
    assertEquals(result.auto_retry, false);
    assertEquals(fetches, failure === "claim" ? 0 : 1);
    if (failure !== "claim") {
      assertEquals(f.action.status, "approved");
      assertEquals(f.action.sent_at, null);
      assertEquals(result.ghl_message_id, "message-fixture");
      await assertRejects(() => run(f));
    }
  });
}

Deno.test("missing provider configuration cannot consume a pending proposal", async () => {
  const f = fixture();
  const { result, fetches } = await run(f, undefined, {
    env: { SUPABASE_SERVICE_ROLE_KEY: "" },
  });
  assertEquals(result.error, "sms_provider_unconfigured");
  assertEquals(fetches, 0);
  assertEquals(f.calls, []);
});

Deno.test("recipient edits during provider request cannot finalize the edited proposal as sent", async () => {
  const f = fixture();
  const { result, fetches } = await run(f, () => {
    f.action.contact_id = "different-contact";
    return Response.json({ success: true, messageId: "message-fixture" });
  });
  assertEquals(fetches, 1);
  assertEquals(result.success, false);
  assertEquals(result.outcome, "provider_accepted");
  assertEquals(f.action.status, "approved");
  assertEquals(f.events[0].row.payload.contact_id, "contact-fixture");
  assertEquals(f.events[0].row.payload.ghl_message_id, "message-fixture");
});

Deno.test("proxy upstream failure envelope after acceptance is unknown, never definite rejection", async () => {
  const f = fixture();
  const { result } = await run(f, () =>
    Response.json({
      success: false,
      error: "GHL upstream connection lost after request acceptance",
    }, { status: 500 }));
  assertEquals(result.outcome, "unknown");
  assertEquals(result.requires_reconciliation, true);
  assertEquals(result.auto_retry, false);
  assertEquals(f.action.status, "approved");
  assertEquals(f.events[0].row.event_type, "proposed_action.dispatch_unknown");
  assertEquals(f.events[0].row.payload.outcome, "unknown");
  assertEquals(f.events[0].row.payload.ghl_message_id, null);
});

Deno.test("legacy status constraint cannot turn accepted send into success or replay", async () => {
  const f = fixture();
  f.allowedStatuses.delete("sent");
  const { result, fetches } = await run(f);
  assertEquals(fetches, 1);
  assertEquals(result.success, false);
  assertEquals(result.error, "dispatch_finalize_unconfirmed");
  assertEquals(result.outcome, "provider_accepted");
  assertEquals(result.ghl_message_id, "message-fixture");
  assertEquals(f.action.status, "approved");
  assertEquals(f.events[0].row.event_type, "proposed_action.dispatched");
  await assertRejects(() => run(f));
});
