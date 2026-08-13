// deno-lint-ignore-file no-explicit-any no-import-prefix
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCanonicalMakesafeRows,
  portalCapturesFromLedger,
  projectTradeMakesafeBoard,
} from "./makesafe_board_read_model.ts";
import { MAKESAFE_ATTESTED_PORTAL_PRODUCER } from "./makesafe_computed_status.ts";
import {
  SES_PORTAL_CAPTURE_PRODUCER,
  SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
  SES_TRADE_PORTAL_CONFIRMATION_QUESTION,
  sesPortalCaptureProducerHasScreenshot,
} from "./ses_portal_capture_contract.ts";
import {
  isSesConfirmingTradeAssignment,
  isSesRoofCard,
  isSesRoofConfirmationDeadCard,
  resolveSesRoofPortalUrl,
  sesRoofCompletionRecorded,
  sesRoofConfirmationEligibility,
} from "./ses_trade_portal_confirmation.ts";
import {
  confirmSesRoofReportDone,
  SesRoofConfirmationError,
} from "./ses_trade_portal_confirmation_action.ts";

const JOB_ID = "11111111-2222-4333-8444-555555555555";
const CYCLE_ID = "99999999-8888-4777-8666-555555555555";
const TRADE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_TRADE_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const ROOF_URL = "https://primeeco.tech/share/d2ff4956-1302-4ef8-a49e-c9d29061";
const REF = "MLB-27037";

/**
 * A roof card in the shape the board loader hands to the read model. It carries
 * the real production shape observed on SWMS-261019: family `roof_report`, a
 * NULL `report_type`, and a generically-typed `builder_portal` link.
 */
function roofCard(over: Record<string, unknown> = {}) {
  const detail = {
    substatus: "waiting_on_trade_report",
    report_type: null,
    external_ref: REF,
    attendance_cycle_id: CYCLE_ID,
    cycle_number: 1,
    external_links: [{
      kind: "builder_portal",
      label: "Builder portal link",
      url: ROOF_URL,
    }],
    ...(over.makesafe_details as Record<string, unknown> || {}),
  };
  return {
    id: JOB_ID,
    job_number: "SWMS-261019",
    type: "makesafe",
    status: "scheduled",
    board_stage: "allocated",
    board_label: "Allocated",
    substatus: detail.substatus,
    external_ref: REF,
    metadata: { makesafe_job_family: "roof_report", external_ref: REF },
    assignments: [{
      id: "assignment-1",
      user_id: TRADE_ID,
      status: "scheduled",
      scheduled_date: "2026-08-02",
    }],
    age_hours: 20,
    ...over,
    makesafe_details: detail,
  };
}

/** A trade attestation exactly as `confirmSesRoofReportDone` commits it. */
function attestationRow(over: Record<string, unknown> = {}) {
  return {
    id: "revision-1",
    job_id: JOB_ID,
    attendance_cycle_id: CYCLE_ID,
    role: "roof_report",
    status: "verified",
    makesafe_fact_version: 1,
    capture_result: "done",
    source_url: ROOF_URL,
    source_content_hash: `sha256:${"c".repeat(64)}`,
    builder_reference: REF,
    captured_at: "2026-08-02T04:00:00.000Z",
    captured_by: TRADE_ID,
    capture_producer: SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
    capture_idempotency_key: `trade-portal-confirmation:v1:${CYCLE_ID}`,
    signal: "Trade confirmed the builder roof report is complete.",
    screenshot_object_key: null,
    screenshot_media_type: null,
    screenshot_content_hash: null,
    screenshot_size_bytes: null,
    ...over,
  };
}

// ── The one question, and nothing else ──────────────────────────────────────

Deno.test("the trade is asked exactly one question, and it never names a family", () => {
  assertEquals(
    SES_TRADE_PORTAL_CONFIRMATION_QUESTION,
    "Is this roof report done?",
  );
  const eligibility = sesRoofConfirmationEligibility(roofCard(), []);
  assertEquals(eligibility.applicable, true);
  assertEquals(eligibility.offered, true);
  assertEquals(eligibility.reason, "eligible");
  // Everything the record needs is DERIVED from the card, so nothing above is
  // ever asked of the trade.
  assertEquals(eligibility.target?.role, "roof_report");
  assertEquals(eligibility.target?.source_url, ROOF_URL);
  assertEquals(eligibility.target?.builder_reference, REF);
  assertEquals(eligibility.target?.attendance_cycle_id, CYCLE_ID);
});

