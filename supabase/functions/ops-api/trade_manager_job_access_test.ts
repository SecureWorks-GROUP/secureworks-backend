// deno-lint-ignore-file no-import-prefix no-explicit-any
// Trade app, Captain 2026-08-17: "whoever assigns should be able to see all
// the work in the job".
//
// The caller who may ASSIGN crew on a job is decided by _resolveAllocationAuthz:
// office roles by name, then role-agnostic `users.managed_verticals` containing
// the job's vertical. trade_job_detail already honours that same managed
// vertical (TradeJobAccessContext, PR #377) — so an assigner already SEES the
// full detail payload. But three sibling per-job surfaces the trade job tabs
// call still ran the access predicate WITHOUT the context: add_note (Log tab
// write), upload_photo / get_upload_url (Photos tab write) and
// get_service_report (report read). A vertical manager could open the job and
// then be refused on those tabs as "not assigned".
//
// This suite drives the REAL handlers against a stub client and proves:
//   - a fencing-vertical lead who is NOT on the crew passes each gate on a
//     fencing job (the widening), and only there;
//   - the same lead is still refused on a patio job (vertical-scoped);
//   - an ordinary installer with no managed vertical is still refused when
//     unassigned (no guard weakened);
//   - a caller from another tenant is refused before anything else;
//   - the pre-existing MakeSafe field-report exception is untouched.
//
// Gate-passing is observed as the handler proceeding PAST the gate: the stub
// raises a sentinel on the first post-gate write, so a refusal and a pass are
// two different errors that cannot be confused.

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _addNoteForTest,
  _getServiceReportForTest,
  _getUploadUrlForTest,
  _uploadPhotoForTest,
} from "./index.ts";

const ORG_A = "00000000-0000-0000-0000-000000000001";
const ORG_B = "00000000-0000-0000-0000-000000000002";
const PAST_GATE = "PAST_GATE_SENTINEL";

type Tables = Record<string, any[]>;

function fixtures(): Tables {
  return {
    jobs: [
      { id: "job-fence", org_id: ORG_A, type: "fencing", job_number: "SWF-26091", status: "scheduled" },
      { id: "job-patio", org_id: ORG_A, type: "patio", job_number: "SWP-26100", status: "scheduled" },
      { id: "job-ms", org_id: ORG_A, type: "makesafe", job_number: "SWMS-26900", status: "in_progress" },
      { id: "job-fence-b", org_id: ORG_B, type: "fencing", job_number: "SWF-99001", status: "scheduled" },
    ],
    // Henry is NOT on job-fence. Alyx is.
    job_assignments: [
      { id: "a1", job_id: "job-fence", user_id: "u-alyx", status: "scheduled" },
      { id: "a2", job_id: "job-patio", user_id: "u-nithin", status: "scheduled" },
    ],
    makesafe_job_details: [],
    job_service_reports: [],
    org_config: [],
  };
}

