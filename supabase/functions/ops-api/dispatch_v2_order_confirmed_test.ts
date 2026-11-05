// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch v2 Tweak 1 (Shaun, 4 Nov 2026): what happens once a supplier order
// is confirmed. Contract: docs/dispatch-v2-board-contract.md, section 3e.
// Rules: dispatch_v2_order_confirmed.ts. Writer:
// dispatch_v2_order_confirmed_write.ts. The hooks in the stage and date
// presses are tested here too, against an in-memory PostgREST stand-in
// (dispatch_v2_order_confirmed_test_fakes.ts) that keeps the migrations'
// unique keys.
//
// Nothing is sent and nothing touches production. Job, client and supplier
// details are made up.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dispatchCrewLineDecision,
  dispatchCrewLineRef,
  dispatchCrewLineText,
  dispatchCrewLineWhen,
  dispatchOrderBranchOf,
} from "./dispatch_v2_order_confirmed.ts";
import {
  type DispatchOrderConfirmedDeps,
  type DispatchOrderConfirmedInput,
  runDispatchV2OrderConfirmed,
} from "./dispatch_v2_order_confirmed_write.ts";
import {
  DISPATCH_V2_SET_MATERIAL_STAGE_ACTION,
  runDispatchV2MaterialStageAction,
} from "./dispatch_v2_material_stage_write.ts";
import {
  DISPATCH_V2_SET_DELIVERY_DATE_ACTION,
  runDispatchV2DeliveryDateAction,
} from "./dispatch_v2_delivery_date.ts";
import { makeFakeClient, type Row } from "./dispatch_v2_order_confirmed_test_fakes.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000ee";
const JOB = "a1000000-0000-4000-8000-000000000001";
const SUP = {
  stratco: "b1000000-0000-4000-8000-000000000001",
  rr: "b1000000-0000-4000-8000-000000000002",
  fw: "b1000000-0000-4000-8000-000000000003",
};
const BOX = {
  stratco: "c1000000-0000-4000-8000-000000000001",
  rr: "c1000000-0000-4000-8000-000000000002",
  fw: "c1000000-0000-4000-8000-000000000003",
};
const ORDER = {
  stratco: "e1000000-0000-4000-8000-000000000001",
  stratcoOld: "e1000000-0000-4000-8000-000000000009",
  rr: "e1000000-0000-4000-8000-000000000002",
  fw: "e1000000-0000-4000-8000-000000000003",
};
const SHAUN = {
  userId: "d1000000-0000-4000-8000-000000000001",
  email: "shaun@ops.test",
};

const STRATCO_BODY =
  "Hi Team, could we please order the following for pickup from Neerabup:\n\n10 x 6.1m Lengths of 76 x 38\nColour: Surfmist\n\nDate: 3 November 2026\n";
const RR_BODY =
  "Hi Team, could we please order the following for delivery:\n\n20 x Sleepers\n\nDate: 2 November 2026\n";
const FW_BODY =
  "Hi Team, could we please order the following for pickup:\n\n5 x Posts\n\nDate: ASAP\n";

// ── The rules ───────────────────────────────────────────────────────────────

Deno.test("branch: only 'pickup from <place>' on the opening line counts", () => {
  assertEquals(dispatchOrderBranchOf(STRATCO_BODY), "Neerabup");
  assertEquals(
    dispatchOrderBranchOf("Could we order for pick up from the Malaga branch."),
    "Malaga",
  );
  assertEquals(dispatchOrderBranchOf("Please collect from O'Connor:"), "O'Connor");
  assertEquals(dispatchOrderBranchOf(FW_BODY), null);
  assertEquals(dispatchOrderBranchOf(RR_BODY), null);
  // A later line saying it does not count: the order builder writes line 1.
  assertEquals(
    dispatchOrderBranchOf("Hi Team, for pickup:\n\nPickup from Neerabup please"),
    null,
  );
  // The rest of a long sentence is not a branch.
  assertEquals(
    dispatchOrderBranchOf(
      "for pickup from whichever of your yards has the most stock on the day please",
    ),
    null,
  );
  assertEquals(dispatchOrderBranchOf(null), null);
});

