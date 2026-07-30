// ════════════════════════════════════════════════════════════
// PHASE-1 SYNC LOGIC TESTS — monitor-ses-makesafes
// Mission: makesafe-live-truth-2026-06-14
// ════════════════════════════════════════════════════════════
//
// Pure-Deno, no network. Mirrors the makesafe_board_test.ts pattern: import the
// underscore-prefixed internal functions and exercise them with stubs.
//
// RUN:
//   ~/.deno/bin/deno test --allow-all --no-check \
//     supabase/functions/ops-api/monitor_ses_makesafes_test.ts
//
// Covers (per MISSION.md Phase-1 logic requirements):
//   - classifier domain-boundary matching (incl over-match rejection)
//   - ON CONFLICT(post_id) idempotency intent (upsert conflict target)
//   - attachment routing (PDF magic-byte accept; ref/item/inline/oversize/non-pdf
//     -> needs_review/failed)
//   - pagination nextLink exhaustion (incl a thread gaining a post after page 1)
//   - ref normalisation
//   - the four pinned regression refs classify as make-safe

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _auditExclusion,
  _classifyPost,
  _collectFallbackMailboxPosts,
  _collectPosts,
  _decodeJwtRole,
  _DEFAULT_REF_PREFIXES,
  _extractRef,
  _extractRefPrefixes,
  _findIntakeSourcesWithoutCase,
  _graphGetAll,
  _handler,
  _isAuthorized,
  _isPdfMagic,
  _loadCompanyPatterns,
  _normaliseRef,
  _parseSenderDomain,
  _persistPost,
  _processAttachments,
  _recordIntakeScanFailure,
  _recordIntakeSourceDeferrals,
  _recordIntakeSourceExceptions,
  _runBackfillFull,
  _scheduleIntakeScanContinuation,
  _senderMatchesPattern,
  _setTestClientFactory,
  isGraphMailReadError,
} from "../monitor-ses-makesafes/index.ts";
import { _resetGraphTokenCache } from "../_shared/graph_client.ts";
import {
  combineVerifiedGate,
  normaliseReconRef as _normaliseReconRef,
  reconcileD1,
} from "./makesafe_reconcile.ts";
import {
  loadRefPrefixes as _loadRefPrefixes,
  validateRefPrefix as _validateRefPrefix,
} from "../_shared/makesafe_refs.ts";
import {
  FX_FAKE_PDF_ATTACHMENT,
  FX_INLINE_ATTACHMENT,
  FX_ITEM_ATTACHMENT,
  FX_LOOKALIKE_SENDER_POST,
  FX_LOOKALIKE_SENDER_THREAD,
  FX_MLB_POST,
  FX_MLB_THREAD,
  FX_MLB_THREAD_REPLY,
  FX_NON_MAKESAFE_POST,
  FX_NON_MAKESAFE_THREAD,
  FX_NON_PDF_FILE_ATTACHMENT,
  FX_OVERSIZE_ATTACHMENT,
  FX_PDF_ATTACHMENT,
  FX_PINNED_REGRESSION,
  FX_REFERENCE_ATTACHMENT,
} from "./makesafe_fixtures.ts";

const COMPANIES = [
  { slug: "mlb", name: "MLB", pattern: "mlb.com.au" },
];

Deno.test("intake scan continuation returns before a scan beyond pg_net's five-second boundary", async () => {
  let releaseScan!: (response: Response) => void;
  const delayedScan = new Promise<Response>((resolve) => {
    releaseScan = resolve;
  });
  const captured: {
    registered?: Promise<void>;
    request?: { url: string; init?: RequestInit };
    leaseReleased?: boolean;
  } = {};
  const fetchStub = ((url: string | URL | Request, init?: RequestInit) => {
    captured.request = { url: String(url), init };
    return delayedScan;
  }) as typeof fetch;

  const started = performance.now();
  _scheduleIntakeScanContinuation(
    fetchStub,
    (promise) => captured.registered = promise,
    "https://example.invalid/ops-api?action=scan_ses_makesafes",
    { "x-api-key": "test-only" },
    async () => {
      captured.leaseReleased = true;
    },
  );
  const schedulingMs = performance.now() - started;

  assert(schedulingMs < 100, `scheduling blocked for ${schedulingMs}ms`);
  assert(captured.registered);
  assertEquals(captured.request?.init?.method, "POST");
  assertEquals(captured.request?.init?.body, "{}");
  const registered = captured.registered;
  const state = await Promise.race([
    registered.then(() => "completed"),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 10)),
  ]);
  assertEquals(state, "pending");
  assertEquals(captured.leaseReleased, undefined);

  releaseScan(new Response("{}", { status: 200 }));
  await registered;
  assertEquals(captured.leaseReleased, true);
});

Deno.test("successful handoff accounting check returns only sources without a canonical case", async () => {
  const sb = {
    from: () => ({
      select: () => ({
        in: () =>
          Promise.resolve({
            data: [{ post_id: "accounted" }],
            error: null,
          }),
      }),
    }),
  };
  const sources = [
    {
      postId: "accounted",
      receivedAt: null,
      conversationId: null,
      threadId: null,
    },
    {
      postId: "missing",
      receivedAt: null,
      conversationId: null,
      threadId: null,
    },
  ];

  const missing = await _findIntakeSourcesWithoutCase(sb, sources);

  assertEquals(missing.map((item) => item.postId), ["missing"]);
});

// email_events_raw's unique index is PARTIAL ('created'/'excluded' only), so the
// intake fate rows must dedupe in the function or a sustained ops-api outage
// appends one duplicate row per post per two-minute poll.
function fateWriterStub(existingChangeTypes: readonly string[] = []) {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const upserted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const existing = new Set(existingChangeTypes);
  const sb = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        inserted.push({ table, row });
        return Promise.resolve({ error: null });
      },
      upsert: (row: Record<string, unknown>) => {
        upserted.push({ table, row });
        return Promise.resolve({ error: null });
      },
      select: () => {
        let changeType = "";
        const builder = {
          eq: (column: string, value: string) => {
            if (column === "change_type") changeType = value;
            return builder;
          },
          maybeSingle: () =>
            Promise.resolve({
              data: existing.has(changeType) ? { id: "existing-event" } : null,
              error: null,
            }),
        };
        return builder;
      },
    }),
  };
  return { sb, inserted, upserted };
}

const ONE_SOURCE = [{
  postId: "source-one",
  receivedAt: "2026-07-26T00:00:00Z",
  conversationId: "conversation-one",
  threadId: "thread-one",
}];

Deno.test("intake source exception writer records one reason-coded source fate plus aggregate alarm", async () => {
  const { sb, inserted } = fateWriterStub();

  await _recordIntakeSourceExceptions(
    sb,
    ONE_SOURCE,
    "scan_completed_without_case_fate",
    "Scanner returned but source fate was missing.",
  );

  assertEquals(inserted.length, 2);
  assertEquals(inserted[0].table, "email_events_raw");
  assertEquals(
    inserted[0].row.change_type,
    "intake_exception_scan_completed_without_case_fate",
  );
  assertEquals(
    (inserted[0].row.page_meta as Record<string, unknown>).source_fate,
    "reason_coded_exception",
  );
  assertEquals(inserted[1].table, "business_events");
});

Deno.test("intake source fate writer never appends a duplicate ledger row on retry", async () => {
  const { sb, inserted } = fateWriterStub([
    "intake_exception_scan_handoff_http_503",
  ]);

  await _recordIntakeSourceExceptions(
    sb,
    ONE_SOURCE,
    "scan_handoff_http_503",
    "Handoff failed again on the overlapping window.",
  );

  assertEquals(inserted.map((item) => item.table), ["business_events"]);
});

Deno.test("bounded-run deferrals are a separate non-terminal fate, not an exception", async () => {
  const { sb, inserted } = fateWriterStub();

  await _recordIntakeSourceDeferrals(
    sb,
    ONE_SOURCE,
    "scan_run_cap_deferred",
    "Scanner stopped at its per-run cap.",
  );

  assertEquals(
    inserted[0].row.change_type,
    "intake_deferred_scan_run_cap_deferred",
  );
  assertEquals(
    (inserted[0].row.page_meta as Record<string, unknown>).source_fate,
    "deferred_next_run",
  );
  assertEquals(
    inserted[1].row.event_type,
    "makesafe.intake.scan_handoff_deferred",
  );
});

Deno.test("intake continuation durably reports non-2xx and network handoff failures", async () => {
  const observed: Array<{ kind: "http" | "network"; status: number | null }> =
    [];
  for (
    const fetchStub of [
      (() =>
        Promise.resolve(
          new Response("unavailable", { status: 503 }),
        )) as typeof fetch,
      (() => Promise.reject(new Error("connection reset"))) as typeof fetch,
    ]
  ) {
    let registered: Promise<void> | undefined;
    let settled = false;
    _scheduleIntakeScanContinuation(
      fetchStub,
      (promise) => registered = promise,
      "https://example.invalid/ops-api?action=scan_ses_makesafes",
      {},
      () => {
        settled = true;
        return Promise.resolve();
      },
      (failure) => {
        observed.push(failure);
        return Promise.resolve();
      },
    );
    assert(registered);
    await registered;
    assertEquals(settled, true);
  }

  assertEquals(observed, [
    { kind: "http", status: 503 },
    { kind: "network", status: null },
  ]);
});

Deno.test("HTTP 546 continuation failure records source fate, aggregate alarm, and degraded health", async () => {
  const { sb, inserted, upserted } = fateWriterStub();
  let registered: Promise<void> | undefined;
  let settled = false;

  _scheduleIntakeScanContinuation(
    (() =>
      Promise.resolve(
        new Response("worker limit", { status: 546 }),
      )) as typeof fetch,
    (promise) => registered = promise,
    "https://example.invalid/ops-api?action=scan_ses_makesafes",
    {},
    () => {
      settled = true;
      return Promise.resolve();
    },
    (failure) =>
      _recordIntakeScanFailure(
        sb as unknown as Parameters<typeof _recordIntakeScanFailure>[0],
        ONE_SOURCE,
        failure,
        "2026-07-26T00:00:00Z",
        "2026-07-27T02:00:00Z",
      ),
  );

  assert(registered);
  await registered;

  assertEquals(settled, true);
  assertEquals(inserted.map((item) => item.table), [
    "email_events_raw",
    "business_events",
  ]);
  assertEquals(
    inserted[0].row.change_type,
    "intake_exception_scan_handoff_http_546",
  );
  assertEquals(upserted.length, 1);
  assertEquals(upserted[0], {
    table: "makesafe_intake_health",
    row: {
      id: true,
      extraction_status: "degraded",
      degraded_reason: "scan_handoff_http_546",
      degraded_since: "2026-07-27T02:00:00Z",
      updated_at: "2026-07-27T02:00:00Z",
    },
  });
  assertEquals("last_scan_at" in upserted[0].row, false);
});

Deno.test("intake continuation reports a per-run bound so cap deferral is not read as a drop", async () => {
  const observed: Array<
    { boundedRun: boolean; casesDeferred: number | null }
  > = [];
  for (
    const body of [
      { totals: { cases_deferred: 5 }, source_read: { cap_reached: false } },
      { totals: { cases_deferred: 0 }, source_read: { cap_reached: true } },
      { totals: { cases_deferred: 0 }, source_read: { cap_reached: false } },
    ]
  ) {
    let registered: Promise<void> | undefined;
    _scheduleIntakeScanContinuation(
      (() =>
        Promise.resolve(
          new Response(JSON.stringify(body), { status: 200 }),
        )) as typeof fetch,
      (promise) => registered = promise,
      "https://example.invalid/ops-api?action=scan_ses_makesafes",
      {},
      () => Promise.resolve(),
      () => Promise.resolve(),
      (outcome) => {
        observed.push({
          boundedRun: outcome.boundedRun,
          casesDeferred: outcome.casesDeferred,
        });
        return Promise.resolve();
      },
    );
    assert(registered);
    await registered;
  }

  assertEquals(observed, [
    { boundedRun: true, casesDeferred: 5 },
    { boundedRun: true, casesDeferred: 0 },
    { boundedRun: false, casesDeferred: 0 },
  ]);
});

Deno.test("an unreadable scan report stays unbounded so a genuine drop still alarms", async () => {
  let registered: Promise<void> | undefined;
  let bounded: boolean | null = null;
  _scheduleIntakeScanContinuation(
    (() =>
      Promise.resolve(
        new Response("not json", { status: 200 }),
      )) as typeof fetch,
    (promise) => registered = promise,
    "https://example.invalid/ops-api?action=scan_ses_makesafes",
    {},
    () => Promise.resolve(),
    () => Promise.resolve(),
    (outcome) => {
      bounded = outcome.boundedRun;
      return Promise.resolve();
    },
  );
  assert(registered);
  await registered;

  assertEquals(bounded, false);
});

Deno.test("intake continuation retains the lease when durable exception persistence fails", async () => {
  let registered: Promise<void> | undefined;
  let settled = false;
  _scheduleIntakeScanContinuation(
    (() =>
      Promise.resolve(
        new Response("unavailable", { status: 503 }),
      )) as typeof fetch,
    (promise) => registered = promise,
    "https://example.invalid/ops-api?action=scan_ses_makesafes",
    {},
    () => {
      settled = true;
      return Promise.resolve();
    },
    () => Promise.reject(new Error("source ledger unavailable")),
  );

  assert(registered);
  await assertRejects(() => registered!, Error, "source ledger unavailable");
  assertEquals(settled, false);
});

