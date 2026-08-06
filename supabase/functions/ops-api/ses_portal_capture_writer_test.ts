// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
/**
 * F7 capture WRITER proof — the observer can now remember what it saw.
 *
 * These tests run the whole path end to end with no production access: the
 * observer's own request builder feeds the REAL `recordSesPortalCaptureEvidence`,
 * which commits through a ledger double that enforces the same rules as
 * `20260728500000_makesafe_portal_capture_bridge_u4.sql` (the CHECK constraint,
 * the idempotency unique index and the per-role version sequence), and the
 * persisted row is then handed to the REAL board read model.
 *
 * Nothing here is a restatement of the production rules; every assertion is
 * made against imported product code, so a regression in the writer, the
 * recorder or the reader fails the same suite.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import fixture from "./fixtures/ses_u4_swms_26980_live_snapshot.json" with {
  type: "json",
};
import {
  assertCaptureWriteAction,
  base64FromBytes,
  buildCaptureWriteRequest,
  CaptureWriteRefusal,
  decideCaptureWrite,
  SES_PORTAL_CAPTURE_OBSERVER_AGENT,
  SES_PORTAL_CAPTURE_WRITE_ACTION,
  writeCaptureRevision,
} from "../../../scripts/ses-f7-prime-portal-observer.ts";
import {
  isTrustedSesPortalCaptureProducer,
  rawSesPortalCaptureSha256,
  SES_PORTAL_CAPTURE_PRODUCER,
  SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
  SES_TRUSTED_PORTAL_CAPTURE_PRODUCERS,
} from "./ses_portal_capture_contract.ts";
import {
  recordSesPortalCaptureEvidence,
  SesPortalCaptureEvidenceError,
} from "./ses_portal_capture_evidence.ts";
import {
  buildCanonicalMakesafeRows,
  OPS_MAKESAFE_STAGES,
  portalCapturesFromLedger,
} from "./makesafe_board_read_model.ts";
import { _deriveMakesafeBoardStage } from "./index.ts";

type Row = Record<string, unknown>;

const NOW = "2026-08-02T12:00:00Z";
/**
 * `captured_at` is validated against the real clock (the recorder refuses a
 * capture claimed more than ten minutes in the future), so observation times
 * are relative rather than a frozen literal.
 */
const CAPTURED_AT = new Date(Date.now() - 60_000).toISOString();
const CAPTURED_AT_LATER = new Date(Date.now() - 30_000).toISOString();
const SOURCE_URL =
  "https://primeeco.tech/share/2ef11c67-8f63-48cb-9ff4-61bf71848f17";
const JOB_ID = fixture.job.id;
const CYCLE_ID = fixture.detail.attendance_cycle_id;
const BUILDER_REFERENCE = fixture.detail.external_ref;

/** A minimal, genuinely-PNG screenshot. No portal pixels ever enter a fixture. */
const SCREENSHOT_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function liveSnapshot() {
  const live = structuredClone(fixture) as unknown as Record<string, unknown>;
  const job = live.job as Row;
  (job.metadata as Row).makesafe_job_family = "roof_report";
  // Shaped exactly as the sibling recorder suite shapes it, and for the same
  // reason: the family must resolve to `ordinary_roof_portal` for the card's
  // one Prime link to type as `roof_report`. A strata client relationship
  // resolves it to `own_template_roof` instead, where the link types as
  // `assessment` and this card has no roof portal to capture. The placeholder
  // is synthetic - no real client name enters a fixture.
  job.client_name = "Ordinary insured";
  (live.detail as Row).report_type = null;
  live.identity_revision = {
    authority_kind: "legacy_job_record",
    source_instruction_id: `legacy-job:${job.id}`,
    source_version: 1,
    source_content_hash: `sha256:${"a".repeat(64)}`,
    lineage_id: job.id,
    effective_case_id: null,
  };
  return live;
}

