// Dispatch page contract: paginated accepted population through the production
// handler and SQL save/reload. Synthetic IDs only. No live send or receipt.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createDispatchLocalHandler } from "./local_server.ts";
import { literal, openDispatchPg } from "./pg_client.ts";

const org = "00000000-0000-4000-8000-000000000001";
const actor = "dispatch-population";
const id = (n: number) =>
  `bb000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

Deno.test("Dispatch list paginates accepted jobs and SQL save/reload keeps a confirmed PO unreceived", async () => {
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
    for (let n = 1; n <= 30; n++) {
      const inserted = await pg.query(
        `insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json,job_number,type)
         values(${literal(id(n))},${literal(org)},'accepted',now(),'{}'::jsonb,'{}'::jsonb,${
          literal(`FIX-POP-${String(n).padStart(2, "0")}`)
        },'fencing') returning jsonb_build_object('id',id)`,
      );
      if (inserted.error) throw new Error(inserted.error.message);
    }
    const poJob = id(1);
    const poId = id(90);
    const poInsert = await pg.query(
      `insert into purchase_orders(id,org_id,job_id,status,po_number,supplier_name,line_items,total,delivery_date)
       values(${literal(poId)},${literal(org)},${literal(poJob)},'confirmed','PO-FIX-1','Fixture supplier','[{"description":"Fixture lot","quantity":1,"unit":"lot"}]'::jsonb,10,'2026-09-10')
       returning jsonb_build_object('id',id)`,
    );
    if (poInsert.error) throw new Error(poInsert.error.message);
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
    const page = await json(`${base}?action=dispatch_list&limit=25`);
    assertEquals(page.jobs.length, 25);
    assertEquals(page.coverage.has_more, true);
    assertEquals(page.next_cursor != null, true);
    const rest = await json(
      `${base}?action=dispatch_list&limit=25&cursor=${page.next_cursor}`,
    );
    assertEquals(rest.jobs.length >= 5, true);
    assertEquals(
      new Set([...page.jobs, ...rest.jobs].map((job: { id: string }) => job.id))
        .size >= 30,
      true,
    );
    const loaded = await json(`${base}?action=dispatch_job&job_id=${poJob}`);
    assertEquals(loaded.purchase_orders[0].po_number, "PO-FIX-1");
    assertEquals(loaded.purchase_orders[0].status, "confirmed");
    assertEquals(loaded.receipts.length, 0);
    const saved = await json(`${base}?action=dispatch_command`, {
      method: "POST",
      body: JSON.stringify({
        job_id: poJob,
        expected_version: loaded.version,
        source_version: loaded.source_version,
        request_id: id(91),
        command: "note_upsert",
        payload: {
          id: id(92),
          text: "Confirmed PO is not a receipt until usable quantity is verified.",
        },
      }),
    });
    const reloaded = await json(`${base}?action=dispatch_job&job_id=${poJob}`);
    assertEquals(reloaded.version, saved.version);
    assertEquals(reloaded.notes[0].id, id(92));
    assertEquals(reloaded.receipts.length, 0);
    assertEquals(reloaded.purchase_orders[0].status, "confirmed");
  } finally {
    controller.abort();
    await server.finished;
    await pg.close();
  }
});
