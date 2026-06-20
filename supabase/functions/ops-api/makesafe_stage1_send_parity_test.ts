// Stage 1-2a — makesafe send-parity tests.
//
// Tests for: photo follow-up idempotency markers, portal-prep idempotency markers,
// isSwmsPdf, checkClientSendGateWithSwms (3-attachment MLB gate).
//
// MONEY/COMMS critical. Pure, mocked: NO network, NO live Supabase, NO Xero.
//
// Run: deno test --no-check --allow-env --allow-net=127.0.0.1 \
//        supabase/functions/ops-api/makesafe_stage1_send_parity_test.ts
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _makesafeSendPhotoFollowupForTest as makesafeSendPhotoFollowup,
} from "./index.ts";
import {
  buildPhotoFollowUpMarkerText,
  buildPortalReadyMarkerText,
  checkClientSendGateWithSwms,
  checkReportJobClientSendGate,
  hasPackPhotoSentMarker,
  hasPackPortalReadyMarker,
  isPackPhotoSentEvent,
  isPackPortalReadyEvent,
  // SWMS helpers
  isSwmsPdf,
  // Existing helpers used in validation
  MAKESAFE_ADMIN_FROM,
  MAKESAFE_CC,
  // Photo follow-up
  MAKESAFE_PACK_PHOTO_SENT_PREFIX,
  // Portal-prep
  MAKESAFE_PACK_PORTAL_READY_PREFIX,
} from "./makesafe_send_pack.ts";

// ─────────────────────────────────────────────────────────────────
// 1. isPackPhotoSentEvent / hasPackPhotoSentMarker
// ─────────────────────────────────────────────────────────────────

Deno.test("photo marker: isPackPhotoSentEvent — PASS for correct prefix", () => {
  const ev = {
    event_type: "note",
    detail_json: {
      text:
        `${MAKESAFE_PACK_PHOTO_SENT_PREFIX} | photos=3 | to=test@ajs.build | 2026-06-18T00:00:00Z | msgid=abc`,
    },
  };
  assert(isPackPhotoSentEvent(ev), "event with photo prefix must match");
});

Deno.test("photo marker: isPackPhotoSentEvent — FAIL for main prefix (not photo prefix)", () => {
  const ev = {
    event_type: "note",
    detail_json: {
      text:
        "MAKESAFE_PACK_SENT | main | INV-123 | to=test@ajs.build | 2026-06-18T00:00:00Z | msgid=",
    },
  };
  assertEquals(
    isPackPhotoSentEvent(ev),
    false,
    "main marker must not match photo event check",
  );
});

Deno.test("photo marker: isPackPhotoSentEvent — FAIL for wrong event_type", () => {
  const ev = {
    event_type: "status_change",
    detail_json: {
      text:
        `${MAKESAFE_PACK_PHOTO_SENT_PREFIX} | photos=1 | to=x@y.com | 2026-06-18T00:00:00Z`,
    },
  };
  assertEquals(isPackPhotoSentEvent(ev), false);
});

Deno.test("photo marker: isPackPhotoSentEvent — FAIL for null / missing", () => {
  assertEquals(isPackPhotoSentEvent(null), false);
  assertEquals(isPackPhotoSentEvent(undefined), false);
  assertEquals(isPackPhotoSentEvent({}), false);
  assertEquals(
    isPackPhotoSentEvent({ event_type: "note", detail_json: {} }),
    false,
  );
});

Deno.test("photo marker: isPackPhotoSentEvent — handles stringified JSON detail_json", () => {
  const ev = {
    event_type: "note",
    detail_json: JSON.stringify({
      text:
        `${MAKESAFE_PACK_PHOTO_SENT_PREFIX} | photos=2 | to=x@y.com | 2026-06-18T`,
    }),
  };
  assert(isPackPhotoSentEvent(ev));
});

Deno.test("photo marker: hasPackPhotoSentMarker — TRUE when marker present in set", () => {
  const events = [
    { event_type: "note", detail_json: { text: "some other note" } },
    {
      event_type: "note",
      detail_json: {
        text:
          `${MAKESAFE_PACK_PHOTO_SENT_PREFIX} | photos=5 | to=x@y.com | now`,
      },
    },
  ];
  assert(hasPackPhotoSentMarker(events));
});

