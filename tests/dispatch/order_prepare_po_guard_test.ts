// deno-lint-ignore-file no-explicit-any
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DispatchError,
  handleDispatch,
} from "../../supabase/functions/ops-api/dispatch_workbench.ts";
import { literal, openDispatchPg } from "./pg_client.ts";

const org = "00000000-0000-4000-8000-000000000001";
const actor = "order-prepare-po-guard";
const id = (n: number) =>
  `34000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function insertAcceptedJob(pg: any, jobId: string) {
  const result = await pg.query(
    `insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json) values(${
      literal(jobId)
    },${
      literal(org)
    },'accepted',now(),'{}'::jsonb,'{}'::jsonb) returning jsonb_build_object('id',id)`,
  );
  if (result.error) throw new Error(result.error.message);
}

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

async function dispatchCommand(
  client: any,
  jobId: string,
  command: string,
  payload: any,
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
      command,
      payload,
    },
  );
}

async function setupReviewedRequirement(
  client: any,
  jobId: string,
  requirementId: string,
) {
  await dispatchCommand(client, jobId, "requirement_upsert", {
    id: requirementId,
    description: "Roof sheets",
    quantity: 2,
    unit: "each",
    specification: "Reviewed profile",
    destination: "site",
    phase: "roof",
  }, id(1000 + Number(requirementId.slice(-12))));
  await dispatchCommand(client, jobId, "requirement_review", {
    id: requirementId,
  }, id(2000 + Number(requirementId.slice(-12))));
}

async function reviewRequirement(
  client: any,
  jobId: string,
  requirementId: string,
  requestId: string,
) {
  await dispatchCommand(client, jobId, "requirement_review", {
    id: requirementId,
  }, requestId);
}

function orderPayload(poId: string, requirementId: string, supplier: string) {
  return {
    id: poId,
    supplier_name: supplier,
    delivery_address: "Fixture site",
    requirement_ids: [requirementId],
    existing_supply_reviewed: true,
    quantities: { [requirementId]: 1 },
  };
}

Deno.test("order_prepare updates only editable Dispatch draft POs", async () => {
  const pg = await openDispatchPg();
  try {
    const job = id(1), requirement = id(2), po = id(3);
    await insertAcceptedJob(pg, job);
    await setupReviewedRequirement(pg.client, job, requirement);
    await dispatchCommand(
      pg.client,
      job,
      "order_prepare",
      orderPayload(po, requirement, "First supplier"),
      id(4),
    );
    await reviewRequirement(pg.client, job, requirement, id(6));
    await dispatchCommand(
      pg.client,
      job,
      "order_prepare",
      orderPayload(po, requirement, "Second supplier"),
      id(5),
    );
    const draft = await pg.query(
      `select jsonb_build_object('status',status,'supplier_name',supplier_name,'total',total,'reference',reference) from purchase_orders where id=${
        literal(po)
      }`,
    );
    if (draft.error) throw new Error(draft.error.message);
    assertEquals(draft.data, {
      status: "draft",
      supplier_name: "Second supplier",
      total: null,
      reference: `dispatch:${po}`,
    });
  } finally {
    await pg.close();
  }
});

async function snapshot(pg: any, job: string, po: string) {
  const result = await pg.query(
    `select jsonb_build_object(
      'po',(select to_jsonb(p) from purchase_orders p where id=${literal(po)}),
      'plan',(select to_jsonb(p) from dispatch_plans p where org_id=${
      literal(org)
    } and job_id=${literal(job)}),
      'commands',(select count(*) from dispatch_commands where org_id=${
      literal(org)
    } and job_id=${literal(job)}),
      'events',(select count(*) from business_events where job_id=${
      literal(job)
    })
    )`,
  );
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

for (
  const [name, patch] of [
    ["issued status", "status='confirmed'"],
    ["Xero link", "xero_po_id='xero-locked'"],
    ["unknown status", "status=null"],
    ["another organisation", "org_id='00000000-0000-4000-8000-000000000002'"],
    ["another job", "job_id='10000000-0000-4000-8000-000000000002'"],
    ["missing reference", "reference=null"],
    ["another reference", "reference='manual-order'"],
  ]
) {
  Deno.test(`order_prepare refuses ${name} at the PO write boundary`, async () => {
    const pg = await openDispatchPg();
    try {
      const job = id(11), requirement = id(12), po = id(13);
      await insertAcceptedJob(pg, job);
      await setupReviewedRequirement(pg.client, job, requirement);
      await dispatchCommand(
        pg.client,
        job,
        "order_prepare",
        orderPayload(po, requirement, "Original supplier"),
        id(14),
      );
      const changed = await pg.query(
        `update purchase_orders set ${patch}, supplier_name='Locked supplier', notes='locked notes',
          subtotal=100,tax=10,total=110 where id=${
          literal(po)
        } returning jsonb_build_object('id',id)`,
      );
      if (changed.error) throw new Error(changed.error.message);
      await reviewRequirement(pg.client, job, requirement, id(15));
      const before = await snapshot(pg, job, po);
      await assertRejects(
        () =>
          dispatchCommand(
            pg.client,
            job,
            "order_prepare",
            orderPayload(po, requirement, "Replacement supplier"),
            id(16),
          ),
        DispatchError,
        "order_not_editable",
      );
      assertEquals(await snapshot(pg, job, po), before);
    } finally {
      await pg.close();
    }
  });
}

Deno.test("order_prepare rolls back plan and event writes when the PO write affects zero rows", async () => {
  const pg = await openDispatchPg();
  try {
    const job = id(21), requirement = id(22), po = id(23);
    await insertAcceptedJob(pg, job);
    await setupReviewedRequirement(pg.client, job, requirement);
    await dispatchCommand(
      pg.client,
      job,
      "order_prepare",
      orderPayload(po, requirement, "Original supplier"),
      id(24),
    );
    await reviewRequirement(pg.client, job, requirement, id(25));
    const trigger = await pg.query(
      `create function pg_temp.suppress_dispatch_po_write() returns trigger language plpgsql as $$
       begin
         if new.id=${literal(po)}::uuid then return null; end if;
         return new;
       end $$;
       create trigger suppress_dispatch_po_write before insert on purchase_orders
       for each row execute function pg_temp.suppress_dispatch_po_write();
       select jsonb_build_object('ready',true)`,
    );
    if (trigger.error) throw new Error(trigger.error.message);
    const before = await snapshot(pg, job, po);
    await assertRejects(
      () =>
        dispatchCommand(
          pg.client,
          job,
          "order_prepare",
          orderPayload(po, requirement, "Replacement supplier"),
          id(26),
        ),
      DispatchError,
      "order_not_editable",
    );
    assertEquals(await snapshot(pg, job, po), before);
  } finally {
    await pg.close();
  }
});
