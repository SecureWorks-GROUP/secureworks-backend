// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _autoApproveCleanIntakeDraftsForTest,
  _listIntakeDraftsForTest,
} from "./index.ts";

interface FakeCalls {
  singleReads: number;
  writes: number;
}

function intakeDraft(
  id: string,
  options: {
    externalRef?: string;
    family?: string | null;
    workOrder?: string | null;
    po?: string | null;
    status?: string;
    receivedAt?: string;
  } = {},
) {
  const externalRef = options.externalRef ?? `MLB-${id}`;
  const workOrder = options.workOrder === undefined
    ? `${externalRef}PO-${id}`
    : options.workOrder;
  const po = options.po === undefined ? `PO-${id}` : options.po;
  const family = options.family === undefined
    ? "general_makesafe"
    : options.family;
  return {
    id: `draft-${id}`,
    status: options.status || "needs_review",
    received_at: options.receivedAt || "2026-08-27T00:00:00.000Z",
    confidence: "high",
    missing_fields: [],
    requesting_company_slug: "mlb",
    requesting_company_name: "Fixture Builder",
    external_ref: externalRef,
    client_name: "Fixture Client",
    site_address: `${id} Fixture Street`,
    subject: `Work Order ${externalRef}`,
    body_preview: "Please attend and make safe.",
    report_type: null,
    extraction_json: {
      builder_work_order_number: workOrder,
      builder_po_number: po,
      makesafe_job_family: family,
    },
    attachments_json: [{
      file_name: `work-order-${id}.pdf`,
      pdf_url: `https://example.invalid/work-order-${id}.pdf`,
      is_work_order: true,
    }],
  };
}

function obligationJob(
  id: string,
  options: {
    externalRef?: string;
    family?: string;
    workOrder?: string;
    po?: string;
    status?: string;
  } = {},
) {
  const externalRef = options.externalRef ?? `MLB-${id}`;
  return {
    job_id: `job-${id}`,
    external_ref: externalRef,
    requesting_company_slug: "mlb",
    requesting_company_name: "Fixture Builder",
    report_type: null,
    jobs: {
      job_number: `SWMS-${id}`,
      status: options.status || "accepted",
      site_address: `${id} Fixture Street`,
      type: "makesafe",
      metadata: {
        builder_work_order_number: options.workOrder ??
          `${externalRef}PO-${id}`,
        builder_po_number: options.po ?? `PO-${id}`,
        makesafe_job_family: options.family || "general_makesafe",
      },
    },
  };
}

