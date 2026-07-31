// deno-lint-ignore-file no-import-prefix no-explicit-any

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assertDurableSourceFates } from "./makesafe_deterministic_intake_runtime.ts";
import {
  INTAKE_SOURCE_ISSUE_REASONS,
  intakeSourceIssueChangeType,
  parseIntakeSourceIssueReason,
  persistIntakeSourceIssue,
} from "./makesafe_intake_source_issues.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const MAILBOX = "ses@secureworkswa.com.au";

class Query {
  private filters: Array<(row: any) => boolean> = [];

  constructor(
    private readonly rows: any[],
    private readonly operation: "select" | "insert",
    private readonly payload?: any,
  ) {}

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  then(resolve: (value: unknown) => void) {
    if (this.operation === "insert") {
      this.rows.push({ id: `row-${this.rows.length + 1}`, ...this.payload });
      resolve({ data: null, error: null });
      return;
    }
    resolve({
      data: this.rows.filter((row) =>
        this.filters.every((filter) => filter(row))
      ),
      error: null,
    });
  }
}

function client(store: Record<string, any[]>) {
  return {
    from(table: string) {
      store[table] ||= [];
      return {
        select: () => new Query(store[table], "select"),
        insert: (payload: any) => new Query(store[table], "insert", payload),
      };
    },
  } as any;
}

Deno.test("typed source issues persist one idempotent non-PII fact", async () => {
  const store: Record<string, any[]> = { email_events_raw: [] };
  const db = client(store);

  const first = await persistIntakeSourceIssue(db, {
    orgId: ORG,
    mailbox: MAILBOX,
    postId: "post-1",
    receivedAt: "2026-07-27T00:00:00.000Z",
    reason: "run_cap_deferred",
    instructionKey: "instruction-1",
    attachmentIds: ["attachment-1"],
    attachmentNames: ["work-order.pdf"],
    attachmentCount: 1,
  });
  const second = await persistIntakeSourceIssue(db, {
    orgId: ORG,
    mailbox: MAILBOX,
    postId: "post-1",
    reason: "source_persist_failed",
  });

  assertEquals(first.created, true);
  assertEquals(second.created, false);
  assertEquals(store.email_events_raw.length, 1);
  assertEquals(
    store.email_events_raw[0].change_type,
    "intake_deferred_run_cap_deferred",
  );
  assertEquals(store.email_events_raw[0].page_meta, {
    source_fate: "open_source_issue",
    next_action_code: "retry_exact_source",
    instruction_key: "instruction-1",
    case_id: null,
    isolated_failure_code: null,
    attachment_ids: ["attachment-1"],
    attachment_names: ["work-order.pdf"],
    attachment_count: 1,
  });
  assertEquals("body" in store.email_events_raw[0], false);
});

Deno.test("every source issue reason has one typed change type", () => {
  assertEquals(
    INTAKE_SOURCE_ISSUE_REASONS.map(intakeSourceIssueChangeType),
    [
      "intake_deferred_run_cap_deferred",
      "intake_deferred_source_closure_cap",
      "intake_deferred_pdf_extraction_cap",
      "intake_deferred_pdf_extraction_pending",
      "intake_deferred_pdf_attachment_limit",
      "intake_exception_lineage_quarantine",
      "intake_deferred_awaiting_parent",
      "intake_exception_source_persist_failed",
      "intake_deferred_attachment_recovery_failed",
      "intake_exception_legacy_draft_source_missing",
      "intake_exception_legacy_draft_attribution_ambiguous",
    ],
  );
});

Deno.test("legacy prefixed cap issue aliases normalize to one reason", () => {
  assertEquals(
    parseIntakeSourceIssueReason("intake_deferred_scan_run_cap_deferred"),
    "run_cap_deferred",
  );
});

Deno.test("durable accounting ignores scan handoff receipts without admitting an unaccounted source", async () => {
  assertEquals(
    parseIntakeSourceIssueReason(
      "intake_exception_scan_handoff_http_500",
    ),
    null,
  );
  assertEquals(
    parseIntakeSourceIssueReason(
      "intake_exception_scan_handoff_http_546",
    ),
    null,
  );
  const store: Record<string, any[]> = {
    makesafe_intake_case_sources: [
      { org_id: ORG, post_id: "MLB-26950-source" },
    ],
    email_classifier_exclusions: [],
    email_events_raw: [
      {
        org_id: ORG,
        post_id: "MLB-26950-source",
        change_type: "intake_exception_scan_handoff_http_500",
      },
      {
        org_id: ORG,
        post_id: "MLB-26950-source",
        change_type: "intake_exception_scan_handoff_http_546",
      },
    ],
  };
  const db = client(store);

  assertEquals(
    await assertDurableSourceFates(db, ["MLB-26950-source"]),
    { checked: 1, final: 1, transient: 0 },
  );
  await assertRejects(
    () => assertDurableSourceFates(db, ["genuinely-unaccounted-source"]),
    Error,
    "0 final, 0 open issues",
  );
});

Deno.test("durable accounting accepts each source exactly once and rejects silent or double fates", async () => {
  const store: Record<string, any[]> = {
    makesafe_intake_case_sources: [
      { org_id: ORG, post_id: "case-final" },
      { org_id: ORG, post_id: "case-with-issue" },
    ],
    email_classifier_exclusions: [
      { mailbox: MAILBOX, post_id: "nonwork-final" },
    ],
    email_events_raw: [
      {
        org_id: ORG,
        post_id: "transient",
        change_type: "intake_deferred_run_cap_deferred",
      },
      {
        org_id: ORG,
        post_id: "case-with-issue",
        change_type: "intake_exception_lineage_quarantine",
      },
    ],
  };
  const db = client(store);

  assertEquals(
    await assertDurableSourceFates(db, [
      "case-final",
      "nonwork-final",
      "transient",
      "case-with-issue",
    ]),
    { checked: 4, final: 3, transient: 1 },
  );
  await assertRejects(
    () => assertDurableSourceFates(db, ["silent"]),
    Error,
    "0 final, 0 open issues",
  );

  store.email_classifier_exclusions.push({
    mailbox: MAILBOX,
    post_id: "case-final",
  });
  await assertRejects(
    () => assertDurableSourceFates(db, ["case-final"]),
    Error,
    "2 final",
  );
});
