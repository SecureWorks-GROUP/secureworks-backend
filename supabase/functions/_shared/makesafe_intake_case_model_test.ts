// deno-lint-ignore-file no-import-prefix

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyCanonicalIdentityUpdate,
  assertSameOrg,
  buildReplayKey,
  buildSourceInstructionKey,
  canonicalSiblingEdge,
  isMakesafeCaseTransitionAllowed,
  type MakesafeIdentity,
  type MakesafeLineageEdge,
  validateLineageEdge,
  validateMakesafeCaseState,
} from "./makesafe_intake_case_model.ts";

const ORG_A = "00000000-0000-0000-0000-000000000001";
const ORG_B = "00000000-0000-0000-0000-000000000002";

Deno.test("state machine allows review resolution and block clearing", () => {
  assert(isMakesafeCaseTransitionAllowed("exception", "blocked_live_job"));
  assert(isMakesafeCaseTransitionAllowed("exception", "confirmed_live_job"));
  assert(
    isMakesafeCaseTransitionAllowed("blocked_live_job", "confirmed_live_job"),
  );
  assert(isMakesafeCaseTransitionAllowed("accounted_non_wo", "exception"));
});

Deno.test("state machine rejects history-destroying shortcuts", () => {
  assertEquals(
    isMakesafeCaseTransitionAllowed("confirmed_live_job", "accounted_non_wo"),
    false,
  );
  assertEquals(
    isMakesafeCaseTransitionAllowed("confirmed_live_job", "exception"),
    false,
  );
  assertEquals(
    isMakesafeCaseTransitionAllowed("accounted_non_wo", "confirmed_live_job"),
    false,
  );
});

Deno.test("all four case states validate only with their required shape", () => {
  const jobId = "job-a";
  assertEquals(
    validateMakesafeCaseState({
      currentState: "confirmed_live_job",
      resultJobId: jobId,
      relatedJobId: null,
      blockingReasons: [],
      exceptionReasonCode: null,
      accountedNonWoReason: null,
    }),
    [],
  );
  assertEquals(
    validateMakesafeCaseState({
      currentState: "blocked_live_job",
      resultJobId: jobId,
      relatedJobId: null,
      blockingReasons: ["missing:client_phone"],
      exceptionReasonCode: null,
      accountedNonWoReason: null,
    }),
    [],
  );
  assertEquals(
    validateMakesafeCaseState({
      currentState: "exception",
      resultJobId: null,
      relatedJobId: jobId,
      blockingReasons: [],
      exceptionReasonCode: "cancellation",
      accountedNonWoReason: null,
    }),
    [],
  );
  assertEquals(
    validateMakesafeCaseState({
      currentState: "accounted_non_wo",
      resultJobId: null,
      relatedJobId: null,
      blockingReasons: [],
      exceptionReasonCode: null,
      accountedNonWoReason: "crew report, not a new instruction",
    }),
    [],
  );
});

Deno.test("invalid state shapes name missing reasons and job contradictions", () => {
  assert(
    validateMakesafeCaseState({
      currentState: "blocked_live_job",
      resultJobId: "job-a",
      relatedJobId: null,
      blockingReasons: [],
      exceptionReasonCode: null,
      accountedNonWoReason: null,
    }).includes("blocked_live_job requires named blockingReasons"),
  );
  assert(
    validateMakesafeCaseState({
      currentState: "exception",
      resultJobId: "job-a",
      relatedJobId: null,
      blockingReasons: [],
      exceptionReasonCode: null,
      accountedNonWoReason: null,
    }).length >= 2,
  );
});

Deno.test("raw identity survives canonical refinement verbatim", () => {
  const original: MakesafeIdentity = {
    rawBuilderName: "  MASTER BUILDERS - Perth ",
    rawExternalRef: "MLB 27037 / Rev A",
    rawPoNumber: " PO-9182-A ",
    rawDeliverableRef: "Roof tarp + electrical isolate",
    canonicalBuilderSlug: null,
    canonicalExternalRef: null,
    canonicalPoNumber: null,
    canonicalDeliverableRef: null,
    identityProvenance: {},
  };
  const refined = applyCanonicalIdentityUpdate(original, {
    canonicalBuilderSlug: "mlb",
    canonicalExternalRef: "MLB-27037",
    canonicalPoNumber: "9182-A",
    canonicalDeliverableRef: "roof-tarp-electrical-isolate",
  }, {
    canonicalExternalRef: {
      method: "deterministic",
      rule: "mlb_subject_v1",
    },
  });

  assertEquals(refined.rawBuilderName, original.rawBuilderName);
  assertEquals(refined.rawExternalRef, original.rawExternalRef);
  assertEquals(refined.rawPoNumber, original.rawPoNumber);
  assertEquals(refined.rawDeliverableRef, original.rawDeliverableRef);
  assertEquals(refined.canonicalExternalRef, "MLB-27037");
});