Deno.test("photo marker: hasPackPhotoSentMarker — FALSE when no marker in set", () => {
  const events = [
    {
      event_type: "note",
      detail_json: {
        text: "MAKESAFE_PACK_SENT | main | INV-1 | to=x@y.com | now | msgid=",
      },
    },
    { event_type: "status_change", detail_json: {} },
  ];
  assertEquals(hasPackPhotoSentMarker(events), false);
});

Deno.test("photo marker: hasPackPhotoSentMarker — FALSE for empty / null", () => {
  assertEquals(hasPackPhotoSentMarker([]), false);
  assertEquals(hasPackPhotoSentMarker(null), false);
  assertEquals(hasPackPhotoSentMarker(undefined), false);
});

// ─────────────────────────────────────────────────────────────────
// 2. buildPhotoFollowUpMarkerText shape
// ─────────────────────────────────────────────────────────────────

Deno.test("buildPhotoFollowUpMarkerText: starts with the correct prefix", () => {
  const text = buildPhotoFollowUpMarkerText({
    photoCount: 4,
    to: "wo@mlb.com.au",
    nowIso: "2026-06-18T01:00:00.000Z",
    messageId: "msg-42",
  });
  assert(
    text.startsWith(MAKESAFE_PACK_PHOTO_SENT_PREFIX),
    `expected prefix; got: ${text}`,
  );
});

Deno.test("buildPhotoFollowUpMarkerText: contains photo count, to, msgid", () => {
  const text = buildPhotoFollowUpMarkerText({
    photoCount: 7,
    to: "wo@mlb.com.au",
    nowIso: "2026-06-18T01:00:00.000Z",
    messageId: "msg-99",
  });
  assert(text.includes("photos=7"), "must contain photo count");
  assert(text.includes("to=wo@mlb.com.au"), "must contain recipient");
  assert(text.includes("msgid=msg-99"), "must contain message id");
});

Deno.test("buildPhotoFollowUpMarkerText: handles null messageId", () => {
  const text = buildPhotoFollowUpMarkerText({
    photoCount: 1,
    to: "x@y.com",
    nowIso: "2026-06-18T01:00:00.000Z",
    messageId: null,
  });
  assert(text.includes("msgid="), "msgid field must be present even when null");
  // The marker it produces must itself be detected as a photo event
  const ev = { event_type: "note", detail_json: { text } };
  assert(isPackPhotoSentEvent(ev), "the built marker must be self-detectable");
});

// ─────────────────────────────────────────────────────────────────
// 3. isPackPortalReadyEvent / hasPackPortalReadyMarker
// ─────────────────────────────────────────────────────────────────

Deno.test("portal marker: isPackPortalReadyEvent — PASS for correct prefix", () => {
  const ev = {
    event_type: "note",
    detail_json: {
      text: `${MAKESAFE_PACK_PORTAL_READY_PREFIX} | 2026-06-18T02:00:00.000Z`,
    },
  };
  assert(isPackPortalReadyEvent(ev));
});

Deno.test("portal marker: isPackPortalReadyEvent — FAIL for photo prefix", () => {
  const ev = {
    event_type: "note",
    detail_json: {
      text:
        `${MAKESAFE_PACK_PHOTO_SENT_PREFIX} | photos=2 | to=x@y.com | 2026-06-18T`,
    },
  };
  assertEquals(isPackPortalReadyEvent(ev), false);
});

Deno.test("portal marker: isPackPortalReadyEvent — FAIL for wrong event_type", () => {
  const ev = {
    event_type: "status_change",
    detail_json: { text: `${MAKESAFE_PACK_PORTAL_READY_PREFIX} | 2026-06-18T` },
  };
  assertEquals(isPackPortalReadyEvent(ev), false);
});

Deno.test("portal marker: isPackPortalReadyEvent — handles stringified JSON detail_json", () => {
  const ev = {
    event_type: "note",
    detail_json: JSON.stringify({
      text: `${MAKESAFE_PACK_PORTAL_READY_PREFIX} | 2026-06-18T`,
    }),
  };
  assert(isPackPortalReadyEvent(ev));
});

