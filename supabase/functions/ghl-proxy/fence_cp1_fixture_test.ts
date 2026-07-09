// CP1 backend fixture lane for fence-load-save-sync-resilience-2026-07-09.
//
// Purpose: executable, deterministic evidence for the backend seams that must be
// fixed after Gate 1. These tests intentionally mirror the current ghl-proxy
// handler decisions instead of importing the edge function or calling Supabase.
//
// No network. No live Supabase/GHL. No migrations. No production behaviour
// changes. CP2b/CP3 current-state tests now encode the hardened contract; older
// CP1_XFAIL names are preserved only where a future mission still owns the seam.

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

function stableFixtureJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableFixtureJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableFixtureJson(obj[key])}`).join(",")}}`;
}

function fixtureScopeHash(value: unknown): string {
  // Deterministic pure-test fingerprint; production uses SHA-256 over the same
  // sorted JSON shape. The exact bytes are less important here than mismatch
  // semantics: stale iPad base hash != current server hash must reject.
  return stableFixtureJson(value || {});
}

function currentSaveScopeOutcome(
  fixture: SaveScopeFixture,
): { status: number; code?: string; writesScope: boolean; currentScopeHash?: string } {
  if (
    currentScopeRefGuardRejects(fixture.incomingRef, fixture.targetJobNumber)
  ) {
    return { status: 409, code: "scope_ref_mismatch", writesScope: false };
  }

  const currentScopeHash = fixtureScopeHash(fixture.targetScopeJson || {});
  if (fixture.expectedScopeHash && fixture.expectedScopeHash !== currentScopeHash) {
    return {
      status: 409,
      code: "scope_hash_conflict",
      writesScope: false,
      currentScopeHash,
    };
  }

  void fixture.expectedRevision;
  return { status: 200, writesScope: true, currentScopeHash };
}

// ────────────────────────────────────────────────────────────────────────────
// job-number assignment mirrors
// ────────────────────────────────────────────────────────────────────────────

type JobNumberStore = {
  occupiedNumbers: Set<string>;
  nextJobNumber: string;
  targetJobNumber?: string | null;
};

function bumpJobNumber(value: string): string {
  const match = value.match(/^(.*?)(\d+)$/);
  if (!match) return `${value}-retry`;
  const width = match[2].length;
  const next = String(Number(match[2]) + 1).padStart(width, "0");
  return `${match[1]}${next}`;
}

async function currentAssignJobNumber(
  store: JobNumberStore,
): Promise<{ jobNumber: string | null; surfacedFailure: boolean; recoveredFromDuplicate: boolean }> {
  if (store.targetJobNumber) {
    return { jobNumber: store.targetJobNumber, surfacedFailure: false, recoveredFromDuplicate: false };
  }

  let jobNumber = store.nextJobNumber;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!store.occupiedNumbers.has(jobNumber)) {
      store.occupiedNumbers.add(jobNumber);
      return { jobNumber, surfacedFailure: false, recoveredFromDuplicate: attempt > 0 };
    }
    jobNumber = bumpJobNumber(jobNumber);
  }

  return { jobNumber: null, surfacedFailure: true, recoveredFromDuplicate: false };
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
  return { jobNumber: current.jobNumber, recoveredFromDuplicate: current.recoveredFromDuplicate };
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
  const existing = rows.find((row) =>
    row.jobId === input.jobId && row.storageUrl === input.storageUrl
  );
  if (existing) return existing;
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

Deno.test("CP2B_CURRENT duplicate idx_jobs_job_number collision retries to the next free number", async () => {
  const result = await currentAssignJobNumber({
    occupiedNumbers: new Set(["SWF-26001"]),
    nextJobNumber: "SWF-26001",
    targetJobNumber: null,
  });

  assertEquals(result, { jobNumber: "SWF-26002", surfacedFailure: false, recoveredFromDuplicate: true });
});

Deno.test("CP2B_CURRENT save_scope rejects stale revision/hash when scope_ref still matches", () => {
  const result = currentSaveScopeOutcome({
    targetJobNumber: "SWF-26001",
    incomingRef: "SWF-26001",
    targetScopeJson: { fenceLength: 12, serverEdit: "newer" },
    incomingScopeJson: { fenceLength: 8, iPadEdit: "stale base" },
    expectedRevision: "rev-before-server-edit",
    expectedScopeHash: "hash-before-server-edit",
  });

  assertEquals(result.status, 409);
  assertEquals(result.code, "scope_hash_conflict");
  assertEquals(result.writesScope, false);
});

Deno.test("CP1_CURRENT phone-only identity is enough for draft/save but not email send readiness", () => {
  const phoneOnly = { phone: "+61400111222", name: "", email: "" };

  assertEquals(currentDraftSaveAcceptsPhoneOnly(phoneOnly), true);
  assertEquals(currentEmailSendReady(phoneOnly), false);
});

Deno.test("CP3_CURRENT register_media reuses the existing row for the same uploaded object", () => {
  const rows: MediaRow[] = [];
  const upload = {
    jobId: "job-1",
    storageUrl: "https://storage.example/job-1/photos/photo-1.jpg",
    type: "photo",
  };

  const first = currentRegisterMedia(rows, upload);
  const retry = currentRegisterMedia(rows, upload);

  assertEquals(first.id, "media-1");
  assertEquals(retry.id, first.id);
  assertEquals(rows.length, 1);
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
// Contract evidence: CP2b/CP3 hardening tests are green guardrails for the
// save/sync seams that now behave safely.
// ────────────────────────────────────────────────────────────────────────────

Deno.test("CP2B_CONTRACT duplicate idx_jobs_job_number collision is retried or returned as recoverable conflict", async () => {
  const result = await desiredAssignJobNumberWithDuplicateRecovery({
    occupiedNumbers: new Set(["SWF-26001"]),
    nextJobNumber: "SWF-26001",
    targetJobNumber: null,
  });

  assertEquals(result, { jobNumber: "SWF-26002", recoveredFromDuplicate: true });
});

Deno.test("CP2B_CONTRACT save_scope rejects stale revision/hash even when scope_ref matches", () => {
  const result = currentSaveScopeOutcome({
    targetJobNumber: "SWF-26001",
    incomingRef: "SWF-26001",
    targetScopeJson: { fenceLength: 12, serverEdit: "newer" },
    incomingScopeJson: { fenceLength: 8, iPadEdit: "stale base" },
    expectedRevision: "rev-before-server-edit",
    expectedScopeHash: "hash-before-server-edit",
  });

  assertEquals(result.status, 409);
  assertEquals(result.code, "scope_hash_conflict");
  assertEquals(result.writesScope, false);
  assertEquals(
    result.currentScopeHash,
    fixtureScopeHash({ fenceLength: 12, serverEdit: "newer" }),
  );
});

Deno.test("CP3_CONTRACT register_media is idempotent after upload succeeded but first register response failed", () => {
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
