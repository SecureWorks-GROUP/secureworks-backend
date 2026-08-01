// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CardState,
  evaluateEligibility,
  authorizeResumeStamp,
  type FixtureRow,
  parseFixture,
  parseMode,
  PROVENANCE_NOTE,
  RUN_LABEL,
  stateMatchesBaseline,
} from "../apply-ses-c3-wo-backfill-v1.ts";

const fixtureUrl = new URL(
  "../ses-c3-wo-backfill-v1.fixture.txt",
  import.meta.url,
);
const dryRunUrl = new URL(
  "../ses-c3-wo-backfill-v1.dry-run.json",
  import.meta.url,
);
const ledgerUrl = new URL(
  "../ses-c3-wo-backfill-v1.apply-ledger.json",
  import.meta.url,
);
const verifyUrl = new URL(
  "../ses-c3-wo-backfill-v1.verify.json",
  import.meta.url,
);
const beforeUrl = new URL(
  "../ses-c3-wo-backfill-v1.c1-before.json",
  import.meta.url,
);
const afterUrl = new URL(
  "../ses-c3-wo-backfill-v1.c1-after.json",
  import.meta.url,
);

/**
 * The closed tranche-1 card set, restated here independently of the fixture.
 * These are exactly the C2 report's recoverable class A (tier A) cards. The
 * tier B/C cards are deliberately absent: widening this tranche has to be a
 * deliberate edit to BOTH lists, never a silent fixture append.
 */
const TRANCHE_ONE_CARDS = [
  "AJBR 66933",
  "AJBR 67172",
  "AJBR 67178",
  "AJBR 67205",
  "AJBR 67260",
  "SWMS-261079",
  "SWMS-261081",
  "SWMS-261113",
  "SWMS-261114",
  "SWMS-261116",
  "SWMS-26430",
  "SWMS-26671",
  "SWMS-26672",
  "SWMS-26673",
  "SWMS-26678",
  "SWMS-26680",
  "SWMS-26681",
  "SWMS-26682",
  "SWMS-26683",
  "SWMS-26684",
  "SWMS-26686",
  "SWMS-26687",
  "SWMS-26688",
  "SWMS-26689",
  "SWMS-26690",
  "SWMS-26691",
];

/** A card that passes every eligibility leg; individual tests break one leg. */
function eligibleState(overrides: Partial<CardState> = {}): CardState {
  return {
    card: "SWMS-26691",
    job_found: true,
    job_status: "archived",
    job_archived: false,
    job_updated_at: "2026-07-01 00:00:00+00",
    case_bound: true,
    attachment_found: true,
    attachment_status: "uploaded",
    attachment_sha256: "a".repeat(64),
    attachment_name: "Works Order.pdf",
    attachment_purged: false,
    attachment_storage_path: "message-id/hash_Works_Order.pdf",
    source_object_present: true,
    identity_text_matches: true,
    work_order_docs: 0,
    work_order_docs_with_url: 0,
    status_applications: 0,
    ...overrides,
  };
}

const sampleRow: FixtureRow = {
  card: "SWMS-26691",
  jobId: "11111111-1111-1111-1111-111111111111",
  caseId: "22222222-2222-2222-2222-222222222222",
  builderWoCanonical: "AJBR-67155",
  attachmentId: "33333333-3333-3333-3333-333333333333",
  sha256: "a".repeat(64),
  fileName: "Works Order.pdf",
};

/** Committed evidence files are read as loose records and asserted key by key. */
type EvidenceDoc = Record<string, JsonValue>;
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// deno-lint-ignore no-explicit-any -- evidence rows are asserted field by field
type EvidenceRow = Record<string, any>;

async function readJson(url: URL): Promise<EvidenceDoc> {
  return JSON.parse(await Deno.readTextFile(url));
}

function rows(doc: EvidenceDoc): EvidenceRow[] {
  return doc.cards as unknown as EvidenceRow[];
}

Deno.test("fixture is exactly the closed tier-A tranche", async () => {
  const rows = parseFixture(await Deno.readTextFile(fixtureUrl));
  assertEquals(rows.length, 26);
  assertEquals(
    rows.map((row) => row.card).sort(),
    [...TRANCHE_ONE_CARDS].sort(),
  );
  assertEquals(new Set(rows.map((row) => row.attachmentId)).size, 26);
  assertEquals(new Set(rows.map((row) => row.jobId)).size, 26);
  for (const row of rows) {
    assertEquals(/^[0-9a-f]{64}$/.test(row.sha256), true, row.card);
    assertEquals(row.fileName.toLowerCase().endsWith(".pdf"), true, row.card);
  }
});

