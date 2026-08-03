// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SesBlocker, SesDocketEnvelopeV3 } from "./ses_docket_envelope.ts";
import {
  canManageSesDocsReadySignoff,
  evaluateSesDocsReadyGate,
  nextSesDocsReadyState,
} from "./ses_docs_ready.ts";
import {
  assertSesDocketsSignedOffForSend,
  SesActionError,
  sesReviewArtifactDisplayLabel,
} from "./ses_reporting_actions.ts";

const INDEX = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const ACTIONS = await Deno.readTextFile(
  new URL("./ses_reporting_actions.ts", import.meta.url),
);
const SQL = await Deno.readTextFile(
  new URL(
    "../../migrations/20260728210000_makesafe_ses_docs_ready_signoff.sql",
    import.meta.url,
  ),
);

const typedBlocker: SesBlocker = {
  state: "blocked",
  reason: "The current-cycle report PDF is missing.",
  reason_code: "trade_evidence_missing",
  searches_attempted: ["job_service_reports", "makesafe_docket_artifacts"],
  rejected_candidates: [],
  recovery_action: "Submit and render the current-cycle report.",
};

function envelope(
  preXeroDocsReady: boolean,
  blocker: SesBlocker | null,
): SesDocketEnvelopeV3 {
  return {
    version: "secureworks.makesafe.docket-manifest/v3-envelope",
    v2: {
      version: "secureworks.makesafe.docket-manifest/v2",
      docket_id: "SWMS-123",
      classification: {},
      routing: {
        builder: "builder",
        report_to: "reports@example.com",
        photo_to: "photos@example.com",
        invoice_to: "invoices@example.com",
      },
      items: {
        report: blocker || { state: "ready", evidence: "file:report.pdf" },
      },
      deliverables: [],
    },
    spine: {
      source_instruction_id: "wo-1",
      lineage_id: "lineage-1",
      job_id: "00000000-0000-0000-0000-000000000123",
      card_id: null,
      property_id: null,
      attendance_cycle_ids: ["00000000-0000-0000-0000-000000000124"],
      current_attendance_cycle_id: "00000000-0000-0000-0000-000000000124",
      readiness_revision:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      docket_revision_id: "00000000-0000-0000-0000-000000000125",
    },
    pre_xero_docs_ready: preXeroDocsReady,
    local_invoice_proposal: {
      state: preXeroDocsReady ? "ready" : "blocked",
      evidence: "file:invoice-proposal.json",
    },
    invoice_create_approved: false,
    client_send_approved: false,
    family_matrix_version: "ses-family-matrix/v1",
    assembler_version: "ses-pack-assembler/v1",
    input_content_hash:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    output_content_hash:
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  };
}

Deno.test("audit-grade gate queues only the assembler-complete family pack", () => {
  assertEquals(
    evaluateSesDocsReadyGate({
      state: "ready",
      envelope: envelope(true, null),
      blockers: [],
    }),
    { state: "needs_review", blockers: [] },
  );

  const refused = evaluateSesDocsReadyGate({
    state: "blocked",
    envelope: envelope(false, typedBlocker),
    blockers: [typedBlocker],
  });
  assertEquals(refused.state, "blocked");
  assertEquals(refused.blockers, [typedBlocker]);
  assertEquals(refused.blockers[0], typedBlocker);
});

Deno.test("Docs Ready transitions are needs-review, signed-off, and invalidated", async () => {
  assertEquals(nextSesDocsReadyState(null, "prepared"), "needs_review");
  assertEquals(
    nextSesDocsReadyState("needs_review", "signed_off"),
    "signed_off",
  );
  assertEquals(
    nextSesDocsReadyState("signed_off", "content_changed"),
    "needs_review",
  );
  assertEquals(
    nextSesDocsReadyState("signed_off", "revoked"),
    "needs_review",
  );
  await assertRejects(
    () =>
      Promise.resolve().then(() => {
        nextSesDocsReadyState("needs_review", "revoked");
      }),
    TypeError,
    "invalid Docs Ready transition",
  );
});

