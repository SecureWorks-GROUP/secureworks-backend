// deno-lint-ignore-file no-explicit-any require-await
/**
 * SEND IT (execute_ses_release_revision) wiring proof for the photo-mail volume
 * guard. The pure guard and the mail-gateway assert are covered in
 * ses_photo_mail_volume_guard_test.ts; this drives the real
 * executeSesReleaseRevisionAction with a scripted client so the operator-facing
 * 409 refusal body is the thing under test, and proves the mail gateway is
 * never reached for an oversized photo route.
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  executeSesReleaseRevisionAction,
  SesActionError,
  type SesSupabaseClient,
} from "./ses_reporting_actions.ts";
import {
  base64EncodedLength,
  PHOTO_MAIL_VOLUME_EXCEEDS_GRAPH_LIMIT,
} from "./ses_photo_mail_volume_guard.ts";

const RELEASE_ID = "release-1";
const JOB_ID = "job-ajs-1";
const DOCKET_ID = "docket-1";
const CONTENT_HASH = "sha256:" + "c".repeat(64);
const MAKESAFE_CC = "ses@secureworkswa.com.au";

interface ArtifactRow {
  content_hash: string;
  size_bytes: number;
  object_key: string;
  media_type: string;
}

function hash(n: number): string {
  return `sha256:${String(n).padStart(64, "0")}`;
}

/** Minimal scripted PostgREST-shaped builder: chainable, resolves to `result`. */
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

