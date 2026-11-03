// deno-lint-ignore-file no-explicit-any
// What the office group receives when a crew member cannot invoice a job for
// want of a work order amount (owner, 3 Nov 2026).
import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  requestWorkOrderAmount,
  WORK_ORDER_REQUEST_EVENT,
  type WorkOrderRequestEmail,
} from "./work_order_request.ts";

function fakeClient(jobs: any[], events: any[]) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const q: any = {
        select: () => q,
        eq: (col: string, val: unknown) => {
          filters.push([col, val]);
          return q;
        },
        limit: () => q,
        maybeSingle: () => {
          const row = jobs.find((j) => filters.every(([c, v]) => j[c] === v));
          return Promise.resolve({ data: row ?? null, error: null });
        },
        insert: (row: any) => {
          events.push(row);
          return Promise.resolve({ error: null });
        },
        then: (resolve: any) => {
          const rows = events.filter((e) =>
            filters.every(([c, v]) =>
              c === "detail_json->>perth_day" ? e.detail_json?.perth_day === v : e[c] === v
            )
          );
          return resolve({ data: table === "job_events" ? rows : [], error: null });
        },
      };
      return q;
    },
  };
}

const JOBS = [
  { id: "j1", job_number: "SWP-261210", client_name: "Rina", site_address: "1 Test St, Baldivis", type: "patio" },
  { id: "j2", job_number: "SWF-26999", client_name: "Kim", site_address: "2 Test St, Byford", type: "fencing" },
];

Deno.test("no work order amount: the patio group is emailed once a day", async () => {
  const sent: WorkOrderRequestEmail[] = [];
  const events: any[] = [];
  const client = fakeClient(JOBS, events);
  const deps = {
    sendEmail: (e: WorkOrderRequestEmail) => (sent.push(e), Promise.resolve({ ok: true })),
    now: () => new Date("2026-11-03T05:00:00Z"),
  };
  const req = { jobId: "j1", crewName: "Alyx", crewEmail: "alyx@example.com", reason: "no_work_order_amount" as const };

  const first = await requestWorkOrderAmount(client, req, deps);
  const again = await requestWorkOrderAmount(client, req, deps);

  assertEquals(first, { status: "sent", to: "patios@secureworkswa.com.au" });
  assertEquals(again.status, "already_sent_today");
  assertEquals(sent.length, 1);
  assertEquals(sent[0].subject, "Work order needed: SWP-261210");
  assertStringIncludes(sent[0].body_html, "Alyx tried to invoice this job, but it has no work order amount yet");
  assertStringIncludes(sent[0].body_html, "1 Test St, Baldivis");
  assertStringIncludes(sent[0].body_html, "Please set the work order amount");
  assertEquals(events[0].event_type, WORK_ORDER_REQUEST_EVENT);
  assertEquals(sent[0].body_html.includes("—"), false);
});

Deno.test("fence job goes to fencing@; a job the crew cannot find goes to the team they name", async () => {
  const sent: WorkOrderRequestEmail[] = [];
  const client = fakeClient(JOBS, []);
  const deps = { sendEmail: (e: WorkOrderRequestEmail) => (sent.push(e), Promise.resolve({ ok: true })) };

  await requestWorkOrderAmount(client, { jobId: "j2", crewName: "Ben", reason: "no_work_order_amount" }, deps);
  const lost = await requestWorkOrderAmount(client, {
    jobText: "12 Smith St Armadale, Jones",
    team: "patio",
    crewName: "Ben",
    reason: "cannot_find_job",
  }, deps);

  assertEquals(sent[0].to, "fencing@secureworkswa.com.au");
  assertEquals(lost.to, "patios@secureworkswa.com.au");
  assertEquals(sent[1].subject, "Work order needed: Ben cannot find 12 Smith St Armadale, Jones");
  assertStringIncludes(sent[1].body_html, "What they typed:</b> 12 Smith St Armadale, Jones");
});

Deno.test("a failed send does not throw", async () => {
  const client = fakeClient(JOBS, []);
  const out = await requestWorkOrderAmount(client, { jobId: "j1", crewName: "Alyx", reason: "no_work_order_amount" }, {
    sendEmail: () => Promise.resolve({ ok: false, error: "graph 503" }),
  });
  assertEquals(out.status, "send_failed");
});