function fakeClient(
  drafts: any[],
  jobs: any[],
  calls: FakeCalls = { singleReads: 0, writes: 0 },
) {
  const tables: Record<string, any[]> = {
    makesafe_intake_drafts: drafts,
    makesafe_job_details: jobs,
    makesafe_companies: [{ active: true, parsing_rules: {} }],
    makesafe_cron_settings: [{ id: 1, auto_file_enabled: true }],
  };

  const from = (table: string) => {
    let selectedWithCount = false;
    const equals: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    let order: { column: string; ascending: boolean } | null = null;
    let range: [number, number] | null = null;

    const result = () => {
      let rows = [...(tables[table] || [])];
      for (const [column, value] of equals) {
        rows = rows.filter((row) => row?.[column] === value);
      }
      for (const [column, values] of inFilters) {
        rows = rows.filter((row) => values.includes(row?.[column]));
      }
      if (order) {
        rows.sort((left, right) => {
          const comparison = String(left?.[order!.column] || "").localeCompare(
            String(right?.[order!.column] || ""),
          );
          return order!.ascending ? comparison : -comparison;
        });
      }
      const count = rows.length;
      if (range) rows = rows.slice(range[0], range[1] + 1);
      return {
        data: rows,
        error: null,
        count: selectedWithCount ? count : null,
      };
    };

    const chain: any = {
      select: (_columns?: string, options?: { count?: string }) => {
        selectedWithCount = options?.count === "exact";
        return chain;
      },
      eq: (column: string, value: unknown) => {
        equals.push([column, value]);
        return chain;
      },
      in: (column: string, values: unknown[]) => {
        inFilters.push([column, values]);
        return chain;
      },
      order: (column: string, options?: { ascending?: boolean }) => {
        order = { column, ascending: options?.ascending !== false };
        return chain;
      },
      range: (from: number, to: number) => {
        range = [from, to];
        return chain;
      },
      maybeSingle: () => {
        const current = result();
        return Promise.resolve({
          data: current.data[0] || null,
          error: null,
        });
      },
      single: () => {
        calls.singleReads++;
        return Promise.resolve({
          data: null,
          error: { message: "stub: unexpected single read" },
        });
      },
      update: () => {
        calls.writes++;
        return chain;
      },
      insert: () => {
        calls.writes++;
        return chain;
      },
      upsert: () => {
        calls.writes++;
        return chain;
      },
      then: (resolve: (value: any) => any, reject: (reason: any) => any) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    return chain;
  };

  return { client: { from }, calls };
}

Deno.test("operator intake omits only proved same-ref same-family accounted drafts", async () => {
  const sameFamily = intakeDraft("61001");
  const distinctFamily = intakeDraft("61002", {
    family: "assessment_report_quote",
  });
  const identityMaybe = intakeDraft("61003", {
    workOrder: null,
    po: null,
  });
  const terminalConflict = intakeDraft("61004");
  const multipleConflict = intakeDraft("61005");
  const { client, calls } = fakeClient(
    [
      sameFamily,
      distinctFamily,
      identityMaybe,
      terminalConflict,
      multipleConflict,
    ],
    [
      obligationJob("61001"),
      obligationJob("61002"),
      obligationJob("61004", { status: "completed" }),
      obligationJob("61005"),
      {
        ...obligationJob("61005"),
        job_id: "job-61005-sibling",
      },
    ],
  );

  const result: any = await _listIntakeDraftsForTest(
    client,
    new URLSearchParams({ status: "draft,needs_review" }),
  );

  assertEquals(
    result.drafts.map((draft: any) => draft.id).sort(),
    [
      distinctFamily.id,
      identityMaybe.id,
      multipleConflict.id,
      terminalConflict.id,
    ].sort(),
  );
  assertEquals(result.total_count, 5);
  assertEquals(result.visible_total_count, 4);
  assertEquals(result.omitted_accounted_count, 1);
  assertEquals(result.returned_count, 4);
  assertEquals(result.has_more, false);
  assertEquals(result.accounted_filter_error, null);
  assertEquals(calls.writes, 0);
});

Deno.test("operator intake reports the queue beyond its 50-row return cap", async () => {
  const drafts = Array.from({ length: 54 }, (_, index) => {
    const id = String(62000 + index);
    return intakeDraft(id, {
      receivedAt: `2026-08-27T00:${String(index).padStart(2, "0")}:00.000Z`,
    });
  });
  const jobs = [obligationJob("62000"), obligationJob("62001")];
  const { client } = fakeClient(drafts, jobs);

  const result: any = await _listIntakeDraftsForTest(
    client,
    new URLSearchParams({ status: "draft,needs_review" }),
  );

  assertEquals(result.total_count, 54);
  assertEquals(result.omitted_count, 2);
  assertEquals(result.visible_total_count, 52);
  assertEquals(result.returned_count, 50);
  assertEquals(result.has_more, true);
});

Deno.test("Advance clean skips a proved accounted draft without entering approval", async () => {
  const draft = intakeDraft("63001");
  const fake = fakeClient([draft], [obligationJob("63001")]);

  const result: any = await _autoApproveCleanIntakeDraftsForTest(fake.client, {
    triggered_by: "ses-reporting-skill",
  });

  assertEquals(result.total_count, 1);
  assertEquals(result.checked_count, 0);
  assertEquals(result.eligible_count, 0);
  assertEquals(result.auto_approved_count, 0);
  assertEquals(result.accounted_skipped_count, 1);
  assertEquals(result.accounted_skipped[0], {
    draft_id: draft.id,
    external_ref: draft.external_ref,
    reason: "existing_equivalent_obligation",
    matched_job_id: "job-63001",
  });
  assertEquals(result.accounted_match_error, null);
  assertEquals(fake.calls.singleReads, 0);
  assertEquals(fake.calls.writes, 0);
});