Deno.test("portal marker: hasPackPortalReadyMarker — TRUE when marker present", () => {
  const events = [
    { event_type: "note", detail_json: { text: "unrelated note" } },
    {
      event_type: "note",
      detail_json: {
        text: `${MAKESAFE_PACK_PORTAL_READY_PREFIX} | 2026-06-18T`,
      },
    },
  ];
  assert(hasPackPortalReadyMarker(events));
});

Deno.test("portal marker: hasPackPortalReadyMarker — FALSE when absent", () => {
  const events = [
    {
      event_type: "note",
      detail_json: {
        text: "MAKESAFE_PACK_SENT | main | INV-1 | to=x@y.com | now | msgid=",
      },
    },
  ];
  assertEquals(hasPackPortalReadyMarker(events), false);
  assertEquals(hasPackPortalReadyMarker([]), false);
  assertEquals(hasPackPortalReadyMarker(null), false);
});

// ─────────────────────────────────────────────────────────────────
// 4. buildPortalReadyMarkerText shape
// ─────────────────────────────────────────────────────────────────

Deno.test("buildPortalReadyMarkerText: starts with correct prefix", () => {
  const text = buildPortalReadyMarkerText({
    nowIso: "2026-06-18T03:00:00.000Z",
  });
  assert(
    text.startsWith(MAKESAFE_PACK_PORTAL_READY_PREFIX),
    `expected prefix; got: ${text}`,
  );
});

Deno.test("buildPortalReadyMarkerText: contains the ISO timestamp", () => {
  const iso = "2026-06-18T03:00:00.000Z";
  const text = buildPortalReadyMarkerText({ nowIso: iso });
  assert(text.includes(iso), "must include the timestamp");
});

Deno.test("buildPortalReadyMarkerText: self-detectable as portal ready event", () => {
  const text = buildPortalReadyMarkerText({
    nowIso: "2026-06-18T03:00:00.000Z",
  });
  const ev = { event_type: "note", detail_json: { text } };
  assert(
    isPackPortalReadyEvent(ev),
    "the built marker must be self-detectable",
  );
});

// ─────────────────────────────────────────────────────────────────
// 5. isSwmsPdf
// ─────────────────────────────────────────────────────────────────

Deno.test("isSwmsPdf: detects SWMS PDF names", () => {
  assert(isSwmsPdf("SWMS - Make Safe.pdf"), "exact SWMS.pdf");
  assert(isSwmsPdf("swms_make_safe_2026.pdf"), "lowercase swms");
  assert(isSwmsPdf("BWCWA-67800 SWMS.pdf"), "ref + SWMS");
  assert(isSwmsPdf("MLB-1234 SWMS Make Safe.pdf"), "MLB SWMS");
});

Deno.test("isSwmsPdf: rejects non-SWMS or non-PDF files", () => {
  assertEquals(
    isSwmsPdf("Make Safe Report.pdf"),
    false,
    "report PDF is not SWMS",
  );
  assertEquals(
    isSwmsPdf(
      "Make Safe Report - SWMS-26642-MLB-25045 - U3-63-Carrington-Street-Palmyra-WA-6157.pdf",
    ),
    false,
    "report PDF carrying a SWMS job number is not the SWMS document",
  );
  assertEquals(
    isSwmsPdf(
      "Make Safe Report - SWMS-26604-MLB-25767 - 170-Hampden-Road-Nedlands-WA.pdf",
    ),
    false,
    "Nedlands report PDF carrying a SWMS job number is not the SWMS document",
  );
  assertEquals(
    isSwmsPdf("Xero Invoice - INV-1234.pdf"),
    false,
    "invoice PDF is not SWMS",
  );
  assertEquals(isSwmsPdf("SWMS - Make Safe.docx"), false, "non-PDF extension");
  assertEquals(isSwmsPdf(""), false, "empty string");
  assertEquals(isSwmsPdf("swms.txt"), false, "txt extension");
});

// ─────────────────────────────────────────────────────────────────
// 6. checkClientSendGateWithSwms
// ─────────────────────────────────────────────────────────────────