Deno.test("a typed roof link outranks the generic builder-portal link on the same card", () => {
  const typed = "https://primeeco.tech/share/typed-roof-link-0000000000000000";
  const card = roofCard({
    makesafe_details: {
      external_links: [
        { kind: "builder_portal", label: "Builder portal", url: ROOF_URL },
        { kind: "roof_report", label: "Roof report", url: typed },
      ],
    },
  });
  const resolved = resolveSesRoofPortalUrl(card);
  assertEquals(resolved.ambiguous, false);
  assertEquals(resolved.url, typed);
  assertEquals(sesRoofConfirmationEligibility(card, []).offered, true);
});

Deno.test("two rival roof links fail closed rather than asking the trade to choose", () => {
  const card = roofCard({
    makesafe_details: {
      external_links: [
        {
          kind: "roof_report",
          label: "Roof report",
          url: "https://primeeco.tech/share/roof-one-000000000000000000000",
        },
        {
          kind: "roof_report",
          label: "Roof report (revised)",
          url: "https://primeeco.tech/share/roof-two-000000000000000000000",
        },
      ],
    },
  });
  const eligibility = sesRoofConfirmationEligibility(card, []);
  assertEquals(eligibility.applicable, false);
  assertEquals(eligibility.reason, "ambiguous_portal_roof_link");
  assertEquals(eligibility.target, null);
});

Deno.test("a card with no portal roof link is not applicable", () => {
  const card = roofCard({ makesafe_details: { external_links: [] } });
  assertEquals(
    sesRoofConfirmationEligibility(card, []).reason,
    "no_portal_roof_link",
  );
});

Deno.test("a non-roof card never offers the control", () => {
  const card = roofCard({
    metadata: { makesafe_job_family: "general_makesafe" },
  });
  const eligibility = sesRoofConfirmationEligibility(card, []);
  assertEquals(eligibility.applicable, false);
  assertEquals(eligibility.reason, "not_a_roof_card");
});

Deno.test("a cancelled card takes no confirmation", () => {
  const card = roofCard({ status: "cancelled" });
  assertEquals(
    sesRoofConfirmationEligibility(card, []).reason,
    "card_not_live",
  );
});

Deno.test("roof identity is settled before liveness, so card_not_live only ever describes a roof card", () => {
  // A measurement that counts by reason depends on this ordering: if liveness
  // were checked first, every dead card on the board would report
  // `card_not_live` and the roof population would read as the whole board.
  const deadNonRoof = roofCard({
    status: "archived",
    metadata: { makesafe_job_family: "general_makesafe" },
  });
  assertEquals(
    sesRoofConfirmationEligibility(deadNonRoof, []).reason,
    "not_a_roof_card",
  );
  const deadRoof = roofCard({ status: "archived" });
  assertEquals(
    sesRoofConfirmationEligibility(deadRoof, []).reason,
    "card_not_live",
  );
});

Deno.test("blockers can be evaluated independently, not just as the first reason hit", () => {
  // `eligibility.reason` short-circuits, which is right for a refusal message
  // and wrong for counting: the six production cards this control does not
  // reach are blocked BOTH by a null attendance cycle and by having no assigned
  // trade, and a measurement that reported only the first would hide the
  // second. These exported primitives are what let a measurement see both.
  const card = roofCard({
    status: "archived",
    makesafe_details: { attendance_cycle_id: null, external_links: [] },
  });
  assertEquals(
    sesRoofConfirmationEligibility(card, []).reason,
    "card_not_live",
  );
  assertEquals(isSesRoofConfirmationDeadCard(card), true);
  assertEquals(isSesRoofCard(card), true);
  assertEquals(resolveSesRoofPortalUrl(card).url, null);
  assertEquals(sesRoofCompletionRecorded(card, []), false);
  // "On the job" is a per-viewer fact the card cannot answer, and it is the one
  // that decides whether ANY trade can act.
  assertEquals(isSesConfirmingTradeAssignment({ status: "scheduled" }), true);
  assertEquals(isSesConfirmingTradeAssignment({ status: "cancelled" }), false);
});