Deno.test("line text: Shaun's three examples, and a moved date", () => {
  assertEquals(
    dispatchCrewLineText({
      kind: "confirmed",
      supplier: "Stratco",
      fulfilment: "pickup",
      when: { kind: "date", date: "2026-11-03" },
      branch: "Neerabup",
      ref: "123456",
    }),
    "Stratco pickup Tue 3 Nov · from Neerabup · ref 123456",
  );
  assertEquals(
    dispatchCrewLineText({
      kind: "confirmed",
      supplier: "R&R",
      fulfilment: "delivery",
      when: { kind: "date", date: "2026-11-02" },
    }),
    "R&R delivery Mon 2 Nov",
  );
  assertEquals(
    dispatchCrewLineText({
      kind: "confirmed",
      supplier: "Fencing Warehouse",
      fulfilment: "pickup",
      when: { kind: "asap" },
    }),
    "Fencing Warehouse pickup ASAP",
  );
  assertEquals(
    dispatchCrewLineText({
      kind: "moved",
      supplier: "Stratco",
      fulfilment: "pickup",
      when: { kind: "date", date: "2026-11-05" },
      branch: "Neerabup",
      ref: "123456",
    }),
    "Stratco pickup moved to Thu 5 Nov",
  );
  assertEquals(
    dispatchCrewLineText({
      kind: "confirmed",
      supplier: "Metroll",
      fulfilment: "delivery",
      when: { kind: "none" },
    }),
    "Metroll delivery no date yet",
  );
});

Deno.test("line date: the box's own date for this order, else the date asked for, else ASAP", () => {
  const order = {
    sent_at: "2026-11-01T02:00:00Z",
    delivery_date: "2026-11-03",
    body_text: STRATCO_BODY,
  };
  assertEquals(
    dispatchCrewLineWhen({
      box: { delivery_date: "2026-11-05", delivery_date_set_at: "2026-11-02T00:00:00Z" },
      order,
    }),
    { kind: "date", date: "2026-11-05" },
  );
  // A box date set before this order went belongs to an earlier order.
  assertEquals(
    dispatchCrewLineWhen({
      box: { delivery_date: "2026-10-20", delivery_date_set_at: "2026-10-19T00:00:00Z" },
      order,
    }),
    { kind: "date", date: "2026-11-03" },
  );
  assertEquals(
    dispatchCrewLineWhen({
      box: null,
      order: { sent_at: order.sent_at, delivery_date: null, body_text: FW_BODY },
    }),
    { kind: "asap" },
  );
  assertEquals(
    dispatchCrewLineWhen({
      box: null,
      order: { sent_at: order.sent_at, delivery_date: null, body_text: "Hi\nDate: \n" },
    }),
    { kind: "none" },
  );
});

Deno.test("line decision: once, then only for a new day", () => {
  const date = (d: string) => ({ kind: "date" as const, date: d });
  assertEquals(dispatchCrewLineDecision({ previous: null, when: date("2026-11-03") }), "confirmed");
  assertEquals(dispatchCrewLineDecision({ previous: null, when: { kind: "asap" } }), "confirmed");
  // A by-hand date press never writes the first line.
  assertEquals(
    dispatchCrewLineDecision({ previous: null, when: date("2026-11-03"), followUpOnly: true }),
    null,
  );
  assertEquals(
    dispatchCrewLineDecision({ previous: { line_date: "2026-11-03" }, when: date("2026-11-03") }),
    null,
  );
  assertEquals(
    dispatchCrewLineDecision({ previous: { line_date: "2026-11-03" }, when: date("2026-11-05") }),
    "moved",
  );
  // ASAP, then a day lands: the full line, so the crew gets branch and ref.
  assertEquals(
    dispatchCrewLineDecision({ previous: { line_date: null }, when: date("2026-11-05") }),
    "confirmed",
  );
  // A cleared date is not news for the yard.
  assertEquals(
    dispatchCrewLineDecision({ previous: { line_date: "2026-11-03" }, when: { kind: "asap" } }),
    null,
  );
});

Deno.test("ref: the first reference found, in the order given", () => {
  assertEquals(dispatchCrewLineRef([null, [], ["123456", "999"], "777"]), "123456");
  assertEquals(dispatchCrewLineRef([undefined, "  ", "W207774"]), "W207774");
  assertEquals(dispatchCrewLineRef([]), null);
});

// ── The writer ──────────────────────────────────────────────────────────────