const MLB_VALID_PAYLOAD = {
  from: MAKESAFE_ADMIN_FROM,
  to: "wo@mlb.com.au",
  cc: MAKESAFE_CC,
  subject: "Make Safe - MLB-1234 - 42 Smith St",
  htmlBody: "<p>Please find attached the make safe report and invoice.</p>",
  attachments: [
    { name: "Make Safe Report - MLB-1234.pdf" },
    { name: "Xero Invoice - INV-5678.pdf" },
    { name: "SWMS - Make Safe.pdf" },
  ],
};

Deno.test("checkClientSendGateWithSwms: PASS with 3 correct PDFs", () => {
  const failures = checkClientSendGateWithSwms(MLB_VALID_PAYLOAD);
  assertEquals(
    failures,
    [],
    `expected no failures; got: ${failures.join(", ")}`,
  );
});

Deno.test("checkClientSendGateWithSwms: PASS when report filename contains SWMS job number plus one real SWMS PDF", () => {
  const payload = {
    ...MLB_VALID_PAYLOAD,
    attachments: [
      {
        name:
          "Make Safe Report - SWMS-26642-MLB-25045 - U3-63-Carrington-Street-Palmyra-WA-6157.pdf",
      },
      { name: "Xero Invoice - INV-0710.pdf" },
      { name: "SecureWorks_SWMS_MLB25045_Palmyra_Roof.pdf" },
    ],
  };
  const failures = checkClientSendGateWithSwms(payload);
  assertEquals(
    failures,
    [],
    `expected no failures; got: ${failures.join(", ")}`,
  );
});

Deno.test("checkClientSendGateWithSwms: FAIL with only 2 attachments (missing SWMS)", () => {
  const payload = {
    ...MLB_VALID_PAYLOAD,
    attachments: [
      { name: "Make Safe Report - MLB-1234.pdf" },
      { name: "Xero Invoice - INV-5678.pdf" },
    ],
  };
  const failures = checkClientSendGateWithSwms(payload);
  assert(failures.length > 0, "must fail with only 2 attachments");
  const allText = failures.join(" ");
  assert(
    allText.includes("three") || allText.includes("SWMS") ||
      allText.includes("swms"),
    `failure must mention SWMS requirement; got: ${allText}`,
  );
});

Deno.test("checkClientSendGateWithSwms: FAIL with wrong sender", () => {
  const payload = { ...MLB_VALID_PAYLOAD, from: "wrong@example.com" };
  const failures = checkClientSendGateWithSwms(payload);
  assert(failures.length > 0);
  assert(failures.some((f) => f.includes("sender")));
});

Deno.test("checkClientSendGateWithSwms: FAIL with missing CC", () => {
  const payload = { ...MLB_VALID_PAYLOAD, cc: "" };
  const failures = checkClientSendGateWithSwms(payload);
  assert(failures.length > 0);
  assert(failures.some((f) => f.includes("cc")));
});

Deno.test("checkClientSendGateWithSwms: FAIL if subject has review marker", () => {
  const payload = {
    ...MLB_VALID_PAYLOAD,
    subject: "DRAFT Make Safe - MLB-1234 - 42 Smith St",
  };
  const failures = checkClientSendGateWithSwms(payload);
  assert(failures.length > 0);
  assert(failures.some((f) => f.includes("DRAFT") || f.includes("marker")));
});

Deno.test("checkClientSendGateWithSwms: FAIL if attachment has review marker in name", () => {
  const payload = {
    ...MLB_VALID_PAYLOAD,
    attachments: [
      { name: "Make Safe Report - MLB-1234 DRAFT.pdf" },
      { name: "Xero Invoice - INV-5678.pdf" },
      { name: "SWMS - Make Safe.pdf" },
    ],
  };
  const failures = checkClientSendGateWithSwms(payload);
  assert(failures.length > 0);
});

Deno.test("checkClientSendGateWithSwms: FAIL if missing report PDF", () => {
  const payload = {
    ...MLB_VALID_PAYLOAD,
    attachments: [
      { name: "Some Document.pdf" },
      { name: "Xero Invoice - INV-5678.pdf" },
      { name: "SWMS - Make Safe.pdf" },
    ],
  };
  const failures = checkClientSendGateWithSwms(payload);
  assert(failures.length > 0);
  assert(failures.some((f) => f.includes("report")));
});