Deno.test("a card with no attendance cycle cannot bind evidence to a visit", () => {
  // Six live production roof cards are in exactly this state (see
  // scripts/ses-roof-trade-confirmation-measure-v1.json). The ledger binds
  // every capture to an attendance cycle, so there is nothing to bind to; the
  // control is correctly absent rather than silently writing an unbound row.
  const card = roofCard({
    makesafe_details: { attendance_cycle_id: null },
  });
  const eligibility = sesRoofConfirmationEligibility(card, []);
  assertEquals(eligibility.applicable, false);
  assertEquals(eligibility.reason, "no_attendance_cycle");
});

// ── PR 229 anti-regression: never hide the control on an unproven card ───────

Deno.test("substatus is not proof: an unverified ready_to_invoice roof card still offers the tick", () => {
  for (
    const substatus of ["ready_to_invoice", "admin_to_send_report", "complete"]
  ) {
    const card = roofCard({
      substatus,
      board_stage: "report_ready",
      makesafe_details: { substatus },
    });
    const eligibility = sesRoofConfirmationEligibility(card, []);
    assertEquals(eligibility.offered, true, substatus);
    assertEquals(eligibility.confirmed, false, substatus);
  }
});

Deno.test("the control disappears only where completion evidence genuinely exists", () => {
  const done = [{ role: "roof_report", status: "done", cycle_number: 1 }];
  const eligibility = sesRoofConfirmationEligibility(roofCard(), done);
  assertEquals(eligibility.applicable, true);
  assertEquals(eligibility.confirmed, true);
  assertEquals(eligibility.offered, false);
  assertEquals(eligibility.reason, "already_confirmed");
  // A prior-cycle capture is not this cycle's completion.
  const stale = [{ role: "roof_report", status: "done", cycle_number: 0 }];
  assertEquals(sesRoofConfirmationEligibility(roofCard(), stale).offered, true);
});

// ── Evidence contract: two producers, one fact ──────────────────────────────

Deno.test("the attested-producer constant the status engine reads matches the contract", () => {
  assertEquals(
    MAKESAFE_ATTESTED_PORTAL_PRODUCER,
    SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
  );
  assertEquals(
    sesPortalCaptureProducerHasScreenshot(SES_PORTAL_CAPTURE_PRODUCER),
    true,
  );
  assertEquals(
    sesPortalCaptureProducerHasScreenshot(
      SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
    ),
    false,
  );
});

/** The same card with its roof link typed rather than generic. */
function typedRoofCard() {
  return roofCard({
    makesafe_details: {
      external_links: [{
        kind: "roof_report",
        label: "Roof report",
        url: ROOF_URL,
      }],
    },
  });
}

Deno.test("a trade attestation counts as current-cycle roof evidence without a screenshot", () => {
  const before = buildCanonicalMakesafeRows([typedRoofCard()], {
    portalCaptureRowsByJobId: {},
  })[0];
  assertEquals(
    before.computed_status_evidence.has_current_portal_capture,
    false,
  );
  assertEquals(before.roof_report_confirmation.offered, true);

  const after = buildCanonicalMakesafeRows([typedRoofCard()], {
    portalCaptureRowsByJobId: { [JOB_ID]: [attestationRow()] },
  })[0];
  assertEquals(after.computed_status_evidence.has_current_portal_capture, true);
  assertEquals(after.roof_report_confirmation.confirmed, true);
  assertEquals(after.roof_report_confirmation.offered, false);
  const published = after.computed_status_evidence.portal_capture_revisions;
  assertEquals(published.length, 1);
  assertEquals(published[0].screenshot_available, false);
});