function fixture(): Record<string, Row[]> {
  const box = (id: string, supplierId: string, name: string, extra: Row = {}) => ({
    id,
    org_id: ORG,
    job_id: JOB,
    supplier_id: supplierId,
    supplier_name: name,
    position: 0,
    created_at: "2026-10-30T00:00:00Z",
    delivery_date: null,
    delivery_date_source: null,
    delivery_date_set_at: null,
    delivery_date_set_by_email: null,
    delivery_date_confirmed_at: null,
    delivery_date_confirmed_by: null,
    delivery_date_confirmed_by_email: null,
    material_stage: null,
    material_stage_set_at: null,
    material_stage_set_by_email: null,
    ...extra,
  });
  const order = (id: string, supplierId: string, name: string, extra: Row) => ({
    id,
    org_id: ORG,
    job_id: JOB,
    supplier_id: supplierId,
    supplier_name: name,
    status: "sent",
    sent_at: "2026-11-01T02:00:00Z",
    delivery_date: null,
    body_text: "",
    order_lines: [],
    subject: `Material Order Ref SWP-90001`,
    ...extra,
  });
  return {
    jobs: [{
      id: JOB,
      org_id: ORG,
      type: "patio",
      status: "awaiting_supplier",
      job_number: "SWP-90001",
      client_name: "Test Person",
      site_suburb: "Balcatta",
      ds_ses_family: null,
      ds_makesafe_family: null,
      ds_repair_stage: null,
    }],
    users: [{ id: SHAUN.userId, email: SHAUN.email, org_id: ORG }],
    job_material_suppliers: [
      box(BOX.stratco, SUP.stratco, "Stratco"),
      box(BOX.rr, SUP.rr, "R&R"),
      box(BOX.fw, SUP.fw, "Fencing Warehouse"),
    ],
    dispatch_supplier_order_emails: [
      order(ORDER.stratcoOld, SUP.stratco, "Stratco", {
        sent_at: "2026-10-20T02:00:00Z",
        delivery_date: "2026-10-22",
        body_text: STRATCO_BODY,
      }),
      order(ORDER.stratco, SUP.stratco, "Stratco", {
        delivery_date: "2026-11-03",
        body_text: STRATCO_BODY,
      }),
      order(ORDER.rr, SUP.rr, "R&R", {
        delivery_date: "2026-11-02",
        body_text: RR_BODY,
      }),
      order(ORDER.fw, SUP.fw, "Fencing Warehouse", { body_text: FW_BODY }),
    ],
    dispatch_v2_order_crew_lines: [],
    dispatch_v2_supplier_order_refs: [],
    dispatch_v2_supplier_emails: [],
    job_events: [],
  };
}

const UNIQUE = {
  dispatch_v2_order_crew_lines: [["order_id", "seq"]],
};

function setup(options: Parameters<typeof makeFakeClient>[1] = {}) {
  const fake = makeFakeClient(fixture(), { unique: UNIQUE, ...options });
  const notes: Array<{ jobId: string; text: string; userId: string | null }> = [];
  let failNotes = false;
  const deps: DispatchOrderConfirmedDeps = {
    writeNote: (input) => {
      if (failNotes) return Promise.reject(new Error("job_events is down"));
      notes.push(input);
      // What add_note writes (index.ts addNote): an internal Office note.
      const row = {
        id: `9e000000-0000-4000-8000-${String(notes.length).padStart(12, "0")}`,
        job_id: input.jobId,
        user_id: input.userId,
        event_type: "note",
        detail_json: {
          text: input.text,
          visibility: "internal_only",
          sync_to_ghl: false,
          from_ops: true,
        },
      };
      fake.tables.job_events.push(row);
      return Promise.resolve({ id: row.id });
    },
  };
  const confirm = (input: Partial<DispatchOrderConfirmedInput>) =>
    runDispatchV2OrderConfirmed(fake.client, {
      orgId: ORG,
      jobId: JOB,
      supplierId: SUP.stratco,
      trigger: "stage_set",
      operator: SHAUN,
      ...input,
    }, deps);
  return {
    ...fake,
    notes,
    deps,
    confirm,
    failNotes: (v: boolean) => (failNotes = v),
  };
}

