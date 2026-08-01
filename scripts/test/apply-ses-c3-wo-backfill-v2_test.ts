// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ADJUDICATION_PATH,
  authorizeAttachedDocumentStamp,
  authorizeResumeStamp,
  boardStageDrift,
  boardStageIndex,
  type CardState,
  evaluateEligibility,
  type FixtureRow,
  parseFixture,
  parseMode,
  PROVENANCE_NOTE,
  referenceDigits,
  RUN_LABEL,
  stateMatchesBaseline,
  summariseMeasuredCard,
  verifyLedgerDocumentOutcome,
} from "../apply-ses-c3-wo-backfill-v2.ts";

const fixtureUrl = new URL(
  "../ses-c3-wo-backfill-v2.fixture.txt",
  import.meta.url,
);
const adjudicationUrl = new URL(
  "../ses-c3-wo-backfill-v2.adjudication.json",
  import.meta.url,
);
const dryRunUrl = new URL(
  "../ses-c3-wo-backfill-v2.dry-run.json",
  import.meta.url,
);
const applyLedgerUrl = new URL(
  "../ses-c3-wo-backfill-v2.apply-ledger.json",
  import.meta.url,
);
const beforeUrl = new URL(
  "../ses-c3-wo-backfill-v2.c1-before.json",
  import.meta.url,
);
const afterUrl = new URL(
  "../ses-c3-wo-backfill-v2.c1-after.json",
  import.meta.url,
);
const verifyUrl = new URL(
  "../ses-c3-wo-backfill-v2.verify.json",
  import.meta.url,
);

const fixtureText = Deno.readTextFileSync(fixtureUrl);
const fixtureRows = parseFixture(fixtureText);
type AdjudicationEntry = {
  card: string;
  verdict: string;
  reference: string;
  email_attachment_id?: string;
  file_name?: string;
  sha256?: string;
  pdf_text_md5?: string;

  agreements: string[];
  agreement_count: number;
  contradictions: string[];
  work_order_shaped_content_groups: number;
  content_groups_after_identity_filter: number;
  multi_candidate_discriminator?: string;
  reason?: string;
  detail?: string;
};
const adjudication: {
  run_label: string;
  totals: { cards_adjudicated: number; attach: number; skip: number };
  attach: AdjudicationEntry[];
  skip: AdjudicationEntry[];
} = JSON.parse(Deno.readTextFileSync(adjudicationUrl));

type MeasuredCard = {
  card: string;
  stage: string | null;
  computed_stage: string | null;
  display_overlay_stage: string | null;
  builder_wo_doc_present: boolean;
};
type VerifiedCard = {
  card: string;
  ok: boolean;
  problems: string[];
  work_order_rows: number;
  source_intact: boolean;
};

function row(overrides: Partial<FixtureRow> = {}): FixtureRow {
  return {
    card: "SWMS-1",
    jobId: "job-1",
    reference: "MLB-26369",
    attachmentId: "att-1",
    sha256: "a".repeat(64),
    pdfTextMd5: "b".repeat(32),
    fileName: "work_order.pdf",
    ...overrides,
  };
}

function state(overrides: Partial<CardState> = {}): CardState {
  return {
    card: "SWMS-1",
    job_found: true,
    job_status: "processing",
    job_archived: false,
    job_updated_at: "2026-08-01T00:00:00Z",
    attachment_found: true,
    attachment_status: "uploaded",
    attachment_sha256: "a".repeat(64),
    attachment_name: "work_order.pdf",
    attachment_purged: false,
    attachment_storage_path: "makesafe-intake/x/work_order.pdf",
    source_object_present: true,
    identity_reference_matches: true,
    identity_text_md5: "b".repeat(32),
    work_order_docs: 0,
    work_order_docs_with_url: 0,
    status_applications: 0,
    ...overrides,
  };
}

Deno.test("attach stamping requires version-one creation ownership", () => {
  assertEquals(
    authorizeAttachedDocumentStamp({ documentId: "doc-1" }, {
      document_id: "doc-1",
      version: 1,
    }),
    { authorized: true, documentId: "doc-1" },
  );
  assertEquals(
    authorizeAttachedDocumentStamp({ documentId: "doc-1" }, {
      document_id: "doc-1",
      version: 2,
    }),
    {
      authorized: false,
      reason: "attach_updated_preexisting_document:doc-1:version=2",
    },
  );
  assertEquals(
    authorizeAttachedDocumentStamp({ documentId: "doc-1" }, null),
    { authorized: false, reason: "attach_document_row_missing" },
  );
});

