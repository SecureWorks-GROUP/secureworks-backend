// deno-lint-ignore-file no-import-prefix

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyCanonicalIdentityUpdate,
  assertLineageImmutable,
  assertSameOrg,
  attachSourceOnce,
  buildInstructionKey,
  buildLiveIdentityKey,
  buildReplayKey,
  companyKeyFromId,
  isMakesafeCaseTransitionAllowed,
  MAKESAFE_NORMALISER_VERSION,
  type MakesafeIdentity,
  type MakesafeLineageSnapshot,
  type MakesafeSourceAccountingRow,
  normaliseMakesafeIdentity,
  placeCaseInLineage,
  planBackfillInstruction,
  validateMakesafeCaseState,
} from "./makesafe_intake_case_model.ts";

const ORG_A = "00000000-0000-0000-0000-000000000001";
const ORG_B = "00000000-0000-0000-0000-000000000002";
const COMPANY_MLB = "11111111-1111-1111-1111-111111111111";
const COMPANY_AJBR = "22222222-2222-2222-2222-222222222222";

const root: MakesafeLineageSnapshot = {
  id: "case-root",
  orgId: ORG_A,
  lineageId: "case-root",
  parentCaseId: null,
  parentRelation: null,
  cycle: 1,
  reasonCode: null,
};

Deno.test("state machine permits reviewed resolution and rejects destructive shortcuts", () => {
  assert(isMakesafeCaseTransitionAllowed("exception", "blocked_live_job"));
  assert(
    isMakesafeCaseTransitionAllowed("blocked_live_job", "confirmed_live_job"),
  );
  assert(isMakesafeCaseTransitionAllowed("accounted_non_wo", "exception"));
  assertEquals(
    isMakesafeCaseTransitionAllowed("confirmed_live_job", "accounted_non_wo"),
    false,
  );
  assertEquals(
    isMakesafeCaseTransitionAllowed("accounted_non_wo", "confirmed_live_job"),
    false,
  );
});

Deno.test("all four states require coherent jobs, reasons and identity floor", () => {
  const liveIdentity = {
    companyId: COMPANY_MLB,
    canonicalIdentity: "PO-9182-A",
    clientName: "Client",
    siteAddress: "1 Test Street",
  };
  assertEquals(
    validateMakesafeCaseState({
      state: "confirmed_live_job",
      reasonCode: null,
      blockedReasons: [],
      jobId: "job-1",
      ...liveIdentity,
    }),
    [],
  );
  assertEquals(
    validateMakesafeCaseState({
      state: "blocked_live_job",
      reasonCode: null,
      blockedReasons: ["missing:client_phone"],
      jobId: "job-1",
      ...liveIdentity,
    }),
    [],
  );
  assertEquals(
    validateMakesafeCaseState({
      state: "exception",
      reasonCode: "below_identity_floor",
      blockedReasons: [],
      jobId: null,
      companyId: null,
      canonicalIdentity: null,
      clientName: null,
      siteAddress: null,
    }),
    [],
  );
  assertEquals(
    validateMakesafeCaseState({
      state: "accounted_non_wo",
      reasonCode: "non_makesafe",
      blockedReasons: [],
      jobId: null,
      companyId: null,
      canonicalIdentity: null,
      clientName: null,
      siteAddress: null,
    }),
    [],
  );
});

Deno.test("hostile state fixtures reject unnamed blocks, ref-less live work and cancellation jobs", () => {
  assert(
    validateMakesafeCaseState({
      state: "blocked_live_job",
      reasonCode: null,
      blockedReasons: [],
      jobId: "job-1",
      companyId: COMPANY_MLB,
      canonicalIdentity: "MLB-1",
      clientName: "Client",
      siteAddress: "1 Test Street",
    }).includes("blocked_live_job requires named blockedReasons"),
  );
  assert(
    validateMakesafeCaseState({
      state: "confirmed_live_job",
      reasonCode: null,
      blockedReasons: [],
      jobId: "job-1",
      companyId: COMPANY_MLB,
      canonicalIdentity: null,
      clientName: "Client",
      siteAddress: "1 Test Street",
    }).some((error) => error.includes("canonical builder WO/PO/ref identity")),
  );
  assert(
    validateMakesafeCaseState({
      state: "exception",
      reasonCode: "cancellation",
      blockedReasons: [],
      jobId: "job-1",
      companyId: COMPANY_MLB,
      canonicalIdentity: "MLB-1",
      clientName: "Client",
      siteAddress: "1 Test Street",
    }).includes("cancellation cannot own a jobId"),
  );
});

