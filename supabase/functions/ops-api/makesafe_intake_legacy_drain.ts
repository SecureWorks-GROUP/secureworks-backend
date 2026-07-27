// deno-lint-ignore-file no-explicit-any

import {
  type DeterministicRuntimeOptions,
  runDeterministicIntake,
} from "./makesafe_deterministic_intake_runtime.ts";
import { persistIntakeSourceIssue } from "./makesafe_intake_source_issues.ts";

const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SES_MAILBOX = "ses@secureworkswa.com.au";
const PAGE_SIZE = 500;

export interface LegacyDraftDrainOptions {
  maxDrafts?: number;
  approveDraft?: DeterministicRuntimeOptions["approveDraft"];
  applyBuilderCancellation?: DeterministicRuntimeOptions[
    "applyBuilderCancellation"
  ];
  runIntake?: typeof runDeterministicIntake;
}

export interface LegacyDraftDrainReport {
  selected: number;
  replayed: number;
  linked: number;
  superseded: number;
  rejected_preserved: number;
  source_missing: number;
  attribution_ambiguous: number;
  failed: number;
}

function isDeadExtractionDraft(row: any): boolean {
  const open = ["draft", "needs_review", "reopen_candidate", "rejected"]
    .includes(String(row.status || ""));
  if (!open || row.deterministic_key) return false;
  if (row.rejected_at) return true;
  if (
    Array.isArray(row.missing_fields) &&
    row.missing_fields.includes("extraction_down_key_dead")
  ) return true;
  return /\b(?:usage[_ -]?cap|extraction[_ -]?(?:down|dead|failed|unavailable))\b/i
    .test(JSON.stringify(row.extraction_json || {}));
}

async function loadFrozenCandidates(
  client: any,
  maxDrafts: number,
): Promise<any[]> {
  const candidates: any[] = [];
  for (let from = 0; candidates.length < maxDrafts; from += PAGE_SIZE) {
    const { data, error } = await client.from("makesafe_intake_drafts")
      .select(
        "id,org_id,mailbox,graph_message_id,status,missing_fields,extraction_json,deterministic_key,rejected_at,rejected_by,review_notes,received_at",
      )
      .eq("org_id", DEFAULT_ORG_ID)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(
        `legacy draft page read failed: ${error.message || error}`,
      );
    }
    const rows = data || [];
    for (const row of rows) {
      if (isDeadExtractionDraft(row)) candidates.push({ ...row });
      if (candidates.length >= maxDrafts) break;
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return candidates;
}

async function writeDraftIssue(
  client: any,
  draft: any,
  reason:
    | "legacy_draft_source_missing"
    | "legacy_draft_attribution_ambiguous"
    | "source_persist_failed",
): Promise<void> {
  await persistIntakeSourceIssue(client, {
    orgId: draft.org_id || DEFAULT_ORG_ID,
    mailbox: draft.mailbox || SES_MAILBOX,
    postId: draft.graph_message_id,
    receivedAt: draft.received_at || null,
    reason,
  });
}

export async function drainLegacyIntakeDrafts(
  client: any,
  options: LegacyDraftDrainOptions = {},
): Promise<LegacyDraftDrainReport> {
  const maxDrafts = Number(options.maxDrafts ?? 5000);
  if (!Number.isInteger(maxDrafts) || maxDrafts < 1 || maxDrafts > 10_000) {
    throw new Error(
      "legacy draft drain maxDrafts must be an integer from 1 to 10000",
    );
  }
  const candidates = await loadFrozenCandidates(client, maxDrafts);
  const report: LegacyDraftDrainReport = {
    selected: candidates.length,
    replayed: 0,
    linked: 0,
    superseded: 0,
    rejected_preserved: 0,
    source_missing: 0,
    attribution_ambiguous: 0,
    failed: 0,
  };
  const runIntake = options.runIntake || runDeterministicIntake;

  for (const draft of candidates) {
    const { data: emails, error: emailError } = await client.from("emails")
      .select("post_id,mailbox")
      .eq("mailbox", SES_MAILBOX)
      .eq("post_id", draft.graph_message_id);
    if (emailError) {
      await writeDraftIssue(client, draft, "source_persist_failed");
      report.failed++;
      continue;
    }
    if ((emails || []).length === 0) {
      await writeDraftIssue(client, draft, "legacy_draft_source_missing");
      if (!draft.rejected_at) {
        const { error } = await client.from("makesafe_intake_drafts")
          .update({ status: "needs_review" })
          .eq("id", draft.id);
        if (error) {
          throw new Error(`legacy draft status write failed: ${error.message}`);
        }
      }
      report.source_missing++;
      continue;
    }
    if ((emails || []).length !== 1) {
      await writeDraftIssue(
        client,
        draft,
        "legacy_draft_attribution_ambiguous",
      );
      report.attribution_ambiguous++;
      continue;
    }

    try {
      await runIntake(client, {
        dryRun: false,
        selectionMode: "exact",
        allowSourcePostIds: [draft.graph_message_id],
        requireAllAllowlistMatches: true,
        maxCases: 1,
        advanceDrafts: options.approveDraft !== undefined,
        approveDraft: options.approveDraft,
        applyBuilderCancellation: options.applyBuilderCancellation,
      });
      report.replayed++;
    } catch {
      await writeDraftIssue(client, draft, "source_persist_failed");
      report.failed++;
      continue;
    }

    const { data: sourceRows, error: sourceError } = await client.from(
      "makesafe_intake_case_sources",
    )
      .select("case_id")
      .eq("org_id", DEFAULT_ORG_ID)
      .eq("post_id", draft.graph_message_id);
    if (sourceError) {
      await writeDraftIssue(client, draft, "source_persist_failed");
      report.failed++;
      continue;
    }
    if ((sourceRows || []).length !== 1) {
      await writeDraftIssue(
        client,
        draft,
        "legacy_draft_attribution_ambiguous",
      );
      report.attribution_ambiguous++;
      continue;
    }
    const caseId = sourceRows[0].case_id;
    const { data: intakeCase, error: caseError } = await client.from(
      "makesafe_intake_cases",
    )
      .select("id,instruction_key")
      .eq("org_id", DEFAULT_ORG_ID)
      .eq("id", caseId)
      .maybeSingle();
    if (caseError || !intakeCase) {
      await writeDraftIssue(client, draft, "source_persist_failed");
      report.failed++;
      continue;
    }

    const rejected = !!draft.rejected_at;
    const audit = `Deterministically accounted ${
      new Date().toISOString()
    } as case ${caseId}; legacy extracted fields were not used.`;
    const { error: updateError } = await client.from("makesafe_intake_drafts")
      .update({
        deterministic_key: intakeCase.instruction_key,
        deterministic_case_id: caseId,
        status: rejected ? "rejected" : "superseded",
        review_notes: [draft.review_notes, audit].filter(Boolean).join("\n"),
        updated_at: new Date().toISOString(),
      })
      .eq("id", draft.id);
    if (updateError) {
      await writeDraftIssue(client, draft, "source_persist_failed");
      report.failed++;
      continue;
    }
    report.linked++;
    if (rejected) report.rejected_preserved++;
    else report.superseded++;
  }
  return report;
}