/**
 * Ledger double enforcing the U4 bridge migration's own rules.
 *
 * It exposes no update and no delete, so "append-only" is a property of the
 * double rather than a claim a test has to remember to check.
 */
class LedgerDouble {
  readonly rows: Row[] = [];
  readonly uploads: Array<{ path: string; bytes: Uint8Array }> = [];
  rpcNames: string[] = [];

  commit(capture: Row): Row {
    this.rpcNames.push("commit_makesafe_portal_capture_v1");
    const result = String(capture.capture_result || "");
    const status = String(capture.status || "");
    const expectedStatus = result === "done"
      ? "verified"
      : result === "not_done"
      ? "captured"
      : "rejected";
    // makesafe_portal_capture_bridge_shape
    const violations: string[] = [];
    if (
      !["roof_report", "assessment", "photos", "scope"].includes(
        String(capture.role),
      )
    ) violations.push("role");
    if (!["done", "not_done", "unreachable"].includes(result)) {
      violations.push("capture_result");
    }
    if (!String(capture.source_url || "").startsWith("https://")) {
      violations.push("source_url");
    }
    for (const key of ["source_content_hash", "makesafe_content_hash"]) {
      if (!/^sha256:[0-9a-f]{64}$/.test(String(capture[key] || ""))) {
        violations.push(key);
      }
    }
    if (!String(capture.builder_reference || "").trim()) {
      violations.push("builder_reference");
    }
    if (!String(capture.captured_by || "").trim()) {
      violations.push("captured_by");
    }
    if (capture.capture_producer !== SES_PORTAL_CAPTURE_PRODUCER) {
      violations.push("capture_producer");
    }
    if (!String(capture.capture_idempotency_key || "").trim()) {
      violations.push("capture_idempotency_key");
    }
    if (!String(capture.signal || "").trim()) violations.push("signal");
    if (!(capture.evidence_refs as unknown[])?.length) {
      violations.push("evidence_refs");
    }
    if (status !== expectedStatus) violations.push("status_result_pairing");
    if (result === "unreachable") {
      if (
        capture.screenshot_object_key || capture.screenshot_media_type ||
        capture.screenshot_content_hash || capture.screenshot_size_bytes
      ) violations.push("unreachable_screenshot_present");
    } else {
      if (
        !String(capture.screenshot_object_key || "").startsWith(
          "makesafe-docket-artifacts/portal-captures/",
        ) || capture.screenshot_media_type !== "image/png" ||
        !/^sha256:[0-9a-f]{64}$/.test(
          String(capture.screenshot_content_hash || ""),
        ) || !(Number(capture.screenshot_size_bytes) > 0)
      ) violations.push("screenshot_shape");
    }
    if (violations.length) {
      throw new Error(
        `new row for relation "makesafe_portal_capture_revisions" violates check constraint "makesafe_portal_capture_bridge_shape" (${
          violations.join(",")
        })`,
      );
    }

    // uq_makesafe_portal_capture_idempotency
    const existing = this.rows.find((row) =>
      row.job_id === capture.job_id &&
      row.attendance_cycle_id === capture.attendance_cycle_id &&
      row.role === capture.role &&
      row.capture_idempotency_key === capture.capture_idempotency_key
    );
    if (existing) {
      if (existing.makesafe_content_hash !== capture.makesafe_content_hash) {
        throw new Error(
          `portal capture idempotency conflict for ${capture.capture_idempotency_key}`,
        );
      }
      return existing;
    }

    const version = this.rows.filter((row) =>
      row.job_id === capture.job_id &&
      row.attendance_cycle_id === capture.attendance_cycle_id &&
      row.role === capture.role
    ).reduce(
      (max, row) => Math.max(max, Number(row.makesafe_fact_version || 0)),
      0,
    ) + 1;
    const inserted: Row = {
      id: `revision-${this.rows.length + 1}`,
      org_id: "org-1",
      created_at: NOW,
      ...capture,
      makesafe_fact_version: version,
    };
    this.rows.push(inserted);
    return inserted;
  }
}

