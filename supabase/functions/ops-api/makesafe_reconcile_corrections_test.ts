import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _assertReviewedFamilyConsistency,
  _convertMakesafeToInsurance,
  _updateMakesafeJobFamily,
} from "./index.ts";

type Store = {
  job: any;
  detail: any;
  events: any[];
  jobUpdates: any[];
  detailUpdates: any[];
};

function clientFor(store: Store) {
  return {
    from(table: string) {
      let updatePayload: any = null;
      const chain: any = {
        select() {
          return chain;
        },
        update(payload: any) {
          updatePayload = payload;
          return chain;
        },
        eq() {
          return chain;
        },
        single() {
          if (table === "jobs" && updatePayload == null) {
            return Promise.resolve({
              data: structuredClone(store.job),
              error: null,
            });
          }
          if (table === "makesafe_job_details" && updatePayload == null) {
            return Promise.resolve({
              data: structuredClone(store.detail),
              error: null,
            });
          }
          if (table === "jobs" && updatePayload != null) {
            store.jobUpdates.push(structuredClone(updatePayload));
            store.job = { ...store.job, ...structuredClone(updatePayload) };
            return Promise.resolve({
              data: structuredClone(store.job),
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        insert(payload: any) {
          if (table === "job_events") {
            store.events.push(structuredClone(payload));
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: any, reject: any) {
          try {
            if (updatePayload != null) {
              if (table === "jobs") {
                store.jobUpdates.push(structuredClone(updatePayload));
                store.job = { ...store.job, ...structuredClone(updatePayload) };
              }
              if (table === "makesafe_job_details") {
                store.detailUpdates.push(structuredClone(updatePayload));
                store.detail = {
                  ...store.detail,
                  ...structuredClone(updatePayload),
                };
              }
            }
            return Promise.resolve(resolve({ data: null, error: null }));
          } catch (error) {
            return reject
              ? Promise.resolve(reject(error))
              : Promise.reject(error);
          }
        },
      };
      return chain;
    },
  };
}

function fixture(): Store {
  return {
    job: {
      id: "job-1",
      job_number: "SWMS-1",
      type: "makesafe",
      status: "processing",
      metadata: {
        makesafe_job_family: "general_makesafe",
        makesafe_job_family_label: "General Make-safe",
        preserve_me: "yes",
      },
    },
    detail: {
      job_id: "job-1",
      report_type: null,
      substatus: "waiting_on_trade_report",
    },
    events: [],
    jobUpdates: [],
    detailUpdates: [],
  };
}

Deno.test("reviewed family correction preserves metadata and does not move substatus", async () => {
  const store = fixture();
  const result = await _updateMakesafeJobFamily(clientFor(store), {
    job_id: "job-1",
    expected_before_family: "general_makesafe",
    makesafe_job_family: "roof_report",
    reason: "source WO says roof report",
  });

  assertEquals(result.ok, true);
  assertEquals(result.before, {
    makesafe_job_family: "general_makesafe",
    report_type: null,
    substatus: "waiting_on_trade_report",
  });
  assertEquals(result.after, {
    makesafe_job_family: "roof_report",
    report_type: "roof_report",
    substatus: "waiting_on_trade_report",
  });
  assertEquals(store.job.metadata.preserve_me, "yes");
  assertEquals(store.job.metadata.makesafe_job_family, "roof_report");
  assertEquals(store.detail.report_type, "roof_report");
  assertEquals(store.detail.substatus, "waiting_on_trade_report");
  assertEquals(store.events.length, 1);
  assertEquals(store.events[0].event_type, "makesafe_job_family_corrected");
});

Deno.test("captain conversion preserves the live job and classifies insurance ownership", async () => {
  const store = fixture();
  store.job.status = "processing";
  const result = await _convertMakesafeToInsurance(clientFor(store), {
    job_id: "job-1",
    expected_before_type: "makesafe",
    insurance_job_type: "restoration",
    captain_ruling: "keep live; actual attendance owed",
  });

  assertEquals(result.ok, true);
  assertEquals(result.before.type, "makesafe");
  assertEquals(result.after, {
    type: "insurance",
    status: "processing",
    insurance_job_type: "restoration",
    insurance_job_type_label: "Restoration Insurance Work",
    substatus: "waiting_on_trade_report",
  });
  assertEquals(store.job.type, "insurance");
  assertEquals(store.job.status, "processing");
  assertEquals(store.job.metadata.preserve_me, "yes");
  assertEquals(store.job.metadata.insurance_job_type, "restoration");
  assertEquals(store.detail.substatus, "waiting_on_trade_report");
  assertEquals(store.events.length, 1);
  assertEquals(store.events[0].event_type, "makesafe_converted_to_insurance");
});

Deno.test("reviewed family correction refuses stale before value", async () => {
  const store = fixture();
  await assertRejects(
    () =>
      _updateMakesafeJobFamily(clientFor(store), {
        job_id: "job-1",
        expected_before_family: "temp_fence_makesafe",
        makesafe_job_family: "roof_report",
      }),
    Error,
    "family drift",
  );
  assertEquals(store.jobUpdates, []);
  assertEquals(store.detailUpdates, []);
  assertEquals(store.events, []);
});

Deno.test("reviewed family consistency: no override is always allowed", () => {
  _assertReviewedFamilyConsistency(null, null, false, false);
  _assertReviewedFamilyConsistency(null, "roof_report", false, true);
  _assertReviewedFamilyConsistency(null, null, true, false);
});

Deno.test("reviewed family consistency: report family requires the matching report type", () => {
  _assertReviewedFamilyConsistency("roof_report", "roof_report", false, true);
  _assertReviewedFamilyConsistency(
    "assessment_report_quote",
    "assessment_report",
    false,
    true,
  );
});

Deno.test("reviewed family consistency: report family on a physical/null type is rejected", () => {
  assertThrows(
    () => _assertReviewedFamilyConsistency("roof_report", null, false, false),
    Error,
    "requires report_type 'roof_report'",
  );
  assertThrows(
    () =>
      _assertReviewedFamilyConsistency(
        "assessment_report_quote",
        null,
        false,
        false,
      ),
    Error,
    "requires report_type 'assessment_report'",
  );
  // roof family with a non-matching (assessment) report type is still a mismatch
  assertThrows(
    () =>
      _assertReviewedFamilyConsistency(
        "roof_report",
        "assessment_report",
        false,
        true,
      ),
    Error,
    "requires report_type 'roof_report'",
  );
});

Deno.test("reviewed family consistency: physical family on a report-only type is rejected", () => {
  assertThrows(
    () =>
      _assertReviewedFamilyConsistency(
        "general_makesafe",
        "roof_report",
        false,
        true,
      ),
    Error,
    "is a physical make-safe",
  );
  assertThrows(
    () =>
      _assertReviewedFamilyConsistency(
        "temp_fence_makesafe",
        "assessment_report",
        false,
        true,
      ),
    Error,
    "is a physical make-safe",
  );
});

Deno.test("reviewed family consistency: physical family on a physical primary is allowed", () => {
  _assertReviewedFamilyConsistency("general_makesafe", null, false, false);
  _assertReviewedFamilyConsistency(
    "temp_fence_makesafe",
    "make_safe",
    false,
    false,
  );
});

Deno.test("reviewed family consistency: combined split rejects a report family, allows a physical one", () => {
  assertThrows(
    () => _assertReviewedFamilyConsistency("roof_report", null, true, false),
    Error,
    "belongs to the secondary card",
  );
  assertThrows(
    () =>
      _assertReviewedFamilyConsistency(
        "assessment_report_quote",
        null,
        true,
        false,
      ),
    Error,
    "belongs to the secondary card",
  );
  // a physical family override still preserves the deliberately physical primary
  _assertReviewedFamilyConsistency("general_makesafe", null, true, false);
  _assertReviewedFamilyConsistency("temp_fence_makesafe", null, true, false);
});

Deno.test("reconciliation approval flags remain explicitly privileged and opt-in", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  assertEquals(
    source.includes("reviewedReportType || effectiveIntakeReportType(draft)"),
    true,
  );
  assertEquals(
    source.includes("body?.suppress_manager_notification === true"),
    true,
  );
  assertEquals(source.includes("body?.report_unsubmitted === true"), true);
  assertEquals(
    source.includes("body?.attach_work_order_for_report === true"),
    true,
  );
  assertEquals(
    source.includes(
      "forbidden: approve_intake_draft requires the privileged ops key",
    ),
    true,
  );
});
