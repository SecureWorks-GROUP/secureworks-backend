// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
/**
 * SEND IT body guard: a persisted release route whose BODY still carries
 * internal draft-annotation vocabulary must refuse before any Graph dispatch,
 * on every shape. This is the send-side backstop for the SWMS-261161 /
 * SWMS-261158 live leak — the producers are proved in
 * ses_release_route_shape_test.ts; this drives the real
 * executeSesReleaseRevisionAction against PERSISTED route rows, exactly the
 * store the leaked sends read from.
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
import { ajsPackCc } from "./ses_release_route_shape.ts";

const RELEASE_ID = "release-body-1";
const JOB_ID = "job-body-1";
const DOCKET_ID = "docket-body-1";
const CONTENT_HASH = "sha256:" + "e".repeat(64);

/** The verbatim annotation body that shipped to the builder on 2026-08-13. */
const LEAKED_REPORT_BODY =
  "Draft only. Report pack for 63 Chidlow St, Northam. Ordinary Mail.Send (group-thread reply is Application: Not supported); subject matches the original work-order email for inbox grouping only — not real threading. Photos and the billing pack travel on separate routes.";

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

function mlbRoutes(reportBody: string): any[] {
  return [
    {
      ordinal: 0,
      route_kind: "report",
      recipients: ["mlb.mailer@primeeco.tech"],
      cc: [],
      subject: "NEW WORK ORDER - MLB-27516 63 Chidlow St E, Northam, WA 6401",
      body: reportBody,
      body_hash: hash(1),
      attachment_hashes: [hash(11)],
    },
    {
      ordinal: 1,
      route_kind: "photo",
      recipients: ["mlb.mailer@primeeco.tech"],
      cc: [],
      subject: "NEW WORK ORDER - MLB-27516 63 Chidlow St E, Northam, WA 6401",
      body: "Please find attached site photos for MLB-27516.\n\nThank you.",
      body_hash: hash(2),
      attachment_hashes: [hash(21)],
    },
    {
      ordinal: 2,
      route_kind: "invoice",
      recipients: ["makesafes@mlbuilders.com.au"],
      cc: ["finance@secureworkswa.com.au"],
      subject: "MLB-27516 - Xero invoice INV-1179",
      body:
        "Please find attached the invoice and supporting documents for MLB-27516.\n\nThank you.",
      body_hash: hash(3),
      attachment_hashes: [hash(11), hash(31)],
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
  {
    content_hash: hash(31),
    size_bytes: 300_000,
    object_key: `dockets/${DOCKET_ID}/Xero Invoice INV-1179.pdf`,
    media_type: "application/pdf",
  },
];

interface Harness {
  routes: any[];
  effects: Map<string, any>;
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
          return query({ data: [], error: null });
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
                    builder_key: "MLB",
                    family: "physical_makesafe",
                  },
                  routing: { invoice_to: "makesafes@mlbuilders.com.au" },
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
        const effect = { ...rpcArgs.p_effect, state: "reserved" };
        harness.effects.set(String(effect.operation_key), effect);
        return Promise.resolve({
          data: { claim_mode: "reserved", effect },
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
        body: payload.body,
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
      const match = sentByToken.get(String(token));
      return match ? [match] : [];
    },
  };
}

const xeroReader = { readAuthorised: async () => ({ id: "xero-invoice-1" }) };
const sealedWorkflowContractFixture = {
  assertWorkflowReleaseContract: async () => `sha256:${"f".repeat(64)}`,
};

async function execute(state: Harness) {
  return await executeSesReleaseRevisionAction(
    scriptedClient(state),
    { mode: "api_key", user: null },
    { org_id: "org-1", release_revision_id: RELEASE_ID, actor: "captain" },
    mailGatewayStub(state),
    xeroReader as any,
    sealedWorkflowContractFixture,
  );
}

Deno.test("SEND IT refuses a persisted route whose body carries internal annotations, before any dispatch", async () => {
  const state: Harness = {
    routes: mlbRoutes(LEAKED_REPORT_BODY),
    effects: new Map(),
    graphCalls: [],
  };
  let error: SesActionError | null = null;
  try {
    await execute(state);
  } catch (err) {
    error = err as SesActionError;
  }
  assert(error instanceof SesActionError, "expected a typed SES refusal");
  assertEquals(error!.status, 409);
  const refusal = error!.refusal as any;
  assertEquals(refusal.code, "route_body_internal_annotation");
  assertEquals(refusal.evidence.route_kind, "report");
  // Nothing reached Graph — the annotation can no longer ship on ANY shape.
  assertEquals(state.graphCalls.length, 0);
});

Deno.test("SEND IT dispatches an MLB release whose persisted bodies are clean", async () => {
  const state: Harness = {
    routes: mlbRoutes(
      "Please find attached the report for MLB-27516.\n\nThank you.",
    ),
    effects: new Map(),
    graphCalls: [],
  };
  const result: any = await execute(state);
  assertEquals(result.state, "released");
  assertEquals(state.graphCalls.length, 3);
  for (const call of state.graphCalls) {
    assertEquals(
      /draft|docket|pack\b|route|cycle|revision|mail\.send/i.test(call.body),
      false,
      call.body,
    );
  }
  // Sanity: the AJS CC producer is untouched by this guard.
  assertEquals(ajsPackCc().length, 3);
});