function clientFor(live: Record<string, unknown>, ledger: LedgerDouble) {
  const rows: Record<string, unknown> = {
    jobs: [live.job],
    makesafe_job_details: [live.detail],
    makesafe_state_identity_current_v2: [live.identity_revision],
    makesafe_intake_cases: live.cases,
    makesafe_attendance_cycles: live.cycles,
    job_service_reports: live.reports,
    job_assignments: live.assignments,
    job_media: live.media,
    job_documents: live.documents,
    makesafe_roof_report_drafts: [],
    makesafe_readiness_current: [],
    makesafe_portal_capture_revisions: ledger.rows,
    makesafe_report_packs: [],
  };
  return {
    storage: {
      from(_bucket: string) {
        return {
          async upload(path: string, bytes: Uint8Array) {
            if (ledger.uploads.some((upload) => upload.path === path)) {
              return { data: null, error: { statusCode: "409" } };
            }
            ledger.uploads.push({ path, bytes });
            return { data: { path }, error: null };
          },
          async download(path: string) {
            const found = ledger.uploads.find((upload) => upload.path === path);
            return found
              ? { data: new Blob([found.bytes as any]), error: null }
              : { data: null, error: { message: "not found" } };
          },
        };
      },
    },
    from(table: string) {
      let single = false;
      const query: any = {
        select: () => query,
        eq: () => query,
        neq: () => query,
        order: () => query,
        maybeSingle: () => {
          single = true;
          return query;
        },
        then(resolve: (value: { data: unknown; error: null }) => unknown) {
          const data = rows[table] ?? [];
          return Promise.resolve({
            data: single && Array.isArray(data) && data.length === 1
              ? data[0]
              : single
              ? null
              : data,
            error: null,
          }).then(resolve);
        },
      };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name !== "commit_makesafe_portal_capture_v1") {
        return { data: null, error: { message: `unexpected rpc ${name}` } };
      }
      try {
        return { data: ledger.commit(args.p_capture as Row), error: null };
      } catch (error) {
        return {
          data: null,
          error: { message: (error as Error).message },
        };
      }
    },
  };
}

/** The board card as the read model sees it, shaped from the same fixture. */
function boardCard(over: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    job_number: "SWMS-26980",
    type: "makesafe",
    status: "processing",
    board_stage: "allocated",
    board_label: "allocated",
    substatus: "admin_to_send_report",
    external_ref: BUILDER_REFERENCE,
    metadata: { makesafe_job_family: "roof_report" },
    makesafe_details: {
      substatus: "admin_to_send_report",
      report_type: "roof_report",
      external_ref: BUILDER_REFERENCE,
      external_links: fixture.detail.external_links,
      cycle_number: 1,
      attendance_cycle_id: CYCLE_ID,
    },
    assignments: [],
    ...over,
  };
}

async function observerRequest(
  over: Partial<Parameters<typeof buildCaptureWriteRequest>[0]> = {},
) {
  const screenshotHash = await rawSesPortalCaptureSha256(SCREENSHOT_BYTES);
  return buildCaptureWriteRequest({
    job_id: JOB_ID,
    attendance_cycle_id: CYCLE_ID,
    role: "roof_report",
    capture_result: "done",
    source_url: SOURCE_URL,
    source_content_hash: `sha256:${"b".repeat(64)}`,
    builder_reference: BUILDER_REFERENCE,
    captured_at: CAPTURED_AT,
    capture_idempotency_key: "observer-swms-26980-roof-v1",
    signal: "submitted/locked observed, 21 of 23 fields answered",
    screenshot: {
      content_hash: screenshotHash,
      bytes_base64: base64FromBytes(SCREENSHOT_BYTES),
    },
    ...over,
  });
}

