// M0 · U3 — Sales-scope + from_site proof fixtures.
//
// Mission: sales-m0-data-truth-2026-07-05 (Lane A / U3). Verifier V re-runs this.
//
// Run from secureworks-backend/:
//   deno test --allow-net --allow-env --allow-read \
//     supabase/functions/_shared/scope/from_site_test.ts
//
// Proves the STRICT server-verified gate (call 4): the flag is set ONLY for a
// same-session, assigned-scoper, in-window send backed by a real
// scope.signed_off event — and NOTHING a client merely asserts can set it.
// Also covers the deep-link resolver, the never-counts estimate heuristic, the
// sandbox no-real-send trigger, and the leak-safety invariant.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildScopeSignoffPayload,
  FROM_SITE_IN_SESSION_WINDOW_MIN,
  isFromSiteEstimated,
  isSandboxRecipient,
  isSandboxSend,
  SALES_SCOPE_ASSIGNMENT_TYPE,
  SCOPE_SIGNOFF_EVENT_TYPE,
  scopingToolDeepLink,
  verifyFromSiteProof,
} from "./from_site.ts";

type Row = Record<string, unknown>;

// Minimal business_events mock for verifyFromSiteProof: select().eq().eq().order().limit()
function makeDb(signoffEvents: Row[]) {
  return {
    from(_table: string) {
      const preds: Array<(r: Row) => boolean> = [];
      const chain: Record<string, unknown> = {
        select() { return chain; },
        eq(c: string, v: unknown) { preds.push((r) => r[c] === v); return chain; },
        order() { return chain; },
        limit() {
          const rows = signoffEvents.filter((r) => preds.every((p) => p(r)));
          return Promise.resolve({ data: rows, error: null });
        },
      };
      return chain;
    },
  };
}

const iso = (s: string) => new Date(s).toISOString();
const JOB = "job-1";
const SCOPER = "user-scoper";
const SESSION = "sess-abc";

function signoffEvent(over: Partial<{ id: string; occurred_at: string; session: string; scoper: string }> = {}): Row {
  const occurred = over.occurred_at ?? iso("2026-06-01T10:00:00Z");
  return {
    id: over.id ?? "evt-signoff-1",
    event_type: SCOPE_SIGNOFF_EVENT_TYPE,
    job_id: JOB,
    occurred_at: occurred,
    payload: {
      scope_revision_id: "rev-1",
      job_id: JOB,
      scoper_user_id: over.scoper ?? SCOPER,
      tool_session_id: over.session ?? SESSION,
      signoff_at: occurred,
    },
  };
}

Deno.test("deep-link resolves per job type", () => {
  assertEquals(scopingToolDeepLink("patio", "J1"), "https://secureworks-group.github.io/patio/?jobId=J1");
  assertEquals(scopingToolDeepLink("fencing", "J2"), "https://secureworks-group.github.io/fence-designer/?jobId=J2");
  // misc/unknown types default to patio (mirrors the existing ghl-proxy builder).
  assertEquals(scopingToolDeepLink("decking", "J3"), "https://secureworks-group.github.io/patio/?jobId=J3");
  assertEquals(scopingToolDeepLink(null, "J4"), "https://secureworks-group.github.io/patio/?jobId=J4");
});

Deno.test("leak-safety invariant: sales_scope is a distinct value", () => {
  // Every ops reporting consumer matches assignment_type by EXACT equality on
  // 'scope' (reporting-api 3187/3195/3394, daily-digest 2891). 'sales_scope' is
  // a different string, so it can never satisfy those equality filters.
  assertEquals(SALES_SCOPE_ASSIGNMENT_TYPE, "sales_scope");
  assert((SALES_SCOPE_ASSIGNMENT_TYPE as string) !== "scope");
});

Deno.test("sandbox trigger: explicit flag OR sink recipient", () => {
  assert(isSandboxSend(true, "real@client.com"));
  assert(isSandboxSend("true", "real@client.com"));
  assert(isSandboxSend(false, "someone+m0sandbox@gmail.com"));
  assert(isSandboxRecipient("qa@sandbox.secureworks.test"));
  assert(isSandboxRecipient("anything@example.com"));
  assert(!isSandboxSend(false, "real.client@bigpond.com"));
  assert(!isSandboxSend(undefined, "real.client@bigpond.com"));
});

Deno.test("estimate heuristic (never counts): 4h window, sign-off must precede send", () => {
  const sent = iso("2026-06-01T12:00:00Z");
  assert(isFromSiteEstimated(sent, [iso("2026-06-01T09:30:00Z")]));  // 2.5h before → estimated
  assert(!isFromSiteEstimated(sent, [iso("2026-06-01T07:00:00Z")])); // 5h before → out of window
  assert(!isFromSiteEstimated(sent, [iso("2026-06-01T13:00:00Z")])); // after send → not counted
  assert(!isFromSiteEstimated(sent, []));                            // no sign-off
});

Deno.test("signoff payload shape carries session + scoper", () => {
  const p = buildScopeSignoffPayload({
    scopeRevisionId: "rev-9", jobId: JOB, scoperUserId: SCOPER, toolSessionId: SESSION, signoffAt: iso("2026-06-01T10:00:00Z"),
  });
  assertEquals(p.tool_session_id, SESSION);
  assertEquals(p.scoper_user_id, SCOPER);
  assertEquals(p.scope_revision_id, "rev-9");
});

