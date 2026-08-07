// deno-lint-ignore-file no-import-prefix
//
// Bind-time renderer validity. The defect these pin: re-pinning the wiki
// renderer un-trusted every bind made under the previous pin, because both
// readers of the stamp compared it against TODAY'S constants. Nothing about
// those binds changed; the validator started asking the wrong question.
//
// The fence that must not open in the process is the mirror image: an older
// identity is admissible only for a bind whose own instant lies inside that
// identity's closed window, so a bind made NOW claiming an old renderer is
// still refused. Both directions are asserted here, at the register and at
// each of the two call sites.
import {
  assert,
  assertEquals,
  assertFalse,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertMakesafeRendererRegisterMatchesPin,
  MAKESAFE_REPORT_RENDERER_AUTHORITY_REGISTER,
  makesafeCurrentRendererAuthorityEntry,
  makesafeRendererAuthorityEntryForStamp,
  makesafeRendererAuthorityVersion,
  makesafeRendererStampAuthorisedAtBind,
} from "./makesafe_report_renderer_authority.ts";
import {
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
  MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
  MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
  MAKESAFE_REPORT_CONTRACT_VERSION,
} from "./makesafe_report_render.ts";
import { inspectSesSupportingReportProof } from "./ses_supporting_report_trust.ts";
import {
  selectPhysicalReportProofForCycle,
  type SesAssemblerLiveSnapshot,
} from "./ses_assembler_input_adapter.ts";

// The identity the three reported cards (and 31 others) were bound under, and
// the deploy instant that closed its window. Production coordinates, measured
// read-only on 2026-08-07 — not invented for the test.
const SUPERSEDED = MAKESAFE_REPORT_RENDERER_AUTHORITY_REGISTER[1];
const SUPERSEDED_VERSION = makesafeRendererAuthorityVersion(SUPERSEDED);
/** SWMS-261157's real curated bind instant, inside the superseded window. */
const REAL_BIND_AT = "2026-08-07T05:39:59.689265+00:00";
const NOW = "2026-08-07T23:00:00.000Z";

const supersededStamp = {
  version: SUPERSEDED_VERSION,
  source_revision: SUPERSEDED.source_revision,
  script_sha256: SUPERSEDED.script_sha256,
};
const currentStamp = {
  version: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
  source_revision: MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
  script_sha256: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
};

Deno.test("register is append-only, contiguous, and its open entry IS the current pin", () => {
  assertMakesafeRendererRegisterMatchesPin();
  const current = makesafeCurrentRendererAuthorityEntry();
  assertEquals(
    current.source_revision,
    MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
  );
  assertEquals(
    current.script_sha256,
    MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
  );
  assertEquals(
    makesafeRendererAuthorityVersion(current),
    MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
  );
  // Every superseded entry hands straight over to its successor, so no bind
  // instant can land in a gap where no renderer was authoritative.
  for (
    const [index, entry] of MAKESAFE_REPORT_RENDERER_AUTHORITY_REGISTER
      .entries()
  ) {
    if (entry.authorised_until === null) continue;
    assertEquals(
      entry.authorised_until,
      MAKESAFE_REPORT_RENDERER_AUTHORITY_REGISTER[index + 1].authorised_from,
    );
    assert(entry.provenance.length > 0, `entry ${index} records no provenance`);
  }
});

Deno.test("the register carries the identity the reported cards were bound under", () => {
  assertEquals(
    SUPERSEDED.script_sha256,
    "fda63bcffa0177b702089e67b5719ae50642a9972aa3628c516fcedb1cfe42dc",
  );
  assertEquals(SUPERSEDED.authorised_until, "2026-08-07T08:36:29Z");
  assertEquals(
    makesafeCurrentRendererAuthorityEntry().authorised_from,
    SUPERSEDED.authorised_until,
  );
});

Deno.test("bind-time validity: superseded identity is trusted inside its own window", () => {
  assert(makesafeRendererStampAuthorisedAtBind(supersededStamp, REAL_BIND_AT));
  // Boundaries: `from` is inclusive, `until` is exclusive.
  assert(
    makesafeRendererStampAuthorisedAtBind(
      supersededStamp,
      SUPERSEDED.authorised_from,
    ),
  );
  assertFalse(
    makesafeRendererStampAuthorisedAtBind(
      supersededStamp,
      SUPERSEDED.authorised_until,
    ),
  );
});

