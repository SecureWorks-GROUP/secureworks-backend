// Second real job: existing confirmed PO plus HTTP save/reload.
// Isolated fixture only. No live send, order, calendar write or production.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleDispatch } from "../../supabase/functions/ops-api/dispatch_workbench.ts";
import { createDispatchLocalHandler } from "./local_server.ts";
import { literal, openDispatchPg } from "./pg_client.ts";

const org = "00000000-0000-4000-8000-000000000001";
const actor = "dispatch-po-slice";
const snapshot = JSON.parse(
  await Deno.readTextFile(
    new URL("./real_jobs/swf-261271.json", import.meta.url),
  ),
);
const groupId = "26127100-0000-4000-8000-000000000001";
const noteId = "26127100-0000-4000-8000-000000000099";
const requirementId = (n: number) =>
  `26127100-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function dispatchJob(client: any, jobId: string) {
  return await handleDispatch(
    client,
    org,
    actor,
    "dispatch_job",
    "GET",
    new URLSearchParams({ job_id: jobId }),
    {},
  );
}

async function command(
  client: any,
  jobId: string,
  name: string,
  payload: unknown,
  requestId: string,
) {
  const current = await dispatchJob(client, jobId);
  return await handleDispatch(
    client,
    org,
    actor,
    "dispatch_command",
    "POST",
    new URLSearchParams(),
    {
      job_id: jobId,
      expected_version: current.version,
      source_version: current.source_version,
      request_id: requestId,
      command: name,
      payload,
    },
  );
}

async function seedJob(pg: any) {
  const jobId = snapshot.job_id;
  const po = snapshot.purchase_orders[0];
  const jobInsert = await pg.query(
    `insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json,site_address,scheduled_at)
     values(${literal(jobId)},${literal(org)},'scheduled',${
      literal(snapshot.accepted_at)
    },'{}'::jsonb,'{}'::jsonb,${literal(snapshot.suburb)},${
      literal(snapshot.scheduled_at)
    }) returning jsonb_build_object('id',id)`,
  );
  if (jobInsert.error) throw new Error(jobInsert.error.message);
  const poInsert = await pg.query(
    `insert into purchase_orders(id,org_id,job_id,status,po_number,supplier_name,line_items,total,delivery_date,notes)
     values(${literal(po.id)},${literal(org)},${literal(jobId)},${
      literal(po.status)
    },${literal(po.po_number)},${literal(po.supplier_name)},${
      literal(po.line_items)
    },${literal(po.total)},${literal(po.delivery_date)},${
      literal(
        "SWF-261271. Delivery target 10 Sep. paid_at empty. delivery_confirmed_at empty. Bundled lot line, not split quote units.",
      )
    }) returning jsonb_build_object('id',id)`,
  );
  if (poInsert.error) throw new Error(poInsert.error.message);
  return jobId;
}

Deno.test("SWF-261271 keeps the existing PO visible without inventing quote-unit coverage", async () => {
  const pg = await openDispatchPg();
  try {
    const jobId = await seedJob(pg);
    await command(pg.client, jobId, "group_upsert", {
      id: groupId,
      name: "R&R quote materials",
      position: 0,
    }, requirementId(10));
    for (const [i, line] of snapshot.quote_material_lines.entries()) {
      await command(pg.client, jobId, "requirement_upsert", {
        id: requirementId(i + 1),
        group_id: groupId,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        specification: line.supplier_name,
        destination: "site",
        phase: "installation",
        source_ref: {
          kind: "quote_line",
          job_number: snapshot.job_number,
          as_of: snapshot.as_of,
        },
      }, requirementId(20 + i));
    }
    await command(pg.client, jobId, "note_upsert", {
      id: noteId,
      text:
        "PO-294460 is confirmed as one lot covering panels and plinths. Quote still has 16.7 m and 7 plinths. Do not treat the 10 Sep delivery field as a receipt.",
    }, requirementId(30));

    const saved = await dispatchJob(pg.client, jobId);
    assertEquals(saved.job.id, jobId);
    assertEquals(saved.purchase_orders.length, 1);
    assertEquals(saved.purchase_orders[0].po_number, "PO-294460");
    assertEquals(saved.purchase_orders[0].status, "confirmed");
    assertEquals(saved.purchase_orders[0].line_items[0].quantity, 1);
    assertEquals(saved.requirements.length, 2);
    assertEquals(saved.allocations.length, 0);
    assertEquals(saved.receipts.length, 0);
    const reloaded = await dispatchJob(pg.client, jobId);
    assertEquals(reloaded.version, saved.version);
    assertEquals(reloaded.purchase_orders[0].id, snapshot.purchase_orders[0].id);
    assertEquals(reloaded.notes[0].id, noteId);
  } finally {
    await pg.close();
  }
});

Deno.test("HTTP handler saves SWF-261271 work and reloads the same PO and requirements", async () => {
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
    const jobId = await seedJob(pg);
    await listening;
    const base = `http://127.0.0.1:${port}/functions/v1/ops-api`;
    const json = async (url: string, init?: RequestInit) => {
      const response = await fetch(url, {
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || response.statusText);
      return body;
    };
    const loaded = await json(`${base}?action=dispatch_job&job_id=${jobId}`);
    assertEquals(loaded.purchase_orders[0].po_number, "PO-294460");
    const grouped = await json(`${base}?action=dispatch_command`, {
      method: "POST",
      body: JSON.stringify({
        job_id: jobId,
        expected_version: loaded.version,
        source_version: loaded.source_version,
        request_id: requirementId(40),
        command: "group_upsert",
        payload: { id: groupId, name: "R&R quote materials", position: 0 },
      }),
    });
    let version = grouped.version;
    let source = grouped.source_version;
    for (const [i, line] of snapshot.quote_material_lines.entries()) {
      const saved = await json(`${base}?action=dispatch_command`, {
        method: "POST",
        body: JSON.stringify({
          job_id: jobId,
          expected_version: version,
          source_version: source,
          request_id: requirementId(41 + i),
          command: "requirement_upsert",
          payload: {
            id: requirementId(i + 1),
            group_id: groupId,
            description: line.description,
            quantity: line.quantity,
            unit: line.unit,
            specification: line.supplier_name,
            destination: "site",
            phase: "installation",
          },
        }),
      });
      version = saved.version;
      source = saved.source_version;
    }
    const reloaded = await json(`${base}?action=dispatch_job&job_id=${jobId}`);
    assertEquals(reloaded.version, version);
    assertEquals(reloaded.groups[0].id, groupId);
    assertEquals(reloaded.requirements.length, 2);
    assertEquals(reloaded.purchase_orders.length, 1);
    assertEquals(reloaded.purchase_orders[0].status, "confirmed");
    assertEquals(reloaded.allocations.length, 0);
  } finally {
    controller.abort();
    await server.finished;
    await pg.close();
  }
});
