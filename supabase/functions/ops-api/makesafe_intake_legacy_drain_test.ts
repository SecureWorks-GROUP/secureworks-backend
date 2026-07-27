// deno-lint-ignore-file no-import-prefix no-explicit-any require-await

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { drainLegacyIntakeDrafts } from "./makesafe_intake_legacy_drain.ts";

const ORG = "00000000-0000-0000-0000-000000000001";

class Query {
  filters: Array<(row: any) => boolean> = [];
  from = 0;
  to = Number.MAX_SAFE_INTEGER;
  constructor(
    readonly rows: any[],
    readonly operation: "select" | "insert" | "update",
    readonly payload?: any,
  ) {}
  select() {
    return this;
  }
  eq(column: string, value: any) {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  order() {
    return this;
  }
  range(from: number, to: number) {
    this.from = from;
    this.to = to;
    return this;
  }
  maybeSingle() {
    const result = this.run();
    return Promise.resolve({
      data: result.data[0] || null,
      error: result.error,
    });
  }
  run() {
    const matching = this.rows.filter((row) =>
      this.filters.every((filter) => filter(row))
    );
    if (this.operation === "insert") {
      this.rows.push({ id: `row-${this.rows.length + 1}`, ...this.payload });
      return { data: [], error: null };
    }
    if (this.operation === "update") {
      matching.forEach((row) => Object.assign(row, this.payload));
      return { data: matching, error: null };
    }
    return { data: matching.slice(this.from, this.to + 1), error: null };
  }
  then(resolve: (value: any) => void) {
    resolve(this.run());
  }
}

function client(store: Record<string, any[]>) {
  return {
    from(table: string) {
      store[table] ||= [];
      return {
        select: () => new Query(store[table], "select"),
        insert: (payload: any) => new Query(store[table], "insert", payload),
        update: (payload: any) => new Query(store[table], "update", payload),
      };
    },
  } as any;
}

function draft(overrides: Record<string, any> = {}): any {
  return {
    id: overrides.id || "draft-1",
    org_id: ORG,
    mailbox: "ses@secureworkswa.com.au",
    graph_message_id: overrides.graph_message_id || "post-1",
    status: overrides.status || "needs_review",
    missing_fields: ["extraction_down_key_dead"],
    extraction_json: {},
    deterministic_key: null,
    rejected_at: overrides.rejected_at || null,
    rejected_by: overrides.rejected_at ? "captain@test" : null,
    review_notes: "Original review evidence",
    received_at: "2026-07-27T00:00:00.000Z",
  };
}

function storeFor(rows: any[]): Record<string, any[]> {
  return {
    makesafe_intake_drafts: rows,
    emails: rows.map((row) => ({
      post_id: row.graph_message_id,
      mailbox: "ses@secureworkswa.com.au",
    })),
    makesafe_intake_cases: [],
    makesafe_intake_case_sources: [],
    email_events_raw: [],
  };
}

Deno.test("legacy drain replays exact sources and supersedes without using extracted fields", async () => {
  const row = draft();
  const store: Record<string, any[]> = storeFor([row]);
  const report = await drainLegacyIntakeDrafts(client(store), {
    runIntake: async (_client, options) => {
      assertEquals(options?.advanceDrafts, false);
      assertEquals(options?.approveDraft, undefined);
      store.makesafe_intake_cases.push({
        id: "case-1",
        org_id: ORG,
        instruction_key: "instruction-1",
      });
      store.makesafe_intake_case_sources.push({
        org_id: ORG,
        post_id: "post-1",
        case_id: "case-1",
      });
      return {} as any;
    },
  });
  assertEquals(report.superseded, 1);
  assertEquals(row.status, "superseded");
  assertEquals(row.deterministic_case_id, "case-1");
  assertEquals(row.deterministic_key, "instruction-1");
});

Deno.test("legacy drain preserves rejection evidence while attaching its deterministic fate", async () => {
  const row = draft({
    status: "needs_review",
    rejected_at: "2026-07-20T00:00:00.000Z",
  });
  const store: Record<string, any[]> = storeFor([row]);
  await drainLegacyIntakeDrafts(client(store), {
    runIntake: async () => {
      store.makesafe_intake_cases.push({
        id: "case-1",
        org_id: ORG,
        instruction_key: "instruction-1",
      });
      store.makesafe_intake_case_sources.push({
        org_id: ORG,
        post_id: "post-1",
        case_id: "case-1",
      });
      return {} as any;
    },
  });
  assertEquals(row.status, "rejected");
  assertEquals(row.rejected_at, "2026-07-20T00:00:00.000Z");
  assertEquals(row.rejected_by, "captain@test");
  assertEquals(row.deterministic_case_id, "case-1");
});

Deno.test("legacy drain fails closed on missing and ambiguous source attribution", async () => {
  const missing = draft({ id: "missing", graph_message_id: "missing-post" });
  const ambiguous = draft({
    id: "ambiguous",
    graph_message_id: "ambiguous-post",
  });
  const store: Record<string, any[]> = storeFor([missing, ambiguous]);
  store.emails = store.emails.filter((row) => row.post_id !== "missing-post");
  let replays = 0;
  const report = await drainLegacyIntakeDrafts(client(store), {
    runIntake: async (_client, options) => {
      replays++;
      if (options?.allowSourcePostIds?.[0] === "ambiguous-post") {
        store.makesafe_intake_case_sources.push(
          { org_id: ORG, post_id: "ambiguous-post", case_id: "case-a" },
          { org_id: ORG, post_id: "ambiguous-post", case_id: "case-b" },
        );
      }
      return {} as any;
    },
  });
  assertEquals(replays, 1);
  assertEquals(report.source_missing, 1);
  assertEquals(report.attribution_ambiguous, 1);
  assertEquals(missing.status, "needs_review");
  assertEquals(ambiguous.deterministic_case_id, undefined);
  assertEquals(
    store.email_events_raw.map((row) => row.exclusion_reason).sort(),
    [
      "legacy_draft_attribution_ambiguous",
      "legacy_draft_source_missing",
    ],
  );
});

Deno.test("legacy drain links duplicate and exception fates without minting from draft fields", async () => {
  const duplicate = draft({
    id: "duplicate",
    graph_message_id: "post-duplicate",
  });
  const exception = draft({
    id: "exception",
    graph_message_id: "post-exception",
  });
  const store: Record<string, any[]> = storeFor([duplicate, exception]);
  await drainLegacyIntakeDrafts(client(store), {
    runIntake: async (_client, options) => {
      const postId = options!.allowSourcePostIds![0];
      const caseId = postId === "post-duplicate"
        ? "case-duplicate"
        : "case-exception";
      store.makesafe_intake_cases.push({
        id: caseId,
        org_id: ORG,
        instruction_key: `instruction-${caseId}`,
        parent_relation: postId === "post-duplicate" ? "duplicate_of" : null,
        state: "exception",
        reason_code: postId === "post-duplicate"
          ? "duplicate"
          : "below_identity_floor",
      });
      store.makesafe_intake_case_sources.push({
        org_id: ORG,
        post_id: postId,
        case_id: caseId,
      });
      return {} as any;
    },
  });
  assertEquals(duplicate.status, "superseded");
  assertEquals(duplicate.deterministic_case_id, "case-duplicate");
  assertEquals(exception.status, "superseded");
  assertEquals(exception.deterministic_case_id, "case-exception");
});

Deno.test("legacy drain pages past the former 50-row and PostgREST-sized partial reads", async () => {
  const rows = Array.from({ length: 501 }, (_, index) =>
    draft({
      id: `draft-${String(index).padStart(3, "0")}`,
      graph_message_id: `post-${index}`,
    }));
  const store: Record<string, any[]> = storeFor(rows);
  const report = await drainLegacyIntakeDrafts(client(store), {
    runIntake: async (_client, options) => {
      const postId = options!.allowSourcePostIds![0];
      const caseId = `case-${postId}`;
      store.makesafe_intake_cases.push({
        id: caseId,
        org_id: ORG,
        instruction_key: `instruction-${postId}`,
      });
      store.makesafe_intake_case_sources.push({
        org_id: ORG,
        post_id: postId,
        case_id: caseId,
      });
      return {} as any;
    },
  });
  assertEquals(report.selected, 501);
  assertEquals(report.linked, 501);
  assertEquals(report.failed, 0);
});