Deno.test("F7 writer: a valid observation produces exactly one revision the board read model accepts", async () => {
  const live = liveSnapshot();
  const ledger = new LedgerDouble();
  const client = clientFor(live, ledger);
  const request = await observerRequest();

  assertEquals(request.action, SES_PORTAL_CAPTURE_WRITE_ACTION);
  const persisted = await recordSesPortalCaptureEvidence(
    client as any,
    request.body,
    "ops-api:api_key",
  );

  // Exactly one revision, and it is the first version for this job/cycle/role.
  assertEquals(ledger.rows.length, 1);
  assertEquals(ledger.rpcNames, ["commit_makesafe_portal_capture_v1"]);
  assertEquals(persisted.makesafe_fact_version, 1);
  assertEquals(persisted.capture_result, "done");
  assertEquals(persisted.status, "verified");

  // The producer is recorded, and so is the concrete agent that looked.
  assertEquals(persisted.capture_producer, SES_PORTAL_CAPTURE_PRODUCER);
  assert(isTrustedSesPortalCaptureProducer(persisted.capture_producer));
  assertEquals(persisted.captured_by, SES_PORTAL_CAPTURE_OBSERVER_AGENT);
  assertEquals(persisted.created_by, "ops-api:api_key");

  // The EXISTING reader accepts it, unchanged.
  const accepted = portalCapturesFromLedger(boardCard(), ledger.rows);
  assertEquals(accepted.length, 1);
  assertEquals(accepted[0].status, "done");
  assertEquals(accepted[0].role, "roof_report");
  assertEquals(accepted[0].locked, true);
  assertEquals(accepted[0].cycle_number, 1);
  assert(
    String(accepted[0].screenshot || "").startsWith(
      "makesafe-docket-artifacts/portal-captures/",
    ),
  );
});

/** A revision the reader accepts, used wherever "a valid capture" is needed. */
function acceptedRevision() {
  return {
    id: "revision-1",
    job_id: JOB_ID,
    attendance_cycle_id: CYCLE_ID,
    role: "roof_report",
    status: "verified",
    makesafe_fact_version: 1,
    capture_result: "done",
    source_url: SOURCE_URL,
    source_content_hash: `sha256:${"b".repeat(64)}`,
    builder_reference: BUILDER_REFERENCE,
    captured_at: NOW,
    captured_by: SES_PORTAL_CAPTURE_OBSERVER_AGENT,
    capture_producer: SES_PORTAL_CAPTURE_PRODUCER,
    signal: "submitted/locked observed",
    screenshot_object_key:
      "makesafe-docket-artifacts/portal-captures/job/cycle/roof_report/a.png",
    screenshot_media_type: "image/png",
    screenshot_content_hash: `sha256:${"c".repeat(64)}`,
    screenshot_size_bytes: 8,
  };
}

Deno.test("F7 writer: recording a capture writes evidence only, and the stage follows that evidence", async () => {
  // Evolved from "F7 writer: recording a capture moves no stage".
  //
  // Before the R12 cutover a capture was display-only, so "no stage moved" was
  // both the WRITE guarantee and the READ guarantee, and one assertion covered
  // both. R12 made an accepted exact-cycle capture genuine PLACEMENT evidence,
  // which splits them apart:
  //
  //   - The write guarantee survives untouched and is what this test protects.
  //     Recording a capture commits evidence and nothing else: it issues no
  //     stage or substatus write, so no raw board state changes.
  //   - The read consequence is now the opposite. The derived stage SHOULD
  //     move, because the evidence the derivation reads has changed. A card
  //     whose column ignored new proof would be the bug, not the fix.
  //
  // Running the REAL recorder is what makes the write half load-bearing: the
  // client double exposes no `update` and no `insert` at all, so an attempt to
  // write board state would throw rather than pass unnoticed.
  const live = liveSnapshot();
  const ledger = new LedgerDouble();
  const request = await observerRequest();
  await recordSesPortalCaptureEvidence(
    clientFor(live, ledger) as any,
    request.body,
    "ops-api:api_key",
  );

  // WRITE: exactly one mutation reached the database and it was the evidence
  // commit. No stage-write RPC, and no second call.
  assertEquals(ledger.rpcNames, ["commit_makesafe_portal_capture_v1"]);
  assertEquals(ledger.rows.length, 1);

  const [before] = buildCanonicalMakesafeRows([boardCard()], {
    computedAt: NOW,
  });
  const [after] = buildCanonicalMakesafeRows([boardCard()], {
    portalCaptureRowsByJobId: { [JOB_ID]: [ledger.rows[0]] },
    computedAt: NOW,
  });

  // The capture is visible as evidence...
  assertEquals(
    before.computed_status_evidence.has_current_portal_capture,
    false,
  );
  assertEquals(after.computed_status_evidence.has_current_portal_capture, true);

  // ...raw board state is untouched, because nothing wrote any...
  assertEquals(after.declared_stage, before.declared_stage);
  assertEquals(after.substatus, before.substatus);
  assertEquals(after.job_state, before.job_state);

  // ...and the derived column moves exactly as far as the new proof carries it.
  // The builder's roof form is now proved submitted and locked, which is
  // report-in. It does NOT overshoot into report_ready: there is still no
  // assembled pack, and a capture is not a pack.
  assertEquals(before.canonical_stage, "allocated");
  assertEquals(after.canonical_stage, "trade_report_in");
});