Deno.test("fixture parsing rejects malformed and duplicated lines", () => {
  const good =
    "SWMS-1|11111111-1111-1111-1111-111111111111|22222222-2222-2222-2222-222222222222|AJBR-1|33333333-3333-3333-3333-333333333333|" +
    "a".repeat(64) + "|Works Order.pdf";
  assertEquals(parseFixture(`# comment\n\n${good}\n`).length, 1);
  assertThrows(
    () => parseFixture(`${good}|extra`),
    Error,
    "expected 7",
  );
  assertThrows(() => parseFixture(`${good}\n${good}`), Error, "repeats card");
  assertThrows(
    () => parseFixture(`${good}\n${good.replace("SWMS-1", "SWMS-2")}`),
    Error,
    "repeats attachment",
  );
  assertThrows(
    () => parseFixture(good.replace("a".repeat(64), "not-a-hash")),
    Error,
    "malformed sha256",
  );
  assertThrows(
    () => parseFixture("# only a comment\n"),
    Error,
    "fixture is empty",
  );
});

Deno.test("eligibility requires every leg of the tier-A claim", () => {
  assertEquals(evaluateEligibility(sampleRow, eligibleState()), {
    eligible: true,
    reason: null,
  });
  const cases: [Partial<CardState>, string][] = [
    [{ job_found: false }, "job_missing"],
    [{ case_bound: false }, "attachment_not_bound_to_card_case"],
    [{ attachment_found: false }, "attachment_missing"],
    [{ attachment_purged: true }, "attachment_pii_purged"],
    [{ attachment_status: "pending" }, "attachment_status_pending"],
    [{ attachment_sha256: "b".repeat(64) }, "attachment_sha256_drift"],
    [{ attachment_name: "Other.pdf" }, "attachment_name_drift"],
    [{ source_object_present: false }, "source_object_missing"],
    [{ identity_text_matches: false }, "identity_text_mismatch"],
    [
      { work_order_docs: 1, work_order_docs_with_url: 1 },
      "work_order_already_present",
    ],
    [{ work_order_docs: 1 }, "work_order_row_exists_without_url"],
  ];
  for (const [override, reason] of cases) {
    const verdict = evaluateEligibility(sampleRow, eligibleState(override));
    assertEquals(verdict.eligible, false, reason);
    assertEquals(verdict.reason, reason);
  }
});

Deno.test("a card whose state moved since the dry run is skipped, not forced", () => {
  const baseline = eligibleState();
  assertEquals(stateMatchesBaseline(baseline, eligibleState()).matches, true);
  const drifted = stateMatchesBaseline(
    baseline,
    eligibleState({ job_status: "complete", work_order_docs: 1 }),
  );
  assertEquals(drifted.matches, false);
  assertEquals(drifted.drifted.sort(), ["job_status", "work_order_docs"]);
});

Deno.test("resume stamping requires the ledger-identified exact document", () => {
  const entry = {
    card: sampleRow.card,
    document_id: "44444444-4444-4444-4444-444444444444",
    file_name: sampleRow.fileName,
    storage_url: "https://example.test/job-documents/doc.pdf",
  };
  const live = {
    id: entry.document_id,
    job_id: sampleRow.jobId,
    type: "work_order",
    run_label: null,
    file_name: entry.file_name,
    storage_url: entry.storage_url,
  };
  assertEquals(authorizeResumeStamp(entry, sampleRow, live), {
    authorized: true,
    documentId: entry.document_id,
  });
  assertEquals(
    authorizeResumeStamp(entry, sampleRow, { ...live, file_name: "Other.pdf" }),
    { authorized: false, reason: "resume_document_file_name_changed" },
  );
  assertEquals(
    authorizeResumeStamp(entry, sampleRow, { ...live, storage_url: "other" }),
    { authorized: false, reason: "resume_document_storage_url_changed" },
  );
  assertEquals(
    authorizeResumeStamp(null, sampleRow, live),
    { authorized: false, reason: "resume_no_prior_ledger_entry" },
  );
  assertEquals(
    authorizeResumeStamp(entry, sampleRow, { ...live, run_label: RUN_LABEL }),
    { authorized: false, reason: "resume_document_already_stamped" },
  );
  assertEquals(
    authorizeResumeStamp(entry, sampleRow, { ...live, job_id: "55555555-5555-5555-5555-555555555555" }),
    { authorized: false, reason: "resume_document_wrong_job" },
  );
  assertEquals(
    authorizeResumeStamp(entry, sampleRow, { ...live, id: "66666666-6666-6666-6666-666666666666" }),
    { authorized: false, reason: "resume_document_id_mismatch" },
  );
  assertEquals(
    authorizeResumeStamp(entry, sampleRow, null),
    { authorized: false, reason: "resume_document_row_missing" },
  );
  assertEquals(
    authorizeResumeStamp(entry, sampleRow, { ...live, type: "photo" }),
    { authorized: false, reason: "resume_document_wrong_type" },
  );
});