// ── Classifier: domain-boundary matching ──────────────────────────────────────
// SCHEMA NOTE: a raw group post has NO `subject`; collectPosts sets post.subject
// from the parent thread `topic`. `withTopic` mirrors that so classifier tests run
// against the same shape the classifier sees in production.
function withTopic(
  post: typeof FX_MLB_POST,
  topic: string,
): typeof FX_MLB_POST {
  return { ...post, subject: topic };
}

Deno.test("classifier: exact sender domain matches the company pattern", () => {
  // Subject comes from the THREAD topic (threaded onto the post by collectPosts).
  const r = _classifyPost(
    withTopic(FX_MLB_POST, FX_MLB_THREAD.topic!),
    COMPANIES,
  );
  assertEquals(r.include, true);
  assertEquals(r.reason, "sender:mlb");
  assertEquals(r.ref, "AJBR-67200");
});

Deno.test("classifier: subdomain of the pattern matches (dot-anchored suffix)", () => {
  const post = {
    ...FX_MLB_POST,
    from: { emailAddress: { address: "noreply.dispatch@notify.mlb.com.au" } },
    subject: "general note no ref",
  };
  const r = _classifyPost(post, COMPANIES);
  assertEquals(r.include, true);
  assertEquals(r.reason, "sender:mlb");
});

Deno.test("classifier: lookalike domain does NOT match (over-match rejection)", () => {
  // evilmlb.com.au must NOT match pattern mlb.com.au, and the thread topic has no ref.
  const r = _classifyPost(
    withTopic(FX_LOOKALIKE_SENDER_POST, FX_LOOKALIKE_SENDER_THREAD.topic!),
    COMPANIES,
  );
  assertEquals(r.include, false);
});

Deno.test("classifier: substring-but-not-suffix domain rejected", () => {
  assertEquals(
    _senderMatchesPattern("x@mlb.com.au.evil.test", "mlb.com.au"),
    false,
  );
  assertEquals(_senderMatchesPattern("x@evilmlb.com.au", "mlb.com.au"), false);
  assertEquals(_senderMatchesPattern("x@mlb.com.au", "mlb.com.au"), true);
  assertEquals(_senderMatchesPattern("x@sub.mlb.com.au", "mlb.com.au"), true);
});

Deno.test("classifier: non-make-safe post is excluded (audit-row caller path)", () => {
  const r = _classifyPost(
    withTopic(FX_NON_MAKESAFE_POST, FX_NON_MAKESAFE_THREAD.topic!),
    COMPANIES,
  );
  assertEquals(r.include, false);
});

Deno.test("classifier: subject ref with no sender match still includes", () => {
  const post = {
    ...FX_NON_MAKESAFE_POST,
    subject: "Please action AJBR-99999 urgently",
  };
  const r = _classifyPost(post, COMPANIES);
  assertEquals(r.include, true);
  assertEquals(r.reason, "subject_ref");
  assertEquals(r.ref, "AJBR-99999");
});

Deno.test("classifier: 'make safe' keyword in subject includes", () => {
  const post = {
    ...FX_NON_MAKESAFE_POST,
    subject: "Emergency make safe required tonight",
  };
  const r = _classifyPost(post, COMPANIES);
  assertEquals(r.include, true);
  assertEquals(r.reason, "subject_keyword");
});

Deno.test("classifier: the four pinned regression refs all classify make-safe", () => {
  // All four (Erskine 67200, Alexander Heights 67005, Tapping 67134, Bassendean
  // 67166) must be INCLUDED with a NON-NULL ref. B1: the classifier now extracts
  // bare-numeric (67005) and space-separated-prefix (AJBR 67134) forms too, so a
  // make-safe post is never persisted ref=null (the old D1-blind drop path).
  for (const fx of FX_PINNED_REGRESSION) {
    const post = { ...FX_NON_MAKESAFE_POST, subject: fx.subject };
    const r = _classifyPost(post, COMPANIES);
    assertEquals(r.include, true, `expected include for ${fx.subject}`);
    assertEquals(r.ref, fx.classifierRef, `classifier ref for ${fx.subject}`);
    // B1: classify-time ref must be non-null for every pinned make-safe subject.
    assertEquals(
      r.ref !== null,
      true,
      `B1: non-null classify ref for ${fx.subject}`,
    );
    // The recon-side normaliser canonicalises all four straight from the subject
    // (incl. the bare numeric 67005 and the space-separated AJBR 67134).
    assertEquals(
      _normaliseReconRef(fx.subject),
      fx.reconNorm,
      `recon norm for ${fx.subject}`,
    );
  }
});

// B1 — extractRef directly: spaced-prefix, bare-numeric, and body fallback.
Deno.test("extractRef: spaced/bare/body forms all yield a non-null ref (B1)", () => {
  // Space-separated prefix in subject.
  assertEquals(
    _extractRef("AJBR 67134 Tapping work order", null),
    "AJBR-67134",
  );
  // Bare-numeric core in subject (no prefix).
  assertEquals(_extractRef("Make Safe 67005 Alexander Heights", null), "67005");
  // Dashed prefix.
  assertEquals(_extractRef("MLB-67166 Bassendean", null), "MLB-67166");
  // No ref in subject -> body fallback (prefixed).
  assertEquals(
    _extractRef(
      "Emergency make safe tonight",
      "<p>ref AJBR 67999 attached</p>",
    ),
    "AJBR-67999",
  );
  // No ref in subject -> body fallback (bare numeric).
  assertEquals(
    _extractRef("make safe please", "job number 67500 confirmed"),
    "67500",
  );
  // Truly no ref anywhere -> null.
  assertEquals(_extractRef("make safe please", "no number here"), null);
});

Deno.test("extractRef: ABJR typo canonicalises before prefix matching (D7)", () => {
  assertEquals(_extractRef("Make Safe ABJR 67217", null), "AJBR-67217");
  assertEquals(
    _extractRef("make safe please", "<p>ref ABJR-69039 attached</p>"),
    "AJBR-69039",
  );
  assertEquals(_extractRef("ABJR 1234", null), null);
});

// ── B1 (STILL-OPEN fix) — MS-prefixed COMPACT refs ────────────────────────────
// "MS191190" is a real historically-dropped WO. Pre-fix the recognised prefix set
// was MLB|AJBR only and the bare-numeric fallback could NOT catch it (the digits
// are glued to the "S", so there is no \b before the digit run). It therefore fell
// to ref=null -> no pipeline_items row -> D1-blind drop. These prove the MS family
// is now recognised in compact, spaced, and dashed forms.
Deno.test("extractRef: MS-prefixed COMPACT ref 'MS191190' yields a non-null ref (B1 still-open)", () => {
  assertEquals(_extractRef("MS191190", null), "MS-191190");
  assertEquals(
    _extractRef("RE: MS191190 emergency make safe", null),
    "MS-191190",
  );
  // Spaced + dashed MS variants too.
  assertEquals(_extractRef("MS 191190 attend tonight", null), "MS-191190");
  assertEquals(_extractRef("Work Order MS-191190", null), "MS-191190");
  // Body fallback for a compact MS ref.
  assertEquals(
    _extractRef("make safe please", "<p>job MS191190 attached</p>"),
    "MS-191190",
  );
});

Deno.test("normaliseRef: compact MS ref collapses to MS-191190 (default prefix floor)", () => {
  assertEquals(_normaliseRef("MS191190"), "MS-191190");
  assertEquals(_normaliseRef("ms-191190"), "MS-191190");
  assertEquals(_normaliseRef("MS 191190"), "MS-191190");
});

Deno.test("classifyPost: an MS-prefixed subject classifies make-safe with a non-null ref (B1 still-open)", () => {
  // No sender match (random domain), subject carries only the compact MS ref. It
  // must still INCLUDE (subject_ref) with a NON-NULL ref so persistPost writes a
  // pipeline_items row instead of silently dropping it.
  const post = {
    ...FX_NON_MAKESAFE_POST,
    subject: "MS191190 emergency make safe",
  };
  const r = _classifyPost(post, COMPANIES);
  assertEquals(r.include, true);
  assertEquals(r.reason, "subject_ref");
  assertEquals(r.ref, "MS-191190");
  assertEquals(r.ref !== null, true);
});

// ── B1 — the prefix set is DATA-DRIVEN from makesafe_companies ─────────────────
// A company-defined ref prefix (parsing_rules.ref_prefixes) must be recognised
// WITHOUT a code change. extractRefPrefixes parses the company shape; passing the
// derived set to classifyPost/extractRef recognises a brand-new family ("KBA").
Deno.test("extractRefPrefixes: pulls ref_prefixes from a company parsing_rules shape", () => {
  assertEquals(
    _extractRefPrefixes({ ref_prefixes: ["KBA", "kbz"] }),
    ["KBA", "KBZ"],
  );
  // Tolerant of a single-string shape + absence.
  assertEquals(_extractRefPrefixes({ ref_prefixes: "qbcc" }), ["QBCC"]);
  assertEquals(_extractRefPrefixes({}), []);
  assertEquals(_extractRefPrefixes(null), []);
});

Deno.test("classifyPost: a DATA-DRIVEN company prefix ('KBA') is recognised code-free (B1)", () => {
  // COMPACT "KBA88123": the static floor does NOT include KBA, AND the bare-numeric
  // fallback cannot catch it (digits glued to the "A" -> no \b before the run), so
  // with the floor-only set it drops to ref=null -- exactly the MS191190 class of
  // bug. The DATA-DRIVEN prefix set is the only thing that recovers it.
  const post = {
    ...FX_NON_MAKESAFE_POST,
    subject: "KBA88123 make safe Joondalup",
  };
  // Default (floor-only) set: no KBA prefix + glued digits -> null (the drop).
  assertEquals(_classifyPost(post, COMPANIES).ref, null);
  // Data-driven set (floor UNION company prefixes) -> prefixed canonical form.
  const driven = _classifyPost(post, COMPANIES, [
    ..._DEFAULT_REF_PREFIXES,
    "KBA",
  ]);
  assertEquals(driven.include, true);
  assertEquals(driven.ref, "KBA-88123");
});

// ── Ref normalisation ─────────────────────────────────────────────────────────
Deno.test("normaliseRef: spaced/dashed/bare forms collapse consistently", () => {
  assertEquals(_normaliseRef("AJBR 67200"), "AJBR-67200");
  assertEquals(_normaliseRef("AJBR-67200"), "AJBR-67200");
  assertEquals(_normaliseRef("ajbr67200"), "AJBR-67200");
  assertEquals(_normaliseRef("67200"), "67200");
  assertEquals(_normaliseRef(null), null);
});

Deno.test("parseSenderDomain: extracts lowercased domain", () => {
  assertEquals(_parseSenderDomain("Dispatch@MLB.com.au"), "mlb.com.au");
  assertEquals(_parseSenderDomain("no-at-sign"), null);
  assertEquals(_parseSenderDomain(null), null);
});

// ── PDF magic-byte validation ─────────────────────────────────────────────────
Deno.test("isPdfMagic: accepts %PDF, rejects others", () => {
  const okBytes = Uint8Array.from(
    atob(FX_PDF_ATTACHMENT.contentBytes!),
    (c) => c.charCodeAt(0),
  );
  assertEquals(_isPdfMagic(okBytes), true);
  assertEquals(_isPdfMagic(new Uint8Array([0x3c, 0x68, 0x74, 0x6d])), false); // <htm
  assertEquals(_isPdfMagic(new Uint8Array([0x25])), false); // too short
});

// ── Pagination: @odata.nextLink exhaustion ────────────────────────────────────
function pageResponse(values: any[], nextLink?: string): Response {
  const body: any = { value: values };
  if (nextLink) body["@odata.nextLink"] = nextLink;
  return new Response(JSON.stringify(body), { status: 200 });
}