Deno.test("F7 writer: a capture changes only what it proves, and never raw board state", () => {
  // Evolved from "F7 writer: no board stage can move because a capture exists".
  //
  // The R12 cutover made an accepted capture placement evidence, so the blanket
  // "no column may move" claim is no longer the guarantee — moving on new proof
  // is the point. Two things survive, and both are asserted below:
  //
  //   - No capture ever writes raw board state. `declared_stage`, `substatus`
  //     and `job_state` are identical before and after, in every combination.
  //   - A capture moves a column only as far as it PROVES. An accepted
  //     exact-cycle capture proves report-in; a capture the reader refuses
  //     proves nothing and moves nothing at all.
  //
  // 1. STRUCTURAL. The legacy ladder that places every card takes no capture
  //    argument, so a ledger row is not an input it could read.
  const legacySource = _deriveMakesafeBoardStage.toString();
  const parameterList = legacySource.slice(
    legacySource.indexOf("("),
    legacySource.indexOf(")"),
  );
  for (const forbidden of ["capture", "portal", "revision"]) {
    assert(
      !parameterList.toLowerCase().includes(forbidden),
      `legacy ladder must take no ${forbidden} input; got ${parameterList}`,
    );
  }

  // 2. BEHAVIOURAL, across every stage the board can display. Injecting a valid
  //    accepted capture on a card in each stage writes no raw state on any of
  //    them, and moves every one of them to exactly the column the capture
  //    proves — never past it, and never somewhere the old `board_stage`
  //    happened to claim.
  for (const stage of OPS_MAKESAFE_STAGES) {
    for (
      const substatus of [
        "company_contact_required",
        "waiting_on_trade_report",
        "awaiting_portal_completion",
        "admin_to_send_report",
        "ready_to_invoice",
      ]
    ) {
      const card = boardCard({
        board_stage: stage,
        board_label: stage,
        substatus,
        makesafe_details: {
          ...boardCard().makesafe_details,
          substatus,
        },
      });
      const [before] = buildCanonicalMakesafeRows([card], { computedAt: NOW });
      const [after] = buildCanonicalMakesafeRows([card], {
        portalCaptureRowsByJobId: { [JOB_ID]: [acceptedRevision()] },
        computedAt: NOW,
      });
      // Raw board state: written by nothing, so identical either side.
      assertEquals(
        after.declared_stage,
        before.declared_stage,
        `${stage}/${substatus} declared_stage was written`,
      );
      assertEquals(
        after.substatus,
        before.substatus,
        `${stage}/${substatus} substatus was written`,
      );
      assertEquals(
        after.job_state,
        before.job_state,
        `${stage}/${substatus} job_state was written`,
      );
      // Derived column: the card starts short of report-in whatever the stale
      // `board_stage` claimed, and the accepted capture proves exactly
      // report-in. Same answer for all 40 combinations, which is the point —
      // placement follows the evidence, not the declared column.
      assertEquals(
        before.canonical_stage,
        "allocated",
        `${stage}/${substatus} unexpected pre-capture placement`,
      );
      assertEquals(
        after.canonical_stage,
        "trade_report_in",
        `${stage}/${substatus} capture did not place the card on its evidence`,
      );
    }
  }

  // 3. A capture the reader REFUSES proves nothing, so it moves nothing. This
  //    is the half of the original guarantee that survives verbatim: absence of
  //    accepted evidence can never advance a card.
  const refused: Array<[string, Record<string, unknown>]> = [
    ["stale attendance cycle", { attendance_cycle_id: "cycle-stale" }],
    ["wrong source URL", {
      source_url: "https://www.primeeco.tech/share/somewhere-else",
    }],
    ["observed not done", { capture_result: "not_done", status: "captured" }],
    ["missing screenshot", { screenshot_object_key: null }],
  ];
  for (const [name, over] of refused) {
    const [after] = buildCanonicalMakesafeRows([boardCard()], {
      portalCaptureRowsByJobId: {
        [JOB_ID]: [{ ...acceptedRevision(), ...over }],
      },
      computedAt: NOW,
    });
    assertEquals(after.canonical_stage, "allocated", name);
    assertEquals(
      after.computed_status_evidence.has_current_portal_capture,
      false,
      name,
    );
  }
});