Deno.test("writer: Order confirmed by hand writes the Stratco pickup line once", async () => {
  const t = setup();
  const r = await t.confirm({});
  assertEquals(r.crew_line, {
    written: true,
    kind: "confirmed",
    text: "Stratco pickup Tue 3 Nov · from Neerabup",
    order_id: ORDER.stratco,
    job_event_id: t.tables.job_events[0].id,
  });
  assertEquals(t.notes, [{
    jobId: JOB,
    text: "Stratco pickup Tue 3 Nov · from Neerabup",
    userId: SHAUN.userId,
  }]);
  const [line] = t.tables.dispatch_v2_order_crew_lines;
  assertEquals(
    [line.seq, line.line_kind, line.line_date, line.branch, line.trigger, line.job_event_id],
    [1, "confirmed", "2026-11-03", "Neerabup", "stage_set", t.tables.job_events[0].id],
  );
  // The note is internal: never client-visible, never synced to GHL.
  assertEquals(t.tables.job_events[0].detail_json.visibility, "internal_only");
  assertEquals(t.tables.job_events[0].detail_json.sync_to_ghl, false);
  assertEquals(t.tables.job_events[0].detail_json.from_ops, true);

  // Pressed again (or Accept after the stage): nothing new for the crew.
  const again = await t.confirm({ trigger: "accept", orderId: ORDER.stratco });
  assertEquals(again.crew_line, {
    written: false,
    reason: "no_change",
    order_id: ORDER.stratco,
  });
  assertEquals(t.notes.length, 1);
});

Deno.test("writer: the reference comes from the accepted reply first, then the order's saved refs", async () => {
  const t = setup();
  t.tables.dispatch_v2_supplier_order_refs.push({
    id: "r1",
    org_id: ORG,
    order_id: ORDER.stratco,
    ref: "555000",
    created_at: "2026-11-01T05:00:00Z",
  });
  t.tables.dispatch_v2_supplier_emails.push({
    id: "f2000000-0000-4000-8000-000000000001",
    org_id: ORG,
    order_id: ORDER.stratco,
    state: "matched",
    supplier_refs: ["123456"],
    received_at: "2026-11-01T06:00:00Z",
  });
  const r = await t.confirm({
    trigger: "accept",
    orderId: ORDER.stratco,
    acceptedEmailId: "f2000000-0000-4000-8000-000000000001",
  });
  assertEquals(
    (r.crew_line as any).text,
    "Stratco pickup Tue 3 Nov · from Neerabup · ref 123456",
  );

  // No accepted reply: the ref the matcher saved on the order.
  const t2 = setup();
  t2.tables.dispatch_v2_supplier_order_refs.push({
    id: "r1",
    org_id: ORG,
    order_id: ORDER.stratco,
    ref: "555000",
    created_at: "2026-11-01T05:00:00Z",
  });
  const r2 = await t2.confirm({});
  assertEquals((r2.crew_line as any).text, "Stratco pickup Tue 3 Nov · from Neerabup · ref 555000");

  // A reply waiting for a person to confirm the guess does not count.
  const t3 = setup();
  t3.tables.dispatch_v2_supplier_emails.push({
    id: "x",
    org_id: ORG,
    order_id: ORDER.stratco,
    state: "needs_confirmation",
    supplier_refs: ["2882092"],
    received_at: "2026-11-01T06:00:00Z",
  });
  const r3 = await t3.confirm({});
  assertEquals((r3.crew_line as any).text, "Stratco pickup Tue 3 Nov · from Neerabup");
});

Deno.test("writer (Tweak 4): the crew line names the approved supplier (RnR Fencing), not the Xero contact", async () => {
  const t = setup();
  t.tables.dispatch_approved_supplier_emails = [
    { id: "e-rr", org_id: ORG, name: "RnR Fencing", active: true },
  ];
  t.tables.dispatch_approved_supplier_email_links = [
    { supplier_id: SUP.rr, approved_id: "e-rr", org_id: ORG },
  ];
  const rr = await t.confirm({ supplierId: SUP.rr });
  assertEquals((rr.crew_line as any).text, "RnR Fencing delivery Mon 2 Nov");
  // A retired approved entry: the order's own name, as before.
  const t2 = setup();
  t2.tables.dispatch_approved_supplier_emails = [
    { id: "e-rr", org_id: ORG, name: "RnR Fencing", active: false },
  ];
  t2.tables.dispatch_approved_supplier_email_links = [
    { supplier_id: SUP.rr, approved_id: "e-rr", org_id: ORG },
  ];
  const old = await t2.confirm({ supplierId: SUP.rr });
  assertEquals((old.crew_line as any).text, "R&R delivery Mon 2 Nov");
});

