// deno-lint-ignore-file no-explicit-any no-import-prefix
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _assertClientSignoffForInvoiceForTest as assertClientSignoffForInvoice,
  _assertSignatureMediaNotSignedOffForTest as assertSignatureMediaNotSignedOff,
  _recordOnSiteClientSignoffForTest as recordOnSiteClientSignoff,
  _waiveClientSignoffForTest as waiveClientSignoff,
} from "./index.ts";

// Table-keyed fake. Reads answer the table's rows filtered by eq/in; inserts are
// recorded and echoed back with an id. Every query is logged by table.
function fakeClient(tables: Record<string, any> = {}, opts: { errors?: Record<string, any> } = {}) {
  const inserts: Record<string, any[]> = {};
  const reads: string[] = [];
  return {
    inserts,
    reads,
    from(table: string) {
      const filters: Array<(r: any) => boolean> = [];
      let insertRow: any = null;
      const q: any = {
        select: () => q,
        eq: (col: string, val: any) => { filters.push((r) => r[col] === val); return q; },
        in: (col: string, vals: any[]) => { filters.push((r) => vals.includes(r[col])); return q; },
        gte: (col: string, val: any) => { filters.push((r) => String(r[col]) >= String(val)); return q; },
        order: () => q,
        limit: () => q,
        insert: (row: any) => { insertRow = row; return q; },
        maybeSingle: () => run().then((r: any) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })),
        single: () => run().then((r: any) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] : r.data })),
        then: (res: any, rej: any) => run().then(res, rej),
      };
      function run(): Promise<any> {
        if (opts.errors?.[table]) return Promise.resolve({ data: null, error: opts.errors[table] });
        if (insertRow) {
          const row = { id: `${table}-${(inserts[table]?.length ?? 0) + 1}`, created_at: "2026-10-19T10:00:00Z", ...insertRow };
          (inserts[table] ||= []).push(row);
          return Promise.resolve({ data: [row], error: null });
        }
        reads.push(table);
        const rows = (tables[table] || []).filter((r: any) => filters.every((f) => f(r)));
        return Promise.resolve({ data: rows, error: null });
      }
      return q;
    },
  };
}

const TRADE = { id: "11111111-1111-4111-8111-111111111111", orgId: "org-1" } as any;
const JOB = { id: "job-1" };
const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString();
const old = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();

Deno.test("on site: records name, rating, happy tick and this trade's signature, then a signed-off event", async () => {
  const c = fakeClient({
    job_media: [
      { id: "sig-other-trade", job_id: "job-1", phase: "signature", uploaded_by: "someone-else", created_at: recent },
      { id: "sig-1", job_id: "job-1", phase: "signature", uploaded_by: TRADE.id, created_at: recent },
    ],
  });
  const out = await recordOnSiteClientSignoff(c, { signatureName: "  A  B ", satisfaction_rating: 5, client_happy: true }, TRADE, JOB);
  assertEquals(out, { recorded: true, signoff_id: "job_client_signoffs-1", counts: true });
  const row = c.inserts.job_client_signoffs[0];
  assertEquals([row.method, row.signed_name, row.happy, row.satisfaction_rating, row.signature_media_id], ["on_site", "A B", true, 5, "sig-1"]);
  assertEquals(row.captured_by_actor, `user:${TRADE.id}`);
  assertEquals(c.inserts.job_events[0].event_type, "client_signed_off");
});

Deno.test("on site: an unhappy client still leaves a row, with the not-happy event", async () => {
  const c = fakeClient({ job_media: [{ id: "sig-1", job_id: "job-1", phase: "signature", uploaded_by: TRADE.id, created_at: recent }] });
  const out = await recordOnSiteClientSignoff(c, { signatureName: "A", satisfaction_rating: 2, client_happy: false }, TRADE, JOB);
  assertEquals(out.counts, false);
  assertEquals(c.inserts.job_client_signoffs.length, 1);
  assertEquals(c.inserts.job_events[0].event_type, "client_signoff_not_happy");
});

Deno.test("on site: no name, no signature, or only a stale one records nothing", async () => {
  const none = fakeClient({ job_media: [] });
  assertEquals(await recordOnSiteClientSignoff(none, { satisfaction_rating: 5 }, TRADE, JOB), { recorded: false, reason: "no_signed_name" });
  assertEquals(await recordOnSiteClientSignoff(none, { signatureName: "A" }, TRADE, JOB), { recorded: false, reason: "no_signature" });
  const stale = fakeClient({ job_media: [{ id: "sig-1", job_id: "job-1", phase: "signature", uploaded_by: TRADE.id, created_at: old }] });
  assertEquals((await recordOnSiteClientSignoff(stale, { signatureName: "A" }, TRADE, JOB)).reason, "no_signature");
  assertEquals(none.inserts.job_client_signoffs, undefined);
  assertEquals(stale.inserts.job_client_signoffs, undefined);
});