Deno.test("F7 writer: a missing required element writes nothing and records why", async () => {
  const missing: Array<[string, Record<string, unknown>]> = [
    ["missing_attendance_cycle", { attendance_cycle_id: null }],
    ["unbound_capture_role", { role: null }],
    ["missing_builder_reference", { builder_reference: "   " }],
    ["missing_capture_idempotency_key", { capture_idempotency_key: null }],
    ["missing_signal", { signal: "" }],
    ["missing_source_content_hash", { source_content_hash: "not-a-hash" }],
    ["missing_or_non_https_source_url", {
      source_url: "http://primeeco.tech/x",
    }],
    ["missing_screenshot", { screenshot: null }],
  ];
  for (const [reason, over] of missing) {
    const error = await observerRequest(over as any).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert(
      error instanceof CaptureWriteRefusal,
      `${reason} should refuse before any network call`,
    );
    assertEquals((error as CaptureWriteRefusal).reason, reason);
  }

  // Nothing reached the ledger, because nothing reached the recorder.
  const ledger = new LedgerDouble();
  assertEquals(ledger.rows.length, 0);

  // And the refusal is mirrored server-side: a capture whose cycle is stale is
  // rejected by the real recorder even if a caller hand-builds the body.
  const live = liveSnapshot();
  const client = clientFor(live, ledger);
  const request = await observerRequest();
  await assertRejects(
    () =>
      recordSesPortalCaptureEvidence(
        client as any,
        {
          ...request.body,
          attendance_cycle_id: "11111111-2222-3333-4444-555555555555",
        },
        "ops-api:api_key",
      ),
    SesPortalCaptureEvidenceError,
    "is not the card's current cycle",
  );
  assertEquals(ledger.rows.length, 0);
});