Deno.test("verify keeps pre-existing updates as adjudication failures", () => {
  assertEquals(
    verifyLedgerDocumentOutcome({
      outcome: "skipped",
      reason: "attach_updated_preexisting_document:doc-1:version=2",
      document_id: "doc-1",
      observed_version: 2,
    }),
    "attach_updated_preexisting_document_needs_adjudication:doc-1:version=2",
  );
  assertEquals(verifyLedgerDocumentOutcome({ outcome: "skipped" }), null);
  assertEquals(verifyLedgerDocumentOutcome(null), null);
});

Deno.test("resume stamping only ever re-stamps the exact ledgered row", () => {
  const fixture = row();
  const live = {
    id: "doc-1",
    job_id: "job-1",
    type: "work_order",
    run_label: null as string | null,
    file_name: "work_order.pdf",
    storage_url: "https://example/doc-1.pdf",
  };
  const entry = {
    document_id: "doc-1",
    file_name: "work_order.pdf",
    storage_url: "https://example/doc-1.pdf",
  };
  assertEquals(authorizeResumeStamp(entry, fixture, live), {
    authorized: true,
    documentId: "doc-1",
  });
  assertEquals(authorizeResumeStamp(null, fixture, live), {
    authorized: false,
    reason: "resume_no_prior_ledger_entry",
  });
  assertEquals(authorizeResumeStamp(entry, fixture, null), {
    authorized: false,
    reason: "resume_document_row_missing",
  });
  assertEquals(
    authorizeResumeStamp(entry, fixture, { ...live, job_id: "job-2" }),
    { authorized: false, reason: "resume_document_wrong_job" },
  );
  assertEquals(
    authorizeResumeStamp(entry, fixture, { ...live, type: "general" }),
    { authorized: false, reason: "resume_document_wrong_type" },
  );
  assertEquals(
    authorizeResumeStamp(entry, fixture, { ...live, run_label: "other" }),
    { authorized: false, reason: "resume_document_already_stamped" },
  );
  assertEquals(
    authorizeResumeStamp(entry, fixture, { ...live, file_name: "other.pdf" }),
    { authorized: false, reason: "resume_document_file_name_changed" },
  );
  assertEquals(
    authorizeResumeStamp(entry, fixture, { ...live, storage_url: "https://x" }),
    { authorized: false, reason: "resume_document_storage_url_changed" },
  );
});

Deno.test("eligibility passes only a fully re-proved card", () => {
  assertEquals(evaluateEligibility(row(), state()), {
    eligible: true,
    reason: null,
  });
});

Deno.test("eligibility refuses every drift it is responsible for", () => {
  const cases: [Partial<CardState>, string][] = [
    [{ job_found: false }, "job_missing"],
    [{ attachment_found: false }, "attachment_missing"],
    [{ attachment_purged: true }, "attachment_pii_purged"],
    [{ attachment_status: "pending" }, "attachment_status_pending"],
    [{ attachment_status: null }, "attachment_status_unknown"],
    [{ attachment_sha256: "c".repeat(64) }, "attachment_sha256_drift"],
    [{ attachment_name: "renamed.pdf" }, "attachment_name_drift"],
    [{ source_object_present: false }, "source_object_missing"],
    [{ identity_reference_matches: false }, "identity_reference_mismatch"],
    [{ identity_text_md5: "d".repeat(32) }, "adjudicated_pdf_text_drift"],
    [{ identity_text_md5: null }, "adjudicated_pdf_text_drift"],
    [
      { work_order_docs: 1, work_order_docs_with_url: 1 },
      "work_order_already_present",
    ],
    [{ work_order_docs: 1 }, "work_order_row_exists_without_url"],
  ];
  for (const [override, reason] of cases) {
    assertEquals(
      evaluateEligibility(row(), state(override)),
      { eligible: false, reason },
      `expected ${reason}`,
    );
  }
});

Deno.test("adjudicated text drift is refused even when the bytes still match", () => {
  // The tranche-2 identity claim rests on the document a human READ. A
  // re-extraction that changes the text invalidates that reading, so the write
  // must refuse regardless of the artifact hash still being intact.
  const verdict = evaluateEligibility(
    row(),
    state({ identity_text_md5: "e".repeat(32) }),
  );
  assertEquals(verdict.eligible, false);
  assertEquals(verdict.reason, "adjudicated_pdf_text_drift");
});

Deno.test("baseline comparison names every drifted field", () => {
  assertEquals(stateMatchesBaseline(state(), state()), {
    matches: true,
    drifted: [],
  });
  assertEquals(
    stateMatchesBaseline(
      state(),
      state({ job_status: "complete", work_order_docs: 1 }),
    ),
    { matches: false, drifted: ["job_status", "work_order_docs"] },
  );
  assertEquals(
    stateMatchesBaseline(state(), state({ identity_text_md5: "f".repeat(32) })),
    { matches: false, drifted: ["identity_text_md5"] },
  );
});