Deno.test("from_site STRICT: qualifies only for same-session + assigned-scoper + in-window", async () => {
  const db = makeDb([signoffEvent()]);
  const ev = await verifyFromSiteProof(db, {
    jobId: JOB, assignedScoperId: SCOPER, toolSessionId: SESSION,
    sendAtIso: iso("2026-06-01T10:05:00Z"), // 5 min after sign-off
  });
  assert(ev !== null);
  assertEquals(ev!.scope_signoff_event_id, "evt-signoff-1");
  assertEquals(ev!.tool_session_id, SESSION);
  assertEquals(ev!.scoper_user_id, SCOPER);
  assertEquals(ev!.verifier, "server");
});

Deno.test("from_site STRICT: every disqualifier returns null", async () => {
  const sendAt = iso("2026-06-01T10:05:00Z");
  // Wrong session (client claims a different session than the sign-off).
  assertEquals(await verifyFromSiteProof(makeDb([signoffEvent()]), {
    jobId: JOB, assignedScoperId: SCOPER, toolSessionId: "sess-OTHER", sendAtIso: sendAt,
  }), null);
  // Not the assigned scoper.
  assertEquals(await verifyFromSiteProof(makeDb([signoffEvent()]), {
    jobId: JOB, assignedScoperId: "user-SOMEONE-ELSE", toolSessionId: SESSION, sendAtIso: sendAt,
  }), null);
  // Out of the in-session window (hours later = office resend).
  const late = iso(`2026-06-01T${10 + Math.ceil(FROM_SITE_IN_SESSION_WINDOW_MIN / 60) + 2}:30:00Z`);
  assertEquals(await verifyFromSiteProof(makeDb([signoffEvent()]), {
    jobId: JOB, assignedScoperId: SCOPER, toolSessionId: SESSION, sendAtIso: late,
  }), null);
  // No session id supplied (a bare from_site assertion).
  assertEquals(await verifyFromSiteProof(makeDb([signoffEvent()]), {
    jobId: JOB, assignedScoperId: SCOPER, toolSessionId: null, sendAtIso: sendAt,
  }), null);
  // Client asserts, but NO sign-off event exists at all → cannot be faked.
  assertEquals(await verifyFromSiteProof(makeDb([]), {
    jobId: JOB, assignedScoperId: SCOPER, toolSessionId: SESSION, sendAtIso: sendAt,
  }), null);
});

// Postgres `payload->>'key'` semantics: returns the value's TEXT form, or null
// when the key is absent. A JSON string "true" and a JSON boolean true both
// extract to the text 'true'. This mirror lets the fixture assert Deckhand B's
// exact reader expression against the row send-quote writes.
function pgArrowArrowText(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : String(v);
}

Deno.test("INTERFACE: B's reader payload->>'from_site'='true' matches the written row", async () => {
  // 1. A qualifying send produces server-verified evidence.
  const evidence = await verifyFromSiteProof(makeDb([signoffEvent()]), {
    jobId: JOB, assignedScoperId: SCOPER, toolSessionId: SESSION,
    sendAtIso: iso("2026-06-01T10:05:00Z"),
  });
  assert(evidence !== null);

  // 2. send-quote writes exactly this into the quote.sent payload (mirrors the
  //    `salesMeasureFields` spread in send-quote/index.ts).
  const quoteSentPayload: Record<string, unknown> = {
    document_id: "doc-1",
    job_number: "P-123",
    ...{ from_site: "true", from_site_evidence: evidence },
  };

  // 3. Deckhand B's scoreboard view reads payload->>'from_site' = 'true'.
  assertEquals(pgArrowArrowText(quoteSentPayload, "from_site"), "true"); // COUNTS
  assert(typeof quoteSentPayload.from_site_evidence === "object"); // jsonb object
  assertEquals((quoteSentPayload.from_site_evidence as { verifier: string }).verifier, "server");

  // 4. A non-qualifying send writes NO from_site key → the view's filter
  //    excludes it (never counted).
  const officeResendPayload: Record<string, unknown> = { document_id: "doc-2", job_number: "P-124" };
  assertEquals(pgArrowArrowText(officeResendPayload, "from_site"), null);
  assert(pgArrowArrowText(officeResendPayload, "from_site") !== "true");

  // 5. estimate label never satisfies the strict reader.
  const estimatedOnly: Record<string, unknown> = { from_site_estimated: "true" };
  assertEquals(pgArrowArrowText(estimatedOnly, "from_site"), null);
});

Deno.test("from_site STRICT: repeat client's old session does not qualify a new send", async () => {
  // Two sign-offs for the job across two sessions; a send in session B must not
  // match session A's sign-off.
  const db = makeDb([
    signoffEvent({ id: "evt-A", occurred_at: iso("2026-05-01T09:00:00Z"), session: "sess-A" }),
    signoffEvent({ id: "evt-B", occurred_at: iso("2026-06-01T10:00:00Z"), session: "sess-B" }),
  ]);
  const ev = await verifyFromSiteProof(db, {
    jobId: JOB, assignedScoperId: SCOPER, toolSessionId: "sess-B", sendAtIso: iso("2026-06-01T10:05:00Z"),
  });
  assertEquals(ev!.scope_signoff_event_id, "evt-B"); // matched the right session, not the stale one
});