Deno.test("F7 writer: a partial capture the reader would trust is refused at the reader too", async () => {
  const live = liveSnapshot();
  const ledger = new LedgerDouble();
  const request = await observerRequest();
  await recordSesPortalCaptureEvidence(
    clientFor(live, ledger) as any,
    request.body,
    "ops-api:api_key",
  );
  const stored = ledger.rows[0];
  assertEquals(
    portalCapturesFromLedger(boardCard(), [stored]).length,
    1,
    "positive control: the persisted reader row must reach the projection",
  );

  // Each single missing element independently makes the reader drop the row.
  for (
    const broken of [
      { builder_reference: "" },
      { screenshot_object_key: null },
      { source_content_hash: "not-a-hash" },
      { attendance_cycle_id: "another-cycle" },
      { source_url: "https://primeeco.tech/share/not-this-cards-link" },
    ]
  ) {
    assertEquals(
      portalCapturesFromLedger(boardCard(), [{ ...stored, ...broken }]),
      [],
    );
  }

  // Producer trust needs its own producer-shaped control. Changing the reader
  // producer alone would also violate the screenshot rule, so begin with a
  // valid screenshot-less trade attestation and change only its producer.
  const tradeAttestation = {
    ...stored,
    capture_producer: SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
    screenshot_object_key: null,
    screenshot_media_type: null,
    screenshot_content_hash: null,
    screenshot_size_bytes: null,
  };
  assertEquals(
    portalCapturesFromLedger(boardCard(), [tradeAttestation]).length,
    1,
    "positive control: an approved trade attestation must reach the projection",
  );
  assertEquals(
    portalCapturesFromLedger(boardCard(), [{
      ...tradeAttestation,
      capture_producer: "some-other-producer/v1",
    }]),
    [],
    "an otherwise-valid row must be refused solely because its producer is untrusted",
  );
});

Deno.test("F7 writer: re-running over unchanged state creates no duplicate", async () => {
  const live = liveSnapshot();
  const ledger = new LedgerDouble();
  const client = clientFor(live, ledger);
  const request = await observerRequest();

  const first = await recordSesPortalCaptureEvidence(
    client as any,
    request.body,
    "ops-api:api_key",
  );
  const second = await recordSesPortalCaptureEvidence(
    client as any,
    request.body,
    "ops-api:api_key",
  );

  assertEquals(ledger.rows.length, 1);
  assertEquals(second.id, first.id);
  assertEquals(second.makesafe_fact_version, 1);
  // The content-addressed screenshot was stored once, not twice.
  assertEquals(ledger.uploads.length, 1);

  // The planner is the FIRST line of defence: an unchanged observation never
  // reaches the recorder at all.
  assertEquals(
    decideCaptureWrite({
      commit: true,
      plannedAction: "idempotent_noop",
      planReason: "unchanged_capture_exists",
      writesUsed: 0,
      maxWrites: 1,
    }),
    { outcome: "idempotent_noop", reason: "unchanged_capture_exists" },
  );

  // The DATABASE is the second: a same-key write whose content differs is a
  // conflict, and the observer reads that conflict as "no duplicate created".
  const conflicting = await observerRequest({
    captured_at: CAPTURED_AT_LATER,
  });
  const transport = async (action: string, body: Record<string, unknown>) => {
    try {
      const data = await recordSesPortalCaptureEvidence(
        client as any,
        body,
        "ops-api:api_key",
      );
      assertEquals(action, SES_PORTAL_CAPTURE_WRITE_ACTION);
      return { status: 200, payload: data };
    } catch (error) {
      const typed = error as SesPortalCaptureEvidenceError;
      return {
        status: typed.status,
        payload: { error: typed.message, code: typed.code },
      };
    }
  };
  const result = await writeCaptureRevision(conflicting, transport);
  assertEquals(result.outcome, "idempotent_noop");
  assertEquals(result.reason, "database_idempotency_conflict");
  assertEquals(ledger.rows.length, 1);
});

Deno.test("F7 writer: an appended later observation is a new revision, never an edit", async () => {
  const live = liveSnapshot();
  const ledger = new LedgerDouble();
  const client = clientFor(live, ledger);

  await recordSesPortalCaptureEvidence(
    client as any,
    (await observerRequest({
      capture_result: "not_done",
      capture_idempotency_key: "observer-swms-26980-roof-in-progress",
      signal: "in progress: 8 of 23 fields answered",
    })).body,
    "ops-api:api_key",
  );
  await recordSesPortalCaptureEvidence(
    client as any,
    (await observerRequest()).body,
    "ops-api:api_key",
  );

  assertEquals(ledger.rows.length, 2);
  assertEquals(ledger.rows.map((row) => row.makesafe_fact_version), [1, 2]);
  // The earlier observation is untouched.
  assertEquals(ledger.rows[0].capture_result, "not_done");
  assertEquals(ledger.rows[0].status, "captured");
  // The reader takes the newest version for the role and reports it as done.
  const accepted = portalCapturesFromLedger(boardCard(), ledger.rows);
  assertEquals(accepted.length, 1);
  assertEquals(accepted[0].status, "done");
});