Deno.test("mode parsing defaults to dry-run and refuses anything unknown", () => {
  assertEquals(parseMode(null), "dry-run");
  assertEquals(parseMode("apply"), "apply");
  assertEquals(parseMode("measure"), "measure");
  assertEquals(parseMode("verify"), "verify");
  assertThrows(() => parseMode("delete"), Error, "--mode must be one of");
});

Deno.test("committed dry run planned exactly the fixture, all eligible", async () => {
  const fixtureRows = parseFixture(await Deno.readTextFile(fixtureUrl));
  const dryRun = await readJson(dryRunUrl);
  assertEquals(dryRun.run_label, RUN_LABEL);
  assertEquals(rows(dryRun).length, fixtureRows.length);
  assertEquals(dryRun.eligible, 26);
  assertEquals(dryRun.skipped, 0);
  for (const card of rows(dryRun)) {
    assertEquals(card.planned_row.type, "work_order");
    assertEquals(card.planned_row.run_label, RUN_LABEL);
    assertEquals(card.planned_row.provenance_note, PROVENANCE_NOTE);
    assertEquals(card.before.work_order_docs, 0);
    assertEquals(card.before.work_order_docs_with_url, 0);
    assertEquals(card.before.case_bound, true);
    assertEquals(card.before.identity_text_matches, true);
    assertStringIncludes(card.source.disposition, "never moved or deleted");
  }
});

Deno.test("committed apply ledger records 26 applied work orders and nothing else", async () => {
  const ledger = await readJson(ledgerUrl);
  assertEquals(ledger.run_label, RUN_LABEL);
  assertEquals(ledger.applied, 26);
  assertEquals(ledger.skipped, 0);
  assertEquals(rows(ledger).length, 26);
  for (const card of rows(ledger)) {
    assertEquals(card.outcome, "applied");
    assertEquals(card.provenance_stamped, true);
    assertEquals(typeof card.document_id, "string");
    // The job row itself must be untouched by the attach.
    assertEquals(card.before.job_status, card.after.job_status);
    assertEquals(card.before.job_updated_at, card.after.job_updated_at);
    assertEquals(
      card.before.status_applications,
      card.after.status_applications,
    );
    // The source artifact stays exactly where it was.
    assertEquals(
      card.before.attachment_storage_path,
      card.after.attachment_storage_path,
    );
    assertEquals(card.after.source_object_present, true);
    // Before/after of the thing this tranche exists to change.
    assertEquals(card.before.work_order_docs_with_url, 0);
    assertEquals(card.after.work_order_docs_with_url, 1);
  }
});

Deno.test("committed verification proves WO present and board stage unchanged", async () => {
  const verify = await readJson(verifyUrl);
  assertEquals(verify.ok, true);
  assertEquals(verify.failures, 0);
  assertEquals(rows(verify).length, 26);
  assertEquals(verify.published_byte_check, true);
  for (const card of rows(verify)) {
    assertEquals(card.problems, []);
    assertEquals(card.outcome, "applied");
    assertEquals(card.work_order_rows, 1);
    assertEquals(card.builder_wo_doc_before, false);
    assertEquals(card.builder_wo_doc_after, true);
    assertEquals(card.stage_before, card.stage_after);
    assertEquals(card.source_intact, true);
    assertEquals(card.published_sha256_matches_source, true);
  }
});

Deno.test("C1 measurements bracket the apply and move only builder_wo_doc", async () => {
  const before = await readJson(beforeUrl);
  const after = await readJson(afterUrl);
  assertEquals(rows(before).length, 26);
  assertEquals(rows(after).length, 26);
  const afterByCard = new Map<string, EvidenceRow>(
    rows(after).map((card) => [String(card.card), card]),
  );
  for (const card of rows(before)) {
    const post = afterByCard.get(String(card.card));
    if (!post) throw new Error(`${card.card} missing from the after measure`);
    assertEquals(card.builder_wo_doc_present, false, card.card);
    assertEquals(post.builder_wo_doc_present, true, card.card);
    assertEquals(card.stage, post.stage, card.card);
    assertEquals(card.computed_stage, post.computed_stage, card.card);
    assertEquals(
      card.display_overlay_stage,
      post.display_overlay_stage,
      card.card,
    );
  }
});