Deno.test("on site: a failed sign-off write leaves a not-recorded event and still throws", async () => {
  const c = fakeClient(
    { job_media: [{ id: "sig-1", job_id: "job-1", phase: "signature", uploaded_by: TRADE.id, created_at: recent }] },
    { errors: { job_client_signoffs: { message: "x", code: "23514" } } },
  );
  await assertRejects(() => recordOnSiteClientSignoff(c, { signatureName: "A", satisfaction_rating: 5 }, TRADE, JOB));
  assertEquals(c.inserts.job_events.length, 1);
  assertEquals(c.inserts.job_events[0].event_type, "client_signoff_not_recorded");
  assertEquals(c.inserts.job_events[0].detail_json, { method: "on_site", signature_media_id: "sig-1", code: "23514" });
});

Deno.test("on site: a named signature id must be this job's and this trade's", async () => {
  const c = fakeClient({ job_media: [{ id: "sig-x", job_id: "job-2", phase: "signature", uploaded_by: TRADE.id, created_at: recent }] });
  const out = await recordOnSiteClientSignoff(c, { signatureName: "A", signature_media_id: "sig-x" }, TRADE, JOB);
  assertEquals(out, { recorded: false, reason: "no_signature" });
});

Deno.test("on site: an out-of-range rating is stored as no rating, a missing tick as null", async () => {
  const c = fakeClient({ job_media: [{ id: "sig-1", job_id: "job-1", phase: "signature", uploaded_by: TRADE.id, created_at: recent }] });
  await recordOnSiteClientSignoff(c, { signatureName: "A", satisfaction_rating: 9 }, TRADE, JOB);
  const row = c.inserts.job_client_signoffs[0];
  assertEquals([row.satisfaction_rating, row.happy], [null, null]);
});

Deno.test("waiver: needs a job, a reason and a named caller", async () => {
  const c = fakeClient({ jobs: [{ id: "job-1", org_id: "org-1", job_number: "SWF-1" }] });
  const actor = { actor: `user:${TRADE.id}`, missing: false };
  await assertRejects(() => waiveClientSignoff(c, { reason: "client away" }, actor), Error, "job_id required");
  await assertRejects(() => waiveClientSignoff(c, { job_id: "job-1", reason: "no" }, actor), Error, "Say why");
  await assertRejects(() => waiveClientSignoff(c, { job_id: "job-1", reason: "client away" }, { actor: "actor_missing", missing: true }), Error, "records who made it");
  await assertRejects(() => waiveClientSignoff(c, { job_id: "job-9", reason: "client away" }, actor), Error, "Job not found");
  assertEquals(c.inserts.job_client_signoffs, undefined);
});

Deno.test("waiver: records an office_waiver row naming the caller and a signed-off event", async () => {
  const c = fakeClient({ jobs: [{ id: "job-1", org_id: "org-1", job_number: "SWF-1" }] });
  const out = await waiveClientSignoff(c, { job_id: "job-1", reason: "client not responding" }, { actor: `user:${TRADE.id}`, missing: false });
  assertEquals(out, { ok: true, signoff_id: "job_client_signoffs-1", job_number: "SWF-1" });
  const row = c.inserts.job_client_signoffs[0];
  assertEquals([row.method, row.waiver_reason, row.captured_by, row.signature_media_id], ["office_waiver", "client not responding", TRADE.id, undefined]);
  assertEquals(c.inserts.job_events[0].event_type, "client_signed_off");
  // A server-key caller named by x-sw-actor keeps its name and has no user id.
  const k = fakeClient({ jobs: [{ id: "job-1", org_id: "org-1", job_number: "SWF-1" }] });
  await waiveClientSignoff(k, { job_id: "job-1", reason: "client not responding" }, { actor: "terminal:marnin", missing: false });
  assertEquals([k.inserts.job_client_signoffs[0].captured_by, k.inserts.job_client_signoffs[0].captured_by_actor], [null, "terminal:marnin"]);
});

Deno.test("invoice gate: flag off reads no sign-off and never refuses", async () => {
  const c = fakeClient({ feature_flags: [], jobs: [{ id: "job-1", type: "fencing", completed_at: null }] });
  await assertClientSignoffForInvoice(c, [{ id: "job-1", label: "SWF-1" }]);
  assertEquals(c.reads.includes("job_client_signoffs"), false);
});

