// CP1 backend fixture lane for fence-load-save-sync-resilience-2026-07-09.
//
// Purpose: executable, deterministic evidence for the backend seams that must be
// fixed after Gate 1. These tests intentionally mirror the current ghl-proxy
// handler decisions instead of importing the edge function or calling Supabase.
//
// No network. No live Supabase/GHL. No migrations. No production behaviour
// changes. Some tests are current-state evidence; tests marked CP1_XFAIL encode
// the desired post-CP1 contract and are expected to fail on the current backend.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ────────────────────────────────────────────────────────────────────────────
// save_scope mirrors
// ────────────────────────────────────────────────────────────────────────────

function normalizeIdentity(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isRealJobRef(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^SW[PF]?-?\d/i.test(value.trim());
}

function currentScopeRefGuardRejects(
  incomingRef: unknown,
  targetJobNumber: unknown,
): boolean {
  return (
    isRealJobRef(incomingRef) &&
    isRealJobRef(targetJobNumber) &&
    normalizeIdentity(incomingRef) !== normalizeIdentity(targetJobNumber)
  );
}

type SaveScopeFixture = {
  targetJobNumber?: string | null;
  targetScopeJson?: Record<string, unknown> | null;
  incomingRef?: string | null;
  incomingScopeJson?: Record<string, unknown> | null;
  expectedRevision?: string | null;
  expectedScopeHash?: string | null;
};

function currentSaveScopeOutcome(
  fixture: SaveScopeFixture,
): { status: number; code?: string; writesScope: boolean } {
  if (
    currentScopeRefGuardRejects(fixture.incomingRef, fixture.targetJobNumber)
  ) {
    return { status: 409, code: "scope_ref_mismatch", writesScope: false };
  }

  // Current handler snapshots previous scope size for audit only, then writes
  // scope_json with no baseServerRevision/baseScopeHash precondition.
  void fixture.targetScopeJson;
  void fixture.expectedRevision;
  void fixture.expectedScopeHash;
  return { status: 200, writesScope: true };
}

// ────────────────────────────────────────────────────────────────────────────
// job-number assignment mirrors
// ────────────────────────────────────────────────────────────────────────────

type JobNumberStore = {
  occupiedNumbers: Set<string>;
  nextJobNumber: string;
  targetJobNumber?: string | null;
};

async function currentAssignJobNumber(
  store: JobNumberStore,
): Promise<{ jobNumber: string | null; surfacedFailure: boolean }> {
  if (store.targetJobNumber) {
    return { jobNumber: store.targetJobNumber, surfacedFailure: false };
  }

  const jobNumber = store.nextJobNumber;
  try {
    if (store.occupiedNumbers.has(jobNumber)) {
      throw new Error(
        'duplicate key value violates unique constraint "idx_jobs_job_number"',
      );
    }
    store.occupiedNumbers.add(jobNumber);
    return { jobNumber, surfacedFailure: false };
  } catch {
    // Mirrors the sign-off/link path around next_job_number: the duplicate is
    // logged inside a catch and not returned as a typed recoverable conflict.
    return { jobNumber: null, surfacedFailure: false };
  }
}

async function desiredAssignJobNumberWithDuplicateRecovery(
  store: JobNumberStore,
): Promise<{ jobNumber: string; recoveredFromDuplicate: boolean }> {
  const current = await currentAssignJobNumber(store);
  if (!current.jobNumber) {
    throw new Error(
      "expected duplicate job-number collision to be retried or surfaced as recoverable conflict",
    );
  }
  return { jobNumber: current.jobNumber, recoveredFromDuplicate: false };
}

// ────────────────────────────────────────────────────────────────────────────
// phone-only identity mirrors
// ────────────────────────────────────────────────────────────────────────────

type DraftIdentity = {
  phone?: string | null;
  name?: string | null;
  email?: string | null;
};

function currentDraftSaveAcceptsPhoneOnly(identity: DraftIdentity): boolean {
  // Backend save_scope only conditionally copies meta fields. It does not require
  // name/email to save a draft scope when phone exists.
  return Boolean(identity.phone);
}

function currentEmailSendReady(identity: DraftIdentity): boolean {
  return Boolean(identity.email);
}

// ────────────────────────────────────────────────────────────────────────────
// media register mirrors
// ────────────────────────────────────────────────────────────────────────────

type MediaRow = {
  id: string;
  jobId: string;
  storageUrl: string;
  type: string;
  label: string;
};

function currentRegisterMedia(
  rows: MediaRow[],
  input: { jobId?: string; storageUrl?: string; type?: string; label?: string },
): MediaRow {
  if (!input.jobId || !input.storageUrl) {
    throw new Error("jobId and storageUrl required");
  }
  const row = {
    id: `media-${rows.length + 1}`,
    jobId: input.jobId,
    storageUrl: input.storageUrl,
    type: input.type || "photo",
    label: input.label || "",
  };
  rows.push(row);
  return row;
}

// ────────────────────────────────────────────────────────────────────────────
// prepare_quote/send idempotency boundary mirrors
// ────────────────────────────────────────────────────────────────────────────

type QuoteDoc = {
  id: string;
  jobId: string;
  sentToClient: boolean;
  supersededAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  runLabel: string | null;
  jobContactId: string | null;
};

function currentPrepareQuoteDoc(docs: QuoteDoc[], jobId: string): QuoteDoc {
  const reusable = docs.find((doc) =>
    doc.jobId === jobId &&
    !doc.sentToClient &&
    doc.supersededAt === null &&
    doc.acceptedAt === null &&
    doc.declinedAt === null &&
    doc.runLabel === null &&
    doc.jobContactId === null
  );
  if (reusable) return reusable;

  const doc: QuoteDoc = {
    id: `doc-${docs.length + 1}`,
    jobId,
    sentToClient: false,
    supersededAt: null,
    acceptedAt: null,
    declinedAt: null,
    runLabel: null,
    jobContactId: null,
  };
  docs.push(doc);
  return doc;
}

function currentSendClaim(doc: QuoteDoc): { claimed: boolean } {
  if (doc.sentToClient) return { claimed: false };
  doc.sentToClient = true;
  return { claimed: true };
}

// ────────────────────────────────────────────────────────────────────────────
// Current-state evidence: these pass today and document the pre-fix seams.
// ────────────────────────────────────────────────────────────────────────────

Deno.test("CP1_CURRENT duplicate idx_jobs_job_number collision is swallowed instead of typed/retried", async () => {
  const result = await currentAssignJobNumber({
    occupiedNumbers: new Set(["SWF-26001"]),
    nextJobNumber: "SWF-26001",
    targetJobNumber: null,
  });

  assertEquals(result, { jobNumber: null, surfacedFailure: false });
});

Deno.test("CP1_CURRENT save_scope accepts stale revision/hash when scope_ref still matches", () => {
  const result = currentSaveScopeOutcome({
    targetJobNumber: "SWF-26001",
    incomingRef: "SWF-26001",
    targetScopeJson: { fenceLength: 12, serverEdit: "newer" },
    incomingScopeJson: { fenceLength: 8, iPadEdit: "stale base" },
    expectedRevision: "rev-before-server-edit",
    expectedScopeHash: "hash-before-server-edit",
  });

  assertEquals(result, { status: 200, writesScope: true });
});

Deno.test("CP1_CURRENT phone-only identity is enough for draft/save but not email send readiness", () => {
  const phoneOnly = { phone: "+61400111222", name: "", email: "" };

  assertEquals(currentDraftSaveAcceptsPhoneOnly(phoneOnly), true);
  assertEquals(currentEmailSendReady(phoneOnly), false);
});

Deno.test("CP1_CURRENT register_media inserts duplicate rows for the same uploaded object", () => {
  const rows: MediaRow[] = [];
  const upload = {
    jobId: "job-1",
    storageUrl: "https://storage.example/job-1/photos/photo-1.jpg",
    type: "photo",
  };

  const first = currentRegisterMedia(rows, upload);
  const retry = currentRegisterMedia(rows, upload);

  assertEquals(first.id, "media-1");
  assertEquals(retry.id, "media-2");
  assertEquals(rows.length, 2);
});

Deno.test("CP1_CURRENT prepare_quote reuses live unsent draft and send claim remains one-shot", () => {
  const docs: QuoteDoc[] = [];

  const firstPrepare = currentPrepareQuoteDoc(docs, "job-1");
  const retryPrepare = currentPrepareQuoteDoc(docs, "job-1");
  const firstSend = currentSendClaim(firstPrepare);
  const retrySend = currentSendClaim(firstPrepare);
  const afterSentPrepare = currentPrepareQuoteDoc(docs, "job-1");

  assertEquals(retryPrepare.id, firstPrepare.id);
  assertEquals(firstSend, { claimed: true });
  assertEquals(retrySend, { claimed: false });
  assertEquals(afterSentPrepare.id, "doc-2");
});

// ────────────────────────────────────────────────────────────────────────────
// Expected-fix evidence: CP1_XFAIL tests are intentionally RED on current behaviour.
// CP1_CONTRACT tests are green guardrails for seams that already behave safely.
// Run red evidence with: deno test --allow-env supabase/functions/ghl-proxy/fence_cp1_fixture_test.ts --filter CP1_XFAIL
// ────────────────────────────────────────────────────────────────────────────

Deno.test("CP1_XFAIL duplicate idx_jobs_job_number collision is retried or returned as recoverable conflict", async () => {
  const result = await desiredAssignJobNumberWithDuplicateRecovery({
    occupiedNumbers: new Set(["SWF-26001"]),
    nextJobNumber: "SWF-26001",
    targetJobNumber: null,
  });

  assertEquals(result.recoveredFromDuplicate, true);
});

Deno.test("CP1_XFAIL save_scope rejects stale revision/hash even when scope_ref matches", () => {
  const result = currentSaveScopeOutcome({
    targetJobNumber: "SWF-26001",
    incomingRef: "SWF-26001",
    targetScopeJson: { fenceLength: 12, serverEdit: "newer" },
    incomingScopeJson: { fenceLength: 8, iPadEdit: "stale base" },
    expectedRevision: "rev-before-server-edit",
    expectedScopeHash: "hash-before-server-edit",
  });

  assertEquals(result, {
    status: 409,
    code: "scope_hash_conflict",
    writesScope: false,
  });
});

Deno.test("CP1_XFAIL register_media is idempotent after upload succeeded but first register response failed", () => {
  const rows: MediaRow[] = [];
  const upload = {
    jobId: "job-1",
    storageUrl: "https://storage.example/job-1/photos/photo-1.jpg",
    type: "photo",
  };

  const first = currentRegisterMedia(rows, upload);
  const retry = currentRegisterMedia(rows, upload);

  assertEquals(retry.id, first.id);
  assertEquals(rows.length, 1);
});

Deno.test("CP1_CONTRACT email quote send requires email only at send boundary, not draft/save boundary", () => {
  const phoneOnly = { phone: "+61400111222", name: "", email: "" };
  const withEmail = { ...phoneOnly, email: "client@example.com" };

  assertEquals(currentDraftSaveAcceptsPhoneOnly(phoneOnly), true);
  assertEquals(currentEmailSendReady(phoneOnly), false);
  assertEquals(currentEmailSendReady(withEmail), true);
});

Deno.test("CP1_CONTRACT one-shot release preserves prepare_quote reuse and send one-shot claim boundaries", () => {
  const docs: QuoteDoc[] = [];
  const firstPrepare = currentPrepareQuoteDoc(docs, "job-1");
  const retryPrepare = currentPrepareQuoteDoc(docs, "job-1");
  const firstSend = currentSendClaim(firstPrepare);
  const retrySend = currentSendClaim(firstPrepare);

  assertEquals(retryPrepare.id, firstPrepare.id);
  assertEquals(firstSend, { claimed: true });
  assertEquals(retrySend, { claimed: false });
});
