// Calendar OOM regression guard.
// ---------------------------------------------------------------------------
// GET ops-api?action=calendar was returning HTTP 546 (edge worker killed for
// exceeding its memory limit) on wide date windows. Cause: calendarEvents
// selected the full calendar_events.scope_json blob — ~100 kB/row average,
// 2.6 MB worst case, almost all of it base64 media under job.sitePlanImage /
// job.checklist — purely to derive the readiness badges, then stripped it from
// the response. A ~200-row window pulled tens of MB into the worker.
//
// This file guards the fix, in both directions:
//   (a) the calendar query must never select the scope_json blob (either branch);
//   (b) readiness must be computed IDENTICALLY to the pre-fix whole-blob logic —
//       a fixture row with a fat scope_json is run through the old code path and
//       the new projection path, and the two readiness objects must match.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _CAL_SCOPE_ALIASES_FOR_TEST,
  _CAL_SCOPE_PROJECTION_FOR_TEST,
  _computeReadinessForTest,
  _scopeFromProjectionForTest,
  calendarEvents,
} from "./index.ts";

// ── Mock that captures the select string and serves calendar rows ──
function calClient(calRows: any[]) {
  const captured: { selects: Record<string, string> } = { selects: {} };
  function builder(table: string) {
    const b: any = {
      select: (s: string) => {
        captured.selects[table] = s;
        return b;
      },
      or: () => b,
      lte: () => b,
      gte: () => b,
      eq: () => b,
      neq: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      then: (res: any, rej: any) =>
        Promise.resolve({
          data: table === "calendar_events" ? calRows : [],
          error: null,
        })
          .then(res, rej),
    };
    return b;
  }
  return { client: { from: (t: string) => builder(t) }, captured };
}
const params = (extra: Record<string, string> = {}) =>
  new URLSearchParams({ from: "2026-07-01", to: "2026-07-31", ...extra });

// A realistic fencing scope_json: the readiness-relevant keys buried alongside
// the megabytes of base64 the fix stops transferring.
const FAT_BASE64 = "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUg".repeat(4000);
function fatScopeJson() {
  return {
    version: 3,
    tool: "fencing-scoper",
    attachmentMethod: "Freestanding posts",
    attachment: "Post and rail",
    notes: "Gate swings inward",
    scope: { summary: "Replace 12m boundary fence" },
    job: {
      ref: "SWF-1234",
      client: "Steve Taylor",
      address: "12 Example St",
      colour: "Monument",
      removal: {
        notes: "",
        access: "easy",
        disposal: "company",
        removalRequired: true,
        existingFenceType: "asbestos",
        asbestosCert: false,
        asbestosSheetCount: 10,
        existingFenceLength: 10,
      },
      quote: { deliveryFee: 100, urgency: "standard" },
      siteNotes: "Rear access via laneway",
      supplierNotes: "",
      // The bloat — base64 media, never read by readiness.
      sitePlanImage: FAT_BASE64,
      checklist: { photos: [FAT_BASE64, FAT_BASE64] },
    },
    scopeMedia: {},
  };
}

// The projected row PostgREST returns for that job, derived from the SHIPPED
// CAL_SCOPE_PROJECTION rather than from a hand-written copy of it: each entry is
// parsed as `alias:scope_json->a->b` and that path is walked against the blob,
// exactly as PostgREST would. So a path that drifts (renamed key, wrong case,
// wrong nesting) resolves to null here and fails the parity tests, instead of
// passing green while production silently loses the badge.
function resolveProjection(entry: string, scope: any): unknown {
  const segments = entry.slice(entry.indexOf(":") + 1).split("->");
  assertEquals(
    segments[0],
    "scope_json",
    `projection '${entry}' must read from scope_json`,
  );
  let cursor: any = scope;
  for (const key of segments.slice(1)) {
    cursor = cursor == null ? undefined : cursor[key];
  }
  return cursor ?? null;
}
function aliasOf(entry: string) {
  return entry.slice(0, entry.indexOf(":"));
}
function projectedRow(scope: any, over: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    assignment_id: "asg-1",
    job_id: "job-1",
    job_type: "fencing",
    scheduled_date: "2026-07-08",
    assignment_status: "confirmed",
    org_id: "org-1",
  };
  for (const entry of _CAL_SCOPE_PROJECTION_FOR_TEST) {
    row[aliasOf(entry)] = resolveProjection(entry, scope);
  }
  return { ...row, ...over };
}

// ── (a) the blob must not be selected ──
Deno.test("calendar query never selects the scope_json blob — light path projects only the readiness keys", async () => {
  const { client, captured } = calClient([]);
  await calendarEvents(client, params());
  const sel = captured.selects["calendar_events"];
  assert(sel, "calendar_events was queried");
  assert(
    !/(^|[\s,])scope_json([\s,]|$)/.test(sel),
    `bare scope_json must not be selected; saw: ${sel}`,
  );
  for (const entry of _CAL_SCOPE_PROJECTION_FOR_TEST) {
    assert(
      sel.includes(entry),
      `readiness key '${entry}' is projected instead`,
    );
  }
  assert(
    !sel.includes("sitePlanImage") && !sel.includes("checklist"),
    "the base64 media keys are never fetched",
  );
});

Deno.test("include_financials=true keeps pricing_json but also drops the scope_json blob", async () => {
  const { client, captured } = calClient([]);
  await calendarEvents(client, params({ include_financials: "true" }));
  const sel = captured.selects["calendar_events"];
  assert(
    !sel.includes("*"),
    "the '*' select carried the blob — it must be enumerated",
  );
  assert(
    !/(^|[\s,])scope_json([\s,]|$)/.test(sel),
    `bare scope_json must not be selected; saw: ${sel}`,
  );
  assert(
    sel.includes("pricing_json"),
    "pricing_json is tiny and stays (financial branch)",
  );
  assert(sel.includes("xero_invoiced"), "financial columns still selected");
});

