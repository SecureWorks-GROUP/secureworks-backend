// deno-lint-ignore-file no-import-prefix
//
// Restoration workflow rules (docs/restoration-workflow-v1.md). Pure: no
// client, no network. The money hand-off is proved against the REAL
// commercial-override builder, never a copy of its rules.
import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  approvedQuote,
  authorityLimitCheck,
  currentQuote,
  decideRestorationQuote,
  describeRestorationPlan,
  markRestorationQuoteSent,
  normaliseQuoteLines,
  readRestorationPlan,
  readRestorationScope,
  restorationInvoiceHandoff,
  type RestorationInvoiceHandoffContext,
  restorationBoardStatus,
  restorationPhase,
  type RestorationPlan,
  restorationPlanForStorage,
  restorationScopeText,
  RestorationWorkflowError,
  saveRestorationQuote,
  setRestorationPlan,
} from "./restoration_workflow.ts";
import { buildCommercialQuantityOverrideLines } from "./ses_commercial_quantity_override.ts";

const ACTOR = { label: "office@example.invalid", now: "2026-11-12T02:00:00.000Z" };
const LATER = { label: "office@example.invalid", now: "2026-11-13T02:00:00.000Z" };

// The scope wording of ML Builders' two live restoration work orders
// (MLR-41228 PO-64545 and MLB-40707 PO-64727, read 12 Nov 2026).
const ASSESS_SCOPE =
  "Allocation Work Order MLR-40001PO-60001 Restoration Restoration Please attend to inspect damage to the bedroom - Water started coming from under the carpet in a bedroom. Leak being repaired today 9/11.\nPlease provide a quote for structural drying (expected to be carpet removal/disposal, wall scrapes & drying equipment). Please cap drying equipment at 5 days.\nDAL (designated authority limit) - $1k for initial attendance.";
const DO_AND_CHARGE_SCOPE =
  "Allocation Work Order MLB-40002PO-60002 Restoration Restoration Please attend to remove the activity room cabinetry that is situated against a wet wall. If you can salvage it, please leave it on site. If it is damaged, please dispose of it.";

function freshPlan(scope: string): RestorationPlan {
  return readRestorationPlan({}, scope).plan;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof RestorationWorkflowError) return error.code;
    throw error;
  }
  return "no_error";
}

Deno.test("restoration scope: a request for a quote is assess and quote, with the builder's limits", () => {
  assertEquals(readRestorationScope(ASSESS_SCOPE), {
    mode: "assess_and_quote",
    authority_limit_ex_gst: 1000,
    equipment_day_cap: 5,
  });
});

Deno.test("restoration scope: an instruction to do the work is do and charge", () => {
  assertEquals(readRestorationScope(DO_AND_CHARGE_SCOPE), {
    mode: "do_and_charge",
    authority_limit_ex_gst: null,
    equipment_day_cap: null,
  });
  // The other live wording of the limit (MLB-28023).
  assertEquals(
    readRestorationScope(
      "Please attend site and carry out make safe remediation works for mould.\nThe delegated DAL limit for this claim is $1000.",
    ),
    {
      mode: "do_and_charge",
      authority_limit_ex_gst: 1000,
      equipment_day_cap: null,
    },
  );
  // No scope at all reads as the path that needs nothing extra.
  assertEquals(readRestorationScope(null).mode, "do_and_charge");
});

Deno.test("restoration plan: read off the work order until something is stored", () => {
  const derived = readRestorationPlan({ makesafe_job_family: "restoration" }, ASSESS_SCOPE);
  assertEquals(derived.stored, false);
  assertEquals(derived.plan.mode, "assess_and_quote");
  assertEquals(derived.plan.mode_source, "work_order_scope");
  assertEquals(derived.plan.authority_limit_ex_gst, 1000);
  assertEquals(restorationPhase(derived.plan), "assess");

  const set = setRestorationPlan(derived.plan, { mode: "do_and_charge" }, ACTOR);
  const stored = readRestorationPlan({ restoration: set }, ASSESS_SCOPE);
  assertEquals(stored.stored, true);
  // A person's choice outranks what the scope reads as.
  assertEquals(stored.plan.mode, "do_and_charge");
  assertEquals(stored.plan.mode_source, "operator");
  assertEquals(stored.plan.updated_by, "office@example.invalid");
});