Deno.test("checkClientSendGateWithSwms: FAIL if missing invoice PDF", () => {
  const payload = {
    ...MLB_VALID_PAYLOAD,
    attachments: [
      { name: "Make Safe Report - MLB-1234.pdf" },
      { name: "Some Document.pdf" },
      { name: "SWMS - Make Safe.pdf" },
    ],
  };
  const failures = checkClientSendGateWithSwms(payload);
  assert(failures.length > 0);
  assert(failures.some((f) => f.includes("invoice") || f.includes("Xero")));
});

Deno.test("checkClientSendGateWithSwms: FAIL if missing SWMS PDF specifically", () => {
  const payload = {
    ...MLB_VALID_PAYLOAD,
    attachments: [
      { name: "Make Safe Report - MLB-1234.pdf" },
      { name: "Xero Invoice - INV-5678.pdf" },
      { name: "Site Photos.pdf" },
    ],
  };
  const failures = checkClientSendGateWithSwms(payload);
  assert(failures.length > 0);
  assert(failures.some((f) => f.includes("SWMS") || f.includes("swms")));
});

// ─────────────────────────────────────────────────────────────────
// 7. Photo follow-up idempotency: marker present => return early (pure model)
// ─────────────────────────────────────────────────────────────────

Deno.test("photo follow-up idempotency: hasPackPhotoSentMarker returns true when marker present, blocking re-send", () => {
  // Simulate the events list that the handler would load from job_events.
  // If hasPackPhotoSentMarker is true, the handler returns {already_sent: true}.
  const markerText = buildPhotoFollowUpMarkerText({
    photoCount: 3,
    to: "wo@mlb.com.au",
    nowIso: "2026-06-18T04:00:00.000Z",
    messageId: "msg-001",
  });
  const events = [
    {
      event_type: "note",
      detail_json: {
        text:
          "MAKESAFE_PACK_SENT | main | INV-1 | to=x@y.com | 2026-06-18 | msgid=",
      },
    },
    { event_type: "note", detail_json: { text: markerText } },
  ];
  // The handler checks: if (hasPackPhotoSentMarker(events)) return {already_sent: true}
  assert(hasPackPhotoSentMarker(events), "marker should block re-send");
  // Without the marker, it would proceed
  assertEquals(
    hasPackPhotoSentMarker([events[0]]),
    false,
    "without photo marker, would proceed",
  );
});

class PhotoFollowupLockQuery {
  private filters: Record<string, unknown> = {};
  private updatePatch: Record<string, unknown> | null = null;

  constructor(
    private table: string,
    private state: {
      events: unknown[];
      photoPackStatus: string;
      updates: Record<string, unknown>[];
    },
  ) {}

  select(_cols?: string) {
    return this;
  }

  eq(key: string, value: unknown) {
    this.filters[key] = value;
    return this;
  }

  in(key: string, values: unknown[]) {
    this.filters[key] = values;
    return this;
  }

  update(patch: Record<string, unknown>) {
    this.updatePatch = patch;
    this.state.updates.push(patch);
    return this;
  }

  insert(_row: Record<string, unknown>) {
    return Promise.resolve({ data: null, error: null });
  }