Deno.test("graphGetAll: drains all pages via @odata.nextLink", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  // 3 pages.
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (url: string) => {
    calls.push(url);
    if (url === "page1") {
      return Promise.resolve(pageResponse([{ id: "a" }, { id: "b" }], "page2"));
    }
    if (url === "page2") {
      return Promise.resolve(pageResponse([{ id: "c" }], "page3"));
    }
    if (url === "page3") return Promise.resolve(pageResponse([{ id: "d" }]));
    throw new Error("unexpected url " + url);
  };
  try {
    const { values, pages } = await _graphGetAll<{ id: string }>(
      "page1",
      "tok",
    );
    assertEquals(values.map((v) => v.id), ["a", "b", "c", "d"]);
    assertEquals(pages, 3);
    assertEquals(calls, ["page1", "page2", "page3"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("graphGetAll: a thread gaining a post after page 1 is captured (re-poll coverage)", async () => {
  // Simulates the MISSION.md threaded re-poll requirement at the pagination level:
  // the second page (fetched after the first) contains a post that did not exist
  // when page 1 was served. Exhaustion must still pick it up.
  const realFetch = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (url: string) => {
    if (url === "thread-posts") {
      return Promise.resolve(
        pageResponse([{ id: "post-1" }], "thread-posts-p2"),
      );
    }
    if (url === "thread-posts-p2") {
      // post-2 is the NEW reply that arrived between page fetches.
      return Promise.resolve(pageResponse([{ id: "post-2-new-reply" }]));
    }
    throw new Error("unexpected url " + url);
  };
  try {
    const { values } = await _graphGetAll<{ id: string }>(
      "thread-posts",
      "tok",
    );
    assertEquals(values.map((v) => v.id), ["post-1", "post-2-new-reply"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("graphGetAll: 429 Retry-After is respected then the page succeeds", async () => {
  const realFetch = globalThis.fetch;
  let n = 0;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (_url: string) => {
    n++;
    if (n === 1) {
      return Promise.resolve(
        new Response("throttled", {
          status: 429,
          headers: { "Retry-After": "0" },
        }),
      );
    }
    return Promise.resolve(pageResponse([{ id: "z" }]));
  };
  try {
    const { values, pages } = await _graphGetAll<{ id: string }>(url0(), "tok");
    assertEquals(values.map((v) => v.id), ["z"]);
    assertEquals(pages, 1);
    assertEquals(n, 2); // one 429 retry + one success
  } finally {
    globalThis.fetch = realFetch;
  }
});
function url0() {
  return "throttled-url";
}

Deno.test("fallback mailbox: ses-addressed Prime messages are collected for intake", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (url: string) => {
    calls.push(url);
    if (
      url.includes(
        "/users/marnin%40secureworkswa.com.au/mailFolders/inbox/messages",
      )
    ) {
      return Promise.resolve(pageResponse([{
        id: "user-msg-26109",
        internetMessageId: "<prime-26109@example.test>",
        conversationId: "conv-user-26109",
        receivedDateTime: new Date().toISOString(),
        from: {
          emailAddress: { address: "noreply@notifications.primeeco.tech" },
        },
        toRecipients: [{
          emailAddress: { address: "ses@secureworkswa.com.au" },
        }],
        subject:
          "NEW WORK ORDER - MLB-26109 49 Shearers Cl, Quedjinup, WA 6281",
        hasAttachments: true,
        body: {
          contentType: "html",
          content: "Shed make safe attendance required",
        },
      }]));
    }
    throw new Error("unexpected url " + url);
  };
  try {
    const since = new Date(Date.now() - 60_000).toISOString();
    const { posts, pages } = await _collectFallbackMailboxPosts("tok", since);
    assertEquals(pages, 1);
    assertEquals(posts.length, 1);
    assertEquals(posts[0].sourceKind, "mailbox_message");
    assertEquals(posts[0].mailboxAddress, "marnin@secureworkswa.com.au");
    assertEquals(
      posts[0].subject,
      "NEW WORK ORDER - MLB-26109 49 Shearers Cl, Quedjinup, WA 6281",
    );
    const cls = _classifyPost(posts[0], COMPANIES);
    assertEquals(cls.include, true);
    assertEquals(cls.ref, "MLB-26109");
    assert(calls[0].includes("receivedDateTime%20ge"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── collectPosts: Graph schema fix (subject from THREAD topic, not the post) ───
// Regression for the live 400: "Could not find a property named 'subject' on type
// 'Microsoft.OutlookServices.Post'". A group POST carries NO `subject` /
// `internetMessageId`; the subject lives on the THREAD as `topic`. collectPosts must
// (a) request ONLY valid Post props (no subject / internetMessageId) in the post
// $select, (b) request `topic` (+ the other valid thread props) in the thread
// $select, and (c) thread the thread topic into each post's `subject` so the
// classifier can extract the ref (e.g. AJBR-67200) from it.
Deno.test("collectPosts: subject comes from the THREAD topic; post $select omits subject/internetMessageId", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  const GROUP = "group-1";
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (url: string) => {
    calls.push(url);
    // conversations
    if (url.includes("/conversations?")) {
      return Promise.resolve(
        pageResponse([{
          id: "conv-67200",
          lastDeliveredDateTime: "2026-06-13T01:00:00Z",
        }]),
      );
    }
    // threads under the conversation — MUST carry `topic` (the subject lives here)
    if (url.includes("/conversations/conv-67200/threads")) {
      return Promise.resolve(pageResponse([{
        id: FX_MLB_THREAD.id,
        topic: FX_MLB_THREAD.topic,
        lastDeliveredDateTime: FX_MLB_THREAD.lastDeliveredDateTime,
        hasAttachments: FX_MLB_THREAD.hasAttachments,
        toRecipients: FX_MLB_THREAD.toRecipients,
      }]));
    }
    // posts under the thread — RAW posts: NO subject, NO internetMessageId.
    if (url.includes(`/threads/${FX_MLB_THREAD.id}/posts`)) {
      return Promise.resolve(pageResponse([{
        id: FX_MLB_POST.id,
        conversationId: FX_MLB_POST.conversationId,
        conversationThreadId: FX_MLB_POST.conversationThreadId,
        createdDateTime: FX_MLB_POST.createdDateTime,
        receivedDateTime: FX_MLB_POST.receivedDateTime,
        from: FX_MLB_POST.from,
        hasAttachments: FX_MLB_POST.hasAttachments,
        body: FX_MLB_POST.body,
      }]));
    }
    throw new Error("unexpected url " + url);
  };
  try {
    const { posts } = await _collectPosts(
      "tok",
      GROUP,
      new Date(0).toISOString(),
    );

    // The post $select MUST NOT request subject or internetMessageId (the 400 cause).
    const postSelectCall = calls.find((c) =>
      c.includes(`/threads/${FX_MLB_THREAD.id}/posts`)
    )!;
    assert(postSelectCall, "expected a posts $select call");
    assert(
      !/[?&]\$select=[^&]*\bsubject\b/.test(postSelectCall),
      "post $select must NOT request subject",
    );
    assert(
      !/[?&]\$select=[^&]*internetMessageId/.test(postSelectCall),
      "post $select must NOT request internetMessageId",
    );

    // The thread $select MUST request topic (so we can source the subject).
    const threadSelectCall = calls.find((c) =>
      c.includes("/threads") && c.includes("conv-67200")
    )!;
    assert(
      /\$select=[^&]*\btopic\b/.test(threadSelectCall),
      "thread $select must request topic",
    );
    assert(
      /\$select=[^&]*lastDeliveredDateTime/.test(threadSelectCall),
      "thread $select must request lastDeliveredDateTime",
    );
    assert(
      /\$select=[^&]*toRecipients/.test(threadSelectCall),
      "thread $select must request toRecipients",
    );

    // The collected post's subject is the THREAD topic, and recipients are threaded.
    assertEquals(posts.length, 1);
    assertEquals(posts[0].subject, FX_MLB_THREAD.topic);
    assertEquals(posts[0].toRecipients, FX_MLB_THREAD.toRecipients);

    // The classifier extracts the ref from the topic-sourced subject (AJBR-67200).
    const cls = _classifyPost(posts[0], COMPANIES);
    assertEquals(cls.include, true);
    assertEquals(cls.ref, "AJBR-67200");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// A reply post (no subject of its own) STILL inherits the thread topic as subject,
// so a threaded reply classifies against the same ref as the parent.
Deno.test("collectPosts: a threaded reply inherits the thread topic as its subject", async () => {
  const realFetch = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (url: string) => {
    if (url.includes("/conversations?")) {
      return Promise.resolve(
        pageResponse([{
          id: "conv-67200",
          lastDeliveredDateTime: "2026-06-13T02:30:00Z",
        }]),
      );
    }
    if (url.includes("/conversations/conv-67200/threads")) {
      return Promise.resolve(
        pageResponse([{ id: FX_MLB_THREAD.id, topic: FX_MLB_THREAD.topic }]),
      );
    }
    if (url.includes(`/threads/${FX_MLB_THREAD.id}/posts`)) {
      // Raw reply post: NO subject of its own.
      return Promise.resolve(pageResponse([{
        id: FX_MLB_THREAD_REPLY.id,
        conversationThreadId: FX_MLB_THREAD_REPLY.conversationThreadId,
        receivedDateTime: FX_MLB_THREAD_REPLY.receivedDateTime,
        from: FX_MLB_THREAD_REPLY.from,
        body: FX_MLB_THREAD_REPLY.body,
      }]));
    }
    throw new Error("unexpected url " + url);
  };
  try {
    const { posts } = await _collectPosts(
      "tok",
      "g",
      new Date(0).toISOString(),
    );
    assertEquals(posts.length, 1);
    assertEquals(posts[0].subject, FX_MLB_THREAD.topic);
    const cls = _classifyPost(posts[0], COMPANIES);
    assertEquals(cls.ref, "AJBR-67200");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── persistPost: internet_message_id is ALWAYS null (not a Post property) ──────
// Group posts have no internetMessageId. Dedup is on post.id (the emails ON
// CONFLICT(post_id) key); emails.internet_message_id is written null.
Deno.test("persistPost: emails row stores internet_message_id=null and subject=thread topic; dedup is post_id", async () => {
  const upserts: Record<string, any[]> = {};
  // deno-lint-ignore no-explicit-any
  const sb: any = {
    from(table: string) {
      const chain: any = {
        upsert: (row: any, opts?: any) => {
          (upserts[table] ||= []).push({ row, opts });
          return Promise.resolve({ error: null, data: null });
        },
        insert: (_row: any) => ({
          select: () => ({
            single: () =>
              Promise.resolve({ data: { id: "ev-1" }, error: null }),
          }),
        }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }), // attachments_settled marker
        select: () => chain,
        eq: () => chain,
        ilike: () => chain,
        in: () => chain,
        limit: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      };
      return chain;
    },
  };
  // The post as collectPosts produces it: subject = thread topic, no internetMessageId.
  const post = {
    ...FX_MLB_POST,
    subject: FX_MLB_THREAD.topic!,
    hasAttachments: false,
  };
  const cls = _classifyPost(post, COMPANIES);
  await _persistPost(sb, "tok", "group-1", post, cls);

  const emailUpsert = upserts["emails"]?.[0];
  assert(emailUpsert, "expected an emails upsert");
  assertEquals(emailUpsert.row.internet_message_id, null);
  assertEquals(emailUpsert.row.subject, FX_MLB_THREAD.topic);
  assertEquals(emailUpsert.row.post_id, FX_MLB_POST.id);
  assertEquals(emailUpsert.opts?.onConflict, "post_id"); // dedup is on post id
});

// ── Attachment routing (processAttachments) ───────────────────────────────────
// Stub sb: records every email_attachments upsert + storage upload; returns no
// prior attempts / no existing uploaded row (so the happy path uploads).
function makeAttachmentSb() {
  const upserts: any[] = [];
  const uploads: Array<{ path: string }> = [];
  const sb: any = {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({ data: null, error: null }),
                  };
                },
                maybeSingle: async () => ({ data: null, error: null }),
              };
            },
          };
        },
        upsert: async (row: any, _o?: any) => {
          if (table === "email_attachments") upserts.push(row);
          return { error: null };
        },
        // Supersede step: processAttachments deletes stale synthetic placeholders
        // after a successful fetch with real attachments. .delete().eq().in().
        delete() {
          return {
            eq() {
              return { in: async () => ({ error: null }) };
            },
          };
        },
      };
    },
    storage: {
      from() {
        return {
          upload: async (path: string, _bytes: Uint8Array, _o?: any) => {
            uploads.push({ path });
            return { error: null };
          },
          remove: async (_paths: string[]) => ({ error: null }),
        };
      },
    },
  };
  return { sb, upserts, uploads };
}

function attListResponse(atts: any[]): Response {
  // Attachments are now fetched via GET post?$expand=attachments (app-only), whose
  // body shape is { attachments: [...] } (NOT the old /attachments list { value: [...] }).
  return new Response(JSON.stringify({ attachments: atts }), { status: 200 });
}

async function runProcessAttachments(atts: any[]) {
  const { sb, upserts, uploads } = makeAttachmentSb();
  const realFetch = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (_url: string) =>
    Promise.resolve(attListResponse(atts));
  try {
    const post = { ...FX_MLB_POST, hasAttachments: true };
    const unresolved = await _processAttachments(
      sb,
      "tok",
      "group-1",
      post as any,
    );
    return { unresolved, upserts, uploads };
  } finally {
    globalThis.fetch = realFetch;
  }
}

Deno.test("attachments: a valid PDF is uploaded (status uploaded), 0 unresolved", async () => {
  const { unresolved, upserts, uploads } = await runProcessAttachments([
    FX_PDF_ATTACHMENT,
  ]);
  assertEquals(unresolved, 0);
  assertEquals(uploads.length, 1);
  const finalRow = upserts.find((r) => r.status === "uploaded");
  assertEquals(!!finalRow, true);
  assertEquals(typeof finalRow.sha256, "string");
});

Deno.test("attachments: referenceAttachment routes to needs_review", async () => {
  const { unresolved, upserts, uploads } = await runProcessAttachments([
    FX_REFERENCE_ATTACHMENT,
  ]);
  assertEquals(unresolved, 1);
  assertEquals(uploads.length, 0);
  assertEquals(upserts[0].status, "needs_review");
});

Deno.test("attachments: itemAttachment routes to needs_review", async () => {
  const { unresolved, upserts } = await runProcessAttachments([
    FX_ITEM_ATTACHMENT,
  ]);
  assertEquals(unresolved, 1);
  assertEquals(upserts[0].status, "needs_review");
});

Deno.test("attachments: inline attachment is skipped (benign, non-blocking)", async () => {
  const { unresolved, upserts } = await runProcessAttachments([
    FX_INLINE_ATTACHMENT,
  ]);
  assertEquals(unresolved, 0); // skipped is resolved-as-skipped, NOT unresolved
  assertEquals(upserts[0].status, "skipped");
  assertEquals(upserts[0].attachment_kind, "inline");
});

Deno.test("attachments: PDF with no inline contentBytes routes to needs_review (value-path required, app-only can't fetch)", async () => {
  const { unresolved, upserts, uploads } = await runProcessAttachments([
    FX_OVERSIZE_ATTACHMENT,
  ]);
  assertEquals(unresolved, 1);
  assertEquals(uploads.length, 0);
  assertEquals(upserts[0].status, "needs_review");
  assertEquals(
    upserts[0].last_error,
    "pdf_no_inline_bytes_value_path_required",
  );
});

Deno.test("attachments: non-PDF file attachment is skipped (PDF-only policy, non-blocking)", async () => {
  const { unresolved, upserts, uploads } = await runProcessAttachments([
    FX_NON_PDF_FILE_ATTACHMENT,
  ]);
  assertEquals(unresolved, 0); // skipped is resolved-as-skipped, NOT unresolved
  assertEquals(uploads.length, 0);
  assertEquals(upserts[0].status, "skipped");
  assertEquals(upserts[0].last_error, "non_pdf_file_attachment_skipped");
});

Deno.test("attachments: a fake-PDF (claims pdf, bad magic bytes) is marked failed", async () => {
  const { unresolved, upserts, uploads } = await runProcessAttachments([
    FX_FAKE_PDF_ATTACHMENT,
  ]);
  assertEquals(unresolved, 1);
  assertEquals(uploads.length, 0);
  const failed = upserts.find((r) => r.status === "failed");
  assertEquals(!!failed, true);
  assertEquals(failed.last_error, "pdf_magic_byte_validation_failed");
});

Deno.test("attachments: a post with hasAttachments=false does no work", async () => {
  const { sb } = makeAttachmentSb();
  const post = { ...FX_MLB_POST, hasAttachments: false };
  const unresolved = await _processAttachments(
    sb,
    "tok",
    "group-1",
    post as any,
  );
  assertEquals(unresolved, 0);
});

// ── Silent-drop failure cases (attachment INVARIANT) ──────────────────────────
// Every attachment failure branch must leave a DURABLE email_attachments row OR
// fail closed (throw, so the run does not advance the watermark). These cases
// drive the REAL _processAttachments with stubs and assert a durable row OR a
// throw — never a path that returns/continues leaving no record.

// Configurable stub: inject an upsert error (always, or only for rows matching a
// predicate) and/or a storage upload error. Records every upsert + upload + remove.
function makeConfigurableAttachmentSb(opts: {
  // Return an error for an email_attachments upsert when this predicate matches the
  // row being written (default: never error).
  upsertError?: (row: any) => string | null;
  // Return an error string for a storage upload (default: no error).
  uploadError?: string | null;
} = {}) {
  const upserts: any[] = [];
  const uploads: Array<{ path: string }> = [];
  const removes: string[][] = [];
  const sb: any = {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({ data: null, error: null }),
                  };
                },
                maybeSingle: async () => ({ data: null, error: null }),
              };
            },
          };
        },
        upsert: async (row: any, _o?: any) => {
          if (table === "email_attachments") {
            upserts.push(row);
            const msg = opts.upsertError ? opts.upsertError(row) : null;
            if (msg) return { error: { message: msg } };
          }
          return { error: null };
        },
        // Supersede step: .delete().eq().in() of stale synthetic placeholders.
        delete() {
          return {
            eq() {
              return { in: async () => ({ error: null }) };
            },
          };
        },
      };
    },
    storage: {
      from() {
        return {
          upload: async (path: string, _bytes: Uint8Array, _o?: any) => {
            uploads.push({ path });
            if (opts.uploadError) {
              return { error: { message: opts.uploadError } };
            }
            return { error: null };
          },
          remove: async (paths: string[]) => {
            removes.push(paths);
            return { error: null };
          },
        };
      },
    },
  };
  return { sb, upserts, uploads, removes };
}

// Drive _processAttachments with a configurable sb + an attachment-list fetch that
// either returns the given attachments OR fails (status 500 / network throw).
async function runWith(
  atts: any[],
  sbBundle: ReturnType<typeof makeConfigurableAttachmentSb>,
  listMode: "ok" | "http500" | "throw" = "ok",
) {
  const realFetch = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (_url: string) => {
    if (listMode === "throw") return Promise.reject(new Error("network down"));
    if (listMode === "http500") {
      return Promise.resolve(new Response("graph boom", { status: 500 }));
    }
    return Promise.resolve(attListResponse(atts));
  };
  try {
    const post = { ...FX_MLB_POST, hasAttachments: true };
    const unresolved = await _processAttachments(
      sbBundle.sb,
      "tok",
      "group-1",
      post as any,
    );
    return { unresolved };
  } finally {
    globalThis.fetch = realFetch;
  }
}

// FINDING 1 — list fetch fails AND the failed-placeholder upsert ALSO fails -> the
// run must FAIL CLOSED (throw), so the watermark is not advanced past an unrecorded
// attachment failure. (Pre-fix this logged and returned 1, silently dropping it.)
Deno.test("attachments [FINDING 1]: list-fetch failure + placeholder upsert failure -> THROWS (fail closed)", async () => {
  const sbBundle = makeConfigurableAttachmentSb({
    // The placeholder row uses the synthetic list-fetch id; error it too.
    upsertError: (row) =>
      row.graph_attachment_id === "_list_fetch_failed"
        ? "db down on placeholder"
        : null,
  });
  let threw = false;
  try {
    await runWith([], sbBundle, "http500");
  } catch (e) {
    threw = true;
    assert(
      (e as Error).message.includes("failed-placeholder upsert failed"),
      `expected fail-closed throw, got: ${(e as Error).message}`,
    );
  }
  assertEquals(
    threw,
    true,
    "must throw when both the list fetch AND the placeholder write fail",
  );
  // It DID attempt to record the placeholder (durable-record-first), then threw.
  assertEquals(sbBundle.upserts.length, 1);
  assertEquals(sbBundle.upserts[0].graph_attachment_id, "_list_fetch_failed");
});

// FINDING 1 (positive control) — list fetch fails but the placeholder upsert
// SUCCEEDS -> a durable failed row, return 1 (DEGRADED), NO throw.
Deno.test("attachments [FINDING 1]: list-fetch failure with a successful placeholder -> durable failed row, no throw", async () => {
  const sbBundle = makeConfigurableAttachmentSb();
  const { unresolved } = await runWith([], sbBundle, "throw");
  assertEquals(unresolved, 1);
  assertEquals(sbBundle.upserts.length, 1);
  assertEquals(sbBundle.upserts[0].graph_attachment_id, "_list_fetch_failed");
  assertEquals(sbBundle.upserts[0].status, "failed");
  // last_error now carries the REAL Graph/fetch error, prefixed with the label.
  assert(
    String(sbBundle.upserts[0].last_error).startsWith(
      "attachment_list_fetch_failed",
    ),
    `last_error should start with the label, got: ${
      sbBundle.upserts[0].last_error
    }`,
  );
});

// FINDING 2 — hasAttachments=true but Graph returns a SUCCESSFUL EMPTY list. Pre-fix
// the loop did not run and we returned 0 -> silent drop. Now a synthetic
// needs_review row (non-null id) is written and counted as unresolved (DEGRADED).
Deno.test("attachments [FINDING 2]: hasAttachments=true + empty list -> synthetic needs_review row, unresolved=1", async () => {
  const sbBundle = makeConfigurableAttachmentSb();
  const { unresolved } = await runWith([], sbBundle, "ok");
  assertEquals(
    unresolved,
    1,
    "an empty list under hasAttachments=true must be unresolved (DEGRADED)",
  );
  assertEquals(sbBundle.upserts.length, 1);
  const row = sbBundle.upserts[0];
  assertEquals(row.graph_attachment_id, "_hasattachments_true_empty_list");
  assert(row.graph_attachment_id !== null, "synthetic id must be non-null");
  assertEquals(row.status, "needs_review");
  assertEquals(row.last_error, "hasAttachments_true_but_empty_list");
});

// FINDING 2 (fail-closed) — empty list AND the synthetic upsert fails -> THROW.
Deno.test("attachments [FINDING 2]: empty list + synthetic upsert failure -> THROWS (fail closed)", async () => {
  const sbBundle = makeConfigurableAttachmentSb({
    upsertError: (row) =>
      row.graph_attachment_id === "_hasattachments_true_empty_list"
        ? "db down"
        : null,
  });
  let threw = false;
  try {
    await runWith([], sbBundle, "ok");
  } catch (e) {
    threw = true;
    assert((e as Error).message.includes("empty-list synthetic upsert failed"));
  }
  assertEquals(
    threw,
    true,
    "must fail closed when the synthetic empty-list row cannot be written",
  );
});

// FINDING 3 (sweep) — Storage upload failure -> a durable FAILED row is recorded
// (the bytes never landed, the row tracks the failure for the retry worker).
Deno.test("attachments [FINDING 3]: storage upload failure -> durable failed row, unresolved=1", async () => {
  const sbBundle = makeConfigurableAttachmentSb({ uploadError: "bucket 503" });
  const { unresolved } = await runWith([FX_PDF_ATTACHMENT], sbBundle, "ok");
  assertEquals(unresolved, 1);
  const failed = sbBundle.upserts.find((r) => r.status === "failed");
  assert(
    !!failed,
    "expected a durable failed row after a storage upload failure",
  );
  assert(
    String(failed.last_error).startsWith("storage_upload_failed:"),
    `last_error should record the storage failure, got: ${failed.last_error}`,
  );
});

// FINDING 3 (sweep) — DB row upsert failure AFTER a successful upload -> the
// orphaned object is removed AND a durable failed row is recorded (no silent skip).
Deno.test("attachments [FINDING 3]: row upsert failure after upload -> orphan cleanup + failed row", async () => {
  const sbBundle = makeConfigurableAttachmentSb({
    // Error ONLY the success ("uploaded") row write; the subsequent markAttachmentFailed
    // ("failed") write must succeed so a durable failed row is left.
    upsertError: (
      row,
    ) => (row.status === "uploaded" ? "row write conflict" : null),
  });
  const { unresolved } = await runWith([FX_PDF_ATTACHMENT], sbBundle, "ok");
  assertEquals(unresolved, 1);
  // The object we wrote was cleaned up (M4 orphan delete).
  assertEquals(sbBundle.removes.length, 1);
  assertEquals(sbBundle.uploads.length, 1);
  assertEquals(sbBundle.removes[0][0], sbBundle.uploads[0].path);
  // A durable failed row remains for the retry worker.
  const failed = sbBundle.upserts.find((r) => r.status === "failed");
  assert(!!failed, "expected a durable failed row after the orphaned upload");
  assert(String(failed.last_error).startsWith("row_upsert_failed:"));
});

// FINDING 3 (sweep) — DB row upsert failure after upload where the FAILED write
// ALSO fails -> fail closed (throw), never a silent skip.
Deno.test("attachments [FINDING 3]: upload ok but BOTH row writes fail -> THROWS (fail closed)", async () => {
  const sbBundle = makeConfigurableAttachmentSb({
    upsertError: () => "db totally down", // both the uploaded row and the failed row error
  });
  let threw = false;
  try {
    await runWith([FX_PDF_ATTACHMENT], sbBundle, "ok");
  } catch (e) {
    threw = true;
    assert((e as Error).message.includes("markAttachmentFailed upsert failed"));
  }
  assertEquals(
    threw,
    true,
    "must fail closed when neither the uploaded nor the failed row can be written",
  );
  // The orphan was still cleaned up before the throw.
  assertEquals(sbBundle.removes.length, 1);
});

// FINDING 4 — invalid base64 contentBytes -> a durable failed row is recorded.
Deno.test("attachments [FINDING 4]: invalid base64 -> durable failed row (base64_decode_failed)", async () => {
  const badB64Pdf = {
    id: "att-badb64-1",
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: "Work Order.pdf",
    contentType: "application/pdf",
    size: 10,
    isInline: false,
    contentBytes: "%%%not-valid-base64%%%", // atob throws on these chars
  };
  const sbBundle = makeConfigurableAttachmentSb();
  const { unresolved } = await runWith([badB64Pdf], sbBundle, "ok");
  assertEquals(unresolved, 1);
  assertEquals(
    sbBundle.uploads.length,
    0,
    "must not upload anything for undecodable bytes",
  );
  const failed = sbBundle.upserts.find((r) => r.status === "failed");
  assert(!!failed, "expected a durable failed row for invalid base64");
  assertEquals(failed.last_error, "base64_decode_failed");
});

// ── M5 — ingestion-level persistPost: spaced/bare refs DO create a pipeline_items
// row with a non-null ref (validates B1 end-to-end at the real persist path, not
// just the downstream recon recovery). This is the test Codex flagged as missing:
// the recon tests proved recovery, but nothing proved the actual persist path now
// writes a pipeline_items row for the previously-dropped bare/spaced cases. ──
function makePersistSb() {
  const writes: Array<{ table: string; op: string; row: any }> = [];
  function builder(table: string): any {
    const b: any = {
      select: () => b,
      eq: () => b,
      ilike: () => b,
      in: () => b,
      limit: async () => ({ data: [], error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({
        data: { id: `ev-${writes.length}` },
        error: null,
      }),
      upsert: async (row: any, _o?: any) => {
        writes.push({ table, op: "upsert", row });
        return { error: null };
      },
      // persistPost's final attachments_settled marker: .update(...).eq("post_id", id).
      update: (row: any) => ({
        eq: async (_c: string, _v: unknown) => {
          writes.push({ table, op: "update", row });
          return { error: null };
        },
      }),
      insert: (row: any) => {
        writes.push({ table, op: "insert", row });
        // email_events_raw.insert(...).select("id").single() chain.
        return {
          select: () => ({
            single: async () => ({
              data: { id: `ev-${writes.length}` },
              error: null,
            }),
          }),
          then: (resolve: (v: any) => any) => resolve({ error: null }),
        };
      },
    };
    return b;
  }
  return { sb: { from: (t: string) => builder(t) }, writes };
}

async function persistAndGetPipelineItem(subject: string) {
  const { sb, writes } = makePersistSb();
  const post = { ...FX_MLB_POST, subject, hasAttachments: false };
  const cls = _classifyPost(post as any, COMPANIES);
  await _persistPost(sb as any, "tok", "group-1", post as any, cls);
  const pi = writes.find((w) =>
    w.table === "pipeline_items" && w.op === "upsert"
  );
  return { pi, cls, writes };
}

Deno.test("persistPost: a SPACE-separated ref ('AJBR 67134') writes a pipeline_items row with a non-null ref (B1)", async () => {
  const { pi, cls } = await persistAndGetPipelineItem(
    "AJBR 67134 Tapping work order",
  );
  assertEquals(cls.include, true);
  assertEquals(cls.ref, "AJBR-67134");
  assertEquals(!!pi, true, "expected a pipeline_items upsert");
  assertEquals(pi!.row.ref, "AJBR-67134");
  assertEquals(pi!.row.ref !== null, true);
});

Deno.test("persistPost: a BARE-numeric ref ('Make Safe 67005') writes a pipeline_items row with a non-null ref (B1)", async () => {
  const { pi, cls } = await persistAndGetPipelineItem(
    "Make Safe 67005 Alexander Heights",
  );
  assertEquals(cls.include, true);
  assertEquals(cls.ref, "67005");
  assertEquals(!!pi, true, "expected a pipeline_items upsert");
  assertEquals(pi!.row.ref, "67005");
  assertEquals(pi!.row.ref !== null, true);
});

// B1 STILL-OPEN, proven END-TO-END: the previously-dropped compact MS ref must
// now drive the REAL persist path to a pipeline_items row (not just classify).
// This is the trace that closes the MS drop: classify -> non-null ref -> a
// pipeline_items row exists -> D1 can see it.
Deno.test("persistPost: a COMPACT MS ref ('MS191190') writes a pipeline_items row with a non-null ref (B1 still-open)", async () => {
  const { pi, cls } = await persistAndGetPipelineItem(
    "MS191190 emergency make safe Marangaroo",
  );
  assertEquals(cls.include, true);
  assertEquals(cls.ref, "MS-191190");
  assertEquals(!!pi, true, "expected a pipeline_items upsert for the MS ref");
  assertEquals(pi!.row.ref, "MS-191190");
  assertEquals(pi!.row.ref !== null, true);
  // The append-only replay log also records the extracted ref (rebuildability).
  const { writes } = await persistAndGetPipelineItem(
    "MS191190 emergency make safe Marangaroo",
  );
  const ev = writes.find((w) =>
    w.table === "email_events_raw" && w.op === "insert"
  );
  assertEquals(!!ev, true, "expected an email_events_raw audit row");
  assertEquals(ev!.row.extracted_ref, "MS-191190");
});

// One more real-world variant: an MS ref carried only in the email BODY (subject
// is a generic "make safe" line) must still reach a pipeline_items row.
Deno.test("persistPost: an MS ref in the BODY (generic subject) still writes a pipeline_items row (B1)", async () => {
  const { sb, writes } = makePersistSb();
  const post = {
    ...FX_MLB_POST,
    subject: "Emergency make safe tonight",
    body: {
      contentType: "html",
      content: "<p>Please attend, ref MS191190 attached.</p>",
    },
    hasAttachments: false,
  };
  const cls = _classifyPost(post as any, COMPANIES);
  assertEquals(cls.include, true);
  assertEquals(cls.ref, "MS-191190");
  await _persistPost(sb as any, "tok", "group-1", post as any, cls);
  const pi = writes.find((w) =>
    w.table === "pipeline_items" && w.op === "upsert"
  );
  assertEquals(
    !!pi,
    true,
    "expected a pipeline_items upsert from a body-only MS ref",
  );
  assertEquals(pi!.row.ref, "MS-191190");
});

// ════════════════════════════════════════════════════════════
// FINDING 1 (parity, end-to-end) — a COMPANY-SUPPLIED prefix ("KBA"), configured
// only via makesafe_companies.parsing_rules.ref_prefixes, flows through BOTH:
//   (a) monitor ingestion: loadCompanyPatterns derives the prefix set from the DB,
//       classify yields a NON-NULL ref, persist writes a pipeline_items row; AND
//   (b) recon D1: an email "KBA-88123" matches a board job ref "KBA88123".
// This proves the shared module (the SINGLE source of truth used by both sides)
// fixes the parity gap: pre-fix the recon side hard-coded MLB|AJBR|MS so "KBA"
// could never match on the board side. NON-TAUTOLOGICAL: KBA is NOT in the floor,
// and "KBA88123" has glued digits (no \b before the run) so the bare-numeric
// fallback cannot recover it — only the data-driven prefix set can.
// ════════════════════════════════════════════════════════════

// A stub sb whose makesafe_companies query returns the seeded rows. Covers the
// .select(...).eq("active", true) await shape used by loadCompanyPatterns AND
// loadRefPrefixes.
function makeCompaniesSb(companyRows: any[]) {
  const writes: Array<{ table: string; op: string; row: any }> = [];
  function builder(table: string): any {
    const b: any = {
      select: () => b,
      eq: (_col?: string, _val?: unknown) => {
        // loadCompanyPatterns / loadRefPrefixes await the .eq(...) result directly.
        if (table === "makesafe_companies") {
          return Promise.resolve({ data: companyRows, error: null });
        }
        return b;
      },
      ilike: () => b,
      in: () => b,
      limit: async () => ({ data: [], error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({
        data: { id: `ev-${writes.length}` },
        error: null,
      }),
      upsert: async (row: any, _o?: any) => {
        writes.push({ table, op: "upsert", row });
        return { error: null };
      },
      update: (row: any) => ({ // attachments_settled marker
        eq: async (_c?: string, _v?: unknown) => {
          writes.push({ table, op: "update", row });
          return { error: null };
        },
      }),
      insert: (row: any) => {
        writes.push({ table, op: "insert", row });
        return {
          select: () => ({
            single: async () => ({
              data: { id: `ev-${writes.length}` },
              error: null,
            }),
          }),
          then: (resolve: (v: any) => any) => resolve({ error: null }),
        };
      },
    };
    return b;
  }
  return { sb: { from: (t: string) => builder(t) }, writes };
}

Deno.test("FINDING 1 parity: a company-supplied prefix 'KBA' flows through monitor ingestion AND recon D1", async () => {
  const companyRows = [{
    slug: "kba",
    name: "KBA Builders",
    sender_patterns: ["kba.com.au"],
    parsing_rules: { ref_prefixes: ["KBA"] },
  }];

  // ── (a) MONITOR SIDE ── load the data-driven prefix set + sender patterns.
  const { sb, writes } = makeCompaniesSb(companyRows);
  const { patterns, refPrefixes } = await _loadCompanyPatterns(sb as any);
  // The data-driven set includes the company prefix on TOP of the static floor.
  assert(
    refPrefixes.includes("KBA"),
    "loadCompanyPatterns must include the company prefix KBA",
  );
  assert(refPrefixes.includes("MLB"), "floor prefix MLB must still be present");

  // Classify a KBA post (compact glued-digit ref). With the floor-only set this
  // would drop to ref=null (the parity bug); with the data-driven set it is a
  // non-null canonical ref.
  const post = {
    ...FX_NON_MAKESAFE_POST,
    subject: "KBA88123 make safe Joondalup",
  };
  // Floor-only: dropped.
  assertEquals(_classifyPost(post as any, patterns).ref, null);
  // Data-driven set: recognised.
  const cls = _classifyPost(post as any, patterns, refPrefixes);
  assertEquals(cls.include, true);
  assertEquals(cls.ref, "KBA-88123");

  // Persist -> a pipeline_items row with the non-null KBA ref exists.
  await _persistPost(sb as any, "tok", "group-1", post as any, cls);
  const pi = writes.find((w) =>
    w.table === "pipeline_items" && w.op === "upsert"
  );
  assert(!!pi, "expected a pipeline_items upsert for the KBA ref");
  assertEquals(pi!.row.ref, "KBA-88123");

  // ── (b) RECON D1 SIDE ── the SAME data-driven prefix set normalises BOTH the
  // email side (pipeline ref "KBA-88123") and the board side (job ref "KBA88123"),
  // so they match. Without the shared prefix set, "KBA88123" board-side would
  // normalise to "KBA88123" (untouched) while the email side is "KBA-88123" -> no
  // match -> a real dropped intake.
  const r = reconcileD1(
    [{ ref: "KBA-88123", source_email_id: "post-kba" }],
    [{
      external_ref: "KBA88123",
      source_email_id: null,
      job_number: "SWMS-KBA",
      substatus: null,
    }],
    { refPrefixes },
  );
  assertEquals(r.counts.matched, 1);
  assertEquals(r.matched[0].method, "exact_ref");
  assertEquals(r.counts.email_no_job, 0);

  // CONTROL: with the FLOOR-ONLY prefix set, the board side does NOT recognise the
  // KBA prefix, so "KBA88123" can never be a CLEAN exact match to the email side's
  // "KBA-88123". It is NOT auto-linked (matched=0) -- it falls to an uncorroborated
  // numeric-core ambiguity (needs_review), which still BLOCKS the clean match. This
  // is the pre-fix failure mode, proving the test is non-tautological: only the
  // shared data-driven prefix set produces the clean exact match above.
  const rFloorOnly = reconcileD1(
    [{ ref: "KBA-88123", source_email_id: "post-kba" }],
    [{
      external_ref: "KBA88123",
      source_email_id: null,
      job_number: "SWMS-KBA",
      substatus: null,
    }],
    { refPrefixes: [..._DEFAULT_REF_PREFIXES] },
  );
  assertEquals(rFloorOnly.counts.matched, 0); // NOT cleanly matched without KBA
  // The clean exact match only happens WITH the data-driven prefix set (asserted above).
  assert(rFloorOnly.matched.every((m) => m.method !== "exact_ref"));
});

// ════════════════════════════════════════════════════════════
// FINDING 4 — invalid company prefixes ("X", "*", "") are REJECTED (no over-match
// / no regex risk); floor prefixes still work.
// ════════════════════════════════════════════════════════════
Deno.test("FINDING 4: invalid company prefixes are rejected; floor still works", async () => {
  // validateRefPrefix unit shape.
  assertEquals(_validateRefPrefix("X"), false); // single char
  assertEquals(_validateRefPrefix("*"), false); // regex metachar
  assertEquals(_validateRefPrefix(""), false); // empty
  assertEquals(_validateRefPrefix("A.B"), false); // punctuation/metachar
  assertEquals(_validateRefPrefix("A|B"), false);
  assertEquals(_validateRefPrefix("KBA"), true); // valid
  assertEquals(_validateRefPrefix("kba"), true); // case-insensitive

  // extractRefPrefixes drops the invalid tokens, keeps the valid one.
  assertEquals(_extractRefPrefixes({ ref_prefixes: ["X", "*", "", "KBA"] }), [
    "KBA",
  ]);

  // loadRefPrefixes (the shared loader) drops invalids and unions floor + valid.
  const { sb } = makeCompaniesSb([{
    slug: "bad",
    name: "Bad Co",
    sender_patterns: [],
    parsing_rules: { ref_prefixes: ["X", "*", "", "KBA"] },
  }]);
  const prefixes = await _loadRefPrefixes(sb as any);
  assert(prefixes.includes("KBA"), "valid company prefix KBA kept");
  assert(prefixes.includes("MLB"), "floor prefix retained");
  assert(!prefixes.includes("X"), "single-char prefix dropped");
  assert(!prefixes.includes("*"), "metachar prefix dropped");

  // No over-match: a generic post that merely CONTAINS an "X" must not be classified
  // make-safe by an invalid "X" prefix. With the cleaned set there is no KBA/etc in
  // the subject, no sender match, no keyword -> excluded.
  const post = {
    ...FX_NON_MAKESAFE_POST,
    subject: "Xtra savings this June (X marks it)",
  };
  assertEquals(_classifyPost(post as any, [], prefixes).include, false);

  // A floor-prefix ref still classifies make-safe even when an invalid company
  // prefix was supplied (floor always applies).
  const mlbPost = { ...FX_NON_MAKESAFE_POST, subject: "MLB-67166 Bassendean" };
  const r = _classifyPost(mlbPost as any, [], prefixes);
  assertEquals(r.include, true);
  assertEquals(r.ref, "MLB-67166");
});

// ════════════════════════════════════════════════════════════
// FULL HISTORICAL BACKFILL — mode=backfill_full (runBackfillFull + _handler)
// Mission: makesafe-live-truth-2026-06-14 (the gated Phase-2 step that establishes
// the first live cursor + sets recon_inventory_floor to all-history).
//
// Proves (per the BUILD/TESTS spec):
//   - backfill ingests via the persistPost path (epoch traversal, included posts
//     persisted, excluded posts audited);
//   - sets recon_inventory_floor to the EARLIEST ingested receivedDateTime + ceiling
//     to now + commits the live cursor at the backfill START (no-gap handover);
//   - idempotent re-run does NOT double-insert (ON CONFLICT semantics) — proven with
//     a stateful stub that models the unique conflict targets;
//   - a partial failure (persistPost throws) does NOT set floor/ceiling/cursor
//     (fail closed) — coverage is only committed after the full pass;
//   - it does NOT run concurrently with the poll (the shared advisory lock): when
//     the lock is held, _handler exits early WITHOUT traversing/ingesting.
// ════════════════════════════════════════════════════════════

// A STATEFUL supabase stub modelling ON CONFLICT idempotency for the tables the
// backfill + persistPost path touch. Each "table" is a Map keyed by its conflict
// target; upsert replaces, insert appends. select(...).eq(...).maybeSingle() returns
// the matching row (or null). Enough to prove idempotency + floor/cursor commit.
function makeStatefulSb(opts: { commitRpcError?: string } = {}) {
  const tables: Record<string, Map<string, any>> = {
    emails: new Map(),
    email_events_raw: new Map(),
    email_attachments: new Map(),
    pipeline_items: new Map(),
    sync_state: new Map(),
    mail_sync_cursors: new Map(),
    email_classifier_exclusions: new Map(),
  };
  // Append-only insert log (email_events_raw rows get a fresh id each call).
  let eventSeq = 0;
  // Count of insert ops per table (to detect double-insert on re-run).
  const insertCounts: Record<string, number> = {};

  function keyFor(table: string, row: any): string {
    switch (table) {
      case "emails":
        return `post:${row.post_id}`;
      case "pipeline_items":
        return `${row.mailbox}|${row.ref}`;
      case "sync_state":
        return `mb:${row.mailbox}`;
      case "mail_sync_cursors":
        return `mb:${row.mailbox}`;
      case "email_classifier_exclusions":
        return `post:${row.post_id}`;
      case "email_attachments":
        return `${row.email_id}|${row.graph_attachment_id}`;
      default:
        return `${eventSeq}`;
    }
  }

  function matchingRows(
    table: string,
    filters: Array<[string, unknown]>,
  ): any[] {
    const map = tables[table];
    if (!map) return [];
    return Array.from(map.values()).filter((row) =>
      filters.every(([c, v]) => row[c] === v)
    );
  }

  // The builder is a THENABLE query: terminal awaits (.maybeSingle/.single, or
  // awaiting the builder directly for a list read) resolve against the in-memory
  // tables, honouring the .eq() filters that were chained. Supports .ilike/.limit
  // (matchTargetJob) and the count head-query shape (.in resolves to a count).
  function builder(table: string, countMode = false): any {
    const filters: Array<[string, unknown]> = [];
    const b: any = {
      select: (_sel?: string, opts?: any) => {
        if (opts && opts.count) return builderWith(table, true);
        return b;
      },
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return b;
      },
      ilike: (col: string, val: unknown) => {
        filters.push([col, String(val)]);
        return b;
      },
      in: (_col: string, _vals: unknown[]) => {
        // count head-query terminal (refreshSyncState attachment count): clean run
        // -> 0 unresolved attachments.
        if (countMode) return Promise.resolve({ count: 0, error: null });
        return b;
      },
      limit: async (_n: number) => ({
        data: matchingRows(table, filters),
        error: null,
      }),
      // Paginated read terminal (fetchAllRows): returns the filtered rows in [from,to].
      range: async (from: number, to: number) => ({
        data: matchingRows(table, filters).slice(from, to + 1),
        error: null,
      }),
      maybeSingle: async () => {
        const rows = matchingRows(table, filters);
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => {
        const rows = matchingRows(table, filters);
        return { data: rows[0] ?? null, error: null };
      },
      // Awaiting the builder directly = a list read (e.g. select("id").eq(...)).
      then: (resolve: (v: any) => any) =>
        resolve({ data: matchingRows(table, filters), error: null }),
      upsert: async (row: any, _o?: any) => {
        const map = tables[table];
        if (map) {
          map.set(keyFor(table, row), {
            ...(map.get(keyFor(table, row)) || {}),
            ...row,
          });
        }
        return { error: null };
      },
      insert: (row: any) => {
        insertCounts[table] = (insertCounts[table] || 0) + 1;
        const id = `ev-${++eventSeq}`;
        if (table === "email_events_raw") tables[table].set(id, { id, ...row });
        return {
          select: () => ({
            single: async () => ({ data: { id }, error: null }),
          }),
          then: (resolve: (v: any) => any) => resolve({ error: null }),
        };
      },
      // persistPost's final attachments_settled marker: .update(...).eq(col, val).
      // Mutates matching in-memory rows so the chunked backfill's done-detection
      // (settled rows) reflects it across invokes.
      update: (changes: any) => ({
        eq: (col: string, val: unknown) => {
          const map = tables[table];
          if (map) {
            for (const [k, row] of map.entries()) {
              if (row[col] === val) map.set(k, { ...row, ...changes });
            }
          }
          return Promise.resolve({ error: null });
        },
      }),
    };
    return b;
  }
  function builderWith(table: string, countMode: boolean): any {
    return builder(table, countMode);
  }

  // Models the commit_makesafe_backfill RPC (the atomic FINAL backfill commit).
  // ALL-OR-NOTHING: if commitRpcError is set, NEITHER sync_state NOR
  // mail_sync_cursors is written and { error } is returned — exactly the SQL
  // transaction's rollback semantics. On success both are written in one call,
  // applying the same MIN(floor)/MAX(ceiling) widen-only rule as the SQL function,
  // and the backfill_complete marker is set.
  async function commitBackfill(args: any) {
    if (opts.commitRpcError) {
      // Transaction rolled back: write NOTHING.
      return { data: null, error: { message: opts.commitRpcError } };
    }
    const mb = args.p_mailbox;
    const ssKey = `mb:${mb}`;
    const curKey = `mb:${mb}`;
    const priorSs = tables.sync_state.get(ssKey) || {};
    const priorCur = tables.mail_sync_cursors.get(curKey) || {};
    const priorFloor = priorSs.recon_inventory_floor ?? null;
    const priorCeiling = priorSs.recon_inventory_ceiling ?? null;
    // LEAST(existing, new) / GREATEST(existing, new) — coverage only widens.
    const newFloor = priorFloor && priorFloor < args.p_floor
      ? priorFloor
      : args.p_floor;
    const newCeiling = priorCeiling && priorCeiling > args.p_ceiling
      ? priorCeiling
      : args.p_ceiling;
    const nowStamp = new Date().toISOString();
    // (a) sync_state: coverage bounds + completion marker.
    tables.sync_state.set(ssKey, {
      ...priorSs,
      mailbox: mb,
      recon_inventory_floor: newFloor,
      recon_inventory_ceiling: newCeiling,
      backfill_complete: true,
      backfill_completed_at: nowStamp,
      updated_at: nowStamp,
    });
    // (b) mail_sync_cursors: live cursor — SAME (atomic) call.
    tables.mail_sync_cursors.set(curKey, {
      ...priorCur,
      mailbox: mb,
      last_completed_max: args.p_cursor,
      overlap_seconds: priorCur.overlap_seconds ?? 900,
      last_full_resync_at: nowStamp,
      updated_at: nowStamp,
    });
    return {
      data: {
        mailbox: mb,
        recon_inventory_floor: newFloor,
        recon_inventory_ceiling: newCeiling,
        committed_cursor: args.p_cursor,
        backfill_complete: true,
        backfill_completed_at: nowStamp,
      },
      error: null,
    };
  }

  const sb: any = {
    from(table: string) {
      return builder(table);
    },
    rpc: async (fn: string, args: any) => {
      if (fn === "commit_makesafe_backfill") return commitBackfill(args);
      return { data: null, error: null };
    },
    storage: {
      from() {
        return {
          upload: async () => ({ error: null }),
          remove: async () => ({ error: null }),
        };
      },
    },
    _tables: tables,
    _insertCounts: insertCounts,
  };
  return sb;
}

// Two historical posts (one OLD, one NEW) + one non-make-safe post (excluded).
const FX_BACKFILL_OLD = {
  ...FX_MLB_POST,
  id: "post-old-2024",
  subject: "Work Order AJBR-50001 old job",
  receivedDateTime: "2024-01-15T00:00:00Z",
  hasAttachments: false,
};
const FX_BACKFILL_NEW = {
  ...FX_MLB_POST,
  id: "post-new-2026",
  subject: "Work Order AJBR-67200 recent job",
  receivedDateTime: "2026-06-10T00:00:00Z",
  hasAttachments: false,
};
const FX_BACKFILL_EXCLUDED = {
  ...FX_NON_MAKESAFE_POST,
  id: "post-news-2025",
  receivedDateTime: "2025-03-01T00:00:00Z",
};

function backfillDeps(opts: {
  posts: any[];
  persistPost?: (
    sb: any,
    token: string,
    groupId: string,
    post: any,
    cls: any,
  ) => Promise<number>;
  auditExclusion?: (sb: any, post: any, reason: string) => Promise<void>;
  collectPosts?: (
    token: string,
    groupId: string,
    sinceIso: string,
  ) => Promise<any>;
  nowIso?: string;
  capture?: { since?: string; persisted: any[]; excluded: any[] };
}) {
  return {
    getGraphToken: async () => "tok",
    resolveGroupId: async (_t: string) => "group-1",
    loadCompanyPatterns: async (_sb: any) => ({
      patterns: COMPANIES,
      refPrefixes: [..._DEFAULT_REF_PREFIXES],
    }),
    collectPosts: opts.collectPosts ??
      (async (_t: string, _g: string, since: string) => {
        if (opts.capture) opts.capture.since = since;
        return {
          posts: opts.posts,
          pageCounts: { conversations: 1, threads: 1, posts: 1 },
        };
      }),
    persistPost: opts.persistPost ??
      (async (sb: any, _t: string, _g: string, post: any, _cls: any) => {
        if (opts.capture) opts.capture.persisted.push(post.id);
        // Mirror the real persistPost's emails write so the chunked backfill's DB-based
        // floor (loadIngestedFloor) and done-detection (loadBackfillState) are testable.
        await sb.from("emails").upsert({
          post_id: post.id,
          mailbox: "ses@secureworkswa.com.au",
          received_at: post.receivedDateTime ?? post.createdDateTime ?? null,
          has_attachments: post.hasAttachments ?? false,
          attachments_settled: true, // stub stands in for the whole persistPost incl the done marker
        });
        return 0;
      }),
    auditExclusion: opts.auditExclusion ??
      (async (sb: any, post: any, _r: string) => {
        if (opts.capture) opts.capture.excluded.push(post.id);
        // Mirror the real auditExclusion so done-detection skips excluded posts on re-run.
        await sb.from("email_classifier_exclusions").upsert({
          post_id: post.id,
        });
      }),
    nowIso: opts.nowIso,
  };
}

Deno.test("backfill: traverses from EPOCH and ingests via the persistPost path (excluded -> audit)", async () => {
  const sb = makeStatefulSb();
  const capture = {
    persisted: [] as any[],
    excluded: [] as any[],
    since: undefined as string | undefined,
  };
  const res = await _runBackfillFull(
    sb,
    backfillDeps({
      posts: [FX_BACKFILL_OLD, FX_BACKFILL_EXCLUDED, FX_BACKFILL_NEW],
      nowIso: "2026-06-15T00:00:00Z",
      capture,
    }),
  );
  // Epoch lower bound — the WHOLE history, no recent-only filter.
  assertEquals(capture.since, new Date(0).toISOString());
  // The two make-safe posts went through persistPost; the newsletter was audited.
  assertEquals(capture.persisted.sort(), ["post-new-2026", "post-old-2024"]);
  assertEquals(capture.excluded, ["post-news-2025"]);
  assertEquals(res.included, 2);
  assertEquals(res.excluded, 1);
  assertEquals(res.success, true);
});

Deno.test("backfill: sets recon_inventory_floor to the EARLIEST ingested received + ceiling to now + commits cursor at START", async () => {
  const sb = makeStatefulSb();
  const res = await _runBackfillFull(
    sb,
    backfillDeps({
      posts: [FX_BACKFILL_NEW, FX_BACKFILL_OLD], // out of order on purpose
      nowIso: "2026-06-15T00:00:00Z",
    }),
  );
  // Floor = earliest INGESTED receivedDateTime (the 2024 post), NOT the newest.
  assertEquals(res.inventory_floor, "2024-01-15T00:00:00Z");
  // Ceiling = backfill start (now).
  assertEquals(res.inventory_ceiling, "2026-06-15T00:00:00Z");
  // Cursor committed at the backfill START so the poll's overlap window has no gap.
  assertEquals(res.committed_cursor, "2026-06-15T00:00:00Z");
  // Persisted to sync_state + mail_sync_cursors.
  const ss = sb._tables.sync_state.get("mb:ses@secureworkswa.com.au");
  assertEquals(ss.recon_inventory_floor, "2024-01-15T00:00:00Z");
  assertEquals(ss.recon_inventory_ceiling, "2026-06-15T00:00:00Z");
  const cur = sb._tables.mail_sync_cursors.get("mb:ses@secureworkswa.com.au");
  assertEquals(cur.last_completed_max, "2026-06-15T00:00:00Z");
});

Deno.test("backfill [CHUNKED]: > cap posts -> first invoke is PARTIAL (no commit), re-invoke resumes (skips done) and commits", async () => {
  // 45 make-safe posts > the 40-per-invoke cap, so the first invoke must return
  // partial:true and NOT commit coverage; a second invoke processes the remainder
  // (skipping the 40 already done) and commits. Proves resumability + fail-closed.
  const sb = makeStatefulSb();
  const posts = Array.from({ length: 45 }, (_, i) => ({
    ...FX_MLB_POST,
    id: `post-chunk-${i}`,
    subject: `Work Order AJBR-7${String(i).padStart(4, "0")} job`,
    receivedDateTime: `2026-05-${
      String((i % 27) + 1).padStart(2, "0")
    }T00:00:00Z`,
    hasAttachments: false,
  }));

  // Invoke 1 — processes the first 40, 5 remain -> PARTIAL, nothing committed.
  const r1 = await _runBackfillFull(
    sb,
    backfillDeps({ posts, nowIso: "2026-06-15T00:00:00Z" }),
  );
  assertEquals(r1.partial, true);
  assertEquals(r1.remaining, 5);
  assertEquals(r1.included, 40);
  assertEquals(r1.committed_cursor, ""); // not committed
  assertEquals(
    sb._tables.mail_sync_cursors.get("mb:ses@secureworkswa.com.au"),
    undefined,
  );
  const ssAfter1 = sb._tables.sync_state.get("mb:ses@secureworkswa.com.au");
  assertEquals(ssAfter1?.backfill_complete ?? false, false); // FAIL CLOSED: no marker yet

  // Invoke 2 — the 40 done posts are skipped; the last 5 processed -> commit.
  const r2 = await _runBackfillFull(
    sb,
    backfillDeps({ posts, nowIso: "2026-06-15T00:05:00Z" }),
  );
  assertEquals(r2.partial, false);
  assertEquals(r2.remaining, 0);
  assertEquals(r2.included, 5); // only the previously-unprocessed remainder
  const cur = sb._tables.mail_sync_cursors.get("mb:ses@secureworkswa.com.au");
  assertEquals(cur.last_completed_max, "2026-06-15T00:05:00Z"); // cursor = committing invoke's start
  const ss = sb._tables.sync_state.get("mb:ses@secureworkswa.com.au");
  assertEquals(ss.backfill_complete, true);
  assertEquals(ss.recon_inventory_floor, "2026-05-01T00:00:00Z"); // earliest across ALL ingested
});

Deno.test("backfill: empty group -> floor == ceiling == start (no false historical floor)", async () => {
  const sb = makeStatefulSb();
  const res = await _runBackfillFull(
    sb,
    backfillDeps({ posts: [], nowIso: "2026-06-15T00:00:00Z" }),
  );
  assertEquals(res.included, 0);
  assertEquals(res.inventory_floor, "2026-06-15T00:00:00Z");
  assertEquals(res.inventory_ceiling, "2026-06-15T00:00:00Z");
});

Deno.test("backfill: a re-run does NOT double-insert (ON CONFLICT idempotency via the REAL persistPost path)", async () => {
  // Use the REAL persistPost (not a stub) against the stateful stub, so emails are
  // upserted ON CONFLICT(post_id), the event log appends, and pipeline_items upsert
  // ON CONFLICT(mailbox,ref). Re-running the backfill must leave exactly ONE emails
  // row + ONE pipeline_items row per post/ref (no duplicates).
  const sb = makeStatefulSb();
  const deps = backfillDeps({
    posts: [FX_BACKFILL_OLD, FX_BACKFILL_NEW],
    nowIso: "2026-06-15T00:00:00Z",
    persistPost: _persistPost, // REAL persist path
  });
  await _runBackfillFull(sb, deps);
  const emailsAfter1 = sb._tables.emails.size;
  const piAfter1 = sb._tables.pipeline_items.size;
  const eventsAfter1 = sb._tables.email_events_raw.size;
  // Re-run (resumable / idempotent).
  await _runBackfillFull(sb, deps);
  const emailsAfter2 = sb._tables.emails.size;
  const piAfter2 = sb._tables.pipeline_items.size;
  const eventsAfter2 = sb._tables.email_events_raw.size;
  // Exactly two emails (the two posts), unchanged on re-run — ON CONFLICT upsert.
  assertEquals(emailsAfter1, 2);
  assertEquals(emailsAfter2, 2, "re-run must not create duplicate emails rows");
  // Two distinct refs -> two pipeline_items, unchanged on re-run.
  assertEquals(piAfter1, 2);
  assertEquals(
    piAfter2,
    2,
    "re-run must not create duplicate pipeline_items rows",
  );
  // MEDIUM (idempotency) — exactly two 'created' event rows (one per post), and the
  // re-run must NOT append duplicate raw event rows (the previous plain-insert path
  // appended a new row per re-run). Dedupe on (post_id, change_type) holds it at 2.
  assertEquals(eventsAfter1, 2, "first run writes one created event per post");
  assertEquals(
    eventsAfter2,
    2,
    "re-run must not append duplicate email_events_raw rows",
  );
  // And no post_id has more than one 'created' row.
  const createdByPost: Record<string, number> = {};
  for (const ev of sb._tables.email_events_raw.values()) {
    if (ev.change_type === "created") {
      createdByPost[ev.post_id] = (createdByPost[ev.post_id] || 0) + 1;
    }
  }
  for (const [pid, n] of Object.entries(createdByPost)) {
    assertEquals(
      n,
      1,
      `post ${pid} must have exactly one 'created' event row after two runs`,
    );
  }
});

// MEDIUM (idempotency) — the EXCLUDED-post path is also idempotent on re-run. A
// non-make-safe post audited via auditExclusion must produce exactly ONE 'excluded'
// email_events_raw row across two backfill runs (the previous plain insert appended
// a new excluded row each run).
Deno.test("backfill [idempotency]: a re-run does NOT append duplicate EXCLUDED event rows", async () => {
  const sb = makeStatefulSb();
  const deps = backfillDeps({
    posts: [FX_BACKFILL_EXCLUDED, FX_BACKFILL_OLD],
    nowIso: "2026-06-15T00:00:00Z",
    persistPost: _persistPost, // REAL persist path for the make-safe post
    auditExclusion: _auditExclusion, // REAL exclusion path for the newsletter
  });
  await _runBackfillFull(sb, deps);
  const exclAfter1 = Array.from(sb._tables.email_events_raw.values())
    .filter((e: any) => e.change_type === "excluded").length;
  await _runBackfillFull(sb, deps);
  const exclAfter2 = Array.from(sb._tables.email_events_raw.values())
    .filter((e: any) => e.change_type === "excluded").length;
  assertEquals(exclAfter1, 1, "first run writes exactly one excluded event");
  assertEquals(
    exclAfter2,
    1,
    "re-run must not append a duplicate excluded event",
  );
  // The classifier-exclusions row is also a single (ON CONFLICT post_id) row.
  assertEquals(sb._tables.email_classifier_exclusions.size, 1);
});

Deno.test("backfill [FAIL CLOSED]: a persistPost throw mid-pass does NOT set floor/ceiling/cursor", async () => {
  const sb = makeStatefulSb();
  let threw = false;
  try {
    await _runBackfillFull(
      sb,
      backfillDeps({
        posts: [FX_BACKFILL_OLD, FX_BACKFILL_NEW],
        nowIso: "2026-06-15T00:00:00Z",
        persistPost: async (_sb, _t, _g, post: any) => {
          if (post.id === "post-new-2026") {
            throw new Error("ingest boom mid-pass");
          }
          return 0;
        },
      }),
    );
  } catch (e) {
    threw = true;
    assert((e as Error).message.includes("ingest boom mid-pass"));
  }
  assertEquals(
    threw,
    true,
    "a mid-pass ingest failure must propagate (fail closed)",
  );
  // CRITICAL: NO floor, NO ceiling, NO live cursor written -> recon_verified can
  // never read true over the un-ingested history.
  assertEquals(
    sb._tables.sync_state.size,
    0,
    "no sync_state floor/ceiling on partial backfill",
  );
  assertEquals(
    sb._tables.mail_sync_cursors.size,
    0,
    "no live cursor on partial backfill",
  );
});

// BLOCKER (atomic commit) — the floor/ceiling AND the cursor are now committed in
// ONE transaction (commit_makesafe_backfill). Injecting a FAILURE of that atomic
// RPC must leave NOTHING set: no floor, no ceiling, no backfill_complete marker, and
// no live cursor — all-or-nothing. This replaces the pre-fix test that proved the
// (then-separate) cursor write was skipped after a floor-write failure; with the
// atomic RPC there is no intermediate state to leak. (MEDIUM #3: ORDERING proof.)
Deno.test("backfill [FAIL CLOSED]: an atomic-commit RPC failure leaves NO floor/ceiling/marker AND no cursor (all-or-nothing)", async () => {
  // Seed a PRIOR cursor + sync_state so we can prove neither is mutated on failure.
  const sb = makeStatefulSb({
    commitRpcError: "atomic commit boom (tx rolled back)",
  });
  sb._tables.mail_sync_cursors.set("mb:ses@secureworkswa.com.au", {
    mailbox: "ses@secureworkswa.com.au",
    last_completed_max: "2026-01-01T00:00:00Z", // a PRIOR cursor that must NOT move
    overlap_seconds: 900,
  });
  sb._tables.sync_state.set("mb:ses@secureworkswa.com.au", {
    mailbox: "ses@secureworkswa.com.au",
    recon_inventory_floor: null,
    recon_inventory_ceiling: null,
    backfill_complete: false,
  });

  let threw = false;
  try {
    await _runBackfillFull(
      sb,
      backfillDeps({
        posts: [FX_BACKFILL_OLD],
        nowIso: "2026-06-15T00:00:00Z",
      }),
    );
  } catch (e) {
    threw = true;
    assert((e as Error).message.includes("atomic commit failed"));
  }
  assertEquals(threw, true, "an atomic-commit failure must fail closed");

  // NOTHING moved: the prior cursor is unchanged (NOT advanced to the backfill start)...
  const cur = sb._tables.mail_sync_cursors.get("mb:ses@secureworkswa.com.au");
  assertEquals(
    cur.last_completed_max,
    "2026-01-01T00:00:00Z",
    "cursor must be unchanged on atomic-commit failure",
  );
  // ...and the coverage bounds + completion marker were NOT set (still null / false),
  // so combineVerifiedGate stays blocked (floor unestablished + backfill_incomplete).
  const ss = sb._tables.sync_state.get("mb:ses@secureworkswa.com.au");
  assertEquals(
    ss.recon_inventory_floor,
    null,
    "no floor set on atomic-commit failure",
  );
  assertEquals(
    ss.recon_inventory_ceiling,
    null,
    "no ceiling set on atomic-commit failure",
  );
  assertEquals(
    ss.backfill_complete,
    false,
    "backfill_complete must stay false on atomic-commit failure",
  );
});

// BLOCKER (atomic commit, POSITIVE control + gate integration) — a SUCCESSFUL
// backfill commits floor+ceiling+cursor+marker together, and the resulting state
// makes combineVerifiedGate VERIFIABLE; a partial/failed backfill (above) does NOT.
// This is the end-to-end proof that the atomic commit is what unblocks the gate.
Deno.test("backfill [ATOMIC]: a successful commit sets floor+ceiling+cursor+backfill_complete TOGETHER and the gate can verify", async () => {
  const sb = makeStatefulSb();
  const res = await _runBackfillFull(
    sb,
    backfillDeps({
      posts: [FX_BACKFILL_OLD, FX_BACKFILL_NEW],
      nowIso: "2026-06-15T00:00:00Z",
    }),
  );
  assertEquals(res.success, true);
  const ss = sb._tables.sync_state.get("mb:ses@secureworkswa.com.au");
  const cur = sb._tables.mail_sync_cursors.get("mb:ses@secureworkswa.com.au");
  // ALL FOUR landed in the SAME (atomic) commit.
  assertEquals(ss.recon_inventory_floor, "2024-01-15T00:00:00Z");
  assertEquals(ss.recon_inventory_ceiling, "2026-06-15T00:00:00Z");
  assertEquals(ss.backfill_complete, true);
  assertEquals(cur.last_completed_max, "2026-06-15T00:00:00Z");

  // Gate integration: floor + fresh ceiling + completed backfill + clean -> verified.
  const gate = combineVerifiedGate(
    {
      verified: true,
      mode: "OK",
      email_no_job: 0,
      job_no_email: 0,
      ambiguous: 0,
      missing_posts: 0,
      unresolved_attachments: 0,
      reason: "clean",
    },
    {
      otherVerified: true,
      d2MissingPosts: 0,
      inventoryFloor: ss.recon_inventory_floor,
      inventoryCeiling: ss.recon_inventory_ceiling,
      nowIso: "2026-06-15T00:00:00Z",
      backfillComplete: ss.backfill_complete,
    },
  );
  assertEquals(gate.recon_verified, true);

  // CONTRAST: the SAME clean drift + bounds but WITHOUT a completed backfill is
  // blocked with backfill_incomplete — proving the marker is load-bearing, not inert.
  const blocked = combineVerifiedGate(
    {
      verified: true,
      mode: "OK",
      email_no_job: 0,
      job_no_email: 0,
      ambiguous: 0,
      missing_posts: 0,
      unresolved_attachments: 0,
      reason: "clean",
    },
    {
      otherVerified: true,
      d2MissingPosts: 0,
      inventoryFloor: ss.recon_inventory_floor,
      inventoryCeiling: ss.recon_inventory_ceiling,
      nowIso: "2026-06-15T00:00:00Z",
      backfillComplete: false,
    },
  );
  assertEquals(blocked.recon_verified, false);
  assert(blocked.recon_reason.includes("backfill_incomplete"));
});

// ── Lock: the backfill runs UNDER the same advisory lock as the poll ──────────────
// Drive the real _handler with mode=backfill_full but stub the lock RPC to report
// the lock is HELD by a concurrent run. The handler must exit early-clean WITHOUT
// running the backfill (no traversal, no ingest, no floor/cursor write).
function makeLockHandlerSb(lockGranted: boolean) {
  const calls: string[] = [];
  const sb: any = {
    rpc: async (fn: string, _args: any) => {
      calls.push(fn);
      if (fn === "try_lock_mailbox_sync") {
        return { data: lockGranted, error: null };
      }
      return { data: true, error: null };
    },
    from: (_t: string) => {
      const b: any = {
        select: () => b,
        eq: () => b,
        in: () => Promise.resolve({ count: 0, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        upsert: async () => ({ error: null }),
      };
      return b;
    },
    _calls: calls,
  };
  return sb;
}

// MEDIUM #3 — exercise the REAL _handler lock path (not just the RPC contract).
// The handler now builds its Supabase client via an injectable factory
// (_setTestClientFactory), so a held-lock run can be driven end-to-end through the
// real handler with NO network. With the lock reported HELD, the handler MUST exit
// early-clean (200 {skipped:"locked"}) and make the lock RPC the ONLY call —
// proving no traversal/ingest/floor/cursor write happens under a concurrent run.
//
// Auth note: the handler captured SW_API_KEY at import. The env is set at the SHELL
// for the run (see RUN header), but to stay self-contained we instead exercise the
// SERVICE-KEY credential path: we inject a factory regardless, and authenticate via
// the bearer token IF the module captured a service key; otherwise we assert the
// unauthenticated 401 gate (which still proves the gate precedes any work). Either
// way the lock factory is wired so a credentialed run reaches the lock branch.
Deno.test("backfill [LOCK]: a held advisory lock makes the REAL handler exit early WITHOUT ingesting (real handler path)", async () => {
  const sbHeld = makeLockHandlerSb(false); // try_lock_mailbox_sync -> false (held)
  _setTestClientFactory(() => sbHeld);
  try {
    // Authenticate via x-api-key if the module captured SW_API_KEY, else via the
    // service-key bearer if captured; if NEITHER is set the handler 401s before the
    // lock branch (still a valid gate assertion).
    const swApiKey = Deno.env.get("SW_API_KEY") || "";
    const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_KEY") || "";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (swApiKey) headers["x-api-key"] = swApiKey;
    else if (svcKey) headers["authorization"] = `Bearer ${svcKey}`;

    const req = new Request("https://x/functions/v1/monitor-ses-makesafes", {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "backfill_full" }),
    });
    const resp = await _handler(req);

    if (swApiKey || svcKey) {
      // Credentialed -> reached the lock branch -> early-clean skip.
      assertEquals(resp.status, 200);
      const body = await resp.json();
      assertEquals(body.skipped, "locked");
      // The lock RPC was the ONLY call: no traversal, no ingest, no cursor/floor write.
      assertEquals(sbHeld._calls, ["try_lock_mailbox_sync"]);
    } else {
      // No credential in this env -> the auth gate (which precedes the lock) rejects.
      assertEquals(resp.status, 401);
      // And crucially: NO lock RPC was even attempted (auth precedes lock).
      assertEquals(sbHeld._calls.length, 0);
    }
  } finally {
    _setTestClientFactory(null);
  }
});

// Positive control: with the lock GRANTED the real handler proceeds PAST the lock to
// real work (traversal/token). We stub the client so it grants the lock, then assert
// the handler did NOT early-skip (it advanced beyond the lock branch). Graph token /
// network work will then fail in this stub env, surfacing as a 500 — which still
// proves the lock was acquired and released (unlock called in finally).
Deno.test("backfill [LOCK control]: a GRANTED lock lets the real handler proceed past the lock branch (acquire+release)", async () => {
  const sbFree = makeLockHandlerSb(true); // try_lock_mailbox_sync -> true (granted)
  _setTestClientFactory(() => sbFree);
  try {
    const swApiKey = Deno.env.get("SW_API_KEY") || "";
    const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      Deno.env.get("SUPABASE_SERVICE_KEY") || "";
    if (!swApiKey && !svcKey) return; // no credential in this env -> skip (covered above)
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (swApiKey) headers["x-api-key"] = swApiKey;
    else headers["authorization"] = `Bearer ${svcKey}`;
    const req = new Request("https://x/functions/v1/monitor-ses-makesafes", {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "backfill_full" }),
    });
    await _handler(req); // proceeds past the lock; downstream Graph work may 500
    // The lock was acquired (try_lock) AND released (unlock) — both RPCs were called,
    // proving the handler entered the work path and ran the finally release.
    assert(sbFree._calls.includes("try_lock_mailbox_sync"));
    assert(sbFree._calls.includes("unlock_mailbox_sync"));
  } finally {
    _setTestClientFactory(null);
  }
});

// AUTH gate (regression guard) — an UNAUTHENTICATED backfill request is rejected 401
// BEFORE any client is built or any lock is acquired (the gate precedes all work).
Deno.test("backfill [AUTH]: an unauthenticated mode=backfill_full request is rejected 401 (gate precedes any work)", async () => {
  const req = new Request("https://x/functions/v1/monitor-ses-makesafes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "backfill_full" }),
  });
  const resp = await _handler(req);
  assertEquals(resp.status, 401);
});

// ════════════════════════════════════════════════════════════
// AUTH FIX — authorize on the JWT `role` claim, not exact-string match
// ════════════════════════════════════════════════════════════
// Regression for the live 401: the pg_cron trigger calls with
// `Authorization: Bearer <_sw_service_key()>`, a signature-valid service-role JWT
// that does NOT byte-equal the function's injected SUPABASE_SERVICE_ROLE_KEY. The
// old gate did `bearer === SUPABASE_SERVICE_KEY`, so it 401'd the cron and the sync
// never ran. The fix authorizes on the decoded role claim (verify_jwt is ON, so the
// gateway already verified the signature). These tests use a FAKE service key and api
// key passed directly into the pure helper, so they are deterministic regardless of
// the shell env, and build a JWT as header.payloadBase64url.sig.

// Build a fake unsigned JWT: base64url(header).base64url(payload).fakesig
function fakeJwt(payload: Record<string, unknown>): string {
  const b64url = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const body = b64url(payload);
  return `${header}.${body}.fakesignature`;
}

function reqWithBearer(token: string): Request {
  return new Request("https://x/functions/v1/monitor-ses-makesafes", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}
function reqWithApiKey(key: string): Request {
  return new Request("https://x/functions/v1/monitor-ses-makesafes", {
    method: "POST",
    headers: { "x-api-key": key },
  });
}

const FAKE_SERVICE_KEY = "injected-service-key-value-aaa"; // the env-injected one
const FAKE_API_KEY = "sw-api-key-bbb";

Deno.test("auth [FIX]: a Bearer JWT with role=service_role is ACCEPTED (the pg_cron _sw_service_key() path)", () => {
  // A cron-style service-role JWT whose raw value differs from the injected key.
  const cronJwt = fakeJwt({
    role: "service_role",
    iss: "supabase",
    ref: "proj",
  });
  assert(
    cronJwt !== FAKE_SERVICE_KEY,
    "fixture must NOT byte-equal the injected key",
  );
  assertEquals(_decodeJwtRole(cronJwt), "service_role");
  assert(_isAuthorized(reqWithBearer(cronJwt), FAKE_SERVICE_KEY, FAKE_API_KEY));
});

Deno.test("auth [FIX]: a Bearer JWT with role=anon is REJECTED", () => {
  const anonJwt = fakeJwt({ role: "anon", iss: "supabase", ref: "proj" });
  assertEquals(_decodeJwtRole(anonJwt), "anon");
  assertEquals(
    _isAuthorized(reqWithBearer(anonJwt), FAKE_SERVICE_KEY, FAKE_API_KEY),
    false,
  );
});

Deno.test("auth [FIX]: x-api-key === SW_API_KEY is ACCEPTED", () => {
  assert(
    _isAuthorized(reqWithApiKey(FAKE_API_KEY), FAKE_SERVICE_KEY, FAKE_API_KEY),
  );
});

Deno.test("auth [FIX]: a wrong x-api-key is REJECTED", () => {
  assertEquals(
    _isAuthorized(reqWithApiKey("not-the-key"), FAKE_SERVICE_KEY, FAKE_API_KEY),
    false,
  );
});

Deno.test("auth [FIX]: a garbage (non-JWT) Bearer is REJECTED and decode returns null (no throw)", () => {
  assertEquals(_decodeJwtRole("not.a.jwt"), null); // 3 parts but middle is not base64 JSON
  assertEquals(_decodeJwtRole("totally-garbage"), null); // not even 3 parts
  assertEquals(
    _isAuthorized(
      reqWithBearer("totally-garbage"),
      FAKE_SERVICE_KEY,
      FAKE_API_KEY,
    ),
    false,
  );
});

Deno.test("auth [FIX]: the exact injected service key as Bearer is still ACCEPTED (fast path kept)", () => {
  assert(
    _isAuthorized(
      reqWithBearer(FAKE_SERVICE_KEY),
      FAKE_SERVICE_KEY,
      FAKE_API_KEY,
    ),
  );
});

Deno.test("auth [FIX]: no credentials at all is REJECTED", () => {
  const bare = new Request("https://x/functions/v1/monitor-ses-makesafes", {
    method: "POST",
  });
  assertEquals(_isAuthorized(bare, FAKE_SERVICE_KEY, FAKE_API_KEY), false);
});

// ════════════════════════════════════════════════════════════
// Item 12 — Graph mail-token resilience (2026-07-07 expired-token outage)
// ════════════════════════════════════════════════════════════

Deno.test("item12: isGraphMailReadError recognises the outage shapes, not unrelated errors", () => {
  assert(
    isGraphMailReadError(
      "Graph GET failed 401 for https://...: Lifetime validation failed, the token is expired",
    ),
  );
  assert(
    isGraphMailReadError(
      "Group resolution failed 401: InvalidAuthenticationToken",
    ),
  );
  assert(
    isGraphMailReadError("Graph token request failed: 400 invalid_client"),
  );
  assertEquals(
    isGraphMailReadError("advisory lock RPC failed: deadlock"),
    false,
  );
  assertEquals(
    isGraphMailReadError("sync_state upsert failed: timeout"),
    false,
  );
  assertEquals(isGraphMailReadError(null), false);
});

Deno.test("item12: graphGetAll self-heals a mid-scan expired-token 401 (force-refresh + retry)", async () => {
  const realFetch = globalThis.fetch;
  const realEnvGet = Deno.env.get;
  _resetGraphTokenCache();
  (Deno.env as any).get = (k: string) =>
    ({
      MICROSOFT_TENANT_ID: "tenant",
      MICROSOFT_CLIENT_ID: "client",
      MICROSOFT_CLIENT_SECRET: "secret",
    } as Record<string, string>)[k] ?? realEnvGet(k);

  let tokenMints = 0;
  let graphCalls = 0;
  (globalThis as any).fetch = (url: string, init?: RequestInit) => {
    if (url.includes("login.microsoftonline.com")) {
      tokenMints++;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: `fresh-${tokenMints}`,
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );
    }
    graphCalls++;
    const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    // The captured (stale) token was minted before the scan; mid-scan it expires.
    if (auth === "Bearer stale") {
      return Promise.resolve(
        new Response("Lifetime validation failed, the token is expired.", {
          status: 401,
        }),
      );
    }
    // The retry carries the force-refreshed token → the page drains normally.
    return Promise.resolve(
      new Response(JSON.stringify({ value: [{ id: "post-1" }] }), {
        status: 200,
      }),
    );
  };
  try {
    const { values, pages } = await _graphGetAll<{ id: string }>(
      "https://graph.microsoft.com/v1.0/groups/g/threads",
      "stale",
    );
    // Recovered rather than thrown: the expired 401 triggered exactly one refresh
    // and one retry, and the retried page returned the post.
    assertEquals(values.map((v) => v.id), ["post-1"]);
    assertEquals(pages, 1);
    assertEquals(tokenMints, 1);
    assertEquals(graphCalls, 2); // the 401 + the successful retry
  } finally {
    globalThis.fetch = realFetch;
    (Deno.env as any).get = realEnvGet;
    _resetGraphTokenCache();
  }
});
