// deno-lint-ignore-file no-explicit-any require-await
/**
 * SEND IT envelope gate for the route-scoped AJS/AJBR recipient rules. The
 * producer is proved in ses_release_route_shape_test.ts; this drives the real
 * executeSesReleaseRevisionAction so the boundary under test is WHICH stored
 * envelopes the current CC requirement may refuse.
 *
 * A release approved before the ruling stores cc [ses@] only. Refusing such a
 * release once it has already mailed a route would strand it: the refusal's own
 * recovery is a new release revision, whose content-derived id mints fresh
 * operation keys and re-mails what already went.
 */
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  executeSesReleaseRevisionAction,
  SesActionError,
  type SesSupabaseClient,
} from "./ses_reporting_actions.ts";
import { ajsPackCc, SES_FINANCE_CC } from "./ses_release_route_shape.ts";
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
  builderKey: "AJS" | "AJBR";
  /** route_kinds whose send effect already exists and is confirmed. */
  confirmedKinds: string[];
  /** Forces the prior-send ledger read to fault. */
  effectReadError?: { message: string } | null;
  effects: Map<string, any>;
  confirmedTokens: Set<string>;
  graphCalls: any[];
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
            data: [{
              ordinal: 1,
              job_id: JOB_ID,
              docket_revision_id: DOCKET_ID,
              invoice_obligation_revision_id: "obligation-1",
            }],
            error: null,
          });
        case "makesafe_release_revision_routes":
          return query({ data: harness.routes, error: null });
        case "ses_external_effects":
          return query({
            data: harness.effectReadError
              ? null
              : harness.confirmedKinds.map((kind) => ({
                operation_key: `op-${kind}`,
              })),
            error: harness.effectReadError || null,
          });
        case "makesafe_docket_revisions":
          return query({
            data: {
              id: DOCKET_ID,
              job_id: JOB_ID,
              xero_binding: {
                status: "AUTHORISED",
                xero_invoice_id: "xero-invoice-1",
              },
              invoice_obligation_revision_id: "obligation-1",
              envelope: {
                v2: {
                  classification: {
                    builder_key: harness.builderKey,
                    family: "physical_makesafe",
                  },
                  routing: {},
                },
              },
              review_spec: {},
            },
            error: null,
          });
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
        subject: payload.subject,
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
  const builderKey = overrides.builderKey || "AJS";
  return {
    routes: builderKey === "AJBR"
      ? ajsRoutes([SES_FINANCE_CC], [])
      : ajsRoutes(ajsPackCc(), []),
    builderKey,
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

Deno.test("SEND IT refuses a never-dispatched AJS release that misses a permanent pack CC", async () => {
  const state = harness({ routes: ajsRoutes(LEGACY_CC, LEGACY_CC) });
  let error: SesActionError | null = null;
  try {
    await execute(state);
  } catch (err) {
    error = err as SesActionError;
  }
  assert(error instanceof SesActionError, "expected a typed SES refusal");
  assertEquals(error!.status, 409);
  const refusal = error!.refusal as any;
  assertEquals(refusal.code, "route_recipient_invalid");
  assertEquals(refusal.evidence.release_send_in_flight, false);
  assertEquals(refusal.evidence.required, ajsPackCc());
  // Nothing has reached the builder, so preparing a new revision is safe.
  assertEquals(state.graphCalls.length, 0);
});

Deno.test("SEND IT finishes an in-flight pre-ruling AJS release instead of stranding it", async () => {
  const state = harness({
    routes: ajsRoutes(LEGACY_CC, LEGACY_CC),
    builderKey: "AJS",
    confirmedKinds: ["report_invoice"],
  });
  const result: any = await execute(state);
  assertEquals(result.state, "released");
  // The confirmed route reconciles; only the outstanding photo route dispatches.
  assertEquals(state.graphCalls.map((call) => call.subject), ["Photos"]);
});

Deno.test("SEND IT still enforces the ses@ floor on an in-flight pre-ruling release", async () => {
  const state = harness({
    routes: ajsRoutes(
      ["someone-else@example.com"],
      ["someone-else@example.com"],
    ),
    confirmedKinds: ["report_invoice"],
  });
  let error: SesActionError | null = null;
  try {
    await execute(state);
  } catch (err) {
    error = err as SesActionError;
  }
  assert(error instanceof SesActionError, "expected a typed SES refusal");
  const refusal = error!.refusal as any;
  assertEquals(refusal.code, "route_recipient_invalid");
  assertEquals(refusal.evidence.release_send_in_flight, true);
  assertEquals(refusal.evidence.required, [MAKESAFE_CC]);
  assertEquals(state.graphCalls.length, 0);
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
  assertEquals(state.graphCalls[0].cc, ajsPackCc());
  assertEquals(state.graphCalls[1].cc, []);
});

Deno.test("SEND IT dispatches AJBR completion docs with finance only and photos with no CC", async () => {
  const state = harness({ builderKey: "AJBR" });
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

Deno.test("SEND IT refuses a never-dispatched AJBR release carrying the old CC set", async () => {
  const state = harness({
    builderKey: "AJBR",
    routes: ajsRoutes(ajsPackCc(), ajsPackCc()),
  });
  let error: SesActionError | null = null;
  try {
    await execute(state);
  } catch (err) {
    error = err as SesActionError;
  }
  assert(error instanceof SesActionError, "expected a typed SES refusal");
  const refusal = error!.refusal as any;
  assertEquals(refusal.code, "route_recipient_invalid");
  assertEquals(refusal.evidence.builder_key, "AJBR");
  assertEquals(refusal.evidence.required, [SES_FINANCE_CC]);
  assertEquals(refusal.evidence.exact, true);
  assertEquals(state.graphCalls.length, 0);
});