Deno.test("a generically-typed roof portal binds verified capture evidence into report-in", () => {
  const before = buildCanonicalMakesafeRows([roofCard()], {
    portalCaptureRowsByJobId: {},
  })[0];
  assertEquals(before.canonical_stage, "allocated");
  assertEquals(before.report.state, "waiting_on_trade_report");

  const row = buildCanonicalMakesafeRows([roofCard()], {
    portalCaptureRowsByJobId: { [JOB_ID]: [attestationRow()] },
  })[0];
  assertEquals(row.roof_report_confirmation.confirmed, true);
  assertEquals(row.computed_status_evidence.has_current_portal_capture, true);
  assertEquals(row.canonical_stage, "trade_report_in");
  assertEquals(row.report.state, "submitted");

  // The deterministic reader proves the same report-in fact with a screenshot.
  const readerRow = buildCanonicalMakesafeRows([roofCard()], {
    portalCaptureRowsByJobId: {
      [JOB_ID]: [attestationRow({
        capture_producer: SES_PORTAL_CAPTURE_PRODUCER,
        captured_by: "chrome-agent@secureworks.test",
        screenshot_object_key:
          "makesafe-docket-artifacts/portal-captures/a/b/roof_report/c.png",
        screenshot_media_type: "image/png",
        screenshot_content_hash: `sha256:${"d".repeat(64)}`,
        screenshot_size_bytes: 1234,
      })],
    },
  })[0];
  assertEquals(
    readerRow.computed_status_evidence.has_current_portal_capture,
    true,
  );
  assertEquals(readerRow.canonical_stage, "trade_report_in");
  assertEquals(readerRow.report.state, "submitted");

  // A qualifying current draft and READY unsent pack promote the same captured
  // roof to Docs Ready instead of stopping at TRI.
  const docsReady = buildCanonicalMakesafeRows([roofCard({
    report_pack: {
      status: "drafted",
      review_state: "READY",
      invoice_doc_id: "invoice-doc",
      docket_revision_id: "docket-ready",
      pre_xero_docs_ready: true,
      blockers: [],
    },
    invoice_status: "draft",
    invoice_qualifies_as_current_draft: true,
    has_invoice_doc: true,
  })], {
    portalCaptureRowsByJobId: { [JOB_ID]: [attestationRow()] },
  })[0];
  assertEquals(docsReady.canonical_stage, "report_ready");
  assertEquals(docsReady.report.state, "submitted");
});

Deno.test("a card-derived capture cannot forge the attestation marker", () => {
  // `attested_producer` is what lets a screenshot-less capture count. Only a
  // validated ledger row may carry it; free-form card content is stripped.
  const forged = typedRoofCard();
  (forged.makesafe_details as any).portal_captures = [{
    role: "roof_report",
    status: "done",
    url: ROOF_URL,
    cycle_number: 1,
    attested_producer: SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
  }];
  const row = buildCanonicalMakesafeRows([forged], {
    portalCaptureRowsByJobId: {},
  })[0];
  assertEquals(row.computed_status_evidence.has_current_portal_capture, false);
});

Deno.test("an attestation for the wrong role, cycle or reference is refused by the projection", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["wrong role", { role: "assessment" }],
    ["wrong cycle", {
      attendance_cycle_id: "00000000-0000-4000-8000-000000000000",
    }],
    ["wrong builder reference", { builder_reference: "WB-99999" }],
    ["url the card does not carry", {
      source_url: "https://primeeco.tech/share/not-this-card-00000000000000",
    }],
    ["unapproved producer", { capture_producer: "some_other_producer/v1" }],
    ["no confirming user", { captured_by: "  " }],
    ["a screenshot it should not have", {
      screenshot_object_key:
        "makesafe-docket-artifacts/portal-captures/x/y/roof_report/z.png",
    }],
  ];
  assertEquals(
    portalCapturesFromLedger(roofCard(), [attestationRow()]).length,
    1,
    "positive control: the valid attestation must reach the ledger projection",
  );
  for (const [label, over] of cases) {
    assertEquals(
      portalCapturesFromLedger(roofCard(), [attestationRow(over)]),
      [],
      label,
    );
  }
});

// ── The tick writes evidence; placement follows that evidence ───────────────