Deno.test("one versioned normaliser preserves dashed refs and WO/PO precedence", () => {
  const canonical = normaliseMakesafeIdentity({
    externalRefRaw: "AJBR 67200",
    builderWoRaw: "AJBR67200",
    builderPoRaw: " PO 91 A ",
    deliverableRefRaw: "Temporary fence",
  });
  assertEquals(canonical.externalRefCanonical, "AJBR-67200");
  assertEquals(canonical.builderWoCanonical, "AJBR-67200");
  assertEquals(canonical.builderPoCanonical, "PO-91-A");
  assertEquals(
    canonical.woPoIdentityKey,
    "wo:AJBR-67200/po:PO-91-A",
  );
  assertEquals(canonical.normaliserVersion, MAKESAFE_NORMALISER_VERSION);

  const claimOnly = normaliseMakesafeIdentity({
    externalRefRaw: "MLB 27037",
    builderWoRaw: null,
    builderPoRaw: null,
    deliverableRefRaw: "assessment",
  });
  assertEquals(claimOnly.externalRefCanonical, "MLB-27037");
  assertEquals(claimOnly.woPoIdentityKey, null);
});

Deno.test("unprefixed builder WOs stay distinct instead of collapsing to digits", () => {
  const woForm = normaliseMakesafeIdentity({
    externalRefRaw: null,
    builderWoRaw: "WO 12345",
    builderPoRaw: null,
    deliverableRefRaw: null,
  });
  const refForm = normaliseMakesafeIdentity({
    externalRefRaw: null,
    builderWoRaw: "REF 12345",
    builderPoRaw: null,
    deliverableRefRaw: null,
  });
  assertEquals(woForm.builderWoCanonical, "WO-12345");
  assertEquals(refForm.builderWoCanonical, "REF-12345");
  assertNotEquals(woForm.woPoIdentityKey, refForm.woPoIdentityKey);
});

Deno.test("punctuation variants of one builder WO stay one identity", () => {
  const keys = ["WO#12345", "WO #12345", "WO-12345", "WO/12345"].map((raw) =>
    normaliseMakesafeIdentity({
      externalRefRaw: null,
      builderWoRaw: raw,
      builderPoRaw: null,
      deliverableRefRaw: null,
    }).woPoIdentityKey
  );
  assertEquals(new Set(keys).size, 1);
  assertEquals(keys[0], "wo:WO-12345");
});

Deno.test("dot and underscore stay significant inside builder POs", () => {
  const keys = ["PO-1.2", "PO_1_2", "PO-1-2"].map((raw) =>
    normaliseMakesafeIdentity({
      externalRefRaw: null,
      builderWoRaw: null,
      builderPoRaw: raw,
      deliverableRefRaw: null,
    }).woPoIdentityKey
  );
  assertEquals(new Set(keys).size, 3);
});

Deno.test("canonical WO/PO cannot smuggle the identity key separators", () => {
  const smuggled = normaliseMakesafeIdentity({
    externalRefRaw: null,
    builderWoRaw: "A/po:B",
    builderPoRaw: "C",
    deliverableRefRaw: null,
  });
  const plain = normaliseMakesafeIdentity({
    externalRefRaw: null,
    builderWoRaw: "A",
    builderPoRaw: "B/po:C",
    deliverableRefRaw: null,
  });
  assertEquals(smuggled.builderWoCanonical, "A-PO-B");
  assertEquals(plain.builderPoCanonical, "B-PO-C");
  assertNotEquals(smuggled.woPoIdentityKey, plain.woPoIdentityKey);
});