Deno.test("the fence holds forward: a superseded identity with a current instant is refused", () => {
  assertFalse(makesafeRendererStampAuthorisedAtBind(supersededStamp, NOW));
  // ...and so is one with no instant at all. An unproved bind time is not a
  // licence; it leaves the current pin as the only acceptable stamp.
  assertFalse(makesafeRendererStampAuthorisedAtBind(supersededStamp, null));
  assertFalse(makesafeRendererStampAuthorisedAtBind(supersededStamp, ""));
  assertFalse(
    makesafeRendererStampAuthorisedAtBind(supersededStamp, "not-a-date"),
  );
  // Before its window opened is equally not authoritative.
  assertFalse(
    makesafeRendererStampAuthorisedAtBind(
      supersededStamp,
      "2026-08-01T00:00:00Z",
    ),
  );
});

Deno.test("a new bind must still match the current pin exactly", () => {
  assert(makesafeRendererStampAuthorisedAtBind(currentStamp, NOW));
  assert(makesafeRendererStampAuthorisedAtBind(currentStamp, null));
  // An unregistered renderer is refused however recent its bind.
  assertFalse(
    makesafeRendererStampAuthorisedAtBind({
      version: "secureworks.wiki-python/" + "a".repeat(40),
      source_revision: "a".repeat(40),
      script_sha256: "b".repeat(64),
    }, NOW),
  );
  // Half-matches never resolve in favour of either half: a stamp whose version
  // and revision disagree describes no renderer that ever ran.
  assertEquals(
    makesafeRendererAuthorityEntryForStamp({
      ...supersededStamp,
      version: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
    }),
    null,
  );
  assertEquals(
    makesafeRendererAuthorityEntryForStamp({
      ...supersededStamp,
      script_sha256: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
    }),
    null,
  );
});

Deno.test("a re-pin that forgets the register fails loudly, in every way it can be forgotten", () => {
  const current = makesafeCurrentRendererAuthorityEntry();
  const movedPin = {
    source_revision: "c".repeat(40),
    script_sha256: "d".repeat(64),
  };
  // 1. Constants moved, register left behind entirely. This is the exact
  //    mistake of 2026-08-07 and the one this guard exists to catch.
  assertThrows(
    () =>
      assertMakesafeRendererRegisterMatchesPin(
        MAKESAFE_REPORT_RENDERER_AUTHORITY_REGISTER,
        movedPin,
      ),
    Error,
    "not the current pin",
  );
  // 2. New entry appended but the outgoing window never closed: two open
  //    windows means two identities authoritative at once.
  assertThrows(
    () =>
      assertMakesafeRendererRegisterMatchesPin([
        { ...current, authorised_until: null },
        { ...current, ...movedPin, authorised_from: "2026-08-09T00:00:00Z" },
      ], movedPin),
    Error,
    "only the last entry may be open",
  );
  // 3. Outgoing window closed at an instant its successor does not open at,
  //    leaving a gap in which no renderer was authoritative.
  assertThrows(
    () =>
      assertMakesafeRendererRegisterMatchesPin([
        { ...current, authorised_until: "2026-08-08T00:00:00Z" },
        {
          ...current,
          ...movedPin,
          authorised_from: "2026-08-09T00:00:00Z",
          authorised_until: null,
        },
      ], movedPin),
    Error,
    "windows must be contiguous",
  );
  // 4. A past entry edited to repeat an identity rather than appended.
  assertThrows(
    () =>
      assertMakesafeRendererRegisterMatchesPin([
        { ...current, authorised_until: "2026-08-09T00:00:00Z" },
        { ...current, authorised_from: "2026-08-09T00:00:00Z" },
      ]),
    Error,
    "repeats a renderer identity",
  );
  // And the real register, against the real pin, is sound.
  assertMakesafeRendererRegisterMatchesPin();
});