Deno.test("reference digits strip every non-digit, including a round suffix", () => {
  assertEquals(referenceDigits("AJBR 67217-R"), "67217");
  assertEquals(referenceDigits("MLB-26369"), "26369");
  assertEquals(referenceDigits("BWCWA6781"), "6781");
  assertEquals(referenceDigits("no-digits"), "");
});

Deno.test("fixture parsing rejects malformed rows", () => {
  assertThrows(
    () => parseFixture("a|b|c|d|e|f"),
    Error,
    "expected 7",
  );
  assertThrows(
    () => parseFixture(`a|b|MLB-1|d|${"a".repeat(63)}|${"b".repeat(32)}|f.pdf`),
    Error,
    "malformed sha256",
  );
  assertThrows(
    () => parseFixture(`a|b|MLB-1|d|${"a".repeat(64)}|${"b".repeat(31)}|f.pdf`),
    Error,
    "malformed pdf_text_md5",
  );
  assertThrows(
    () =>
      parseFixture(`a|b|no-digits|d|${"a".repeat(64)}|${"b".repeat(32)}|f.pdf`),
    Error,
    "reference with no digits",
  );
  assertThrows(
    () =>
      parseFixture(
        `a|b|MLB-1|d|${"a".repeat(64)}|${"b".repeat(32)}|f.pdf\n` +
          `a|b2|MLB-2|d2|${"c".repeat(64)}|${"d".repeat(32)}|g.pdf`,
      ),
    Error,
    "repeats card a",
  );
  assertThrows(
    () =>
      parseFixture(
        `a|b|MLB-1|d|${"a".repeat(64)}|${"b".repeat(32)}|f.pdf\n` +
          `a2|b2|MLB-2|d|${"c".repeat(64)}|${"d".repeat(32)}|g.pdf`,
      ),
    Error,
    "repeats attachment d",
  );
  assertThrows(
    () => parseFixture("# only a comment\n"),
    Error,
    "fixture is empty",
  );
});

Deno.test("mode parsing defaults to the read-only plan", () => {
  assertEquals(parseMode(null), "dry-run");
  assertEquals(parseMode("apply"), "apply");
  assertThrows(() => parseMode("delete"), Error, "--mode must be one of");
});

Deno.test("measure summary reads the shipped board-sweep row shape", () => {
  assertEquals(
    summariseMeasuredCard({
      job_ref: "SWMS-26956",
      stage: "allocated",
      computed_stage: "allocated",
      display_overlay_stage: null,
      reading: { verdict: "undetermined" },
      inventory: { builder_wo_doc: { present: true, detail: "one row" } },
    }),
    {
      card: "SWMS-26956",
      stage: "allocated",
      computed_stage: "allocated",
      display_overlay_stage: null,
      verdict: "undetermined",
      builder_wo_doc_present: true,
      builder_wo_doc_detail: "one row",
    },
  );
  // A card the ruler refused to measure has no reading and no inventory.
  assertEquals(
    summariseMeasuredCard({ job_ref: "SWMS-26450", stage: "archive" }),
    {
      card: "SWMS-26450",
      stage: "archive",
      computed_stage: null,
      display_overlay_stage: null,
      verdict: null,
      builder_wo_doc_present: false,
      builder_wo_doc_detail: null,
    },
  );
});

Deno.test("board stage drift reports only cards present in both sweeps", () => {
  const before = boardStageIndex([
    { job_ref: "A", stage: "archive", computed_stage: "archive" },
    { job_ref: "B", stage: "new", computed_stage: "new" },
    { job_ref: "C", stage: "new", computed_stage: "new" },
  ]);
  const after = boardStageIndex([
    { job_ref: "A", stage: "archive", computed_stage: "archive" },
    { job_ref: "B", stage: "allocated", computed_stage: "new" },
    { job_ref: "D", stage: "new", computed_stage: "new" },
  ]);
  // B moved; C left the board (not this tranche's claim); D is new.
  assertEquals(boardStageDrift(before, after), ["B"]);
  assertEquals(boardStageDrift(before, before), []);
});

