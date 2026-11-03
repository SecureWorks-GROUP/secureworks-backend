// S13 (Scope Engine shared variable "job status moves on the board (quoted, sold)"): a customer's acceptance moves the
// job from quoted to accepted (sold) or partially accepted, and the move is recorded as job.status_changed, the board
// move the send (draft to quoted) and the decline (quoted to lost) already record. The acceptance moved the job's status
// and recorded no move: 32 of 32 share-link acceptances in the 60 days to 3 Nov 2026 have no quoted-to-accepted event
// (read-only SELECT). The move is recorded once, only by the call whose own update moved the status.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { acceptanceStatusChangedEvent, moveJobStatusOnAcceptance } from "./acceptance_status_move.ts";

const SEND_QUOTE = new URL("./index.ts", import.meta.url);

type Call = { patch: Record<string, unknown>; filters: [string, unknown][]; select: boolean };
// A jobs table of one row; update(...).eq(...)[.eq(...)][.select()] as supabase-js chains it.
function fakeJobs(status: string | null) {
  const row: Record<string, unknown> = { id: "job-1", status };
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      assertEquals(table, "jobs");
      return {
        update(patch: Record<string, unknown>) {
          const call: Call = { patch, filters: [], select: false };
          calls.push(call);
          const run = () => {
            const hit = call.filters.every(([k, v]) => row[k] === v);
            if (hit) Object.assign(row, patch);
            return { data: hit && call.select ? [{ id: row.id }] : null, error: null };
          };
          const chain: any = {
            eq(k: string, v: unknown) { call.filters.push([k, v]); return chain; },
            select() { call.select = true; return Promise.resolve(run()); },
            then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) { return Promise.resolve(run()).then(ok, bad); },
          };
          return chain;
        },
      };
    },
  };
  return { client, row, calls };
}

const base = { jobId: "job-1", jobName: "SWF-TEST-1", documentId: "doc-1", amount: 1100, handler: "send-quote/accept", nowIso: "2026-11-03T16:00:00.000Z" };

Deno.test("the event: quoted to accepted, in the shape the send and the decline write", () => {
  const ev = acceptanceStatusChangedEvent({ ...base, from: "quoted", to: "accepted" })!;
  assertEquals(ev.event_type, "job.status_changed");
  assertEquals(ev.source, "send-quote");
  assertEquals([ev.entity_type, ev.entity_id, ev.job_id, ev.correlation_id], ["job", "job-1", "job-1", "job-1"]);
  assertEquals((ev.payload as any).changes, { status: { from: "quoted", to: "accepted" } });
  assertEquals((ev.payload as any).entity, { id: "job-1", name: "SWF-TEST-1" });
  assertEquals((ev.payload as any).related_entities, [{ type: "job_document", id: "doc-1" }]);
  assertEquals((ev.payload as any).financial, { amount: 1100 });
  assertEquals(ev.metadata, { reason: "quote_accepted", handler: "send-quote/accept" });
  assertEquals([ev.occurred_at, ev.recorded_at, ev.schema_version], [base.nowIso, base.nowIso, "1.0"]);
});

Deno.test("no move, no event: same status, or the status before is not known", () => {
  assertEquals(acceptanceStatusChangedEvent({ ...base, from: "accepted", to: "accepted" }), null);
  assertEquals(acceptanceStatusChangedEvent({ ...base, from: null, to: "accepted" }), null);
  assertEquals(acceptanceStatusChangedEvent({ ...base, from: "quoted", to: "partially_accepted" })!.payload, {
    entity: { id: "job-1", name: "SWF-TEST-1" },
    changes: { status: { from: "quoted", to: "partially_accepted" } },
    financial: { amount: 1100 },
    related_entities: [{ type: "job_document", id: "doc-1" }],
  });
});

Deno.test("acceptance of a quoted job: the job is accepted with its date, and one board move is recorded", async () => {
  const { client, row } = fakeJobs("quoted");
  const emitted: any[] = [];
  const r = await moveJobStatusOnAcceptance(client, { ...base, priorStatus: "quoted", newStatus: "accepted", acceptedAtIso: base.nowIso }, async (e) => { emitted.push(e); });
  assertEquals(row.status, "accepted");
  assertEquals(row.accepted_at, base.nowIso);
  assertEquals(r, { moved: true, recorded: true });
  assertEquals(emitted.length, 1);
  assertEquals(emitted[0].payload.changes, { status: { from: "quoted", to: "accepted" } });
});

