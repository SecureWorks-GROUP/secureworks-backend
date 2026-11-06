import { deepStrictEqual as equal } from "node:assert/strict";
import { scopePaymentStagesAction } from "./scope_payment_stages.ts";
const body = {
  job_id: crypto.randomUUID(),
  scope_revision_id: crypto.randomUUID(),
};
const actor = {
  staff: true,
  orgId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
};

Deno.test("local stages: money, acceptance claims and unidentified confirmations are refused before persistence", async () => {
  const client = {
    rpc: () => {
      throw new Error("must not persist");
    },
  };
  equal(
    (await scopePaymentStagesAction(
      client,
      "read_scope_payment_stages",
      "POST",
      body,
      { ...actor, staff: false },
    )).status,
    403,
  );
  equal(
    (await scopePaymentStagesAction(
      client,
      "read_scope_payment_stages",
      "POST",
      { ...body, amount_inc_gst: 1 },
      actor,
    )).status,
    400,
  );
  equal(
    (await scopePaymentStagesAction(
      client,
      "confirm_scope_payment_stage",
      "POST",
      body,
      { ...actor, userId: null },
    )).status,
    403,
  );
  equal(
    (await scopePaymentStagesAction(
      client,
      "read_scope_payment_stages",
      "GET",
      body,
      actor,
    )).status,
    405,
  );
});

Deno.test("local stages: read returns retained money and evidence, never a fresh calculation", async () => {
  const stored = {
    ...body,
    stages: [{
      id: crypto.randomUUID(),
      stage_id: "fixture-stage",
      amount_inc_gst: 1,
      held_reason: "basis_unconfirmed",
    }],
    xero_writes: false,
    sent: false,
    payment_links: false,
  };
  const response = await scopePaymentStagesAction(
    {
      rpc: (name: string, args: unknown) => {
        equal(name, "read_scope_payment_stages");
        equal(args, {
          p_job_id: body.job_id,
          p_scope_revision_id: body.scope_revision_id,
          p_org_id: actor.orgId,
        });
        return { data: stored, error: null };
      },
    },
    "read_scope_payment_stages",
    "POST",
    body,
    actor,
  );
  equal(await response.json(), stored);
});

Deno.test("local stages: staff confirmation takes its identity from the session and accepts no amount", async () => {
  const input = {
    ...body,
    stage_id: "fixture-stage",
    evidence_kind: "work_done",
    note: "Synthetic staff evidence",
  };
  const response = await scopePaymentStagesAction(
    {
      rpc: (name: string, args: Record<string, unknown>) => {
        equal(name, "confirm_scope_payment_stage");
        equal(args.p_actor, actor.userId);
        equal(args.p_evidence_kind, "work_done");
        return { data: { stages: [] }, error: null };
      },
    },
    "confirm_scope_payment_stage",
    "POST",
    input,
    actor,
  );
  equal(response.status, 200);
});
