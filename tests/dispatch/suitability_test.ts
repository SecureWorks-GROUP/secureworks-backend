// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DispatchError,
  handleDispatch,
} from "../../supabase/functions/ops-api/dispatch_workbench.ts";
import { literal, openDispatchPg } from "./pg_client.ts";

const org = "00000000-0000-4000-8000-000000000001";
const actor = "suitability-test";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function insertAcceptedJob(pg: any, jobId: string) {
  const result = await pg.query(
    `insert into jobs(id,org_id,status,accepted_at,scope_json,pricing_json) values(${
      literal(jobId)
    },${
      literal(org)
    },'accepted',now(),'{}','{}') returning jsonb_build_object('id',id)`,
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

async function insertConfirmedPo(
  pg: any,
  jobId: string,
  poId: string,
  line: any,
) {
  const result = await pg.query(
    `insert into purchase_orders(id,org_id,job_id,status,line_items,supplier_name,notes) values(${
      literal(poId)
    },${literal(org)},${literal(jobId)},'confirmed',jsonb_build_array(${
      literal(line)
    }),'Supplier','Deliver to: Site') returning jsonb_build_object('id',id)`,
  );
  if (result.error) throw new Error(result.error.message);
}

Deno.test("handler SQL suitability follows physical requirement revision and explicit confirmation", async () => {
  const pg = await openDispatchPg();
  try {
    const jobId = id(801), requirementId = id(802), po = id(803);
    const allocationId = id(804), receiptId = id(805);
    await insertAcceptedJob(pg, jobId);
    await dispatchCommand(pg.client, jobId, "requirement_upsert", {
      id: requirementId,
      description: "Standard sheets",
      quantity: 10,
      unit: "sheet",
      specification: "0.42 BMT roof sheet",
      destination: "site",
    }, id(1801));
    await dispatchCommand(pg.client, jobId, "requirement_review", {
      id: requirementId,
    }, id(1802));
    await dispatchCommand(pg.client, jobId, "set_review", {}, id(1803));
    await insertConfirmedPo(pg, jobId, po, {
      description: "Standard sheets",
      quantity: 10,
      unit: "sheet",
      specification: "0.42 BMT roof sheet",
    });
    await dispatchCommand(pg.client, jobId, "allocation_upsert", {
      id: allocationId,
      requirement_id: requirementId,
      supply_id: `po:${po}:0`,
      quantity: 10,
    }, id(1804));
    await dispatchCommand(pg.client, jobId, "receipt_upsert", {
      id: receiptId,
      allocation_id: allocationId,
      usable_quantity: 10,
      damaged_quantity: 0,
      location: "site",
      evidence: "Received at site",
    }, id(1805));
    await dispatchCommand(pg.client, jobId, "requirement_reconcile", {
      id: requirementId,
      description: "Insulated panels",
      quantity: 10,
      unit: "sheet",
      specification: "50mm insulated roof panel",
      reason: "Signed scope changed to insulated panels",
    }, id(1806));
    await dispatchCommand(pg.client, jobId, "requirement_review", {
      id: requirementId,
    }, id(1807));
    await dispatchCommand(pg.client, jobId, "set_review", {}, id(1808));
    await dispatchCommand(pg.client, jobId, "context_review", {}, id(1809));
    const notReady = await dispatchCommand(
      pg.client,
      jobId,
      "assess",
      {},
      id(1810),
    );
    assertEquals(notReady.assessment.ready, false);
    assert(
      notReady.assessment.obligations.some((x: any) =>
        x.code === "allocation_suitability" &&
        x.allocation_id === allocationId
      ),
    );
    assert(
      notReady.assessment.obligations.some((x: any) =>
        x.code === "supply_gap" && x.quantity === 10
      ),
    );
    const staleAllocation = notReady.allocations.find((x: any) =>
      x.id === allocationId
    );
    assertEquals(staleAllocation.suitability_status, "stale");
    assertEquals(
      staleAllocation.requirement_revision ===
        notReady.requirements[0].physical_revision,
      false,
    );
    const confirmed = await dispatchCommand(
      pg.client,
      jobId,
      "allocation_confirm_suitability",
      {
        id: allocationId,
        reason:
          "Manufacturer confirms standard sheets satisfy revised panel requirement",
        evidence: "Engineer email ENG-801",
      },
      id(1811),
    );
    const confirmedAllocation = confirmed.allocations.find((x: any) =>
      x.id === allocationId
    );
    assertEquals(confirmedAllocation.suitability_status, "current");
    assertEquals(
      confirmedAllocation.requirement_revision,
      confirmed.requirements[0].physical_revision,
    );
    assertEquals(
      confirmedAllocation.supply_revision,
      confirmedAllocation.current_supply_revision,
    );
    assertEquals(
      confirmedAllocation.suitability_confirmation.reason,
      "Manufacturer confirms standard sheets satisfy revised panel requirement",
    );
    assertEquals(
      confirmedAllocation.suitability_confirmation.evidence,
      "Engineer email ENG-801",
    );
    assertEquals(confirmedAllocation.suitability_confirmation.actor, actor);
    assert(typeof confirmedAllocation.suitability_confirmation.at === "string");
    await assertRejects(
      () =>
        dispatchCommand(
          pg.client,
          jobId,
          "allocation_confirm_suitability",
          { id: allocationId, evidence: "Engineer email ENG-801" },
          id(1814),
        ),
      DispatchError,
      "Invalid suitability reason",
    );
    await assertRejects(
      () =>
        dispatchCommand(
          pg.client,
          jobId,
          "allocation_confirm_suitability",
          {
            id: allocationId,
            reason: "Manufacturer confirms compatibility",
          },
          id(1815),
        ),
      DispatchError,
      "Invalid suitability evidence",
    );
    const ready = await dispatchCommand(
      pg.client,
      jobId,
      "assess",
      {},
      id(1812),
    );
    assertEquals(ready.assessment.ready, true);
    const quantityOnly = await dispatchCommand(
      pg.client,
      jobId,
      "requirement_reconcile",
      {
        id: requirementId,
        quantity: 8,
        reason: "Signed scope quantity reduced",
      },
      id(1813),
    );
    const quantityAllocation = quantityOnly.allocations.find((x: any) =>
      x.id === allocationId
    );
    assertEquals(quantityAllocation.suitability_status, "current");
    assertEquals(
      quantityAllocation.requirement_revision,
      quantityOnly.requirements[0].physical_revision,
    );
    await dispatchCommand(pg.client, jobId, "requirement_reconcile", {
      id: requirementId,
      description: "Insulated acoustic panels",
      quantity: 8,
      unit: "sheet",
      specification: "50mm insulated acoustic roof panel",
      reason: "Engineer changed physical panel specification",
    }, id(1816));
    await dispatchCommand(pg.client, jobId, "requirement_review", {
      id: requirementId,
    }, id(1817));
    await dispatchCommand(pg.client, jobId, "set_review", {}, id(1818));
    const staleAfterSourceDrift = await dispatchCommand(
      pg.client,
      jobId,
      "assess",
      {},
      id(1819),
    );
    assertEquals(staleAfterSourceDrift.assessment.ready, false);
    assert(
      staleAfterSourceDrift.assessment.obligations.some((x: any) =>
        x.code === "allocation_suitability" &&
        x.allocation_id === allocationId
      ),
    );
    const reconfirmed = await dispatchCommand(
      pg.client,
      jobId,
      "allocation_confirm_suitability",
      {
        id: allocationId,
        reason: "Engineer approved acoustic compatibility",
        evidence: "Engineer revision ENG-802",
      },
      id(1840),
    );
    assertEquals(reconfirmed.allocations[0].suitability_status, "current");
    const changedSupply = await pg.query(
      `update purchase_orders set line_items=jsonb_set(line_items,'{0,quantity}','9'::jsonb) where id=${
        literal(po)
      } returning jsonb_build_object('id',id)`,
    );
    if (changedSupply.error) throw new Error(changedSupply.error.message);
    const afterSupplyDrift = await dispatchJob(pg.client, jobId);
    assertEquals(
      afterSupplyDrift.source_version === reconfirmed.source_version,
      false,
    );
    assertEquals(afterSupplyDrift.allocations[0].suitability_status, "stale");
    assertEquals(afterSupplyDrift.allocations[0].supply_valid, false);
    await assertRejects(
      () =>
        dispatchCommand(pg.client, jobId, "allocation_confirm_suitability", {
          id: allocationId,
          reason: "Prior confirmation",
          evidence: "ENG-802",
        }, id(1841)),
      DispatchError,
      "Current verified supply is required for suitability confirmation",
    );
  } finally {
    await pg.close();
  }
});

Deno.test("handler SQL PO drift refuses suitability confirmation and permits replacement supply", async () => {
  const pg = await openDispatchPg();
  try {
    const jobId = id(821), requirementId = id(822), po = id(823);
    const oldAllocation = id(824), oldReceipt = id(825), stockId = id(826);
    const replacementAllocation = id(827), replacementReceipt = id(828);
    await insertAcceptedJob(pg, jobId);
    await dispatchCommand(pg.client, jobId, "requirement_upsert", {
      id: requirementId,
      description: "Standard sheets",
      quantity: 10,
      unit: "sheet",
      specification: "0.42 BMT roof sheet",
      destination: "site",
    }, id(1821));
    await dispatchCommand(pg.client, jobId, "requirement_review", {
      id: requirementId,
    }, id(1822));
    await dispatchCommand(pg.client, jobId, "set_review", {}, id(1823));
    await insertConfirmedPo(pg, jobId, po, {
      description: "Standard sheets",
      quantity: 10,
      unit: "sheet",
      specification: "0.42 BMT roof sheet",
    });
    await dispatchCommand(pg.client, jobId, "allocation_upsert", {
      id: oldAllocation,
      requirement_id: requirementId,
      supply_id: `po:${po}:0`,
      quantity: 10,
    }, id(1824));
    await dispatchCommand(pg.client, jobId, "receipt_upsert", {
      id: oldReceipt,
      allocation_id: oldAllocation,
      usable_quantity: 10,
      damaged_quantity: 0,
      location: "site",
      evidence: "Original delivery photo",
    }, id(1825));
    await dispatchCommand(pg.client, jobId, "requirement_reconcile", {
      id: requirementId,
      description: "Insulated panels",
      quantity: 10,
      unit: "sheet",
      specification: "50mm insulated roof panel",
      reason: "Signed scope changed to insulated panels",
    }, id(1826));
    await dispatchCommand(pg.client, jobId, "requirement_review", {
      id: requirementId,
    }, id(1827));
    await dispatchCommand(pg.client, jobId, "set_review", {}, id(1828));
    await dispatchCommand(pg.client, jobId, "stock_record", {
      id: stockId,
      description: "Insulated panels",
      quantity: 10,
      unit: "sheet",
      location: "yard",
      evidence: "Supplier replacement docket",
    }, id(1829));
    await dispatchCommand(pg.client, jobId, "allocation_upsert", {
      id: replacementAllocation,
      requirement_id: requirementId,
      supply_id: `stock:${stockId}`,
      quantity: 10,
    }, id(1830));
    await dispatchCommand(pg.client, jobId, "receipt_upsert", {
      id: replacementReceipt,
      allocation_id: replacementAllocation,
      usable_quantity: 10,
      damaged_quantity: 0,
      location: "site",
      evidence: "Replacement delivered to site",
    }, id(1831));
    await dispatchCommand(pg.client, jobId, "requirement_review", {
      id: requirementId,
    }, id(1832));
    await dispatchCommand(pg.client, jobId, "set_review", {}, id(1833));
    const replaced = await dispatchCommand(
      pg.client,
      jobId,
      "assess",
      {},
      id(1834),
    );
    assertEquals(replaced.assessment.ready, true);
    assertEquals(replaced.receipts.some((x: any) => x.id === oldReceipt), true);
    assertEquals(
      replaced.allocations.find((x: any) => x.id === oldAllocation)
        .suitability_status,
      "stale",
    );
    const drift = await pg.query(
      `update purchase_orders set line_items='[{"description":"Cancelled standard sheets","quantity":0,"unit":"sheet","specification":"cancelled"}]'::jsonb,status='cancelled' where id=${
        literal(po)
      } returning jsonb_build_object('id',id)`,
    );
    if (drift.error) throw new Error(drift.error.message);
    const afterDrift = await dispatchJob(pg.client, jobId);
    assertEquals(
      afterDrift.allocations.find((x: any) => x.id === oldAllocation)
        .supply_valid,
      false,
    );
    await assertRejects(
      () =>
        dispatchCommand(pg.client, jobId, "allocation_confirm_suitability", {
          id: oldAllocation,
          reason: "Trying to bless a cancelled PO line",
          evidence: "Generic note",
        }, id(1835)),
      DispatchError,
      "Current verified supply is required for suitability confirmation",
    );
    await dispatchCommand(pg.client, jobId, "requirement_review", {
      id: requirementId,
    }, id(1836));
    await dispatchCommand(pg.client, jobId, "set_review", {}, id(1837));
    const stillReady = await dispatchCommand(
      pg.client,
      jobId,
      "assess",
      {},
      id(1838),
    );
    assertEquals(stillReady.assessment.ready, true);
    assertEquals(
      stillReady.allocations.find((x: any) => x.id === oldAllocation)
        .supply_valid,
      false,
    );
    assertEquals(
      stillReady.receipts.some((x: any) => x.id === oldReceipt),
      true,
    );
  } finally {
    await pg.close();
  }
});