Deno.test("restoration plan: a stored block this version cannot read is refused, never guessed around", () => {
  assertEquals(
    code(() => readRestorationPlan({ restoration: { version: "something-else", mode: "assess_and_quote" } }, ASSESS_SCOPE)),
    "restoration_plan_unreadable",
  );
  assertEquals(
    code(() =>
      readRestorationPlan({
        restoration: {
          version: "restoration-workflow/v1",
          mode: "assess_and_quote",
          quotes: [{ revision: 1, status: "approved", lines: [] }],
        },
      }, ASSESS_SCOPE)
    ),
    "restoration_plan_unreadable",
  );
});

Deno.test("restoration plan: setting the limit and the mode is validated", () => {
  const plan = freshPlan(DO_AND_CHARGE_SCOPE);
  assertEquals(
    setRestorationPlan(plan, { authority_limit_ex_gst: 1500 }, ACTOR).authority_limit_ex_gst,
    1500,
  );
  assertEquals(
    setRestorationPlan(freshPlan(ASSESS_SCOPE), { authority_limit_ex_gst: null }, ACTOR).authority_limit_ex_gst,
    null,
  );
  assertEquals(code(() => setRestorationPlan(plan, { mode: "quote_only" }, ACTOR)), "restoration_mode_invalid");
  assertEquals(code(() => setRestorationPlan(plan, { authority_limit_ex_gst: -5 }, ACTOR)), "authority_limit_invalid");
  assertEquals(code(() => setRestorationPlan(plan, { equipment_day_cap: 2.5 }, ACTOR)), "equipment_day_cap_invalid");
});

const DRYING_LINES = [
  { kind: "labour", description: "Remove and dispose of wet carpet and underlay, 2 trades", quantity: 6, unit: "hr", unit_price_ex_gst: 90 },
  { kind: "equipment", description: "Air movers x 3 and dehumidifier x 1", quantity: 5, unit: "day", unit_price_ex_gst: 180 },
  { kind: "disposal", description: "Tipping fee", quantity: 1, unit: "each", unit_price_ex_gst: 120 },
];

Deno.test("restoration quote: the server works out every total", () => {
  const lines = normaliseQuoteLines([
    { ...DRYING_LINES[0], line_total_ex_gst: 1 },
    DRYING_LINES[1],
    DRYING_LINES[2],
  ]);
  assertEquals(lines.map((line) => line.line_total_ex_gst), [540, 900, 120]);
  const saved = saveRestorationQuote(freshPlan(ASSESS_SCOPE), { lines: DRYING_LINES }, "SWMS-261999", ACTOR);
  assertEquals(saved.quote.quote_number, "SWMS-261999-Q1");
  assertEquals(saved.quote.subtotal_ex_gst, 1560);
  assertEquals(saved.quote.gst, 156);
  assertEquals(saved.quote.total_inc_gst, 1716);
  assertEquals(saved.quote.status, "draft");
  assertEquals(restorationPhase(saved.plan), "quote_drafted");
});

Deno.test("restoration quote: bad lines are refused by name", () => {
  const plan = freshPlan(ASSESS_SCOPE);
  const save = (lines: unknown) => code(() => saveRestorationQuote(plan, { lines }, "SWMS-1", ACTOR));
  assertEquals(save([]), "quote_lines_required");
  assertEquals(save([{ kind: "labour", description: "", quantity: 1, unit_price_ex_gst: 90 }]), "quote_line_invalid");
  assertEquals(save([{ kind: "labour", description: "x", quantity: 0, unit_price_ex_gst: 90 }]), "quote_line_invalid");
  assertEquals(save([{ kind: "labour", description: "x", quantity: 1, unit_price_ex_gst: -1 }]), "quote_line_invalid");
  assertEquals(save([{ kind: "magic", description: "x", quantity: 1, unit_price_ex_gst: 1 }]), "quote_line_invalid");
  assertEquals(save([{ kind: "labour", description: "x", quantity: 1, unit_price_ex_gst: 0 }]), "quote_total_zero");
});