Deno.test("the status changed under it (another call moved it first): the job still ends accepted, no second move recorded", async () => {
  const { client, row } = fakeJobs("accepted");
  const emitted: any[] = [];
  const r = await moveJobStatusOnAcceptance(client, { ...base, priorStatus: "quoted", newStatus: "accepted", acceptedAtIso: base.nowIso }, async (e) => { emitted.push(e); });
  assertEquals(row.status, "accepted");
  assertEquals(row.accepted_at, base.nowIso, "the write is the same as before: status and accepted date");
  assertEquals(r, { moved: false, recorded: false });
  assertEquals(emitted.length, 0);
});

Deno.test("partially accepted stays partially accepted on another party's acceptance: written as before, no move recorded", async () => {
  const { client, row } = fakeJobs("partially_accepted");
  const emitted: any[] = [];
  const r = await moveJobStatusOnAcceptance(client, { ...base, priorStatus: "partially_accepted", newStatus: "partially_accepted" }, async (e) => { emitted.push(e); });
  assertEquals(row.status, "partially_accepted");
  assertEquals("accepted_at" in row, false, "no accepted date while partly accepted");
  assertEquals(r, { moved: false, recorded: false });
  assertEquals(emitted.length, 0);
});

Deno.test("the status before was not read: the job is written as before and no move is guessed", async () => {
  const { client, row, calls } = fakeJobs("quoted");
  const emitted: any[] = [];
  const r = await moveJobStatusOnAcceptance(client, { ...base, priorStatus: null, newStatus: "accepted", acceptedAtIso: base.nowIso }, async (e) => { emitted.push(e); });
  assertEquals(row.status, "accepted");
  assertEquals(calls.length, 1);
  assertEquals(r, { moved: false, recorded: false });
  assertEquals(emitted.length, 0);
});

Deno.test("a failed event write never fails the acceptance", async () => {
  const { client, row } = fakeJobs("quoted");
  const r = await moveJobStatusOnAcceptance(client, { ...base, priorStatus: "quoted", newStatus: "accepted", acceptedAtIso: base.nowIso }, () => Promise.reject(new Error("db down")));
  assertEquals(row.status, "accepted");
  assertEquals(r, { moved: true, recorded: false });
});

Deno.test("both acceptance paths (one party, and per run) move the job through moveJobStatusOnAcceptance, reading the status first", async () => {
  const src = await Deno.readTextFile(SEND_QUOTE);
  const uses = src.split("await moveJobStatusOnAcceptance(sb,").length - 1;
  assertEquals(uses, 2, "the one-party and the per-run acceptance");
  assert(!/\.update\(\{ status: jobStatus, \.\.\.\(jobStatus === 'accepted'/.test(src), "the per-run path no longer writes the status directly");
  assert(!/\.update\(\{\s*status: newStatus,\s*\.\.\.\(newStatus === 'accepted'/.test(src), "the one-party path no longer writes the status directly");
  assert(src.includes(".select('id, status, job_number, client_name, type, pricing_json, site_address, site_suburb, ghl_contact_id')"), "the per-run acceptance reads the job's status");
  assert(src.includes(".select('id, status, ghl_opportunity_id, ghl_contact_id, job_number, client_name, type, pricing_json, site_address, site_suburb')"), "the one-party acceptance reads the job's status");
  assertEquals(src.split("priorStatus: job?.status ?? null").length - 1, 2, "each passes the status it read as the status before");
  assert(src.includes("handler: 'send-quote/accept'") && src.includes("'send-quote/accept-run'"), "each path names its handler");
});

Deno.test("planted fault: the acceptance as it stood moved the status and recorded nothing", async () => {
  const { client, row } = fakeJobs("quoted");
  const emitted: unknown[] = [];
  await client.from("jobs").update({ status: "accepted", accepted_at: base.nowIso }).eq("id", "job-1");
  assertEquals(row.status, "accepted");
  assertEquals(emitted.length, 0, "the board never saw quoted to accepted");
  const { client: c2 } = fakeJobs("quoted");
  const fixed: unknown[] = [];
  await moveJobStatusOnAcceptance(c2, { ...base, priorStatus: "quoted", newStatus: "accepted", acceptedAtIso: base.nowIso }, async (e) => { fixed.push(e); });
  assertEquals(fixed.length, 1);
});