// job_intelligence is the readiness-column MATERIALIZED VIEW on a
// migration-provisioned DB and a table without those columns on live prod, so
// select('*') is the only shape that keeps readiness identical on both. Trimming
// it to an enumeration would silently drop real readiness inputs on the former.
Deno.test("job_intelligence stays select('*')", async () => {
  const { client, captured } = calClient([projectedRow(fatScopeJson())]);
  await calendarEvents(client, params());
  assertEquals(captured.selects["job_intelligence"], "*");
});

// ── every projected path must actually resolve. Parity below only exercises the
// two paths readiness reads, so drift on the other six (projected for
// drift-tolerance) would otherwise pass unnoticed. The fixture carries every key
// the projection names, so a null here means the path is wrong. ──
Deno.test("every CAL_SCOPE_PROJECTION path resolves against a real scope_json", () => {
  const scope = fatScopeJson();
  const row: any = projectedRow(scope);
  for (const entry of _CAL_SCOPE_PROJECTION_FOR_TEST) {
    const alias = aliasOf(entry);
    assert(
      row[alias] != null,
      `projection '${entry}' resolved to nothing — the fixture carries that key, so the path has drifted`,
    );
  }
});

// ── (b) readiness parity: pre-fix (whole blob) vs post-fix (projection) ──
const PRE_FIX_INTEL = {}; // job_intelligence carries no readiness columns today

function readinessPreFix(scope: any) {
  // The old call: the FULL blob straight off the event row.
  return _computeReadinessForTest("fencing", PRE_FIX_INTEL, scope, {}, [
    {
      status: "confirmed",
      assignment_type: "install",
      scheduled_date: "2099-01-01",
    },
  ]);
}
function readinessPostFix(row: any) {
  return _computeReadinessForTest(
    "fencing",
    PRE_FIX_INTEL,
    _scopeFromProjectionForTest(row),
    {},
    [
      {
        status: "confirmed",
        assignment_type: "install",
        scheduled_date: "2099-01-01",
      },
    ],
  );
}

Deno.test("readiness is byte-for-byte identical for a fat scope_json — projection vs full blob", () => {
  const scope = fatScopeJson();
  assertEquals(
    JSON.stringify(readinessPostFix(projectedRow(scope))),
    JSON.stringify(readinessPreFix(scope)),
    "asbestos-clearance badge must survive the projection unchanged",
  );
  // Guard the guard: this fixture really does exercise the asbestos rule.
  assert(
    readinessPreFix(scope).completeness.some((c: any) =>
      c.key === "asbestos_clearance"
    ),
    "fixture must trigger scope_mentions_asbestos, else the parity assert is vacuous",
  );
});

Deno.test("readiness parity holds when the scope does NOT mention asbestos", () => {
  const scope = fatScopeJson();
  scope.job.removal = {
    notes: "",
    access: "easy",
    disposal: "company",
    removalRequired: false,
    existingFenceType: "other",
    existingFenceLength: 0,
  } as any;
  assertEquals(
    JSON.stringify(readinessPostFix(projectedRow(scope))),
    JSON.stringify(readinessPreFix(scope)),
  );
  assert(
    !readinessPreFix(scope).completeness.some((c: any) =>
      c.key === "asbestos_clearance"
    ),
    "clean scope must not raise the asbestos rule (negative control)",
  );
});

Deno.test("readiness parity holds for an empty / missing scope_json", () => {
  assertEquals(
    JSON.stringify(readinessPostFix(projectedRow(null))),
    JSON.stringify(readinessPreFix(null)),
  );
  assertEquals(
    _scopeFromProjectionForTest(projectedRow(null)),
    null,
    "nothing projected -> null, as before",
  );
});

Deno.test("patio attachment_is_fascia still reads through the projection", () => {
  const scope: any = fatScopeJson();
  scope.attachmentMethod = "Fascia bracket";
  const assignments = [{
    status: "confirmed",
    assignment_type: "install",
    scheduled_date: "2099-01-01",
  }];
  const pre = _computeReadinessForTest(
    "patio",
    PRE_FIX_INTEL,
    scope,
    {},
    assignments,
  );
  const post = _computeReadinessForTest(
    "patio",
    PRE_FIX_INTEL,
    _scopeFromProjectionForTest(projectedRow(scope)),
    {},
    assignments,
  );
  assertEquals(JSON.stringify(post), JSON.stringify(pre));
  assert(
    pre.completeness.some((c: any) => c.key === "engineering_doc"),
    "fixture must trigger attachment_is_fascia, else the parity assert is vacuous",
  );
});

// ── response shape must not leak the projection aliases ──
Deno.test("response shape unchanged — rd_* aliases and scope_json/org_id are stripped from events", async () => {
  const { client } = calClient([projectedRow(fatScopeJson())]);
  const res: any = await calendarEvents(client, params());
  assertEquals(Object.keys(res).sort(), [
    "deliveries",
    "events",
    "readiness",
    "truncated",
  ]);
  const ev = res.events[0];
  assert(_CAL_SCOPE_ALIASES_FOR_TEST.size > 0, "alias set must be non-empty");
  for (const alias of _CAL_SCOPE_ALIASES_FOR_TEST) {
    assert(
      !(alias in ev),
      `projection alias '${alias}' leaked into the response`,
    );
  }
  assert(
    !("scope_json" in ev) && !("org_id" in ev),
    "scope_json/org_id stay stripped",
  );
  assertEquals(ev.assignment_id, "asg-1");
  assert(res.readiness["job-1"], "readiness still computed per job");
});
