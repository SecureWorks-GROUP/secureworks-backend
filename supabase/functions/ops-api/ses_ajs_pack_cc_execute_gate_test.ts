// deno-lint-ignore-file no-explicit-any require-await
/**
 * SEND IT repair proof for route-scoped AJS/AJBR recipient rules. The harness
 * drives the real execute action through persisted release rows and captures
 * the actual Graph payload, including old and partially delivered releases.
 */
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildSesReleaseRevisionPlanForDockets,
  executeSesReleaseRevisionAction,
  SesActionError,
  type SesSupabaseClient,
} from "./ses_reporting_actions.ts";
import {
  ajsPackCc,
  SES_FINANCE_CC,
  sesReleaseRouteCcForBuilders,
} from "./ses_release_route_shape.ts";
import { MAKESAFE_CC } from "./makesafe_send_pack.ts";

const RELEASE_ID = "release-cc-1";
const JOB_ID = "job-ajs-cc-1";
const DOCKET_ID = "docket-cc-1";
const CONTENT_HASH = "sha256:" + "d".repeat(64);
const LEGACY_CC = [MAKESAFE_CC];

function hash(n: number): string {
  return `sha256:${String(n).padStart(64, "0")}`;
}

function query(result: { data: any; error: any }): any {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => Promise.resolve(result),
    limit: () => builder,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: any, reject: any) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function ajsRoutes(completionCc: string[], photoCc: string[]): any[] {
  return [
    {
      ordinal: 1,
      route_kind: "report_invoice",
      recipients: ["workorders@ajs.build"],
      cc: completionCc,
      subject: "Report + Invoice",
      // Builder-facing wording: the execute body guard refuses annotation
      // vocabulary, so stub bodies must be as clean as real producer output.
      body:
        "Please find attached the report and invoice for AJBR-1.\n\nThank you.",
      body_hash: hash(1),
      attachment_hashes: [hash(11)],
    },
    {
      ordinal: 2,
      route_kind: "photo",
      recipients: ["workorders@ajs.build"],
      cc: photoCc,
      subject: "Photos",
      body: "Please find attached site photos for AJBR-1.\n\nThank you.",
      body_hash: hash(2),
      attachment_hashes: [hash(21)],
    },
  ];
}

const ARTIFACTS = [
  {
    content_hash: hash(11),
    size_bytes: 900_000,
    object_key: `dockets/${DOCKET_ID}/Make%20Safe%20Report.pdf`,
    media_type: "application/pdf",
  },
  {
    content_hash: hash(21),
    size_bytes: 1_200_000,
    object_key: `dockets/${DOCKET_ID}/photos/001.jpg`,
    media_type: "image/jpeg",
  },
];

interface Harness {
  routes: any[];
  builderKeys: Array<"AJS" | "AJBR">;
  /** route_kinds whose send effect already exists and is confirmed. */
  confirmedKinds: string[];
  /** Forces the prior-send ledger read to fault. */
  effectReadError?: { message: string } | null;
  effects: Map<string, any>;
  confirmedTokens: Set<string>;
  graphCalls: any[];
}

function memberRows(harness: Harness): any[] {
  return harness.builderKeys.map((_, index) => ({
    ordinal: index + 1,
    job_id: index === 0 ? JOB_ID : `${JOB_ID}-${index + 1}`,
    docket_revision_id: index === 0 ? DOCKET_ID : `${DOCKET_ID}-${index + 1}`,
    invoice_obligation_revision_id: `obligation-${index + 1}`,
  }));
}

function docketRows(harness: Harness): any[] {
  return memberRows(harness).map((member, index) => ({
    id: member.docket_revision_id,
    job_id: member.job_id,
    xero_binding: {
      status: "AUTHORISED",
      xero_invoice_id: `xero-invoice-${index + 1}`,
    },
    invoice_obligation_revision_id: member.invoice_obligation_revision_id,
    envelope: {
      v2: {
        classification: {
          builder_key: harness.builderKeys[index],
          family: "physical_makesafe",
        },
        routing: {},
      },
    },
    review_spec: {},
  }));
}

function docketQuery(harness: Harness): any {
  const rows = docketRows(harness);
  let selectedId = "";
  const result = (single: boolean) => ({
    data: single ? rows.find((row) => row.id === selectedId) || null : rows,
    error: null,
  });
  const builder: any = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      if (column === "id") selectedId = String(value || "");
      return builder;
    },
    in: () => builder,
    order: () => Promise.resolve(result(false)),
    limit: () => builder,
    maybeSingle: () => Promise.resolve(result(true)),
    then: (resolve: any, reject: any) =>
      Promise.resolve(result(false)).then(resolve, reject),
  };
  return builder;
}