function scriptedClient(args: {
  routes: any[];
  artifacts: ArtifactRow[];
  tablesTouched: string[];
  effects: Map<string, any>;
}): SesSupabaseClient {
  return {
    from(table: string) {
      args.tablesTouched.push(table);
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
          return query({ data: args.routes, error: null });
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
                    builder_key: "AJS",
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
          return query({ data: args.artifacts, error: null });
        case "job_events":
          return query({ data: [], error: null });
        case "makesafe_closeout_revisions":
          return query({
            data: args.effects.get("closeout") || null,
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
        // Echo the exact effect identity the action built for this route, and
        // remember it so later transitions keep that route's own token.
        const effect = { ...rpcArgs.p_effect, state: "reserved" };
        args.effects.set(String(effect.operation_key), effect);
        return Promise.resolve({
          data: { claim_mode: "reserved", effect },
          error: null,
        });
      }
      if (name === "transition_ses_external_effect_v1") {
        const effect = args.effects.get(String(rpcArgs.p_operation_key)) || {
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
        args.effects.set("closeout", closeout);
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

const AJS_PACK_CC = [
  MAKESAFE_CC,
  "vanessa@ajs.build",
  "mandi@ajs.build",
];

function ajsRoutes(photoHashes: string[]): any[] {
  return [
    {
      ordinal: 1,
      route_kind: "report_invoice",
      recipients: ["workorders@ajs.build"],
      cc: AJS_PACK_CC,
      subject: "Report + Invoice",
      body: "Report and invoice",
      body_hash: hash(1),
      attachment_hashes: [hash(11)],
    },
    {
      ordinal: 2,
      route_kind: "photo",
      recipients: ["workorders@ajs.build"],
      cc: AJS_PACK_CC,
      subject: "Photos",
      body: "Photo pack",
      body_hash: hash(2),
      attachment_hashes: photoHashes,
    },
  ];
}

function mailGatewayStub(calls: any[]): any {
  // Graph proves the send by token, exactly as the real gateway does.
  const sentByToken = new Map<string, any>();
  return {
    createDraftAndSend: async (payload: any, context: any) => {
      calls.push({ subject: payload.subject, token: context.external_token });
      const result = {
        message_id: `graph-message-${calls.length}`,
        internet_message_id: `<msg-${calls.length}@graph>`,
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

Deno.test("SEND IT refuses an oversized photo route with a named 409 and no Graph call", async () => {
  const photoHashes = [hash(21), hash(22), hash(23)];
  const artifacts: ArtifactRow[] = [
    {
      content_hash: hash(11),
      size_bytes: 900_000,
      object_key: `dockets/${DOCKET_ID}/Make%20Safe%20Report.pdf`,
      media_type: "application/pdf",
    },
    ...photoHashes.map((content_hash, index) => ({
      content_hash,
      size_bytes: 13 * 1024 * 1024,
      object_key: `dockets/${DOCKET_ID}/photos/00${index + 1}.jpg`,
      media_type: "image/jpeg",
    })),
  ];
  const calls: any[] = [];
  const tablesTouched: string[] = [];
  let error: SesActionError | null = null;
  try {
    await executeSesReleaseRevisionAction(
      scriptedClient({
        routes: ajsRoutes(photoHashes),
        artifacts,
        tablesTouched,
        effects: new Map(),
      }),
      { mode: "api_key", user: null },
      { org_id: "org-1", release_revision_id: RELEASE_ID, actor: "captain" },
      mailGatewayStub(calls),
      xeroReader as any,
    );
  } catch (err) {
    error = err as SesActionError;
  }

  assert(error instanceof SesActionError, "expected a typed SES refusal");
  assertEquals(error!.status, 409);
  const refusal = error!.refusal as any;
  assertEquals(refusal.state, "refused");
  assertEquals(refusal.code, PHOTO_MAIL_VOLUME_EXCEEDS_GRAPH_LIMIT);
  // The refusal states the actual total against the actual documented limit.
  assertStringIncludes(refusal.fact, "39.00 MiB");
  // The message-total term compares the base64-encoded wire size.
  assertStringIncludes(refusal.fact, "52.00 MiB");
  assertStringIncludes(refusal.fact, "35.00 MiB");
  assertStringIncludes(refusal.fact, "not culled");
  assertEquals(refusal.evidence.attachment_count, 3);
  assertEquals(refusal.evidence.total_raw_bytes, 39 * 1024 * 1024);
  assertEquals(
    refusal.evidence.total_base64_bytes,
    3 * base64EncodedLength(13 * 1024 * 1024),
  );
  assertEquals(
    refusal.evidence.message_size_limit_bytes,
    35 * 1024 * 1024,
  );
  assertEquals(refusal.evidence.exceeded, "message_total");
  assertEquals(refusal.evidence.transport, "user_mailbox");
  assertEquals(refusal.evidence.photo_cull, false);
  assertEquals(refusal.evidence.offending_attachments.length, 3);
  // Only the preceding report+invoice route reached Graph; the photo route
  // refused before any Graph call of its own.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].subject, "Report + Invoice");
});

Deno.test("SEND IT dispatches the same photo route once it fits under the ceiling", async () => {
  const photoHashes = [hash(21), hash(22), hash(23)];
  const artifacts: ArtifactRow[] = [
    {
      content_hash: hash(11),
      size_bytes: 900_000,
      object_key: `dockets/${DOCKET_ID}/Make%20Safe%20Report.pdf`,
      media_type: "application/pdf",
    },
    ...photoHashes.map((content_hash, index) => ({
      content_hash,
      size_bytes: 5 * 1024 * 1024,
      object_key: `dockets/${DOCKET_ID}/photos/00${index + 1}.jpg`,
      media_type: "image/jpeg",
    })),
  ];
  const calls: any[] = [];
  const tablesTouched: string[] = [];
  await executeSesReleaseRevisionAction(
    scriptedClient({
      routes: ajsRoutes(photoHashes),
      artifacts,
      tablesTouched,
      effects: new Map(),
    }),
    { mode: "api_key", user: null },
    { org_id: "org-1", release_revision_id: RELEASE_ID, actor: "captain" },
    mailGatewayStub(calls),
    xeroReader as any,
  );
  assertEquals(calls.map((call) => call.subject), [
    "Report + Invoice",
    "Photos",
  ]);
});