Deno.test("recording an attestation writes evidence, and the column follows the evidence", () => {
  // Evolved from "recording an attestation writes evidence, not a stage".
  //
  // The "writes evidence, not a stage" half is still exactly right and still
  // enforced — it is proved against the REAL action by "an assigned trade's
  // tick records evidence with its producer and writes no stage", which asserts
  // `stage_written === false` and inspects every table the recorder touched.
  //
  // The R12 cutover changed this test's other half. The old comment here read
  // "the board column is the legacy ladder plus the overlay resolver; neither
  // reads portal evidence, so the tick cannot move the card", and its first
  // clause is no longer true: placement is the corrected evidence engine now,
  // and an accepted attestation IS evidence. So the card SHOULD move, and the
  // guarantee worth protecting is that it moves because of the recorded proof
  // and by exactly the distance that proof carries.
  const before = buildCanonicalMakesafeRows([roofCard()], {
    portalCaptureRowsByJobId: {},
  })[0];
  const after = buildCanonicalMakesafeRows([roofCard()], {
    portalCaptureRowsByJobId: { [JOB_ID]: [attestationRow()] },
  })[0];

  // Raw board state is untouched: the tick wrote a capture row, not a stage.
  assertEquals(after.declared_stage, before.declared_stage);
  assertEquals(after.substatus, before.substatus);
  assertEquals(after.job_state, before.job_state);

  // The column moves to what the attestation proves: the builder's roof form is
  // confirmed done, which is report-in. Not report_ready — a tick is not a pack.
  assertEquals(before.canonical_stage, "allocated");
  assertEquals(after.canonical_stage, "trade_report_in");

  // An attestation the projection refuses proves nothing, so it moves nothing.
  // Absence of accepted evidence can never advance a card.
  const refused = buildCanonicalMakesafeRows([roofCard()], {
    portalCaptureRowsByJobId: {
      [JOB_ID]: [attestationRow({ captured_by: "  " })],
    },
  })[0];
  assertEquals(refused.canonical_stage, "allocated");
});

// ── The trade projection ────────────────────────────────────────────────────

Deno.test("only a trade on the job gets the control; a see-all manager does not", () => {
  const rows = buildCanonicalMakesafeRows([roofCard()], {
    portalCaptureRowsByJobId: {},
  });
  const assigned = projectTradeMakesafeBoard(rows, {
    userId: TRADE_ID,
    role: "crew",
    managedVerticals: [],
  }).rows[0];
  assertEquals(assigned.roof_report_confirmation.can_confirm, true);
  assertEquals(
    assigned.roof_report_confirmation.question,
    SES_TRADE_PORTAL_CONFIRMATION_QUESTION,
  );

  const manager = projectTradeMakesafeBoard(rows, {
    userId: "manager-not-on-the-job",
    role: "ops_manager",
    managedVerticals: ["makesafe"],
  }).rows[0];
  assertEquals(manager.roof_report_confirmation.offered, true);
  assertEquals(manager.roof_report_confirmation.can_confirm, false);
  assertEquals(manager.roof_report_confirmation.question, null);
});

Deno.test("the trade confirmation payload carries no client-identifying field", () => {
  const rows = buildCanonicalMakesafeRows([roofCard()], {
    portalCaptureRowsByJobId: {},
  });
  const projected = projectTradeMakesafeBoard(rows, {
    userId: TRADE_ID,
    role: "crew",
    managedVerticals: [],
  }).rows[0];
  const serialized = JSON.stringify(projected.roof_report_confirmation);
  for (
    const key of ["client_name", "client_phone", "client_email", "site_address"]
  ) {
    assert(!serialized.includes(key), key);
  }
  assertEquals(Object.keys(projected.roof_report_confirmation).sort(), [
    "applicable",
    "attendance_cycle_id",
    "can_confirm",
    "confirmed",
    "cycle_number",
    "offered",
    "producer",
    "question",
    "reason",
    "source_url",
  ]);
});

// ── The write path ──────────────────────────────────────────────────────────

type Recorded = { table: string; op: string; payload?: unknown };