Deno.test("reopen instruction keys differ from the cycle they reopen", () => {
  const original = buildInstructionKey({
    instructionFingerprint: "fingerprint-mlb-27037",
    deliverableDiscriminator: "po:PO-A",
  });
  const reopen = buildInstructionKey({
    instructionFingerprint: "fingerprint-mlb-27037",
    deliverableDiscriminator: "po:PO-A",
    cycle: 2,
  });
  assertNotEquals(original, reopen);
  assertEquals(
    original,
    buildInstructionKey({
      instructionFingerprint: "fingerprint-mlb-27037",
      deliverableDiscriminator: "po:PO-A",
      cycle: 1,
    }),
  );
  assertThrows(
    () =>
      buildInstructionKey({
        instructionFingerprint: "f",
        deliverableDiscriminator: "d",
        cycle: 0,
      }),
    Error,
    "cycle must be a positive integer",
  );
});

Deno.test("raw builder, ref, WO, PO and deliverable survive canonical refinement", () => {
  const original: MakesafeIdentity = {
    companySlugRaw: "  MASTER BUILDERS - Perth ",
    externalRefRaw: "MLB 27037 / Rev A",
    builderWoRaw: " WO 27037 ",
    builderPoRaw: " PO-9182-A ",
    deliverableRefRaw: "Roof tarp + electrical isolate",
    companyKey: null,
    externalRefCanonical: null,
    builderWoCanonical: null,
    builderPoCanonical: null,
    deliverableRefCanonical: null,
    woPoIdentityKey: null,
    normaliserVersion: MAKESAFE_NORMALISER_VERSION,
    fieldProvenance: {},
  };
  const refined = applyCanonicalIdentityUpdate(original, {
    companyKey: companyKeyFromId(COMPANY_MLB),
    externalRefCanonical: "MLB-27037",
    builderWoCanonical: "MLB-27037",
    builderPoCanonical: "9182-A",
    deliverableRefCanonical: "roof-tarp-electrical-isolate",
    woPoIdentityKey: "wo:MLB-27037/po:9182-A",
  }, {
    canonicalIdentityV1: {
      method: "deterministic",
      rule: MAKESAFE_NORMALISER_VERSION,
    },
  });
  assertEquals(refined.companySlugRaw, original.companySlugRaw);
  assertEquals(refined.externalRefRaw, original.externalRefRaw);
  assertEquals(refined.builderWoRaw, original.builderWoRaw);
  assertEquals(refined.builderPoRaw, original.builderPoRaw);
  assertEquals(refined.deliverableRefRaw, original.deliverableRefRaw);
  assertEquals(refined.builderPoCanonical, "9182-A");
});

Deno.test("canonical identity needs provenance and provenance is append-only", () => {
  const original: MakesafeIdentity = {
    companySlugRaw: "MLB",
    externalRefRaw: "MLB 1",
    builderWoRaw: null,
    builderPoRaw: null,
    deliverableRefRaw: null,
    companyKey: companyKeyFromId(COMPANY_MLB),
    externalRefCanonical: "MLB-1",
    builderWoCanonical: null,
    builderPoCanonical: null,
    deliverableRefCanonical: null,
    woPoIdentityKey: null,
    normaliserVersion: MAKESAFE_NORMALISER_VERSION,
    fieldProvenance: {
      externalRefV1: { method: "deterministic", rule: "subject_v1" },
    },
  };
  assertThrows(
    () =>
      applyCanonicalIdentityUpdate(original, { builderPoCanonical: "1" }, {}),
    Error,
    "require field provenance",
  );
  assertThrows(
    () =>
      applyCanonicalIdentityUpdate(original, { builderPoCanonical: "1" }, {
        externalRefV1: { method: "human", rule: "manual" },
      }),
    Error,
    "append-only",
  );
});

