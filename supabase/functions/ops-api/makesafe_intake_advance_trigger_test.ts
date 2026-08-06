// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  describeMakesafeIntakeAdvanceRefusal,
  MAKESAFE_INTAKE_ADVANCE_LIVE_TRIGGERS,
  MAKESAFE_INTAKE_ADVANCE_RENDER_PATH_TRIGGERS,
  resolveMakesafeIntakeAdvanceTrigger,
} from "./makesafe_intake_advance_trigger.ts";
import { _autoApproveCleanIntakeDraftsForTest } from "./index.ts";

// ── The pure decision ────────────────────────────────────────────────────────

Deno.test("the live-approval allow-list is closed and every member is explicit or scheduled", () => {
  // Membership pin. Adding a name authorises unattended live make-safe job
  // creation under it, so growing this set must be a deliberate, reviewed edit
  // rather than something a refactor can do quietly.
  assertEquals(
    [...MAKESAFE_INTAKE_ADVANCE_LIVE_TRIGGERS.keys()].sort(),
    ["ops_intake_review_sweep", "ses-reporting-skill"],
  );
  assertEquals(
    MAKESAFE_INTAKE_ADVANCE_LIVE_TRIGGERS.get("ses-reporting-skill"),
    "scheduled",
  );
  assertEquals(
    MAKESAFE_INTAKE_ADVANCE_LIVE_TRIGGERS.get("ops_intake_review_sweep"),
    "explicit",
  );
  // No render-path trigger may ever also be a live trigger.
  for (const renderTrigger of MAKESAFE_INTAKE_ADVANCE_RENDER_PATH_TRIGGERS) {
    assertEquals(
      MAKESAFE_INTAKE_ADVANCE_LIVE_TRIGGERS.has(renderTrigger),
      false,
      `${renderTrigger} is a render-path trigger and must never authorise a live run`,
    );
  }
});

Deno.test("the board autoload is refused by name, not merely as an unknown", () => {
  const decision = resolveMakesafeIntakeAdvanceTrigger({
    triggered_by: "ops_board_autoload",
  });
  assertEquals(decision.liveAuthorised, false);
  assertEquals(decision.refusalReason, "render_path_trigger");
  assertEquals(decision.kind, null);
  // The trigger is still reported verbatim so a stale client is diagnosable.
  assertEquals(decision.trigger, "ops_board_autoload");
  assertStringIncludes(
    describeMakesafeIntakeAdvanceRefusal(decision) || "",
    "rendering a board must never create live make-safe jobs",
  );
});

Deno.test("an unnamed trigger previews and keeps the legacy audit label", () => {
  for (const body of [{}, { triggered_by: "   " }, null, undefined]) {
    const decision = resolveMakesafeIntakeAdvanceTrigger(body);
    assertEquals(decision.liveAuthorised, false, JSON.stringify(body));
    assertEquals(decision.refusalReason, "trigger_missing");
    // The historical label is retained for attribution of the existing rows and
    // for the intake-health auto-filed counter; it authorises nothing.
    assertEquals(decision.trigger, "auto_intake_clean_gate");
  }
});

Deno.test("an unrecognised trigger is refused as unknown, not as a render path", () => {
  const decision = resolveMakesafeIntakeAdvanceTrigger({
    triggered_by: "some_new_caller",
  });
  assertEquals(decision.liveAuthorised, false);
  assertEquals(decision.refusalReason, "trigger_not_authorised");
});

Deno.test("the two sanctioned triggers are authorised and carry their kind", () => {
  const scheduled = resolveMakesafeIntakeAdvanceTrigger({
    triggered_by: "ses-reporting-skill",
  });
  assertEquals(scheduled.liveAuthorised, true);
  assertEquals(scheduled.kind, "scheduled");
  assertEquals(describeMakesafeIntakeAdvanceRefusal(scheduled), null);

  // camelCase body key and surrounding whitespace resolve identically — the
  // dashboard and the skill do not share a serialiser.
  const explicit = resolveMakesafeIntakeAdvanceTrigger({
    triggeredBy: " ops_intake_review_sweep ",
  });
  assertEquals(explicit.liveAuthorised, true);
  assertEquals(explicit.kind, "explicit");
});

// ── The real sweep ───────────────────────────────────────────────────────────