Deno.test("writer: a delivery, and an ASAP order that later gets a date", async () => {
  const t = setup();
  const rr = await t.confirm({ supplierId: SUP.rr });
  assertEquals((rr.crew_line as any).text, "R&R delivery Mon 2 Nov");

  const fw = await t.confirm({ supplierId: SUP.fw });
  assertEquals((fw.crew_line as any).text, "Fencing Warehouse pickup ASAP");
  // Accept on the supplier's reply puts a date on the box: the full line.
  const box = t.tables.job_material_suppliers.find((b) => b.id === BOX.fw)!;
  Object.assign(box, {
    delivery_date: "2026-11-06",
    delivery_date_source: "supplier_reply",
    delivery_date_set_at: "2026-11-02T01:00:00Z",
  });
  const dated = await t.confirm({ supplierId: SUP.fw, trigger: "accept", orderId: ORDER.fw });
  assertEquals((dated.crew_line as any).text, "Fencing Warehouse pickup Fri 6 Nov");
  assertEquals((dated.crew_line as any).kind, "confirmed");
  assertEquals(
    t.tables.dispatch_v2_order_crew_lines.filter((l) => l.order_id === ORDER.fw).map((l) => l.seq),
    [1, 2],
  );
});

Deno.test("writer: a date changed later writes one 'moved to' line", async () => {
  const t = setup();
  await t.confirm({});
  const box = t.tables.job_material_suppliers.find((b) => b.id === BOX.stratco)!;
  Object.assign(box, {
    delivery_date: "2026-11-05",
    delivery_date_source: "by_hand",
    delivery_date_set_at: "2026-11-02T01:00:00Z",
  });
  const moved = await t.confirm({ trigger: "date_set" });
  assertEquals((moved.crew_line as any).text, "Stratco pickup moved to Thu 5 Nov");
  assertEquals((moved.crew_line as any).kind, "moved");
  // The same day again: nothing.
  const same = await t.confirm({ trigger: "date_set" });
  assertEquals((same.crew_line as any).reason, "no_change");
  assertEquals(t.notes.map((n) => n.text), [
    "Stratco pickup Tue 3 Nov · from Neerabup",
    "Stratco pickup moved to Thu 5 Nov",
  ]);
});

Deno.test("writer: a by-hand date on an order never confirmed writes nothing", async () => {
  const t = setup();
  const r = await t.confirm({ trigger: "date_set" });
  assertEquals(r.crew_line, {
    written: false,
    reason: "not_confirmed_yet",
    order_id: ORDER.stratco,
  });
  assertEquals(t.notes.length, 0);
  assertEquals(t.tables.dispatch_v2_order_crew_lines.length, 0);
});

Deno.test("writer: two presses at once write one note", async () => {
  const t = setup({
    // Someone else claims line 1 between this press's read and its claim.
    beforeInsert: (table, row) => {
      if (table !== "dispatch_v2_order_crew_lines" || row.seq !== 1) return;
      if (t.tables.dispatch_v2_order_crew_lines.length > 0) return;
      t.tables.dispatch_v2_order_crew_lines.push({ ...row, id: "other-press" });
    },
  });
  const r = await t.confirm({});
  assertEquals(r.crew_line, {
    written: false,
    reason: "already_written",
    order_id: ORDER.stratco,
  });
  assertEquals(t.notes.length, 0);
});

Deno.test("writer: a note that fails gives the claim back, so the next press writes it", async () => {
  const t = setup();
  t.failNotes(true);
  const r = await t.confirm({});
  assertEquals(r.crew_line, {
    written: false,
    reason: "note_failed",
    order_id: ORDER.stratco,
  });
  assertEquals(t.tables.dispatch_v2_order_crew_lines.length, 0);
  t.failNotes(false);
  const again = await t.confirm({});
  assertEquals((again.crew_line as any).written, true);
  assertEquals(t.notes.length, 1);
});

Deno.test("writer: no sent order, another org's order, or a read failure writes nothing", async () => {
  const t = setup();
  for (const o of t.tables.dispatch_supplier_order_emails) {
    if (o.supplier_id === SUP.rr) o.status = "draft";
  }
  assertEquals((await t.confirm({ supplierId: SUP.rr })).crew_line, {
    written: false,
    reason: "no_sent_order",
    order_id: null,
  });
  t.tables.dispatch_supplier_order_emails.find((o) => o.id === ORDER.fw)!.org_id = OTHER_ORG;
  assertEquals(
    (await t.confirm({ supplierId: SUP.fw, orderId: ORDER.fw, trigger: "accept" })).crew_line,
    { written: false, reason: "no_sent_order", order_id: null },
  );
  const broken = setup({
    fail: { dispatch_v2_order_crew_lines: { select: { code: "42P01", message: "missing" } } },
  });
  assertEquals((await broken.confirm({})).crew_line, {
    written: false,
    reason: "read_failed",
    order_id: ORDER.stratco,
  });
  assertEquals(t.notes.length + broken.notes.length, 0);
});