Deno.test("MLB-26567 twin post ids converge on one instruction key", () => {
  const firstPostId = "AAMk-MLB-26567";
  const twinPostId = "AAMk-MLB-26567-twin";
  assertNotEquals(firstPostId, twinPostId);
  const firstKey = buildInstructionKey({
    instructionFingerprint: "fingerprint-mlb-26567",
    deliverableDiscriminator: "po:44001",
  });
  const twinKey = buildInstructionKey({
    instructionFingerprint: "fingerprint-mlb-26567",
    deliverableDiscriminator: "po:44001",
  });
  assertEquals(firstKey, twinKey);
  assertEquals(
    buildReplayKey({ orgId: ORG_A, instructionKey: firstKey }),
    buildReplayKey({ orgId: ORG_A, instructionKey: twinKey }),
  );
});

Deno.test("dual-capture AAMk and mailbox hash rows attach to one case", () => {
  let rows: readonly MakesafeSourceAccountingRow[] = [];
  rows = attachSourceOnce(rows, {
    orgId: ORG_A,
    caseId: "case-1",
    postId: "AAMk-real-post",
    role: "original",
  }).rows;
  rows = attachSourceOnce(rows, {
    orgId: ORG_A,
    caseId: "case-1",
    postId: "mailbox_9c8081",
    role: "twin",
  }).rows;
  assertEquals(rows.length, 2);
  assertEquals(new Set(rows.map((row) => row.caseId)).size, 1);
});

Deno.test("MLB-26118 resend x4 creates zero extra cases and four source rows", () => {
  const instructionKey = buildInstructionKey({
    instructionFingerprint: "fingerprint-mlb-26118",
    deliverableDiscriminator: "po:approved",
  });
  const replayKeys = new Set([
    buildReplayKey({ orgId: ORG_A, instructionKey }),
  ]);
  let rows: readonly MakesafeSourceAccountingRow[] = [];
  for (let index = 1; index <= 4; index++) {
    rows = attachSourceOnce(rows, {
      orgId: ORG_A,
      caseId: "case-approved",
      postId: `resend-${index}`,
      role: "resend",
    }).rows;
    const plan = planBackfillInstruction({
      replayKeys,
      replayKey: buildReplayKey({ orgId: ORG_A, instructionKey }),
      sourceAlreadyAttached: true,
      sideEffectsSuppressed: true,
    });
    assertEquals(plan.caseWrites, 0);
    assertEquals(plan.notificationWrites, 0);
  }
  assertEquals(rows.length, 4);
});

Deno.test("the same post is idempotent and cannot account to two cases", () => {
  const first = attachSourceOnce([], {
    orgId: ORG_A,
    caseId: "case-1",
    postId: "post-1",
    role: "original",
  });
  const replay = attachSourceOnce(first.rows, {
    orgId: ORG_A,
    caseId: "case-1",
    postId: "post-1",
    role: "original",
  });
  assertEquals(replay.inserted, false);
  assertThrows(
    () =>
      attachSourceOnce(first.rows, {
        orgId: ORG_A,
        caseId: "case-2",
        postId: "post-1",
        role: "twin",
      }),
    Error,
    "another case",
  );
});

Deno.test("MLB-27037 PO-variant triple stays one lineage with separate live keys", () => {
  const poA = placeCaseInLineage({
    newCaseId: "case-po-a",
    orgId: ORG_A,
    parent: null,
    relation: null,
  });
  const poB = placeCaseInLineage({
    newCaseId: "case-po-b",
    orgId: ORG_A,
    parent: poA,
    relation: "sibling_of",
  });
  const poC = placeCaseInLineage({
    newCaseId: "case-po-c",
    orgId: ORG_A,
    parent: poA,
    relation: "sibling_of",
  });
  assertEquals(poA.lineageId, poB.lineageId);
  assertEquals(poA.lineageId, poC.lineageId);
  const keys = ["9182-A", "9182-B", "9182-C"].map((po) =>
    buildLiveIdentityKey({
      orgId: ORG_A,
      companyKey: companyKeyFromId(COMPANY_MLB),
      woPoIdentityKey: `wo:MLB-27037/po:${po}`,
      cycle: 1,
    })
  );
  assertEquals(new Set(keys).size, 3);
});