function fakeClient(options: {
  job?: Record<string, unknown> | null;
  detail?: Record<string, unknown> | null;
  assignments?: Array<Record<string, unknown>>;
  ledger?: Array<Record<string, unknown>>;
  ledgerAfterCommit?: Array<Record<string, unknown>>;
  rpcError?: { message: string } | null;
}) {
  const recorded: Recorded[] = [];
  const rpcCalls: Array<Record<string, unknown>> = [];
  const readCalls: string[] = [];
  let ledgerReads = 0;
  const ledger = options.ledger ?? [];

  const builder = (table: string) => {
    const state: Record<string, unknown> = {};
    const chain: any = {
      select: (_columns?: string) => {
        readCalls.push(table);
        return chain;
      },
      eq: (column: string, value: unknown) => {
        state[column] = value;
        return chain;
      },
      order: () => chain,
      maybeSingle: () => {
        if (table === "jobs") {
          return Promise.resolve({ data: options.job ?? null, error: null });
        }
        if (table === "makesafe_job_details") {
          return Promise.resolve({ data: options.detail ?? null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      insert: (payload: unknown) => {
        recorded.push({ table, op: "insert", payload });
        return Promise.resolve({ data: null, error: null });
      },
      update: (payload: unknown) => {
        recorded.push({ table, op: "update", payload });
        return chain;
      },
      delete: () => {
        recorded.push({ table, op: "delete" });
        return chain;
      },
      then: (resolve: any) => {
        if (table === "job_assignments") {
          return resolve({ data: options.assignments ?? [], error: null });
        }
        if (table === "makesafe_portal_capture_revisions") {
          ledgerReads += 1;
          const rows = ledgerReads > 1 && options.ledgerAfterCommit
            ? options.ledgerAfterCommit
            : ledger;
          return resolve({ data: rows, error: null });
        }
        return resolve({ data: [], error: null });
      },
    };
    return chain;
  };

  return {
    recorded,
    rpcCalls,
    readCalls,
    from: (table: string) => builder(table),
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (options.rpcError) {
        return Promise.resolve({ data: null, error: options.rpcError });
      }
      const capture = (args as any).p_capture;
      return Promise.resolve({
        data: { id: "revision-new", ...capture },
        error: null,
      });
    },
  };
}

const LIVE_JOB = {
  id: JOB_ID,
  type: "makesafe",
  status: "scheduled",
  job_number: "SWMS-261019",
  metadata: { makesafe_job_family: "roof_report", external_ref: REF },
};
const LIVE_DETAIL = {
  job_id: JOB_ID,
  report_type: null,
  external_ref: REF,
  attendance_cycle_id: CYCLE_ID,
  cycle_number: 1,
  external_links: [{ kind: "builder_portal", label: "Portal", url: ROOF_URL }],
};

Deno.test("an assigned trade's tick records evidence with its producer and writes no stage", async () => {
  const client = fakeClient({
    job: LIVE_JOB,
    detail: LIVE_DETAIL,
    assignments: [{ id: "a1", status: "scheduled" }],
  });
  const result = await confirmSesRoofReportDone(client, {
    body: { job_id: JOB_ID },
    callerUserId: TRADE_ID,
    nowIso: "2026-08-02T04:00:00.000Z",
  });

  assertEquals(result.already_confirmed, false);
  assertEquals(result.stage_written, false);
  assertEquals(result.producer, SES_TRADE_PORTAL_CONFIRMATION_PRODUCER);
  assertEquals(result.question, SES_TRADE_PORTAL_CONFIRMATION_QUESTION);
  assertEquals(result.confirmed_by, TRADE_ID);
  assertEquals(result.attendance_cycle_id, CYCLE_ID);

  assertEquals(client.rpcCalls.length, 1);
  const capture = (client.rpcCalls[0].args as any).p_capture;
  assertEquals(
    capture.capture_producer,
    SES_TRADE_PORTAL_CONFIRMATION_PRODUCER,
  );
  assertEquals(capture.capture_result, "done");
  assertEquals(capture.status, "verified");
  assertEquals(capture.role, "roof_report");
  assertEquals(capture.job_id, JOB_ID);
  assertEquals(capture.attendance_cycle_id, CYCLE_ID);
  assertEquals(capture.captured_by, TRADE_ID);
  assertEquals(capture.screenshot_object_key, null);
  assert(/^sha256:[0-9a-f]{64}$/.test(capture.source_content_hash));
  assert(/^sha256:[0-9a-f]{64}$/.test(capture.makesafe_content_hash));

  // The ONLY table write is the additive audit event. No jobs row, no
  // makesafe_job_details row, no invoice, no send.
  assertEquals(client.recorded.map((entry) => `${entry.table}:${entry.op}`), [
    "job_events:insert",
  ]);
});

Deno.test("a trade who is not on the job cannot confirm, and nothing is read or written after the refusal", async () => {
  const client = fakeClient({
    job: LIVE_JOB,
    detail: LIVE_DETAIL,
    assignments: [],
  });
  const error = await assertRejects(
    () =>
      confirmSesRoofReportDone(client, {
        body: { job_id: JOB_ID },
        callerUserId: OTHER_TRADE_ID,
      }),
    SesRoofConfirmationError,
  );
  assertEquals(error.status, 403);
  assertEquals(error.code, "ses_roof_confirmation_forbidden");
  assertEquals(client.readCalls, ["jobs", "job_assignments"]);
  assertEquals(client.rpcCalls.length, 0);
  assertEquals(client.recorded.length, 0);
});

Deno.test("a cancelled assignment is not being on the job", async () => {
  const client = fakeClient({
    job: LIVE_JOB,
    detail: LIVE_DETAIL,
    assignments: [{ id: "a1", status: "cancelled" }],
  });
  const error = await assertRejects(
    () =>
      confirmSesRoofReportDone(client, {
        body: { job_id: JOB_ID },
        callerUserId: TRADE_ID,
      }),
    SesRoofConfirmationError,
  );
  assertEquals(error.status, 403);
  assertEquals(client.rpcCalls.length, 0);
});

Deno.test("a second tick is a no-op that answers the trade the same way the first did", async () => {
  const client = fakeClient({
    job: LIVE_JOB,
    detail: LIVE_DETAIL,
    assignments: [{ id: "a1", status: "scheduled" }],
    ledger: [attestationRow()],
  });
  const result = await confirmSesRoofReportDone(client, {
    body: { job_id: JOB_ID },
    callerUserId: OTHER_TRADE_ID,
  });
  assertEquals(result.already_confirmed, true);
  assertEquals(result.stage_written, false);
  assertEquals(result.confirmed_by, TRADE_ID);
  assertEquals(result.revision_id, "revision-1");
  assertEquals(client.rpcCalls.length, 0);
  assertEquals(client.recorded.length, 0);
});

Deno.test("a deterministic reader capture already satisfies completion, so the trade tick is a no-op too", async () => {
  const readerRow = attestationRow({
    id: "reader-revision",
    capture_producer: SES_PORTAL_CAPTURE_PRODUCER,
    captured_by: "chrome-agent@secureworks.test",
    screenshot_object_key:
      "makesafe-docket-artifacts/portal-captures/a/b/roof_report/c.png",
    screenshot_media_type: "image/png",
    screenshot_content_hash: `sha256:${"d".repeat(64)}`,
    screenshot_size_bytes: 1234,
  });
  const client = fakeClient({
    job: LIVE_JOB,
    detail: LIVE_DETAIL,
    assignments: [{ id: "a1", status: "scheduled" }],
    ledger: [readerRow],
  });
  const result = await confirmSesRoofReportDone(client, {
    body: { job_id: JOB_ID },
    callerUserId: TRADE_ID,
  });
  assertEquals(result.already_confirmed, true);
  assertEquals(client.rpcCalls.length, 0);
});

Deno.test("two trades ticking at once converge on one confirmation instead of an error", async () => {
  const client = fakeClient({
    job: LIVE_JOB,
    detail: LIVE_DETAIL,
    assignments: [{ id: "a1", status: "scheduled" }],
    ledger: [],
    ledgerAfterCommit: [attestationRow({ id: "winner" })],
    rpcError: { message: "portal capture idempotency conflict" },
  });
  const result = await confirmSesRoofReportDone(client, {
    body: { job_id: JOB_ID },
    callerUserId: OTHER_TRADE_ID,
  });
  assertEquals(result.already_confirmed, true);
  assertEquals(result.revision_id, "winner");
  assertEquals(result.confirmed_by, TRADE_ID);
});

Deno.test("a commit failure with no surviving confirmation is reported, not swallowed", async () => {
  const client = fakeClient({
    job: LIVE_JOB,
    detail: LIVE_DETAIL,
    assignments: [{ id: "a1", status: "scheduled" }],
    ledger: [],
    ledgerAfterCommit: [],
    rpcError: { message: "connection reset" },
  });
  const error = await assertRejects(
    () =>
      confirmSesRoofReportDone(client, {
        body: { job_id: JOB_ID },
        callerUserId: TRADE_ID,
      }),
    SesRoofConfirmationError,
  );
  assertEquals(error.code, "ses_roof_confirmation_commit_failed");
});

Deno.test("an assigned trade on a non-roof card is refused with a reason a human can act on", async () => {
  const client = fakeClient({
    job: { ...LIVE_JOB, metadata: { makesafe_job_family: "general_makesafe" } },
    detail: LIVE_DETAIL,
    assignments: [{ id: "a1", status: "scheduled" }],
  });
  const error = await assertRejects(
    () =>
      confirmSesRoofReportDone(client, {
        body: { job_id: JOB_ID },
        callerUserId: TRADE_ID,
      }),
    SesRoofConfirmationError,
  );
  assertEquals(error.status, 409);
  assertEquals(error.code, "ses_roof_confirmation_not_a_roof_card");
  assertEquals(client.rpcCalls.length, 0);
});

Deno.test("a roof card whose builder link never arrived is refused, and says so", async () => {
  const client = fakeClient({
    job: LIVE_JOB,
    detail: { ...LIVE_DETAIL, external_links: [] },
    assignments: [{ id: "a1", status: "scheduled" }],
  });
  const error = await assertRejects(
    () =>
      confirmSesRoofReportDone(client, {
        body: { job_id: JOB_ID },
        callerUserId: TRADE_ID,
      }),
    SesRoofConfirmationError,
  );
  assertEquals(error.code, "ses_roof_confirmation_no_portal_roof_link");
  assert(error.message.includes("no builder roof report link"));
});

Deno.test("the request body cannot supply role, url, cycle or confirming identity", async () => {
  const client = fakeClient({
    job: LIVE_JOB,
    detail: LIVE_DETAIL,
    assignments: [{ id: "a1", status: "scheduled" }],
  });
  await confirmSesRoofReportDone(client, {
    body: {
      job_id: JOB_ID,
      role: "assessment",
      source_url: "https://evil.example.com/share/anything",
      attendance_cycle_id: "00000000-0000-4000-8000-000000000000",
      captured_by: OTHER_TRADE_ID,
      builder_reference: "WB-99999",
      capture_result: "not_done",
      screenshot: { bytes_base64: "AAAA" },
    },
    callerUserId: TRADE_ID,
    nowIso: "2026-08-02T04:00:00.000Z",
  });
  const capture = (client.rpcCalls[0].args as any).p_capture;
  assertEquals(capture.role, "roof_report");
  assertEquals(capture.source_url, ROOF_URL);
  assertEquals(capture.attendance_cycle_id, CYCLE_ID);
  assertEquals(capture.captured_by, TRADE_ID);
  assertEquals(capture.builder_reference, REF);
  assertEquals(capture.capture_result, "done");
  assertEquals(capture.screenshot_object_key, null);
});

Deno.test("an unauthenticated caller is refused before any read", async () => {
  const client = fakeClient({ job: LIVE_JOB, detail: LIVE_DETAIL });
  const error = await assertRejects(
    () => confirmSesRoofReportDone(client, { body: { job_id: JOB_ID } }),
    SesRoofConfirmationError,
  );
  assertEquals(error.status, 401);
  assertEquals(client.readCalls, []);
  assertEquals(client.rpcCalls.length, 0);
});