Deno.test("restoration quote: a draft is edited in place; a sent quote is never rewritten", () => {
  const first = saveRestorationQuote(freshPlan(ASSESS_SCOPE), { lines: DRYING_LINES }, "SWMS-261999", ACTOR);
  const edited = saveRestorationQuote(first.plan, { lines: DRYING_LINES.slice(0, 2) }, "SWMS-261999", ACTOR);
  assertEquals(edited.plan.quotes.length, 1);
  assertEquals(edited.quote.revision, 1);
  assertEquals(edited.quote.subtotal_ex_gst, 1440);

  const sent = markRestorationQuoteSent(edited.plan, { revision: 1, sent_to: "coordinator@builder.example" }, ACTOR);
  assertEquals(sent.quote.status, "sent");
  assertEquals(restorationPhase(sent.plan), "awaiting_approval");

  const revised = saveRestorationQuote(sent.plan, { lines: DRYING_LINES }, "SWMS-261999", LATER);
  assertEquals(revised.plan.quotes.length, 2);
  assertEquals(revised.quote.quote_number, "SWMS-261999-Q2");
  // The quote the builder saw is exactly as it was.
  assertEquals(revised.plan.quotes[0].subtotal_ex_gst, 1440);
  assertEquals(revised.plan.quotes[0].status, "sent");
});

Deno.test("restoration quote: an approval needs a named person and where it can be read", () => {
  const saved = saveRestorationQuote(freshPlan(ASSESS_SCOPE), { lines: DRYING_LINES }, "SWMS-261999", ACTOR);
  const decide = (input: Record<string, unknown>) => code(() => decideRestorationQuote(saved.plan, { revision: 1, ...input }, ACTOR));
  assertEquals(decide({ decision: "maybe" }), "quote_decision_invalid");
  assertEquals(decide({ decision: "approved" }), "quote_decision_needs_person");
  assertEquals(decide({ decision: "approved", decided_by: "Builder Coordinator" }), "quote_decision_needs_evidence");
  assertEquals(
    code(() => decideRestorationQuote(saved.plan, { revision: 7, decision: "approved", decided_by: "x", evidence_ref: "y" }, ACTOR)),
    "quote_revision_stale",
  );
  assertEquals(
    code(() => decideRestorationQuote(saved.plan, { decision: "approved", decided_by: "x", evidence_ref: "y" }, ACTOR)),
    "quote_revision_required",
  );
  assertEquals(
    code(() => decideRestorationQuote(freshPlan(ASSESS_SCOPE), { revision: 1, decision: "approved", decided_by: "x", evidence_ref: "y" }, ACTOR)),
    "quote_missing",
  );

  const approved = decideRestorationQuote(saved.plan, {
    revision: 1,
    decision: "approved",
    decided_by: "Builder Coordinator",
    evidence_kind: "email",
    evidence_ref: "Re: MLR-40001 quote, 12 Nov 2026 3:03pm",
  }, LATER);
  assertEquals(approved.quote.status, "approved");
  assertEquals(approved.quote.decision?.recorded_by, "office@example.invalid");
  // A decision on a quote nobody marked as sent still records that it went.
  assert(approved.quote.sent);
  assertEquals(restorationPhase(approved.plan), "approved_works");
  assertEquals(approvedQuote(approved.plan)?.quote_number, "SWMS-261999-Q1");

  // Recording the same decision again changes nothing; the opposite is refused.
  const again = decideRestorationQuote(approved.plan, { revision: 1, decision: "approved", decided_by: "x", evidence_ref: "y" }, LATER);
  assert(again.plan === approved.plan);
  assertEquals(
    code(() => decideRestorationQuote(approved.plan, { revision: 1, decision: "declined", decided_by: "x" }, LATER)),
    "quote_already_decided",
  );
});