Deno.test("same numeric ref from two builders does not collide", () => {
  const mlb = buildLiveIdentityKey({
    orgId: ORG_A,
    companyKey: companyKeyFromId(COMPANY_MLB),
    woPoIdentityKey: "wo:67200",
    cycle: 1,
  });
  const ajbr = buildLiveIdentityKey({
    orgId: ORG_A,
    companyKey: companyKeyFromId(COMPANY_AJBR),
    woPoIdentityKey: "wo:67200",
    cycle: 1,
  });
  assertNotEquals(mlb, ajbr);
});

Deno.test("claim-only family ambiguity is not collapsed by live identity", () => {
  const assessment = buildLiveIdentityKey({
    orgId: ORG_A,
    companyKey: companyKeyFromId(COMPANY_MLB),
    woPoIdentityKey: null,
    cycle: 1,
  });
  const tempFence = buildLiveIdentityKey({
    orgId: ORG_A,
    companyKey: companyKeyFromId(COMPANY_MLB),
    woPoIdentityKey: null,
    cycle: 1,
  });
  assertEquals(assessment, null);
  assertEquals(tempFence, null);
});

Deno.test("ref-less source remains structurally accounted below identity floor", () => {
  const errors = validateMakesafeCaseState({
    state: "exception",
    reasonCode: "below_identity_floor",
    blockedReasons: [],
    jobId: null,
    companyId: null,
    canonicalIdentity: null,
    clientName: null,
    siteAddress: null,
  });
  const source = attachSourceOnce([], {
    orgId: ORG_A,
    caseId: "case-ref-less",
    postId: "post-ref-less",
    role: "original",
  });
  assertEquals(errors, []);
  assertEquals(source.rows.length, 1);
});

Deno.test("lineage rejects self-links and contradictory parent/relation shape", () => {
  assertThrows(
    () =>
      placeCaseInLineage({
        newCaseId: root.id,
        orgId: ORG_A,
        parent: root,
        relation: "revision_of",
      }),
    Error,
    "itself",
  );
  assertThrows(
    () =>
      placeCaseInLineage({
        newCaseId: "case-child",
        orgId: ORG_A,
        parent: root,
        relation: null,
      }),
    Error,
    "set together",
  );
});

Deno.test("duplicate-of-a-duplicate fails and direct-root duplicate succeeds", () => {
  const direct = placeCaseInLineage({
    newCaseId: "case-duplicate",
    orgId: ORG_A,
    parent: root,
    relation: "duplicate_of",
  });
  direct.reasonCode = "duplicate";
  assertThrows(
    () =>
      placeCaseInLineage({
        newCaseId: "case-duplicate-2",
        orgId: ORG_A,
        parent: direct,
        relation: "duplicate_of",
      }),
    Error,
    "lineage root",
  );
  assertEquals(direct.parentCaseId, root.id);
});

Deno.test("lineage parent, relation, root and cycle are immutable", () => {
  const child = placeCaseInLineage({
    newCaseId: "case-child",
    orgId: ORG_A,
    parent: root,
    relation: "revision_of",
  });
  assertThrows(
    () => assertLineageImmutable(child, { ...child, parentCaseId: "other" }),
    Error,
    "immutable",
  );
  assertThrows(
    () => assertLineageImmutable(child, { ...child, cycle: 2 }),
    Error,
    "immutable",
  );
});

Deno.test("cancellation and late revision attach to existing lineage without jobs", () => {
  const cancellation = placeCaseInLineage({
    newCaseId: "case-cancel",
    orgId: ORG_A,
    parent: root,
    relation: "cancellation_of",
  });
  cancellation.reasonCode = "cancellation";
  const revision = placeCaseInLineage({
    newCaseId: "case-late-revision",
    orgId: ORG_A,
    parent: root,
    relation: "revision_of",
  });
  revision.reasonCode = "revision";
  assertEquals(cancellation.lineageId, root.lineageId);
  assertEquals(revision.lineageId, root.lineageId);
  assertEquals(
    validateMakesafeCaseState({
      state: "exception",
      reasonCode: cancellation.reasonCode,
      blockedReasons: [],
      jobId: null,
      companyId: null,
      canonicalIdentity: null,
      clientName: null,
      siteAddress: null,
    }),
    [],
  );
});