// One draft that genuinely passes the pure clean gate: high confidence, no missing
// fields, a matched company, a ref, and exactly one servable non-report PDF. All
// values are synthetic — no client identity appears in this fixture.
function cleanDraftRow() {
  return {
    id: "draft-fixture-1",
    status: "needs_review",
    confidence: "high",
    missing_fields: [],
    requesting_company_slug: "mlb",
    requesting_company_name: "Fixture Builder",
    external_ref: "FIXTURE-PO-1",
    client_name: "Fixture Client",
    site_address: "1 Fixture Street",
    subject: "Work Order FIXTURE-PO-1",
    body_preview: "Please attend and make safe.",
    report_type: null,
    extraction_json: {},
    attachments_json: [
      {
        file_name: "work-order-FIXTURE-PO-1.pdf",
        pdf_url: "https://example.invalid/work-order-FIXTURE-PO-1.pdf",
        is_work_order: true,
      },
    ],
  };
}

/**
 * Minimal PostgREST-shaped stub. `approveIntakeDraft` loads the draft with
 * `.select('*').eq('id', …).single()`; this stub answers that read with an error, so
 * any approval ATTEMPT lands in the sweep's `failed[]`. That is what makes "did the
 * sweep try to write?" observable without a database.
 */
function stubClient(rows: any[], calls: { singleReads: number }) {
  const builder = (table: string) => {
    const chain: any = {
      select: () => chain,
      in: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => Promise.resolve({ data: rows, error: null }),
      maybeSingle: () =>
        table === "makesafe_cron_settings"
          // Auto-file brake left ON, so the intent gate is the only thing that can
          // withhold a live run in these tests.
          ? Promise.resolve({ data: { auto_file_enabled: true }, error: null })
          : Promise.resolve({ data: null, error: null }),
      single: () => {
        calls.singleReads++;
        return Promise.resolve({
          data: null,
          error: { message: "stub: no draft" },
        });
      },
      update: () => chain,
    };
    return chain;
  };
  return { from: (table: string) => builder(table) };
}

Deno.test("REGRESSION: a render-path trigger previews the same drafts and approves none", async () => {
  const calls = { singleReads: 0 };
  const result: any = await _autoApproveCleanIntakeDraftsForTest(
    stubClient([cleanDraftRow()], calls),
    { limit: 60, triggered_by: "ops_board_autoload" },
  );

  // The brake is NOT the clean gate: the draft is still reported eligible, with
  // its evidence, so the operator surface loses no information.
  assertEquals(result.checked_count, 1);
  assertEquals(result.eligible_count, 1);
  // ...and nothing was written. approveIntakeDraft was never entered, so its
  // draft load never happened.
  assertEquals(result.auto_approved_count, 0);
  assertEquals(result.failed_count, 0);
  assertEquals(calls.singleReads, 0);

  assertEquals(result.dry_run, true);
  assertEquals(result.requested_dry_run, false);
  assertEquals(result.live_approval_authorised, false);
  assertEquals(result.trigger_refusal_reason, "render_path_trigger");
  assert(result.enabled, "the emergency brakes stay independent of the intent gate");
});

Deno.test("CONTROL: an authorised trigger still reaches the approval path", async () => {
  const calls = { singleReads: 0 };
  const result: any = await _autoApproveCleanIntakeDraftsForTest(
    stubClient([cleanDraftRow()], calls),
    { limit: 60, triggered_by: "ses-reporting-skill" },
  );

  assertEquals(result.eligible_count, 1);
  assertEquals(result.live_approval_authorised, true);
  assertEquals(result.trigger_kind, "scheduled");
  assertEquals(result.trigger_refusal_reason, null);
  assertEquals(result.dry_run, false);
  // The stub refuses the draft load, so the attempt surfaces as a failure rather
  // than an approval — an attempt is exactly what the regression above must not make.
  assertEquals(calls.singleReads, 1);
  assertEquals(result.failed_count, 1);
});

Deno.test("CONTROL: an explicit dry_run still previews under an authorised trigger", async () => {
  const calls = { singleReads: 0 };
  const result: any = await _autoApproveCleanIntakeDraftsForTest(
    stubClient([cleanDraftRow()], calls),
    { limit: 60, dry_run: true, triggered_by: "ops_intake_review_sweep" },
  );

  assertEquals(result.live_approval_authorised, true);
  assertEquals(result.dry_run, true);
  assertEquals(result.requested_dry_run, true);
  assertEquals(calls.singleReads, 0);
});