Deno.test("restoration quote: an approved quote stands until the builder approves its revision", () => {
  const saved = saveRestorationQuote(freshPlan(ASSESS_SCOPE), { lines: DRYING_LINES }, "SWMS-261999", ACTOR);
  const approved = decideRestorationQuote(saved.plan, { revision: 1, decision: "approved", decided_by: "Builder Coordinator", evidence_ref: "email 12 Nov" }, ACTOR);
  assertEquals(
    code(() => saveRestorationQuote(approved.plan, { lines: DRYING_LINES }, "SWMS-261999", LATER)),
    "quote_already_approved",
  );
  const extra = [...DRYING_LINES, { kind: "equipment", description: "Two further drying days", quantity: 2, unit: "day", unit_price_ex_gst: 180 }];
  const revised = saveRestorationQuote(approved.plan, { lines: extra, revise_approved: true }, "SWMS-261999", LATER);
  assertEquals(currentQuote(revised.plan)?.revision, 2);
  // Revision 2 is only a draft: revision 1 is still what may be invoiced.
  assertEquals(approvedQuote(revised.plan)?.revision, 1);
  assertEquals(restorationPhase(revised.plan), "approved_works");
  const declined = decideRestorationQuote(revised.plan, { revision: 2, decision: "declined", decided_by: "Builder Coordinator" }, LATER);
  assertEquals(approvedQuote(declined.plan)?.revision, 1);
  assertEquals(restorationPhase(declined.plan), "approved_works");
});

Deno.test("restoration quote: a declined first quote leaves nothing approved", () => {
  const saved = saveRestorationQuote(freshPlan(ASSESS_SCOPE), { lines: DRYING_LINES }, "SWMS-261999", ACTOR);
  const declined = decideRestorationQuote(saved.plan, { revision: 1, decision: "declined", decided_by: "Builder Coordinator" }, ACTOR);
  assertEquals(restorationPhase(declined.plan), "declined");
  assertEquals(approvedQuote(declined.plan), null);
  const described = describeRestorationPlan(declined.plan, true);
  assertEquals(described.phase_label, "Quote declined");
  assertEquals(described.approved_quote_number, null);
});

// The live shape of the first approved restoration quote (MLB-40707, 11 Nov
// 2026): 1 trade x 4 hours at $110 an hour plus a $120 tipping fee, $560 ex GST.
const CABINETRY_LINES = [
  { kind: "labour", description: "Remove activity room cabinetry, 1 trade x 4 hours", quantity: 4, unit: "hr", unit_price_ex_gst: 110 },
  { kind: "disposal", description: "Tipping fee", quantity: 1, unit: "each", unit_price_ex_gst: 120 },
];

function approvedPlan(lines: unknown): RestorationPlan {
  const saved = saveRestorationQuote(freshPlan(DO_AND_CHARGE_SCOPE), { lines }, "SWMS-261998", ACTOR);
  return decideRestorationQuote(saved.plan, {
    revision: 1,
    decision: "approved",
    decided_by: "Builder Coordinator",
    evidence_ref: "Re: MLB-40002 / PO-60002 revised quote, 11 Nov 2026",
  }, ACTOR).plan;
}

const DOCKET: RestorationInvoiceHandoffContext = {
  job_number: "SWMS-261998",
  sealed_labour_rate_ex_gst: 90,
  sealed_billable_hours_floor: 3,
  trade_reported_hours_per_trade: 4,
  authorised_by: "Office Person",
  now: "2026-11-13T03:00:00.000Z",
};

Deno.test("restoration hand-off: the approved quote becomes the staff-locked figure the invoice path already accepts", () => {
  const handoff = restorationInvoiceHandoff(approvedPlan(CABINETRY_LINES), DOCKET);
  assert(handoff.ready);
  assertEquals(handoff.total_ex_gst, 560);
  const override = handoff.commercial_quantity_override;
  assertEquals(override.authority_kind, "staff_lock");
  assertEquals(override.decision_key, "restoration-quote:SWMS-261998:r1");
  assertEquals(override.labour_rate_override, {
    sealed_unit_price_ex_gst: 90,
    authorised_unit_price_ex_gst: 110,
    reason: override.labour_rate_override!.reason,
  });
  assert(override.reason.includes("Builder Coordinator"));
  // The REAL builder accepts it and prices exactly the quote: no second
  // copy of its rules lives here.
  const built = buildCommercialQuantityOverrideLines({
    override,
    docket_revision_id: "docket-1",
    attendance_cycle_ids: ["cycle-1"],
    sealed_labour_unit_price_ex_gst: 90,
    builder_reference: "MLB-40002PO-60002",
  });
  assertEquals(
    built.lines.map((line) => [line.description, line.quantity, line.unit_price]),
    [
      ["Remove activity room cabinetry, 1 trade x 4 hours", 4, 110],
      ["Tipping fee", 1, 120],
    ],
  );
  assertEquals(built.lines.reduce((sum, line) => sum + line.quantity * line.unit_price, 0), 560);
  assertEquals(built.provenance.override_kind, "commercial_rate_override");
  assert(built.lines.every((line) => line.rate_override_approved === true && line.rate_override_by === "Office Person"));
});