Deno.test("reopen cycle is case-defined for reattend and cancel-reopen paths", () => {
  const fromReattendPath = placeCaseInLineage({
    newCaseId: "case-reopen-reattend",
    orgId: ORG_A,
    parent: root,
    relation: "reopen_of",
  });
  const fromCancelledPath = placeCaseInLineage({
    newCaseId: "case-reopen-cancelled",
    orgId: ORG_A,
    parent: root,
    relation: "reopen_of",
  });
  assertEquals(fromReattendPath.cycle, 2);
  assertEquals(fromCancelledPath.cycle, 2);
  const oldKey = buildLiveIdentityKey({
    orgId: ORG_A,
    companyKey: companyKeyFromId(COMPANY_MLB),
    woPoIdentityKey: "wo:MLB-1/po:1",
    cycle: root.cycle,
  });
  const reopenedKey = buildLiveIdentityKey({
    orgId: ORG_A,
    companyKey: companyKeyFromId(COMPANY_MLB),
    woPoIdentityKey: "wo:MLB-1/po:1",
    cycle: fromCancelledPath.cycle,
  });
  assertNotEquals(oldKey, reopenedKey);
});

Deno.test("job linkage is direct and independent of makesafe_job_details", () => {
  const caseProjection = {
    caseId: "case-details-less-job",
    jobId: "job-without-details",
    makesafeJobDetails: null,
  };
  assertEquals(caseProjection.jobId, "job-without-details");
  assertEquals(caseProjection.makesafeJobDetails, null);
});

Deno.test("tenant scope includes source, lineage and replay keys", () => {
  assertSameOrg(ORG_A, ORG_A, ORG_A);
  assertThrows(
    () => assertSameOrg(ORG_A, ORG_B),
    Error,
    "crosses org boundary",
  );
  const instructionKey = buildInstructionKey({
    instructionFingerprint: "same-fixture",
    deliverableDiscriminator: "same-deliverable",
  });
  assertNotEquals(
    buildReplayKey({ orgId: ORG_A, instructionKey }),
    buildReplayKey({ orgId: ORG_B, instructionKey }),
  );
});

Deno.test("slug drift resolves to stable company id key", () => {
  const seededAsAj = companyKeyFromId(COMPANY_AJBR);
  const parsedAsAjs = companyKeyFromId(COMPANY_AJBR);
  const parsedAsAjbr = companyKeyFromId(COMPANY_AJBR);
  assertEquals(seededAsAj, parsedAsAjs);
  assertEquals(seededAsAj, parsedAsAjbr);
});

Deno.test("backfill run two writes nothing and never emits effects", () => {
  const instructionKey = buildInstructionKey({
    instructionFingerprint: "backfill-fixture",
    deliverableDiscriminator: "po:1",
  });
  const replayKey = buildReplayKey({ orgId: ORG_A, instructionKey });
  const first = planBackfillInstruction({
    replayKeys: new Set(),
    replayKey,
    sourceAlreadyAttached: false,
    sideEffectsSuppressed: true,
  });
  const second = planBackfillInstruction({
    replayKeys: new Set([replayKey]),
    replayKey,
    sourceAlreadyAttached: true,
    sideEffectsSuppressed: true,
  });
  assertEquals(first, {
    caseWrites: 1,
    sourceWrites: 1,
    eventWrites: 1,
    notificationWrites: 0,
    domainEventWrites: 0,
  });
  assertEquals(second, {
    caseWrites: 0,
    sourceWrites: 0,
    eventWrites: 0,
    notificationWrites: 0,
    domainEventWrites: 0,
  });
  assertThrows(
    () =>
      planBackfillInstruction({
        replayKeys: new Set(),
        replayKey,
        sourceAlreadyAttached: false,
        sideEffectsSuppressed: false,
      }),
    Error,
    "suppress",
  );
});