Deno.test("the committed fixture is the adjudicated attach set", () => {
  assertEquals(fixtureRows.length, adjudication.attach.length);
  const byCard = new Map(fixtureRows.map((entry) => [entry.card, entry]));
  for (const entry of adjudication.attach) {
    const fixtureRow = byCard.get(entry.card);
    if (!fixtureRow) throw new Error(`${entry.card} missing from the fixture`);
    assertEquals(fixtureRow.attachmentId, entry.email_attachment_id);
    assertEquals(fixtureRow.sha256, entry.sha256);
    assertEquals(fixtureRow.pdfTextMd5, entry.pdf_text_md5);
    assertEquals(fixtureRow.fileName, entry.file_name);
    assertEquals(fixtureRow.reference, entry.reference);
  }
  // No skipped card may leak into the write set.
  for (const entry of adjudication.skip) {
    assertEquals(byCard.has(entry.card), false, `${entry.card} must not write`);
  }
});

Deno.test("every attach verdict carries at least two agreements and no contradiction", () => {
  for (const entry of adjudication.attach) {
    assertEquals(entry.verdict, "attach");
    assertEquals(
      entry.agreement_count >= 2,
      true,
      `${entry.card} has ${entry.agreement_count} agreements`,
    );
    assertEquals(entry.agreements.length, entry.agreement_count);
    assertEquals(new Set(entry.agreements).size, entry.agreements.length);
    assertEquals(entry.contradictions.length, 0, `${entry.card} contradicted`);
  }
});

Deno.test("a claim with several work orders is only written under a named discriminator", () => {
  for (const entry of adjudication.attach) {
    assertEquals(
      entry.content_groups_after_identity_filter <=
        entry.work_order_shaped_content_groups,
      true,
      `${entry.card} filter counts`,
    );
    if (entry.content_groups_after_identity_filter > 1) {
      assertEquals(
        typeof entry.multi_candidate_discriminator,
        "string",
        `${entry.card} needs a discriminator`,
      );
    }
  }
  for (const entry of adjudication.skip) {
    assertEquals(entry.verdict, "skip");
    assertEquals(typeof entry.reason, "string");
    assertEquals(typeof entry.detail, "string");
  }
});

Deno.test("the adjudication totals match its own rows", () => {
  assertEquals(adjudication.totals.attach, adjudication.attach.length);
  assertEquals(adjudication.totals.skip, adjudication.skip.length);
  assertEquals(
    adjudication.totals.cards_adjudicated,
    adjudication.attach.length + adjudication.skip.length,
  );
  assertEquals(adjudication.run_label, RUN_LABEL);
});

Deno.test("committed run evidence agrees with the fixture", () => {
  const dryRun = JSON.parse(Deno.readTextFileSync(dryRunUrl));
  const ledger = JSON.parse(Deno.readTextFileSync(applyLedgerUrl));
  const before = JSON.parse(Deno.readTextFileSync(beforeUrl));
  const after = JSON.parse(Deno.readTextFileSync(afterUrl));
  const verify = JSON.parse(Deno.readTextFileSync(verifyUrl));

  assertEquals(dryRun.run_label, RUN_LABEL);
  assertEquals(dryRun.mode, "dry-run");
  assertEquals(dryRun.adjudication, ADJUDICATION_PATH);
  assertEquals(dryRun.cards.length, fixtureRows.length);
  assertEquals(ledger.applied + ledger.skipped, fixtureRows.length);
  assertEquals(before.cards.length, fixtureRows.length);
  assertEquals(after.cards.length, fixtureRows.length);

  // The tranche's whole point: the work-order cell flips, the stage does not.
  const beforeByCard = new Map<string, MeasuredCard>(
    (before.cards as MeasuredCard[]).map((entry) => [entry.card, entry]),
  );
  for (const entry of after.cards as MeasuredCard[]) {
    const was = beforeByCard.get(entry.card);
    if (!was) throw new Error(`${entry.card} missing from the before measure`);
    assertEquals(was.builder_wo_doc_present, false, `${entry.card} before`);
    assertEquals(entry.builder_wo_doc_present, true, `${entry.card} after`);
    assertEquals(was.stage, entry.stage, `${entry.card} stage`);
    assertEquals(was.computed_stage, entry.computed_stage);
    assertEquals(was.display_overlay_stage, entry.display_overlay_stage);
  }

  assertEquals(verify.ok, true);
  assertEquals(verify.failures, 0);
  assertEquals(verify.board_stage_drift.length, 0);
  assertEquals(verify.cards.length, fixtureRows.length);
  for (const entry of verify.cards as VerifiedCard[]) {
    assertEquals(entry.ok, true, `${entry.card} verify`);
    assertEquals(entry.problems.length, 0);
    assertEquals(entry.work_order_rows, 1);
    assertEquals(entry.source_intact, true);
  }
});

Deno.test("provenance is labelled as tranche two", () => {
  assertEquals(RUN_LABEL, "ses-c3-wo-backfill-tranche2-v1");
  assertStringIncludes(PROVENANCE_NOTE, "tranche 2");
});