Deno.test("F7 writer: an expired link records cannot-observe, never not-done", async () => {
  const live = liveSnapshot();
  const ledger = new LedgerDouble();
  const client = clientFor(live, ledger);

  const request = await observerRequest({
    capture_result: "unreachable",
    signal: "cannot observe: Prime link expired or inactive",
    capture_idempotency_key: "observer-swms-26980-roof-expired",
    screenshot: null,
  });
  assertEquals(request.body.screenshot, undefined);

  const persisted = await recordSesPortalCaptureEvidence(
    client as any,
    request.body,
    "ops-api:api_key",
  );
  assertEquals(persisted.capture_result, "unreachable");
  assertEquals(persisted.status, "rejected");
  assertEquals(persisted.screenshot_object_key, null);
  // No screenshot was invented for a page nobody could read.
  assertEquals(ledger.uploads.length, 0);

  // "Could not observe" is NOT evidence of incompletion: the reader surfaces it
  // as unreachable and unlocked, never as not_done.
  const [capture] = portalCapturesFromLedger(boardCard(), ledger.rows);
  assertEquals(capture.status, "unreachable");
  assertEquals(capture.locked, false);
  assertEquals(capture.screenshot, null);

  // And an unreachable capture carrying a screenshot is refused outright.
  const screenshotHash = await rawSesPortalCaptureSha256(SCREENSHOT_BYTES);
  assertThrows(
    () =>
      buildCaptureWriteRequest({
        job_id: JOB_ID,
        attendance_cycle_id: CYCLE_ID,
        role: "roof_report",
        capture_result: "unreachable",
        source_url: SOURCE_URL,
        source_content_hash: `sha256:${"b".repeat(64)}`,
        builder_reference: BUILDER_REFERENCE,
        captured_at: NOW,
        capture_idempotency_key: "k",
        signal: "cannot observe",
        screenshot: {
          content_hash: screenshotHash,
          bytes_base64: base64FromBytes(SCREENSHOT_BYTES),
        },
      }),
    CaptureWriteRefusal,
    "unreachable_capture_carries_screenshot",
  );
});

Deno.test("F7 writer: the only reachable write action is the evidence recorder", () => {
  assertCaptureWriteAction(SES_PORTAL_CAPTURE_WRITE_ACTION);
  for (
    const forbidden of [
      "makesafe_status_apply",
      "update_job_status",
      "update_job_field",
      "mark_makesafe_portal_report_done",
      "makesafe_state_reconcile",
      "makesafe_duplicate_survivor_archive",
    ]
  ) {
    assertThrows(
      () => assertCaptureWriteAction(forbidden),
      CaptureWriteRefusal,
      "disallowed_ops_api_action",
    );
  }
});

Deno.test("F7 writer: producer trust is the exact two-member seam the captain owns", () => {
  assertEquals([...SES_TRUSTED_PORTAL_CAPTURE_PRODUCERS], [
    SES_PORTAL_CAPTURE_PRODUCER,
    SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
  ]);
  assert(isTrustedSesPortalCaptureProducer(SES_PORTAL_CAPTURE_PRODUCER));
  assert(
    isTrustedSesPortalCaptureProducer(
      SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
    ),
  );
  for (
    const candidate of [
      SES_PORTAL_CAPTURE_OBSERVER_AGENT,
      "trade-app/v1",
      "",
      null,
      undefined,
      42,
    ]
  ) {
    assertEquals(isTrustedSesPortalCaptureProducer(candidate), false);
  }
});