Deno.test("invoice gate: a newest revoked sign-off blocks invoicing and an unrevoked signature allows it", async () => {
  const flag = [{ flag_name: "trade_invoice_requires_client_signoff_v1", enabled: true }];
  const jobs = [{ id: "job-1", type: "fencing", completed_at: null }];
  const drawn = {
    id: "drawn",
    job_id: "job-1",
    method: "on_site",
    happy: true,
    satisfaction_rating: 5,
    signature_media_id: "sig-1",
    created_at: "2026-10-19T01:00:00Z",
  };
  const revoked = {
    id: "revoked-row",
    job_id: "job-1",
    method: "revoked",
    happy: true,
    satisfaction_rating: 5,
    created_at: "2026-10-19T02:00:00Z",
  };
  const blocked = fakeClient({ feature_flags: flag, jobs, job_client_signoffs: [drawn, revoked] });
  const err = await assertRejects(
    () => assertClientSignoffForInvoice(blocked, [{ id: "job-1", label: "SWF-1" }]),
    Error,
    "SWF-1 cannot be invoiced yet: waiting for the client to sign the job off.",
  );
  assertEquals((err as any).status, 422);
  const open = fakeClient({ feature_flags: flag, jobs, job_client_signoffs: [drawn] });
  await assertClientSignoffForInvoice(open, [{ id: "job-1", label: "SWF-1" }]);
});

Deno.test("invoice gate: flag on refuses an unsigned fencing job with 422 and passes a signed one", async () => {
  const flag = [{ flag_name: "trade_invoice_requires_client_signoff_v1", enabled: true }];
  const jobs = [
    { id: "job-1", type: "fencing", completed_at: null },
    { id: "job-2", type: "fencing", completed_at: null },
    { id: "job-3", type: "makesafe", completed_at: null },
  ];
  const signoffs = [{ id: "s", job_id: "job-2", method: "on_site", happy: true, satisfaction_rating: 5, created_at: "2026-10-19T00:00:00Z" }];
  const c = fakeClient({ feature_flags: flag, jobs, job_client_signoffs: signoffs });
  const err = await assertRejects(() => assertClientSignoffForInvoice(c, [{ id: "job-1", label: "SWF-1" }]), Error, "SWF-1 cannot be invoiced yet");
  assertEquals((err as any).status, 422);
  await assertClientSignoffForInvoice(c, [{ id: "job-2", label: "SWF-2" }, { id: "job-3", label: "SWM-3" }]);
});

Deno.test("invoice gate: flag on and the job read fails holds the job", async () => {
  const flag = [{ flag_name: "trade_invoice_requires_client_signoff_v1", enabled: true }];
  const c = fakeClient({ feature_flags: flag }, { errors: { jobs: { message: "x" } } });
  await assertRejects(() => assertClientSignoffForInvoice(c, [{ id: "job-1", label: "SWF-1" }]), Error, "could not be checked");
});

Deno.test("invoice gate: a job id with no jobs row is held, not let through", async () => {
  const flag = [{ flag_name: "trade_invoice_requires_client_signoff_v1", enabled: true }];
  const c = fakeClient({ feature_flags: flag, jobs: [] });
  await assertRejects(() => assertClientSignoffForInvoice(c, [{ id: "job-gone", label: "SWF-9" }]), Error, "could not be checked");
});

Deno.test("invoice gate: a long job list is read in chunks and every job is judged", async () => {
  const flag = [{ flag_name: "trade_invoice_requires_client_signoff_v1", enabled: true }];
  const jobs = Array.from({ length: 250 }, (_, i) => ({ id: `job-${i}`, type: "makesafe", completed_at: null }));
  const c = fakeClient({ feature_flags: flag, jobs });
  await assertClientSignoffForInvoice(c, jobs.map((j) => ({ id: j.id, label: j.id })));
  assertEquals(c.reads.filter((t) => t === "jobs").length, 3);
});

Deno.test("media delete: a signature used by a sign-off is refused before storage; others pass", async () => {
  const c = fakeClient({ job_client_signoffs: [{ id: "s1", signature_media_id: "sig-1" }] });
  const err = await assertRejects(() => assertSignatureMediaNotSignedOff(c, [{ id: "sig-1", phase: "signature" }]), Error, "client sign-off");
  assertEquals((err as any).status, 409);
  await assertSignatureMediaNotSignedOff(c, [{ id: "sig-2", phase: "signature" }]);
  // A photo is never checked.
  const n = c.reads.length;
  await assertSignatureMediaNotSignedOff(c, [{ id: "sig-1", phase: "completion" }]);
  assertEquals(c.reads.length, n);
  const bad = fakeClient({}, { errors: { job_client_signoffs: { message: "x" } } });
  const e2 = await assertRejects(() => assertSignatureMediaNotSignedOff(bad, [{ id: "sig-1", phase: "signature" }]));
  assertEquals((e2 as any).status, 503);
});
