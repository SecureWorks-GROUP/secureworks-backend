// deno-lint-ignore-file no-explicit-any no-import-prefix
/**
 * SWMS-261124 class — captain-accepted historical backfill places Archive
 * from evidence (legacy_incomplete_evidence + issued ACCREC), not from a
 * display-ledger overlay that R12 can unbind.
 */
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeMakesafeStatus } from "./makesafe_computed_status.ts";
import {
  deriveSesStageV2,
  SES_STAGE_DECISION_REQUIRED,
  SES_STAGE_ENGINE_V2_VERSION,
  sesStageHistoricalBackfillCloseout,
} from "./ses_stage_engine_v2.ts";

const NOW = "2026-08-24T00:00:00.000Z";
const RECOVERY_KEY = "ses-historical:BWCWA-6648:INV-0754";

function historicalCard(over: Record<string, any> = {}): any {
  return {
    job: {
      status: "accepted",
      metadata: {
        makesafe_job_family: "general_makesafe",
        legacy_incomplete_evidence: true,
        historical_backfill_key: RECOVERY_KEY,
        historical_invoice_number: "INV-0754",
        legacy_incomplete_evidence_accepted_by: "captain",
        legacy_incomplete_evidence_accepted_at: "2026-08-01",
        ...(over.metadata || {}),
      },
      ...(over.job || {}),
    },
    detail: {
      cycle_number: 1,
      attendance_cycle_id: null,
      substatus: "company_contact_required",
      ...(over.detail || {}),
    },
    evidence: {
      assignments: [],
      serviceReports: [],
      completionPhotoCount: 0,
      invoiceStatus: "PAID",
      invoiceDate: "2026-06-24",
      invoiceCreatedAt: "2026-06-24T04:30:01.903Z",
      packSent: false,
      attendanceCycleIds: [],
      currentAttendanceCycleId: null,
      ...(over.evidence || {}),
    },
    nowIso: NOW,
    ...over,
  };
}

Deno.test("historical backfill closeout recognises the SWMS-261124 shape", () => {
  const hit = sesStageHistoricalBackfillCloseout(historicalCard());
  assertEquals(hit, {
    recovery_key: RECOVERY_KEY,
    invoice_status: "PAID",
  });
});

Deno.test("historical backfill closeout refuses without captain legacy acceptance", () => {
  assertEquals(
    sesStageHistoricalBackfillCloseout(historicalCard({
      metadata: { legacy_incomplete_evidence: false },
    })),
    null,
  );
  assertEquals(
    sesStageHistoricalBackfillCloseout(historicalCard({
      metadata: { legacy_incomplete_evidence: true, historical_backfill_key: "" },
    })),
    null,
  );
});

Deno.test("historical backfill closeout refuses a DRAFT invoice", () => {
  assertEquals(
    sesStageHistoricalBackfillCloseout(historicalCard({
      evidence: { invoiceStatus: "DRAFT" },
    })),
    null,
  );
});

Deno.test("SWMS-261124 places at archive from invoice date via the common clock", () => {
  const result = deriveSesStageV2(historicalCard());
  assertEquals(result.stage, "archive");
  assertEquals(result.engine_version, SES_STAGE_ENGINE_V2_VERSION);
  assert(
    result.reasons.some((r) =>
      r.includes("captain-accepted historical backfill") &&
      r.includes(RECOVERY_KEY)
    ),
  );
  assert(
    result.reasons.some((r) => r.includes("at least 7 days old")),
  );
});

Deno.test("AUTHORISED historical backfill also places (not PAID-only)", () => {
  const result = deriveSesStageV2(historicalCard({
    evidence: {
      invoiceStatus: "AUTHORISED",
      invoiceDate: "2026-06-24",
    },
  }));
  assertEquals(result.stage, "archive");
});

Deno.test("without an issued invoice the card stays New (no invented closeout)", () => {
  const result = deriveSesStageV2(historicalCard({
    evidence: {
      invoiceStatus: null,
      invoiceDate: null,
      invoiceCreatedAt: null,
    },
  }));
  assertEquals(result.stage, "new");
});

Deno.test("fresh invoice date places Completed, then Archive at seven days", () => {
  const fresh = deriveSesStageV2(historicalCard({
    evidence: {
      invoiceStatus: "PAID",
      invoiceDate: "2026-08-20",
      invoiceCreatedAt: "2026-08-20T12:00:00.000Z",
    },
  }));
  assertEquals(fresh.stage, "completed");

  const boundary = deriveSesStageV2(historicalCard({
    evidence: {
      invoiceStatus: "PAID",
      // Exactly 7 days before NOW → Archive (strict boundary).
      invoiceDate: "2026-08-17",
      invoiceCreatedAt: "2026-08-17T00:00:00.000Z",
    },
  }));
  assertEquals(boundary.stage, "archive");
});

Deno.test("M1 published value is unchanged by the historical-backfill closeout", () => {
  const card = historicalCard();
  const without = {
    ...card,
    job: {
      ...card.job,
      metadata: {
        ...card.job.metadata,
        legacy_incomplete_evidence: false,
      },
    },
  };
  // M1 must ignore the historical-backfill evidence path entirely.
  assertEquals(
    JSON.stringify(computeMakesafeStatus(card)),
    JSON.stringify(computeMakesafeStatus(without)),
  );
});

Deno.test("a bound terminal proof still outranks the historical-backfill path", () => {
  const CYCLE = "cycle-0000-0000-0000-000000000001";
  const result = deriveSesStageV2(historicalCard({
    evidence: {
      invoiceStatus: "PAID",
      invoiceDate: "2026-06-24",
      attendanceCycleIds: [CYCLE],
      currentAttendanceCycleId: CYCLE,
      terminalProofs: [{
        id: "proof-1",
        kind: "verified_historical_closeout",
        attendance_cycle_ids: [CYCLE],
        evidence_refs: ["xero_invoices:inv"],
        proven_by: "test",
        // Recent proof → Completed, proving this branch ran instead of the
        // older invoice-date Archive path.
        proven_at: "2026-08-22T00:00:00.000Z",
      }],
    },
  }));
  assertEquals(result.stage, "completed");
  assert(
    result.reasons.some((r) => r.includes("verified_historical_closeout")),
  );
});

Deno.test("missing completion clock on an otherwise valid historical card is decision_required", () => {
  const result = deriveSesStageV2(historicalCard({
    evidence: {
      invoiceStatus: "PAID",
      invoiceDate: null,
      invoiceCreatedAt: null,
    },
  }));
  assertEquals(result.stage, SES_STAGE_DECISION_REQUIRED);
  assertEquals(result.conflicts, ["completion_timestamp_missing"]);
});