  maybeSingle() {
    if (this.table === "makesafe_report_packs") {
      return Promise.resolve({
        data: {
          id: "photo-pack-1",
          status: this.state.photoPackStatus,
          failed_step: "photo_followup",
        },
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  }

  then(resolve: (value: unknown) => void, reject?: (reason?: unknown) => void) {
    try {
      if (this.table === "job_events") {
        return Promise.resolve({ data: this.state.events, error: null }).then(
          resolve,
          reject,
        );
      }
      if (this.table === "makesafe_report_packs" && this.updatePatch) {
        const allowed = Array.isArray(this.filters.status)
          ? this.filters.status.map(String)
          : [];
        const claimed = allowed.includes(this.state.photoPackStatus)
          ? [{ id: "photo-pack-1", status: this.state.photoPackStatus }]
          : [];
        if (claimed.length) this.state.photoPackStatus = "sending";
        return Promise.resolve({ data: claimed, error: null }).then(
          resolve,
          reject,
        );
      }
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    } catch (e) {
      return Promise.reject(e).then(resolve, reject);
    }
  }
}

Deno.test("photo follow-up action: in-flight photo pack blocks before any fetch/email", async () => {
  const state = {
    events: [
      {
        event_type: "note",
        detail_json: {
          text:
            "MAKESAFE_PACK_SENT | main | INV-1 | to=x@y.com | 2026-06-18 | msgid=main",
        },
      },
    ],
    photoPackStatus: "sending",
    updates: [] as Record<string, unknown>[],
  };
  const client = {
    from(table: string) {
      return new PhotoFollowupLockQuery(table, state);
    },
  };

  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    fetchCalls++;
    return Promise.resolve(new Response("unexpected"));
  }) as typeof fetch;
  try {
    await assertRejects(
      () =>
        makesafeSendPhotoFollowup(client, {
          job_id: "job-1",
          approved_photos: [{
            url: "https://example.com/job-1/photo.jpg",
            name: "photo.jpg",
          }],
        }),
      Error,
      "current photo pack status is 'sending'",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assertEquals(
    fetchCalls,
    0,
    "lock failure must happen before photo/email fetch",
  );
  assertEquals(
    state.updates.length,
    1,
    "only the attempted atomic lock update should run",
  );
});

// ─────────────────────────────────────────────────────────────────
// 8. Portal-prep idempotency: marker present => return early (pure model)
// ─────────────────────────────────────────────────────────────────

Deno.test("portal-prep idempotency: hasPackPortalReadyMarker returns true, blocking re-prep", () => {
  const markerText = buildPortalReadyMarkerText({
    nowIso: "2026-06-18T05:00:00.000Z",
  });
  const events = [
    { event_type: "note", detail_json: { text: "unrelated note" } },
    { event_type: "note", detail_json: { text: markerText } },
  ];
  assert(
    hasPackPortalReadyMarker(events),
    "portal marker should block re-prep",
  );
  assertEquals(
    hasPackPortalReadyMarker([events[0]]),
    false,
    "without portal marker, would proceed",
  );
});

Deno.test("portal-prep idempotency: the built marker is self-detectable after a round-trip JSON stringify", () => {
  const markerText = buildPortalReadyMarkerText({
    nowIso: "2026-06-18T05:00:00.000Z",
  });
  // Simulate what Supabase returns: detail_json stored as text, returned as string
  const evStringified = {
    event_type: "note",
    detail_json: JSON.stringify({ text: markerText }),
  };
  assert(
    isPackPortalReadyEvent(evStringified),
    "portal marker must survive JSON stringify round-trip",
  );
  assert(hasPackPortalReadyMarker([evStringified]));
});

// ─────────────────────────────────────────────────────────────────
// 7. checkReportJobClientSendGate
// ─────────────────────────────────────────────────────────────────

const REPORT_JOB_VALID_PAYLOAD = {
  from: MAKESAFE_ADMIN_FROM,
  to: "wo@mlb.com.au",
  cc: MAKESAFE_CC,
  subject: "Make Safe Report Invoice - MLB-1234 - 42 Smith St",
  htmlBody:
    "<p>Please find attached the invoice for the builder-portal report job.</p>",
  attachments: [
    { name: "Xero Invoice - INV-5678.pdf" },
  ],
};

Deno.test("checkReportJobClientSendGate: PASS with invoice-only PDF", () => {
  const failures = checkReportJobClientSendGate(REPORT_JOB_VALID_PAYLOAD);
  assertEquals(
    failures,
    [],
    `expected no failures; got: ${failures.join(", ")}`,
  );
});

Deno.test("checkReportJobClientSendGate: FAIL if a SecureWorks report PDF is included", () => {
  const failures = checkReportJobClientSendGate({
    ...REPORT_JOB_VALID_PAYLOAD,
    attachments: [
      { name: "Make Safe Report - MLB-1234.pdf" },
      { name: "Xero Invoice - INV-5678.pdf" },
    ],
  });
  assert(
    failures.some((f) =>
      f.includes("must not include") || f.includes("exactly one")
    ),
    failures.join(" | "),
  );
});

Deno.test("checkReportJobClientSendGate: FAIL without an invoice PDF", () => {
  const failures = checkReportJobClientSendGate({
    ...REPORT_JOB_VALID_PAYLOAD,
    attachments: [{ name: "Payment Summary.pdf" }],
  });
  assert(
    failures.some((f) => f.includes("Xero invoice")),
    failures.join(" | "),
  );
});
