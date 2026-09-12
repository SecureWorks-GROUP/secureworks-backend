import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  currentDispatchWorkingState,
  derivationOf,
  dispatchSourceFingerprint,
  isProviderExtractableEvent,
  projectDispatchDerivedFacts,
  projectOrgRollupOntoJob,
  type DispatchContextEvent,
} from "./dispatch_context.ts";

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REQ = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function evt(partial: Partial<DispatchContextEvent> & { id: string }): DispatchContextEvent {
  return {
    event_type: "dispatch.plan.changed",
    job_id: JOB,
    correlation_id: partial.correlation_id ?? REQ,
    payload: {
      contract_version: "dispatch-context/v1",
      org_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      job_id: JOB,
      plan_version: 1,
      source_version: 1,
      command: "save",
      state: { order_drafts: [{ id: "d1", status: "draft" }] },
      ...(partial.payload as object || {}),
    },
    metadata: {
      evidence_role: "human_working_state",
      provider_action: false,
      source_ref: { table: "dispatch_plans", job_id: JOB, version: 1 },
      derivation: { owner: "dispatch", event_id: REQ, plan_version: (partial.payload as { plan_version?: number } | undefined)?.plan_version ?? 1 },
      ...(partial.metadata as object || {}),
    },
    ...partial,
  };
}

Deno.test("latest plan_version wins even if events arrive out of order", () => {
  const cur = currentDispatchWorkingState([
    evt({ id: "e2", payload: { plan_version: 2, command: "save", state: { v: 2 } } }),
    evt({ id: "e1", payload: { plan_version: 1, command: "save", state: { v: 1 } } }),
  ]);
  assertEquals(cur.present, true);
  if (cur.present) {
    assertEquals(cur.plan_version, 2);
    assertEquals(cur.command, "save");
    assertEquals(cur.not_provider_fact, true);
    assertEquals(cur.provider_action, false);
  }
});

Deno.test("duplicate correlation_id is one logical mutation", () => {
  const cur = currentDispatchWorkingState([
    evt({ id: "first", correlation_id: "req-1", payload: { plan_version: 3, state: { v: 3 } } }),
    evt({ id: "dup", correlation_id: "req-1", payload: { plan_version: 99, state: { v: 99 } } }),
  ]);
  assertEquals(cur.present, true);
  if (cur.present) {
    assertEquals(cur.plan_version, 3);
    assertEquals(cur.event_id, "first");
  }
});

Deno.test("missing job UUID is not current dispatch state", () => {
  const cur = currentDispatchWorkingState([
    evt({ id: "bad", job_id: "SWP-1", payload: { job_id: "SWP-1", plan_version: 1 } }),
  ]);
  assertEquals(cur.present, false);
});

Deno.test("working-state drafts are not extractable provider facts", () => {
  const paidLooking = evt({
    id: "draft",
    payload: { plan_version: 4, command: "order_prepare", state: { order_drafts: [{ status: "draft", note: "paid cash" }] } },
  });
  assertEquals(isProviderExtractableEvent(paidLooking), false);
  const cur = currentDispatchWorkingState([paidLooking]);
  assertEquals(cur.present, true);
  if (cur.present) {
    assertEquals(cur.provider_action, false);
    assertEquals(cur.evidence_role, "human_working_state");
    assertEquals(cur.command, "order_prepare");
  }
});

Deno.test("derivation survives from event metadata onto projected fact provenance", () => {
  const event = evt({ id: "e-save", payload: { plan_version: 7, command: "save" } });
  assertEquals(derivationOf(event), { owner: "dispatch", event_id: REQ, plan_version: 7 });
  const state = currentDispatchWorkingState([event]);
  const projected = projectDispatchDerivedFacts(state);
  assertEquals(projected.length, 1);
  assertEquals(projected[0].provenance.derivation, { owner: "dispatch", event_id: REQ, plan_version: 7 });
});

Deno.test("save/review echo of own projection does not change Dispatch source fingerprint", () => {
  const before: Array<{ id: string; provenance?: { derivation?: { owner?: string } } }> = [
    { id: "scope-1" },
  ];
  const event = evt({ id: "echo", payload: { plan_version: 1, command: "save" } });
  const own = projectDispatchDerivedFacts(currentDispatchWorkingState([event]));
  assertEquals(dispatchSourceFingerprint(before), dispatchSourceFingerprint([...before, ...own]));
});

Deno.test("external independent fact still changes Dispatch source fingerprint", () => {
  const before: Array<{ id: string; provenance?: { derivation?: { owner?: string } } }> = [
    { id: "scope-1" },
  ];
  const external = { id: "email-1", provenance: { derivation: { owner: "external_email" } } };
  assertEquals(dispatchSourceFingerprint(before) === dispatchSourceFingerprint([...before, external]), false);
});

Deno.test("org rollup preserves Dispatch lineage; mixed inputs are not silently merged", () => {
  const dispatchOrg = {
    id: "org-d",
    kind: "note",
    value: {},
    provenance: { derivation: { owner: "dispatch" as const, event_id: REQ, plan_version: 2 } },
  };
  const onlyOwn = projectOrgRollupOntoJob([dispatchOrg], JOB);
  assertEquals(onlyOwn.needs_richer_lineage, false);
  assertEquals(onlyOwn.facts[0].provenance.derivation.owner, "dispatch");
  const mixed = projectOrgRollupOntoJob([
    dispatchOrg,
    { id: "org-x", kind: "note", value: {}, provenance: { derivation: { owner: "external_email" } } },
  ], JOB);
  assertEquals(mixed.needs_richer_lineage, true);
  assertEquals(mixed.facts.length, 0);
});

Deno.test("ordinary client evidence remains extractable", () => {
  assertEquals(
    isProviderExtractableEvent({
      id: "sms",
      event_type: "client.sms_in",
      job_id: JOB,
      payload: { body: "please go ahead" },
      metadata: {},
    }),
    true,
  );
});