function confirmedEffect(kind: string): any {
  const externalToken = `SES-confirmed-${kind}`;
  return {
    operation_key: `op-${kind}`,
    org_id: "org-1",
    effect_kind: "route_send",
    release_revision_id: RELEASE_ID,
    route_kind: kind,
    payload_hash: hash(kind === "report_invoice" ? 91 : 92),
    external_token: externalToken,
    state: "confirmed",
    provider_digest: {
      message_id: `graph-message-prior-${kind}`,
      internet_message_id: `<prior-${kind}@graph>`,
      operation_token: externalToken,
    },
  };
}

function scriptedClient(harness: Harness): SesSupabaseClient {
  return {
    from(table: string) {
      switch (table) {
        case "makesafe_release_revisions":
          return query({
            data: { id: RELEASE_ID, content_hash: CONTENT_HASH },
            error: null,
          });
        case "makesafe_release_revision_members":
          return query({
            data: memberRows(harness),
            error: null,
          });
        case "makesafe_release_revision_routes":
          return query({ data: harness.routes, error: null });
        case "ses_external_effects":
          return query({
            data: harness.effectReadError
              ? null
              : harness.confirmedKinds.map(confirmedEffect),
            error: harness.effectReadError || null,
          });
        case "makesafe_docket_revisions":
          return docketQuery(harness);
        case "makesafe_docket_artifacts":
          return query({ data: ARTIFACTS, error: null });
        case "makesafe_closeout_revisions":
          return query({
            data: harness.effects.get("closeout") || null,
            error: null,
          });
        case "makesafe_revision_approvals_current_v2":
          return query({
            data: { id: "approval-1", approval_content_hash: CONTENT_HASH },
            error: null,
          });
        default:
          return query({ data: null, error: null });
      }
    },
    rpc(name: string, rpcArgs: Record<string, any>) {
      if (name === "assert_ses_dockets_signed_off_v1") {
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "begin_ses_release_execution_v1") {
        return Promise.resolve({ data: { reserved: true }, error: null });
      }
      if (name === "claim_ses_external_effect_v1") {
        const routeKind = String(rpcArgs.p_effect?.route_kind || "");
        const alreadyConfirmed = harness.confirmedKinds.includes(routeKind);
        const effect = {
          ...rpcArgs.p_effect,
          state: alreadyConfirmed ? "confirmed" : "reserved",
          ...(alreadyConfirmed
            ? {
              provider_digest: {
                message_id: `graph-message-prior-${routeKind}`,
                internet_message_id: `<prior-${routeKind}@graph>`,
                operation_token: rpcArgs.p_effect.external_token,
              },
            }
            : {}),
        };
        harness.effects.set(String(effect.operation_key), effect);
        if (alreadyConfirmed) {
          harness.confirmedTokens.add(String(effect.external_token));
        }
        return Promise.resolve({
          data: {
            claim_mode: alreadyConfirmed ? "confirmed" : "reserved",
            effect,
          },
          error: null,
        });
      }
      if (name === "transition_ses_external_effect_v1") {
        const effect = harness.effects.get(String(rpcArgs.p_operation_key)) || {
          operation_key: String(rpcArgs.p_operation_key),
          external_token: "",
          effect_kind: "route_send",
        };
        return Promise.resolve({
          data: { ...effect, state: rpcArgs.p_to_state },
          error: null,
        });
      }
      if (name === "confirm_ses_release_route_v1") {
        return Promise.resolve({
          data: { proof_hash: rpcArgs.p_proof_hash },
          error: null,
        });
      }
      if (name === "commit_ses_release_closeout_v1") {
        const closeout = { ...(rpcArgs.p_closeout || {}), verified: true };
        harness.effects.set("closeout", closeout);
        return Promise.resolve({ data: closeout, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    storage: {
      from: () => ({
        upload: async () => ({ data: null, error: null }),
        createSignedUrl: async () => ({ data: null, error: null }),
        download: async () => ({ data: null, error: null }),
      }),
    },
  } as unknown as SesSupabaseClient;
}

function mailGatewayStub(harness: Harness): any {
  const sentByToken = new Map<string, any>();
  return {
    createDraftAndSend: async (payload: any, context: any) => {
      harness.graphCalls.push({
        route_kind: payload.route_kind,
        subject: payload.subject,
        recipients: payload.recipients,
        cc: payload.cc,
        token: context.external_token,
      });
      const result = {
        message_id: `graph-message-${harness.graphCalls.length}`,
        internet_message_id: `<msg-${harness.graphCalls.length}@graph>`,
        operation_token: context.external_token,
      };
      sentByToken.set(String(context.external_token), result);
      return result;
    },
    reconcileSent: async (token: string) => {
      const key = String(token);
      const match = sentByToken.get(key);
      if (match) return [match];
      // An already-confirmed effect proves its send from Sent Items, never by
      // a second dispatch.
      if (harness.confirmedTokens.has(key)) {
        return [{
          message_id: `graph-message-prior-${key.slice(0, 8)}`,
          internet_message_id: `<prior-${key.slice(0, 8)}@graph>`,
          operation_token: key,
        }];
      }
      return [];
    },
  };
}

const xeroReader = { readAuthorised: async () => ({ id: "xero-invoice-1" }) };

function harness(overrides: Partial<Harness> = {}): Harness {
  const builderKeys = overrides.builderKeys || ["AJS"];
  return {
    routes: builderKeys.length === 1 && builderKeys[0] === "AJBR"
      ? ajsRoutes([SES_FINANCE_CC], [])
      : ajsRoutes([...ajsPackCc()].sort(), []),
    builderKeys,
    confirmedKinds: [],
    effectReadError: null,
    effects: new Map(),
    confirmedTokens: new Set<string>(),
    graphCalls: [],
    ...overrides,
  };
}

async function execute(state: Harness) {
  return await executeSesReleaseRevisionAction(
    scriptedClient(state),
    { mode: "api_key", user: null },
    { org_id: "org-1", release_revision_id: RELEASE_ID, actor: "captain" },
    mailGatewayStub(state),
    xeroReader as any,
  );
}

Deno.test("SEND IT repairs a never-dispatched AJS release before Graph send", async () => {
  const state = harness({
    routes: ajsRoutes([...ajsPackCc()].sort(), LEGACY_CC),
  });
  const result: any = await execute(state);
  assertEquals(result.state, "released");
  assertEquals(state.graphCalls[0].cc, [...ajsPackCc()].sort());
  assertEquals(state.graphCalls[1].cc, []);
  assertEquals(
    result.dispatch_previews.map((route: any) => ({
      route_kind: route.route_kind,
      recipients: route.recipients,
      cc: route.cc,
    })),
    state.graphCalls.map((route) => ({
      route_kind: route.route_kind,
      recipients: route.recipients,
      cc: route.cc,
    })),
  );
});

Deno.test("SEND IT finishes an in-flight pre-ruling AJS release instead of stranding it", async () => {
  const state = harness({
    routes: ajsRoutes(LEGACY_CC, LEGACY_CC),
    builderKeys: ["AJS"],
    confirmedKinds: ["report_invoice"],
  });
  const result: any = await execute(state);
  assertEquals(result.state, "released");
  // The confirmed route reconciles; only the outstanding photo route dispatches.
  assertEquals(state.graphCalls.map((call) => call.subject), ["Photos"]);
  // Permanent regression assertion from the adversarial review: the legacy
  // stored photo CC never reaches Graph.
  assertEquals(state.graphCalls[0].cc, []);
  assertEquals(result.dispatch_previews.length, 1);
  assertEquals(result.dispatch_previews[0].route_kind, "photo");
  assertEquals(
    result.dispatch_previews[0].recipients,
    state.graphCalls[0].recipients,
  );
  assertEquals(result.dispatch_previews[0].cc, state.graphCalls[0].cc);
});

Deno.test("SEND IT repairs an arbitrary stale CC on an outstanding in-flight route", async () => {
  const state = harness({
    routes: ajsRoutes(
      ["someone-else@example.com"],
      ["someone-else@example.com"],
    ),
    confirmedKinds: ["report_invoice"],
  });
  const result: any = await execute(state);
  assertEquals(result.state, "released");
  assertEquals(state.graphCalls.map((call) => call.subject), ["Photos"]);
  assertEquals(state.graphCalls[0].cc, []);
});

Deno.test("SEND IT refuses on an unreadable send ledger rather than guessing the CC floor", async () => {
  const state = harness({
    routes: ajsRoutes(LEGACY_CC, LEGACY_CC),
    effectReadError: { message: "connection reset" },
  });
  let error: SesActionError | null = null;
  try {
    await execute(state);
  } catch (err) {
    error = err as SesActionError;
  }
  assert(error instanceof SesActionError, "expected a typed SES refusal");
  assertEquals(error!.status, 503);
  const refusal = error!.refusal as any;
  assertEquals(refusal.code, "route_send_proof_unreadable");
  assertEquals(state.graphCalls.length, 0);
});

Deno.test("SEND IT keeps AJS completion CCs and clears the AJS photo CC", async () => {
  const state = harness();
  const result: any = await execute(state);
  assertEquals(result.state, "released");
  assertEquals(state.graphCalls.map((call) => call.subject), [
    "Report + Invoice",
    "Photos",
  ]);
  assertEquals(state.graphCalls[0].cc, [...ajsPackCc()].sort());
  assertEquals(state.graphCalls[1].cc, []);
});

Deno.test("SEND IT dispatches AJBR completion docs with finance only and photos with no CC", async () => {
  const state = harness({ builderKeys: ["AJBR"] });
  const result: any = await execute(state);
  assertEquals(result.state, "released");
  assertEquals(state.graphCalls.map((call) => call.subject), [
    "Report + Invoice",
    "Photos",
  ]);
  assertEquals(state.graphCalls[0].cc, [SES_FINANCE_CC]);
  assertEquals(state.graphCalls[0].cc.includes(MAKESAFE_CC), false);
  assertEquals(state.graphCalls[1].cc, []);
});

Deno.test("SEND IT clears the outstanding photo CC on an in-flight legacy AJBR release", async () => {
  const state = harness({
    builderKeys: ["AJBR"],
    routes: ajsRoutes(ajsPackCc(), ajsPackCc()),
    confirmedKinds: ["report_invoice"],
  });
  const result: any = await execute(state);
  assertEquals(result.state, "released");
  assertEquals(state.graphCalls.map((call) => call.subject), ["Photos"]);
  assertEquals(state.graphCalls[0].cc, []);
  assertEquals(result.dispatch_previews.map((route: any) => route.route_kind), [
    "photo",
  ]);
  assertEquals(result.dispatch_previews[0].cc, state.graphCalls[0].cc);
});

Deno.test("SEND IT repairs a never-dispatched AJBR release carrying the old CC set", async () => {
  const state = harness({
    builderKeys: ["AJBR"],
    routes: ajsRoutes(ajsPackCc(), ajsPackCc()),
  });
  const result: any = await execute(state);
  assertEquals(result.state, "released");
  assertEquals(state.graphCalls[0].cc, [SES_FINANCE_CC]);
  assertEquals(state.graphCalls[0].cc.includes(MAKESAFE_CC), false);
  assertEquals(state.graphCalls[1].cc, []);
  for (let index = 0; index < state.graphCalls.length; index++) {
    assertEquals(
      result.dispatch_previews[index].recipients,
      state.graphCalls[index].recipients,
    );
    assertEquals(
      result.dispatch_previews[index].cc,
      state.graphCalls[index].cc,
    );
  }
});

Deno.test("mixed AJS/AJBR composites compose every member rule in either order", async () => {
  const expectedCompletionCc = sesReleaseRouteCcForBuilders({
    routeKind: "report_invoice",
    builderKeys: ["AJS", "AJBR"],
  });
  for (
    const builderKeys of [
      ["AJS", "AJBR"],
      ["AJBR", "AJS"],
    ] as Array<Array<"AJS" | "AJBR">>
  ) {
    const state = harness({
      builderKeys,
      routes: ajsRoutes(LEGACY_CC, LEGACY_CC),
    });
    const result: any = await execute(state);
    assertEquals(result.state, "released");
    assertEquals(state.graphCalls[0].cc, expectedCompletionCc);
    assertEquals(state.graphCalls[1].cc, []);
    assertEquals(result.dispatch_previews[0].cc, state.graphCalls[0].cc);
    assertEquals(result.dispatch_previews[1].cc, state.graphCalls[1].cc);
  }
});

Deno.test("mixed AJS/AJBR release planning persists the same order-independent recipients", async () => {
  const expectedCompletionCc = sesReleaseRouteCcForBuilders({
    routeKind: "report_invoice",
    builderKeys: ["AJS", "AJBR"],
  });
  for (
    const builderKeys of [
      ["AJS", "AJBR"],
      ["AJBR", "AJS"],
    ] as Array<Array<"AJS" | "AJBR">>
  ) {
    const dockets = builderKeys.map((builderKey, index) => ({
      job_id: `plan-job-${index + 1}`,
      docket_revision_id: `plan-docket-${index + 1}`,
      invoice_obligation_revision_id: `plan-obligation-${index + 1}`,
      attendance_cycle_ids: [`plan-cycle-${index + 1}`],
      readiness_revision: hash(70 + index),
      dependency_generation: index + 1,
      clean_input: {
        builder_key: builderKey,
        family: "physical_makesafe",
        photo_route_applicable: true,
        report_route_applicable: true,
      },
    })) as any;
    const plan = await buildSesReleaseRevisionPlanForDockets({
      org_id: "org-1",
      dockets,
      routes: ajsRoutes(LEGACY_CC, LEGACY_CC),
      created_by: "captain",
    });
    assertEquals(plan.routes.map((route) => route.cc), [
      expectedCompletionCc,
      [],
    ]);
  }
});