// Minimal chainable stand-in for the PostgREST builder: enough for the access
// predicate's reads (jobs by id, job_assignments by job+user, makesafe details,
// service report + template reads); the first WRITE raises the sentinel.
function makeClient(tables: Tables) {
  function builder(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let limitN: number | null = null;
    const run = () => {
      let rows = (tables[table] || []).filter((r) => preds.every((p) => p(r)));
      if (limitN != null) rows = rows.slice(0, limitN);
      return { data: rows, error: null };
    };
    const api: any = {
      select: () => api,
      order: () => api,
      eq: (c: string, v: any) => {
        preds.push((r) => String(r?.[c] ?? "") === String(v));
        return api;
      },
      neq: (c: string, v: any) => {
        preds.push((r) => String(r?.[c] ?? "") !== String(v));
        return api;
      },
      limit: (n: number) => {
        limitN = n;
        return api;
      },
      single: () => Promise.resolve({ data: run().data[0] ?? null, error: null }),
      maybeSingle: () => Promise.resolve({ data: run().data[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
      insert: () => {
        throw new Error(PAST_GATE);
      },
      update: () => {
        throw new Error(PAST_GATE);
      },
      upsert: () => {
        throw new Error(PAST_GATE);
      },
    };
    return api;
  }
  return {
    from: (table: string) => builder(table),
    storage: {
      createBucket: () => {
        throw new Error(PAST_GATE);
      },
      from: () => {
        throw new Error(PAST_GATE);
      },
    },
  };
}

const HENRY = { id: "u-henry", orgId: ORG_A, managedVerticals: ["fencing"] };
const ALYX = { id: "u-alyx", orgId: ORG_A, managedVerticals: [] as string[] };
const SONNY = { id: "u-sonny", orgId: ORG_A, managedVerticals: [] as string[] };

function access(v: { orgId: string; managedVerticals: string[] }) {
  return { orgId: v.orgId, managedVerticals: v.managedVerticals };
}

async function outcome(p: Promise<unknown>): Promise<"passed" | "refused" | string> {
  try {
    await p;
    return "passed";
  } catch (e) {
    const m = String((e as Error)?.message || e);
    if (m === PAST_GATE) return "passed";
    if (/not assigned|not authorized/i.test(m)) return "refused";
    return m;
  }
}

// ── add_note (Log tab) ───────────────────────────────────────────────────────

Deno.test("add_note: a fencing-vertical lead who is NOT on the crew may write to a fencing job's log", async () => {
  const r = await outcome(_addNoteForTest(
    makeClient(fixtures()),
    { jobId: "job-fence", userId: HENRY.id, text: "gate code 1234" },
    false,
    access(HENRY),
  ));
  assertEquals(r, "passed");
});

Deno.test("add_note CONTROL: the same lead is still refused on a patio job (vertical-scoped, not a blanket)", async () => {
  const r = await outcome(_addNoteForTest(
    makeClient(fixtures()),
    { jobId: "job-patio", userId: HENRY.id, text: "x" },
    false,
    access(HENRY),
  ));
  assertEquals(r, "refused");
});

Deno.test("add_note CONTROL: an unassigned installer with no managed vertical is still refused", async () => {
  const r = await outcome(_addNoteForTest(
    makeClient(fixtures()),
    { jobId: "job-fence", userId: SONNY.id, text: "x" },
    false,
    access(SONNY),
  ));
  assertEquals(r, "refused");
});

Deno.test("add_note CONTROL: an assigned installer still passes exactly as before", async () => {
  const r = await outcome(_addNoteForTest(
    makeClient(fixtures()),
    { jobId: "job-fence", userId: ALYX.id, text: "x" },
    false,
    access(ALYX),
  ));
  assertEquals(r, "passed");
});

Deno.test("add_note CONTROL: without the access context the old own-assignment rule is byte-identical (manager refused)", async () => {
  // The dispatch passes the context for every non-staff JWT caller; this pins
  // that the widening lives in the CONTEXT, not in a loosened predicate.
  const r = await outcome(_addNoteForTest(
    makeClient(fixtures()),
    { jobId: "job-fence", userId: HENRY.id, text: "x" },
    false,
  ));
  assertEquals(r, "refused");
});

Deno.test("add_note CONTROL: another tenant's fencing job refuses a fencing lead before anything else", async () => {
  const r = await outcome(_addNoteForTest(
    makeClient(fixtures()),
    { jobId: "job-fence-b", userId: HENRY.id, text: "x" },
    false,
    access(HENRY),
  ));
  assertEquals(r, "refused");
});

// ── upload_photo / get_upload_url (Photos tab) ───────────────────────────────

Deno.test("upload_photo: a fencing lead not on the crew may upload to a fencing job; refused on patio", async () => {
  const ok = await outcome(_uploadPhotoForTest(
    makeClient(fixtures()),
    { jobId: "job-fence", userId: HENRY.id, dataUrl: "data:image/jpeg;base64,AAAA" },
    access(HENRY),
  ));
  assertEquals(ok, "passed");
  const no = await outcome(_uploadPhotoForTest(
    makeClient(fixtures()),
    { jobId: "job-patio", userId: HENRY.id, dataUrl: "data:image/jpeg;base64,AAAA" },
    access(HENRY),
  ));
  assertEquals(no, "refused");
});

Deno.test("upload_photo CONTROL: an unassigned installer is still refused", async () => {
  const r = await outcome(_uploadPhotoForTest(
    makeClient(fixtures()),
    { jobId: "job-fence", userId: SONNY.id, dataUrl: "data:image/jpeg;base64,AAAA" },
    access(SONNY),
  ));
  assertEquals(r, "refused");
});

Deno.test("get_upload_url: a fencing lead not on the crew gets a signed URL for a fencing job; refused on patio", async () => {
  const ok = await outcome(_getUploadUrlForTest(
    makeClient(fixtures()),
    { jobId: "job-fence", fileName: "site.jpg", contentType: "image/jpeg" },
    HENRY.id,
    false,
    access(HENRY),
  ));
  assertEquals(ok, "passed");
  const no = await outcome(_getUploadUrlForTest(
    makeClient(fixtures()),
    { jobId: "job-patio", fileName: "site.jpg", contentType: "image/jpeg" },
    HENRY.id,
    false,
    access(HENRY),
  ));
  assertEquals(no, "refused");
});

Deno.test("get_upload_url CONTROL: an unassigned installer is still refused; an expense receipt never touches the job gate", async () => {
  const no = await outcome(_getUploadUrlForTest(
    makeClient(fixtures()),
    { jobId: "job-fence", fileName: "site.jpg" },
    SONNY.id,
    false,
    access(SONNY),
  ));
  assertEquals(no, "refused");
  const receipt = await outcome(_getUploadUrlForTest(
    makeClient(fixtures()),
    { fileName: "receipt.jpg", purpose: "expense_receipt" },
    SONNY.id,
    false,
    access(SONNY),
  ));
  assertEquals(receipt, "passed");
});

// ── get_service_report (report read) ────────────────────────────────────────

Deno.test("get_service_report: a fencing lead not on the crew may read a fencing job's report; refused on patio", async () => {
  const ok = await _getServiceReportForTest(
    makeClient(fixtures()),
    new URLSearchParams({ jobId: "job-fence" }),
    HENRY.id,
    access(HENRY),
  );
  assertEquals(ok.report, null);
  assertEquals(Array.isArray(ok.checklistTemplate), true);
  await assertRejects(
    () =>
      _getServiceReportForTest(
        makeClient(fixtures()),
        new URLSearchParams({ jobId: "job-patio" }),
        HENRY.id,
        access(HENRY),
      ),
    Error,
    "not assigned",
  );
});

Deno.test("get_service_report CONTROL: an unassigned installer is still refused", async () => {
  await assertRejects(
    () =>
      _getServiceReportForTest(
        makeClient(fixtures()),
        new URLSearchParams({ jobId: "job-fence" }),
        SONNY.id,
        access(SONNY),
      ),
    Error,
    "not assigned",
  );
});

// ── The MakeSafe field-report exception is untouched ────────────────────────

Deno.test("CONTROL: any trade may still read/write an open MakeSafe with no named assignment (unchanged exception)", async () => {
  const note = await outcome(_addNoteForTest(
    makeClient(fixtures()),
    { jobId: "job-ms", userId: SONNY.id, text: "on site" },
    false,
    access(SONNY),
  ));
  assertEquals(note, "passed");
  const rep = await _getServiceReportForTest(
    makeClient(fixtures()),
    new URLSearchParams({ jobId: "job-ms" }),
    SONNY.id,
    access(SONNY),
  );
  assertEquals(rep.report, null);
});