// ── The hooks in the stage and date presses ─────────────────────────────────

function stageCtx(onOrderConfirmed?: any) {
  return {
    orgId: ORG,
    actor: { ...SHAUN, orgId: ORG },
    via: "screen" as const,
    today: "2026-11-02",
    now: () => "2026-11-02T03:00:00.000Z",
    onOrderConfirmed,
  };
}

Deno.test("hook: only a move to Order confirmed runs the order-confirmed step", async () => {
  const t = setup();
  const calls: any[] = [];
  const hook = (i: any) => {
    calls.push(i);
    return runDispatchV2OrderConfirmed(t.client, {
      orgId: ORG,
      jobId: i.jobId,
      supplierId: i.supplierId,
      trigger: "stage_set",
      operator: i.operator,
    }, t.deps);
  };
  const quote = await runDispatchV2MaterialStageAction(
    t.client,
    DISPATCH_V2_SET_MATERIAL_STAGE_ACTION,
    { box_id: BOX.stratco, material_stage: "quote_received" },
    stageCtx(hook),
  ) as any;
  assertEquals(calls.length, 0);
  assertEquals("order_confirmed" in quote, false);

  const confirmed = await runDispatchV2MaterialStageAction(
    t.client,
    DISPATCH_V2_SET_MATERIAL_STAGE_ACTION,
    { box_id: BOX.stratco, material_stage: "order_confirmed" },
    stageCtx(hook),
  ) as any;
  assertEquals(calls.length, 1);
  assertEquals(calls[0].boxId, BOX.stratco);
  assertEquals(confirmed.order_confirmed.crew_line.text, "Stratco pickup Tue 3 Nov · from Neerabup");
  assertEquals(confirmed.success, true);
  assertEquals(confirmed.job_status_changed, false);
});

Deno.test("hook: a failing order-confirmed step never undoes the stage", async () => {
  const t = setup();
  const r = await runDispatchV2MaterialStageAction(
    t.client,
    DISPATCH_V2_SET_MATERIAL_STAGE_ACTION,
    { box_id: BOX.stratco, material_stage: "order_confirmed" },
    stageCtx(() => Promise.reject(new Error("boom"))),
  ) as any;
  assertEquals(r.success, true);
  assertEquals(r.order_confirmed, null);
  const box = t.tables.job_material_suppliers.find((b) => b.id === BOX.stratco)!;
  assertEquals(box.material_stage, "order_confirmed");
  // Left out (the older callers): the answer is as before.
  const t2 = setup();
  const r2 = await runDispatchV2MaterialStageAction(
    t2.client,
    DISPATCH_V2_SET_MATERIAL_STAGE_ACTION,
    { box_id: BOX.stratco, material_stage: "order_confirmed" },
    stageCtx(undefined),
  ) as any;
  assertEquals("order_confirmed" in r2, false);
});

Deno.test("hook: a new date by hand follows up a confirmed order; a cleared date does not", async () => {
  const t = setup();
  await t.confirm({});
  const calls: any[] = [];
  const ctx = {
    orgId: ORG,
    actor: { ...SHAUN, orgId: ORG },
    via: "screen" as const,
    today: "2026-11-02",
    now: () => "2026-11-02T03:00:00.000Z",
    onDateChanged: (i: any) => {
      calls.push(i);
      return runDispatchV2OrderConfirmed(t.client, {
        orgId: ORG,
        jobId: i.jobId,
        supplierId: i.supplierId,
        trigger: "date_set",
        operator: i.operator,
      }, t.deps);
    },
  };
  const set = await runDispatchV2DeliveryDateAction(
    t.client,
    DISPATCH_V2_SET_DELIVERY_DATE_ACTION,
    { box_id: BOX.stratco, delivery_date: "2026-11-05", confirmed: true },
    ctx,
  ) as any;
  assertEquals(set.order_confirmed.crew_line.text, "Stratco pickup moved to Thu 5 Nov");
  const cleared = await runDispatchV2DeliveryDateAction(
    t.client,
    DISPATCH_V2_SET_DELIVERY_DATE_ACTION,
    { box_id: BOX.stratco, delivery_date: null },
    ctx,
  ) as any;
  assertEquals(calls.length, 1);
  assertEquals("order_confirmed" in cleared, false);
  assert(t.notes.length === 2);
});