Deno.test("only an identified Captain or admin-owner can tick or revoke", () => {
  assertEquals(
    canManageSesDocsReadySignoff({
      mode: "jwt",
      role: "trade",
      operator_class: "captain",
    }),
    true,
  );
  assertEquals(
    canManageSesDocsReadySignoff({
      mode: "jwt",
      role: "owner",
      operator_class: null,
    }),
    true,
  );
  assertEquals(
    canManageSesDocsReadySignoff({
      mode: "jwt",
      role: "trade",
      operator_class: "shaun_clean",
    }),
    false,
  );
  assertEquals(
    canManageSesDocsReadySignoff({ mode: "api_key" }),
    false,
  );
});

Deno.test("append-only SQL invalidates old signoff when exact content changes", () => {
  for (
    const required of [
      "CREATE TABLE IF NOT EXISTS public.ses_docket_review_events",
      "review_state IN ('needs_review', 'signed_off')",
      "event_kind IN ('prepared', 'content_changed', 'signed_off', 'revoked')",
      "docket_output_content_hash",
      "event_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE",
      "assembler_version",
      "family_matrix_version",
      "signed_off_at",
      "is append-only",
      "docket_revision_id <> target.id",
      "effective_kind := 'content_changed'",
      "invalidated_signoff := prior_event.id",
      "new docket content exists; review the current exact revision",
      "REVOKE INSERT, UPDATE, DELETE ON public.ses_docket_review_events",
    ]
  ) {
    assertStringIncludes(SQL, required);
  }
});

Deno.test("database pack gate reuses assembler verdict and typed blockers", () => {
  assertStringIncludes(SQL, "target.state <> 'ready'");
  assertStringIncludes(SQL, "NOT target.pre_xero_docs_ready");
  assertStringIncludes(SQL, "jsonb_array_length(target.blockers) <> 0");
  assertStringIncludes(SQL, "artifact.role = 'xero_invoice_pdf'");
  assertStringIncludes(
    SQL,
    "keep its typed blockers and do not queue it for review",
  );
  assert(
    !SQL.includes("UPDATE public.makesafe_docket_revisions"),
    "review state must not mutate append-only docket bytes",
  );
});

Deno.test("shared SES release path refuses every unsigned exact member", async () => {
  const calls: string[] = [];
  const client = {
    rpc: (name: string) => {
      calls.push(name);
      return Promise.resolve({
        data: null,
        error: {
          message:
            "Docs Ready signoff missing: Captain must tick the current exact pack bytes",
        },
      });
    },
  } as any;
  const error = await assertRejects(
    () =>
      assertSesDocketsSignedOffForSend(client, [
        "00000000-0000-0000-0000-000000000001",
      ]),
    SesActionError,
  );
  assert("code" in error.refusal);
  assertEquals(error.refusal.code, "docs_ready_signoff_missing");
  assertEquals(calls, ["assert_ses_dockets_signed_off_v1"]);

  const executeStart = ACTIONS.indexOf(
    "export async function executeSesReleaseRevisionAction",
  );
  const signoffWall = ACTIONS.indexOf(
    "await assertSesDocketsSignedOffForSend(",
    executeStart,
  );
  const executionReservation = ACTIONS.indexOf(
    'client.rpc("begin_ses_release_execution_v1"',
    executeStart,
  );
  const providerDispatch = ACTIONS.indexOf(
    "mailGateway.createDraftAndSend",
    executeStart,
  );
  const signoffWallCount = [
    ...ACTIONS.slice(executeStart).matchAll(
      /await assertSesDocketsSignedOffForSend\(/g,
    ),
  ].length;
  assert(
    executeStart >= 0 && signoffWall > executeStart &&
      executionReservation > signoffWall &&
      providerDispatch > executionReservation &&
      signoffWallCount >= 2,
    "signoff wall must run before release reservation and every Graph send",
  );
});

Deno.test("ops-api exposes the four dashboard Docs Ready actions", () => {
  for (
    const action of [
      "list_ses_docs_ready_reviews",
      "get_ses_reviewable_pack",
      "sign_off_ses_docket",
      "revoke_ses_docket_signoff",
    ]
  ) {
    assertStringIncludes(INDEX, `case '${action}'`);
  }
  assertStringIncludes(ACTIONS, "createSignedUrl");
  assertStringIncludes(ACTIONS, "signed_url_expires_in_seconds: 300");
  assertEquals(
    sesReviewArtifactDisplayLabel("source_attachment"),
    "Works Order",
  );
  assertEquals(sesReviewArtifactDisplayLabel("report"), null);
  assertStringIncludes(ACTIONS, "display_label: sesReviewArtifactDisplayLabel");
});