Deno.test("restoration hand-off: labour at the sealed rate carries no rate override", () => {
  const handoff = restorationInvoiceHandoff(approvedPlan(DRYING_LINES), DOCKET);
  assert(handoff.ready);
  assertEquals(handoff.commercial_quantity_override.labour_rate_override, undefined);
  const built = buildCommercialQuantityOverrideLines({
    override: handoff.commercial_quantity_override,
    docket_revision_id: "docket-1",
    attendance_cycle_ids: ["cycle-1"],
    sealed_labour_unit_price_ex_gst: 90,
    builder_reference: "MLR-40001PO-60001",
  });
  assertEquals(built.provenance.override_kind, "commercial_quantity_not_rate");
  // Equipment and disposal ride as non-labour lines, word for word.
  assertEquals(built.lines.map((line) => line.evidence.line_kind), ["labour", "materials", "materials"]);
});

Deno.test("restoration hand-off: a quote the instrument cannot carry is refused with the reason, never bent", () => {
  const notReady = (plan: RestorationPlan, context = DOCKET) => {
    const handoff = restorationInvoiceHandoff(plan, context);
    assert(!handoff.ready);
    return handoff.code;
  };
  assertEquals(notReady(freshPlan(ASSESS_SCOPE)), "no_approved_quote");
  // Saved and sent is not approved.
  const saved = saveRestorationQuote(freshPlan(ASSESS_SCOPE), { lines: DRYING_LINES }, "SWMS-1", ACTOR);
  assertEquals(notReady(markRestorationQuoteSent(saved.plan, { revision: 1 }, ACTOR).plan), "no_approved_quote");
  assertEquals(
    notReady(approvedPlan([{ kind: "equipment", description: "Drying equipment, lump sum", quantity: 1, unit_price_ex_gst: 900 }])),
    "quote_has_no_labour_line",
  );
  assertEquals(
    notReady(approvedPlan([
      { kind: "labour", description: "Day labour", quantity: 2, unit_price_ex_gst: 90 },
      { kind: "labour", description: "After hours labour", quantity: 2, unit_price_ex_gst: 110 },
    ])),
    "quote_labour_rates_differ",
  );
  assertEquals(
    notReady(approvedPlan(CABINETRY_LINES), { ...DOCKET, sealed_labour_rate_ex_gst: null }),
    "docket_not_prepared",
  );
  assertEquals(
    notReady(approvedPlan(CABINETRY_LINES), { ...DOCKET, authorised_by: " " }),
    "authorised_by_required",
  );
});

Deno.test("restoration authority limit: it reports beside the first invoice and never prices", () => {
  const plan = freshPlan(ASSESS_SCOPE);
  assertEquals(authorityLimitCheck(plan, null).status, "not_priced");
  assertEquals(authorityLimitCheck(plan, 270).status, "within_limit");
  assertEquals(authorityLimitCheck(plan, 1000).status, "within_limit");
  const over = authorityLimitCheck(plan, 1260);
  assertEquals(over.status, "over_limit");
  assert(over.note.includes("$1000"));
  assertEquals(authorityLimitCheck(freshPlan(DO_AND_CHARGE_SCOPE), 5000).status, "no_limit");
  // Once a quote is approved, the limit no longer caps the quoted works.
  assertEquals(authorityLimitCheck(approvedPlan(DRYING_LINES), 1560).status, "no_limit");
  const limited = setRestorationPlan(approvedPlan(DRYING_LINES), { authority_limit_ex_gst: 1000 }, ACTOR);
  assertEquals(authorityLimitCheck(limited, 1560).status, "within_limit");
});

Deno.test("restoration plan: every refusal is the module's own error with a status", () => {
  const error = assertThrows(
    () => saveRestorationQuote(freshPlan(ASSESS_SCOPE), { lines: "nope" }, "SWMS-1", ACTOR),
    RestorationWorkflowError,
  );
  assertEquals(error.status, 400);
  assertEquals(error.code, "quote_lines_required");
});