Deno.test("canonical identity cannot change without provenance", () => {
  const original: MakesafeIdentity = {
    rawBuilderName: "MLB",
    rawExternalRef: "MLB 1",
    rawPoNumber: null,
    rawDeliverableRef: null,
    canonicalBuilderSlug: null,
    canonicalExternalRef: null,
    canonicalPoNumber: null,
    canonicalDeliverableRef: null,
    identityProvenance: {},
  };
  assertThrows(
    () =>
      applyCanonicalIdentityUpdate(
        original,
        { canonicalExternalRef: "MLB-1" },
        {},
      ),
    Error,
    "field provenance",
  );
});

Deno.test("identity provenance cannot overwrite an earlier observation", () => {
  const original: MakesafeIdentity = {
    rawBuilderName: "MLB",
    rawExternalRef: "MLB 1",
    rawPoNumber: null,
    rawDeliverableRef: null,
    canonicalBuilderSlug: "mlb",
    canonicalExternalRef: "MLB-1",
    canonicalPoNumber: null,
    canonicalDeliverableRef: null,
    identityProvenance: {
      canonicalExternalRefV1: {
        method: "deterministic",
        rule: "mlb_subject_v1",
      },
    },
  };
  assertThrows(
    () =>
      applyCanonicalIdentityUpdate(
        original,
        { canonicalExternalRef: "MLB-2" },
        {
          canonicalExternalRefV1: {
            method: "human",
            rule: "manual_correction",
          },
        },
      ),
    Error,
    "append-only",
  );
});

Deno.test("replay key is stable for the same source instruction", () => {
  const instructionKey = buildSourceInstructionKey({
    sourceMessageId: "graph-post-123",
    deliverableDiscriminator: "po:9182-A",
  });
  const first = buildReplayKey({
    orgId: ORG_A,
    sourceSystem: "microsoft_graph",
    sourceMailbox: "ses@secureworksgroup.com.au",
    sourceInstructionKey: instructionKey,
  });
  const replay = buildReplayKey({
    orgId: ORG_A,
    sourceSystem: "microsoft_graph",
    sourceMailbox: "ses@secureworksgroup.com.au",
    sourceInstructionKey: buildSourceInstructionKey({
      sourceMessageId: "graph-post-123",
      deliverableDiscriminator: "po:9182-A",
    }),
  });
  assertEquals(replay, first);
});

Deno.test("twin posts and re-sends remain separate cases for lineage", () => {
  const original = buildSourceInstructionKey({
    sourceMessageId: "graph-post-original",
  });
  const twin = buildSourceInstructionKey({
    sourceMessageId: "graph-post-twin",
  });
  const resend = buildSourceInstructionKey({
    sourceMessageId: "graph-post-resend",
  });
  assertNotEquals(original, twin);
  assertNotEquals(original, resend);
});

Deno.test("separate deliverables in one message never collapse", () => {
  const tarp = buildSourceInstructionKey({
    sourceMessageId: "graph-post-123",
    deliverableDiscriminator: "po:9182-A/tarp",
  });
  const electrical = buildSourceInstructionKey({
    sourceMessageId: "graph-post-123",
    deliverableDiscriminator: "po:9182-B/electrical",
  });
  assertNotEquals(tarp, electrical);
});

Deno.test("tenant helper rejects cross-org job, draft or lineage links", () => {
  assertSameOrg(ORG_A, ORG_A, ORG_A);
  assertThrows(
    () => assertSameOrg(ORG_A, ORG_A, ORG_B),
    Error,
    "crosses org boundary",
  );
});

Deno.test("lineage rejects self-links and a second duplicate parent", () => {
  const existing: MakesafeLineageEdge[] = [{
    orgId: ORG_A,
    fromCaseId: "case-duplicate",
    relationType: "duplicate_of",
    toCaseId: "case-original",
  }];
  assert(
    validateLineageEdge(existing, {
      orgId: ORG_A,
      fromCaseId: "case-duplicate",
      relationType: "duplicate_of",
      toCaseId: "case-other-parent",
    }).includes("duplicate case already has a canonical parent"),
  );
  assert(
    validateLineageEdge([], {
      orgId: ORG_A,
      fromCaseId: "case-a",
      relationType: "revision_of",
      toCaseId: "case-a",
    }).includes("lineage cannot link a case to itself"),
  );
});

Deno.test("hierarchical lineage rejects cycles across relation types", () => {
  const existing: MakesafeLineageEdge[] = [
    {
      orgId: ORG_A,
      fromCaseId: "case-b",
      relationType: "revision_of",
      toCaseId: "case-a",
    },
    {
      orgId: ORG_A,
      fromCaseId: "case-c",
      relationType: "reopen_of",
      toCaseId: "case-b",
    },
  ];
  const errors = validateLineageEdge(existing, {
    orgId: ORG_A,
    fromCaseId: "case-a",
    relationType: "cancellation_of",
    toCaseId: "case-c",
  });
  assert(errors.includes("lineage edge would create a cycle"));
});

Deno.test("sibling lineage is canonical and unique by direction", () => {
  const sibling = canonicalSiblingEdge(ORG_A, "case-z", "case-a");
  assertEquals(sibling.fromCaseId, "case-a");
  assertEquals(sibling.toCaseId, "case-z");
  assertEquals(validateLineageEdge([], sibling), []);
  assert(
    validateLineageEdge([sibling], sibling).includes(
      "lineage edge already exists",
    ),
  );
});