// ── Call site 1: the served-pack trust inspection ──

function supportingReportArtifact(
  renderer: Record<string, unknown>,
): Record<string, unknown> {
  const content = `sha256:${"a".repeat(64)}`;
  const raw = "b".repeat(64);
  return {
    id: "artifact-under-test",
    role: "supporting_report_pdf",
    media_type: "application/pdf",
    content_hash: content,
    size_bytes: 1024,
    metadata: {
      source_kind: "durable_curated_revision",
      source_identity: "curation-revision:rev-1/artifact:art-1",
      source_document_id: "document-1",
      report_document_id: "document-1",
      source_revision_id: "rev-1",
      source_artifact_id: "art-1",
      source_artifact_content_hash: content,
      expected_raw_sha256: raw,
      output_sha256: raw,
      render_hash: raw,
      evidence_source: "current_cycle_curated_makesafe_report",
      report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
      report_input_hash: `sha256:${"c".repeat(64)}`,
      ...renderer,
    },
  };
}

const supersededMetadata = {
  report_renderer_version: SUPERSEDED_VERSION,
  report_renderer_source_revision: SUPERSEDED.source_revision,
  report_renderer_script_sha256: SUPERSEDED.script_sha256,
};
const currentMetadata = {
  report_renderer_version: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_VERSION,
  report_renderer_source_revision:
    MAKESAFE_REPORT_AUTHORITATIVE_SOURCE_REVISION,
  report_renderer_script_sha256: MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256,
};

Deno.test("trust inspection: a pre-re-pin bind recovers with no re-bind", () => {
  const artifact = supportingReportArtifact(supersededMetadata);
  assertEquals(
    inspectSesSupportingReportProof(artifact, {
      curated_bind_at: REAL_BIND_AT,
    }),
    { trusted: true },
  );
});

Deno.test("trust inspection: the fence still refuses an old identity bound now", () => {
  const artifact = supportingReportArtifact(supersededMetadata);
  assertEquals(
    inspectSesSupportingReportProof(artifact, { curated_bind_at: NOW }),
    { trusted: false, reason: "active_renderer_input_binding_missing" },
  );
  // No bind instant supplied is the pre-existing refusal, unchanged.
  assertEquals(
    inspectSesSupportingReportProof(artifact),
    { trusted: false, reason: "active_renderer_input_binding_missing" },
  );
});

Deno.test("trust inspection: a current-pin bind is unaffected, with or without an instant", () => {
  const artifact = supportingReportArtifact(currentMetadata);
  assertEquals(inspectSesSupportingReportProof(artifact), { trusted: true });
  assertEquals(
    inspectSesSupportingReportProof(artifact, { curated_bind_at: NOW }),
    { trusted: true },
  );
});

Deno.test("trust inspection: bind-time validity opens nothing else", () => {
  // A real bind instant does not rescue an artifact that fails any other check.
  const selfVouching = supportingReportArtifact(supersededMetadata);
  (selfVouching.metadata as Record<string, unknown>).source_identity =
    "document-1";
  assertEquals(
    inspectSesSupportingReportProof(selfVouching, {
      curated_bind_at: REAL_BIND_AT,
    }),
    { trusted: false, reason: "source_identity_self_reference" },
  );
  const noInputHash = supportingReportArtifact(supersededMetadata);
  (noInputHash.metadata as Record<string, unknown>).report_input_hash = "";
  assertEquals(
    inspectSesSupportingReportProof(noInputHash, {
      curated_bind_at: REAL_BIND_AT,
    }),
    { trusted: false, reason: "active_renderer_input_binding_missing" },
  );
});

// ── Call site 2: the assembler's durable curated document selection ──

const CYCLE = "cycle-1";

