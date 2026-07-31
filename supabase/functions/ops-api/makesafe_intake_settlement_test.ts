// deno-lint-ignore-file no-import-prefix no-explicit-any

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ensureIntakeWorkOrderEvidence,
  intakeMintedJobIds,
} from "./makesafe_intake_settlement.ts";

function client(existing: any[] = [], insertError: any = null) {
  const inserts: any[] = [];
  const query: any = {
    select() {
      return query;
    },
    in() {
      return query;
    },
    eq() {
      return Promise.resolve({ data: existing, error: null });
    },
  };
  return {
    inserts,
    client: {
      from() {
        return {
          select() {
            return query;
          },
          insert(row: any) {
            inserts.push(row);
            return Promise.resolve({ data: null, error: insertError });
          },
        };
      },
    },
  };
}

Deno.test("work-order evidence continuation fans every source PDF to every minted job idempotently", async () => {
  const db = client([
    {
      job_id: "job-1",
      storage_url: "storage/work-order.pdf",
      pdf_url: "storage/work-order.pdf",
    },
  ]);
  await ensureIntakeWorkOrderEvidence(
    db.client,
    ["job-1", "job-2", "job-2"],
    [{
      file_name: "work-order.pdf",
      storage_url: "storage/work-order.pdf",
    }],
    {},
  );

  assertEquals(db.inserts, [{
    job_id: "job-2",
    type: "work_order",
    file_name: "work-order.pdf",
    storage_url: "storage/work-order.pdf",
    pdf_url: "storage/work-order.pdf",
    visible_to_trades: true,
  }]);
});

Deno.test("work-order evidence continuation remains retryable after an insert failure", async () => {
  const db = client([], { message: "storage write failed" });
  await assertRejects(
    () =>
      ensureIntakeWorkOrderEvidence(
        db.client,
        ["job-1"],
        [{ pdf_url: "storage/work-order.pdf" }],
        {},
      ),
    Error,
    "work-order evidence attach failed",
  );
});

Deno.test("minted job recovery distinguishes new jobs from existing-job bindings", () => {
  assertEquals(
    intakeMintedJobIds(
      {
        deterministic_intake: true,
        intake_minted_job_ids: ["job-1", "job-2", "job-1"],
      },
      "job-1",
    ),
    ["job-1", "job-2"],
  );
  assertEquals(
    intakeMintedJobIds(
      {
        deterministic_intake: true,
        intake_minted_job_ids: [],
      },
      "existing-job",
    ),
    [],
  );
  assertEquals(
    intakeMintedJobIds({ deterministic_intake: true }, "legacy-job"),
    ["legacy-job"],
  );
});