// The board card reads the PRICE-FREE record the job carries
// (restorationPlanForStorage), never the priced quote document.
function storedMetadata(plan: RestorationPlan): Record<string, unknown> {
  const hashes = new Map(plan.quotes.map((quote) => [quote.revision, `sha256:${quote.revision}`]));
  return { restoration: restorationPlanForStorage(plan, hashes) };
}

Deno.test("restoration board card: a sent quote reads as waiting on the builder, with no money", () => {
  const saved = saveRestorationQuote(freshPlan(ASSESS_SCOPE), { lines: DRYING_LINES }, "SWMS-261709", ACTOR);
  const sent = markRestorationQuoteSent(saved.plan, { revision: 1, sent_to: "coordinator@builder.example" }, LATER);
  const status = restorationBoardStatus(storedMetadata(sent.plan), "");
  assertEquals(status, {
    version: "restoration-workflow/v1",
    readable: true,
    reason: null,
    stored: true,
    mode: "assess_and_quote",
    phase: "awaiting_approval",
    phase_label: "Quote with builder",
    next_step: "Quote SWMS-261709-Q1 is with the builder. Do not start the quoted works until their approval is recorded.",
    quote_number: "SWMS-261709-Q1",
    quote_status: "sent",
    quote_sent_at: LATER.now,
    approved_quote_number: null,
  });
  // Same phase and next step as the priced read.
  const described = describeRestorationPlan(sent.plan, true);
  assertEquals(status.phase, described.phase);
  assertEquals(status.next_step, described.next_step);
  // Nothing priced reaches the card: no dollar figure, no total, no limit.
  const json = JSON.stringify(status);
  assert(!/\$|total|subtotal|gst|limit|price|lines|pdf/i.test(json), json);
});

Deno.test("restoration board card: every phase comes from the one phase rule", () => {
  // Nothing stored: the mode is read off the work order.
  assertEquals(restorationBoardStatus({}, ASSESS_SCOPE).phase, "assess");
  assertEquals(restorationBoardStatus({}, DO_AND_CHARGE_SCOPE).phase, "attend_and_charge");
  assertEquals(restorationBoardStatus(null, DO_AND_CHARGE_SCOPE).stored, false);
  const saved = saveRestorationQuote(freshPlan(ASSESS_SCOPE), { lines: DRYING_LINES }, "SWMS-261709", ACTOR);
  assertEquals(restorationBoardStatus(storedMetadata(saved.plan), "").phase, "quote_drafted");
  const approved = decideRestorationQuote(saved.plan, { revision: 1, decision: "approved", decided_by: "Builder Coordinator", evidence_ref: "email 12 Nov" }, LATER);
  const approvedStatus = restorationBoardStatus(storedMetadata(approved.plan), "");
  assertEquals(approvedStatus.phase, "approved_works");
  assertEquals(approvedStatus.approved_quote_number, "SWMS-261709-Q1");
  const declined = decideRestorationQuote(saved.plan, { revision: 1, decision: "declined", decided_by: "Builder Coordinator" }, LATER);
  assertEquals(restorationBoardStatus(storedMetadata(declined.plan), "").phase, "declined");
});

Deno.test("restoration board card: a record this version cannot read is reported, never thrown", () => {
  const status = restorationBoardStatus({ restoration: { version: "restoration-workflow/v9", mode: "assess_and_quote" } }, "");
  assertEquals(status.readable, false);
  assertEquals(status.reason, "restoration_plan_unreadable");
  assertEquals(status.phase, null);
  const badQuote = restorationBoardStatus({
    restoration: { version: "restoration-workflow/v1", mode: "assess_and_quote", quotes: [{ revision: 1, status: "lost" }] },
  }, "");
  assertEquals(badQuote.readable, false);
});

Deno.test("restoration scope text: notes and both special instructions, in that order", () => {
  assertEquals(
    restorationScopeText(
      { notes: " a ", metadata: { special_instructions: "b" } },
      { special_instructions: "c" },
    ),
    "a\nb\nc",
  );
  assertEquals(restorationScopeText(null, null), "");
});