function snapshotWith(
  renderer: Record<string, unknown>,
  bindEvents: Array<Record<string, unknown>>,
): SesAssemblerLiveSnapshot {
  return {
    job: { id: "job-1", job_number: "SWMS-TEST" },
    detail: { job_id: "job-1", attendance_cycle_id: CYCLE },
    cycles: [],
    reports: [],
    assignments: [],
    media: [],
    documents: [{
      id: "document-1",
      job_id: "job-1",
      type: "makesafe_report",
      visible_to_trades: true,
      attendance_cycle_id: CYCLE,
      cycle_attribution: "bound",
      version: 1,
      created_at: "2026-08-07T05:34:45.925522+00:00",
      data_snapshot_json: {
        report_contract_version: MAKESAFE_REPORT_CONTRACT_VERSION,
        report_render_hash: "e".repeat(64),
        evidence_source: "current_cycle_curated_makesafe_report",
        curated_source_kind: "durable_curated_revision",
        curated_source_identity:
          "curation-revision:curation-1/artifact:artifact-1",
        curated_source_revision_id: "curation-1",
        curated_source_artifact_id: "artifact-1",
        curated_source_artifact_content_hash: `sha256:${"d".repeat(64)}`,
        curated_source_expected_raw_sha256: `sha256:${"e".repeat(64)}`,
        report_input_hash: `sha256:${"f".repeat(64)}`,
        ...renderer,
      },
    }],
    roof_draft: null,
    readiness: null,
    portal_captures: [],
    legacy_packs: [],
    docket_revisions: [],
    docket_artifacts: [],
    events: [],
    curated_bind_events: bindEvents,
  } as unknown as SesAssemblerLiveSnapshot;
}

function bindEvent(createdAt: string): Record<string, unknown> {
  return {
    id: "bind-1",
    job_id: "job-1",
    event_type: "ses_curated_report_source_bind_validated",
    created_at: createdAt,
    detail_json: { document_id: "document-1" },
  };
}

Deno.test("adapter selection: a pre-re-pin bind is selectable again, with no re-bind", () => {
  const proof = selectPhysicalReportProofForCycle(
    snapshotWith(supersededMetadata, [bindEvent(REAL_BIND_AT)]),
    CYCLE,
  );
  assertEquals(proof?.source_kind, "durable_curated_revision");
  assertEquals(proof?.source_document_id, "document-1");
});

Deno.test("adapter selection: the fence still refuses an old identity bound now", () => {
  assertEquals(
    selectPhysicalReportProofForCycle(
      snapshotWith(supersededMetadata, [bindEvent(NOW)]),
      CYCLE,
    ),
    null,
  );
  // No bind trail at all is the pre-existing refusal, not a new licence.
  assertEquals(
    selectPhysicalReportProofForCycle(
      snapshotWith(supersededMetadata, []),
      CYCLE,
    ),
    null,
  );
});

Deno.test("adapter selection: the newest bind decides, so a re-bind cannot be out-voted", () => {
  // Document re-bound under the current pin after an earlier superseded bind:
  // the stale claim must not be vouched for by the older event.
  assertEquals(
    selectPhysicalReportProofForCycle(
      snapshotWith(supersededMetadata, [bindEvent(REAL_BIND_AT), {
        ...bindEvent(NOW),
        id: "bind-2",
      }]),
      CYCLE,
    ),
    null,
  );
});

Deno.test("adapter selection: a current-pin bind is unaffected", () => {
  const proof = selectPhysicalReportProofForCycle(
    snapshotWith(currentMetadata, [bindEvent(NOW)]),
    CYCLE,
  );
  assertEquals(proof?.source_document_id, "document-1");
});

Deno.test("both call sites answer the same way about the same identity", () => {
  // A partial fix leaves the two disagreeing, which is the shape of the defect
  // rather than its cure. Same stamp, same instant, same verdict, every time.
  for (
    const [renderer, metadata] of [
      [supersededMetadata, supersededMetadata],
      [currentMetadata, currentMetadata],
    ] as const
  ) {
    for (const boundAt of [REAL_BIND_AT, NOW]) {
      const trusted =
        inspectSesSupportingReportProof(supportingReportArtifact(metadata), {
          curated_bind_at: boundAt,
        }).trusted;
      const selected = selectPhysicalReportProofForCycle(
        snapshotWith(renderer, [bindEvent(boundAt)]),
        CYCLE,
      ) !== null;
      assertEquals(
        trusted,
        selected,
        `call sites disagree for bind at ${boundAt}`,
      );
    }
  }
});
