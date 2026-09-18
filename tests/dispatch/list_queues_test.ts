import {
  assertEquals,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createDispatchLocalHandler } from "./local_server.ts";
import { literal, openDispatchPg } from "./pg_client.ts";

const org = "00000000-0000-4000-8000-000000000011";
const foreignOrg = "00000000-0000-4000-8000-000000000012";
const actor = "dispatch-list-queues";
const id = (n: number) =>
  `cc000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

Deno.test("Dispatch list classifies material, acceptance and historical queues", async () => {
  const pg = await openDispatchPg();
  const controller = new AbortController();
  let port = 0;
  let ready!: () => void;
  const listening = new Promise<void>((resolve) => ready = resolve);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: controller.signal,
    onListen(address) {
      port = address.port;
      ready();
    },
  }, createDispatchLocalHandler(pg.client, org, actor));
  try {
    const insertJob = async (
      n: number,
      status: string,
      accepted: boolean,
      targetOrg = org,
    ) => {
      const result = await pg.query(
        `insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json,job_number,type)
         values(${literal(id(n))},${literal(targetOrg)},${literal(status)},${
          accepted ? "now()" : "null"
        },'{}'::jsonb,'{}'::jsonb,${literal(`QUEUE-${n}`)},'fencing')
         returning jsonb_build_object('id',id)`,
      );
      if (result.error) throw new Error(result.error.message);
    };
    await insertJob(1, "accepted", true);
    await insertJob(2, "processing", false);
    await insertJob(3, "processing", false);
    await insertJob(4, "complete", true);
    await insertJob(5, "complete", false);
    await insertJob(6, "processing", false);
    await insertJob(7, "accepted", true, foreignOrg);
    await insertJob(8, "archived", true);
    const documents = await pg.query(
      `insert into job_documents(id,job_id,type,accepted_at,superseded_at) values
       (${literal(id(30))},${literal(id(3))},'quote',now(),null),
       (${literal(id(31))},${literal(id(6))},'quote',now(),now())
       returning jsonb_build_object('id',id)`,
    );
    if (documents.error) throw new Error(documents.error.message);
    await listening;
    const base = `http://127.0.0.1:${port}/functions/v1/ops-api`;
    const json = async (url: string) => {
      const response = await fetch(url, {
        headers: { "content-type": "application/json" },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || response.statusText);
      return body;
    };
    const current = await json(`${base}?action=dispatch_list&limit=10`);
    assertEquals(current.jobs.map((job: { id: string }) => job.id), [
      id(1),
      id(3),
    ]);
    assertEquals(current.coverage.queue, "current_material");
    assertEquals(current.coverage.universe, 6);
    assertEquals(current.coverage.accepted, 3);
    assertEquals(current.coverage.unresolved, 3);
    assertEquals(current.coverage.queues, {
      current_material: 2,
      acceptance_review: 2,
      historical: 2,
    });
    const review = await json(
      `${base}?action=dispatch_list&queue=acceptance_review&limit=1`,
    );
    assertEquals(review.jobs.length, 1);
    assertEquals(review.jobs[0].id, id(2));
    assertEquals(review.jobs[0].next_action, "Resolve acceptance evidence");
    assertEquals(review.coverage.has_more, true);
    assertEquals(review.coverage.complete, false);
    const reviewRest = await json(
      `${base}?action=dispatch_list&queue=acceptance_review&limit=10&cursor=${review.next_cursor}`,
    );
    assertEquals(reviewRest.jobs.map((job: { id: string }) => job.id), [
      id(6),
    ]);
    assertEquals(reviewRest.coverage.complete, true);
    const historical = await json(
      `${base}?action=dispatch_list&queue=historical&limit=10`,
    );
    assertEquals(historical.jobs.map((job: { id: string }) => job.id), [
      id(4),
      id(5),
    ]);
    assertEquals(historical.jobs[0].dispatch_queue, "historical");
    assertNotEquals(
      historical.jobs[0].next_action,
      "Review material obligations",
    );
  } finally {
    controller.abort();
    await server.finished;
    await pg.close();
  }
});
